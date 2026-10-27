// =============================================================
// queueBulk.test.ts: work queue (lib/queueLogic.js): edit-many with parked/batched/register fields,
// dry run (dry) and optimistic concurrency (expectCheck), changelog and undo, block moves (rankBlock),
// longest prefix, project proposals (suggestProject, classifyQueue, addProjectWarnings) and prefix warnings,
// plus the commands in queue.mjs against a copy in a temporary folder (never the real queue).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Parked = { by: string; at: string; reason?: string; to?: string };
type Task = {
  id: string;
  title?: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  source?: string;
  value?: number;
  content_min?: number;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  priority_bonus?: number;
  project?: string;
  feature?: string;
  batched?: boolean;
  parked?: Parked;
};
type Project = {
  title: string;
  prefixes?: string[];
  pause?: boolean;
  plan?: string;
  fileRoot?: string[];
  features?: string[];
  priority_bonus?: number;
  area?: string;
};
type Change = { id?: string; pid?: string; field: string; for: unknown; after: unknown };
type Post = {
  nr: number;
  at: string;
  by: string;
  action: string;
  changes: Change[];
  undone?: { at: string; by: string };
};
type Queue = {
  tasks: Task[];
  resolved?: string[];
  projects?: Record<string, Project>;
  areas?: Record<string, { title: string }>;
  focus?: Record<string, unknown>;
  limits?: Record<string, number | boolean | string | null>;
  changelog?: Post[];
  changed?: string;
  next_migr?: number;
};
type Proposed = {
  pid: string | null;
  signal: string | null;
  safe: boolean;
  disagree: boolean;
  counterProposal: string | null;
  reason: string;
};
type Row = { id: string; now: string; proposed: string | null; type: string };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  WITHOUT_PROJECT: string;
  CHANGELOG_MAX: number;
  projectFor: (o: Partial<Task>, register?: Record<string, Project>) => string;
  longestPrefix: (
    id: string,
    register: Record<string, Project>,
  ) => { pid: string; prefix: string; also: string[] } | null;
  editMany: (
    queue: Queue,
    input: unknown,
    option?: { by?: string; now?: string; dry?: boolean },
  ) => {
    error: string[];
    changed?: string[];
    projects?: string[];
    changes?: Change[];
    warnings?: string[];
  };
  bulkDiff: (forQueue: Partial<Queue>, afterQueue: Partial<Queue>) => Change[];
  diffLines: (e: Change[]) => string[];
  logChange: (
    queue: Queue,
    v: { by?: string; action: string; changes: Change[]; now?: string },
  ) => Post | null;
  undoEntry: (
    queue: Queue,
    v?: { by?: string; now?: string; show?: boolean },
  ) => { error: string[]; entry?: Post; show?: boolean };
  expectCheck: (queue: Partial<Queue>, expect: string | null) => string | null;
  rankBlock: (
    queue: Queue,
    ids: string[],
    space: { top?: boolean; bottom?: boolean; over?: string; under?: string },
    now?: number,
  ) => { error: string[]; changes?: Record<string, number | null>; warnings?: string[] };
  selectNext: (queue: Queue, now?: number) => { id: string; score: number }[];
  score: (
    o: Task,
    tasks: Task[],
    now?: number,
    register?: Record<string, Project>,
  ) => number;
  suggestProject: (o: Partial<Task>, register: Record<string, Project>) => Proposed;
  classifyQueue: (
    queue: Queue,
    filter?: { withoutProject?: boolean; disagreeing?: boolean },
  ) => { move: Row[]; sort: Row[] };
  prefixWarnings: (register: Record<string, Project>, v?: { pid?: string }) => string[];
  addProjectWarnings: (newOnes: Partial<Task>[], register: Record<string, Project>) => string[];
  newRegister: (
    register: Record<string, Project> | undefined,
    changes: unknown,
    areas?: Record<string, unknown>,
  ) => { error: string[] };
};

const NOW = Date.parse('2026-10-07T12:00:00Z');
const ISO = '2026-10-07T12:00:00.000Z';
const o = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  domain: id.toLowerCase(),
  class: 'K',
  status: 'waiting',
  mission: 'x',
  title: id,
  ...extra,
});
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const REGISTER: Record<string, Project> = {
  warehouse: {
    title: 'Warehouse',
    prefixes: ['SB-'],
    plan: 'docs/warehouse-requirements-engine-plan.md',
    fileRoot: ['components/goods/', 'lib/data/'],
  },
  directory: {
    title: 'Directory',
    prefixes: ['K-'],
    plan: 'docs/directory-plan.md',
  },
  ui: {
    title: 'Calendar',
    prefixes: ['V-'],
    fileRoot: ['components/list/', 'lib/list'],
    features: ['Overview', 'Swap'],
  },
  report: { title: 'Report', plan: 'docs/report-plan.md' },
};
const reasonQueue = (): Queue => ({
  projects: clone(REGISTER),
  limits: { maxConcurrent: 10, maxDPlus: 4, maxPerDomain: 7, maxDb: 6 },
  tasks: [
    o('SB-1', { value: 2 }),
    o('SB-2', { value: 3 }),
    o('SB-3', { value: 9 }),
    o('V-1', { value: 8 }),
    o('V-2', { value: 4, depends_on: ['V-1'] }),
    o('X-1', { value: 5 }),
  ],
});

describe('longest prefix', () => {
  const register: Record<string, Project> = {
    wide: { title: 'Wide', prefixes: ['4'] },
    narrow: { title: 'Narrow', prefixes: ['4F-'] },
    a: { title: 'A', prefixes: ['SB-'] },
    b: { title: 'B', prefixes: ['SB-'] },
  };
  it('the longest prefix wins regardless of order in the register', () => {
    expect(L.projectFor(o('4F-1'), register)).toBe('narrow');
    expect(L.projectFor(o('4A-1'), register)).toBe('wide');
    const reversed = { narrow: register.narrow, wide: register.wide };
    expect(L.projectFor(o('4F-1'), reversed)).toBe('narrow');
  });
  it('equal length: the first in the register wins, and the others are reported', () => {
    expect(L.projectFor(o('SB-1'), register)).toBe('a');
    expect(L.longestPrefix('SB-1', register)).toEqual({ pid: 'a', prefix: 'SB-', also: ['b'] });
  });
  it('an explicit project wins; no match gives without-project', () => {
    expect(L.projectFor(o('4F-1', { project: 'a' }), register)).toBe('a');
    expect(L.projectFor(o('Z-1'), register)).toBe(L.WITHOUT_PROJECT);
  });
  it('prefixWarnings: one character, the start of another project prefix, and the same prefix in two places', () => {
    const adv = L.prefixWarnings(register).join('\n');
    expect(adv).toContain('the prefix 4 in wide is only one character');
    expect(adv).toContain('the prefix 4 in wide is the start of 4F- in narrow');
    expect(adv).toContain('the prefix SB- is in both a and b');
    // pid limits to warnings about that project.
    expect(L.prefixWarnings(register, { pid: 'a' }).join('\n')).not.toContain('wide');
    // A prefix with a separator (S-) is not "one character".
    expect(L.prefixWarnings({ s: { title: 'S', prefixes: ['S-'] } })).toEqual([]);
  });
});

describe('register: fileRoot and features', () => {
  it('accepts lists of paths and names, rejects wildcards and empty values', () => {
    expect(
      L.newRegister({}, { p: { title: 'P', fileRoot: ['lib/x/'], features: ['Data sheet'] } }).error,
    ).toEqual([]);
    expect(L.newRegister({}, { p: { title: 'P', fileRoot: ['lib/*.ts'] } }).error.join()).toContain(
      'fileRoot',
    );
    expect(L.newRegister({}, { p: { title: 'P', features: [''] } }).error.join()).toContain(
      'features',
    );
  });
});

describe('editMany: parked, batched, dry and changes', () => {
  it('parked: true, { reason, to } and null; by/at are set by the tool', () => {
    const queue = reasonQueue();
    const r = L.editMany(
      queue,
      [
        { id: 'SB-1', parked: true },
        { id: 'SB-2', parked: { reason: 'waiting on vendor', to: '2026-12-01' } },
      ],
      { by: 'owner', now: ISO },
    );
    expect(r.error).toEqual([]);
    expect(queue.tasks[0].parked).toEqual({ by: 'owner', at: ISO });
    expect(queue.tasks[1].parked).toEqual({
      by: 'owner',
      at: ISO,
      reason: 'waiting on vendor',
      to: '2026-12-01T23:59:59.000Z',
    });
    expect(L.editMany(queue, [{ id: 'SB-1', parked: null }], { now: ISO }).error).toEqual([]);
    expect(queue.tasks[0].parked).toBeUndefined();
  });

  it('parked: true on one that is already parked changes nothing', () => {
    const queue = reasonQueue();
    queue.tasks[0].parked = { by: 'x', at: '2026-10-01T00:00:00.000Z' };
    const r = L.editMany(queue, [{ id: 'SB-1', parked: true }], { now: ISO });
    expect(r.changes).toEqual([]);
    expect(queue.tasks[0].parked!.at).toBe('2026-10-01T00:00:00.000Z');
  });

  it('parked: only waiting and proposed, a valid future date, known fields; all or nothing', () => {
    const queue = reasonQueue();
    queue.tasks[2].status = 'running';
    const for_ = clone(queue);
    const r = L.editMany(
      queue,
      [
        { id: 'SB-1', project: 'ui' },
        { id: 'SB-3', parked: true },
        { id: 'SB-2', parked: { to: '2020-01-01' } },
        { id: 'V-1', parked: { why: 'x' } },
        { id: 'X-1', parked: 'yes' },
      ],
      { now: ISO },
    );
    const f = r.error.join('\n');
    expect(f).toContain('SB-3: status running (only waiting and proposed can be parked)');
    expect(f).toContain('the date 2020-01-01 has passed');
    expect(f).toContain('unknown field why');
    expect(f).toContain('X-1: parked must be true, null or');
    expect(queue).toEqual(for_);
  });

  it('batched: same rules as add/edit (D+, something depends on it, an open owner question); false removes the field', () => {
    const queue = reasonQueue();
    queue.tasks[0].class = 'D+';
    queue.tasks[2].waiting_on = ['Q1'];
    const for_ = clone(queue);
    const r = L.editMany(queue, [
      { id: 'SB-1', batched: true },
      { id: 'V-1', batched: true },
      { id: 'SB-3', batched: true },
    ]);
    const f = r.error.join('\n');
    expect(f).toContain('SB-1: batched: D+');
    expect(f).toContain('V-1: batched: V-2 depends on V-1');
    expect(f).toContain('SB-3: batched: SB-3 waits on owner questions');
    expect(queue).toEqual(for_);

    expect(L.editMany(queue, [{ id: 'SB-2', batched: true }]).error).toEqual([]);
    expect(queue.tasks[1].batched).toBe(true);
    expect(L.editMany(queue, [{ id: 'SB-2', batched: false }]).error).toEqual([]);
    expect('batched' in queue.tasks[1]).toBe(false);
  });

  it('batched is checked against the queue as it will be after the whole file', () => {
    const queue = reasonQueue();
    // V-2 (which depends on V-1) is not cancelled, so V-1 cannot go to the batch queue while V-2 is open.
    expect(L.editMany(queue, [{ id: 'V-1', batched: true }]).error.join()).toContain('V-2 depends on');
    queue.tasks[4].status = 'done';
    expect(L.editMany(queue, [{ id: 'V-1', batched: true }]).error).toEqual([]);
  });

  it('dry: changes nothing, but gives the same changes and warnings', () => {
    const queue = reasonQueue();
    queue.projects!.ui.pause = true;
    const for_ = clone(queue);
    const input = [
      { id: 'SB-1', project: 'ui' },
      { id: 'SB-2', feature: 'Data sheet' },
      { id: 'SB-3', priority_bonus: 5 },
    ];
    const t = L.editMany(queue, input, { now: ISO, dry: true });
    expect(queue).toEqual(for_);
    expect(t.error).toEqual([]);
    expect(t.changes).toEqual([
      { id: 'SB-1', field: 'project', before: null, after: 'ui' },
      { id: 'SB-2', field: 'feature', before: null, after: 'Data sheet' },
      { id: 'SB-3', field: 'priority_bonus', before: null, after: 5 },
    ]);
    expect(t.warnings!.join()).toContain('SB-1 is moved to ui, which is paused');
    const r = L.editMany(queue, input, { now: ISO });
    expect(r.changes).toEqual(t.changes);
    expect(r.warnings).toEqual(t.warnings);
    // What is already that way gives no change.
    expect(L.editMany(queue, input, { now: ISO, dry: true }).changes).toEqual([]);
  });

  it('the register fields area, fileRoot and features go via projects, and show in the changes', () => {
    const queue = reasonQueue();
    queue.areas = { goods: { title: 'Goods' } };
    const r = L.editMany(queue, {
      projects: {
        directory: { area: 'goods', fileRoot: ['lib/directory/'], features: ['Import'] },
      },
    });
    expect(r.error).toEqual([]);
    expect(r.changes).toEqual([
      { pid: 'directory', field: 'area', before: null, after: 'goods' },
      { pid: 'directory', field: 'features', before: null, after: ['Import'] },
      { pid: 'directory', field: 'fileRoot', before: null, after: ['lib/directory/'] },
    ]);
    expect(
      L.editMany(queue, { projects: { directory: { area: 'does-not-exist' } } }).error.join(),
    ).toContain('unknown area');
  });

  it('warns when a task that focus has dragged along is parked', () => {
    const queue = reasonQueue();
    queue.focus = { order: ['project:warehouse'], rest: 'wait' };
    queue.tasks[0].depends_on = ['X-1'];
    const r = L.editMany(queue, [{ id: 'X-1', parked: true }], { now: ISO });
    expect(r.error).toEqual([]);
    expect(r.warnings!.join()).toContain('X-1 is pulled along by SB-1');
  });
});

describe('expectCheck (optimistic concurrency)', () => {
  it('ok when the queue has not changed after the timestamp, denies when it has', () => {
    expect(L.expectCheck({ changed: ISO }, null)).toBeNull();
    expect(L.expectCheck({ changed: ISO }, ISO)).toBeNull();
    expect(L.expectCheck({ changed: ISO }, '2026-10-07T13:00:00Z')).toBeNull();
    expect(L.expectCheck({ changed: ISO }, '2026-10-07T11:59:59Z')).toContain('queue was changed');
    expect(L.expectCheck({}, ISO)).toBeNull();
    expect(L.expectCheck({ changed: ISO }, 'yesterday')).toContain('invalid');
  });
});

describe('changelog and undo', () => {
  const perform = (queue: Queue, input: unknown, action = 'edit-many') => {
    const forQueue = clone({ tasks: queue.tasks, projects: queue.projects });
    const r = L.editMany(queue, input, { by: 'owner', now: ISO });
    expect(r.error).toEqual([]);
    return L.logChange(queue, {
      by: 'owner',
      action,
      changes: L.bulkDiff(forQueue, queue),
      now: ISO,
    });
  };

  it('bulkDiff gives only fields that actually changed; no entry when nothing changed', () => {
    const queue = reasonQueue();
    expect(perform(queue, [{ id: 'SB-1', project: 'warehouse' }])!.changes).toEqual([
      { id: 'SB-1', field: 'project', before: null, after: 'warehouse' },
    ]);
    expect(perform(queue, [{ id: 'SB-1', project: 'warehouse' }])).toBeNull();
    expect(queue.changelog!.map((p) => p.nr)).toEqual([1]);
  });

  it('undo rolls back, and the next undo takes the entry before', () => {
    const queue = reasonQueue();
    const start = clone(queue.tasks);
    perform(queue, [{ id: 'SB-1', project: 'ui', feature: 'Swap' }]);
    perform(queue, [
      { id: 'SB-1', priority_bonus: 30 },
      { id: 'SB-2', parked: true },
    ]);
    const show = L.undoEntry(queue, { show: true });
    expect(show.error).toEqual([]);
    expect(show.entry!.nr).toBe(2);
    expect(queue.tasks[0].priority_bonus).toBe(30); // show changes nothing
    expect(L.undoEntry(queue, { by: 'owner', now: ISO }).entry!.nr).toBe(2);
    expect(queue.tasks[0].priority_bonus).toBeUndefined();
    expect(queue.tasks[1].parked).toBeUndefined();
    expect(L.undoEntry(queue, { by: 'owner', now: ISO }).entry!.nr).toBe(1);
    expect(queue.tasks).toEqual(start);
    expect(L.undoEntry(queue).error.join()).toContain('nothing to undo');
    // Entries stay, marked undone.
    expect(queue.changelog!.every((p) => p.undone?.by === 'owner')).toBe(true);
  });

  it('denies (and changes nothing) when a field has changed since', () => {
    const queue = reasonQueue();
    perform(queue, [{ id: 'SB-1', project: 'ui' }]);
    queue.tasks[0].project = 'report'; // someone else changed it
    const for_ = clone(queue);
    const r = L.undoEntry(queue, { now: ISO });
    expect(r.error.join()).toContain('SB-1 project has changed since');
    expect(queue).toEqual(for_);
  });

  it('denies when the result breaks the rules (parked on one that is running now)', () => {
    const queue = reasonQueue();
    perform(queue, [{ id: 'SB-1', parked: true }]);
    perform(queue, [{ id: 'SB-1', parked: null }]);
    queue.tasks[0].status = 'running';
    expect(L.undoEntry(queue, { now: ISO }).error.join()).toContain(
      'only waiting and proposed can be parked',
    );
  });

  it('a project the entry created goes away again; denies when a task uses it', () => {
    const queue = reasonQueue();
    perform(queue, { projects: { fresh: { title: 'New' } } });
    expect(queue.projects!.fresh).toBeDefined();
    expect(L.undoEntry(queue, { now: ISO }).error).toEqual([]);
    expect(queue.projects!.fresh).toBeUndefined();

    perform(queue, { projects: { fresh: { title: 'New' } } });
    queue.tasks[5].project = 'fresh';
    expect(L.undoEntry(queue, { now: ISO }).error.join()).toContain('X-1 uses the project fresh');
  });

  it('keeps the last CHANGELOG_MAX entries', () => {
    const queue = reasonQueue();
    for (let i = 1; i <= L.CHANGELOG_MAX + 5; i += 1)
      perform(queue, [{ id: 'SB-1', priority_bonus: i }]);
    expect(queue.changelog!.length).toBe(L.CHANGELOG_MAX);
    expect(queue.changelog![0].nr).toBe(6);
    expect(queue.changelog!.at(-1)!.nr).toBe(L.CHANGELOG_MAX + 5);
  });

  it('diffLines: short text per field', () => {
    expect(L.diffLines([{ id: 'A', field: 'project', before: null, after: 'ui' }])).toEqual([
      'A project: (none) → ui',
    ]);
  });
});

describe('rankBlock', () => {
  const order = (queue: Queue) => L.selectNext(queue, NOW).map((v) => v.id);
  const apply = (queue: Queue, e: Record<string, number | null>) =>
    expect(
      L.editMany(
        queue,
        Object.entries(e).map(([id, t]) => ({ id, priority_bonus: t })),
      ).error,
    ).toEqual([]);

  it('top: the block at the top, in the same relative order as before', () => {
    const queue = reasonQueue();
    expect(order(queue)).toEqual(['V-1', 'SB-3', 'X-1', 'SB-2', 'SB-1']);
    const r = L.rankBlock(queue, ['SB-1', 'SB-2'], { top: true }, NOW);
    expect(r.error).toEqual([]);
    apply(queue, r.changes!);
    expect(order(queue)).toEqual(['SB-2', 'SB-1', 'V-1', 'SB-3', 'X-1']);
  });

  it('bottom, over and under', () => {
    let queue = reasonQueue();
    apply(queue, L.rankBlock(queue, ['SB-3', 'V-1'], { bottom: true }, NOW).changes!);
    expect(order(queue)).toEqual(['X-1', 'SB-2', 'SB-1', 'V-1', 'SB-3']);

    queue = reasonQueue();
    // V-1 is at the top: "over" with no neighbor above puts the block one step above it.
    apply(queue, L.rankBlock(queue, ['SB-1', 'SB-2'], { over: 'V-1' }, NOW).changes!);
    expect(order(queue)).toEqual(['SB-2', 'SB-1', 'V-1', 'SB-3', 'X-1']);

    queue = reasonQueue();
    apply(queue, L.rankBlock(queue, ['SB-1', 'SB-3'], { under: 'X-1' }, NOW).changes!);
    expect(order(queue)).toEqual(['V-1', 'X-1', 'SB-3', 'SB-1', 'SB-2']);
  });

  it('denies on unknown, running, the reference inside the block, and without exactly one position', () => {
    const queue = reasonQueue();
    queue.tasks[3].status = 'running';
    expect(L.rankBlock(queue, ['V-1'], { top: true }, NOW).error.join()).toContain('status running');
    expect(L.rankBlock(queue, ['NO'], { top: true }, NOW).error.join()).toContain(
      'unknown task NO',
    );
    expect(L.rankBlock(queue, ['SB-1'], { over: 'SB-1' }, NOW).error.join()).toContain(
      'is in the block itself',
    );
    expect(L.rankBlock(queue, ['SB-1'], {}, NOW).error.join()).toContain('choose one of');
    expect(L.rankBlock(queue, ['SB-1'], { top: true, bottom: true }, NOW).error.join()).toContain(
      'choose one of',
    );
  });

  it('with focus: moves only within the stage; over/under requires the same stage', () => {
    const queue = reasonQueue();
    queue.focus = { order: ['project:ui', 'project:warehouse'], rest: 'fill' };
    expect(L.rankBlock(queue, ['SB-1'], { over: 'V-1' }, NOW).error.join()).toContain(
      'another stage than V-1',
    );
    // top moves SB-1 to the top of the goods stage, but never ahead of the ui stage.
    apply(queue, L.rankBlock(queue, ['SB-1'], { top: true }, NOW).changes!);
    const r = order(queue);
    expect(r.indexOf('SB-1')).toBeLessThan(r.indexOf('SB-3'));
    expect(r.indexOf('V-1')).toBeLessThan(r.indexOf('SB-1'));
  });
});

describe('suggestProject', () => {
  it('prefix (safe) when no strong signals contradict it', () => {
    const f = L.suggestProject(o('SB-9', { owned_files: ['components/goods/A.tsx'] }), REGISTER);
    expect(f).toMatchObject({
      pid: 'warehouse',
      signal: 'prefix',
      safe: true,
      disagree: false,
    });
  });

  it('the plan in the source when the prefix is missing', () => {
    const f = L.suggestProject(o('Y-1', { source: 'docs/report-plan.md § 3' }), REGISTER);
    expect(f).toMatchObject({ pid: 'report', signal: 'plan', safe: true });
    // Backslashes and just the file name work too.
    expect(
      L.suggestProject(o('Y-2', { source: 'see directory-plan.md part 4' }), REGISTER).pid,
    ).toBe('directory');
  });

  it('fileRoot: most owned files wins; a tie is ambiguous (Sort)', () => {
    expect(
      L.suggestProject(
        o('Y-1', { owned_files: ['lib/list/a.ts', 'lib/list/b.ts', 'lib/data/x.ts'] }),
        REGISTER,
      ),
    ).toMatchObject({ pid: 'ui', signal: 'fileRoot' });
    const t = L.suggestProject(
      o('Y-1', { owned_files: ['lib/list/a.ts', 'lib/data/x.ts'] }),
      REGISTER,
    );
    expect(t).toMatchObject({ pid: null, safe: false });
    expect(t.reason).toContain('equally many owned files');
    // "lib/list" without a slash is a file or folder, but not "lib/listX".
    expect(
      L.suggestProject(o('Y-1', { owned_files: ['lib/listX.ts'] }), REGISTER).pid,
    ).toBeNull();
  });

  it('an explicit project against strong signals gives disagree with a counter-proposal', () => {
    const f = L.suggestProject(
      o('Y-1', { project: 'report', owned_files: ['components/goods/A.tsx', 'lib/data/b.ts'] }),
      REGISTER,
    );
    expect(f).toMatchObject({
      pid: 'report',
      signal: 'explicit',
      disagree: true,
      counterProposal: 'warehouse',
    });
    // A prefix that contradicts an explicit project is deliberate (not disagree).
    expect(L.suggestProject(o('SB-1', { project: 'ui' }), REGISTER).disagree).toBe(false);
  });

  it('prefix against a strong signal: uncertain, with a counter-proposal', () => {
    const f = L.suggestProject(o('SB-1', { source: 'docs/report-plan.md' }), REGISTER);
    expect(f).toMatchObject({
      pid: 'warehouse',
      safe: false,
      disagree: true,
      counterProposal: 'report',
    });
  });

  it('no signals: Sort', () => {
    expect(L.suggestProject(o('Y-1'), REGISTER)).toMatchObject({
      pid: null,
      signal: null,
      safe: false,
    });
  });
});

describe('classifyQueue and the add warnings', () => {
  const queue = (): Queue => ({
    projects: clone(REGISTER),
    tasks: [
      o('SB-1'),
      o('Y-1', { source: 'docs/report-plan.md' }),
      o('Y-2'),
      o('Y-3', { project: 'ui', owned_files: ['components/goods/a.tsx'] }),
      o('Y-4', { source: 'docs/report-plan.md', status: 'done' }),
    ],
  });

  it('move (safe, without project), sort and disagree; finished ones are skipped', () => {
    const k = L.classifyQueue(queue());
    expect(k.move.map((r) => [r.id, r.proposed])).toEqual([['Y-1', 'report']]);
    expect(k.sort.map((r) => [r.id, r.type, r.proposed])).toEqual([
      ['Y-2', 'sort', null],
      ['Y-3', 'disagree', 'warehouse'],
    ]);
  });

  it('the filters --without-project and --disagree', () => {
    expect(L.classifyQueue(queue(), { withoutProject: true }).sort.map((r) => r.id)).toEqual(['Y-2']);
    const u = L.classifyQueue(queue(), { disagreeing: true });
    expect(u.move).toEqual([]);
    expect(u.sort.map((r) => r.id)).toEqual(['Y-3']);
  });

  it('add: proposal when the project is missing, Sort without a signal, disagree, and a new feature', () => {
    const adv = L.addProjectWarnings(
      [
        o('Y-1', { source: 'docs/report-plan.md' }),
        o('Y-2'),
        o('Y-3', { project: 'ui', owned_files: ['components/goods/a.tsx'] }),
        o('V-9', { feature: 'New things' }),
        o('V-8', { feature: 'overview' }),
        o('V-7', { feature: 'Swap' }),
      ],
      REGISTER,
    ).join('\n');
    expect(adv).toContain('Y-1 has no project; proposed report');
    expect(adv).toContain('Y-2 has no project and lands in "Sort"');
    expect(adv).toContain('Y-3: set to ui, but');
    expect(adv).toContain('V-9: new feature "New things" in ui');
    expect(adv).toContain('V-8: feature "overview" is called "Overview"');
    expect(adv).not.toContain('V-7');
    expect(L.addProjectWarnings([o('Y-2')], {})).toEqual([]);
  });
});

describe('queue.mjs: edit-many --dry/--expect-changed, rank, undo, classify (against a copy)', () => {
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
  const file = (name: string, content: unknown) => {
    const filePath = join(folder, name);
    writeFileSync(filePath, JSON.stringify(content));
    return filePath;
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-bulk-'));
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({ ...reasonQueue(), changed: ISO, next_migr: 1000 }, null, 2),
    );
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('--dry writes nothing; --json gives the changes and the version', () => {
    const f = file('m.json', [{ id: 'SB-1', parked: { reason: 'test' } }]);
    const for_ = readFileSync(join(folder, 'queue.json'), 'utf8');
    const r = run(['edit-many', '--file', f, '--dry', '--json']);
    expect(r.code).toBe(0);
    const answer = JSON.parse(r.out) as { ok: boolean; changed: string; changes: Change[] };
    expect(answer.ok).toBe(true);
    expect(answer.changed).toBe(ISO);
    expect(answer.changes.map((e) => [e.id, e.field])).toEqual([['SB-1', 'parked']]);
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(for_);
  });

  it('--expect-changed: exit 6 when the queue has changed since; ok with the correct version', () => {
    const f = file('m.json', [{ id: 'SB-1', project: 'ui' }]);
    const old = run(['edit-many', '--file', f, '--expect-changed', '2026-10-07T11:00:00Z']);
    expect(old.code).toBe(6);
    expect(old.error).toContain('queue was changed');
    expect(readQueue().tasks[0].project).toBeUndefined();
    const ok = run(['edit-many', '--file', f, '--expect-changed', ISO, '--by', 'board']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('undo: queue.mjs undo');
    const queue = readQueue();
    expect(queue.tasks[0].project).toBe('ui');
    expect(queue.changelog!.at(-1)).toMatchObject({ nr: 1, by: 'board', action: 'edit-many' });
  });

  it('an error in the file: nothing changes, and no entry in the changelog', () => {
    const f = file('m.json', [
      { id: 'SB-1', project: 'ui' },
      { id: 'SB-2', batched: 'yes' },
    ]);
    const r = run(['edit-many', '--file', f]);
    expect(r.code).toBe(1);
    expect(readQueue().tasks[0].project).toBeUndefined();
    expect(readQueue().changelog).toBeUndefined();
  });

  it('rank + park + undo: every write can be rolled back in reverse order', () => {
    const start = readQueue().tasks;
    expect(run(['rank', 'SB-1', 'SB-2', '--top']).code).toBe(0);
    expect(run(['park', 'X-1', '--reason', 'wait', '--by', 'owner']).code).toBe(0);
    expect(readQueue().changelog!.map((p) => p.action)).toEqual(['rank', 'park']);
    const show = run(['undo', '--show']);
    expect(show.out).toContain('no. 2 park');
    expect(run(['undo']).code).toBe(0);
    expect(readQueue().tasks[5].parked).toBeUndefined();
    expect(run(['undo']).code).toBe(0);
    expect(readQueue().tasks).toEqual(start);
    const empty = run(['undo']);
    expect(empty.code).toBe(1);
    expect(empty.error).toContain('nothing to undo');
  });

  it('classify --execute sets only the safe proposals; add warns when the project is missing', () => {
    const add = run([
      'add',
      '--json',
      JSON.stringify([
        {
          id: 'Y-1',
          title: 'Y',
          domain: 'y',
          class: 'K',
          mission: 'x',
          source: 'docs/report-plan.md',
        },
        { id: 'Y-2', title: 'Y', domain: 'y', class: 'K', mission: 'x' },
      ]),
    ]);
    expect(add.code).toBe(0);
    expect(add.out).toContain('Y-1 has no project; proposed report');
    expect(add.out).toContain('Y-2 has no project and lands in "Sort"');
    const show = run(['classify']);
    expect(show.out).toContain('Y-1');
    expect(readQueue().tasks.find((x) => x.id === 'Y-1')!.project).toBeUndefined();
    expect(run(['classify', '--execute']).code).toBe(0);
    const queue = readQueue();
    expect(queue.tasks.find((x) => x.id === 'Y-1')!.project).toBe('report');
    expect(queue.tasks.find((x) => x.id === 'Y-2')!.project).toBeUndefined();
    expect(queue.changelog!.at(-1)!.action).toBe('classify');
  });

  it('project --file-root and prefix warning', () => {
    const r = run([
      'project',
      'wide',
      '--title',
      'Wide',
      '--prefix',
      'S',
      '--file-root',
      'lib/x/',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('the prefix S in wide is only one character');
    expect(r.out).toContain('the prefix S in wide is the start of SB-');
    expect(readQueue().projects!.wide.fileRoot).toEqual(['lib/x/']);
  });
});
