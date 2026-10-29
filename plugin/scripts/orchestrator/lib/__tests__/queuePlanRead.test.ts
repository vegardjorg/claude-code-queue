// =============================================================
// queuePlanRead.test.ts: the read view of documents and the Unregistered box in the Plans room (see docs/board.md).
//
// Render tests do not work here, so the rules are pure functions in lib/queuePlanView.js (the same file the
// browser loads) and are tested directly: the allowlist and the path guard for /api/doc, the links in a document, the markdown
// blocks (HTML becomes text), the anchors, the groups in the box, the suggestion for a new entry and the forms. The path guard on disk
// (queueBoard.readDocument) runs against a temporary folder with a junction/symlink, a hidden file and a too large file.
// The arguments to `queue.mjs plan new` and `plan edit --set {sources}` run against queue.mjs on a copy (preview,
// writing as owner with --expect-changed, and an outdated version). At the end we read read.js, plans.js, index.html and
// queue-board.mjs as text for the wiring.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../queuePlanView.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');

describe('readPathError: the allowlist for /api/doc', () => {
  afterEach(() => V.setReadFolders(null));

  it('lets through markdown under the document folders (default docs/)', () => {
    expect(V.READ_FOLDERS).toEqual(['docs/']);
    for (const s of [
      'docs/plan-register.md',
      'docs/notes/board-plan-2026-10-10.md',
      'docs/a/b/c.md',
      'docs/README.MD',
    ])
      expect([s, V.readPathError(s)]).toEqual([s, null]);
  });

  it('the document folders can be set (from the configuration), and invalid folders are dropped', () => {
    expect(V.setReadFolders(['docs', 'governance/', '../out', '.hidden', 'C:/x', 42])).toEqual([
      'docs/',
      'governance/',
    ]);
    expect(V.readPathError('governance/a/b.md')).toBeNull();
    expect(V.readPathError('other/x.md')).toContain('docs/, governance/');
    // An empty list gives the default back
    expect(V.setReadFolders([])).toEqual(['docs/']);
  });

  it('rejects .., hidden files, .env, other file types, absolute paths and folders outside the allowlist', () => {
    for (const s of [
      '',
      '../docs/x.md',
      'docs/../.env',
      'docs/./x.md',
      'docs//x.md',
      '/docs/x.md',
      'C:/projects/Alpha/docs/x.md',
      'docs\\x.md',
      '.env',
      'docs/.env',
      'docs/.hidden.md',
      'docs/.git/x.md',
      'docs/x.env',
      'docs/x.md.back',
      'docs/x.txt',
      'docs/x.md:stream',
      'docs/x.md.',
      'docs/x.md ',
      'docs/PROGRA~1.md',
      'scripts/x.md',
      'db/CLAUDE.md',
      'admin/x.md',
      'docsx/y.md',
      'governance',
      'docs/x\u0000.md',
      'docs/line\nbreak.md',
      `docs/${'a'.repeat(400)}.md`,
    ])
      expect([s, V.readPathError(s)]).not.toEqual([s, null]);
    expect(V.readPathError(null)).toBe('missing path');
    expect(V.readPathError(42)).toBe('missing path');
  });
});

describe('linkMeasure: links in a document', () => {
  it('relative .md links become documents (with anchor), otherwise text', () => {
    expect(V.linkMeasure('docs/notes/a.md', '../b.md#3.4')).toEqual({
      type: 'doc',
      path: 'docs/b.md',
      anchor: '3.4',
    });
    expect(V.linkMeasure('docs/a.md', 'notes/c.md')).toEqual({
      type: 'doc',
      path: 'docs/notes/c.md',
      anchor: null,
    });
    expect(V.linkMeasure('docs/a.md', '/docs/x.md')).toEqual({
      type: 'doc',
      path: 'docs/x.md',
      anchor: null,
    });
    // Outside the document folders there is no readable link
    expect(V.linkMeasure('docs/a.md', '/governance/x.md').type).toBe('another');
    expect(V.linkMeasure('docs/a.md', '#section')).toEqual({ type: 'anchor', anchor: 'section' });
    expect(V.linkMeasure('docs/a.md', 'https://law.example.org/x')).toEqual({
      type: 'external',
      url: 'https://law.example.org/x',
    });
    for (const h of [
      'javascript:alert(1)',
      'data:text/html,x',
      'mailto:a@b.no',
      '../../../.env',
      '../../scripts/x.js',
      '../.git/config',
      'x.ts',
      '%zz.md',
      '',
    ])
      expect([h, V.linkMeasure('docs/a.md', h).type]).toEqual([h, 'another']);
  });
});

describe('markdownBlocks and inlineParts', () => {
  it('headings, paragraph, lists with levels, code, quote, table and divider', () => {
    const b = V.markdownBlocks(
      [
        '---',
        'title: x',
        '---',
        '# Title',
        '',
        'First line',
        'continues here.',
        '',
        '- a',
        '  - a1',
        '- b',
        '',
        '1. one',
        '2. two',
        '',
        '```js',
        'const x = "<b>";',
        '```',
        '> quote',
        '',
        '| A | B |',
        '|---|---|',
        '| 1 | `x|y` |',
        '',
        '***',
        '## 3.4 Maturity ##',
      ].join('\r\n'),
    );
    expect(b.map((x: { type: string }) => x.type)).toEqual([
      'code',
      'heading',
      'paragraph',
      'list',
      'list',
      'code',
      'quote',
      'table',
      'line',
      'heading',
    ]);
    expect(b[1]).toEqual({ type: 'heading', level: 1, text: 'Title' });
    expect(b[2].text).toBe('First line continues here.');
    expect(b[3].points.map((p: { level: number; text: string }) => [p.level, p.text])).toEqual([
      [0, 'a'],
      [1, 'a1'],
      [0, 'b'],
    ]);
    expect(b[4].points.map((p: { sorted: boolean; nr: number }) => [p.sorted, p.nr])).toEqual([
      [true, 1],
      [true, 2],
    ]);
    expect(b[5]).toEqual({ type: 'code', language: 'js', text: 'const x = "<b>";' });
    expect(b[7]).toEqual({ type: 'table', header: ['A', 'B'], rows: [['1', '`x|y`']] });
    expect(b[9]).toEqual({ type: 'heading', level: 2, text: '3.4 Maturity' });
  });

  it('HTML stays as text, and emphasis, code and links are split up', () => {
    expect(V.inlineParts('<script>alert(1)</script>')).toEqual([
      { type: 'text', text: '<script>alert(1)</script>' },
    ]);
    const d = V.inlineParts(
      'See **bold `code`** and *italic*, [plan](../a.md) and snake_case_name \\*.',
    );
    expect(d.map((x: { type: string }) => x.type)).toEqual([
      'text',
      'bold',
      'text',
      'italic',
      'text',
      'link',
      'text',
    ]);
    expect(d[1].parts).toEqual([
      { type: 'text', text: 'bold ' },
      { type: 'code', text: 'code' },
    ]);
    expect(d[5]).toEqual({ type: 'link', text: 'plan', template: '../a.md' });
    expect(d[6].text).toBe(' and snake_case_name *.');
    expect(V.cleanText('![logo](x.png) <https://a.no>')).toBe('[image: logo] https://a.no');
  });

  it('anchorIndex finds § 3.4, text in the heading and #slug', () => {
    const b = V.markdownBlocks('# Plan\n\n## 3.4 Maturity and built\n\n### Unregistered box');
    expect(V.anchorIndex(b, '§ 3.4')).toBe(1);
    expect(V.anchorIndex(b, 'maturity')).toBe(1);
    expect(V.anchorIndex(b, 'unregistered-box')).toBe(2);
    expect(V.anchorIndex(b, 'does not exist')).toBe(-1);
    expect(V.anchorIndex(b, '')).toBe(-1);
  });
});

describe('the Unregistered box: groups, suggestions and the forms', () => {
  it('groups by document folder (the longest first), and removes empty groups', () => {
    const folders = ['docs/', 'docs/notes/', 'governance/'];
    const g = V.unregisteredGroups(
      ['docs/b.md', 'docs/notes/a.md', 'governance/analyse/c.md', 'docs/b.md', 'other.md'],
      folders,
    );
    expect(g.map((x: { id: string; paths: string[] }) => [x.id, x.paths])).toEqual([
      ['docs/notes', ['docs/notes/a.md']],
      ['governance', ['governance/analyse/c.md']],
      ['docs', ['docs/b.md']],
      ['other', ['other.md']],
    ]);
    expect(V.unregisteredGroups([])).toEqual([]);
    // Default: the folders the read view uses
    expect(V.unregisteredGroups(['docs/x.md']).map((x: { id: string }) => x.id)).toEqual(['docs']);
  });

  it('suggests an available id and title from the file name', () => {
    expect(V.entrySuggestion('docs/notes/api-swap-draft-2026-10-10.md', new Set())).toEqual({
      id: 'PL-API-SWAP-DRAFT-1',
      title: 'Api swap draft',
    });
    expect(V.entrySuggestion('docs/export_board.md', ['PL-EXPORT-BOARD-1']).id).toBe(
      'PL-EXPORT-BOARD-2',
    );
    expect(P.validateEntry).toBeDefined();
  });

  it('newEntryFromForm makes a valid entry, and rejects junk', () => {
    const { entry, error } = V.newEntryFromForm(
      {
        id: 'PL-X-1',
        title: ' Title ',
        project: 'export',
        priority: 'now',
        category: 'security',
      },
      'docs/x.md',
    );
    expect(error).toEqual([]);
    expect(entry).toEqual({
      id: 'PL-X-1',
      title: 'Title',
      project: 'export',
      priority: 'now',
      now_category: ['security'],
      maturity: 'idea',
      sources: [{ path: 'docs/x.md' }],
    });
    const no = V.newEntryFromForm(
      { id: 'x', title: '', project: '', priority: 'drop' },
      '../.env',
    );
    expect(no.entry).toBeNull();
    expect(no.error.length).toBeGreaterThanOrEqual(5);
    expect(
      V.newEntryFromForm({ id: 'PL-X-1', title: 'T', project: 'a', priority: 'now' }, 'docs/x.md')
        .error,
    ).toEqual(['Now needs a category (security, before prod or important)']);
  });

  it('sourceBonus keeps the old sources and rejects the same source twice', () => {
    const p = { id: 'PL-A', sources: [{ path: 'docs/a.md', anchor: '§ 1', role: 'plan' }] };
    expect(V.sourceBonus(p, 'docs/b.md', ' § 2 ')).toEqual({
      sources: [
        { path: 'docs/a.md', anchor: '§ 1', role: 'plan' },
        { path: 'docs/b.md', anchor: '§ 2' },
      ],
      error: [],
    });
    expect(V.sourceBonus(p, 'docs/a.md', '§ 1').error).toEqual(['PL-A already has this source']);
    expect(V.sourceBonus(p, 'scripts/x.js', '').error.length).toBe(1);
    expect(V.sourceBonus(null, 'docs/b.md').error).toEqual(['unknown plan entry']);
  });

  it('the arguments: owner choice, the board as sender, --dry or --expect-changed', () => {
    expect(V.newEntryArgs('/tmp/x.json', { dry: true })).toEqual([
      'plan',
      'new',
      '--file',
      '/tmp/x.json',
      '--json',
      '--set-by',
      'owner',
      '--by',
      'theBoard',
      '--dry',
    ]);
    expect(
      V.sourceArgs('PL-A', [{ path: 'docs/a.md' }], { expect: '2026-10-15T00:00:00.000Z' }),
    ).toEqual([
      'plan',
      'edit',
      'PL-A',
      '--set',
      '{"sources":[{"path":"docs/a.md"}]}',
      '--json',
      '--set-by',
      'owner',
      '--by',
      'theBoard',
      '--expect-changed',
      '2026-10-15T00:00:00.000Z',
    ]);
  });
});

describe('queueBoard.readDocument: the path guard on disk', () => {
  let root: string;
  let out: string;
  const io = { fs, path };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'queue-read-'));
    out = mkdtempSync(join(tmpdir(), 'queue-read-out-'));
    mkdirSync(join(root, 'docs', 'notes'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plan.md'), '# Plan\n\nText.');
    writeFileSync(join(root, 'docs', 'notes', 'note.md'), 'internal');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(out, 'secret.md'), 'outside the root');
    mkdirSync(join(root, 'docs', 'folder.md'));
    writeFileSync(join(root, 'docs', 'large.md'), 'x'.repeat(2048));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it('reads markdown in the allowlist', () => {
    const r = T.readDocument(root, 'docs/plan.md', io);
    expect(r).toMatchObject({
      ok: true,
      path: 'docs/plan.md',
      text: '# Plan\n\nText.',
      bytes: 13,
    });
    expect(T.readDocument(root, 'docs/notes/note.md', io)).toMatchObject({
      ok: true,
      text: 'internal',
    });
  });

  it('rejects .env, .., folders, missing files and too large files, without leaking content', () => {
    expect(T.readDocument(root, '.env', io)).toMatchObject({ ok: false, status: 400 });
    expect(T.readDocument(root, 'docs/../.env', io)).toMatchObject({ ok: false, status: 400 });
    expect(T.readDocument(root, 'docs/missing.md', io)).toMatchObject({ ok: false, status: 404 });
    expect(T.readDocument(root, 'docs/folder.md', io)).toMatchObject({ ok: false, status: 404 });
    expect(T.readDocument(root, 'docs/large.md', io, { max: 1024 })).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(JSON.stringify(T.readDocument(root, 'docs/../.env', io))).not.toContain('SECRET');
  });

  it('rejects a symlink or junction out of the root, also when the target is markdown', () => {
    // A junction works without extra rights on Windows; on other platforms it becomes a plain folder symlink.
    symlinkSync(out, join(root, 'docs', 'link'), 'junction');
    const r = T.readDocument(root, 'docs/link/secret.md', io);
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(JSON.stringify(r)).not.toContain('outside the root');
  });

  it('rejects when the path is not the real path (wrong letter case does not give another file)', () => {
    const r = T.readDocument(root, 'docs/PLAN.md', io);
    // Letter case: Windows finds the file, but the real path is a different one (403); Linux does not find it (404).
    expect(r.ok).toBe(false);
    expect([403, 404]).toContain(r.status);
  });
});

describe('queue.mjs plan new and plan edit with the arguments from the box (copy in a temporary folder)', () => {
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
  const projects = { export: { title: 'Export', area: 'alpha' } };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-read-queue-'));
    mkdirSync(join(folder, 'docs'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'new.md'), '# New');
    writeFileSync(join(folder, 'docs', 'a.md'), '# A');
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
    const r = P.newEntry(
      reg,
      {
        id: 'PL-A',
        title: 'Title A',
        project: 'export',
        priority: 'later',
        priority_reason: 'Rule 8: no deadline.',
        maturity: 'investigated',
        sources: [{ path: 'docs/a.md' }],
      },
      { role: 'agent', projects, question: {}, existsPath: () => true },
    );
    if (r.error.length) throw new Error(r.error.join('; '));
    writeFileSync(join(folder, 'plans.json'), JSON.stringify(reg));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('New entry: the preview writes nothing; saving with the version creates the entry as owner', () => {
    const { entry, error } = V.newEntryFromForm(
      { id: 'PL-NEW-1', title: 'New plan', project: 'export', priority: 'owner' },
      'docs/new.md',
    );
    expect(error).toEqual([]);
    const file = join(folder, 'entry.json');
    writeFileSync(file, JSON.stringify(entry));
    const for_ = readFileSync(join(folder, 'plans.json'), 'utf8');
    const dry = run(V.newEntryArgs(file, { dry: true }));
    expect(dry.code).toBe(0);
    expect(dry.data.dry).toBe(true);
    expect(dry.data.changes.length).toBeGreaterThan(0);
    expect(readFileSync(join(folder, 'plans.json'), 'utf8')).toBe(for_);

    const r = run(V.newEntryArgs(file, { expect: dry.data.changed }));
    expect(r.code).toBe(0);
    expect(readReg().entries.find((p: { id: string }) => p.id === 'PL-NEW-1')).toMatchObject({
      priority: 'owner',
      priority_set_by: 'owner',
      maturity: 'idea',
      sources: [{ path: 'docs/new.md' }],
    });
    expect(readReg().changelog.at(-1)).toMatchObject({ by: 'theBoard', action: 'plan new' });
  });

  it('Add as source: the whole list is written, and an outdated version is rejected with exit 6', () => {
    const reg = readReg();
    const p = reg.entries.find((x: { id: string }) => x.id === 'PL-A');
    const { sources } = V.sourceBonus(p, 'docs/new.md', '§ 1');
    const dry = run(V.sourceArgs('PL-A', sources, { dry: true }));
    expect(dry.code).toBe(0);
    expect(dry.data.changes.map((e: { field: string }) => e.field)).toContain('sources');

    const old = run(V.sourceArgs('PL-A', sources, { expect: '2026-01-01T00:00:00.000Z' }));
    expect(old.code).toBe(6);
    expect(old.data.outdated).toBe(true);

    const r = run(V.sourceArgs('PL-A', sources, { expect: dry.data.changed }));
    expect(r.code).toBe(0);
    expect(readReg().entries.find((x: { id: string }) => x.id === 'PL-A').sources).toEqual([
      { path: 'docs/a.md' },
      { path: 'docs/new.md', anchor: '§ 1' },
    ]);
    // The priority the agent set is untouched (only the sources are changed).
    expect(readReg().entries.find((x: { id: string }) => x.id === 'PL-A')).toMatchObject({
      priority: 'later',
      priority_set_by: 'agent',
    });
  });
});

describe('the wiring in the board (read as text)', () => {
  const read = (f: string) => readFileSync(join(CLIENT, f), 'utf8');
  it('read.js draws only with textContent and createElement, and uses the pure functions', () => {
    const js = read(join('plans', 'read.js'));
    expect(js).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|eval\(/);
    for (const f of [
      'markdownBlocks',
      'inlineParts',
      'linkMeasure',
      'anchorIndex',
      'newEntryFromForm',
      'sourceBonus',
    ])
      expect(js).toContain(`V.${f}`);
    expect(js).toContain('/api/doc?path=');
    expect(js).toContain("'/api/plan-check'");
    expect(js).toContain('window.QueuePlanRead');
  });
  it('plans.js, index.html and queue-board.mjs wire in read.js and the routes', () => {
    expect(read(join('plans', 'plans.js'))).toContain('window.QueuePlanRead.sourceTab(readHelp, p)');
    expect(read(join('plans', 'plans.js'))).toContain(
      'window.QueuePlanRead.unregisteredBox(readHelp, d)',
    );
    const html = read('index.html');
    expect(html.indexOf('/plans/read.js')).toBeGreaterThan(0);
    expect(html.indexOf('/plans/read.js')).toBeLessThan(html.indexOf('/plans/plans.js'));
    const mjs = readFileSync(join(CLIENT, '..', 'queue-board.mjs'), 'utf8');
    for (const r of [
      "'/api/doc'",
      "'/api/plan-check'",
      "'/api/plan-new'",
      "'/api/plan-source'",
      "'/plans/read.js'",
    ])
      expect(mjs).toContain(r);
    expect(mjs).toContain('T.readDocument(SOURCE_ROOT');
  });
});
