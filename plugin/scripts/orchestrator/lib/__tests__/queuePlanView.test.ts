// =============================================================
// queuePlanView.test.ts: the pure rules for the Plans room on the queue board (lib/queuePlanView.js, see docs/board.md).
//
// Render tests do not work here, so the rules are pure functions (the same file the browser loads) and are tested directly:
// the url, the facets with counts, the tree with rolled-up progress, the breadcrumb and the copy lines (only id and
// titles), "Prepare for queue", the queue status with the focus step and the data from /api/plans. In addition we read
// index.html, plans.js, plans.css and queue-board.mjs as text for the wiring (the room picker, the Focus name, the route that only
// reads, no innerHTML, no hex and fonts via the tokens).
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../queuePlanView.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const NOW = new Date('2026-10-15T10:00:00Z');

type Post = Record<string, unknown>;

/** An entry as /api/plans sends it, with default values. */
function entry(id: string, extra: Post = {}): Post {
  return {
    id,
    title: `Title ${id}`,
    summary: null,
    project: 'export',
    module: 'alpha',
    priority: 'later',
    now_category: [],
    priority_set_by: 'agent',
    maturity: 'idea',
    size: 'M',
    deadline: null,
    sources: [],
    roadmap: [],
    ownerQuestions: [],
    legal: null,
    legal_open: 0,
    stale: false,
    finished: 0,
    total: 0,
    queue: [],
    ...extra,
  };
}

const DATA = {
  modules: [
    { oid: 'alpha', title: 'Alpha' },
    { oid: 'beta', title: 'Beta' },
  ],
  projects: {
    export: { title: 'Export (risk and alerts)', summary: 'Export', area: 'alpha' },
    rotation: { title: 'Rotation', summary: 'Rotation', area: 'beta' },
  },
  entries: [] as Post[],
};

describe('url', () => {
  it('reads and writes room, filters, search, entry and tab, and survives going forward and back', () => {
    const t = V.readUrl('?room=plans&pri=now,owner&cat=for-prod&q=export&entry=PL-EXPORT-1&tab=queue');
    expect(t.room).toBe('plans');
    expect(t.filter.pri).toEqual(['now', 'owner']);
    expect(t.filter.cat).toEqual(['for-prod']);
    expect(t.search).toBe('export');
    expect(t.entry).toBe('PL-EXPORT-1');
    expect(t.tab).toBe('queue');
    expect(V.readUrl(V.writeUrl(t))).toEqual(t);
  });

  it('drops invalid values silently, and Queue is the default without a search part', () => {
    const t = V.readUrl('?room=something&pri=now,junk,now&entry=<script>&tab=x&module=Alpha!');
    expect(t.room).toBe('queue');
    expect(t.filter.pri).toEqual(['now']);
    expect(t.filter.module).toEqual([]);
    expect(t.entry).toBeNull();
    expect(t.tab).toBe('summary');
    expect(V.writeUrl(V.readUrl(''))).toBe('');
  });

  it('does not write the tab when no entry is selected, nor the default tab', () => {
    const t = V.readUrl('?room=plans&tab=queue');
    expect(V.writeUrl(t)).toBe('?room=plans');
    expect(V.writeUrl({ ...t, entry: 'PL-A', tab: 'summary' })).toBe('?room=plans&entry=PL-A');
  });

  it('the ready-made views are valid search parts in Plans', () => {
    for (const v of V.DONE_VIEWS) {
      const t = V.readUrl(v.search);
      expect(t.room).toBe('plans');
      expect(V.countFilters(t.filter)).toBeGreaterThan(0);
    }
    expect(
      V.sameView('?room=plans&pri=drop&set=agent', '?set=agent&pri=drop&room=plans'),
    ).toBe(true);
    expect(V.sameView('?room=plans&pri=now', '?room=plans&pri=now&q=x')).toBe(false);
  });

  it('an own view is cleaned (name without control chars, search part without entry)', () => {
    expect(
      V.cleanOwnView({ name: '  Mine\u0007 ', search: '?room=plans&pri=now&entry=PL-A' }),
    ).toEqual({
      name: 'Mine',
      search: '?room=plans&pri=now',
    });
    expect(V.cleanOwnView({ name: '', search: '?pri=now' })).toBeNull();
    expect(V.cleanOwnView(null)).toBeNull();
  });
});

describe('the filters and the facets', () => {
  const entries = [
    entry('PL-A', { priority: 'now', now_category: ['security'] }),
    entry('PL-B', {
      priority: 'now',
      now_category: ['for-prod'],
      ownerQuestions: [{ id: 'SP-1', resolved: false }],
    }),
    entry('PL-C', { priority: 'owner', project: 'rotation', module: 'beta' }),
    entry('PL-D', { priority: 'drop', priority_set_by: 'agent' }),
    entry('PL-E', {
      priority: 'later',
      project: null,
      module: null,
      deadline: '2026-10-20',
      legal_open: 1,
    }),
  ];

  it('drop is hidden until the priority filter includes it (SP-8)', () => {
    expect(V.filter(entries, V.emptyFilter(), '').map((p: Post) => p.id)).toEqual([
      'PL-A',
      'PL-B',
      'PL-C',
      'PL-E',
    ]);
    const f = { ...V.emptyFilter(), pri: ['drop'], set: ['agent'] };
    expect(V.filter(entries, f, '').map((p: Post) => p.id)).toEqual(['PL-D']);
  });

  it('or within a facet, and between the facets; the search in id and title', () => {
    const f = { ...V.emptyFilter(), pri: ['now', 'owner'], module: ['alpha'] };
    expect(V.filter(entries, f, '').map((p: Post) => p.id)).toEqual(['PL-A', 'PL-B']);
    expect(V.filter(entries, V.emptyFilter(), 'title pl-c').map((p: Post) => p.id)).toEqual([
      'PL-C',
    ]);
  });

  it('waiting on: the owner for priority owner or an open owner question, lawyer for open points', () => {
    expect(V.waitingOn(entries[1])).toEqual(['owner']);
    expect(V.waitingOn(entries[2])).toEqual(['owner']);
    expect(V.waitingOn(entries[4])).toEqual(['lawyer']);
    expect(V.waitingOn(entries[0])).toEqual(['none']);
  });

  it('the deadline bands are computed from today\'s date in Oslo', () => {
    expect(V.deadlineBand('2026-10-14', NOW)).toBe('overdue');
    expect(V.deadlineBand('2026-10-20', NOW)).toBe('30');
    expect(V.deadlineBand('2026-12-01', NOW)).toBe('90');
    expect(V.deadlineBand('2027-06-01', NOW)).toBe('later');
    expect(V.deadlineBand(null, NOW)).toBe('none');
  });

  it('the count per value includes the other filters, not its own facet; empty values are hidden', () => {
    const f = { ...V.emptyFilter(), pri: ['now'] };
    const counts = V.facetNumber(entries, f, '', { ...DATA, now: NOW });
    const pri = counts.find((x: { id: string }) => x.id === 'pri');
    // The priority facet ignores its own choice: all five, Drop too (which can then be checked).
    expect(pri.option.map((v: { val: string; count: number }) => [v.val, v.count])).toEqual([
      ['now', 2],
      ['owner', 1],
      ['later', 1],
      ['drop', 1],
    ]);
    expect(pri.option[0]).toMatchObject({ text: 'Now', selected: true });
    const modName = counts.find((x: { id: string }) => x.id === 'module');
    expect(modName.option.map((v: { val: string }) => v.val)).toEqual(['alpha']);
    const cat = counts.find((x: { id: string }) => x.id === 'cat');
    expect(
      cat.option.map((v: { text: string; count: number }) => `${v.text} ${v.count}`),
    ).toEqual(['security 1', 'before prod 1']);
  });

  it('a selected filter stays even without matches, so it can be removed', () => {
    const f = { ...V.emptyFilter(), module: ['gamma'] };
    const modName = V.facetNumber(entries, f, '', DATA).find((x: { id: string }) => x.id === 'module');
    expect(modName.option.find((v: { val: string }) => v.val === 'gamma')).toMatchObject({
      count: 0,
      selected: true,
    });
  });

  it('the chips have the facet name and the value text', () => {
    const f = { ...V.emptyFilter(), module: ['alpha'], pri: ['now'] };
    expect(V.chips(f, DATA).map((b: { text: string }) => b.text)).toEqual([
      'Module: Alpha',
      'Priority: Now',
    ]);
  });
});

describe('the tree and the progress', () => {
  it('module › project › entry in module order, "Without project" last and "Without module" at the end', () => {
    const entries = [
      entry('PL-V', { project: 'rotation', module: 'beta', maturity: 'built' }),
      entry('PL-A', { maturity: 'partial', finished: 1, total: 4 }),
      entry('PL-X', { project: 'exists-not' }),
      entry('PL-U', { project: null, module: null }),
    ];
    const tree = V.tree(entries, DATA);
    expect(tree.map((m: { oid: string }) => m.oid)).toEqual(['alpha', 'beta', V.WITHOUT_MODULE]);
    expect(tree[0].projects.map((p: { title: string }) => p.title)).toEqual([
      'Export',
      'Without project',
    ]);
    expect(tree[0].progress).toEqual({ built: 0, n: 2, share: 0.125 });
    expect(tree[1].progress).toEqual({ built: 1, n: 1, share: 1 });
  });
});

describe('the breadcrumb and the copy lines', () => {
  const d = {
    ...DATA,
    entries: [entry('PL-EXPORT-1', { title: 'Risk assessment, check-in and alerts' })],
  };

  it('the path is built from the selected entry, with a copy line per level', () => {
    const filePath = V.breadcrumbs({ entry: 'PL-EXPORT-1', filter: V.emptyFilter() }, d);
    expect(filePath.map((l: { text: string }) => l.text)).toEqual([
      'Plans',
      'Alpha',
      'Export',
      'PL-EXPORT-1',
    ]);
    expect(filePath.map((l: { copy: string | null }) => l.copy)).toEqual([
      null,
      '/plans alpha (Alpha). Instruction:',
      '/plans export (Alpha › Export). Instruction:',
      '/plans PL-EXPORT-1 (Alpha › Export › Risk assessment, check-in and alerts). Instruction:',
    ]);
    expect(filePath[2].filter).toMatchObject({ module: ['alpha'], project: ['export'] });
  });

  it('without an entry: the path follows the filter on one module and one project', () => {
    const f = { ...V.emptyFilter(), project: ['rotation'] };
    const filePath = V.breadcrumbs({ entry: null, filter: f }, d);
    expect(filePath.map((l: { level: string }) => l.level)).toEqual(['room', 'module', 'project']);
    expect(filePath[1].text).toBe('Beta');
  });

  it('the copy lines for owner questions and legal points have a prefix', () => {
    expect(V.copyLine('owner', 'SP-EXPORT-1', ['Alpha', 'Export', 'PL-EXPORT-1'])).toBe(
      '/plans owner SP-EXPORT-1 (Alpha › Export › PL-EXPORT-1). Instruction:',
    );
    expect(V.copyLine('jur', 'J-2', [])).toBe('/plans jur J-2. Instruction:');
  });

  it('the lines contain only id and titles, never the summary text or the sources', () => {
    const p = entry('PL-SECRET', {
      summary: 'INTERNAL CONTENT',
      sources: [{ path: 'docs/notes/x.md' }],
    });
    const lines = [V.entryLine(p, d), V.prepare(p, d).line];
    for (const l of lines) {
      expect(l).not.toContain('INTERNAL');
      expect(l).not.toContain('docs/notes');
    }
  });

  it('the short name for a project is the title up to a parenthesis or colon', () => {
    expect(V.summaryName('Export, import and reports (round 4)', 'x')).toBe(
      'Export, import and reports',
    );
    expect(V.summaryName('Legal liability: texts', 'x')).toBe('Legal liability');
    expect(V.summaryName('', 'pid')).toBe('pid');
  });
});

describe('"Prepare for queue"', () => {
  it('line for /add-to-queue and the checks before packing', () => {
    const p = entry('PL-A', {
      maturity: 'investigated',
      ownerQuestions: [
        { id: 'SP-1', resolved: false },
        { id: 'SP-2', resolved: true },
      ],
      legal: {
        points: [
          { id: 'J-1', status: 'to-lawyer', blocks: 'prod' },
          { id: 'J-2', status: 'resolved', blocks: 'prod' },
        ],
      },
      sources: [{ path: 'docs/notes/investigation.md' }],
    });
    const k = V.prepare(p, DATA);
    expect(k.line).toBe('/add-to-queue PL-A (Alpha › Export › Title PL-A)');
    expect(k.warnings).toEqual([
      'Entry is investigated, not ready.',
      '1 open owner question: SP-1.',
      '1 open legal point that blocks: J-1.',
    ]);
    expect(V.prepare(entry('PL-K', { maturity: 'ready' }), DATA).warnings).toEqual([]);
  });
});

describe('the queue status with the focus step', () => {
  it('separates the focus step from the priority and says when a task is not started', () => {
    expect(V.queueStatusText({ column: 'queue', applies: true, step: 1, step_title: 'Alpha' })).toBe(
      'In queue, stage 2 in focus (Alpha)',
    );
    expect(V.queueStatusText({ column: 'queue', applies: true, step: null, outside: true })).toBe(
      'In queue, outside focus: not started',
    );
    expect(V.queueStatusText({ column: 'queue', applies: false })).toBe('In queue');
    expect(V.queueStatusText({ column: 'built' })).toBe('Done');
    expect(V.queueStatusText({ column: null, status: 'cancelled' })).toBe('Cancelled');
  });
});

describe('the data from /api/plans', () => {
  const reg = {
    ...P.emptyRegister('2026-10-01T00:00:00Z'),
    entries: [
      {
        id: 'PL-A',
        title: 'A',
        project: 'export',
        priority: 'later',
        maturity: 'planned',
        ownerQuestions: ['SP-1'],
      },
      {
        id: 'PL-B',
        title: 'B',
        project: 'export',
        priority: 'now',
        now_category: ['important'],
        maturity: 'ready',
        depends_on: ['PL-A'],
      },
    ],
    changelog: [
      {
        nr: 1,
        at: '2026-10-02T00:00:00Z',
        by: 'queue.mjs',
        action: 'plan edit',
        changes: [
          { collection: 'entries', id: 'PL-A', field: 'priority', before: 'now', after: 'later' },
        ],
      },
    ],
    active_session: [{ entry: 'PL-B', at: '2026-10-15T09:30:00Z', by: 'plans' }],
  };
  const queue = {
    areas: { beta: { title: 'Beta' }, alpha: { title: 'Alpha' } },
    projects: { export: { title: 'Export (risk)', area: 'alpha' } },
    tasks: [
      {
        id: 'A-1',
        title: 'First',
        status: 'done',
        plan: 'PL-A',
        done: '2026-10-03T00:00:00Z',
      },
      { id: 'A-2', title: 'Other', status: 'waiting', plan: 'PL-A' },
      { id: 'A-3', title: 'Cancelled', status: 'cancelled', plan: 'PL-A' },
    ],
    question: { 'SP-1': { text: 'What do we choose?' } },
    resolved: [],
  };

  it('sorts by the priority rules, derives maturity and includes queue status, question, active session and history', () => {
    // Modules in the configuration's order first (sent in here), then the others in the queue's order.
    const queuePlan = { ...P, MODULES: [{ oid: 'alpha', title: 'Alpha' }] };
    const d = V.plansData(reg, queue, {
      now: NOW,
      queuePlan,
      queueInfo: (o: { status: string }) => ({ column: o.status === 'waiting' ? 'queue' : 'built' }),
    });
    expect(d.modules.map((m: { oid: string }) => m.oid)).toEqual(['alpha', 'beta']);
    expect(d.read_folders).toEqual(['docs/']);
    expect(d.projects.export.summary).toBe('Export');
    expect(d.entries.map((p: Post) => p.id)).toEqual(['PL-B', 'PL-A']);
    const a = d.entries[1];
    expect(a).toMatchObject({
      module: 'alpha',
      maturity: 'partial',
      fraction: '1/2',
      finished: 1,
      total: 2,
      maturity_plan: 'planned',
    });
    expect(a.queue.map((o: { id: string; column: string }) => `${o.id}:${o.column}`)).toEqual([
      'A-1:built',
      'A-2:queue',
    ]);
    expect(a.ownerQuestions).toEqual([{ id: 'SP-1', text: 'What do we choose?', resolved: false, answer: null }]);
    expect(a.blocks).toEqual(['PL-B']);
    expect(a.history).toEqual([
      {
        nr: 1,
        at: '2026-10-02T00:00:00Z',
        by: 'queue.mjs',
        action: 'plan edit',
        field: ['priority'],
      },
    ]);
    expect(d.entries[0].active).toEqual({ at: '2026-10-15T09:30:00Z', by: 'plans' });
    // The history has only field names, never the values before and after.
    expect(JSON.stringify(a.history)).not.toContain('later');
    expect(V.planForTask(d.entries)).toEqual({ 'A-1': 'PL-A', 'A-2': 'PL-A' });
  });
});

describe('the wiring in the board', () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  const js = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
  const css = readFileSync(join(CLIENT, 'plans', 'plans.css'), 'utf8');
  const board = readFileSync(join(CLIENT, 'board.js'), 'utf8');
  const server = readFileSync(join(CLIENT, '..', 'queue-board.mjs'), 'utf8');

  it('the top has the room picker Plans | Queue, and the "plan" view is called Focus', () => {
    expect(html).toMatch(/id="room-option"[^>]*role="tablist"/);
    expect(html).toMatch(/id="room-plans"[\s\S]*?Plans\s*<\/button>/);
    expect(html).toMatch(/id="room-queue"[\s\S]*?Queue\s*<\/button>/);
    expect(html).toMatch(/id="show-plan"[\s\S]*?>\s*Focus\s*<\/button>/);
    expect(html).toContain('id="plans-room"');
  });

  it('plans.js loads after board.js and queuePlanView.js, and the server serves them', () => {
    const i = (s: string) => html.indexOf(s);
    expect(i('/board.js')).toBeGreaterThan(0);
    expect(i('/queuePlanView.js')).toBeGreaterThan(i('/board.js'));
    expect(i('/plans/plans.js')).toBeGreaterThan(i('/queuePlanView.js'));
    expect(server).toContain("'/plans/plans.js'");
    expect(server).toContain("'/plans/plans.css'");
    expect(server).toContain("'/queuePlanView.js'");
  });

  it('/api/plans is read only (GET), and the room never writes', () => {
    expect(server).toMatch(/req\.method === 'GET' && filePath === '\/api\/plans'/);
    expect(js).not.toMatch(/method:\s*'POST'/);
    const code = js.replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it('the queue card has a marker for the plan entry, and the detail panel a link to it', () => {
    expect(board).toContain("class: 'badge plan-entry-badge'");
    expect(board).toContain("'Plan entry',");
    expect(board).toContain('window.QueuePlans?.openEntry(k.plan)');
    expect(board).toContain('window.QueueBoard = {');
  });

  it('plans.css uses the tokens: no hex, fonts via --text-*, weight 400 or 600', () => {
    const without = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(without).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const m of without.matchAll(/font-size:\s*([^;]+);/g))
      expect(m[1]).toMatch(/^var\(--text-(xs|sm|md|lg|xl)\)$/);
    for (const m of without.matchAll(/font-weight:\s*([^;]+);/g))
      expect(['400', '600']).toContain(m[1].trim());
  });
});

// PLAN-3a-QA1: optional parts (the deadline band, the Unregistered box, the action line) are null on surfaces where they
// do not apply, and Element.append(null) inserts the text "null". The room is therefore only filled via roomChildren.
describe('roomChildren (PLAN-3a-QA1)', () => {
  it('removes null, undefined and false and keeps the order', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    expect(V.roomChildren([null, a, undefined, false, b, null])).toEqual([a, b]);
    expect(V.roomChildren([])).toEqual([]);
    expect(V.roomChildren(undefined)).toEqual([]);
  });

  it('plans.js never puts children straight into the room with room.append', () => {
    const source = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
    // The only call is inside fillRoom, which filters with roomChildren first.
    expect(source.match(/\broom\.append\(/g)).toHaveLength(1);
    expect(source).toMatch(/room\.append\(\.\.\.V\.roomChildren\(children\)\)/);
  });
});
