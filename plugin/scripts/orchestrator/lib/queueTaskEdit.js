// =============================================================
// queueTaskEdit.js: cancel, decline and edit ONE task from the board (and `queue.mjs cancel`).
//
// The rules live here as pure functions; queue.mjs applies them under the lock (`cancel`, `edit`) and the board server
// calls queue.mjs, so the lock, the atomic write, the changelog and "Undo" are the same as for the bulk actions.
//   - Cancel and decline: only a task that is waiting (also on hold or in the batch queue) or proposed. A running,
//     picked or review task is never cancelled from the board (an agent or a person may be working on it); the board
//     shows the CLI command instead (cliCancelHint). Declining a proposal is cancelling it with the reason as a remark.
//   - Edit: value (1-10), content minutes and class, only for waiting and proposed tasks. The result is checked with
//     queueLogic.validate, the same check `queue.mjs add` and `edit` run.
// =============================================================
'use strict';

const L = require('./queueLogic.js');

/** The statuses a task can be cancelled (or declined) from on the board and with `queue.mjs cancel`. */
const CANCEL_STATUSES = new Set(['waiting', 'proposed']);
/** The statuses the board's "Edit" form is shown for. */
const EDIT_STATUSES = new Set(['waiting', 'proposed']);
/** The fields the "Edit" form sets. */
const EDIT_FIELDS = ['value', 'content_min', 'class'];
/** The task classes (the same list queueLogic.validate checks). */
const CLASSES = Object.keys(L.WEIGHT);
/** The largest content estimate the form takes (minutes). A track is far smaller; this only stops typing errors. */
const CONTENT_MIN_MAX = 1000;
/** The longest reason the board sends as a remark. */
const REASON_MAX = 300;

/** Text from the board: control characters removed, trimmed and cut. */
const cleanReason = (x) =>
  String(x ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, REASON_MAX);

/** The remark a cancel writes: "cancelled: <reason>", "declined: <reason>", or just the word without a reason. */
function cancelRemark(reason, { declined = false } = {}) {
  const word = declined ? 'declined' : 'cancelled';
  const g = cleanReason(reason);
  return g ? `${word}: ${g}` : word;
}

/**
 * Why the task cannot be cancelled now (null when it can). Used by `queue.mjs cancel` under the lock and by the
 * board server before it calls queue.mjs.
 * @returns {string|null}
 */
function cancelError(o) {
  if (!o) return 'unknown task';
  if (L.isExternalRow(o)) return `${o.id} is a record outside the queue (cq external done "${o.external_name ?? o.id}")`;
  if (!CANCEL_STATUSES.has(o.status))
    return (
      `${o.id} is ${o.status}; only waiting and proposed tasks can be cancelled this way ` +
      `(an agent may be working on it: ${cliCancelCommand(o.id)})`
    );
  return null;
}

/**
 * Cancels the task in place: status cancelled (queueLogic.setStatus, as `queue.mjs set <id> cancelled`) and the remark
 * with a timestamp in the same form `set --remark` writes.
 * @returns {{ error: string|null }}
 */
function cancelTask(o, { remark = null, now = new Date().toISOString() } = {}) {
  const f = cancelError(o);
  if (f) return { error: f };
  const s = L.setStatus(o, 'cancelled', now);
  if (s.error) return { error: s.error };
  if (remark) o.remarks = [...(o.remarks ?? []), `${now} ${remark}`];
  return { error: null };
}

/** The CLI command that cancels a task the board will not cancel itself. */
const cliCancelCommand = (id) => `cq set ${id} cancelled --remark "<why>"`;

/**
 * The one-line hint the detail panel shows for a running, picked or review task, or null for other statuses.
 * @returns {string|null}
 */
function cliCancelHint(o) {
  if (!o || !['running', 'picked', 'review'].includes(o.status)) return null;
  return (
    'An agent or a person may be working on this task, so it is not cancelled from the board. ' +
    `To cancel it: ${cliCancelCommand(o.id)}`
  );
}

/**
 * Reads the "Edit" form ({ value, content_min, class }, strings or numbers) into the fields to change. Only fields
 * that are given are taken; an empty field is left as it is.
 * @returns {{ error: string[], field: object }}
 */
function editFields(form) {
  const error = [];
  const field = {};
  const f = form && typeof form === 'object' && !Array.isArray(form) ? form : {};
  const unknown = Object.keys(f).filter((k) => !EDIT_FIELDS.includes(k));
  if (unknown.length) error.push(`unknown field ${unknown.join(', ')} (the form only takes ${EDIT_FIELDS.join(', ')})`);
  const given = (k) => f[k] != null && String(f[k]).trim() !== '';
  const whole = (k) => {
    const s = String(f[k]).trim();
    return /^\d+$/.test(s) ? Number(s) : NaN;
  };
  if (given('value')) {
    const v = whole('value');
    if (!(v >= 1 && v <= 10)) error.push('value must be a whole number 1-10');
    else field.value = v;
  }
  if (given('content_min')) {
    const v = whole('content_min');
    if (!(v >= 1 && v <= CONTENT_MIN_MAX))
      error.push(`content minutes must be a whole number 1-${CONTENT_MIN_MAX}`);
    else field.content_min = v;
  }
  if (given('class')) {
    const k = String(f.class).trim();
    if (!CLASSES.includes(k)) error.push(`class must be one of ${CLASSES.join(', ')}`);
    else field.class = k;
  }
  return { error, field };
}

/**
 * The board's "Edit" for one task: the status must allow it, the form must be valid, and the task as it will be must
 * pass queueLogic.validate (the check `queue.mjs add` and `edit` run). Only the fields that actually change are returned,
 * so an unchanged form writes nothing. queue.mjs edit validates again under the lock.
 * @returns {{ error: string[], field?: object }}
 */
function editPlan(queue, id, form) {
  const o = (queue?.tasks ?? []).find((x) => x.id === id);
  if (!o || L.isExternalRow(o)) return { error: [`unknown task ${id}`] };
  if (!EDIT_STATUSES.has(o.status))
    return { error: [`${id} is ${o.status}; only waiting and proposed tasks can be edited on the board`] };
  const r = editFields(form);
  if (r.error.length) return { error: r.error };
  const field = {};
  for (const [k, v] of Object.entries(r.field)) if (!L.equalValue(o[k], v)) field[k] = v;
  if (!Object.keys(field).length) return { error: ['nothing changed'] };
  const f = L.validate(
    { ...o, ...field },
    (queue.tasks ?? []).filter((x) => x.id !== id),
    queue.projects,
  );
  if (f.length) return { error: f };
  return { error: [], field };
}

module.exports = {
  CANCEL_STATUSES,
  EDIT_STATUSES,
  EDIT_FIELDS,
  CLASSES,
  CONTENT_MIN_MAX,
  REASON_MAX,
  cleanReason,
  cancelRemark,
  cancelError,
  cancelTask,
  cliCancelCommand,
  cliCancelHint,
  editFields,
  editPlan,
};
