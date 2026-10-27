// =============================================================
// costGuard.js: the threshold logic for the cost guard. See docs/orchestration.md.
//
// When the usage of a running track passes FACTOR (3) x the average cost for its class (finished tasks with measured cost
// over the last 7 days, the same numbers as `queue.mjs cost --since 7d`), the orchestrator is notified, and the track gets
// a short message to wrap up or deliver PARTIAL. No automatic stop.
//
// The measurement is the same as `queue.mjs set <id> done` and `cost measure`: usage from the agent transcripts, priced
// with timeCost.costUsd and summed with queueLogic.sumCost. The difference is that agents still running do not have
// any "done" row in the time log yet (the start row has the agent id as track label), so `liveAgents` includes the
// start rows as candidates; the caller (hook-context.mjs) keeps an uncertain candidate only when the mission in
// the transcript mentions the task id (queueLogic.mentionsTask), as in queue.mjs.
//
// Pure logic (no file I/O), tested in lib/__tests__/costGuard.test.ts.
// =============================================================
const TK = require('./timeCost.js');

// The factor is 3, not 2: with 2x many tracks are wrapped up with little work left; the goal is to catch a runaway session.
// Each notice is logged in <dataFolder>/cost-guard-log.jsonl (cost-guard-statistics.mjs), so the threshold can be
// calibrated on data.
const FACTOR = 3;
/** Minimum number of finished tasks in the class before the average is used as threshold (one outcome is not an average). */
const MIN_N = 3;
/** How often the hook measures (reading transcripts is expensive); COST_GUARD_INTERVAL_MIN overrides. */
const INTERVAL_MS = 10 * 60_000;
const SINCE_MS = 7 * 86_400_000;
const CLASSES = ['K', 'D', 'D+', 'U'];
/** The agent types that work on a task: track, track-d and the reviewers in config().reviewers (queueLogic). */
const taskAgentTypes = () => require('./queueLogic.js').TASK_AGENT_TYPES;

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * The class from the mission file: the table row "| Class | K (weight 1.0) ..." (the make-mission format), otherwise
 * "class D+" in the title line ("TRACK X (...; class K, estimate 60 min)"). null when none is recognized.
 */
function classFromMission(text) {
  const s = String(text ?? '');
  const table = s.match(/^\|\s*Class\s*\|\s*(D\+|[KDU])(?![A-Za-z0-9+])/m);
  if (table) return table[1];
  const free = s.match(/\bclass\s+(D\+|[KDU])(?![A-Za-z0-9+])/i);
  return free ? free[1].toUpperCase() : null;
}

/**
 * Average cost per class from queueLogic.costStatistics (perClass has n and sum usd).
 * @returns {Record<string, { average: number, n: number }>}
 */
function averagePerClass(stat) {
  const out = {};
  for (const k of stat?.perClass ?? []) {
    if (!k.n) continue;
    out[k.class] = { average: round2(Number(k.usd) / k.n), n: k.n };
  }
  return out;
}

/**
 * The agents that may belong to a running task, from the time log. `safe`: a row has the task's track label
 * (or a fix round, timeCost.taskIdFor). Otherwise a candidate when the type is a task agent, the label is unknown
 * (the agent id) and the agent started after `from`. `row` is the last "done" row with tokens (backup when
 * the transcript is missing), or null.
 * @returns {{ agent: string, type: string, safe: boolean, row: object|null }[]}
 */
function liveAgents(rows, id, { from = null } = {}) {
  const info = new Map();
  for (const r of rows ?? []) {
    if (!r?.agent_id) continue;
    const t = Date.parse(r.time);
    const a = info.get(r.agent_id) ?? { first: t, type: null, track: new Set(), row: null };
    if (t < a.first) a.first = t;
    if (r.agent_type) a.type = r.agent_type;
    if (r.track) a.track.add(r.track);
    if (r.event === 'done' && r.tokens && (!a.row || t >= Date.parse(a.row.time))) a.row = r;
    info.set(r.agent_id, a);
  }
  const isId = (s) => s === id;
  const out = [];
  for (const [agent, a] of info) {
    const type = a.type ?? 'unknown';
    const labels = [...a.track];
    if (labels.some((s) => TK.taskIdFor(s, isId) === id)) {
      out.push({ agent, type, safe: true, row: a.row });
      continue;
    }
    // Another recognized label (not the agent id) means another task.
    if (labels.some((s) => !agent.startsWith(s))) continue;
    if (!taskAgentTypes().includes(type)) continue;
    if (from && a.first < Date.parse(from)) continue;
    out.push({ agent, type, safe: false, row: a.row });
  }
  return out;
}

/** Should the hook measure now? First time, or when the interval has passed since the previous measurement. */
function shouldMeasure(state, now, intervalMs = INTERVAL_MS) {
  const latest = Date.parse(state?.last_measured ?? '');
  return Number.isNaN(latest) || now - latest >= intervalMs;
}

/**
 * The threshold logic. `measurements`: [{ id, class, usd }] for running tasks. `average`: averagePerClass. A track is
 * notified once (saved in `notified`) when usd > factor x average for the class and the class has at least minN finished
 * tasks. Tasks no longer running are removed from `notified`, so a new run (fix round) can be notified again.
 * @returns {{ notices: { id: string, class: string, usd: number, average: number, limit: number, n: number }[],
 *   notified: Record<string, { usd: number, time: string }> }}
 */
function assess({
  measurements,
  average,
  notified = {},
  factor = FACTOR,
  minN = MIN_N,
  now = Date.now(),
}) {
  const activeOnes = new Set((measurements ?? []).map((m) => m.id));
  const newNotified = Object.fromEntries(
    Object.entries(notified ?? {}).filter(([id]) => activeOnes.has(id)),
  );
  const notices = [];
  for (const m of measurements ?? []) {
    const s = average?.[m.class];
    if (!s || s.n < minN || !(s.average > 0)) continue;
    const limit = round2(factor * s.average);
    if (!(Number(m.usd) > limit) || newNotified[m.id]) continue;
    notices.push({
      id: m.id,
      class: m.class,
      usd: round2(Number(m.usd)),
      average: s.average,
      limit,
      n: s.n,
    });
    newNotified[m.id] = { usd: round2(Number(m.usd)), time: new Date(now).toISOString() };
  }
  return { notices, notified: newNotified };
}

/** The short message the orchestrator forwards to the track (SendMessage). */
function trackMessage(v) {
  return (
    `COST_GUARD ${v.id}: usage is $${v.usd}, over ${FACTOR}x the average for class ${v.class} ($${v.average}). ` +
    'Wrap up: finish what you are doing, commit, and deliver. If the task is not done, deliver PARTIAL with ' +
    'what remains in the report. Do not start new parts.'
  );
}

/** Hook output (systemMessage to the owner, additionalContext to the orchestrator), or null without notices. */
function hookText(notices) {
  if (!notices?.length) return null;
  const lines = notices.map(
    (v) =>
      `${v.id} (${v.class}) $${v.usd} > ${FACTOR}x average $${v.average} (limit $${v.limit}, n=${v.n} last 7d)`,
  );
  return {
    systemMessage: `Cost guard: ${lines.join('; ')}.`,
    additionalContext:
      `[costGuard] ${notices.length} track(s) have passed ${FACTOR}x the average cost for their class: ${lines.join('; ')}. ` +
      'No automatic stop. Send each track this message with SendMessage (agent id from start/the time log): ' +
      notices.map((v) => `"${trackMessage(v)}"`).join(' ') +
      ' Judge for yourself whether the track should be stopped or split.',
  };
}

module.exports = {
  FACTOR,
  MIN_N,
  INTERVAL_MS,
  SINCE_MS,
  CLASSES,
  classFromMission,
  averagePerClass,
  liveAgents,
  shouldMeasure,
  assess,
  trackMessage,
  hookText,
};
