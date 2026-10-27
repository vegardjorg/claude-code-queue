// =============================================================
// queuePlanDoc.test.ts: Documents and agreements (see docs/plan-register.md). The register `documents`
// in plans.json: validation, versionSkew, next revision and the timeline, "What must be done", the limits for the agent on
// priority, changelog and undo, and `queue.mjs plan doc …` against a copy in a temporary folder (never the
// real queue or the real register). The display rules for the tab are tested in queuePlanView.test.ts.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Doc = Record<string, unknown> & { id: string };
type Reg = {
  changed?: string;
  entries: Record<string, unknown>[];
  archive: Record<string, unknown>;
  documents: Doc[];
  changelog: { nr: number; changes: { collection: string; id: string; field: string }[] }[];
};
type Answer = { error: string[]; warnings: string[]; doc?: Doc; boost?: boolean };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan') as {
  DOC_GROUPS: { id: string; title: string }[];
  DOC_STATUSES: string[];
  emptyRegister: (now?: string) => Reg;
  normalize: (r: unknown) => Reg;
  validateDoc: (d: unknown, ctx?: object) => { error: string[]; warnings: string[] };
  newDoc: (reg: Reg, input: object, ctx?: object) => Answer;
  editDoc: (reg: Reg, id: string, field: object, ctx?: object) => Answer;
  reviseDoc: (reg: Reg, id: string, option: object, ctx?: object) => Answer;
  revisionInterval: (s: unknown) => object | null;
  nextRevision: (d: object, o?: object) => Record<string, unknown> | null;
  versionSkew: (d: object) => { type: string; text: string }[];
  docReasons: (d: object, o?: object) => { type: string }[];
  docMustBeDone: (l: object[], o?: object) => { id: string; reasons: { type: string }[] }[];
  revisionTimeline: (l: object[], o?: object) => { id: string; type: string; date: string }[];
  docCopyLine: (d: object) => string;
  filterDoc: (reg: Reg, f?: object, o?: object) => Doc[];
  getDoc: (reg: Reg, queue: object, id: string, o?: object) => Record<string, unknown>;
  planDiff: (a: object, b: object) => { collection: string; id: string; field: string }[];
  logChange: (reg: Reg, o: object) => unknown;
  undo: (reg: Reg, o?: object) => { error: string[] };
};

const NOW = new Date('2026-10-15T10:00:00.000Z');
const EXISTS = new Set(['docs/agreements/terms.md', 'docs/privacy.md']);
const ctx = (role = 'agent') => ({
  role,
  question: { 'SP-TERMS-1': { text: 'Which version?' } },
  existsPath: (s: string) => EXISTS.has(s),
  now: '2026-10-15T10:00:00.000Z',
});
const doc = (id: string, extra: object = {}): Doc => ({
  id,
  title: `Document ${id}`,
  group: 'customerAgreements',
  audience: 'customer',
  status: 'draft',
  source: 'docs/agreements/terms.md',
  ...extra,
});
const register = (...documents: Doc[]): Reg => {
  const reg = P.normalize(P.emptyRegister('2026-10-14T09:00:00.000Z'));
  for (const d of documents) {
    const r = P.newDoc(reg, d, ctx(d.priority_set_by === 'owner' ? 'owner' : 'agent'));
    if (r.error.length) throw new Error(r.error.join('; '));
  }
  return reg;
};

describe('queuePlan: validation of documents', () => {
  it('accepts a full document with all the fields', () => {
    const reg = register(
      doc('DOC-DECLARATION', { group: 'privacy', source: 'docs/privacy.md' }),
    );
    const r = P.newDoc(
      reg,
      doc('DOC-TERMS', {
        published: [
          { where: 'webPage', url: 'https://example.no/terms', version: '1.2' },
          { where: 'admin', path: 'guidance/terms', version: '1.1' },
        ],
        version: '1.3-draft',
        current_version: '1.2',
        status: 'to-lawyer',
        last_revised: '2026-09-20',
        revision_every: '12 mo',
        depends_on_docs: ['DOC-DECLARATION'],
        problems: [{ text: 'Mentions old vendor', severity: 'high', source: 'PL-SWAP-1' }],
        priority: 'now',
        now_category: ['for-prod'],
        priority_reason: 'Rule 3: Terms before the first paying customer.',
        legal_points: ['J-TERMS-3'],
        ownerQuestions: ['SP-TERMS-1'],
        deadline: null,
      }),
      ctx(),
    );
    expect(r.error).toEqual([]);
    expect(r.doc).toMatchObject({ priority_set_by: 'agent', created: ctx().now });
    expect(reg.documents.map((d) => d.id)).toEqual(['DOC-DECLARATION', 'DOC-TERMS']);
  });

  it('rejects an unknown field, wrong id, group, status, path and web address', () => {
    const v = P.validateDoc(
      {
        ...doc('TERMS'),
        group: 'other',
        status: 'done',
        audience: 'all',
        source: '../secret.md',
        published: [{ where: 'webPage', url: 'http://uncertain.no' }],
        junkField: 1,
      },
      {},
    );
    const t = v.error.join('\n');
    expect(t).toContain('unknown field junkField');
    expect(t).toContain('id must look like DOC-');
    expect(t).toContain('group must be');
    expect(t).toContain('status must be');
    expect(t).toContain('audience must be');
    expect(t).toContain('. and .. are not allowed');
    expect(t).toContain('https address');
  });

  it('the source must exist; a document that is missing needs no source', () => {
    const reg = register();
    expect(P.newDoc(reg, doc('DOC-X', { source: 'docs/gone.md' }), ctx()).error.join()).toContain(
      'does not exist',
    );
    const r = P.newDoc(reg, doc('DOC-Y', { source: undefined, status: 'missing' }), ctx());
    expect(r.error).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('ids are never reused, depends_on_docs and planEntries must exist', () => {
    const reg = register(doc('DOC-A'));
    expect(P.newDoc(reg, doc('DOC-A'), ctx()).error.join()).toContain('already used');
    expect(P.newDoc(reg, doc('DOC-B', { depends_on_docs: ['DOC-Z'] }), ctx()).error.join()).toContain(
      'unknown document DOC-Z',
    );
    expect(
      P.newDoc(reg, doc('DOC-C', { planEntries: ['PL-EXISTS-NOT'] }), ctx()).error.join(),
    ).toContain('unknown planEntry');
  });

  it('priority is optional, but follows the priority rules when it is set', () => {
    const reg = register();
    expect(P.newDoc(reg, doc('DOC-A'), ctx()).error).toEqual([]);
    expect(
      P.newDoc(
        reg,
        doc('DOC-B', { priority: 'now', now_category: ['for-prod'] }),
        ctx(),
      ).error.join(),
    ).toContain('priority_reason');
    expect(
      P.newDoc(
        reg,
        doc('DOC-C', { priority: 'later', priority_reason: 'Rule 3: Terms before customer.' }),
        ctx(),
      ).error.join(),
    ).toContain('rule 3');
    expect(P.newDoc(reg, doc('DOC-D', { now_category: ['important'] }), ctx()).error.join()).toContain(
      'only used when priority is set',
    );
  });
});

describe('queuePlan: priority and the limits for the agent', () => {
  const ownerDoc = doc('DOC-E', {
    priority: 'later',
    priority_reason: 'The owner: waiting.',
    priority_set_by: 'owner',
  });

  it('an agent does not change a priority the owner has set, but rule 1 can raise it', () => {
    const reg = register(ownerDoc);
    const no = P.editDoc(
      reg,
      'DOC-E',
      { priority: 'now', now_category: ['important'], priority_reason: 'Rule 4: x' },
      ctx(),
    );
    expect(no.error.join()).toContain('set by the owner');
    const yes = P.editDoc(
      reg,
      'DOC-E',
      {
        priority: 'now',
        now_category: ['security'],
        priority_reason: 'Rule 1: secret in the text.',
      },
      ctx(),
    );
    expect(yes.error).toEqual([]);
    expect(yes.boost).toBe(true);
    expect(yes.doc).toMatchObject({
      priority_set_by: 'agent',
      agent_boost: { from: { priority: 'later' } },
    });
  });

  it('the owner can set and remove the priority; tool fields cannot be set', () => {
    const reg = register(doc('DOC-A'));
    const r = P.editDoc(reg, 'DOC-A', { priority: 'owner' }, ctx('owner'));
    expect(r.error).toEqual([]);
    expect(r.doc).toMatchObject({ priority: 'owner', priority_set_by: 'owner' });
    const away = P.editDoc(reg, 'DOC-A', { priority: null }, ctx('owner'));
    expect(away.error).toEqual([]);
    expect(away.doc?.priority_set_by).toBeUndefined();
    expect(P.editDoc(reg, 'DOC-A', { created: 'x' }, ctx()).error.join()).toContain(
      'is set by the tool',
    );
    expect(P.editDoc(reg, 'DOC-ZZ', { status: 'draft' }, ctx()).error.join()).toContain(
      'unknown document',
    );
  });
});

describe('queuePlan: revision, timeline and versionSkew', () => {
  it('parses revision_every', () => {
    expect(P.revisionInterval('12 mo')).toEqual({ mo: 12 });
    expect(P.revisionInterval('1 year')).toEqual({ mo: 12 });
    expect(P.revisionInterval('4 weeks')).toEqual({ days: 28 });
    expect(P.revisionInterval('90 days')).toEqual({ days: 90 });
    expect(P.revisionInterval('on change of subprocessor')).toEqual({
      event: 'on change of subprocessor',
    });
    expect(P.revisionInterval('now and then')).toBeNull();
  });

  it('next revision: date, overdue, soon, event; none for missing', () => {
    expect(
      P.nextRevision(
        { last_revised: '2025-09-20', revision_every: '12 mo', status: 'approved' },
        { now: NOW },
      ),
    ).toMatchObject({
      date: '2026-09-20',
      overdue: true,
    });
    expect(
      P.nextRevision(
        { last_revised: '2026-01-31', revision_every: '1 mo', status: 'approved' },
        { now: NOW },
      ),
    ).toMatchObject({
      date: '2026-02-28',
    });
    expect(
      P.nextRevision(
        { last_revised: '2026-04-01', revision_every: '7 mo', status: 'approved' },
        { now: NOW },
      ),
    ).toMatchObject({
      date: '2026-11-01',
      overdue: false,
      soon: true,
    });
    expect(
      P.nextRevision({ revision_every: 'on change', status: 'approved' }, { now: NOW }),
    ).toEqual({
      event: 'on change',
    });
    expect(
      P.nextRevision(
        { last_revised: '2025-01-01', revision_every: '1 mo', status: 'missing' },
        { now: NOW },
      ),
    ).toBeNull();
  });

  it('versionSkew: published differs from current, places differ, customers on an older version', () => {
    const types = (d: object) => P.versionSkew(d).map((g) => g.type);
    expect(
      types({
        status: 'published',
        current_version: '1.2',
        version: '1.2',
        published: [
          { where: 'webPage', version: '1.2' },
          { where: 'admin', version: '1.1' },
        ],
      }),
    ).toEqual(['published-different', 'places-different']);
    expect(
      types({ status: 'approved', audience: 'customer', version: '1.3', current_version: '1.2' }),
    ).toEqual(['accepted-older']);
    expect(
      types({ status: 'approved', audience: 'internal', version: '1.3', current_version: '1.2' }),
    ).toEqual(['not-rolled-out']);
    // A draft is not approved yet: no skew.
    expect(
      types({
        status: 'to-lawyer',
        audience: 'customer',
        version: '1.3-draft',
        current_version: '1.2',
      }),
    ).toEqual([]);
  });

  it('"What must be done" and the timeline', () => {
    const list = [
      { id: 'DOC-A', status: 'missing' },
      { id: 'DOC-B', status: 'approved', last_revised: '2025-01-01', revision_every: '12 mo' },
      { id: 'DOC-C', status: 'draft', problems: [{ text: 'x', severity: 'high' }] },
      { id: 'DOC-D', status: 'draft', priority: 'now', now_category: ['for-prod'] },
      { id: 'DOC-E', status: 'published', last_revised: '2026-06-01', revision_every: '6 mo' },
      {
        id: 'DOC-F',
        status: 'draft',
        priority: 'drop',
        problems: [{ text: 'x', severity: 'high' }],
      },
    ];
    const m = P.docMustBeDone(list, { now: NOW });
    expect(m.map((x) => x.id)).toEqual(['DOC-A', 'DOC-C', 'DOC-B', 'DOC-D']);
    const t = P.revisionTimeline(list, { now: NOW, days: 90 });
    expect(t.map((x) => `${x.id} ${x.date}`)).toEqual(['DOC-B 2026-01-01', 'DOC-E 2026-12-01']);
    expect(P.docCopyLine({ id: 'DOC-TERMS' })).toBe('/plans doc DOC-TERMS. Instruction:');
  });

  it('revise sets last_revised, version and the history', () => {
    const reg = register(
      doc('DOC-A', { status: 'approved', version: '1.0', revision_every: '12 mo' }),
    );
    const r = P.reviseDoc(
      reg,
      'DOC-A',
      { version: '1.1', date: '2026-10-01', remark: 'New vendor', by: 'test' },
      ctx(),
    );
    expect(r.error).toEqual([]);
    expect(r.doc).toMatchObject({
      last_revised: '2026-10-01',
      version: '1.1',
      revisions: [{ date: '2026-10-01', version: '1.1', remark: 'New vendor', by: 'test' }],
    });
    expect(P.reviseDoc(reg, 'DOC-A', { date: '1. session' }, ctx()).error.join()).toContain(
      'YYYY-MM-DD',
    );
  });
});

describe('queuePlan: filter, fetching, changelog and undo', () => {
  it('filters and fetches with links both ways', () => {
    const reg = register(
      doc('DOC-VENDOR', { group: 'privacy', status: 'approved' }),
      doc('DOC-TERMS', {
        depends_on_docs: ['DOC-VENDOR'],
        problems: [{ text: 'Old vendor', severity: 'medium' }],
      }),
      doc('DOC-OLD', {
        priority: 'drop',
        drop_reason: 'Replaced.',
        priority_reason: 'Rule 7: replaced.',
      }),
    );
    expect(P.filterDoc(reg).map((d) => d.id)).toEqual(['DOC-VENDOR', 'DOC-TERMS']);
    expect(P.filterDoc(reg, { all: true })).toHaveLength(3);
    expect(P.filterDoc(reg, { group: ['privacy'] }).map((d) => d.id)).toEqual([
      'DOC-VENDOR',
    ]);
    expect(P.filterDoc(reg, { problems: true }).map((d) => d.id)).toEqual(['DOC-TERMS']);
    expect(P.filterDoc(reg, { search: 'old vendor' }).map((d) => d.id)).toEqual(['DOC-TERMS']);
    const h = P.getDoc(reg, { question: {} }, 'DOC-VENDOR');
    expect(h.used_by).toEqual(['DOC-TERMS']);
    expect(h.copy).toBe('/plans doc DOC-VENDOR. Instruction:');
    expect(P.getDoc(reg, {}, 'DOC-X').error).toEqual(['unknown document DOC-X']);
  });

  it('the changelog has the collection documents, and undo rolls back', () => {
    const reg = register(doc('DOC-A'));
    const for_ = JSON.parse(JSON.stringify(reg));
    P.editDoc(reg, 'DOC-A', { status: 'to-lawyer' }, ctx());
    const e = P.planDiff(for_, reg);
    expect(e).toEqual([
      expect.objectContaining({ collection: 'documents', id: 'DOC-A', field: 'status' }),
    ]);
    P.logChange(reg, { action: 'plan doc edit', changes: e });
    expect(P.undo(reg).error).toEqual([]);
    expect(reg.documents[0].status).toBe('draft');
    // A new document is undone completely.
    const for2 = JSON.parse(JSON.stringify(reg));
    P.newDoc(reg, doc('DOC-B'), ctx());
    P.logChange(reg, { action: 'plan doc new', changes: P.planDiff(for2, reg) });
    expect(P.undo(reg).error).toEqual([]);
    expect(reg.documents.map((d) => d.id)).toEqual(['DOC-A']);
  });
});

describe('queue.mjs plan doc …: against a copy in a temporary folder', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;
  let sources: string;
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
          QUEUE_PLAN_SOURCE_ROOT: sources,
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
  const readReg = (): Reg => JSON.parse(readFileSync(join(folder, 'plans.json'), 'utf8')) as Reg;
  const file = (name: string, content: unknown) => {
    const filePath = join(folder, name);
    writeFileSync(filePath, JSON.stringify(content));
    return filePath;
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-plan-doc-'));
    sources = join(folder, 'root');
    mkdirSync(join(sources, 'docs', 'agreements'), { recursive: true });
    writeFileSync(join(sources, 'docs', 'agreements', 'terms.md'), '# Terms\n');
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        changed: '2026-10-14T08:00:00.000Z',
        tasks: [],
        projects: {},
        areas: {},
        question: {},
        resolved: [],
      }),
    );
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('new, show, get, edit, revise and undo; the queue file is not touched', () => {
    const queueFor = readFileSync(join(folder, 'queue.json'), 'utf8');
    const fresh = run([
      'plan',
      'doc',
      'new',
      '--file',
      file('new.json', [
        doc('DOC-TERMS', { status: 'approved', version: '1.3', current_version: '1.2' }),
        doc('DOC-SLA', { source: undefined, status: 'missing' }),
      ]),
    ]);
    expect(fresh.error).toBe('');
    expect(fresh.out).toContain('2 new document(s): DOC-TERMS, DOC-SLA');
    expect(readReg().documents).toHaveLength(2);
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(queueFor);

    const show = run(['plan', 'doc', 'show']);
    expect(show.out).toContain('What must be done:');
    expect(show.out).toContain('Customer agreements (2)');
    expect(show.out).toContain('MISS');

    const get = run(['plan', 'doc', 'get', 'DOC-TERMS']);
    expect(get.out).toContain('Copy: /plans doc DOC-TERMS. Instruction:');
    expect(get.out).toContain('VERSION_SKEW');

    const edit = run([
      'plan',
      'doc',
      'edit',
      'DOC-SLA',
      '--field',
      'status=draft',
      'source=docs/agreements/terms.md',
    ]);
    expect(edit.code).toBe(0);
    expect(readReg().documents[1]).toMatchObject({ status: 'draft' });

    const rev = run([
      'plan',
      'doc',
      'revise',
      'DOC-TERMS',
      '--version',
      '1.4',
      '--date',
      '2026-10-01',
    ]);
    expect(rev.code).toBe(0);
    expect(readReg().documents[0]).toMatchObject({ last_revised: '2026-10-01', version: '1.4' });

    // A plan entry command afterwards does not see documents as new (the snapshot includes documents).
    const undo = run(['plan', 'undo', '--json']);
    expect(undo.code).toBe(0);
    expect(readReg().documents[0]).toMatchObject({ version: '1.3' });
    expect(
      readReg()
        .changelog.at(-1)
        ?.changes.every((e) => e.collection === 'documents'),
    ).toBe(true);
  });

  it('an error gives exit 1 and writes nothing; --dry and --expect-changed work', () => {
    const r = run([
      'plan',
      'doc',
      'new',
      '--file',
      file('error.json', doc('DOC-X', { group: 'junk' })),
    ]);
    expect(r.code).toBe(1);
    expect(r.error).toContain('group must be');
    const dry = run([
      'plan',
      'doc',
      'new',
      '--file',
      file('ok.json', doc('DOC-X')),
      '--dry',
      '--json',
    ]);
    expect(JSON.parse(dry.out)).toMatchObject({ ok: true, dry: true });
    run(['plan', 'doc', 'new', '--file', file('ok.json', doc('DOC-X'))]);
    const outdated = run([
      'plan',
      'doc',
      'edit',
      'DOC-X',
      '--field',
      'status=to-lawyer',
      '--expect-changed',
      '2020-01-01T00:00:00.000Z',
    ]);
    expect(outdated.code).toBe(6);
    expect(readReg().documents[0].status).toBe('draft');
  });
});
