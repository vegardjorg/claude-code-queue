// =============================================================
// queueStatistics.js: the statistics on the kanban board for the work queue (scripts/orchestrator/queue-board.mjs).
//
// Pure functions without I/O. The server reads queue.json and the time log (via scripts/orchestrator/lib/timeCost.js) once,
// caches on mtime and calls `statistics`. No rules are copied here:
//   - the estimate is queueLogic.estimate (content_min × class weight),
//   - usage is timeCost.usageEvents (the same numbers as the budget guard and `log-time.mjs --cost`),
//   - the night window is queueLogic.parseNightWindow / inNightWindow (the same as the night guard),
//   - the dates are local dates (timeCost.dayFor).
// The median is the main number (tolerates outliers); the average sits next to it. Tasks without `started` (completed outside the queue)
// or with missing or impossible times are not counted in the times, and the number excluded is in the answer.
// In versus out (added and finished per day), median time from question to answer (only with enough resolutions), and
// the age limits for aging work on the board (`ageBounds`: p85 per class).
// The batch queue is counted separately in the key figures (`batchQueue`).
// Tested in scripts/orchestrator/lib/__tests__/queueStatistics.test.ts.
// =============================================================

const L = require('./queueLogic.js');
const TK = require('./timeCost.js');

/** The charts show the last 14 days; "finished" in the key figures the last 7. */
const WINDOW_DAYS = 14;
const DONE_DAYS = 7;
/** The context cap for a track (the mission template: handover and PARTIAL at about 300k). */
const CONTEXT_CAP = 300_000;
/** The classes in fixed order (the charts are stacked in this order). */
const CLASSES = ['K', 'D', 'D+', 'U'];
/** The model field is read from this many of the last track agents. */
const MODEL_COUNT = 10;
/** Aging work: the percentile and the minimum number finished in the class before the limit applies. */
const AGE_PERCENTILE = 85;
const AGE_MIN_COUNT = 5;
/** "Median time from question to answer" is shown only when this many resolutions have a time. */
const RESPONSE_TIME_MIN_COUNT = 5;

const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

/** Median of the numbers (null for an empty list). */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Average of the numbers (null for an empty list). */
function average(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Percentile p (0–100) by nearest rank: at least p % of the numbers are less than or equal to the answer (null for an empty list). */
function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Done tasks in the queue (not entries outside the queue) with a done date among `days` (local date). */
function doneInWindow(queue, days, tz = TK.TZ) {
  const inWindow = new Set(days);
  return (queue?.tasks ?? []).filter(
    (o) =>
      o.status === 'done' &&
      !L.isExternalRow(o) &&
      o.done &&
      inWindow.has(TK.dayFor(o.done, tz)),
  );
}

/**
 * The age limits for aging work on the board: per class p85 of the work time (start to delivered; for cards
 * in In progress) and of the whole cycle (start to done; for cards in Review), among those finished in the last 14 days. A class
 * with fewer than AGE_MIN_COUNT finished has no limit (null): then nothing is marked.
 * @returns {Record<string, { work: number|null, cycle: number|null, count: number }>} minutes
 */
function ageBounds(queue, { now = Date.now(), tz = TK.TZ } = {}) {
  const finished = doneInWindow(queue, daysBackward(now, WINDOW_DAYS, tz), tz);
  const out = {};
  for (const cls of CLASSES) {
    const i = finished.filter((o) => o.class === cls);
    const work = i.map((o) => minutesBetween(o.started, o.delivered)).filter((x) => x != null);
    const cycle = i.map((o) => minutesBetween(o.started, o.done)).filter((x) => x != null);
    out[cls] = {
      work: work.length >= AGE_MIN_COUNT ? round(percentile(work, AGE_PERCENTILE)) : null,
      cycle: cycle.length >= AGE_MIN_COUNT ? round(percentile(cycle, AGE_PERCENTILE)) : null,
      count: cycle.length,
    };
  }
  return out;
}

/**
 * The last `n` dates (YYYY-MM-DD, local date in the time zone), oldest first, with today last. Computed in calendar days from today's
 * date, so daylight saving time never skips or repeats a day.
 */
function daysBackward(now, n, tz = TK.TZ) {
  const [y, m, d] = TK.dayFor(new Date(now).toISOString(), tz).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--)
    out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}

/** Minutes between two ISO times, or null when one is missing, invalid or goes backward. */
function minutesBetween(from, to) {
  const a = Date.parse(from ?? '');
  const b = Date.parse(to ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 60_000;
}

/** The numbers for one selection: median and average in whole minutes. */
const middle = (xs) => ({
  median: xs.length ? round(median(xs)) : null,
  average: xs.length ? round(average(xs)) : null,
});

/** The batch queue in numbers: tasks, content minutes, groups and groups ready for packing. */
function batchQueueNumber(queue) {
  const g = L.batchGroups(queue ?? {});
  return {
    count: g.reduce((s, x) => s + x.count, 0),
    minutes: g.reduce((s, x) => s + x.sum, 0),
    groups: g.length,
    readyOnes: g.filter((x) => x.ready).length,
  };
}

/**
 * The whole statistics for the board.
 * @param {object} queue the queue (queue.json)
 * @param {object[]} rows the time log (timeCost.readRows); the "done" rows are enough
 * @param {{ now?: number, tz?: string }} [option]
 */
function statistics(queue, rows, { now = Date.now(), tz = TK.TZ } = {}) {
  const g = { ...L.DEFAULT_LIMITS, ...(queue?.limits ?? {}) };
  const days = daysBackward(now, WINDOW_DAYS, tz);
  const inWindow = new Set(days);
  const last7 = new Set(days.slice(-DONE_DAYS));
  const today = days[days.length - 1];

  // ---- Tasks (queue.json): finished in the window, without entries outside the queue ----
  const finished = doneInWindow(queue, days, tz);
  const perDay = new Map(days.map((d) => [d, { day: d, K: 0, D: 0, 'D+': 0, U: 0, sum: 0 }]));
  for (const o of finished) {
    const row = perDay.get(TK.dayFor(o.done, tz));
    row.sum += 1;
    if (CLASSES.includes(o.class)) row[o.class] += 1;
  }

  // ---- In versus out: added and finished per day, without entries outside the queue ----
  const addedAt = new Map(days.map((d) => [d, 0]));
  for (const o of queue?.tasks ?? []) {
    if (L.isExternalRow(o) || !o.added_at) continue;
    const d = TK.dayFor(o.added_at, tz);
    if (addedAt.has(d)) addedAt.set(d, addedAt.get(d) + 1);
  }
  const inOutPerDay = days.map((d) => ({ day: d, in: addedAt.get(d), out: perDay.get(d).sum }));
  const last = inOutPerDay.slice(-DONE_DAYS);
  const inSum = last.reduce((s, r) => s + r.in, 0);
  const outSum = last.reduce((s, r) => s + r.out, 0);

  // ---- Time from question to answer: from when the question existed (registered, or the first task waiting on
  // it) until the resolution. Shown only with enough resolutions with a time. ----
  const responseTimes = [];
  for (const [sp, x] of Object.entries(queue?.resolutions ?? {})) {
    const answeredAt = Date.parse(x?.time ?? '');
    if (!Number.isFinite(answeredAt)) continue;
    const from = [
      queue?.question?.[sp]?.added_at,
      ...(queue?.tasks ?? [])
        .filter((o) => (o.waiting_on ?? []).includes(sp))
        .map((o) => o.added_at),
    ]
      .map((t) => Date.parse(t ?? ''))
      .filter(Number.isFinite);
    if (!from.length || answeredAt < Math.min(...from)) continue;
    responseTimes.push((answeredAt - Math.min(...from)) / 60_000);
  }

  const cycles = [];
  const match = [];
  const perClass = new Map(CLASSES.map((k) => [k, { work: [], review: [], estimate: [] }]));
  let excludedCycle = 0;
  let excludedClass = 0;
  for (const o of finished) {
    const cycle = minutesBetween(o.started, o.done);
    if (cycle == null) {
      excludedCycle += 1;
      excludedClass += 1;
      continue;
    }
    cycles.push(cycle);
    const estimate = L.estimate(o);
    if (estimate > 0) match.push(cycle / estimate);
    // Work (started → delivered) and review/merge (delivered → done) require all three times and a known class.
    const work = minutesBetween(o.started, o.delivered);
    const review = minutesBetween(o.delivered, o.done);
    const k = perClass.get(o.class);
    if (work == null || review == null || !k) {
      excludedClass += 1;
      continue;
    }
    k.work.push(work);
    k.review.push(review);
    k.estimate.push(estimate);
  }

  // ---- Usage (the time log): per day, with the night share ----
  const window = L.parseNightWindow(g.nightWindow) ?? L.parseNightWindow(L.DEFAULT_LIMITS.nightWindow);
  const cost = new Map(days.map((d) => [d, { day: d, usd: 0, night: 0 }]));
  for (const h of TK.usageEvents(rows ?? [], tz)) {
    const row = cost.get(h.day);
    if (!row) continue;
    row.usd += h.usd;
    if (L.inNightWindow(window, Date.parse(h.time), tz)) row.night += h.usd;
  }

  // ---- The context of the build agents (last row per agent; the rows are cumulative) ----
  // The build agents are `track` (K, U) AND `track-d` (D, D+); the role map lives in timeCost.isBuildAgent, so
  // D tracks do not fall out of the context and model statistics.
  const trackRows = new Map();
  for (const r of rows ?? []) {
    if (r?.event !== 'done' || !TK.isBuildAgent(r.agent_type)) continue;
    trackRows.set(r.agent_id ?? `${r.track ?? '?'}|${r.time}`, r);
  }
  const trackLast = [...trackRows.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const inWindowTrack = trackLast.filter((r) => inWindow.has(TK.dayFor(r.time, tz)));
  const contexts = inWindowTrack
    .map((r) => Number(r.context?.end))
    .filter((x) => Number.isFinite(x) && x > 0);

  // ---- The model in the last tracks ----
  const models = new Map();
  for (const r of trackLast.filter((x) => x.model).slice(-MODEL_COUNT))
    models.set(r.model, (models.get(r.model) ?? 0) + 1);

  const dailyBudget = Number(g.dailyBudget);
  return {
    windowDays: WINDOW_DAYS,
    doneDays: DONE_DAYS,
    nightWindow: g.nightWindow,
    keyFigures: {
      finished: finished.filter((o) => last7.has(TK.dayFor(o.done, tz))).length,
      cycleMedian: cycles.length ? round(median(cycles)) : null,
      cycleCount: cycles.length,
      accuracy: match.length ? round(median(match), 2) : null,
      matchCount: match.length,
      usageToday: round(cost.get(today).usd, 2),
      dailyBudget:
        g.dailyBudget != null && Number.isFinite(dailyBudget) && dailyBudget > 0
          ? dailyBudget
          : null,
      // Per day on average over the last 7 days; net > 0 means the queue is growing.
      inOut: {
        in: round(inSum / DONE_DAYS, 1),
        out: round(outSum / DONE_DAYS, 1),
        net: round((inSum - outSum) / DONE_DAYS, 1),
      },
      // The batch queue is counted separately (waiting to be packed, not to be started).
      batchQueue: batchQueueNumber(queue),
      responseTime:
        responseTimes.length >= RESPONSE_TIME_MIN_COUNT
          ? { median: round(median(responseTimes)), count: responseTimes.length }
          : null,
    },
    donePerDay: [...perDay.values()],
    inOutPerDay,
    perClass: CLASSES.map((cls) => {
      const k = perClass.get(cls);
      return {
        class: cls,
        count: k.work.length,
        work: middle(k.work),
        review: middle(k.review),
        estimateAverage: k.estimate.length ? round(average(k.estimate)) : null,
      };
    }),
    costPerDay: [...cost.values()].map((r) => ({
      day: r.day,
      usd: round(r.usd, 2),
      night: round(r.night, 2),
    })),
    context: {
      count: contexts.length,
      median: contexts.length ? round(median(contexts)) : null,
      max: contexts.length ? Math.max(...contexts) : null,
      cap: CONTEXT_CAP,
    },
    excluded: {
      cycle: excludedCycle,
      class: excludedClass,
      context: inWindowTrack.length - contexts.length,
    },
    models: [...models.entries()]
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count),
  };
}

module.exports = {
  WINDOW_DAYS,
  DONE_DAYS,
  CONTEXT_CAP,
  CLASSES,
  AGE_PERCENTILE,
  AGE_MIN_COUNT,
  RESPONSE_TIME_MIN_COUNT,
  median,
  average,
  percentile,
  daysBackward,
  minutesBetween,
  doneInWindow,
  ageBounds,
  statistics,
};
