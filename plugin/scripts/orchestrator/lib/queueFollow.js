// =============================================================
// queueFollow.js: the "Follow up" entries in the work queue.
//
// A follow-up entry is an observation with a start and an end, what we measure, a log and a fixed report template, so
// internal tests, trial periods after an owner decision and variables we follow over time do not "float" in the memory
// or in the handover note. The entries live in <dataFolder>/follow.json (gitignored, next to queue.json) and are written
// by `queue.mjs follow` under the same lock as the queue. Only the pure rules live here (no file, no clock):
//   - the data model and the validation (add), the due date (effectiveStatus), log, extend, close and markReported;
//   - the report from the template (reportText), and the lines for queue.mjs show, orchestrator pulse and follow
//     (shortLines and friends).
//
// The statuses: active -> to-report (the end date is reached; computed, and stored at the next write) -> reported
// (`queue.mjs follow report` has written the report) -> closed with an owner decision (the field `decision`), or
// cancelled. All mutating functions are all or nothing: an error gives { error: [...] } and the register is unchanged.
//
// The day follows the local calendar of the machine (Intl...resolvedOptions().timeZone, as NIGHT_TZ in queueLogic.js),
// not UTC.
// =============================================================
'use strict';

const STATUSES = ['active', 'to-report', 'reported', 'cancelled'];
// The fixed structure of the report.
const REPORT_TEMPLATE = [
  'Question',
  'Setup',
  'Measurements',
  'Findings',
  'Deviations and losses',
  'Recommendation',
  'Owner decision',
];
const ID = /^F-[A-Z0-9][A-Z0-9_-]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The machine's time zone (TZ overrides it, as everywhere in cq).
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const emptyRegister = () => ({ version: 1, entries: [], changed: null });

/** The register from the file, or an empty one when the file is missing or broken. */
function normalize(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.entries)) return emptyRegister();
  return { version: 1, changed: r.changed ?? null, entries: r.entries };
}

/** Is the text a real calendar date (YYYY-MM-DD)? 2026-13-01 and 2026-02-30 are refused. */
function validDate(s) {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today's date (YYYY-MM-DD) in the local time zone; the due date follows the local calendar, not UTC. */
function dayDate(now, tz = LOCAL_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const text = (x) => (typeof x === 'string' ? x.trim() : '');
const textList = (x) => Array.isArray(x) && x.every((v) => typeof v === 'string' && v.trim());

/** The status as it applies today: an active entry is to-report from the end date on. */
function effectiveStatus(p, today) {
  if (p.status === 'active' && today >= p.end) return 'to-report';
  return p.status;
}

/** The errors in a (normalized) entry; empty list = valid. */
function validate(p, others) {
  const error = [];
  if (!ID.test(p.id ?? ''))
    error.push(
      `id "${p.id ?? ''}" must start with F- and have capital letters, digits, "-" or "_" (at most 42 chars)`,
    );
  else if (others.some((x) => x.id === p.id)) error.push(`id ${p.id} already exists`);
  for (const field of ['title', 'why', 'owner'])
    if (!text(p[field])) error.push(`${field} is missing`);
  const okStart = validDate(p.start);
  const okEnd = validDate(p.end);
  if (!okStart) error.push(`start "${p.start ?? ''}" must be a date (YYYY-MM-DD)`);
  if (!okEnd) error.push(`end "${p.end ?? ''}" must be a date (YYYY-MM-DD)`);
  if (okStart && okEnd && p.end <= p.start)
    error.push(`end (${p.end}) must be after start (${p.start})`);
  if (!STATUSES.includes(p.status))
    error.push(`status "${p.status}" must be one of ${STATUSES.join(', ')}`);
  if (!Array.isArray(p.goals) || p.goals.length === 0)
    error.push('goals must have at least one goal ({ name, how, expected })');
  else {
    const seen = new Set();
    p.goals.forEach((m, i) => {
      if (!m || typeof m !== 'object') return error.push(`goals[${i}] must be an object`);
      for (const f of ['name', 'how', 'expected'])
        if (!text(m[f])) error.push(`goals[${i}].${f} is missing`);
      if (text(m.name) && /[=\s]/.test(m.name))
        error.push(`goals[${i}].name "${m.name}" cannot have spaces or "="`);
      if (seen.has(m.name)) error.push(`the goal name ${m.name} appears twice`);
      seen.add(m.name);
    });
  }
  if (!Array.isArray(p.log)) error.push('log must be a list');
  else {
    // A log that comes with add (moved from the memory) must have the same form as `queue.mjs follow log` writes.
    const names = new Set(Array.isArray(p.goals) ? p.goals.map((m) => m?.name) : []);
    p.log.forEach((l, i) => {
      if (!l || typeof l !== 'object' || !text(l.at) || !text(l.source))
        return error.push(`log[${i}] must have at and source`);
      if (!text(l.text) && !l.values) error.push(`log[${i}] must have text or values`);
      for (const n of Object.keys(l.values ?? {}))
        if (!names.has(n)) error.push(`log[${i}] has unknown goal ${n}`);
    });
  }
  if (!textList(p.report_template) || p.report_template.join('|') !== REPORT_TEMPLATE.join('|'))
    error.push(`report_template is fixed: ${REPORT_TEMPLATE.join(', ')}`);
  if (p.related !== undefined) {
    const r = p.related;
    const ok =
      r &&
      typeof r === 'object' &&
      !Array.isArray(r) &&
      Object.keys(r).every((k) => ['tasks', 'memory'].includes(k)) &&
      (r.tasks === undefined || textList(r.tasks)) &&
      (r.memory === undefined || textList(r.memory));
    if (!ok) error.push('related must be { tasks?: [id, ...], memory?: [name, ...] }');
  }
  if (p.close_action !== undefined && !textList(p.close_action))
    error.push('close_action must be a text or a list of texts');
  return error;
}

/** Adds a new entry (from follow add). Default: status active, empty log, the fixed report template. */
function add(reg, input, { now }) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { error: ['the entry must be one JSON object'] };
  const p = {
    ...input,
    status: input.status ?? 'active',
    log: input.log ?? [],
    report_template: input.report_template ?? [...REPORT_TEMPLATE],
    created: input.created ?? now,
  };
  if (typeof p.close_action === 'string') p.close_action = [p.close_action];
  const error = validate(p, reg.entries);
  if (error.length) return { error };
  reg.entries.push(p);
  return { error: [], entry: p };
}

function find(reg, id) {
  const p = reg.entries.find((x) => x.id === id);
  return p ? { p } : { error: [`Unknown follow-up entry ${id} (cq follow lists them)`] };
}
const isClosed = (p) => p.decision != null || p.status === 'cancelled';

/** Stores to-report on active entries that have reached the end date (called at every write). */
function updateDue(reg, today) {
  for (const p of reg.entries) p.status = effectiveStatus(p, today);
}

/** One log entry: text and/or goal values (the names must exist in goals). */
function log(reg, id, input, { now }) {
  const f = find(reg, id);
  if (f.error) return { error: f.error };
  const { p } = f;
  if (isClosed(p)) return { error: [`${id} is closed; the log is closed`] };
  const t = text(input.text);
  const values = input.values ?? {};
  const names = Object.keys(values);
  if (!t && !names.length) return { error: ['Write --text "..." and/or --value name=value'] };
  const known = p.goals.map((m) => m.name);
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length)
    return {
      error: [`Unknown goal ${unknown.join(', ')} in ${id}; the goals are ${known.join(', ')}`],
    };
  const row = { at: now, source: text(input.source) || 'queue.mjs' };
  if (t) row.text = t;
  if (names.length) row.values = Object.fromEntries(names.map((n) => [n, String(values[n])]));
  p.log.push(row);
  return { error: [], entry: p };
}

/** Moves the end date forward; an entry to report becomes active again. */
function extend(reg, id, to, { now }) {
  const f = find(reg, id);
  if (f.error) return { error: f.error };
  const { p } = f;
  if (isClosed(p) || p.status === 'reported')
    return { error: [`${id} is ${p.status}; only active entries and entries to report are extended`] };
  if (!validDate(to)) return { error: [`--to "${to ?? ''}" must be a date (YYYY-MM-DD)`] };
  if (to <= p.end) return { error: [`--to (${to}) must be after the current end (${p.end})`] };
  const from = p.end;
  p.end = to;
  p.status = 'active';
  p.log.push({ at: now, source: 'queue.mjs follow extend', text: `Extended ${from} -> ${to}` });
  return { error: [], entry: p };
}

/** The report is written (follow report): status reported, with path and time. */
function markReported(reg, id, reportPath, { now }) {
  const f = find(reg, id);
  if (f.error) return { error: f.error };
  const { p } = f;
  if (!isClosed(p)) p.status = 'reported';
  p.report = reportPath;
  p.reported = now;
  return { error: [], entry: p };
}

/** The owner decision (follow close): closes the entry; --cancelled gives status cancelled. */
function close(reg, id, input, { now }) {
  const f = find(reg, id);
  if (f.error) return { error: f.error };
  const { p } = f;
  const v = text(input.decision);
  if (!v) return { error: ['Write the owner decision: --decision "..."'] };
  if (isClosed(p)) return { error: [`${id} is already closed (decision: ${p.decision ?? '-'})`] };
  p.decision = v;
  p.closed = now;
  if (input.cancelled) p.status = 'cancelled';
  else if (p.status !== 'reported') p.status = 'reported';
  p.log.push({ at: now, source: 'queue.mjs follow close', text: `Decision: ${v}` });
  return { error: [], entry: p };
}

// ---- The report --------------------------------------------------------------------------------------------------
const PLACEHOLDER = '(assessed by the orchestrator)';

/** The report as markdown, with the fixed headings of the template; setup, measurements and log are filled in. */
function reportText(p, { now }) {
  const out = [`# ${p.id}: ${p.title}`, ''];
  out.push(
    `Generated ${now} by cq follow report. Status: ${p.status}. The sections marked ${PLACEHOLDER} are written by the orchestrator.`,
  );
  const section = (name, lines) => out.push('', `## ${name}`, '', ...lines);
  section('Question', [p.why]);
  const setup = [
    `- Period: ${p.start} to ${p.end}`,
    `- Owner: ${p.owner}`,
    '- Goals:',
    ...p.goals.map((m) => `  - ${m.name}: ${m.how} (expected: ${m.expected})`),
  ];
  if (p.related?.tasks?.length) setup.push(`- Related tasks: ${p.related.tasks.join(', ')}`);
  if (p.related?.memory?.length) setup.push(`- Memory: ${p.related.memory.join(', ')}`);
  if (p.close_action?.length)
    setup.push(
      '- Close action (only when the decision calls for it):',
      ...p.close_action.map((h) => `  - ${h}`),
    );
  section('Setup', setup);
  const measurements = [];
  for (const m of p.goals) {
    const rows = p.log.filter((l) => l.values && m.name in l.values);
    const last = rows.at(-1);
    measurements.push(
      `- ${m.name} (expected ${m.expected}): ${rows.length} measurement(s)${last ? `, last: ${last.values[m.name]}` : ''}`,
      ...rows.map((l) => `  - ${l.at} (${l.source}): ${l.values[m.name]}`),
    );
  }
  section('Measurements', measurements);
  const notes = p.log.filter((l) => l.text);
  section('Findings', [
    ...(notes.length
      ? notes.map((l) => `- ${l.at} (${l.source}): ${l.text}`)
      : ['- (no text in the log)']),
    '',
    PLACEHOLDER,
  ]);
  section('Deviations and losses', [PLACEHOLDER]);
  section('Recommendation', [PLACEHOLDER]);
  section('Owner decision', [p.decision ?? `(not decided; cq follow close ${p.id} --decision "...")`]);
  return `${out.join('\n')}\n`;
}

// ---- Views -------------------------------------------------------------------------------------------------------
/** The lines for queue.mjs show and orchestrator pulse: one line with the active ones, plus TO REPORT and pending decisions. */
function shortLines(reg, today, { pulse = false } = {}) {
  const open = reg.entries.filter((p) => !isClosed(p));
  const active = open.filter((p) => effectiveStatus(p, today) === 'active');
  const due = open.filter((p) => effectiveStatus(p, today) === 'to-report');
  const decision = open.filter((p) => p.status === 'reported');
  const out = [];
  if (active.length || due.length) {
    const parts = active.map((p) => `${p.id} until ${p.end}`);
    out.push(
      `FOLLOW UP: ${active.length} active${parts.length ? ` (${parts.join(', ')})` : ''}` +
        (due.length ? `; ${due.length} TO REPORT` : '') +
        ' · cq follow',
    );
  }
  if (due.length)
    out.push(
      `TO REPORT: ${due.map((p) => `${p.id} (end ${p.end})`).join(', ')}. ` +
        `Run cq follow report ${due[0].id}` +
        (pulse
          ? ', assess it and present it to the owner (repeated at every pulse until the report is written).'
          : '.'),
    );
  if (decision.length)
    out.push(
      `FOLLOW UP waiting on an owner decision: ${decision.map((p) => p.id).join(', ')} (cq follow close <id> --decision "...").`,
    );
  return out;
}

const RANK = { 'to-report': 0, active: 1, reported: 2, cancelled: 3 };

/** The list for queue.mjs follow: one line per entry, the open ones first. */
function listLines(reg, today) {
  if (!reg.entries.length) return ['No follow-up entries. Add one: cq follow add --file <json>.'];
  const status = (p) =>
    p.decision != null && p.status === 'reported' ? 'closed' : effectiveStatus(p, today);
  const sorted = [...reg.entries].sort(
    (x, y) => (RANK[status(x)] ?? 4) - (RANK[status(y)] ?? 4) || x.end.localeCompare(y.end),
  );
  return sorted.map(
    (p) =>
      `${p.id.padEnd(22)} ${status(p).padEnd(11)} ${p.start} -> ${p.end}  ${p.log.length} log  ${p.title}`,
  );
}

/** The whole entry for queue.mjs follow show. */
function showLines(p, today) {
  const out = [
    `${p.id}: ${p.title}`,
    `Status: ${effectiveStatus(p, today)}${p.decision ? ` (decision: ${p.decision})` : ''} · ${p.start} -> ${p.end} · owner ${p.owner}`,
    `Why: ${p.why}`,
    'Goals:',
    ...p.goals.map((m) => `  ${m.name}: ${m.how} (expected: ${m.expected})`),
  ];
  if (p.related)
    out.push(
      `Related: ${[...(p.related.tasks ?? []), ...(p.related.memory ?? []).map((m) => `memory ${m}`)].join(', ')}`,
    );
  if (p.close_action?.length) out.push(`Close action: ${p.close_action.join(' + ')}`);
  if (p.report) out.push(`Report: ${p.report} (${p.reported})`);
  out.push(`Log (${p.log.length}):`);
  for (const l of p.log) {
    const v = l.values
      ? ` [${Object.entries(l.values)
          .map(([k, x]) => `${k}=${x}`)
          .join(', ')}]`
      : '';
    out.push(`  ${l.at} ${l.source}: ${l.text ?? ''}${v}`);
  }
  return out;
}

/** The data for the board's read view /follow: the entries with today's status, the open ones first, and the short lines. */
function boardData(reg, today) {
  const entries = reg.entries
    .map((p) => ({ ...p, status: effectiveStatus(p, today), decided: p.decision != null }))
    .sort(
      (x, y) =>
        Number(x.decided) - Number(y.decided) ||
        (RANK[x.status] ?? 4) - (RANK[y.status] ?? 4) ||
        String(x.end).localeCompare(String(y.end)),
    );
  return { today, lines: shortLines(reg, today), entries };
}

module.exports = {
  STATUSES,
  REPORT_TEMPLATE,
  LOCAL_TZ,
  emptyRegister,
  normalize,
  validDate,
  dayDate,
  effectiveStatus,
  updateDue,
  add,
  log,
  extend,
  markReported,
  close,
  reportText,
  shortLines,
  listLines,
  showLines,
  boardData,
};
