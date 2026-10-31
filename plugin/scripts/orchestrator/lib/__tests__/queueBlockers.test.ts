// =============================================================
// queueBlockers.test.ts: blocker reasons with clustering (`cq block`, `cq unblock`, `cq blockers`, merge auto-opening).
//
// Why: "why was the queue stuck last week" had no answer except reading logs. A task now records
// `blocks: [{ code, from, to?, note? }]` with codes from ONE fixed table (queueLogic.BLOCK_CODES), so the reasons can be
// counted and timed per code. The rules are in queueLogic (openBlock, closeBlock, blockerSummary); queue.mjs only does the
// I/O, and merge opens merge-conflict / gate-red when it stops there. Tested pure and against a temporary repo with an
// injected merge runner (QUEUE_MERGE_RUNNING: no real merge, push or gates; never the main repo or the real queue).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Block = { code: string; from: string; to?: string; note?: string };
type Task = Record<string, unknown> & { id: string; status: string; blocks?: Block[] };
type Row = { code: string; count: number; ms: number; open: number };

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic') as {
  BLOCK_CODES: { code: string; text: string }[];
  openBlockOf: (o: Task) => Block | null;
  openBlock: (
    o: Task,
    code: string,
    option?: { now?: number; note?: string | null },
  ) => { block: Block; closed: Block | null; kept: boolean } | { error: string };
  closeBlock: (o: Task, option?: { now?: number }) => Block | null;
  blockerSummary: (queue: { tasks: Task[] }, option?: { now?: number; days?: number }) => Row[];
  blockerLines: (summary: Row[], option?: { days?: number }) => string[];
};

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('blocker reasons (pure)', () => {
  it('the fixed table has exactly the agreed codes', () => {
    expect(L.BLOCK_CODES.map((b) => b.code)).toEqual([
      'merge-conflict',
      'gate-red',
      'context',
      'quota',
      'owner-question',
      'dependency',
      'no-agent',
      'silent',
      'other',
    ]);
  });

  it('opens and closes one block; an unknown code is refused', () => {
    const o: Task = { id: 'A', status: 'running' };
    expect(L.openBlock(o, 'nope')).toHaveProperty('error');
    const r = L.openBlock(o, 'context', { now: NOW, note: '  ran   out ' });
    expect(r).toMatchObject({ kept: false, closed: null, block: { code: 'context', from: iso(NOW), note: 'ran out' } });
    expect(L.openBlockOf(o)?.code).toBe('context');
    const c = L.closeBlock(o, { now: NOW + H });
    expect(c).toEqual({ code: 'context', from: iso(NOW), to: iso(NOW + H), note: 'ran out' });
    expect(L.openBlockOf(o)).toBeNull();
    expect(L.closeBlock(o)).toBeNull();
  });

  it('at most one open: the same code keeps the start, another code closes the open one', () => {
    const o: Task = { id: 'A', status: 'running' };
    L.openBlock(o, 'quota', { now: NOW });
    const same = L.openBlock(o, 'quota', { now: NOW + H }) as { block: Block; kept: boolean };
    expect(same.kept).toBe(true);
    expect(same.block.from).toBe(iso(NOW));
    const other = L.openBlock(o, 'dependency', { now: NOW + 2 * H }) as { closed: Block };
    expect(other.closed).toMatchObject({ code: 'quota', to: iso(NOW + 2 * H) });
    expect(o.blocks!.filter((b) => !b.to).map((b) => b.code)).toEqual(['dependency']);
  });

  it('the summary: count and time inside the window per code, open ones up to now, top first', () => {
    const tasks: Task[] = [
      // 2 h of gate-red, closed.
      { id: 'A', status: 'running', blocks: [{ code: 'gate-red', from: iso(NOW - 5 * H), to: iso(NOW - 3 * H) }] },
      // An open context block of 4 h, and an old one outside the window.
      {
        id: 'B',
        status: 'running',
        blocks: [
          { code: 'context', from: iso(NOW - 4 * H) },
          { code: 'quota', from: iso(NOW - 20 * 24 * H), to: iso(NOW - 19 * 24 * H) },
        ],
      },
      // Started before the window: only the part inside counts (1 day).
      { id: 'C', status: 'waiting', blocks: [{ code: 'gate-red', from: iso(NOW - 8 * 24 * H), to: iso(NOW - 6 * 24 * H) }] },
      // Left open on a task that is done: stops counting at done.
      { id: 'D', status: 'done', done: iso(NOW - 2 * H), blocks: [{ code: 'silent', from: iso(NOW - 3 * H) }] },
    ];
    const s = L.blockerSummary({ tasks }, { now: NOW, days: 7 });
    expect(s).toEqual([
      { code: 'gate-red', count: 2, ms: 2 * H + 24 * H, open: 0 },
      { code: 'context', count: 1, ms: 4 * H, open: 1 },
      { code: 'silent', count: 1, ms: H, open: 0 },
    ]);
    const lines = L.blockerLines(s, { days: 7 });
    expect(lines[0]).toMatch(/last 7 days/);
    expect(lines[1]).toMatch(/^\s+gate-red\s+2\s+26 h 0 min$/);
    expect(lines[2]).toContain('(1 open)');
    expect(L.blockerLines([], { days: 3 })).toEqual(['No blockers recorded in the last 3 days.']);
  });
});

describe('queue.mjs block, unblock, blockers and merge (against a temporary repo)', () => {
  it('records blockers by hand and from a stopped merge, and the next merge closes them', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-blockers-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    const scratch = path.join(folder, 'scratch');
    fs.mkdirSync(repo);
    fs.mkdirSync(scratch);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    const head = g(['rev-parse', 'main']);
    g(['switch', '-q', '-c', 'queue/K']);
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.writeFileSync(path.join(repo, 'lib', 'k.ts'), 'export const k = 1;\n');
    g(['add', '--', 'lib/k.ts']);
    g(['commit', '-q', '-m', 'K']);
    g(['switch', '-q', 'main']);
    const created = new Date(Date.now() - 86_400_000).toISOString();
    const task = (id: string, extra: Record<string, unknown>) => ({
      id,
      title: `Task ${id}`,
      domain: `dom-${id}`,
      class: 'K',
      value: 5,
      content_min: 60,
      migr_tens: 0,
      depends_on: [],
      waiting_on: [],
      owned_files: [`lib/${id}.ts`],
      added_at: created,
      ...extra,
    });
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created,
        limits: {},
        next_migr: 3600,
        resolved: [],
        tasks: [
          task('K', { status: 'review', branch: 'queue/K', head_start: head, scratchpad: scratch, started: created }),
          task('W', { status: 'waiting' }),
        ],
      }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({}));
    const scenarioFile = path.join(folder, 'scenario.json');
    const runningFile = path.join(folder, 'running.mjs');
    fs.writeFileSync(
      runningFile,
      [
        "import fs from 'node:fs';",
        'export default function run(x) {',
        "  const sc = JSON.parse(fs.readFileSync(process.env.MERGE_TEST_SCENARIO, 'utf8'));",
        "  return sc[x.step] ?? { code: 0, out: 'ok' };",
        '}',
      ].join('\n'),
    );
    const scenario = (s: Record<string, { code: number; out: string }>) =>
      fs.writeFileSync(scenarioFile, JSON.stringify(s));
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
      QUEUE_MERGE_RUNNING: runningFile,
      MERGE_TEST_SCENARIO: scenarioFile,
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const blocksOf = (id: string) =>
      (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as { tasks: Task[] }).tasks.find(
        (o) => o.id === id,
      )?.blocks ?? [];

    // By hand: block, the same again, unblock; an unknown code is refused and nothing is written.
    expect(run('block', 'W', 'nope').code).not.toBe(0);
    expect(blocksOf('W')).toEqual([]);
    const b = run('block', 'W', 'owner-question', '--note', 'which provider');
    expect(b.code).toBe(0);
    expect(b.out).toContain('W: blocked by owner-question');
    expect(run('block', 'W', 'owner-question').out).toContain('already blocked');
    expect(blocksOf('W')).toEqual([expect.objectContaining({ code: 'owner-question', note: 'which provider' })]);
    expect(run('unblock', 'W').out).toContain('owner-question closed');
    expect(blocksOf('W')[0].to).toBeTruthy();
    expect(run('unblock', 'W').out).toContain('no open blocker');

    // merge stops in the gates: gate-red is opened.
    scenario({ merge: { code: 0, out: 'Merged' }, gates: { code: 1, out: 'FAIL lint' } });
    const m1 = run('merge', 'K', '--without-fill');
    expect(m1.code).toBe(1);
    expect(m1.out).toContain('Blocker gate-red opened on K');
    expect(blocksOf('K').map((x) => [x.code, !!x.to])).toEqual([['gate-red', false]]);
    // merge stops in the merge step: gate-red is closed, merge-conflict opened (one open at a time).
    scenario({ merge: { code: 1, out: 'CONFLICT (content): lib/k.ts' } });
    expect(run('merge', 'K', '--without-fill').code).toBe(1);
    expect(blocksOf('K').map((x) => [x.code, !!x.to])).toEqual([
      ['gate-red', true],
      ['merge-conflict', false],
    ]);
    // The next merge goes through: the open one is closed.
    scenario({ merge: { code: 0, out: 'Merged' }, gates: { code: 0, out: 'gates: OK' }, done: { code: 0, out: 'done' } });
    const m3 = run('merge', 'K', '--without-fill');
    expect(m3.code).toBe(0);
    expect(blocksOf('K').every((x) => !!x.to)).toBe(true);

    // blockers: one row per code, as text and JSON.
    const text = run('blockers', '--days', '7');
    expect(text.out).toMatch(/^\s+owner-question\s+1\s/m);
    expect(text.out).toMatch(/^\s+gate-red\s+1\s/m);
    expect(text.out).toMatch(/^\s+merge-conflict\s+1\s/m);
    const json = JSON.parse(run('blockers', '--json').out) as { days: number; blockers: Row[] };
    expect(json.days).toBe(7);
    expect(json.blockers.map((r) => r.code).sort()).toEqual(['gate-red', 'merge-conflict', 'owner-question']);
    expect(run('blockers', '--days', '0').code).not.toBe(0);
  });
});
