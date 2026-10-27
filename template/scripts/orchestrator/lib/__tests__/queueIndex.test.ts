// =============================================================
// queueIndex.test.ts: the document index ordered by the plan register (lib/queueIndex.js, an optional feature): reading
// INDEX (introduction, items, generated lines discarded, an unknown line is an error), section per module, cross-cutting and
// unlinked, the plan entry line, new plan documents from the register, idempotence, plus make-index.mjs (--check, --dry,
// writing, without a register) against a copy in a temporary folder (never the real INDEX or the real register).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The test modules sit in a temporary queue.config.json (QUEUE_CONFIG), set before queueIndex/queuePlan read the configuration;
// make-index.mjs in the child process inherits it.
const CONFIG_FOLDER = mkdtempSync(join(tmpdir(), 'queue-index-config-'));
process.env.QUEUE_CONFIG = join(CONFIG_FOLDER, 'queue.config.json');
writeFileSync(
  process.env.QUEUE_CONFIG,
  JSON.stringify({
    modules: [
      { oid: 'alpha', title: 'Alpha' },
      { oid: 'beta', title: 'Beta' },
      { oid: 'gamma', title: 'Gamma' },
    ],
  }),
);

type Source = { path: string; anchor?: string; role?: string };
type Post = { id: string; title: string; project: string; sources?: Source[] };
type Entry = { paths: string[]; lines: string[] };

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS module (like queuePlan.js)
const I = require('../queueIndex') as {
  PLAN_ENTRIES_PREFIX: string;
  MAX_ENTRIES_ON_LINE: number;
  pathsInEntry: (line: string) => string[];
  readIndex: (t: string) => { introduction: string[]; entries: Entry[]; error: string[] };
  pathMatches: (a: string, b: string) => boolean;
  sectionFor: (entries: Post[], projects: Record<string, { area?: string }>) => string;
  makeIndex: (
    t: string,
    reg: { entries: Post[] },
    queue: { projects?: Record<string, { area?: string }> },
    ctx?: { exists?: (path: string) => boolean; folders?: string[]; index?: string | null },
  ) => { text: string; error: string[]; newOnes: string[]; count: Record<string, number> };
  firstDifference: (a: string, b: string) => { line: number } | null;
  INDEX_DEFAULT: string;
  indexFile: () => string | null;
};

const INTRODUCTION = '# Document index\n\n> Remark.\n\nThese live in `docs/`.\n';
const INDEX = `${INTRODUCTION}- \`docs/a-plan.md\` — plan A
  with continuation
- \`docs/b-plan.md\`: plan B
- \`docs/c.md\` · \`docs/d.md\` — two documents
- \`archive/\` — folder
`;
const QUEUE = {
  projects: {
    export: { area: 'alpha' },
    beta: { area: 'beta' },
    gamma: { area: 'gamma' },
    orphan: {},
  },
};
const entry = (id: string, project: string, sources: Source[], title = `Title ${id}`): Post => ({
  id,
  title,
  project,
  sources,
});

describe('readIndex', () => {
  it('separates introduction and items, and takes all paths at the start of the line', () => {
    const r = I.readIndex(INDEX);
    expect(r.error).toEqual([]);
    expect(r.introduction.join('\n')).toBe(INTRODUCTION.trimEnd());
    expect(r.entries.map((o) => o.paths)).toEqual([
      ['docs/a-plan.md'],
      ['docs/b-plan.md'],
      ['docs/c.md', 'docs/d.md'],
      ['archive/'],
    ]);
    expect(r.entries[0].lines).toEqual(['- `docs/a-plan.md` — plan A', '  with continuation']);
  });

  it('discards section headings, empty lines and plan entry lines (they are made again)', () => {
    const t = `${INTRODUCTION}## Alpha\n\n- \`docs/a.md\`: a\n${I.PLAN_ENTRIES_PREFIX}\`PL-X-1\`.\n\n## Beta\n`;
    const r = I.readIndex(t);
    expect(r.entries).toEqual([{ paths: ['docs/a.md'], lines: ['- `docs/a.md`: a'] }]);
  });

  it('reports an unknown line in the body instead of losing it', () => {
    const r = I.readIndex(`${INDEX}Loose text\n`);
    expect(r.error).toHaveLength(1);
    expect(r.error[0]).toMatch(/unknown line/);
  });

  it('reports an item without a path in backticks', () => {
    expect(I.readIndex(`${INTRODUCTION}- no path\n`).error[0]).toMatch(/backticks/);
  });

  it('accepts CRLF', () => {
    expect(I.readIndex(INDEX.replace(/\n/g, '\r\n')).entries).toHaveLength(4);
  });
});

describe('pathMatches and sectionFor', () => {
  it('a folder item matches files below the folder, a file item only itself', () => {
    expect(I.pathMatches('archive/', 'archive/01.md')).toBe(true);
    expect(I.pathMatches('docs/a.md', 'docs/a.md')).toBe(true);
    expect(I.pathMatches('docs/a.md', 'docs/a.md.back')).toBe(false);
  });

  it('no entries gives unlinked; most in one module wins; a tie follows the module order from the configuration', () => {
    expect(I.sectionFor([], QUEUE.projects)).toBe('unlinked');
    expect(
      I.sectionFor(
        [entry('PL-A', 'beta', []), entry('PL-B', 'beta', []), entry('PL-C', 'export', [])],
        QUEUE.projects,
      ),
    ).toBe('beta');
    expect(I.sectionFor([entry('PL-A', 'beta', []), entry('PL-B', 'export', [])], QUEUE.projects)).toBe(
      'alpha',
    );
  });

  it('entries in three modules give cross-cutting; a project without a module counts as without-module', () => {
    expect(
      I.sectionFor(
        [entry('PL-A', 'beta', []), entry('PL-B', 'export', []), entry('PL-C', 'gamma', [])],
        QUEUE.projects,
      ),
    ).toBe('crossCutting');
    expect(I.sectionFor([entry('PL-A', 'orphan', [])], QUEUE.projects)).toBe('without-module');
    expect(I.sectionFor([entry('PL-A', 'exists-not', [])], QUEUE.projects)).toBe('without-module');
  });
});

describe('makeIndex', () => {
  const REG = {
    entries: [
      entry('PL-B', 'beta', [{ path: 'docs/b-plan.md', role: 'plan' }]),
      entry('PL-A', 'export', [{ path: 'docs/a-plan.md', role: 'plan' }]),
      entry('PL-D', 'gamma', [{ path: 'docs/d.md', role: 'history' }]),
      entry('PL-L', 'export', [{ path: 'archive/05.md', role: 'reference' }]),
    ],
  };

  it('orders by module, keeps the descriptions and adds the plan entry line', () => {
    const r = I.makeIndex(INDEX, REG, QUEUE);
    expect(r.error).toEqual([]);
    expect(r.text).toBe(
      `${INTRODUCTION}
## Alpha

- \`archive/\` — folder
  Plan entries: \`PL-L\`.
- \`docs/a-plan.md\` — plan A
  with continuation
  Plan entries: \`PL-A\`.

## Beta

- \`docs/b-plan.md\`: plan B
  Plan entries: \`PL-B\`.

## Gamma

- \`docs/c.md\` · \`docs/d.md\` — two documents
  Plan entries: \`PL-D\`.
`,
    );
    expect(r.count).toEqual({ alpha: 2, beta: 1, gamma: 1 });
  });

  it('is idempotent: a second run gives the same text', () => {
    const one = I.makeIndex(INDEX, REG, QUEUE).text;
    expect(I.makeIndex(one, REG, QUEUE).text).toBe(one);
    expect(I.firstDifference(one, I.makeIndex(one, REG, QUEUE).text)).toBeNull();
  });

  it('a document without an entry ends up under "Not linked to a plan entry", without a plan entry line', () => {
    const r = I.makeIndex(INDEX, { entries: [] }, QUEUE);
    expect(r.count).toEqual({ unlinked: 4 });
    expect(r.text).toContain('## Not linked to a plan entry');
    expect(r.text).not.toContain('Plan entries:');
  });

  it('a new tracked plan document from the register gets an item with the title of the first entry', () => {
    const reg = {
      entries: [
        entry('PL-Z', 'beta', [{ path: 'docs/new-plan.md', role: 'plan' }], 'Later title'),
        entry('PL-Y', 'beta', [{ path: 'docs/new-plan.md', role: 'plan' }], 'First title'),
      ],
    };
    const r = I.makeIndex(INDEX, reg, QUEUE);
    expect(r.newOnes).toEqual(['docs/new-plan.md']);
    expect(r.text).toContain(
      '- `docs/new-plan.md`: First title (the description is taken from the plan entry',
    );
    expect(r.text).toContain('  Plan entries: `PL-Y`, `PL-Z`.');
    // The new line is kept verbatim on the next run.
    expect(I.makeIndex(r.text, reg, QUEUE).text).toBe(r.text);
  });

  it('new items only for plan and reference below the document folders, not INDEX, not dead or ignored paths', () => {
    const reg = {
      entries: [
        entry('PL-1', 'beta', [
          { path: 'docs/history.md', role: 'history' },
          { path: 'docs/investigation.md', role: 'investigation' },
          { path: 'docs/notes/secret.md', role: 'plan' },
          { path: 'governance/x.md', role: 'plan' },
          { path: 'docs/INDEX.md', role: 'plan' },
          { path: 'docs/gone.md', role: 'plan' },
          { path: 'docs/runbook.md', role: 'reference' },
          { path: 'docs/without-role.md' },
        ]),
      ],
    };
    // exists: make-index.mjs says no to missing files and files git ignores (here docs/notes/).
    const exists = (s: string) => s !== 'docs/gone.md' && !s.startsWith('docs/notes/');
    const r = I.makeIndex(INDEX, reg, QUEUE, { exists });
    expect(r.newOnes).toEqual(['docs/runbook.md', 'docs/without-role.md']);
    // With more documentFolders the others count too
    const more = I.makeIndex(INDEX, reg, QUEUE, { exists, folders: ['docs', 'governance'] });
    expect(more.newOnes).toEqual(['docs/runbook.md', 'docs/without-role.md', 'governance/x.md']);
  });

  it('index file: default docs/INDEX.md when the configuration says nothing', () => {
    expect(I.INDEX_DEFAULT).toBe('docs/INDEX.md');
    expect(I.indexFile()).toBe('docs/INDEX.md');
  });

  it('many entries are shown as a count with a search command', () => {
    const many = Array.from({ length: I.MAX_ENTRIES_ON_LINE + 1 }, (_, i) =>
      entry(`PL-M${i}`, 'beta', [{ path: 'docs/b-plan.md', role: 'plan' }]),
    );
    const r = I.makeIndex(INDEX, { entries: many }, QUEUE);
    expect(r.text).toContain(
      `  Plan entries: ${many.length} entries, see \`node scripts/orchestrator/queue.mjs plan show --search docs/b-plan.md\`.`,
    );
  });
});

describe('make-index.mjs', () => {
  const SCRIPT = join(__dirname, '..', '..', 'make-index.mjs');
  let folder: string;
  let queue: string;
  let index: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'make-index-'));
    queue = join(folder, 'queue');
    mkdirSync(queue);
    mkdirSync(join(folder, 'root', 'docs'), { recursive: true });
    index = join(folder, 'root', 'docs', 'INDEX.md');
    writeFileSync(index, INDEX);
    writeFileSync(join(folder, 'root', 'docs', 'new-plan.md'), '# New\n');
    writeFileSync(join(queue, 'queue.json'), JSON.stringify(QUEUE));
    writeFileSync(
      join(queue, 'plans.json'),
      JSON.stringify({
        entries: [
          entry('PL-A', 'export', [{ path: 'docs/a-plan.md', role: 'plan' }]),
          entry('PL-N', 'beta', [{ path: 'docs/new-plan.md', role: 'plan' }]),
        ],
      }),
    );
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  function run(args: string[], queueFolder = queue): { code: number; out: string } {
    try {
      const out = execFileSync(process.execPath, [SCRIPT, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: queueFolder,
          QUEUE_INDEX_FILE: index,
          QUEUE_DOC_ROOT: join(folder, 'root'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (e) {
      const f = e as { status: number; stdout: string; stderr: string };
      return { code: f.status, out: `${f.stdout}${f.stderr}` };
    }
  }

  it('--check reports drift with exit 1 and writes nothing; --dry gives exit 0', () => {
    const s = run(['--check']);
    expect(s.code).toBe(1);
    expect(s.out).toMatch(/DRIFT/);
    expect(s.out).toMatch(/docs\/new-plan\.md/);
    expect(run(['--dry']).code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(INDEX);
  });

  it('writes INDEX, and then --check is green', () => {
    const w = run([]);
    expect(w.code).toBe(0);
    expect(w.out).toMatch(/wrote/);
    const fresh = readFileSync(index, 'utf8');
    expect(fresh).toContain('## Beta');
    expect(fresh).toContain('- `docs/new-plan.md`: Title PL-N');
    const s = run(['--check']);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/OK/);
  });

  it('without a register --check skips with exit 0 (CI, clean clone)', () => {
    const s = run(['--check'], join(folder, 'exists-not'));
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/skipping/);
  });

  it('an unknown line in the body stops with exit 2 and leaves the file alone', () => {
    writeFileSync(index, `${INDEX}Loose text\n`);
    expect(run([]).code).toBe(2);
    expect(readFileSync(index, 'utf8')).toBe(`${INDEX}Loose text\n`);
  });

  it('an unknown option gives exit 2', () => {
    expect(run(['--error']).code).toBe(2);
  });
});
