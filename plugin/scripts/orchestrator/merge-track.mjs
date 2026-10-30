#!/usr/bin/env node
// =============================================================
// merge-track.mjs: merges one track branch into baseBranch (config().baseBranch) and resolves the most common conflicts
// automatically. See docs/orchestration.md.
//
// WHY: when several tracks work in parallel, they often add blocks at the end of the same files (registries, lists,
// translations, test lists). Git sees two insertions at the same place as a conflict, and the sides often share lines (a
// closing "}" or "];"). Resolving this by hand per track is slow and error prone: conflict markers
// get committed, or a missing comma joins two strings together.
//
// HOW: git merges first. For each file in conflict the script does its OWN three-way merge from base (:1:), HEAD (:2:)
// and branch (:3:), instead of cutting in git's markers:
//   * text files: the changes from each side against base (git diff -U0) are applied to base.
//       - changes in different places: both are included
//       - insertions at the same place: HEAD's first, then the branch's
//       - the same base lines changed identically on both sides (for example a comma added to the previous element): the
//         changed lines once, then the rest from HEAD, then the rest from the branch
//       - otherwise: a real conflict, resolved by hand
//     In SQL and JS/TS a missing comma is inserted where HEAD's block ends with list values and the branch's block
//     starts with a new one.
//   * translation files (JSON under a locales/ folder): the HEAD text, plus top-level keys the branch has added, inserted
//     verbatim. Checked three-way against base.
//
// AFTERWARDS the affected files are validated: no conflict markers, JSON parses, `node --check` on JS, and in SQL files that
// were merged automatically: list values or tuples without a comma before a new one. If everything is green, the merge is
// committed. Otherwise the merge is left in place (git merge --abort to undo), and the script says what must be resolved by
// hand. The project's own gates (gates.mjs) are run by `queue.mjs merge` after this script, not here.
//
// BEFORE the merge: the guard check (lib/mergeGuard.js). If the branch touches a protected path (config().protectedPaths:
// .claude/, the orchestrator scripts, hooks, agents, queue.config.json, package.json and so on) that the task does not
// own in queue.json, the merge stops (exit 4). Other files outside the ownership only give a warning.
//
// With migrations turned on (config().migrations.folder) it also reports SQL functions that the branch rewrites entirely
// (create or replace) and that another track in the same wave has also rewritten. Then the one with the highest
// migration number wins, and the other's change silently disappears.
//
// AFTER a successful merge the track worktree is cleaned up (cleanup-worktree.mjs: the links are removed as links, then
// `git worktree remove` without --force). The branch is kept. The cleanup is best effort: it never turns a successful merge
// into exit ≠ 0, and locked, dirty or unmerged worktrees are left alone.
//
// USE:
//   node scripts/orchestrator/merge-track.mjs <branch> [--wave-base <sha>] [--without-commit] [--keep-worktree] [--allow-guard]
//     --wave-base <sha>  the base branch commit the wave started from (for the check of functions rewritten by several tracks)
//     --without-commit       resolve and validate, but do not commit (the merge is left in place)
//     --keep-worktree   do not clean up the track worktree after the merge
//     --allow-guard     merge even if the branch touches protected paths it does not own (logged as "guard-overridden"
//                       in the time log). Without it: exit 4 BEFORE the merge, with the list.
//   Exit: 0 merged, 1 merge or validation failed, 2 usage or no diff, 3 identity guard, 4 merge guard.
// NB: never use String.replace with a replacement text that may contain "$" (patterns such as $& are interpreted); build with slice.
// =============================================================

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { cleanupWorktree } from './cleanup-worktree.mjs';

const require = createRequire(import.meta.url);
const { config } = require('./lib/queueConfig.js');
const CQ = require('./lib/projectRoot.js').cqCommand();
const K = config();

const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const waveBase = val('--wave-base');
const branch = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--wave-base');
const WITHOUT_COMMIT = args.includes('--without-commit');
const KEEP_WORKTREE = args.includes('--keep-worktree');
const ALLOW_GUARD = args.includes('--allow-guard');
if (!branch) {
  console.error(
    `Use: ${CQ} merge-track <branch> [--wave-base <sha>] [--without-commit] [--keep-worktree] [--allow-guard]`,
  );
  process.exit(2);
}

// Best-effort cleanup of the track worktree after a successful merge. One log line; an error here NEVER makes the merge
// fail (exit stays 0).
function cleanupAfterMerge() {
  if (KEEP_WORKTREE) {
    console.log('Worktree: kept (--keep-worktree).');
    return;
  }
  try {
    const r = cleanupWorktree(branch, { against: 'HEAD' });
    console.log(`Worktree: ${r.status}: ${r.message}`);
  } catch (e) {
    console.log(`Worktree: the cleanup failed, the merge stands: ${e.message}`);
  }
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 << 20 });
const gitOk = (...a) => spawnSync('git', a, { encoding: 'utf8', maxBuffer: 256 << 20 });

// Identity guard BEFORE merge: merge commits must have the owner's real git identity. A test identity left behind
// in the repo config (for example from a test of this script) would otherwise end up in all merge commits.
// Tests for this script must use a temporary repo.
{
  const r = spawnSync('git', ['var', 'GIT_COMMITTER_IDENT'], { encoding: 'utf8' });
  const ident = (r.stdout || '').trim();
  if (r.status !== 0 || !ident || /@(example\.(com|org|net|invalid)|[^>\s]*\.invalid)>/i.test(ident)) {
    process.stderr.write(
      `The identity guard stopped the merge: the git identity looks like a test or is missing (${ident || 'none'}). ` +
        'Set user.name and user.email first.\n',
    );
    process.exit(3);
  }
}

// Windows locks large files for a moment after git has written them (virus scanner or file watcher): the write gives
// UNKNOWN/EBUSY/EPERM. Try again a few times with a short pause before giving up.
function writeWithNewAttempt(file, text) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.writeFileSync(file, text);
      return;
    } catch (e) {
      if (attempt >= 10 || !['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
    }
  }
}
// ---- 0) Guard check: protected paths need ownership ---------------------------------------------------------------
// Hooks, settings, agent definitions, orchestrator scripts, the queue config and package.json can only be changed by a
// task that owns the path (owned_files/shared_patch in queue.json). Otherwise the merge stops BEFORE it starts;
// --allow-guard overrides and is logged. The logic and the rules are in lib/mergeGuard.js, the list in
// config().protectedPaths. The diff is HEAD...<branch> (the branch's own changes since the fork point), so base branch
// commits merged into the branch are not counted as the track's.
{
  const G = require('./lib/mergeGuard.js');
  const { dataFolder, timeLog } = require('./lib/queueConfig.js');
  const id = G.taskIdFromBranch(branch, K.branchPrefix);
  let task = null;
  try {
    const queue = JSON.parse(fs.readFileSync(path.join(dataFolder(), 'queue.json'), 'utf8'));
    const tasks = queue.tasks || [];
    task = tasks.find((o) => o.branch === branch) ?? (id ? tasks.find((o) => o.id === id) : null) ?? null;
  } catch {
    // no queue here (a wave track or a test): empty ownership, so every protected path stops
  }
  const taskName = task?.id ?? id;
  const diff = gitOk('diff', '--name-status', '-M', `HEAD...${branch}`);
  if (diff.status !== 0) {
    console.error(`Guard check: could not get the diff HEAD...${branch}:\n${diff.stderr}`);
    process.exit(2);
  }
  const guard = G.assessGuard({
    changes: G.readDiff(diff.stdout),
    ownedFiles: task?.owned_files ?? [],
    sharedPatch: task?.shared_patch ?? [],
    migrBlock: task?.migr_block ?? null,
    migrations: K.migrations,
    protectedPaths: Array.isArray(K.protectedPaths) ? K.protectedPaths : undefined,
    allowGuard: ALLOW_GUARD,
  });
  if (guard.drift.length > 0) {
    console.log(
      `WARNING ownership drift (${taskName ?? branch}): ${guard.drift.length} file(s) outside owned_files + shared_patch:`,
    );
    for (const f of guard.drift.slice(0, 30)) console.log(`  ${f}`);
    if (guard.drift.length > 30) console.log(`  … and ${guard.drift.length - 30} more`);
  }
  if (guard.violations.length > 0) {
    const list = guard.violations.map((b) => `  ${b.path}  (${b.reason})`).join('\n');
    if (guard.stop) {
      console.error(
        `\nGUARD: ${branch} changes protected paths that the task${taskName ? ` ${taskName}` : ''} does not own:\n${list}\n\n` +
          'Hooks, settings, agents, orchestrator scripts, the queue config and package.json can run code with the owner\'s rights.\n' +
          `Read the diff (git diff HEAD...${branch} -- <path>). If the change is intended: add the path to the task's\n` +
          'owned_files/shared_patch, or merge with --allow-guard (logged as "guard-overridden"). Nothing was merged.',
      );
      process.exit(4);
    }
    console.log(`GUARD OVERRIDDEN (--allow-guard) for ${branch}:\n${list}`);
    try {
      fs.appendFileSync(
        timeLog(),
        `${JSON.stringify({
          time: new Date().toISOString(),
          wave: task ? 'queue' : null,
          track: taskName ?? branch,
          event: 'guard-overridden',
          branch,
          paths: guard.violations.map((b) => b.path),
        })}\n`,
      );
    } catch (e) {
      console.error(`  (could not log guard-overridden: ${e.message})`);
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-track-'));

// ---- 1) Merge ------------------------------------------------------------------------
const now = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
console.log(`Merging ${branch} into ${now} …`);
// Stale index after `git commit -- <files>` with a pre-commit hook: the file equals HEAD in the working tree, but
// the index has an older version, and then merge refuses ("local changes would be overwritten"). Clean up only such files.
for (const f of git('diff', '--cached', '--name-only').split('\n').filter(Boolean)) {
  if (gitOk('diff', '--quiet', 'HEAD', '--', f).status === 0) {
    gitOk('reset', '-q', '--', f);
    console.log(`  cleaned stale index for ${f} (equal to HEAD)`);
  }
}
const m = gitOk('merge', '--no-ff', '--no-edit', branch);
const conflicts = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
if (m.status !== 0 && !conflicts.length) {
  console.error(`git merge failed without conflicts:\n${m.stdout}${m.stderr}`);
  process.exit(1);
}
console.log(conflicts.length ? `Conflicts in ${conflicts.length} files.` : 'No conflicts.');

// ---- 2) Three-way merge per file -------------------------------------------------------
const version = (n, file) => {
  const r = gitOk('show', `:${n}:${file}`);
  return r.status === 0 ? r.stdout : null;
};

// Changes from base to side as hunks: { a: start line (0-based) in base, n: number of base lines, new: [lines] }.
function hunker(base, side, name) {
  const fb = path.join(tmp, `${name}.base`);
  const fside = path.join(tmp, `${name}.side`);
  fs.writeFileSync(fb, base);
  fs.writeFileSync(fside, side);
  const r = spawnSync(
    'git',
    ['diff', '--no-index', '-U0', '--no-color', '--diff-algorithm=myers', fb, fside],
    {
      encoding: 'utf8',
      maxBuffer: 256 << 20,
    },
  );
  const out = [];
  let cur = null;
  for (const l of r.stdout.split('\n')) {
    const h = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      const bStart = Number(h[1]);
      const bCount = h[2] === undefined ? 1 : Number(h[2]);
      // For a pure insertion (bCount = 0) bStart points to the line BEFORE the insertion.
      cur = { a: bCount === 0 ? bStart : bStart - 1, n: bCount, new: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('+') && !l.startsWith('+++')) cur.new.push(l.slice(1));
  }
  return out;
}

// A line that consists only of list values ('a' or 'a', 'b') and does not end with a comma.
const LIT = `('[^']*'|"[^"]*")`;
const LIST_LINE = new RegExp(`^\\s*${LIT}(\\s*,\\s*${LIT})*\\s*(--.*|//.*)?$`);
const LAST_VALUE = new RegExp(`${LIT}(\\s*(--.*|//.*)?)$`);
const startsWithListValue = (l) => /^\s*['"]/.test(l);
// A tuple row in a VALUES list: "('a', 'b')" without a comma at the end (optional comment). If two tracks add a row
// at the end of the same list, the merge could otherwise lose the comma between the tuples.
// The code part of the line: everything before a "--"/"//" comment that sits OUTSIDE a string. Then a parenthesis in
// the comment ("-- row (2)") does not look like the end of a tuple.
function codePart(l) {
  let inString = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (inString) {
      if (c === inString) inString = null;
    } else if (c === "'" || c === '"') inString = c;
    else if ((c === '-' || c === '/') && l[i + 1] === c) return l.slice(0, i);
  }
  return l;
}
const isTupleLine = (l) => /^\s*\(.*\)\s*$/.test(codePart(l));
const startsWithTuple = (l) => /^\s*\(/.test(l);

// Inserts a comma when block A ends with list values (or a tuple) without a comma and block B starts with a new one.
function commaBetween(a, b, file) {
  if (!/\.(sql|js|mjs|ts|tsx)$/.test(file)) return a;
  const isContent = (l) => l.trim() && !/^\s*(--|\/\/)/.test(l);
  let i = a.length - 1;
  while (i >= 0 && !isContent(a[i])) i--;
  const firstB = b.find(isContent);
  if (i < 0 || firstB === undefined) return a;
  const copy = [...a];
  // Without String.replace: build the line with slice, so "$" in the content is never interpreted as a pattern.
  if (LIST_LINE.test(a[i]) && startsWithListValue(firstB)) {
    const match = copy[i].match(LAST_VALUE);
    const pos = match.index + match[1].length;
    copy[i] = `${copy[i].slice(0, pos)},${copy[i].slice(pos)}`;
    return copy;
  }
  if (isTupleLine(a[i]) && startsWithTuple(firstB)) {
    const pos = codePart(copy[i]).lastIndexOf(')') + 1;
    copy[i] = `${copy[i].slice(0, pos)},${copy[i].slice(pos)}`;
    return copy;
  }
  return a;
}

function mergeText(file, base, ours, theirs) {
  const bl = base.split('\n');
  const ho = hunker(base, ours, 'o');
  const ht = hunker(base, theirs, 't');
  const all = [...ho.map((h) => ({ ...h, s: 'o' })), ...ht.map((h) => ({ ...h, s: 't' }))].sort(
    (x, y) => x.a - y.a || (x.s === 'o' ? -1 : 1),
  );
  const out = [];
  let pos = 0;
  for (let i = 0; i < all.length;) {
    const h = all[i];
    const end = (x) => x.a + x.n;
    // Groups hunks that overlap (same base range, or insertion at the same anchor point).
    const group = [h];
    let gEnd = end(h);
    let j = i + 1;
    while (j < all.length && (all[j].a < gEnd || (all[j].a === h.a && all[j].a === gEnd))) {
      group.push(all[j]);
      gEnd = Math.max(gEnd, end(all[j]));
      j++;
    }
    for (; pos < h.a; pos++) out.push(bl[pos]);
    const fromO = group.filter((x) => x.s === 'o');
    const fromT = group.filter((x) => x.s === 't');
    if (!fromO.length || !fromT.length) {
      for (const x of group) out.push(...x.new);
    } else if (
      fromO.length === 1 &&
      fromT.length === 1 &&
      fromO[0].a === fromT[0].a &&
      fromO[0].n === fromT[0].n
    ) {
      const o = fromO[0].new;
      const t = fromT[0].new;
      const n = fromO[0].n;
      if (o.join('\n') === t.join('\n')) out.push(...o);
      else if (n === 0) {
        // Pure insertions at the same place: HEAD's block, then the branch's. NEVER a common prefix here: both may start
        // with the same line (for example a closing "}" that the diff has "rotated" into the block), and it is needed twice.
        out.push(...commaBetween(o, t, file), ...t);
      } else {
        // The same base lines changed on both sides: accepted only when both changed them identically (for example a comma
        // added to the previous element), and the rest is insertions. Then the changed lines are taken once, then the rest from each side.
        if (o.slice(0, n).join('\n') !== t.slice(0, n).join('\n'))
          return { ok: false, reason: `the same lines changed differently (base line ${h.a + 1})` };
        const common = o.slice(0, n);
        const oRest = o.slice(n);
        const tRest = t.slice(n);
        out.push(...commaBetween(common.concat(oRest), tRest, file), ...tRest);
      }
    } else {
      return { ok: false, reason: `overlapping changes around base line ${h.a + 1}` };
    }
    pos = gEnd;
    i = j;
  }
  for (; pos < bl.length; pos++) out.push(bl[pos]);
  return { ok: true, text: out.join('\n') };
}

// Translation files: HEAD's text (conflict free after the HEAD side), plus top-level keys the branch has added, verbatim.
function mergeIn18n(base, ours, theirs, current) {
  const main = [];
  let mode = 'common';
  for (const l of current.split('\n')) {
    if (/^<<<<<<< /.test(l)) {
      mode = 'ours';
      continue;
    }
    if (l === '=======' && mode === 'ours') {
      mode = 'theirs';
      continue;
    }
    if (/^>>>>>>> /.test(l)) {
      mode = 'common';
      continue;
    }
    if (mode !== 'theirs') main.push(l);
  }
  let s = main.join('\n');
  let res;
  try {
    res = JSON.parse(s);
  } catch (e) {
    return { ok: false, reason: `the HEAD side does not parse: ${e.message}` };
  }
  const B = JSON.parse(base);
  const O = JSON.parse(ours);
  const T = JSON.parse(theirs);
  const tl = theirs.split('\n');
  for (const k of Object.keys(T)) {
    if (k in res || k in B) continue;
    const start = tl.findIndex((l) => l.startsWith(`  ${JSON.stringify(k)}: `));
    if (start < 0) return { ok: false, reason: `could not find top-level key ${k} in the branch` };
    let end = start;
    if (tl[start].trim().endsWith('{')) {
      for (let i = start + 1; i < tl.length; i++)
        if (/^ {2}\},?$/.test(tl[i])) {
          end = i;
          break;
        }
    }
    let block = tl.slice(start, end + 1).join('\n');
    if (block.endsWith(',')) block = block.slice(0, -1);
    const last = s.lastIndexOf('}');
    s = `${s.slice(0, last).trimEnd()},\n${block}\n}\n`;
    res = JSON.parse(s);
  }
  // Three-way check: everything the branch added exists; everything HEAD has exists unless the branch removed it from the base.
  const missing = [];
  const checkT = (a, b, bb, filePath) => {
    for (const k of Object.keys(b)) {
      const fresh = !bb || !(k in bb);
      if (!(k in a)) {
        if (fresh) missing.push(filePath + k);
        continue;
      }
      if (b[k] && typeof b[k] === 'object') checkT(a[k], b[k], bb && bb[k], `${filePath + k}.`);
    }
  };
  const checkO = (a, o, t, bb, filePath) => {
    for (const k of Object.keys(o)) {
      const removed = bb && k in bb && !(t && k in t);
      if (!(k in a)) {
        if (!removed) missing.push(filePath + k);
        continue;
      }
      if (o[k] && typeof o[k] === 'object')
        checkO(a[k], o[k], t && t[k], bb && bb[k], `${filePath + k}.`);
    }
  };
  checkT(res, T, B, '');
  checkO(res, O, T, B, '');
  if (missing.length)
    return { ok: false, reason: `keys missing after merge: ${missing.slice(0, 5).join(', ')}` };
  return { ok: true, text: s };
}

const resolved = [];
const manual = [];
for (const file of conflicts) {
  const base = version(1, file);
  const ours = version(2, file);
  const theirs = version(3, file);
  if (base === null || ours === null || theirs === null) {
    manual.push(`${file}: added or deleted on one side`);
    continue;
  }
  let r;
  if (/(^|\/)locales\/[A-Za-z_-]+\.json$/.test(file))
    r = mergeIn18n(base, ours, theirs, fs.readFileSync(file, 'utf8'));
  else if (file.endsWith('.json')) r = { ok: false, reason: 'JSON outside locales/ is resolved by hand' };
  else r = mergeText(file, base, ours, theirs);
  if (!r.ok) {
    manual.push(`${file}: ${r.reason}`);
    continue;
  }
  writeWithNewAttempt(file, r.text);
  resolved.push(file);
}

// ---- 3) Validation ---------------------------------------------------------------------
const error = [];
const changed = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
const checked = [...new Set([...resolved, ...changed])].filter((f) => fs.existsSync(f));
// Two identifier-like list values in a row without a comma: SQL joins them into one string, and
// both disappear from the list. Messages split over several lines have whitespace inside the string and are
// deliberate concatenations; they are not flagged.
const IDENT = `'[A-Za-z0-9_.:/-]+'`;
const identLine = new RegExp(`^\\s*${IDENT}(\\s*,\\s*${IDENT})*\\s*(--.*)?$`);
const identStart = new RegExp(`^\\s*${IDENT}`);
for (const f of checked) {
  const t = fs.readFileSync(f, 'utf8');
  if (/^(<<<<<<<|>>>>>>>) /m.test(t) || /^=======$/m.test(t)) error.push(`${f}: conflict markers`);
  if (f.endsWith('.json')) {
    try {
      JSON.parse(t);
    } catch (e) {
      error.push(`${f}: JSON does not parse (${e.message})`);
    }
  }
  if (/\.(js|mjs|cjs)$/.test(f)) {
    const r = spawnSync('node', ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) error.push(`${f}: node --check failed`);
  }
  if (resolved.includes(f) && f.endsWith('.sql')) {
    const L = t.split('\n');
    for (let i = 0; i < L.length; i++) {
      if (!identLine.test(L[i])) continue;
      let j = i + 1;
      while (j < L.length && /^\s*(--|$)/.test(L[j])) j++;
      if (j < L.length && identStart.test(L[j]))
        error.push(`${f}:${i + 1}: list value without a comma before a new value on line ${j + 1}`);
    }
    // The same error for tuple rows in a VALUES list ("('a', 'b')" followed by a new "(" row): gives a syntax error, which
    // is only discovered when the SQL actually runs.
    for (let i = 0; i < L.length; i++) {
      if (!isTupleLine(L[i]) || !/^\s*\('/.test(L[i])) continue;
      let j = i + 1;
      while (j < L.length && /^\s*(--|$)/.test(L[j])) j++;
      if (j < L.length && /^\s*\('/.test(L[j]))
        error.push(`${f}:${i + 1}: tuple without a comma before a new tuple on line ${j + 1}`);
    }
  }
}
// ---- 4) Functions rewritten by several tracks in the wave ---------------------------------------
const overlap = [];
const migFolder = K.migrations?.folder;
if (waveBase && migFolder) {
  const fnInFiles = (ref, files) => {
    const name = new Map();
    for (const f of files) {
      const r = gitOk('show', `${ref}:${f}`);
      if (r.status !== 0) continue;
      for (const x of r.stdout.matchAll(
        /create\s+or\s+replace\s+function\s+(?:public\.)?([a-z_0-9]+)/gi,
      ))
        name.set(x[1].toLowerCase(), f);
    }
    return name;
  };
  const branchFiles = git(
    'diff',
    '--name-only',
    `${waveBase}...${branch}`,
    '--',
    migFolder,
  )
    .split('\n')
    .filter(Boolean);
  const otherFiles = git('diff', '--name-only', waveBase, 'HEAD', '--', migFolder)
    .split('\n')
    .filter((f) => f && !branchFiles.includes(f));
  const g = fnInFiles(branch, branchFiles);
  const a = fnInFiles('HEAD', otherFiles);
  for (const [fn, f] of g)
    if (a.has(fn)) overlap.push(`${fn}: ${path.basename(f)} and ${path.basename(a.get(fn))}`);
}

// ---- 5) Result and commit --------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
if (resolved.length) console.log(`Resolved automatically: ${resolved.join(', ')}`);
if (overlap.length) {
  console.log(
    'WARNING: SQL functions rewritten entirely by several tracks in the wave (the one with the highest number wins):',
  );
  for (const o of overlap) console.log(`  ${o}`);
}
if (manual.length || error.length) {
  console.log('\nMUST BE RESOLVED BY HAND (the merge is left in place; git merge --abort undoes it):');
  for (const x of [...manual, ...error]) console.log(`  ${x}`);
  process.exit(1);
}
if (WITHOUT_COMMIT) {
  console.log('\nEverything resolved and validated. Not committed (--without-commit).');
  process.exit(0);
}
if (resolved.length) git('add', '--', ...resolved);
// Without conflicts git merge has already committed itself (no MERGE_HEAD). Then there is nothing to commit.
const mergeInProgress = gitOk('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
if (!mergeInProgress) {
  console.log(`\nMerged and committed by git merge: ${git('log', '--oneline', '-1').trim()}`);
  cleanupAfterMerge();
  process.exit(0);
}
const c = gitOk('commit', '--no-edit');
if (c.status !== 0 && !/nothing to commit/.test(`${c.stdout}${c.stderr}`)) {
  console.error(`commit failed:\n${c.stdout}${c.stderr}`);
  process.exit(1);
}
console.log(`\nMerged and committed: ${git('log', '--oneline', '-1').trim()}`);
cleanupAfterMerge();
process.exit(0);
