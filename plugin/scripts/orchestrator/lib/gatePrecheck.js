// =============================================================
// gatePrecheck.js: the precheck before the full gate run (`cq gates --precheck`, gates.mjs).
//
// WHY: a track that only learns about a red error after a long full gate run has spent many minutes (and tokens) on
// waiting. The precheck runs the cheapest checks first, in a fixed order, only on what the track changed, and STOPS at
// the first red one. A red error should show up in 3 to 5 minutes. Only a green precheck goes on to the class's full gate
// (`--quick` or `--full`), which is unchanged.
//
// The checks come from `gates.precheck` in queue.config.json. Each element is a shell command (string) or an object
// { name?, command, files?, budgetSec? }:
//   {changed}  is replaced by the relevant changed files (quoted, separated by spaces), in one command
//   {file}     runs the command once per relevant changed file (e.g. `node --check {file}`)
//   files      path patterns (as for the helpers: "*.ts" = that file name anywhere, "src/" = the folder, "**" = any
//              folders); the relevant files are the changed files that match. Without `files` all changed files are.
//   budgetSec  the time budget for the check (default gates.precheckBudgetSec, 120 s). Over budget: TIMEOUT, stop.
// A check is skipped (SKIP) when no changed file is relevant: when it has `files` or a placeholder and nothing matches,
// and always when nothing at all has changed against the base branch.
// `gates.precheck` null (the default) = the standard checks the project has (standardChecks): syntax check of changed
// .js/.mjs/.cjs, `tsc --noEmit` when tsconfig.json and a local tsc exist, eslint on the changed files when an eslint
// config and a local eslint exist, and the tests related to the changed files (vitest related / jest
// --findRelatedTests) when a local vitest or jest exists. `[]` turns the precheck off (green, nothing to run).
// The standard checks use only local tools (node_modules/.bin), so npx never fetches from the network.
//
// Pure logic: the caller (gates.mjs) gives the changed files, an `exists` function and a `run` function, so the order,
// the stop, the expansion, the skips and the budget are tested without real long runs (lib/__tests__/gatePrecheck.test.ts).
// =============================================================
'use strict';

const { matchesAny } = require('./queueHelpers.js');
const { withoutColors, normalizePath } = require('./orchestratorHelp.js');

/** The default time budget per check (seconds), when neither the check nor gates.precheckBudgetSec says otherwise. */
const BUDGET_SEC = 120;
/** At most this many error lines per red check in the output. */
const ERROR_LINES = 12;

const JS_FILES = ['*.js', '*.mjs', '*.cjs'];
const TS_FILES = ['*.ts', '*.tsx', '*.mts', '*.cts', 'tsconfig*.json'];
const CODE_FILES = ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.mts', '*.cts'];
const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

/** Is there a local bin for the tool (node_modules/.bin/<name>, or <name>.cmd on Windows)? */
const hasBin = (exists, name) =>
  exists(`node_modules/.bin/${name}`) || exists(`node_modules/.bin/${name}.cmd`);

/**
 * The standard checks, in the fixed order, for what the project has. `exists(relPath)` says whether a file exists in
 * the folder the gates run in.
 * @param {(relPath: string) => boolean} exists
 * @returns {{ name: string, command: string, files?: string[], budgetSec?: number }[]}
 */
function standardChecks(exists) {
  const out = [{ name: 'syntax (node --check)', command: 'node --check {file}', files: JS_FILES, budgetSec: 60 }];
  if (exists('tsconfig.json') && hasBin(exists, 'tsc'))
    out.push({ name: 'tsc --noEmit', command: 'npx tsc --noEmit', files: TS_FILES, budgetSec: 180 });
  if (ESLINT_CONFIGS.some((f) => exists(f)) && hasBin(exists, 'eslint'))
    out.push({ name: 'eslint (changed files)', command: 'npx eslint {changed}', files: CODE_FILES, budgetSec: 120 });
  if (hasBin(exists, 'vitest'))
    out.push({
      name: 'related tests (vitest)',
      command: 'npx vitest related --run --passWithNoTests {changed}',
      files: CODE_FILES,
      budgetSec: 180,
    });
  else if (hasBin(exists, 'jest'))
    out.push({
      name: 'related tests (jest)',
      command: 'npx jest --findRelatedTests --passWithNoTests {changed}',
      files: CODE_FILES,
      budgetSec: 180,
    });
  return out;
}

/**
 * The checks to run: gates.precheck from the config (strings or objects), or the standard checks when it is not a
 * list. Elements without a command are dropped.
 * @param {{ precheck?: unknown, precheckBudgetSec?: unknown } | undefined} gates  config().gates
 * @param {(relPath: string) => boolean} exists
 */
function checksFrom(gates, exists) {
  const own = gates?.precheck;
  const budget = Number(gates?.precheckBudgetSec) > 0 ? Number(gates.precheckBudgetSec) : BUDGET_SEC;
  const list = Array.isArray(own) ? own : standardChecks(exists);
  const out = [];
  for (const e of list) {
    const c = typeof e === 'string' ? { command: e } : e && typeof e === 'object' ? e : null;
    if (!c || typeof c.command !== 'string' || !c.command.trim()) continue;
    out.push({
      name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : c.command.trim(),
      command: c.command.trim(),
      files: Array.isArray(c.files) ? c.files.filter((f) => typeof f === 'string' && f) : undefined,
      budgetSec: Number(c.budgetSec) > 0 ? Number(c.budgetSec) : budget,
    });
  }
  return out;
}

/** A file path quoted for the shell (double quotes, which both sh and cmd understand; " inside is escaped). */
const quote = (f) => `"${String(f).replace(/"/g, '\\"')}"`;

/**
 * What one check runs for these changed files: { skip: reason } or { commands: string[] }.
 * {changed} gives one command with all relevant files; {file} one command per file.
 * @param {{ command: string, files?: string[] }} check
 * @param {string[]} changed  the changed files, relative to the folder the gates run in, with "/"
 */
function planCheck(check, changed) {
  if (changed.length === 0) return { skip: 'nothing changed against the base branch' };
  const usesFile = check.command.includes('{file}');
  const usesChanged = check.command.includes('{changed}');
  const relevant = check.files ? changed.filter((f) => matchesAny(f, check.files)) : [...changed];
  if ((check.files || usesFile || usesChanged) && relevant.length === 0)
    return { skip: 'no relevant changed files' };
  const all = relevant.map(quote).join(' ');
  const fill = (s) => s.split('{changed}').join(all);
  if (usesFile) return { commands: relevant.map((f) => fill(check.command.split('{file}').join(quote(f)))) };
  return { commands: [fill(check.command)] };
}

/**
 * The first relevant error lines of a red check: lines that look like an error or a test failure, or point at a
 * file position (file:line); otherwise the last non-empty lines. Colors removed, paths relative to `root`.
 * @param {string} text
 * @param {string} [root]
 * @param {number} [max]
 */
function errorLines(text, root, max = ERROR_LINES) {
  const r = root ? normalizePath(root).replace(/\/$/, '') + '/' : null;
  const lines = withoutColors(text)
    .split(/\r?\n/)
    .map((l) => (r ? l.split(r).join('').split(r.split('/').join('\\')).join('') : l))
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  const errorish =
    /error|fail|✗|×|assert|expected|received|cannot find|unexpected|not defined|\b[A-Za-z0-9_./\\-]+\.[a-z]{1,4}[:(]\d+/i;
  const hit = lines.filter((l) => errorish.test(l));
  const pick = hit.length ? hit.slice(0, max) : lines.slice(-max);
  return pick.map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
}

/**
 * Runs the checks in order and stops at the first one that is not green (RED or TIMEOUT); the rest are not run.
 * `run(command, { timeoutMs })` runs one shell command and gives (or resolves to) { status, out, timedOut }; `now()`
 * gives ms.
 * The budget covers the whole check (all its commands, for {file} one per file).
 * @param {{ checks: ReturnType<typeof checksFrom>, changed: string[],
 *   run: (command: string, o: { timeoutMs: number }) => any,
 *   now?: () => number, root?: string }} o
 * @returns {Promise<{ ok: boolean, status: 'GREEN'|'RED'|'TIMEOUT', stoppedAt: string|null, results: object[] }>}
 */
async function runPrecheck({ checks, changed, run, now = Date.now, root }) {
  const results = [];
  let stoppedAt = null;
  let status = 'GREEN';
  for (const check of checks) {
    if (stoppedAt) {
      results.push({ name: check.name, status: 'NOT RUN', sec: 0, reason: `stopped at ${stoppedAt}` });
      continue;
    }
    const plan = planCheck(check, changed);
    if (plan.skip) {
      results.push({ name: check.name, status: 'SKIP', sec: 0, reason: plan.skip });
      continue;
    }
    const t0 = now();
    const budgetMs = check.budgetSec * 1000;
    let result = { name: check.name, status: 'GREEN', commands: plan.commands.length };
    for (const command of plan.commands) {
      const left = budgetMs - (now() - t0);
      const r = left > 0 ? await run(command, { timeoutMs: left }) : { status: null, out: '', timedOut: true };
      if (r.timedOut) {
        result = {
          ...result,
          status: 'TIMEOUT',
          command,
          reason:
            `over its budget of ${check.budgetSec} s and stopped. This is not a code error: run the class's full ` +
            'gate instead, or raise budgetSec (gates.precheckBudgetSec) for the check.',
        };
        break;
      }
      if (r.status !== 0) {
        result = { ...result, status: 'RED', command, exit: r.status, errors: errorLines(r.out || '', root) };
        break;
      }
    }
    result.sec = (now() - t0) / 1000;
    results.push(result);
    if (result.status !== 'GREEN') {
      stoppedAt = check.name;
      status = result.status;
    }
  }
  return { ok: status === 'GREEN', status, stoppedAt, results };
}

/**
 * The text lines for the terminal: one line per check (name, status, time), the error lines under a red one, and a
 * final line.
 * @param {Awaited<ReturnType<typeof runPrecheck>>} r
 * @param {{ changedCount: number, base: string, totalSec: number }} o
 */
function precheckLines(r, { changedCount, base, totalSec }) {
  const width = Math.min(40, Math.max(10, ...r.results.map((x) => x.name.length)) + 2);
  const out = [`precheck: ${changedCount} changed file(s) against ${base}`];
  for (const x of r.results) {
    const head = `${x.name.padEnd(width)} ${x.status}`;
    if (x.status === 'SKIP' || x.status === 'NOT RUN') out.push(`${head} (${x.reason})`);
    else if (x.status === 'TIMEOUT') out.push(`${head} ${Math.round(x.sec)} s: ${x.reason}`);
    else out.push(`${head} ${Math.round(x.sec)} s`);
    if (x.status === 'RED') {
      out.push(`  command: ${x.command.length > 200 ? `${x.command.slice(0, 199)}…` : x.command}`);
      for (const l of x.errors || []) out.push(`  ${l}`);
    }
  }
  const total = Math.round(totalSec);
  if (r.ok) out.push(`PRECHECK GREEN in ${total} s: go on to the class's full gate.`);
  else
    out.push(
      `PRECHECK ${r.status} at "${r.stoppedAt}" (${total} s): fix it before the full gate${r.status === 'TIMEOUT' ? ', or run the full gate if the check is only slow' : ''}.`,
    );
  return out;
}

module.exports = {
  BUDGET_SEC,
  standardChecks,
  checksFrom,
  planCheck,
  errorLines,
  runPrecheck,
  precheckLines,
};
