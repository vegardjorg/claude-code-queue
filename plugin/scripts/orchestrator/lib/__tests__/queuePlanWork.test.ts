// =============================================================
// queuePlanWork.test.ts: the workflow in the Plans room (lib/queuePlanView.js, see docs/board.md):
// the overview page (the module cards, "Waiting on you", the capacity in Now with a growth warning, recently changed
// and registered, "Working now"), "changed by session", keys (j, k, Enter, /, 1 to 4, c, x, Esc and Ctrl+K), the
// command line (matches with breadcrumb trail, recently used at the top), multi select and change in the row (the calls
// to queue.mjs and the undo), and that the calls work against queue.mjs on a copy in a temporary folder (never the
// real register). Finally the wiring in index.html, queue-board.mjs and the new files (no innerHTML).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../queuePlanView.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
const NOW = new Date('2026-10-15T10:00:00Z');

type Post = Record<string, unknown>;

/** An entry as /api/plans sends it, with default values. */
function entry(id: string, extra: Post = {}): Post {
  return {
    id,
    title: `Title ${id}`,
    project: 'export',
    module: 'alpha',
    priority: 'later',
    now_category: [],
    maturity: 'idea',
    maturity_plan: 'idea',
    size: 'M',
    ownerQuestions: [],
    legal_open: 0,
    stale: false,
    blocks: [],
    active: null,
    history: [],
    ...extra,
  };
}

const DATA = {
  modules: [
    { oid: 'alpha', title: 'Alpha' },
    { oid: 'beta', title: 'Beta' },
    { oid: 'gamma', title: 'Gamma' },
  ],
  projects: {
    export: { title: 'Export', summary: 'Export', area: 'alpha' },
    api: { title: 'API', summary: 'API', area: 'beta' },
    empty: { title: 'Without entries', summary: 'Without entries', area: 'gamma' },
  },
  entries: [
    entry('PL-A', {
      priority: 'now',
      now_category: ['security'],
      maturity: 'built',
      ownerQuestions: [
        { id: 'SP-1', resolved: false },
        { id: 'SP-2', resolved: true },
      ],
      legal_open: 2,
      blocks: ['PL-B', 'PL-C'],
    }),
    entry('PL-B', {
      priority: 'owner',
      maturity: 'ready',
      ownerQuestions: [{ id: 'SP-1', resolved: false }],
      stale: true,
      active: { at: '2026-10-15T09:30:00Z', by: 'planSession' },
    }),
    entry('PL-C', { priority: 'drop', maturity: 'idea' }),
    entry('PL-D', {
      project: 'api',
      module: 'beta',
      maturity: 'partial',
      finished: 1,
      total: 2,
      active: { at: '2026-10-15T09:50:00Z', by: 'another' },
    }),
    entry('PL-E', { project: null, module: null }),
  ],
  decisions: {
    openOnes: [
      {
        id: 'SP-1',
        text: 'Select vendor',
        blocked_entries: ['PL-A', 'PL-B'],
        tasks: [],
        urgent: false,
        deadline: null,
        entries: ['PL-A'],
      },
      {
        id: 'SP-3',
        text: 'Urgent',
        blocked_entries: [],
        tasks: ['X'],
        urgent: true,
        deadline: '2026-10-20',
        entries: [],
      },
      {
        id: 'SP-4',
        text: 'Small',
        blocked_entries: [],
        tasks: [],
        urgent: false,
        deadline: null,
        entries: [],
      },
    ],
  },
  jur_points: [
    {
      id: 'J-1',
      question: 'Is an assessment needed?',
      status: 'open',
      open: true,
      blocks: 'prod',
      entry: 'PL-A',
      deadline_days: null,
      deadline: null,
    },
    {
      id: 'J-2',
      question: 'Closed',
      status: 'resolved',
      open: false,
      blocks: 'prod',
      entry: 'PL-A',
    },
    {
      id: 'J-3',
      question: 'On a dropped entry',
      status: 'open',
      open: true,
      blocks: 'nothing',
      entry: 'PL-C',
    },
  ],
};

describe('theOverview', () => {
  it('the module cards: all modules, dropped apart, bars, built and three warning counts', () => {
    const k = V.moduleSummary(DATA);
    expect(k.map((x: Post) => x.oid)).toEqual(['alpha', 'beta', 'gamma', '(without-module)']);
    const alpha = k[0];
    expect(alpha).toMatchObject({
      title: 'Alpha',
      count: 2,
      dropped: 1,
      built: 1,
      ownerQuestions: 1,
      legal: 2,
      stale: 1,
      active: 1,
    });
    expect(alpha.priority.map((x: Post) => [x.id, x.count])).toEqual([
      ['now', 1],
      ['owner', 1],
      ['later', 0],
    ]);
    expect(alpha.maturity.find((x: Post) => x.id === 'planned').count).toBe(1);
    expect(alpha.maturity.find((x: Post) => x.id === 'built').count).toBe(1);
    expect(k[2]).toMatchObject({ oid: 'gamma', count: 0, share: 0 });
    expect(k[1].share).toBeCloseTo(0.5);
  });

  it('"Waiting on you": urgent first, then what blocks the most, at most five, and never dropped entries', () => {
    const v = V.waitingOnYou(DATA);
    expect(v.points.map((x: Post) => x.id)).toEqual(['SP-3', 'J-1', 'SP-1', 'SP-4']);
    expect(v.total).toBe(4);
    expect(v.points[1]).toMatchObject({
      type: 'jur',
      blocks: 3,
      hinders: 'prod',
      entry: 'PL-A',
    });
    expect(V.waitingOnYou(DATA, { max: 2 }).points).toHaveLength(2);
    expect(V.surfaceCount(DATA).overview).toBe(4);
  });

  it('"Working now": entries with a live marker, newest pulse first', () => {
    expect(V.workingNow(DATA).map((x: Post) => x.id)).toEqual(['PL-D', 'PL-B']);
  });

  it('the capacity: growth in Now from new entries and the changelog, with a notice when Now grows faster than the queue drains', () => {
    const reg = {
      entries: [
        { id: 'PL-A', priority: 'now', size: 'L', created: '2026-10-10T00:00:00Z' },
        { id: 'PL-B', priority: 'now', size: 'M', created: '2026-01-01T00:00:00Z' },
        { id: 'PL-C', priority: 'now', size: 'S', created: '2026-01-01T00:00:00Z' },
        { id: 'PL-D', priority: 'later', size: 'XL', created: '2026-10-10T00:00:00Z' },
      ],
      changelog: [
        {
          nr: 1,
          at: '2026-10-12T00:00:00Z',
          changes: [
            { collection: 'entries', id: 'PL-B', field: 'priority', before: 'later', after: 'now' },
          ],
        },
        {
          nr: 2,
          at: '2026-08-01T00:00:00Z',
          changes: [
            { collection: 'entries', id: 'PL-C', field: 'priority', before: 'later', after: 'now' },
          ],
        },
      ],
    };
    const t = V.nowAccess(reg, { now: NOW, days: 28, sizeTrack: P.SIZE_TRACK });
    expect(t.ids.sort()).toEqual(['PL-A', 'PL-B']);
    expect(t.track).toBe(P.SIZE_TRACK.L + P.SIZE_TRACK.M);
    expect(t.per_week).toBeCloseTo(t.track / 4, 1);
    expect(V.capacityWarning({ per_week: 1 }, t).notice).toBe(true);
    expect(V.capacityWarning({ per_week: 1 }, t).warning_text).toMatch(
      /grows faster than the queue empties/,
    );
    expect(V.capacityWarning({ per_week: 50 }, t).notice).toBe(false);
    expect(V.capacityWarning({ per_week: null }, { track: 0, per_week: 0, entries: 0 }).notice).toBe(
      false,
    );
  });

  it('recently changed and recently registered, newest first', () => {
    const reg = {
      entries: [
        { id: 'PL-A', title: 'A', created: '2026-10-01T00:00:00Z' },
        { id: 'PL-B', title: 'B', created: '2026-10-14T00:00:00Z' },
        { id: 'PL-C', title: 'C' },
      ],
      changelog: [
        {
          nr: 1,
          at: 'x',
          by: 'agent',
          action: 'plan new',
          changes: [{ id: 'PL-A' }, { id: 'PL-A' }],
        },
        {
          nr: 2,
          at: 'y',
          by: 'theBoard',
          action: 'plan prioritize',
          undone: true,
          changes: [{ id: 'PL-B' }],
        },
      ],
    };
    expect(V.recentChanged(reg)).toEqual([
      { nr: 2, at: 'y', by: 'theBoard', action: 'plan prioritize', undone: true, ids: ['PL-B'] },
      { nr: 1, at: 'x', by: 'agent', action: 'plan new', undone: false, ids: ['PL-A'] },
    ]);
    expect(V.recentRegistered(reg).map((x: Post) => x.id)).toEqual(['PL-B', 'PL-A']);
  });

  it('plansData has capacity, recent and created; the overview is its own surface with its own path', () => {
    const reg = P.emptyRegister('2026-10-14T09:00:00.000Z');
    const projects = { export: { title: 'Export', area: 'alpha' } };
    const r = P.newEntry(
      reg,
      {
        id: 'PL-X',
        title: 'X',
        project: 'export',
        priority: 'now',
        now_category: ['important'],
        priority_reason: 'Rule 4: blocks.',
        maturity: 'ready',
        size: 'M',
      },
      {
        role: 'agent',
        projects,
        question: {},
        existsPath: () => true,
        now: '2026-10-14T09:00:00.000Z',
      },
    );
    expect(r.error).toEqual([]);
    const d = V.plansData(
      reg,
      { projects, areas: { alpha: { title: 'Alpha' } } },
      { now: NOW, donePerWeek: 0.25 },
    );
    expect(d.capacity).toMatchObject({ entries: 1, track: P.SIZE_TRACK.M });
    expect(d.capacity.access.ids).toEqual(['PL-X']);
    expect(d.capacity.notice).toBe(true);
    expect(d.recent.registered[0].id).toBe('PL-X');
    expect(d.entries[0].created).toBe('2026-10-14T09:00:00.000Z');

    const t = V.readUrl('?room=plans&surface=overview');
    expect(t.surface).toBe('overview');
    expect(V.writeUrl(t)).toBe('?room=plans&surface=overview');
    expect(V.readUrl('?room=plans').surface).toBe('entries'); // old links and saved views are unchanged
    const filePath = V.breadcrumbs(t, d);
    expect(filePath.map((l: Post) => l.text)).toEqual(['Plans', 'Overview']);
    expect(filePath[0].state).toEqual({ surface: 'entries' });
  });
});

describe('live update: "changed by session"', () => {
  const withId = (nr: number, by: string) => [{ nr, by, at: 'x', action: 'h', field: ['title'] }];
  it('new entries and newer changelog are marked, but not what the board wrote itself, and not the first fetch', () => {
    const old = {
      entries: [
        entry('PL-A', { history: withId(3, 'agent') }),
        entry('PL-B', { history: withId(4, 'agent') }),
      ],
    };
    const fresh = {
      entries: [
        entry('PL-A', { history: withId(5, 'session-1') }),
        entry('PL-B', { history: withId(6, 'theBoard') }),
        entry('PL-C', { history: withId(7, 'session-1') }),
      ],
    };
    expect(V.changedEntries(old, fresh)).toEqual([
      { id: 'PL-A', by: 'session-1', new: false },
      { id: 'PL-C', by: 'session-1', new: true },
    ]);
    expect(V.changedEntries(null, fresh)).toEqual([]);
    expect(V.changedEntries(fresh, fresh)).toEqual([]);
  });
});

describe('keys', () => {
  const t = (key: string, extra: Post = {}, ctx: Post = {}) =>
    V.keyAction({ key, ...extra }, ctx);
  it('j, k, Enter, /, 1 to 4, c, x and Esc; Ctrl+K and Cmd+K everywhere', () => {
    expect(t('j')).toEqual({ type: 'move', direction: 1 });
    expect(t('k')).toEqual({ type: 'move', direction: -1 });
    expect(t('Enter')).toEqual({ type: 'opened' });
    expect(t('/')).toEqual({ type: 'search' });
    expect(['1', '2', '3', '4'].map((k) => t(k).val)).toEqual(['now', 'later', 'owner', 'drop']);
    expect(t('c')).toEqual({ type: 'copy' });
    expect(t('x')).toEqual({ type: 'mark' });
    expect(t('Escape')).toEqual({ type: 'cancel' });
    expect(t('k', { ctrlKey: true })).toEqual({ type: 'palette' });
    expect(t('K', { metaKey: true }, { inputField: true })).toEqual({ type: 'palette' });
  });
  it('in an input field, with Ctrl, Alt or Cmd, and while something is open, the letters control nothing', () => {
    expect(t('j', {}, { inputField: true })).toBeNull();
    expect(t('c', { ctrlKey: true })).toBeNull();
    expect(t('x', { altKey: true })).toBeNull();
    expect(t('1', {}, { busy: true })).toBeNull();
    expect(t('k', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(t('J')).toBeNull();
    expect(t('5')).toBeNull();
  });
  it('neighborEntry stops at the ends and starts at the correct end', () => {
    const l = ['PL-A', 'PL-B', 'PL-C'];
    expect(V.neighborEntry(l, 'PL-B', 1)).toBe('PL-C');
    expect(V.neighborEntry(l, 'PL-C', 1)).toBe('PL-C');
    expect(V.neighborEntry(l, 'PL-A', -1)).toBe('PL-A');
    expect(V.neighborEntry(l, null, 1)).toBe('PL-A');
    expect(V.neighborEntry(l, 'PL-X', -1)).toBe('PL-C');
    expect(V.neighborEntry([], 'PL-A', 1)).toBeNull();
  });
  it('1 to 4: Later and Owner save directly, Now asks for a category and Drop for a reason, same gives unchanged', () => {
    const p = entry('PL-A', { priority: 'later' });
    expect(V.priorityFromKey(p, 'owner')).toEqual({
      group: { ids: ['PL-A'], priority: 'owner', category: [] },
    });
    expect(V.priorityFromKey(p, 'later')).toEqual({ unchanged: true });
    expect(V.priorityFromKey(p, 'now')).toEqual({ menu: 'now' });
    expect(V.priorityFromKey(p, 'drop')).toEqual({ menu: 'drop' });
    expect(V.priorityFromKey(entry('PL-B', { priority: 'now' }), 'now')).toEqual({
      unchanged: true,
    });
    expect(V.priorityFromKey(null, 'now')).toEqual({ unchanged: true });
  });
});

describe('the command line (Ctrl+K)', () => {
  const k = V.paletteCandidates(DATA);
  it('the candidates: actions, modules, projects with entries and all entries with breadcrumb trail', () => {
    expect(k.filter((x: Post) => x.type === 'project').map((x: Post) => x.id)).toEqual([
      'export',
      'api',
    ]);
    const pd = k.find((x: Post) => x.sortKey === 'entry:PL-D');
    expect(pd.path).toBe('Plans › Beta › API');
    expect(k.find((x: Post) => x.sortKey === 'entry:PL-C').drop).toBe(true);
    expect(k.find((x: Post) => x.sortKey === 'project:api').path).toBe('Plans › Beta');
    expect(k.some((x: Post) => x.sortKey === 'action:copy-selected')).toBe(true);
    expect(k.some((x: Post) => x.sortKey === 'action:prepare')).toBe(true);
  });
  it('empty search: recently used first (those that exist), then the actions and modules', () => {
    const r = V.paletteMatch(k, '', ['entry:PL-B', 'entry:PL-GONE', 'module:beta']);
    expect(r.slice(0, 2).map((x: Post) => [x.sortKey, x.recent])).toEqual([
      ['entry:PL-B', true],
      ['module:beta', true],
    ]);
    expect(r.filter((x: Post) => x.sortKey === 'module:beta')).toHaveLength(1);
    expect(r.some((x: Post) => x.type === 'entry' && !x.recent)).toBe(false);
  });
  it('search: all words must hit; exact id first, recently used above the rest, dropped last', () => {
    expect(V.paletteMatch(k, 'pl-d')[0].sortKey).toBe('entry:PL-D');
    expect(V.paletteMatch(k, 'beta title').map((x: Post) => x.sortKey)).toEqual(['entry:PL-D']);
    const title = V.paletteMatch(k, 'title', ['entry:PL-E']);
    expect(title[0]).toMatchObject({ sortKey: 'entry:PL-E', recent: true });
    expect(title[title.length - 1].sortKey).toBe('entry:PL-C');
    expect(V.paletteMatch(k, 'missing')).toEqual([]);
    expect(V.paletteMatch(k, '(')).toEqual(expect.any(Array)); // special characters do not break it
  });
  it('addToRecent: first, without duplicates, at most eight, and only valid keys', () => {
    let l: string[] = [];
    for (let i = 0; i < 10; i += 1) l = V.addToRecent(l, `entry:PL-${i}`);
    expect(l).toHaveLength(8);
    expect(l[0]).toBe('entry:PL-9');
    expect(V.addToRecent(l, 'entry:PL-5')[0]).toBe('entry:PL-5');
    expect(V.addToRecent(l, 'entry:PL-5').filter((x: string) => x === 'entry:PL-5')).toHaveLength(1);
    expect(V.addToRecent(['junk', 'entry:PL-1'], 'javascript:x')).toEqual(['entry:PL-1']);
  });
  it('the start lines for several entries, one per line', () => {
    expect(V.startLines(['PL-A', 'PL-GONE', 'PL-D'], DATA).split('\n')).toEqual([
      '/plans PL-A (Alpha › Export › Title PL-A). Instruction:',
      '/plans PL-D (Beta › API › Title PL-D). Instruction:',
    ]);
  });
});

describe('multi select and change in the row: the calls', () => {
  it('priority goes via plan prioritize as owner; Now requires a category and Drop a reason', () => {
    const r = V.planBulkCall({
      action: 'priority',
      ids: ['PL-A', 'PL-B'],
      priority: 'now',
      category: 'for-prod',
    });
    expect(r.error).toEqual([]);
    expect(r.call).toEqual([
      [
        'plan',
        'prioritize',
        'PL-A',
        'PL-B',
        'now',
        '--category',
        'for-prod',
        '--set-by',
        'owner',
        '--by',
        'theBoard',
        '--json',
      ],
    ]);
    expect(
      V.planBulkCall({ action: 'priority', ids: ['PL-A'], priority: 'now' }).error.length,
    ).toBe(1);
    expect(
      V.planBulkCall({ action: 'priority', ids: ['PL-A'], priority: 'drop' }).error[0],
    ).toMatch(/reason/);
  });
  it('project and maturity: plan edit per entry with --set; only the maturities the owner sets', () => {
    expect(
      V.planBulkCall({ action: 'project', ids: ['PL-A'], project: 'api' }).call,
    ).toEqual([
      [
        'plan',
        'edit',
        'PL-A',
        '--set',
        '{"project":"api"}',
        '--set-by',
        'owner',
        '--by',
        'theBoard',
        '--json',
      ],
    ]);
    expect(V.planBulkCall({ action: 'project', ids: ['PL-A'], project: '' }).call[0][4]).toBe(
      '{"project":null}',
    );
    expect(
      V.planBulkCall({ action: 'project', ids: ['PL-A'], project: '--delete' }).error,
    ).toEqual(['invalid project']);
    expect(
      V.planBulkCall({ action: 'maturity', ids: ['PL-A', 'PL-B'], maturity: 'ready' }).call,
    ).toHaveLength(2);
    expect(
      V.planBulkCall({ action: 'maturity', ids: ['PL-A'], maturity: 'built' }).error[0],
    ).toMatch(/is computed/);
    expect(V.MATURITY_MANUAL).toEqual(P.MATURITY_MANUAL);
  });
  it('merge: into one of the chosen, at least two entries', () => {
    expect(
      V.planBulkCall({ action: 'combine', ids: ['PL-A', 'PL-B', 'PL-C'], to: 'PL-B' })
        .call,
    ).toEqual([['plan', 'combine', 'PL-B', 'PL-A', 'PL-C', '--by', 'theBoard', '--json']]);
    expect(
      V.planBulkCall({ action: 'combine', ids: ['PL-A', 'PL-B'], to: 'PL-X' }).error.length,
    ).toBe(1);
    expect(
      V.planBulkCall({ action: 'combine', ids: ['PL-A'], to: 'PL-A' }).error.length,
    ).toBe(1);
  });
  it('everything invalid is refused before anything runs', () => {
    expect(V.planBulkCall(null).call).toEqual([]);
    expect(V.planBulkCall({ action: 'delete', ids: ['PL-A'] }).error[0]).toMatch(
      /unknown action/,
    );
    expect(V.planBulkCall({ action: 'maturity', ids: [], maturity: 'ready' }).error).toEqual([
      'no entries selected',
    ]);
    expect(
      V.planBulkCall({ action: 'maturity', ids: ['PL-A', 'PL-A'], maturity: 'ready' }).error
        .length,
    ).toBe(1);
    expect(
      V.planBulkCall({ action: 'maturity', ids: ['--dry'], maturity: 'ready' }).error.length,
    ).toBe(1);
    const many = Array.from({ length: V.BULK_MAX + 1 }, (_, i) => `PL-${i}`);
    expect(
      V.planBulkCall({ action: 'maturity', ids: many, maturity: 'ready' }).error[0],
    ).toMatch(/too many/);
  });
  it('undo: newest first, only whole numbers', () => {
    expect(V.undoCall([3, 5, 4]).call.map((k: string[]) => k[3])).toEqual(['5', '4', '3']);
    expect(V.undoCall([]).error.length).toBe(1);
    expect(V.undoCall(['5']).error.length).toBe(1);
    expect(V.undoCall([0]).error.length).toBe(1);
  });
  it('the text for the confirmation', () => {
    expect(
      V.bulkText({
        action: 'priority',
        ids: ['PL-A'],
        priority: 'now',
        category: 'for-prod',
      }),
    ).toBe('PL-A: priority Now (before prod)');
    expect(
      V.bulkText(
        { action: 'project', ids: ['PL-A', 'PL-B'], project: 'export' },
        { projects: DATA.projects },
      ),
    ).toBe('2 entries: project Export');
  });
});

describe('queue.mjs with the calls from multi select (copy in a temporary folder)', () => {
  let folder: string;
  const run = (args: string[]) => {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
          QUEUE_PLAN_SOURCE_ROOT: folder,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, data: JSON.parse(out.trim().split('\n').pop() ?? 'null') };
    } catch (e) {
      const x = e as { status: number; stdout: string };
      let data = null;
      try {
        data = JSON.parse(
          String(x.stdout ?? '')
            .trim()
            .split('\n')
            .pop() ?? 'null',
        );
      } catch {
        data = null;
      }
      return { code: x.status, data };
    }
  };
  const readReg = () => JSON.parse(readFileSync(join(folder, 'plans.json'), 'utf8'));
  const find = (id: string) => readReg().entries.find((p: Post) => p.id === id);

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-work-'));
    const projects = {
      export: { title: 'Export', area: 'alpha' },
      other: { title: 'Other', area: 'alpha' },
    };
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        changed: '2026-10-14T08:00:00.000Z',
        tasks: [],
        projects,
        areas: { alpha: { title: 'Alpha' } },
        question: {},
        resolved: [],
      }),
    );
    const reg = P.emptyRegister('2026-10-14T09:00:00.000Z');
    for (const id of ['PL-A', 'PL-B', 'PL-C']) {
      const r = P.newEntry(
        reg,
        {
          id,
          title: `Title ${id}`,
          project: 'export',
          priority: 'later',
          priority_reason: 'Rule 8: no deadline.',
          maturity: 'investigated',
        },
        { role: 'agent', projects, question: {}, existsPath: () => true },
      );
      if (r.error.length) throw new Error(r.error.join('; '));
    }
    writeFileSync(join(folder, 'plans.json'), JSON.stringify(reg));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  /** Like the server: preview (--dry), save with --expect-changed in a chain, return the changelog numbers. */
  const save = (b: Post) => {
    const { error, call } = V.planBulkCall(b);
    expect(error).toEqual([]);
    const for_ = readFileSync(join(folder, 'plans.json'), 'utf8');
    const dry = call.map((k: string[]) => run([...k, '--dry']));
    expect(
      dry.every((r: { code: number; data: Post }) => r.code === 0 && r.data?.ok === true),
    ).toBe(true);
    expect(readFileSync(join(folder, 'plans.json'), 'utf8')).toBe(for_);
    let version = dry[0].data.changed;
    const log: number[] = [];
    for (const k of call) {
      const r = run([...k, '--expect-changed', version]);
      expect(r.code).toBe(0);
      log.push(r.data.log);
      version = r.data.changed;
    }
    return log;
  };

  it('project and maturity for several entries are saved, and undo takes it all back newest first', () => {
    const l1 = save({ action: 'project', ids: ['PL-A', 'PL-B'], project: 'other' });
    expect([find('PL-A').project, find('PL-B').project, find('PL-C').project]).toEqual([
      'other',
      'other',
      'export',
    ]);
    const l2 = save({ action: 'maturity', ids: ['PL-C'], maturity: 'ready' });
    expect(find('PL-C').maturity).toBe('ready');
    for (const k of V.undoCall([...l1, ...l2]).call) expect(run(k).code).toBe(0);
    expect([find('PL-A').project, find('PL-B').project, find('PL-C').maturity]).toEqual([
      'export',
      'export',
      'investigated',
    ]);
  });

  it('priority from the row is saved as owner; merge moves the others to the archive and can be undone', () => {
    save({ action: 'priority', ids: ['PL-A'], priority: 'now', category: 'important' });
    expect(find('PL-A')).toMatchObject({
      priority: 'now',
      now_category: ['important'],
      priority_set_by: 'owner',
    });
    const l = save({ action: 'combine', ids: ['PL-A', 'PL-B'], to: 'PL-A' });
    expect(find('PL-B')).toBeUndefined();
    expect(readReg().archive['PL-B']).toBeTruthy();
    for (const k of V.undoCall(l).call) expect(run(k).code).toBe(0);
    expect(find('PL-B')).toBeTruthy();
  });

  it('an outdated expect gives exit 6 and no write', () => {
    const { call } = V.planBulkCall({ action: 'maturity', ids: ['PL-A'], maturity: 'ready' });
    const for_ = readFileSync(join(folder, 'plans.json'), 'utf8');
    const r = run([...call[0], '--expect-changed', '2020-01-01T00:00:00.000Z']);
    expect(r.code).toBe(6);
    expect(readFileSync(join(folder, 'plans.json'), 'utf8')).toBe(for_);
  });
});

describe('the wiring (index.html, queue-board.mjs and the new files)', () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  const server = readFileSync(join(CLIENT, '..', 'queue-board.mjs'), 'utf8');
  const plans = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
  const overview = readFileSync(join(CLIENT, 'plans', 'overview.js'), 'utf8');
  const work = readFileSync(join(CLIENT, 'plans', 'work.js'), 'utf8');
  const css = readFileSync(join(CLIENT, 'plans', 'plans.css'), 'utf8');
  /** The code without comments (so a comment that mentions innerHTML does not count). */
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('the new files load before plans.js and are served by the board', () => {
    const i = (s: string) => html.indexOf(s);
    expect(i('/plans/overview.js')).toBeGreaterThan(0);
    expect(i('/plans/work.js')).toBeGreaterThan(i('/plans/overview.js'));
    expect(i('/plans/plans.js')).toBeGreaterThan(i('/plans/work.js'));
    expect(server).toMatch(/'\/plans\/overview\.js'/);
    expect(server).toMatch(/'\/plans\/work\.js'/);
  });
  it('write routes and live update in the server, and all writing goes via queue.mjs', () => {
    expect(server).toMatch(/filePath === '\/api\/plan-bulk'\) return planBulk\(b\)/);
    expect(server).toMatch(/filePath === '\/api\/plan-undo'\) return planUndo\(b\)/);
    expect(server).toMatch(/searchParams\.get\('wait'\) === '1'/);
    expect(server).toMatch(/fs\.watch\(FOLDER/);
    const bulk = server.slice(
      server.indexOf('async function planBulk'),
      server.indexOf('async function planUndo'),
    );
    expect(bulk).toMatch(/PRIVACY\.planBulkCall/);
    expect(bulk).not.toMatch(/writeFileSync|renameSync/);
  });
  it('no innerHTML, all text via textContent; plans.js wires in the overview and multi select', () => {
    for (const f of [overview, work])
      expect(code(f)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
    expect(plans).toMatch(/window\.QueuePlanOverview\.side\(workHelp, d\)/);
    expect(plans).toMatch(/window\.QueuePlanWork\.optionLine\(workHelp, d\)/);
    expect(plans).toMatch(/V\.readUrl\('\?room=plans&surface=overview'\)/);
    expect(plans).toMatch(/wait: true/);
  });
  it('CSS: no hex, and the pulse stands still with reduced motion', () => {
    expect(code(css)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.pulse/);
  });
  it('the warning counts on a module card: only over 0, and no red rule shared with the capacity warning', () => {
    // One base rule for the counters (neutral); the red background belongs to .has.v-legal and the capacity warning.
    expect(code(css).match(/^\.overview-warning \{/gm)?.length).toBe(1);
    expect(css).toMatch(/\.overview-capacity-warning \{/);
    // Run moduleCard's counters with a minimal h.el: a 0 gives no element.
    const made: string[] = [];
    const h = {
      el: (_tag: string, attr: Record<string, string> | null, ...children: unknown[]) => {
        if (attr?.class) made.push(attr.class);
        return { attr, children };
      },
      goToList: () => {},
    };
    const card = {
      oid: 'm',
      title: 'M',
      count: 2,
      dropped: 0,
      share: 0.5,
      built: 1,
      priority: [],
      maturity: [],
      ownerQuestions: 0,
      legal: 2,
      stale: 0,
      active: 0,
    };
    const w: any = {
      QueuePlanView: { emptyFilter: () => ({}), workingNow: () => [], moduleSummary: () => [card] },
    };
    // The file is the repo's own overview.js, run with a stub window (as the browser does with the real one).
    new Function('window', overview)(w);
    const d = { exists: true };
    try {
      w.QueuePlanOverview.side(h, d);
    } catch {
      // side() draws more than the cards; the counters are what this test looks at.
    }
    const warnings = made.filter((c) => c.startsWith('overview-warning '));
    expect(warnings).toEqual(['overview-warning has v-legal']);
  });
});
