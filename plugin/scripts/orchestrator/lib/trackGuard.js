// =============================================================
// trackGuard.js: pure logic for the track hooks and shared transcript reading. See docs/orchestration.md.
//
// WHY: a large part of the track cost accrues when the track context is large, and the cap was only a rule the agent
// had to remember. Read hygiene (excerpts of large files, do not re-read files that are loaded automatically) is in the mission,
// but is only partly followed: agents read CLAUDE.md with Read even though Claude Code loads it automatically, and read
// large files whole instead of in excerpts. Hooks are deterministic; instructions are advice.
//
// Used by:
//   hook-context.mjs       (the main sessions; uses lastContext + readTail from here)
//   hook-track-context.mjs  (PostToolUse: contextGuard for the track agents)
//   hook-read-guard.mjs       (PreToolUse Read: readGuard for the track and review agents)
//
// The agent type: Claude Code puts `agent_id` and `agent_type` in the hook input when the hook fires inside a subagent
// (hook-time.mjs reads the same fields on SubagentStart). In the main session the fields are missing, and the guards do nothing.
//
// The read guard can be extended per project in queue.config.json, the `readGuard` field (all optional):
//   agentTypes   extra agent types the guard applies to (in addition to track, track-d, reviewer, reviewer-security)
//   autoLoaded   extra files that are loaded automatically and must not be read whole (file name, or path relative to the root)
//   largeFiles   glob patterns (relative to the root, e.g. "db/migrations/*.sql") for files that must be read in excerpts
//                when they exceed maxLines; migrations.folder/*.sql is included automatically when it is set
//   maxLines   the limit for largeFiles (default 300)
//   blockLines  all text files over this many lines are read in excerpts (default 2000)
//
// The functions here do no I/O beyond readTail/readHeader/subagentTranscript (which get fs functions passed in), so they can
// be tested (lib/__tests__/trackGuard.test.ts).
// =============================================================

const fs = require('node:fs');
const path = require('node:path');

/** Agent types the context guard applies to (the queue's track agents). */
const CONTEXT_TYPES = new Set(['track', 'track-d']);
/** Agent types readGuard applies to by default (track + the review agents in the template). */
const READ_TYPES = new Set(['track', 'track-d', 'reviewer', 'reviewer-security']);
/** Files Claude Code loads automatically (or that belong to memory), and that must not be read whole again. */
const AUTO_LOADED = Object.freeze(['CLAUDE.md', 'CLAUDE.local.md', 'MEMORY.md']);

/** Default context threshold for tracks (tokens). Overridden with TRACK_CONTEXT_WARNING. */
const TRACK_THRESHOLD = 280_000;
/** A file in largeFiles over this many lines must be read in excerpts. Overridden with READ_GUARD_MAX_LINES. */
const MAX_LINES = 300;
/** Any text file over this many lines must be read in excerpts (Read only takes the first 2000 lines anyway). */
const BLOCK_LINES = 2000;

const TAIL_BYTES = 4 * 1024 * 1024; // the last usage count is at the end of the transcript

/**
 * Context size from the last assistant message with `usage` in the transcript (JSONL text), or null.
 *
 * After a compaction (`/compact` or automatic) a `compact_boundary` row sits AFTER the last usage row,
 * because the compaction call itself is not logged as an assistant message. The last usage row is then the size BEFORE
 * the compaction (e.g. 346k), and the guard gave a false notice, or stopped the first message after /compact when the
 * old value was above the stop limit. If we hit the boundary before a usage row, the size is unknown until the next answer:
 * return null (no action). The next assistant answer has the correct, small value.
 */
function lastContext(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.includes('"compact_boundary"')) return null;
    if (!l.includes('"usage"')) continue;
    try {
      const o = JSON.parse(l);
      const u = o?.message?.usage;
      if (o?.type !== 'assistant' || !u) continue;
      return (
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0)
      );
    } catch {
      // the first line in the tail may be cut in the middle; skip it
    }
  }
  return null;
}

/** Reads the last `bytes` of a file as text (a transcript can be hundreds of MB). */
function readTail(filePath, bytes = TAIL_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads the first `bytes` of a file as text (the mission is at the top of the transcript). */
function readHeader(filePath, bytes = 64 * 1024) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Path to the SUBAGENT's own transcript. `transcript_path` in the hook input is the main session's transcript even when the hook
 * fires inside a subagent; the subagent's lives in `<session-folder>/<session_id>/subagents/agent-<agent_id>.jsonl`
 * (the same file SubagentStop gives as `agent_transcript_path`). Returns null when it does not exist, so the guard
 * never measures the main session's context by mistake.
 * @param {object} input hook input
 * @param {(p: string) => boolean} [exists]
 */
function subagentTranscript(input, exists = fs.existsSync) {
  if (!input || !input.agent_id) return null;
  const id = String(input.agent_id);
  const candidates = [];
  if (input.agent_transcript_path) candidates.push(String(input.agent_transcript_path));
  const tp = input.transcript_path ? String(input.transcript_path) : '';
  if (tp) {
    // transcript_path may already point to the subagent's file
    if (path.basename(tp) === `agent-${id}.jsonl`) candidates.push(tp);
    const folder = path.dirname(tp);
    const session = input.session_id ? String(input.session_id) : path.basename(tp, '.jsonl');
    candidates.push(path.join(folder, session, 'subagents', `agent-${id}.jsonl`));
  }
  for (const k of candidates) {
    try {
      if (exists(k)) return k;
    } catch {
      // try the next
    }
  }
  return null;
}

const thousand = (n) => `${Math.round(n / 1000)}k`;

/**
 * Context guard: should the track agent get a message now?
 * @param {{ agentType?: string|null, context?: number|null, threshold?: number, triggered?: number[] }} a
 *   triggered = the thresholds that have already given a message for this agent.
 * @returns {null | { threshold: number, message: string }}
 */
function assessContext({ agentType, context, threshold = TRACK_THRESHOLD, triggered = [] } = {}) {
  if (!agentType || !CONTEXT_TYPES.has(agentType)) return null; // the main session and other agent types: no effect
  if (typeof context !== 'number' || !Number.isFinite(context)) return null;
  if (!(threshold > 0) || context < threshold) return null;
  if (triggered.includes(threshold)) return null; // once per threshold per agent
  return {
    threshold,
    message:
      `[contextGuard] Your context is about ${thousand(context)} tokens (guard at ${thousand(threshold)}). ` +
      'Finish the step you are on, commit, write handover.md (what is done, what remains, next command) ' +
      'and deliver PARTIAL. Every turn now costs much more than in a new track.',
  };
}

/** Normalizes a path to forward slashes, so Windows and POSIX paths are treated alike. */
const norm = (p) => String(p || '').replace(/\\/g, '/');

/** Turns a glob pattern (relative to the root) into a regular expression that matches the end of a path. */
function globToRegex(glob) {
  const g = norm(glob).replace(/^\.\//, '');
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      r += '(?:.*/)?';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${r}$`, 'i');
}

/**
 * The read guard's rules, merged from the defaults and config().readGuard. Without arguments queue.config.json is read.
 * @param {{ agentTypes?: string[], autoLoaded?: string[], largeFiles?: string[], maxLines?: number,
 *   blockLines?: number } | null} [readGuard]
 * @param {{ folder?: string|null } | null} [migrations]
 */
function readRules(readGuard, migrations) {
  if (readGuard === undefined || migrations === undefined) {
    const k = require('./queueConfig.js').config();
    if (readGuard === undefined) readGuard = k.readGuard ?? {};
    if (migrations === undefined) migrations = k.migrations ?? {};
  }
  const lv = readGuard || {};
  const list = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v) : []);
  const largeOnes = list(lv.largeFiles);
  if (migrations?.folder) largeOnes.push(`${norm(migrations.folder).replace(/\/+$/, '')}/*.sql`);
  return {
    types: new Set([...READ_TYPES, ...list(lv.agentTypes)]),
    autoLoaded: [...AUTO_LOADED, ...list(lv.autoLoaded)],
    largeFiles: largeOnes.map(globToRegex),
    maxLines: Number(lv.maxLines) > 0 ? Number(lv.maxLines) : MAX_LINES,
    blockLines: Number(lv.blockLines) > 0 ? Number(lv.blockLines) : BLOCK_LINES,
  };
}

/** Is the path a file that is loaded automatically (CLAUDE.md in any folder, MEMORY.md, the project's own)? */
function isAutoLoaded(file, rules = readRules()) {
  const n = norm(file);
  const name = path.posix.basename(n);
  return rules.autoLoaded.some((a) => {
    const x = norm(a).replace(/^\.\//, '');
    if (!x.includes('/')) return name === x;
    return n === x || n.toLowerCase().endsWith(`/${x.toLowerCase()}`);
  });
}

/** Is the path one of the project's large files (largeFiles, migrations.folder/*.sql) that must be read in excerpts? */
function isLargeFile(file, rules = readRules()) {
  const n = norm(file);
  return rules.largeFiles.some((re) => re.test(n));
}

const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|pdf|ipynb)$/i;

/**
 * Read guard: should this Read be denied?
 * @param {{ agentType?: string|null, filePath?: string, offset?: number, limit?: number, countLines?: number|null,
 *   maxLines?: number, rules?: ReturnType<typeof readRules> }} a  countLines is counted by the hook when limit is missing.
 * @returns {null | { reason: string }}
 */
function assessReading({ agentType, filePath, offset, limit, countLines, maxLines, rules } = {}) {
  if (!agentType || !filePath) return null;
  const r = rules ?? readRules();
  if (!r.types.has(agentType)) return null;
  const excerpt = limit != null || offset != null;
  if (isAutoLoaded(filePath, r)) {
    // An excerpt is allowed: a track that will edit the file must have read it (Edit requires that).
    if (excerpt) return null;
    return {
      reason:
        `readGuard: ${path.posix.basename(norm(filePath))} is loaded automatically (CLAUDE.md files at start or the first ` +
        'time you read a file in the folder, memory at start). Do not read it again; the content is already in your ' +
        'context. If you need to edit the file, find the section with Grep and read it with offset and limit.',
    };
  }
  if (limit != null || typeof countLines !== 'number' || NOT_TEXT.test(norm(filePath)))
    return null;
  const max = maxLines ?? r.maxLines;
  if (isLargeFile(filePath, r) && countLines > max) {
    return {
      reason:
        `readGuard: the file has ${countLines} lines (max ${max} without a limit for this file type). Read in excerpts: ` +
        'Grep -n for the function, table or name you need, then Read with offset and limit around the match.',
    };
  }
  if (countLines > r.blockLines) {
    return {
      reason:
        `readGuard: the file has ${countLines} lines (over ${r.blockLines}). Read in excerpts: Grep -n for what you ` +
        'need, then Read with offset and limit around the match.',
    };
  }
  return null;
}

module.exports = {
  CONTEXT_TYPES,
  READ_TYPES,
  AUTO_LOADED,
  TRACK_THRESHOLD,
  MAX_LINES,
  BLOCK_LINES,
  lastContext,
  readTail,
  readHeader,
  subagentTranscript,
  assessContext,
  readRules,
  globToRegex,
  isAutoLoaded,
  isLargeFile,
  assessReading,
};
