// =============================================================
// queueBatch.test.ts: the batch queue in the work queue.
//
// Small tasks that block nothing are added with `batched: true` and packed into tracks of the right size when a
// group (project → class) is large enough. The tests prove the rules where they are enforced: the pure functions in
// queueLogic.js (validation, grouping and ready threshold, packing, that batch-queue tasks are never startable), the board
// and the statistics (queueBoard.js, queueStatistics.js), and queue.mjs against a copy of the queue in a temporary folder
// (QUEUE_FOLDER), never the real one.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Task = {
  id: string;
  title?: string;
  domain?: string;
  class?: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  value?: number;
  content_min?: number;
  migr_tens?: number;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  owner_db?: string[];
  shared_patch?: string[];
  requires?: string[];
  labels?: string[];
  project?: string;
  feature?: string;
  source?: string;
  batched?: boolean;
  remarks?: string[];
  merged_from?: string[];
  added_at?: string;
  added_by?: string;
};
type Queue = {
  tasks: Task[];
  resolved?: string[];
  projects?: Record<string, { title: string; prefixes?: string[] }>;
  next_migr?: number;
};
type Measure = { min: number; measure: number; max: number };
type Group = {
  pid: string;
  class: string;
  measure: Measure | null;
  sum: number;
  count: number;
  ready: boolean;
  over: boolean;
  invalid: boolean;
  common_files: string[];
  features: { feature: string; sum: number; ids: string[] }[];
  tasks: { id: string; content_min: number; feature: string }[];
};
type Proposed = {
  id: string | null;
  pid: string;
  class: string;
  parts: string[];
  sum: number;
  out: boolean;
};
type PackAnswer = {
  error: string[];
  new?: Task;
  cancelled?: string[];
  redirected?: string[];
};

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic') as {
  BATCH_MEASURE: Record<string, Measure>;
  BATCHED_BLOCKER: string;
  isBatched: (o: Task) => boolean;
  inBatchQueue: (o: Task) => boolean;
  batchedError: (o: Task, tasks: Task[], resolved?: string[]) => string[];
  batchGroups: (queue: Queue) => Group[];
  batchSuggestion: (queue: Queue) => Proposed[];
  batchPack: (
    queue: Queue,
    ids: string[],
    option: { newId: string; title?: string | null; mission: string; by?: string; now?: string },
  ) => PackAnswer;
  batchMissionText: (
    fresh: Task,
    parts: Task[],
    texts: Map<string, { text: string; path: string | null }>,
    now?: string,
  ) => string;
  blockers: (o: Task, tasks: Task[], resolved?: string[]) => string[];
  selectNext: (queue: Queue, now?: number) => { id: string }[];
  pickable: (queue: Queue) => { id: string }[];
  pick: (
    queue: Queue,
    id: string,
    option: { by: string; force?: boolean },
  ) => { error?: string; task?: Task };
  state: (
    queue: Queue,
    usage?: number,
  ) => {
    waiting: number;
    proposed: number;
    batched: number;
    canStart: number;
    blocked: { id: string }[];
  };
};
const T = require('../queueBoard') as {
  columnFor: (o: Task) => string | null;
  board: (queue: Queue) => {
    columns: Record<string, { id: string; ready: boolean; batched: boolean }[]>;
    batchQueue: Group[];
  };
};
const S = require('../queueStatistics') as {
  statistics: (
    queue: Queue,
    rows: unknown[],
    option?: { now?: number },
  ) => {
    keyFigures: { batchQueue: { count: number; minutes: number; groups: number; readyOnes: number } };
  };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const T1 = '2026-10-06T10:00:00.000Z';

function up(id: string, field: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    domain: 'client',
    class: 'K',
    status: 'waiting',
    mission: `Do ${id}.`,
    value: 5,
    content_min: 30,
    migr_tens: 0,
    depends_on: [],
    waiting_on: [],
    owned_files: [],
    owner_db: [],
    shared_patch: [],
    added_at: T1,
    ...field,
  };
}

const REGISTER = {
  ui: { title: 'Calendar', prefixes: ['VA-'] },
  help: { title: 'Help', prefixes: ['KU-'] },
};

describe('batchedError (add/edit)', () => {
  it('accepts a small, non-blocking K in the batch queue, and an old task without the field', () => {
    expect(L.batchedError(up('A', { batched: true }), [])).toEqual([]);
    expect(L.batchedError(up('A'), [])).toEqual([]);
    expect(L.batchedError(up('A', { batched: false }), [])).toEqual([]);
  });

  it('rejects D+, a non-boolean value and tasks that are not waiting', () => {
    expect(L.batchedError(up('A', { class: 'D+', batched: true }), []).join()).toMatch(
      /D\+ is never combined/,
    );
    expect(L.batchedError({ ...up('A'), batched: 'yes' as unknown as boolean }, []).join()).toMatch(
      /batched must be true or false/,
    );
    expect(L.batchedError(up('A', { status: 'running', batched: true }), []).join()).toMatch(
      /only waiting tasks/,
    );
  });

  it('rejects a task that another open task depends on (finished and cancelled ones do not count)', () => {
    const a = up('A', { batched: true });
    const f = L.batchedError(a, [a, up('B', { depends_on: ['A'] })]);
    expect(f.join()).toMatch(/B depends on A/);
    expect(
      L.batchedError(a, [
        a,
        up('C', { depends_on: ['A'], status: 'done' }),
        up('D', { depends_on: ['A'], status: 'cancelled' }),
      ]),
    ).toEqual([]);
  });

  it('rejects an open owner question, but accepts resolved ones', () => {
    const a = up('A', { batched: true, waiting_on: ['Q9'] });
    expect(L.batchedError(a, [a]).join()).toMatch(/owner questions that are not resolved \(Q9\)/);
    expect(L.batchedError(a, [a], ['Q9'])).toEqual([]);
  });

  it('rejects a task that depends on a task in the batch queue', () => {
    const s = up('S', { batched: true });
    const b = up('B', { depends_on: ['S'] });
    expect(L.batchedError(b, [s, b]).join()).toMatch(/depends on S, which is in the batch queue/);
  });
});

describe('batch-queue tasks are never startable or pickable', () => {
  const queue = (): Queue => ({
    tasks: [up('A', { batched: true }), up('B'), up('C', { batched: true, status: 'proposed' })],
    next_migr: 2840,
  });

  it('the batched blocker; selectNext and pickable skip them', () => {
    const k = queue();
    expect(L.blockers(k.tasks[0], k.tasks)).toEqual([L.BATCHED_BLOCKER]);
    expect(L.selectNext(k).map((x) => x.id)).toEqual(['B']);
    expect(L.pickable(k).map((x) => x.id)).toEqual(['B']);
  });

  it('pick denies, even with --force', () => {
    const k = queue();
    expect(L.pick(k, 'A', { by: 'owner', force: true }).error).toMatch(/in the batch queue/);
    expect(k.tasks[0].status).toBe('waiting');
  });

  it('state counts the batch queue separately (not as waiting or proposed, not blocked)', () => {
    const t = L.state(queue());
    expect(t.waiting).toBe(1);
    expect(t.proposed).toBe(0);
    expect(t.batched).toBe(2);
    expect(t.canStart).toBe(1);
    expect(t.blocked.map((b) => b.id)).toEqual([]);
  });

  it('cancelled or done with batched is not in the batch queue', () => {
    expect(L.inBatchQueue(up('A', { batched: true, status: 'cancelled' }))).toBe(false);
    expect(L.inBatchQueue(up('A', { batched: true, status: 'proposed' }))).toBe(true);
    expect(L.isBatched(up('A'))).toBe(false);
  });
});

describe('batchGroups and the ready threshold', () => {
  it('groups project → class in register order, K before D before U, tasks by feature and id', () => {
    const queue: Queue = {
      projects: REGISTER,
      tasks: [
        up('KU-1', { batched: true, content_min: 20 }),
        up('VA-3', { batched: true, class: 'D', content_min: 20, feature: 'B' }),
        up('VA-2', { batched: true, content_min: 40, feature: 'B', owned_files: ['a.ts'] }),
        up('VA-1', {
          batched: true,
          content_min: 50,
          feature: 'A',
          owned_files: ['./a.ts', 'b.ts'],
        }),
        up('VA-4', { batched: true, class: 'U', content_min: 45 }),
        up('VA-5', { content_min: 50 }), // not in the batch queue
      ],
    };
    const g = L.batchGroups(queue);
    expect(g.map((x) => `${x.pid}/${x.class}`)).toEqual(['ui/K', 'ui/D', 'ui/U', 'help/K']);
    expect(g[0].tasks.map((o) => o.id)).toEqual(['VA-1', 'VA-2']);
    expect(g[0].sum).toBe(90);
    expect(g[0].ready).toBe(true);
    expect(g[0].features).toEqual([
      { feature: 'A', sum: 50, ids: ['VA-1'] },
      { feature: 'B', sum: 40, ids: ['VA-2'] },
    ]);
    expect(g[0].common_files).toEqual(['a.ts']);
    expect(g[1]).toMatchObject({ class: 'D', sum: 20, ready: false });
    expect(g[2]).toMatchObject({ class: 'U', sum: 45, ready: true });
    expect(g[3]).toMatchObject({ pid: 'help', sum: 20, ready: false });
  });

  it('ready from the lower target: K 90, D 30, U 45 (one minute under is not ready); over the upper target is marked', () => {
    expect(L.BATCH_MEASURE.K).toMatchObject({ min: 90, max: 120 });
    expect(L.BATCH_MEASURE.D).toMatchObject({ min: 30, max: 50 });
    expect(L.BATCH_MEASURE.U).toMatchObject({ min: 45 });
    for (const [cls, min] of [
      ['K', 90],
      ['D', 30],
      ['U', 45],
    ] as const) {
      const under = L.batchGroups({
        tasks: [up('A', { class: cls, batched: true, content_min: min - 1 })],
      });
      const onState = L.batchGroups({
        tasks: [up('A', { class: cls, batched: true, content_min: min })],
      });
      expect(under[0].ready).toBe(false);
      expect(onState[0].ready).toBe(true);
    }
    const over = L.batchGroups({ tasks: [up('A', { batched: true, content_min: 121 })] });
    expect(over[0].over).toBe(true);
  });

  it('a D+ with batched from before (old data) shows as invalid and is never ready', () => {
    const g = L.batchGroups({
      tasks: [up('A', { class: 'D+', batched: true, content_min: 99 })],
    });
    expect(g[0]).toMatchObject({ invalid: true, ready: false, measure: null });
  });

  it('is deterministic (same answer regardless of the order in the queue file)', () => {
    const o = [
      up('VA-2', { batched: true, feature: 'X' }),
      up('VA-1', { batched: true, feature: 'X' }),
      up('KU-1', { batched: true }),
    ];
    const a = L.batchGroups({ projects: REGISTER, tasks: o });
    const b = L.batchGroups({ projects: REGISTER, tasks: [...o].reverse() });
    expect(b).toEqual(a);
  });
});

describe('batchSuggestion (--auto)', () => {
  it('fills packages up toward the upper target, leaves a remainder under the lower target, and gives available ids', () => {
    const queue: Queue = {
      projects: REGISTER,
      tasks: [
        up('VA-S1', { status: 'done' }), // the id is used
        ...['a', 'b', 'c', 'd', 'e'].map((x) => up(`VA-${x}`, { batched: true, content_min: 40 })),
        up('VA-f', { batched: true, content_min: 20 }),
        up('KU-1', { batched: true, content_min: 30 }), // not ready
      ],
    };
    const f = L.batchSuggestion(queue);
    expect(f).toEqual([
      {
        id: 'VA-S2',
        pid: 'ui',
        class: 'K',
        parts: ['VA-a', 'VA-b', 'VA-c'],
        sum: 120,
        out: false,
      },
      {
        id: 'VA-S3',
        pid: 'ui',
        class: 'K',
        parts: ['VA-d', 'VA-e', 'VA-f'],
        sum: 100,
        out: false,
      },
    ]);
  });

  it('a task that has reached the target alone is proposed to leave the batch queue', () => {
    const f = L.batchSuggestion({
      tasks: [up('A', { class: 'D', batched: true }), up('B', { class: 'D', batched: true })],
    });
    expect(f.map((x) => [x.parts, x.out, x.id])).toEqual([
      [['A'], true, null],
      [['B'], true, null],
    ]);
  });

  it('changes nothing', () => {
    const queue: Queue = { tasks: [up('A', { batched: true, content_min: 95 })] };
    const snapshot = JSON.stringify(queue);
    L.batchSuggestion(queue);
    expect(JSON.stringify(queue)).toBe(snapshot);
  });
});

describe('batchPack', () => {
  const makeQueue = (): Queue => ({
    projects: REGISTER,
    resolved: ['Q1'],
    tasks: [
      up('VA-1', {
        batched: true,
        value: 4,
        content_min: 30,
        depends_on: ['X'],
        owned_files: ['a.ts'],
        requires: ['db'],
        feature: 'Common',
        source: 'plan § 1',
        waiting_on: ['Q1'],
      }),
      up('VA-2', {
        batched: true,
        value: 8,
        content_min: 40,
        migr_tens: 1,
        depends_on: ['X', 'VA-1', 'Y'],
        owned_files: ['a.ts', 'b.ts'],
        owner_db: ['f'],
        labels: ['visual'],
        feature: 'Common',
      }),
      up('VA-3', { batched: true, content_min: 25, shared_patch: ['anonymize_user'] }),
      up('X', { status: 'done' }),
      up('Y'),
      up('Z', { depends_on: ['VA-2', 'VA-3', 'Y'] }),
      up('Q', { depends_on: ['VA-1'], status: 'done' }),
    ],
  });
  const NOW = '2026-10-06T12:00:00.000Z';

  it('merges the fields, cancels the originals and redirects depends_on', () => {
    const queue = makeQueue();
    const r = L.batchPack(queue, ['VA-1', 'VA-2', 'VA-3'], {
      newId: 'VA-S1',
      mission: 'scripts/.queue/mission/VA-S1.md',
      now: NOW,
    });
    expect(r.error).toEqual([]);
    expect(r.new).toMatchObject({
      id: 'VA-S1',
      class: 'K',
      status: 'waiting',
      project: 'ui',
      feature: 'Common',
      domain: 'client',
      value: 8,
      content_min: 95,
      migr_tens: 1,
      depends_on: ['X', 'Y'],
      waiting_on: ['Q1'],
      owned_files: ['a.ts', 'b.ts'],
      owner_db: ['f'],
      shared_patch: ['anonymize_user'],
      requires: ['db'],
      labels: ['visual'],
      source: 'VA-1: plan § 1',
      merged_from: ['VA-1', 'VA-2', 'VA-3'],
      mission: 'scripts/.queue/mission/VA-S1.md',
      added_at: NOW,
    });
    expect(r.new?.batched).toBeUndefined();
    expect(r.new?.title).toBe('Combined track (3): Task VA-1 + Task VA-2 + Task VA-3');
    for (const id of ['VA-1', 'VA-2', 'VA-3']) {
      const o = queue.tasks.find((x) => x.id === id);
      expect(o?.status).toBe('cancelled');
      expect(o?.remarks).toEqual([`${NOW} merged into VA-S1`]);
    }
    expect(queue.tasks.find((x) => x.id === 'Z')?.depends_on).toEqual(['VA-S1', 'Y']);
    // A done task is not touched.
    expect(queue.tasks.find((x) => x.id === 'Q')?.depends_on).toEqual(['VA-1']);
    expect(r.redirected).toEqual(['Z']);
    // The new one is startable when its predecessors are finished (Y is still waiting).
    expect(L.blockers(r.new as Task, queue.tasks, queue.resolved)).toEqual([
      'waiting on Y (waiting)',
    ]);
  });

  it('own title; proposed among the parts gives status proposed', () => {
    const queue = makeQueue();
    queue.tasks[2].status = 'proposed';
    const r = L.batchPack(queue, ['VA-1', 'VA-3'], {
      newId: 'VA-S1',
      title: 'Small shift fixes',
      mission: 'x.md',
    });
    expect(r.new).toMatchObject({ title: 'Small shift fixes', status: 'proposed' });
  });

  const rejected = (edit: (queue: Queue) => void, ids: string[], newId: string, pattern: RegExp) => {
    const queue = makeQueue();
    edit(queue);
    const snapshot = JSON.stringify(queue);
    const r = L.batchPack(queue, ids, { newId, mission: 'x.md' });
    expect(r.error.join('\n')).toMatch(pattern);
    // All or nothing: the queue is untouched.
    expect(JSON.stringify(queue)).toBe(snapshot);
  };

  it('rejects different classes (K and D are never mixed)', () =>
    rejected((queue) => (queue.tasks[2].class = 'D'), ['VA-1', 'VA-3'], 'VA-S1', /different classes/));
  it('rejects D+', () =>
    rejected(
      (queue) => {
        queue.tasks[0].class = 'D+';
        queue.tasks[2].class = 'D+';
      },
      ['VA-1', 'VA-3'],
      'VA-S1',
      /D\+ is never combined/,
    ));
  it('rejects different open owner questions', () =>
    rejected(
      (queue) => (queue.tasks[2].waiting_on = ['Q7']),
      ['VA-1', 'VA-3'],
      'VA-S1',
      /different open owner questions/,
    ));
  it('rejects fewer than two, a duplicate id, an unknown id and the wrong status', () => {
    rejected(() => undefined, ['VA-1'], 'VA-S1', /at least two tasks/);
    rejected(() => undefined, ['VA-1', 'VA-1'], 'VA-S1', /appears more than once/);
    rejected(() => undefined, ['VA-1', 'NO'], 'VA-S1', /unknown task NO/);
    rejected(() => undefined, ['VA-1', 'X'], 'VA-S1', /X has status done/);
  });
  it('rejects an id that exists and an invalid id', () => {
    rejected(() => undefined, ['VA-1', 'VA-3'], 'Y', /id Y already exists/);
    rejected(() => undefined, ['VA-1', 'VA-3'], 'new id', /invalid characters/);
  });
  it('rejects a cycle (an external predecessor itself waiting on one of the parts)', () =>
    rejected((queue) => (queue.tasks[2].depends_on = ['Z']), ['VA-2', 'VA-3'], 'VA-S1', /cycle: Z/));

  it('the mission text has an introduction, the order and every part mission in full', () => {
    const queue = makeQueue();
    const parts = [queue.tasks[0], queue.tasks[2]];
    const r = L.batchPack(queue, ['VA-1', 'VA-3'], { newId: 'VA-S1', mission: 'x.md', now: NOW });
    const text = L.batchMissionText(
      r.new as Task,
      parts,
      new Map([
        [
          'VA-1',
          { text: '# VA-1\n\nThe whole mission for VA-1.\n', path: 'scripts/.queue/mission/VA-1.md' },
        ],
        ['VA-3', { text: 'Do VA-3.', path: null }],
      ]),
      NOW,
    );
    expect(text).toMatch(/^# VA-S1: combined track \(2 parts, K, approx\. 55 content minutes\)/);
    expect(text).toContain('1. VA-1: Task VA-1 (K, 30 min)');
    expect(text).toContain('2. VA-3: Task VA-3 (K, 25 min)');
    expect(text).toContain('## Part VA-1: Task VA-1');
    expect(text).toContain('(Original mission file: `scripts/.queue/mission/VA-1.md`)');
    expect(text).toContain('The whole mission for VA-1.');
    expect(text).toContain('(The original mission was text in the queue file.)');
    expect(text).toContain('Do VA-3.');
  });
});

describe('the board and the statistics', () => {
  const queue = (): Queue => ({
    projects: REGISTER,
    tasks: [
      up('VA-1', { batched: true, content_min: 60 }),
      up('VA-2', { batched: true, content_min: 35 }),
      up('VA-3'),
      up('KU-1', { batched: true, class: 'D', content_min: 20, status: 'proposed' }),
    ],
  });

  it('batch-queue cards sit in their own column, not in the queue or Proposed', () => {
    const t = T.board(queue());
    expect(T.columnFor(up('A', { batched: true }))).toBe('batch');
    expect(t.columns.batch.map((k) => k.id)).toEqual(['VA-1', 'VA-2', 'KU-1']);
    expect(t.columns.queue.map((k) => k.id)).toEqual(['VA-3']);
    expect(t.columns.proposed).toEqual([]);
    expect(t.columns.batch.every((k) => k.batched && !k.ready)).toBe(true);
    expect(t.batchQueue.map((g) => [g.pid, g.class, g.sum, g.ready])).toEqual([
      ['ui', 'K', 95, true],
      ['help', 'D', 20, false],
    ]);
  });

  it('the statistics count the batch queue separately', () => {
    const s = S.statistics(queue(), [], { now: Date.parse(T1) });
    expect(s.keyFigures.batchQueue).toEqual({ count: 3, minutes: 115, groups: 2, readyOnes: 1 });
  });
});

describe('queue.mjs batch (against a copy of the queue)', () => {
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
      return { code: x.status, out: String(x.stdout ?? ''), error: String(x.stderr ?? '') };
    }
  }
  const readQueue = (): Queue => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));
  const missionPath = (id: string) => join(folder, 'mission', `${id}.md`);

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-batch-'));
    mkdirSync(join(folder, 'source'));
    for (const id of ['VA-1', 'VA-2'])
      writeFileSync(join(folder, 'source', `${id}.md`), `# ${id}\n\nMission for ${id}.\n`);
    const queue: Queue = {
      projects: REGISTER,
      next_migr: 2840,
      tasks: [
        up('VA-1', { batched: true, content_min: 50, mission: join(folder, 'source', 'VA-1.md') }),
        up('VA-2', { batched: true, content_min: 45, mission: join(folder, 'source', 'VA-2.md') }),
        up('VA-3', { depends_on: ['VA-1'] }),
        up('VA-4', { class: 'D' }),
      ],
    };
    // VA-3 depends on VA-1 from before (old data); batch pack must redirect it.
    writeFileSync(join(folder, 'queue.json'), JSON.stringify(queue));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('batch lists the groups with the sum against the target and READY FOR PACKING', () => {
    const r = run(['batch']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/BATCH_QUEUE: 2 task\(s\), 95 content minutes/);
    expect(r.out).toMatch(/K +95 \/ 90–120 min .*READY FOR PACKING/);
    expect(r.out).toContain('VA-1');
  });

  it('add rejects batched for D+ and for an open owner question; the whole file is rejected', () => {
    const file = join(folder, 'in.json');
    writeFileSync(
      file,
      JSON.stringify([
        up('VA-9', { class: 'D+', batched: true }),
        up('VA-8', { batched: true, waiting_on: ['Q5'] }),
        up('VA-7', { batched: true }),
      ]),
    );
    const r = run(['add', '--file', file]);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/VA-9: .*D\+ is never combined/);
    expect(r.error).toMatch(/VA-8: .*Q5/);
    expect(readQueue().tasks.map((o) => o.id)).not.toContain('VA-7');
  });

  it('add rejects batched on a task that another in the same file depends on', () => {
    const file = join(folder, 'in.json');
    writeFileSync(
      file,
      JSON.stringify([up('VA-7', { batched: true }), up('VA-6', { depends_on: ['VA-7'] })]),
    );
    const r = run(['add', '--file', file]);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/VA-6 depends on VA-7/);
  });

  it('edit: batched in and out; denies batched on something others depend on', () => {
    expect(run(['edit', 'VA-4', '--json', '{"batched":true}']).code).toBe(0);
    expect(readQueue().tasks.find((o) => o.id === 'VA-4')?.batched).toBe(true);
    expect(run(['edit', 'VA-4', '--json', '{"batched":false}']).code).toBe(0);
    expect(readQueue().tasks.find((o) => o.id === 'VA-4')).not.toHaveProperty('batched');
    const r = run(['edit', 'VA-1', '--json', '{"value":9}']);
    expect(r.code).toBe(1); // VA-3 depends on VA-1 in the batch queue (old data) and is stopped
    expect(r.error).toMatch(/VA-3 depends on VA-1/);
  });

  it('start denies a task in the batch queue', () => {
    const r = run(['start', 'VA-2', '--force']);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/in the batch queue/);
  });

  it('batch pack writes the mission file, cancels the parts and redirects depends_on', () => {
    const r = run(['batch', 'pack', 'VA-1', 'VA-2', '--id', 'VA-S1', '--title', 'Small ui']);
    expect(r.error).toBe('');
    expect(r.out).toMatch(/Packed VA-S1 \(K, 95 min, status waiting\) from VA-1, VA-2/);
    const queue = readQueue();
    const fresh = queue.tasks.find((o) => o.id === 'VA-S1');
    expect(fresh).toMatchObject({ title: 'Small ui', merged_from: ['VA-1', 'VA-2'] });
    expect(queue.tasks.find((o) => o.id === 'VA-1')?.status).toBe('cancelled');
    expect(queue.tasks.find((o) => o.id === 'VA-3')?.depends_on).toEqual(['VA-S1']);
    const text = readFileSync(missionPath('VA-S1'), 'utf8');
    expect(text).toContain('Mission for VA-1.');
    expect(text).toContain('Mission for VA-2.');
    expect(fresh?.mission?.replace(/\\/g, '/')).toBe(missionPath('VA-S1').replace(/\\/g, '/'));
  });

  it('batch pack is all or nothing: an error leaves the queue file untouched and no mission file', () => {
    const snapshot = readFileSync(join(folder, 'queue.json'), 'utf8');
    const r = run(['batch', 'pack', 'VA-1', 'VA-4', '--id', 'VA-S1']);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/different classes/);
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(snapshot);
    expect(existsSync(missionPath('VA-S1'))).toBe(false);
    // A mission file that already exists is never overwritten.
    mkdirSync(join(folder, 'mission'), { recursive: true });
    writeFileSync(missionPath('VA-S1'), 'old');
    const r2 = run(['batch', 'pack', 'VA-1', 'VA-2', '--id', 'VA-S1']);
    expect(r2.code).toBe(1);
    expect(readFileSync(missionPath('VA-S1'), 'utf8')).toBe('old');
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(snapshot);
  });

  it('batch pack --auto proposes without editing; --execute packs', () => {
    const snapshot = readFileSync(join(folder, 'queue.json'), 'utf8');
    const r = run(['batch', 'pack', '--auto']);
    expect(r.out).toContain('queue.mjs batch pack VA-1 VA-2 --id VA-S1');
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(snapshot);
    const u = run(['batch', 'pack', '--auto', '--execute']);
    expect(u.error).toBe('');
    expect(readQueue().tasks.find((o) => o.id === 'VA-S1')?.status).toBe('waiting');
    expect(existsSync(missionPath('VA-S1'))).toBe(true);
  });

  it('show counts the batch queue separately and does not show the cards as pending', () => {
    const r = run(['show']);
    expect(r.out).toMatch(/BATCH_QUEUE \(2 task\(s\) in 1 group\(s\), 1 ready for packing/);
    expect(r.out).toMatch(/2 in the batch queue \(queue\.mjs batch\)/);
    expect(r.out).not.toMatch(/^VA-1 +waiting/m);
  });
});
