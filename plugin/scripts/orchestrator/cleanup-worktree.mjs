#!/usr/bin/env node
// =============================================================
// cleanup-worktree.mjs: cleans up a track's worktree after a successful merge (called from merge-track.mjs),
// and the backlog under .claude/worktrees/ with --all. See docs/orchestration.md.
//
// WHY: worktrees pile up (one per track), and file watchers and tools get slow or give up. They must be cleaned up
// continuously. Two traps make the cleanup dangerous:
//   * prepare-track.mjs creates links (junction on Windows, symlink otherwise) for config().sharedLinks (default
//     node_modules) to the MAIN TREE's folders. A delete that follows such a link empties the folder in mainTree, and then
//     both the owner's dev server and all other tracks stop.
//   * `git worktree remove` often fails with "Directory not empty"/"Permission denied" on folders with symlinks and hard
//     links. Git has then ALREADY unregistered the worktree, but the folder is left behind.
//
// HOW (cleanupWorktree): the criteria in shouldCleanUp → fingerprint of mainTree → each path in sharedLinks is removed as a LINK
// (`cmd /c rmdir` WITHOUT /s on Windows, unlink otherwise: removes the link and never the target; a real folder there stops
// everything) → new fingerprint → `git worktree remove` WITHOUT --force (git itself refuses on changes or a lock) → if the folder
// is left behind and git has unregistered it, and no folder link inside it points OUT of the worktree: `cmd /c rmdir /s /q` on
// Windows, fs.rmSync otherwise (neither follows links) → final fingerprint. The branch is NEVER deleted (the commits must remain).
//
// NEVER: --force on git worktree remove, touching locked worktrees, PowerShell Remove-Item -Recurse (PS 5.1 can follow junctions)
// or a recursive delete before the links are removed, or cleaning up anything outside .claude/worktrees/.
//
// USE:
//   node scripts/orchestrator/cleanup-worktree.mjs --all [--execute] [--min-age-hours 3]
//       A dry run is the default: lists what would be removed and why the rest stays. Merged = in baseBranch
//       (config().baseBranch). Folders under .claude/worktrees/ that git does not know (leftovers after an earlier cleanup)
//       are included too. --min-age-hours is the minimum age in hours.
//   node scripts/orchestrator/cleanup-worktree.mjs <branch> [--execute] [--against <ref>]     (one branch, default against baseBranch)
//   import { cleanupWorktree } from './cleanup-worktree.mjs'                            (merge-track.mjs, against HEAD)
// Test: npx vitest run scripts/orchestrator/__tests__/cleanup-worktree.test.mjs
// =============================================================

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { trackLinks } = require('./lib/orchestratorHelp.js');
const { config } = require('./lib/queueConfig.js');

/** The links tracks get (config().sharedLinks), normalized. Read on use, so the test can import without a config. */
const links = () => trackLinks(config().sharedLinks);

const WIN = process.platform === 'win32';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), error: (r.stderr || '').trim() };
}

/** true when `path` is INSIDE `root` (not equal to root). path.win32.relative compares case-insensitively. */
export function isUnder(filePath, root) {
  const rel = path.relative(path.resolve(root), path.resolve(filePath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
const same = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';

/**
 * Pure decision: should the worktree be cleaned up? The first reason that applies wins. The order goes from cheap to expensive, so
 * the caller can skip computing `dirty` (git status) and `realLinkFolder` when an earlier reason already stops it.
 *  - underWorktreesFolder: is under <mainTree>/.claude/worktrees/
 *  - locked:               porcelain line "locked"
 *  - isCurrentDirectory:  process.cwd() is in the worktree
 *  - merged:             the branch commit is an ancestor of HEAD (merge-track) or baseBranch (--all)
 *  - forNew:               changed within the minimum age (--all), so newly prepared tracks are not hit
 *  - dirty:              number of lines in `git status --porcelain` (boolean accepted; negative/unknown = no cleanup)
 *  - realLinkFolder:      relative path in sharedLinks that is a REAL folder (npm install in the worktree?), otherwise null
 */
export function shouldCleanUp({
  underWorktreesFolder,
  locked,
  isCurrentDirectory,
  merged,
  forNew = false,
  dirty,
  realLinkFolder = null,
}) {
  if (!underWorktreesFolder) return { cleanup: false, reason: 'not under .claude/worktrees/' };
  if (locked) return { cleanup: false, reason: 'locked' };
  if (isCurrentDirectory) return { cleanup: false, reason: 'is the current directory' };
  if (!merged) return { cleanup: false, reason: 'not merged' };
  if (forNew) return { cleanup: false, reason: 'changed recently (below the minimum age)' };
  const count = typeof dirty === 'boolean' ? (dirty ? 1 : 0) : dirty;
  if (typeof count !== 'number' || Number.isNaN(count) || count < 0)
    return { cleanup: false, reason: 'unknown status (git status failed)' };
  if (count > 0) return { cleanup: false, reason: `uncommitted changes (${count})` };
  if (realLinkFolder) return { cleanup: false, reason: `${realLinkFolder} is not a link` };
  return { cleanup: true, reason: 'merged, clean and unlocked' };
}

export function mainTree(cwd = process.cwd()) {
  const r = git(['rev-parse', '--git-common-dir'], cwd);
  if (!r.ok) throw new Error(`not in a git tree: ${r.error}`);
  return path.dirname(path.resolve(cwd, r.out));
}

/** `git worktree list --porcelain` as objects: { path, head, branch, locked, detached, prunable }. */
export function worktreeList(main) {
  const r = git(['worktree', 'list', '--porcelain'], main);
  if (!r.ok) throw new Error(`git worktree list failed: ${r.error}`);
  const out = [];
  let cur = null;
  for (const l of r.out.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) {
      cur = {
        path: path.resolve(l.slice(9)),
        head: null,
        branch: null,
        locked: false,
        detached: false,
        prunable: false,
      };
      out.push(cur);
    } else if (!cur) continue;
    else if (l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
    else if (l === 'detached') cur.detached = true;
    else if (l === 'locked' || l.startsWith('locked ')) cur.locked = true;
    else if (l === 'prunable' || l.startsWith('prunable ')) cur.prunable = true;
  }
  return out;
}

/**
 * The fingerprint of the main tree's shared folders (sharedLinks): the number of entries in each. It must be unchanged before and
 * after each step; if it changes, something has followed a link into mainTree, and the cleanup stops.
 */
export function fingerprint(main, list = links()) {
  const out = {};
  for (const rel of list) {
    try {
      out[rel] = fs.readdirSync(path.join(main, ...rel.split('/'))).length;
    } catch {
      out[rel] = -1;
    }
  }
  return out;
}
const equalFingerprint = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function alarm(label, before, after) {
  const message =
    `${label}: THE FINGERPRINT OF THE MAIN TREE'S SHARED FOLDERS CHANGED. Stopped. ` +
    `Before ${JSON.stringify(before)}, after ${JSON.stringify(after)}. Check ${Object.keys(before).join(', ') || 'the shared folders'} in mainTree now.`;
  console.error(`\n!!! ${message}\n`);
  return { status: 'error', message };
}

function linkType(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) return 'link'; // Node reports NTFS junctions as symbolic links
  return st.isDirectory() ? 'folder' : 'other';
}

const winPath = (p) => path.resolve(p).split('/').join('\\');

/** Removes ONLY the link (rmdir without /s), never the target. */
function removeLink(p) {
  if (WIN) execFileSync('cmd', ['/c', 'rmdir', winPath(p)], { stdio: 'pipe' });
  else fs.unlinkSync(p);
  if (linkType(p) !== 'missing') throw new Error(`link ${p} is still there`);
}

/** Folder links inside `root` that point OUT of root. Never follows links. Unreadable folders are reported (unknown = unsafe). */
export function findOutLinks(root) {
  const out = [];
  const unreadable = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entry;
    try {
      entry = fs.readdirSync(dir);
    } catch (e) {
      unreadable.push(`${dir} (${e.code})`);
      continue;
    }
    for (const name of entry) {
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let measure = null;
        let isFolder = false;
        try {
          measure = fs.realpathSync(p);
          isFolder = fs.statSync(p).isDirectory();
        } catch {
          // Dangling link: the delete only removes the link itself.
        }
        if (isFolder && !isUnder(measure, root) && !same(measure, root)) out.push(`${p} -> ${measure}`);
        continue;
      }
      if (st.isDirectory()) stack.push(p);
    }
  }
  return { out, unreadable };
}

function gitdirFor(wt) {
  try {
    const m = fs.readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(wt, m[1].trim()) : null;
  } catch {
    return null;
  }
}
/**
 * Last activity: the worktree root (changed when prepare-track creates the links) and HEAD/logs/HEAD (changed on checkout and
 * commit). NOT the index or the git folder itself: a plain `git status` (also our own dry run and queue-takeover.mjs) rewrites them,
 * and then all worktrees would look new for three hours after every dry run. Ongoing, uncommitted work is stopped
 * anyway by the check for dirty worktrees.
 */
function lastChangedMs(wt) {
  const gd = gitdirFor(wt);
  const candidates = [wt, ...(gd ? [path.join(gd, 'HEAD'), path.join(gd, 'logs', 'HEAD')] : [])];
  let max = 0;
  for (const k of candidates) {
    try {
      max = Math.max(max, fs.statSync(k).mtimeMs);
    } catch {
      // does not exist
    }
  }
  return max;
}
const forNewTime = (wt, minAgeHours) =>
  minAgeHours > 0 && Date.now() - lastChangedMs(wt) < minAgeHours * 3600e3;

function realLinkFolderIn(wt) {
  for (const rel of links()) {
    const t = linkType(path.join(wt, ...rel.split('/')));
    if (t === 'folder' || t === 'other') return rel;
  }
  return null;
}

const label = (w) => `${path.basename(w.path)}${w.branch ? ` (${w.branch})` : ''}`;

/** Computes the criteria for a registered worktree, cheapest first, and returns the shouldCleanUp answer. */
export function assess(w, { against = 'HEAD', minAgeHours = 0, main }) {
  const input = {
    underWorktreesFolder: isUnder(w.path, path.join(main, '.claude', 'worktrees')),
    locked: w.locked,
    isCurrentDirectory: isUnder(process.cwd(), w.path) || same(process.cwd(), w.path),
  };
  const course = shouldCleanUp({ ...input, merged: true, dirty: 0 });
  if (!course.cleanup) return course;
  if (w.prunable || !fs.existsSync(w.path))
    return { cleanup: false, reason: 'the folder does not exist (git worktree prune)' };
  input.merged = !!w.head && git(['merge-base', '--is-ancestor', w.head, against], main).ok;
  if (!input.merged) return shouldCleanUp(input);
  input.forNew = forNewTime(w.path, minAgeHours);
  if (input.forNew) return shouldCleanUp(input);
  const s = git(['-C', w.path, 'status', '--porcelain'], main);
  input.dirty = s.ok ? s.out.split('\n').filter(Boolean).length : -1;
  input.realLinkFolder = realLinkFolderIn(w.path);
  return shouldCleanUp(input);
}

/** Step 5: the folder is left behind after git has unregistered it. */
function deleteRest(filePath, main, before, name) {
  const { out, unreadable } = findOutLinks(filePath);
  if (out.length)
    return {
      status: 'leftovers',
      message: `${name}: folder link points out of the worktree, leaving it: ${out.slice(0, 3).join('; ')}`,
    };
  if (unreadable.length)
    return {
      status: 'leftovers',
      message: `${name}: could not read ${unreadable.slice(0, 3).join('; ')}, leaving it`,
    };
  if (WIN) {
    try {
      execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', winPath(filePath)], { stdio: 'pipe' });
    } catch {
      // rmdir gives an error code when something is held open; the result is checked below.
    }
  } else {
    try {
      // fs.rmSync does not follow symlinks (they are removed as links), and no link points out (checked above).
      fs.rmSync(filePath, { recursive: true, force: true });
    } catch {
      // the result is checked below
    }
  }
  const after = fingerprint(main);
  if (!equalFingerprint(before, after)) return alarm(name, before, after);
  if (fs.existsSync(filePath))
    return {
      status: 'leftovers',
      message: `${name}: the folder is left behind (held open by a process?), --all takes it later: ${filePath}`,
    };
  return {
    status: 'removed',
    message: `${name}: removed (the leftovers after git worktree remove deleted)`,
  };
}

/** Removes the links (sharedLinks) as links. Returns null when all went well, otherwise a result that stops the cleanup. */
function removeTrackLinks(filePath, main, before, name) {
  for (const rel of links()) {
    const p = path.join(filePath, ...rel.split('/'));
    const t = linkType(p);
    if (t === 'missing') continue;
    if (t !== 'link')
      return { status: 'skipped', message: `${name}: ${rel} is not a link` };
    try {
      removeLink(p);
    } catch (e) {
      return {
        status: 'skipped',
        message: `${name}: could not remove link ${rel}: ${e.message}`,
      };
    }
  }
  const after = fingerprint(main);
  if (!equalFingerprint(before, after)) return alarm(name, before, after);
  return null;
}

function cleanupRegistered(w, { against, minAgeHours, main }) {
  const name = label(w);
  const v = assess(w, { against, minAgeHours, main });
  if (!v.cleanup) return { status: 'skipped', message: `${name}: ${v.reason}` };
  const before = fingerprint(main);
  const stop = removeTrackLinks(w.path, main, before, name);
  if (stop) return stop;
  const r = git(['worktree', 'remove', w.path], main);
  if (!fs.existsSync(w.path)) {
    const after = fingerprint(main);
    if (!equalFingerprint(before, after)) return alarm(name, before, after);
    return { status: 'removed', message: `${name}: removed` };
  }
  if (worktreeList(main).some((x) => same(x.path, w.path)))
    return {
      status: 'skipped',
      message: `${name}: git worktree remove refused (${r.error || 'unknown reason'}); the links are removed, run prepare-track.mjs to recreate them`,
    };
  return deleteRest(w.path, main, before, name);
}

/**
 * Cleans up the worktree that has `branch` checked out. Called by merge-track.mjs after a successful merge (against = 'HEAD').
 * Returns { status: 'removed' | 'skipped' | 'leftovers' | 'error', message }. Throws only on unexpected errors.
 */
export function cleanupWorktree(branch, { against = 'HEAD', minAgeHours = 0, main = mainTree() } = {}) {
  const w = worktreeList(main).find((x) => x.branch === branch);
  if (!w) return { status: 'skipped', message: `no worktree for ${branch}` };
  return cleanupRegistered(w, { against, minAgeHours, main });
}

/** Folders under .claude/worktrees/ that git does not know: leftovers after an earlier cleanup. */
function cleanupUnregistered(filePath, { minAgeHours, main, execute }) {
  const name = `${path.basename(filePath)} (not registered)`;
  if (isUnder(process.cwd(), filePath) || same(process.cwd(), filePath))
    return { status: 'skipped', message: `${name}: is the current directory` };
  if (forNewTime(filePath, minAgeHours))
    return { status: 'skipped', message: `${name}: changed recently (below the minimum age)` };
  const real = realLinkFolderIn(filePath);
  if (real) return { status: 'skipped', message: `${name}: ${real} is not a link` };
  if (!execute)
    return { status: 'would remove', message: `${name}: leftovers after an earlier cleanup` };
  const before = fingerprint(main);
  const stop = removeTrackLinks(filePath, main, before, name);
  if (stop) return stop;
  return deleteRest(filePath, main, before, name);
}

function mainProgram() {
  const args = process.argv.slice(2);
  const val = (n, s) => (args.includes(n) ? args[args.indexOf(n) + 1] : s);
  const execute = args.includes('--execute');
  const baseBranch = config().baseBranch;
  const main = mainTree();
  const root = path.join(main, '.claude', 'worktrees');
  const results = [];

  if (args.includes('--all')) {
    const minAgeHours = Number(val('--min-age-hours', '3'));
    const list = worktreeList(main);
    for (const w of list) {
      if (!isUnder(w.path, root)) continue; // mainTree and everything outside .claude/worktrees/ is never touched
      let r;
      if (execute) r = cleanupRegistered(w, { against: baseBranch, minAgeHours, main });
      else {
        const v = assess(w, { against: baseBranch, minAgeHours, main });
        r = v.cleanup
          ? { status: 'would remove', message: `${label(w)}: ${v.reason}` }
          : { status: 'skipped', message: `${label(w)}: ${v.reason}` };
      }
      results.push(r);
      if (r.status === 'error') break;
    }
    const known = new Set(list.map((w) => path.resolve(w.path).toLowerCase()));
    let folders = [];
    try {
      folders = fs.readdirSync(root).map((n) => path.join(root, n));
    } catch {
      // no worktrees folder
    }
    for (const filePath of folders) {
      if (results.some((r) => r.status === 'error')) break;
      if (known.has(path.resolve(filePath).toLowerCase())) continue;
      if (linkType(filePath) !== 'folder') continue;
      results.push(cleanupUnregistered(filePath, { minAgeHours, main, execute }));
    }
  } else {
    const branch = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--against');
    if (!branch) {
      console.error(
        'use: cleanup-worktree.mjs --all [--execute] [--min-age-hours 3] | <branch> [--execute] [--against <ref>]',
      );
      process.exit(2);
    }
    const against = val('--against', baseBranch);
    const w = worktreeList(main).find((x) => x.branch === branch);
    if (!w) results.push({ status: 'skipped', message: `no worktree for ${branch}` });
    else if (execute) results.push(cleanupRegistered(w, { against, minAgeHours: 0, main }));
    else {
      const v = assess(w, { against, minAgeHours: 0, main });
      results.push({
        status: v.cleanup ? 'would remove' : 'skipped',
        message: `${label(w)}: ${v.reason}`,
      });
    }
  }

  for (const r of results) console.log(`${r.status.padEnd(13)} ${r.message}`);
  const perStatus = {};
  for (const r of results) perStatus[r.status] = (perStatus[r.status] || 0) + 1;
  const perReason = {};
  for (const r of results.filter((x) => x.status === 'skipped')) {
    const g = r.message.slice(r.message.indexOf(': ') + 2).replace(/\(\d+\)/, '(n)');
    perReason[g] = (perReason[g] || 0) + 1;
  }
  console.log(
    `\n${execute ? 'EXECUTED' : 'DRY RUN (add --execute to clean up)'}: ${JSON.stringify(perStatus)}`,
  );
  for (const [g, n] of Object.entries(perReason).sort((a, b) => b[1] - a[1]))
    console.log(`  kept: ${n} × ${g}`);
  const fp = fingerprint(main);
  console.log(`Fingerprint mainTree: ${JSON.stringify(fp)}`);
  process.exit(results.some((r) => r.status === 'error') ? 1 : 0);
}

// Run the CLI only when the file is started directly (not on import from merge-track.mjs or the test). The case of
// the drive letter can vary on Windows, so the comparison ignores case there.
const started = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
const equal = WIN
  ? started.toLowerCase() === import.meta.url.toLowerCase()
  : started === import.meta.url;
if (equal) mainProgram();
