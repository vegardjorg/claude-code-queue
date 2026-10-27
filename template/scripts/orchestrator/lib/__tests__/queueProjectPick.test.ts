// =============================================================
// queueProjectPick.test.ts: work queue (lib/queueLogic.js): project and feature (the prefix rule,
// pause and priority bonus per project), picking (pick/deliver/release/pickable, status picked that owns files
// but takes no agent slot), visual QA (set done → qa waiting, qa ok, qa deviation → <id>-QA<n>) and edit-many
// (all or nothing). The commands are described in docs/queue.md; the older rules are in queueLogic.test.ts.
// =============================================================
import { describe, it, expect } from 'vitest';

type Project = {
  title?: string;
  plan?: string;
  prefixes?: string[];
  pause?: boolean;
  priority_bonus?: number;
};
type Register = Record<string, Project>;
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
  owner_db?: string[];
  shared_patch?: string[];
  added_at?: string;
  added_by?: string;
  priority_bonus?: number;
  migr_tens?: number;
  migr_block?: string | null;
  branch?: string;
  project?: string;
  feature?: string;
  labels?: string[];
  picked_by?: string;
  picked_at?: string;
  qa_status?: string;
  qa_note?: string;
  qa_original?: string;
  remarks?: string[];
  delivered?: string;
  done?: string;
};
type Queue = {
  tasks: Task[];
  resolved?: string[];
  limits?: { maxConcurrent?: number; maxDPlus?: number; maxPerDomain?: number; maxDb?: number };
  projects?: Register;
  next_migr?: number;
};
type Selected = { id: string; score: number; estimate: number; project: string };
type Group = {
  pid: string;
  title: string | null;
  pause: boolean;
  features: { feature: string; tasks: Task[] }[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../queueLogic') as {
  WITHOUT_PROJECT: string;
  WITHOUT_FEATURE: string;
  validate: (o: unknown, ex?: Task[], register?: Register) => string[];
  blockers: (o: Task, all: Task[], resolved?: string[]) => string[];
  score: (o: Task, all: Task[], now?: number, register?: Register) => number;
  selectNext: (queue: Queue, now?: number) => Selected[];
  state: (queue: Queue) => { activeOnes: number; picked: number; qa: number; empty: boolean };
  projectFor: (o: Partial<Task>, register?: Register) => string;
  groups: (tasks: Task[], register?: Register) => Group[];
  projectOverview: (queue: Queue) => {
    pid: string;
    total: number;
    done: number;
    min_left: number;
    activeOnes: number;
    picked: number;
    pause: boolean;
    ownerQuestion: { sp: string; tasks: number }[];
  }[];
  newRegister: (
    register: Register | undefined,
    changes: unknown,
  ) => { register: Register; error: string[] };
  editMany: (
    queue: Queue,
    input: unknown,
  ) => { error: string[]; changed?: string[]; projects?: string[] };
  pickable: (
    queue: Queue,
    filter?: { label?: string; project?: string; maxMin?: number },
    now?: number,
  ) => { id: string; project: string; paused: boolean }[];
  pick: (
    queue: Queue,
    id: string,
    opt?: { by?: string; force?: boolean; now?: string },
  ) => { error?: string; blockers?: string[]; task?: Task; overridden?: string[] };
  deliver: (queue: Queue, id: string, now?: string) => { error?: string; task?: Task };
  release: (
    queue: Queue,
    id: string,
    opt?: { commits?: number; now?: string },
  ) => { error?: string; task?: Task; by?: string; warning?: string | null };
  isOldPick: (
    o: Task,
    git?: { commits?: number; lastCommit?: string | null },
    now?: number,
  ) => boolean;
  setStatus: (o: Task, status: string, now?: string) => { error?: string; qa?: boolean };
  qaList: (queue: Queue) => Group[];
  qaOk: (queue: Queue, ids: string[], now?: string) => { ok: string[]; error: string[] };
  qaDeviation: (
    queue: Queue,
    id: string,
    text: string,
    now?: string,
  ) => { error?: string; task?: Task; fix?: Task };
};

const NOW = Date.parse('2026-09-30T12:00:00Z');
const ISO = '2026-09-30T12:00:00.000Z';
const o = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  domain: 'ui',
  class: 'K',
  status: 'waiting',
  mission: 'x',
  title: id,
  ...extra,
});
const ids = (queue: Queue) => K.selectNext(queue, NOW).map((v) => v.id);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('project for a task', () => {
  const register: Register = {
    'alpha': { title: 'Alpha', prefixes: ['A-', 'AJ-'] },
    warehouse: { title: 'Warehouse', prefixes: ['SB-'] },
    // Overlaps with warehouse: the first project in the register wins.
    directory: { title: 'Directory', prefixes: ['SB-', 'K-'] },
  };

  it('follows the prefix rule from the register, and the first project wins', () => {
    expect(K.projectFor(o('A-T1a'), register)).toBe('alpha');
    expect(K.projectFor(o('AJ-1a'), register)).toBe('alpha');
    expect(K.projectFor(o('SB-P5d'), register)).toBe('warehouse');
    expect(K.projectFor(o('K-1a1'), register)).toBe('directory');
  });

  it('an explicit project wins over the prefix', () => {
    expect(K.projectFor(o('A-T1a', { project: 'warehouse' }), register)).toBe(
      'warehouse',
    );
  });

  it('without a match (and without a register) it is without-project; the prefix must come first in the id', () => {
    expect(K.projectFor(o('G-I4K'), register)).toBe(K.WITHOUT_PROJECT);
    expect(K.projectFor(o('XA-1'), register)).toBe(K.WITHOUT_PROJECT);
    expect(K.projectFor(o('A-T1a'))).toBe(K.WITHOUT_PROJECT);
    expect(K.WITHOUT_PROJECT).toBe('without-project');
  });

  it('groups project → feature in register order, without-project and without feature last', () => {
    const g = K.groups(
      [
        o('G-1'),
        o('SB-2', { feature: 'Ingredients' }),
        o('A-1', { feature: 'Overview' }),
        o('A-2'),
        o('A-3', { feature: 'Overview' }),
      ],
      register,
    );
    expect(g.map((p) => p.pid)).toEqual(['alpha', 'warehouse', K.WITHOUT_PROJECT]);
    expect(g[0].features.map((f) => f.feature)).toEqual(['Overview', K.WITHOUT_FEATURE]);
    expect(g[0].features[0].tasks.map((x) => x.id)).toEqual(['A-1', 'A-3']);
  });
});

describe('pause and priority bonus per project in next', () => {
  it('pause keeps a project out of next, without stopping the rest', () => {
    const queue: Queue = {
      projects: { gamma: { title: 'Gamma', prefixes: ['G-'], pause: true } },
      tasks: [o('G-1', { value: 10, domain: 'gamma' }), o('A-1', { value: 2 })],
    };
    expect(ids(queue)).toEqual(['A-1']);
    // When the project resumes, the task comes back (and highest, with value 10).
    queue.projects!.gamma.pause = false;
    expect(ids(queue)).toEqual(['G-1', 'A-1']);
  });

  it('the project priority_bonus is added to the task priority', () => {
    const queue: Queue = {
      limits: { maxConcurrent: 1 },
      projects: { delta: { title: 'Delta', prefixes: ['D-'], priority_bonus: 100 } },
      tasks: [o('A', { value: 9 }), o('D-1', { value: 3 })],
    };
    expect(ids(queue)).toEqual(['D-1']);
    const withoutBonus = K.score(queue.tasks[1], queue.tasks, NOW);
    expect(K.score(queue.tasks[1], queue.tasks, NOW, queue.projects)).toBe(withoutBonus + 100);
    expect(K.selectNext(queue, NOW)[0].project).toBe('delta');
  });
});

describe('status picked', () => {
  it('blocks a colliding task, but does not count toward maxConcurrent or maxDPlus', () => {
    const queue: Queue = {
      limits: { maxConcurrent: 1, maxDPlus: 1 },
      tasks: [
        o('P', {
          status: 'picked',
          picked_by: 'Kim',
          class: 'D+',
          owned_files: ['app/x.tsx'],
        }),
        o('CLASH', { value: 10, owned_files: ['app/x.tsx'] }),
        o('FREE', { value: 1, class: 'D+' }),
      ],
    };
    expect(K.blockers(queue.tasks[1], queue.tasks)).toEqual(['file app/x.tsx is owned by P']);
    // The slot (maxConcurrent 1) and the D+ cap (1) are available, because P is picked, not a queue agent.
    expect(ids(queue)).toEqual(['FREE']);
  });

  it('a delivered picked task (review) takes no agent slot either, but keeps ownership', () => {
    const queue: Queue = {
      limits: { maxConcurrent: 1 },
      tasks: [
        o('P', { status: 'review', picked_by: 'session-2', owned_files: ['a.ts'] }),
        o('CLASH', { owned_files: ['a.ts'] }),
        o('FREE'),
      ],
    };
    expect(ids(queue)).toEqual(['FREE']);
    // A normal review (queue agent) takes the slot.
    delete queue.tasks[0].picked_by;
    expect(ids(queue)).toEqual([]);
  });

  it('state: picked tasks do not keep the loop running, but are counted separately', () => {
    const t = K.state({ tasks: [o('P', { status: 'picked', picked_by: 'x' })] });
    expect(t.activeOnes).toBe(0);
    expect(t.picked).toBe(1);
    expect(t.empty).toBe(true);
  });
});

describe('pick, deliver and release', () => {
  const base = (): Queue => ({
    next_migr: 3450,
    resolved: [],
    tasks: [
      o('DONE', { status: 'done' }),
      o('OPEN', { status: 'waiting' }),
      o('KJ', { status: 'running', owned_files: ['app/common.tsx'] }),
      o('DEP', { depends_on: ['OPEN'] }),
      o('SP', { waiting_on: ['OWNER-1'] }),
      o('CLASH', { owned_files: ['app/common.tsx'] }),
      o('MIGR', { migr_tens: 2, depends_on: ['DONE'] }),
      o('SUGGESTION', { status: 'proposed' }),
    ],
  });

  it('denies on an open dependency, an owner question and an ownership collision', () => {
    const queue = base();
    for (const [id, reason] of [
      ['DEP', 'waiting on OPEN'],
      ['SP', 'waiting on answer: OWNER-1'],
      ['CLASH', 'file app/common.tsx is owned by KJ'],
    ]) {
      const r = K.pick(queue, id, { by: 'Kim', now: ISO });
      expect(r.error).toContain(reason);
      expect(queue.tasks.find((x) => x.id === id)!.status).toBe('waiting');
    }
  });

  it('--force overrides the blockers (with a remark), but never the status', () => {
    const queue = base();
    const r = K.pick(queue, 'CLASH', { by: 'Kim', force: true, now: ISO });
    expect(r.error).toBeUndefined();
    expect(r.overridden).toEqual(['file app/common.tsx is owned by KJ']);
    expect(r.task!.status).toBe('picked');
    expect(r.task!.remarks![0]).toContain('--force');
    expect(K.pick(queue, 'SUGGESTION', { by: 'Kim', force: true }).error).toContain('proposed');
    expect(K.pick(queue, 'KJ', { by: 'Kim', force: true }).error).toContain('status running');
    expect(K.pick(queue, 'CLASH', { by: 'Other', force: true }).error).toContain(
      'already picked by Kim',
    );
  });

  // The project has a migration flow (config().migrations.folder set); without it no task gets a block.
  const MIGR_ON = { folder: 'db/migrations', blockSize: 10 };

  it('requires --by, and assigns branch and migration block like start', () => {
    const queue = base();
    expect(K.pick(queue, 'MIGR', { by: '  ' }).error).toContain('--by');
    const r = K.pick(queue, 'MIGR', { by: 'session-7', now: ISO, migrations: MIGR_ON });
    expect(r.task).toMatchObject({
      status: 'picked',
      picked_by: 'session-7',
      picked_at: ISO,
      branch: 'queue/MIGR',
      migr_block: '3450–3469',
    });
    expect(queue.next_migr).toBe(3470);
    // Without migrations: no block, and next_migr stays.
    const r2 = K.pick(queue, 'OPEN', { by: 'session-7', now: ISO });
    expect(r2.task!.migr_block).toBeNull();
    expect(queue.next_migr).toBe(3470);
    // Without a migration flow in the project: no block even with migr_tens, and next_migr stays.
    const queue0 = base();
    const r0 = K.pick(queue0, 'MIGR', { by: 'session-7', now: ISO, migrations: { folder: null } });
    expect(r0.task!.migr_block).toBeNull();
    expect(queue0.next_migr).toBe(3450);
  });

  it('deliver: picked → review (picked_by stays); deliver on anything else is refused', () => {
    const queue = base();
    K.pick(queue, 'OPEN', { by: 'Kim', now: ISO });
    const r = K.deliver(queue, 'OPEN', ISO);
    expect(r.task).toMatchObject({ status: 'review', delivered: ISO, picked_by: 'Kim' });
    expect(K.deliver(queue, 'OPEN').error).toContain('is not picked');
    expect(K.deliver(queue, 'MISSING').error).toContain('unknown');
  });

  it('release: picked → waiting, removes the pick fields, keeps branch and block, and warns on commits', () => {
    const queue = base();
    K.pick(queue, 'MIGR', { by: 'Kim', now: ISO, migrations: MIGR_ON });
    const without = K.release(clone(queue), 'MIGR', { commits: 0, now: ISO });
    expect(without.warning).toBeNull();
    expect(without.task!.remarks).toBeUndefined();

    const r = K.release(queue, 'MIGR', { commits: 3, now: ISO });
    expect(r.by).toBe('Kim');
    expect(r.task!.status).toBe('waiting');
    expect(r.task!.picked_by).toBeUndefined();
    expect(r.task!.picked_at).toBeUndefined();
    expect(r.task!.branch).toBe('queue/MIGR');
    expect(r.warning).toContain('3 commit(s)');
    expect(r.warning).toContain('kept');
    const remarks = r.task!.remarks!;
    expect(remarks[remarks.length - 1]).toContain('released by Kim');
    // If it is picked again, the block is reused (the numbers on the kept branch are still its own).
    const left = K.pick(queue, 'MIGR', { by: 'Other', now: ISO, migrations: MIGR_ON });
    expect(left.task!.migr_block).toBe('3450–3469');
    expect(queue.next_migr).toBe(3470);
    expect(K.release(queue, 'OPEN').error).toContain('is not picked');
  });

  it('pickable: only what can be picked now, filtered and sorted; pause does not stop picking', () => {
    const queue: Queue = {
      projects: { gamma: { title: 'Gamma', prefixes: ['G-'], pause: true } },
      tasks: [
        o('KJ', { status: 'running', owned_files: ['a.ts'] }),
        o('CLASH', { owned_files: ['a.ts'] }),
        o('SHOW', { labels: ['visual'], value: 9 }),
        o('LONG', { content_min: 120 }),
        o('G-1', { value: 2 }),
      ],
    };
    const all = K.pickable(queue, {}, NOW);
    expect(all.map((p) => p.id)).toEqual(['SHOW', 'G-1', 'LONG']);
    expect(all.find((p) => p.id === 'G-1')!.paused).toBe(true);
    expect(K.pickable(queue, { label: 'visual' }, NOW).map((p) => p.id)).toEqual(['SHOW']);
    expect(K.pickable(queue, { project: 'gamma' }, NOW).map((p) => p.id)).toEqual(['G-1']);
    expect(K.pickable(queue, { maxMin: 60 }, NOW).map((p) => p.id)).toEqual(['SHOW', 'G-1']);
  });

  it('"old": picked over 72 h ago with no commits in the last 72 h', () => {
    const picked = o('P', {
      status: 'picked',
      picked_by: 'x',
      picked_at: '2026-09-26T12:00:00Z',
    });
    expect(K.isOldPick(picked, { commits: 0 }, NOW)).toBe(true);
    expect(K.isOldPick(picked, { commits: 2, lastCommit: '2026-09-30T08:00:00Z' }, NOW)).toBe(
      false,
    );
    expect(K.isOldPick(picked, { commits: 2, lastCommit: '2026-09-26T13:00:00Z' }, NOW)).toBe(
      true,
    );
    const fresh = { ...picked, picked_at: '2026-09-29T12:00:00Z' };
    expect(K.isOldPick(fresh, { commits: 0 }, NOW)).toBe(false);
    expect(K.isOldPick({ ...picked, status: 'waiting' }, { commits: 0 }, NOW)).toBe(false);
  });
});

describe('visual QA', () => {
  const base = (): Queue => ({
    projects: { 'alpha': { title: 'Alpha', prefixes: ['A-'] } },
    tasks: [
      o('A-1', {
        status: 'review',
        labels: ['visual'],
        feature: 'Overview',
        title: 'The card shows the wrong summary',
        mission: 'scripts/.queue/mission/A-1.md',
        owned_files: ['components/ui/Summary.tsx'],
        value: 8,
      }),
      o('A-2', { status: 'review' }),
    ],
  });

  it('set done on a visual task gives qa_status waiting; otherwise no QA', () => {
    const queue = base();
    const r = K.setStatus(queue.tasks[0], 'done', ISO);
    expect(r.qa).toBe(true);
    expect(queue.tasks[0]).toMatchObject({ status: 'done', done: ISO, qa_status: 'waiting' });
    expect(K.setStatus(queue.tasks[1], 'done', ISO).qa).toBe(false);
    expect(queue.tasks[1].qa_status).toBeUndefined();
    // QA list: project → feature → task, and state counts it.
    const list = K.qaList(queue);
    expect(list).toHaveLength(1);
    expect(list[0].pid).toBe('alpha');
    expect(list[0].features[0].feature).toBe('Overview');
    expect(list[0].features[0].tasks.map((x) => x.id)).toEqual(['A-1']);
    expect(K.state(queue).qa).toBe(1);
  });

  it('set picked is refused (use pick), and setting a picked task to waiting removes the pick fields', () => {
    const p = o('P', { status: 'picked', picked_by: 'x', picked_at: ISO });
    expect(K.setStatus(p, 'picked').error).toContain('pick');
    expect(K.setStatus(p, 'junk').error).toContain('unknown status');
    K.setStatus(p, 'waiting', ISO);
    expect(p.status).toBe('waiting');
    expect(p.picked_by).toBeUndefined();
  });

  it('qa deviation creates <id>-QA1 and then -QA2, with the same project and feature', () => {
    const queue = base();
    K.setStatus(queue.tasks[0], 'done', ISO);
    const r1 = K.qaDeviation(queue, 'A-1', 'The button is under 44 px on mobile', ISO);
    expect(r1.error).toBeUndefined();
    expect(queue.tasks[0]).toMatchObject({
      qa_status: 'deviation',
      qa_note: 'The button is under 44 px on mobile',
    });
    expect(r1.fix).toMatchObject({
      id: 'A-1-QA1',
      class: 'K',
      domain: 'ui',
      project: 'alpha',
      feature: 'Overview',
      labels: ['visual'],
      added_by: 'owner',
      status: 'waiting',
      qa_original: 'A-1',
      owned_files: ['components/ui/Summary.tsx'],
      value: 8,
    });
    expect(r1.fix!.mission).toContain('The button is under 44 px on mobile');
    expect(r1.fix!.mission).toContain('A-1');
    expect(r1.fix!.mission).toContain('scripts/.queue/mission/A-1.md');

    const r2 = K.qaDeviation(queue, 'A-1', 'Still the wrong color in dark mode', ISO);
    expect(r2.fix!.id).toBe('A-1-QA2');

    // A deviation on a fix task continues the numbering from the original.
    const qa1 = queue.tasks.find((x) => x.id === 'A-1-QA1')!;
    K.setStatus(qa1, 'done', ISO);
    expect(qa1.qa_status).toBe('waiting');
    expect(K.qaDeviation(queue, 'A-1-QA1', 'Almost, but the text is cut off', ISO).fix!.id).toBe(
      'A-1-QA3',
    );

    expect(K.qaDeviation(queue, 'A-2', '', ISO).error).toBeDefined();
    expect(K.qaDeviation(queue, 'A-1-QA2', 'x', ISO).error).toContain('is not done');
  });

  it('qa ok is all or nothing, and accepts waiting and deviation', () => {
    const queue = base();
    K.setStatus(queue.tasks[0], 'done', ISO);
    const error = K.qaOk(queue, ['A-1', 'A-2'], ISO);
    expect(error.ok).toEqual([]);
    expect(error.error[0]).toContain('A-2');
    expect(queue.tasks[0].qa_status).toBe('waiting');
    expect(K.qaOk(queue, ['A-1'], ISO).ok).toEqual(['A-1']);
    expect(queue.tasks[0].qa_status).toBe('ok');
    expect(K.qaList(queue)).toEqual([]);
  });
});

describe('edit-many and register', () => {
  const base = (): Queue => ({
    projects: { gamma: { title: 'Gamma', prefixes: ['G-'] } },
    tasks: [o('A'), o('B'), o('G-1')],
  });

  it('is all or nothing: one error, and nothing is changed (not the register either)', () => {
    const queue = base();
    const for_ = clone(queue);
    const r = K.editMany(queue, {
      projects: { delta: { title: 'Delta', prefixes: ['D-'] } },
      tasks: [
        { id: 'A', project: 'delta', feature: 'Upgrade' },
        { id: 'B', project: 'does-not-exist' },
        { id: 'UNKNOWN', feature: 'x' },
        { id: 'G-1', status: 'done' },
      ],
    });
    expect(r.error.length).toBe(3);
    expect(r.error.join('\n')).toContain('unknown project does-not-exist');
    expect(r.error.join('\n')).toContain('UNKNOWN: unknown task');
    expect(r.error.join('\n')).toContain('unknown field status');
    expect(queue).toEqual(for_);
  });

  it('applies everything when everything is valid; null removes a field', () => {
    const queue = base();
    queue.tasks[2].feature = 'Import';
    const r = K.editMany(queue, {
      projects: { delta: { title: 'Delta', prefixes: ['D-'], priority_bonus: 20 } },
      tasks: [
        { id: 'A', project: 'delta', feature: 'Upgrade', labels: ['visual'] },
        { id: 'G-1', feature: null },
      ],
    });
    expect(r.error).toEqual([]);
    expect(r.changed).toEqual(['A', 'G-1']);
    expect(r.projects).toEqual(['delta']);
    expect(queue.projects!.delta.priority_bonus).toBe(20);
    expect(queue.tasks[0]).toMatchObject({
      project: 'delta',
      feature: 'Upgrade',
      labels: ['visual'],
    });
    expect(queue.tasks[2].feature).toBeUndefined();
    // A plain list (without projects) works too.
    expect(K.editMany(queue, [{ id: 'B', project: 'gamma' }]).error).toEqual([]);
    expect(queue.tasks[1].project).toBe('gamma');
  });

  it('register: a new project requires a title, the id is kebab-case, the fields have the correct type', () => {
    expect(K.newRegister({}, { gamma: { prefixes: ['G-'] } }).error[0]).toContain(
      'title missing',
    );
    expect(K.newRegister({}, { Gamma: { title: 'x' } }).error[0]).toContain('kebab-case');
    expect(K.newRegister({}, { 'without-project': { title: 'x' } }).error[0]).toContain(
      'kebab-case',
    );
    const types = K.newRegister(
      {},
      {
        a: {
          title: 'A',
          pause: 'yes',
          priority_bonus: 'much',
          prefixes: ['TF -'],
          color: 'red',
        },
      },
    ).error.join('\n');
    for (const chunk of ['pause', 'priority_bonus', 'prefixes', 'unknown field color'])
      expect(types).toContain(chunk);
    // Changing an existing project keeps the rest; null removes (pause off).
    const r = K.newRegister({ gamma: { title: 'Gamma', pause: true } }, { gamma: { pause: null } });
    expect(r.error).toEqual([]);
    expect(r.register.gamma).toEqual({ title: 'Gamma' });
  });

  it('project overview: done/total, minutes left, active ones, picked and blocking owner questions', () => {
    const queue: Queue = {
      projects: { gamma: { title: 'Gamma', prefixes: ['G-'], pause: true } },
      resolved: ['OWNER-2'],
      tasks: [
        o('G-1', { status: 'done' }),
        o('G-2', { status: 'running', content_min: 20 }),
        o('G-3', { status: 'picked', picked_by: 'x', content_min: 10 }),
        o('G-4', { waiting_on: ['OWNER-1', 'OWNER-2'], content_min: 30 }),
        o('G-5', { waiting_on: ['OWNER-1'], content_min: 30 }),
        o('G-6', { status: 'cancelled' }),
        o('OTHER'),
      ],
    };
    const [gamma, without] = K.projectOverview(queue);
    expect(gamma).toMatchObject({
      pid: 'gamma',
      total: 5,
      done: 1,
      min_left: 90,
      activeOnes: 1,
      picked: 1,
      pause: true,
      ownerQuestion: [{ sp: 'OWNER-1', tasks: 2 }],
    });
    expect(without.pid).toBe(K.WITHOUT_PROJECT);
  });
});

describe('backward compatible: old queue.json without the new fields', () => {
  const old = (): Queue => ({
    limits: { maxConcurrent: 2 },
    resolved: [],
    tasks: [
      o('A', { value: 9 }),
      o('B', { value: 5, owned_files: ['x.ts'] }),
      o('C', { status: 'running', owned_files: ['x.ts'] }),
      o('D', { value: 3 }),
    ],
  });

  it('next, priority, validation and state are as before', () => {
    const queue = old();
    expect(ids(queue)).toEqual(['A']);
    const s = K.score(queue.tasks[0], queue.tasks, NOW);
    expect(K.score(queue.tasks[0], queue.tasks, NOW, queue.projects)).toBe(s);
    expect(K.validate(o('NEW'), queue.tasks)).toEqual([]);
    // Without a register the project name is not validated against it (it does not exist yet).
    expect(K.validate(o('NEW', { project: 'gamma' }), queue.tasks, queue.projects)).toEqual([]);
    expect(
      K.validate(o('NEW', { labels: 'visual' as unknown as string[] }), queue.tasks)[0],
    ).toContain('labels');
    const t = K.state(queue);
    expect(t).toMatchObject({ activeOnes: 1, picked: 0, qa: 0, empty: false });
    expect(K.projectOverview(queue).map((r) => r.pid)).toEqual([K.WITHOUT_PROJECT]);
  });

  it('with a register an explicit project must exist in it', () => {
    const reg: Register = { gamma: { title: 'Gamma' } };
    expect(K.validate(o('NEW', { project: 'gamma' }), [], reg)).toEqual([]);
    expect(K.validate(o('NEW', { project: 'lnon' }), [], reg)[0]).toContain('unknown project lnon');
  });
});
