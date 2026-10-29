// =============================================================
// timeCost.js: correct measurement of agent usage. See docs/orchestration.md.
//
// Pure logic, no I/O. Used by:
//   hook-time.mjs   analyzeTranscript(): the numbers in the "done" row per agent
//   log-time.mjs   --show (deduplicated) and --cost [--day]: usage per agent type and total
//   queue.mjs         dailyUsage() for the budget guard in `next`
// Tested in lib/__tests__/timeCost.test.ts.
//
// WHY DEDUPLICATION: hook-time writes a "done" row every time an agent stops, and the rows are CUMULATIVE (the whole
// transcript is analyzed again). An agent resumed with SendMessage therefore gets several rows, and a naive sum
// counts the same usage several times (well over double in practice).
// Here every row gives only the GROWTH since the previous row for the same agent, so the sum over all rows = last row
// per agent, and the usage is split correctly by day when an agent runs past midnight.
//
// UNIT: "API-equivalent USD" with the list prices in PRICES: claude-opus-5-5 input $4, output $20, cache read $0.20,
// cache write 5 min $5 and 1 h $8 per MTok. The subscription quota is not in dollars, but is weighted by the same
// pattern, so the shares and trends are what matter.
// =============================================================
'use strict';

/** USD per million tokens. Unknown models are priced as DEFAULT_MODEL and marked "assumed". */
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_5m: 5, cache_1h: 8 },
};
const DEFAULT_MODEL = 'claude-opus-5-5';

/** The time zone "day" is computed in (local day). */
const TZ = 'Europe/Oslo';

/** The cache lifetime per type (s). A pause longer than this before a turn = the cache expired and was written again. */
const CACHE_TTL_S = { '5m': 300, '1h': 3600 };

/**
 * Price for a set of tokens. Older rows have only `cache_written` (the sum): subagents have a 5 minute cache
 * (the investigation, section 2.1), so the sum is then priced as 5 min. Newer rows have `cache_written_5m` and `cache_written_1h`.
 * @returns {number} USD
 */
function costUsd(tokens, model) {
  if (!tokens) return 0;
  const p = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  let s5 = tokens.cache_written_5m;
  let s1 = tokens.cache_written_1h;
  if (s5 == null && s1 == null) {
    s5 = n(tokens.cache_written);
    s1 = 0;
  } else {
    s5 = n(s5);
    s1 = n(s1);
    // Writes not split by type (older API responses) count as 5 min.
    const undivided = n(tokens.cache_written) - s5 - s1;
    if (undivided > 0) s5 += undivided;
  }
  return (
    (n(tokens.input) * p.input +
      n(tokens.output) * p.output +
      n(tokens.cache_read) * p.cache_read +
      s5 * p.cache_5m +
      s1 * p.cache_1h) /
    1e6
  );
}

/**
 * Track id from the agent's mission (first user messages in the transcript): `prompt-<ID>.md` or "track <ID>"/"TRACK <ID>".
 * The ids in the queue can have hyphens and dots and start with a letter (A-1, alpha-2b); a regex that only takes
 * [A-Za-z0-9]+ or "TRACK <digits...>" would log such tracks with the agent id instead.
 * @returns {string|null}
 */
function trackFromText(text) {
  const t = String(text ?? '');
  const clean = (s) => s.replace(/[._-]+$/, '');
  const file = t.match(/prompt-([A-Za-z0-9][A-Za-z0-9._-]*?)\.md\b/);
  if (file) return clean(file[1]);
  // The reviewer's mission is "Read <scratchpad>\rev-<ID>\reviewer-<type>.md ..." (queue.mjs receive). Without this rule
  // the reviewers are logged with the agent id, and the review cost and the FINDINGS lines go missing.
  const rev = t.match(/(?:^|[\\/\s])rev-([A-Za-z0-9][A-Za-z0-9._-]*?)[\\/]+reviewer-/);
  if (rev) return clean(rev[1]);
  const word = t.match(/\b(?:TRACK|[Tt]rack)\s+([A-Z0-9][A-Za-z0-9._-]{1,40})/);
  if (word) return clean(word[1]);
  return null;
}

/**
 * The build agents (the agents that do the track itself): `track` for K and U, `track-d` for D and D+ (queueLogic.agentTypeFor).
 * A role map that only knows `track` loses the phase split for D and D+.
 */
const BUILD_AGENT_TYPES = ['track', 'track-d'];
const isBuildAgent = (type) => BUILD_AGENT_TYPES.includes(type);

/**
 * Computes usage from an agent transcript (JSONL). Streamed messages can span several lines with the same
 * message.id; they are counted once (last usage wins, first timestamp gives the turn's time).
 */
function analyzeTranscript(text) {
  const turns = new Map(); // message.id -> { usage, ts, model }
  const tool = new Set();
  let first = null;
  let last = null;
  let firstChange = null;
  let callForChange = 0;
  let trackFromMission = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (first === null) first = ts;
      last = ts;
    }
    const m = r.message;
    if (!m) continue;
    const content = Array.isArray(m.content) ? m.content : [];
    if (r.type === 'user' && !trackFromMission) {
      const textChunks =
        typeof m.content === 'string' ? m.content : content.map((c) => c?.text ?? '').join(' ');
      trackFromMission = trackFromText(textChunks);
    }
    if (r.type !== 'assistant') continue;
    if (m.id && m.usage) {
      const earlier = turns.get(m.id);
      turns.set(m.id, {
        usage: m.usage,
        ts: earlier?.ts ?? (Number.isNaN(ts) ? null : ts),
        model: m.model ?? earlier?.model ?? null,
      });
    }
    for (const c of content) {
      if (c?.type !== 'tool_use' || !c.id || tool.has(c.id)) continue;
      tool.add(c.id);
      if (firstChange === null) {
        if (['Edit', 'Write', 'NotebookEdit'].includes(c.name)) firstChange = ts;
        else callForChange++;
      }
    }
  }
  const tokens = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_written: 0,
    cache_written_5m: 0,
    cache_written_1h: 0,
  };
  const context = [];
  const models = new Map();
  let cacheExpiry = 0;
  let previousTs = null;
  for (const { usage: u, ts, model } of turns.values()) {
    const written = u.cache_creation_input_tokens ?? 0;
    const read = u.cache_read_input_tokens ?? 0;
    const five = u.cache_creation?.ephemeral_5m_input_tokens;
    const hour = u.cache_creation?.ephemeral_1h_input_tokens;
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.cache_read += read;
    tokens.cache_written += written;
    // Without a split (older API responses) the write counts as 5 min, as for subagents.
    tokens.cache_written_5m += five ?? (hour == null ? written : 0);
    tokens.cache_written_1h += hour ?? 0;
    context.push((u.input_tokens ?? 0) + read + written);
    if (model) models.set(model, (models.get(model) ?? 0) + 1);
    // Cache expiry: the turn came after a pause longer than the cache lifetime and wrote more than it read (the whole context
    // was written again). The investigation, section 2.1: about $2.25 per expiry for an agent at 450k, vs $0.09 for a normal turn.
    const ttl = (hour ?? 0) > 0 ? CACHE_TTL_S['1h'] : CACHE_TTL_S['5m'];
    if (ts !== null && previousTs !== null && ts - previousTs > ttl * 1000 && written > read)
      cacheExpiry++;
    if (ts !== null) previousTs = ts;
  }
  const sorted = [...context].sort((x, y) => x - y);
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    duration_s: first !== null && last !== null ? Math.round((last - first) / 1000) : null,
    toolCall: tool.size,
    modelTurns: turns.size,
    tokens,
    model,
    cache_expiry: cacheExpiry,
    cost_usd: Math.round(costUsd(tokens, model) * 100) / 100,
    context: context.length
      ? {
          start: context[0],
          median: sorted[Math.floor(sorted.length / 2)],
          end: context[context.length - 1],
        }
      : null,
    first_change_s:
      firstChange !== null && first !== null
        ? Math.round((firstChange - first) / 1000)
        : null,
    call_for_first_change: firstChange !== null ? callForChange : null,
    track: trackFromMission,
  };
}

/** The date (YYYY-MM-DD) an ISO timestamp has in the time zone `tz`. */
function dayFor(iso, tz = TZ) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Reads JSONL text into rows; broken lines are skipped (the file is written by several processes). */
function readRows(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* half line from a concurrent writer */
    }
  }
  return out;
}

/** The key a usage row is deduplicated on: agent_id, otherwise track + time (older manual rows). */
const agentKey = (r) => r.agent_id ?? `${r.track ?? '?'}|${r.time}`;

/**
 * The usage split into events: one per "done" row with tokens, with the GROWTH since the previous row for the same agent
 * (the rows are cumulative). The sum over all events = last row per agent.
 * `tokens` is the growth in raw tokens (input, output, cache_read, cache_written) the same way, for
 * the weekly quota model in lib/queueCapacity.js.
 * @returns {{ agent: string, type: string, track: string, time: string, day: string, usd: number, turns: number,
 *   cache_expiry: number, assumed: boolean, tokens: { input: number, output: number, cache_read: number,
 *   cache_written: number } }[]}
 */
function usageEvents(rows, tz = TZ) {
  const perAgent = new Map();
  for (const r of rows) {
    if (r?.event !== 'done' || !r.tokens) continue;
    const k = agentKey(r);
    if (!perAgent.has(k)) perAgent.set(k, []);
    perAgent.get(k).push(r);
  }
  const out = [];
  for (const [agent, list] of perAgent) {
    list.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    let previous = { usd: 0, turns: 0, expiry: 0 };
    const previousTok = { input: 0, output: 0, cache_read: 0, cache_written: 0 };
    for (const r of list) {
      const growth = {};
      for (const k of Object.keys(previousTok)) {
        const v = Number(r.tokens?.[k] ?? 0) || 0;
        growth[k] = Math.max(0, v - previousTok[k]);
        previousTok[k] = Math.max(previousTok[k], v);
      }
      const now = {
        usd: costUsd(r.tokens, r.model),
        turns: Number(r.modelTurns ?? 0),
        expiry: Number(r.cache_expiry ?? 0),
      };
      out.push({
        agent,
        type: require('./projectRoot.js').bareAgentType(r.agent_type) ?? 'unknown',
        track: r.track ?? agent,
        time: r.time,
        day: dayFor(r.time, tz),
        usd: Math.max(0, now.usd - previous.usd),
        turns: Math.max(0, now.turns - previous.turns),
        cache_expiry: Math.max(0, now.expiry - previous.expiry),
        assumed: !!r.model && !PRICES[r.model],
        tokens: growth,
      });
      // A row without full analysis (transcript too large) can be lower than the previous one: keep the highest.
      previous = {
        usd: Math.max(previous.usd, now.usd),
        turns: Math.max(previous.turns, now.turns),
        expiry: Math.max(previous.expiry, now.expiry),
      };
    }
  }
  return out;
}

/** Today's (or a given day's) usage in USD, all agent types. For the budget guard in queue.mjs. */
function dailyUsage(rows, day, tz = TZ) {
  return usageEvents(rows, tz)
    .filter((h) => h.day === day)
    .reduce((s, h) => s + h.usd, 0);
}

/**
 * Summary for `log-time.mjs --cost`: total, per agent type, per track and (with the queue) per risk class.
 * @param {object[]} rows
 * @param {{ day?: string|null, tz?: string, classFor?: (track: string) => string|null }} [option]
 */
function summarizeCost(rows, { day = null, tz = TZ, classFor = () => null } = {}) {
  const events = usageEvents(rows, tz).filter((h) => !day || h.day === day);
  const perType = new Map();
  const perTrack = new Map();
  const perClass = new Map();
  let total = 0;
  let assumed = false;
  for (const h of events) {
    total += h.usd;
    assumed ||= h.assumed;
    const t = perType.get(h.type) ?? { usd: 0, agents: new Set(), cache_expiry: 0 };
    t.usd += h.usd;
    t.agents.add(h.agent);
    t.cache_expiry += h.cache_expiry;
    perType.set(h.type, t);
    const s = perTrack.get(h.track) ?? { usd: 0, types: new Set(), cache_expiry: 0, turns: 0 };
    s.usd += h.usd;
    s.types.add(h.type);
    s.cache_expiry += h.cache_expiry;
    s.turns += h.turns;
    perTrack.set(h.track, s);
    const cls = classFor(h.track) ?? 'unknown';
    perClass.set(cls, (perClass.get(cls) ?? 0) + h.usd);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    day,
    total: r2(total),
    assumed,
    perType: [...perType.entries()]
      .map(([type, t]) => ({
        type,
        usd: r2(t.usd),
        agents: t.agents.size,
        cache_expiry: t.cache_expiry,
        share: total > 0 ? Math.round((t.usd / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.usd - a.usd),
    perTrack: [...perTrack.entries()]
      .map(([track, s]) => ({
        track,
        usd: r2(s.usd),
        types: [...s.types].sort(),
        cache_expiry: s.cache_expiry,
        turns: s.turns,
      }))
      .sort((a, b) => b.usd - a.usd),
    perClass: [...perClass.entries()]
      .map(([cls, usd]) => ({ class: cls, usd: r2(usd) }))
      .sort((a, b) => b.usd - a.usd),
  };
}

/**
 * The rows for `log-time.mjs --show`: all rows, but for every agent only the LAST "done" row (they are cumulative).
 * The order is kept.
 */
function deduplicateDone(rows) {
  const last = new Map();
  rows.forEach((r, i) => {
    if (r?.event === 'done' && r.agent_id) last.set(r.agent_id, i);
  });
  return rows.filter(
    (r, i) => !(r?.event === 'done' && r.agent_id && last.get(r.agent_id) !== i),
  );
}

/**
 * The queue's task id for a track label from the time log. Fix rounds are started as separate agents with labels such
 * as "A-1-r2" or "B-2-round2"; they belong to task A-1 / B-2.
 */
function taskIdFor(track, exists) {
  if (exists(track)) return track;
  const without = String(track).replace(/-(?:r|round)\d+$/i, '');
  return without !== track && exists(without) ? without : null;
}

/**
 * The time the FIRST reviewer for task `id` started, from the time log rows (hook-time writes a
 * "start" row per agent). An agent belongs to the task when one of its rows has the track label `id` or a fix round of
 * it (taskIdFor); the start row can lack the label when the transcript was not written yet, so the agent's earliest
 * row applies. Only agents of `types` (the reviewer types) and only starts at or after `from` (t_receive) are counted.
 * @param {object[]} rows
 * @param {string} id
 * @param {{ types: string[], from?: string|null }} option
 * @returns {string|null} ISO-time
 */
function firstReviewStart(rows, id, { types, from = null }) {
  const isId = (s) => s === id;
  const belongsTo = new Set();
  const first = new Map();
  const type = new Map();
  for (const r of rows ?? []) {
    if (!r?.agent_id) continue;
    if (r.agent_type) type.set(r.agent_id, require('./projectRoot.js').bareAgentType(r.agent_type));
    if (r.track && taskIdFor(r.track, isId) === id) belongsTo.add(r.agent_id);
    const t = Date.parse(r.time);
    if (Number.isNaN(t)) continue;
    const f = first.get(r.agent_id);
    if (f == null || t < f) first.set(r.agent_id, t);
  }
  const limit = from ? Date.parse(from) : NaN;
  let best = null;
  for (const agent of belongsTo) {
    if (!types.includes(type.get(agent))) continue;
    const t = first.get(agent);
    if (t == null || (!Number.isNaN(limit) && t < limit)) continue;
    if (best == null || t < best) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

/**
 * Changed code lines (inserted + deleted) from `git diff --shortstat`, e.g.
 * " 3 files changed, 120 insertions(+), 4 deletions(-)" -> 124. Empty diff gives 0; unrecognizable text or null gives null.
 * @returns {number|null}
 */
function diffLinesFromShortstat(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (!t) return 0;
  if (!/\bfiles? changed\b/.test(t)) return null;
  const input = t.match(/(\d+) insertions?\(\+\)/);
  const out = t.match(/(\d+) deletions?\(-\)/);
  return (input ? Number(input[1]) : 0) + (out ? Number(out[1]) : 0);
}

module.exports = {
  PRICES,
  DEFAULT_MODEL,
  TZ,
  costUsd,
  trackFromText,
  analyzeTranscript,
  dayFor,
  readRows,
  usageEvents,
  dailyUsage,
  summarizeCost,
  deduplicateDone,
  taskIdFor,
  BUILD_AGENT_TYPES,
  isBuildAgent,
  firstReviewStart,
  diffLinesFromShortstat,
};
