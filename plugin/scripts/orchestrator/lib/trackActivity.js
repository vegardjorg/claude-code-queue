// =============================================================
// scripts/orchestrator/lib/trackActivity.js: the last sign of life of a running track (the I/O for SILENT).
//
// WHY: a track whose agent has hung (or lost its context) still stands "running" with a worktree, so neither the
// delivery check nor STARTED WITHOUT AGENT sees it. queueLogic.silentTracks decides who is silent from a map
// id -> last activity; this file measures that time, for queue.mjs (show, state, pulse) and the board server alike.
//
// HOW: the newest of four cheap sources, cheapest first, stopping as soon as one is fresh enough (`freshMs`):
//   1. the last commit on the branch (git log -1 --format=%ct),
//   2. the track folder(s) in the scratchpad (<root>/<id>/, a shallow walk),
//   3. the agent transcript(s): the agents the time log ties to the task (the track label), their .jsonl mtime and the
//      time of their newest row,
//   4. the newest mtime in the worktree (skips node_modules and .git, at most `maxEntries` entries).
// Everything is read-only and never throws: a source that cannot be read simply gives nothing.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const TK = require('./timeCost.js');

const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * The newest mtime (ms) of the folder itself and what lies under it, breadth first. Stops after `maxEntries` entries,
 * below `maxDepth`, or as soon as an mtime >= `freshMs` is seen (the caller only needs to know that it is alive).
 * @returns {number|null}
 */
function newestMtime(dir, { maxEntries = 4000, maxDepth = 8, freshMs = Infinity } = {}) {
  let newest = null;
  const see = (ms) => {
    if (Number.isFinite(ms) && (newest == null || ms > newest)) newest = ms;
  };
  try {
    see(fs.statSync(dir).mtimeMs);
  } catch {
    return null;
  }
  let level = [dir];
  let count = 0;
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next = [];
    for (const d of level) {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (++count > maxEntries || (newest != null && newest >= freshMs)) return newest;
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        const p = path.join(d, e.name);
        try {
          see(fs.statSync(p).mtimeMs);
        } catch {
          continue;
        }
        if (e.isDirectory()) next.push(p);
      }
    }
    level = next;
  }
  return newest;
}

/**
 * Per task id: the agent ids the time log ties to it (the track label, fix rounds included: timeCost.taskIdFor) and the
 * time of the newest row for those agents.
 * @returns {Map<string, { agents: Set<string>, lastRow: number|null }>}
 */
function agentsByTask(rows, ids) {
  const known = new Set(ids);
  const agentTask = new Map();
  for (const r of rows ?? []) {
    if (!r?.agent_id || !r.track) continue;
    const id = TK.taskIdFor(r.track, (x) => known.has(x));
    if (id) agentTask.set(r.agent_id, id);
  }
  const out = new Map();
  for (const r of rows ?? []) {
    const id = r?.agent_id ? agentTask.get(r.agent_id) : null;
    if (!id) continue;
    const x = out.get(id) ?? { agents: new Set(), lastRow: null };
    x.agents.add(r.agent_id);
    const t = Date.parse(r.time ?? '');
    if (Number.isFinite(t) && (x.lastRow == null || t > x.lastRow)) x.lastRow = t;
    out.set(id, x);
  }
  return out;
}

/** The transcripts folder (~/.claude/projects/<repo-slug>, as in queue.mjs; QUEUE_TRANSCRIPTS overrides). */
function transcriptsRoot(mainTree) {
  return (
    process.env.QUEUE_TRANSCRIPTS ??
    path.join(require('node:os').homedir(), '.claude', 'projects', String(mainTree).replace(/[^A-Za-z0-9]/g, '-'))
  );
}

/** The path to an agent's transcript (<root>/<session>/subagents/agent-<id>.jsonl), or null. */
function findTranscript(root, agentId) {
  let sessions;
  try {
    sessions = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const d of sessions) {
    const p = path.join(root, d.name, 'subagents', `agent-${agentId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const mtimeOf = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * The last sign of life for one track, in ms (null = nothing found).
 * @param {{ branch: string, worktree?: string|null, trackDirs?: string[], agents?: { agents: Set<string>,
 *   lastRow: number|null } | null, findTranscript?: (agentId: string) => string|null, git?: (args: string[]) => string|null,
 *   freshMs?: number, maxEntries?: number }} x
 * @returns {{ ms: number|null, source: string|null }}
 */
function lastActivity({
  branch,
  worktree = null,
  trackDirs = [],
  agents = null,
  findTranscript: find = null,
  git = null,
  freshMs = Infinity,
  maxEntries = 4000,
}) {
  let best = { ms: null, source: null };
  const see = (ms, source) => {
    if (Number.isFinite(ms) && (best.ms == null || ms > best.ms)) best = { ms, source };
    return best.ms != null && best.ms >= freshMs;
  };
  if (git && branch) {
    const s = String(git(['log', '-1', '--format=%ct', `refs/heads/${branch}`, '--']) ?? '').trim();
    if (see(/^\d+$/.test(s) ? Number(s) * 1000 : null, 'commit')) return best;
  }
  for (const d of trackDirs) if (see(newestMtime(d, { maxEntries: 200, maxDepth: 2, freshMs }), 'track folder')) return best;
  if (agents) {
    if (see(agents.lastRow, 'time log')) return best;
    for (const id of agents.agents) {
      const p = find ? find(id) : null;
      if (p && see(mtimeOf(p), 'transcript')) return best;
    }
  }
  if (worktree) see(newestMtime(worktree, { maxEntries, freshMs }), 'worktree');
  return best;
}

module.exports = { newestMtime, agentsByTask, transcriptsRoot, findTranscript, lastActivity, SKIP_DIRS };
