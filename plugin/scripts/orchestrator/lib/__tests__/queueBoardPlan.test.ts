// =============================================================
// queueBoardPlan.test.ts: queue-board: focus from the plan view (queueLogic.saveFocusPlan, all or nothing),
// the points in "Placement" (scoreParts = score), the cards' place and sorting with focus (queueBoard.board), "Waiting on you"
// sorted by what the answer unlocks in focus, the "Sort" list and the bulk action accept-suggestion, the preview of
// "Save focus" and areas from the board (areaPlan), and queue.mjs focus save / area with --expect-changed against a copy in
// a temporary folder (never the real queue).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
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
  added_at?: string;
  priority_bonus?: number;
};
type Project = {
  title: string;
  prefixes?: string[];
  pause?: boolean;
  area?: string;
  fileRoot?: string[];
  priority_bonus?: number;
};
type Queue = {
  tasks: Task[];
  resolved?: string[];
  projects?: Record<string, Project>;
  areas?: Record<string, { title: string; description?: string | null }>;
  question?: Record<string, { text: string }>;
  focus?: Record<string, unknown>;
  changed?: string;
  next_migr?: number;
};
type Space = {
  step: number | null;
  outside: boolean;
  out: boolean;
  reason: string | null;
  nr?: number;
  by?: number;
};
type Summary = { id: string; ready: boolean; area: string; space: Space | null };
type Question = {
  sp: string;
  count: number;
  focus: { count: number; minutes: number; per_step: number[] } | null;
};
type SaveAnswer = {
  error: string[];
  warnings: string[];
  focus?: Record<string, unknown> | null;
  removed?: boolean;
  paused?: string[];
  still?: string[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  FOCUS_PLAN_MAX: number;
  saveFocusPlan: (queue: Queue, input: Record<string, unknown>, now?: string) => SaveAnswer;
  scoreParts: (
    o: Task,
    tasks: Task[],
    now: number,
    register: Record<string, Project>,
  ) => { score: number; value: number; minutes: number; unlocks: number };
  score: (
    o: Task,
    tasks: Task[],
    now: number,
    register: Record<string, Project>,
  ) => number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard') as {
  board: (
    queue: Queue,
    option?: { now?: number },
  ) => {
    columns: Record<string, Summary[]>;
    focus: { active: boolean; now_count: number; stage: { title: string }[] } | null;
    areas: { oid: string; title: string; projects: string[] }[];
    inbox: {
      count: number;
      focus_sorted: boolean;
      question: Question[];
      sort: { id: string; type: string; proposed: string | null }[];
    };
  };
  sortList: (queue: Queue) => { id: string; type: string; proposed: string | null }[];
  bulkPlan: (
    queue: Queue,
    action: string,
    ids: string[],
  ) => { error: string[]; command?: string; content?: { tasks: Record<string, unknown>[] } };
  focusPreview: (
    queue: Queue,
    input: Record<string, unknown>,
    option?: { now?: number },
  ) => {
    error: string[];
    lines: string[];
    before_text: string;
    after_text: string;
    next: { id: string }[];
  };
  AREA_ACTIONS: string[];
  areaPlan: (
    queue: Queue,
    b: Record<string, unknown>,
  ) => { error: string[]; args?: string[]; lines?: string[] };
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
/**
 * Goods (area Core) and Calendar (without area), a paused project, two owner questions and two tasks without a project
 * (X-1 has files under the ui fileRoot, so a proposal; X-2 has nothing).
 */
const reasonQueue = (): Queue => ({
  tasks: [
    o('SB-1', { value: 8 }),
    o('SB-2', { depends_on: ['SB-1'] }),
    o('SB-3', { waiting_on: ['Q-2'] }),
    o('SB-4', { depends_on: ['SB-3'] }),
    o('V-1', { added_at: '2026-10-01T00:00:00.000Z', priority_bonus: 2 }),
    o('V-2', { waiting_on: ['Q-1'] }),
    o('P-1'),
    o('X-1', { owned_files: ['app/ui/list.tsx'] }),
    o('X-2'),
  ],
  projects: {
    goods: { title: 'Goods', prefixes: ['SB-'], area: 'core' },
    ui: { title: 'Calendar', prefixes: ['V-'], fileRoot: ['app/ui/'], priority_bonus: 1 },
    paused: { title: 'Paused', prefixes: ['P-'], pause: true },
  },
  areas: { core: { title: 'Core' } },
  question: { 'Q-1': { text: 'Question about ui' }, 'Q-2': { text: 'Question about goods' } },
  resolved: [],
  changed: ISO,
});

describe('saveFocusPlan: focus and pause from the plan view in one change', () => {
  it('sets focus, pauses and continues in the same change', () => {
    const queue = reasonQueue();
    const r = L.saveFocusPlan(
      queue,
      {
        order: ['project:ui', 'area:core'],
        now_count: 1,
        pause: [],
        continue: ['paused'],
      },
      ISO,
    );
    expect(r.error).toEqual([]);
    expect(r.still).toEqual(['paused']);
    expect(queue.focus).toMatchObject({
      order: ['project:ui', 'area:core'],
      now_count: 1,
    });
    expect(queue.projects?.paused.pause).toBeUndefined();
  });

  it('all or nothing: one error, and the queue is untouched', () => {
    const queue = reasonQueue();
    const for_ = JSON.stringify(queue);
    expect(
      L.saveFocusPlan(queue, { order: ['project:ui'], pause: ['exists-not'] }).error[0],
    ).toMatch(/unknown project exists-not/);
    expect(
      L.saveFocusPlan(queue, { order: ['project:ui'], pause: ['ui'], continue: ['ui'] })
        .error[0],
    ).toMatch(/in both pause and continue/);
    expect(
      L.saveFocusPlan(queue, { order: ['project:exists-not'], pause: ['goods'] }).error.length,
    ).toBeGreaterThan(0);
    expect(L.saveFocusPlan(queue, { order: 'project:ui' }).error[0]).toMatch(
      /must be a list/,
    );
    expect(JSON.stringify(queue)).toBe(for_);
  });

  it('now_count must lie between 1 and the number of stages', () => {
    const queue = reasonQueue();
    expect(L.saveFocusPlan(queue, { order: ['project:ui'], now_count: 2 }).error[0]).toMatch(
      /now_count/,
    );
    expect(L.saveFocusPlan(queue, { order: ['project:ui'], now_count: 0 }).error[0]).toMatch(
      /now_count/,
    );
    expect(L.saveFocusPlan(queue, { order: ['project:ui'], now_count: 1 }).error).toEqual([]);
  });

  it('an empty order removes focus', () => {
    const queue = reasonQueue();
    L.saveFocusPlan(queue, { order: ['project:ui'] }, ISO);
    const r = L.saveFocusPlan(queue, { order: [] }, ISO);
    expect(r).toMatchObject({ error: [], removed: true, focus: null });
    expect(queue.focus).toBeUndefined();
  });

  it('too many stages are denied', () => {
    const queue = reasonQueue();
    const many = Array.from({ length: L.FOCUS_PLAN_MAX + 1 }, (_, i) => `project:p${i}`);
    expect(L.saveFocusPlan(queue, { order: many }).error[0]).toMatch(/at most/);
  });
});

describe('scoreParts: the points in "Placement" are the same as the queue uses', () => {
  it('the score from the parts equals score() for all pending', () => {
    const queue = reasonQueue();
    const register = queue.projects ?? {};
    for (const x of queue.tasks) {
      const d = L.scoreParts(x, queue.tasks, NOW, register);
      expect(d.score).toBe(L.score(x, queue.tasks, NOW, register));
    }
    const sk1 = L.scoreParts(queue.tasks[0], queue.tasks, NOW, register);
    expect(sk1).toMatchObject({ value: 8, minutes: 30, unlocks: 1 });
  });
});

describe('board(): place, area and sorting with focus', () => {
  it('without focus: no stage, areas from the register', () => {
    const t = T.board(reasonQueue(), { now: NOW });
    expect(t.focus).toBeNull();
    const sk1 = t.columns.queue.find((k) => k.id === 'SB-1');
    expect(sk1?.space?.step).toBeNull();
    expect(sk1?.area).toBe('core');
    expect(t.columns.queue.find((k) => k.id === 'V-1')?.area).toBe('without-area');
    expect(t.areas.find((x) => x.oid === 'core')).toMatchObject({
      title: 'Core',
      projects: ['goods'],
    });
  });

  it('with focus on Calendar (rest waiting): Calendar first with nr/by, Goods outside with a reason', () => {
    const queue = reasonQueue();
    L.saveFocusPlan(queue, { order: ['project:ui'] }, '2026-10-07T11:00:00.000Z');
    const t = T.board(queue, { now: NOW });
    expect(t.focus).toMatchObject({ active: true, now_count: 1 });
    const ids = t.columns.queue.map((k) => k.id);
    const v1 = t.columns.queue.find((k) => k.id === 'V-1');
    const sk1 = t.columns.queue.find((k) => k.id === 'SB-1');
    expect(v1?.space).toMatchObject({ step: 0, outside: false, nr: 1, by: 1 });
    expect(v1?.ready).toBe(true);
    expect(sk1?.space).toMatchObject({ step: null, outside: true, out: true });
    expect(sk1?.space?.reason).toMatch(/outside focus/);
    expect(sk1?.ready).toBe(false);
    expect(ids.indexOf('V-1')).toBeLessThan(ids.indexOf('SB-1'));
  });
});

describe('"Waiting on you": questions sorted by what the answer unlocks in focus', () => {
  it('without focus: most tasks first (Q-2 unlocks two)', () => {
    const i = T.board(reasonQueue(), { now: NOW }).inbox;
    expect(i.focus_sorted).toBe(false);
    expect(i.question.map((s) => s.sp)).toEqual(['Q-2', 'Q-1']);
    expect(i.question[0].focus).toBeNull();
  });

  it('with focus on Calendar: Q-1 first, with the minutes per stage', () => {
    const queue = reasonQueue();
    L.saveFocusPlan(queue, { order: ['project:ui'] }, '2026-10-07T11:00:00.000Z');
    const i = T.board(queue, { now: NOW }).inbox;
    expect(i.focus_sorted).toBe(true);
    expect(i.question.map((s) => s.sp)).toEqual(['Q-1', 'Q-2']);
    expect(i.question[0].focus).toEqual({ per_step: [30], count: 1, minutes: 30 });
    expect(i.question[1].focus?.count).toBe(0);
  });
});

describe('"Sort" and accept-suggestion', () => {
  it('tasks without a project are in the list, with a proposal where the signals point one way', () => {
    const queue = reasonQueue();
    const rows = T.sortList(queue);
    expect(rows.find((r) => r.id === 'X-1')).toMatchObject({ type: 'move', proposed: 'ui' });
    expect(rows.find((r) => r.id === 'X-2')).toMatchObject({ type: 'sort', proposed: null });
    // Sort is cleanup: it is not counted in the count on "Waiting on you".
    const i = T.board(queue, { now: NOW }).inbox;
    expect(i.sort.map((r) => r.id)).toEqual(expect.arrayContaining(['X-1', 'X-2']));
    expect(i.count).toBe(i.question.length);
  });

  it('accept-suggestion becomes edit-many with the proposed project, and denies without a proposal', () => {
    const queue = reasonQueue();
    expect(T.bulkPlan(queue, 'accept-suggestion', ['X-1', 'X-2'])).toEqual({
      error: [],
      command: 'edit-many',
      content: { tasks: [{ id: 'X-1', project: 'ui' }] },
    });
    expect(T.bulkPlan(queue, 'accept-suggestion', ['X-2']).error[0]).toMatch(
      /none of the marked ones has a proposed/,
    );
  });
});

describe('focusPreview: "Save focus" explained before it is saved', () => {
  it('the steps, rest, drag along and the period, without changing the queue', () => {
    const queue = reasonQueue();
    const for_ = JSON.stringify(queue);
    const f = T.focusPreview(
      queue,
      { order: ['project:ui', 'area:core'] },
      { now: NOW },
    );
    expect(f.error).toEqual([]);
    expect(f.before_text).toBe('no focus');
    expect(f.lines[0]).toMatch(/^Now, stage 1: Calendar/);
    expect(f.lines[1]).toMatch(/^Next, stage 2: Core/);
    expect(f.lines.some((x) => /waits fully/.test(x))).toBe(true);
    expect(f.lines.some((x) => /applies until you change it/.test(x))).toBe(true);
    expect(f.next.map((n) => n.id)).toContain('V-1');
    expect(JSON.stringify(queue)).toBe(for_);
  });

  it('an error gives no lines, and an empty order explains that focus is removed', () => {
    const queue = reasonQueue();
    expect(
      T.focusPreview(queue, { order: ['project:no'] }, { now: NOW }).error.length,
    ).toBeGreaterThan(0);
    L.saveFocusPlan(queue, { order: ['project:ui'] }, '2026-10-07T11:00:00.000Z');
    const f = T.focusPreview(queue, { order: [] }, { now: NOW });
    expect(f.lines[0]).toMatch(/Focus is removed/);
    expect(f.after_text).toBe('no focus');
  });
});

describe('areaPlan: areas from the board', () => {
  it('save, delete and move become queue.mjs area arguments with an explanation', () => {
    const queue = reasonQueue();
    expect(T.AREA_ACTIONS).toEqual(['save', 'delete', 'move']);
    expect(T.areaPlan(queue, { action: 'save', oid: 'production', title: 'Operations' })).toMatchObject({
      error: [],
      args: ['area', 'production', '--title', 'Operations'],
    });
    const move = T.areaPlan(queue, { action: 'move', pid: 'ui', oid: 'core' });
    expect(move.args).toEqual(['area', 'core', '--projects', 'ui']);
    expect(move.lines?.[0]).toMatch(/from without area to core/);
    expect(T.areaPlan(queue, { action: 'move', pid: 'goods', oid: null }).args).toEqual([
      'area',
      'core',
      '--remove',
      'goods',
    ]);
    // Core is used by Goods: delete is denied.
    expect(T.areaPlan(queue, { action: 'delete', oid: 'core' }).error.length).toBeGreaterThan(0);
    expect(T.areaPlan(queue, { action: 'guess' }).error[0]).toMatch(/unknown action/);
    expect(T.areaPlan(queue, { action: 'move', pid: 'goods', oid: 'core' }).error[0]).toMatch(
      /already/,
    );
  });
});

describe('queue.mjs: focus save and area with --expect-changed (against a copy)', () => {
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
  const plan = (input: Record<string, unknown>): string => {
    const file = join(folder, 'plan.json');
    writeFileSync(file, JSON.stringify(input));
    return file;
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-board5b-'));
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({ ...reasonQueue(), next_migr: 1000 }, null, 2),
    );
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('focus save --dry --json writes nothing; without --dry it saves focus and pause in one change', () => {
    const for_ = readFileSync(join(folder, 'queue.json'), 'utf8');
    const file = plan({ order: ['project:ui'], continue: ['paused'] });
    const t = run(['focus', 'save', '--file', file, '--dry', '--json']);
    expect(t.code).toBe(0);
    expect(JSON.parse(t.out)).toMatchObject({
      ok: true,
      dry: true,
      changed: ISO,
      still: ['paused'],
    });
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(for_);

    const r = run([
      'focus',
      'save',
      '--file',
      file,
      '--json',
      '--expect-changed',
      ISO,
      '--by',
      'theBoard',
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, dry: false, still: ['paused'] });
    const queue = readQueue();
    expect(queue.focus).toMatchObject({ order: ['project:ui'], set_by: 'theBoard' });
    expect(queue.projects?.paused.pause).toBeUndefined();
  });

  it('focus save: an outdated preview gives exit 6, an error gives exit 1, and nothing is written', () => {
    const for_ = readFileSync(join(folder, 'queue.json'), 'utf8');
    const old = run([
      'focus',
      'save',
      '--file',
      plan({ order: ['project:ui'] }),
      '--json',
      '--expect-changed',
      '2026-10-01T00:00:00.000Z',
    ]);
    expect(old.code).toBe(6);
    expect(JSON.parse(old.out)).toMatchObject({ ok: false, outdated: true });
    const error = run([
      'focus',
      'save',
      '--file',
      plan({ order: ['project:ui'], pause: ['no'] }),
      '--json',
    ]);
    expect(error.code).toBe(1);
    expect((JSON.parse(error.out) as { error: string[] }).error[0]).toMatch(/unknown project no/);
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(for_);
  });

  it('area --expect-changed: outdated gives exit 6, the current version saves', () => {
    const for_ = readFileSync(join(folder, 'queue.json'), 'utf8');
    const old = run([
      'area',
      'production',
      '--title',
      'Operations',
      '--expect-changed',
      '2026-10-01T00:00:00.000Z',
    ]);
    expect(old.code).toBe(6);
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(for_);
    const ok = run([
      'area',
      'production',
      '--title',
      'Operations',
      '--projects',
      'ui',
      '--expect-changed',
      ISO,
    ]);
    expect(ok.code).toBe(0);
    const queue = readQueue();
    expect(queue.areas?.production).toMatchObject({ title: 'Operations' });
    expect(queue.projects?.ui.area).toBe('production');
  });
});
