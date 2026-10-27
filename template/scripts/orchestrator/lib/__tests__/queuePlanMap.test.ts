// =============================================================
// queuePlanMap.test.ts: the priority map and the deadline band in the Plans room (see docs/board.md).
//
// Render tests do not work here, so the rules are pure functions in lib/queuePlanView.js (the same file the
// browser loads) and are tested directly: the columns, the grid with draft, the move (mouse and keyboard use the
// same functions), the preview's changes and errors, the groups and the arguments to `queue.mjs plan prioritize`, and
// the deadline band. The arguments also run against queue.mjs on a copy in a temporary folder (preview, write with
// --expect-changed, outdated version and undo), so the server's translation is proven against the real command.
// Finally map.js, plans.js, index.html and queue-board.mjs are read as text for the wiring.
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

type Post = Record<string, unknown> & { id: string };

/** An entry as /api/plans sends it. */
function entry(id: string, extra: Record<string, unknown> = {}): Post {
  return {
    id,
    title: `Title ${id}`,
    module: 'alpha',
    project: 'export',
    priority: 'later',
    now_category: [],
    ownerQuestions: [],
    deadline: null,
    ...extra,
  };
}
const MODULES = [
  { oid: 'alpha', title: 'Alpha' },
  { oid: 'gamma', title: 'Gamma' },
];

describe('the columns and the grid', () => {
  it('Now goes under the first category (security, before prod, important); otherwise the priority', () => {
    expect(
      V.mapColumnFor(entry('PL-A', { priority: 'now', now_category: ['important', 'for-prod'] })),
    ).toBe('now-for-prod');
    expect(V.mapColumnFor(entry('PL-A', { priority: 'now', now_category: ['security'] }))).toBe(
      'now-security',
    );
    expect(V.mapColumnFor(entry('PL-A', { priority: 'now' }))).toBe('now-important');
    expect(V.mapColumnFor(entry('PL-A', { priority: 'owner' }))).toBe('owner');
    expect(V.mapColumnFor(entry('PL-A', { priority: 'junk' }))).toBeNull();
    expect(V.MAP_COLUMNS.map((k: { id: string }) => k.id)).toEqual([
      'now-security',
      'now-for-prod',
      'now-important',
      'owner',
      'later',
      'drop',
    ]);
    // Color is never the only carrier: every column has symbol and text.
    for (const k of V.MAP_COLUMNS) expect(k.symbol && k.text).toBeTruthy();
    expect(V.mapColumn('drop').folded).toBe(true);
  });

  it('the rules in the priority rules (the table in queuePlan.js) are tied to the columns', () => {
    const nr = (id: string) =>
      V.columnRules(P.PRIORITY_RULES, id).map((r: { nr: number }) => r.nr);
    expect(nr('now-security')).toEqual([1]);
    expect(nr('now-for-prod')).toEqual([2, 3]);
    expect(nr('now-important')).toEqual([2, 4, 5]);
    expect(nr('owner')).toEqual([6]);
    expect(nr('drop')).toEqual([7]);
    expect(nr('later')).toEqual([8]);
  });

  it('rows per module with matches, "Without module" last, and the draft moves the chip', () => {
    const entries = [
      entry('PL-A', { priority: 'now', now_category: ['security'] }),
      entry('PL-B'),
      entry('PL-C', { module: 'gamma', priority: 'owner' }),
      entry('PL-D', { module: null }),
      entry('PL-E', { priority: 'unknown' }),
    ];
    const n = V.mapGrid(entries, MODULES, { 'PL-B': { to: 'now-important' } });
    expect(n.rows.map((r: { oid: string }) => r.oid)).toEqual(['alpha', 'gamma', V.WITHOUT_MODULE]);
    const alpha = n.rows[0];
    expect(alpha.cells['now-important'][0]).toMatchObject({ moved: true, from: 'later' });
    expect(alpha.cells.later).toEqual([]);
    expect(alpha.count).toBe(2);
    expect(n.columns.find((k: { id: string }) => k.id === 'now-important').count).toBe(1);
    expect(n.withoutPriority.map((p: Post) => p.id)).toEqual(['PL-E']);
  });

  it('the map has the same filters as the list, plus the dropped ones for the folded column', () => {
    const entries = [
      entry('PL-A'),
      entry('PL-B', { priority: 'drop' }),
      entry('PL-C', { module: 'gamma' }),
    ];
    const filter = { ...V.emptyFilter(), module: ['alpha'] };
    expect(V.filter(entries, filter, '', { now: NOW }).map((p: Post) => p.id)).toEqual(['PL-A']);
    expect(V.mapEntries(entries, filter, '', { now: NOW }).map((p: Post) => p.id)).toEqual([
      'PL-A',
      'PL-B',
    ]);
    // If the priority filter is chosen explicitly, it applies as in the list.
    const onlyNow = { ...V.emptyFilter(), pri: ['later'] };
    expect(V.mapEntries(entries, onlyNow, '', { now: NOW }).map((p: Post) => p.id)).toEqual([
      'PL-A',
      'PL-C',
    ]);
  });
});

describe('draft', () => {
  const a = entry('PL-A');
  const b = entry('PL-B', { priority: 'now', now_category: ['important'] });

  it('moving, back to start removes the move, and the reason follows Drop', () => {
    let u = V.moveInDraft({}, a, 'drop');
    expect(u).toEqual({ 'PL-A': { to: 'drop' } });
    u = V.setDraftReason(u, 'PL-A', 'Replaced by PL-B.');
    expect(u['PL-A'].reason).toBe('Replaced by PL-B.');
    expect(V.moveInDraft(u, a, 'drop')['PL-A'].reason).toBe('Replaced by PL-B.');
    expect(V.moveInDraft(u, a, 'owner')).toEqual({ 'PL-A': { to: 'owner' } });
    expect(V.moveInDraft(u, a, 'later')).toEqual({});
    // Reason only on Drop; an unknown column changes nothing.
    expect(V.setDraftReason({ 'PL-A': { to: 'owner' } }, 'PL-A', 'x')).toEqual({
      'PL-A': { to: 'owner' },
    });
    expect(V.moveInDraft({}, a, 'junk')).toEqual({});
  });

  it('the keyboard moves to the neighbor column and stops at the edge', () => {
    expect(V.columnNeighbor('owner', -1)).toBe('now-important');
    expect(V.columnNeighbor('owner', 1)).toBe('later');
    expect(V.columnNeighbor('now-security', -1)).toBeNull();
    expect(V.columnNeighbor('drop', 1)).toBeNull();
    expect(V.columnNeighbor('junk', 1)).toBeNull();
  });

  it('cleanDraft removes gone entries and what is already there (changed by another session)', () => {
    const u = { 'PL-A': { to: 'owner' }, 'PL-B': { to: 'now-important' }, 'PL-X': { to: 'later' } };
    expect(V.cleanDraft(u, [a, b])).toEqual({ 'PL-A': { to: 'owner' } });
  });

  it('the changes for the preview, and Drop without reason stops the save', () => {
    const u = { 'PL-A': { to: 'drop' }, 'PL-B': { to: 'now-security' } };
    const r = V.draftChanges(u, [b, a]);
    expect(
      r.changes.map(
        (e: { id: string; fromText: string; toText: string }) =>
          `${e.id}:${e.fromText}>${e.toText}`,
      ),
    ).toEqual(['PL-B:Now: important>Now: security', 'PL-A:Later>Drop']);
    expect(r.error).toEqual(['PL-A: Drop requires one sentence as the reason.']);
    const ok = V.draftChanges({ 'PL-A': { to: 'drop', reason: '  Low value. ' } }, [a]);
    expect(ok.error).toEqual([]);
    expect(ok.changes[0].reason).toBe('Low value.');
  });

  it('the groups: one per priority and category, Drop per reason', () => {
    const entries = [
      entry('PL-1'),
      entry('PL-2'),
      entry('PL-3'),
      entry('PL-4'),
      entry('PL-5', { priority: 'owner' }),
    ];
    const u = {
      'PL-1': { to: 'now-for-prod' },
      'PL-2': { to: 'now-for-prod' },
      'PL-3': { to: 'drop', reason: 'A.' },
      'PL-4': { to: 'drop', reason: 'B.' },
      'PL-5': { to: 'later' },
    };
    const g = V.draftGroups(V.draftChanges(u, entries).changes);
    expect(g).toEqual([
      { priority: 'now', category: ['for-prod'], reason: null, ids: ['PL-1', 'PL-2'] },
      { priority: 'drop', category: [], reason: 'A.', ids: ['PL-3'] },
      { priority: 'drop', category: [], reason: 'B.', ids: ['PL-4'] },
      { priority: 'later', category: [], reason: null, ids: ['PL-5'] },
    ]);
  });
});

describe('the server check: prioritizeCall', () => {
  it('makes one queue.mjs call per group, as owner and from the board', () => {
    const r = V.prioritizeCall([
      { priority: 'now', category: ['security'], ids: ['PL-A', 'PL-B'] },
      { priority: 'drop', category: [], reason: '--delete all\u0007', ids: ['PL-C'] },
    ]);
    expect(r.error).toEqual([]);
    expect(r.call).toEqual([
      [
        'plan',
        'prioritize',
        'PL-A',
        'PL-B',
        'now',
        '--category',
        'security',
        '--set-by',
        'owner',
        '--by',
        'theBoard',
        '--json',
      ],
      // A reason starting with "-" would be read as a flag; control characters are removed.
      [
        'plan',
        'prioritize',
        'PL-C',
        'drop',
        '--reason',
        'delete all',
        '--set-by',
        'owner',
        '--by',
        'theBoard',
        '--json',
      ],
    ]);
  });

  it('denies all when one group is invalid', () => {
    const error = (g: unknown) => V.prioritizeCall(g).error.join(' | ');
    expect(error(null)).toContain('no changes');
    expect(error([{ priority: 'soon', ids: ['PL-A'] }])).toContain('unknown priority');
    expect(error([{ priority: 'now', category: [], ids: ['PL-A'] }])).toContain(
      'exactly one category',
    );
    expect(error([{ priority: 'later', category: ['important'], ids: ['PL-A'] }])).toContain(
      'only Now has a category',
    );
    expect(error([{ priority: 'now', category: ['junk'], ids: ['PL-A'] }])).toContain(
      'unknown Now category',
    );
    expect(error([{ priority: 'owner', ids: ['--dry'] }])).toContain('invalid');
    expect(
      error([
        { priority: 'owner', ids: ['PL-A'] },
        { priority: 'later', ids: ['PL-A'] },
      ]),
    ).toContain('duplicate');
    expect(error([{ priority: 'drop', reason: '  ', ids: ['PL-A'] }])).toContain('Drop requires');
    const many = Array.from({ length: V.DRAFT_MAX + 1 }, (_, i) => `PL-N${i}`);
    expect(error([{ priority: 'owner', ids: many }])).toContain('too many');
    const mixed = V.prioritizeCall([
      { priority: 'owner', ids: ['PL-A'] },
      { priority: 'soon', ids: ['PL-B'] },
    ]);
    expect(mixed.call).toEqual([]);
  });
});

describe('queue.mjs plan prioritize with the arguments from the map (copy in a temporary folder)', () => {
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

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-map-'));
    const projects = { export: { title: 'Export', area: 'alpha' } };
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

  it('preview writes nothing; save with the version writes as owner; undo --nr takes it back', () => {
    const entries = readReg().entries.map((p: Post) => entry(p.id, { priority: p.priority }));
    const u = {
      'PL-A': { to: 'now-for-prod' },
      'PL-B': { to: 'drop', reason: 'Covered by PL-A.' },
    };
    const { call, error } = V.prioritizeCall(V.draftGroups(V.draftChanges(u, entries).changes));
    expect(error).toEqual([]);
    const for_ = readFileSync(join(folder, 'plans.json'), 'utf8');

    const dry = call.map((k: string[]) => run([...k, '--dry']));
    expect(dry.every((r: { code: number }) => r.code === 0)).toBe(true);
    expect(dry[0].data.changes.map((e: { field: string }) => e.field)).toEqual(
      expect.arrayContaining(['priority', 'now_category', 'priority_set_by']),
    );
    expect(readFileSync(join(folder, 'plans.json'), 'utf8')).toBe(for_);

    let version = dry[0].data.changed;
    const log: number[] = [];
    for (const k of call) {
      const r = run([...k, '--expect-changed', version]);
      expect(r.code).toBe(0);
      log.push(r.data.log);
      version = r.data.changed;
    }
    const after = readReg().entries;
    expect(after.find((p: Post) => p.id === 'PL-A')).toMatchObject({
      priority: 'now',
      now_category: ['for-prod'],
      priority_set_by: 'owner',
    });
    expect(after.find((p: Post) => p.id === 'PL-B')).toMatchObject({
      priority: 'drop',
      drop_reason: 'Covered by PL-A.',
      priority_set_by: 'owner',
    });

    // An old version (the register changed since the preview) gives exit 6 and no write.
    const old = run([...call[0], '--expect-changed', dry[0].data.changed]);
    expect(old.code).toBe(6);
    expect(old.data.outdated).toBe(true);

    // The compensation the server does when a later call fails: undo the written ones, newest first.
    for (const nr of [...log].reverse())
      expect(run(['plan', 'undo', '--nr', String(nr), '--json', '--by', 'theBoard']).code).toBe(0);
    expect(readReg().entries.map((p: Post) => p.priority)).toEqual(['later', 'later', 'later']);
    // A wrong number undoes nothing.
    expect(run(['plan', 'undo', '--nr', '999', '--json']).code).not.toBe(0);
  });
});

describe('the deadline band (90 days)', () => {
  const entries = [
    entry('PL-A', { deadline: '2026-10-20' }),
    entry('PL-B', { deadline: '2026-10-01' }),
    entry('PL-C', { deadline: '2027-03-01' }),
    entry('PL-D', { deadline: '2026-11-01', priority: 'drop' }),
    entry('PL-E', {
      ownerQuestions: [
        { id: 'SP-1', text: 'Select vendor', resolved: false, deadline: '2026-11-15' },
        { id: 'SP-2', text: 'Resolved', resolved: true, deadline: '2026-11-15' },
      ],
    }),
  ];
  const documents = [
    {
      id: 'DOC-TERMS',
      title: 'Terms',
      status: 'approved',
      deadline: '2026-12-01',
      next_revision: { date: '2026-10-15', days: 0 },
      planEntries: [{ id: 'PL-A', title: 'x' }],
    },
    { id: 'DOC-X', title: 'X', status: 'outdated', deadline: '2026-10-30', planEntries: [] },
  ];

  it('includes entries, owner actions and documents within 90 days and the overdue ones; never dropped', () => {
    const e = V.deadlineElements(entries, documents, { now: NOW });
    expect(
      e.map((x: { type: string; id: string; days: number }) => `${x.type}:${x.id}:${x.days}`),
    ).toEqual([
      'entry:PL-B:-14',
      'revision:DOC-TERMS:0',
      'entry:PL-A:5',
      'owner:SP-1:31',
      'doc:DOC-TERMS:47',
    ]);
    expect(e[0]).toMatchObject({ overdue: true, share: 0 });
    expect(e[2].share).toBeCloseTo(5 / 90);
    expect(e.find((x: { id: string }) => x.id === 'SP-1').entry).toBe('PL-E');
  });

  it('with a selection: only entries in the selection and documents linked to them', () => {
    const e = V.deadlineElements(entries, documents, { now: NOW, ids: ['PL-A'] });
    expect(e.map((x: { type: string; id: string }) => `${x.type}:${x.id}`)).toEqual([
      'revision:DOC-TERMS',
      'entry:PL-A',
      'doc:DOC-TERMS',
    ]);
    expect(V.deadlineElements(entries, documents, { now: NOW, ids: ['PL-C'] })).toEqual([]);
  });

  it('the marks are spread over rows so they do not overlap, the rest batched in +N', () => {
    const m = (share: number) => ({ id: String(share), share });
    const r = V.deadlineRows([m(0), m(0.01), m(0.02), m(0.03), m(0.5)], {
      distance: 0.05,
      maxRows: 3,
    });
    expect(r.rows.map((x: { id: string }[]) => x.map((y) => y.id))).toEqual([
      ['0', '0.5'],
      ['0.01'],
      ['0.02'],
    ]);
    expect(r.hidden.map((x: { id: string }) => x.id)).toEqual(['0.03']);
  });

  it('the scale has today and every 30th day, and the text says what and when', () => {
    const s = V.deadlineScale(NOW, 90);
    expect(s.map((x: { days: number; date: string }) => `${x.days}:${x.date}`)).toEqual([
      '0:2026-10-15',
      '30:2026-11-14',
      '60:2026-12-14',
      '90:2027-01-13',
    ]);
    expect(s[0].text).toBe('Today');
    expect(
      V.deadlineText({
        type: 'entry',
        id: 'PL-B',
        title: 'B',
        date: '2026-10-01',
        days: -14,
        overdue: true,
      }),
    ).toBe('Deadline 2026-10-01 (overdue by 14 days): PL-B B');
    expect(
      V.deadlineText({
        type: 'owner',
        id: 'SP-1',
        title: 'Select',
        date: '2026-10-16',
        days: 1,
        overdue: false,
      }),
    ).toBe('Owner action 2026-10-16 (in 1 day): SP-1 Select');
  });
});

describe('url and /api/plans', () => {
  it('show=map is in the url and survives a round trip', () => {
    const t = V.readUrl('?room=plans&pri=now&show=map');
    expect(t.show).toBe('map');
    expect(V.writeUrl(t)).toBe('?room=plans&pri=now&show=map');
    expect(V.readUrl(V.writeUrl(t))).toEqual(t);
    expect(V.readUrl('?room=plans&show=junk').show).toBe('list');
    expect(V.writeUrl(V.readUrl('?room=plans'))).toBe('?room=plans');
  });

  it('plansData sends the rules and the deadline on owner questions', () => {
    const reg = {
      ...P.emptyRegister('2026-10-01T00:00:00Z'),
      entries: [
        {
          id: 'PL-A',
          title: 'A',
          project: 'export',
          priority: 'owner',
          maturity: 'idea',
          ownerQuestions: ['SP-1', 'SP-2'],
        },
      ],
    };
    const queue = {
      areas: { alpha: { title: 'Alpha' } },
      projects: { export: { title: 'Export', area: 'alpha' } },
      tasks: [],
      question: { 'SP-1': { text: 'What?', deadline: '2026-11-01' }, 'SP-2': { text: 'And?' } },
      resolved: [],
    };
    const d = V.plansData(reg, queue, { now: NOW });
    expect(d.rules.map((r: { nr: number }) => r.nr)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(d.entries[0].ownerQuestions[0].deadline).toBe('2026-11-01');
    expect('deadline' in d.entries[0].ownerQuestions[1]).toBe(false);
  });
});

describe('the wiring in the board', () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  const map = readFileSync(join(CLIENT, 'plans', 'map.js'), 'utf8');
  const plans = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
  const server = readFileSync(join(CLIENT, '..', 'queue-board.mjs'), 'utf8');
  const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, '');

  it('map.js loads after queuePlanView.js and before plans.js, and the server serves it', () => {
    const i = (s: string) => html.indexOf(s);
    expect(i('/plans/map.js')).toBeGreaterThan(i('/queuePlanView.js'));
    expect(i('/plans/plans.js')).toBeGreaterThan(i('/plans/map.js'));
    expect(server).toContain("'/plans/map.js'");
  });

  it('the map writes only via /api/plan-prioritize, and the server translates with prioritizeCall', () => {
    expect(code(map)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    const urls = [...code(map).matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(urls).toEqual(['/api/plan-prioritize']);
    expect(map).toContain("'X-Queue-Key'");
    expect(server).toContain("if (filePath === '/api/plan-prioritize') return planPrioritize(b);");
    expect(server).toContain('PRIVACY.prioritizeCall(b.groups)');
    expect(server).toContain("'--expect-changed'");
    // The rest of the room still does not write.
    expect(plans).not.toMatch(/method:\s*'POST'/);
  });

  it('plans.js switches between List and Priority map and shows the deadline band above the panes', () => {
    expect(plans).toContain("['map', 'Priority map']");
    expect(plans).toContain('window.QueuePlanMap.deadlineBand(');
    expect(plans).toContain('V.mapEntries(d.entries, t.filter, t.search)');
  });
});
