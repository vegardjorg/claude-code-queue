// =============================================================
// mergeGuard.js: the guard check merge-track.mjs runs BEFORE a track branch is merged (hardening against prompt
// injection).
//
// WHY: a track can change hooks, settings, agent definitions, orchestrator scripts, the queue config and CI. A hook in
// .claude/settings.json runs with the owner's full rights in the orchestrator session the next time it starts. If the
// track has read hostile text (a PDF, a web page, another agent's report) and followed an instruction in it, that must
// not slip silently through the merge. The guard lives here because Claude Code has no sandbox on Windows.
//
// The rule:
//   - STOP: the diff touches a protected path (config().protectedPaths) that is not in the task's owned_files or
//     shared_patch. `--allow-guard` overrides; merge-track.mjs logs it in the time log (event "guard-overridden").
//   - WARNING: other files outside owned_files + shared_patch (ownership drift). Migrations in the task's migr_block
//     count as owned. If the task has no ownership at all (a wave track without a queue entry), no drift warning.
//   - Ownership ending with "/" covers the whole folder; otherwise the path must be equal.
//   - Rename and copy count both paths: moving a file INTO .claude/ is as dangerous as writing it there, and moving
//     .claude/settings.json OUT deletes it.
//
// Protected path entries (protectedPaths in queue.config.json, see STANDARD in queueConfig.js):
//   "folder/"      the folder and everything under it (from the root)
//   "dir/file"     exactly that path (from the root)
//   "name"         (no slash) a file with that name in ANY folder, e.g. package.json: npm runs lifecycle scripts
//                  (postinstall …) from every package.json.
// Paths under node_modules/ are never protected (they are links, not committed).
//
// Pure logic without I/O; merge-track.mjs fetches the diff (git diff --name-status -M) and the task (queue.json).
// Test: lib/__tests__/mergeGuard.test.ts.
// =============================================================

/** Common form of a path: forward slashes, no leading ./ */
function norm(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

/** The default list (STANDARD.protectedPaths), read lazily so this module stays pure for the tests. */
function defaultProtected() {
  return require('./queueConfig.js').STANDARD.protectedPaths;
}

/**
 * Is the path protected?
 * @param {string} p
 * @param {string[]} [protectedPaths] default STANDARD.protectedPaths
 */
function isProtected(p, protectedPaths = defaultProtected()) {
  const s = norm(p);
  if (s.startsWith('node_modules/') || s.includes('/node_modules/')) return false;
  const name = s.split('/').pop();
  return (protectedPaths || []).map(norm).some((b) => {
    if (!b) return false;
    if (b.endsWith('/')) return s.startsWith(b);
    if (!b.includes('/')) return name === b;
    return s === b;
  });
}

/** Does one ownership entry cover the path? "folder/" covers subfolders, otherwise exactly equal. */
function covers(owner, p) {
  const e = norm(owner);
  if (!e) return false;
  return e.endsWith('/') ? p.startsWith(e) : p === e;
}

/**
 * Does the migration block ("3600–3609", or "20260926002840–2849" with a shortened end) cover the migration file?
 * The file must lie directly in migrations.folder, and its name must match migrations.filePattern (group 1 = the
 * number). A shortened end replaces the last digits of the start.
 * @param {string} p
 * @param {string|null} migrBlock
 * @param {{ folder?: string|null, filePattern?: string }|null} [migrations]
 */
function migrCovered(p, migrBlock, migrations) {
  if (!migrBlock || !migrations?.folder) return false;
  const s = norm(p);
  const folder = norm(migrations.folder).replace(/\/+$/, '');
  if (!s.startsWith(`${folder}/`)) return false;
  const file = s.slice(folder.length + 1);
  if (file.includes('/')) return false;
  let m;
  try {
    m = file.match(new RegExp(migrations.filePattern || '^(\\d+)_'));
  } catch {
    return false;
  }
  if (!m || !/^\d+$/.test(m[1] ?? '')) return false;
  const pieces = String(migrBlock)
    .split(/\s*[–—-]\s*/)
    .map((d) => d.trim())
    .filter(Boolean);
  if (pieces.length === 0 || !pieces.every((d) => /^\d+$/.test(d))) return false;
  const from = pieces[0];
  let to = pieces[1] ?? from;
  if (to.length < from.length) to = from.slice(0, from.length - to.length) + to;
  const n = m[1];
  if (n.length !== from.length) return false;
  return BigInt(n) >= BigInt(from) && BigInt(n) <= BigInt(to);
}

/**
 * Parse the output of `git diff --name-status -M`. Each line: "M\tpath", "R100\told\tnew", "C075\tfrom\tto".
 * Returns [{ status: 'M'|'A'|'D'|'R'|'C'|…, paths: [..] }].
 * @param {string} text
 */
function readDiff(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const [code, ...paths] = l.split('\t');
      return { status: code.trim().charAt(0), paths: paths.map(norm).filter(Boolean) };
    })
    .filter((e) => e.paths.length > 0);
}

/**
 * The task id from a queue branch: "queue/A-1" and "origin/queue/A-1" give "A-1"; other branches give null.
 * @param {string} branch
 * @param {string} [branchPrefix] config().branchPrefix, default "queue/"
 */
function taskIdFromBranch(branch, branchPrefix = 'queue/') {
  const prefix = String(branchPrefix || '');
  if (!prefix) return null;
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(branch || '').match(new RegExp(`(?:^|/)${esc}([^/]+)$`));
  return m ? m[1] : null;
}

/**
 * Assess a diff against the task's ownership.
 * @param {{ changes: { status: string, paths: string[] }[], ownedFiles?: string[], sharedPatch?: string[],
 *           migrBlock?: string | null, migrations?: { folder?: string|null, filePattern?: string } | null,
 *           protectedPaths?: string[], allowGuard?: boolean }} input
 * @returns {{ violations: { path: string, reason: string }[], drift: string[], stop: boolean, overridden: boolean }}
 */
function assessGuard({
  changes,
  ownedFiles = [],
  sharedPatch = [],
  migrBlock = null,
  migrations = null,
  protectedPaths = defaultProtected(),
  allowGuard = false,
}) {
  const owned = [...(ownedFiles || []), ...(sharedPatch || [])].map(norm).filter(Boolean);
  const hasOwnership = owned.length > 0 || Boolean(migrBlock);
  const isOwned = (p) => owned.some((e) => covers(e, p)) || migrCovered(p, migrBlock, migrations);

  const violations = [];
  const drift = [];
  const seen = new Set();
  for (const e of changes || []) {
    const move = (e.status === 'R' || e.status === 'C') && e.paths.length === 2;
    e.paths.forEach((raw, i) => {
      const p = norm(raw);
      // On a copy the source is not changed; only the target counts.
      if (e.status === 'C' && i === 0) return;
      if (seen.has(p)) return;
      seen.add(p);
      if (isOwned(p)) return;
      if (isProtected(p, protectedPaths)) {
        let reason = "protected path, not in the task's owned_files/shared_patch";
        if (move && e.status === 'R')
          reason += i === 1 ? ` (renamed from ${e.paths[0]})` : ` (renamed to ${e.paths[1]})`;
        violations.push({ path: p, reason });
      } else if (hasOwnership) drift.push(p);
    });
  }
  return {
    violations,
    drift,
    stop: violations.length > 0 && !allowGuard,
    overridden: violations.length > 0 && Boolean(allowGuard),
  };
}

module.exports = {
  isProtected,
  readDiff,
  migrCovered,
  taskIdFromBranch,
  assessGuard,
};
