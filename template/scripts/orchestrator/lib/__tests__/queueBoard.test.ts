// =============================================================
// queueBoard.test.ts: the pure helpers behind the kanban board for the work queue (lib/queueBoard.js).
//
// The board (scripts/orchestrator/queue-board.mjs) shows the same as `queue.mjs show/next/projects` because it uses
// the rules in queueLogic.js (priority, projectFor, blockers, limits). The tests here prove that the board:
//   - splits tasks into the columns In queue / In progress / Review / Built (and proposed on its own),
//   - computes a new priority_bonus that lands a card BETWEEN the neighbors (checked with queueLogic.score itself),
//   - orders and moves project lanes without changing the order between the other projects,
//   - counts agent slots (WIP) with the same rule as the queue (counterAsAgent),
//   - has an own, neutral palette (light and dark) with the colors the board uses, and makes the CSS variables from it.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

type Task = {
  id: string;
  title?: string;
  domain?: string;
  class?: 'K' | 'D' | 'D+' | 'U';
  status: string;
  value?: number;
  content_min?: number;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  priority_bonus?: number;
  project?: string;
  feature?: string;
  labels?: string[];
  picked_by?: string;
  picked_at?: string;
  started?: string;
  delivered?: string;
  done?: string;
  qa_status?: string;
  added_at?: string;
  external?: boolean;
  external_name?: string;
  migr_tens?: number;
};
type Register = Record<
  string,
  { title: string; prefixes?: string[]; pause?: boolean; priority_bonus?: number }
>;
type Queue = {
  tasks: Task[];
  projects?: Register;
  resolved?: string[];
  limits?: Record<string, number>;
};
type Summary = {
  id: string;
  status: string;
  project: string;
  ready: boolean;
  blockers: string[];
  score: number | null;
  visual: boolean;
  old: boolean;
  recent: boolean;
  qa_status: string | null;
  color: string;
};
type Board = {
  wip: {
    agents: number;
    max: number;
    dPlus: number;
    maxDPlus: number;
    picked: number;
    external: number;
  };
  projects: { pid: string; priority_bonus: number; color: string; movable: boolean }[];
  columns: {
    queue: Summary[];
    proposed: Summary[];
    inProgress: Summary[];
    review: Summary[];
    built: Summary[];
  };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard') as {
  STEP: number;
  PROJECT_COLORS: string[];
  columnFor: (o: Task) => string | null;
  board: (
    queue: Queue,
    option?: {
      now?: number;
      uncommitted?: string[];
      branches?: Record<string, { commits: number; lastCommit: string | null }>;
    },
  ) => Board;
  wip: (queue: Queue) => Board['wip'];
  projectLanes: (queue: Queue) => Board['projects'];
  newBonus: (
    queue: Queue,
    id: string,
    space: { over?: string | null; under?: string | null; top?: boolean },
    now?: number,
  ) => { bonus?: number; error?: string };
  laneBonus: (
    lanes: { pid: string; priority_bonus: number }[],
    pid: string,
    space: { over?: string | null; under?: string | null },
  ) => { changes?: Record<string, number>; error?: string };
  WITHOUT_PROJECT_COLOR: string;
  PALETTE: { light: Record<string, string>; dark: Record<string, string> };
  themeCss: (p?: { light: Record<string, string>; dark: Record<string, string> }) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  score: (o: Task, all: Task[], now?: number, register?: Register) => number;
};

const NOW = Date.parse('2026-09-30T12:00:00Z');
const daysSince = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const hoursSince = (t: number) => new Date(NOW - t * 3_600_000).toISOString();

/** A task with the usual default fields (as `queue.mjs add` gives). */
function up(id: string, field: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    domain: 'client',
    class: 'K',
    status: 'waiting',
    value: 5,
    content_min: 30,
    depends_on: [],
    waiting_on: [],
    owned_files: [],
    added_at: NOW_ISO,
    ...field,
  };
}
const NOW_ISO = new Date(NOW).toISOString();

describe('columnFor', () => {
  it('splits the statuses into the four columns, proposed on its own and cancelled outside', () => {
    expect(T.columnFor(up('A', { status: 'waiting' }))).toBe('queue');
    expect(T.columnFor(up('A', { status: 'proposed' }))).toBe('proposed');
    expect(T.columnFor(up('A', { status: 'running' }))).toBe('inProgress');
    expect(T.columnFor(up('A', { status: 'picked' }))).toBe('inProgress');
    expect(T.columnFor(up('A', { status: 'external', external: true }))).toBe('inProgress');
    expect(T.columnFor(up('A', { status: 'review' }))).toBe('review');
    expect(T.columnFor(up('A', { status: 'done' }))).toBe('built');
    expect(T.columnFor(up('A', { status: 'cancelled' }))).toBeNull();
    // An ended registration outside the queue is not work and is not shown.
    expect(T.columnFor(up('A', { status: 'done', external: true }))).toBeNull();
  });
});

describe('board: column split', () => {
  const queue: Queue = {
    projects: {
      alpha: { title: 'Alpha', prefixes: ['V-'] },
      pause: { title: 'Paused', prefixes: ['P-'], pause: true },
    },
    resolved: [],
    tasks: [
      up('V-1', { value: 9 }),
      up('V-2', { value: 3 }),
      up('V-3', { value: 8, depends_on: ['V-9'] }),
      up('V-4', { value: 7, waiting_on: ['SP9'] }),
      up('V-5', { value: 6, owned_files: ['app/x.tsx'] }),
      up('P-1', { value: 10 }),
      up('V-9', { status: 'running', started: hoursSince(1), class: 'D+' }),
      up('V-10', { status: 'picked', picked_by: 'owner', picked_at: hoursSince(80) }),
      up('X-1', {
        status: 'external',
        external: true,
        external_name: 'session 2',
        added_at: hoursSince(2),
      }),
      up('V-11', { status: 'review', delivered: hoursSince(1) }),
      up('V-12', {
        status: 'done',
        done: daysSince(1),
        labels: ['visual'],
        qa_status: 'waiting',
      }),
      up('V-13', { status: 'done', done: daysSince(10) }),
      up('V-14', {
        status: 'done',
        done: daysSince(20),
        labels: ['visual'],
        qa_status: 'waiting',
      }),
      up('V-15', { status: 'proposed' }),
      up('V-16', { status: 'cancelled' }),
    ],
  };
  const t = T.board(queue, { now: NOW, uncommitted: ['app/x.tsx'] });
  const ids = (k: Summary[]) => k.map((x) => x.id);

  it('In queue: ready ones first by priority, then blocked by priority', () => {
    expect(ids(t.columns.queue)).toEqual(['V-1', 'V-2', 'P-1', 'V-3', 'V-4', 'V-5']);
    const readyOnes = t.columns.queue.filter((k) => k.ready).map((k) => k.id);
    expect(readyOnes).toEqual(['V-1', 'V-2']);
  });

  it('a blocked card says why, with the same text as queue.mjs show', () => {
    const h = Object.fromEntries(t.columns.queue.map((k) => [k.id, k.blockers.join(' · ')]));
    expect(h['V-3']).toContain('waiting on V-9 (running)');
    expect(h['V-4']).toContain('waiting on answer: SP9');
    expect(h['V-5']).toBe('file app/x.tsx is uncommitted in the main tree');
    expect(h['P-1']).toContain('the project pause is paused');
    expect(h['V-1']).toBe('');
  });

  it('proposed sits on its own, cancelled is not shown', () => {
    expect(ids(t.columns.proposed)).toEqual(['V-15']);
    const all = Object.values(t.columns)
      .flat()
      .map((k) => k.id);
    expect(all).not.toContain('V-16');
  });

  it('In progress has running, picked and external; a picked one without commits for over 72 h is old', () => {
    expect(ids(t.columns.inProgress).sort()).toEqual(['V-10', 'V-9', 'X-1']);
    const old = t.columns.inProgress.filter((k) => k.old).map((k) => k.id);
    expect(old).toEqual(['V-10']);
  });

  it('a picked one with fresh commits on the branch is not old', () => {
    const t2 = T.board(queue, {
      now: NOW,
      branches: { 'queue/V-10': { commits: 2, lastCommit: hoursSince(3) } },
    });
    expect(t2.columns.inProgress.find((k) => k.id === 'V-10')?.old).toBe(false);
  });

  it('Built: newest first; recent = last 7 days, and waiting QA is shown regardless of age', () => {
    expect(ids(t.columns.built)).toEqual(['V-12', 'V-13', 'V-14']);
    const recent = t.columns.built.filter((k) => k.recent).map((k) => k.id);
    expect(recent).toEqual(['V-12', 'V-14']);
    expect(t.columns.built[0]).toMatchObject({ visual: true, qa_status: 'waiting' });
  });

  it('Review has what is delivered', () => {
    expect(ids(t.columns.review)).toEqual(['V-11']);
  });

  it('the score on the card is the queue\'s own priority (queueLogic.score with the project\'s bonus)', () => {
    const k = t.columns.queue.find((x) => x.id === 'V-1');
    const o = queue.tasks.find((x) => x.id === 'V-1') as Task;
    expect(k?.score).toBe(L.score(o, queue.tasks, NOW, queue.projects));
  });
});

describe('wip', () => {
  it('counts agent slots like the queue (running and review without picked_by), D+ separately, picked and external alongside', () => {
    const queue: Queue = {
      limits: { maxConcurrent: 5, maxDPlus: 2 },
      tasks: [
        up('A', { status: 'running', class: 'D+' }),
        up('B', { status: 'running' }),
        up('C', { status: 'review' }),
        up('D', { status: 'review', picked_by: 'owner' }),
        up('E', { status: 'picked', picked_by: 'owner' }),
        up('F', { status: 'external', external: true }),
        up('G', { status: 'waiting' }),
      ],
    };
    expect(T.wip(queue)).toEqual({
      agents: 3,
      max: 5,
      dPlus: 1,
      maxDPlus: 2,
      picked: 1,
      external: 1,
    });
  });

  it('uses the default limits when the queue has none of its own', () => {
    const w = T.wip({ tasks: [] });
    expect(w.max).toBeGreaterThan(0);
    expect(w.maxDPlus).toBeGreaterThan(0);
  });
});

describe('newBonus: the card lands between the neighbors', () => {
  const queue: Queue = {
    tasks: [
      up('A', { value: 9 }),
      up('B', { value: 6 }),
      up('C', { value: 3 }),
      up('D', { value: 2, priority_bonus: 40 }),
      up('K', { status: 'running' }),
    ],
  };
  const eff = (k: Queue, id: string) =>
    L.score(k.tasks.find((o) => o.id === id) as Task, k.tasks, NOW, k.projects);
  const withBonus = (k: Queue, id: string, bonus: number): Queue => ({
    ...k,
    tasks: k.tasks.map((o) => (o.id === id ? { ...o, priority_bonus: bonus } : o)),
  });

  it('between two neighbors: the new priority lies strictly between them', () => {
    const r = T.newBonus(queue, 'C', { over: 'A', under: 'B' }, NOW);
    expect(r.error).toBeUndefined();
    const fresh = withBonus(queue, 'C', r.bonus as number);
    expect(eff(fresh, 'C')).toBeLessThan(eff(fresh, 'A'));
    expect(eff(fresh, 'C')).toBeGreaterThan(eff(fresh, 'B'));
  });

  it('a card with an existing bonus is moved down: the bonus is replaced, not added on top', () => {
    const r = T.newBonus(queue, 'D', { over: 'B', under: 'C' }, NOW);
    const fresh = withBonus(queue, 'D', r.bonus as number);
    expect(eff(fresh, 'D')).toBeLessThan(eff(fresh, 'B'));
    expect(eff(fresh, 'D')).toBeGreaterThan(eff(fresh, 'C'));
  });

  it('top and bottom: one step past the neighbor', () => {
    const top = T.newBonus(queue, 'C', { under: 'A' }, NOW);
    expect(eff(withBonus(queue, 'C', top.bonus as number), 'C')).toBeCloseTo(
      eff(queue, 'A') + T.STEP,
      1,
    );
    const bottom = T.newBonus(queue, 'A', { over: 'C' }, NOW);
    expect(eff(withBonus(queue, 'A', bottom.bonus as number), 'A')).toBeCloseTo(
      eff(queue, 'C') - T.STEP,
      1,
    );
  });

  it('"to the top of the queue" lands above the highest in the whole queue', () => {
    const r = T.newBonus(queue, 'C', { top: true }, NOW);
    const fresh = withBonus(queue, 'C', r.bonus as number);
    for (const id of ['A', 'B', 'D']) expect(eff(fresh, 'C')).toBeGreaterThan(eff(fresh, id));
  });

  it('denies cards not in the queue, unknown neighbors and a move without neighbors', () => {
    expect(T.newBonus(queue, 'K', { over: 'A' }, NOW).error).toMatch(/queue/);
    expect(T.newBonus(queue, 'C', { over: 'ZZ' }, NOW).error).toMatch(/ZZ/);
    expect(T.newBonus(queue, 'C', { over: 'K' }, NOW).error).toMatch(/K/);
    expect(T.newBonus(queue, 'C', {}, NOW).error).toBeTruthy();
    expect(T.newBonus(queue, 'unknown', { over: 'A' }, NOW).error).toMatch(/unknown/);
  });
});

describe('projectLanes and laneBonus', () => {
  const queue: Queue = {
    projects: {
      a: { title: 'A' },
      b: { title: 'B', priority_bonus: 20 },
      c: { title: 'C' },
      d: { title: 'D' },
    },
    tasks: [up('X-1'), up('Y-1', { project: 'c' })],
  };

  it('project order: highest bonus first, then the register\'s order, without-project last and not movable', () => {
    const b = T.projectLanes(queue);
    expect(b.map((x) => x.pid)).toEqual(['b', 'a', 'c', 'd', 'without-project']);
    expect(b.find((x) => x.pid === 'without-project')?.movable).toBe(false);
    expect(b.find((x) => x.pid === 'a')?.movable).toBe(true);
  });

  it('the project color is stable (the register\'s order), independent of the priority', () => {
    const f1 = Object.fromEntries(T.projectLanes(queue).map((x) => [x.pid, x.color]));
    const queue2 = {
      ...queue,
      projects: { ...queue.projects, d: { title: 'D', priority_bonus: 99 } },
    };
    const f2 = Object.fromEntries(T.projectLanes(queue2).map((x) => [x.pid, x.color]));
    expect(f2).toEqual(f1);
    expect(new Set(['a', 'b', 'c', 'd'].map((p) => f1[p])).size).toBe(4);
  });

  /** The order after the changes are added to the register. */
  function after(changes: Record<string, number>): string[] {
    const reg: Register = { ...(queue.projects as Register) };
    for (const [pid, t] of Object.entries(changes))
      reg[pid] = { ...reg[pid], priority_bonus: t };
    return T.projectLanes({ ...queue, projects: reg })
      .map((x) => x.pid)
      .filter((p) => p !== 'without-project');
  }
  const lanes = () => T.projectLanes(queue).filter((x) => x.movable);

  it('between two neighbors with room: only the moved project changes', () => {
    const r = T.laneBonus(lanes(), 'd', { over: 'b', under: 'a' });
    expect(Object.keys(r.changes ?? {})).toEqual(['d']);
    expect(after(r.changes ?? {})).toEqual(['b', 'd', 'a', 'c']);
  });

  it('between two equal neighbors: the smaller side is shifted, and the others keep their order among themselves', () => {
    const r = T.laneBonus(lanes(), 'd', { over: 'a', under: 'c' });
    expect(after(r.changes ?? {})).toEqual(['b', 'a', 'd', 'c']);
    // c is alone below d (one lane), while b and a are above (two): c is moved down, not b and a up.
    expect(Object.keys(r.changes ?? {}).sort()).toEqual(['c', 'd']);
  });

  it('top and bottom', () => {
    expect(after(T.laneBonus(lanes(), 'c', { under: 'b' }).changes ?? {})).toEqual([
      'c',
      'b',
      'a',
      'd',
    ]);
    expect(after(T.laneBonus(lanes(), 'b', { over: 'd' }).changes ?? {})).toEqual([
      'a',
      'c',
      'd',
      'b',
    ]);
  });

  it('denies unknown projects', () => {
    expect(T.laneBonus(lanes(), 'zz', { over: 'a' }).error).toMatch(/zz/);
    expect(T.laneBonus(lanes(), 'a', { over: 'zz' }).error).toMatch(/zz/);
  });
});

describe('the neutral palette (PALETTE) and theme.css', () => {
  const p = T.PALETTE;
  const CLIENT = join(__dirname, '..', '..', 'queue-board');

  /** All the `var(--color-…)` names and `color-${…}` colors the client files use. */
  function usedTokens(): Set<string> {
    const files: string[] = [];
    const batch = (folder: string) => {
      for (const d of readdirSync(folder, { withFileTypes: true })) {
        if (d.isDirectory()) batch(join(folder, d.name));
        else if (/\.(css|js|html)$/.test(d.name)) files.push(join(folder, d.name));
      }
    };
    batch(CLIENT);
    const out = new Set<string>();
    for (const f of files)
      for (const m of readFileSync(f, 'utf8').matchAll(/--color-([a-z0-9-]+)/g)) out.add(m[1]);
    return out;
  }

  it('light and dark have the same names, and all are valid hex colors', () => {
    expect(Object.keys(p.light).sort()).toEqual(Object.keys(p.dark).sort());
    for (const v of [...Object.values(p.light), ...Object.values(p.dark)])
      expect(v).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('every color the client files use (board.css, plans/ etc.) exists in the palette', () => {
    const missing = [...usedTokens()].filter((t) => !p.light[t]);
    expect(missing).toEqual([]);
  });

  it('the project colors and the neutral one exist in the palette', () => {
    for (const token of [...T.PROJECT_COLORS, T.WITHOUT_PROJECT_COLOR]) {
      expect(p.light[token]).toBeDefined();
      expect(p.dark[token]).toBeDefined();
    }
  });

  /** The contrast ratio per WCAG (relative luminance). */
  function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
      const [r, g, bl] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  }

  it('the text keeps at least 4.5:1 against the surfaces in both modes', () => {
    for (const mode of [p.light, p.dark]) {
      for (const surface of ['surface', 'surface-container-lowest', 'surface-container-low']) {
        expect(contrast(mode['on-surface'], mode[surface])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(mode['on-surface-variant'], mode[surface])).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(mode['on-primary'], mode.primary)).toBeGreaterThanOrEqual(4.5);
      for (const [onState, surface] of [
        ['on-primary-container', 'primary-container'],
        ['on-secondary-container', 'secondary-container'],
        ['on-tertiary-container', 'tertiary-container'],
        ['on-error-container', 'error-container'],
        ['inverse-on-surface', 'inverse-surface'],
      ])
        expect(contrast(mode[onState], mode[surface])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the project colors keep at least 3:1 against the surfaces in both modes (badges and edges)', () => {
    for (const mode of [p.light, p.dark])
      for (const token of [...T.PROJECT_COLORS, T.WITHOUT_PROJECT_COLOR])
        expect(contrast(mode[token], mode.surface)).toBeGreaterThanOrEqual(3);
  });

  it('themeCss gives CSS variables for light, dark by the system and dark with the toggle', () => {
    const css = T.themeCss(p);
    expect(css).toContain(`--color-primary: ${p.light.primary};`);
    expect(css).toContain(`--color-primary: ${p.dark.primary};`);
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('[data-theme="dark"]');
    // Without an argument the palette is used.
    expect(T.themeCss()).toBe(css);
  });

  it('themeCss does not let through names or values that are not plain colors', () => {
    const css = T.themeCss({ light: { 'ok-name': '#000000', 'x;}': '#ffffff', y: 'red' }, dark: {} });
    expect(css).toContain('--color-ok-name: #000000;');
    expect(css).not.toContain('x;}');
    expect(css).not.toContain('--color-y');
  });
});

// =============================================================
// The guard rules, "Boost dependencies too", the settings and the setup.
// =============================================================
type Guard = {
  level: 'info' | 'warning' | 'stop';
  text: string;
  proposed?: { text: string; field: object };
};
type O2 = Task & { migr_tens?: number; branch?: string; owner_db?: string[] };
type Queue2 = Omit<Queue, 'tasks' | 'limits'> & {
  tasks: O2[];
  limits?: Record<string, number | boolean | string | null>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../queueBoard') as {
  SAVER_MODE: Record<string, number>;
  assess: (
    queue: Queue2,
    action: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Guard[];
  boostBonus: (
    queue: Queue2,
    id: string,
    space: { over?: string | null; under?: string | null; top?: boolean },
    now?: number,
  ) => { changes?: Record<string, number>; error?: string };
  SETTINGS: { name: string }[];
  settings: (
    queue: Queue2,
  ) => { name: string; val: string; standard: string; saverMode: string | null }[];
  SKILL_RULES: { text: string }[];
  QUEUE_HOOKS: { file: string; events: string[]; allMatchers?: boolean }[];
  hooksCoverage: (settings: unknown) => {
    all: boolean;
    missing: string[];
    hooks: {
      file: string;
      ok: boolean;
      events: { event: string; matchers: string[]; ok: boolean }[];
    }[];
  };
  QUEUE_SKILLS: string[];
  skillsCoverage: (
    exists: (name: string) => boolean,
    name?: string[],
  ) => { all: boolean; exists: string[]; missing: string[] };
  highestMigration: (
    files: string[],
    filePattern?: string,
  ) => { version: string; file: string; number: number } | null;
  boardTitle: (config: unknown) => string;
  board: (
    queue: Queue2,
    option?: { now?: number; branchPrefix?: string },
  ) => { night: { active: boolean; stop: boolean }; columns: { queue: { id: string; branch: string }[] } };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L2 = require('../queueLogic') as {
  LIMIT_NAME: string[];
  score: (o: O2, all: O2[], now?: number, register?: Register) => number;
  blockers: (o: O2, all: O2[], resolved?: string[]) => string[];
  blockerParts: (o: O2, all: O2[], resolved?: string[]) => { type: string; text: string }[];
  editMany: (queue: Queue2, input: unknown) => { error: string[]; changed?: string[] };
};

describe('assess: moving a card in the queue', () => {
  const reason = (): Queue2 => ({
    tasks: [
      up('TOP', { value: 9 }),
      up('MIDDLE', { value: 6 }),
      up('X', { value: 2 }),
      up('BOTTOM', { value: 1 }),
    ],
  });
  const move = (queue: Queue2, id: string, space: Record<string, unknown>, context = {}) =>
    V.assess(queue, { type: 'move', id, ...space }, { now: NOW, ...context });
  const levels = (v: Guard[]) => v.map((x) => x.level);

  it('a clean move without a blocker gives an empty list', () => {
    expect(move(reason(), 'X', { over: 'TOP', under: 'MIDDLE' })).toEqual([]);
    expect(move(reason(), 'X', { top: true })).toEqual([]);
  });

  it('moving down or to the same place warns of nothing, not even for a blocked card', () => {
    const queue = reason();
    queue.tasks.push(up('DEP', { status: 'waiting', value: 1 }));
    queue.tasks[1].depends_on = ['DEP'];
    expect(move(queue, 'MIDDLE', { over: 'X', under: 'BOTTOM' })).toEqual([]);
  });

  it('1. dependency not done: warning with the proposal "Boost dependencies too" when they are in the queue', () => {
    const queue = reason();
    queue.tasks.push(up('A1', { value: 1 }), up('B1', { value: 1 }));
    queue.tasks[2].depends_on = ['A1', 'B1'];
    const v = move(queue, 'X', { top: true });
    expect(v).toEqual([
      {
        level: 'warning',
        text: 'X cannot start before A1 and B1 are finished.',
        proposed: { text: 'Boost dependencies too', field: { boost: true } },
      },
    ]);
  });

  it('1. a running dependency: warning without a proposal (it cannot be boosted)', () => {
    const queue = reason();
    queue.tasks.push(up('A1', { status: 'running' }));
    queue.tasks[2].depends_on = ['A1'];
    const v = move(queue, 'X', { top: true });
    expect(v).toEqual([{ level: 'warning', text: 'X cannot start before A1 is done.' }]);
  });

  it('2. waiting on an owner question: warning; resolved ones do not count', () => {
    const queue = reason();
    queue.tasks[2].waiting_on = ['SP-9', 'SP-10'];
    queue.resolved = ['SP-10'];
    expect(move(queue, 'X', { top: true })).toEqual([
      { level: 'warning', text: 'X is waiting on your answer to SP-9.' },
    ]);
  });

  it('3. an owned file is shared with something running, picked or external: info', () => {
    const queue = reason();
    queue.tasks[2].owned_files = ['lib/a.ts'];
    queue.tasks.push(
      up('K1', { status: 'running', owned_files: ['lib/'] }),
      up('P1', { status: 'picked', picked_by: 'owner', owned_files: ['lib/a.ts'] }),
    );
    const v = move(queue, 'X', { top: true });
    expect(v).toEqual([
      { level: 'info', text: 'X shares the file lib/a.ts with K1 and starts only when K1 is done.' },
      { level: 'info', text: 'X shares the file lib/a.ts with P1 and starts only when P1 is done.' },
    ]);
  });

  it('4. the project is paused: info', () => {
    const queue = reason();
    queue.projects = { beta: { title: 'Beta', pause: true } };
    queue.tasks[2].project = 'beta';
    expect(move(queue, 'X', { top: true })).toEqual([
      {
        level: 'info',
        text: 'The project beta is paused: the move takes effect only when the project continues.',
      },
    ]);
  });

  it('5. limit reached: the D+ slots are full, and maxDb is reached for a task with migrations (info)', () => {
    const queue = reason();
    queue.limits = { maxDPlus: 1, maxDb: 1 };
    queue.tasks[2].class = 'D+';
    queue.tasks[2].migr_tens = 1;
    queue.tasks.push(up('K1', { status: 'running', class: 'D+', migr_tens: 1 }));
    const v = move(queue, 'X', { top: true });
    expect(levels(v)).toEqual(['info', 'info']);
    expect(v[0].text).toBe('The D+ slots are full (1 of 1): X starts when a slot becomes available.');
    expect(v[1].text).toBe(
      'The limit for tracks with migrations is reached (1 of 1): X starts when a slot becomes available.',
    );
  });

  it('the blockers come from queueLogic: blockerParts gives exactly the same texts as blockers', () => {
    const queue = reason();
    queue.tasks[2].depends_on = ['MIDDLE', 'EXISTS-NOT'];
    queue.tasks[2].waiting_on = ['SP-1'];
    queue.tasks[2].owned_files = ['a.ts'];
    queue.tasks.push(up('K1', { status: 'running', owned_files: ['a.ts'] }));
    const x = queue.tasks[2];
    expect(L2.blockerParts(x, queue.tasks).map((h) => h.text)).toEqual(
      L2.blockers(x, queue.tasks),
    );
    expect(L2.blockers(x, queue.tasks)).toHaveLength(4);
  });
});

describe('boostBonus: "Boost dependencies too"', () => {
  const queue: Queue2 = {
    tasks: [
      up('TOP', { value: 9 }),
      up('MIDDLE', { value: 6 }),
      up('X', { value: 2, depends_on: ['A1', 'B1', 'OVER', 'KJ'] }),
      up('A1', { value: 1 }),
      up('B1', { value: 1.5 }),
      up('OVER', { value: 10 }), // already above: not touched
      up('KJ', { status: 'running' }), // running: cannot be boosted
    ],
  };
  const eff = (k: Queue2, id: string) =>
    L2.score(k.tasks.find((o) => o.id === id) as O2, k.tasks, NOW, k.projects);
  const use = (k: Queue2, changes: Record<string, number>): Queue2 => ({
    ...k,
    tasks: k.tasks.map((o) =>
      o.id in changes ? { ...o, priority_bonus: changes[o.id] } : o,
    ),
  });

  it('the open dependencies in the queue are put right above the card, between the card and the neighbor above, in their order', () => {
    const r = V.boostBonus(queue, 'X', { over: 'TOP', under: 'MIDDLE' }, NOW);
    // OVER is already above the card and is not touched; KJ is running and cannot be boosted.
    expect(Object.keys(r.changes ?? {}).sort()).toEqual(['A1', 'B1', 'X']);
    const fresh = use(queue, r.changes ?? {});
    expect(eff(fresh, 'X')).toBeLessThan(eff(fresh, 'TOP'));
    expect(eff(fresh, 'X')).toBeGreaterThan(eff(fresh, 'MIDDLE'));
    for (const d of ['A1', 'B1']) {
      expect(eff(fresh, d)).toBeGreaterThan(eff(fresh, 'X'));
      expect(eff(fresh, d)).toBeLessThan(eff(fresh, 'TOP'));
    }
    // B1 was above A1 before, and still is.
    expect(eff(fresh, 'B1')).toBeGreaterThan(eff(fresh, 'A1'));
  });

  it('top of the queue: all dependencies in the queue land above the card, in their order (raise, never lower)', () => {
    const r = V.boostBonus(queue, 'X', { top: true }, NOW);
    const fresh = use(queue, r.changes ?? {});
    for (const d of ['A1', 'B1', 'OVER']) {
      expect(eff(fresh, d)).toBeGreaterThan(eff(fresh, 'X'));
      expect(eff(fresh, d)).toBeGreaterThanOrEqual(eff(queue, d));
    }
    expect(eff(fresh, 'OVER')).toBeGreaterThan(eff(fresh, 'B1'));
    expect(r.changes).not.toHaveProperty('KJ');
  });

  it('edit-many takes priority_bonus for several tasks in one call (all or nothing)', () => {
    const k = JSON.parse(JSON.stringify(queue)) as Queue2;
    const r = L2.editMany(k, {
      tasks: [
        { id: 'X', priority_bonus: 12.5 },
        { id: 'A1', priority_bonus: 30 },
      ],
    });
    expect(r.error).toEqual([]);
    expect(k.tasks.find((o) => o.id === 'A1')?.priority_bonus).toBe(30);
    const for_ = JSON.stringify(k);
    const error = L2.editMany(k, {
      tasks: [
        { id: 'X', priority_bonus: 1 },
        { id: 'A1', priority_bonus: 'much' },
      ],
    });
    expect(error.error.join('\n')).toContain('priority_bonus must be a number');
    expect(JSON.stringify(k)).toBe(for_);
  });
});

describe('assess: actions', () => {
  it('6. pausing a project with something in progress: warning; nothing in progress: none', () => {
    const queue: Queue2 = {
      projects: { beta: { title: 'Beta' } },
      tasks: [
        up('L1', { project: 'beta', status: 'running' }),
        up('L2', { project: 'beta', status: 'picked', picked_by: 'owner' }),
        up('L3', { project: 'beta' }),
      ],
    };
    expect(V.assess(queue, { type: 'pause', pid: 'beta' })).toEqual([
      { level: 'warning', text: '2 in progress in beta and will run to completion; the pause only stops new ones.' },
    ]);
    expect(V.assess(queue, { type: 'pause', pid: 'other' })).toEqual([]);
    expect(V.assess(queue, { type: 'continue', pid: 'beta' })).toEqual([]);
  });

  it('7. release with commits on the branch: warning; without commits: none', () => {
    const queue: Queue2 = { tasks: [up('P', { status: 'picked', picked_by: 'owner' })] };
    expect(
      V.assess(queue, { type: 'release', id: 'P' }, { branches: { 'queue/P': { commits: 3 } } }),
    ).toEqual([{ level: 'warning', text: 'Branch queue/P has 3 commits that will be left behind.' }]);
    expect(
      V.assess(queue, { type: 'release', id: 'P' }, { branches: { 'queue/P': { commits: 0 } } }),
    ).toEqual([]);
  });

  it('8. pick: info when an orchestrator is active and when the task has migrations', () => {
    const queue: Queue2 = { tasks: [up('M', { migr_tens: 2 }), up('R')] };
    const v = V.assess(queue, { type: 'pick', id: 'M' }, { orchestrator: { active: true } });
    expect(v.map((x) => x.level)).toEqual(['info', 'info']);
    expect(v[0].text).toContain('deliver when you are done');
    expect(v[1].text).toBe(
      'M has migrations and gets a migration block (2 tens) when it is picked.',
    );
    expect(V.assess(queue, { type: 'pick', id: 'R' }, { orchestrator: { active: false } })).toEqual([]);
  });

  it('9. QA deviation without text: stop; with text: nothing', () => {
    const queue: Queue2 = { tasks: [up('Q', { status: 'done', qa_status: 'waiting' })] };
    expect(V.assess(queue, { type: 'qa-deviation', id: 'Q', text: '  ' })).toEqual([
      { level: 'stop', text: 'Write what is wrong, and where, before you report a QA deviation.' },
    ]);
    expect(V.assess(queue, { type: 'qa-deviation', id: 'Q', text: 'the button is gone' })).toEqual([]);
  });
});

describe('assess: settings', () => {
  const queue: Queue2 = {
    limits: { maxConcurrent: 5, maxDPlus: 2, maxDb: 3 },
    tasks: [up('K1', { status: 'running' }), up('K2', { status: 'running' })],
  };
  const limit = (name: string, val: string, context = {}) =>
    V.assess(queue, { type: 'limit', name, val }, context);

  it('10. above saver mode (5 concurrent, 2 D+): warning; within: none', () => {
    expect(limit('maxConcurrent', '6')[0]?.level).toBe('warning');
    expect(limit('maxConcurrent', '6')[0]?.text).toContain('the quota is used faster');
    expect(limit('maxConcurrent', '5')).toEqual([]);
    // maxDPlus 3 is within maxConcurrent (5), but above saver mode.
    expect(limit('maxDPlus', '3')[0]?.level).toBe('warning');
    expect(limit('maxDPlus', '2')).toEqual([]);
  });

  it('11. maxDb is raised: warning about the connection pool; lowered: none', () => {
    expect(limit('maxDb', '4')[0]?.text).toContain('connection pool');
    expect(limit('maxDb', '2')).toEqual([]);
  });

  it('12. maxConcurrent 0: warning that the queue stops', () => {
    expect(limit('maxConcurrent', '0')).toEqual([
      { level: 'warning', text: 'With 0 concurrent the queue stops: no new tasks are started.' },
    ]);
  });

  it('13. daily quota below today\'s usage: warning; above: none; "off": none', () => {
    expect(limit('dailyBudget', '40', { usageToday: 55.5 })[0]?.text).toBe(
      'The daily quota (40.00 USD) is already used up today (55.50 USD): the queue stops new tasks right away.',
    );
    expect(limit('dailyBudget', '80', { usageToday: 55.5 })).toEqual([]);
    expect(limit('dailyBudget', 'off', { usageToday: 55.5 })).toEqual([]);
  });

  it('14. nightRun off while something is running: info; on: none', () => {
    expect(limit('nightRun', 'off')).toEqual([
      { level: 'info', text: '2 running and will run to completion; the night pause only stops new ones.' },
    ]);
    expect(limit('nightRun', 'on')).toEqual([]);
  });

  it('an invalid value is not flagged here (queue.mjs denies with its own message)', () => {
    expect(limit('maxDPlus', '9')).toEqual([]);
    expect(limit('nightWindow', '2306')).toEqual([]);
  });
});

describe('settings and setup', () => {
  it('the panel has all the limits queue.mjs can set, with current value, default and saverMode', () => {
    expect(V.SETTINGS.map((f) => f.name)).toEqual(L2.LIMIT_NAME);
    const field = V.settings({
      tasks: [],
      limits: { maxConcurrent: 5, nightRun: false },
    });
    const f = (name: string) => field.find((x) => x.name === name);
    expect(f('maxConcurrent')).toMatchObject({ val: '5', standard: '5', saverMode: '5' });
    expect(f('maxDPlus')).toMatchObject({ val: '2', standard: '2', saverMode: '2' });
    expect(f('maxPerDomain')?.saverMode).toBeNull();
    expect(f('dailyBudget')).toMatchObject({ val: 'off', standard: 'off' });
    expect(f('nightRun')).toMatchObject({ val: 'off', standard: 'on' });
    expect(f('nightWindow')).toMatchObject({ val: '23-06', standard: '23-06' });
  });

  it('the working rules in the panel: the saver mode text follows SAVER_MODE', () => {
    expect(V.SKILL_RULES.length).toBeGreaterThan(0);
    expect(V.SKILL_RULES[0].text).toContain(
      `at most ${V.SAVER_MODE.maxConcurrent} concurrent tracks and ${V.SAVER_MODE.maxDPlus} D+`,
    );
  });

  /** settings.json with all the queue system's hooks, as the installation sets them up. */
  function fullSettings() {
    const hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> = {};
    for (const h of V.QUEUE_HOOKS)
      for (const event of h.events)
        (hooks[event] ??= []).push({
          matcher: '*',
          hooks: [{ command: `node scripts/orchestrator/${h.file}` }],
        });
    return { hooks };
  }

  it('hooks: all the queue system\'s hooks in place gives "all"', () => {
    const r = V.hooksCoverage(fullSettings());
    expect(r.all).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.hooks.map((h) => h.file)).toEqual(V.QUEUE_HOOKS.map((h) => h.file));
  });

  it('hooks: every hook in the list exists as a script in scripts/orchestrator/', () => {
    const files = readdirSync(join(__dirname, '..', '..'));
    for (const h of V.QUEUE_HOOKS) expect(files).toContain(h.file);
  });

  it('hooks: a narrow matcher on the time log and a missing hook are reported', () => {
    const s = fullSettings();
    s.hooks.SubagentStart = [
      { matcher: 'track', hooks: [{ command: 'node scripts/orchestrator/hook-time.mjs' }] },
    ];
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter(
      (e) => !e.hooks[0].command.includes('hook-read-guard.mjs'),
    );
    const r = V.hooksCoverage(s);
    expect(r.all).toBe(false);
    expect(r.missing).toEqual(['hook-time.mjs (SubagentStart)', 'hook-read-guard.mjs (PreToolUse)']);
    const time = r.hooks.find((h) => h.file === 'hook-time.mjs');
    expect(time?.events[0]).toEqual({ event: 'SubagentStart', matchers: ['track'], ok: false });
    // A command with backslashes (Windows) and without a matcher counts too.
    expect(
      V.hooksCoverage({
        hooks: {
          ...fullSettings().hooks,
          SubagentStop: [{ hooks: [{ command: 'node scripts\\orchestrator\\hook-time.mjs' }] }],
        },
      }).all,
    ).toBe(true);
    expect(V.hooksCoverage({}).all).toBe(false);
    // Another project's script with the same file name somewhere else does not count.
    expect(
      V.hooksCoverage({
        hooks: {
          ...fullSettings().hooks,
          UserPromptSubmit: [{ hooks: [{ command: 'node tool/hook-effort.mjs' }] }],
        },
      }).missing,
    ).toEqual(['hook-effort.mjs (UserPromptSubmit)', 'hook-context.mjs (UserPromptSubmit)']);
  });

  it('skills: the queue system\'s skills, and which are missing', () => {
    expect(V.QUEUE_SKILLS).toEqual(['queue', 'add-to-queue', 'parallel-wave', 'plans', 'pick', 'start']);
    expect(V.skillsCoverage(() => true)).toEqual({ all: true, exists: V.QUEUE_SKILLS, missing: [] });
    expect(V.skillsCoverage((n) => n !== 'pick' && n !== 'start')).toMatchObject({
      all: false,
      missing: ['pick', 'start'],
    });
    // A file check that throws counts as "missing".
    expect(
      V.skillsCoverage(() => {
        throw new Error('no');
      }).exists,
    ).toEqual([]);
  });

  it('skills: every skill in the list ships with the template (template/.claude/skills/<name>/SKILL.md)', () => {
    const folder = join(__dirname, '..', '..', '..', '..', '.claude', 'skills');
    const exists = (n: string) => {
      try {
        return readFileSync(join(folder, n, 'SKILL.md'), 'utf8').length > 0;
      } catch {
        return false;
      }
    };
    expect(V.skillsCoverage(exists).missing).toEqual([]);
  });

  it('the highest migration among the file names, with the project\'s file pattern', () => {
    expect(
      V.highestMigration([
        '20260926003449_b.sql',
        '20260926000900_a.sql',
        'README.md',
        '20260926003450_c.sql.back',
      ]),
    ).toEqual({ version: '20260926003449', file: '20260926003449_b.sql', number: 20260926003449 });
    expect(V.highestMigration([])).toBeNull();
    // The numbers are compared as numbers, not as text (9 < 10).
    expect(V.highestMigration(['9_a.sql', '10_b.sql'])?.file).toBe('10_b.sql');
    // Own pattern (V<nr>__name.sql) and an invalid pattern.
    expect(
      V.highestMigration(['V2__a.sql', 'V11__b.sql', '12_c.sql'], '^V(\\d+)__.*\\.sql$'),
    ).toMatchObject({ number: 11, file: 'V11__b.sql' });
    expect(V.highestMigration(['1_a.sql'], '([')).toBeNull();
  });

  it('the title: board.title, with the project name when it is set', () => {
    expect(V.boardTitle({ board: { title: 'Queue board' }, projectName: 'alpha' })).toBe(
      'Queue board · alpha',
    );
    expect(V.boardTitle({ board: { title: 'Queue board' }, projectName: 'theProject' })).toBe(
      'Queue board',
    );
    expect(V.boardTitle({})).toBe('Queue board');
  });

  it('the branch on the card follows the branch prefix (default queue/)', () => {
    const queue = { tasks: [{ id: 'A-1', status: 'waiting' } as O2] };
    expect(V.board(queue).columns.queue[0].branch).toBe('queue/A-1');
    expect(V.board(queue, { branchPrefix: 'work/' }).columns.queue[0].branch).toBe('work/A-1');
  });
  it('the board says whether the night pause stops new starts now', () => {
    const night = Date.parse('2026-09-30T21:30:00Z'); // 23:30 in Oslo
    expect(
      V.board({ tasks: [], limits: { nightRun: false } }, { now: night }).night,
    ).toMatchObject({
      active: true,
      stop: true,
    });
    expect(V.board({ tasks: [] }, { now: night }).night).toEqual({ active: false, stop: false });
  });
});

// =============================================================
// "unlocks N", the chain, "Next up", aging work, "Waiting on you" and guard rule 15.
// =============================================================
type O3 = O2 & { waiting_on?: string[] };
type Queue3 = Omit<Queue2, 'tasks'> & {
  tasks: O3[];
  question?: Record<
    string,
    { type: string; text: string; recommendation?: string; added_at?: string }
  >;
  resolutions?: Record<
    string,
    { time: string; answer: string | null; by: string | null; logged?: boolean }
  >;
};
type Lock = { count: number; minutes: number; direct: string[]; ids: string[] };
type Next = {
  stop: string | null;
  text: string | null;
  available: number;
  startable: { id: string; title: string }[];
  whenAvailable: { id: string; title: string }[];
};
type Aging = { measure: string; limit: number; age: number } | null;
type Limits = Record<string, { work: number | null; cycle: number | null }>;
type Inbox = {
  count: number;
  question: {
    sp: string;
    type: string;
    text: string | null;
    direct: string[];
    count: number;
    minutes: number;
  }[];
  qa: { pid: string; features: { feature: string; tasks: { id: string }[] }[] }[];
  qaCount: number;
  proposed: { id: string }[];
  stuck: { id: string; status: string; aging: Aging }[];
  unlogged: { sp: string }[];
};
type Summary3 = Summary & {
  aging: Aging;
  unlocks: { count: number; minutes: number; direct: string[] } | null;
  chain: { before: string[]; after: string[] } | null;
};
type Board3 = Omit<Board, 'columns'> & {
  columns: Record<'queue' | 'proposed' | 'inProgress' | 'review' | 'built', Summary3[]>;
  next: Next;
  inbox: Inbox;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const K3 = require('../queueBoard') as {
  NEXT_WHEN_FULL: number;
  unlocksOf: (queue: Queue3, id: string) => Lock;
  chain: (queue: Queue3, id: string) => { before: string[]; after: string[] };
  aging: (o: O3, limits: Limits, now?: number) => Aging;
  nextUp: (
    queue: Queue3,
    option?: { now?: number; uncommitted?: string[]; dailyUsage?: number },
  ) => Next;
  board: (
    queue: Queue3,
    option?: { now?: number; ageLimits?: Limits; dailyUsage?: number },
  ) => Board3;
  assess: (queue: Queue3, action: Record<string, unknown>) => Guard[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L3 = require('../queueLogic') as {
  selectNext: (queue: Queue3, now?: number, option?: { uncommitted?: string[] }) => { id: string }[];
  lockUpCount: (id: string, all: O3[]) => number;
  estimate: (o: O3) => number;
};

describe('unlocksOf: "unlocks N"', () => {
  // A ← B ← C ← E(done) ← F, and A ← D (D+). X ⇄ Y is a cycle. K is cancelled and waits on A.
  const queue = (): Queue3 => ({
    tasks: [
      up('A'),
      up('B', { depends_on: ['A'] }),
      up('C', { depends_on: ['B'] }),
      up('D', { depends_on: ['A'], class: 'D+' }),
      up('E', { depends_on: ['C'], status: 'done' }),
      up('F', { depends_on: ['E'] }),
      up('K', { depends_on: ['A'], status: 'cancelled' }),
      up('X', { depends_on: ['Y'] }),
      up('Y', { depends_on: ['X'] }),
    ],
  });

  it('direct and transitive successors that are not finished, and the sum of the estimates', () => {
    const r = K3.unlocksOf(queue(), 'A');
    // E is done and does not count, but F behind it does; K is cancelled.
    expect(r.ids).toEqual(['B', 'C', 'D', 'F']);
    expect(r.direct).toEqual(['B', 'D']);
    expect(r.count).toBe(4);
    expect(r.minutes).toBe(30 + 30 + L3.estimate(up('D', { class: 'D+' })) + 30);
  });

  it('same count as the bonus in the priority (queueLogic.lockUpCount)', () => {
    const k = queue();
    for (const o of k.tasks)
      expect(K3.unlocksOf(k, o.id).count).toBe(L3.lockUpCount(o.id, k.tasks));
  });

  it('cycles are tolerated, and the card itself is never included', () => {
    expect(K3.unlocksOf(queue(), 'X').ids).toEqual(['Y']);
    expect(K3.unlocksOf(queue(), 'Y').ids).toEqual(['X']);
    expect(K3.unlocksOf(queue(), 'F')).toEqual({ count: 0, minutes: 0, direct: [], ids: [] });
  });
});

describe('chain: predecessors and successors that still need doing', () => {
  it('the predecessors transitively through depends_on, the successors like unlocksOf', () => {
    const k: Queue3 = {
      tasks: [
        up('A'),
        up('B', { depends_on: ['A'] }),
        up('C', { depends_on: ['B', 'UNKNOWN'] }),
        up('D', { depends_on: ['C'] }),
        up('E', { depends_on: ['D'] }),
      ],
    };
    expect(K3.chain(k, 'C')).toEqual({ before: ['A', 'B'], after: ['D', 'E'] });
    // A done predecessor blocks nothing and is left out, but the search goes through it.
    k.tasks[1].status = 'done';
    expect(K3.chain(k, 'C')).toEqual({ before: ['A'], after: ['D', 'E'] });
  });

  it('the board gives the cards chain and unlocks (null when missing)', () => {
    const t = K3.board(
      { tasks: [up('A'), up('B', { depends_on: ['A'] }), up('Z')] },
      { now: NOW },
    );
    const summary = (id: string) => t.columns.queue.find((x) => x.id === id);
    expect(summary('A')?.unlocks).toEqual({ count: 1, minutes: 30, direct: ['B'] });
    expect(summary('A')?.chain).toEqual({ before: [], after: ['B'] });
    expect(summary('B')?.chain).toEqual({ before: ['A'], after: [] });
    expect(summary('Z')?.chain).toBeNull();
    expect(summary('Z')?.unlocks).toBeNull();
  });
});

describe('nextUp: "Next up" is queueLogic.selectNext', () => {
  const queue = (): Queue3 => ({
    limits: { maxConcurrent: 2, maxDPlus: 1 },
    tasks: [
      up('H', { value: 9 }),
      up('M', { value: 6 }),
      up('L', { value: 3 }),
      up('Q', { value: 2 }),
      up('BLOCK', { value: 10, waiting_on: ['S1'] }),
    ],
  });

  it('available slots: what selectNext starts now, at most as many as are available', () => {
    const k = queue();
    const n = K3.nextUp(k, { now: NOW });
    expect(n.stop).toBeNull();
    expect(n.available).toBe(2);
    expect(n.startable.map((v) => v.id)).toEqual(L3.selectNext(k, NOW).map((v) => v.id));
    expect(n.startable.map((v) => v.id)).toEqual(['H', 'M']);
    expect(n.startable[0].title).toBe('Task H');
    expect(n.whenAvailable).toEqual([]);
  });

  it('full slots: the next ones when a slot becomes available (selectNext with more slots)', () => {
    const k = queue();
    k.tasks.push(up('K1', { status: 'running' }), up('K2', { status: 'running' }));
    const n = K3.nextUp(k, { now: NOW });
    expect(n.available).toBe(0);
    expect(n.startable).toEqual([]);
    expect(n.whenAvailable.map((v) => v.id)).toEqual(['H', 'M', 'L']);
    expect(K3.NEXT_WHEN_FULL).toBe(3);
  });

  it('a reprioritization gives a different order right away', () => {
    const k = queue();
    const q = k.tasks.find((o) => o.id === 'Q');
    if (q) q.priority_bonus = 500;
    expect(K3.nextUp(k, { now: NOW }).startable.map((v) => v.id)).toEqual(['Q', 'H']);
  });

  it('if the queue stops, the reason is there: nightPause, daily quota, concurrent tracks 0', () => {
    const night = Date.parse('2026-09-30T21:30:00Z'); // 23:30 in Oslo
    const k = queue();
    k.limits = { ...k.limits, nightRun: false };
    const n = K3.nextUp(k, { now: night });
    expect(n.stop).toBe('nightPause');
    expect(n.text).toBe('Night pause until 06:00: no new ones start.');
    expect(n.startable).toEqual([]);

    const b = queue();
    b.limits = { ...b.limits, dailyBudget: 5 };
    expect(K3.nextUp(b, { now: NOW, dailyUsage: 6 }).stop).toBe('dailyBudget');
    expect(K3.nextUp(b, { now: NOW, dailyUsage: 1 }).stop).toBeNull();

    const closed = queue();
    closed.limits = { maxConcurrent: 0 };
    expect(K3.nextUp(closed, { now: NOW })).toMatchObject({
      stop: 'maxConcurrent',
      whenAvailable: [],
    });
  });

  it('the board has next with the same answer', () => {
    const k = queue();
    expect(K3.board(k, { now: NOW }).next).toEqual(K3.nextUp(k, { now: NOW }));
  });
});

describe('aging work: over p85 for the class', () => {
  const limits: Limits = {
    K: { work: 40, cycle: 60 },
    D: { work: null, cycle: null },
  };

  it('running: the time since start against p85 of the work time; review: against p85 of the whole cycle', () => {
    expect(
      K3.aging(up('A', { status: 'running', started: hoursSince(1) }), limits, NOW),
    ).toEqual({ measure: 'work', limit: 40, age: 60 });
    expect(
      K3.aging(up('A', { status: 'running', started: hoursSince(0.5) }), limits, NOW),
    ).toBeNull();
    expect(
      K3.aging(
        up('R', { status: 'review', started: hoursSince(1.5), delivered: hoursSince(1) }),
        limits,
        NOW,
      ),
    ).toEqual({ measure: 'cycle', limit: 60, age: 90 });
  });

  it('without a limit (too few finished in the class), or in the queue, nothing is marked', () => {
    expect(
      K3.aging(
        up('D1', { class: 'D', status: 'running', started: hoursSince(30) }),
        limits,
        NOW,
      ),
    ).toBeNull();
    expect(K3.aging(up('V', { started: hoursSince(30) }), limits, NOW)).toBeNull();
  });

  it('the board: aging replaces "3 × estimate" for running ones; the 72 h rule for picked ones stays', () => {
    const t = K3.board(
      {
        tasks: [
          up('OLD', { status: 'running', started: hoursSince(10) }),
          up('NEW', { status: 'running', started: hoursSince(0.25) }),
          up('PL', { status: 'picked', picked_by: 'owner', picked_at: daysSince(4) }),
        ],
      },
      { now: NOW, ageLimits: limits },
    );
    const summary = (id: string) => t.columns.inProgress.find((x) => x.id === id);
    expect(summary('OLD')?.old).toBe(false);
    expect(summary('OLD')?.aging).toEqual({ measure: 'work', limit: 40, age: 600 });
    expect(summary('NEW')?.aging).toBeNull();
    expect(summary('PL')?.old).toBe(true);
    // Without ageLimits no running ones are marked, regardless of age.
    const without = K3.board(
      { tasks: [up('OLD', { status: 'running', started: hoursSince(10) })] },
      { now: NOW },
    );
    expect(without.columns.inProgress[0]).toMatchObject({ old: false, aging: null });
  });
});

describe('inbox: "Waiting on you"', () => {
  const queue = (): Queue3 => ({
    tasks: [
      up('A', { waiting_on: ['S-LARGE'] }),
      up('B', { depends_on: ['A'] }),
      up('C', { depends_on: ['B'] }),
      up('D', { waiting_on: ['S-SMALL', 'S-LARGE'] }),
      up('E', { waiting_on: ['S-RESOLVED'] }),
      up('Q1', {
        status: 'done',
        labels: ['visual'],
        qa_status: 'waiting',
        feature: 'list',
      }),
      up('Q2', { status: 'done', labels: ['visual'], qa_status: 'ok' }),
      up('F1', { status: 'proposed' }),
      up('K1', { status: 'running', started: hoursSince(5) }),
      up('P1', { status: 'picked', picked_by: 'owner', picked_at: daysSince(4) }),
    ],
    resolved: ['S-RESOLVED'],
    question: {
      'S-SMALL': { type: 'lawyer', text: 'Ask the lawyer.' },
      'S-REG': { type: 'condition', text: 'Nobody waiting yet.' },
    },
    resolutions: {
      'S-RESOLVED': { time: NOW_ISO, answer: 'Yes', by: 'owner', logged: false },
    },
  });
  const limits: Limits = { K: { work: 60, cycle: 90 } };

  it('questions sorted by what the answer unlocks (tasks and minutes, transitively)', () => {
    const i = K3.board(queue(), { now: NOW, ageLimits: limits }).inbox;
    expect(i.question.map((s) => `${s.sp}:${s.count}:${s.minutes}`)).toEqual([
      'S-LARGE:4:120', // A and D wait directly, B and C via the chain
      'S-SMALL:1:30',
      'S-REG:0:0', // registered, but nobody waiting yet
    ]);
    expect(i.question[0]).toMatchObject({ type: 'question', text: null, direct: ['A', 'D'] });
    expect(i.question[1]).toMatchObject({ type: 'lawyer', text: 'Ask the lawyer.' });
    expect(i.question.some((s) => s.sp === 'S-RESOLVED')).toBe(false);
  });

  it('QA (only waiting), proposed, what is stuck, unlogged resolutions and the count', () => {
    const i = K3.board(queue(), { now: NOW, ageLimits: limits }).inbox;
    expect(i.qa).toHaveLength(1);
    expect(i.qa[0].features).toEqual([
      { feature: 'list', tasks: [expect.objectContaining({ id: 'Q1' })] },
    ]);
    expect(i.qaCount).toBe(1);
    expect(i.proposed.map((f) => f.id)).toEqual(['F1']);
    // Oldest first (like the In progress column).
    expect(i.stuck.map((h) => `${h.id}:${h.status}`)).toEqual(['P1:picked', 'K1:running']);
    expect(i.stuck[1].aging).toMatchObject({ measure: 'work', limit: 60 });
    expect(i.unlogged.map((x) => x.sp)).toEqual(['S-RESOLVED']);
    // Unlogged resolutions are info for the orchestrator and are not counted.
    expect(i.count).toBe(3 + 1 + 1 + 2);
  });

  it('empty inbox: count 0', () => {
    expect(K3.board({ tasks: [up('A')] }, { now: NOW }).inbox).toMatchObject({
      count: 0,
      question: [],
      qa: [],
      proposed: [],
      stuck: [],
      unlogged: [],
    });
  });
});

describe('assess: 15. answer to an owner question', () => {
  const queue: Queue3 = {
    tasks: [],
    question: { BET: { type: 'condition', text: 'The library is stable.' } },
  };
  it('an empty answer stops; condition and lawyer get the "fulfilled" text', () => {
    expect(K3.assess(queue, { type: 'resolve', sp: 'SP8', text: '  ' })).toEqual([
      {
        level: 'stop',
        text: 'Write the answer before you resolve: waiting tracks build on it.',
      },
    ]);
    expect(K3.assess(queue, { type: 'resolve', sp: 'BET', text: '' })[0].text).toContain('fulfilled');
    expect(K3.assess(queue, { type: 'resolve', sp: 'SP8', text: 'Resolved with the vendor' })).toEqual([]);
  });
});
