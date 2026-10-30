#!/usr/bin/env node
// =============================================================
// gates.mjs: runs the project's gates (config().gates.quick or .full from queue.config.json) in order.
//
// WHY: tracks and the orchestrator must check the work the same way whatever the project. Which commands are
// gates (type check, lint, tests, custom checks) is the project's business and lives in queue.config.json, not here.
//   --quick  what tracks run before delivery (quick checks).
//   --full  what the orchestrator runs after merge and before a batch push (everything).
//
// Runs in process.cwd() when it is the project root or a worktree of the project (a track checks its own
// worktree), otherwise in the project root. Each gate is a shell command; it is green when the exit code is 0.
//
// Output: one line per gate (GREEN/RED + duration, and the first error line for red ones) and a final line.
// Exit 0 when all are green (or no gates are set up), 1 otherwise.
//   --log <file>  writes the whole output of each gate to the file (for debugging without filling the context).
//
//   --precheck  the fail-fast precheck a track runs BEFORE the class's full gate: the cheapest checks first, in a fixed
//               order, only on the files changed against baseBranch (`gates.precheck`, with `{changed}`/`{file}`;
//               standard checks when it is not set), and it STOPS at the first red one. One line per check with time
//               and GREEN/RED/SKIP; under a red one the first error lines. Exit 0 green, 1 red, 3 over a check's time
//               budget (gates.precheckBudgetSec), 2 setup error. --json gives the summary as JSON instead of lines;
//               --base <ref> compares against another ref. The logic lives in lib/gatePrecheck.js.
//
// Use: node scripts/orchestrator/gates.mjs --quick|--full [--log <file>]
//      node scripts/orchestrator/gates.mjs --precheck [--json] [--base <ref>] [--log <file>]
// See docs/orchestration.md.
// =============================================================

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { config } = require('./lib/queueConfig.js');
const { firstErrorLine, gateType, resultLine } = require('./lib/orchestratorHelp.js');

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const full = args.includes('--full');
const precheck = args.includes('--precheck');
if ([quick, full, precheck].filter(Boolean).length !== 1) {
  console.error(
    'use: gates.mjs --quick|--full [--log <file>]\n' +
      '     gates.mjs --precheck [--json] [--base <ref>] [--track-base <sha> --track-tip <sha>] [--log <file>]',
  );
  process.exit(2);
}
const li = args.indexOf('--log');
const logFile = li >= 0 && args[li + 1] ? path.resolve(args[li + 1]) : null;
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const K = config();

/** Is `path` the project root or a worktree of the project (<root>/.claude/worktrees/<name>/...)? */
function inProject(filePath) {
  const rel = path.relative(K.root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const cwd = inProject(process.cwd()) ? process.cwd() : K.root;

if (precheck) process.exit(await precheckMode());

// ---- --precheck: the cheapest checks first, stop at the first red one (lib/gatePrecheck.js) ----------------------------

/** git in the gate folder; stdout, or null when the command failed. */
function git(...a) {
  const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : null;
}

/** Lines of git output (paths with "/"), or [] for null. */
function lines(s) {
  if (s == null) return [];
  return s
    .split(/\r?\n/)
    .map((l) => l.trim().split('\\').join('/'))
    .filter(Boolean);
}

/**
 * The changed files against the base branch, relative to the gate folder: committed since the fork point (merge-base
 * of HEAD and the base), staged, unstaged and untracked (not ignored). Deleted files are left out (nothing to check).
 * --track-base/--track-tip (the merge step's arguments, lib/trackDiff.js) give a merged track's own diff instead.
 * Returns { base, files } or { error }.
 */
function changedFiles() {
  const wanted = option('--base') || K.baseBranch;
  const candidates = [wanted, `${K.remote}/${wanted}`];
  const ref = candidates.find((c) => git('rev-parse', '--verify', '--quiet', `${c}^{commit}`) != null);
  if (!ref) return { error: `the base branch ${wanted} was not found (also not ${K.remote}/${wanted}); use --base <ref>` };
  const fork = (git('merge-base', 'HEAD', ref) || '').trim();
  if (!fork) return { error: `no merge base between HEAD and ${ref}` };
  const tracked = git('diff', '--name-only', '--relative', '--diff-filter=d', fork);
  const untracked = git('ls-files', '--others', '--exclude-standard');
  if (tracked == null || untracked == null) return { error: 'git diff failed in the gate folder' };
  let files = [...new Set([...lines(tracked), ...lines(untracked)])];
  const trackBase = option('--track-base');
  if (trackBase) {
    const own = require('./lib/trackDiff.js').trackChangedFiles({
      git: (...a) => git(...a),
      trackBase,
      trackTip: option('--track-tip'),
      changed: files,
    });
    if (own == null) return { error: `git diff ${trackBase}... failed` };
    files = lines(own.join('\n'));
  }
  return { base: ref, files: files.filter((f) => fs.existsSync(path.join(cwd, f))).sort() };
}

/** Ends a process and its children (a shell starts the real tool as a child; on Windows taskkill /T takes the tree). */
function killTree(child) {
  try {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Runs one shell command with a time limit. Resolves to { status, out, timedOut }. */
function runCommand(command, { timeoutMs }) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32', // its own process group, so the whole tree can be ended
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, timeoutMs));
    child.on('error', (e) => (out += `\n${e.message}`));
    child.on('close', (status) => {
      clearTimeout(timer);
      if (logFile) fs.appendFileSync(logFile, `\n===== ${command} (exit ${status ?? 'unknown'}${timedOut ? ', timeout' : ''}) =====\n${out}`);
      resolve({ status, out, timedOut });
    });
  });
}

/** --precheck. Exit 0 green (or nothing to check), 1 red, 3 a check over its time budget, 2 setup error. */
async function precheckMode() {
  const P = require('./lib/gatePrecheck.js');
  const json = args.includes('--json');
  const exists = (rel) => fs.existsSync(path.join(cwd, rel)) || fs.existsSync(path.join(K.root, rel));
  const checks = P.checksFrom(K.gates, exists);
  const ch = changedFiles();
  if (ch.error) {
    if (json) console.log(JSON.stringify({ ok: false, status: 'ERROR', error: ch.error }));
    else console.error(`precheck: ${ch.error}`);
    return 2;
  }
  if (logFile) fs.writeFileSync(logFile, `gates --precheck in ${cwd} against ${ch.base}\n${ch.files.join('\n')}\n`);
  const t0 = Date.now();
  const r = await P.runPrecheck({ checks, changed: ch.files, run: runCommand, root: cwd });
  const totalSec = (Date.now() - t0) / 1000;
  if (json)
    console.log(
      JSON.stringify(
        { ok: r.ok, status: r.status, stoppedAt: r.stoppedAt, base: ch.base, changed: ch.files, totalSec, checks: r.results },
        null,
        2,
      ),
    );
  else {
    for (const l of P.precheckLines(r, { changedCount: ch.files.length, base: ch.base, totalSec })) console.log(l);
    if (!r.ok && logFile) console.log(`full log: ${logFile}`);
  }
  return r.ok ? 0 : r.status === 'TIMEOUT' ? 3 : 1;
}

// ---- --quick / --full ---------------------------------------------------------------------------------------------------
const mode = quick ? 'quick' : 'full';
const gates = (Array.isArray(K.gates?.[mode]) ? K.gates[mode] : []).filter(
  (g) => typeof g === 'string' && g.trim(),
);
if (gates.length === 0) {
  console.log('no gates set up in queue.config.json');
  process.exit(0);
}

if (logFile) fs.writeFileSync(logFile, `gates --${mode} in ${cwd}\n`);
const width = Math.min(60, Math.max(...gates.map((g) => g.length)) + 2);
const start = Date.now();
let failedCount = 0;

for (const command of gates) {
  const t0 = Date.now();
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const sec = (Date.now() - t0) / 1000;
  const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
  const green = r.status === 0;
  if (!green) failedCount++;
  console.log(
    resultLine(
      {
        name: command,
        status: green ? 'GREEN' : 'RED',
        sec,
        first: green ? '' : firstErrorLine(gateType(command), out, cwd),
      },
      width,
    ),
  );
  if (logFile)
    fs.appendFileSync(logFile, `\n===== ${command} (exit ${r.status ?? 'unknown'}, ${Math.round(sec)} s) =====\n${out}`);
}

const total = Math.round((Date.now() - start) / 1000);
console.log(
  failedCount === 0
    ? `ALL GREEN: ${gates.length} gate(s) --${mode} in ${total} s`
    : `RED: ${failedCount} of ${gates.length} gate(s) --${mode} failed (${total} s)${logFile ? `, full log: ${logFile}` : ''}`,
);
process.exit(failedCount === 0 ? 0 : 1);
