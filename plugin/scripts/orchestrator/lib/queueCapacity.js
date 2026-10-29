// =============================================================
// queueCapacity.js: the weekly quota of the Claude subscription as a model in the work queue.
//
// The subscription has a weekly quota that resets at a fixed time each week. The queue uses the quota continuously, and
// without governance it can run empty several days before the reset. This module estimates how much of the quota is used,
// when it runs empty at the current pace, and how many tracks can run concurrently without it running empty before the reset.
//
// The reset (weekday, time of day, time zone) and the subscription name are in queue.config.json under `capacity`
// (resetDay, resetClock, timeZone, planName); see `resetFrom`. Daylight saving time is handled.
//
// The model: usage is measured in API-equivalent USD from the time log (timeCost.usageEvents, the same numbers as
// the budget guard and `log-time.mjs --cost`). One constant, `usd_per_100`, says how many such USD in the TIME LOG
// correspond to 100 % of the weekly quota. The time log covers only the subagents; the orchestrator session and other sessions are outside,
// but are included in the constant as long as their share is stable. That is why the constant is calibrated against the percentage Claude shows on
// the usage page (`queue.mjs capacity --calibrate <percent>`), not against list prices.
//
// No I/O here (beyond reading the config): queue.mjs reads the queue and the time log and calls these functions. Tested in
// scripts/orchestrator/lib/__tests__/queueCapacity.test.ts.
// =============================================================
'use strict';

const L = require('./queueLogic.js');
const { config } = require('./queueConfig.js');

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const HOUR_MS = 3_600_000;

/**
 * Default reset when the config says nothing: tuesday (getUTCDay number 2) at 19.00 in Europe/Oslo, without
 * planName. Overridden in queue.config.json under `capacity`.
 */
const RESET = Object.freeze({
  weekday: 2,
  hour: 19,
  minute: 0,
  tz: 'Europe/Oslo',
  planName: null,
});

/** Is `tz` a time zone Intl knows? */
function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The reset from the config fields under `capacity` (missing or invalid values give the default):
 *   resetDay    0-6 (0 = sunday, 2 = tuesday)
 *   resetClock "HH:MM" (24-hour, local time in the time zone)
 *   timeZone        IANA time zone, e.g. "Europe/Oslo"
 *   planName        the subscription name in the text, or null for just "weekly quota"
 * @param {{ resetDay?: number, resetClock?: string, timeZone?: string, planName?: string|null }} [ch]
 * @returns {{ weekday: number, hour: number, minute: number, tz: string, planName: string|null }}
 */
function resetFrom(ch = {}) {
  const day = Number(ch?.resetDay);
  const weekday =
    ch?.resetDay != null && Number.isInteger(day) && day >= 0 && day <= 6
      ? day
      : RESET.weekday;
  const hm = /^(\d{1,2})[:.](\d{2})$/.exec(String(ch?.resetClock ?? '').trim());
  const okHm = hm != null && Number(hm[1]) <= 23 && Number(hm[2]) <= 59;
  const tz = ch?.timeZone && validTimeZone(ch.timeZone) ? ch.timeZone : RESET.tz;
  const planName =
    typeof ch?.planName === 'string' && ch.planName.trim() ? ch.planName.trim() : null;
  return {
    weekday,
    hour: okHm ? Number(hm[1]) : RESET.hour,
    minute: okHm ? Number(hm[2]) : RESET.minute,
    tz,
    planName,
  };
}

/** The reset as the project's config says (queue.config.json, `capacity`). Read on each call. */
function reset() {
  return resetFrom(config().capacity ?? {});
}

/** The name of the reset day, e.g. "tuesday". */
const dayName = (n = reset()) => WEEKDAYS[n.weekday];

/**
 * Default values for the quota model (saved in the queue file queue.json under `capacity`, not in the config). usd_per_100 is only
 * a rough starting point; calibrate it against the percentage Claude shows (queue.mjs capacity --calibrate / --set).
 * mode: 'notice' (fill only reports), 'cap' (fill starts no more than the suggestion, overridden with --over-quota) or
 * 'off'. stop_pct: where the quota is empty in practice (it often stops a little before 100 %).
 */
const DEFAULT_CAPACITY = {
  usd_per_100: 2282,
  stop_pct: 98,
  mode: 'notice',
  calibrations: [],
  cloudCredit: null,
};

/** The time zone offset (ms) in `tz` at the time `ms` (positive east of UTC). */
function offset(ms, tz) {
  const chunk = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+chunk.year, +chunk.month - 1, +chunk.day, +chunk.hour, +chunk.minute, +chunk.second);
  return local - Math.floor(ms / 1000) * 1000;
}

/** UTC ms for a local wall clock time in `tz` (two rounds, so the daylight saving transition is matched). */
function localToUtc(year, month0, day, hour, minute, tz) {
  const guess = Date.UTC(year, month0, day, hour, minute);
  const first = guess - offset(guess, tz);
  return guess - offset(first, tz);
}

/** Last reset (UTC ms) at or before `now`. `n` defaults to the config (reset()). */
function lastReset(now = Date.now(), n = reset()) {
  // The local date in the time zone now, then go back to the reset day and check the time of day.
  const local = new Date(now + offset(now, n.tz));
  for (let back = 0; back <= 7; back++) {
    const d = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back),
    );
    if (d.getUTCDay() !== n.weekday) continue;
    const t = localToUtc(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      n.hour,
      n.minute,
      n.tz,
    );
    if (t <= now) return t;
  }
  throw new Error('found no reset (cannot happen)');
}

/** Next reset (UTC ms) after `now`: the same local time of day seven days after the last one. */
function nextReset(now = Date.now(), n = reset()) {
  const last = lastReset(now, n);
  const local = new Date(last + offset(last, n.tz));
  return localToUtc(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 7,
    n.hour,
    n.minute,
    n.tz,
  );
}

/** The settings as they apply: the defaults + whatever is in queue.json under `capacity`. */
function settings(queue) {
  return { ...DEFAULT_CAPACITY, ...(queue?.capacity ?? {}) };
}

/**
 * The usage in [from, to) from the usage events (timeCost.usageEvents).
 * @returns {{ usd: number, tokens: Record<string, number>, agents: number }}
 */
function usageBetween(events, from, to) {
  const tokens = { input: 0, output: 0, cache_read: 0, cache_written: 0 };
  const agents = new Set();
  let usd = 0;
  for (const h of events ?? []) {
    const t = Date.parse(h.time);
    if (!(t >= from && t < to)) continue;
    usd += h.usd;
    agents.add(h.agent);
    for (const k of Object.keys(tokens)) tokens[k] += Number(h.tokens?.[k] ?? 0) || 0;
  }
  return { usd, tokens, agents: agents.size };
}

/**
 * Track hours in [from, to): the sum of the time queue tracks have run (started → delivered, or now while running), without
 * cloud tracks (their own cloud credit), picked tasks and entries outside the queue. Divided by the hours it gives the average number of
 * parallel tracks.
 */
function trackHours(queue, from, to) {
  let ms = 0;
  for (const o of queue?.tasks ?? []) {
    if (!o.started || o.cloud || o.picked_by || L.isExternalRow(o)) continue;
    const start = Date.parse(o.started);
    const end = o.delivered
      ? Date.parse(o.delivered)
      : o.status === 'running'
        ? to
        : o.done
          ? Date.parse(o.done)
          : null;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const a = Math.max(start, from);
    const b = Math.min(end, to);
    if (b > a) ms += b - a;
  }
  return ms / HOUR_MS;
}

/** Calibrated cost (USD) and count for tasks that are waiting or running (what lies ahead in the queue). */
function queueCost(queue) {
  let usd = 0;
  let count = 0;
  for (const o of queue?.tasks ?? []) {
    if (!['waiting', 'running'].includes(o.status) || L.isExternalRow(o)) continue;
    usd += L.estimateCost(o);
    count++;
  }
  return { usd, count };
}

/**
 * Forecast for the week.
 * @param {{ queue: object, events: object[], now?: number, reset?: object }} input
 *   reset: defaults to the config (reset()); included in the answer, so the texts use the same day and zone
 */
function forecast({ queue, events, now = Date.now(), reset: n = reset() }) {
  const k = settings(queue);
  const from = lastReset(now, n);
  const to = nextReset(now, n);
  const f = usageBetween(events, from, now);
  const pct = (f.usd / k.usd_per_100) * 100;
  const hoursElapsed = Math.max((now - from) / HOUR_MS, 1 / 60);
  const hoursLeft = (to - now) / HOUR_MS;
  // Pace as the average since the reset (the way Claude computes its forecast) and the last 24 hours (today's speed).
  const paceAverage = pct / hoursElapsed; // % per hour
  const f24 = usageBetween(events, Math.max(from, now - 24 * HOUR_MS), now);
  const hours24 = Math.min(24, hoursElapsed);
  const rate24 = ((f24.usd / k.usd_per_100) * 100) / hours24;
  const emptyAt = (rate) =>
    rate > 0 && pct < 100 ? now + ((100 - pct) / rate) * HOUR_MS : pct >= 100 ? now : null;
  const emptyAverage = emptyAt(paceAverage);
  const empty24 = emptyAt(rate24);
  // Parallelism: track hours per hour = the average of concurrent tracks; % per track hour includes the orchestrator's share.
  const st = trackHours(queue, from, now);
  const parallelAverage = st / hoursElapsed;
  const pctPerTrackHour = st > 0 ? pct / st : null;
  const rest = Math.max(0, 100 - pct);
  const sustainablePace = hoursLeft > 0 ? rest / hoursLeft : 0; // % per hour that lasts until the reset
  // The floor (not rounding): a suggestion should rather let the quota last a little longer than empty it before the reset.
  const trackSustainable =
    pctPerTrackHour && pctPerTrackHour > 0 ? sustainablePace / pctPerTrackHour : null;
  const suggestionTrack = trackSustainable == null ? null : Math.max(0, Math.floor(trackSustainable));
  const costOfQueue = queueCost(queue);
  return {
    from,
    to,
    now,
    reset: n,
    usd: f.usd,
    tokens: f.tokens,
    agents: f.agents,
    pct,
    usd_per_100: k.usd_per_100,
    stop_pct: k.stop_pct,
    mode: k.mode,
    hoursElapsed,
    hoursLeft,
    paceAverage,
    tempo24: rate24,
    emptyAverage,
    empty24,
    holds: emptyAverage == null || emptyAverage >= to,
    trackHours: st,
    parallelAverage,
    pctPerTrackHour,
    sustainablePace,
    trackSustainable,
    suggestionTrack,
    // One weekly quota converted: tokens and track hours per 100 % at the pace so far this week.
    per100:
      pct > 0
        ? {
            tokens: Object.fromEntries(
              Object.entries(f.tokens).map(([n2, v]) => [n2, (v / pct) * 100]),
            ),
            trackHours: st > 0 ? (st / pct) * 100 : null,
          }
        : null,
    queue: { ...costOfQueue, pct: (costOfQueue.usd / k.usd_per_100) * 100 },
    cloudCredit: k.cloudCredit ?? null,
    calibrations: k.calibrations ?? [],
  };
}

/**
 * A new constant from the percentage Claude shows now: usd_per_100 = the usage since the reset / percent × 100.
 * Returns the new settings (saved by the caller under the lock) or { error }.
 * @param {object} queue
 * @param {{ percent: unknown, events: object[], now?: number, reset?: object }} input
 *   reset: defaults to the config (reset())
 */
function calibrate(
  queue,
  { percent, events, now = Date.now(), reset: n = reset() },
) {
  const p = Number(percent);
  if (!(p > 0 && p <= 100)) return { error: 'the percentage must be a number above 0 and at most 100' };
  const k = settings(queue);
  const from = lastReset(now, n);
  const { usd } = usageBetween(events, from, now);
  if (!(usd > 0))
    return { error: 'no measured usage since the reset; cannot calibrate yet' };
  const fresh = Math.round((usd / p) * 100);
  const point = {
    time: new Date(now).toISOString(),
    percent: p,
    usd: Math.round(usd * 10) / 10,
    usd_per_100: fresh,
  };
  return {
    previous: k.usd_per_100,
    capacity: {
      ...(queue?.capacity ?? {}),
      usd_per_100: fresh,
      calibrations: [...(k.calibrations ?? []), point].slice(-20),
    },
  };
}

/**
 * The cap for `fill`: how many NEW tracks can be started when the quota forecast must last until the reset.
 * mode 'off' or unknown suggestion: no limit. Otherwise: maxNew = max(0, suggestion − active), but never below 1 when
 * nothing is running (the queue should not stand completely still on a forecast). 'notice' only gives the message; 'cap' limits.
 * @returns {{ limit: number|null, message: string|null }}
 */
function quotaCap(p, activeOnes) {
  if (p.mode === 'off' || p.suggestionTrack == null) return { limit: null, message: null };
  if (p.holds && activeOnes <= p.suggestionTrack) return { limit: null, message: null };
  const maxNew = Math.max(activeOnes === 0 ? 1 : 0, p.suggestionTrack - activeOnes);
  const tz = p.reset?.tz;
  const text =
    `Quota: ${p.pct.toFixed(0)} % used, empty ${timeText(p.emptyAverage, tz)} at this pace ` +
    `(resets ${timeText(p.to, tz)}). ` +
    `At most ${p.suggestionTrack} concurrent tracks last until the reset; ${activeOnes} running now.`;
  if (p.mode === 'cap')
    return {
      limit: maxNew,
      message: `${text} Quota cap: starts at most ${maxNew} new ones (override with --over-quota).`,
    };
  return {
    limit: null,
    message: `${text} (Notice only; queue.mjs capacity --mode cap makes it a cap.)`,
  };
}

/** "sunday 25.10 at 16.30" in the time zone `tz` (default: the time zone from the config). */
function timeText(ms, tz) {
  if (ms == null) return 'never (no usage)';
  const zone = tz || reset().tz;
  const d = new Date(ms + offset(ms, zone));
  const to = (x) => String(x).padStart(2, '0');
  return (
    `${WEEKDAYS[d.getUTCDay()]} ${to(d.getUTCDate())}.${to(d.getUTCMonth() + 1)} at ` +
    `${to(d.getUTCHours())}.${to(d.getUTCMinutes())}`
  );
}

const counts = (x, d = 1) => x.toLocaleString('en-GB', { maximumFractionDigits: d });
const mill = (x) => `${(x / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 1 })} M`;
const pctT = (x, d = 1) => `${x.toLocaleString('en-GB', { maximumFractionDigits: d })} %`;

/** The lines `queue.mjs capacity` prints. */
function lines(p) {
  const n = p.reset ?? reset();
  const tt = (ms) => timeText(ms, n.tz);
  const out = [];
  out.push(
    `Weekly quota${n.planName ? ` (${n.planName})` : ''}: reset ${tt(p.from)}, next ${tt(p.to)} ` +
      `(${p.hoursLeft.toFixed(0)} h left; resets every ${dayName(n)}).`,
  );
  out.push(
    `Used: ${pctT(p.pct)} estimated (${Math.round(p.usd)} of ${p.usd_per_100} USD API equivalent in the time log; ` +
      `${p.agents} agents).`,
  );
  out.push(
    `  Tokens since the reset (subagents): cache-read ${mill(p.tokens.cache_read)}, cache-written ` +
      `${mill(p.tokens.cache_written)}, output ${mill(p.tokens.output)}, input ${mill(p.tokens.input)}.`,
  );
  out.push(
    `Pace: ${pctT(p.paceAverage * 24)} per day on average since the reset, ${pctT(p.tempo24 * 24)} per day the last 24 h.`,
  );
  out.push(
    `Empty (100 %) at the average pace: ${tt(p.emptyAverage)}${p.holds ? ' (lasts until the reset)' : ''}; ` +
      `at the pace of the last 24 h: ${tt(p.empty24)}.`,
  );
  out.push(
    `Parallelism: ${counts(p.parallelAverage)} tracks on average (${p.trackHours.toFixed(0)} track hours)` +
      (p.pctPerTrackHour ? `, ${pctT(p.pctPerTrackHour, 2)} of the quota per track hour.` : '.'),
  );
  if (p.suggestionTrack != null)
    out.push(
      `Suggested: at most ${p.suggestionTrack} concurrent tracks (computed ${counts(p.trackSustainable)}; ` +
        `${pctT(p.sustainablePace * 24)} per day) make the quota last until ${tt(p.to)}; ${p.suggestionTrack + 1} tracks ` +
        `empty it about ${tt(p.now + ((100 - p.pct) / ((p.suggestionTrack + 1) * p.pctPerTrackHour)) * HOUR_MS)}. ` +
        `Mode in fill: ${p.mode}.`,
    );
  if (p.per100)
    out.push(
      `One weekly quota ≈ ${mill(p.per100.tokens.cache_read)} cache-read, ${mill(p.per100.tokens.cache_written)} ` +
        `cache-written and ${mill(p.per100.tokens.output)} output tokens` +
        (p.per100.trackHours ? `, about ${Math.round(p.per100.trackHours)} track hours.` : '.'),
    );
  out.push(
    `The queue (waiting and running, also blocked and parked): ${p.queue.count} tasks ≈ ${Math.round(p.queue.usd)} USD ≈ ${pctT(p.queue.pct)} of a ` +
      'weekly quota (calibrated cost per class).',
  );
  if (p.cloudCredit) {
    const s = p.cloudCredit;
    out.push(
      `Cloud credit (separate pool, cloud sessions only): ${s.left_usd} of ${s.total_usd ?? '?'} USD left, expires ` +
        `${s.expires ? tt(Date.parse(s.expires)) : '?'}${s.set ? ` (set ${s.set.slice(0, 10)})` : ''}. ` +
        'Empty credit: cloud sessions count against the weekly quota.',
    );
  }
  const latest = p.calibrations.at(-1);
  out.push(
    latest
      ? `Calibrated ${tt(Date.parse(latest.time))}: ${latest.percent} % = ${latest.usd} USD → ${latest.usd_per_100} per 100 %. ` +
          'New: queue.mjs capacity --calibrate <percent from Claude>.'
      : 'Default constant (not calibrated yet). Calibrate: queue.mjs capacity --calibrate <percent from Claude>.',
  );
  return out;
}

module.exports = {
  RESET,
  WEEKDAYS,
  DEFAULT_CAPACITY,
  resetFrom,
  reset,
  dayName,
  offset,
  localToUtc,
  lastReset,
  nextReset,
  settings,
  usageBetween,
  trackHours,
  queueCost,
  forecast,
  calibrate,
  quotaCap,
  timeText,
  lines,
};
