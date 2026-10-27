// =============================================================
// orchestratorHelp.js: pure helper functions for the gate runner (gates.mjs), worktree preparation
// (prepare-track.mjs) and worktree cleanup (cleanup-worktree.mjs).
//
// Everything here is pure functions without fs, git or processes, so the decisions can be unit tested
// (lib/__tests__/orchestratorHelp.test.ts). The scripts do the I/O and call here to decide.
// See docs/orchestration.md for how tracks are prepared and cleaned up.
// =============================================================
'use strict';

/** Normalizes paths from git (Windows may give backslashes). */
function normalizePath(s) {
  return String(s).trim().split('\\').join('/');
}

/** Removes ANSI color codes. */
function withoutColors(s) {
  return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

const summary = (s, max = 200) => {
  const t = String(s).trim().replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/** Makes an absolute path in an error line relative to the root, so the line becomes short and readable. */
function relative(line, root) {
  if (!root) return line;
  const r1 = normalizePath(root).replace(/\/$/, '') + '/';
  const r2 = r1.split('/').join('\\');
  return line.split(r1).join('').split(r2).join('');
}

/**
 * Which kind of tool a gate command is, so firstErrorLine knows what to look for.
 * 'tsc', 'eslint', 'prettier', 'test' (vitest/jest/mocha/node --test) or 'other'.
 */
function gateType(command) {
  const k = String(command || '');
  if (/\btsc\b/.test(k)) return 'tsc';
  if (/\beslint\b/.test(k)) return 'eslint';
  if (/\bprettier\b/.test(k)) return 'prettier';
  if (/\b(vitest|jest|mocha)\b|--test\b|\bnpm (run )?test\b/.test(k)) return 'test';
  return 'other';
}

/**
 * Picks the first meaningful error line from the output of a red gate. `type` is 'tsc', 'eslint',
 * 'prettier', 'test' (or 'jest') or something else (generic). Falls back to the last non-empty line.
 */
function firstErrorLine(type, text, root) {
  const lines = withoutColors(text)
    .split(/\r?\n/)
    .map((l) => relative(l, root));
  const notEmpty = lines.filter((l) => l.trim());
  const find = (re) => lines.find((l) => re.test(l));

  if (type === 'tsc') {
    const l = find(/error TS\d+:/);
    if (l) return summary(l);
  }
  if (type === 'eslint') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s+(\d+:\d+)\s+error\s+(.*)$/);
      if (!m) continue;
      let file = '';
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j].trim() && !/^\s/.test(lines[j])) {
          file = lines[j].trim();
          break;
        }
      }
      return summary(`${file}:${m[1]} ${m[2]}`);
    }
    const l = find(/(Error|Oops!|Cannot find)/);
    if (l) return summary(l);
  }
  if (type === 'prettier') {
    const l =
      find(/^\[error\]/) ||
      lines.find((x) => /^\[warn\]\s+\S/.test(x) && !/Code style issues|Run Prettier/i.test(x));
    if (l) return summary('not formatted: ' + l.replace(/^\[(warn|error)\]\s*/, ''));
  }
  if (type === 'test' || type === 'jest') {
    const l = lines.find((x) => /^\s*(●|×|✗|FAIL) /.test(x) && !/● Console/.test(x));
    if (l) return summary(l);
  }
  const generic = find(
    /(✗|✖|❌|\bERROR\b|\berror:|\bRED\b|\bError\b|\bERROR\b|\bviolations?\b|\bmissing\b|\bfailed\b)/,
  );
  if (generic) return summary(generic);
  return summary(notEmpty[notEmpty.length - 1] || '(no output)');
}

/** Formats the result line for one gate: `name  GREEN 12 s` / `name  RED 40 s: first error line`. */
function resultLine(r, width = 34) {
  const name = r.name.padEnd(width);
  const s = `${Math.round(r.sec)} s`;
  if (r.status === 'GREEN') return `${name} GREEN ${s}`;
  return `${name} RED ${s}${r.first ? `: ${r.first}` : ''}`;
}

/**
 * What prepare-track.mjs should do with the branch.
 *  - 'keep': already on the wanted branch.
 *  - 'switch': `git switch <branch>` without -B. The target branch already exists with commits not on the base (typically
 *    after `queue.mjs release`, which keeps the branch, or a new worktree for a continuation). A `checkout -B`
 *    would reset it, and the commits would only remain in the reflog.
 *  - 'checkout': new `git checkout -B <branch> <base>` (the worktree is clean, has no commits of its own, and the target
 *    branch does not exist or has no commits ahead of the base).
 *  - 'deny': would throw away work (dirty tree, or commits not on the base).
 *
 * `measureCommits` is the number of commits on the target branch not on the base (0 or undefined when the branch does not exist).
 * `base` is the name of the base in the texts (default "baseBranch").
 */
function branchDecision({ current, branch, dirty, ownCommits, measureCommits = 0, base = 'baseBranch' }) {
  if (current === branch) return { action: 'keep' };
  if (dirty) {
    const reason = `uncommitted changes on ${current || '(detached HEAD)'}`;
    return {
      action: 'deny',
      reason:
        measureCommits > 0
          ? `${reason}; ${branch} exists with ${measureCommits} commit(s) ahead of ${base} and can only be taken over from a clean worktree`
          : reason,
    };
  }
  if (ownCommits > 0)
    return {
      action: 'deny',
      reason: `${current || '(detached HEAD)'} has ${ownCommits} commit(s) that are not on ${base}`,
    };
  if (measureCommits > 0) return { action: 'switch', measureCommits };
  return { action: 'checkout' };
}

/**
 * What prepare-track.mjs should do with the branch under `--continue`: a fix round or continuation of a track in a NEW
 * agent and a new worktree. The branch is taken over as is, never reset (`checkout -B`), and its own commits are counted
 * afterwards against the base.
 *  - 'keep': already on the branch.
 *  - 'switch': `git switch <branch>` without reset.
 *  - 'deny': the branch does not exist, is checked out in another worktree, the worktree is dirty, or a detached HEAD has
 *    commits not on the base (they would be left dangling without a branch).
 *
 * `otherWorktree` is the path to ANOTHER worktree that has the branch checked out (see worktreeWithBranch), otherwise null.
 * An ordinary worktree branch (worktree-agent-x) with its own commits does not block the switch: the commits stay on it.
 */
function continueDecision({
  current,
  branch,
  exists,
  dirty,
  ownCommits = 0,
  otherWorktree,
  base = 'baseBranch',
}) {
  if (!exists)
    return {
      action: 'deny',
      reason: `${branch} does not exist; --continue only takes over an existing branch (new track: run without --continue)`,
    };
  if (current === branch) return { action: 'keep' };
  if (otherWorktree)
    return {
      action: 'deny',
      reason: `${branch} is checked out in another worktree (${otherWorktree}); free it with \`git -C "${otherWorktree}" switch --detach\` and run again`,
    };
  if (dirty)
    return { action: 'deny', reason: `uncommitted changes on ${current || '(detached HEAD)'}` };
  if (!current && ownCommits > 0)
    return {
      action: 'deny',
      reason: `detached HEAD has ${ownCommits} commit(s) that are not on ${base}; make a branch for them first`,
    };
  return { action: 'switch' };
}

/**
 * Finds the worktree that has `branch` checked out, from the output of `git worktree list --porcelain`.
 * Gives the path (as git wrote it) or null. Compares the whole ref name, so queue/X does not match queue/X-r1.
 * @param {string} porcelain
 * @param {string} branch
 * @returns {string | null}
 */
function worktreeWithBranch(porcelain, branch) {
  let filePath = null;
  for (const raw of String(porcelain).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) filePath = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return filePath;
  }
  return null;
}

/**
 * The paths (relative to the worktree root, with "/") that prepare-track.mjs creates as links (junction on Windows,
 * symlink otherwise) to the MAIN TREE's folders, and that cleanup-worktree.mjs must remove as LINKS (never recursively) before a
 * worktree is deleted. Both read the list from here, so they never drift apart: a link the cleanup does not know about
 * can be followed by a recursive delete and empty the folder in mainTree.
 *
 * The source is config().sharedLinks (default ['node_modules']). Invalid paths (absolute, with "..", empty) are dropped.
 * @param {string[]} [sharedLinks]
 * @returns {string[]}
 */
function trackLinks(sharedLinks) {
  const list = sharedLinks ?? require('./queueConfig.js').config().sharedLinks ?? [];
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const rel = normalizePath(raw).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..'))
      continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

module.exports = {
  firstErrorLine,
  continueDecision,
  gateType,
  branchDecision,
  normalizePath,
  resultLine,
  trackLinks,
  withoutColors,
  worktreeWithBranch,
};
