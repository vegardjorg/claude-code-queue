// =============================================================
// queuePlanLegal.test.ts: legal panel, owner decisions, launchOverview and the lawyer package (see docs/plan-register.md).
//
// The rules are enforced in the pure functions in lib/queuePlan.js (validation of the legal field, the points,
// the decisions and their sorting, launchOverview and the lawyer package) and lib/queuePlanView.js (the facets,
// url, the groups, path and the copy lines on the board). Render tests do not work here, so the wiring in
// legal.js, plans.js, index.html and queue-board.mjs is read as text at the end.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../queuePlanView.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const BOARD = join(__dirname, '..', '..', 'queue-board.mjs');
const NOW = new Date('2026-10-15T10:00:00Z');

type Obj = Record<string, unknown>;

function point(id: string, extra: Obj = {}): Obj {
  return { id, question: `Question ${id}?`, status: 'open', blocks: 'packing', ...extra };
}

function entry(id: string, extra: Obj = {}): Obj {
  return {
    id,
    title: `Title ${id}`,
    project: 'export',
    priority: 'later',
    priority_set_by: 'owner',
    maturity: 'investigated',
    ...extra,
  };
}

const QUEUE = {
  areas: { alpha: { title: 'Alpha' }, beta: { title: 'Beta' } },
  projects: {
    export: { title: 'Export', area: 'alpha' },
    planning: { title: 'Planning', area: 'beta' },
  },
  question: {
    'SP-A': {
      type: 'question',
      text: 'Select A or B?',
      recommendation: 'A',
      added_at: '2026-10-01T08:00:00Z',
    },
    'SP-B': { type: 'question', text: 'Price?', added_at: '2026-10-10T08:00:00Z' },
    'OWNER-SIGN': { type: 'owner-task', text: 'Sign the terms agreement', added_at: '2026-09-01T08:00:00Z' },
    'SP-BLACK': { type: 'question', text: 'Old', added_at: '2026-09-01T08:00:00Z' },
  },
  resolved: ['SP-BLACK'],
  resolutions: { 'SP-BLACK': { answer: 'Yes', time: '2026-09-02T08:00:00Z', by: 'owner' } },
  tasks: [
    { id: 'T-1', status: 'waiting', waiting_on: ['SP-B'], content_min: 90, project: 'planning' },
    { id: 'T-2', status: 'waiting', waiting_on: ['SP-B'] },
    { id: 'T-3', status: 'done', waiting_on: ['SP-A'] },
  ],
};

function register(): Obj {
  return P.normalize({
    version: 1,
    entries: [
      entry('PL-A', {
        priority: 'now',
        now_category: ['for-prod'],
        ownerQuestions: ['SP-A'],
        sources: [{ path: 'docs/a.md', anchor: '§ 2' }],
        legal: {
          affects: ['Contracts Act § 36'],
          privacy: { art9: true, dpia: 'needed', dpa_change: false },
          points: [
            point('J-A-1', { status: 'to-lawyer', blocks: 'prod', ai_assessment: 'Probably ok.' }),
            point('J-A-2', { status: 'resolved', ai_assessment: 'Resolved by AI.' }),
          ],
        },
      }),
      entry('PL-B', {
        depends_on: ['PL-A'],
        ownerQuestions: ['SP-A', 'OWNER-SIGN'],
        legal: { points: [point('J-B-1', { deadline: '2026-10-20' })] },
      }),
      entry('PL-C', { project: 'planning', depends_on: ['PL-A'] }),
      entry('PL-D', {
        priority: 'drop',
        drop_reason: 'Replaced.',
        legal: { points: [point('J-D-1', { status: 'to-lawyer' })] },
      }),
    ],
  });
}

describe('validateLegal', () => {
  it('accepts a valid field and older short point ids', () => {
    const r = P.validateLegal({
      affects: ['GDPR art. 28'],
      privacy: { art9: true, dpia: 'exists', dpa_change: true },
      points: [
        point('J7b'),
        point('E1', { status: 'resolved', lawyer: { answer: 'Ok', date: '2026-10-01' } }),
      ],
    });
    expect(r.error).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('rejects unknown fields, wrong values and duplicate ids', () => {
    const r = P.validateLegal({
      unknown: 1,
      privacy: { art9: 'yes', dpia: 'maybe', more: true },
      points: [
        point('J-1', { status: 'done', blocks: 'alt', deadline: '15.10.2026', extra: 1 }),
        point('J-1'),
        { id: 'has whitespace', question: '', status: 'open', blocks: 'prod' },
        point('J-2', { lawyer: { answer: '', date: 'yesterday', who: 'x' } }),
      ],
    });
    const alt = r.error.join('\n');
    for (const t of [
      'unknown field unknown',
      'privacy: unknown field more',
      'privacy.art9 must be true or false',
      'privacy.dpia must be',
      'point J-1: status must be',
      'point J-1: blocks must be',
      'point J-1: deadline must be',
      'point J-1: unknown field extra',
      'point J-1: the id appears twice',
      'point has whitespace: id must be',
      'point has whitespace: question missing',
      'point J-2: lawyer.answer missing',
      'point J-2: lawyer.date',
      'point J-2: lawyer: unknown field who',
    ])
      expect(alt).toContain(t);
  });

  it('warns about art. 9 without DPIA, ai-assessed without assessment and an answer on an open point', () => {
    const r = P.validateLegal({
      privacy: { art9: true },
      points: [
        point('J-1', { status: 'ai-assessed' }),
        point('J-2', { status: 'resolved' }),
        point('J-3', { status: 'to-lawyer', lawyer: { answer: 'Ok', date: '2026-10-01' } }),
      ],
    });
    expect(r.error).toEqual([]);
    const adv = r.warnings.join('\n');
    expect(adv).toContain('without a DPIA assessment');
    expect(adv).toContain('point J-1: ai-assessed without ai_assessment');
    expect(adv).toContain('point J-2: resolved without');
    expect(adv).toContain('point J-3: the lawyer has answered');
  });

  it('validateEntry rejects a point id used in another entry, but not in the entry itself', () => {
    const reg = register();
    const entries = reg.entries as Obj[];
    const fresh = entry('PL-NEW', { legal: { points: [point('J-A-1')] } });
    const r = P.validateEntry(fresh, { projects: QUEUE.projects, entries });
    expect(r.error.join('\n')).toContain('J-A-1: the id is used in PL-A');
    const own = P.validateEntry(entries[0], { projects: QUEUE.projects, entries });
    expect(own.error).toEqual([]);
  });

  it('plan edit (editEntry) refuses an invalid legal field and changes nothing', () => {
    const reg = register();
    const r = P.editEntry(
      reg,
      'PL-C',
      { legal: { points: [point('J-X', { status: 'junk' })] } },
      {
        role: 'owner',
        projects: QUEUE.projects,
      },
    );
    expect(r.error.join('\n')).toContain('status must be');
    expect(((reg.entries as Obj[])[2] as Obj).legal).toBeUndefined();
  });
});

describe('legalPoints and privacyPerModule', () => {
  it('lists the points with entry and module, open ones first by working order and blocking', () => {
    const pk = P.legalPoints(register(), QUEUE, { now: NOW });
    expect(pk.map((x: Obj) => x.id)).toEqual(['J-B-1', 'J-A-1', 'J-D-1', 'J-A-2']);
    const b1 = pk[0];
    expect(b1).toMatchObject({ entry: 'PL-B', module: 'alpha', open: true, deadline_days: 5 });
    const a1 = pk.find((x: Obj) => x.id === 'J-A-1');
    expect(a1).toMatchObject({
      affects: ['Contracts Act § 36'],
      sources: [{ path: 'docs/a.md', anchor: '§ 2' }],
    });
  });

  it('privacy per module counts art. 9 and DPIA, but not dropped entries', () => {
    const reg = register();
    (reg.entries as Obj[])[2].legal = { privacy: { art9: true, dpa_change: true } };
    const pv = P.privacyPerModule(reg, QUEUE);
    expect(pv.map((r: Obj) => r.module)).toEqual(['alpha', 'beta']);
    expect(pv[0]).toMatchObject({ art9: ['PL-A'], dpia: { needed: ['PL-A'] } });
    expect(pv[1]).toMatchObject({
      art9: ['PL-C'],
      dpia: { unassessed: ['PL-C'] },
      dpa_change: ['PL-C'],
    });
  });
});

describe('ownerDecisions', () => {
  it('links the questions to entries (also via depends_on), queue tasks and minutes', () => {
    const b = P.ownerDecisions(register(), QUEUE, { now: NOW });
    const a = b.openOnes.find((x: Obj) => x.id === 'SP-A');
    expect(a).toMatchObject({
      entries: ['PL-A', 'PL-B'],
      tasks: [],
      minutes: 0,
      modules: ['alpha'],
    });
    expect(a.blocked_entries).toEqual(['PL-A', 'PL-B', 'PL-C']);
    const bb = b.openOnes.find((x: Obj) => x.id === 'SP-B');
    expect(bb).toMatchObject({
      tasks: ['T-1', 'T-2'],
      minutes: 120,
      modules: ['beta'],
      days_open: 5,
    });
    const sign = b.openOnes.find((x: Obj) => x.id === 'OWNER-SIGN');
    expect(sign).toMatchObject({ action: true, deadline: null });
  });

  it('sorts: urgent (deadline within 14 days) first, then most blocked entries, then minutes', () => {
    const reg = register();
    (reg.entries as Obj[])[1].deadline = '2026-10-25'; // PL-B: SP-A and OWNER-SIGN get a deadline in 10 days
    const b = P.ownerDecisions(reg, QUEUE, { now: NOW });
    expect(b.openOnes.map((x: Obj) => x.id)).toEqual(['SP-A', 'OWNER-SIGN', 'SP-B']);
    expect(b.openOnes[0].urgent).toBe(true);
    const without = P.ownerDecisions(register(), QUEUE, { now: NOW });
    expect(without.openOnes.map((x: Obj) => x.id)).toEqual(['SP-A', 'OWNER-SIGN', 'SP-B']);
    expect(without.openOnes[1].blocked_entries.length).toBeGreaterThan(0);
  });

  it('answered ones are in the history with the answer', () => {
    const b = P.ownerDecisions(register(), QUEUE, { now: NOW });
    expect(b.answered).toHaveLength(1);
    expect(b.answered[0]).toMatchObject({
      id: 'SP-BLACK',
      resolved: true,
      answer: 'Yes',
      answer_by: 'owner',
    });
  });
});

describe('launchOverview', () => {
  it('collects for-prod entries, prod-blocking points, owner actions and questions on for-prod entries', () => {
    const l = P.launchOverview(register(), QUEUE, { now: NOW });
    expect(l.entries.map((p: Obj) => p.id)).toEqual(['PL-A']);
    expect(l.legal.map((x: Obj) => x.id)).toEqual(['J-A-1']);
    expect(l.actions.map((x: Obj) => x.id)).toEqual(['OWNER-SIGN']);
    expect(l.decisions.map((x: Obj) => x.id)).toEqual(['SP-A']);
    expect(l.remaining).toBe(4);
  });

  it('includes documents marked Now, before prod that have something that must be done', () => {
    const reg = register();
    reg.documents = [
      {
        id: 'DOC-TERMS',
        title: 'Terms',
        status: 'missing',
        priority: 'now',
        now_category: ['for-prod'],
      },
      { id: 'DOC-X', title: 'X', status: 'missing', priority: 'later' },
    ];
    const l = P.launchOverview(reg, QUEUE, { now: NOW });
    expect(l.documents.map((d: Obj) => d.id)).toEqual(['DOC-TERMS']);
  });
});

describe('lawyerPackage', () => {
  it('collects only to-lawyer points from entries that are not dropped, with context and links', () => {
    const pk = P.lawyerPackage(register(), QUEUE, { now: NOW });
    expect(pk.path).toBe('scripts/.queue/lawyerPackages/lawyer-package-2026-10-15.md');
    expect(pk.points).toEqual(['J-A-1']);
    expect(pk.text).toContain('## J-A-1: Question J-A-1?');
    expect(pk.text).toContain('Legal references: Contracts Act § 36');
    expect(pk.text).toContain('AI assessment: Probably ok.');
    expect(pk.text).toContain('Plan links: docs/a.md');
    expect(pk.text).toContain('not been sent');
    expect(pk.text).not.toMatch(/[–—]/);
  });

  it('free text cannot create new headings, and an empty package says so', () => {
    const reg = register();
    const point = ((reg.entries as Obj[])[0].legal as Obj).points as Obj[];
    point[0].question = 'First line\n## Fake heading';
    const pk = P.lawyerPackage(reg, QUEUE, { now: NOW });
    expect(pk.text).not.toContain('\n## Fake');
    expect(
      P.lawyerPackage(P.normalize({ version: 1, entries: [] }), QUEUE, { date: '2026-11-01' }),
    ).toMatchObject({
      path: 'scripts/.queue/lawyerPackages/lawyer-package-2026-11-01.md',
      points: [],
    });
    expect(() => P.lawyerPackagePath('../x')).toThrow();
  });

  it('the lawyer packages live in the data folder, outside the document folders, so they never become unregistered documents', () => {
    const filePath = P.lawyerPackagePath('2026-10-15');
    expect(P.DOCUMENT_FOLDERS.some((m: string) => filePath.startsWith(`${m}/`))).toBe(false);
    expect(P.lawyerPackagePath('2026-10-15', { folder: 'data/' })).toBe(
      'data/lawyerPackages/lawyer-package-2026-10-15.md',
    );
  });
});

describe('the surfaces on the board (queuePlanView)', () => {
  const data = () => {
    const reg = register();
    return {
      modules: [
        { oid: 'alpha', title: 'Alpha' },
        { oid: 'beta', title: 'Beta' },
      ],
      projects: { export: { summary: 'Export' } },
      entries: [{ id: 'PL-A', title: 'Title PL-A', module: 'alpha', project: 'export' }],
      documents: [],
      ...V.jbData(reg, QUEUE, { now: NOW, P }),
    };
  };

  it('the url carries surface, filters, search and option both ways, and drops invalid values', () => {
    const t = V.readUrl(
      '?room=plans&surface=jur&jst=to-lawyer,junk&jbl=prod&jmod=alpha&jq=terms&jur=J-A-1',
    );
    expect(t.surface).toBe('jur');
    expect(t.jfilter).toEqual({ status: ['to-lawyer'], block: ['prod'], module: ['alpha'] });
    expect(t).toMatchObject({ jsearch: 'terms', jur: 'J-A-1' });
    expect(V.readUrl(V.writeUrl(t))).toEqual(t);
    const b = V.readUrl(
      '?room=plans&surface=decision&bst=answered&bty=owner-task&bfr=30&bbl=many&sp=SP-A',
    );
    expect(b.bfilter).toMatchObject({
      status: ['answered'],
      type: ['owner-task'],
      deadline: ['30'],
      block: ['many'],
    });
    expect(b.sp).toBe('SP-A');
    expect(V.readUrl(V.writeUrl(b))).toEqual(b);
    expect(V.readUrl('?surface=secret').surface).toBe('entries');
    expect(V.readUrl('?jur=..%2Fx').jur).toBeNull();
  });

  it('closed points and answered questions are hidden until the status filter includes them', () => {
    const d = data();
    const jur = V.jbList('jur', d);
    expect(V.jbFilter('jur', jur, V.emptyJbFilter('jur'), '').map((x: Obj) => x.id)).toEqual([
      'J-B-1',
      'J-A-1',
      'J-D-1',
    ]);
    const withResolved = { ...V.emptyJbFilter('jur'), status: ['resolved'] };
    expect(V.jbFilter('jur', jur, withResolved, '').map((x: Obj) => x.id)).toEqual(['J-A-2']);
    const dec = V.jbList('decision', d);
    expect(
      V.jbFilter('decision', dec, V.emptyJbFilter('decision'), '').some((x: Obj) => x.resolved),
    ).toBe(false);
    const hist = V.jbFilter(
      'decision',
      dec,
      { ...V.emptyJbFilter('decision'), status: ['answered'] },
      'yes',
    );
    expect(hist.map((x: Obj) => x.id)).toEqual(['SP-BLACK']);
  });

  it('the facet counts count with the other filters on, and the status facet also shows the closed ones', () => {
    const d = data();
    const f = V.jbFacetNumber(
      'jur',
      V.jbList('jur', d),
      { ...V.emptyJbFilter('jur'), block: ['prod'] },
      '',
      {
        modules: d.modules,
      },
    );
    const status = f.find((x: Obj) => x.id === 'status');
    expect(status.option.map((v: Obj) => [v.val, v.count])).toEqual([['to-lawyer', 1]]);
    const block = f.find((x: Obj) => x.id === 'block');
    expect(block.option.map((v: Obj) => [v.val, v.count, v.symbol])).toEqual([
      ['prod', 1, '■'],
      ['packing', 2, '▲'],
    ]);
    const modName = f.find((x: Obj) => x.id === 'module');
    expect(modName.option[0]).toMatchObject({ val: 'alpha', text: 'Alpha' });
  });

  it('the groups: status in working order, and "Answer this first" for the top five', () => {
    const d = data();
    const g = V.jbGroups('jur', V.jbList('jur', d));
    expect(g.map((x: Obj) => x.id)).toEqual(['open', 'to-lawyer', 'resolved']);
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `S-${i}`, resolved: false }));
    const bg = V.jbGroups('decision', [...many, { id: 'S-x', resolved: true }]);
    expect(bg.map((x: Obj) => [x.id, (x.elements as Obj[]).length])).toEqual([
      ['first', 5],
      ['openOnes', 2],
      ['answered', 1],
    ]);
  });

  it('path, the copy lines (only id and titles) and the counts in the surface picker', () => {
    const d = data();
    const filePath = V.breadcrumbs({ surface: 'jur', jur: 'J-A-1', jfilter: V.emptyJbFilter('jur') }, d);
    expect(filePath.map((l: Obj) => l.text)).toEqual(['Plans', 'Legal', 'To lawyer', 'J-A-1']);
    expect(filePath[3].copy).toBe('/plans jur J-A-1 (Alpha › Export › PL-A). Instruction:');
    const bs = V.breadcrumbs({ surface: 'decision', sp: 'SP-A', bfilter: V.emptyJbFilter('decision') }, d);
    expect(bs.map((l: Obj) => l.text)).toEqual(['Plans', 'Decisions', 'SP-A']);
    expect(bs[2].copy).toBe('/plans owner SP-A (Alpha › Export › PL-A). Instruction:');
    expect(V.breadcrumbs({ surface: 'launch' }, d).map((l: Obj) => l.text)).toEqual([
      'Plans',
      'Launch',
    ]);
    expect(V.surfaceCount(d)).toMatchObject({ jur: 3, decision: 3, launch: 4 });
  });

  it('the answer to resolve: required text, at most 4000 characters, confirm only when given', () => {
    expect(V.resolveBody('SP-A', '  ').error).toBeTruthy();
    expect(V.resolveBody('SP-A', 'x'.repeat(4001)).error).toBeTruthy();
    expect(V.resolveBody('SP-A', ' Yes ').body).toEqual({ type: 'resolve', sp: 'SP-A', answer: 'Yes' });
    expect(V.resolveBody('SP-A', 'Yes', { confirm: true }).body.confirm).toBe(true);
  });
});

describe('the wiring in the board (read as text)', () => {
  const jur = readFileSync(join(CLIENT, 'plans', 'legal.js'), 'utf8');
  const plans = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  const board = readFileSync(BOARD, 'utf8');

  it('legal.js loads before plans.js and is served as a file of its own', () => {
    expect(html.indexOf('/plans/legal.js')).toBeGreaterThan(0);
    expect(html.indexOf('/plans/legal.js')).toBeLessThan(html.indexOf('/plans/plans.js'));
    expect(board).toContain("'/plans/legal.js': [path.join('plans', 'legal.js')");
    expect(plans).toContain('window.QueuePlanLegal.cells(legalHelp, d)');
  });

  it('answer goes via the resolve route, the lawyer package via /api/lawyerPackage, and no text is set as HTML', () => {
    expect(jur).toContain("postJson('/api/action', r0.body)");
    expect(jur).toContain("postJson('/api/lawyerPackage'");
    expect(board).toContain("if (filePath === '/api/lawyerPackage') return lawyerPackageWrite(b);");
    expect(board).toMatch(/isSymbolicLink\(\)/);
    expect(jur).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(jur).not.toMatch(/https?:\/\//);
  });
});
