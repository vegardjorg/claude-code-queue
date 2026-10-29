// =============================================================
// queueGit.js: the git reading for the work queue (work outside the queue).
//
// Answers three questions: what on baseBranch comes from the queue (merge of <branchPrefix><id>), from the orchestrator
// (the trailer "Queue: orchestrator") and from outside the queue; which branches and worktrees outside the queue's branchPrefix
// have commits not in baseBranch; and which files are uncommitted in mainTree.
//
// The base branch, the remote and the branch prefix come from queue.config.json (queueConfig.js: baseBranch, remote, branchPrefix).
// The functions take them as optional parameters, so the tests can control them without a config file.
//
// Read only, and always with --no-optional-locks: `git status` must never take index.lock from another session that
// commits in mainTree concurrently. The decisions (classification, collisions, cutPoint, consistency) live in
// queueLogic.js. Used by queue.mjs, queue-takeover.mjs and push-check.mjs. Tested against a temporary repo in
// scripts/orchestrator/lib/__tests__/queueExternal.test.ts (never the main repo).
// =============================================================
'use strict';

const { execFileSync } = require('node:child_process');
const L = require('./queueLogic.js');
const { config } = require('./queueConfig.js');

/** The integration branch from the config (default main). Read at call time, not at load time. */
const baseBranch = () => config().baseBranch || 'main';
/** The remote from the config (default origin). */
const remoteName = () => config().remote || 'origin';
/** The branch prefix for queue tasks from the config (default queue/). */
const branchPrefix = () => config().branchPrefix || 'queue/';
/**
 * Branches never counted as "work outside the queue" in addition to baseBranch (typically the release branch that follows
 * baseBranch). From the config (`excludeBranches`), default main and master.
 */
const excludedBranches = () => config().excludeBranches ?? ['main', 'master'];
/** The remote reference to baseBranch, e.g. origin/main. */
const removeBase = ({ base = baseBranch(), remote = remoteName() } = {}) => `${remote}/${base}`;

// Field and record separators in `git log --format` (%x1f and %x1e). Made with fromCharCode, not as escapes in the source.
const US = String.fromCharCode(0x1f);
const RS = String.fromCharCode(0x1e);
const FORMAT = '%x1e%H%x1f%P%x1f%cI%x1f%s%x1f%B%x1f';

/**
 * git runner for a repo: (args) → stdout (untrimmed), or null when git fails. core.quotepath=off gives non-ASCII
 * characters in file names as they are.
 */
function makeGit(cwd) {
  return (args) => {
    try {
      return execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
}

const lines = (out) =>
  String(out ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/** Parses `git log --format=FORMAT [--name-only]`: [{ sha, summary, parents, date, subject, message, files }]. */
function parseLog(out) {
  return String(out ?? '')
    .split(RS)
    .filter((r) => r.includes(US))
    .map((r) => {
      const [sha, parents = '', date = '', subject = '', message = '', rest = ''] = r.split(US);
      const s = sha.trim();
      return {
        sha: s,
        summary: s.slice(0, 8),
        parents: parents.split(' ').filter(Boolean),
        date: date.trim(),
        subject: subject.trim(),
        message: message.trim(),
        files: lines(rest),
      };
    });
}

/**
 * The first-parent line on `to` (default baseBranch), NEWEST FIRST, with the files each commit changed against the first
 * parent (for a merge: everything it brought in). The window is `from..to` (e.g. origin/main..main) or `--since=<since>`.
 * null when git fails (unknown ref).
 * @param {(args: string[]) => string|null} git
 * @param {{ from?: string, to?: string, since?: string }} window
 */
function readFirstParents(git, { from, to = baseBranch(), since } = {}) {
  const args = [
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--name-only',
    `--format=${FORMAT}`,
  ];
  if (since) args.push(`--since=${since}`);
  args.push(from ? `${from}..${to}` : to, '--');
  const out = git(args);
  return out == null ? null : parseLog(out);
}

/**
 * Classifies the first-parent commits (queueLogic.classifyCommit). A merge that is not of a queue branch is external
 * when it is itself external or brings in at least one commit without the trailer; the commits it brings in (not reachable
 * from the first parent or from `from`) are in `side`.
 */
function classify(git, commits, { from } = {}) {
  return (commits ?? []).map((c) => {
    const k = L.classifyCommit(c);
    if (c.parents.length < 2 || k.source === 'queue') return { ...c, ...k, side: [] };
    const [first, ...others] = c.parents;
    const args = ['log', `--format=${FORMAT}`, ...others, `^${first}`];
    if (from) args.push(`^${from}`);
    args.push('--');
    const side = parseLog(git(args)).map((s) => ({
      ...s,
      source: L.hasOrchestratorTrailer(s.message) ? 'orchestrator' : 'external',
    }));
    const external = k.source === 'external' || side.some((s) => s.source === 'external');
    return { ...c, source: external ? 'external' : 'orchestrator', side };
  });
}

/**
 * Uncommitted changes (`git status --porcelain -z`): [{ xy, path, untracked }]. Untracked folders appear as "folder/"
 * (git collapses them). Gitignored files are not included. null when git fails.
 */
function readUncommitted(git) {
  const out = git(['status', '--porcelain', '-z']);
  if (out == null) return null;
  const parts = out.split('\0');
  const res = [];
  for (let i = 0; i < parts.length; i++) {
    const d = parts[i];
    if (!d || d.length < 4) continue;
    const xy = d.slice(0, 2);
    res.push({ xy, path: d.slice(3), untracked: xy === '??' });
    // Renamed or copied: the old path follows as a separate field.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return res;
}

/** `git worktree list --porcelain`: [{ path, head, branch (without refs/heads/) | null, detached (detached) }]. */
function readWorktrees(git) {
  const out = [];
  let wt = null;
  for (const line of String(git(['worktree', 'list', '--porcelain']) ?? '').split('\n')) {
    if (line.startsWith('worktree ')) {
      wt = { path: line.slice(9).trim(), head: null, branch: null, detached: false };
      out.push(wt);
    } else if (wt && line.startsWith('HEAD ')) wt.head = line.slice(5).trim();
    else if (wt && line.startsWith('branch refs/heads/')) wt.branch = line.slice(18).trim();
    else if (wt && line.trim() === 'detached') wt.detached = true;
  }
  return out;
}

/** Number of commits, changed files (against the merge base) and last commit for a ref not merged into `base`. */
function refInfo(git, ref, base) {
  return {
    count: Number(String(git(['rev-list', '--count', `${base}..${ref}`]) ?? '0').trim()) || 0,
    files: lines(git(['diff', '--name-only', `${base}...${ref}`, '--'])),
    last: String(git(['log', '-1', '--format=%cI', ref, '--']) ?? '').trim() || null,
  };
}

/**
 * Local branches outside the queue's branchPrefix (and not baseBranch or `exclude`) with commits not in `base`, plus
 * detached worktrees with such commits (except those on the queue's work, e.g. a PARTIAL track after
 * `git switch --detach`). [{ name, count, files, last, worktree }], or null when git fails.
 * @param {{ base?: string, prefix?: string, exclude?: string[] }} [option] default from the config
 */
function readOtherBranches(
  git,
  { base = baseBranch(), prefix = branchPrefix(), exclude = excludedBranches() } = {},
) {
  const out = git([
    'for-each-ref',
    `--no-merged=${base}`,
    '--format=%(refname:short)',
    'refs/heads',
  ]);
  if (out == null) return null;
  const wts = readWorktrees(git);
  const wtPerBranch = new Map(wts.filter((w) => w.branch).map((w) => [w.branch, w.path]));
  const excluded = (n) => n.startsWith(prefix) || n === base || exclude.includes(n);
  const branches = [];
  for (const name of lines(out)) {
    if (excluded(name)) continue;
    const info = refInfo(git, name, base);
    if (info.count > 0) branches.push({ name, ...info, worktree: wtPerBranch.get(name) ?? null });
  }
  for (const w of wts.filter((x) => x.detached && x.head)) {
    const info = refInfo(git, w.head, base);
    if (!info.count) continue;
    const onQueue = lines(
      git(['branch', '--list', `${prefix}*`, '--contains', w.head, '--format=%(refname:short)']),
    );
    if (onQueue.length) continue;
    branches.push({ name: `(detached ${w.head.slice(0, 8)})`, ...info, worktree: w.path });
  }
  return branches;
}

/**
 * The sources of work outside the queue in a window: classified first-parent commits, the external ones, branches outside
 * the queue's branchPrefix and uncommitted files in the repo `git` points at (mainTree). `error` lists what could not be read.
 * @param {{ window?: object, base?: string, prefix?: string, exclude?: string[] }} [option] default from the config
 */
function externalSources(git, { window = {}, base = baseBranch(), prefix, exclude } = {}) {
  const error = [];
  const raw = readFirstParents(git, { to: base, ...window });
  if (raw == null) error.push(`could not read ${window.from ? `${window.from}..` : ''}${base}`);
  const commits = classify(git, raw ?? [], { from: window.from });
  const branches = readOtherBranches(git, { base, prefix, exclude });
  if (branches == null) error.push('could not read the branches');
  const uncommitted = readUncommitted(git);
  if (uncommitted == null) error.push('could not read git status');
  return {
    commits,
    externalOnes: commits.filter((c) => c.source === 'external'),
    branches: branches ?? [],
    uncommitted: uncommitted ?? [],
    error,
  };
}

/**
 * The whole picture for `queue.mjs external`: the sources, consistency (external commits that mention a task), collisions with
 * the owned files (queueLogic.externalCollisions) and tasks without a project or feature.
 */
function externalImage(git, queue, { window = {}, base = baseBranch(), prefix, exclude } = {}) {
  const k = externalSources(git, { window, base, prefix, exclude });
  const tasks = queue.tasks ?? [];
  return {
    ...k,
    consistency: L.consistency(k.externalOnes, tasks),
    collisions: L.externalCollisions(tasks, {
      commits: k.externalOnes,
      branches: k.branches,
      uncommitted: k.uncommitted.map((u) => u.path),
    }),
    registered: tasks.filter((o) => L.isExternalRow(o) && o.status === 'external'),
    missing: L.missingProject(tasks, queue.projects),
  };
}

/**
 * Per task (for `start`, `pick` and `trackFile`): the collisions since the task was added, external commits that
 * mention the id, and the warning text for the track block. Map id → { collisions, mentioned, warning }.
 */
function externalForTasks(
  git,
  tasks,
  { base = baseBranch(), now = Date.now(), prefix, exclude } = {},
) {
  const list = (tasks ?? []).filter(Boolean);
  const times = list.map((o) => Date.parse(o.added_at ?? '')).filter(Number.isFinite);
  // Without added_at: the last 30 days.
  const fromMs = times.length ? Math.min(...times) : now - 30 * 86_400_000;
  const k = externalSources(git, {
    window: { since: new Date(fromMs).toISOString() },
    base,
    prefix,
    exclude,
  });
  const answer = new Map();
  for (const o of list) {
    const addedAt = Date.parse(o.added_at ?? '');
    const after = k.externalOnes.filter(
      (c) => !Number.isFinite(addedAt) || !c.date || Date.parse(c.date) > addedAt,
    );
    const collisions = L.externalCollisions(
      [o],
      { commits: after, branches: k.branches, uncommitted: k.uncommitted.map((u) => u.path) },
      { statuses: [o.status] },
    );
    const mentioned = L.consistency(after, [o]).map((s) => ({ summary: s.summary, subject: s.subject }));
    answer.set(o.id, {
      collisions,
      mentioned,
      warning: L.trackFileWarning(o, collisions, mentioned),
      error: k.error,
    });
  }
  return answer;
}

module.exports = {
  baseBranch,
  remoteName,
  branchPrefix,
  excludedBranches,
  removeBase,
  makeGit,
  parseLog,
  readFirstParents,
  classify,
  readUncommitted,
  readWorktrees,
  readOtherBranches,
  externalSources,
  externalImage,
  externalForTasks,
};
