// =============================================================
// queueFocus.test.ts: work queue (lib/queueLogic.js): area register and `project.area`,
// focus period with stages, "rest" (wait/fill) and "dragged along" (transitive dependencies), `parked` with an optional
// to-date, the shared ranking (selectNext, pickable, state, summaryView) and the commands area, areas,
// focus, park and continue in queue.mjs (against a copy in a temporary folder, never the real queue).
// Without focus and without parked the result must
// be the same as before (own describe block below).
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
  value?: number;
  content_min?: number;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  priority_bonus?: number;
  project?: string;
  feature?: string;
  picked_by?: string;
  batched?: boolean;
  parked?: Parked;
};
type Project = {
  title: string;
  prefixes?: string[];
  pause?: boolean;
  priority_bonus?: number;
  area?: string;
};
type Focus = {
  name?: string;
  from?: string;
  to?: string | null;
  order: string[];
  rest?: string;
  drag_with_dependencies?: boolean;
};
type Queue = {
  tasks: Task[];
  resolved?: string[];
  limits?: Record<string, number | boolean | string | null>;
  projects?: Record<string, Project>;
  areas?: Record<string, { title: string; description?: string }>;
  focus?: Focus;
  next_migr?: number;
};
type Selected = {
  id: string;
  score: number;
  step?: number | null;
  dragged_by?: string | null;
};
type FocusStatus = {
  active: boolean;
  expired: boolean;
  readyOnes: number;
  in_focus: number;
  inProgress: number;
  dragged_with: number;
  notice: string | null;
  ownerQuestion: { sp: string; tasks: number }[];
};
type State = {
  canStart: number;
  empty: boolean;
  blocked: { id: string; blockers: string[] }[];
  parked?: number;
  focus?: FocusStatus;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  WITHOUT_AREA: string;
  selectNext: (queue: Queue, now?: number) => Selected[];
  pickable: (
    queue: Queue,
    filter?: Record<string, unknown>,
    now?: number,
  ) => { id: string; step?: number | null; outside_focus?: boolean; paused: boolean }[];
  state: (queue: Queue, dailyUsage?: number, option?: { now?: number }) => State;
  summaryView: (queue: Queue, option?: { now?: number }) => string[];
  blockersWithPause: (o: Task, queue: Queue) => string[];
  uncommittedSkipped: (queue: Queue, uncommitted: string[]) => { id: string }[];
  areaFor: (o: Partial<Task>, queue: Queue) => string;
  parseStep: (raw: string, queue: Queue) => { stage?: string; error?: string };
  ownStep: (o: Task, queue: Queue) => number | null;
  draggedWith: (queue: Queue, now?: number) => Map<string, { stage: number; by: string }>;
  ranking: (o: Task, queue: Queue) => { stage: number; out: boolean; score: number };
  parkedNow: (o: Task, now?: number) => boolean;
  setFocus: (
    queue: Queue,
    input: Record<string, unknown>,
    now?: string,
  ) => { error: string[]; warnings: string[]; focus?: Focus };
  removeFocus: (queue: Queue) => Focus | null;
  focusStatus: (queue: Queue, option?: { now?: number; canStart?: string[] }) => FocusStatus | null;
  setArea: (
    queue: Queue,
    oid: string,
    field: Record<string, unknown>,
  ) => { error: string[]; new?: boolean; deleted?: boolean; moved?: string[] };
  areaOverview: (
    queue: Queue,
    now?: number,
  ) => { oid: string; projects: string[]; waiting: number; readyOnes: number; parked: number }[];
  park: (
    queue: Queue,
    ids: string[],
    option?: { by?: string; reason?: string | null; to?: string | null; now?: string },
  ) => { error: string[]; parked?: string[]; warnings?: string[] };
  continue: (
    queue: Queue,
    ids: string[],
  ) => { error: string[]; still?: string[]; notParked?: string[] };
  pick: (
    queue: Queue,
    id: string,
    option?: { by?: string; force?: boolean; now?: string },
  ) => {
    error?: string;
  };
  newRegister: (
    register: Record<string, Project> | undefined,
    changes: unknown,
    areas?: Record<string, unknown>,
  ) => { error: string[] };
  validate: (o: unknown, ex?: Task[], register?: Record<string, Project>) => string[];
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
const ids = (queue: Queue) => L.selectNext(queue, NOW).map((v) => v.id);

// Two areas (goods, ui) and one project without an area (tool). Value drives the base score: ui tasks have
// a higher score than goods tasks, so a fixed order only shows when focus is in effect.
const REGISTER: Record<string, Project> = {
  warehouse: { title: 'Warehouse', prefixes: ['SB-'], area: 'goods' },
  calendar: { title: 'Calendar', prefixes: ['VP-'], area: 'ui' },
  report: { title: 'Report', prefixes: ['FR-'], area: 'ui' },
  security: { title: 'Security', prefixes: ['S-'], area: 'security' },
  tool: { title: 'Tool', prefixes: ['VK-'] },
};
const AREAS = {
  goods: { title: 'Goods' },
  ui: { title: 'Calendar and staff' },
  security: { title: 'Security and privacy' },
};
const reasonQueue = (): Queue => ({
  projects: clone(REGISTER),
  areas: clone(AREAS),
  limits: { maxConcurrent: 10, maxDPlus: 4, maxPerDomain: 7, maxDb: 6 },
  tasks: [
    o('SB-1', { value: 2 }),
    o('SB-2', { value: 3 }),
    o('VP-1', { value: 9 }),
    o('VP-2', { value: 8 }),
    o('VK-1', { value: 10 }),
    o('S-1', { value: 7 }),
  ],
});

describe('without focus and without parked: as before', () => {
  it('selectNext: score and id, no new fields in the rows', () => {
    const queue = reasonQueue();
    const v = L.selectNext(queue, NOW);
    expect(v.map((x) => x.id)).toEqual(['VK-1', 'VP-1', 'VP-2', 'S-1', 'SB-2', 'SB-1']);
    for (const r of v) {
      expect('step' in r).toBe(false);
      expect('dragged_by' in r).toBe(false);
    }
  });

  it('state: no focus or parked field; blockers without focus text', () => {
    const queue = reasonQueue();
    queue.projects!.calendar.pause = true;
    const t = L.state(queue, undefined, { now: NOW });
    expect('focus' in t).toBe(false);
    expect('parked' in t).toBe(false);
    expect(t.blocked.find((b) => b.id === 'VP-1')?.blockers).toEqual([
      'the project calendar is paused',
    ]);
  });

  it('summaryView has no FOCUS line', () => {
    expect(L.summaryView(reasonQueue(), { now: NOW }).some((l) => l.startsWith('FOCUS'))).toBe(false);
  });

  it('one stage covering everything, with rest fill, gives the same order as without focus', () => {
    const without = ids(reasonQueue());
    const queue = reasonQueue();
    queue.focus = {
      order: ['area:goods', 'area:ui', 'area:security', 'project:tool'],
      rest: 'fill',
    };
    // Four stages change the order; one stage for everything (all in the same area) does not.
    const all = reasonQueue();
    for (const p of Object.values(all.projects!)) p.area = 'goods';
    all.focus = { order: ['area:goods'], rest: 'fill' };
    expect(ids(all)).toEqual(without);
    expect(ids(queue)).not.toEqual(without);
  });

  it('focus off gives the same result as before focus was set', () => {
    const queue = reasonQueue();
    const for_ = ids(queue);
    expect(L.setFocus(queue, { order: ['goods'] }, ISO).error).toEqual([]);
    expect(ids(queue)).not.toEqual(for_);
    L.removeFocus(queue);
    expect(ids(queue)).toEqual(for_);
  });
});

describe('focus: fixed order, rest and specificity', () => {
  it('stage 1 before stage 2 regardless of score; by score within the stage', () => {
    const queue = reasonQueue();
    queue.focus = { order: ['area:goods', 'area:ui'], rest: 'wait' };
    expect(ids(queue)).toEqual(['SB-2', 'SB-1', 'VP-1', 'VP-2']);
    const v = L.selectNext(queue, NOW);
    expect(v[0].step).toBe(0);
    expect(v[2].step).toBe(1);
  });

  it('rest wait: outside focus is not started, and the blocker says why', () => {
    const queue = reasonQueue();
    queue.focus = { name: 'Goods first', order: ['area:goods'], rest: 'wait' };
    expect(ids(queue)).toEqual(['SB-2', 'SB-1']);
    const h = L.blockersWithPause(
      queue.tasks.find((x) => x.id === 'VK-1')!,
      queue,
    );
    expect(h[0]).toMatch(/outside focus "Goods first"/);
  });

  it('rest fill: outside focus comes last and fills the available slots', () => {
    const queue = reasonQueue();
    queue.focus = { order: ['area:goods'], rest: 'fill' };
    expect(ids(queue)).toEqual(['SB-2', 'SB-1', 'VK-1', 'VP-1', 'VP-2', 'S-1']);
    const v = L.selectNext(queue, NOW);
    expect(v[2].step).toBeNull();
    queue.limits!.maxConcurrent = 2;
    expect(ids(queue)).toEqual(['SB-2', 'SB-1']);
  });

  it('the most specific stage wins (project over area, feature over project)', () => {
    const queue = reasonQueue();
    queue.tasks.push(o('VP-3', { value: 1, feature: 'Overview' }));
    queue.focus = {
      order: ['feature:calendar/Overview', 'area:ui', 'project:calendar'],
      rest: 'wait',
    };
    const t = (id: string) =>
      L.ownStep(
        queue.tasks.find((x) => x.id === id)!,
        queue,
      );
    expect(t('VP-3')).toBe(0);
    expect(t('VP-1')).toBe(2);
    expect(ids(queue)[0]).toBe('VP-3');
    // Report is only in the area stage, and so comes before calendar (stage 3).
    queue.tasks.push(o('FR-1', { value: 1 }));
    expect(ids(queue)).toEqual(['VP-3', 'FR-1', 'VP-1', 'VP-2']);
  });

  it('pause takes precedence over focus: a paused project in stage 1 is not started', () => {
    const queue = reasonQueue();
    queue.projects!.warehouse.pause = true;
    queue.focus = { order: ['area:goods', 'area:ui'], rest: 'wait' };
    expect(ids(queue)).toEqual(['VP-1', 'VP-2']);
  });

  it('an expired focus is ranked as without focus, with a notice', () => {
    const queue = reasonQueue();
    queue.focus = {
      name: 'Week 41',
      order: ['area:goods'],
      rest: 'wait',
      to: '2026-10-01T00:00:00Z',
    };
    expect(ids(queue)).toEqual(ids(reasonQueue()));
    const t = L.state(queue, undefined, { now: NOW });
    expect(t.focus?.expired).toBe(true);
    expect(t.focus?.notice).toMatch(/Focus period "Week 41" is over/);
  });

  it('a focus that has not started yet does not apply', () => {
    const queue = reasonQueue();
    queue.focus = { order: ['area:goods'], rest: 'wait', from: '2026-12-01T00:00:00Z' };
    expect(ids(queue)).toEqual(ids(reasonQueue()));
  });
});

describe('dragged along', () => {
  it('transitive dependencies outside focus get the stage of the focus task, with by', () => {
    const queue = reasonQueue();
    queue.tasks = [
      o('VP-1', { value: 9, depends_on: ['FR-1'] }),
      o('FR-1', { value: 2, depends_on: ['S-1'] }),
      o('S-1', { value: 2 }),
      o('VK-1', { value: 10 }),
    ];
    queue.areas!.report = { title: 'Report' };
    queue.projects!.report.area = 'report';
    queue.focus = { order: ['project:calendar'], rest: 'wait' };
    const d = L.draggedWith(queue, NOW);
    expect(d.get('FR-1')).toEqual({ stage: 0, by: 'VP-1' });
    expect(d.get('S-1')).toEqual({ stage: 0, by: 'VP-1' });
    expect(d.has('VK-1')).toBe(false);
    // S-1 is ready (no dependencies) and dragged along; VK-1 stays outside focus.
    expect(ids(queue)).toEqual(['S-1']);
    expect(L.selectNext(queue, NOW)[0].dragged_by).toBe('VP-1');
  });

  it('the highest-priority focus task decides the stage', () => {
    const queue = reasonQueue();
    queue.tasks = [
      o('SB-1', { depends_on: ['S-1'] }),
      o('VP-1', { depends_on: ['S-1'] }),
      o('S-1'),
    ];
    queue.focus = { order: ['area:ui', 'area:goods'], rest: 'wait' };
    expect(L.draggedWith(queue, NOW).get('S-1')).toEqual({ stage: 0, by: 'VP-1' });
  });

  it('a dependency with a better stage of its own is not dragged down; finished and parked roots do not count', () => {
    const queue = reasonQueue();
    queue.tasks = [
      o('VP-1', { depends_on: ['SB-1', 'S-1'] }),
      o('SB-1'),
      o('S-1', { status: 'done' }),
      o('VP-2', { depends_on: ['VK-1'], parked: { by: 'owner', at: ISO } }),
      o('VK-1'),
    ];
    queue.focus = { order: ['area:goods', 'area:ui'], rest: 'wait' };
    const d = L.draggedWith(queue, NOW);
    expect(d.has('SB-1')).toBe(false);
    expect(d.has('S-1')).toBe(false);
    expect(d.has('VK-1')).toBe(false);
  });

  it('without-dependencies turns it off', () => {
    const queue = reasonQueue();
    queue.tasks = [o('VP-1', { depends_on: ['S-1'] }), o('S-1')];
    queue.focus = { order: ['area:ui'], rest: 'wait', drag_with_dependencies: false };
    expect(L.draggedWith(queue, NOW).size).toBe(0);
    expect(ids(queue)).toEqual([]);
  });
});

describe('notice when focus has nothing ready', () => {
  it('nothing ready: notice with the owner question that unblocks the most, and the queue is empty', () => {
    const queue = reasonQueue();
    queue.tasks = [
      o('SB-1', { waiting_on: ['Q3'] }),
      o('SB-2', { waiting_on: ['Q3'] }),
      o('VK-1'),
    ];
    queue.focus = { name: 'Goods', order: ['area:goods'], rest: 'wait' };
    const t = L.state(queue, undefined, { now: NOW });
    expect(t.empty).toBe(true);
    expect(t.focus?.readyOnes).toBe(0);
    expect(t.focus?.notice).toMatch(/Nothing ready in focus \"Goods\"\. Answering Q3 unlocks 2/);
    expect(L.summaryView(queue, { now: NOW }).join('\n')).toMatch(/FOCUS WARNING/);
  });

  it('everything in focus done: "focus is empty"', () => {
    const queue = reasonQueue();
    queue.tasks = [o('SB-1', { status: 'done' }), o('VK-1')];
    queue.focus = { order: ['area:goods'], rest: 'wait' };
    expect(L.focusStatus(queue, { now: NOW })?.notice).toMatch(/is empty: nothing left/);
  });

  it('ready work in focus: no notice', () => {
    const queue = reasonQueue();
    queue.focus = { order: ['area:goods'], rest: 'wait' };
    const s = L.focusStatus(queue, { now: NOW, canStart: ['SB-1', 'SB-2'] })!;
    expect(s.notice).toBeNull();
    expect(s.readyOnes).toBe(2);
  });
});

describe('parked', () => {
  it('parked is skipped by selectNext and pickable; a to-date in the past = not parked', () => {
    const queue = reasonQueue();
    queue.tasks[0].parked = { by: 'owner', at: ISO, reason: 'waiting on vendor' };
    queue.tasks[1].parked = { by: 'owner', at: ISO, to: '2026-10-01T00:00:00.000Z' };
    expect(ids(queue)).not.toContain('SB-1');
    expect(ids(queue)).toContain('SB-2');
    expect(L.pickable(queue, {}, NOW).map((p) => p.id)).not.toContain('SB-1');
    const t = L.state(queue, undefined, { now: NOW });
    expect(t.parked).toBe(1);
    expect(t.blocked.find((b) => b.id === 'SB-1')?.blockers[0]).toMatch(
      /^parked by owner: waiting on vendor/,
    );
  });

  it('park/continue: all or nothing, only waiting and proposed, date in the future', () => {
    const queue = reasonQueue();
    queue.tasks[2].status = 'running';
    expect(L.park(queue, ['SB-1', 'VP-1'], { by: 'owner', now: ISO }).error[0]).toMatch(
      /VP-1: status running/,
    );
    expect(queue.tasks[0].parked).toBeUndefined();
    expect(L.park(queue, ['SB-1'], { to: '2026-10-01', now: ISO }).error[0]).toMatch(/has passed/);
    expect(L.park(queue, ['NO'], { now: ISO }).error[0]).toMatch(/unknown task NO/);
    const r = L.park(queue, ['SB-1'], { by: 'owner', reason: 'later', to: '2026-11-01', now: ISO });
    expect(r.error).toEqual([]);
    expect(queue.tasks[0].parked).toEqual({
      by: 'owner',
      at: ISO,
      reason: 'later',
      to: '2026-11-01T23:59:59.000Z',
    });
    expect(L.validate(queue.tasks[0], [], REGISTER)).toEqual([]);
    const f = L.continue(queue, ['SB-1', 'SB-2']);
    expect(f).toEqual({ error: [], still: ['SB-1'], notParked: ['SB-2'] });
    expect(L.continue(queue, ['NO']).error).toEqual(['unknown task NO']);
  });

  it('warns when a parked task is dragged along by something in focus', () => {
    const queue = reasonQueue();
    queue.tasks = [o('VP-1', { depends_on: ['S-1'] }), o('S-1')];
    queue.focus = { order: ['area:ui'], rest: 'wait' };
    const r = L.park(queue, ['S-1'], { by: 'owner', now: ISO });
    expect(r.warnings?.[0]).toMatch(/S-1 is pulled along by VP-1/);
  });

  it('pick denies a parked task without --force', () => {
    const queue = reasonQueue();
    queue.tasks[0].parked = { by: 'owner', at: ISO };
    expect(L.pick(queue, 'SB-1', { by: 'me', now: ISO }).error).toMatch(/parked by owner/);
    expect(L.pick(queue, 'SB-1', { by: 'me', force: true, now: ISO }).error).toBeUndefined();
  });

  it('validate rejects an invalid parked field', () => {
    expect(L.validate(o('X-1', { parked: { by: '', at: ISO } }), [], {}).join()).toMatch(
      /parked must be/,
    );
  });
});

describe('setFocus and parseStep', () => {
  it('bare names are read as area or project; ambiguous or unknown is an error', () => {
    const queue = reasonQueue();
    expect(L.parseStep('goods', queue)).toEqual({ stage: 'area:goods' });
    expect(L.parseStep('calendar', queue)).toEqual({ stage: 'project:calendar' });
    expect(L.parseStep('security', queue).error).toMatch(/both an area and a project/);
    expect(L.parseStep('no', queue).error).toMatch(/unknown stage/);
    expect(L.parseStep('feature:calendar', queue).error).toMatch(/feature:<project>\/<name>/);
    expect(L.parseStep('feature:calendar/ Overview ', queue)).toEqual({
      stage: 'feature:calendar/Overview',
    });
  });

  it('validates everything before anything is changed', () => {
    const queue = reasonQueue();
    const r = L.setFocus(
      queue,
      { order: ['goods', 'area:goods', 'no'], rest: 'maybe', to: '2020-01-01' },
      ISO,
    );
    expect(r.error.join(' | ')).toMatch(
      /appears more than once.*unknown stage no.*rest must be.*has passed/,
    );
    expect(queue.focus).toBeUndefined();
    expect(L.setFocus(queue, { order: [] }, ISO).error[0]).toMatch(/at least one stage/);
  });

  it('the default is rest wait and drag along; warns about pause, an empty stage and zero ready ones', () => {
    const queue = reasonQueue();
    queue.projects!.warehouse.pause = true;
    queue.areas!.help = { title: 'Help' };
    const r = L.setFocus(queue, { order: ['goods', 'area:help'], name: 'Test' }, ISO);
    expect(r.error).toEqual([]);
    expect(queue.focus).toMatchObject({
      name: 'Test',
      from: ISO,
      to: null,
      order: ['area:goods', 'area:help'],
      rest: 'wait',
      drag_with_dependencies: true,
    });
    expect(r.warnings.join(' | ')).toMatch(/the project warehouse in stage 1 is paused/);
    expect(r.warnings.join(' | ')).toMatch(/stage 2 \(area:help\) has no open tasks/);
    expect(r.warnings.join(' | ')).toMatch(/no ready tasks/);
  });
});

describe('areas', () => {
  it('areaFor follows the project; without an area = without-area', () => {
    const queue = reasonQueue();
    expect(L.areaFor(o('SB-9'), queue)).toBe('goods');
    expect(L.areaFor(o('Z-9'), queue)).toBe(L.WITHOUT_AREA);
    expect(L.areaFor(o('XX-9'), queue)).toBe(L.WITHOUT_AREA);
  });

  it('setArea creates, moves projects and denies deleting one in use; all or nothing', () => {
    const queue = reasonQueue();
    expect(L.setArea(queue, 'tool', { projects: ['tool'] }).error[0]).toMatch(
      /title missing/,
    );
    expect(L.setArea(queue, 'tool', { title: 'Tool', projects: ['no'] }).error).toEqual([
      'unknown project no',
    ]);
    expect(queue.areas!.tool).toBeUndefined();
    const r = L.setArea(queue, 'tool', {
      title: 'Tool',
      projects: ['tool', 'report'],
    });
    expect(r).toMatchObject({ error: [], new: true, moved: ['tool', 'report'] });
    expect(queue.projects!.report.area).toBe('tool');
    expect(L.setArea(queue, 'tool', { delete: true }).error[0]).toMatch(
      /is used by report, tool/,
    );
    queue.focus = { order: ['area:security'] };
    delete queue.projects!.security.area;
    expect(L.setArea(queue, 'security', { delete: true }).error[0]).toMatch(/is in the focus/);
    expect(L.setArea(queue, 'Invalid', { title: 'x' }).error[0]).toMatch(/kebab-case/);
  });

  it('newRegister: the area must exist when the change sets it', () => {
    expect(L.newRegister(REGISTER, { tool: { area: 'no' } }, AREAS).error[0]).toMatch(
      /unknown area no/,
    );
    expect(L.newRegister(REGISTER, { tool: { area: 'goods' } }, AREAS).error).toEqual([]);
    // Other changes to a project that already has an area do not check the area.
    expect(L.newRegister(REGISTER, { warehouse: { pause: true } }).error).toEqual([]);
  });

  it('areaOverview: projects, waiting, ready ones and parked per area', () => {
    const queue = reasonQueue();
    queue.tasks.push(
      o('SB-3', { depends_on: ['SB-1'] }),
      o('SB-4', { parked: { by: 'e', at: ISO } }),
    );
    const rows = L.areaOverview(queue, NOW);
    expect(rows.map((r) => r.oid)).toEqual(['goods', 'ui', 'security', L.WITHOUT_AREA]);
    expect(rows[0]).toMatchObject({
      projects: ['warehouse'],
      waiting: 4,
      readyOnes: 2,
      parked: 1,
    });
    expect(rows[1].projects).toEqual(['calendar', 'report']);
  });
});

describe('queue.mjs: area, areas, focus, park, continue (against a copy)', () => {
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
    folder = mkdtempSync(join(tmpdir(), 'queue-focus-'));
    const queue = reasonQueue();
    delete queue.areas;
    for (const p of Object.values(queue.projects!)) delete p.area;
    writeFileSync(join(folder, 'queue.json'), JSON.stringify({ ...queue, next_migr: 1000 }, null, 2));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('area + areas + focus set/show/off', () => {
    expect(
      run(['area', 'goods', '--title', 'Goods', '--projects', 'warehouse']).code,
    ).toBe(0);
    expect(readQueue().projects!.warehouse.area).toBe('goods');
    expect(run(['project', 'calendar', '--area', 'no']).code).toBe(1);
    const areasRun = run(['areas']);
    expect(areasRun.out).toMatch(/goods +2 waiting · 2 ready/);
    expect(areasRun.out).toMatch(/without-area/);
    const s = run(['focus', 'set', 'goods', '--name', 'Goods first']);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/Focus set: 1 Goods · rest waiting/);
    expect(readQueue().focus?.order).toEqual(['area:goods']);
    const n = run(['next']);
    expect(
      n.out
        .trim()
        .split('\n')
        .map((l) => l.split(/\s+/)[0]),
    ).toEqual(['SB-2', 'SB-1']);
    expect(n.out).toMatch(/T1/);
    const f = run(['focus']);
    expect(f.out).toMatch(/FOCUS "Goods first"/);
    expect(f.out).toMatch(/NEXT UP:/);
    expect(run(['show', '--full']).out).toMatch(/outside focus "Goods first"/);
    expect(run(['start', 'VK-1']).error).toMatch(/outside focus/);
    expect(run(['focus', 'set', 'no']).code).toBe(1);
    expect(run(['focus', 'off']).out).toMatch(/Focus removed/);
    expect(readQueue().focus).toBeUndefined();
  });

  it('park and continue', () => {
    const p = run(['park', 'SB-1', 'VP-1', '--reason', 'later', '--by', 'owner']);
    expect(p.code).toBe(0);
    expect(readQueue().tasks.find((x) => x.id === 'SB-1')?.parked?.reason).toBe('later');
    expect(run(['next']).out).not.toMatch(/^SB-1/m);
    expect(run(['start', 'SB-1']).error).toMatch(/parked by owner/);
    expect(run(['park', 'NO']).code).toBe(1);
    const f = run(['continue', 'SB-1', 'VP-1']);
    expect(f.out).toMatch(/Off hold: SB-1, VP-1/);
    expect(readQueue().tasks.some((x) => x.parked)).toBe(false);
  });
});
