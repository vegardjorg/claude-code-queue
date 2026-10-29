// =============================================================
// contextMeasure.js: pure computation for context-measure.mjs.
//
// Why: about 70 % of the track cost is cache reading, and that is roughly turns x context. To see whether measures such
// as a leaner shared protocol work, a fixed metric is needed: median and p90 context, calls before first change and turns,
// per agent type and risk class, over a time window.
//
// Input is the rows from the time log (config().timeLog; hook-time writes one CUMULATIVE "done" row per stop, so only
// the LAST one per agent counts) and an optional class lookup function (from the queue). No I/O here; the test lives in
// __tests__/contextMeasure.test.ts.
// =============================================================

/**
 * Quantile with linear interpolation (q = 0.5 gives median, 0.9 gives p90). Empty list gives null.
 * @param {number[]} counts
 * @param {number} q
 */
function quantile(counts, q) {
  const s = counts.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  return s[low] + (s[high] - s[low]) * (pos - low);
}

/**
 * Last "done" row per agent_id with time in [from, to). Rows without agent_id or without a context measurement are skipped
 * (older manual rows and agents where the hook could not read the transcript).
 * @param {object[]} rows
 * @param {{ from?: number|null, to?: number|null }} [window] milliseconds (Date.parse)
 */
function lastDonePerAgent(rows, { from = null, to = null } = {}) {
  const last = new Map();
  for (const r of rows) {
    if (!r || r.event !== 'done' || !r.agent_id) continue;
    const t = Date.parse(r.time);
    if (!Number.isFinite(t)) continue;
    if (from != null && t < from) continue;
    if (to != null && t >= to) continue;
    const f = last.get(r.agent_id);
    if (!f || Date.parse(f.time) <= t) last.set(r.agent_id, r);
  }
  return [...last.values()].filter((r) => r.context && typeof r.context.median === 'number');
}

const round = (x, n = 0) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);

/**
 * The key figures for one group of agents.
 * @param {object[]} list done rows
 */
function keyFigures(list) {
  const context = list.map((r) => r.context.median);
  const start = list.map((r) => r.context.start);
  const end = list.map((r) => r.context.end);
  const call = list.map((r) => r.call_for_first_change).filter((x) => typeof x === 'number');
  const turns = list.map((r) => Number(r.modelTurns)).filter((x) => Number.isFinite(x));
  const cost = list.map((r) => Number(r.cost_usd)).filter((x) => Number.isFinite(x));
  const sum = cost.reduce((a, b) => a + b, 0);
  return {
    count: list.length,
    context_median: round(quantile(context, 0.5)),
    context_p90: round(quantile(context, 0.9)),
    context_start_median: round(quantile(start, 0.5)),
    context_end_median: round(quantile(end, 0.5)),
    call_for_first_change_median: round(quantile(call, 0.5), 1),
    call_for_first_change_count: call.length,
    turns_median: round(quantile(turns, 0.5), 1),
    cost_sum: round(sum, 2),
    cost_average: cost.length ? round(sum / cost.length, 2) : null,
  };
}

/**
 * The whole measurement: per agent type and class, sorted by cost sum (most expensive first), plus the total.
 * @param {object[]} rows
 * @param {{ from?: number|null, to?: number|null, classFor?: (row: any) => string|null }} [option]
 */
function measureContext(rows, { from = null, to = null, classFor = () => null } = {}) {
  const done = lastDonePerAgent(rows, { from, to });
  const groups = new Map();
  for (const r of done) {
    const type = r.agent_type || '(no type)';
    const cls = classFor(r) ?? 'unknown';
    const k = `${type}|${cls}`;
    if (!groups.has(k)) groups.set(k, { agenttype: type, class: cls, rows: [] });
    groups.get(k).rows.push(r);
  }
  const out = [...groups.values()]
    .map((g) => ({ agenttype: g.agenttype, class: g.class, ...keyFigures(g.rows) }))
    .sort((a, b) => b.cost_sum - a.cost_sum || a.agenttype.localeCompare(b.agenttype));
  return {
    from: from != null ? new Date(from).toISOString() : null,
    to: to != null ? new Date(to).toISOString() : null,
    total: keyFigures(done),
    groups: out,
  };
}

/**
 * Class lookup from the queue: task id (also fix rounds such as "X-r2") and the agent ids in the task's cost measurement
 * (the reviewers are logged with the agent id as track label).
 * @param {{ tasks?: object[] }} queue
 * @returns {(row: object) => string|null}
 */
function classLookup(queue) {
  const perId = new Map();
  const perAgent = new Map();
  for (const o of queue?.tasks ?? []) {
    if (!o?.id || !o.class) continue;
    perId.set(o.id, o.class);
    if (typeof o.agent === 'string' && o.agent) perAgent.set(o.agent, o.class);
    for (const a of o.cost?.agents ?? []) if (a?.agent) perAgent.set(a.agent, o.class);
  }
  return (row) => {
    if (row?.agent_id && perAgent.has(row.agent_id)) return perAgent.get(row.agent_id);
    const track = String(row?.track ?? '');
    if (perId.has(track)) return perId.get(track);
    const without = track.replace(/-(?:r|round)\d+$/i, '');
    return perId.get(without) ?? null;
  };
}

/** Text table for the terminal. */
function formatTable(m) {
  const k = (x) => (x == null ? '-' : `${Math.round(x / 1000)}k`);
  const v = (x) => (x == null ? '-' : String(x));
  const lines = [
    `Context measurement ${m.from ?? '(start)'} → ${m.to ?? '(now)'} (last done row per agent)`,
    'agenttype       class  count  start  context-median  p90    end-median  call-before-change  turns  cost-sum  cost-average',
  ];
  const row = (name, cls, g) =>
    [
      name.padEnd(15),
      cls.padEnd(7),
      String(g.count).padStart(6),
      k(g.context_start_median).padStart(6),
      k(g.context_median).padStart(16),
      k(g.context_p90).padStart(6),
      k(g.context_end_median).padStart(13),
      `${v(g.call_for_first_change_median)} (n=${g.call_for_first_change_count})`.padStart(17),
      v(g.turns_median).padStart(6),
      `$${v(g.cost_sum)}`.padStart(9),
      `$${v(g.cost_average)}`.padStart(11),
    ].join(' ');
  for (const g of m.groups) lines.push(row(g.agenttype, g.class, g));
  lines.push(row('ALL', '', m.total));
  return lines.join('\n');
}

module.exports = {
  quantile,
  lastDonePerAgent,
  keyFigures,
  measureContext,
  classLookup,
  formatTable,
};
