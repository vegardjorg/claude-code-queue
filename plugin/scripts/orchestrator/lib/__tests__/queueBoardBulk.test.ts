// =============================================================
// queueBoardBulk.test.ts: queue-board: multi select and bulk actions (lib/queueBoard.js: bulkPlan,
// bulkSummary, packPreview, assess with type 'bulk', board: changed/undo/parked), the batch queue in
// the dependency graph (lib/queueGraph.js), and the new flags in queue.mjs (rank --json, undo --nr, batch pack
// --expect-changed) against a copy in a temporary folder (never the real queue).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Task = {
  id: string;
  title?: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  value?: number;
  content_min?: number;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  labels?: string[];
  project?: string;
  feature?: string;
  batched?: boolean;
  parked?: { by: string; at: string; reason?: string; to?: string };
  priority_bonus?: number;
};
type Project = { title: string; prefixes?: string[]; pause?: boolean };
type Queue = {
  tasks: Task[];
  resolved?: string[];
  projects?: Record<string, Project>;
  focus?: Record<string, unknown>;
  changelog?: { nr: number; action: string; by: string; at: string; changes: unknown[] }[];
  changed?: string;
  next_migr?: number;
};
type Calendar = { level: 'info' | 'warning' | 'stop'; text: string };
type Plan = {
  error: string[];
  command?: string;
  content?: { tasks: Record<string, unknown>[] };
  space?: Record<string, unknown>;
  newId?: string;
  title?: string | null;
};
type Summary = { id: string; parked: { reason: string | null; to: string | null } | null };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard') as {
  BULK_MAX: number;
  BULK_CONFIRM: number;
  BULK_ACTIONS: string[];
  bulkPlan: (queue: Queue, action: string, ids: string[], val?: Record<string, unknown>) => Plan;
  bulkSummary: (
    queue: Queue,
    action: string,
    ids: string[],
    val: Record<string, unknown>,
    changes: { id?: string; field: string; for: unknown; after: unknown }[],
  ) => string;
  packPreview: (
    queue: Queue,
    ids: string[],
    v: { newId: string; title?: string | null },
  ) => {
    error: string[];
    new?: { id: string; class: string; content_min: number; project: string; status: string };
    cancelled?: string[];
    redirected?: string[];
  };
  assess: (queue: Queue, action: Record<string, unknown>, context?: { now?: number }) => Calendar[];
  board: (
    queue: Queue,
    option?: { now?: number },
  ) => {
    changed: string | null;
    undo: { nr: number; action: string; field: number; tasks: number } | null;
    columns: Record<string, Summary[]>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const G = require('../queueGraph') as {
  buildGraph: (
    data: unknown,
    option?: { showStandalone?: boolean },
  ) => { nodes: { id: string; state: string }[] };
};

const NOW = Date.parse('2026-10-07T12:00:00Z');
const ISO = '2026-10-07T12:00:00.000Z';
const o = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  domain: id.toLowerCase(),
  class: 'K',
  status: 'waiting',
  mission: `The mission for ${id}.`,
  title: id,
  value: 5,
  content_min: 30,
  ...extra,
});
const reasonQueue = (): Queue => ({
  tasks: [
    o('SB-1'),
    o('SB-2', { depends_on: ['SB-1'] }),
    o('SB-3', { status: 'running' }),
    o('SB-4', { labels: ['visual'] }),
    o('V-1', { batched: true, content_min: 50, feature: 'Staffing' }),
    o('V-2', { batched: true, content_min: 50, feature: 'Staffing' }),
    o('V-3', { parked: { by: 'owner', at: '2026-10-06T10:00:00.000Z', reason: 'wait' } }),
  ],
  projects: {
    goods: { title: 'Goods', prefixes: ['SB-'] },
    ui: { title: 'Calendar', prefixes: ['V-'] },
    paused: { title: 'Paused', prefixes: ['P-'], pause: true },
  },
  resolved: [],
});

describe('bulkPlan: action → queue.mjs command', () => {
  it('project, feature and batch queue become edit-many with one row per id', () => {
    const queue = reasonQueue();
    expect(T.bulkPlan(queue, 'project', ['SB-1', 'SB-4'], { pid: 'ui' })).toEqual({
      error: [],
      command: 'edit-many',
      content: {
        tasks: [
          { id: 'SB-1', project: 'ui' },
          { id: 'SB-4', project: 'ui' },
        ],
      },
    });
    expect(T.bulkPlan(queue, 'project', ['SB-1'], { pid: null }).content).toEqual({
      tasks: [{ id: 'SB-1', project: null }],
    });
    expect(T.bulkPlan(queue, 'feature', ['SB-1'], { name: '  Data sheet ' }).content).toEqual({
      tasks: [{ id: 'SB-1', feature: 'Data sheet' }],
    });
    expect(T.bulkPlan(queue, 'batch-in', ['SB-4']).content).toEqual({
      tasks: [{ id: 'SB-4', batched: true }],
    });
    expect(T.bulkPlan(queue, 'batch-out', ['V-1']).content).toEqual({
      tasks: [{ id: 'V-1', batched: false }],
    });
  });

  it('park: true without reason and date, otherwise { reason, to }; the date must be YYYY-MM-DD', () => {
    const queue = reasonQueue();
    expect(T.bulkPlan(queue, 'park', ['SB-1']).content).toEqual({
      tasks: [{ id: 'SB-1', parked: true }],
    });
    expect(
      T.bulkPlan(queue, 'park', ['SB-1'], { reason: 'waiting', to: '2026-10-20' }).content,
    ).toEqual({ tasks: [{ id: 'SB-1', parked: { reason: 'waiting', to: '2026-10-20' } }] });
    expect(T.bulkPlan(queue, 'park', ['SB-1'], { to: '20.10.2026' }).error[0]).toMatch(
      /YYYY-MM-DD/,
    );
  });

  it('continue takes only the parked ones, and denies when none is parked', () => {
    const queue = reasonQueue();
    expect(T.bulkPlan(queue, 'continue', ['SB-1', 'V-3']).content).toEqual({
      tasks: [{ id: 'V-3', parked: null }],
    });
    expect(T.bulkPlan(queue, 'continue', ['SB-1']).error[0]).toMatch(/none of the marked ones/);
  });

  it('a label is added or removed only where it changes something; an empty list removes the field', () => {
    const queue = reasonQueue();
    expect(
      T.bulkPlan(queue, 'label-add', ['SB-1', 'SB-4'], { label: 'Visual' }).content,
    ).toEqual({ tasks: [{ id: 'SB-1', labels: ['visual'] }] });
    expect(
      T.bulkPlan(queue, 'label-remove', ['SB-1', 'SB-4'], { label: 'visual' }).content,
    ).toEqual({ tasks: [{ id: 'SB-4', labels: null }] });
    expect(T.bulkPlan(queue, 'label-remove', ['SB-1'], { label: 'visual' }).error[0]).toMatch(
      /none of the marked ones has the label/,
    );
    expect(T.bulkPlan(queue, 'label-add', ['SB-1'], { label: 'two words' }).error[0]).toMatch(
      /one short word/,
    );
  });

  it('rank: top/bottom, or over/under with a valid id', () => {
    const queue = reasonQueue();
    expect(T.bulkPlan(queue, 'rank', ['SB-1'], { space: 'top' })).toEqual({
      error: [],
      command: 'rank',
      space: { top: true },
    });
    expect(T.bulkPlan(queue, 'rank', ['SB-1'], { space: 'under', ref: 'SB-4' }).space).toEqual({
      under: 'SB-4',
    });
    expect(T.bulkPlan(queue, 'rank', ['SB-1'], { space: 'over', ref: '-x' }).error.length).toBe(1);
    expect(T.bulkPlan(queue, 'rank', ['SB-1'], { space: 'middle' }).error.length).toBe(1);
  });

  it('batch-pack proposes an available id from the project\'s prefix when it is missing', () => {
    const queue = reasonQueue();
    expect(T.bulkPlan(queue, 'batch-pack', ['V-1', 'V-2'])).toMatchObject({
      error: [],
      command: 'batch-pack',
      newId: 'V-S1',
      title: null,
    });
    expect(
      T.bulkPlan(queue, 'batch-pack', ['V-1', 'V-2'], { new_id: 'V-PACKAGE', title: 'Package' }),
    ).toMatchObject({ newId: 'V-PACKAGE', title: 'Package' });
  });

  it('denies unknown action, empty list, invalid ids, duplicates and over the cap', () => {
    const queue = reasonQueue();
    expect(T.bulkPlan(queue, 'delete', ['SB-1']).error[0]).toMatch(/unknown bulk action/);
    expect(T.bulkPlan(queue, 'park', []).error).toContain('no tasks are marked');
    expect(T.bulkPlan(queue, 'park', ['a b']).error).toContain('invalid id in the list');
    expect(T.bulkPlan(queue, 'park', ['SB-1', 'SB-1']).error).toContain(
      'the same id appears more than once',
    );
    const many = Array.from({ length: T.BULK_MAX + 1 }, (_, i) => `X-${i}`);
    expect(T.bulkPlan(queue, 'park', many).error[0]).toMatch(/at most 500/);
  });
});

describe('bulkSummary: the explanation in the preview', () => {
  const queue = reasonQueue();
  it('a move tells how many move, from which projects, and how many are already there', () => {
    const text = T.bulkSummary(queue, 'project', ['SB-1', 'SB-4', 'V-1'], { pid: 'ui' }, [
      { id: 'SB-1', field: 'project', before: null, after: 'ui' },
      { id: 'SB-4', field: 'project', before: null, after: 'ui' },
    ]);
    expect(text).toBe(
      '3 tasks: 2 move to the project ui (2 from goods). 1 are already so.',
    );
  });
  it('hold, batch queue, block and packing explain what it means', () => {
    const e = [{ id: 'SB-1', field: 'parked', before: null, after: {} }];
    expect(T.bulkSummary(queue, 'park', ['SB-1'], { to: '2026-10-20' }, e)).toMatch(
      /are put on hold up to and including 2026-10-20\. They stay in the queue, but are not started or picked\./,
    );
    expect(T.bulkSummary(queue, 'batch-in', ['SB-1'], {}, e)).toMatch(/packed together/);
    expect(T.bulkSummary(queue, 'rank', ['SB-1'], { space: 'over', ref: 'SB-4' }, e)).toMatch(
      /move together right above SB-4 and keep their order/,
    );
    expect(T.bulkSummary(queue, 'batch-pack', ['V-1', 'V-2'], {}, [])).toMatch(
      /cannot be undone/,
    );
  });
  it('no em dashes in the texts', () => {
    for (const h of T.BULK_ACTIONS)
      expect(T.bulkSummary(queue, h, ['SB-1'], { pid: 'ui', label: 'x' }, [])).not.toMatch(
        /—/,
      );
  });
});

describe('packPreview: "Pack into track" on a copy', () => {
  it('shows the new track and the parts that are cancelled, without changing the queue', () => {
    const queue = reasonQueue();
    const for_ = JSON.stringify(queue);
    const p = T.packPreview(queue, ['V-1', 'V-2'], { newId: 'V-S1', title: 'Combined' });
    expect(p.error).toEqual([]);
    expect(p.new).toMatchObject({ id: 'V-S1', class: 'K', content_min: 100, project: 'ui' });
    expect(p.cancelled).toEqual(['V-1', 'V-2']);
    expect(JSON.stringify(queue)).toBe(for_);
  });
  it('same rules as queue.mjs batch pack (at least two, available id)', () => {
    const queue = reasonQueue();
    expect(T.packPreview(queue, ['V-1'], { newId: 'V-S1' }).error.join(' ')).toMatch(/at least two/);
    expect(T.packPreview(queue, ['V-1', 'V-2'], { newId: 'SB-1' }).error.join(' ')).toMatch(
      /already exists/,
    );
  });
});

describe('assess: bulk actions (guard rule 16)', () => {
  const v = (queue: Queue, action: string, ids: string[], val: Record<string, unknown> = {}) =>
    T.assess(queue, { type: 'bulk', action, ids, val }, { now: NOW });
  const level = (list: Calendar[], n: string) => list.filter((x) => x.level === n).map((x) => x.text);

  it('stop: running tasks and unknown ids cannot be bulk edited', () => {
    const queue = reasonQueue();
    expect(level(v(queue, 'park', ['SB-1', 'SB-3']), 'stop')[0]).toMatch(
      /Only tasks that are waiting or proposed.*SB-3 \(running\)/,
    );
    expect(level(v(queue, 'park', ['NO-1']), 'stop')[0]).toMatch(/Not in the queue: NO-1/);
  });

  it('warning: many at once, and moving to a paused project', () => {
    const queue = reasonQueue();
    for (let i = 0; i < T.BULK_CONFIRM + 1; i++) queue.tasks.push(o(`M-${i}`));
    const ids = queue.tasks.filter((x) => x.id.startsWith('M-')).map((x) => x.id);
    expect(level(v(queue, 'label-add', ids, { label: 'x' }), 'warning')[0]).toMatch(
      /You are changing 51 tasks/,
    );
    expect(level(v(reasonQueue(), 'project', ['SB-1'], { pid: 'paused' }), 'warning')[0]).toMatch(
      /is paused/,
    );
    expect(level(v(reasonQueue(), 'project', ['SB-1'], { pid: 'exists-not' }), 'stop')[0]).toMatch(
      /does not exist/,
    );
  });

  it('parking a dependency: warning when something in focus waits on it, otherwise info', () => {
    const queue = reasonQueue();
    expect(level(v(queue, 'park', ['SB-1']), 'info')[0]).toMatch(/Other tasks are waiting on SB-1/);
    expect(level(v(queue, 'park', ['SB-1']), 'warning')).toEqual([]);
    // If the dependency is parked together with the one waiting, nothing is flagged.
    expect(v(queue, 'park', ['SB-1', 'SB-2'])).toEqual([]);
    const withFocus: Queue = {
      ...reasonQueue(),
      focus: { order: ['project:goods'], rest: 'wait', from: '2026-10-01T00:00:00Z' },
    };
    expect(level(v(withFocus, 'park', ['SB-1']), 'warning')[0]).toMatch(
      /Something in focus is waiting on SB-1 \(SB-2 waiting on it\)/,
    );
  });

  it('stop: the batch queue rules (queueLogic.batchedError) against the queue as it will be', () => {
    const queue = reasonQueue();
    // SB-1 blocks SB-2, so it does not belong in the batch queue.
    expect(level(v(queue, 'batch-in', ['SB-1']), 'stop')[0]).toMatch(/SB-2 depends on SB-1/);
    queue.tasks.push(o('D-1', { class: 'D+' }));
    expect(level(v(queue, 'batch-in', ['D-1']), 'stop')[0]).toMatch(/D\+ is never combined/);
    expect(v(reasonQueue(), 'batch-in', ['SB-4'])).toEqual([]);
  });

  it('batch-out and batch-pack: stop when none is in the batch queue, or the packing does not work', () => {
    const queue = reasonQueue();
    expect(level(v(queue, 'batch-out', ['SB-1']), 'stop')[0]).toMatch(/None of the marked ones/);
    expect(level(v(queue, 'batch-out', ['SB-1', 'V-1']), 'info')[0]).toMatch(
      /Not in the batch queue: SB-1/,
    );
    expect(v(queue, 'batch-pack', ['V-1', 'V-2'])).toEqual([]);
    expect(level(v(queue, 'batch-pack', ['V-1']), 'stop')[0]).toMatch(/Cannot be packed/);
  });
});

describe('board: the version, "Undo last" and "on hold" on the card', () => {
  it('changed and undo come along in the state; parked is shown on the card', () => {
    const queue: Queue = {
      ...reasonQueue(),
      changed: ISO,
      changelog: [
        {
          nr: 3,
          action: 'edit-many',
          by: 'theBoard',
          at: ISO,
          changes: [
            { id: 'SB-1', field: 'project', before: null, after: 'ui' },
            { id: 'SB-4', field: 'project', before: null, after: 'ui' },
          ],
        },
      ],
    };
    const t = T.board(queue, { now: NOW });
    expect(t.changed).toBe(ISO);
    expect(t.undo).toMatchObject({ nr: 3, action: 'edit-many', field: 2, tasks: 2 });
    const v3 = t.columns.queue.find((k) => k.id === 'V-3');
    expect(v3?.parked).toMatchObject({ reason: 'wait', to: null });
    expect(t.columns.queue.find((k) => k.id === 'SB-1')?.parked).toBeNull();
    expect(T.board(reasonQueue(), { now: NOW }).undo).toBeNull();
  });
});

describe('queueGraph: the batch queue is in the dependency graph with its own state', () => {
  it('a batch queue task in a chain gets the state "batch"', () => {
    const queue = reasonQueue();
    queue.tasks.push(o('V-4', { depends_on: ['V-9'] }), o('V-9', { status: 'running' }));
    // V-1 in the batch queue depends on something that is running.
    queue.tasks.find((x) => x.id === 'V-1')!.depends_on = ['V-9'];
    const g = G.buildGraph(T.board(queue, { now: NOW }));
    expect(g.nodes.find((n) => n.id === 'V-1')?.state).toBe('batch');
    expect(g.nodes.find((n) => n.id === 'V-4')?.state).toBe('blocked');
  });
});

describe('queue.mjs: rank --json, undo --nr and batch pack --expect-changed (against a copy)', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout ?? '', error: x.stderr ?? '' };
    }
  }
  const readQueue = (): Queue => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')) as Queue;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-board5a-'));
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({ ...reasonQueue(), changed: ISO, next_migr: 1000 }, null, 2),
    );
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('rank --dry --json writes nothing; rank --json answers with the log entry', () => {
    const for_ = readFileSync(join(folder, 'queue.json'), 'utf8');
    const t = run(['rank', 'SB-4', '--top', '--dry', '--json']);
    expect(t.code).toBe(0);
    const dry = JSON.parse(t.out) as {
      ok: boolean;
      dry: boolean;
      changed: string;
      changes: unknown[];
    };
    expect(dry).toMatchObject({ ok: true, dry: true, changed: ISO });
    expect(dry.changes.length).toBe(1);
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(for_);
    const r = run(['rank', 'SB-4', '--top', '--json', '--by', 'theBoard']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, changed: ['SB-4'], log: 1 });
    const error = run(['rank', 'SB-3', '--top', '--json']);
    expect(error.code).toBe(1);
    expect((JSON.parse(error.out) as { error: string[] }).error[0]).toMatch(/only waiting and proposed/);
  });

  it('undo --nr undoes only the entry the board showed', () => {
    expect(run(['rank', 'SB-4', '--top', '--by', 'theBoard']).code).toBe(0);
    expect(run(['rank', 'SB-1', '--top', '--by', 'orchestrator']).code).toBe(0);
    const no = run(['undo', '--nr', '1', '--json']);
    expect(no.code).toBe(1);
    expect((JSON.parse(no.out) as { error: string[] }).error[0]).toMatch(
      /last change that can be undone is no\. 2.*not no\. 1/,
    );
    expect(run(['undo', '--show', '--nr', '1', '--json']).out).toMatch(/"ok":false/);
    const yes = run(['undo', '--nr', '2', '--json']);
    expect(yes.code).toBe(0);
    expect(readQueue().tasks.find((x) => x.id === 'SB-1')?.priority_bonus).toBeUndefined();
  });

  it('batch pack --expect-changed denies (exit 6) when the queue changed after the preview', () => {
    const r = run([
      'batch',
      'pack',
      'V-1',
      'V-2',
      '--id',
      'V-S1',
      '--expect-changed',
      '2026-10-01T00:00:00.000Z',
    ]);
    expect(r.code).toBe(6);
    expect(existsSync(join(folder, 'mission', 'V-S1.md'))).toBe(false);
    const ok = run(['batch', 'pack', 'V-1', 'V-2', '--id', 'V-S1', '--expect-changed', ISO]);
    expect(ok.code).toBe(0);
    expect(readQueue().tasks.find((x) => x.id === 'V-S1')).toBeTruthy();
  });
});
