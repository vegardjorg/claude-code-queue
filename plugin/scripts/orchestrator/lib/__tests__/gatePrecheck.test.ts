// =============================================================
// gatePrecheck.test.ts: the fail-fast precheck (`cq gates --precheck`, lib/gatePrecheck.js and gates.mjs).
//
// Locks: the checks run in the fixed order and stop at the first red one (the rest are NOT RUN), {changed} and {file}
// expand to the relevant changed files, a check is skipped when no changed file is relevant (only .md changed: no
// tests), the time budget gives TIMEOUT with a clear message, the standard checks follow what the project has, and
// --json gives a machine-readable summary. The logic tests use a fake `run` (no real runs); the end-to-end test runs
// gates.mjs in a small git fixture with `node --check` only.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checksFrom, errorLines, planCheck, precheckLines, runPrecheck, standardChecks } from '../gatePrecheck';

type Run = { status: number | null; out: string; timedOut?: boolean };

/** A fake run: answers per command (first matching key), and remembers what was run. */
function fakeRun(answers: Record<string, Run>, fallback: Run = { status: 0, out: '' }) {
  const ran: string[] = [];
  const run = (command: string) => {
    ran.push(command);
    const key = Object.keys(answers).find((k) => command.includes(k));
    return key ? answers[key] : fallback;
  };
  return { ran, run };
}

/** A clock the test moves: each run takes `step` ms. */
function clock(step = 1000) {
  let t = 0;
  return { now: () => t, tick: () => (t += step) };
}

const nothing = () => false;

describe('checksFrom and standardChecks', () => {
  it('gates.precheck as a list: strings and objects, the global budget as the default', () => {
    const c = checksFrom(
      {
        precheckBudgetSec: 30,
        precheck: ['npm run typecheck', { name: 'lint', command: 'eslint {changed}', files: ['*.ts'], budgetSec: 5 }, {}, ''],
      },
      nothing,
    );
    expect(c).toEqual([
      { name: 'npm run typecheck', command: 'npm run typecheck', files: undefined, budgetSec: 30 },
      { name: 'lint', command: 'eslint {changed}', files: ['*.ts'], budgetSec: 5 },
    ]);
  });
  it('[] turns the precheck off; null gives the standard checks', () => {
    expect(checksFrom({ precheck: [] }, nothing)).toEqual([]);
    expect(checksFrom({ precheck: null }, nothing).map((c) => c.name)).toEqual(['syntax (node --check)']);
  });
  it('the standard checks follow what the project has, in the fixed order, with local tools only', () => {
    const has = (files: string[]) => (f: string) => files.includes(f);
    expect(standardChecks(nothing).map((c) => c.command)).toEqual(['node --check {file}']);
    const all = standardChecks(
      has(['tsconfig.json', 'node_modules/.bin/tsc', 'eslint.config.js', 'node_modules/.bin/eslint.cmd', 'node_modules/.bin/vitest']),
    );
    expect(all.map((c) => c.command)).toEqual([
      'node --check {file}',
      'npx tsc --noEmit',
      'npx eslint {changed}',
      'npx vitest related --run --passWithNoTests {changed}',
    ]);
    // tsconfig without a local tsc: no tsc (npx would fetch it from the network); jest when there is no vitest.
    expect(standardChecks(has(['tsconfig.json', 'node_modules/.bin/jest'])).map((c) => c.command)).toEqual([
      'node --check {file}',
      'npx jest --findRelatedTests --passWithNoTests {changed}',
    ]);
  });
});

describe('planCheck: {changed}, {file} and skips', () => {
  const changed = ['src/a.ts', 'src/b c.js', 'docs/x.md'];
  it('{changed} gives one command with the relevant files quoted', () => {
    expect(planCheck({ command: 'eslint {changed}', files: ['*.ts', '*.js'] }, changed)).toEqual({
      commands: ['eslint "src/a.ts" "src/b c.js"'],
    });
    // Without files: all changed files.
    expect(planCheck({ command: 'check {changed}' }, changed).commands).toEqual([
      'check "src/a.ts" "src/b c.js" "docs/x.md"',
    ]);
  });
  it('{file} gives one command per relevant file', () => {
    expect(planCheck({ command: 'node --check {file}', files: ['*.js'] }, changed)).toEqual({
      commands: ['node --check "src/b c.js"'],
    });
  });
  it('skips when no changed file is relevant, and when nothing changed at all', () => {
    expect(planCheck({ command: 'vitest related {changed}', files: ['*.ts'] }, ['README.md', 'docs/a.md'])).toEqual({
      skip: 'no relevant changed files',
    });
    expect(planCheck({ command: 'npm run typecheck' }, []).skip).toMatch(/nothing changed/);
    // A check without files and placeholder runs as it is when something changed.
    expect(planCheck({ command: 'npm run typecheck' }, ['README.md'])).toEqual({ commands: ['npm run typecheck'] });
  });
});

describe('runPrecheck: order, stop at the first red, budget', () => {
  const checks = checksFrom(
    {
      precheck: [
        { name: 'syntax', command: 'node --check {file}', files: ['*.js'] },
        { name: 'types', command: 'tsc --noEmit', files: ['*.ts'] },
        { name: 'lint', command: 'eslint {changed}' },
        { name: 'tests', command: 'vitest related {changed}', files: ['*.ts', '*.js'] },
      ],
    },
    nothing,
  );
  it('runs in the fixed order when all are green', async () => {
    const f = fakeRun({});
    const r = await runPrecheck({ checks, changed: ['a.ts', 'b.js'], run: f.run });
    expect(r).toMatchObject({ ok: true, status: 'GREEN', stoppedAt: null });
    expect(f.ran).toEqual(['node --check "b.js"', 'tsc --noEmit', 'eslint "a.ts" "b.js"', 'vitest related "a.ts" "b.js"']);
  });
  it('stops at the first red one: the rest are NOT RUN, and the error lines are kept', async () => {
    const out = 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number.\nFound 1 error.';
    const f = fakeRun({ tsc: { status: 2, out } });
    const r = await runPrecheck({ checks, changed: ['a.ts', 'b.js'], run: f.run });
    expect(r).toMatchObject({ ok: false, status: 'RED', stoppedAt: 'types' });
    expect(f.ran).toEqual(['node --check "b.js"', 'tsc --noEmit']);
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(['GREEN', 'RED', 'NOT RUN', 'NOT RUN']);
    expect(r.results[1].errors[0]).toContain('error TS2322');
    expect(r.results[1].exit).toBe(2);
  });
  it('{file}: stops at the first red file', async () => {
    const f = fakeRun({ 'b.js': { status: 1, out: 'b.js:1\nSyntaxError: Unexpected token' } });
    const r = await runPrecheck({ checks: checks.slice(0, 1), changed: ['a.js', 'b.js', 'c.js'], run: f.run });
    expect(f.ran).toEqual(['node --check "a.js"', 'node --check "b.js"']);
    expect(r.results[0]).toMatchObject({ status: 'RED', command: 'node --check "b.js"' });
    expect(r.results[0].errors).toEqual(['b.js:1', 'SyntaxError: Unexpected token']);
  });
  it('only .md changed: everything is skipped and the precheck is green', async () => {
    const f = fakeRun({});
    const r = await runPrecheck({
      checks: [checks[0], checks[1], checks[3]],
      changed: ['README.md'],
      run: f.run,
    });
    expect(f.ran).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.results.every((x: { status: string }) => x.status === 'SKIP')).toBe(true);
  });
  it('the time budget: a timed out run gives TIMEOUT with a clear message, and stops', async () => {
    const f = fakeRun({ tsc: { status: null, out: '', timedOut: true } });
    const r = await runPrecheck({ checks, changed: ['a.ts'], run: f.run });
    expect(r).toMatchObject({ ok: false, status: 'TIMEOUT', stoppedAt: 'types' });
    expect(r.results[1].reason).toMatch(/over its budget of 120 s.*not a code error/);
    expect(f.ran).toEqual(['tsc --noEmit']);
  });
  it('the budget covers all the commands of a {file} check, and the run gets what is left', async () => {
    const c = clock(1500);
    const timeouts: number[] = [];
    const run = (_command: string, o: { timeoutMs: number }) => {
      timeouts.push(o.timeoutMs);
      c.tick();
      return { status: 0, out: '' };
    };
    const one = checksFrom({ precheck: [{ name: 'syntax', command: 'node --check {file}', budgetSec: 2 }] }, nothing);
    const r = await runPrecheck({ checks: one, changed: ['a.js', 'b.js', 'c.js'], run, now: c.now });
    expect(timeouts).toEqual([2000, 500]); // the third file never starts: the budget is spent
    expect(r).toMatchObject({ status: 'TIMEOUT', stoppedAt: 'syntax' });
  });
});

describe('errorLines and precheckLines', () => {
  it('error lines: error-like lines and file positions first, otherwise the tail; colors and the root removed', () => {
    const root = 'C:/repo';
    const out = '\u001b[31m FAIL \u001b[39m C:/repo/src/a.test.ts > adds\nAssertionError: expected 1 to be 2\nsome noise';
    expect(errorLines(out, root)).toEqual([' FAIL  src/a.test.ts > adds', 'AssertionError: expected 1 to be 2']);
    expect(errorLines('one\ntwo\nthree', undefined, 2)).toEqual(['two', 'three']);
  });
  it('one line per check with time and status, the error lines under a red one, and the final line', async () => {
    const checks = checksFrom({ precheck: [{ name: 'a', command: 'x {changed}', files: ['*.ts'] }, 'y', 'z'] }, nothing);
    const f = fakeRun({ y: { status: 1, out: 'error: broken' } });
    const r = await runPrecheck({ checks, changed: ['README.md'], run: f.run });
    const text = precheckLines(r, { changedCount: 1, base: 'main', totalSec: 2 }).join('\n');
    expect(text).toMatch(/^precheck: 1 changed file\(s\) against main/);
    expect(text).toMatch(/^a +SKIP \(no relevant changed files\)$/m);
    expect(text).toMatch(/^y +RED 0 s$/m);
    expect(text).toMatch(/^ {2}error: broken$/m);
    expect(text).toMatch(/^z +NOT RUN \(stopped at y\)$/m);
    expect(text).toMatch(/PRECHECK RED at "y"/);
  });
});

// ---- gates.mjs end to end, in a small git fixture (node --check only, no long runs) ----
describe('gates.mjs --precheck (end to end)', () => {
  const gates = path.resolve(__dirname, '..', '..', 'gates.mjs');
  it('red on a syntax error with exit 1, green and --json after the fix, usage error with two modes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-precheck-'));
    try {
      const sh = (...a: string[]) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
      sh('init', '-q', '-b', 'main');
      sh('config', 'user.email', 't@example.com');
      sh('config', 'user.name', 'test');
      fs.writeFileSync(
        path.join(root, 'queue.config.json'),
        JSON.stringify({
          baseBranch: 'main',
          gates: { quick: [], full: [], precheck: [{ command: 'node --check {file}', files: ['*.js'] }] },
        }),
      );
      fs.writeFileSync(path.join(root, 'ok.js'), 'const a = 1;\n');
      sh('add', '-A');
      sh('commit', '-q', '-m', 'init');
      sh('checkout', '-q', '-b', 'queue/X');
      fs.writeFileSync(path.join(root, 'bad.js'), 'const b = ;\n');
      fs.writeFileSync(path.join(root, 'notes.md'), 'text\n');
      const env = { ...process.env, QUEUE_ROOT: root, QUEUE_CONFIG: path.join(root, 'queue.config.json') };
      const run = (...a: string[]) => spawnSync(process.execPath, [gates, ...a], { cwd: root, encoding: 'utf8', env });

      const red = run('--precheck');
      expect(red.status, red.stderr).toBe(1);
      expect(red.stdout).toMatch(/node --check \{file\} +RED/);
      expect(red.stdout).toContain('SyntaxError');
      expect(red.stdout).toMatch(/PRECHECK RED/);

      fs.writeFileSync(path.join(root, 'bad.js'), 'const b = 2;\n');
      const green = run('--precheck', '--json');
      expect(green.status, green.stdout + green.stderr).toBe(0);
      const j = JSON.parse(green.stdout);
      expect(j).toMatchObject({ ok: true, status: 'GREEN', base: 'main', stoppedAt: null });
      expect(j.changed).toEqual(['bad.js', 'notes.md']);
      expect(j.checks).toEqual([expect.objectContaining({ name: 'node --check {file}', status: 'GREEN', commands: 1 })]);

      expect(run('--precheck', '--full').status).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
