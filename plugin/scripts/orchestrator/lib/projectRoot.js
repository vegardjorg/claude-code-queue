// =============================================================
// projectRoot.js: finds the project the queue works on, independent of where the scripts themselves live.
//
// Two install modes:
//   - Vendored (install.mjs): the scripts live in <project>/scripts/orchestrator/. The project is two folders up, and
//     queue.config.json lies there. This was the only mode before, and it behaves exactly as before.
//   - Plugin: the scripts live in Claude Code's plugin folder, far away from the project. The project is found from the
//     working directory (cwd) instead, or from CLAUDE_PROJECT_DIR, which Claude Code sets for hooks.
//
// Two roots are returned:
//   - main: the main tree, where the queue data and queue.config.json live. The same for every worktree of the repo,
//     otherwise each track would get its own empty queue.
//   - tree: the tree we run in. In a worktree (a track) this is the worktree, otherwise the main tree.
//
// The main tree is found with plain file reads (no `git` process), because hooks run on every tool call and must be fast.
// A worktree has a FILE named .git with "gitdir: <main>/.git/worktrees/<name>"; that folder has a file `commondir`
// pointing to <main>/.git.
//
// Order for main: QUEUE_ROOT (tests, backup scripts) -> vendored location -> cwd -> CLAUDE_PROJECT_DIR -> vendored
// location even without queue.config.json (old behaviour as the last fallback).
// =============================================================
const fs = require('node:fs');
const path = require('node:path');

const WORKTREE_PART = `${path.sep}.claude${path.sep}worktrees${path.sep}`;

/** Compares two paths; case-insensitive on Windows, where C:\X and c:\x are the same folder. */
function samePath(a, b, platform = process.platform) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * The nearest git work tree at or above `start`: { top, main } or null when `start` is not inside a git repo.
 * `top` is the folder that holds .git; `main` is the main tree (the same as `top` unless `top` is a linked worktree).
 * @param {string} start
 * @param {{ fs?: typeof fs }} [o] fs can be replaced in tests
 */
function gitTree(start, o = {}) {
  const f = o.fs ?? fs;
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = f.statSync(dotGit);
    } catch {
      /* no .git here, go up */
    }
    if (stat?.isDirectory()) return { top: dir, main: dir };
    if (stat?.isFile()) return { top: dir, main: mainFromGitFile(dir, dotGit, f) };
    const up = path.dirname(dir);
    if (up === dir) return null; // reached the drive root
    dir = up;
  }
}

/**
 * The main tree for a .git FILE (linked worktree or submodule). For a worktree, gitdir/commondir points to the shared
 * <main>/.git, whose parent folder is the main tree. A submodule has no commondir and counts as its own main tree.
 */
function mainFromGitFile(top, dotGit, f) {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(f.readFileSync(dotGit, 'utf8'));
    if (!m) return top;
    const gitdir = path.resolve(top, m[1]); // gitdir may be relative (worktree.useRelativePaths)
    const common = path.resolve(gitdir, f.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    return path.basename(common) === '.git' ? path.dirname(common) : top;
  } catch {
    return top; // no commondir: a submodule, or a broken worktree; use the folder itself
  }
}

/**
 * Finds main and tree (see the top of the file).
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, scriptDir?: string, fs?: typeof fs, platform?: string }} [o]
 *   scriptDir = the folder of the orchestrator scripts (default: the folder above lib/). Everything can be replaced in tests.
 * @returns {{ main: string, tree: string, mode: 'env' | 'vendored' | 'cwd' | 'project-dir' | 'fallback' }}
 */
function resolveRoots(o = {}) {
  const f = o.fs ?? fs;
  const env = o.env ?? process.env;
  const cwd = path.resolve(o.cwd ?? process.cwd());
  const platform = o.platform ?? process.platform;
  const scriptDir = path.resolve(o.scriptDir ?? path.join(__dirname, '..'));
  const here = gitTree(cwd, { fs: f });
  // tree = the work tree of cwd when it belongs to the same repo as main, otherwise main itself.
  const treeFor = (main) => (here && samePath(here.main, main, platform) ? here.top : main);

  if (env.QUEUE_ROOT) {
    const main = path.resolve(env.QUEUE_ROOT);
    return { main, tree: treeFor(main), mode: 'env' };
  }

  // Vendored: <project>/scripts/orchestrator/. The tree is where the script lives (also a worktree's own copy), as before.
  const legacyTree = path.resolve(scriptDir, '..', '..');
  const legacyMain = legacyTree.split(WORKTREE_PART)[0];
  if (exists(f, path.join(legacyMain, 'queue.config.json'))) {
    return { main: legacyMain, tree: legacyTree, mode: 'vendored' };
  }

  if (here) return { main: here.main, tree: here.top, mode: 'cwd' };

  if (env.CLAUDE_PROJECT_DIR) {
    const project = gitTree(env.CLAUDE_PROJECT_DIR, { fs: f });
    if (project) return { main: project.main, tree: project.main, mode: 'project-dir' };
  }

  return { main: legacyMain, tree: legacyTree, mode: 'fallback' };
}

function exists(f, filePath) {
  try {
    return f.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

let buffer = null;

/** resolveRoots() for this process, computed once (cwd and the environment do not change while a script runs). */
function roots() {
  if (!buffer) buffer = resolveRoots();
  return buffer;
}

/**
 * Does this project use the queue? True when queue.config.json lies in the main tree, or when any QUEUE_* variable is
 * set (tests and scripts that point the queue somewhere explicitly). The hooks ask this first and exit at once when it
 * is false: a plugin's hooks run in EVERY project the user opens, and must cost nothing where the queue is not set up.
 * @param {{ env?: NodeJS.ProcessEnv, main?: string, fs?: typeof fs }} [o]
 */
function queueActive(o = {}) {
  const env = o.env ?? process.env;
  if (Object.keys(env).some((k) => k.startsWith('QUEUE_'))) return true;
  return exists(o.fs ?? fs, path.join(o.main ?? roots().main, 'queue.config.json'));
}

/**
 * The command to write in hints, missions and handover notes: `cq` in a plugin install (bin/cq is on PATH), and
 * `node scripts/orchestrator/cq.mjs` in a vendored install, where nothing is on PATH. With `fromWorktree`, the vendored
 * form points at the main tree's copy, for commands a track runs inside its worktree.
 * @param {{ fromWorktree?: boolean, mode?: string }} [o]
 */
function cqCommand(o = {}) {
  if ((o.mode ?? roots().mode) !== 'vendored') return 'cq';
  return o.fromWorktree ? 'node <mainTree>/scripts/orchestrator/cq.mjs' : 'node scripts/orchestrator/cq.mjs';
}

/** The plugin's name in .claude-plugin/plugin.json: the prefix of its skills (/cq:queue) and agents (cq:track). */
const PLUGIN_NAME = 'cq';

/**
 * The subagent_type to start an agent with. A plugin's agents are named `<plugin>:<agent>` (cq:track); a vendored
 * install has them in .claude/agents/ under the bare name. Names that already have a prefix are left alone.
 * @param {string} name  bare agent name, e.g. "track" or "reviewer"
 * @param {{ mode?: string }} [o]
 */
function agentRef(name, o = {}) {
  if (!name || String(name).includes(':') || (o.mode ?? roots().mode) === 'vendored') return name;
  return `${PLUGIN_NAME}:${name}`;
}

/** The bare agent name from a hook payload or the time log: "cq:track" -> "track". Everything compares bare names. */
function bareAgentType(type) {
  return typeof type === 'string' && type.startsWith(`${PLUGIN_NAME}:`) ? type.slice(PLUGIN_NAME.length + 1) : type;
}

module.exports = {
  resolveRoots,
  roots,
  queueActive,
  cqCommand,
  agentRef,
  bareAgentType,
  PLUGIN_NAME,
  gitTree,
  samePath,
};
