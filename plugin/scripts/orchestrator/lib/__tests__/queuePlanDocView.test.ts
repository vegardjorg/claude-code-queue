// =============================================================
// queuePlanDocView.test.ts: the view rules for the surface "Documents and agreements" in the Plans room
// (lib/queuePlanView.js): the values match queuePlan.js,
// the url (surface, filters, search, selected document), the facets with counts, the table per group, the timeline per month,
// the path and the data /api/plans sends.
// =============================================================
import { describe, it, expect } from 'vitest';

type DocV = Record<string, unknown> & { id: string; notice?: string[]; reasons?: unknown[] };
type State = {
  room: string;
  surface: string;
  dfilter: Record<string, string[]>;
  dsearch: string;
  doc: string | null;
  filter: Record<string, string[]>;
  entry: string | null;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../queuePlanView') as {
  DOC_GROUP: Record<string, string>;
  DOC_STATUS: Record<string, unknown>;
  DOC_AUDIENCE: Record<string, string>;
  DOC_SEVERITY: Record<string, string>;
  DOC_PUBLISHED: Record<string, string>;
  readUrl: (s: string) => State;
  writeUrl: (t: object) => string;
  emptyDocFilter: () => Record<string, string[]>;
  docFilter: (l: DocV[], f?: object, s?: string) => DocV[];
  docFacetNumber: (
    l: DocV[],
    f: object,
    s: string,
  ) => { id: string; option: { val: string; count: number }[] }[];
  docChips: (f: object) => { text: string }[];
  countDocFilters: (f: object) => number;
  docGroups: (
    l: DocV[],
  ) => { id: string; count: number; must: number; status: Record<string, number> }[];
  timelineMonths: (l: object[]) => { sortKey: string; title: string; elements: unknown[] }[];
  breadcrumbs: (
    t: object,
    d: object,
  ) => { level: string; text: string; copy: string | null; state?: object }[];
  cleanOwnView: (x: unknown) => { search: string } | null;
  plansData: (
    reg: object,
    queue: object,
    ctx?: object,
  ) => Record<string, unknown> & { documents: DocV[] };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan') as {
  DOC_GROUPS: { id: string }[];
  DOC_STATUSES: string[];
  DOC_AUDIENCES: string[];
  DOC_SEVERITY: string[];
  DOC_PUBLISHED_WHERE: string[];
};

const d = (id: string, extra: object = {}): DocV => ({
  id,
  title: `Document ${id}`,
  group: 'customerAgreements',
  audience: 'customer',
  status: 'draft',
  priority: null,
  notice: [],
  reasons: [],
  problems: [],
  ...extra,
});

describe('queuePlanView: the values and the url', () => {
  it('the values are the same as in queuePlan.js (the order too)', () => {
    expect(Object.keys(V.DOC_GROUP)).toEqual(P.DOC_GROUPS.map((g) => g.id));
    expect(Object.keys(V.DOC_STATUS)).toEqual(P.DOC_STATUSES);
    expect(Object.keys(V.DOC_AUDIENCE)).toEqual(P.DOC_AUDIENCES);
    expect(Object.keys(V.DOC_SEVERITY)).toEqual(P.DOC_SEVERITY);
    expect(Object.keys(V.DOC_PUBLISHED)).toEqual(P.DOC_PUBLISHED_WHERE);
  });

  it('surface, filters, search and selected document go forward and back; invalid ones are dropped', () => {
    const t = V.readUrl(
      '?room=plans&surface=doc&dgr=privacy&dst=to-lawyer,junk&dq=terms&doc=DOC-TERMS',
    );
    expect(t).toMatchObject({
      room: 'plans',
      surface: 'doc',
      dsearch: 'terms',
      doc: 'DOC-TERMS',
      dfilter: { group: ['privacy'], status: ['to-lawyer'] },
    });
    expect(V.readUrl(V.writeUrl(t))).toEqual(t);
    const u = V.readUrl('?room=plans&surface=x&doc=<script>');
    expect(u.surface).toBe('entries');
    expect(u.doc).toBeNull();
    // The Queue room and a plan entry address are as before.
    expect(V.writeUrl(V.readUrl(''))).toBe('');
    expect(V.writeUrl(V.readUrl('?room=plans&pri=now'))).toBe('?room=plans&pri=now');
  });

  it('a saved view does not include the document state', () => {
    expect(
      V.cleanOwnView({ name: 'X', search: '?room=plans&pri=now&surface=doc&doc=DOC-A' })?.search,
    ).toBe('?room=plans&pri=now');
  });
});

describe('queuePlanView: facets, groups and timeline', () => {
  const list = [
    d('DOC-A', { status: 'to-lawyer', notice: ['problem-high', 'problem'], reasons: [{}] }),
    d('DOC-B', { group: 'privacy', audience: 'public' }),
    d('DOC-C', { group: 'governance', audience: 'internal', status: 'approved', priority: 'now' }),
    d('DOC-D', { priority: 'drop' }),
  ];

  it('filters, hides dropped ones and counts per value', () => {
    expect(V.docFilter(list).map((x) => x.id)).toEqual(['DOC-A', 'DOC-B', 'DOC-C']);
    expect(V.docFilter(list, { pri: ['drop'] }).map((x) => x.id)).toEqual(['DOC-D']);
    expect(V.docFilter(list, { notice: ['problem'] }).map((x) => x.id)).toEqual(['DOC-A']);
    expect(V.docFilter(list, { notice: ['none'] }).map((x) => x.id)).toEqual(['DOC-B', 'DOC-C']);
    expect(V.docFilter(list, {}, 'document doc-b').map((x) => x.id)).toEqual(['DOC-B']);
    const f = { ...V.emptyDocFilter(), group: ['customerAgreements'] };
    const counts = V.docFacetNumber(list, f, '');
    // Group is counted without its own choice; status with the group filter on.
    expect(counts.find((x) => x.id === 'group')?.option.map((v) => `${v.val}:${v.count}`)).toEqual([
      'customerAgreements:1',
      'privacy:1',
      'governance:1',
    ]);
    expect(counts.find((x) => x.id === 'status')?.option.map((v) => `${v.val}:${v.count}`)).toEqual([
      'to-lawyer:1',
    ]);
    expect(V.docChips(f).map((b) => b.text)).toEqual(['Group: Customer agreements']);
    expect(V.countDocFilters(f)).toBe(1);
  });

  it('one table per group in the order from the plan', () => {
    const g = V.docGroups(V.docFilter(list));
    expect(g.map((x) => `${x.id}:${x.count}:${x.must}`)).toEqual([
      'customerAgreements:1:1',
      'privacy:1:0',
      'governance:1:0',
    ]);
    expect(g[0].status).toEqual({ 'to-lawyer': 1 });
  });

  it('the timeline: Overdue first, then one column per month', () => {
    const k = V.timelineMonths([
      { id: 'DOC-A', date: '2026-09-01', overdue: true },
      { id: 'DOC-B', date: '2026-12-01', overdue: false },
      { id: 'DOC-C', date: '2026-11-03', overdue: false },
      { id: 'DOC-D', date: '2026-11-20', overdue: false },
    ]);
    expect(k.map((x) => `${x.sortKey}:${x.elements.length}`)).toEqual([
      'overdue:1',
      '2026-11:2',
      '2026-12:1',
    ]);
    expect(k[1].title).toMatch(/^November 2026$/i);
  });
});

describe('queuePlanView: the path and the data from the server', () => {
  const reg = {
    entries: [{ id: 'PL-SWAP-1', title: 'Swap email vendor', project: 'p', priority: 'now' }],
    archive: {},
    changelog: [
      {
        nr: 1,
        at: '2026-10-14T10:00:00Z',
        by: 'test',
        action: 'plan doc edit',
        changes: [{ collection: 'documents', id: 'DOC-TERMS', field: 'status' }],
      },
    ],
    documents: [
      {
        id: 'DOC-VENDOR',
        title: 'Subprocessors',
        group: 'privacy',
        audience: 'public',
        status: 'approved',
      },
      {
        id: 'DOC-TERMS',
        title: 'Terms agreement',
        group: 'customerAgreements',
        audience: 'customer',
        status: 'approved',
        version: '1.3',
        current_version: '1.2',
        last_revised: '2025-09-20',
        revision_every: '12 mo',
        depends_on_docs: ['DOC-VENDOR'],
        planEntries: ['PL-SWAP-1'],
        problems: [{ text: 'Mentions old vendor', severity: 'high' }],
        ownerQuestions: ['SP-TERMS-1'],
      },
    ],
  };
  const queue = {
    projects: { p: { title: 'P', area: 'm' } },
    areas: { m: { title: 'M' } },
    question: { 'SP-TERMS-1': { text: 'Which?' } },
    resolved: [],
  };
  const data = V.plansData(reg, queue, { now: new Date('2026-10-15T10:00:00Z') });

  it('plansData has documents with skew, revision, notices, links and history', () => {
    const dpa = data.documents.find((x) => x.id === 'DOC-TERMS') as DocV & Record<string, unknown>;
    expect(dpa.notice).toEqual(['problem-high', 'problem', 'miss', 'overdue']);
    expect(dpa.next_revision).toMatchObject({ date: '2026-09-20', overdue: true });
    expect(dpa.depends_on_docs).toEqual([
      { id: 'DOC-VENDOR', title: 'Subprocessors', status: 'approved' },
    ]);
    expect(dpa.planEntries).toEqual([{ id: 'PL-SWAP-1', title: 'Swap email vendor' }]);
    expect(dpa.ownerQuestions).toEqual([{ id: 'SP-TERMS-1', text: 'Which?', resolved: false }]);
    expect((dpa.history as { field: string[] }[])[0].field).toEqual(['status']);
    expect(
      (data.documents.find((x) => x.id === 'DOC-VENDOR') as Record<string, unknown>).used_by,
    ).toEqual(['DOC-TERMS']);
    expect((data.doc_must_be_done as { id: string }[]).map((x) => x.id)).toEqual(['DOC-TERMS']);
    expect((data.doc_timeline as { id: string; type: string }[])[0]).toMatchObject({
      id: 'DOC-TERMS',
      type: 'revision',
    });
  });

  it('path: Plans › Documents and agreements › Group › DOC-id with copy line', () => {
    const filePath = V.breadcrumbs(V.readUrl('?room=plans&surface=doc&doc=DOC-TERMS'), data);
    expect(filePath.map((l) => l.text)).toEqual([
      'Plans',
      'Documents and agreements',
      'Customer agreements',
      'DOC-TERMS',
    ]);
    expect(filePath[3].copy).toBe('/plans doc DOC-TERMS. Instruction:');
    expect(filePath[0].state).toEqual({ surface: 'entries', doc: null });
    const onlyGroup = V.breadcrumbs(V.readUrl('?room=plans&surface=doc&dgr=governance'), data);
    expect(onlyGroup.map((l) => l.level)).toEqual(['room', 'surface', 'group']);
  });
});
