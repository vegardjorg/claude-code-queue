// =============================================================
// queueDiagnose.test.ts: the guard for low parallelism in the work queue (scripts/orchestrator/lib/queueDiagnose.js).
//
// The fixtures cover the error types that can block the focus without anyone noticing:
//   1. a task depends_on a cancelled task that is merged into another;
//   2. a task depends_on a revision that does not exist, while a later revision is delivered;
//   3. a task dragged along by a focus task, but the project it belongs to is paused;
//   4. ready tasks in focus are held back by a capacity limit.
// Plus loose waits, answered questions in waiting_on, bottlenecks and "no output above the threshold".
// Each finding is "simple" (ready command) or "complex" (options with a recommendation).
// =============================================================
import { describe, it, expect } from 'vitest';

type Task = {
  id: string;
  status: string;
  title?: string;
  domain?: string;
  class?: string;
  project?: string;
  depends_on?: string[];
  waiting_on?: string[];
  remarks?: string[];
  merged_from?: string[];
  owned_files?: string[];
  picked_by?: string;
};
type Queue = {
  tasks: Task[];
  limits?: Record<string, unknown>;
  projects?: Record<string, { prefixes?: string[]; pause?: boolean }>;
  focus?: Record<string, unknown> | null;
  resolved?: string[];
  resolutions?: Record<string, { time: string; answer: string | null; by: string | null }>;
  question?: Record<string, { type: string; text: string }>;
};
type Findings = {
  type: string;
  id: string;
  back: number;
  class: 'simple' | 'complex';
  text: string;
  command?: string;
  option?: { text: string; command?: string }[];
  recommendation?: string;
  dep?: string;
};
type Diagnose = {
  activeOnes: number;
  max: number;
  threshold: number;
  share: number;
  low: boolean;
  findings: Findings[];
};

/* eslint-disable @typescript-eslint/no-require-imports */
const D = require('../queueDiagnose') as {
  DEFAULT_THRESHOLD: number;
  parallelDiagnose: (queue: Queue, option?: { now?: number }) => Diagnose;
  diagnoseLines: (d: Diagnose, option?: { max?: number }) => string[];
  diagnoseFull: (d: Diagnose) => string[];
  parseThreshold: (raw: string) => { val?: number; error?: string };
  thresholdFor: (queue: Queue) => number;
};
const L = require('../queueLogic') as {
  parseLimit: (name: string, raw: string, g?: object) => { val?: unknown; error?: string };
  LIMIT_NAME: string[];
};
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

function up(id: string, field: Partial<Task> = {}): Task {
  return { id, status: 'waiting', title: id, domain: id.split('-')[0], class: 'K', ...field };
}

/** Running agents (count toward maxConcurrent), each in its own domain and without files, so they do not block anything. */
const runningOnes = (n: number): Task[] =>
  Array.from({ length: n }, (_, i) => up(`ACT-${i}`, { status: 'running', domain: `act${i}` }));

const PROJECTS: Queue['projects'] = {
  alpha: { prefixes: ['A-'] },
  beta: { prefixes: ['B-'], pause: true },
  gamma: { prefixes: ['ACT-', 'X-'] },
};
const FOCUS = {
  name: 'Alpha',
  order: ['project:alpha'],
  rest: 'wait',
  drag_with_dependencies: true,
};

function queue(tasks: Task[], extra: Partial<Queue> = {}): Queue {
  return {
    tasks: [...runningOnes(2), ...tasks],
    limits: { maxConcurrent: 6 },
    projects: PROJECTS,
    focus: FOCUS,
    resolved: [],
    ...extra,
  };
}

const find = (d: Diagnose, type: string, id: string) =>
  d.findings.find((f) => f.type === type && f.id === id);

describe('depends-on-cancelled (case 1: A-10 → A-6, merged into A-8)', () => {
  const k = () =>
    queue([
      up('A-6', {
        status: 'cancelled',
        remarks: ['2026-10-06T18:45:21.753Z merged into A-8'],
      }),
      up('A-8', { status: 'done' }),
      up('A-10', { depends_on: ['A-6', 'A-5'] }),
      up('A-5', { status: 'done' }),
      up('A-11', { depends_on: ['A-10'] }),
      up('A-12', { depends_on: ['A-11'] }),
    ]);

  it('simple: the replacement from the remark, with a ready edit command and the chain held back in focus', () => {
    const f = find(D.parallelDiagnose(k(), { now: NOW }), 'depends-on-cancelled', 'A-10');
    expect(f).toBeDefined();
    expect(f?.class).toBe('simple');
    expect(f?.dep).toBe('A-6');
    expect(f?.back).toBe(3);
    expect(f?.command).toBe(
      `cq edit A-10 --json '{"depends_on":["A-8","A-5"]}'`,
    );
  });

  it('the replacement can also come from merged_from, and the chain is followed', () => {
    const kk = queue([
      up('A-A', { status: 'cancelled' }),
      up('A-B', {
        status: 'cancelled',
        merged_from: ['A-A'],
        remarks: ['t merged into A-C'],
      }),
      up('A-C', { status: 'done' }),
      up('A-D', { depends_on: ['A-A'] }),
    ]);
    const f = find(D.parallelDiagnose(kk, { now: NOW }), 'depends-on-cancelled', 'A-D');
    expect(f?.class).toBe('simple');
    expect(f?.command).toContain('{"depends_on":["A-C"]}');
  });

  it('complex: without a known replacement gives an option (remove) and a recommendation', () => {
    const kk = queue([up('A-A', { status: 'cancelled' }), up('A-D', { depends_on: ['A-A'] })]);
    const f = find(D.parallelDiagnose(kk, { now: NOW }), 'depends-on-cancelled', 'A-D');
    expect(f?.class).toBe('complex');
    expect(f?.command).toBeUndefined();
    expect(f?.option?.[0]?.command).toContain('{"depends_on":[]}');
    expect(f?.recommendation).toMatch(/remove the dependency/);
  });
});

describe('depends-on-unknown (case 2: A-7-X → A-7-r2, while r3 is delivered)', () => {
  it('simple: the highest finished revision of the same stem (not the base task)', () => {
    const kk = queue([
      up('A-7', { status: 'done' }),
      up('A-7-r3', { status: 'done' }),
      up('A-7-X', { depends_on: ['A-7-r2'] }),
    ]);
    const f = find(D.parallelDiagnose(kk, { now: NOW }), 'depends-on-unknown', 'A-7-X');
    expect(f?.class).toBe('simple');
    expect(f?.command).toContain('{"depends_on":["A-7-r3"]}');
  });

  it('complex: several candidates (without revision) or no near id', () => {
    const kk = queue([
      up('A-Q', { depends_on: ['A-ZZZ'] }),
      up('A-M-r1', { status: 'done' }),
      up('A-M-r2', { status: 'done' }),
      up('A-R', { depends_on: ['A-M'] }),
    ]);
    const d = D.parallelDiagnose(kk, { now: NOW });
    const none = find(d, 'depends-on-unknown', 'A-Q');
    expect(none?.class).toBe('complex');
    expect(none?.text).toMatch(/no near id/);
    const more = find(d, 'depends-on-unknown', 'A-R');
    expect(more?.class).toBe('complex');
    expect(more?.option?.map((v) => v.text)).toEqual([
      'repoint to A-M-r1',
      'repoint to A-M-r2',
      'remove the dependency',
    ]);
  });
});

describe('dragged-with-paused (case 3: B-1 in the paused project beta)', () => {
  it('simple: move to the focus project that drags it along', () => {
    const kk = queue([
      up('B-1'),
      up('B-2', { depends_on: ['B-1'] }),
      up('A-NEW', { depends_on: ['B-2'] }),
    ]);
    const d = D.parallelDiagnose(kk, { now: NOW });
    const f = find(d, 'dragged-with-paused', 'B-1');
    expect(f?.class).toBe('simple');
    expect(f?.command).toBe(
      `cq edit B-1 --json '{"project":"alpha"}'`,
    );
    // B-1 holds back itself and two in focus (B-2 dragged along, A-NEW).
    expect(f?.back).toBe(3);
    expect(find(d, 'dragged-with-paused', 'B-2')?.class).toBe('simple');
  });

  it('without a pause: no findings', () => {
    const kk = queue([up('B-1'), up('A-NEW', { depends_on: ['B-1'] })], {
      projects: { ...PROJECTS, beta: { prefixes: ['B-'] } },
    });
    expect(
      D.parallelDiagnose(kk, { now: NOW }).findings.filter((f) => f.type === 'dragged-with-paused'),
    ).toEqual([]);
  });
});

describe('loose waits and answered questions', () => {
  it('answered but not in resolved: simple resolve; unregistered: complex (the owner does not see it)', () => {
    const kk = queue([up('A-1', { waiting_on: ['SP-1'] }), up('A-2', { waiting_on: ['SP-UNREGISTERED'] })], {
      resolutions: { 'SP-1': { time: '2026-10-10T10:00:00Z', answer: 'yes', by: 'owner' } },
    });
    const d = D.parallelDiagnose(kk, { now: NOW });
    expect(find(d, 'lose-waiting', 'A-1')?.command).toBe(
      'cq resolve SP-1',
    );
    const u = find(d, 'lose-waiting', 'A-2');
    expect(u?.class).toBe('complex');
    expect(u?.recommendation).toMatch(/register the question/);
  });

  it('waiting-on-resolved: cleanup, not in the short paragraph', () => {
    const kk = queue([up('A-1', { waiting_on: ['SP-1', 'SP-2'] })], {
      resolved: ['SP-1'],
      question: { 'SP-2': { type: 'question', text: 'Question two?' } },
    });
    const d = D.parallelDiagnose(kk, { now: NOW });
    const f = find(d, 'waiting-on-resolved', 'A-1');
    expect(f?.class).toBe('simple');
    expect(f?.command).toContain(`{"waiting_on":["SP-2"]}`);
    expect(D.diagnoseLines(d).join('\n')).not.toContain('waiting-on-resolved');
    expect(D.diagnoseFull(d).join('\n')).toContain('CLEANUP (1)');
  });
});

describe('bottleneck', () => {
  it('complex, information only: the non-startable task the most focus tasks wait on, with its own reason', () => {
    const kk = queue([
      up('A-REV', { status: 'review' }),
      up('A-A', { depends_on: ['A-REV'] }),
      up('A-B', { depends_on: ['A-A'] }),
      up('A-C', { depends_on: ['A-REV'] }),
      up('A-SP', { waiting_on: ['SP-9'] }),
      up('A-E', { depends_on: ['A-SP'] }),
    ]);
    const d = D.parallelDiagnose(kk, { now: NOW });
    const fl = d.findings.filter((f) => f.type === 'bottleneck');
    expect(fl.map((f) => f.id)).toEqual(['A-REV', 'A-A', 'A-SP']);
    expect(fl[0]).toMatchObject({ class: 'complex', back: 3 });
    expect(fl[0].text).toMatch(/in review/);
    expect(fl[0].recommendation).toMatch(/review and merge of A-REV/);
    expect(fl[2].recommendation).toMatch(/SP-9/);
    expect(fl.every((f) => f.command === undefined)).toBe(true);
  });
});

// Fill finds nothing to start, and the blockers are empty for ready D+ tasks in focus, because maxDPlus = 2 is
// used up by two active D+ tracks. The diagnosis should say so.
describe('capacity (case 4: ready D+ in focus held back by maxDPlus)', () => {
  const kk = () =>
    queue(
      [
        up('A-DP1', { status: 'running', class: 'D+', domain: 'dp1' }),
        up('A-DP2', { status: 'review', class: 'D+', domain: 'dp2' }),
        up('A-READY1', { class: 'D+', domain: 'k1' }),
        up('A-READY2', { class: 'D+', domain: 'k2' }),
      ],
      { limits: { maxConcurrent: 6, maxDPlus: 2 } },
    );

  it('complex: the limit, the tasks it holds back and the tracks holding the places, with the limit command as option', () => {
    const d = D.parallelDiagnose(kk(), { now: NOW });
    const f = find(d, 'capacity', 'maxDPlus');
    expect(f).toBeDefined();
    expect(f).toMatchObject({ class: 'complex', back: 2 });
    expect(f!.text).toMatch(/maxDPlus \(2\)/);
    expect(f!.text).toMatch(/A-READY1, A-READY2/);
    expect(f!.text).toMatch(/A-DP1, A-DP2/);
    expect(f!.recommendation).toMatch(/limit maxDPlus 3/);
  });

  it('capacity comes before the bottlenecks and is shown in the short paragraph', () => {
    const d = D.parallelDiagnose(kk(), { now: NOW });
    const inCapacity = d.findings.findIndex((x) => x.type === 'capacity');
    const bottleneckIdx = d.findings.findIndex((x) => x.type === 'bottleneck');
    if (bottleneckIdx >= 0) expect(inCapacity).toBeLessThan(bottleneckIdx);
    expect(D.diagnoseLines(d).some((l) => l.includes('[complex] capacity maxDPlus'))).toBe(
      true,
    );
  });

  it('no capacity finding when the limit is not reached', () => {
    const k2 = kk();
    k2.limits = { maxConcurrent: 6, maxDPlus: 4 };
    expect(D.parallelDiagnose(k2, { now: NOW }).findings.some((x) => x.type === 'capacity')).toBe(
      false,
    );
  });
});

describe('the threshold and the output', () => {
  it('low: 2 of 6 (33 %) gives a heading, simple before complex, at most 12 lines', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      up(`A-K${i}`, { depends_on: [`A-GONE-${i}`] }),
    );
    const d = D.parallelDiagnose(queue(many), { now: NOW });
    expect(d).toMatchObject({ activeOnes: 2, max: 6, low: true });
    const lines = D.diagnoseLines(d);
    expect(lines[0]).toBe('LOW PARALLELISM: 2 of 6 tracks (33 %, threshold 70 %). Quick diagnosis:');
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.join('\n')).toMatch(/\+\d+ more findings \(cq diagnose\)/);
  });

  it('no output when the share is above the threshold (5 of 6), but diagnose shows everything', () => {
    const kk = queue([up('A-D', { depends_on: ['A-GONE'] })], {
      tasks: [...runningOnes(5), up('A-D', { depends_on: ['A-GONE'] })],
    });
    const d = D.parallelDiagnose(kk, { now: NOW });
    expect(d.low).toBe(false);
    expect(D.diagnoseLines(d)).toEqual([]);
    expect(D.diagnoseFull(d).join('\n')).toContain('depends-on-unknown A-D');
  });

  it('exactly at the threshold is not low; picked tasks do not count as agents', () => {
    const threshold = { limits: { maxConcurrent: 10, parallelThreshold: 0.5 } };
    expect(D.parallelDiagnose({ ...queue([]), tasks: runningOnes(5), ...threshold }).low).toBe(false);
    const picked = up('A-P', { status: 'running', picked_by: 'owner' });
    // One task waiting, so the queue is not empty (an empty queue is never low, see below).
    const waiting = up('A-W');
    expect(
      D.parallelDiagnose({ ...queue([]), tasks: [...runningOnes(4), picked, waiting], ...threshold })
        .low,
    ).toBe(true);
  });

  it('an empty queue (nothing waiting) is not low parallelism: no alarm, and diagnose says why', () => {
    const empty = { ...queue([]), tasks: [], limits: { maxConcurrent: 5 } };
    const d = D.parallelDiagnose(empty);
    expect(d.low).toBe(false);
    expect((d as Diagnose & { empty: boolean }).empty).toBe(true);
    expect(D.diagnoseLines(d)).toEqual([]);
    const full = D.diagnoseFull(d).join('\n');
    expect(full).not.toContain('LOW PARALLELISM');
    expect(full).toContain('Parallelism: 0 of 5 tracks (nothing waiting to run).');
    // Only done and proposed tasks: still nothing to run.
    const finished = {
      ...empty,
      tasks: [up('A-1', { status: 'done' }), up('A-2', { status: 'proposed' })],
    };
    expect(D.parallelDiagnose(finished).low).toBe(false);
  });

  it('parallelThreshold: parsed by limit (0–1 or percentage), 0 turns the guard off, invalid is rejected', () => {
    expect(D.DEFAULT_THRESHOLD).toBe(0.7);
    expect(D.parseThreshold('70 %')).toEqual({ val: 0.7 });
    expect(D.parseThreshold('0,5')).toEqual({ val: 0.5 });
    expect(D.parseThreshold('1.5').error).toBeDefined();
    expect(L.parseLimit('parallelThreshold', '0.6')).toEqual({ val: 0.6 });
    expect(L.parseLimit('parallelThreshold', 'much').error).toMatch(/from 0 to 1/);
    // Not a place limit: the settings panel on the board (LIMIT_NAME) is unchanged.
    expect(L.LIMIT_NAME).not.toContain('parallelThreshold');
    const by = { ...queue([]), limits: { maxConcurrent: 6, parallelThreshold: 0 } };
    expect(D.thresholdFor(by)).toBe(0);
    expect(D.parallelDiagnose(by).low).toBe(false);
  });

  it('never touches the queue', () => {
    const kk = queue([
      up('A-6', { status: 'cancelled', remarks: ['t merged into A-8'] }),
      up('A-8', { status: 'done' }),
      up('A-10', { depends_on: ['A-6'] }),
      up('B-1'),
      up('A-NEW', { depends_on: ['B-1'] }),
    ]);
    const before = JSON.stringify(kk);
    D.diagnoseFull(D.parallelDiagnose(kk, { now: NOW }));
    expect(JSON.stringify(kk)).toBe(before);
  });
});
