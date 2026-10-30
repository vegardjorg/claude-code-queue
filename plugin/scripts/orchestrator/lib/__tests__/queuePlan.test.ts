// =============================================================
// queuePlan.test.ts: the plan register (lib/queuePlan.js): validation (project exists, sources exist, drop requires a reason),
// the limits for the agent on priority, the priority rules as data, derived maturity, filtering and fetching, merging,
// changelog and undo, the document checks, plus `queue.mjs plan …` against a copy in a temporary folder (never the real
// queue or the real register). See docs/plan-register.md.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The test modules are in a temporary queue.config.json (QUEUE_CONFIG). It is set before queuePlan reads the configuration,
// and is inherited by queue.mjs in the child processes, so both see the same modules.
const CONFIG_FOLDER = mkdtempSync(join(tmpdir(), 'queue-plan-config-'));
process.env.QUEUE_CONFIG = join(CONFIG_FOLDER, 'queue.config.json');
writeFileSync(
  process.env.QUEUE_CONFIG,
  JSON.stringify({
    modules: [
      { oid: 'alpha', title: 'Alpha', description: 'Test module' },
      { oid: 'beta', title: 'Beta', description: 'Test module' },
      { oid: 'gamma', title: 'Gamma', description: 'Test module' },
      { oid: 'example', title: 'Example', description: 'Test module' },
      { oid: 'without-module', title: 'No fixed module', description: 'Projects without a module' },
    ],
    projectModuleSuggestion: { notes: 'without-module', setup: 'example' },
  }),
);

type Post = Record<string, unknown> & {
  id: string;
  priority?: string;
  priority_set_by?: string;
};
type Reg = {
  version: number;
  changed?: string;
  entries: Post[];
  archive: Record<string, Post & { merged_to?: string }>;
  changelog: { nr: number; action: string; undone?: unknown; changes: unknown[] }[];
};
type Answer = {
  error: string[];
  warnings: string[];
  entry?: Post;
  changed?: string[];
  boost?: boolean | string[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan') as {
  PRIORITY_RULES: { nr: number; priority: string; categories: string[]; measurement?: object }[];
  PRIORITIES: string[];
  emptyRegister: (now?: string) => Reg;
  normalize: (r: unknown) => Reg;
  validateEntry: (p: unknown, ctx?: object) => { error: string[]; warnings: string[] };
  sourcePathError: (s: unknown) => string | null;
  ruleNrFromReason: (g: unknown) => number | null;
  measuredRule: (
    p: Post,
    entries: Post[],
    o?: { now?: Date },
  ) => { nr: number; priority: string } | null;
  newEntry: (reg: Reg, input: unknown, ctx?: object) => Answer;
  editEntry: (reg: Reg, id: string, field: object, ctx?: object) => Answer;
  prioritize: (
    reg: Reg,
    ids: string[],
    option: { priority: string; category?: string[]; reason?: string | null },
    ctx?: object,
  ) => Answer & { changed: string[]; unchanged: string[]; boost: string[] };
  prioritizeMany: (
    reg: Reg,
    list: unknown,
    ctx?: object,
  ) => Answer & { changed: string[]; unchanged: string[]; boost: string[] };
  verify: (reg: Reg, id: string, o: object) => Answer;
  combineTogether: (reg: Reg, to: string, from: string[]) => Answer & { archived?: string[] };
  derivedMaturity: (
    p: Post,
    tasks: object[],
    o?: { now?: Date },
  ) => {
    maturity: string;
    fraction: string | null;
    finished: number;
    total: number;
    stale: boolean;
  };
  sortEntries: (p: Post[]) => Post[];
  filterEntries: (reg: Reg, queue: object, f?: object) => (Post & { module: string | null })[];
  get: (
    reg: Reg,
    queue: object,
    n: string,
    ctx?: object,
  ) => {
    error: string[];
    type?: string;
    entries?: (Post & { queue: { id: string }[] })[];
    copy?: string;
  };
  planDiff: (a: object, b: object) => { collection: string; id: string; field: string }[];
  logChange: (reg: Reg, o: object) => { nr: number } | null;
  undo: (reg: Reg, o?: object) => { error: string[]; entry?: { nr: number } };
  expectCheck: (reg: object, f: unknown) => string | null;
  parseFieldArg: (l: string[]) => { field: Record<string, unknown>; error: string[] };
};

const PROJECTS = {
  export: { title: 'Export', area: 'alpha' },
  import: { title: 'Import', area: 'gamma' },
  solved: { title: 'No module' },
};
const AREAS = { alpha: { title: 'Alpha' }, gamma: { title: 'Gamma' } };
const EXISTS = new Set(['docs/export-plan.md', 'docs/gamma.md', 'docs/notes/investigation.md']);
const ctx = (role = 'agent') => ({
  role,
  projects: PROJECTS,
  question: { 'SP-EXPORT-1': { text: 'Which vendor?' } },
  existsPath: (s: string) => EXISTS.has(s),
  now: '2026-10-14T10:00:00.000Z',
});
const entry = (id: string, extra: object = {}): Post => ({
  id,
  title: `Title ${id}`,
  project: 'export',
  priority: 'later',
  priority_reason: 'Rule 8: extension without a deadline.',
  maturity: 'investigated',
  ...extra,
});
const register = (...entries: Post[]): Reg => {
  const reg = P.emptyRegister('2026-10-14T09:00:00.000Z');
  for (const p of entries) {
    const r = P.newEntry(reg, p, ctx(p.priority_set_by === 'owner' ? 'owner' : 'agent'));
    if (r.error.length) throw new Error(r.error.join('; '));
  }
  return reg;
};

describe('queuePlan: validation', () => {
  it('accepts a valid entry and sets priority_set_by and created', () => {
    const reg = P.emptyRegister();
    const r = P.newEntry(
      reg,
      entry('PL-EXPORT-1', {
        sources: [{ path: 'docs/export-plan.md', anchor: '§ 3', role: 'plan' }],
      }),
      ctx(),
    );
    expect(r.error).toEqual([]);
    expect(r.entry?.priority_set_by).toBe('agent');
    expect(r.entry?.created).toBe('2026-10-14T10:00:00.000Z');
    expect(reg.entries).toHaveLength(1);
  });

  it('refuses an unknown project, unknown source and unknown field, and does not mutate the register', () => {
    const reg = P.emptyRegister();
    const r = P.newEntry(
      reg,
      entry('PL-X-1', {
        project: 'exists-not',
        sources: [{ path: 'docs/gone.md' }],
        tittle: 'writeError',
      }),
      ctx(),
    );
    const f = r.error.join('\n');
    expect(f).toContain('unknown project exists-not');
    expect(f).toContain('source docs/gone.md does not exist');
    expect(f).toContain('unknown field tittle');
    expect(reg.entries).toHaveLength(0);
  });

  it('drop requires a reason; now_category only with now; derived maturity cannot be set', () => {
    const reg = P.emptyRegister();
    expect(
      P.newEntry(
        reg,
        entry('PL-D-1', { priority: 'drop', priority_reason: 'Rule 7: replaced.' }),
        ctx(),
      ).error.join(),
    ).toContain('drop requires one sentence as the reason');
    expect(
      P.newEntry(reg, entry('PL-D-2', { now_category: ['important'] }), ctx()).error.join(),
    ).toContain('now_category is only used when priority is now');
    expect(P.newEntry(reg, entry('PL-D-3', { maturity: 'built' }), ctx()).error.join()).toContain(
      'is derived from the queue',
    );
    expect(
      P.newEntry(
        reg,
        entry('PL-D-4', {
          priority: 'drop',
          priority_reason: 'Rule 7: replaced.',
          drop_reason: 'Replaced by PL-X.',
        }),
        ctx(),
      ).error,
    ).toEqual([]);
  });

  it('the agent must give priority_reason, and the reason must match the rule it refers to', () => {
    const reg = P.emptyRegister();
    expect(
      P.newEntry(reg, entry('PL-G-1', { priority_reason: undefined }), ctx()).error.join(),
    ).toContain('an agent must give priority_reason');
    expect(
      P.newEntry(
        reg,
        entry('PL-G-2', { priority: 'later', priority_reason: 'Rule 1: access hole.' }),
        ctx(),
      ).error.join(),
    ).toContain('rule 1 (Security), which gives now, not later');
    // The owner needs no reason.
    expect(P.newEntry(reg, entry('PL-G-3', { priority_reason: undefined }), ctx('owner')).error).toEqual(
      [],
    );
    // A wrong category is a warning.
    const r = P.newEntry(
      reg,
      entry('PL-G-4', {
        priority: 'now',
        now_category: ['important'],
        priority_reason: 'Rule 3: Terms before the first customer.',
      }),
      ctx(),
    );
    expect(r.error).toEqual([]);
    expect(r.warnings.join()).toContain(
      'rule 3 (Before launch) gives Now with category for-prod',
    );
  });

  it('ids are never reused, not even from the archive', () => {
    const reg = register(entry('PL-A-1'), entry('PL-A-2'));
    P.combineTogether(reg, 'PL-A-1', ['PL-A-2']);
    expect(P.newEntry(reg, entry('PL-A-2'), ctx()).error.join()).toContain('the id is already used');
    expect(P.newEntry(reg, entry('error-id'), ctx()).error.join()).toContain(
      'id must look like PL-NAME-1',
    );
  });

  it('source paths: relative, with slash, without .. and without an absolute path', () => {
    expect(P.sourcePathError('docs/a.md')).toBeNull();
    expect(P.sourcePathError('../secret.md')).toContain('. and .. are not allowed');
    expect(P.sourcePathError('docs/../../x')).toContain('. and .. are not allowed');
    expect(P.sourcePathError('C:/x.md')).toContain('relative');
    expect(P.sourcePathError('/etc/passwd')).toContain('relative');
    expect(P.sourcePathError('docs\\a.md')).toContain('slash');
  });

  it('depends_on must point to a known entry; ownerQuestions that do not exist in the queue give a warning', () => {
    const reg = register(entry('PL-B-1'));
    expect(
      P.newEntry(reg, entry('PL-B-2', { depends_on: ['PL-UNKNOWN-1'] }), ctx()).error.join(),
    ).toContain('depends_on on unknown planEntry PL-UNKNOWN-1');
    const r = P.newEntry(
      reg,
      entry('PL-B-3', { depends_on: ['PL-B-1'], ownerQuestions: ['SP-UNKNOWN-9'] }),
      ctx(),
    );
    expect(r.error).toEqual([]);
    expect(r.warnings.join()).toContain('SP-UNKNOWN-9 is not in the queue');
  });
});

describe('queuePlan: priority and the limits for the agent', () => {
  it('the rules are data: eight rules, rule 1 always gives now/security', () => {
    expect(P.PRIORITY_RULES.map((r) => r.nr)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(P.PRIORITY_RULES[0]).toMatchObject({ priority: 'now', categories: ['security'] });
    expect(P.PRIORITY_RULES[7].priority).toBe('later');
    expect(P.ruleNrFromReason('Rule 3: Terms.')).toBe(3);
    expect(P.ruleNrFromReason('no rule mentioned')).toBeNull();
  });

  it('an agent does not change a priority the owner has set', () => {
    const reg = register(
      entry('PL-E-1', { priority_set_by: 'owner', priority: 'later', priority_reason: 'Owner.' }),
    );
    const r = P.editEntry(
      reg,
      'PL-E-1',
      { priority: 'drop', drop_reason: 'Low value.', priority_reason: 'Rule 7.' },
      ctx(),
    );
    expect(r.error.join()).toContain('is set by the owner, and an agent does not change it');
    expect(reg.entries[0].priority).toBe('later');
    // Nor the reason for the owner's priority.
    expect(
      P.editEntry(reg, 'PL-E-1', { priority_reason: 'Other reason.' }, ctx()).error.join(),
    ).toContain("priority_reason belongs to the owner's priority");
    // Other fields are fine.
    expect(P.editEntry(reg, 'PL-E-1', { remark: 'note' }, ctx()).error).toEqual([]);
  });

  it('the exception: a security finding raises an owner-set entry to now/security and marks agent_boost', () => {
    const reg = register(
      entry('PL-E-2', { priority_set_by: 'owner', priority: 'later', priority_reason: 'Owner.' }),
    );
    const r = P.editEntry(
      reg,
      'PL-E-2',
      {
        priority: 'now',
        now_category: ['security'],
        priority_reason: 'Rule 1: access hole found.',
      },
      { ...ctx(), by: 'TRACK-1' },
    );
    expect(r.error).toEqual([]);
    expect(r.boost).toBe(true);
    expect(reg.entries[0]).toMatchObject({
      priority: 'now',
      priority_set_by: 'agent',
      agent_boost: { by: 'TRACK-1', from: { priority: 'later', now_category: null } },
    });
    // The owner sets the priority again: the boost has been seen and disappears.
    expect(P.editEntry(reg, 'PL-E-2', { priority: 'later' }, ctx('owner')).error).toEqual([]);
    expect(reg.entries[0].agent_boost).toBeUndefined();
    expect(reg.entries[0].priority_set_by).toBe('owner');
  });

  it('an agent cannot create an owner-set priority; a new priority from an agent requires a new reason', () => {
    const reg = P.emptyRegister();
    expect(
      P.newEntry(reg, entry('PL-F-1', { priority_set_by: 'owner' }), ctx()).error.join(),
    ).toContain('an agent cannot set priority_set_by owner');
    const reg2 = register(entry('PL-F-2'));
    expect(P.editEntry(reg2, 'PL-F-2', { priority: 'owner' }, ctx()).error.join()).toContain(
      'new priority requires priority_reason',
    );
  });

  it('prioritize is all or nothing, and category and drop reason follow the priority', () => {
    const reg = register(
      entry('PL-M-1'),
      entry('PL-M-2'),
      entry('PL-M-3', { priority_set_by: 'owner', priority_reason: 'Owner.' }),
    );
    const error = P.prioritize(
      reg,
      ['PL-M-1', 'PL-M-3'],
      { priority: 'owner', reason: 'Rule 6: price.' },
      ctx(),
    );
    expect(error.error.join()).toContain('PL-M-3');
    expect(reg.entries.map((p) => p.priority)).toEqual(['later', 'later', 'later']);

    const ok = P.prioritize(
      reg,
      ['PL-M-1', 'PL-M-2'],
      { priority: 'now', category: ['for-prod'], reason: 'Rule 3: Terms.' },
      ctx(),
    );
    expect(ok.error).toEqual([]);
    expect(ok.changed).toEqual(['PL-M-1', 'PL-M-2']);
    expect(reg.entries[0]).toMatchObject({ priority: 'now', now_category: ['for-prod'] });

    expect(
      P.prioritize(reg, ['PL-M-1'], { priority: 'drop', reason: null }, ctx()).error.join(),
    ).toContain('drop requires one sentence as the reason');
    const d = P.prioritize(
      reg,
      ['PL-M-1'],
      { priority: 'drop', reason: 'Rule 7: covered by PL-M-2.' },
      ctx(),
    );
    expect(d.error).toEqual([]);
    expect(reg.entries[0]).toMatchObject({
      priority: 'drop',
      drop_reason: 'Rule 7: covered by PL-M-2.',
    });
    expect(reg.entries[0].now_category).toBeUndefined();
    // Back from drop: the drop reason disappears.
    P.prioritize(reg, ['PL-M-1'], { priority: 'later', reason: 'Rule 8: undone drop.' }, ctx());
    expect(reg.entries[0].drop_reason).toBeUndefined();
  });

  it('measured rule: deadline within 60 days (rule 2) and blocking two entries (rule 4)', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    const a = entry('PL-R-1', { deadline: '2026-11-20' });
    expect(P.measuredRule(a, [a], { now })).toMatchObject({ nr: 2, priority: 'now' });
    const b = entry('PL-R-2', { deadline: '2027-06-01' });
    const c = entry('PL-R-3', { depends_on: ['PL-R-2'] });
    const d = entry('PL-R-4', { depends_on: ['PL-R-2'] });
    expect(P.measuredRule(b, [b, c, d], { now })).toMatchObject({ nr: 4 });
    expect(P.measuredRule(b, [b, c], { now })).toBeNull();
  });
});

describe('queuePlan: derived maturity', () => {
  const p = entry('PL-K-1', { maturity: 'ready' });
  const o = (id: string, status: string, plan = 'PL-K-1', done?: string) => ({
    id,
    status,
    plan,
    done,
  });
  const now = new Date('2026-10-14T10:00:00Z');

  it('no tasks: the maturity from the plan work', () => {
    expect(P.derivedMaturity(p, [o('X-1', 'waiting', 'PL-OTHER-1')], { now }).maturity).toBe('ready');
  });
  it('open tasks: in-queue; some finished: partial with a fraction; all finished: built', () => {
    expect(P.derivedMaturity(p, [o('A', 'waiting'), o('B', 'running')], { now }).maturity).toBe(
      'in-queue',
    );
    const d = P.derivedMaturity(p, [o('A', 'done'), o('B', 'waiting'), o('C', 'waiting')], { now });
    expect(d).toMatchObject({ maturity: 'partial', fraction: '1/3' });
    expect(P.derivedMaturity(p, [o('A', 'done'), o('B', 'cancelled')], { now }).maturity).toBe(
      'built',
    );
  });
  it('verified when the verification is after the last finished task and not stale', () => {
    const v = { ...p, verified: { date: '2026-10-10', by: 'agent', findings: 'ok' } };
    expect(
      P.derivedMaturity(v, [o('A', 'done', 'PL-K-1', '2026-10-09T12:00:00Z')], { now }).maturity,
    ).toBe('verified');
    expect(
      P.derivedMaturity(v, [o('A', 'done', 'PL-K-1', '2026-10-12T12:00:00Z')], { now }).maturity,
    ).toBe('built');
    const old = { ...p, verified: { date: '2026-08-01', by: 'agent', findings: 'ok' } };
    const r = P.derivedMaturity(old, [o('A', 'done', 'PL-K-1', '2026-07-01T12:00:00Z')], {
      now,
    });
    expect(r).toMatchObject({ maturity: 'built', stale: true });
  });
  it('tasks linked to a merged entry count in the target', () => {
    const m = { ...p, merged_from: ['PL-K-2'] };
    expect(P.derivedMaturity(m, [o('A', 'done'), o('B', 'waiting', 'PL-K-2')], { now }).fraction).toBe(
      '1/2',
    );
  });
});

describe('queuePlan: sorting, filtering, fetching and merging', () => {
  it('sorts by priority, deadline, blocking and size', () => {
    const entries = [
      entry('PL-S-1', { priority: 'later', size: 'S' }),
      entry('PL-S-2', { priority: 'now', size: 'L' }),
      entry('PL-S-3', { priority: 'now', size: 'S' }),
      entry('PL-S-4', { priority: 'now', deadline: '2026-12-01', size: 'XL' }),
      entry('PL-S-5', { priority: 'owner' }),
    ];
    expect(P.sortEntries(entries).map((p) => p.id)).toEqual([
      'PL-S-4',
      'PL-S-3',
      'PL-S-2',
      'PL-S-5',
      'PL-S-1',
    ]);
  });

  it('filter: drop is hidden by default; module via the project; search', () => {
    const reg = register(
      entry('PL-V-1'),
      entry('PL-V-2', { project: 'import', title: 'Import with QR' }),
      entry('PL-V-3', {
        priority: 'drop',
        priority_reason: 'Rule 7.',
        drop_reason: 'Replaced.',
      }),
    );
    const queue = { projects: PROJECTS, areas: AREAS, tasks: [] };
    expect(P.filterEntries(reg, queue).map((p) => p.id)).toEqual(['PL-V-1', 'PL-V-2']);
    expect(P.filterEntries(reg, queue, { all: true })).toHaveLength(3);
    expect(P.filterEntries(reg, queue, { priority: ['drop'] }).map((p) => p.id)).toEqual(['PL-V-3']);
    expect(P.filterEntries(reg, queue, { module: 'gamma' }).map((p) => p.id)).toEqual(['PL-V-2']);
    expect(P.filterEntries(reg, queue, { search: 'qr' }).map((p) => p.id)).toEqual(['PL-V-2']);
  });

  it('get: entry, project or module, with queue status, owner question and a copy line without content', () => {
    const reg = register(
      entry('PL-H-1', {
        ownerQuestions: ['SP-EXPORT-1'],
        sources: [{ path: 'docs/notes/investigation.md', role: 'investigation' }],
        summary: 'SECRET',
      }),
      entry('PL-H-2', { project: 'import' }),
    );
    const queue = {
      projects: PROJECTS,
      areas: AREAS,
      tasks: [{ id: 'EXPORT-1a', title: 'First', status: 'done', plan: 'PL-H-1' }],
      question: { 'SP-EXPORT-1': { text: 'Which vendor?' } },
      resolved: ['SP-EXPORT-1'],
    };
    const r = P.get(reg, queue, 'PL-H-1', { existsPath: (s: string) => EXISTS.has(s) });
    expect(r.type).toBe('entry');
    expect(r.entries?.[0].queue).toEqual([{ id: 'EXPORT-1a', title: 'First', status: 'done' }]);
    expect(r.entries?.[0]).toMatchObject({
      ownerQuestion: [{ id: 'SP-EXPORT-1', resolved: true }],
      sources: [{ path: 'docs/notes/investigation.md', exists: true }],
    });
    expect(r.copy).toContain('PL-H-1');
    expect(r.copy).not.toContain('SECRET');
    expect(P.get(reg, queue, 'import').entries?.map((p) => p.id)).toEqual(['PL-H-2']);
    expect(P.get(reg, queue, 'alpha').type).toBe('module');
    expect(P.get(reg, queue, 'unknown').error.join()).toContain('found no');
  });

  it('combine: the target gets sources and anchors, the others go to the archive, dependencies are redirected', () => {
    const reg = register(
      entry('PL-J-1', { roadmap: ['9.1'], sources: [{ path: 'docs/gamma.md' }] }),
      entry('PL-J-2', {
        roadmap: ['9.2'],
        sources: [{ path: 'docs/gamma.md' }, { path: 'docs/export-plan.md' }],
      }),
      entry('PL-J-3', { depends_on: ['PL-J-2'] }),
    );
    const r = P.combineTogether(reg, 'PL-J-1', ['PL-J-2']);
    expect(r.error).toEqual([]);
    expect(reg.entries.map((p) => p.id)).toEqual(['PL-J-1', 'PL-J-3']);
    expect(reg.entries[0]).toMatchObject({
      roadmap: ['9.1', '9.2'],
      merged_from: ['PL-J-2'],
      sources: [{ path: 'docs/gamma.md' }, { path: 'docs/export-plan.md' }],
    });
    expect(reg.entries[1].depends_on).toEqual(['PL-J-1']);
    expect(reg.archive['PL-J-2'].merged_to).toBe('PL-J-1');
    expect(P.editEntry(reg, 'PL-J-2', { remark: 'x' }, ctx()).error.join()).toContain(
      'is merged into PL-J-1',
    );
  });
});

describe('queuePlan: changelog, undo and concurrency', () => {
  it('undo rolls back a change, a new entry and a merge', () => {
    const reg = register(entry('PL-U-1'), entry('PL-U-2'));
    const log = (action: string, fn: () => void) => {
      const for_ = JSON.parse(JSON.stringify({ entries: reg.entries, archive: reg.archive }));
      fn();
      P.logChange(reg, { by: 'test', action, changes: P.planDiff(for_, reg) });
    };
    log('edit', () => P.editEntry(reg, 'PL-U-1', { remark: 'new' }, ctx()));
    log('new', () => P.newEntry(reg, entry('PL-U-3'), ctx()));
    log('combine', () => P.combineTogether(reg, 'PL-U-1', ['PL-U-2']));
    expect(reg.changelog.map((p) => p.action)).toEqual(['edit', 'new', 'combine']);

    expect(P.undo(reg, { by: 'test' }).error).toEqual([]);
    expect(reg.entries.map((p) => p.id).sort()).toEqual(['PL-U-1', 'PL-U-2', 'PL-U-3']);
    expect(reg.archive).toEqual({});
    expect(reg.entries.find((p) => p.id === 'PL-U-1')?.merged_from).toBeUndefined();
    expect(P.undo(reg).error).toEqual([]);
    expect(reg.entries.map((p) => p.id).sort()).toEqual(['PL-U-1', 'PL-U-2']);
    expect(P.undo(reg).error).toEqual([]);
    expect(reg.entries[0].remark).toBeUndefined();
    expect(P.undo(reg).error.join()).toContain('nothing to undo');
  });

  it('undo refuses when the field has changed since', () => {
    const reg = register(entry('PL-W-1'));
    const for_ = JSON.parse(JSON.stringify({ entries: reg.entries, archive: reg.archive }));
    P.editEntry(reg, 'PL-W-1', { remark: 'a' }, ctx());
    P.logChange(reg, { action: 'edit', changes: P.planDiff(for_, reg) });
    reg.entries[0].remark = 'changed outside the log';
    expect(P.undo(reg).error.join()).toContain('PL-W-1 remark has changed since');
    expect(reg.entries[0].remark).toBe('changed outside the log');
  });

  it('expectCheck and --field parsing', () => {
    expect(P.expectCheck({ changed: '2026-10-14T10:00:00Z' }, '2026-10-14T09:00:00Z')).toContain(
      'was changed',
    );
    expect(P.expectCheck({ changed: '2026-10-14T10:00:00Z' }, '2026-10-14T11:00:00Z')).toBeNull();
    expect(P.expectCheck({}, 'junk')).toContain('invalid');
    expect(P.parseFieldArg(['size=M', 'roadmap=["9.1"]', 'remark=', 'deadline=null'])).toEqual({
      field: { size: 'M', roadmap: ['9.1'], remark: null, deadline: null },
      error: [],
    });
    expect(P.parseFieldArg(['without']).error.join()).toContain('name=val');
  });
});

describe('queue.mjs plan …: against a copy in a temporary folder', () => {
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
  const QUEUE = {
    changed: '2026-10-14T08:00:00.000Z',
    tasks: [
      {
        id: 'EXPORT-1a',
        title: 'First',
        domain: 'alpha',
        class: 'K',
        status: 'waiting',
        plan: 'PL-EXPORT-1',
      },
    ],
    projects: PROJECTS,
    areas: AREAS,
    question: {},
    resolved: [],
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-plan-'));
    sources = join(folder, 'root');
    mkdirSync(join(sources, 'docs'), { recursive: true });
    writeFileSync(join(sources, 'docs', 'export-plan.md'), '# plan\n');
    writeFileSync(join(folder, 'queue.json'), JSON.stringify(QUEUE, null, 2));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('new, show, get and edit; the queue file is not touched', () => {
    const queueFor = readFileSync(join(folder, 'queue.json'), 'utf8');
    const fresh = run([
      'plan',
      'new',
      '--file',
      file('new.json', [
        entry('PL-EXPORT-1', { sources: [{ path: 'docs/export-plan.md' }] }),
        entry('PL-EXPORT-2'),
      ]),
    ]);
    expect(fresh.error).toBe('');
    expect(fresh.out).toContain('2 new plan entr(ies): PL-EXPORT-1, PL-EXPORT-2');
    expect(fresh.out).toContain('Changelog no. 1');
    expect(readReg().entries).toHaveLength(2);
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(queueFor);

    const show = run(['plan', 'show', '--json']);
    const v = JSON.parse(show.out) as { entries: (Post & { derived: { maturity: string } })[] };
    expect(v.entries.find((p) => p.id === 'PL-EXPORT-1')?.derived.maturity).toBe('in-queue');

    const get = run(['plan', 'get', 'PL-EXPORT-1']);
    expect(get.out).toContain('queue: EXPORT-1a waiting');
    expect(get.out).toContain('Copy: /plans PL-EXPORT-1');

    const edit = run(['plan', 'edit', 'PL-EXPORT-2', '--field', 'size=M', 'remark=note']);
    expect(edit.code).toBe(0);
    expect(readReg().entries[1]).toMatchObject({ size: 'M', remark: 'note' });
  });

  it('validation gives exit 1 and writes nothing; --dry writes nothing', () => {
    const r = run([
      'plan',
      'new',
      '--file',
      file('error.json', entry('PL-X-1', { project: 'gone' })),
      '--json',
    ]);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as { error: string[] }).error.join()).toContain('unknown project gone');
    expect(existsSync(join(folder, 'plans.json'))).toBe(false);

    const t = run(['plan', 'new', '--file', file('ok.json', entry('PL-X-2')), '--dry']);
    expect(t.out).toContain('Preview (nothing written)');
    expect(existsSync(join(folder, 'plans.json'))).toBe(false);
  });

  it('prioritize with the owner limit, --expect-changed and undo', () => {
    run(['plan', 'new', '--file', file('a.json', entry('PL-P-1')), '--set-by', 'owner']);
    const deny = run(['plan', 'prioritize', 'PL-P-1', 'drop', '--reason', 'Rule 7: low value.']);
    expect(deny.code).toBe(1);
    expect(deny.error).toContain('set by the owner');

    const version = readReg().changed as string;
    const ok = run([
      'plan',
      'prioritize',
      'PL-P-1',
      'now',
      '--category',
      'security',
      '--reason',
      'Rule 1: access hole.',
      '--expect-changed',
      version,
      '--json',
    ]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true, boost: ['PL-P-1'] });
    expect(readReg().entries[0]).toMatchObject({ priority: 'now', now_category: ['security'] });

    // The preview was built on an older version: exit 6.
    const old = run([
      'plan',
      'edit',
      'PL-P-1',
      '--field',
      'remark=x',
      '--expect-changed',
      '2026-01-01T00:00:00Z',
    ]);
    expect(old.code).toBe(6);

    expect(run(['plan', 'undo']).out).toContain('Undone no. 2 plan prioritize');
    expect(readReg().entries[0].priority).toBe('later');
    expect(readReg().entries[0].agent_boost).toBeUndefined();
  });

  it('prioritize-many: all the moves in one write, one changelog entry and one undo', () => {
    run([
      'plan',
      'new',
      '--file',
      file('a.json', [entry('PL-PM-1'), entry('PL-PM-2'), entry('PL-PM-3')]),
    ]);
    const list = [
      {
        id: 'PL-PM-1',
        priority: 'now',
        category: ['important'],
        reason: 'Rule 5: error for users.',
      },
      { id: 'PL-PM-2', priority: 'drop', reason: 'Rule 7: covered by another.' },
      { id: 'PL-PM-3', priority: 'later' },
    ];
    // The preview writes nothing.
    const version = readReg().changed as string;
    const dry = run([
      'plan',
      'prioritize-many',
      '--file',
      file('m.json', list),
      '--dry',
      '--json',
    ]);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({ ok: true, dry: true, log: null });
    expect(readReg().changed).toBe(version);

    // One invalid element: nothing written (all or nothing).
    const half = run([
      'plan',
      'prioritize-many',
      '--file',
      file('h.json', [...list.slice(0, 1), { id: 'PL-PM-2', priority: 'drop' }]),
      '--json',
    ]);
    expect(half.code).toBe(1);
    expect(readReg().entries.map((p) => p.priority)).toEqual(['later', 'later', 'later']);

    // Outdated preview: exit 6.
    const old = run([
      'plan',
      'prioritize-many',
      '--file',
      file('m.json', list),
      '--expect-changed',
      '2026-01-01T00:00:00Z',
    ]);
    expect(old.code).toBe(6);

    const ok = run([
      'plan',
      'prioritize-many',
      '--file',
      file('m.json', list),
      '--expect-changed',
      version,
      '--set-by',
      'owner',
      '--json',
    ]);
    expect(ok.code).toBe(0);
    const answer = JSON.parse(ok.out) as { log: number };
    const reg = readReg();
    expect(reg.entries.map((p) => p.priority)).toEqual(['now', 'drop', 'later']);
    // PL-PM-3 was already later: unchanged, so it keeps who set it.
    expect(reg.entries.map((p) => p.priority_set_by)).toEqual(['owner', 'owner', 'agent']);
    expect(reg.entries[1].drop_reason).toBe('Rule 7: covered by another.');
    const log = (reg as unknown as { changelog: { nr: number; action: string }[] })
      .changelog;
    expect(log.filter((l) => l.action === 'plan prioritize-many')).toHaveLength(1);
    expect(log[log.length - 1].nr).toBe(answer.log);

    // One undo rolls the whole save back.
    expect(run(['plan', 'undo']).out).toContain('plan prioritize-many');
    expect(readReg().entries.map((p) => p.priority)).toEqual(['later', 'later', 'later']);
  });

  it('combine and verify', () => {
    run(['plan', 'new', '--file', file('a.json', [entry('PL-Q-1'), entry('PL-Q-2')])]);
    expect(run(['plan', 'combine', 'PL-Q-1', 'PL-Q-2']).code).toBe(0);
    expect(Object.keys(readReg().archive)).toEqual(['PL-Q-2']);
    const v = run([
      'plan',
      'verify',
      'PL-Q-1',
      '--findings',
      'Checked against the code.',
      '--commit',
      'abc1234',
    ]);
    expect(v.code).toBe(0);
    expect(readReg().entries[0].verified).toMatchObject({
      by: 'agent',
      findings: 'Checked against the code.',
      commit: 'abc1234',
    });
    expect(run(['plan', 'rules']).out).toContain('1. Security');
  });
});

// =============================================================
// Link to the queue (add --plan), phase plan, modules, plan check and plan backup.
// =============================================================

type Findings = { id?: string; task?: string; project?: string; reason: string; ids?: string[] };
type CheckAnswer = {
  unregistered: string[];
  dead_paths: { id: string; path: string }[];
  stale: Findings[];
  not_verified: string[];
  statusDeviation: Findings[];
  ruleDeviation: Findings[];
  gaps: Findings[];
  duplicates: Findings[];
  capacity: {
    entries: number;
    track: number;
    without_size: string[];
    weeks: number | null;
    text: string;
  };
  references: { id: string; path: string; role: string }[];
  count: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P2 = require('../queuePlan') as {
  MODULES: { oid: string; title: string }[];
  PROJECT_MODULE_SUGGESTION: Record<string, string>;
  modulePlan: (
    queue: object,
    o?: { link?: boolean },
  ) => {
    newOnes: { oid: string }[];
    exists: { oid: string; title: string | null }[];
    link: { pid: string; oid: string }[];
  };
  phasePlanEnds: (projects: object, newOnes: object[]) => string[];
  planLinkError: (reg: Reg, id: unknown) => string | null;
  linkPlan: (
    reg: Reg,
    newOnes: object[],
    planId?: string | null,
  ) => { error: string[]; warnings: string[]; tasks: Record<string, unknown>[] };
  docStatus: (text: unknown, anchor?: string | null) => string | null;
  duplicates: (entries: Post[]) => Findings[];
  capacity: (reg: Reg, queue: object, o?: object) => CheckAnswer['capacity'];
  check: (reg: Reg, queue: object, ctx?: object) => CheckAnswer;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  validate: (o: object, ex?: object[], reg?: object) => string[];
  newRegister: (
    r: object,
    e: object,
    o?: object,
  ) => { error: string[]; register: Record<string, object> };
};

describe('queuePlan: link queueTask → planEntry', () => {
  it('planLinkError: unknown, merged and invalid ids are refused; a known entry is accepted', () => {
    const reg = register(entry('PL-K-1'), entry('PL-K-2'));
    P.combineTogether(reg, 'PL-K-1', ['PL-K-2']);
    expect(P2.planLinkError(reg, 'PL-K-1')).toBeNull();
    expect(P2.planLinkError(reg, 'PL-K-2')).toContain('is merged into PL-K-1');
    expect(P2.planLinkError(reg, 'PL-GONE-1')).toContain('unknown planEntry PL-GONE-1');
    expect(P2.planLinkError(reg, 'not-an-id')).toContain('must be a plan entry id');
  });

  it('linkPlan sets plan and project, warns about not ready, another project and drop, and does not mutate the input', () => {
    const reg = register(
      entry('PL-K-1', { maturity: 'ready' }),
      entry('PL-K-2'),
      entry('PL-K-3', {
        priority: 'drop',
        drop_reason: 'Covered.',
        priority_reason: 'Rule 7: covered.',
      }),
    );
    const input = [{ id: 'A' }, { id: 'B', project: 'import' }, { id: 'C', plan: 'PL-K-2' }];
    const r = P2.linkPlan(reg, input, 'PL-K-1');
    expect(r.error).toEqual([]);
    expect(r.tasks[0]).toMatchObject({ plan: 'PL-K-1', project: 'export' });
    expect(r.tasks[1]).toMatchObject({ plan: 'PL-K-1', project: 'import' });
    expect(r.tasks[2]).toMatchObject({ plan: 'PL-K-2', project: 'export' });
    expect(input[0]).toEqual({ id: 'A' });
    expect(r.warnings.join('\n')).toContain('B: project import, but planEntry PL-K-1');
    expect(r.warnings.join('\n')).toContain('PL-K-2 is investigated, not ready');
    expect(P2.linkPlan(reg, [{ id: 'D' }], 'PL-K-3').warnings.join()).toContain('is dropped');
    const deny = P2.linkPlan(reg, [{ id: 'E' }, { id: 'F', plan: 'PL-NO-1' }], 'PL-K-1');
    expect(deny.error).toEqual([expect.stringContaining('F: unknown planEntry PL-NO-1')]);
  });

  it('the plan field in the queue: the format is checked in queueLogic, and phase must be plan', () => {
    const o = { id: 'X', title: 't', domain: 'd', class: 'K', mission: 'o' };
    expect(L.validate({ ...o, plan: 'PL-A-1' })).toEqual([]);
    expect(L.validate({ ...o, plan: 'error' }).join()).toContain('plan must be a plan entry id');
    expect(L.newRegister({}, { p: { title: 'P', phase: 'plan' } }).error).toEqual([]);
    expect(L.newRegister({}, { p: { title: 'P', phase: 'build' } }).error.join()).toContain(
      'phase must be plan',
    );
  });

  it('phasePlanEnds: only projects in phase plan that get tasks', () => {
    const pr = { a: { title: 'A', phase: 'plan' }, b: { title: 'B' } };
    expect(
      P2.phasePlanEnds(pr, [{ project: 'a' }, { project: 'b' }, { project: 'a' }]),
    ).toEqual(['a']);
  });
});

describe('queuePlan: modules from the configuration', () => {
  it('modules from queue.config.json; existing ones are not changed; --link only for projects without a module', () => {
    expect(P2.MODULES.map((m) => m.title)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Example',
      'No fixed module',
    ]);
    expect(P2.PROJECT_MODULE_SUGGESTION.notes).toBe('without-module');
    expect(P2.PROJECT_MODULE_SUGGESTION.setup).toBe('example');
    const queue = {
      areas: { alpha: { title: 'Alpha-area' } },
      projects: {
        setup: { title: 'O' },
        import: { title: 'K', area: 'alpha' },
        unknown: { title: 'U' },
      },
    };
    const r = P2.modulePlan(queue, { link: true });
    expect(r.newOnes).toHaveLength(4);
    expect(r.exists).toEqual([{ oid: 'alpha', title: 'Alpha-area' }]);
    expect(r.link).toEqual([{ pid: 'setup', oid: 'example' }]);
    expect(P2.modulePlan(queue).link).toEqual([]);
  });
});

describe('queuePlan: plan check', () => {
  it('docStatus: the section under the anchor, table rows, check mark, and mixed gives null', () => {
    const doc = [
      '# Plan',
      '## 3. Data model',
      '### 3.4 Maturity',
      'Status: done',
      '## 4. Commands',
      'Status: not started',
      '## 5. List',
      '- [ ] a',
      '- [ ] b',
      '## 6. Done list',
      '- [x] a',
      '## 7. Mixed',
      '- [x] a',
      '- [ ] b',
      '## 8. Batches',
      '| STEP-2 | Not started | K |',
    ].join('\n');
    expect(P2.docStatus(doc, '§ 3.4')).toBe('done');
    expect(P2.docStatus(doc, '§ 4')).toBe('not-started');
    expect(P2.docStatus(doc, '5. List')).toBe('not-started');
    expect(P2.docStatus(doc, '§ 6')).toBe('done');
    expect(P2.docStatus(doc, '§ 7')).toBeNull();
    expect(P2.docStatus(doc, 'STEP-2')).toBe('not-started');
    expect(P2.docStatus(doc, 'exists-not')).toBeNull();
    expect(P2.docStatus('# X\nStatus: delivered\n')).toBe('done');
    expect(P2.docStatus(null)).toBeNull();
  });

  it('duplicates: nearly identical titles and the same source with the same anchor', () => {
    const d = P2.duplicates([
      entry('PL-D-1', { title: 'Export risk assessment checkin notification' }),
      entry('PL-D-2', { title: 'Export: risk assessment, checkin, notification' }),
      entry('PL-D-3', {
        title: 'Something completely different here',
        sources: [{ path: 'docs/a.md', anchor: '§ 2' }],
      }),
      entry('PL-D-4', { title: 'And yet another thing', sources: [{ path: 'docs/a.md', anchor: '§ 2' }] }),
      entry('PL-D-5', { title: 'Third things here', sources: [{ path: 'docs/a.md', anchor: '§ 3' }] }),
    ]);
    expect(d).toEqual([
      { ids: ['PL-D-1', 'PL-D-2'], reason: 'nearly identical titles' },
      { ids: ['PL-D-3', 'PL-D-4'], reason: 'same source docs/a.md § 2' },
    ]);
  });

  it('capacity: the estimates in Now minus finished queue tasks, against finished per week', () => {
    const now = (id: string, extra: object) =>
      entry(id, {
        priority: 'now',
        now_category: ['important'],
        priority_reason: 'Rule 5: error.',
        ...extra,
      });
    const reg = register(
      now('PL-C-1', { size: 'L' }),
      now('PL-C-2', { size: 'M' }),
      now('PL-C-3', {}),
      entry('PL-C-4', { size: 'XL' }),
    );
    const queue = {
      tasks: [
        { id: 'c1', plan: 'PL-C-1', status: 'done' },
        { id: 'c2', plan: 'PL-C-1', status: 'done' },
        { id: 'c3', plan: 'PL-C-1', status: 'waiting' },
      ],
    };
    const k = P2.capacity(reg, queue, { donePerWeek: 3 });
    expect(k).toMatchObject({ entries: 3, track: 7, without_size: ['PL-C-3'], weeks: 2.3 });
    expect(k.text).toContain('Now is about 2,3 weeks at the current pace');
    expect(P2.capacity(reg, queue).text).toContain('the pace is unknown');
  });

  it('check finds unregistered, dead paths, stale, statusDeviation, ruleDeviation and gaps', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    const reg = register(
      entry('PL-S-1', {
        sources: [{ path: 'docs/export-plan.md', anchor: '§ 2' }],
        verified: { date: '2026-08-01', by: 'agent', findings: 'ok' },
      }),
      entry('PL-S-2', {
        sources: [{ path: 'docs/gamma.md' }],
        verified: { date: '2026-10-10', by: 'agent', findings: 'ok', commit: 'abc1234' },
      }),
      entry('PL-S-3', {
        priority: 'owner',
        priority_reason: 'Rule 6: option.',
        ownerQuestions: ['SP-EXPORT-1'],
      }),
      entry('PL-S-4', { project: 'solved', deadline: '2026-11-01', size: 'S' }),
    );
    // A source that was moved after the entry was added.
    reg.entries[3].sources = [{ path: 'docs/moved.md' }];
    const queue = {
      projects: { ...PROJECTS, empty: { title: 'Empty', phase: 'plan' } },
      resolved: ['SP-EXPORT-1'],
      tasks: [
        { id: 's1', plan: 'PL-S-1', status: 'done', done: '2026-07-01T10:00:00Z' },
        {
          id: 's2',
          plan: 'PL-S-2',
          status: 'done',
          done: '2026-10-01T10:00:00Z',
          owned_files: ['lib/a.ts', 'lib/b.ts'],
        },
        { id: 's3', plan: 'PL-GONE-1', status: 'waiting' },
        { id: 's4', project: 'empty', status: 'waiting' },
      ],
    };
    const texts: Record<string, string> = {
      'docs/export-plan.md': '# Plan\n## 2. Part\nStatus: not started\n',
      'docs/gamma.md': '# Gamma\n',
    };
    const call: { files: string[]; from: object }[] = [];
    const r = P2.check(reg, queue, {
      now,
      documents: [
        'docs/export-plan.md',
        'docs/other.md',
        'docs/INDEX.md',
        'docs/notes/x.md',
      ],
      existsPath: (s: string) => s in texts,
      readDoc: (s: string) => texts[s] ?? null,
      changedFiles: (files: string[], from: object) => {
        call.push({ files, from });
        return ['lib/a.ts'];
      },
      donePerWeek: 2,
    });
    expect(r.unregistered).toEqual(['docs/notes/x.md', 'docs/other.md']);
    expect(r.dead_paths).toEqual([{ id: 'PL-S-4', path: 'docs/moved.md' }]);
    expect(r.stale.map((f) => f.id)).toEqual(['PL-S-1', 'PL-S-2']);
    expect(r.stale[0].reason).toContain('over 30 days');
    expect(r.stale[1].reason).toContain('lib/a.ts');
    expect(call).toEqual([
      { files: ['lib/a.ts', 'lib/b.ts'], from: { date: '2026-10-10', commit: 'abc1234' } },
    ]);
    const statusFindings = r.statusDeviation.map((s) => s.reason).join('\n');
    expect(statusFindings).toContain(
      'the queue says built (1/1), but docs/export-plan.md § 2 says not started',
    );
    expect(statusFindings).toContain('s3 points to unknown planEntry PL-GONE-1');
    expect(statusFindings).toContain('the project empty has phase plan, but 1 queue task(s)');
    expect(r.ruleDeviation).toEqual([
      expect.objectContaining({
        id: 'PL-S-4',
        rule: 2,
        reason: expect.stringContaining('is later'),
      }),
    ]);
    const gaps = r.gaps.map((h) => `${h.id}: ${h.reason}`).join('\n');
    expect(gaps).toContain('PL-S-3: all the owner questions are resolved');
    expect(gaps).toContain('PL-S-4: the project solved has no module');
    expect(r.count).toBeGreaterThan(8);
  });
});

describe('queuePlan: prioritizeMany', () => {
  it('validates the whole list, is all or nothing, and follows the access rules of prioritize', () => {
    const reg = register(entry('PL-PM-1'), entry('PL-PM-2'));
    const form = P.prioritizeMany(
      reg,
      [
        { id: 'PL-PM-1', priority: 'unknown' },
        { id: 'PL-PM-1', priority: 'later' },
        { priority: 'later', extra: 1 },
        'text',
      ],
      ctx(),
    );
    expect(form.error.join('\n')).toMatch(/priority must be one of/);
    expect(form.error.join('\n')).toContain('PL-PM-1: appears more than once in the list');
    expect(form.error.join('\n')).toContain('element 3: unknown field extra');
    expect(form.error.join('\n')).toContain('element 4: must be');
    expect(P.prioritizeMany(reg, [], ctx()).error).toHaveLength(1);
    expect(P.prioritizeMany(reg, null, ctx()).error).toHaveLength(1);

    // Category outside now and drop without a reason: nothing is changed.
    const error = P.prioritizeMany(
      reg,
      [
        { id: 'PL-PM-1', priority: 'now', category: ['important'], reason: 'Rule 5: error.' },
        { id: 'PL-PM-2', priority: 'later', category: ['important'] },
      ],
      ctx(),
    );
    expect(error.error).toEqual(['PL-PM-2: category is only used with now']);
    expect(reg.entries.map((p) => p.priority)).toEqual(['later', 'later']);
    expect(
      P.prioritizeMany(reg, [{ id: 'PL-PM-2', priority: 'drop' }], ctx()).error.join(),
    ).toContain('drop requires');
    expect(
      P.prioritizeMany(reg, [{ id: 'PL-GONE-1', priority: 'later' }], ctx()).error,
    ).not.toEqual([]);

    const ok = P.prioritizeMany(
      reg,
      [
        { id: 'PL-PM-1', priority: 'now', category: ['important'], reason: 'Rule 5: error.' },
        { id: 'PL-PM-2', priority: 'later' },
      ],
      ctx('owner'),
    );
    expect(ok).toMatchObject({ error: [], changed: ['PL-PM-1'], unchanged: ['PL-PM-2'] });
    expect(reg.entries[0]).toMatchObject({
      priority: 'now',
      now_category: ['important'],
      priority_set_by: 'owner',
    });
    // An agent does not change an owner-set priority, not even in a combined save.
    expect(
      P.prioritizeMany(
        reg,
        [{ id: 'PL-PM-1', priority: 'later', reason: 'Rule 8: x.' }],
        ctx(),
      ).error.join(),
    ).toContain('set by the owner');
  });

  it('the board saves priorityMap with one prioritize-many call, without an undo loop', () => {
    // Normalize CRLF so the test also passes on a Windows checkout (core.autocrlf=true).
    const board = readFileSync(join(__dirname, '..', '..', 'queue-board.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const body = board.slice(board.indexOf('async function planPrioritize'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toContain("'prioritize-many'");
    expect(fn).not.toContain("'undo'");
    expect(fn.match(/await queueJson\(/g)).toHaveLength(1);
  });
});

describe('queuePlan: statusDeviation without false matches', () => {
  it('docStatus: a number anchor does not match a longer number (9.10 is not 9.108)', () => {
    const doc = [
      '# R',
      '### 9.108 Snapshot',
      'Status: done',
      '### 9.10 Other',
      'Status: draft',
    ].join('\n');
    expect(P2.docStatus(doc, '9.10')).toBe('not-started');
    expect(P2.docStatus(doc, '9.108')).toBe('done');
  });

  it('docStatus: subsections and a check mark in running text are not read as the entry status', () => {
    const doc = [
      '### 9.108 Snapshot engine',
      'Status (verified against the form): event log missing.',
      '- Log daily at launch for the "✅" metrics.',
      '#### F1 Older part',
      'Status: done',
      '### 9.109 Next',
    ].join('\n');
    expect(P2.docStatus(doc, '9.108')).toBeNull();
    // A check mark first in a list item or in a table cell is still a status badge.
    expect(P2.docStatus('## 2. Part\n- ✅ delivered\n', '§ 2')).toBe('done');
    expect(P2.docStatus('## 2. Part\n| a | ✅ |\n', '§ 2')).toBe('done');
  });

  it('docStatus: in a large section only the top is read', () => {
    const fill = Array.from({ length: 40 }, (_, i) => `Line ${i} about something else.`);
    const sent = ['### 9.50 Large', ...fill, 'Status: done'].join('\n');
    expect(P2.docStatus(sent, '9.50')).toBeNull();
    const early = ['### 9.50 Large', 'Status: not started', ...fill].join('\n');
    expect(P2.docStatus(early, '9.50')).toBe('not-started');
  });

  it('check: drop entries and sources with role history or reference give no statusDeviation', () => {
    const reg = register(
      entry('PL-H-1', {
        priority: 'drop',
        drop_reason: 'History.',
        priority_reason: 'Rule 7: covered.',
        sources: [{ path: 'docs/export-plan.md' }],
      }),
      entry('PL-H-2', {
        sources: [
          { path: 'docs/export-plan.md', role: 'history' },
          { path: 'docs/gamma.md', role: 'reference' },
        ],
      }),
      entry('PL-H-3', { sources: [{ path: 'docs/export-plan.md', role: 'plan' }] }),
    );
    const texts: Record<string, string> = {
      'docs/export-plan.md': '# Old plan\nStatus: done\n',
      'docs/gamma.md': '# Ref\nStatus: delivered\n',
    };
    const r = P2.check(
      reg,
      { projects: PROJECTS, tasks: [] },
      {
        documents: ['docs/export-plan.md', 'docs/gamma.md'],
        existsPath: (s: string) => s in texts,
        readDoc: (s: string) => texts[s] ?? null,
      },
    );
    expect(r.statusDeviation.map((x) => x.id)).toEqual(['PL-H-3']);
    expect(r.unregistered).toEqual([]);
    expect(r.references).toEqual([
      { id: 'PL-H-2', path: 'docs/export-plan.md', role: 'history' },
      { id: 'PL-H-2', path: 'docs/gamma.md', role: 'reference' },
    ]);
  });
});

describe('queue.mjs: add --plan, edit-many, project --phase, plan check, modules and backup', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;
  let sources: string;
  function run(args: string[], env: Record<string, string> = {}) {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
          QUEUE_PLAN_SOURCE_ROOT: sources,
          QUEUE_PLAN_BACKUP: join(folder, 'sync.mjs'),
          ...env,
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
  type Queue = {
    tasks: Record<string, unknown>[];
    projects: Record<string, Record<string, unknown>>;
    areas?: Record<string, { title: string }>;
  };
  const readQueue = (): Queue => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')) as Queue;
  const file = (name: string, content: unknown) => {
    const filePath = join(folder, name);
    writeFileSync(filePath, JSON.stringify(content));
    return filePath;
  };
  const mkTask = (id: string, extra: object = {}) => ({
    id,
    title: `Task ${id}`,
    domain: 'alpha',
    class: 'K',
    mission: 'text',
    ...extra,
  });

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-plan2-'));
    sources = join(folder, 'root');
    mkdirSync(join(sources, 'docs'), { recursive: true });
    writeFileSync(join(sources, 'docs', 'export-plan.md'), '# plan\n');
    writeFileSync(join(sources, 'docs', 'unregistered.md'), '# other\n');
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        changed: '2026-10-14T08:00:00.000Z',
        tasks: [mkTask('OLD-1', { project: 'import', status: 'waiting' })],
        projects: { ...PROJECTS, fresh: { title: 'New', phase: 'plan' } },
        areas: AREAS,
        question: {},
        resolved: [],
      }),
    );
    expect(
      run([
        'plan',
        'new',
        '--file',
        file('p.json', [
          entry('PL-A-1', { maturity: 'ready', sources: [{ path: 'docs/export-plan.md' }] }),
          entry('PL-N-1', { project: 'fresh' }),
        ]),
      ]).code,
    ).toBe(0);
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('add --plan refuses an unknown planEntry and writes nothing', () => {
    const r = run(['add', '--file', file('a.json', [mkTask('A-1')]), '--plan', 'PL-GONE-1']);
    expect(r.code).toBe(1);
    expect(r.error).toContain('A-1: unknown planEntry PL-GONE-1');
    expect(readQueue().tasks).toHaveLength(1);
  });

  it('add --plan links, takes the project from the entry, and removes phase plan', () => {
    const r = run([
      'add',
      '--file',
      file('a.json', [mkTask('A-1'), mkTask('N-1', { plan: 'PL-N-1' })]),
      '--plan',
      'PL-A-1',
    ]);
    expect(r.error).toBe('');
    expect(r.out).toContain('Linked to plan entry: PL-A-1, PL-N-1');
    expect(r.out).toContain('Phase plan removed (has queue tasks now): fresh');
    expect(r.out).toContain('WARNING: planEntry PL-N-1 is investigated, not ready');
    const queue = readQueue();
    expect(queue.tasks.find((o) => o.id === 'A-1')).toMatchObject({
      plan: 'PL-A-1',
      project: 'export',
    });
    expect(queue.projects.fresh.phase).toBeUndefined();
    const show = JSON.parse(run(['plan', 'show', '--json']).out) as {
      entries: (Post & { derived: { maturity: string } })[];
    };
    expect(show.entries.find((p) => p.id === 'PL-A-1')?.derived.maturity).toBe('in-queue');
  });

  it('edit-many sets plan on an existing task and refuses an unknown one', () => {
    expect(
      run(['edit-many', '--file', file('e.json', [{ id: 'OLD-1', plan: 'PL-NO-1' }])]).code,
    ).toBe(1);
    expect(readQueue().tasks[0].plan).toBeUndefined();
    expect(
      run(['edit-many', '--file', file('e.json', [{ id: 'OLD-1', plan: 'PL-A-1' }])]).code,
    ).toBe(0);
    expect(readQueue().tasks[0].plan).toBe('PL-A-1');
  });

  it('project --phase plan is refused when the project has queue tasks, and is set otherwise', () => {
    const deny = run(['project', 'import', '--phase', 'plan']);
    expect(deny.code).toBe(1);
    expect(deny.error).toContain('phase plan only applies to projects without queue tasks');
    expect(run(['project', 'export', '--phase', 'plan']).code).toBe(0);
    expect(readQueue().projects.export.phase).toBe('plan');
    expect(run(['project', 'export', '--phase', 'none']).code).toBe(0);
    expect(readQueue().projects.export.phase).toBeUndefined();
  });

  it('plan check --json only reads and finds unregistered documents and gaps', () => {
    const queueFor = readFileSync(join(folder, 'queue.json'), 'utf8');
    const r = run(['plan', 'check', '--json']);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out) as CheckAnswer & { ok: boolean };
    expect(s.ok).toBe(true);
    expect(s.unregistered).toEqual(['docs/unregistered.md']);
    expect(s.gaps).toEqual([{ id: 'PL-N-1', reason: 'the project fresh has no module' }]);
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(queueFor);
    expect(run(['plan', 'check']).out).toContain(
      'Unregistered (no entry points to the document) (1)',
    );
  });

  it('plan modules creates the missing ones, does not touch existing ones, and --dry writes nothing', () => {
    const t = run(['plan', 'modules', '--dry']);
    expect(t.out).toContain('Preview (nothing written)');
    expect(Object.keys(readQueue().areas ?? {})).toEqual(['alpha', 'gamma']);
    expect(run(['plan', 'modules']).code).toBe(0);
    const ar = readQueue().areas ?? {};
    expect(Object.keys(ar)).toHaveLength(5);
    expect(ar.alpha.title).toBe('Alpha');
    expect(run(['plan', 'modules']).out).toContain('all areas exist');
  });

  it('plan backup runs sync.mjs with --push, and an error in sync gives an exit code and no "done"', () => {
    writeFileSync(
      join(folder, 'sync.mjs'),
      "import fs from 'node:fs';\nfs.writeFileSync(new URL('./argv.json', import.meta.url), JSON.stringify({ argv: process.argv.slice(2), root: process.env.QUEUE_ROOT }));\n",
    );
    const r = run(['plan', 'backup', '--push']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Backup done and pushed.');
    const called = JSON.parse(readFileSync(join(folder, 'argv.json'), 'utf8')) as {
      argv: string[];
      root: string;
    };
    expect(called.argv).toEqual(['--push']);
    expect(called.root).toBeTruthy();
    expect(run(['plan', 'backup', '--dry']).out).toContain('Preview (nothing run)');
    writeFileSync(join(folder, 'sync.mjs'), 'process.exit(1);\n');
    const error = run(['plan', 'backup']);
    expect(error.code).toBe(1);
    expect(error.error).toContain('sync.mjs stopped (exit 1)');
    expect(run(['plan', 'backup'], { QUEUE_PLAN_BACKUP: join(folder, 'gone.mjs') }).error).toContain(
      'Could not find',
    );
  });
});

// ---- "Working now" --------------------------------------------------------------------------

type Cursor = { entry: string; at: string; by: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const A = require('../queuePlan') as {
  ACTIVE_SESSION_HOURS: number;
  isActiveSession: (m: unknown, o?: { now?: Date | string }) => boolean;
  activeEntries: (
    reg: unknown,
    o?: { now?: Date | string },
  ) => Record<string, { at: string; by: string }>;
  setActiveSession: (
    reg: Reg & { active_session?: Cursor[] },
    id: string,
    o?: { by?: string | null; now?: Date | string; end?: boolean },
  ) => { error: string[]; changed: boolean; cursor: Cursor | null };
};

describe('queuePlan: active_session', () => {
  const NOW = '2026-10-14T12:00:00.000Z';

  it('a marker lives for under 2 hours after the last pulse, and dies after that', () => {
    expect(A.ACTIVE_SESSION_HOURS).toBe(2);
    expect(A.isActiveSession({ at: '2026-10-14T10:00:01.000Z' }, { now: NOW })).toBe(true);
    expect(A.isActiveSession({ at: '2026-10-14T10:00:00.000Z' }, { now: NOW })).toBe(false);
    expect(A.isActiveSession({ at: '2026-10-14T12:04:00.000Z' }, { now: NOW })).toBe(true);
    expect(A.isActiveSession({ at: '2026-10-14T12:30:00.000Z' }, { now: NOW })).toBe(false);
    expect(A.isActiveSession({ at: 'junk' }, { now: NOW })).toBe(false);
    expect(A.isActiveSession(null, { now: NOW })).toBe(false);
  });

  it('sets, replaces and removes the marker without touching entries or changelog', () => {
    const reg = register(entry('PL-EXPORT-1'), entry('PL-EXPORT-2')) as Reg & { active_session?: Cursor[] };
    const entryFor = JSON.stringify(reg.entries);
    const logFor = JSON.stringify(reg.changelog);
    const changedFor = reg.changed;

    const s1 = A.setActiveSession(reg, 'PL-EXPORT-1', { by: 'session-a', now: '2026-10-14T11:00:00.000Z' });
    expect(s1).toMatchObject({ error: [], changed: true });
    expect(reg.active_session).toEqual([
      { entry: 'PL-EXPORT-1', at: '2026-10-14T11:00:00.000Z', by: 'session-a' },
    ]);
    // New pulse on the same entry: one marker, last one wins.
    A.setActiveSession(reg, 'PL-EXPORT-1', { by: 'session-b', now: NOW });
    A.setActiveSession(reg, 'PL-EXPORT-2', { by: 'session-a', now: NOW });
    expect(reg.active_session).toHaveLength(2);
    expect(A.activeEntries(reg, { now: NOW })).toEqual({
      'PL-EXPORT-1': { at: NOW, by: 'session-b' },
      'PL-EXPORT-2': { at: NOW, by: 'session-a' },
    });

    const s2 = A.setActiveSession(reg, 'PL-EXPORT-1', { end: true, now: NOW });
    expect(s2).toMatchObject({ error: [], changed: true, cursor: null });
    expect(Object.keys(A.activeEntries(reg, { now: NOW }))).toEqual(['PL-EXPORT-2']);
    // --end without a marker is no error, just no change.
    expect(A.setActiveSession(reg, 'PL-EXPORT-1', { end: true, now: NOW }).changed).toBe(false);

    expect(JSON.stringify(reg.entries)).toBe(entryFor);
    expect(JSON.stringify(reg.changelog)).toBe(logFor);
    expect(reg.changed).toBe(changedFor);
  });

  it('dead markers disappear from activeEntries and are cleaned up on the next write', () => {
    const reg = register(entry('PL-EXPORT-1'), entry('PL-EXPORT-2')) as Reg & { active_session?: Cursor[] };
    reg.active_session = [
      { entry: 'PL-EXPORT-1', at: '2026-10-14T08:00:00.000Z', by: 'old' },
      { entry: 'PL-GONE-1', at: NOW, by: 'unknown entry' },
    ];
    expect(A.activeEntries(reg, { now: NOW })).toEqual({});
    A.setActiveSession(reg, 'PL-EXPORT-2', { by: 'new', now: NOW });
    expect(reg.active_session.map((m) => m.entry)).toEqual(['PL-GONE-1', 'PL-EXPORT-2']);
    expect(Object.keys(A.activeEntries(reg, { now: NOW }))).toEqual(['PL-EXPORT-2']);
  });

  it('refuses an unknown or merged entry, and a missing id', () => {
    const reg = register(entry('PL-EXPORT-1'), entry('PL-EXPORT-2'));
    P.combineTogether(reg, 'PL-EXPORT-1', ['PL-EXPORT-2']);
    expect(A.setActiveSession(reg, 'PL-EXPORT-9').error[0]).toContain('does not exist');
    expect(A.setActiveSession(reg, 'PL-EXPORT-2').error[0]).toContain('is merged into PL-EXPORT-1');
    expect(A.setActiveSession(reg, '').error[0]).toContain('missing entry id');
    expect((reg as { active_session?: unknown }).active_session).toBeUndefined();
  });
});

describe('queue.mjs plan active', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;
  function run(args: string[]) {
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
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout ?? '', error: x.stderr ?? '' };
    }
  }
  const readReg = () =>
    JSON.parse(readFileSync(join(folder, 'plans.json'), 'utf8')) as Reg & {
      active_session?: Cursor[];
    };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-plan-active-'));
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({ changed: '2026-10-14T08:00:00.000Z', tasks: [], projects: PROJECTS }),
    );
    writeFileSync(join(folder, 'new.json'), JSON.stringify([entry('PL-EXPORT-1')]));
    expect(run(['plan', 'new', '--file', join(folder, 'new.json')]).code).toBe(0);
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('sets and removes the marker without changelog and without bumping changed', () => {
    const for_ = readReg();
    const set = run(['plan', 'active', 'PL-EXPORT-1', '--by', 'plans-session', '--json']);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toMatchObject({
      ok: true,
      changed: true,
      cursor: { by: 'plans-session' },
    });
    const after = readReg();
    expect(after.active_session).toEqual([
      expect.objectContaining({ entry: 'PL-EXPORT-1', by: 'plans-session' }),
    ]);
    expect(after.changed).toBe(for_.changed);
    expect(after.changelog).toEqual(for_.changelog);

    const list = JSON.parse(run(['plan', 'active', '--json']).out) as { activeOnes: object };
    expect(Object.keys(list.activeOnes)).toEqual(['PL-EXPORT-1']);
    const show = JSON.parse(run(['plan', 'show', '--json']).out) as { activeOnes: object };
    expect(Object.keys(show.activeOnes)).toEqual(['PL-EXPORT-1']);

    expect(run(['plan', 'active', 'PL-EXPORT-1', '--end']).out).toContain('the cursor is removed');
    expect(readReg().active_session).toEqual([]);
    expect(run(['plan', 'active']).out).toContain('No plan entries are under work now');
  });

  it('refuses an unknown entry and writes nothing', () => {
    const for_ = readFileSync(join(folder, 'plans.json'), 'utf8');
    const r = run(['plan', 'active', 'PL-GONE-1']);
    expect(r.code).toBe(1);
    expect(r.error).toContain('does not exist');
    expect(readFileSync(join(folder, 'plans.json'), 'utf8')).toBe(for_);
  });
});

// ---- The consistency checks for Documents and agreements ----------------------------------------------
type DocFindings = { doc: string | null; check: string; severity: string; text: string };
type DocReg = Reg & { documents: Record<string, unknown>[] };
type Vendor = { id: string; name?: string; word?: string[]; documents?: unknown[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../queuePlan') as {
  DOC_CHECKS: string[];
  vendorsInText: (
    t: string,
    o?: { onlyTable?: boolean; vendors?: Vendor[] },
  ) => string[];
  sectionInText: (t: string, heading: RegExp) => string | null;
  checkVendors: (reg: object, queue: object, ctx: object) => DocFindings[];
  checkRevisions: (reg: object, o?: { now?: Date }) => DocFindings[];
  assessWebAnswer: (doc: object, pub: object, answer: object) => DocFindings[];
  webAddresses: (reg: object) => { doc: { id: string }; pub: { url: string } }[];
  docConsistency: (reg: object, queue: object, ctx?: object) => { findings: DocFindings[]; ran: string[] };
  syncConsistency: (
    reg: object,
    findings: DocFindings[],
    ran: string[],
    ctx?: object,
  ) => { error: string[]; warnings: string[]; changed: string[] };
  validateDoc: (d: object, ctx?: object) => { error: string[]; warnings: string[] };
  check: (reg: object, queue: object, ctx?: object) => { count: number; doc_consistency?: DocFindings[] };
  emptyRegister: (now?: string) => DocReg;
};

// The vendor list in the tests (in a project it lives in queue.config.json under documents.vendors). The names are
// made up.
const VENDORS: Vendor[] = [
  { id: 'northstock', name: 'Northstock', documents: ['DOC-VENDOR'] },
  { id: 'postman', name: 'Postman', documents: ['DOC-VENDOR'] },
  { id: 'pigeon', name: 'Pigeon', documents: ['DOC-VENDOR'] },
  { id: 'speechbox', name: 'Speechbox', documents: ['DOC-VENDOR'] },
  {
    id: 'invoice',
    name: 'Invoicer',
    documents: [
      {
        doc: 'DOC-DECLARATION',
        section: '^Who we share with',
        where: 'DOC-DECLARATION (Who we share with)',
      },
    ],
  },
];
const SWITCHES = [{ out: 'postman', in: 'pigeon', planEntry: 'PL-SWAP-1' }];

describe('queuePlan: vendors, revision and web', () => {
  const UL = [
    '| Vendor | Service |',
    '|---|---|',
    '| **Northstock Ltd** | Database |',
    '| **Postman Inc.** | Email, mentions Speechbox in the text |',
  ].join('\n');
  const MANIFEST = 'NORTHSTOCK_URL, POSTMAN_API_KEY, PIGEON_API_KEY and INVOICER_TOKEN';
  const PRIVACY = [
    '### What data we process',
    'Invoicing via Invoicer.',
    '### Who we share with',
    'Northstock (storage).',
    '### Your rights',
  ].join('\n');
  const regWith = (documents: object[], entries: object[] = []) => ({ documents, entries });
  const ul = {
    id: 'DOC-VENDOR',
    status: 'draft',
    source: 'ul.md',
    group: 'privacy',
    audience: 'customer',
  };
  const pv = {
    id: 'DOC-DECLARATION',
    status: 'draft',
    source: 'pv.md',
    group: 'privacy',
    audience: 'public',
  };
  const agreement = {
    id: 'DOC-AGREEMENT',
    status: 'draft',
    source: 'agreement.md',
    group: 'customerAgreements',
    audience: 'customer',
  };
  const internal = { ...agreement, id: 'DOC-INTERNAL', group: 'governance', audience: 'internal' };
  const run = (
    texts: Record<string, string>,
    documents: object[] = [ul, pv, agreement, internal],
    extra: object = {},
  ) =>
    K.checkVendors(regWith(documents), {}, {
      readDoc: (s: string) => texts[s] ?? null,
      vendors: VENDORS,
      secretsManifest: 'docs/secrets-manifest.md',
      vendorSwitches: SWITCHES,
      ...extra,
    });

  it('vendorsInText only looks at the first cell in table mode, and a word inside another word does not count', () => {
    const o = { vendors: VENDORS };
    expect(K.vendorsInText(UL, { ...o, onlyTable: true }).sort()).toEqual([
      'northstock',
      'postman',
    ]);
    expect(K.vendorsInText('POSTMAN_API_KEY and postmanship', o)).toEqual(['postman']);
    // Without a list in the configuration there are no vendors
    expect(K.vendorsInText(UL)).toEqual([]);
  });

  it('sectionInText gives the text under the heading up to the next one at the same level, otherwise null', () => {
    expect(K.sectionInText(PRIVACY, /^Who we share with/)).toBe('Northstock (storage).');
    expect(K.sectionInText('# A\n## B\ntext\n### C\nunder\n## D', /^B$/)).toBe(
      'text\n### C\nunder',
    );
    expect(K.sectionInText(PRIVACY, /^Does not exist/)).toBeNull();
  });

  it('reports a vendor in the manifest missing from the document, one in the document not in use, and the switch', () => {
    const findings = run({
      'docs/secrets-manifest.md': MANIFEST,
      'ul.md': UL,
      'pv.md': PRIVACY,
      'agreement.md': 'Email is sent via Postman.',
    });
    // Pigeon is in the manifest, but not in the list: high finding
    expect(findings).toContainEqual(
      expect.objectContaining({
        doc: 'DOC-VENDOR',
        check: 'vendor',
        severity: 'high',
        text: expect.stringContaining('Pigeon is in use'),
      }),
    );
    // Speechbox is in the list, but not in the manifest: low finding (still in use?)
    expect(findings).toContainEqual(
      expect.objectContaining({
        doc: 'DOC-VENDOR',
        severity: 'low',
        text: expect.stringContaining('Speechbox is in DOC-VENDOR'),
      }),
    );
    // Invoicer is only under the wrong heading in the declaration: high finding
    expect(findings).toContainEqual(
      expect.objectContaining({
        doc: 'DOC-DECLARATION',
        severity: 'high',
        text: expect.stringContaining('DOC-DECLARATION (Who we share with)'),
      }),
    );
    // Postman is on its way out; the planEntry does not exist, so the switch is planned (medium)
    expect(findings).toContainEqual(
      expect.objectContaining({
        doc: 'DOC-AGREEMENT',
        severity: 'medium',
        text: expect.stringContaining('Mentions Postman; to be replaced by Pigeon (PL-SWAP-1, planned)'),
      }),
    );
    // Postman does not count as missing anywhere, and internal documents are not checked for switches
    expect(findings.some((f) => /^Postman is in use/.test(f.text))).toBe(false);
    expect(findings.some((f) => f.doc === 'DOC-INTERNAL')).toBe(false);
  });

  it('is silent when everything is correct', () => {
    const ulCorrect = `${UL}\n| **Pigeon** | Email |`.replace(
      '| **Postman Inc.** | Email, mentions Speechbox in the text |',
      '| **Postman Inc.** | Email |',
    );
    const privacyCorrect = PRIVACY.replace('Northstock (storage).', 'Northstock (storage) and Invoicer.');
    const findings = run(
      { 'docs/secrets-manifest.md': MANIFEST, 'ul.md': ulCorrect, 'pv.md': privacyCorrect },
      [ul, pv],
      { vendorSwitches: [] },
    );
    expect(findings).toEqual([]);
  });

  it('without a manifest all in the list count as in use; a document that is missing or cannot be read gives a medium finding', () => {
    const withoutManifest = run({ 'ul.md': UL, 'pv.md': PRIVACY }, [ul, pv], {
      secretsManifest: null,
      vendorSwitches: [],
    });
    expect(withoutManifest.map((f) => f.text.split(' ')[0]).sort()).toEqual([
      'Invoicer',
      'Pigeon',
    ]);
    expect(withoutManifest.some((f) => f.severity === 'low')).toBe(false);

    const withoutDoc = run({ 'ul.md': UL }, [ul], { secretsManifest: null, vendorSwitches: [] });
    expect(withoutDoc).toContainEqual(
      expect.objectContaining({
        doc: null,
        severity: 'medium',
        text: expect.stringContaining('DOC-DECLARATION is not in the document register'),
      }),
    );
    const withoutSource = run({ 'ul.md': UL }, [ul, pv], {
      secretsManifest: null,
      vendorSwitches: [],
    });
    expect(withoutSource).toContainEqual(
      expect.objectContaining({
        doc: 'DOC-DECLARATION',
        severity: 'medium',
        text: expect.stringContaining('pv.md'),
      }),
    );
    // A manifest that does not exist gives a low finding without a document
    const gone = run({ 'ul.md': UL, 'pv.md': PRIVACY }, [ul, pv], { vendorSwitches: [] });
    expect(gone).toContainEqual(
      expect.objectContaining({ doc: null, severity: 'low', text: expect.stringContaining('Could not find') }),
    );
  });

  it('overdue revisions and the web check', () => {
    const d = {
      id: 'DOC-X',
      status: 'draft',
      last_revised: '2025-01-01',
      revision_every: '12 mo',
    };
    expect(K.checkRevisions(regWith([d]), { now: new Date('2026-10-15T10:00:00Z') })).toEqual([
      expect.objectContaining({ doc: 'DOC-X', check: 'revision' }),
    ]);
    const doc = { id: 'DOC-P', audience: 'public', group: 'privacy' };
    const pub = { where: 'webPage', url: 'https://example.no/p', version: '1.2' };
    expect(K.assessWebAnswer(doc, pub, { status: 200, text: 'Version 1.2 (current)' })).toEqual(
      [],
    );
    expect(K.assessWebAnswer(doc, pub, { status: 200, text: 'Version 1.21' })[0].text).toContain(
      'does not show version 1.2',
    );
    expect(K.assessWebAnswer(doc, pub, { status: 404, text: '' })[0]).toMatchObject({
      severity: 'high',
    });
    expect(K.assessWebAnswer(doc, pub, { error: 'timeout' })[0].text).toContain('does not respond');
    const reg = regWith([
      { ...doc, status: 'draft', published: [pub, { where: 'admin', path: 'x' }] },
    ]);
    expect(K.webAddresses(reg).map((x) => x.pub.url)).toEqual(['https://example.no/p']);
  });
});

describe('queuePlan: docConsistency, sync to problems, modules and plan check', () => {
  const NOW = '2026-10-15T10:00:00.000Z';
  const fresh = (field: Record<string, unknown>) => ({
    group: 'privacy',
    audience: 'internal',
    status: 'draft',
    title: 'Title',
    created: NOW,
    ...field,
  });

  it('validateDoc accepts known modules and rejects unknown ones', () => {
    expect(K.validateDoc(fresh({ id: 'DOC-ASSESSMENT', modules: ['alpha', 'beta'] })).error).toEqual([]);
    expect(K.validateDoc(fresh({ id: 'DOC-ASSESSMENT', modules: ['junk'] })).error.join()).toContain(
      'unknown module junk',
    );
    expect(K.validateDoc(fresh({ id: 'DOC-ASSESSMENT', modules: 'alpha' })).error.join()).toContain(
      'modules must be a list',
    );
  });

  it('syncConsistency only replaces the problems from the checks that ran, and does not touch others', () => {
    const reg = K.emptyRegister(NOW);
    reg.documents = [
      fresh({
        id: 'DOC-A',
        problems: [
          { text: 'Written by the owner', severity: 'low' },
          { text: 'Old findings', severity: 'medium', source: 'check:vendor' },
          { text: 'Web findings', severity: 'medium', source: 'check:web' },
        ],
      }),
      fresh({ id: 'DOC-B' }),
    ];
    const findings: DocFindings[] = [
      { doc: 'DOC-A', check: 'vendor', severity: 'high', text: 'New findings' },
      { doc: 'DOC-B', check: 'revision', severity: 'medium', text: 'Overdue' },
      { doc: null, check: 'vendor', severity: 'low', text: 'No document' },
    ];
    const s = K.syncConsistency(reg, findings, ['vendor', 'revision'], { now: NOW });
    expect(s.error).toEqual([]);
    expect(s.changed).toEqual(['DOC-A']);
    expect(reg.documents[0].problems).toEqual([
      { text: 'Written by the owner', severity: 'low' },
      { text: 'Web findings', severity: 'medium', source: 'check:web' },
      { text: 'New findings', severity: 'high', source: 'check:vendor' },
    ]);
    // Revisions are never recorded as a problem
    expect(reg.documents[1].problems).toBeUndefined();
    // The same findings once more: nothing is changed
    expect(K.syncConsistency(reg, findings, ['vendor'], { now: NOW }).changed).toEqual([]);
  });

  it('docConsistency is empty without documents, the vendor check only runs with a list, and plan check counts the findings', () => {
    expect(K.DOC_CHECKS).toEqual(['vendor', 'revision', 'web']);
    const empty = K.emptyRegister(NOW);
    expect(K.docConsistency(empty, {})).toEqual({ findings: [], ran: [] });
    expect(K.check(empty, {}, { now: new Date(NOW) }).doc_consistency).toBeUndefined();
    const reg = K.emptyRegister(NOW);
    reg.documents = [fresh({ id: 'DOC-X', last_revised: '2025-01-01', revision_every: '12 mo' })];
    // Without a vendor list in the configuration only the revision check runs
    const r = K.docConsistency(reg, {}, { now: new Date(NOW), readDoc: () => null });
    expect(r.ran).toEqual(['revision']);
    const withList = K.docConsistency(reg, {}, {
      now: new Date(NOW),
      readDoc: () => null,
      vendors: VENDORS,
      secretsManifest: null,
    });
    expect(withList.ran).toEqual(['vendor', 'revision']);
    const s = K.check(reg, {}, { now: new Date(NOW) });
    expect(s.doc_consistency).toHaveLength(1);
    expect(s.count).toBeGreaterThanOrEqual(1);
  });
});

describe('queue.mjs plan doc check, against a copy in a temporary folder', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;
  let root: string;
  const run = (args: string[]) => {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
          QUEUE_PLAN_SOURCE_ROOT: root,
          // A configuration of its own with the vendor list, the manifest and the switch.
          QUEUE_CONFIG: join(folder, 'queue.config.json'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout ?? '', error: x.stderr ?? '' };
    }
  };
  const readReg = () => JSON.parse(readFileSync(join(folder, 'plans.json'), 'utf8')) as DocReg;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-plan-doc-'));
    root = join(folder, 'root');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(folder, 'queue.config.json'),
      JSON.stringify({
        modules: [{ oid: 'alpha', title: 'Alpha' }],
        documents: {
          vendors: VENDORS.slice(0, 3),
          secretsManifest: 'docs/secrets-manifest.md',
          vendorSwitches: SWITCHES,
        },
      }),
    );
    writeFileSync(join(root, 'docs', 'secrets-manifest.md'), 'NORTHSTOCK and PIGEON_API_KEY\n');
    writeFileSync(
      join(root, 'docs', 'vendors.md'),
      '| **Northstock** | db |\n| **Postman** | email |\n',
    );
    writeFileSync(join(root, 'docs', 'agreement.md'), 'Email is sent via Postman.\n');
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        tasks: [],
        projects: PROJECTS,
        areas: AREAS,
        question: {},
        resolved: [],
      }),
    );
    const doc = [
      {
        group: 'privacy',
        status: 'draft',
        id: 'DOC-VENDOR',
        title: 'Vendors',
        audience: 'internal',
        source: 'docs/vendors.md',
      },
      {
        group: 'customerAgreements',
        status: 'draft',
        id: 'DOC-AGREEMENT',
        title: 'Customer agreement',
        audience: 'customer',
        source: 'docs/agreement.md',
      },
    ];
    writeFileSync(join(folder, 'doc.json'), JSON.stringify(doc));
    expect(run(['plan', 'doc', 'new', '--file', join(folder, 'doc.json')]).code).toBe(0);
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('shows the findings, writes them as problems with --write, and undo removes them', () => {
    const show = run(['plan', 'doc', 'check', '--json']);
    expect(show.code).toBe(0);
    const v = JSON.parse(show.out) as { ran: string[]; findings: DocFindings[] };
    expect(v.ran).toEqual(['vendor', 'revision']);
    expect(v.findings).toContainEqual(
      expect.objectContaining({
        doc: 'DOC-VENDOR',
        check: 'vendor',
        severity: 'high',
        text: expect.stringContaining('Pigeon is in use'),
      }),
    );
    expect(v.findings).toContainEqual(
      expect.objectContaining({
        doc: 'DOC-AGREEMENT',
        severity: 'medium',
        text: expect.stringContaining('Mentions Postman'),
      }),
    );
    // Without --write nothing is changed
    expect(readReg().documents.every((d) => !d.problems)).toBe(true);

    const dry = run(['plan', 'doc', 'check', '--write', '--dry']);
    expect(dry.out).toContain('Preview (nothing written)');
    expect(readReg().documents.every((d) => !d.problems)).toBe(true);

    const write = run(['plan', 'doc', 'check', '--write']);
    expect(write.code).toBe(0);
    expect(write.out).toContain('Problems updated in 2 document(s)');
    const vendorList = readReg().documents.find((d) => d.id === 'DOC-VENDOR') as {
      problems: { source: string }[];
    };
    expect(vendorList.problems[0].source).toBe('check:vendor');

    // plan check shows them in a section of their own
    expect(run(['plan', 'check']).out).toContain('Documents and agreements');

    expect(run(['plan', 'undo']).code).toBe(0);
    expect(readReg().documents.every((d) => !d.problems)).toBe(true);
  });
});
