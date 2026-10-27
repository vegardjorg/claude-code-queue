#!/usr/bin/env node
// =============================================================
// hook-context.mjs: UserPromptSubmit hook that warns, puts the orchestrator into wind-down and finally stops when
// the conversation grows too long. See docs/orchestration.md.
//
// Why: every turn reads the whole context again. A message above 500k costs nearly three times as much as at
// 100-200k, and a pause of over an hour in a long session pays for the whole conversation again (the cache expires).
// A hard stop in the middle of orchestration costs more than it saves, so the active orchestrator gets a wind-down step.
//
// How it works (the thresholds and rules live in lib/contextGuard.js, with tests):
//   - Reads the last assistant message's `usage` in the transcript (input + cache read + cache write), which
//     is the size of the context the model actually got last time.
//   - From NOTICE (250k): shows a message to the owner (systemMessage) and a short reminder to the model.
//   - Sessions that are not the active orchestrator: STOP (400k) stops the message (decision: block).
//   - The active orchestrator (cursor <dataFolder>/orchestrator.json is bound to this session, see below):
//     WIND_DOWN (350k, the emergency brake) sets `windDown` in the cursor and asks the model to finish (intake, review,
//     fix rounds, merge, set done) without starting new ones, update the running handover note
//     <dataFolder>/handover-ongoing.md and ask the owner to compact now (ready-made /compact line). `queue.mjs
//     next/start/fill` then refuses (exit 6) until the session is compacted. Hard stop only at STOP_ORCHESTRATOR (550k).
//   - COMPACT (280k): the active orchestrator gets a proposal to compact (systemMessage with a ready-made
//     /compact line the owner pastes in; the model cannot run /compact itself) and a reminder to update the note
//     and finish the step it is in. No wind-down, and no fixed limit on the number of compactions: the cycle
//     starts again after every compaction. A new session is only an emergency measure.
//     Why compaction over a new session: the token cost is about equal (both cost about one turn), while rotation
//     costs the owner work and waiting, and the background agents belong to the session that started them (notices and
//     fix rounds are lost on rotation). Everything important lives in files (queue.json, mission, report.md, the note), so a
//     compacted session is in practice a new session that keeps its agents. Quality safeguards: decisions written to file
//     at once, focus in the /compact line, and the queue state and a resume instruction are added back by
//     hook-after-compact.mjs (SessionStart, matcher compact).
//   - Mode (limits.autocompact in queue.json, `queue.mjs compact auto|manual`, shown in the messages): manual gives the
//     proposal above; auto says Claude Code compacts by itself (the owner has set /autocompact), with the line only as backup.
//   - "continue:" first in the message always passes through.
//   - The limits can be overridden with CONTEXT_WARNING, CONTEXT_STOP, CONTEXT_WIND_DOWN, CONTEXT_STOP_ORCHESTRATOR and
//     CONTEXT_COMPACT (tokens).
//
// System messages are NEVER stopped: UserPromptSubmit also fires for messages Claude Code queues by itself,
// <task-notification> (background agent done) and <agent-message> (SubagentHandback report). If they were stopped, with
// "UserPromptSubmit operation blocked by hook" in the transcript, delivered tracks never reach the model and the queue freezes.
// Such messages get notice/wind-down, never block.
//
// Who is the orchestrator? The session that LAST ran `queue.mjs orchestrator pulse|start|fill` (seen in its own transcript)
// while the cursor is active. The hook binds the cursor to the session by session_id. See contextGuard.orchestratorBinding.
//
// COST_GUARD: in the active orchestrator session the hook measures (at most every 10 min, COST_GUARD_INTERVAL_MIN overrides)
// the usage of running tasks, the same way as `queue.mjs set <id> done` (usage from the agent transcripts,
// queueLogic.sumCost). If a track passes FACTOR (3x) the average cost for its class (`queue.mjs cost --since 7d`; class from
// the mission file), the owner gets a systemMessage and the orchestrator a ready-made message to send the track (wrap up or
// deliver PARTIAL). No automatic stop. Each track is notified once (<dataFolder>/costGuard.json), and each notice is logged in
// <dataFolder>/cost-guard-log.jsonl (read with cost-guard-statistics.mjs). The thresholds and text live in lib/costGuard.js,
// with tests. COST_GUARD_BY=1 turns the guard off.
//
// Fails OPEN: any internal error gives no output and exit 0, so the hook never blocks normal work.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Transcript reading is shared with the track hooks (hook-track-context.mjs): lib/trackGuard.js.
const require = createRequire(import.meta.url);
const { lastContext, readTail } = require('./lib/trackGuard.js');
export { lastContext };
const KV = require('./lib/contextGuard.js');
const COST = require('./lib/costGuard.js');
const L = require('./lib/queueLogic.js');
const TK = require('./lib/timeCost.js');
const { config, dataFolder, timeLog } = require('./lib/queueConfig.js');

// Main tree (config().root is always mainTree, also from a worktree) and the data folder (QUEUE_FOLDER overrides).
const MAIN_TREE = config().root;
const QUEUE_FOLDER = dataFolder();
const CURSOR = path.join(QUEUE_FOLDER, 'orchestrator.json');
const QUEUE_FILE = path.join(QUEUE_FOLDER, 'queue.json');
const COST_GUARD_FILE = path.join(QUEUE_FOLDER, 'costGuard.json');
// Statistics: one line per notice, append-only. Read with scripts/orchestrator/cost-guard-statistics.mjs.
const COST_GUARD_LOG = path.join(QUEUE_FOLDER, 'cost-guard-log.jsonl');
// Same sources as queue.mjs (the time log and the agent transcripts); the env vars override in tests.
const TIME_LOG = timeLog();
// Claude Code saves the transcripts in ~/.claude/projects/<slug>, where slug is the root path with all characters
// except A-Z, a-z and 0-9 replaced by "-". QUEUE_TRANSCRIPTS overrides (tests).
const TRANSCRIPTS =
  process.env.QUEUE_TRANSCRIPTS ??
  path.join(os.homedir(), '.claude', 'projects', MAIN_TREE.replace(/[^A-Za-z0-9]/g, '-'));
const MAX_TRANSCRIPT = 300 * 1024 * 1024;

/** Read stdin (hook input as JSON). */
async function readIn() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return JSON.parse(s || '{}');
}

/** The whole transcript (to count compactions), or empty text. */
function readFully(filePath) {
  try {
    return fs.statSync(filePath).size > MAX_TRANSCRIPT ? '' : fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readCursor() {
  try {
    return JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes the cursor atomically (tmp + rename), like queue.mjs. Errors are swallowed: the hook fails open. */
function writeCursor(m) {
  try {
    const tmp = `${CURSOR}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
    fs.renameSync(tmp, CURSOR);
  } catch {
    // error-ignored: the hook must never block a message; the wind-down is set on the next message
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** The transcript text of an agent (like queue.mjs findTranscript/readTranscript), or null. */
function agentTranscript(agentId) {
  try {
    for (const d of fs.readdirSync(TRANSCRIPTS, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const filePath = path.join(TRANSCRIPTS, d.name, 'subagents', `agent-${agentId}.jsonl`);
      if (!fs.existsSync(filePath)) continue;
      return fs.statSync(filePath).size > MAX_TRANSCRIPT ? null : fs.readFileSync(filePath, 'utf8');
    }
  } catch {
    // error-ignored: without a transcript the time log's last row is used
  }
  return null;
}

/** The class from the mission file (path in o.mission, or the text itself), otherwise o.class. */
function classFor(o) {
  const s = String(o.mission ?? '');
  let text = s.includes('\n') ? s : null;
  if (!text && s) {
    for (const root of [process.cwd(), MAIN_TREE]) {
      try {
        text = fs.readFileSync(path.resolve(root, s), 'utf8');
        break;
      } catch {
        // not here
      }
    }
  }
  return COST.classFromMission(text) ?? o.class ?? null;
}

/** The usage of a running task, measured as in queue.mjs (transcript, otherwise last done row). */
function measureTask(o, rows) {
  const agents = [];
  for (const a of COST.liveAgents(rows, o.id, { from: o.started ?? o.picked_at ?? null })) {
    const text = agentTranscript(a.agent);
    if (!a.safe && !(text && L.mentionsTask(L.firstUserMessage(text), o.id))) continue;
    if (text) {
      const t = TK.analyzeTranscript(text);
      agents.push({
        agent: a.agent,
        type: a.type,
        tokens: t.tokens,
        model: t.model,
        source: 'transcript',
      });
    } else if (a.row) {
      agents.push({ agent: a.agent, type: a.type, tokens: a.row.tokens, model: a.row.model });
    }
  }
  return L.sumCost(agents).usd;
}

/** The cost guard: hook text when a track has passed the threshold, otherwise null. Only in the active orchestrator session. */
function costGuard(now) {
  if (process.env.COST_GUARD_BY === '1') return null;
  const state = readJson(COST_GUARD_FILE) ?? {};
  const min = Number(process.env.COST_GUARD_INTERVAL_MIN);
  const interval = Number.isFinite(min) && min >= 0 ? min * 60_000 : COST.INTERVAL_MS;
  if (!COST.shouldMeasure(state, now, interval)) return null;
  const queue = readJson(QUEUE_FILE);
  if (!queue) return null;
  const running = (queue.tasks ?? []).filter((o) => o.status === 'running');
  const average = COST.averagePerClass(
    L.costStatistics(queue, { since: new Date(now - COST.SINCE_MS).toISOString() }),
  );
  let rows = [];
  if (running.length) {
    try {
      rows = TK.readRows(fs.readFileSync(TIME_LOG, 'utf8'));
    } catch {
      rows = [];
    }
  }
  const measurements = running.map((o) => ({
    id: o.id,
    class: classFor(o),
    usd: measureTask(o, rows),
  }));
  const v = COST.assess({ measurements, average, notified: state.notified, now });
  try {
    const tmp = `${COST_GUARD_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ last_measured: new Date(now).toISOString(), notified: v.notified }, null, 2) +
        '\n',
    );
    fs.renameSync(tmp, COST_GUARD_FILE);
  } catch {
    // error-ignored: without saved state it is measured again on the next message
  }
  try {
    // One line per notice: id, class, usage at notice, average, limit and factor. The final cost comes from queue.json.
    for (const x of v.notices) {
      fs.appendFileSync(
        COST_GUARD_LOG,
        JSON.stringify({ time: new Date(now).toISOString(), factor: COST.FACTOR, ...x }) + '\n',
      );
    }
  } catch {
    // error-ignored: the statistics are an aid; the notice must come even if the log cannot be written
  }
  return COST.hookText(v.notices);
}

/** Adds the cost guard's text to the context hook's output (a block stands alone). */
function merge(out, cost) {
  if (!cost) return out;
  if (out?.decision === 'block') return out;
  const sys = [out?.systemMessage, cost.systemMessage].filter(Boolean).join('\n');
  const ctx = [out?.hookSpecificOutput?.additionalContext, cost.additionalContext]
    .filter(Boolean)
    .join('\n');
  return {
    ...(out ?? {}),
    systemMessage: sys,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
  };
}

async function main() {
  const input = await readIn();
  if (!input.transcript_path) return;
  const tail = readTail(input.transcript_path);
  const n = lastContext(tail);
  const g = KV.limits(process.env);
  const now = Date.now();
  const sessionId = input.session_id ?? null;
  // The binding is checked on every message (also below the notice limit): a new orchestrator session with a small context
  // must take the cursor and reset the previous session's wind-down as soon as it has run an orchestrator call.
  const bind = KV.orchestratorBinding({
    cursor: readCursor(),
    sessionId,
    lastCall: KV.lastOrchestratorCall(tail),
    now,
  });
  // The cost guard is measured only in the active orchestrator session; an error in it must never take down the context guard.
  let cost = null;
  if (bind.orchestrator) {
    try {
      cost = costGuard(now);
    } catch {
      cost = null;
    }
  }
  if (n == null || n < Math.min(g.notice, g.windDown, g.compact)) {
    if (bind.changed) writeCursor(bind.cursor);
    const out = merge(null, cost);
    if (out) process.stdout.write(JSON.stringify(out));
    return;
  }
  let cursor = bind.cursor;
  // Compactions are counted in the WHOLE transcript (the tail is not enough), and only for the orchestrator above COMPACT.
  // The count is only shown in the message (no fixed limit).
  const compactions =
    bind.orchestrator && n >= Math.min(g.compact, g.windDown)
      ? KV.countCompactions(readFully(input.transcript_path))
      : 0;
  const mode = bind.orchestrator ? KV.compactMode(readJson(QUEUE_FILE)) : 'manual';
  const b = KV.assess({
    n,
    prompt: String(input.prompt || ''),
    orchestrator: bind.orchestrator,
    inWindDown: KV.inWindDown(cursor, sessionId),
    g,
  });
  if (b.setWindDown) cursor = KV.withWindDown(cursor, { sessionId, n, now });
  if (bind.changed || b.setWindDown) writeCursor(cursor);

  const out = merge(
    KV.hookOutput(b, { n, orchestrator: bind.orchestrator, g, compactions, mode }),
    cost,
  );
  if (out) process.stdout.write(JSON.stringify(out));
}

main().catch(() => process.exit(0));
