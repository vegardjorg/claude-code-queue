// =============================================================
// queueForecast.js: "when will the remaining N tasks be done?" as a Monte Carlo forecast (ActionableAgile style).
//
// Pure functions without I/O. The data is what the queue already has:
//   - throughput: done tasks per calendar day (local date, timeCost.dayFor) in the window (default the last 28 days),
//     INCLUDING the days nothing was finished (a zero day is real data: weekends, pauses, a stuck queue),
//   - remaining: the open tasks in the current focus stages (with the dependencies they pull along) when a focus
//     applies, otherwise all waiting, running, picked and review tasks. `project` narrows it to one project.
// One run draws a day's throughput at random (with replacement) from the window, day after day, until the drawn tasks
// reach the remaining count; the number of days is the run's answer. After `runs` runs, p50/p85/p95 are the day counts
// that 50/85/95 % of the runs finished within (nearest rank, like queueStatistics.percentile). Day 1 is today, so "by
// Tue 4 Nov (4 days)" counts from today's date.
// Expected cost = remaining x the median measured cost (cost.usd, `queue.mjs set <id> done`) per done task in the window;
// null when no done task in the window has a measured cost.
// With fewer than MIN_DONE done in the window there is no forecast ("not enough data").
// Used by `queue.mjs forecast` and the board (the Focus view and Statistics). Tested in lib/__tests__/queueForecast.test.ts.
// =============================================================

const L = require('./queueLogic.js');
const S = require('./queueStatistics.js');
const TK = require('./timeCost.js');

/** The default window (days) and number of runs. */
const WINDOW_DAYS = 28;
const RUNS = 2000;
/** Fewer done tasks than this in the window: not enough data for a forecast. */
const MIN_DONE = 5;
/** A run never counts past this many days (guards against a window that is almost all zero days). */
const MAX_DAYS = 3650;
/** The percentiles in the answer. */
const LEVELS = [50, 85, 95];
/** The open statuses counted as remaining when no focus applies. */
const OPEN = ['waiting', 'running', 'picked', 'review'];
/** Never remaining, also inside a focus stage. */
const CLOSED = ['done', 'cancelled', 'proposed', 'external'];

const round2 = (x) => Math.round(x * 100) / 100;

/** A small seeded random generator (mulberry32): the same seed gives the same numbers (the tests). Values in [0, 1). */
function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The date `n` days after the date YYYY-MM-DD (calendar days, so daylight saving time never shifts it). */
function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The forecast itself.
 * @param {{ done: { done: string, usd?: number|null }[], remaining: number, days?: number, runs?: number,
 *           rng?: () => number, now?: number, tz?: string }} input
 *   done = the done tasks (their done time and measured cost, if any); the ones outside the window are ignored.
 * @returns {{ enough: boolean, reason: string|null, remaining: number, windowDays: number, sample: number, runs: number,
 *             throughput: number[], p50: object|null, p85: object|null, p95: object|null,
 *             medianCost: number|null, costCount: number, expectedCost: number|null, today: string }}
 *   p50/p85/p95 = { days, date } (date = YYYY-MM-DD, local).
 */
function forecast({
  done = [],
  remaining = 0,
  days = WINDOW_DAYS,
  runs = RUNS,
  rng = Math.random,
  now = Date.now(),
  tz = TK.TZ,
} = {}) {
  const window = Math.max(1, Math.floor(Number(days) || WINDOW_DAYS));
  const calendar = S.daysBackward(now, window, tz);
  const today = calendar[calendar.length - 1];
  const perDay = new Map(calendar.map((d) => [d, 0]));
  const costs = [];
  for (const o of done ?? []) {
    const d = o?.done ? TK.dayFor(o.done, tz) : null;
    if (!d || !perDay.has(d)) continue;
    perDay.set(d, perDay.get(d) + 1);
    const usd = Number(o.usd);
    if (o.usd != null && Number.isFinite(usd) && usd > 0) costs.push(usd);
  }
  const throughput = [...perDay.values()];
  const sample = throughput.reduce((a, b) => a + b, 0);
  const left = Math.max(0, Math.floor(Number(remaining) || 0));
  const medianCost = costs.length ? round2(S.median(costs)) : null;
  const base = {
    remaining: left,
    windowDays: window,
    sample,
    runs: 0,
    throughput,
    p50: null,
    p85: null,
    p95: null,
    medianCost,
    costCount: costs.length,
    expectedCost: medianCost == null ? null : round2(left * medianCost),
    today,
  };
  if (sample < MIN_DONE)
    return {
      ...base,
      enough: false,
      reason: `not enough data (${sample} done in the last ${window} days, needs at least ${MIN_DONE})`,
    };
  const at = (n) => ({ days: n, date: addDays(today, n) });
  if (left === 0) return { ...base, enough: true, reason: null, p50: at(0), p85: at(0), p95: at(0) };
  const n = Math.max(1, Math.floor(Number(runs) || RUNS));
  const results = [];
  for (let r = 0; r < n; r++) {
    let count = 0;
    let day = 0;
    while (count < left && day < MAX_DAYS) {
      day += 1;
      count += throughput[Math.min(throughput.length - 1, Math.floor(rng() * throughput.length))];
    }
    results.push(day);
  }
  const out = { ...base, enough: true, reason: null, runs: n };
  for (const p of LEVELS) out[`p${p}`] = at(S.percentile(results, p));
  return out;
}

/**
 * The remaining tasks: open tasks in the current focus stages (also the dependencies they pull along) when a focus
 * applies, otherwise waiting, running, picked and review. Proposals, cancelled, done and entries outside the queue never
 * count. `project` narrows to one project (queueLogic.projectFor).
 * @returns {{ tasks: object[], focus: { name: string|null, stages: string[] } | null }}
 */
function remainingTasks(queue, { project = null, now = Date.now() } = {}) {
  const register = queue?.projects ?? {};
  const k = L.rankingContext(queue ?? {}, now);
  const inProject = (o) => !project || L.projectFor(o, register) === project;
  const all = (queue?.tasks ?? []).filter((o) => !L.isExternalRow(o) && inProject(o));
  if (k.applies) {
    const tasks = all.filter((o) => !CLOSED.includes(o.status) && L.focusSpace(o, k).step != null);
    const order = queue.focus.order ?? [];
    return {
      tasks,
      focus: { name: queue.focus.name ?? null, stages: order.map((t) => L.stepTitle(t, queue)) },
    };
  }
  return { tasks: all.filter((o) => OPEN.includes(o.status)), focus: null };
}

/**
 * The forecast for the queue: remainingTasks + the done tasks in queue.json (doneInWindow's rules: status done, a done
 * time, not an entry outside the queue). The throughput is the whole queue's (also with --project): the queue works on
 * one thing at a time, so the pace of the whole queue is the honest one.
 */
function queueForecast(queue, { project = null, days = WINDOW_DAYS, runs = RUNS, rng, now = Date.now(), tz = TK.TZ } = {}) {
  const r = remainingTasks(queue, { project, now });
  const done = (queue?.tasks ?? [])
    .filter((o) => o.status === 'done' && !L.isExternalRow(o) && o.done)
    .map((o) => ({ done: o.done, usd: o.cost?.usd ?? null }));
  return {
    ...forecast({ done, remaining: r.tasks.length, days, runs, rng, now, tz }),
    project: project ?? null,
    focus: r.focus,
    ids: r.tasks.map((o) => o.id),
  };
}

/** "Tue 4 Nov" for the date YYYY-MM-DD. */
function dayText(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const dm = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${wd} ${dm}`;
}

/**
 * The short paragraph (the CLI and the board): "Focus "X": 14 tasks left. 50 %: by Tue 4 Nov (4 days), 85 %: Thu 6 Nov,
 * 95 %: Fri 7 Nov. Based on 31 done in the last 28 days. Expected cost about 42 USD."
 */
function forecastText(f) {
  const scope = f.focus
    ? `Focus${f.focus.name ? ` "${f.focus.name}"` : ` (${f.focus.stages.join(', ')})`}`
    : 'The queue';
  const what = `${scope}${f.project ? `, project ${f.project}` : ''}`;
  const left = `${f.remaining} task${f.remaining === 1 ? '' : 's'} left`;
  if (!f.enough) return `${what}: ${left}. No forecast: ${f.reason}.`;
  if (f.remaining === 0) return `${what}: nothing left.`;
  const plural = (n) => `${n} day${n === 1 ? '' : 's'}`;
  const cost =
    f.expectedCost == null
      ? ' No measured cost yet.'
      : ` Expected cost about ${Math.round(f.expectedCost)} USD.`;
  return (
    `${what}: ${left}. 50 %: by ${dayText(f.p50.date)} (${plural(f.p50.days)}), 85 %: ${dayText(f.p85.date)}, ` +
    `95 %: ${dayText(f.p95.date)}. Based on ${f.sample} done in the last ${f.windowDays} days.${cost}`
  );
}

/** The seed the board uses, so the same queue always gives the same numbers (and the state's version stays stable). */
const BOARD_SEED = 28;

/** The forecast for the board (the Focus view and Statistics): the numbers and the paragraph, without the long lists. */
function boardForecast(queue, { now = Date.now(), tz = TK.TZ } = {}) {
  const f = queueForecast(queue, { rng: seededRandom(BOARD_SEED), now, tz });
  const { throughput, ids, ...rest } = f;
  return { ...rest, text: forecastText(f) };
}

module.exports = {
  BOARD_SEED,
  boardForecast,
  WINDOW_DAYS,
  RUNS,
  MIN_DONE,
  LEVELS,
  seededRandom,
  addDays,
  forecast,
  remainingTasks,
  queueForecast,
  dayText,
  forecastText,
};
