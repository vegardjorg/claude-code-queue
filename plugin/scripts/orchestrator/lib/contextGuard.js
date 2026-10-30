// =============================================================
// contextGuard.js: pure logic for the context guard (hook-context.mjs and hook-after-compact.mjs).
// See docs/orchestration.md.
//
// The thresholds (tokens, overridable with environment variables):
//   - NOTICE 250k (CONTEXT_WARNING): a reminder to the model and a message to the owner, all sessions.
//   - STOP 400k (CONTEXT_STOP): the message is stopped (decision: block) in sessions that are NOT the active orchestrator.
//   - WIND_DOWN 350k (CONTEXT_WIND_DOWN): the active orchestrator goes into wind-down. The hook sets `windDown` in the
//     orchestrator cursor (<dataFolder>/orchestrator.json); `queue.mjs next/start/fill` then refuse (exit 6), while receive,
//     review, fix rounds, merge and `set done` work as before. The message is "compact now".
//   - STOP_ORCHESTRATOR 550k (CONTEXT_STOP_ORCHESTRATOR): hard stop for the orchestrator too.
//   - COMPACT 280k (CONTEXT_COMPACT): the active orchestrator gets a suggestion to compact (/compact with focus,
//     a ready line in COMPACT_COMMAND that the owner pastes). Compaction is the default: there is no fixed limit
//     on the number of compactions, and the cycle starts again after each compaction. WIND_DOWN and STOP_ORCHESTRATOR are
//     the emergency brake when the owner has not compacted. After a compaction hook-after-compact.mjs adds the queue state and
//     a resume instruction again (afterCompactText) and lifts the wind-down for the session (withoutWindDown). A new session
//     (/queue in a new window) is only a last resort (the session has hung or is broken).
//   - Mode: `queue.mjs compact auto|manual` sets limits.autocompact in queue.json (compactMode). Manual: a notice
//     with a ready /compact line. Auto: Claude Code compacts by itself (autoCompactEnabled on, window 300k), and the queue
//     resumes automatically; the line is only a fallback. The mode is shown in the hook messages and on the board.
//   - The handover note is ongoing (HANDOVER_NOTE): the orchestrator keeps it updated after each merge and
//     each decision from the owner, so both compaction and any emergency rotation are cheap.
// "continue:" at the start of the message always gets through.
//
// System messages are NEVER stopped: Claude Code runs the UserPromptSubmit hook also for messages queued without
// the owner writing them, namely <task-notification> (background agent done) and <agent-message> (SubagentHandback).
// If they are stopped ("UserPromptSubmit operation blocked by hook" in the transcript), delivered tracks never reach the
// model, and the queue freezes. See the hook-context.mjs header.
//
// Who is the orchestrator? The cursor only has a free session name, and queue.mjs does not know which Claude Code session
// calls it. The hook, however, gets the session_id and the transcript. The rule (orchestratorBinding): the session that LAST ran an
// orchestrator call (`queue.mjs orchestrator pulse`, `queue.mjs start`, `queue.mjs fill`, seen in its own transcript), while the
// cursor is active, is the orchestrator. The hook then binds the cursor to the session (session_id = session_id, session_id_time =
// time of the call). If another session takes over (newer call), the binding moves and a wind-down that belonged to the previous
// session is reset. `queue.mjs orchestrator pulse --session "<new name>"` also resets (queueLogic.newCursor), and `orchestrator stop`
// removes the cursor. No I/O here; tested in lib/__tests__/contextGuard.test.ts.
// =============================================================
'use strict';

const { orchestratorStatus, ORCHESTRATOR_EXPIRY_MS } = require('./queueLogic.js');

const STANDARD = Object.freeze({
  notice: 250_000,
  stop: 400_000,
  windDown: 350_000,
  stopOrchestrator: 550_000,
  compact: 280_000,
});

/** The thresholds, with overrides from the environment variables (invalid or empty values give the default). */
function limits(env = {}) {
  const counts = (v, std) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : std;
  };
  // No limit on the number of compactions; compaction is the default regardless of count.
  return {
    notice: counts(env.CONTEXT_WARNING, STANDARD.notice),
    stop: counts(env.CONTEXT_STOP, STANDARD.stop),
    windDown: counts(env.CONTEXT_WIND_DOWN, STANDARD.windDown),
    stopOrchestrator: counts(env.CONTEXT_STOP_ORCHESTRATOR, STANDARD.stopOrchestrator),
    compact: counts(env.CONTEXT_COMPACT, STANDARD.compact),
  };
}

/** Messages Claude Code queues by itself (agent done, hand-back): they are never stopped. */
const SYSTEM_MESSAGE = /^\s*<(task-notification|agent-message|teammate-message)\b/;
function isSystemMessage(prompt) {
  return SYSTEM_MESSAGE.test(String(prompt ?? ''));
}

/** "continue:" at the start of the message: the owner sends it anyway. */
function isOverridden(prompt) {
  return /^\s*continue:/i.test(String(prompt ?? ''));
}

/** Commands only the orchestrator runs (they pulse the cursor). `queue.mjs cloud start` and `set` do not count. */
const ORCHESTRATOR_CALLS =
  /(?:queue\.mjs["']?|cq\.mjs["']?|(?:^|[\s;&|(])cq(?:\.cmd)?)\s+(?:queue\s+)?(?:orchestrator\s+pulse|start|fill)\b/;

/**
 * The time (ms) of the last orchestrator call in the transcript text (JSONL, often just the tail), or null.
 * A call is a tool_use from the assistant with an `input.command` that matches ORCHESTRATOR_CALLS.
 */
function lastOrchestratorCall(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!(l.includes('queue.mjs') || /\bcq\b/.test(l)) || !l.includes('tool_use')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // the first line of the tail may be cut
    }
    if (o?.type !== 'assistant' || !Array.isArray(o?.message?.content)) continue;
    const match = o.message.content.some(
      (c) => c?.type === 'tool_use' && ORCHESTRATOR_CALLS.test(String(c?.input?.command ?? '')),
    );
    if (!match) continue;
    const t = Date.parse(o.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Is this session the active orchestrator, and must the cursor be bound again?
 * @param {{ cursor: object|null, sessionId: string|null, lastCall: number|null, now?: number }} input
 * @returns {{ orchestrator: boolean, cursor: object|null, changed: boolean }}
 *   `cursor` is the (possibly updated) cursor; `changed` = the hook should write it.
 */
function orchestratorBinding({ cursor, sessionId, lastCall, now = Date.now() }) {
  const no = { orchestrator: false, cursor, changed: false };
  if (!cursor || !sessionId || !orchestratorStatus(cursor, now).active) return no;
  const time = cursor.session_id_time ?? Number.NEGATIVE_INFINITY;
  const freshCall = lastCall != null && now - lastCall <= ORCHESTRATOR_EXPIRY_MS;
  if (cursor.session_id === sessionId) {
    if (freshCall && lastCall > time)
      return { orchestrator: true, cursor: { ...cursor, session_id_time: lastCall }, changed: true };
    return { orchestrator: true, cursor, changed: false };
  }
  if (!freshCall || lastCall < time) return no;
  // This session has made a newer orchestrator call than the bound one: it has taken over.
  const fresh = { ...cursor, session_id: sessionId, session_id_time: lastCall };
  if (fresh.windDown && fresh.windDown.session_id !== sessionId) delete fresh.windDown;
  return { orchestrator: true, cursor: fresh, changed: true };
}

/** Is the cursor in wind-down for exactly this session? */
function inWindDown(cursor, sessionId) {
  return Boolean(cursor?.windDown && cursor.windDown.session_id === sessionId);
}

/**
 * The number of compactions (/compact, manual and automatic) in the session's transcript text: rows with
 * `type: "system"` and `subtype: "compact_boundary"`. Claude Code writes one such row in the same JSONL file (same
 * session_id) each time the session is compacted. Each candidate line is parsed, so text that only QUOTES the field (e.g. a
 * mission in a user message, where the quotes are escaped) is not counted.
 */
function countCompactions(text) {
  let count = 0;
  for (const l of String(text ?? '').split('\n')) {
    if (!l.includes('compact_boundary')) continue;
    try {
      const o = JSON.parse(l);
      if (o?.type === 'system' && o?.subtype === 'compact_boundary') count++;
    } catch {
      // cut or broken line: not counted
    }
  }
  return count;
}

/**
 * The ongoing handover note: one fixed file in the data folder (config().dataFolder, relative to the root) that the
 * orchestrator keeps updated after each merge and each decision from the owner. The name fits the pattern `handover-*.md`
 * that queue-takeover.mjs shows at the top (newest by mtime).
 */
function notePath() {
  let folder = 'scripts/.queue';
  try {
    folder = String(require('./queueConfig.js').config().dataFolder || folder);
  } catch {
    // no config: the default folder
  }
  return `${folder.replace(/\\/g, '/').replace(/\/+$/, '')}/handover-ongoing.md`;
}
const HANDOVER_NOTE = notePath();

/** The line the owner pastes (the model cannot run /compact itself). The focus is what would otherwise be lost. */
const COMPACT_COMMAND =
  `/compact keep: everything in ${HANDOVER_NOTE}, active tracks (id, status, branch, HEAD at start), open owner questions, ` +
  'unpushed commits, scratchpad path, next command';

/**
 * How the owner turns Claude Code's own compaction on and off. Two separate settings: autoCompactEnabled (on/off,
 * default on) and the window (autoCompactWindow, which cq setup --settings sets to 300000; /autocompact 300k sets the same
 * window for the current model). "/autocompact auto" only resets the window to the model's own; it does not turn
 * compaction off. /config does not open in the desktop app, so the settings file line is given too.
 */
const AUTOCOMPACT_ON = '/config autoCompactEnabled=true, then /autocompact 300k';
const AUTOCOMPACT_OFF = '/config autoCompactEnabled=false';
const AUTOCOMPACT_FILE = '"autoCompactEnabled": false in .claude/settings.local.json';

/** Compaction mode from the queue file: limits.autocompact = true gives 'auto', everything else 'manual' (default). */
function compactMode(queue) {
  return queue?.limits?.autocompact === false ? 'manual' : 'auto';
}

/** The mode in plain language, as it appears in the messages. */
function modeText(mode) {
  return mode === 'auto'
    ? 'automatic compaction (cq compact manual turns it off)'
    : 'manual compaction (cq compact auto turns on automatic)';
}

/**
 * Focus for the summary when the session is compacted. The PreCompact hook (hook-after-compact.mjs) writes it to stdout, and
 * Claude Code adds it to the compaction instruction, also for automatic compaction where no line is pasted.
 */
function forCompactInstruction() {
  return (
    'The queue orchestrator session is being compacted. Keep: everything in ' +
    `${HANDOVER_NOTE} (the path, and that it must be read first), active tracks (id, status, branch, HEAD at start, ` +
    'agent id), review packages and reviewers, open owner questions with recommendation, owner decisions from this session, unpushed ' +
    'commits, scratchpad path and next command. Details that are in queue.json or in the note can be shortened.'
  );
}

/**
 * What the hook should do.
 * @param {{ n: number|null, prompt: string, orchestrator: boolean, inWindDown?: boolean, g?: object }} input
 *   (a `compactions` field is accepted, but no longer affects the decision; the count is only shown in the messages)
 * @returns {{ action: 'none'|'notice'|'compact'|'windDown'|'stop', setWindDown: boolean, limit?: number }}
 *
 * Orchestrator: from COMPACT (280k) /compact with focus is suggested, again after each compaction (no
 * fixed limit that triggers rotation). WIND_DOWN (350k) and STOP_ORCHESTRATOR (550k) are the emergency brake when the owner does not compact.
 */
function assess({ n, prompt, orchestrator, inWindDown: already = false, g = limits() }) {
  const none = { action: 'none', setWindDown: false };
  if (n == null || !Number.isFinite(n)) return none;
  const canStopped = !isSystemMessage(prompt) && !isOverridden(prompt);
  if (orchestrator) {
    const setWindDown = n >= g.windDown && !already;
    if (n >= g.stopOrchestrator && canStopped)
      return { action: 'stop', setWindDown, limit: g.stopOrchestrator };
    if (n >= g.windDown) return { action: 'windDown', setWindDown };
    if (n >= g.compact) return { action: 'compact', setWindDown: false };
    if (n >= g.notice) return { action: 'notice', setWindDown: false };
    return none;
  }
  if (n >= g.stop && canStopped)
    return { action: 'stop', setWindDown: false, limit: g.stop };
  if (n >= g.notice) return { action: 'notice', setWindDown: false };
  return none;
}

/** The cursor with the wind-down flag set for the session. */
function withWindDown(cursor, { sessionId, n, now = Date.now() }) {
  return {
    ...cursor,
    windDown: { from: new Date(now).toISOString(), context: n ?? null, session_id: sessionId },
  };
}

const k = (n) => `${Math.round(n / 1000)}k`;

/**
 * Hook output (the object written as JSON to stdout), or null for no output.
 * @param {{ action: string, setWindDown: boolean, limit?: number }} b from assess()
 * @param {{ n: number, orchestrator: boolean, g?: object, now?: number, compactions?: number,
 *   mode?: 'auto'|'manual' }} context  `mode` = compactMode(queue.json), default manual.
 *
 * Compaction is the default. The orchestrator is never asked to rotate; a new session is only mentioned as a last resort (the
 * session has hung or is broken). Other sessions (tracks, the owner's own) get a new session as before.
 */
function hookOutput(b, { n, orchestrator, g = limits(), compactions = 0, mode = 'manual' }) {
  if (b.action === 'none') return null;
  const auto = mode === 'auto';
  const note = HANDOVER_NOTE;
  const lastResort =
    'A new session (/queue in a new window) is only a last resort if the session has hung or is broken.';
  if (b.action === 'compact') {
    const nr = compactions + 1;
    return {
      systemMessage: auto
        ? `Context about ${k(n)} tokens. Mode: ${modeText(mode)}. Claude Code compacts the orchestrator session by ` +
          `itself (compaction no. ${nr} in the session), and the queue resumes automatically afterwards. If it has not happened by ` +
          `about ${k(g.windDown)}, paste:\n${COMPACT_COMMAND}`
        : `Context about ${k(n)} tokens: time to compact the orchestrator session (compaction no. ${nr} in the session; ` +
          `mode: ${modeText(mode)}). When the model has finished the step it is on, paste:\n` +
          `${COMPACT_COMMAND}\nRunning agents are kept. Emergency brake (wind-down) at ${k(g.windDown)}.`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: auto
          ? `[hook-context] COMPACT (about ${k(n)} tokens, mode automatic): Claude Code compacts the session by ` +
            `itself. Update the handover note ${note} now (active tracks, review packages, open owner questions, ` +
            'owner decisions, scratchpad path, next command), so resuming afterwards is cheap. Continue normal ' +
            'work; after the compaction hook-after-compact.mjs gives a resume instruction.'
          : `[hook-context] COMPACT (about ${k(n)} tokens, mode manual): the owner has been asked to compact the session with ` +
            '/compact (you cannot run /compact yourself). Update the handover note ' +
            `${note} now, finish the step you are on (receive, merge, set done) and do not start long new ` +
            'operations midway. After the compaction hook-after-compact.mjs adds the queue state and a ' +
            'resume instruction. No wind-down; running agents still report to this session.',
      },
    };
  }
  if (b.action === 'stop') {
    return {
      decision: 'block',
      reason: orchestrator
        ? `The conversation is at about ${k(n)} tokens (stop at ${k(b.limit ?? g.stopOrchestrator)}). Each message now costs ` +
          'almost three times as much as after a compaction. Compact the orchestrator session now with the line below ' +
          `(it keeps the running agents). ${lastResort} To send the message anyway, for example to ask for ` +
          `an updated handover note, start it with "continue:".\n${COMPACT_COMMAND}`
        : `The conversation is at about ${k(n)} tokens (stop at ${k(b.limit ?? g.stop)}). Each message now costs ` +
          'almost three times as much as in a new session. Start a new session. To send the message anyway, for ' +
          'example to ask for a handover note, start it with "continue:".',
    };
  }
  if (b.action === 'windDown') {
    const fresh = b.setWindDown;
    return {
      systemMessage:
        `Context about ${k(n)} tokens: the orchestrator is in WIND_DOWN (emergency brake from ${k(g.windDown)}, hard stop ` +
        `at ${k(g.stopOrchestrator)}; mode: ${modeText(mode)}). No new tasks are started; started ones are finished. ` +
        `Compact now: when the model has finished the step it is on, paste:\n${COMPACT_COMMAND}\n` +
        `The wind-down is lifted by itself after the compaction. ${lastResort}`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: fresh
          ? `[hook-context] WIND_DOWN (about ${k(n)} tokens). From now on: start NO new tasks (cq next/start/fill ` +
            'refuses with exit 6). Allowed: receive delivered tracks (receive), review, fix rounds for already started ' +
            'tasks, merge, db push/deploy for what is merged, set done, resolve. Update the ' +
            `handover note ${note} (active tasks with branch/worktree/prompt, review packages and reviewers, ` +
            'open owner questions, scratchpad path, next command), and ask the owner to compact now with the /compact line. ' +
            `The wind-down is lifted after the compaction. Hard stop at ${k(g.stopOrchestrator)}.`
          : `[hook-context] Wind-down in progress (about ${k(n)} tokens, hard stop at ${k(g.stopOrchestrator)}): no new ones ` +
            `start; finish receive, review and merge, keep ${note} updated, keep answers short. ` +
            'The wind-down is lifted once the owner has compacted.',
      },
    };
  }
  return {
    systemMessage:
      `Context about ${k(n)} tokens (notice from ${k(g.notice)}, ` +
      (orchestrator
        ? `compaction at ${k(g.compact)}, wind-down at ${k(g.windDown)}, stop at ${k(g.stopOrchestrator)}; ` +
          `mode: ${modeText(mode)}). Avoid long pauses in this session.`
        : `stop at ${k(g.stop)}). Consider a new session with a handover note soon; avoid long pauses in this session.`),
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `[hook-context] The conversation is at about ${k(n)} tokens. Keep answers short` +
        (orchestrator
          ? `, and keep the handover note ${note} updated after each merge and each decision from the owner.`
          : ', and suggest a handover note and a new session when it fits (not in the middle of a receive).'),
    },
  };
}

/** Should hook-after-compact.mjs add the queue state again? Only when the cursor is bound to exactly this session. */
function afterCompactBound({ cursor, sessionId }) {
  return Boolean(sessionId && cursor?.session_id && cursor.session_id === sessionId);
}

/**
 * The cursor without the session's wind-down. The owner has compacted (the normal path): then queue.mjs
 * next/start/fill should work again, no matter how many times the session has been compacted. If the session passes WIND_DOWN again,
 * hook-context.mjs sets the wind-down again.
 */
function withoutWindDown(cursor, sessionId) {
  if (!inWindDown(cursor, sessionId)) return { cursor, changed: false };
  const fresh = { ...cursor };
  delete fresh.windDown;
  return { cursor: fresh, changed: true };
}

/** Cap for additionalContext after compaction (about 3k tokens). */
const AFTER_COMPACT_MAX_DRAW = 12_000;

/**
 * The resume instruction after compaction: what the orchestrator must do right away, without waiting for
 * the owner. With automatic compaction Claude Code continues the turn by itself; after a manual /compact no turn starts
 * by itself (the SessionStart hook cannot start one), so the instruction then applies to the first message afterwards.
 */
function resumeText(mode) {
  const cq = require('./projectRoot.js').cqCommand();
  return [
    'RESUME NOW, without waiting for the owner:',
    `  1. Read the handover note ${HANDOVER_NOTE} (Read; the scratchpad path and open matters are there).`,
    `  2. ${cq} orchestrator pulse`,
    `  3. Receive tracks that have delivered (report.md exists): ${cq} receive <id>`,
    `  4. ${cq} fill --scratchpad <scratchpad from the note>, and start ALL the agents it ` +
      'lists in the same turn.',
    mode === 'auto'
      ? '  Automatic compaction: the turn continues by itself, so do this now.'
      : '  Manual /compact: no turn starts by itself, so do this in the answer to the first message afterwards, even ' +
        'if it is just "continue".',
    '  Keep the note updated after each merge and each decision from the owner.',
  ].join('\n');
}

/**
 * additionalContext after /compact (SessionStart, matcher compact): a short queue state that the summary might otherwise
 * lose, and the resume instruction. The order is chosen so the most important comes first; the queue view is cut if
 * the cap is reached.
 * @param {{ show: string, question: Array<{ sp: string, text?: string|null, recommendation?: string|null }>,
 *   unpushed: number|null, base?: string, compactions: number, windDownRevoked?: boolean,
 *   mode?: 'auto'|'manual', g?: object, maxDraw?: number }} input
 *   `base` = baseBranch (config().baseBranch) for the line about unpushed commits.
 */
function afterCompactText({
  show,
  question,
  unpushed,
  base = 'baseBranch',
  compactions,
  windDownRevoked = false,
  mode = 'manual',
  g = limits(),
  maxDraw = AFTER_COMPACT_MAX_DRAW,
}) {
  const header = [
    `[hook-after-compact] The session has been compacted (compaction no. ${compactions} in the session; mode: ` +
      `${modeText(mode)}). The queue state below was read from queue.json just now; trust it over the summary.`,
    `Next time the context reaches about ${k(g.compact)}, it is time for a new compaction (the same cycle each time).`,
  ];
  if (windDownRevoked)
    header.push(
      'The wind-down for this session is revoked (the owner compacted), so cq fill works again.',
    );
  header.push(resumeText(mode));
  header.push(`Unpushed commits on ${base}: ${unpushed == null ? 'unknown' : unpushed}`);
  const openOnes = (question ?? []).map(
    (s) =>
      `  ${s.sp}: ${s.text ?? '(missing text)'}${s.recommendation ? ` (recommendation: ${s.recommendation})` : ''}`,
  );
  header.push(
    openOnes.length
      ? `Open owner questions (${openOnes.length}):\n${openOnes.join('\n')}`
      : 'No open owner questions.',
  );
  header.push('The queue (cq show):');
  const start = header.join('\n') + '\n';
  const rest = Math.max(0, maxDraw - start.length);
  const v = String(show ?? '').trimEnd();
  const cut = '\n… (truncated; run cq show)';
  const body = v.length <= rest ? v : v.slice(0, Math.max(0, rest - cut.length)) + cut;
  return (start + body).slice(0, maxDraw);
}

// =============================================================
// Context guards after automatic compaction (tracks, the orchestrator's pause advice and the track end gate).
//
// `autoCompactWindow: 300000` (settings.queue.json) applies to every session, the tracks too, so they compact at about
// 267k. A PARTIAL guard at 280k alone would then practically never trigger. The rule: a track may compact once. PARTIAL
// comes at the SECOND compaction, or at a hard limit, whichever happens first. After the first compaction the track
// gets one short reminder to check the mission, the branch and its commits.
// =============================================================

/** Agent types the track guards below apply to (the queue's track agents; bare names, see projectRoot.bareAgentType). */
const TRACK_AGENT_TYPES = new Set(['track', 'track-d']);

/**
 * Hard context limit for tracks (tokens), the same value as the old guard (trackGuard.TRACK_THRESHOLD). With the default
 * autoCompactWindow (300k) the track compacts before it gets here, so the limit only triggers when the window is raised
 * (or the compaction does not happen). Overridden with TRACK_CONTEXT_WARNING in hook-track-context.mjs.
 */
const TRACK_HARD_LIMIT = 280_000;

/** The markers in hook-track-context.mjs's state file (the triggered list). */
const KEY_COMPACT1 = 'compact1';
const KEY_PARTIAL = 'partial';

const COMPACT1_MESSAGE =
  '[contextGuard] You have been compacted once. Check the mission path, the branch and what is committed before you ' +
  'continue.';

/** Has the PARTIAL message been given? State files from before this guard hold the threshold as a number (e.g. 280000). */
function partialSaid(triggered = []) {
  return triggered.includes(KEY_PARTIAL) || triggered.some((x) => typeof x === 'number');
}

/**
 * Should the track agent get a message now (PostToolUse)?
 * @param {{ agentType?: string|null, compactions?: number, context?: number|null, hardLimit?: number,
 *   triggered?: Array<string|number> }} a
 * @returns {null | { key: 'compact1'|'partial', cause: 'compaction'|'hard', message: string, compactions: number }}
 */
function assessTrackContext({
  agentType,
  compactions = 0,
  context = null,
  hardLimit = TRACK_HARD_LIMIT,
  triggered = [],
} = {}) {
  if (!agentType || !TRACK_AGENT_TYPES.has(agentType)) return null;
  if (partialSaid(triggered)) return null; // PARTIAL is given once; after it no reminder is needed
  const n = Number.isFinite(compactions) && compactions > 0 ? compactions : 0;
  const over =
    typeof context === 'number' && Number.isFinite(context) && hardLimit > 0 && context >= hardLimit;
  if (n >= 2 || over) {
    const why =
      n >= 2
        ? `You have been compacted ${n} times`
        : `Your context is about ${k(context)} tokens (hard limit ${k(hardLimit)})`;
    return {
      key: KEY_PARTIAL,
      cause: n >= 2 ? 'compaction' : 'hard',
      compactions: n,
      message:
        `[contextGuard] ${why}. Finish the step you are on, commit, write handover.md (what is done, what remains, ` +
        'next command) and deliver PARTIAL. Every turn now costs much more than in a new track.',
    };
  }
  if (n === 1 && !triggered.includes(KEY_COMPACT1))
    return { key: KEY_COMPACT1, cause: 'compaction', compactions: n, message: COMPACT1_MESSAGE };
  return null;
}

// ----- Pause advice (hook-context.mjs, the orchestrator only) -----

/** The pause advice is given from this context size (tokens). Overridden with CONTEXT_PAUSE. */
const PAUSE_THRESHOLD = 150_000;

const PAUSE_TIP =
  'Tip: run /compact before the break. A pause of over 1 h writes the whole context to the cache again.';

/**
 * Phrases that say the owner is leaving the machine, in English and Norwegian (the queue's first users). Whole words
 * only: "pause" in "pauseButton" must not trigger. \b does not work with non-ASCII letters, so the boundaries are
 * letter/digit lookarounds with the u flag. "away" and "back in" alone are left out on purpose ("right away", "put it
 * back in").
 */
const PAUSE_WORDS = [
  'have to go',
  'got to go',
  'gotta go',
  'heading out',
  'leaving now',
  'stepping away',
  'be back',
  'back later',
  'afk',
  'brb',
  'going to bed',
  'good night',
  'taking a break',
  'pause',
  'må reise',
  'skal reise',
  'går nå',
  'drar nå',
  'må gå',
  'borte',
  'tilbake om',
  'legger meg',
  'god natt',
];
const PAUSE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${PAUSE_WORDS.map((o) => o.replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

/** Does the message say the owner is leaving the machine? System messages (agent done and the like) never count. */
function isPauseMessage(prompt) {
  const p = String(prompt ?? '');
  if (isSystemMessage(p)) return false;
  return PAUSE_RE.test(p);
}

/**
 * The pause advice as hook output (advice only, never block), or null. The shape is the cost guard's
 * ({ systemMessage, additionalContext }), so hook-context.mjs merges it the same way.
 * @param {{ prompt: string, n: number|null, orchestrator: boolean, threshold?: number }} a
 */
function pauseAdvice({ prompt, n, orchestrator, threshold = PAUSE_THRESHOLD }) {
  if (!orchestrator) return null;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= threshold) return null;
  if (!isPauseMessage(prompt)) return null;
  return { systemMessage: PAUSE_TIP, additionalContext: PAUSE_TIP };
}

// ----- SubagentStop gate (hook-track-end.mjs) -----

const END_REASON =
  'Finish: commit the work and write the RESULT line (or PARTIAL/REFUSE with the reason) before you stop.';

/** An end line: the RESULT line, or PARTIAL / REFUSE (with a reason). */
const END_LINE = /\bRESULT\s+status=|\bPARTIAL\b|\bREFUSE[DS]?\b/;

/**
 * Has the agent written an end line in its last message? Looks at `last_assistant_message` from the hook input and at the
 * last assistant rows of the transcript (text, and `message` in a SubagentHandback call, where the report is delivered).
 * @param {{ lastMessage?: string|null, text?: string|null, maxRows?: number }} a
 */
function hasEndLine({ lastMessage = null, text = null, maxRows = 3 } = {}) {
  if (lastMessage && END_LINE.test(String(lastMessage))) return true;
  const lines = String(text ?? '').split('\n');
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < maxRows; i--) {
    const l = lines[i];
    if (!l.includes('"assistant"')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // the first line of the tail may be cut
    }
    if (o?.type !== 'assistant' || !Array.isArray(o?.message?.content)) continue;
    seen++;
    for (const c of o.message.content) {
      const parts =
        c?.type === 'text'
          ? [c.text]
          : c?.type === 'tool_use'
            ? [c?.input?.message, c?.input?.content]
            : [];
      if (parts.some((b) => typeof b === 'string' && END_LINE.test(b))) return true;
    }
  }
  return false;
}

/**
 * Should the gate stop the agent (SubagentStop, decision: block)?
 * @param {{ agentType?: string|null, commits: number|null, hasEndLine: boolean, alreadyBlocked: boolean,
 *   stopHookActive?: boolean }} a  commits = the track's own commits on its branch since head_start (null = unknown).
 * @returns {null | { decision: 'block', reason: string }}
 * Fails open: an unknown agent type, an unknown commit count or a block already given gives null.
 */
function assessEndGate({ agentType, commits, hasEndLine: ended, alreadyBlocked, stopHookActive = false }) {
  if (!agentType || !TRACK_AGENT_TYPES.has(agentType)) return null;
  if (alreadyBlocked || stopHookActive) return null; // once per agent: no loop
  if (typeof commits !== 'number' || !Number.isFinite(commits)) return null;
  if (commits > 0 || ended) return null;
  return { decision: 'block', reason: END_REASON };
}

module.exports = {
  TRACK_AGENT_TYPES,
  TRACK_HARD_LIMIT,
  KEY_COMPACT1,
  KEY_PARTIAL,
  COMPACT1_MESSAGE,
  partialSaid,
  assessTrackContext,
  PAUSE_THRESHOLD,
  PAUSE_TIP,
  isPauseMessage,
  pauseAdvice,
  END_REASON,
  hasEndLine,
  assessEndGate,
  COMPACT_COMMAND,
  HANDOVER_NOTE,
  AUTOCOMPACT_ON,
  AUTOCOMPACT_OFF,
  AUTOCOMPACT_FILE,
  compactMode,
  modeText,
  forCompactInstruction,
  countCompactions,
  afterCompactBound,
  withoutWindDown,
  AFTER_COMPACT_MAX_DRAW,
  afterCompactText,
  STANDARD,
  limits,
  isSystemMessage,
  isOverridden,
  ORCHESTRATOR_CALLS,
  lastOrchestratorCall,
  orchestratorBinding,
  inWindDown,
  assess,
  withWindDown,
  hookOutput,
};
