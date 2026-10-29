#!/usr/bin/env node
// =============================================================
// prepare-track.mjs: makes an agent worktree ready for a track in one call. See docs/orchestration.md and
// docs/mission-template.md (track protocol).
//
// WHY: without this every track spends several calls on links, copying and branch switching before the first code change.
// The dependency folders (config().sharedLinks, default node_modules) are linked to mainTree instead of being
// installed again. The rule is therefore: link, NEVER `npm install` in the worktree (it would write straight into the
// main tree's folder, which the owner and the other tracks use).
//
// What the script does (idempotent; feel free to run it again):
//   1. Refuses to run in mainTree (only in a worktree).
//   2. Creates links for each path in config().sharedLinks to mainTree if they are missing: junction on Windows
//      (PowerShell New-Item -ItemType Junction), symlink otherwise. Warns if one of them is a real folder.
//      If the folder is missing in mainTree, it is skipped with a warning.
//   3. If config().migrations.environmentFile is set and the file exists in mainTree but not in the worktree, it is copied
//      (it is often gitignored, and the push guard needs it to see which environment is linked).
//   4. Creates the scratchpad subfolder <scratchpad>/<TRACK>/.
//   5. `git checkout -B <branch> <base>` if the worktree is not already on the branch. Refuses if that would throw away
//      uncommitted changes or commits not on the base. If the branch already exists with commits ahead of the base
//      (after `queue.mjs release` or a continuation), it becomes `git switch <branch>` without -B.
//      With --continue (fix round or continuation in a new agent): the branch MUST exist, and it is always
//      `git switch <branch>` without reset. Refuses (with the path and `git -C <path> switch --detach`) when the branch is
//      checked out in another worktree. Own commits are counted on the branch against the base, so it does not matter that
//      the base is ahead of the branch.
//   6. Writes one status line (READY / DENIES).
//
// Use:
//   node scripts/orchestrator/prepare-track.mjs <TRACK> [--branch <name>] [--scratchpad <root-folder>] [--base <ref>]
//        [--continue]
//   Defaults: --branch <branchPrefix><TRACK> (config().branchPrefix, default queue/), --base config().baseBranch,
//   --scratchpad <os.tmpdir()>/queue-track.
//   Fix round: node scripts/orchestrator/prepare-track.mjs X-r1 --branch queue/X --continue --scratchpad "…"
// =============================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  continueDecision,
  branchDecision,
  worktreeWithBranch,
  trackLinks,
} = require('./lib/orchestratorHelp.js');
const { config } = require('./lib/queueConfig.js');
const K = config();

const a = process.argv.slice(2);
const val = (name, standard) => {
  const i = a.indexOf(name);
  return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : standard;
};
const TRACK = a[0] && !a[0].startsWith('--') ? a[0] : undefined;
if (!TRACK) {
  console.error(
    'use: prepare-track.mjs <TRACK> [--branch <name>] [--scratchpad <root-folder>] [--base <ref>] [--continue]',
  );
  process.exit(2);
}
const BRANCH = val('--branch', `${K.branchPrefix}${TRACK}`);
const BASE = val('--base', K.baseBranch);
const CONTINUE = a.includes('--continue');
const SCRATCH = path.resolve(val('--scratchpad', path.join(os.tmpdir(), 'queue-track')), TRACK);

const deny = (reason) => {
  console.log(`DENIES ${TRACK}: ${reason}`);
  process.exit(1);
};

// Works in the worktree we are in (cwd), not where the script lives: the script can be run from mainTree with
// cwd in the worktree, and then it is the worktree that must be prepared.
function git(...args) {
  const r = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), error: (r.stderr || '').trim() };
}

const top = git('rev-parse', '--show-toplevel');
if (!top.ok) deny('not in a git tree');
const WT = path.resolve(top.out);
const common = path.resolve(WT, git('rev-parse', '--git-common-dir').out);
const own = path.resolve(WT, git('rev-parse', '--git-dir').out);
if (common === own) deny(`${WT} is mainTree, not a worktree`);
const MAIN = path.dirname(common);

const status = [];

// ---------- 2. links ----------
function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink(); // Node reports NTFS junctions as symbolic links
  } catch {
    return null; // does not exist
  }
}
const ps = (s) => `'${s.split("'").join("''")}'`;

/** Creates a folder link: junction on Windows (does not require admin rights), symlink otherwise. */
function makeLink(filePath, measure) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `New-Item -ItemType Junction -Path ${ps(filePath)} -Target ${ps(measure)} | Out-Null`,
      ],
      { encoding: 'utf8' },
    );
    return (r.stderr || '').trim();
  }
  try {
    fs.symlinkSync(measure, filePath, 'dir');
    return '';
  } catch (e) {
    return e?.message ?? String(e);
  }
}

let made = 0;
// The list is shared with cleanup-worktree.mjs (both read config().sharedLinks via trackLinks), so the cleanup always
// knows every link we create here.
for (const rel of trackLinks(K.sharedLinks)) {
  const filePath = path.join(WT, ...rel.split('/'));
  const measure = path.join(MAIN, ...rel.split('/'));
  const link = isLink(filePath);
  if (link === true) continue;
  if (link === false) {
    status.push(`WARNING ${rel} is a real folder (npm install in the worktree?), not a link`);
    continue;
  }
  if (!fs.existsSync(measure)) {
    status.push(`WARNING mainTree is missing ${rel}, no link`);
    continue;
  }
  const error = makeLink(filePath, measure);
  if (isLink(filePath) !== true) deny(`could not create link ${rel}: ${error}`);
  made++;
}
status.push(`links ok${made ? ` (made ${made})` : ''}`);

// ---------- 3. environment file (optional) ----------
const environmentFile = K.migrations?.environmentFile;
if (environmentFile) {
  const here = path.resolve(WT, environmentFile);
  const source = path.resolve(MAIN, environmentFile);
  if (!fs.existsSync(here) && fs.existsSync(source)) {
    fs.mkdirSync(path.dirname(here), { recursive: true });
    fs.copyFileSync(source, here);
    status.push(`${environmentFile} copied`);
  }
}

// ---------- 4. scratchpad ----------
fs.mkdirSync(SCRATCH, { recursive: true });
status.push(`scratchpad ${SCRATCH}`);

// ---------- 5. branch ----------
if (!git('rev-parse', '--verify', '--quiet', BASE).ok) deny(`cannot find ${BASE}`);
const current = git('branch', '--show-current').out;
const dirty = git('status', '--porcelain', '--untracked-files=no').out.length > 0;
const ownCommits = Number(git('rev-list', '--count', `${BASE}..HEAD`).out) || 0;
// If the target branch already exists with commits ahead of the base (after `queue.mjs release`, or a continuation in a new
// worktree), we switch to it and never reset it with -B: the commits would then only remain in the reflog.
const measureExists = git('rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`).ok;
const measureCommits = measureExists
  ? Number(git('rev-list', '--count', `${BASE}..refs/heads/${BRANCH}`).out) || 0
  : 0;
// --continue: take over an existing branch without reset, and deny clearly when another worktree holds it.
const otherWorktree = (() => {
  if (!CONTINUE) return null;
  const filePath = worktreeWithBranch(git('worktree', 'list', '--porcelain').out, BRANCH);
  return filePath && path.resolve(filePath) !== WT ? filePath : null;
})();
const b = CONTINUE
  ? continueDecision({
      current,
      branch: BRANCH,
      exists: measureExists,
      dirty,
      ownCommits,
      otherWorktree,
      base: BASE,
    })
  : branchDecision({ current, branch: BRANCH, dirty, ownCommits, measureCommits, base: BASE });
if (b.action === 'deny') deny(`will not switch to ${BRANCH}: ${b.reason}`);
if (b.action === 'switch') {
  const r = git('switch', BRANCH);
  if (!r.ok)
    deny(
      `git switch ${BRANCH} failed (the branch has ${measureCommits} commit(s) ahead of ${BASE} and is not reset): ${r.error}`,
    );
}
if (b.action === 'checkout') {
  const r = git('checkout', '-B', BRANCH, BASE);
  if (!r.ok) deny(`git checkout -B ${BRANCH} ${BASE} failed: ${r.error}`);
}
const sha = git('rev-parse', '--short', 'HEAD').out;
const baseSha = git('rev-parse', '--short', BASE).out;

// Own commits on the branch we are now on, against the base: for --continue that is the track's work so far.
const nowCommits = Number(git('rev-list', '--count', `${BASE}..HEAD`).out) || 0;
const branchText = CONTINUE
  ? ` (continues, ${nowCommits} own commit(s) ahead of ${BASE} ${baseSha})`
  : b.action === 'checkout'
    ? ` (new from ${BASE} ${baseSha})`
    : b.action === 'switch'
      ? ` (existing branch taken over, ${measureCommits} commit(s) ahead of ${BASE} ${baseSha})`
      : ` (base ${BASE} ${baseSha})`;
console.log(`READY ${TRACK}: branch ${BRANCH} @ ${sha}${branchText}, ${status.join(', ')}`);
