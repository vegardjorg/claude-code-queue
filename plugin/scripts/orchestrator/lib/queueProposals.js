// =============================================================
// queueProposals.js: auto-accept of agent proposals by the owner's rules (Linear's triage auto-apply style). Default OFF.
//
// An agent (track, reviewer, investigation agent) adds tasks as `proposed` (queueLogic.statusAtAdd); normally the
// orchestrator or the owner approves them (`queue.mjs approve`). With the rules on, a proposal that fits them is approved
// by the queue itself through the SAME approve path (queueLogic.approve: proposed -> waiting, the field `approved`), gets a
// remark, and lands in the log `auto_accepted` in queue.json, so the owner can see it and undo it.
//
// The rules: config().proposals.autoAccept (queueConfig.js STANDARD) with queue.json `proposals.autoAccept` on top (the
// queue wins field by field; `queue.mjs proposals auto` and the board's gear write it):
//   { enabled: false, classes: ["K"], maxEstimateMin: 60, maxValue: null }
//   classes = the classes that may be accepted (only K and U can be listed), maxEstimateMin = at most this estimate
//   (queueLogic.estimate: content_min x class weight; null = no cap), maxValue = at most this value (null = no cap).
// The HARD rules no setting can override (autoAcceptDecision checks them first):
//   - never class D or D+ (database and security work always gets a human look),
//   - never a task with `waiting_on` (it waits on an owner question),
//   - never a task with a legal or owner label (LEGAL_LABELS), or linked to a plan entry with open legal points,
//   - never a task that owns a protected path (config().protectedPaths, the merge guard's list): owning one is what lets
//     a track change hooks, settings or the orchestrator scripts without the merge guard stopping it,
//   - never a task whose auto-accept the owner has undone before.
// Applied by `queue.mjs add` (the new proposals) and `queue.mjs orchestrator pulse` (older ones). Pure functions without I/O;
// tested in lib/__tests__/queueProposals.test.ts.
// =============================================================

const L = require('./queueLogic.js');
const G = require('./mergeGuard.js');

/** The default rules (the same as config().proposals.autoAccept in queueConfig.js STANDARD). */
const DEFAULT_RULES = Object.freeze({ enabled: false, classes: ['K'], maxEstimateMin: 60, maxValue: null });
/** The classes a rule may list. D and D+ are never auto-accepted (a hard rule). */
const ALLOWED_CLASSES = ['K', 'U'];
/** Labels that always need the owner (also anything starting with "legal" or "owner"). */
const LEGAL_LABELS = ['legal', 'lawyer', 'owner', 'owner-task', 'owner-decision', 'privacy', 'dpia'];
/** The log keeps the last this many entries. */
const LOG_CAP = 200;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The rules in force: the config's default with the queue's own on top (field by field). */
function rulesFor(configRules, queue) {
  const own = isObject(queue?.proposals?.autoAccept) ? queue.proposals.autoAccept : {};
  const base = isObject(configRules) ? configRules : {};
  const r = { ...DEFAULT_RULES, ...base, ...own };
  return {
    enabled: r.enabled === true,
    classes: Array.isArray(r.classes) ? r.classes.filter((k) => ALLOWED_CLASSES.includes(k)) : [],
    maxEstimateMin: r.maxEstimateMin == null ? null : Number(r.maxEstimateMin),
    maxValue: r.maxValue == null ? null : Number(r.maxValue),
  };
}

/**
 * Validates a change to the rules (from the CLI or the board). Returns the errors (empty = valid); only the fields
 * present are checked.
 */
function rulesError(change) {
  const error = [];
  if (!isObject(change)) return ['the rules must be an object'];
  for (const k of Object.keys(change))
    if (!['enabled', 'classes', 'maxEstimateMin', 'maxValue'].includes(k)) error.push(`unknown field ${k}`);
  if ('enabled' in change && typeof change.enabled !== 'boolean') error.push('enabled must be true or false');
  if ('classes' in change) {
    if (!Array.isArray(change.classes)) error.push('classes must be a list');
    else
      for (const k of change.classes)
        if (!ALLOWED_CLASSES.includes(k))
          error.push(
            k === 'D' || k === 'D+'
              ? `class ${k} is never auto-accepted (a hard rule)`
              : `unknown class ${k} (allowed: ${ALLOWED_CLASSES.join(', ')})`,
          );
  }
  for (const [k, max] of [
    ['maxEstimateMin', 100_000],
    ['maxValue', 10],
  ])
    if (k in change && change[k] !== null) {
      const n = change[k];
      if (!Number.isInteger(n) || n < 1 || n > max) error.push(`${k} must be a whole number 1-${max} or null`);
    }
  return error;
}

/** Does one owned path cover (or equal) a protected path? A folder owner covers protected paths under it. */
function ownsProtected(task, protectedPaths) {
  const norm = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const list = (protectedPaths ?? []).map(norm).filter(Boolean);
  for (const raw of [...(task?.owned_files ?? []), ...(task?.shared_patch ?? [])]) {
    const p = norm(raw);
    if (!p) continue;
    if (G.isProtected(p, list)) return p;
    // A folder owned as a whole ("plugin/") covers the protected folders and files inside it ("plugin/hooks/").
    if (p.endsWith('/') && list.some((b) => b.includes('/') && b.startsWith(p))) return p;
  }
  return null;
}

/**
 * Should the queue accept this proposal by itself?
 * @param {object} task
 * @param {{ enabled, classes, maxEstimateMin, maxValue }} rules rulesFor(...)
 * @param {{ protectedPaths?: string[], openLegalPlans?: Set<string>, undone?: Set<string> }} [ctx]
 * @returns {{ accept: boolean, reason: string }}
 */
function autoAcceptDecision(task, rules, ctx = {}) {
  const no = (reason) => ({ accept: false, reason });
  if (!task || task.status !== 'proposed') return no(`not proposed (status ${task?.status ?? '?'})`);
  // ---- The hard rules: no setting overrides them ----
  if (task.class === 'D' || task.class === 'D+') return no(`class ${task.class} is never auto-accepted`);
  if ((task.waiting_on ?? []).length) return no(`waits on ${task.waiting_on.join(', ')}`);
  const legal = (task.labels ?? []).find((l) => {
    const s = String(l).toLowerCase();
    return LEGAL_LABELS.includes(s) || s.startsWith('legal') || s.startsWith('owner');
  });
  if (legal) return no(`has the label ${legal}`);
  if (task.plan && ctx.openLegalPlans?.has(task.plan))
    return no(`the plan entry ${task.plan} has open legal points`);
  const prot = ownsProtected(task, ctx.protectedPaths ?? []);
  if (prot) return no(`owns the protected path ${prot}`);
  if (ctx.undone?.has(task.id)) return no('the owner undid an earlier auto-accept');
  // ---- The owner's rules ----
  const r = rules ?? DEFAULT_RULES;
  if (!r.enabled) return no('auto-accept is off');
  if (!(r.classes ?? []).includes(task.class))
    return no(`class ${task.class ?? '?'} is not in the rules (${(r.classes ?? []).join(', ') || 'none'})`);
  const estimate = L.estimate(task);
  if (r.maxEstimateMin != null && estimate > r.maxEstimateMin)
    return no(`estimate ${estimate} min is over ${r.maxEstimateMin}`);
  const value = Number(task.value ?? 5);
  if (r.maxValue != null && value > r.maxValue) return no(`value ${value} is over ${r.maxValue}`);
  return {
    accept: true,
    reason:
      `class ${task.class}, estimate ${estimate} min` +
      `${r.maxEstimateMin != null ? ` <= ${r.maxEstimateMin}` : ''}` +
      `${r.maxValue != null ? `, value ${value} <= ${r.maxValue}` : ''}`,
  };
}

/** The plan entries with at least one open legal point (queuePlan.LEGAL_OPEN), from the plan register. */
function openLegalPlans(reg) {
  const open = ['open', 'ai-assessed', 'to-lawyer'];
  const out = new Set();
  for (const p of reg?.entries ?? []) {
    const points = Array.isArray(p?.legal?.points) ? p.legal.points : [];
    if (points.some((x) => isObject(x) && open.includes(x.status ?? 'open'))) out.add(p.id);
  }
  return out;
}

/** The ids whose auto-accept was undone (never accepted again by itself). */
function undoneIds(queue) {
  return new Set((queue?.auto_accepted ?? []).filter((x) => x?.undone).map((x) => x.id));
}

/**
 * Applies the rules to the proposals in the queue (all of them, or only `ids`). Mutates `queue` (the caller writes under
 * the lock): approves through queueLogic.approve, adds a remark and a log entry per accepted task.
 * @returns {{ id: string, reason: string }[]} the accepted ones
 */
function applyAutoAccept(queue, rules, ctx = {}, { ids = null, now = new Date().toISOString() } = {}) {
  if (!rules?.enabled) return [];
  const undone = undoneIds(queue);
  const accepted = [];
  for (const o of queue?.tasks ?? []) {
    if (o.status !== 'proposed' || (ids && !ids.includes(o.id))) continue;
    const d = autoAcceptDecision(o, rules, { ...ctx, undone });
    if (!d.accept) continue;
    const r = L.approve(queue, [o.id], now);
    if (r.error.length) continue;
    o.remarks = [...(o.remarks ?? []), `${now} auto-accepted by the owner's rules: ${d.reason}`];
    accepted.push({ id: o.id, reason: d.reason });
  }
  if (accepted.length)
    queue.auto_accepted = [
      ...(queue.auto_accepted ?? []),
      ...accepted.map((x) => ({ id: x.id, at: now, reason: x.reason })),
    ].slice(-LOG_CAP);
  return accepted;
}

/**
 * Undoes an auto-accept: back to proposed, when the task has not been started (status waiting, never started or picked).
 * Mutates `queue`; returns the error text or null.
 */
function undoAutoAccept(queue, id, now = new Date().toISOString()) {
  const entry = [...(queue?.auto_accepted ?? [])].reverse().find((x) => x?.id === id);
  if (!entry) return `${id} was not auto-accepted (cq proposals log)`;
  if (entry.undone) return `${id}: the auto-accept was already undone`;
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return `unknown task ${id}`;
  if (o.status !== 'waiting' || o.started || o.picked_by)
    return `${id} has moved on (status ${o.status}${o.started ? ', started' : ''}); it can no longer go back to proposed`;
  o.status = 'proposed';
  delete o.approved;
  o.remarks = [...(o.remarks ?? []), `${now} auto-accept undone, back to proposed`];
  entry.undone = now;
  return null;
}

/** One line per log entry, newest first ("2026-10-31 10:00  A-1  class K, estimate 30 min <= 60  (undone ...)"). */
function logLines(queue, { max = 50 } = {}) {
  return [...(queue?.auto_accepted ?? [])]
    .reverse()
    .slice(0, max)
    .map(
      (x) =>
        `${String(x.at ?? '').slice(0, 16).replace('T', ' ')}  ${x.id}  ${x.reason ?? ''}` +
        `${x.undone ? `  (undone ${String(x.undone).slice(0, 16).replace('T', ' ')})` : ''}`,
    );
}

/** The rules as one line ("on: classes K, estimate <= 60 min, any value"). */
function rulesText(r) {
  return (
    `${r.enabled ? 'on' : 'off'}: classes ${r.classes.join(', ') || 'none'}, ` +
    `${r.maxEstimateMin != null ? `estimate <= ${r.maxEstimateMin} min` : 'any estimate'}, ` +
    `${r.maxValue != null ? `value <= ${r.maxValue}` : 'any value'}`
  );
}

/**
 * The board's "Auto-accept proposals" section: the rules and the log (newest first) with whether Undo is possible now
 * (the same test as undoAutoAccept: the last entry for the id, not undone, the task waiting and never started or picked).
 */
function boardData(configRules, queue, { max = 50 } = {}) {
  const tasks = new Map((queue?.tasks ?? []).map((o) => [o.id, o]));
  const log = queue?.auto_accepted ?? [];
  const lastFor = new Map(log.map((x, i) => [x?.id, i]));
  const rows = log
    .map((x, i) => {
      const o = tasks.get(x?.id);
      const canUndo =
        lastFor.get(x?.id) === i && !x.undone && !!o && o.status === 'waiting' && !o.started && !o.picked_by;
      return { id: x.id, at: x.at, reason: x.reason ?? '', undone: x.undone ?? null, title: o?.title ?? null, canUndo };
    })
    .reverse()
    .slice(0, max);
  return { rules: rulesFor(configRules, queue), allowedClasses: ALLOWED_CLASSES, log: rows };
}

/**
 * The board's save (POST /api/proposals) as `queue.mjs proposals auto ...` arguments. The body:
 * { enabled, classes, maxEstimateMin, maxValue } (all required, null = no cap). Validated here and again by queue.mjs.
 * @returns {{ args: string[] } | { error: string }}
 */
function boardArgs(b) {
  if (!isObject(b)) return { error: 'invalid body' };
  const change = {
    enabled: b.enabled,
    classes: b.classes,
    maxEstimateMin: b.maxEstimateMin ?? null,
    maxValue: b.maxValue ?? null,
  };
  const error = rulesError(change);
  if (error.length) return { error: error.join('; ') };
  return {
    args: [
      'proposals',
      'auto',
      change.enabled ? 'on' : 'off',
      '--classes',
      change.classes.length ? change.classes.join(',') : 'none',
      '--max-estimate',
      change.maxEstimateMin == null ? 'none' : String(change.maxEstimateMin),
      '--max-value',
      change.maxValue == null ? 'none' : String(change.maxValue),
    ],
  };
}

module.exports = {
  boardData,
  boardArgs,
  DEFAULT_RULES,
  ALLOWED_CLASSES,
  LEGAL_LABELS,
  LOG_CAP,
  rulesFor,
  rulesError,
  ownsProtected,
  autoAcceptDecision,
  openLegalPlans,
  undoneIds,
  applyAutoAccept,
  undoAutoAccept,
  logLines,
  rulesText,
};
