// =============================================================
// scripts/orchestrator/lib/trackDiff.js: which files a merged track branch itself changed.
//
// WHY: some gates want to know which files the track has changed (e.g. to run only the affected tests, or to
// separate an error the track introduced from an error that already existed in the base). In a track worktree it is easy:
// base...HEAD plus the working tree. But when `queue.mjs merge` runs the gates on baseBranch AFTER the merge, HEAD equals
// base and the list is empty, so the gates would think the track changed nothing.
//
// HOW: the merge step remembers the branch's fork point (merge-base against baseBranch BEFORE the merge) and the branch tip,
// and passes them to the gates as `--track-base <sha> --track-tip <sha>`. The branch's own changes are then the diff
// separator...tip. We use the tip and not HEAD, because separator..HEAD on baseBranch also includes other tracks merged
// after the fork point; they must not count as this track.
// =============================================================
'use strict';

/**
 * The arguments the merge step gives the gates. Empty when something is missing (the gates then only look at `changed`, as before).
 * @param {{ separator?: string | null, tip?: string | null }} k
 * @returns {string[]}
 */
function trackArgs({ separator, tip }) {
  if (!separator || !tip) return [];
  return ['--track-base', separator, '--track-tip', tip];
}

/**
 * The files the track has changed.
 * Without `trackBase`: `changed` (base...HEAD + the working tree, as the gates see it in a track worktree).
 * With `trackBase`: the branch's own diff trackBase...trackTip (HEAD when the tip is missing), plus `changed` (the
 * orchestrator's working tree), without duplicates.
 * @param {{ git: (...args: string[]) => string | null, trackBase?: string | null, trackTip?: string | null,
 *   changed: string[] }} k  `git` gives stdout, or null when the command failed
 * @returns {string[] | null} null when the diff could not be read (the caller then stops instead of guessing)
 */
function trackChangedFiles({ git, trackBase, trackTip, changed }) {
  if (!trackBase) return [...changed];
  const out = git('diff', '--name-only', `${trackBase}...${trackTip || 'HEAD'}`);
  if (out == null) return null;
  const files = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...files, ...changed])];
}

module.exports = { trackArgs, trackChangedFiles };
