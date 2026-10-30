// =============================================================
// queueLogic.js: pure logic for the work queue (scripts/orchestrator/queue.mjs).
//
// The queue gives continuous flow instead of fixed waves (docs/queue.md): when a slot becomes free, it starts the highest
// ranked task that (a) has all dependencies done, (b) is not waiting on an owner question, and (c) does not own
// a file, DB object or shared patch that a running task owns. The limits (concurrent, D+, per domain) sit in
// the queue file under `limits`.
//
// Project, feature, picking and QA: tasks belong to a project (explicit field or prefix rule from the
// `projects` register) and a feature; a person or session can pick a task (status `picked`, owns its files
// but takes no agent slot); tasks with the label `visual` land in the owner's QA list when they are done. All
// the new fields are optional, so an older queue.json works unchanged.
//
// Work outside the queue: commits on baseBranch (config().baseBranch) are classified as queue (merge of a queue branch,
// config().branchPrefix), orchestrator (the trailer "Queue: orchestrator") or external; external changes are compared with
// the owned files; a row with status `external` (`queue.mjs external add`) owns files like a picked task; `next` skips
// tasks that collide with uncommitted files in the main tree; the push check finds a safe cut point. The git reading
// lives in queueGit.js.
//
// Owner questions and resolutions: `question` holds the text behind the ids in `waiting_on`, and `resolutions` holds the
// answer with a timestamp (the id still sits in `resolved`). Both are optional.
//
// Batch queue: `batched: true` (optional) puts a small, non-blocking task in the batch queue; it is never started or
// picked alone, and `batchPack` combines a group into one track of the right size.
//
// Areas, focus period and parking: `areas` above projects, `focus` with stage, "rest" and "pulled along", and
// `parked` per task. One ranking (queueLogic.ranking) for selectNext, pickable, show and state. Without focus and
// parked the result is the same as without these fields.
//
// The orchestrator's routine as script and cost per task: short `show`, agent type and agent message for `fill`,
// review package for `receive`, the RESULT/FINDINGS parsers and the cost sum for `set done` and `cost`.
//
// No I/O here (except that config() is read when needed): the CLI reads and writes the file and calls these functions.
// The tests live in lib/__tests__/.
// =============================================================

/**
 * The config (queue.config.json via queueConfig.js), read the first time it is needed. If reading fails (e.g. in a pure test without
 * config), the defaults are used.
 */
let configCache = null;
function cfg() {
  if (configCache) return configCache;
  try {
    configCache = require('./queueConfig.js').config();
  } catch {
    configCache = {};
  }
  return configCache;
}
/** Forgets the config that was read (tests that switch QUEUE_CONFIG). */
function resetConfig() {
  configCache = null;
}
/** The integration branch everything is merged into. */
const baseBranch = () => cfg().baseBranch ?? 'main';
/** The remote baseBranch is pushed to. */
const remoteName = () => cfg().remote ?? 'origin';
/** Prefix for the queue branches (`<prefix><id>`). */
const branchPrefix = () => cfg().branchPrefix ?? 'queue/';
/** The queue branch for a task. */
const queueBranch = (id) => `${branchPrefix()}${id}`;

/**
 * Weight per risk class. Estimate = content (min for a K track) × weight.
 *
 * `estimate` is NOT a good wall time; wall time depends little on content_min. WEIGHT and estimate drive priority (value
 * per minute in scoreParts), the size targets and the cloud bundle cap; editing them would reshuffle the queue. Calibrated wall time and
 * cost live in `estimateWall` and `estimateCost` below.
 */
const WEIGHT = { K: 1.0, D: 1.3, 'D+': 1.8, U: 0.6 };

/**
 * Calibrated model for WALL TIME (started → done, i.e. including review and merge) and COST (API-equivalent USD for track
 * and reviewers, timeCost.costUsd) per task: fixed + content_min × factor, per class. The start values are fitted to
 * the medians for finished queue tracks in a real project (a few hundred tracks):
 *   K: wall time approx. 15 min (content 30), 29 (90), 33 (120); cost approx. $0.9 / $2.4 / $3.5
 *   D: wall time approx. 60 min (30–60);                         cost approx. $3.6–5.4
 *   D+: wall time approx. 88 min (30);                            cost approx. $7.4
 *   U: wall time approx. 24 min (60);                             cost approx. $1.8
 * Fix rounds (2+ build agents) roughly double cost and wall time; they are rare and sit in the median.
 * Calibrate again (`queue.mjs cost`) when the class mix or way of working changes.
 */
const CALIBRATED = {
  date: '2026-10-23',
  wall: { K: [10, 0.19], D: [56, 0.4], 'D+': [65, 1.1], U: [6, 0.3] },
  cost: { K: [0.6, 0.022], D: [2, 0.08], 'D+': [3, 0.15], U: [0.6, 0.02] },
};

/** Default limits: overridden in the queue file under `limits`. */
// maxDb: tracks with migrations (migr_tens > 0) concurrently. Many concurrent DB tracks compete for the same
// database (locks, queueing in test runs); client tracks do not load it and are not limited by this limit.
// dailyBudget: USD API equivalent per day (measured with timeCost.js). null = off (no limit) until the owner has set a
// number with `queue.mjs limit dailyBudget <usd>`.
// nightRun / nightWindow: with nightRun off, no new tasks are started in the night window (local time, "23-06" =
// from 23:00 to 06:00). Default is on.
// autocompact: automatic compaction of the orchestrator session. On (default, as in Claude Code itself): Claude Code compacts
// by itself (autoCompactEnabled on, window 300k) and the queue resumes automatically. Off: notice with a ready /compact line,
// so the owner follows along (also turn off Claude Code's own compaction then). The hooks
// read the value (contextGuard.compactMode); `queue.mjs compact auto|manual`.
const DEFAULT_LIMITS = {
  maxConcurrent: 5,
  maxDPlus: 2,
  maxPerDomain: 7,
  maxDb: 6,
  dailyBudget: null,
  nightRun: true,
  nightWindow: '23-06',
  autocompact: true,
};
/** The time zone the night window and the daily budget's day apply in: the machine's own (the TZ environment variable
 * overrides it). */
const NIGHT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Statuses in which the task keeps its ownership (running, picked by a person or session, delivered and waiting for
 * review/merge, or work registered outside the queue). The queue starts nothing that collides with these.
 */
const ACTIVE = new Set(['running', 'review', 'picked', 'external']);

// proposed: added by an agent (track, reviewer, fold/investigation agent) and not approved yet. Never
// started; `queue.mjs approve <id…>` makes it waiting.
// picked: a person or session does the task manually (`queue.mjs pick`). Owns its files and has
// migrationBlock, but does not count toward maxConcurrent/maxDPlus.
// external: not a task, but a record of work in progress outside the queue (`queue.mjs external add`). Owns
// its files like a picked task until `external done <name>`. The row has `external: true` and never counts as
// work (projects, show, state).
const STATUSES = new Set([
  'proposed',
  'waiting',
  'running',
  'picked',
  'review',
  'done',
  'cancelled',
  'external',
]);
const CLASSES = new Set(Object.keys(WEIGHT));

/** The project for a task without its own `project` and without a match on any prefix in the register. */
const WITHOUT_PROJECT = 'without-project';
/** The group name for tasks without `feature` in the grouped view and the QA list. */
const WITHOUT_FEATURE = '(no feature)';
/** Visual QA: the owner looks at finished tasks with the label `visual`. */
const QA_STATUSES = new Set(['waiting', 'ok', 'deviation']);
const LABEL_VISUAL = 'visual';
/** Project id: short kebab-case (webshop, api-v2, reports). */
const PID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Label: short word in lowercase (visual). */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** A picked task is "old" when it has been picked this long without commits (it is never released automatically). */
const OLD_PICK_MS = 72 * 3_600_000;

/** Estimated time in minutes for a task (content × weight). */
function estimate(o) {
  const content = Number(o.content_min ?? 30);
  return Math.round(content * (WEIGHT[o.class] ?? 1));
}

/** Calibrated wall time in minutes (started → done, including review and merge), see CALIBRATED. */
function estimateWall(o) {
  const [fixedLine, factor] = CALIBRATED.wall[o?.class] ?? CALIBRATED.wall.K;
  return Math.round(fixedLine + Number(o?.content_min ?? 30) * factor);
}

/** Calibrated cost in API-equivalent USD (track and reviewers), see CALIBRATED. The basis for the quota forecast. */
function estimateCost(o) {
  const [fixedLine, factor] = CALIBRATED.cost[o?.class] ?? CALIBRATED.cost.K;
  return Math.round((fixedLine + Number(o?.content_min ?? 30) * factor) * 10) / 10;
}

/**
 * Validates a new task. Returns a list of errors (empty = valid).
 * Required: id, title, domain, class, mission (path to track description or text).
 * `register` (the queue's `projects`): when it has at least one project, an explicit `project` must exist in it.
 */
function validate(o, existing = [], register) {
  const error = [];
  if (!o || typeof o !== 'object') return ['task must be an object'];
  if (!o.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(o.id))
    error.push('id missing or has invalid characters');
  if (existing.some((e) => e.id === o.id)) error.push(`id ${o.id} already exists`);
  if (!o.title) error.push('title missing');
  if (!o.domain) error.push('domain missing');
  if (!CLASSES.has(o.class)) error.push(`class must be one of ${[...CLASSES].join(', ')}`);
  if (!o.mission) error.push('mission missing (path to track description or text)');
  if (o.status && !STATUSES.has(o.status)) error.push(`unknown status ${o.status}`);
  for (const field of ['depends_on', 'waiting_on', 'owned_files', 'owner_db', 'shared_patch']) {
    if (o[field] != null && !Array.isArray(o[field])) error.push(`${field} must be a list`);
  }
  if (o.value != null && !(o.value >= 1 && o.value <= 10)) error.push('value must be 1–10');
  const emptyRegister = !register || Object.keys(register).length === 0;
  error.push(...validateNewField(o, register, { stringProject: !emptyRegister }));
  return error;
}

/**
 * The project fields (project, feature, labels, qa_status). All are optional. With `stringProject` an
 * explicit project must exist in the register (writeError would otherwise create a new, empty project in the `projects` table).
 */
function validateNewField(o, register, { stringProject = true } = {}) {
  const error = [];
  if (o.project != null) {
    if (typeof o.project !== 'string' || !PID_PATTERN.test(o.project))
      error.push('project must be a short kebab-case id (e.g. api-v2)');
    else if (
      stringProject &&
      o.project !== WITHOUT_PROJECT &&
      !Object.hasOwn(register ?? {}, o.project)
    )
      error.push(
        `unknown project ${o.project} (create it first: cq project ${o.project} --title "…")`,
      );
  }
  // Plan entry the task belongs to (id in scripts/.queue/plans.json; queue.mjs checks that it exists).
  if (o.plan != null && (typeof o.plan !== 'string' || !/^PL-\S+$/.test(o.plan)))
    error.push('plan must be a plan entry id (PL-NAME-1)');
  if (o.feature != null && (typeof o.feature !== 'string' || !o.feature.trim()))
    error.push('feature must be a text (short name, e.g. "Today\'s staffing")');
  if (
    o.labels != null &&
    (!Array.isArray(o.labels) ||
      o.labels.some((e) => typeof e !== 'string' || !LABEL_PATTERN.test(e)))
  )
    error.push('labels must be a list of short lowercase words (e.g. ["visual"])');
  if (
    o.requires != null &&
    (!Array.isArray(o.requires) || o.requires.some((k) => typeof k !== 'string' || !REQUIRES.has(k)))
  )
    error.push(`requires must be a list of ${[...REQUIRES].join(', ')}`);
  if (o.qa_status != null && !QA_STATUSES.has(o.qa_status))
    error.push(`qa_status must be one of ${[...QA_STATUSES].join(', ')}`);
  // "put on hold" for one task (queue.mjs park).
  if (o.parked != null) {
    const p = o.parked;
    const valid =
      typeof p === 'object' &&
      !Array.isArray(p) &&
      typeof p.by === 'string' &&
      !!p.by.trim() &&
      typeof p.at === 'string' &&
      Number.isFinite(Date.parse(p.at)) &&
      (p.to == null || (typeof p.to === 'string' && Number.isFinite(Date.parse(p.to)))) &&
      (p.reason == null || typeof p.reason === 'string');
    if (!valid) error.push('parked must be { by, at, reason?, to? } (set with cq park)');
  }
  return error;
}

/** The fast index while queueLogic.withIndex runs (see "The fast index" below), otherwise null. Declared here, before first use. */
let fastIndex = null;

// ---- Project and feature -----------------------------------------------------------------------------

/**
 * The project a task belongs to: explicit `project`, otherwise the project with the LONGEST prefix in the register that
 * matches the start of the id (on equal length the first in the register wins), otherwise `without-project`.
 * The prefixes are data in the register, never hardcoded here.
 */
function projectFor(o, register) {
  if (typeof o?.project === 'string' && o.project) return o.project;
  // Inside withIndex each id is looked up once per register (the board asks many times per card).
  const ix = fastIndex;
  if (ix && register && typeof register === 'object') {
    ix.project ??= new WeakMap();
    let perId = ix.project.get(register);
    if (!perId) ix.project.set(register, (perId = new Map()));
    const id = String(o?.id ?? '');
    if (!perId.has(id)) perId.set(id, longestPrefix(id, register)?.pid ?? WITHOUT_PROJECT);
    return perId.get(id);
  }
  return longestPrefix(o?.id, register)?.pid ?? WITHOUT_PROJECT;
}

/**
 * The longest prefix in the register that matches the start of the id: { pid, prefix } or null. On equal length in two
 * projects the first in the register wins (as before), and `also` lists the others.
 */
function longestPrefix(id, register) {
  const s = String(id ?? '');
  let best = null;
  for (const [pid, p] of Object.entries(register ?? {})) {
    const prefixes = Array.isArray(p?.prefixes) ? p.prefixes : [];
    for (const pre of prefixes) {
      if (typeof pre !== 'string' || !pre || !s.startsWith(pre)) continue;
      if (!best || pre.length > best.prefix.length) best = { pid, prefix: pre, also: [] };
      else if (pre.length === best.prefix.length && pid !== best.pid && !best.also.includes(pid))
        best.also.push(pid);
    }
  }
  return best;
}

/** Is the project the task belongs to paused? Then the queue does not start it (next/start without --force). */
function projectPaused(o, register) {
  return register?.[projectFor(o, register)]?.pause === true;
}

/**
 * The blockers, with pause first when the project is paused (for `show` and `state`; `start` checks pause itself).
 * A parked task and a task outside the focus (when the rest waits) get that as the first blocker.
 * @param {object} [k] rankingContext(queue, now), when many tasks are looked up
 */
function blockersWithPause(o, queue, k = null) {
  const register = queue.projects ?? {};
  const h = blockers(o, queue.tasks ?? [], queue.resolved);
  if (o.status !== 'waiting') return h;
  const ahead = [];
  if (o.parked && parkedNow(o, k?.now ?? Date.now())) ahead.push(parkedText(o));
  if (projectPaused(o, register)) ahead.push(`the project ${projectFor(o, register)} is paused`);
  if (queue.focus) {
    const p = focusSpace(o, k ?? rankingContext(queue));
    if (p.outside && !p.parked && !p.paused && p.out) ahead.push(outsideText(queue));
  }
  return [...ahead, ...h];
}

/** Does the task have the label? */
function hasLabel(o, label) {
  return Array.isArray(o?.labels) && o.labels.includes(label);
}

/**
 * Does the task count toward the queue's agent slots (maxConcurrent, maxDPlus)? Running and review do, but not a task
 * that a person or session has picked, not even after it is delivered to review (it still has `picked_by`).
 */
function counterAsAgent(o) {
  return (o.status === 'running' || o.status === 'review') && !o.picked_by;
}

/** The order projects are shown in: the register's order, then unknown alphabetically, `without-project` last. */
function projectOrder(pids, register) {
  const inRegister = Object.keys(register ?? {});
  const others = [...pids]
    .filter((p) => !inRegister.includes(p) && p !== WITHOUT_PROJECT)
    .sort((x, y) => x.localeCompare(y, 'en'));
  return [
    ...inRegister.filter((p) => pids.has(p)),
    ...others,
    ...(pids.has(WITHOUT_PROJECT) ? [WITHOUT_PROJECT] : []),
  ];
}

/**
 * Groups tasks project → feature (the order within a feature is the one the caller gave). For `show --grouped`
 * and the QA list. Returns [{ pid, title, pause, features: [{ feature, tasks }] }].
 */
function groups(tasks, register) {
  const perProject = new Map();
  for (const o of tasks) {
    const pid = projectFor(o, register);
    if (!perProject.has(pid)) perProject.set(pid, new Map());
    const f =
      typeof o.feature === 'string' && o.feature.trim() ? o.feature.trim() : WITHOUT_FEATURE;
    const perFeature = perProject.get(pid);
    if (!perFeature.has(f)) perFeature.set(f, []);
    perFeature.get(f).push(o);
  }
  return projectOrder(new Set(perProject.keys()), register).map((pid) => {
    const perFeature = perProject.get(pid);
    const features = [...perFeature.keys()].sort((x, y) =>
      x === WITHOUT_FEATURE ? 1 : y === WITHOUT_FEATURE ? -1 : x.localeCompare(y, 'en'),
    );
    return {
      pid,
      title: register?.[pid]?.title ?? null,
      pause: register?.[pid]?.pause === true,
      features: features.map((f) => ({ feature: f, tasks: perFeature.get(f) })),
    };
  });
}

/**
 * Overview per project for `queue.mjs projects`: done/total (without cancelled and proposed), minutes left
 * (estimate for what is not done), active ones (running/review), picked, waiting, in the QA list, and the owner questions that
 * block most tasks in the project.
 */
function projectOverview(queue) {
  const register = queue.projects ?? {};
  const resolved = new Set(queue.resolved ?? []);
  const rows = new Map();
  const row = (pid) => {
    if (!rows.has(pid)) {
      const p = register[pid] ?? {};
      rows.set(pid, {
        pid,
        title: p.title ?? null,
        plan: p.plan ?? null,
        pause: p.pause === true,
        priority_bonus: Number(p.priority_bonus) || 0,
        in_register: Object.hasOwn(register, pid),
        total: 0,
        done: 0,
        min_left: 0,
        activeOnes: 0,
        picked: 0,
        waiting: 0,
        proposed: 0,
        qa: 0,
        sp: new Map(),
      });
    }
    return rows.get(pid);
  };
  for (const pid of Object.keys(register)) row(pid);
  // Records outside the queue (external add) are not work in any project.
  for (const o of (queue.tasks ?? []).filter((x) => !isExternalRow(x))) {
    const r = row(projectFor(o, register));
    if (o.status === 'cancelled') continue;
    if (o.status === 'proposed') {
      r.proposed += 1;
      continue;
    }
    r.total += 1;
    if (o.status === 'done') {
      r.done += 1;
      if (o.qa_status === 'waiting') r.qa += 1;
      continue;
    }
    r.min_left += estimate(o);
    if (o.status === 'running' || o.status === 'review') r.activeOnes += 1;
    else if (o.status === 'picked') r.picked += 1;
    else if (o.status === 'waiting') {
      r.waiting += 1;
      for (const sp of o.waiting_on ?? []) {
        if (!resolved.has(sp)) r.sp.set(sp, (r.sp.get(sp) ?? 0) + 1);
      }
    }
  }
  return projectOrder(new Set(rows.keys()), register).map((pid) => {
    const { sp, ...r } = rows.get(pid);
    return {
      ...r,
      ownerQuestion: [...sp.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([s, n]) => ({ sp: s, tasks: n })),
    };
  });
}

/** The fields a project in the register can have. */
const PROJECT_FIELD = new Set([
  'title',
  'plan',
  'prefixes',
  'pause',
  'priority_bonus',
  'area',
  // File roots (signal for classify) and known feature names.
  'fileRoot',
  'features',
  // 'plan' = the project exists in the plan register, but has no queue tasks yet (docs/plan-register.md).
  'phase',
]);

/**
 * Validates and applies changes to the project register: { <pid>: { title?, plan?, prefixes?, pause?,
 * priority_bonus? } }. A new project requires title. `null` removes an optional field. Returns a NEW
 * register (the old one is not changed) and the error list; the caller uses the register only when the error list is empty.
 */
function newRegister(register, changes, areas = {}) {
  const error = [];
  const fresh = { ...(register ?? {}) };
  if (changes == null) return { register: fresh, error };
  if (typeof changes !== 'object' || Array.isArray(changes))
    return { register: fresh, error: ['projects must be an object { <pid>: { title, … } }'] };
  for (const [pid, field] of Object.entries(changes)) {
    if (!PID_PATTERN.test(pid) || pid === WITHOUT_PROJECT) {
      error.push(`project id ${pid} must be short kebab-case (and not ${WITHOUT_PROJECT})`);
      continue;
    }
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      error.push(`${pid}: must be an object`);
      continue;
    }
    const unknown = Object.keys(field).filter((k) => !PROJECT_FIELD.has(k));
    if (unknown.length)
      error.push(
        `${pid}: unknown field ${unknown.join(', ')} (allowed: ${[...PROJECT_FIELD].join(', ')})`,
      );
    const p = { ...(fresh[pid] ?? {}) };
    for (const [k, v] of Object.entries(field)) {
      if (!PROJECT_FIELD.has(k)) continue;
      if (v === null) delete p[k];
      else p[k] = v;
    }
    if (typeof p.title !== 'string' || !p.title.trim()) error.push(`${pid}: title missing`);
    if (p.plan != null && typeof p.plan !== 'string')
      error.push(`${pid}: plan must be a text (path)`);
    if (
      p.prefixes != null &&
      (!Array.isArray(p.prefixes) ||
        p.prefixes.some((x) => typeof x !== 'string' || !x || /\s/.test(x)))
    )
      error.push(`${pid}: prefixes must be a list of non-empty prefixes without whitespace`);
    if (p.pause != null && typeof p.pause !== 'boolean')
      error.push(`${pid}: pause must be true/false`);
    if (p.priority_bonus != null && !Number.isFinite(p.priority_bonus))
      error.push(`${pid}: priority_bonus must be a number`);
    // File root = folders/files (paths, not patterns), features = known feature names.
    if (
      p.fileRoot != null &&
      (!Array.isArray(p.fileRoot) ||
        p.fileRoot.some((x) => typeof x !== 'string' || !x.trim() || /\s/.test(x) || /[*?]/.test(x)))
    )
      error.push(`${pid}: fileRoot must be a list of paths without whitespace and wildcards`);
    if (
      p.features != null &&
      (!Array.isArray(p.features) ||
        p.features.some((x) => typeof x !== 'string' || !x.trim() || x.length > 80))
    )
      error.push(`${pid}: features must be a list of short names`);
    if (p.phase != null && p.phase !== 'plan')
      error.push(`${pid}: phase must be plan (or be removed with null)`);
    // Area must exist in the area register when the change sets it.
    if ('area' in field && field.area != null) {
      if (typeof field.area !== 'string' || !PID_PATTERN.test(field.area))
        error.push(`${pid}: area must be a short kebab-case id`);
      else if (!Object.hasOwn(areas ?? {}, field.area))
        error.push(
          `${pid}: unknown area ${field.area} (create it first: cq area ${field.area} --title "…")`,
        );
    }
    fresh[pid] = p;
  }
  return { register: fresh, error };
}

/** The fields `edit-many` can set per task. */
const EDIT_MANY_FIELD = new Set([
  'id',
  'project',
  'feature',
  'labels',
  'requires',
  'priority_bonus',
  // Put on hold / take off hold, and into / out of the batch queue, with the same rules as park and edit.
  'parked',
  'batched',
  // The link to the plan register (queue.mjs checks that the plan entry exists).
  'plan',
]);
/** The fields that are actually changed (everything except id). */
const EDIT_MANY_VALUES = [
  'project',
  'feature',
  'labels',
  'requires',
  'priority_bonus',
  'parked',
  'batched',
  'plan',
];

/**
 * Interprets `parked` in edit-many: null = take off hold; true = park (without reason and date); { reason?, to? } = park with
 * reason and/or date (YYYY-MM-DD = through that day, UTC). `by` and `at` are set by the tool (same shape as
 * queue.mjs park). Returns { val } (null = remove the field) or { error }.
 */
function parkedValue(raw, { by, now }) {
  if (raw === null) return { val: null };
  const who = String(by ?? '').trim() || 'unknown';
  if (raw === true) return { val: { by: who, at: now } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'parked must be true, null or { reason?, to? }' };
  const unknown = Object.keys(raw).filter((k) => !['reason', 'to'].includes(k));
  if (unknown.length)
    return { error: `parked: unknown field ${unknown.join(', ')} (allowed: reason, to)` };
  const g = raw.reason == null ? null : String(raw.reason).trim();
  if (g && g.length > FOCUS_MAX_TEXT)
    return { error: `parked: the reason can be at most ${FOCUS_MAX_TEXT} characters` };
  let to = null;
  if (raw.to != null && raw.to !== '') {
    to = parseToDate(raw.to);
    if (!to) return { error: `parked: invalid date ${raw.to} (use YYYY-MM-DD or ISO time)` };
    if (Date.parse(to) <= Date.parse(now))
      return { error: `parked: the date ${raw.to} has passed` };
  }
  return {
    val: { by: who, at: now, ...(g ? { reason: g } : {}), ...(to ? { to } : {}) },
  };
}

/**
 * Bulk edit (`queue.mjs edit-many --file`): a list [{ id, project?, feature?, labels?, requires?,
 * priority_bonus?, parked?, batched? }] or an object { projects?: {…}, tasks?: [...] }. ALL OR NOTHING:
 * everything is validated before anything is changed, and on one error nothing is changed (neither tasks nor register). `null` removes a field
 * (project then falls back to the prefix rule). A project must exist in the register after the file is applied.
 * `priority_bonus` ("Lift dependencies too") must be a number.
 * `parked` (see parkedValue; only waiting and proposed can be parked, like queue.mjs park), `batched` (same
 * rules as add/edit: queueLogic.batchedError against the queue as it will be), the register fields `area`, `fileRoot` and `features`,
 * and `dry` (computes everything on a copy and changes nothing). The answer always has `changes` (bulkDiff: only fields that
 * actually changed, for the preview and the changelog) and `warnings` (move to a paused project, parking of a
 * task the focus has pulled along, batch queue for a task that is parked).
 * @param {{ by?: string, now?: string, dry?: boolean }} [option]
 * @returns {{ error: string[], changed?: string[], projects?: string[], changes?: object[], warnings?: string[] }}
 */
function editMany(queue, input, { by = null, now = new Date().toISOString(), dry = false } = {}) {
  if (dry) return editMany(cloneJson(queue), input, { by, now });
  let changes;
  let projects;
  const error = [];
  if (Array.isArray(input)) changes = input;
  else if (input && typeof input === 'object') {
    const unknown = Object.keys(input).filter((k) => !['tasks', 'projects'].includes(k));
    if (unknown.length)
      error.push(`unknown top-level keys: ${unknown.join(', ')} (allowed: projects, tasks)`);
    changes = input.tasks ?? [];
    projects = input.projects;
  } else {
    return { error: ['the file must be a list of changes or { projects, tasks }'] };
  }
  if (!Array.isArray(changes)) return { error: [...error, 'tasks must be a list'] };
  const reg = newRegister(queue.projects, projects, queue.areas);
  error.push(...reg.error);
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const set = new Set();
  const plan = [];
  changes.forEach((e, i) => {
    const name = e?.id ?? `no. ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      error.push(
        `no. ${i + 1}: must be an object { id, project?, feature?, labels?, priority_bonus?, parked?, batched? }`,
      );
      return;
    }
    const unknown = Object.keys(e).filter((k) => !EDIT_MANY_FIELD.has(k));
    if (unknown.length)
      error.push(
        `${name}: unknown field ${unknown.join(', ')} (edit-many only takes ${[...EDIT_MANY_FIELD].join(', ')})`,
      );
    if (
      'priority_bonus' in e &&
      e.priority_bonus !== null &&
      (typeof e.priority_bonus !== 'number' || !Number.isFinite(e.priority_bonus))
    )
      error.push(`${name}: priority_bonus must be a number`);
    const o = perId.get(e.id);
    if (!o || isExternalRow(o)) {
      error.push(`${name}: unknown task`);
      return;
    }
    if (set.has(e.id)) error.push(`${e.id}: appears more than once in the file`);
    set.add(e.id);
    // The values that are written (parked is normalized; batched false/null removes the field, like queue.mjs edit).
    const values = {};
    for (const k of EDIT_MANY_VALUES) if (k in e) values[k] = e[k];
    if ('parked' in e) {
      if (e.parked === true && o.parked) delete values.parked;
      else {
        const p = parkedValue(e.parked, { by, now });
        if (p.error) error.push(`${e.id}: ${p.error}`);
        else {
          values.parked = p.val;
          if (p.val && o.status !== 'waiting' && o.status !== 'proposed')
            error.push(`${e.id}: status ${o.status} (only waiting and proposed can be parked)`);
        }
      }
    }
    if ('batched' in e) {
      if (e.batched != null && typeof e.batched !== 'boolean')
        error.push(`${e.id}: batched must be true, false or null`);
      else if (e.batched !== true) values.batched = null;
    }
    const fresh = { ...o };
    for (const [k, v] of Object.entries(values)) {
      if (v === null) delete fresh[k];
      else fresh[k] = v;
    }
    for (const f of validateNewField(fresh, reg.register, { stringProject: true }))
      error.push(`${e.id}: ${f}`);
    plan.push({ o, e, new: fresh, values });
  });
  // Batch queue: the rules against the queue as it will be after the WHOLE file (two tasks in the file can affect each other).
  const newPerId = new Map(plan.map((p) => [p.o.id, p.new]));
  const after = (queue.tasks ?? []).map((x) => newPerId.get(x.id) ?? x);
  for (const p of plan) {
    if (!('batched' in p.e)) continue;
    for (const f of batchedError(p.new, after, queue.resolved)) error.push(`${p.o.id}: ${f}`);
  }
  if (error.length) return { error };

  // Warnings (do not stop): computed against the queue BEFORE the change.
  const warnings = [];
  const k = rankingContext(queue, Date.parse(now));
  for (const p of plan) {
    const pidAfter = projectFor(p.new, reg.register);
    if (
      pidAfter !== projectFor(p.o, queue.projects ?? {}) &&
      reg.register?.[pidAfter]?.pause === true
    )
      warnings.push(
        `${p.o.id} is moved to ${pidAfter}, which is paused (not started until it continues)`,
      );
    if (p.values.parked && !p.o.parked) {
      const d = k.dragged.get(p.o.id);
      if (d && !newPerId.get(d.by)?.parked)
        warnings.push(
          `${p.o.id} is pulled along by ${d.by} in the focus (stage ${d.stage + 1}); it waits until ${p.o.id} continues`,
        );
    }
    if (p.new.batched === true && p.new.parked)
      warnings.push(
        `${p.o.id} is both parked and in the batch queue; it is packed, but not started until it continues`,
      );
  }

  const forQueue = {
    tasks: plan.map((p) => cloneJson(p.o)),
    projects: cloneJson(queue.projects ?? {}),
  };
  if (projects != null) queue.projects = reg.register;
  for (const { o, values } of plan) {
    for (const [kk, v] of Object.entries(values)) {
      if (v === null) delete o[kk];
      else o[kk] = v;
    }
  }
  return {
    error: [],
    changed: plan.map((p) => p.o.id),
    projects: Object.keys(projects ?? {}),
    changes: bulkDiff(forQueue, {
      tasks: plan.map((p) => p.o),
      projects: queue.projects ?? {},
    }),
    warnings,
  };
}

// ---- Areas, focus period and parking -------------------------------------------------------------
//
// Three optional fields in queue.json (docs/queue.md):
//   areas: { <oid>: { title, description? } }   the area register (program parts); the project gets `area`. The list is
//                                                  data, never hardcoded here.
//   focus: { name?, from?, to?, order: [stage], rest: 'wait'|'fill', drag_with_dependencies?, set_by? }
//          A stage is `area:<oid>`, `project:<pid>` or `feature:<pid>/<name>`. Everything in stage 1 comes before everything in
//          stage 2 (regardless of score); within a stage the usual score applies. A more specific stage wins over a less
//          specific one (feature > project > area), so "Widgets now, rest of Platform later" works both ways.
//          `rest: wait` (default) = tasks outside all stages are not started; `fill` = they come last and
//          fill slots the focus does not use. The focus applies until it is changed, with an optional end date `to`; when
//          it has passed, the queue is ranked as without focus and state/show give notice.
//          Pulled along: an open dependency (transitively) of a pending task in the focus gets the stage of the highest
//          ranked task that waits on it, even if it belongs to an area outside.
//   task.parked: { by, at, reason?, to? }      "put on hold" for one task. Status stays waiting (like batched);
//                                                  next, start and pickable skip it. With `to` the parking ends
//                                                  by itself.
// The ranking (ranking/compareRanking) is ONE function used by selectNext, pickable, nextUp (via selectNext),
// show and state: [parked/paused/outside focus → out] → focusStep → score → id. Without focus and without parked the
// result is the same as before (tested in lib/__tests__/queueFocus.test.ts).

/** Area for projects without `area`. */
const WITHOUT_AREA = 'without-area';
/** Valid values for focus.rest. Standard: wait. */
const FOCUS_REST = ['wait', 'fill'];
/** How specific a stage is: the most specific stage that matches a task decides the stage. */
const STEP_SPECIFICITY = { area: 1, project: 2, feature: 3 };
/** Sort values for tasks outside the focus (rest waiting) and parked (last of all). */
const REST_STEP = 1_000_000;
const PARKED_STEP = 2_000_000;
/** Longest free text in focus name and parking reason. */
const FOCUS_MAX_TEXT = 200;

/** The area a task belongs to: the project's `area`, otherwise `without-area`. Tasks never have their own area field. */
function areaFor(o, queue) {
  const register = queue?.projects ?? {};
  const oid = register[projectFor(o, register)]?.area;
  return typeof oid === 'string' && oid ? oid : WITHOUT_AREA;
}

/**
 * Interprets one stage from the CLI or the board: `area:<oid>`, `project:<pid>`, `feature:<pid>/<name>`, or a bare
 * name (area if it exists, otherwise project; if both exist, the type must be written). Returns the saved form.
 * @returns {{ stage: string } | { error: string }}
 */
function parseStep(raw, queue) {
  const areas = queue?.areas ?? {};
  const register = queue?.projects ?? {};
  const s = String(raw ?? '').trim();
  if (!s) return { error: 'empty stage' };
  const colon = s.indexOf(':');
  if (colon < 0) {
    const isArea = Object.hasOwn(areas, s);
    const isProject = Object.hasOwn(register, s);
    if (isArea && isProject)
      return {
        error: `${s} is both an area and a project: write area:${s} or project:${s}`,
      };
    if (isArea) return { stage: `area:${s}` };
    if (isProject) return { stage: `project:${s}` };
    return {
      error: `unknown stage ${s} (neither area nor project; see cq areas and projects)`,
    };
  }
  const type = s.slice(0, colon);
  const rest = s.slice(colon + 1).trim();
  if (type === 'area') {
    if (!Object.hasOwn(areas, rest))
      return { error: `unknown area ${rest} (create it with cq area ${rest} --title "…")` };
    return { stage: `area:${rest}` };
  }
  if (type === 'project') {
    if (!Object.hasOwn(register, rest)) return { error: `unknown project ${rest}` };
    return { stage: `project:${rest}` };
  }
  if (type === 'feature') {
    const separator = rest.indexOf('/');
    const pid = separator < 0 ? '' : rest.slice(0, separator).trim();
    const name = separator < 0 ? '' : rest.slice(separator + 1).trim();
    if (!pid || !name)
      return { error: `a feature stage is written feature:<project>/<name> (got ${s})` };
    if (!Object.hasOwn(register, pid)) return { error: `unknown project ${pid} in ${s}` };
    return { stage: `feature:${pid}/${name}` };
  }
  return { error: `unknown stage type ${type} (use area:, project: or feature:)` };
}

/** Does the task match a (saved) stage? Returns the specificity (1–3) or 0. */
function stepMatch(o, stage, queue) {
  const s = String(stage);
  const colon = s.indexOf(':');
  const type = s.slice(0, colon);
  const rest = s.slice(colon + 1);
  const register = queue?.projects ?? {};
  if (type === 'area') return areaFor(o, queue) === rest ? STEP_SPECIFICITY.area : 0;
  if (type === 'project')
    return projectFor(o, register) === rest ? STEP_SPECIFICITY.project : 0;
  if (type === 'feature') {
    const separator = rest.indexOf('/');
    const pid = rest.slice(0, separator);
    const name = rest.slice(separator + 1);
    const f = typeof o?.feature === 'string' ? o.feature.trim() : '';
    return projectFor(o, register) === pid && f === name ? STEP_SPECIFICITY.feature : 0;
  }
  return 0;
}

/**
 * Does the focus apply now? No when it is not set, has an empty order, `to` has passed (the period is over) or `from` is
 * in the future. Also returns why, for the notice.
 * @returns {{ applies: boolean, expired: boolean, notStarted: boolean }}
 */
function focusApplies(queue, now = Date.now()) {
  const f = queue?.focus;
  if (!f || !Array.isArray(f.order) || !f.order.length)
    return { applies: false, expired: false, notStarted: false };
  const to = f.to ? Date.parse(f.to) : NaN;
  if (Number.isFinite(to) && to <= now)
    return { applies: false, expired: true, notStarted: false };
  const from = f.from ? Date.parse(f.from) : NaN;
  if (Number.isFinite(from) && from > now)
    return { applies: false, expired: false, notStarted: true };
  return { applies: true, expired: false, notStarted: false };
}

/**
 * The task's own stage (0-based index in focus.order), or null when no stage matches. The most specific
 * stage wins; on equal level the first one. Does not look at "pulled along" (draggedWith/focusSpace does that).
 */
function ownStep(o, queue) {
  const order = queue?.focus?.order ?? [];
  let best = null;
  let bestSpec = 0;
  order.forEach((t, i) => {
    const spec = stepMatch(o, t, queue);
    if (spec > bestSpec) {
      best = i;
      bestSpec = spec;
    }
  });
  return best;
}

/** Is the task parked now? The parking ends by itself when `to` has passed. */
function parkedNow(o, now = Date.now()) {
  const p = o?.parked;
  if (!p || typeof p !== 'object') return false;
  const to = p.to ? Date.parse(p.to) : NaN;
  return !(Number.isFinite(to) && to <= now);
}

/**
 * "Pulled along": open dependencies (transitively) of pending tasks in the focus that do not themselves have an equally good stage.
 * Each gets the stage of the highest ranked focus task that waits on it, and `by` = that task. The roots are
 * pending tasks with their own stage that are not parked or in a paused project (they should not pull anything along).
 * Empty when the focus does not apply or `drag_with_dependencies` is false.
 * @returns {Map<string, { stage: number, by: string }>}
 */
function draggedWith(queue, now = Date.now()) {
  const dragged = new Map();
  if (!focusApplies(queue, now).applies || queue.focus.drag_with_dependencies === false) return dragged;
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const perId = new Map(tasks.map((o) => [o.id, o]));
  const ownOne = new Map();
  const stepFor = (o) => {
    if (!ownOne.has(o.id)) ownOne.set(o.id, ownStep(o, queue));
    return ownOne.get(o.id);
  };
  const roots = tasks
    .filter(
      (o) =>
        o.status === 'waiting' &&
        !isExternalRow(o) &&
        !parkedNow(o, now) &&
        !projectPaused(o, register),
    )
    .map((o) => ({ o, t: stepFor(o) }))
    .filter((x) => x.t != null)
    .sort((x, y) => x.t - y.t || x.o.id.localeCompare(y.o.id));
  for (const { o, t } of roots) {
    const set = new Set([o.id]);
    const stack = [...(o.depends_on ?? [])];
    while (stack.length) {
      const id = stack.pop();
      if (set.has(id)) continue;
      set.add(id);
      const d = perId.get(id);
      if (!openTask(d) || isExternalRow(d)) continue;
      const own = stepFor(d);
      const previous = dragged.get(id);
      if ((own == null || own > t) && (!previous || previous.stage > t))
        dragged.set(id, { stage: t, by: o.id });
      stack.push(...(d.depends_on ?? []));
    }
  }
  return dragged;
}

/**
 * The context the ranking needs, computed once per call (draggedWith walks the whole dependency graph).
 * @returns {{ queue: object, now: number, applies: boolean, expired: boolean, notStarted: boolean,
 *             rest: string, dragged: Map<string, { stage: number, by: string }> }}
 */
function rankingContext(queue, now = Date.now()) {
  const g = focusApplies(queue, now);
  return {
    queue,
    now,
    ...g,
    rest: g.applies && queue.focus.rest === 'fill' ? 'fill' : 'wait',
    dragged: g.applies ? draggedWith(queue, now) : new Map(),
  };
}

/** The text for a parked task (blocker in show/state). */
function parkedText(o) {
  const p = o.parked ?? {};
  return (
    `parked${p.to ? ` until ${utcText(p.to)}` : ''} by ${p.by ?? '?'}` +
    `${p.reason ? `: ${p.reason}` : ''} (cq continue ${o.id})`
  );
}

/** The text for a task outside the focus when the rest waits. */
function outsideText(queue) {
  const name = queue?.focus?.name ? ` "${queue.focus.name}"` : '';
  return `outside focus${name} (rest waiting; cq focus)`;
}

/**
 * The placement of one task, without score: focusStep (0-based, null = outside all stages), pulled along by, and whether it is
 * out of the ranking (parked, paused project, or outside the focus when the rest waits) with the reason.
 * `stage` is the sort value: 0 without focus; the stage index with focus; the stage count for the rest with `fill`;
 * REST_STEP for the rest with `wait`; PARKED_STEP for parked.
 */
function focusSpace(o, k) {
  const queue = k.queue;
  const parked = parkedNow(o, k.now);
  const paused = projectPaused(o, queue.projects ?? {});
  let step = null;
  let draggedBy = null;
  let outside = false;
  let stage = 0;
  if (k.applies) {
    const d = k.dragged.get(o.id);
    step = d ? d.stage : ownStep(o, queue);
    draggedBy = d ? d.by : null;
    outside = step == null;
    stage = outside ? (k.rest === 'fill' ? queue.focus.order.length : REST_STEP) : step;
  }
  if (parked) stage = PARKED_STEP;
  const outsideWait = outside && k.rest !== 'fill';
  let reason = null;
  if (parked) reason = parkedText(o);
  else if (paused) reason = `the project ${projectFor(o, queue.projects ?? {})} is paused`;
  else if (outsideWait) reason = outsideText(queue);
  return {
    stage,
    step,
    dragged_by: draggedBy,
    parked,
    paused,
    outside,
    out: parked || paused || outsideWait,
    reason,
  };
}

/**
 * The ranking of one task: focusSpace + score. ONE source for selectNext, pickable, nextUp, show and state.
 * @param {object} [k] rankingContext(queue, now), when many tasks are ranked
 */
function ranking(o, queue, k = rankingContext(queue)) {
  return {
    ...focusSpace(o, k),
    score: score(o, queue.tasks ?? [], k.now, queue.projects ?? {}),
  };
}

/** The sorting: lowest stage first, then highest score, then id. Takes { o, r } where r = ranking(o, …). */
function compareRanking(a, b) {
  return a.r.stage - b.r.stage || b.r.score - a.r.score || a.o.id.localeCompare(b.o.id);
}

/** Interprets a date (YYYY-MM-DD = through that day, UTC; otherwise ISO). null if invalid. */
function parseToDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const ms = /^\d{4}-\d\d-\d\d$/.test(s) ? Date.parse(`${s}T23:59:59.000Z`) : Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Short text for a stage: the area's or project's title, or the feature name. */
function stepTitle(stage, queue) {
  const s = String(stage);
  const colon = s.indexOf(':');
  const type = s.slice(0, colon);
  const rest = s.slice(colon + 1);
  if (type === 'area') return queue?.areas?.[rest]?.title ?? rest;
  if (type === 'project') return queue?.projects?.[rest]?.title ?? rest;
  return rest.slice(rest.indexOf('/') + 1);
}

/** "T1", "T2 pulled along by A-1" or "rest" for a row with { step, dragged_by } (show, next, pickable). */
function stepText(r) {
  if (r?.step == null) return 'rest';
  return `T${r.step + 1}${r.dragged_by ? ` pulled along by ${r.dragged_by}` : ''}`;
}

/** "1 Auth → 2 Payment and invoicing · rest waiting" */
function focusText(queue) {
  const f = queue?.focus;
  if (!f?.order?.length) return 'no focus';
  const stage = f.order.map((t, i) => `${i + 1} ${stepTitle(t, queue)}`).join(' → ');
  const rest = f.rest === 'fill' ? 'rest fills free slots' : 'rest waiting';
  return `${stage} · ${rest}${f.to ? ` · until ${utcText(f.to)}` : ''}`;
}

/**
 * Sets the focus (queue.mjs focus set). input: { order: [stage], rest?, to?, name?, drag_with_dependencies?, set_by? }.
 * Everything is validated before anything is changed. Warnings (not errors): stages without open tasks, paused projects in a stage, and
 * a focus that gives zero ready tasks now. Changes `queue` only when the error list is empty.
 * @returns {{ error: string[], warnings: string[], focus?: object }}
 */
function setFocus(queue, input, now = new Date().toISOString()) {
  const error = [];
  const warnings = [];
  const nowMs = Date.parse(now);
  const raw = Array.isArray(input?.order) ? input.order : [];
  if (!raw.length)
    error.push(
      'focus needs at least one stage (area:<oid>, project:<pid> or feature:<pid>/<name>)',
    );
  const order = [];
  for (const t of raw) {
    const r = parseStep(t, queue);
    if ('error' in r) error.push(r.error);
    else if (order.includes(r.stage)) error.push(`${r.stage} appears more than once`);
    else order.push(r.stage);
  }
  const rest = input?.rest ?? 'wait';
  if (!FOCUS_REST.includes(rest)) error.push(`rest must be ${FOCUS_REST.join(' or ')}`);
  let to = null;
  if (input?.to != null && input.to !== '') {
    to = parseToDate(input.to);
    if (!to) error.push(`invalid date ${input.to} (use YYYY-MM-DD or ISO time)`);
    else if (Date.parse(to) <= nowMs) error.push(`end date ${input.to} has passed`);
  }
  const name = input?.name == null ? null : String(input.name).trim();
  if (name != null && name.length > FOCUS_MAX_TEXT)
    error.push(`name can be at most ${FOCUS_MAX_TEXT} characters`);
  if (input?.drag_with_dependencies != null && typeof input.drag_with_dependencies !== 'boolean')
    error.push('drag_with_dependencies must be true/false');
  // How many of the stages the plan view shows in "Now" (the rest of the stages sit in "Next"). View only;
  // the order is the same. If the field is missing, "Now" is the first stage.
  const nowCount = input?.now_count == null ? null : Number(input.now_count);
  if (
    nowCount != null &&
    (!Number.isInteger(nowCount) || nowCount < 1 || nowCount > Math.max(order.length, 1))
  )
    error.push(`now_count must be an integer from 1 to ${Math.max(order.length, 1)}`);
  if (error.length) return { error, warnings };

  const focus = {
    ...(name ? { name } : {}),
    from: now,
    to,
    order,
    ...(nowCount != null ? { now_count: nowCount } : {}),
    rest,
    drag_with_dependencies: input?.drag_with_dependencies !== false,
    ...(input?.set_by ? { set_by: String(input.set_by).slice(0, FOCUS_MAX_TEXT) } : {}),
    // The history of stages taken out (cleanFocus) is carried over when the focus is set again.
    ...(Array.isArray(queue.focus?.history) && queue.focus.history.length
      ? { history: queue.focus.history }
      : {}),
  };
  // The warnings are computed on a copy with the new focus, so the queue is not changed before everything is ready.
  const trial = { ...queue, focus };
  const register = queue.projects ?? {};
  const opened = (queue.tasks ?? []).filter(
    (o) => openTask(o) && o.status !== 'proposed' && !isExternalRow(o),
  );
  order.forEach((t, i) => {
    const match = opened.filter((o) => stepMatch(o, t, trial) > 0);
    if (!match.length) warnings.push(`stage ${i + 1} (${t}) has no open tasks`);
    const pausedOnes = [
      ...new Set(
        match.filter((o) => projectPaused(o, register)).map((o) => projectFor(o, register)),
      ),
    ];
    for (const pid of pausedOnes)
      warnings.push(`the project ${pid} in stage ${i + 1} is paused (pause takes precedence over focus)`);
  });
  const status = focusStatus(trial, { now: nowMs });
  if (status.active && status.readyOnes === 0)
    warnings.push('the focus gives no ready tasks now (see cq focus)');
  queue.focus = focus;
  return { error: [], warnings, focus };
}

/** Removes the focus (queue.mjs focus off). Returns the old one, or null. */
function removeFocus(queue) {
  const oldOne = queue.focus ?? null;
  delete queue.focus;
  return oldOne;
}

/** At most this many stages and pause changes in one plan from the board. */
const FOCUS_PLAN_MAX = 50;

/**
 * Saves the plan view from the board (queue.mjs focus save) in ONE change, all or nothing:
 *   - focus: { order, now_count?, rest?, to?, name?, drag_with_dependencies?, set_by? } like setFocus;
 *     empty order = the focus is removed (like focus off);
 *   - the "Waiting" column in the plan: `pause` (projects that are paused) and `continue` (taken off pause).
 * The pause changes are made before the focus is checked, so the warnings (paused projects in a stage, no ready ones) apply to the queue
 * as it will be. Changes `queue` only when the error list is empty.
 * @returns {{ error: string[], warnings: string[], focus?: object|null, removed?: boolean, paused?: string[],
 *   still?: string[] }}
 */
function saveFocusPlan(queue, input, now = new Date().toISOString()) {
  const error = [];
  const order = Array.isArray(input?.order) ? input.order : null;
  if (!order) error.push('order must be a list (empty = no focus)');
  const pause = Array.isArray(input?.pause) ? [...new Set(input.pause.map(String))] : [];
  const proceed = Array.isArray(input?.continue) ? [...new Set(input.continue.map(String))] : [];
  if (
    (order?.length ?? 0) > FOCUS_PLAN_MAX ||
    pause.length + proceed.length > FOCUS_PLAN_MAX
  )
    error.push(`at most ${FOCUS_PLAN_MAX} stages and ${FOCUS_PLAN_MAX} pause changes`);
  const register = { ...(queue.projects ?? {}) };
  for (const pid of [...pause, ...proceed])
    if (!Object.hasOwn(register, pid))
      error.push(`unknown project ${pid} (only projects in the register can be paused)`);
  const both = pause.filter((pid) => proceed.includes(pid));
  if (both.length) error.push(`${both.join(', ')} appears in both pause and continue`);
  if (error.length) return { error, warnings: [] };

  const paused = [];
  const still = [];
  for (const pid of pause) {
    if (register[pid].pause === true) continue;
    register[pid] = { ...register[pid], pause: true };
    paused.push(pid);
  }
  for (const pid of proceed) {
    if (register[pid].pause !== true) continue;
    const p = { ...register[pid] };
    delete p.pause;
    register[pid] = p;
    still.push(pid);
  }
  // The trial: the same queue with the new register, so the warnings are computed on the queue as it will be.
  const trial = { ...queue, projects: register };
  let focus = null;
  let warnings = [];
  if (order.length) {
    const s = setFocus(trial, input, now);
    if (s.error.length) return { error: s.error, warnings: s.warnings };
    focus = s.focus;
    warnings = s.warnings;
  }
  const removed = !order.length && !!queue.focus;
  if (paused.length || still.length) queue.projects = register;
  if (focus) queue.focus = focus;
  else delete queue.focus;
  return { error: [], warnings, focus, removed, paused, still };
}

/**
 * Focus status for `focus`, `state` and `show`: what is in focus, what is ready, how many are pulled along,
 * and the warning when the period is over or the focus has nothing ready (with notice).
 * null when no focus is set.
 * @param {{ now?: number, canStart?: string[], context?: object }} [option]
 */
function focusStatus(queue, { now = Date.now(), canStart = null, context = null } = {}) {
  if (!queue?.focus) return null;
  const k = context ?? rankingContext(queue, now);
  const f = queue.focus;
  const name = f.name ? ` "${f.name}"` : '';
  const tasks = (queue.tasks ?? []).filter((o) => !isExternalRow(o));
  const out = {
    name: f.name ?? null,
    text: focusText(queue),
    order: f.order ?? [],
    rest: f.rest === 'fill' ? 'fill' : 'wait',
    to: f.to ?? null,
    active: k.applies,
    expired: k.expired,
    not_started: k.notStarted,
    in_focus: 0,
    readyOnes: 0,
    inProgress: 0,
    can_start: 0,
    dragged_with: k.dragged.size,
    per_step: (f.order ?? []).map((t) => ({ stage: t, waiting: 0, readyOnes: 0, min_left: 0 })),
    ownerQuestion: [],
    notice: null,
  };
  if (k.expired) {
    out.notice =
      `Focus period${name} is over (until ${utcText(f.to)}). The queue is ranked as without focus until it is changed: ` +
      'cq focus set … or cq focus off.';
    return out;
  }
  if (!k.applies) return out;
  const can = new Set(canStart ?? []);
  const sp = new Map();
  for (const o of tasks) {
    const p = focusSpace(o, k);
    if (p.step == null) continue;
    if (['running', 'review', 'picked'].includes(o.status)) {
      out.inProgress += 1;
      continue;
    }
    if (o.status !== 'waiting' || isBatched(o) || p.parked || p.paused) continue;
    const row = out.per_step[p.step];
    out.in_focus += 1;
    row.waiting += 1;
    row.min_left += estimate(o);
    if (blockers(o, queue.tasks ?? [], queue.resolved).length === 0) {
      out.readyOnes += 1;
      row.readyOnes += 1;
    }
    if (can.has(o.id)) out.can_start += 1;
    for (const s of openQuestion(o, queue.resolved)) sp.set(s, (sp.get(s) ?? 0) + 1);
  }
  out.ownerQuestion = [...sp.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([s, n]) => ({ sp: s, tasks: n }));
  if (out.readyOnes === 0) {
    const first = out.ownerQuestion[0];
    const answer = first
      ? ` Answering ${first.sp} unlocks ${first.tasks} task(s) in focus.`
      : '';
    const rest =
      out.rest === 'wait'
        ? ' The rest waits, so free slots stay empty until the focus has ready work or is changed (cq focus).'
        : ' The rest fills free slots (rest: fill).';
    out.notice =
      out.in_focus === 0 && out.inProgress === 0
        ? `Focus${name} is empty: nothing left in the stages.${rest}`
        : `Nothing ready in focus${name}${out.inProgress ? ` (${out.inProgress} in progress)` : ''}.${answer}${rest}`;
  }
  return out;
}

// ---- Done focus stages are evaluated and taken out ------------------------------------------------------------------
//
// The focus should only show stages that still have tasks in them. A stage is evaluated (evaluateFocusStep) to:
//   active           open tasks: waiting (also parked and paused ones), running, picked, review;
//   done-with-rests  0 open, but rests: batch queue tasks, proposals, tasks that ONLY wait on owner questions, and
//                    done tasks with QA still waiting on the owner. Each rest gets a suggestion, and the stage stays
//                    until they are settled;
//   done             0 open and 0 rests (also a stage that never had anything).
// cleanFocus takes out the stages with status done, records it in focus.history and in the changelog (changes with
// `focus: true`, undone with queue.mjs undo). The last stage is never taken out by itself: a focus without stages
// means "no focus" (everything in the queue can start), and that choice belongs to the owner (focus set … or focus off).
// Runs from queue.mjs focus clean, and automatically in receive, set <id> done|cancelled and fill. The board shows
// the queue as if the cleaning was done (focusWithoutDone), so done stages are never shown.

/** At most this many entries in focus.history (the oldest fall out). */
const FOCUS_HISTORY_MAX = 50;
/** The statuses that are open work in a stage (waiting is counted separately, see evaluateFocusStep). */
const FOCUS_OPEN_ACTIVE = new Set(['running', 'picked', 'review']);

/** The suggestion for what to do with a rest. */
function restSuggestion(type, o, sp = []) {
  if (type === 'batched')
    return `pack the batch queue (cq batch pack ${o.id} … --id <new-id>, or cq batch pack --auto)`;
  if (type === 'proposed')
    return `ask the owner for a yes on the proposal (cq approve ${o.id}), otherwise cancel it`;
  if (type === 'question') return `owner question ${sp.join(', ')} unlocks it`;
  return 'QA with the owner (cq qa)';
}

/**
 * Evaluates each focus stage. A task belongs to the stage it is dragged into, otherwise its own (the most specific,
 * ownStep). Pure function; changes nothing.
 * @returns {{ index: number, stage: string, title: string, open: number, ready: number, min_left: number,
 *   rests: { type: 'batched'|'proposed'|'question'|'qa', id: string, title: string|null, sp?: string[],
 *   suggestion: string }[], status: 'active'|'done-with-rests'|'done' }[]}
 */
function evaluateFocusStep(queue, now = Date.now()) {
  const order = queue?.focus?.order ?? [];
  const out = order.map((t, i) => ({
    index: i,
    stage: t,
    title: stepTitle(t, queue),
    open: 0,
    ready: 0,
    min_left: 0,
    rests: [],
    status: 'done',
  }));
  if (!out.length) return out;
  const tasks = queue.tasks ?? [];
  const k = rankingContext(queue, now);
  return withIndex(tasks, () => {
    for (const o of tasks) {
      if (!o || isExternalRow(o) || o.status === 'cancelled') continue;
      if (o.status === 'done' && o.qa_status !== 'waiting') continue;
      const step = k.dragged.get(o.id)?.stage ?? ownStep(o, queue);
      if (step == null) continue;
      const row = out[step];
      const rest = (type, sp) =>
        row.rests.push({
          type,
          id: o.id,
          title: o.title ?? null,
          ...(sp ? { sp } : {}),
          suggestion: restSuggestion(type, o, sp ?? []),
        });
      if (o.status === 'done') rest('qa');
      else if (o.status === 'proposed') rest('proposed');
      else if (o.status === 'waiting' && isBatched(o)) rest('batched');
      else if (o.status === 'waiting') {
        const h = blockerParts(o, tasks, queue.resolved);
        if (h.length && h.every((x) => x.type === 'question'))
          rest(
            'question',
            h.map((x) => x.sp),
          );
        else {
          row.open += 1;
          row.min_left += estimate(o);
          if (!h.length) row.ready += 1;
        }
      } else if (FOCUS_OPEN_ACTIVE.has(o.status)) row.open += 1;
    }
    for (const row of out)
      row.status = row.open ? 'active' : row.rests.length ? 'done-with-rests' : 'done';
    return out;
  });
}

/**
 * The focus without the stages with status done (pure; does not change `queue`). The first stage is kept when all
 * are done (see the top of the section). `now_count` (the plan view's "Now") is lowered by the stages taken out in
 * front of the limit.
 * @returns {{ evaluation: object[], focus: object|null, taken_out: object[], kept: object|null }} focus = null when
 *   nothing is taken out
 */
function focusWithoutDone(queue, now = Date.now()) {
  const evaluation = evaluateFocusStep(queue, now);
  const done = evaluation.filter((t) => t.status === 'done');
  let kept = null;
  let out = done;
  if (done.length && done.length === evaluation.length) {
    kept = done[0];
    out = done.slice(1);
  }
  if (!out.length) return { evaluation, focus: null, taken_out: [], kept };
  const gone = new Set(out.map((t) => t.index));
  const f = queue.focus;
  const focus = { ...f, order: f.order.filter((_, i) => !gone.has(i)) };
  if (f.now_count != null) {
    const before = out.filter((t) => t.index < f.now_count).length;
    focus.now_count = Math.min(Math.max(f.now_count - before, 1), focus.order.length);
  }
  return { evaluation, focus, taken_out: out, kept };
}

/**
 * Takes out the done focus stages (queue.mjs focus clean, and automatically in receive, set and fill). Each removal
 * is recorded in focus.history ({ at, by, action: 'taken out', stage, title }) and as one entry in the changelog, so
 * queue.mjs undo works. `dry` computes without changing anything.
 * @returns {{ evaluation: object[], taken_out: { stage: string, title: string }[], with_rests: object[],
 *   kept: object|null, changes: object[], entry: object|null }}
 */
function cleanFocus(queue, { by = null, now = new Date().toISOString(), dry = false } = {}) {
  const empty = {
    evaluation: [],
    taken_out: [],
    with_rests: [],
    kept: null,
    changes: [],
    entry: null,
  };
  if (!queue?.focus?.order?.length) return empty;
  const r = focusWithoutDone(queue, Date.parse(now));
  const answer = {
    evaluation: r.evaluation,
    taken_out: r.taken_out.map((t) => ({ stage: t.stage, title: t.title })),
    with_rests: r.evaluation.filter((t) => t.status === 'done-with-rests'),
    kept: r.kept,
    changes: [],
    entry: null,
  };
  if (!r.focus) return answer;
  const who = String(by ?? '').trim() || 'unknown';
  const history = [
    ...(Array.isArray(queue.focus.history) ? queue.focus.history : []),
    ...answer.taken_out.map((t) => ({ at: now, by: who, action: 'taken out', ...t })),
  ].slice(-FOCUS_HISTORY_MAX);
  const after = { ...r.focus, history };
  for (const field of ['order', 'now_count', 'history'])
    if (!equalValue(queue.focus[field], after[field]))
      answer.changes.push({
        focus: true,
        field,
        before: cloneJson(queue.focus[field] ?? null),
        after: cloneJson(after[field] ?? null),
      });
  if (dry) return answer;
  queue.focus = after;
  answer.entry = logChange(queue, { by: who, action: 'focus clean', changes: answer.changes, now });
  return answer;
}

/** One rest in plain text: "SEC-1 proposed → ask the owner for a yes …". */
function restText(r) {
  return `${r.id} ${r.type}${r.sp ? ` (${r.sp.join(', ')})` : ''} → ${r.suggestion}`;
}

/** The suggestion per rest type in the short line (the one per rest is in focus evaluate). */
const REST_GROUP_SUGGESTION = {
  batched: 'pack the batch queue (cq batch pack --auto)',
  proposed: 'ask the owner for a yes (cq approve <id>) or cancel',
  question: 'the answer unlocks it',
  qa: 'QA with the owner (cq qa)',
};

/** The rests grouped per type, short: "proposed 2 (SEC-1, SEC-2) → ask …; qa 1 (SK-2) → QA with the owner". */
function restGroupText(rests, maxId = 4) {
  const groups = new Map();
  for (const r of rests ?? []) {
    if (!groups.has(r.type)) groups.set(r.type, []);
    groups.get(r.type).push(r.sp ? `${r.id}: ${r.sp.join(', ')}` : r.id);
  }
  return [...groups]
    .map(([type, ids]) => {
      const show = ids.slice(0, maxId).join(', ');
      const more = ids.length > maxId ? `, +${ids.length - maxId}` : '';
      return `${type} ${ids.length} (${show}${more}) → ${REST_GROUP_SUGGESTION[type] ?? '?'}`;
    })
    .join('; ');
}

/**
 * The lines after a cleaning (queue.mjs focus clean and the automatic one in receive, set and fill): one per stage
 * taken out, one per stage that is done with rests (the rests and suggestions; the orchestrator puts them to the owner
 * at the end of the round), and one when the last stage is done and stays.
 */
function focusCleanLines(r) {
  const lines = [];
  const tnr = new Map((r?.evaluation ?? []).map((t) => [t.stage, t.index + 1]));
  for (const t of r?.taken_out ?? [])
    lines.push(
      `Focus stage T${tnr.get(t.stage) ?? '?'} ${t.title} (${t.stage}) done and taken out (undo: cq undo)`,
    );
  for (const t of r?.with_rests ?? [])
    lines.push(
      `Focus stage T${t.index + 1} ${t.title} done with rests (${t.rests.length}): ` +
        `${restGroupText(t.rests)}. Details: cq focus evaluate`,
    );
  if (r?.kept)
    lines.push(
      `Focus stage T${r.kept.index + 1} ${r.kept.title} is done, and all stages are done: set a new focus ` +
        '(cq focus set …) or cq focus off.',
    );
  return lines;
}

/**
 * Creates, changes or deletes an area (queue.mjs area). field: { title?, description?, projects?: [pid],
 * remove?: [pid], delete?: true }. `projects` sets the projects' `area` (a project belongs to one area, so it
 * is moved from another). Deletion is refused when a project or the focus uses the area. All or nothing.
 * @returns {{ error: string[], new?: boolean, deleted?: boolean, area?: object, moved?: string[], removed?: string[] }}
 */
function setArea(queue, oid, field = {}) {
  const error = [];
  if (!PID_PATTERN.test(String(oid ?? '')) || oid === WITHOUT_AREA)
    return { error: [`area id ${oid} must be short kebab-case (and not ${WITHOUT_AREA})`] };
  const areas = { ...(queue.areas ?? {}) };
  const register = { ...(queue.projects ?? {}) };
  const exists = Object.hasOwn(areas, oid);
  if (field.delete) {
    if (!exists) return { error: [`unknown area ${oid}`] };
    const users = Object.entries(register)
      .filter(([, p]) => p?.area === oid)
      .map(([pid]) => pid);
    if (users.length)
      error.push(
        `${oid} is used by ${users.join(', ')} (move them first: cq area ${oid} --remove …)`,
      );
    if ((queue.focus?.order ?? []).includes(`area:${oid}`))
      error.push(`${oid} is in the focus (edit the focus first: cq focus set … or focus off)`);
    if (error.length) return { error };
    delete areas[oid];
    queue.areas = areas;
    return { error: [], deleted: true };
  }
  const o = { ...(areas[oid] ?? {}) };
  if (field.title != null) o.title = String(field.title).trim();
  if (field.description === null) delete o.description;
  else if (field.description != null) o.description = String(field.description).trim();
  if (typeof o.title !== 'string' || !o.title) error.push(`${oid}: title missing (--title "…")`);
  else if (o.title.length > FOCUS_MAX_TEXT) error.push(`${oid}: the title is too long`);
  const moved = [];
  for (const pid of field.projects ?? []) {
    if (!Object.hasOwn(register, pid)) {
      error.push(`unknown project ${pid}`);
      continue;
    }
    register[pid] = { ...register[pid], area: oid };
    moved.push(pid);
  }
  const removed = [];
  for (const pid of field.remove ?? []) {
    if (register[pid]?.area !== oid) {
      error.push(`${pid} does not belong to ${oid}`);
      continue;
    }
    const p = { ...register[pid] };
    delete p.area;
    register[pid] = p;
    removed.push(pid);
  }
  if (error.length) return { error };
  areas[oid] = o;
  queue.areas = areas;
  if (moved.length || removed.length) queue.projects = register;
  return { error: [], new: !exists, area: o, moved, removed };
}

/**
 * Overview per area for `queue.mjs areas`: projects, pending, ready ones (no blockers now, not parked), minutes
 * left, active ones and parked. The register's order, unknown areas (a project points to an area that does not exist)
 * alphabetically, `without-area` last.
 */
function areaOverview(queue, now = Date.now()) {
  const areas = queue.areas ?? {};
  const tasks = (queue.tasks ?? []).filter((o) => !isExternalRow(o));
  const rows = new Map();
  const row = (oid) => {
    if (!rows.has(oid))
      rows.set(oid, {
        oid,
        title: areas[oid]?.title ?? null,
        description: areas[oid]?.description ?? null,
        in_register: Object.hasOwn(areas, oid),
        projects: [],
        waiting: 0,
        readyOnes: 0,
        parked: 0,
        activeOnes: 0,
        min_left: 0,
      });
    return rows.get(oid);
  };
  for (const oid of Object.keys(areas)) row(oid);
  for (const p of projectOverview(queue)) {
    const oid = areaFor({ project: p.pid }, queue);
    row(oid).projects.push(p.pid);
  }
  for (const o of tasks) {
    if (!openTask(o) || o.status === 'proposed') continue;
    const r = row(areaFor(o, queue));
    r.min_left += estimate(o);
    if (o.status === 'running' || o.status === 'review' || o.status === 'picked') r.activeOnes += 1;
    if (o.status !== 'waiting' || isBatched(o)) continue;
    r.waiting += 1;
    if (parkedNow(o, now)) r.parked += 1;
    else if (blockers(o, queue.tasks ?? [], queue.resolved).length === 0) r.readyOnes += 1;
  }
  const inRegister = Object.keys(areas);
  const unknown = [...rows.keys()]
    .filter((x) => !inRegister.includes(x) && x !== WITHOUT_AREA)
    .sort((x, y) => x.localeCompare(y, 'en'));
  return [...inRegister, ...unknown, ...(rows.has(WITHOUT_AREA) ? [WITHOUT_AREA] : [])].map((oid) =>
    rows.get(oid),
  );
}

/**
 * Parks tasks ("put on hold", queue.mjs park). Only `waiting` and `proposed` can be parked. `to` (YYYY-MM-DD or
 * ISO) must be in the future. Warns when a task is pulled along by something in the focus (then the focus task waits too). All or
 * nothing; a parked task can be parked again (reason and date are updated).
 * @returns {{ error: string[], parked?: string[], warnings?: string[] }}
 */
function park(queue, ids, { by, reason = null, to = null, now = new Date().toISOString() } = {}) {
  const error = [];
  const nowMs = Date.parse(now);
  const list = [...new Set(ids ?? [])];
  if (!list.length) error.push('park <id> …');
  const who = String(by ?? '').trim() || 'unknown';
  const g = reason == null ? null : String(reason).trim();
  if (g && g.length > FOCUS_MAX_TEXT)
    error.push(`the reason can be at most ${FOCUS_MAX_TEXT} characters`);
  let toIso = null;
  if (to != null && to !== '') {
    toIso = parseToDate(to);
    if (!toIso) error.push(`invalid date ${to} (use YYYY-MM-DD or ISO time)`);
    else if (Date.parse(toIso) <= nowMs) error.push(`the date ${to} has passed`);
  }
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const selected = [];
  for (const id of list) {
    const o = perId.get(id);
    if (!o || isExternalRow(o)) error.push(`unknown task ${id}`);
    else if (o.status !== 'waiting' && o.status !== 'proposed')
      error.push(`${id}: status ${o.status} (only waiting and proposed can be parked)`);
    else selected.push(o);
  }
  if (error.length) return { error };
  const warnings = [];
  const k = rankingContext(queue, nowMs);
  for (const o of selected) {
    const d = k.dragged.get(o.id);
    if (d && !list.includes(d.by))
      warnings.push(
        `${o.id} is pulled along by ${d.by} in the focus (stage ${d.stage + 1}); it waits until ${o.id} continues`,
      );
  }
  for (const o of selected)
    o.parked = {
      by: who,
      at: now,
      ...(g ? { reason: g } : {}),
      ...(toIso ? { to: toIso } : {}),
    };
  return { error: [], parked: selected.map((o) => o.id), warnings };
}

/**
 * Takes tasks off hold (queue.mjs continue). Unknown ids are errors (nothing is changed); one that was not parked is reported.
 * @returns {{ error: string[], still?: string[], notParked?: string[] }}
 */
function proceed(queue, ids) {
  const list = [...new Set(ids ?? [])];
  if (!list.length) return { error: ['continue <id> …'] };
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const error = list.filter((id) => !perId.has(id)).map((id) => `unknown task ${id}`);
  if (error.length) return { error };
  const still = [];
  const notParked = [];
  for (const id of list) {
    const o = perId.get(id);
    if (o.parked) {
      delete o.parked;
      still.push(id);
    } else notParked.push(id);
  }
  return { error: [], still, notParked };
}

/** Normalizes a path: slashes, no leading ./. */
function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Do two file ownerships overlap? An entry that ends in "/" owns the whole folder.
 * Exact path otherwise. (Deliberately simple: glob patterns would give false security.)
 */
function fileOverlap(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x.endsWith('/') && y.startsWith(x)) return true;
  if (y.endsWith('/') && x.startsWith(y)) return true;
  return false;
}

/**
 * First conflict between a candidate and an active task, with the details (the guard rules on the board need
 * who and what, not just the text), or null.
 * @returns {{ type: 'file'|'db'|'patch', name: string, with: string, text: string } | null}
 */
function conflictPart(candidate, active) {
  // A record outside the queue (external add) is named after the session or person, so the blocker says who is working.
  // The text is built only when there actually is a conflict (conflictPart is called for every pair).
  const ownerText = () =>
    isExternalRow(active)
      ? `${active.id} (work outside the queue: ${active.external_name ?? '?'})`
      : active.id;
  for (const f of candidate.owned_files ?? []) {
    for (const g of active.owned_files ?? []) {
      if (fileOverlap(f, g))
        return {
          type: 'file',
          name: norm(f),
          with: active.id,
          text: `file ${norm(f)} is owned by ${ownerText()}`,
        };
    }
  }
  // The sets are built only when the candidate has something to compare (most have empty lists).
  const dbCandidate = candidate.owner_db ?? [];
  const dbActive = dbCandidate.length
    ? new Set((active.owner_db ?? []).map((s) => s.toLowerCase()))
    : null;
  for (const d of dbCandidate) {
    if (dbActive.has(d.toLowerCase()))
      return {
        type: 'db',
        name: d,
        with: active.id,
        text: `DB function ${d} is owned by ${ownerText()}`,
      };
  }
  // One dynamic patch of each shared function at a time (e.g. a common export or anonymization function).
  const patchCandidate = candidate.shared_patch ?? [];
  const patchActive = patchCandidate.length
    ? new Set((active.shared_patch ?? []).map((s) => s.toLowerCase()))
    : null;
  for (const d of patchCandidate) {
    if (patchActive.has(d.toLowerCase()))
      return {
        type: 'patch',
        name: d,
        with: active.id,
        text: `shared patch ${d} in progress in ${active.id}`,
      };
  }
  return null;
}

/** First conflict between a candidate and an active task (as text), or null. */
function conflict(candidate, active) {
  return conflictPart(candidate, active)?.text ?? null;
}

/**
 * The blockers with details: [{ type, text, … }], where `text` is exactly what `blockers` gives. The types:
 * status (proposed, picked or another status), depends_on { id, status } (status null = unknown task),
 * question { sp }, and conflict { conflict: conflictPart }. (The limits are checked in selectNext.)
 */
function blockerParts(o, tasks, resolved = []) {
  if (o.status === 'proposed')
    return [{ type: 'status', text: `proposed (approve it first: cq approve ${o.id})` }];
  if (o.status === 'picked')
    return [{ type: 'status', text: `picked by ${o.picked_by ?? '?'}` }];
  if (o.status !== 'waiting') return [{ type: 'status', text: `status ${o.status}` }];
  // A task in the batch queue is never started or picked alone; it is packed into a track (queue.mjs batch pack).
  if (isBatched(o)) return [{ type: 'batched', text: BATCHED_BLOCKER }];
  const h = [];
  const perId = perIdFor(tasks);
  for (const dep of o.depends_on ?? []) {
    const d = perId.get(dep);
    if (!d) h.push({ type: 'depends_on', id: dep, status: null, text: `depends on unknown ${dep}` });
    else if (d.status !== 'done')
      h.push({
        type: 'depends_on',
        id: dep,
        status: d.status,
        text: `waiting on ${dep} (${d.status})`,
      });
  }
  const resolvedSet = new Set(resolved);
  for (const sp of o.waiting_on ?? []) {
    if (!resolvedSet.has(sp)) h.push({ type: 'question', sp, text: `waiting on answer: ${sp}` });
  }
  // Copy, so a caller that changes a blocker never changes the buffered answer (conflictsWithActive).
  for (const k of conflictsWithActive(o, tasks))
    h.push({ type: 'conflict', conflict: { ...k }, text: k.text });
  return h;
}

/**
 * The conflicts between the candidate and each active task (conflictPart), in the order of the active ones. The board
 * asks blockerParts for the same card from several views (the card, nextUp, the plan basis, the areas, selectNext),
 * and each call walked all the active ones again. Inside withIndex the answer is therefore computed once per candidate
 * and reused (same condition as the rest of the fast index: the queue does not change while fn runs). Outside the
 * index it is computed again.
 */
function conflictsWithActive(o, tasks) {
  const ix = indexFor(tasks);
  if (ix) {
    ix.conflicts ??= new Map();
    const stored = ix.conflicts.get(o);
    if (stored) return stored;
  }
  const out = [];
  for (const a of activeFor(tasks)) {
    const k = conflictPart(o, a);
    if (k) out.push(k);
  }
  if (ix) ix.conflicts.set(o, out);
  return out;
}

/** Why can the task not be started now? Empty list = it can. (The limits are checked in selectNext.) */
function blockers(o, tasks, resolved = []) {
  return blockerParts(o, tasks, resolved).map((h) => h.text);
}

// ---- The fast index ------------------------------------------------------------------------------------------------
// blockerParts, successors and score were called once per card, and each call built the lookups for the WHOLE queue
// again (the id map, the active ones, childrenMap and the transitive successor list). With 3 000 tasks the board was
// then quadratic (close to a minute). withIndex(tasks, fn) lets fn use lookups that are built ONCE and reused, but only
// for exactly this task list and only while fn runs: outside (and for another list) everything is built again as
// before, so a mutation of the queue (queue.mjs changes status, depends_on …) can never meet a stale lookup. The
// requirement on fn is therefore that it does not change the tasks (the list, status or depends_on) or the project
// register while it runs; the board and the views only read. (The variable fastIndex is declared at the top, before
// projectFor.)

/**
 * Run fn with the fast index for `tasks` (see above). Nested calls reuse the outer index. Synchronous fn only.
 * @template T
 * @param {object[]} tasks
 * @param {() => T} fn
 * @returns {T}
 */
function withIndex(tasks, fn) {
  if (fastIndex) return fn();
  fastIndex = {
    tasks,
    perId: null,
    active: null,
    children: null,
    after: new Map(),
    project: null,
    conflicts: null,
  };
  try {
    return fn();
  } finally {
    fastIndex = null;
  }
}

/** The index when it applies to exactly this list, otherwise null. */
function indexFor(tasks) {
  return fastIndex && fastIndex.tasks === tasks ? fastIndex : null;
}

/** id → task (from the index when it applies; otherwise a new map). */
function perIdFor(tasks) {
  const ix = indexFor(tasks);
  if (!ix) return new Map(tasks.map((x) => [x.id, x]));
  ix.perId ??= new Map(tasks.map((x) => [x.id, x]));
  return ix.perId;
}

/** The tasks with an active status (ACTIVE), in queue order (from the index when it applies). */
function activeFor(tasks) {
  const ix = indexFor(tasks);
  if (!ix) return tasks.filter((x) => ACTIVE.has(x.status));
  ix.active ??= tasks.filter((x) => ACTIVE.has(x.status));
  return ix.active;
}

/** The successors per task: id → the ids that have it in `depends_on` (for successors; build it once for many calls). */
function childrenMap(tasks) {
  const ix = indexFor(tasks);
  if (ix) {
    ix.children ??= buildChildrenMap(tasks);
    return ix.children;
  }
  return buildChildrenMap(tasks);
}

function buildChildrenMap(tasks) {
  const children = new Map();
  for (const o of tasks) {
    for (const d of o.depends_on ?? []) {
      if (!children.has(d)) children.set(d, []);
      children.get(d).push(o.id);
    }
  }
  return children;
}

/**
 * Tasks that wait on this one, directly or indirectly (transitively through `depends_on`), and that still need doing
 * (not done or cancelled). Cycles are tolerated (each task is visited once), and the task itself is never included.
 * The same count as the bonus in the priority (lockUpCount) and "unlocks N" on the board.
 * @param {Map<string, string[]>} [children] childrenMap(tasks), when many tasks are looked up
 * @returns {string[]} the ids in the order they were found
 */
function successors(id, tasks, children) {
  // With the fast index (and the index's own childrenMap) each id is computed only once; the copy protects against the
  // caller sorting or changing the list (unlocksOf on the board sorts it).
  const ix = indexFor(tasks);
  if (ix && (children === undefined || children === childrenMap(tasks))) {
    if (!ix.after.has(id)) ix.after.set(id, computeSuccessors(id, tasks, childrenMap(tasks)));
    return [...ix.after.get(id)];
  }
  return computeSuccessors(id, tasks, children ?? childrenMap(tasks));
}

function computeSuccessors(id, tasks, children) {
  const set = new Set();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const x = stack.pop();
    if (set.has(x) || x === id) continue;
    set.add(x);
    stack.push(...(children.get(x) ?? []));
  }
  // Only tasks that still need doing count.
  const perId = perIdFor(tasks);
  return [...set].filter((x) => !['done', 'cancelled'].includes(perId.get(x)?.status));
}

/** How many tasks (directly or indirectly) wait on this one? Gives a bonus for unlocking others. */
function lockUpCount(id, tasks) {
  return successors(id, tasks).length;
}

/**
 * Priority: value per estimated minute, with a bonus for tasks that unlock others and a small
 * age bonus so nothing sits still forever. Manual `priority_bonus` (±) from reprioritizing, plus
 * the project's `priority_bonus` from the register (when `register` is given).
 */
function score(o, tasks, now = Date.now(), register) {
  return scoreParts(o, tasks, now, register).score;
}

/**
 * The parts the priority (score) is computed from, for "Placement" in the detail panel on the board: value, the minutes
 * used (at least 5), unlocks N (+25 % each), age in days (+2 % per day, at most 14), the task's and the project's
 * bonus, and the result. score() is just `.score` from here, so the explanation can never drift from the number.
 * @returns {{ value: number, minutes: number, unlocks: number, lock_factor: number, days: number,
 *   age_factor: number, reason: number, bonus: number, project_bonus: number, score: number }}
 */
function scoreParts(o, tasks, now = Date.now(), register) {
  const value = Number(o.value ?? 5);
  const time = Math.max(estimate(o), 5);
  const lockState = lockUpCount(o.id, tasks);
  const days = o.added_at ? Math.max(0, (now - Date.parse(o.added_at)) / 86_400_000) : 0;
  const lockFactor = 1 + 0.25 * lockState;
  const ageFactor = 1 + Math.min(days, 14) * 0.02;
  const s = (value / time) * 100 * lockFactor * ageFactor;
  const projectBonus = register
    ? Number(register[projectFor(o, register)]?.priority_bonus) || 0
    : 0;
  const bonus = Number(o.priority_bonus ?? 0);
  return {
    value,
    minutes: time,
    unlocks: lockState,
    lock_factor: lockFactor,
    days: Math.round(days * 10) / 10,
    age_factor: Math.round(ageFactor * 1000) / 1000,
    reason: Math.round(s * 100) / 100,
    bonus,
    project_bonus: projectBonus,
    score: Math.round((s + bonus + projectBonus) * 100) / 100,
  };
}

/**
 * Selects tasks that can be started now, in ranked order, within the limits.
 * The candidates are also checked against each other: two chosen tasks cannot own the same thing.
 * Projects with `pause` are skipped, and the project's `priority_bonus` is added to the task's priority.
 * A picked task (person/session) owns its files and counts toward maxDb and maxPerDomain (it is tested and merged
 * like a track), but not toward maxConcurrent/maxDPlus, which apply to the queue's agents.
 * `uncommitted`: the paths `git status` shows in the main tree. A task that owns one of them is skipped (another
 * session is working in the file); `uncommittedSkipped` says which and why.
 */
/** Does the task have migrations (counts toward maxDb)? */
const hasMigr = (o) => Number(o.migr_tens ?? 0) > 0;

/**
 * The slots in use now, with the same rules as selectNext: agents (running and review without picked_by) toward maxConcurrent and
 * maxDPlus; all that own something (active ones, not records outside the queue) toward maxDb and maxPerDomain.
 * @returns {{ limits: object, agents: number, available: number, dPlus: number, db: number, perDomain: Map<string, number> }}
 */
function spaceUse(queue) {
  const tasks = queue.tasks ?? [];
  const g = { ...DEFAULT_LIMITS, ...(queue.limits ?? {}) };
  // Records outside the queue own files (blockers), but take no slot within the limits.
  const owners = tasks.filter((o) => ACTIVE.has(o.status) && !isExternalRow(o));
  const agents = tasks.filter(counterAsAgent);
  const perDomain = new Map();
  for (const a of owners) perDomain.set(a.domain, (perDomain.get(a.domain) ?? 0) + 1);
  return {
    limits: g,
    agents: agents.length,
    available: g.maxConcurrent - agents.length,
    dPlus: agents.filter((o) => o.class === 'D+').length,
    db: owners.filter(hasMigr).length,
    perDomain,
  };
}

function selectNext(queue, now = Date.now(), { uncommitted = [] } = {}) {
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const use = spaceUse(queue);
  const g = use.limits;
  let { available, dPlus, db } = use;
  const perDomain = use.perDomain;

  // Common ranking (parked, paused and outside focus are out; then focusStep, score, id). Without focus and
  // without parked this is exactly the old filter (pause) and the old sorting (score, id).
  const k = rankingContext(queue, now);
  const candidates = tasks
    .filter(
      (o) =>
        o.status === 'waiting' &&
        blockers(o, tasks, queue.resolved).length === 0 &&
        !uncommittedCollision(o, uncommitted),
    )
    .map((o) => ({ o, r: ranking(o, queue, k) }))
    .filter((x) => !x.r.out)
    .sort(compareRanking)
    .map(({ o, r }) => ({ o, s: r.score, r }));

  const selected = [];
  for (const { o, s, r } of candidates) {
    if (available <= 0) break;
    if (o.class === 'D+' && dPlus >= g.maxDPlus) continue;
    if (hasMigr(o) && db >= g.maxDb) continue;
    if ((perDomain.get(o.domain) ?? 0) >= g.maxPerDomain) continue;
    if (selected.some((v) => conflict(o, v.o) || conflict(v.o, o))) continue;
    selected.push({ o, s, r });
    available -= 1;
    if (o.class === 'D+') dPlus += 1;
    if (hasMigr(o)) db += 1;
    perDomain.set(o.domain, (perDomain.get(o.domain) ?? 0) + 1);
  }
  return selected.map(({ o, s, r }) => ({
    id: o.id,
    score: s,
    estimate: estimate(o),
    class: o.class,
    domain: o.domain,
    project: projectFor(o, register),
    // Only when the focus applies (otherwise the same row as before): the stage (0-based, null = rest with `fill`) and pulled along.
    ...(k.applies ? { step: r.step, dragged_by: r.dragged_by } : {}),
  }));
}

/**
 * Assigns the next free migration block. A task with `migr_tens` > 0 gets that many blocks of `size` numbers
 * (config().migrations.blockSize, default 10), and the block starts on a whole multiple of the size.
 * Blocks in `taken` (takenBlocks: a migration file, the block of a task that is not finished, or a block named in an
 * active prompt file, e.g. after a move by hand) are skipped, and `skipped` lists them. Without `taken` the answer is
 * the same as before.
 * Returns { from, to, nextAvailable, skipped? }.
 */
function assignMigrBlock(nextAvailable, tens, size = 10, taken = []) {
  if (!tens || tens <= 0) return { from: null, to: null, nextAvailable };
  const s = Number(size) > 0 ? Math.floor(Number(size)) : 10;
  let from = Math.ceil(nextAvailable / s) * s;
  const skipped = [];
  for (;;) {
    const to = from + tens * s - 1;
    const hit = taken.filter((t) => t.from <= to && t.to >= from);
    if (!hit.length) return { from, to, nextAvailable: to + 1, ...(taken.length ? { skipped } : {}) };
    skipped.push(...hit);
    from = Math.ceil((Math.max(...hit.map((t) => t.to)) + 1) / s) * s;
  }
}

/**
 * How many migration blocks the task should have: `migr_tens`, but 0 when the project has no migration flow
 * (config().migrations.folder is null). Then no task gets a block, and nothing is blocked by migrations.
 */
function migrTens(o, migrations = cfg().migrations) {
  if (!migrations?.folder) return 0;
  const t = Number(o?.migr_tens ?? 0);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

// ---- Taken migration blocks ----------------------------------------------------------------------------------
// `fill` could hand out a block that a running track already had: the orchestrator moved the block by hand in the
// prompt file, but the queue (migr_block) and next_migr did not know, so the next fill got the same block. Free now
// means: not a migration file in migrations.folder, not the block of a task that is not finished, and not named in an
// active prompt file in the scratchpad.

/** Statuses in which a task no longer holds its block. */
const MIGR_FREE_STATUS = new Set(['done', 'cancelled']);

/** A block in text: "3450–3459" or "3450-3459" (en dash or hyphen, spaces allowed). The end can be short ("3450–59"). */
const BLOCK_PATTERN = /(?<!\d)(\d+)\s*[–-]\s*(\d+)(?!\d)/;

/**
 * "3450–3459" (en dash or hyphen, possibly with text around it) → { from: 3450, to: 3459 }, otherwise null. A short
 * end number ("2340–49") is filled in from the start.
 */
function blockInterval(text) {
  const m = BLOCK_PATTERN.exec(String(text ?? ''));
  if (!m) return null;
  const from = Number(m[1]);
  let to = Number(m[2]);
  if (to < from) {
    const s = String(from);
    to = Number(s.slice(0, Math.max(0, s.length - m[2].length)) + m[2]);
  }
  return to >= from ? { from, to } : null;
}

/**
 * All blocks named in a text (a prompt file), as intervals. Only lines that say "migration block" count, so line
 * ranges and dates elsewhere in the mission are never read as a block.
 */
function blocksInText(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/migration block/i.test(line)) continue;
    for (const m of line.matchAll(new RegExp(BLOCK_PATTERN.source, 'g'))) {
      const b = blockInterval(m[0]);
      if (b) out.push(b);
    }
  }
  return out;
}

/** The last part of a path (/ or \). */
const fileName = (p) =>
  String(p ?? '')
    .split(/[\\/]/)
    .pop();

/** The task id a prompt file belongs to: "prompt-A-4.md" and "prompt-A-4-r2.md" → "A-4". */
function promptTask(name, tasks = []) {
  const m = /^prompt-(.+)\.md$/.exec(fileName(name));
  if (!m) return null;
  const ids = new Set(tasks.map((o) => o.id));
  if (ids.has(m[1])) return m[1];
  const without = m[1].replace(/-r\d+$/, '');
  return ids.has(without) ? without : m[1];
}

/**
 * The blocks that are taken, as { from, to, source }. `fileNrs`: the numbers of the migration files in the main tree
 * (the first group in migrations.filePattern). `prompts`: [{ name, text }] from the scratchpad; a prompt file counts
 * when its task is not done or cancelled (an unknown id counts too: rather one block too many than a collision).
 * `except`: the task itself (for move and start).
 */
function takenBlocks({ tasks = [], fileNrs = [], prompts = [], except = null } = {}) {
  const taken = [];
  for (const n of fileNrs) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) taken.push({ from: v, to: v, source: 'migration file' });
  }
  for (const o of tasks) {
    if (o.id === except || MIGR_FREE_STATUS.has(o.status)) continue;
    const b = blockInterval(o.migr_block);
    if (b) taken.push({ ...b, source: `task ${o.id}` });
  }
  const status = new Map(tasks.map((o) => [o.id, o.status]));
  for (const p of prompts) {
    const id = promptTask(p.name, tasks);
    if (!id || id === except || MIGR_FREE_STATUS.has(status.get(id))) continue;
    for (const b of blocksInText(p.text)) taken.push({ ...b, source: fileName(p.name) });
  }
  return taken;
}

/**
 * Assigns the block for a start (common for `start`, `fill` and `pick`): the next free one from `queue.next_migr`
 * past `taken`, and moves `next_migr` past it (never backward). The new block is added to `taken`, so several starts in
 * the same call get different blocks.
 * @returns {{ block: string|null, skipped: object[] }}
 */
function assignStartBlock(queue, o, taken = [], migrations = cfg().migrations) {
  const b = assignMigrBlock(
    Number(queue.next_migr),
    migrTens(o, migrations),
    migrations?.blockSize,
    taken,
  );
  if (b.from == null) return { block: null, skipped: [] };
  queue.next_migr = Math.max(Number(queue.next_migr) || 0, b.nextAvailable);
  taken.push({ from: b.from, to: b.to, source: `task ${o.id}` });
  return { block: migrBlockText(b), skipped: b.skipped ?? [] };
}

/**
 * `queue.mjs migr move <id> <block>`: "3470" or "3470-3479" → { from, to }. With only the start given the block gets
 * as many blocks of `size` as the task has (`tens`, at least 1). Error: { error }.
 */
function parseMoveBlock(text, tens = 1, size = 10) {
  const s = String(text ?? '').trim();
  const z = Number(size) > 0 ? Math.floor(Number(size)) : 10;
  const m = /^(\d+)(?:\s*[–-]\s*(\d+))?$/.exec(s);
  if (!m) return { error: `invalid block "${s}" (e.g. 3470 or 3470-3479)` };
  const from = Number(m[1]);
  const b =
    m[2] != null ? blockInterval(s) : { from, to: from + Math.max(1, Number(tens) || 1) * z - 1 };
  if (!b || b.from % z !== 0 || (b.to + 1) % z !== 0)
    return {
      error: `the block ${b ? `${b.from}–${b.to}` : s} must cover whole blocks of ${z} (start on a multiple of ${z}, end just before one)`,
    };
  return b;
}

/**
 * Swaps the block in a prompt file: the "Migration block:" line and every mention of the old block (en dash or
 * hyphen, any spacing). The old block is both the queue's and the one the file itself names (an earlier move by hand
 * only stands in the file). No String.replace with a replacement string ("$'" duplicates text): callbacks only.
 */
function moveBlockInText(text, old, fresh) {
  const freshText = migrBlockText(fresh);
  let t = String(text ?? '');
  const inFile = blockInterval((/^Migration block:.*$/m.exec(t) ?? [''])[0]);
  t = t.replace(/^Migration block:.*$/m, () => `Migration block: ${freshText}`);
  const olds = [old, inFile].filter((g) => g && !(g.from === fresh.from && g.to === fresh.to));
  if (!olds.length) return t;
  return t.replace(new RegExp(BLOCK_PATTERN.source, 'g'), (hit) => {
    const b = blockInterval(hit);
    return b && olds.some((g) => g.from === b.from && g.to === b.to) ? freshText : hit;
  });
}

/**
 * Is the queue out of work? Empty = nothing running and nothing can be started. Also returns what is blocked.
 * With `dailyUsage` (USD today, from timeCost.js) and a daily budget that is used up, nothing can
 * be started (stop: 'dailyBudget'), so the loop stops when the running ones are done.
 * `uncommitted`: as in selectNext; a task that is only stopped by an uncommitted file gets that as its blocker.
 * Night pause: with nightRun off and `now` inside the night window, nothing can be started either
 * (stop: 'nightPause', night: the message), the same way as the budget guard.
 */
function state(
  queue,
  dailyUsage,
  { uncommitted = [], now = Date.now(), cursor = null, load = null } = {},
) {
  const tasks = queue.tasks ?? [];
  // Active = what the orchestrator waits on (running or to be merged). A picked task does not keep the loop going:
  // the person or session that picked it delivers (review) or merges it itself.
  const activeOnes = tasks.filter((o) => o.status === 'running' || o.status === 'review');
  const picked = tasks.filter((o) => o.status === 'picked');
  // The batch queue is counted separately (it waits to be packed, not to be started).
  const waiting = tasks.filter((o) => o.status === 'waiting' && !isBatched(o));
  const batched = tasks.filter(inBatchQueue);
  const guard = startGuard(queue, dailyUsage, { now, cursor, load });
  const canStart = guard ? [] : selectNext(queue, now, { uncommitted });
  const guardBlocker = guard?.stop === 'dailyBudget' ? 'the daily budget is used up' : guard?.summary;
  const rk = rankingContext(queue, now);
  const blocked = waiting
    .filter((o) => !canStart.some((k) => k.id === o.id))
    .map((o) => {
      const h = blockersWithPause(o, queue, rk);
      const u = h.length ? null : uncommittedCollision(o, uncommitted);
      if (u) h.push(`file ${u.path} is uncommitted in the main tree`);
      return {
        id: o.id,
        blockers: guard && !h.length ? [guardBlocker] : h,
      };
    });
  const parked = waiting.filter((o) => parkedNow(o, now)).length;
  // The owner question that unlocks the most tasks first.
  const question = new Map();
  for (const o of waiting) {
    for (const sp of o.waiting_on ?? []) {
      if (!(queue.resolved ?? []).includes(sp)) question.set(sp, (question.get(sp) ?? 0) + 1);
    }
  }
  return {
    activeOnes: activeOnes.length,
    picked: picked.length,
    waiting: waiting.length,
    proposed: tasks.filter((o) => o.status === 'proposed' && !isBatched(o)).length,
    batched: batched.length,
    qa: tasks.filter((o) => o.status === 'done' && o.qa_status === 'waiting').length,
    external: tasks.filter((o) => o.status === 'external').length,
    canStart: canStart.length,
    empty: activeOnes.length === 0 && canStart.length === 0,
    ...(guard?.stop === 'dailyBudget' ? { stop: 'dailyBudget', budget: guard.message } : {}),
    ...(guard?.stop === 'nightPause' ? { stop: 'nightPause', night: guard.message } : {}),
    ...(guard?.stop === 'windDown' ? { stop: 'windDown', windDown: guard.message } : {}),
    ...(guard?.stop === 'load' ? { stop: 'load', load: guard.message } : {}),
    blocked,
    ownerQuestion: [...question.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sp, n]) => ({ sp, tasks: n })),
    // Only when something is parked or a focus is set (otherwise the same answer as before).
    ...(parked ? { parked } : {}),
    ...(queue.focus
      ? {
          focus: focusStatus(queue, {
            now,
            canStart: canStart.map((x) => x.id),
            context: rk,
          }),
        }
      : {}),
  };
}

// ---- Budget guard -----------------------------------------------------------------------------------------

/**
 * Is today's usage over the daily budget? `limits.dailyBudget` in the queue file is USD API equivalent per local day; not
 * set, null, 0 or negative = off. The usage is measured by the caller (queue.mjs reads the time log via timeCost.js).
 * The usage of agents that are still running is counted only when they stop (hook-time writes the row then), so the guard
 * kicks in a little after the limit has actually been passed: set the limit with a margin.
 * @param {object} queue the queue
 * @param {number|undefined} dailyUsage USD used today
 * @returns {{ active: boolean, stop: boolean, limit?: number, usage?: number, message?: string }}
 */
function budgetGuard(queue, dailyUsage) {
  const limit = Number(queue?.limits?.dailyBudget);
  if (queue?.limits?.dailyBudget == null || !Number.isFinite(limit) || limit <= 0) {
    return { active: false, stop: false };
  }
  const usage = Math.round(Number(dailyUsage ?? 0) * 100) / 100;
  const stop = usage >= limit;
  const counts = `${usage.toFixed(2)} of ${limit.toFixed(2)} USD (API equivalent, local day)`;
  return {
    active: true,
    stop,
    limit,
    usage,
    message: stop
      ? `DAILY BUDGET USED UP: ${counts}. No new tasks are started today. Running tasks finish ` +
        'as usual. The owner can raise the limit (cq limit dailyBudget <usd>) or start one task with start <id> --force.'
      : `Daily budget: ${counts} used.`,
  };
}

// ---- Night guard ---------------------------------------------------------------------------------------

/** "23-06" → { from: 23, to: 6 }. Two digits on each side (00–23), and from and to cannot be equal. Otherwise null. */
function parseNightWindow(s) {
  const m = /^([01]\d|2[0-3])-([01]\d|2[0-3])$/.exec(String(s ?? '').trim());
  if (!m || m[1] === m[2]) return null;
  return { from: Number(m[1]), to: Number(m[2]) };
}

/** The hour (0–23) a point in time has in the time zone `tz` (local time by default, daylight saving time accounted for). */
function hourIn(now, tz = NIGHT_TZ) {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(now))
    .replace(/\D/g, '');
  return Number(t) % 24;
}

/** Is the point in time inside the night window? A window across midnight ("23-06") applies from 23:00 to 06:00. */
function inNightWindow(window, now = Date.now(), tz = NIGHT_TZ) {
  if (!window) return false;
  const t = hourIn(now, tz);
  return window.from < window.to ? t >= window.from && t < window.to : t >= window.from || t < window.to;
}

const clockTime = (t) => `${String(t).padStart(2, '0')}:00`;

/**
 * Night pause: with `limits.nightRun` = false no new tasks are started inside the night window (local time). Running
 * tasks finish, and delivered tracks are received and merged as usual; only new starts stop. The default (on) gives
 * unchanged behavior. `queue.mjs next` then gives exit 5 and `start` refuses without --force (startGuard).
 * @returns {{ active: boolean, stop: boolean, to?: string, summary?: string, message?: string }}
 */
function nightGuard(queue, now = Date.now(), tz = NIGHT_TZ) {
  const g = { ...DEFAULT_LIMITS, ...(queue?.limits ?? {}) };
  if (g.nightRun !== false) return { active: false, stop: false };
  const v = parseNightWindow(g.nightWindow) ?? parseNightWindow(DEFAULT_LIMITS.nightWindow);
  const stop = inNightWindow(v, now, tz);
  const from = clockTime(v.from);
  const to = clockTime(v.to);
  const summary = `nightPause until ${to}`;
  return {
    active: true,
    stop,
    to,
    summary,
    message: stop
      ? `Night pause until ${to}: nightRun is off, so no new tasks are started between ${from} and ${to} (local time). ` +
        'Running tasks finish, and delivered tracks are received and merged as usual. The owner can turn nightRun on ' +
        '(cq limit nightRun on) or start one task with start <id> --force.'
      : `Night run is off: no new tasks are started between ${from} and ${to} (local time).`,
  };
}

/**
 * Does the budget guard, night guard, wind-down guard or load guard stop new starts now? The budget first (exit 4),
 * then the night (exit 5), then the wind-down (exit 6; requires `cursor`, the orchestrator cursor), then the load
 * (exit 7; requires `load`, the measurement). `force` (owner's word, `start --force`) overrides all four. Used by
 * `next`, `start`, `fill`, `show` and `state`.
 * @returns {{ code: 4|5|6|7, stop: 'dailyBudget'|'nightPause'|'windDown'|'load', summary?: string, message: string } | null}
 */
function startGuard(
  queue,
  dailyUsage,
  { now = Date.now(), force = false, cursor = null, load = null } = {},
) {
  if (force) return null;
  const b = budgetGuard(queue, dailyUsage);
  if (b.stop) return { code: 4, stop: 'dailyBudget', message: b.message };
  const n = nightGuard(queue, now);
  if (n.stop) return { code: 5, stop: 'nightPause', summary: n.summary, message: n.message };
  const by = windDownGuard(cursor, now);
  if (by.stop) return { code: 6, stop: 'windDown', summary: by.summary, message: by.message };
  // The machine is full (exit 7). Only with a measurement (`load`); without it the guard is off.
  const lg = loadGuard(queue, load);
  if (lg.stop) return { code: 7, stop: 'load', summary: lg.summary, message: lg.message };
  return null;
}

// ---- Load guard ---------------------------------------------------------------------------------------------------

/**
 * The load limit in effect: `limits.minFreeMemoryPct` in the queue file when it is set there (also "off", which is
 * stored as null), otherwise `loadGuard.minFreeMemoryPct` in queue.config.json. null or 0 = off (default).
 */
function minFreeMemoryFor(queue) {
  if (queue?.limits && Object.hasOwn(queue.limits, 'minFreeMemoryPct'))
    return queue.limits.minFreeMemoryPct;
  try {
    return cfg().loadGuard?.minFreeMemoryPct ?? null;
  } catch {
    return null; // no config: off
  }
}

/**
 * Is the machine too full to start another track? When many tracks run at once, gates can go red from timeouts and
 * lack of memory, not from code errors. With a limit set (minFreeMemoryFor: percent free memory, os.freemem /
 * os.totalmem), no new start happens while free memory is below the limit. A measurement that is null (unknown)
 * never stops. Running tracks finish; only new starts wait. `start --force` and `fill --over-load` override.
 * @param {object} queue the queue
 * @param {{ freeMemoryPct: number|null } | null} load the measurement (queue.mjs measureLoad)
 * @returns {{ active: boolean, stop: boolean, reasons?: string[], summary?: string, message?: string }}
 */
function loadGuard(queue, load) {
  const raw = minFreeMemoryFor(queue);
  const min = Number(raw);
  const on = raw != null && Number.isFinite(min) && min > 0;
  if (!load || !on) return { active: on, stop: false };
  const free = load.freeMemoryPct == null ? NaN : Number(load.freeMemoryPct);
  if (!(Number.isFinite(free) && free < min)) return { active: true, stop: false };
  const reasons = [`free memory ${Math.round(free * 10) / 10} % (below ${min} %)`];
  return {
    active: true,
    stop: true,
    reasons,
    summary: `the machine is full: ${reasons.join(', ')}`,
    message:
      `THE MACHINE IS FULL: ${reasons.join(' and ')}. No new tracks are started until the load goes down; running ` +
      'tracks finish, and delivered tracks are received and merged as usual. The owner can change the limit ' +
      '(cq limit minFreeMemoryPct <number|off>) or start one task with start <id> --force.',
  };
}

/** Interprets the load limit: integer 1-100 (percent free memory), "off"/0 = null. */
function parseLoadLimit(name, s) {
  if (['off', 'no', 'null', 'none', '0'].includes(s.toLowerCase())) return { val: null };
  if (!/^\d+$/.test(s)) return { error: `${name} must be an integer or "off"` };
  const v = Number(s);
  if (v > 100) return { error: `${name} must be between 1 and 100 (percent) or "off"` };
  return { val: v };
}

// ---- Wind-down guard -----------------------------------------------------------------------------

/** The running handover note in the data folder (same path as contextGuard.HANDOVER_NOTE). */
function handoverNote() {
  let folder = 'scripts/.queue';
  try {
    folder = String(cfg().dataFolder || folder);
  } catch {
    // no config: the default folder
  }
  return `${folder.replace(/\\/g, '/').replace(/\/+$/, '')}/handover-ongoing.md`;
}

/**
 * Is the orchestrator in wind-down? hook-context.mjs sets `windDown` in the orchestrator cursor when the active
 * orchestrator session passes approx. 350k context (contextGuard.js). Then no new tasks are started
 * (`next`, `start` and `fill` give exit 6), while receiving, review, fix rounds, merge and `set` go on as before.
 * Applies only as long as the cursor is active (not expired). The normal way out is compaction:
 * hook-after-compact.mjs lifts the wind-down. Also reset when a new session takes the cursor (emergency rotation:
 * `orchestrator pulse --session "<new name>"`, or the hook binds the cursor to another session) and with `orchestrator stop`.
 * @returns {{ active: boolean, stop: boolean, summary?: string, message?: string }}
 */
function windDownGuard(cursor, now = Date.now()) {
  if (!cursor?.windDown || !orchestratorStatus(cursor, now).active)
    return { active: false, stop: false };
  const from = cursor.windDown.from ?? '?';
  const context = cursor.windDown.context
    ? ` at approx. ${Math.round(cursor.windDown.context / 1000)}k tokens`
    : '';
  return {
    active: true,
    stop: true,
    summary: 'windDown (compact the session)',
    message:
      `WIND_DOWN: the orchestrator session "${cursor.session ?? '?'}" went into wind-down ${from}${context}. No new tasks ` +
      'are started from this session. Finish receiving, review, fix rounds and merge of started tasks, update ' +
      `the handover note (${handoverNote()}) and ask the owner to compact now (the hook message has ` +
      'a ready /compact line); the wind-down is lifted by itself after the compaction. A new session only as ' +
      'a last resort (the session has hung): `cq orchestrator pulse --session "<new name>"` resets the wind-down. ' +
      "Owner's word: start <id> --force.",
  };
}

/** The limits that can be set with `queue.mjs limit <name> <val>`. */
const LIMIT_NAME = [
  'maxConcurrent',
  'maxDPlus',
  'maxPerDomain',
  'maxDb',
  'dailyBudget',
  'nightRun',
  'nightWindow',
  'autocompact',
];

/**
 * Limits that `queue.mjs limit` also sets, but that are not slot limits (not in LIMIT_NAME, so
 * the settings panel on the board, queueBoard.SETTINGS, is unchanged). parallelThreshold: the share of maxConcurrent below
 * which fill, receive and pulse write a quick queue diagnosis (queueDiagnose.js); default 0.7, 0 = off.
 */
const LIMIT_EXTRA = ['parallelThreshold', 'minFreeMemoryPct'];

/** A limit value as text: null = "off", true/false = "on"/"off". */
function limitText(name, v) {
  if (v == null) return 'off';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

/**
 * Interprets a new limit value. max*: integer ≥ 0 (maxConcurrent 0 stops the queue). dailyBudget: number > 0 (USD), or
 * "off" for no limit. nightRun: "on" or "off". nightWindow: "HH-HH" in local time, e.g. 23-06. autocompact:
 * "on"/"auto" or "off"/"manual".
 * With `current` (the limits as they are now) maxDPlus cannot become larger than maxConcurrent. maxDb can:
 * picked tasks count in maxDb, but not in maxConcurrent, so 6 tracks with migrations and 5 agents makes sense.
 * @returns {{ val: number|boolean|string|null } | { error: string }}
 */
function parseLimit(name, raw, current) {
  if (!LIMIT_NAME.includes(name) && !LIMIT_EXTRA.includes(name))
    return { error: `unknown limit ${name} (${[...LIMIT_NAME, ...LIMIT_EXTRA].join(', ')})` };
  // Interpreted in queueDiagnose (loaded here, not at the top, because queueDiagnose itself uses this file).
  if (name === 'parallelThreshold') return require('./queueDiagnose.js').parseThreshold(raw);
  const s = String(raw ?? '').trim();
  if (name === 'minFreeMemoryPct') return parseLoadLimit(name, s);
  if (name === 'dailyBudget') {
    if (['off', 'none', 'null'].includes(s.toLowerCase())) return { val: null };
    const v = Number(s.replace(',', '.'));
    if (!s || !Number.isFinite(v) || v <= 0)
      return { error: 'dailyBudget must be a number > 0 (USD) or "off"' };
    return { val: Math.round(v * 100) / 100 };
  }
  if (name === 'nightRun') {
    const x = s.toLowerCase();
    if (['on', 'yes'].includes(x)) return { val: true };
    if (['off', 'no'].includes(x)) return { val: false };
    return { error: 'nightRun must be "on" or "off"' };
  }
  if (name === 'autocompact') {
    const x = s.toLowerCase();
    if (['on', 'yes', 'auto'].includes(x)) return { val: true };
    if (['off', 'no', 'manual'].includes(x)) return { val: false };
    return { error: 'autocompact must be "on" (auto) or "off" (manual)' };
  }
  if (name === 'nightWindow') {
    const v = parseNightWindow(s);
    if (!v)
      return {
        error: 'nightWindow must have the form HH-HH in local time (two digits, 00–23), e.g. 23-06, and from and to cannot be equal',
      };
    return { val: `${String(v.from).padStart(2, '0')}-${String(v.to).padStart(2, '0')}` };
  }
  if (!/^\d+$/.test(s)) return { error: `${name} must be an integer ≥ 0` };
  const v = Number(s);
  if (name === 'maxDPlus' && current) {
    const max = Number(current.maxConcurrent);
    if (Number.isFinite(max) && v > max)
      return { error: `${name} cannot be larger than maxConcurrent (${max})` };
  }
  return { val: v };
}

// ---- Proposed ----------------------------------------------------------------------------------------------

/**
 * Is `added_by` an agent? The protocol says that agents set their own id: a track (a task id in the queue, also a
 * fix round like "A-4-r2"), a reviewer ("rev-…", "review …") or a fold/investigation agent ("… agent …"). The owner
 * (add-to-queue) and the orchestrator use other labels, and their tasks go straight to waiting.
 */
function isAgentSource(addedBy, tasks = []) {
  const s = String(addedBy ?? '').trim();
  if (!s) return false;
  const ids = new Set(tasks.map((o) => o.id));
  if (ids.has(s)) return true;
  const withoutRound = s.replace(/-(?:r|round)\d+$/i, '');
  if (withoutRound !== s && ids.has(withoutRound)) return true;
  return /^(?:rev|review|fold)\b/i.test(s) || /\bagent\b/i.test(s);
}

/**
 * The status a new task gets in `queue.mjs add`: proposed when an agent added it, otherwise waiting. `approved` (the flag
 * --approved, only for the orchestrator or the owner) gives waiting regardless, for example for a HIGH finding from review.
 */
function statusAtAdd(fresh, tasks = [], { approved = false } = {}) {
  if (approved) return 'waiting';
  return isAgentSource(fresh?.added_by, tasks) ? 'proposed' : 'waiting';
}

/**
 * Approves proposed tasks: proposed → waiting. Changes tasks in `queue` (the caller writes the file under lock).
 * @returns {{ approved: string[], error: string[] }}
 */
function approve(queue, ids, now = new Date().toISOString()) {
  const approved = [];
  const error = [];
  for (const id of ids) {
    const o = (queue.tasks ?? []).find((x) => x.id === id);
    if (!o) error.push(`unknown task ${id}`);
    else if (o.status !== 'proposed') error.push(`${id} is not proposed (status ${o.status})`);
    else {
      o.status = 'waiting';
      o.approved = now;
      approved.push(id);
    }
  }
  return { approved, error };
}

// ---- Owner questions and resolutions -------------------------------------------------------------------
//
// `question`: { "<id>": { type, text, recommendation?, source?, added_at } } is the text behind the ids in `waiting_on`, so
// the board can show what the owner must answer. `resolutions`: { "<id>": { time, answer, by, logged? } } is the answer with
// a timestamp; the id still sits in `resolved` (that list is what the blockers read). Both fields are optional: an
// old queue.json without them works unchanged.

/** The types an owner question can have. `condition` is answered with how the condition is fulfilled. */
const QUESTION_TYPES = ['question', 'condition', 'lawyer', 'owner-task'];
const QUESTION_FIELD = new Set(['type', 'text', 'recommendation', 'source', 'added_at']);
const QUESTION_MAX_TEXT = 4000;

/** Valid id for an owner question: not empty, at most 300 characters, without control characters, whitespace at the ends or a leading "-". */
function validQuestionId(id) {
  const s = typeof id === 'string' ? id : '';
  return (
    s.length > 0 &&
    s.length <= 300 &&
    s.trim() === s &&
    !s.startsWith('-') &&
    !/[\u0000-\u001f\u007f]/.test(s)
  );
}

/**
 * Sets or updates owner questions (`queue.mjs question`, `question --file`, `add` with `{ tasks, question }`).
 * All or nothing: if one question is invalid, nothing is changed. A field that is not included is kept from before; `null`
 * removes recommendation or source. `added_at` is set by the tool (the first time the question is registered).
 * @param {object} queue the queue (changed when the error list is empty)
 * @param {Record<string, { type?: string, text?: string, recommendation?: string|null, source?: string|null }>} input
 * @returns {{ set: string[], error: string[] }}
 */
function setQuestion(queue, input, now = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { set: [], error: ['question must be an object: { "<id>": { type, text, … } }'] };
  const error = [];
  const newOnes = {};
  for (const [id, s] of Object.entries(input)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      error.push(`${id}: must be an object { type, text, recommendation?, source? }`);
      continue;
    }
    const f = [];
    // A NEW question must have a strict id (QUESTION_ID_PATTERN), so free text never becomes a "question". A
    // question that is already registered can still be updated (validQuestionId).
    if (!validQuestionId(id) || (!queue.question?.[id] && !QUESTION_ID_PATTERN.test(id)))
      f.push('invalid id');
    const unknown = Object.keys(s).filter((k) => !QUESTION_FIELD.has(k));
    if (unknown.length) f.push(`unknown field ${unknown.join(', ')}`);
    const previous = queue.question?.[id] ?? {};
    const type = s.type ?? previous.type ?? 'question';
    if (!QUESTION_TYPES.includes(type)) f.push(`type must be ${QUESTION_TYPES.join(', ')}`);
    const text = s.text ?? previous.text;
    if (typeof text !== 'string' || !text.trim()) f.push('text missing');
    for (const k of ['text', 'recommendation', 'source']) {
      const v = s[k];
      if (v != null && (typeof v !== 'string' || v.length > QUESTION_MAX_TEXT))
        f.push(`${k} must be text (at most ${QUESTION_MAX_TEXT} characters)`);
    }
    if (f.length) {
      error.push(`${id}: ${f.join('; ')}`);
      continue;
    }
    const fresh = { type, text: text.trim() };
    for (const k of ['recommendation', 'source']) {
      const v = s[k] !== undefined ? s[k] : previous[k];
      if (typeof v === 'string' && v.trim()) fresh[k] = v.trim();
    }
    fresh.added_at = previous.added_at ?? now;
    newOnes[id] = fresh;
  }
  if (error.length) return { set: [], error };
  queue.question = { ...(queue.question ?? {}), ...newOnes };
  return { set: Object.keys(newOnes), error: [] };
}

/**
 * `queue.mjs resolve <id…> [--answer "…"] [--by "…"]`: the ids are put in `resolved` (as before) and in `resolutions` with time, answer
 * and who. Without an answer an earlier resolution is kept unchanged (time and answer are never lost); a new answer replaces it
 * and must be entered in the decision log again (`logged: false`). An empty answer (`--answer ""`) is refused: then everything stops.
 * @returns {{ resolved: string[], error: string[] }}
 */
function resolve(queue, ids, { answer = null, by = null, now = new Date().toISOString() } = {}) {
  const list = [...new Set(ids ?? [])];
  const error = list
    .filter((id) => !validQuestionId(id))
    .map((id) => `invalid question id ${JSON.stringify(id)}`);
  if (!list.length) error.push('resolve requires at least one question id');
  const s = answer == null ? null : String(answer).trim();
  if (answer != null && !s)
    error.push('the answer is empty: write the answer, or how the condition is fulfilled');
  if (error.length) return { resolved: [], error };
  queue.resolved = [...new Set([...(queue.resolved ?? []), ...list])];
  const resolutions = { ...(queue.resolutions ?? {}) };
  for (const id of list) {
    if (resolutions[id] && s == null) continue;
    resolutions[id] = { time: now, answer: s, by: by ? String(by).trim() || null : null };
    if (s != null) resolutions[id].logged = false;
  }
  queue.resolutions = resolutions;
  return { resolved: list, error: [] };
}

/** Resolutions with an answer that is not entered in the decision log yet (the orchestrator enters them and runs --mark-logged). */
function unlogged(queue) {
  return Object.entries(queue.resolutions ?? {})
    .filter(([, a]) => a && a.answer != null && a.logged !== true)
    .map(([sp, a]) => ({ sp, ...a }))
    .sort((x, y) => String(x.time).localeCompare(String(y.time)) || x.sp.localeCompare(y.sp));
}

/**
 * `queue.mjs resolutions --mark-logged <id…>`: the answers are entered in the decision log. All or nothing (unknown id or
 * a resolution without an answer gives an error).
 * @returns {{ marked: string[], error: string[] }}
 */
function markLogged(queue, ids) {
  const list = [...new Set(ids ?? [])];
  const error = [];
  if (!list.length) error.push('--mark-logged requires at least one question id');
  for (const id of list) {
    const a = queue.resolutions?.[id];
    if (!a) error.push(`${id} is not resolved with a timestamp (cq resolve ${id} --answer "…")`);
    else if (a.answer == null) error.push(`${id} has no answer to enter`);
  }
  if (error.length) return { marked: [], error };
  queue.resolutions = { ...queue.resolutions };
  for (const id of list) queue.resolutions[id] = { ...queue.resolutions[id], logged: true };
  return { marked: list, error: [] };
}

/**
 * Overview for `queue.mjs question`: each question that is registered or that a task waits on, with the text (or
 * null when it is missing), whether it is resolved, and how many pending tasks wait directly on it. Open ones first
 * (most pending first), then resolved ones.
 */
function questionOverview(queue) {
  const resolved = new Set(queue.resolved ?? []);
  const waiting = new Map();
  for (const o of queue.tasks ?? []) {
    if (o.status !== 'waiting' && o.status !== 'proposed') continue;
    for (const sp of o.waiting_on ?? []) {
      if (!waiting.has(sp)) waiting.set(sp, []);
      if (o.status === 'waiting') waiting.get(sp).push(o.id);
    }
  }
  const ids = new Set([...Object.keys(queue.question ?? {}), ...waiting.keys()]);
  return [...ids]
    .map((sp) => {
      const q = queue.question?.[sp];
      return {
        sp,
        type: q?.type ?? 'question',
        text: q?.text ?? null,
        recommendation: q?.recommendation ?? null,
        source: q?.source ?? null,
        resolved: resolved.has(sp),
        answer: queue.resolutions?.[sp]?.answer ?? null,
        tasks: waiting.get(sp) ?? [],
      };
    })
    .sort(
      (x, y) =>
        Number(x.resolved) - Number(y.resolved) ||
        y.tasks.length - x.tasks.length ||
        x.sp.localeCompare(y.sp),
    );
}

/** The ids a task waits on that have no text in `question` (add warns about them). */
function questionWithoutText(tasks, queue) {
  const out = new Set();
  for (const o of tasks)
    for (const sp of o.waiting_on ?? []) if (!queue.question?.[sp]?.text) out.add(sp);
  return [...out];
}

// ---- An owner answer cannot be lost -----------------------------------------------
//
// A task stayed blocked even though the owner had answered twice: `waiting_on` had free text instead of a registered
// question id, so the question did not exist in `question`, was never shown in "Waiting on you", and `resolve` could not hit
// it. Three measures: (1) add and edit refuse a new waiting_on id that is not registered (waitingOnError), (2) fill, show and
// state list loose waits (resolveWaits), (3) resolve with an answer writes the answer into the mission (ownerAnswerBonus).

/** Strict id for an owner question: letters (including Nordic letters), digits, ".", "_" and "-", at most 40 characters, without whitespace. */
const QUESTION_ID_PATTERN = /^[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5][A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5._-]{0,39}$/;

/** Is the question registered so that the owner can answer it (text and type in `question`)? */
function questionRegistered(queue, sp) {
  const q = Object.hasOwn(queue?.question ?? {}, sp) ? queue.question[sp] : null;
  return !!(q && typeof q.text === 'string' && q.text.trim() && q.type);
}

/**
 * The errors for `waiting_on` on a task (add and edit; all or nothing in the caller). Each id that is not in
 * `earlier` (the task's waiting_on before the change) must match QUESTION_ID_PATTERN and be registered in `queue.question`
 * with text and type. `queue.question` should already contain the questions that are registered in the same call (the add form
 * { tasks, question }). Waits that were already there are not refused (they show as loose waits instead).
 * @returns {string[]}
 */
function waitingOnError(o, queue, { earlier = [] } = {}) {
  const list = o?.waiting_on;
  if (list == null || !Array.isArray(list)) return [];
  const from = new Set(earlier ?? []);
  const error = [];
  for (const sp of list) {
    if (from.has(sp)) continue;
    if (typeof sp !== 'string' || !QUESTION_ID_PATTERN.test(sp))
      error.push(
        `waiting_on ${JSON.stringify(sp)} is not a question id (letters, digits, ".", "_", "-", at most 40 characters, ` +
          'no whitespace). Register the question with an id and text, and wait on the id',
      );
    else if (!questionRegistered(queue, sp))
      error.push(
        `waiting_on ${sp} is not registered with text and type: add it under "question" in the add file, or first ` +
          `cq question ${sp} --text "…" --type <${QUESTION_TYPES.join('|')}>`,
      );
  }
  return error;
}

/**
 * Loose waits: tasks (waiting or proposed) that wait on something the owner cannot answer, or that are blocked by
 * a question that has been answered. `reason`: `freeText` (the id does not match QUESTION_ID_PATTERN), `unregistered` (no
 * text and type in `question`), or `resolved-blocks` (the answer is in `resolutions`, but the id is missing in `resolved`,
 * which is what the blockers read; should not be able to happen). A resolved question without text does not block and is not included.
 * @returns {{ id: string, status: string, sp: string, reason: string }[]}
 */
function resolveWaits(queue) {
  const resolved = new Set(queue?.resolved ?? []);
  const out = [];
  for (const o of queue?.tasks ?? []) {
    if (o.status !== 'waiting' && o.status !== 'proposed') continue;
    for (const sp of Array.isArray(o.waiting_on) ? o.waiting_on : []) {
      if (resolved.has(sp)) continue;
      let reason = null;
      if (Object.hasOwn(queue.resolutions ?? {}, sp)) reason = 'resolved-blocks';
      else if (typeof sp !== 'string' || !QUESTION_ID_PATTERN.test(sp)) reason = 'freeText';
      else if (!questionRegistered(queue, sp)) reason = 'unregistered';
      if (reason) out.push({ id: o.id, status: o.status, sp: String(sp), reason });
    }
  }
  return out;
}

/**
 * The WARNING lines for loose waits (fill, show). Empty list when there are none. `max` limits the detail lines.
 * @param {{ id: string, status: string, sp: string, reason: string }[]} list resolveWaits(queue)
 */
function resolveWaitsLines(list, { max = 10 } = {}) {
  if (!list?.length) return [];
  const what = {
    freeText: 'free text, not a question id: register a question and switch to the id',
    unregistered: 'unregistered: cq question <id> --text "…" --type <type>',
    'resolved-blocks': 'answered, but not in resolved: cq resolve <id> again',
  };
  const taskIds = new Set(list.map((x) => x.id));
  return [
    `NOTICE: ${list.length} loose wait(s) in ${taskIds.size} task(s) (the owner does not see them in "Waiting on you", ` +
      'or an answer blocks anyway):',
    ...list
      .slice(0, max)
      .map(
        (x) =>
          `  ${x.id} (${x.status}) waiting on "${cutText(x.sp, 70)}": ${what[x.reason] ?? x.reason}`,
      ),
    ...(list.length > max
      ? [`  +${list.length - max} more (cq state, the field resolveWaits)`]
      : []),
  ];
}

/**
 * Resolve with an answer writes the answer into the mission: a bonus "OWNER_ANSWER <sp> (<date>): <answer>" on each task that
 * waits on the question and is not done, cancelled or external (same mechanism as `queue.mjs edit --bonus`, so
 * the track block and the prompt get the decision). Idempotent: if the same answer for the same question is already there, it is
 * not added again. Without an answer nothing happens. Mutates the queue.
 * @returns {{ id: string, sp: string }[]} the additions that were made
 */
function ownerAnswerBonus(queue, ids, answer, now = new Date().toISOString()) {
  const s = answer == null ? '' : String(answer).trim();
  if (!s) return [];
  const date = String(now).slice(0, 10);
  const added = [];
  for (const sp of [...new Set(ids ?? [])]) {
    for (const o of queue?.tasks ?? []) {
      if (['done', 'cancelled', 'external'].includes(o.status)) continue;
      if (!(o.waiting_on ?? []).includes(sp)) continue;
      const fromFor = (Array.isArray(o.bonus) ? o.bonus : []).some(
        (t) =>
          typeof t?.text === 'string' &&
          t.text.startsWith(`OWNER_ANSWER ${sp} (`) &&
          t.text.endsWith(`): ${s}`),
      );
      if (fromFor) continue;
      if (!addToBonus(o, `OWNER_ANSWER ${sp} (${date}): ${s}`, now)) added.push({ id: o.id, sp });
    }
  }
  return added;
}

/** "2026-10-01 14:02 UTC" from an ISO time (for the track file; the time is always saved in UTC). */
const utcText = (iso) =>
  typeof iso === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso)
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
    : '?';

/**
 * The block in the track file with the owner's answer to what the task waited on (`waiting_on` that is resolved), so the track sees
 * the decision and does not build without it. null when the task did not wait on anything resolved.
 */
function answerBlock(o, queue) {
  const resolved = new Set(queue.resolved ?? []);
  const sp = (o.waiting_on ?? []).filter((x) => resolved.has(x));
  if (!sp.length) return null;
  const lines = sp.map((id) => {
    const q = queue.question?.[id];
    const a = queue.resolutions?.[id];
    const what = q?.text ? ` (${q.type ?? 'question'}): "${q.text}"` : '';
    if (a?.answer == null)
      return `- ${id}${what} Resolved${a?.time ? ` ${utcText(a.time)}` : ''}, but the answer is not in the queue: see the decision log.`;
    const word = q?.type === 'condition' || q?.type === 'lawyer' ? 'Fulfilled' : 'Answer';
    return `- ${id}${what} ${word}: "${a.answer}" (${a.by ?? '?'}, ${utcText(a.time)}).`;
  });
  return [
    '**Owner answer to what the task waited on** (binding; from `cq resolve`, entered in the decision log by the orchestrator):',
    ...lines,
  ].join('\n');
}

// ---- Migration block as text (common for start and pick) ------------------------------------------------------

/** "3450–3459" from { from, to }, or null when the task has no migrations. */
function migrBlockText(b) {
  if (b?.from == null) return null;
  return `${b.from}–${b.to}`;
}

// ---- Picking ---------------------------------------------------------------------------------------

/**
 * Tasks that can be picked now: status waiting, no open dependencies or owner questions, and no ownership collision
 * with running/review/picked. Sorted by priority (with the project's bonus). Pause only stops the queue; a
 * task in a paused project can still be picked, and the row says `paused: true`.
 * @param {{ label?: string, project?: string, maxMin?: number, uncommitted?: string[] }} filter
 *   `uncommitted`: the paths from `git status` in the main tree. A task that owns one of them still stays on the list
 *   (picking is a manual choice), but the row says `uncommitted: <path>` so the one picking sees it.
 */
function pickable(queue, { label, project, maxMin, uncommitted = [] } = {}, now = Date.now()) {
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  // Common ranking. Parked ones are skipped; outside the focus still stays on the list (picking is a manual
  // choice, as for a paused project), but last and with `outside_focus: true`.
  const k = rankingContext(queue, now);
  return tasks
    .filter((o) => o.status === 'waiting' && blockers(o, tasks, queue.resolved).length === 0)
    .filter((o) => !label || hasLabel(o, label))
    .filter((o) => !project || projectFor(o, register) === project)
    .filter((o) => maxMin == null || estimate(o) <= maxMin)
    .map((o) => ({ o, r: ranking(o, queue, k) }))
    .filter(({ r }) => !r.parked)
    .sort(compareRanking)
    .map(({ o, r }) => ({
      id: o.id,
      title: o.title,
      class: o.class,
      domain: o.domain,
      estimate: estimate(o),
      score: r.score,
      project: projectFor(o, register),
      feature: o.feature ?? null,
      labels: o.labels ?? [],
      migr: Number(o.migr_tens ?? 0) > 0,
      paused: r.paused,
      uncommitted: uncommittedCollision(o, uncommitted)?.path ?? null,
      ...(k.applies ? { step: r.step, dragged_by: r.dragged_by, outside_focus: r.outside } : {}),
    }));
}

/**
 * Picks a task: waiting → picked, with queue branch (`<branchPrefix><id>`) and migration block as with `start`. Refuses on open
 * dependencies, owner questions or ownership collision with running/review/picked; `force` (owner's word) overrides those
 * three, never the status (a proposed task must be approved first, and something that is running cannot be picked). A migration block
 * the task already has (e.g. after `release`) is reused, so the numbers on a kept branch are still its own.
 * Changes `queue` (the caller writes the file under lock).
 * @returns {{ error: string, blockers?: string[] } | { task: object, overridden: string[] }}
 */
function pick(
  queue,
  id,
  {
    by,
    force = false,
    now = new Date().toISOString(),
    migrations = cfg().migrations,
    taken = [],
  } = {},
) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  const who = String(by ?? '').trim();
  if (!who) return { error: 'pick requires --by "<who>" (the person or session doing the task)' };
  if (o.status !== 'waiting') {
    const why =
      o.status === 'picked'
        ? `already picked by ${o.picked_by ?? '?'}`
        : o.status === 'proposed'
          ? `proposed (approve it first: cq approve ${id})`
          : `status ${o.status}`;
    return { error: `${id} cannot be picked: ${why}` };
  }
  // The batch queue is not overridden with --force; the task is taken out with edit (batched:false) or packed.
  if (isBatched(o))
    return { error: `${id} cannot be picked: ${BATCHED_BLOCKER}`, blockers: [BATCHED_BLOCKER] };
  const h = blockers(o, queue.tasks, queue.resolved);
  // A parked task is not picked without --force (focus and pause do not stop picking, as before).
  if (parkedNow(o, Date.parse(now))) h.unshift(parkedText(o));
  if (h.length && !force)
    return {
      error: `${id} cannot be picked: ${h.join(' · ')} (--force overrides, only on the owner's word)`,
      blockers: h,
    };
  const tens = migrTens(o, migrations);
  let block = null;
  if (tens > 0) {
    if (o.migr_block) block = o.migr_block;
    else {
      if (!Number.isFinite(Number(queue.next_migr)))
        return { error: 'the queue is missing next_migr; cannot assign a migration block' };
      // Past blocks that are already taken (the caller gives `taken`, see takenBlocks).
      block = assignStartBlock(queue, o, taken, migrations).block;
    }
  }
  o.status = 'picked';
  o.picked_by = who;
  o.picked_at = now;
  o.branch = queueBranch(id);
  o.migr_block = block;
  if (force && h.length)
    o.remarks = [...(o.remarks ?? []), `${now} picked with --force past: ${h.join(' · ')}`];
  return { task: o, overridden: force ? h : [] };
}

/** Delivers a picked task to review (picked → review). `picked_by` stays (history, and takes no agent slot). */
function deliver(queue, id, now = new Date().toISOString()) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (o.status !== 'picked') return { error: `${id} is not picked (status ${o.status})` };
  o.status = 'review';
  if (!o.delivered) o.delivered = now;
  return { task: o };
}

/**
 * Releases a picked task (picked → waiting) and removes the pick fields. The queue branch and the migration block are kept.
 * `commits` (ahead of baseBranch on the queue branch, counted by the caller) gives a warning and a remark on the task.
 */
function release(queue, id, { commits = 0, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (o.status !== 'picked') return { error: `${id} is not picked (status ${o.status})` };
  const by = o.picked_by;
  o.status = 'waiting';
  delete o.picked_by;
  delete o.picked_at;
  delete o.cloud; // a released cloud session has ended
  let warning = null;
  if (commits > 0) {
    const branch = o.branch ?? queueBranch(id);
    warning =
      `${branch} has ${commits} commit(s) that are not on ${baseBranch()}. Branch kept. NB: when the queue starts ` +
      `the task again, prepare-track creates the branch from ${baseBranch()} (checkout -B) and the commits fall out of it; save them ` +
      `first (git branch ${branch}-released ${branch}) or pick the task again and keep building.`;
    o.remarks = [
      ...(o.remarks ?? []),
      `${now} released by ${by ?? '?'}; ${branch} had ${commits} commit(s) ahead of ${baseBranch()}`,
    ];
  }
  return { task: o, by, warning };
}

/**
 * Is a picked task "old"? Picked more than 72 h ago and without commits in the last 72 h (no commits on
 * the queue branch, or the last commit older than 72 h). Only a marker: it is never released automatically.
 * @param {{ commits?: number, lastCommit?: string|null }} git commits ahead of baseBranch and the time of the last one
 */
function isOldPick(o, { commits = 0, lastCommit = null } = {}, now = Date.now()) {
  if (o?.status !== 'picked' || !o.picked_at) return false;
  if (!(now - Date.parse(o.picked_at) > OLD_PICK_MS)) return false;
  if (!commits) return true;
  const last = lastCommit ? Date.parse(lastCommit) : NaN;
  return Number.isFinite(last) && now - last > OLD_PICK_MS;
}

/** "14 min", "3 h 12 min", "4 d" from milliseconds ("?" when unknown). */
function ageText(ms) {
  if (ms == null || Number.isNaN(ms)) return '?';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const t = Math.floor(min / 60);
  return t < 48 ? `${t} h ${min % 60} min` : `${Math.floor(t / 24)} d`;
}

// ---- Status and visual QA ---------------------------------------------------------------------------

/**
 * Sets the status with its side effects (`queue.mjs set`): delivered on review, done time, and `qa_status: "waiting"` when a
 * task with the label `visual` becomes done (from another status). `picked` is set only with `pick` (branch and
 * migration block). If a picked task goes back to waiting/proposed, the pick fields are removed (like `release`).
 * @returns {{ error: string } | { task: object, qa: boolean }}
 */
function setStatus(o, status, now = new Date().toISOString()) {
  if (!STATUSES.has(status)) return { error: `unknown status ${status}` };
  if (status === 'picked')
    return {
      error: 'status picked is set with cq pick <id> --by "<who>" (assigns branch and migration block)',
    };
  // Status external belongs only to records outside the queue, and such a record never becomes a task
  // that the queue can start (set waiting would have turned it into one).
  if (status === 'external')
    return {
      error: 'status external is set with cq external add --name "<session>" --files <…> (record outside the queue)',
    };
  if (isExternalRow(o) && status !== 'done' && status !== 'cancelled')
    return {
      error: `${o.id} is a record outside the queue; it can only be ended (cq external done "${o.external_name ?? o.id}")`,
    };
  const from = o.status;
  if (status === 'review' && !o.delivered) o.delivered = now;
  let qa = false;
  if (status === 'done') {
    o.done = now;
    if (from !== 'done' && hasLabel(o, LABEL_VISUAL)) {
      o.qa_status = 'waiting';
      qa = true;
    }
  }
  if (from === 'picked' && (status === 'waiting' || status === 'proposed')) {
    delete o.picked_by;
    delete o.picked_at;
    delete o.cloud;
  }
  o.status = status;
  return { task: o, qa };
}

/** QA list: finished tasks with `qa_status: "waiting"`, grouped project → feature (groups). */
function qaList(queue) {
  const i = (queue.tasks ?? []).filter((o) => o.status === 'done' && o.qa_status === 'waiting');
  return groups(i, queue.projects ?? {});
}

/**
 * The owner has looked at tasks and approves them: qa_status → ok. Applies to finished tasks that wait on QA or
 * have a deviation (checked again after the fix). All or nothing, like `approve`.
 * @returns {{ ok: string[], error: string[] }}
 */
function qaOk(queue, ids, now = new Date().toISOString()) {
  const error = [];
  const found = [];
  for (const id of ids) {
    const o = (queue.tasks ?? []).find((x) => x.id === id);
    if (!o) error.push(`unknown task ${id}`);
    else if (o.status !== 'done') error.push(`${id} is not done (status ${o.status})`);
    else if (o.qa_status !== 'waiting' && o.qa_status !== 'deviation')
      error.push(`${id} is not in the QA list (qa_status ${o.qa_status ?? 'none'})`);
    else found.push(o);
  }
  if (error.length) return { ok: [], error };
  for (const o of found) {
    o.qa_status = 'ok';
    o.qa_ok = now;
  }
  return { ok: found.map((o) => o.id), error: [] };
}

/**
 * The owner found a deviation: qa_status → deviation, `qa_note` = the text, and a fix task `<id>-QA<n>` is added
 * (K, same project and feature, the label visual, the original's files, mission = the text + link to the original,
 * added_by "owner", status waiting). A deviation on a fix task numbers on from the original (X-QA1 → X-QA2).
 * @returns {{ error: string } | { task: object, fix: object }}
 */
function qaDeviation(queue, id, text, now = new Date().toISOString()) {
  const tasks = queue.tasks ?? [];
  const o = tasks.find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (o.status !== 'done')
    return { error: `${id} is not done (status ${o.status}); QA applies to finished tasks` };
  const t = String(text ?? '').trim();
  if (!t) return { error: 'qa deviation requires a text: what is wrong, and where' };
  const root = typeof o.qa_original === 'string' && o.qa_original ? o.qa_original : id;
  const pattern = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-QA(\\d+)$`);
  const n =
    1 +
    tasks.reduce((m, x) => {
      const match = pattern.exec(x.id);
      return match ? Math.max(m, Number(match[1])) : m;
    }, 0);
  const register = queue.projects ?? {};
  const pid = projectFor(o, register);
  const summary = t.length > 90 ? `${t.slice(0, 87)}...` : t;
  const isPath = typeof o.mission === 'string' && !/\n/.test(o.mission) && /\.md$/i.test(o.mission);
  const link = isPath
    ? `the mission: ${o.mission}`
    : `the mission is on ${o.id} in the queue (cq show --all)`;
  const fix = {
    id: `${root}-QA${n}`,
    title: `QA fix of ${o.id}: ${summary}`,
    domain: o.domain,
    class: 'K',
    ...(pid !== WITHOUT_PROJECT ? { project: pid } : {}),
    ...(typeof o.feature === 'string' && o.feature ? { feature: o.feature } : {}),
    labels: [LABEL_VISUAL],
    mission:
      `The owner found a deviation in visual QA of ${o.id} ("${o.title}"):\n\n${t}\n\n` +
      `The original: ${o.id}, ${link}. Fix the deviation and keep the rest of the original's behavior.`,
    value: Number(o.value ?? 5),
    content_min: 20,
    migr_tens: 0,
    depends_on: [],
    waiting_on: [],
    owned_files: [...(o.owned_files ?? [])],
    owner_db: [],
    shared_patch: [],
    source: `qa deviation ${o.id}`,
    added_by: 'owner',
    qa_original: root,
  };
  // Without register: the project is inherited from the original, not written in again (it can be an older, explicit
  // project that is not in the register).
  const f = validate(fix, tasks);
  if (f.length) return { error: `fix task ${fix.id} is invalid: ${f.join('; ')}` };
  fix.status = statusAtAdd(fix, tasks);
  fix.added_at = now;
  o.qa_status = 'deviation';
  o.qa_note = t;
  o.remarks = [...(o.remarks ?? []), `${now} QA deviation, fix ${fix.id}`];
  tasks.push(fix);
  return { task: o, fix };
}

// ---- Work outside the queue ----------------------------------------------------------------------------
//
// Other sessions commit straight to baseBranch, create branches (hotfix/*) and have uncommitted files in the main tree. The queue must
// know about it: it does not start a track that collides, and it does not build something that is already done. The git reading lives in
// queueGit.js; here are only the decisions.

/** The trailer the orchestrator sets on its own commits on baseBranch: `git commit --trailer "Queue: orchestrator" …`. */
const ORCHESTRATOR_TRAILER = 'Queue: orchestrator';
const ORCHESTRATOR_TRAILER_PATTERN = /^Queue:[ \t]*orchestrator[ \t]*$/im;
/** The orchestrator cursor (scripts/.queue/orchestrator.json) is considered expired after this long without an update. */
const ORCHESTRATOR_EXPIRY_MS = 2 * 3_600_000;
/** Tasks that are compared with changes outside the queue (collisions), in display order. */
const COLLISION_STATUSES = ['running', 'picked', 'review', 'waiting'];

/** Is the row a record of work outside the queue (`queue.mjs external add`), not a task? */
function isExternalRow(o) {
  return o?.external === true;
}

/** Does the commit message have the trailer "Queue: orchestrator" (on its own line)? */
function hasOrchestratorTrailer(message) {
  return ORCHESTRATOR_TRAILER_PATTERN.test(String(message ?? ''));
}

/**
 * The task id from the merge track message "Merge branch '<branchPrefix><id>' into <baseBranch>", otherwise null.
 * @param {string} subject
 * @param {string} [prefix] default config().branchPrefix
 */
function queueIdFromMerge(subject, prefix = branchPrefix()) {
  const m = new RegExp(`^Merge branch '${regexSafe(prefix)}([^']+)'`).exec(String(subject ?? ''));
  return m ? m[1] : null;
}

/**
 * Where does a commit on the base branch's first-parent line come from? `queue` = merge of a queue branch (merge-track.mjs, also a
 * picked task that the one who picked it merged themselves), `orchestrator` = the trailer "Queue: orchestrator", otherwise `external`.
 * A merge of another branch (hotfix/*, <remote>/<baseBranch>) is external; queueGit.js also looks at the commits it brings along.
 * @param {{ parents?: string[], subject?: string, message?: string }} c
 * @returns {{ source: 'queue'|'orchestrator'|'external', queue_id?: string }}
 */
function classifyCommit(c) {
  if ((c?.parents?.length ?? 0) >= 2) {
    const id = queueIdFromMerge(c.subject);
    if (id) return { source: 'queue', queue_id: id };
  }
  if (hasOrchestratorTrailer(c?.message)) return { source: 'orchestrator' };
  return { source: 'external' };
}

const regexSafe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The task ids that appear in the text as whole words: "(A-T8c)", "A-T8c:", "A-T8c." and "A-T8c" at the end match;
 * "A-T8c2", "A-T8c-QA1" and "XA-T8c" do not (then it is another id).
 */
function mentionedIds(text, ids) {
  const t = String(text ?? '');
  const out = [];
  for (const id of ids ?? []) {
    if (!id || !t.includes(id)) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])${regexSafe(id)}(?![A-Za-z0-9_-])`);
    if (re.test(t)) out.push(id);
  }
  return out;
}

/**
 * Consistency: external commits that mention a task in the queue. For a pending task the suggestion is
 * `queue.mjs external accept <id> <sha>` (it may have been done outside the queue); this is never done automatically.
 * @param {{ sha: string, summary?: string, subject?: string, message?: string, side?: { message?: string }[] }[]} externalOnes
 * @returns {{ sha: string, summary: string, subject: string, id: string, status: string, proposed: string|null }[]}
 */
function consistency(externalOnes, tasks) {
  const perId = new Map((tasks ?? []).filter((o) => !isExternalRow(o)).map((o) => [o.id, o]));
  const ids = [...perId.keys()];
  const out = [];
  for (const c of externalOnes ?? []) {
    const summary = c.summary ?? String(c.sha).slice(0, 8);
    // The subject, the message and the messages of the commits an external merge brings along.
    const text = [c.subject, c.message, ...(c.side ?? []).map((s) => s.message)].join('\n');
    for (const id of mentionedIds(text, ids)) {
      const o = perId.get(id);
      out.push({
        sha: c.sha,
        summary,
        subject: c.subject ?? '',
        id,
        status: o.status,
        proposed: o.status === 'waiting' ? `cq external accept ${id} ${summary}` : null,
      });
    }
  }
  return out;
}

/**
 * The push check: the first-parent commits in <remote>/<baseBranch>..<baseBranch>, OLDEST FIRST, each with `source`.
 * - `externalOnes`: the commits with source external (empty = safe to push everything).
 * - `cutPoint`: the sha of the last commit before the first external one, when ALL commits from the first external one onward are
 *   external. The queue's and the orchestrator's part then sits together in front and can be pushed alone with `git push <remote> <sha>:<baseBranch>`.
 *   null when the first commit is already external (the queue has nothing to push alone) or when they are interleaved.
 * - `merged`: a queue or orchestrator commit comes after an external one. Then the external ones cannot be held back
 *   without rewriting history, and that is never done.
 */
function pushPlan(firstParents) {
  const list = firstParents ?? [];
  const i = list.findIndex((c) => c.source === 'external');
  const countOf = (k) => list.filter((c) => c.source === k).length;
  const common = { total: list.length, queue: countOf('queue'), orchestrator: countOf('orchestrator') };
  if (i < 0)
    return {
      ...common,
      externalOnes: [],
      cutPoint: null,
      merged: false,
      ownForCut: list.length,
    };
  const merged = list.slice(i).some((c) => c.source !== 'external');
  return {
    ...common,
    externalOnes: list.filter((c) => c.source === 'external'),
    cutPoint: !merged && i > 0 ? list[i - 1].sha : null,
    merged,
    ownForCut: i,
  };
}

/** The first owned file in the task that an uncommitted path in the main tree overlaps: { file (the owned file), path }, otherwise null. */
function uncommittedCollision(o, uncommitted) {
  for (const f of o?.owned_files ?? []) {
    for (const u of uncommitted ?? []) {
      const filePath = typeof u === 'string' ? u : u?.path;
      if (filePath && fileOverlap(f, filePath)) return { file: norm(f), path: norm(filePath) };
    }
  }
  return null;
}

/**
 * Tasks `next` skips because they collide with an uncommitted file in the main tree: the pending ones that could otherwise
 * be started (no blockers, the project not paused). [{ id, file, path }].
 */
function uncommittedSkipped(queue, uncommitted) {
  const tasks = queue.tasks ?? [];
  const rk = rankingContext(queue);
  const out = [];
  for (const o of tasks) {
    // What selectNext would not start anyway (paused, parked, outside focus) is not "skipped".
    if (o.status !== 'waiting' || focusSpace(o, rk).out) continue;
    const k = uncommittedCollision(o, uncommitted);
    if (k && blockers(o, tasks, queue.resolved).length === 0) out.push({ id: o.id, ...k });
  }
  return out;
}

/**
 * Collisions between work outside the queue and the owned files of tasks that are running, picked, in review or waiting.
 * @param {object[]} tasks the queue's tasks
 * @param {{ commits?: { sha: string, summary?: string, subject?: string, files: string[], date?: string }[],
 *           branches?: { name: string, files: string[] }[], uncommitted?: (string|{ path: string })[] }} sources
 *   commits = the external ones, with the date they landed on baseBranch; a commit counts only for tasks that were added
 *   BEFORE it landed. Branches (outside the queue branches, not merged) and uncommitted files always count.
 * @returns {{ id: string, status: string, file: string, owner: string, source: 'commit'|'branch'|'uncommitted',
 *             sha?: string, summary?: string, subject?: string, date?: string, branch?: string }[]}
 */
function externalCollisions(tasks, sources = {}, { statuses = COLLISION_STATUSES } = {}) {
  // Index path → sources, so each owned file is looked up instead of being compared with all changed files.
  const index = new Map();
  const addTo = (filePath, source) => {
    const s = norm(filePath ?? '');
    if (!s) return;
    if (!index.has(s)) index.set(s, []);
    index.get(s).push(source);
  };
  for (const c of sources.commits ?? []) {
    const summary = c.summary ?? String(c.sha).slice(0, 8);
    for (const f of c.files ?? [])
      addTo(f, { source: 'commit', sha: c.sha, summary, subject: c.subject ?? '', date: c.date });
  }
  for (const g of sources.branches ?? []) {
    for (const f of g.files ?? []) addTo(f, { source: 'branch', branch: g.name });
  }
  for (const u of sources.uncommitted ?? [])
    addTo(typeof u === 'string' ? u : u?.path, { source: 'uncommitted' });
  // Untracked folders ("?? new-folder/") own everything below them.
  const folders = [...index.keys()].filter((s) => s.endsWith('/'));

  const sequence = new Map(statuses.map((s, i) => [s, i]));
  const out = [];
  const set = new Set();
  for (const o of tasks ?? []) {
    if (isExternalRow(o) || !sequence.has(o.status)) continue;
    const addedAt = o.added_at ? Date.parse(o.added_at) : NaN;
    const match = (filePath, list, owner) => {
      for (const k of list) {
        // A commit that landed before the task was added is already part of the basis for the mission.
        if (
          k.source === 'commit' &&
          Number.isFinite(addedAt) &&
          k.date &&
          !(Date.parse(k.date) > addedAt)
        )
          continue;
        const key = `${o.id}|${filePath}|${k.source}|${k.sha ?? k.branch ?? ''}`;
        if (set.has(key)) continue;
        set.add(key);
        out.push({ id: o.id, status: o.status, file: filePath, owner, ...k });
      }
    };
    for (const e of o.owned_files ?? []) {
      const f = norm(e);
      if (f.endsWith('/')) {
        for (const [filePath, list] of index) if (fileOverlap(f, filePath)) match(filePath, list, f);
      } else {
        if (index.has(f)) match(f, index.get(f), f);
        for (const m of folders) if (f.startsWith(m)) match(m, index.get(m), f);
      }
    }
  }
  return out.sort((x, y) => sequence.get(x.status) - sequence.get(y.status) || x.id.localeCompare(y.id));
}

/** "<id>: the file X was changed outside the queue in <sha> "subject"" / "… on branch <branch>" / "… is uncommitted in the main tree". */
function collisionText(k, { withId = true } = {}) {
  const file = k.file === k.owner ? k.file : `${k.file} (under ${k.owner})`;
  const where =
    k.source === 'commit'
      ? `was changed outside the queue in ${k.summary} "${String(k.subject ?? '').slice(0, 70)}"`
      : k.source === 'branch'
        ? `was changed outside the queue on branch ${k.branch} (not in ${baseBranch()})`
        : 'is uncommitted in the main tree (another session is working in it)';
  return `${withId ? `${k.id}: ` : ''}the file ${file} ${where}`;
}

/**
 * The warning `trackFile` writes into the track block when the owned files have changed outside the queue since the task was added,
 * so the track reads the diff before it builds on an outdated mission. null when there is nothing to warn about.
 * @param {object} o the task
 * @param {object[]} collisions externalCollisions for this task
 * @param {{ summary: string, subject?: string }[]} mentioned external commits that mention the id
 */
function trackFileWarning(o, collisions = [], mentioned = []) {
  if (!collisions.length && !mentioned.length) return null;
  const MAX = 12;
  const lines = [
    `**WARNING from the queue (work outside the queue): your owned files have changed outside the queue since the task was added ` +
      `(${o.added_at ?? 'unknown time'}).** The mission may be outdated. Read the diff before you build on, and write in ` +
      'the report what no longer holds:',
  ];
  for (const k of collisions.slice(0, MAX)) {
    if (k.source === 'commit')
      lines.push(
        `- \`${k.file}\` in ${k.summary} "${String(k.subject ?? '').slice(0, 70)}": \`git show ${k.summary} -- ${k.file}\``,
      );
    else if (k.source === 'branch')
      lines.push(
        `- \`${k.file}\` on branch ${k.branch} (not merged to ${baseBranch()}): ` +
          `\`git diff ${baseBranch()}...${k.branch} -- ${k.file}\``,
      );
    else
      lines.push(
        `- \`${k.file}\` is uncommitted in the main tree: another session is working in the file. Do not touch it; report to the orchestrator.`,
      );
  }
  if (collisions.length > MAX)
    lines.push(`- … and ${collisions.length - MAX} more (cq external)`);
  if (mentioned.length)
    lines.push(
      `Commits outside the queue that mention ${o.id} (is something already done?): ` +
        mentioned
          .slice(0, 5)
          .map((c) => `${c.summary} "${String(c.subject ?? '').slice(0, 60)}"`)
          .join(', '),
    );
  return lines.join('\n');
}

/** Id for a new record outside the queue: external-<name as kebab-case>, with -2, -3 … when it already exists. */
function externalId(name, tasks = []) {
  const slug =
    String(name ?? '')
      .toLowerCase()
      .replace(/\u00E6/g, 'ae')
      .replace(/\u00F8/g, 'o')
      .replace(/\u00E5/g, 'a')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'session';
  const ids = new Set(tasks.map((o) => o.id));
  let id = `external-${slug}`;
  for (let n = 2; ids.has(id); n++) id = `external-${slug}-${n}`;
  return id;
}

/**
 * Registers work in progress outside the queue (`queue.mjs external add`): a row with status `external` that owns the files (and
 * the DB functions, if any) like a picked task, until `external done <name>`. The same name again while the row is active
 * adds the files (and sets the branch when given). Changes `queue` (the caller writes the file under lock).
 * @returns {{ error: string } | { row: object, new: boolean, warnings: string[] }}
 */
function externalAdd(
  queue,
  { name, files = [], db = [], branch = null, now = new Date().toISOString() } = {},
) {
  const who = String(name ?? '').trim();
  if (!who) return { error: 'external add requires --name "<session or person>"' };
  const newFiles = [...new Set((files ?? []).map((f) => norm(f).trim()).filter(Boolean))];
  const newDb = [...new Set((db ?? []).map((d) => String(d).trim()).filter(Boolean))];
  if (!newFiles.length && !newDb.length)
    return {
      error: 'external add requires --files <path …> (folder with "/" at the end), or --db <function …>',
    };
  queue.tasks = queue.tasks ?? [];
  let row = queue.tasks.find(
    (o) => isExternalRow(o) && o.status === 'external' && o.external_name === who,
  );
  const fresh = !row;
  if (row) {
    row.owned_files = [...new Set([...(row.owned_files ?? []), ...newFiles])];
    row.owner_db = [...new Set([...(row.owner_db ?? []), ...newDb])];
    if (branch) row.branch = branch;
    row.updated = now;
  } else {
    row = {
      id: externalId(who, queue.tasks),
      title: `Work outside the queue: ${who}`,
      domain: 'external',
      class: 'K',
      mission:
        'Registered with cq external add. Not a task: the row owns the files until external done.',
      value: 5,
      content_min: 0,
      migr_tens: 0,
      depends_on: [],
      waiting_on: [],
      owned_files: newFiles,
      owner_db: newDb,
      shared_patch: [],
      status: 'external',
      external: true,
      external_name: who,
      ...(branch ? { branch } : {}),
      added_at: now,
      added_by: who,
    };
    const f = validate(row, queue.tasks);
    if (f.length) return { error: `the record is invalid: ${f.join('; ')}` };
    queue.tasks.push(row);
  }
  // Warnings: tasks in the queue that already own the same thing (they must talk), and pending ones that are now held back.
  const warnings = [];
  const held = [];
  for (const o of queue.tasks) {
    if (o === row || isExternalRow(o)) continue;
    const k = conflict(o, row);
    if (!k) continue;
    if (ACTIVE.has(o.status))
      warnings.push(
        `${o.id} (${o.status}) owns the same thing: ${k.replace(/ is owned by .*$/, '')}; tell the orchestrator`,
      );
    else if (o.status === 'waiting') held.push(o.id);
  }
  if (held.length)
    warnings.push(
      `${held.length} pending task(s) are not started before external done: ${held.slice(0, 8).join(', ')}${held.length > 8 ? ' …' : ''}`,
    );
  return { row, new: fresh, warnings };
}

/** Ends a record outside the queue (by name or id): status done, and the files are free again. */
function externalDone(queue, nameOrId, now = new Date().toISOString()) {
  const x = String(nameOrId ?? '').trim();
  if (!x) return { error: 'external done <name>' };
  const row = (queue.tasks ?? []).find(
    (o) => isExternalRow(o) && o.status === 'external' && (o.external_name === x || o.id === x),
  );
  if (!row)
    return { error: `no active record outside the queue with the name ${x} (see cq external)` };
  row.status = 'done';
  row.done = now;
  return { row };
}

/**
 * The owner or the orchestrator accepts that a pending task was done outside the queue (`queue.mjs external accept <id> <sha>`):
 * status done with the remark "done outside the queue in <sha>". Never automatic. `mentioned` = the commit message mentions the id
 * (otherwise the remark says so). A visual task lands in the QA list as with `set done`.
 * @returns {{ error: string } | { task: object, qa: boolean }}
 */
function externalAccept(queue, id, sha, { mentioned = true, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (isExternalRow(o))
    return { error: `${id} is a record outside the queue (cq external done)` };
  if (!sha) return { error: 'external accept <id> <sha>' };
  if (o.status !== 'waiting' && o.status !== 'proposed') {
    const why =
      o.status === 'picked' ? `picked by ${o.picked_by ?? '?'}` : `status ${o.status}`;
    return { error: `${id} cannot be accepted as done outside the queue: ${why}` };
  }
  const s = setStatus(o, 'done', now);
  if (s.error) return s;
  o.done_outside_queue = sha;
  o.remarks = [
    ...(o.remarks ?? []),
    `${now} done outside the queue in ${String(sha).slice(0, 8)}${mentioned ? '' : ' (the commit message does not mention the id)'}`,
  ];
  return { task: o, qa: s.qa };
}

/**
 * Is an orchestrator active? The cursor (scripts/.queue/orchestrator.json: { session, updated, event }) is updated by
 * the orchestrator on each loop round (`queue.mjs orchestrator pulse`, and by `start`/`set`), and is considered expired after 2 h.
 */
function orchestratorStatus(cursor, now = Date.now()) {
  if (!cursor || !cursor.updated)
    return { active: false, session: null, age_ms: null, reason: 'no marker' };
  const age = now - Date.parse(cursor.updated);
  if (!Number.isFinite(age))
    return { active: false, session: cursor.session ?? null, age_ms: null, reason: 'invalid timestamp' };
  const active = age <= ORCHESTRATOR_EXPIRY_MS;
  return {
    active,
    session: cursor.session ?? null,
    age_ms: age,
    event: cursor.event ?? null,
    reason: active ? null : 'expired (over 2 h without update)',
  };
}

/** New marker: the session name is the one given, otherwise the previous marker's, otherwise "orchestrator". */
function newCursor(previous, { session, event, now = new Date().toISOString() } = {}) {
  const name = String(session ?? '').trim() || previous?.session || 'orchestrator';
  const m = { session: name, updated: now, event: event ?? null };
  // The session binding (session_id/session_id_time, set by hook-context.mjs) and the wind-down flag carry over as
  // long as it is the same session (same name) and the cursor is not expired. A new name (or an expired marker) means that a
  // new session takes the cursor: then both are reset, and session_id_time is set to now, so only orchestrator calls made AFTER
  // the takeover can bind a session (contextGuard.orchestratorBinding).
  const live = previous != null && orchestratorStatus(previous, Date.parse(now)).active;
  if (live && name === previous.session) {
    if (previous.session_id) m.session_id = previous.session_id;
    if (previous.session_id_time != null) m.session_id_time = previous.session_id_time;
    if (previous.windDown) m.windDown = previous.windDown;
  } else if (previous) {
    m.session_id_time = Date.parse(now);
  }
  return m;
}

/**
 * Tasks in work (proposed, waiting, running, picked, review) that are missing a project (land in without-project, only
 * when the register has projects) or feature. New tasks should have both (add-to-queue); another session that adds
 * without them becomes visible here and in `add`.
 */
function missingProject(tasks, register) {
  const inWork = new Set(['proposed', 'waiting', 'running', 'picked', 'review']);
  const withRegister = Object.keys(register ?? {}).length > 0;
  const withoutProject = [];
  const withoutFeature = [];
  for (const o of tasks ?? []) {
    if (isExternalRow(o) || !inWork.has(o.status)) continue;
    if (withRegister && projectFor(o, register) === WITHOUT_PROJECT) withoutProject.push(o.id);
    if (typeof o.feature !== 'string' || !o.feature.trim()) withoutFeature.push(o.id);
  }
  return { withoutProject, withoutFeature };
}

// ---- The track block (trackFile and cloud-package) ------------------------------------------------------------------------

/**
 * The track block from the heading "## TRACK …" down: the ownership, a warning about changes outside the queue if any, owner answers
 * and the mission text. `queue.mjs trackFile` puts TITLE/BLOCK/BRANCH in front; `cloud-package` puts it under "## The mission".
 * @param {object} o the task
 * @param {object} queue the queue (for answerBlock)
 * @param {{ text: string, warning?: string|null, cloud?: boolean }} v `cloud`: the cloud session has no SendMessage, so
 *   the ownership line says "stop" instead of "report".
 */
function trackBlock(o, queue, { text, warning = null, cloud = false } = {}) {
  const list = (x) => (Array.isArray(x) && x.length ? x.join(', ') : 'none');
  const reportFrom = cloud
    ? 'if you need to, stop with CLOUD-STOP and say what is needed.'
    : 'if you need to, report it (SendMessage) instead of editing it.';
  const answer = answerBlock(o, queue);
  return [
    `## TRACK ${o.id} (${o.title}; source: ${o.source ?? 'see the mission'}; class ${o.class}, estimate ${estimate(o)} min)`,
    '',
    `**Ownership in the queue:** files ${list(o.owned_files)}; DB ${list(o.owner_db)}; shared patch ${list(o.shared_patch)}. Do not touch anything other tasks in the queue own; ${reportFrom}`,
    '',
    ...(warning ? [warning, ''] : []),
    ...(answer ? [answer, ''] : []),
    String(text ?? '').trim(),
    // `queue.mjs edit <id> --bonus "…"` (instead of node -e against queue.json).
    ...(bonusBlock(o) ? ['', bonusBlock(o)] : []),
    '',
  ].join('\n');
}

// ---- Cloud: queue tasks in cloud sessions on claude.ai --------------------------------------------------------
// The cloud session only sees what is pushed to the remote and has no database. So only client/tool tasks
// (K, U) without migrations and DB are suitable, and only when the owned files are pushed. The orchestrator (or the owner from the board) sends
// the package; the cloud pushes the queue branch (<branchPrefix><id>, or the branch the session is allowed to use), and the orchestrator merges as
// usual.

/** Who a cloud session appears as in `picked_by`. */
const CLOUD_BY = 'cloud';
/** At most this many cloud sessions concurrently (does not count toward maxConcurrent). */
const CLOUD_MAX = 3;
const CLOUD_CLASSES = new Set(['K', 'U']);
// The field `requires` (set when the task is added): what the task needs beyond the repo on the remote.
// The resources in CLOUD_CLOSED do not exist in a cloud session (no database, the network is blocked behind a proxy, gitignored
// files, local source collections and the owner's device are local), so the task runs locally. `deploy` does not close:
// the orchestrator deploys after the merge.
const REQUIRES = new Set(['db', 'web', 'sources', 'local-files', 'unit', 'deploy']);
const CLOUD_CLOSED = new Map([
  ['db', 'needs the database (test runs against a database)'],
  ['web', 'needs the network (downloads or external sources; the cloud is behind a block)'],
  ['sources', 'needs local source collections or primary sources'],
  ['local-files', 'needs files that only exist locally (gitignored or untracked)'],
  ['unit', "needs the owner's device or a running app"],
]);

/** Is the task in a cloud session now? (picked by "cloud", with the cloud field set by `cloud start`) */
function isCloud(o) {
  return o?.status === 'picked' && o.picked_by === CLOUD_BY && !!o.cloud;
}

/**
 * The areas the cloud does not see (gitignored or untracked). The queue's dataFolder (scripts/.queue/) is always included; the folders in
 * config().cloudHidden (list of paths, e.g. 'docs/private/') are added.
 */
function cloudHidden() {
  const extra = Array.isArray(cfg().cloudHidden) ? cfg().cloudHidden : [];
  return [
    ...extra
      .map((s) => String(s).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .map((s) => ({
        pattern: new RegExp(`(^|/)${regexSafe(s)}(/|$)`),
        area: `${s}/`,
        boostable: true,
      })),
    { pattern: /(^|\/)scripts\/\.queue(\/|$)/, area: 'scripts/.queue/', boostable: false },
  ];
}
// A line that says the binding content is lifted into the mission (the template's "GITIGNORED; everything binding is lifted in here"),
// is a source reference, not something the cloud needs to read.
const BOOSTED_IN = /lifted in|everything binding/i;

/**
 * The references in the mission text to files the cloud does not see. The task's own mission file does not count (it is put
 * into the package). `boosted`: the line says the binding content is lifted in (does not apply to scripts/.queue/, where other
 * tasks' missions live).
 * @returns {{ path: string, area: string, boosted: boolean }[]} unique paths in order
 */
function cloudReferences(text, { id, ownPath } = {}) {
  const own = ownPath ? norm(ownPath).toLowerCase() : null;
  const hiddenOnes = cloudHidden();
  const out = [];
  const set = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const boosted = BOOSTED_IN.test(line);
    for (const raw of line.replace(/\\/g, '/').split(/[\s`'"()<>[\]|,;\u00AB\u00BB*]+/)) {
      const filePath = raw.replace(/[.:]+$/, '');
      if (!filePath) continue;
      const match = hiddenOnes.find((u) => u.pattern.test(filePath));
      if (!match) continue;
      const low = filePath.toLowerCase();
      if (own && (low === own || low.endsWith(`/${own}`))) continue;
      if (id && match.area === 'scripts/.queue/' && low.endsWith(`/mission/${id.toLowerCase()}.md`))
        continue;
      if (set.has(filePath)) continue;
      set.add(filePath);
      out.push({ path: filePath, area: match.area, boosted: match.boostable && boosted });
    }
  }
  return out;
}

/**
 * Can the task run in a cloud session? Suitable when all of this holds:
 *   - class K or U, no migrations (migr_tens 0), empty owner_db and shared_patch
 *   - the mission does not point to folders the cloud does not see (config().cloudHidden, and scripts/.queue/ beyond its own file; a
 *     source reference on a line that says the binding content is lifted in is fine)
 *   - status waiting without open dependencies, owner questions or ownership collision (or already in a cloud session)
 *   - the owned files are not changed locally since <remote>/<baseBranch> (committed and not pushed, or uncommitted):
 *     otherwise the cloud builds on old code
 * @param {{ pushedHead?: string|null, changed?: string[], missionText?: string, ownPath?: string|null }} v
 *   `pushedHead`: the sha of <remote>/<baseBranch> (null: unknown, then it cannot be checked). `changed`: the paths that are
 *   changed locally since then. `missionText`: the mission itself (the file `mission` points to, or the text).
 * @returns {{ suitable: boolean, reasons: string[] }}
 */
function cloudSuitable(queue, id, { pushedHead = null, changed = [], missionText, ownPath = null } = {}) {
  const tasks = queue?.tasks ?? [];
  const o = tasks.find((x) => x.id === id);
  if (!o) return { suitable: false, reasons: [`unknown task ${id}`] };
  const reasons = [];
  if (!CLOUD_CLASSES.has(o.class)) reasons.push(`class ${o.class} (only K and U run in the cloud)`);
  if (Number(o.migr_tens ?? 0) > 0) reasons.push('has migrations (the cloud has no database)');
  // The label "not-cloud": a cloud session has tried and stopped because the task needs something only available locally (sources,
  // downloads, local files). Set by the orchestrator after CLOUD-STOP.
  for (const k of o.requires ?? []) if (CLOUD_CLOSED.has(k)) reasons.push(CLOUD_CLOSED.get(k));
  if (hasLabel(o, 'not-cloud'))
    reasons.push('marked not-cloud (needs something that only exists locally)');
  if ((o.owner_db ?? []).length) reasons.push(`owns DB functions: ${o.owner_db.join(', ')}`);
  if ((o.shared_patch ?? []).length) reasons.push(`shared patch: ${o.shared_patch.join(', ')}`);

  if (isCloud(o)) {
    // Already in a cloud session: the status is correct, and the blockers applied when it was started.
  } else if (o.status !== 'waiting') {
    reasons.push(
      o.status === 'picked' ? `picked by ${o.picked_by ?? '?'}` : `status ${o.status}`,
    );
  } else {
    for (const h of blockerParts(o, tasks, queue.resolved)) {
      if (h.type === 'depends_on') reasons.push(`open dependency: ${h.text}`);
      else if (h.type === 'question') reasons.push(`open owner question: ${h.sp}`);
      else reasons.push(h.text);
    }
  }

  const text = missionText ?? (String(o.mission ?? '').includes('\n') ? o.mission : '');
  // References to other tasks' missions (scripts/.queue/mission/<another>.md) are context, not binding content:
  // the package explains that the file does not exist in the cloud. They do not close.
  const hiddenOnes = cloudReferences(text, { id: o.id, ownPath }).filter(
    (r) => !r.boosted && r.area !== 'scripts/.queue/',
  );
  if (hiddenOnes.length)
    reasons.push(
      `the mission points to files the cloud does not see: ${hiddenOnes.map((r) => r.path).join(', ')}`,
    );

  if (!pushedHead)
    reasons.push(
      `did not find ${remoteName()}/${baseBranch()} (run git fetch ${remoteName()} ${baseBranch()})`,
    );
  else {
    const local = [];
    for (const f of o.owned_files ?? []) {
      const e = (changed ?? []).find((filePath) => fileOverlap(f, filePath));
      if (e) local.push(norm(e));
    }
    if (local.length)
      reasons.push(
        `owned files changed locally and not pushed: ${[...new Set(local)].slice(0, 5).join(', ')}` +
          ` (push ${baseBranch()} first)`,
      );
  }
  return { suitable: reasons.length === 0, reasons };
}

/** The general rules for a K or U track in the cloud, short. The project's own rules are in config().architectureRules. */
const CLOUD_RULES_COMMON = [
  'No migrations and no database: the cloud has no database. If you need it, CLOUD-STOP.',
  "Follow the project's CLAUDE.md; the rules below are the most important ones for the track.",
  'No personal data or secrets in logs, error messages or commits. No dev server or preview.',
  'Commit only the files you own (git add -- <files>); do not touch files outside the ownership list.',
];

/** The rules the cloud package brings along: the general ones and the project's architecture rules (config().architectureRules). */
function cloudRules() {
  const ownOnes = Array.isArray(cfg().architectureRules) ? cfg().architectureRules : [];
  return [...CLOUD_RULES_COMMON, ...ownOnes.map(String).filter((r) => r.trim())];
}

/** Bundle: at most this many tasks, and at most this many minutes of estimate in total, in one cloud session. */
const CLOUD_BUNDLE_MAX = 4;
const CLOUD_BUNDLE_MIN = 120;

const CLOUD_GATES =
  'npm install; the tests for the new/changed files; and at the end, before push, ' +
  `\`${require('./projectRoot.js').cqCommand()} gates --quick --wave cloud --track <id>\` (the quick gates from config().gates.quick). ` +
  'If a gate is red, fix it and run it again; if it is red because of something outside the task or an environment issue in the cloud, ' +
  'mention it in the report.';
// npm install can rewrite package-lock.json; then the session must reset it itself.
const CLOUD_LOCK =
  'Do not commit package-lock.json unless the mission says so (npm install rewrites it; reset it before commit).';
const commitLine = (id) =>
  `Commit message: "<type>(<area>): <summary> (${id})" + line "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>".`;
const branchLine = (branch, explanation = '') => {
  const r = remoteName();
  const b = baseBranch();
  return (
    `Branch rule${explanation}: start from ${r}/${b} (git fetch ${r} ${b} && git checkout -b ${branch} ${r}/${b}). ` +
    `Push only branch ${branch} to ${r}. If the push to ${branch} is rejected by access rules, push instead to the ` +
    `branch the session is allowed to use (for example claude/...) and write the name of the branch in the report. Never ${b}, ` +
    'never PR.'
  );
};

/** "Files the cloud does not see …" for all the parts in the package, or null. */
function hiddenLine(parts) {
  const paths = [
    ...new Set(
      parts.flatMap((d) =>
        cloudReferences(d.text, { id: d.o.id, ownPath: d.ownPath }).map((r) => r.path),
      ),
    ),
  ];
  return paths.length
    ? `Files the cloud does not see (gitignored or untracked): ${paths.join(', ')}. Everything binding is in the mission ` +
        'below; ignore these references.'
    : null;
}

/**
 * The cloud package: one self-contained message for the routine "queue-cloud" (or to paste into a cloud session). Structure: branch rule, gates, commit message, files the cloud does not see, rules, report format, and then
 * the mission in full with the track block.
 * @param {{ text: string, ownPath?: string|null }} v the mission text (the file or the text itself)
 */
function cloudPackage(o, queue, { text, ownPath = null } = {}) {
  const id = o.id;
  const hidden = hiddenLine([{ o, text, ownPath }]);
  return [
    `# CLOUD TRACK ${id} (class ${o.class}, approx. ${estimate(o)} min)`,
    '',
    branchLine(queueBranch(id)),
    `Gates in the cloud: ${CLOUD_GATES}`,
    CLOUD_LOCK,
    commitLine(id),
    ...(hidden ? [hidden] : []),
    '',
    'Rules (the ones that apply to this track):',
    ...cloudRules().map((r) => `- ${r}`),
    '',
    'Report: at most 20 lines (what, files, test result red first then green, gates, branch), last line ' +
      `"CLOUD-DONE ${id} <sha>" or "CLOUD-STOP ${id} <reason>".`,
    '',
    '## The mission',
    '',
    trackBlock(o, queue, { text, cloud: true }),
  ].join('\n');
}

/**
 * The cap for a bundle: at most CLOUD_BUNDLE_MAX tasks and CLOUD_BUNDLE_MIN minutes of estimate, and no id twice.
 * @param {object[]} tasks
 * @returns {string[]} the reasons (empty = within the cap)
 */
function cloudBundleCap(tasks, { max = CLOUD_BUNDLE_MAX, maxMin = CLOUD_BUNDLE_MIN } = {}) {
  const reasons = [];
  const ids = tasks.map((o) => o.id);
  if (new Set(ids).size !== ids.length) reasons.push('the same task twice');
  if (tasks.length > max) reasons.push(`${tasks.length} tasks (at most ${max} in one bundle)`);
  const sum = tasks.reduce((s, o) => s + estimate(o), 0);
  if (sum > maxMin) reasons.push(`${sum} min estimate in total (at most approx. ${maxMin} in one bundle)`);
  return reasons;
}

/**
 * The cloud package for a bundle: several small tasks in one cloud session (the startup, clone + npm install + CLAUDE.md, costs the same
 * regardless of size). The missions are done one after another in the order given. Each gets its own queue branch made from
 * <remote>/<baseBranch> (never from the previous task's branch), its own commit, its own push and its own report line; a stop on one
 * does not hinder the next ones. The last line is CLOUD-BUNDLE-DONE <done>/<count>. One task gives the usual cloudPackage.
 * @param {{ o: object, text: string, ownPath?: string|null }[]} parts
 */
function cloudBundlePackage(parts, queue) {
  if (parts.length === 1) return cloudPackage(parts[0].o, queue, parts[0]);
  const n = parts.length;
  const ids = parts.map((d) => d.o.id);
  const sum = parts.reduce((s, d) => s + estimate(d.o), 0);
  const hidden = hiddenLine(parts);
  return [
    `# CLOUD BUNDLE ${ids.join(', ')} (${n} tasks, approx. ${sum} min)`,
    '',
    `Do the ${n} missions below one after another, in this order: ${ids.join(' → ')}. For EACH task:`,
    `- ${branchLine(queueBranch('<id>'), ' (own branch per task)')} Make each branch from ${remoteName()}/${baseBranch()}, ` +
      'never from the previous ' +
      "task's branch, and do not bring along changes from an earlier task.",
    `- Own commit and own push. ${commitLine('<id>')}`,
    `- Gates for the task: ${CLOUD_GATES}`,
    '- Report line right after the push: "CLOUD-DONE <id> <sha>", or "CLOUD-STOP <id> <reason>" when the task cannot ' +
      'be done. A stop does not hinder the next ones: move on to the next task.',
    CLOUD_LOCK,
    ...(hidden ? [hidden] : []),
    '',
    'Rules (the ones that apply to all tasks):',
    ...cloudRules().map((r) => `- ${r}`),
    '',
    'Report: at most 8 lines per task (what, files, test result red first then green, gates, branch), each ending ' +
      'with its report line. Last line of the whole report: ' +
      `"CLOUD-BUNDLE-DONE <count CLOUD-DONE>/${n}".`,
    '',
    ...parts.flatMap((d, i) => [
      '---',
      '',
      `# Task ${i + 1} of ${n}: ${d.o.id} (branch ${queueBranch(d.o.id)})`,
      '',
      trackBlock(d.o, queue, { text: d.text, cloud: true }),
    ]),
  ].join('\n');
}

/**
 * Proposed bundles (`queue.mjs cloud-bundles`): the cloud-suitable candidates grouped by project and feature (same area
 * one after another, so the context is reused), the groups by best priority, and within the group by priority. Then
 * the bundles are filled in that order as long as the cap holds; a task that alone is over the cap stands alone.
 * @param {{ id: string, project: string, feature?: string|null, estimate: number, score: number }[]} candidates
 * @returns {{ ids: string[], minutes: number, areas: string[] }[]}
 */
function cloudBundles(candidates, { max = CLOUD_BUNDLE_MAX, maxMin = CLOUD_BUNDLE_MIN } = {}) {
  const groups = new Map();
  for (const k of candidates) {
    const area = `${k.project}${k.feature ? ` / ${k.feature}` : ''}`;
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push({ ...k, area });
  }
  const afterScore = (a, b) => b.score - a.score || a.id.localeCompare(b.id);
  const sorted = [...groups.values()]
    .map((g) => g.sort(afterScore))
    .sort((a, b) => afterScore(a[0], b[0]))
    .flat();
  const bundles = [];
  let now = null;
  for (const k of sorted) {
    if (!now || now.ids.length >= max || now.minutes + k.estimate > maxMin) {
      now = { ids: [], minutes: 0, areas: [] };
      bundles.push(now);
    }
    now.ids.push(k.id);
    now.minutes += k.estimate;
    if (!now.areas.includes(k.area)) now.areas.push(k.area);
  }
  return bundles;
}

/** Number of cloud sessions running: tasks in the same session (same execution, or same bundle) count once. */
function cloudSessions(queue) {
  return new Set((queue.tasks ?? []).filter(isCloud).map((o) => o.cloud.execution ?? o.cloud.bundle ?? o.id))
    .size;
}

/**
 * `queue.mjs cloud start <id> [<id> …]`: picks tasks for one cloud session (picked_by "cloud", branch queue/<id>) and sets
 * `cloud: { started, execution?, bundle? }` (bundle = the ids when several run in the same session). All or nothing. Refuses when a
 * task is not suitable (`suitability` per id, computed by the caller with git), when the bundle is over the cap, or when CLOUD_MAX
 * cloud sessions are already running; `force` overrides those three, and the pick's blockers. If a task is already in the cloud, only
 * the execution is set (the orchestrator got the session id after the owner pressed start).
 * @param {string|string[]} ids
 * @param {{ suitability?: Record<string, { suitable: boolean, reasons: string[] }>, execution?: string|null, force?: boolean,
 *   now?: string }} v
 * @returns {{ error: string } | { tasks: object[], newOnes: string[], left: string[], overridden: string[] }}
 */
function cloudStart(
  queue,
  ids,
  { suitability = {}, execution = null, force = false, now = new Date().toISOString() } = {},
) {
  const list = [].concat(ids);
  const tasks = [];
  for (const id of list) {
    const o = (queue.tasks ?? []).find((x) => x.id === id);
    if (!o) return { error: `unknown task ${id}` };
    tasks.push(o);
  }
  const newOnes = tasks.filter((o) => !isCloud(o));
  const left = tasks.filter((o) => isCloud(o));
  const overridden = [];
  const stop = (text) => {
    if (!force) return `${text} (--force overrides)`;
    overridden.push(text);
    return null;
  };
  for (const o of newOnes) {
    const e = suitability[o.id];
    if (e && !e.suitable) {
      const f = stop(`${o.id} is not suitable for the cloud: ${e.reasons.join(' · ')}`);
      if (f) return { error: f };
    }
  }
  const cap = cloudBundleCap(tasks);
  if (cap.length) {
    const f = stop(`the bundle is over the cap: ${cap.join(' · ')}`);
    if (f) return { error: f };
  }
  if (newOnes.length) {
    const sessions = cloudSessions(queue);
    if (sessions >= CLOUD_MAX) {
      const f = stop(`${sessions} cloud sessions are already running (at most ${CLOUD_MAX})`);
      if (f) return { error: f };
    }
  }
  // pick changes the queue; check all before any is changed (the caller does not write the file on error, but keep it clean).
  for (const o of newOnes) {
    if (o.status !== 'waiting')
      return { error: `${o.id} cannot be started in the cloud: status ${o.status}` };
  }
  const bundle = list.length > 1 ? list.join(',') : null;
  for (const o of newOnes) {
    const p = pick(queue, o.id, { by: CLOUD_BY, force, now });
    if (p.error) return p;
    overridden.push(...p.overridden);
    o.cloud = { started: now, ...(execution ? { execution } : {}), ...(bundle ? { bundle } : {}) };
  }
  for (const o of left) if (execution) o.cloud.execution = execution;
  return {
    tasks,
    newOnes: newOnes.map((o) => o.id),
    left: left.map((o) => o.id),
    overridden,
  };
}

/**
 * `queue.mjs cloud done`: the cloud has pushed the branch (the caller has checked it with git). The task goes to review as with
 * `deliver`, with `cloud.done`, branch and the sha. The orchestrator merges.
 */
function cloudDone(queue, id, { branch, sha = null, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (!isCloud(o))
    return {
      error: `${id} is not in a cloud session (status ${o.status}${o.picked_by ? `, picked by ${o.picked_by}` : ''})`,
    };
  const l = deliver(queue, id, now);
  if (l.error) return l;
  o.cloud = { ...o.cloud, done: now, branch: branch ?? queueBranch(id), ...(sha ? { sha } : {}) };
  return { task: o };
}

/** `queue.mjs cloud cancel` = release for a cloud session (branch and migration block kept, the cloud field is removed). */
function cloudCancel(queue, id, { commits = 0, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (!isCloud(o)) return { error: `${id} is not in a cloud session (status ${o.status})` };
  const execution = o.cloud?.execution ?? null;
  const s = release(queue, id, { commits, now });
  if (s.error) return s;
  o.remarks = [...(o.remarks ?? []), `${now} cloud session aborted${execution ? ` (${execution})` : ''}`];
  return s;
}

// ---- Batch queue -----------------------------------------------------------------
// Small tasks that do not fit naturally into a track of the right size, and that do not block anything, are added with
// `batched: true` instead of becoming their own small tracks (fixed overhead is a large part of a small K track). They are shown, but never started or picked alone
// (the blocker `batched`). When a group (project → class) is large enough, the orchestrator packages it into one track with
// `queue.mjs batch pack`: a new task with a mission file that collects the originals in full, the originals cancelled with a
// remark, `depends_on` in other tasks redirected, and `merged_from` (same mechanics as other merging).

/** The blocker a task in the batch queue gets (show, the board, start, pick). */
const BATCHED_BLOCKER =
  'in the batch queue (packed into a track with cq batch pack; taken out with edit --json \'{"batched":false}\')';

/**
 * The target size per class in content minutes (add-to-queue): `min` = lower target (a group is "ready for packing" from
 * this on), `measure` = the middle of the target, `max` = upper target (a package is not filled above this). D+ is never combined.
 */
const BATCH_MEASURE = {
  K: { min: 90, measure: 105, max: 120 },
  D: { min: 30, measure: 40, max: 50 },
  U: { min: 45, measure: 60, max: 75 },
};
/** The order the classes are shown in. */
const BATCH_CLASSES = ['K', 'D', 'U'];

/** Does the task have `batched: true` (and is it a queue task, not a record outside the queue)? */
function isBatched(o) {
  return o?.batched === true && !isExternalRow(o);
}

/** Is the task in the batch queue now (batched and waiting or proposed)? Cancelled and finished ones are out of it. */
function inBatchQueue(o) {
  return isBatched(o) && (o.status === 'waiting' || o.status === 'proposed');
}

const openTask = (o) => !!o && o.status !== 'done' && o.status !== 'cancelled';
const contentMin = (o) => Number(o?.content_min ?? 30) || 0;
/** The owner questions in `waiting_on` that are not resolved. */
const openQuestion = (o, resolved = []) => {
  const a = new Set(resolved ?? []);
  return [...new Set(o?.waiting_on ?? [])].filter((sp) => !a.has(sp)).sort();
};

/**
 * The rules for the batch queue on `add` and `edit` (called in addition to validate). `tasks` = the queue as it will be (on add:
 * the existing ones plus the new ones; the task itself may be included). Refuses `batched` for D+, for tasks that other
 * unfinished tasks depend on, for tasks that wait on an owner question that is not resolved, and for tasks
 * that are not waiting. Also refuses that a task depends on a task in the batch queue (it would never be started).
 * @returns {string[]} errors (empty = valid)
 */
function batchedError(o, tasks = [], resolved = []) {
  const error = [];
  if (!o || typeof o !== 'object') return error;
  if (o.batched != null && typeof o.batched !== 'boolean')
    error.push('batched must be true or false');
  if (o.batched === true) {
    if (o.class === 'D+')
      error.push('batched: D+ is never combined with others; add it as its own track');
    if (o.status && o.status !== 'waiting' && o.status !== 'proposed')
      error.push(`batched: only waiting tasks can sit in the batch queue (status ${o.status})`);
    const dependents = tasks
      .filter((x) => x.id !== o.id && openTask(x) && (x.depends_on ?? []).includes(o.id))
      .map((x) => x.id);
    if (dependents.length)
      error.push(
        `batched: ${dependents.join(', ')} depends on ${o.id}; a task that blocks something should not be in the batch queue`,
      );
    const sp = openQuestion(o, resolved);
    if (sp.length)
      error.push(
        `batched: ${o.id} waits on owner questions that are not resolved (${sp.join(', ')}); it does not belong in the batch queue until they are answered`,
      );
  }
  const perId = new Map(tasks.map((x) => [x.id, x]));
  for (const dep of o.depends_on ?? []) {
    const d = perId.get(dep);
    if (d && d.id !== o.id && inBatchQueue(d))
      error.push(
        `depends on ${dep}, which is in the batch queue and is not started alone (pack it or take it out first: cq edit ${dep} --json '{"batched":false}')`,
      );
  }
  return error;
}

/**
 * The small task guard: a small task should not become its own track, because the fixed
 * cost per track (startup, worktree, gates, merge) is larger than the content. Called on `add`, and only kicks in
 * when `content_min` is set explicitly and is below the lower target for the class (BATCH_MEASURE.min). Exceptions: D+ (never
 * combined), tasks that wait on an owner question, tasks that other open tasks depend on, and
 * `own_track: "<reason>"` (deliberately its own track, e.g. on the owner's word).
 *   - Without `value` the priority is uncertain: ask the owner (with a recommendation) before the task is added.
 *   - content_min <= SMALL_FIX_MIN: not in the queue. The owner chooses "fix now" (recommended) or the batch queue (`batched: true`).
 *   - Otherwise, with low priority (value <= SMALL_LOW_VALUE): the batch queue (`batched: true`), which packages it into a track of
 *     sensible size (`queue.mjs batch`). High priority can be its own track.
 * @returns {string[]} errors (empty = valid)
 */
const SMALL_FIX_MIN = 10;
const SMALL_LOW_VALUE = 7;
function smallTaskError(o, tasks = [], resolved = []) {
  if (!o || typeof o !== 'object') return [];
  const error = [];
  const ownTrack = typeof o.own_track === 'string' && !!o.own_track.trim();
  if (o.own_track != null && !ownTrack)
    error.push('own_track must be a short reason (text), e.g. "the owner asked for its own track"');
  if (typeof o.content_min !== 'number' || o.class === 'D+' || ownTrack) return error;
  if (o.content_min >= (BATCH_MEASURE[o.class]?.min ?? 0)) return error;
  if (openQuestion(o, resolved).length) return error;
  const blocks = tasks.some(
    (x) => x.id !== o.id && openTask(x) && (x.depends_on ?? []).includes(o.id),
  );
  if (blocks) return error;
  const min = o.content_min;
  if (o.value == null) {
    error.push(
      `small task (${min} min) without value: the priority is uncertain. Ask the owner (with a recommendation) and set value`,
    );
  } else if (min <= SMALL_FIX_MIN && o.batched !== true) {
    error.push(
      `small task (${min} min, the limit is ${SMALL_FIX_MIN}): do not add it to the queue. Ask the owner: fix now (recommended) or batch queue ("batched": true). Deliberately its own track: "own_track": "<reason>"`,
    );
  } else if (min > SMALL_FIX_MIN && o.value <= SMALL_LOW_VALUE && o.batched !== true) {
    error.push(
      `small task with low priority (${min} min, below ${BATCH_MEASURE[o.class].min} for ${o.class}, value ${o.value}): add it to the batch queue with "batched": true. Deliberately its own track: "own_track": "<reason>"`,
    );
  }
  return error;
}

/** The common value when all have the same, otherwise the first (project, feature, domain). */
function commonOrFirst(values) {
  const v = values.filter((x) => x != null && x !== '');
  return v.length ? v[0] : null;
}
/** Union of the list field over the tasks, in the order they first occur. */
function unionField(parts, field) {
  const out = [];
  for (const o of parts) for (const x of o[field] ?? []) if (!out.includes(x)) out.push(x);
  return out;
}

/**
 * The batch queue grouped project → class, with the sum of content minutes against the target for the class. Deterministic: projects in
 * the register's order (like `show --grouped`), the classes K, D, U (D+ last, marked invalid), tasks by feature
 * and id. `ready` = the sum has reached the lower target (K 90, D 30, U 45). `common_files` = owned files that several in the group own.
 * @returns {{ pid, title, class, measure, sum, count, ready, over, invalid, tasks, features, common_files }[]}
 */
function batchGroups(queue) {
  const register = queue.projects ?? {};
  const perGroup = new Map();
  for (const o of (queue.tasks ?? []).filter(inBatchQueue)) {
    const pid = projectFor(o, register);
    const key = `${pid}\u0000${o.class}`;
    if (!perGroup.has(key)) perGroup.set(key, { pid, class: o.class, parts: [] });
    perGroup.get(key).parts.push(o);
  }
  const pids = new Set([...perGroup.values()].map((g) => g.pid));
  const classRank = (k) => (BATCH_CLASSES.includes(k) ? BATCH_CLASSES.indexOf(k) : 99);
  const featureFor = (o) =>
    typeof o.feature === 'string' && o.feature.trim() ? o.feature.trim() : WITHOUT_FEATURE;
  const out = [];
  for (const pid of projectOrder(pids, register)) {
    const groups = [...perGroup.values()]
      .filter((g) => g.pid === pid)
      .sort(
        (x, y) =>
          classRank(x.class) - classRank(y.class) ||
          String(x.class).localeCompare(String(y.class)),
      );
    for (const g of groups) {
      const parts = [...g.parts].sort((x, y) => {
        const fx = featureFor(x);
        const fy = featureFor(y);
        if (fx !== fy)
          return fx === WITHOUT_FEATURE ? 1 : fy === WITHOUT_FEATURE ? -1 : fx.localeCompare(fy, 'en');
        return x.id.localeCompare(y.id);
      });
      const measure = BATCH_MEASURE[g.class] ?? null;
      const sum = parts.reduce((s, o) => s + contentMin(o), 0);
      const features = [];
      for (const o of parts) {
        const f = featureFor(o);
        let row = features.find((x) => x.feature === f);
        if (!row) features.push((row = { feature: f, sum: 0, ids: [] }));
        row.sum += contentMin(o);
        row.ids.push(o.id);
      }
      const countFile = new Map();
      for (const o of parts)
        for (const f of new Set((o.owned_files ?? []).map(norm)))
          countFile.set(f, (countFile.get(f) ?? 0) + 1);
      out.push({
        pid,
        title: register?.[pid]?.title ?? null,
        class: g.class,
        measure,
        sum,
        count: parts.length,
        ready: !!measure && sum >= measure.min,
        over: !!measure && sum > measure.max,
        invalid: !measure,
        features,
        common_files: [...countFile.entries()]
          .filter(([, n]) => n > 1)
          .map(([f]) => f)
          .sort(),
        tasks: parts.map((o) => ({
          id: o.id,
          title: o.title ?? '',
          status: o.status,
          content_min: contentMin(o),
          feature: featureFor(o),
          owned_files: o.owned_files ?? [],
        })),
      });
    }
  }
  return out;
}

/** A new, free id for a package: the project's first prefix + "S<n>" (A-S1), otherwise BATCH-<n>. */
function batchId(pid, register, used) {
  const pre = register?.[pid]?.prefixes?.[0];
  const base = pre ? (/[-._]$/.test(pre) ? pre : `${pre}-`) : 'BATCH-';
  for (let n = 1; ; n++) {
    const id = `${base}S${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Proposed packages for the groups that are ready (`queue.mjs batch pack --auto`). Within a group the packages are filled in
 * the group's order (feature, id) up toward the upper target; a package is closed when the next task would pass the upper target and
 * the package has reached the lower target. A rest below the lower target stays in the batch queue. Tasks with different open owner questions
 * are never packed together. A "package" with one task that alone has reached the target is proposed to be taken out of the batch queue (`out: true`).
 * Deterministic; changes nothing.
 * @returns {{ id: string|null, pid: string, class: string, parts: string[], sum: number, out: boolean }[]}
 */
function batchSuggestion(queue) {
  const register = queue.projects ?? {};
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const used = new Set(perId.keys());
  const out = [];
  for (const g of batchGroups(queue)) {
    if (!g.ready || g.invalid) continue;
    // Split on open owner questions (normally none: the batch queue does not accept such), in order of first occurrence.
    const perSp = new Map();
    for (const r of g.tasks) {
      const k = openQuestion(perId.get(r.id), queue.resolved).join(',');
      if (!perSp.has(k)) perSp.set(k, []);
      perSp.get(k).push(r);
    }
    for (const rows of perSp.values()) {
      const packages = [];
      let cur = { parts: [], sum: 0 };
      for (const r of rows) {
        if (cur.parts.length && cur.sum + r.content_min > g.measure.max && cur.sum >= g.measure.min) {
          packages.push(cur);
          cur = { parts: [], sum: 0 };
        }
        cur.parts.push(r.id);
        cur.sum += r.content_min;
      }
      if (cur.parts.length && cur.sum >= g.measure.min) packages.push(cur);
      for (const p of packages) {
        const alone = p.parts.length === 1;
        const id = alone ? null : batchId(g.pid, register, used);
        if (id) used.add(id);
        out.push({ id, pid: g.pid, class: g.class, parts: p.parts, sum: p.sum, out: alone });
      }
    }
  }
  return out;
}

/**
 * Packages the tasks `ids` into one new track `newId` (`queue.mjs batch pack`). ALL OR NOTHING: everything is checked before anything
 * is changed, and on error `queue` is untouched. Requirements: at least two tasks, all waiting (or proposed), same class (K and D are thus
 * never mixed), not D+, equal open owner questions, new id free and valid, and no cycle (a part cannot depend on
 * something that itself waits on another part). The fields are combined: content_min sum, value and migr_tens max, depends_on
 * union minus the parts, owned_files/owner_db/shared_patch/requires/labels/waiting_on union, project/feature/domain common
 * or first, source "id: source | …", `merged_from`. The originals become `cancelled` with the remark "merged into
 * <newId>", and `depends_on` in all other open tasks is redirected to the new one. Status: waiting when all parts are waiting,
 * otherwise proposed. The caller writes the mission file (batchMissionText).
 * @param {{ newId: string, title?: string, mission: string, by?: string, now?: string }} option
 * @returns {{ error: string[] } | { error: [], new: object, cancelled: string[], redirected: string[] }}
 */
function batchPack(queue, ids, { newId, title, mission, by, now = new Date().toISOString() } = {}) {
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const perId = new Map(tasks.map((o) => [o.id, o]));
  const error = [];
  const list = [...(ids ?? [])];
  if (new Set(list).size !== list.length) error.push('the same id appears more than once');
  if (list.length < 2)
    error.push(
      'pack requires at least two tasks (one task is taken out with cq edit <id> --json \'{"batched":false}\')',
    );
  if (!newId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(newId))
    error.push('--id <new-id> missing or has invalid characters');
  else if (perId.has(newId)) error.push(`id ${newId} already exists`);
  const parts = [];
  for (const id of list) {
    const o = perId.get(id);
    if (!o) error.push(`unknown task ${id}`);
    else if (isExternalRow(o)) error.push(`${id} is a record outside the queue`);
    else if (o.status !== 'waiting' && o.status !== 'proposed')
      error.push(`${id} has status ${o.status} (only pending and proposed tasks can be packed)`);
    else parts.push(o);
  }
  if (parts.some((o) => o.class === 'D+')) error.push('D+ is never combined with others');
  const classes = [...new Set(parts.map((o) => o.class))];
  if (classes.length > 1)
    error.push(`different classes (${classes.join(', ')}); K and D (and U) are never packed together`);
  const spSet = [...new Set(parts.map((o) => openQuestion(o, queue.resolved).join(',')))];
  if (spSet.length > 1)
    error.push(
      `different open owner questions (${parts.map((o) => `${o.id}: ${openQuestion(o, queue.resolved).join(', ') || 'none'}`).join('; ')}); such tasks are never packed together`,
    );
  if (error.length) return { error };

  const partIds = new Set(list);
  const depends_on = unionField(parts, 'depends_on').filter((d) => !partIds.has(d) && d !== newId);
  // Cycle: an external predecessor that itself (transitively) waits on one of the parts would wait on the new track.
  const children = childrenMap(tasks);
  const after = new Set(list.flatMap((id) => successors(id, tasks, children)));
  const cycle = depends_on.filter((d) => after.has(d));
  if (cycle.length)
    return {
      error: [
        `would create a cycle: ${cycle.join(', ')} itself waits on one of the parts; pack them together or split differently`,
      ],
    };

  const first = parts[0];
  const pids = parts.map((o) => projectFor(o, register));
  const sources = parts.filter((o) => o.source).map((o) => `${o.id}: ${o.source}`);
  const fresh = {
    value: Math.max(...parts.map((o) => Number(o.value ?? 5))),
    content_min: parts.reduce((s, o) => s + contentMin(o), 0),
    migr_tens: Math.max(...parts.map((o) => Number(o.migr_tens ?? 0))),
    depends_on,
    waiting_on: unionField(parts, 'waiting_on'),
    owned_files: unionField(parts, 'owned_files'),
    owner_db: unionField(parts, 'owner_db'),
    shared_patch: unionField(parts, 'shared_patch'),
    id: newId,
    title:
      String(title ?? '').trim() ||
      `Combined track (${parts.length}): ${parts.map((o) => o.title ?? o.id).join(' + ')}`,
    domain: commonOrFirst(parts.map((o) => o.domain)),
    project: pids[0],
    class: first.class,
    mission,
    ...(sources.length ? { source: sources.join(' | ') } : {}),
    added_by: by ?? 'cq batch pack',
    merged_from: list,
  };
  const feature = commonOrFirst(
    parts.map((o) => (typeof o.feature === 'string' ? o.feature.trim() : null)),
  );
  if (feature) fresh.feature = feature;
  for (const field of ['requires', 'labels']) {
    const u = unionField(parts, field);
    if (u.length) fresh[field] = u;
  }
  if (fresh.project === WITHOUT_PROJECT) delete fresh.project;
  fresh.status = parts.every((o) => o.status === 'waiting') ? 'waiting' : 'proposed';
  fresh.added_at = now;
  // Same validation as add (without tasks that are cancelled in the same write).
  const vf = validate(fresh, tasks, register);
  if (vf.length) return { error: vf.map((f) => `${newId}: ${f}`) };

  // ---- Execute (everything is checked) ----
  for (const o of parts) {
    o.status = 'cancelled';
    o.remarks = [...(o.remarks ?? []), `${now} merged into ${newId}`];
  }
  const redirected = [];
  for (const o of tasks) {
    if (partIds.has(o.id) || !openTask(o) || !(o.depends_on ?? []).some((d) => partIds.has(d)))
      continue;
    const newOnes = [];
    for (const d of o.depends_on) {
      const x = partIds.has(d) ? newId : d;
      if (!newOnes.includes(x)) newOnes.push(x);
    }
    o.depends_on = newOnes;
    redirected.push(o.id);
  }
  queue.tasks.push(fresh);
  return { error: [], new: fresh, cancelled: list, redirected };
}

/**
 * The mission file for a packed track: introduction (order, commit per part, the union is in the queue task) and each part's
 * original track description in full. `texts`: id → { text, path } (path = the mission file the part came from, or
 * null when the mission was text in the queue file).
 */
function batchMissionText(fresh, parts, texts, now = new Date().toISOString()) {
  const date = String(now).slice(0, 10);
  const lines = [
    `# ${fresh.id}: combined track (${parts.length} parts, ${fresh.class}, approx. ${fresh.content_min} content minutes)`,
    '',
    `Combined track of ${parts.map((o) => o.id).join(', ')} (batch queue, cq batch pack ${date}, to save fixed ` +
      'overhead per track). Do them in this order, and commit per part (the commit message mentions the part id, e.g. ' +
      `"${parts[0].id}: …"). Each part below is the original track description unchanged; "Depends on" inside the parts ` +
      'that points to another part in this track is fulfilled by doing the parts in order. Owned files, owned DB and ' +
      `dependencies for the whole track are the union of the parts (in the queue task ${fresh.id}). Report per part at the end.`,
    '',
    'Order:',
    ...parts.map(
      (o, i) => `${i + 1}. ${o.id}: ${o.title ?? ''} (${o.class}, ${contentMin(o)} min)`,
    ),
    '',
  ];
  for (const o of parts) {
    const t = texts.get(o.id) ?? { text: '', path: null };
    lines.push(
      '',
      '---',
      '',
      `## Part ${o.id}: ${o.title ?? ''}`,
      '',
      t.path
        ? `(Original mission file: \`${t.path}\`)`
        : '(The original mission was text in the queue file.)',
      '',
      String(t.text ?? '').trimEnd(),
      '',
    );
  }
  return lines.join('\n');
}

// ---- The orchestrator's routine as script and cost per task -----
//
// `show` (short by default), `fill`, `receive`, `set <id> done` and `cost` in queue.mjs. Here is only the pure part: the
// short view, agent type and agent message, the content of the review package, the parsers for the RESULT and FINDINGS lines, which
// agents in the time log belong to a task, and the sum of the cost. Git, the transcripts and the time log are read in queue.mjs.
// Tested in lib/__tests__/queueOrchestrator.test.ts.

const TK = require('./timeCost.js');

/** The agent type for a track by class: D and D+ on `track-d` (high), K and U on `track` (medium). */
function agentTypeFor(cls) {
  return cls === 'D' || cls === 'D+' ? 'track-d' : 'track';
}

/** Default reviewers per class (subagent_type); the installation ships .claude/agents/reviewer*.md. */
const DEFAULT_REVIEWERS = { D: ['reviewer'], 'D+': ['reviewer', 'reviewer-security'] };

/**
 * The reviewer setup: config().reviewers (class → list of subagent_type), otherwise the default. A class that is not
 * in the setup gets no review (K and U by default).
 */
function reviewerSetup() {
  const r = cfg().reviewers;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : DEFAULT_REVIEWERS;
}

/** The reviewers by class: by default K and U none, D `reviewer`, D+ also `reviewer-security`. */
function reviewersFor(cls) {
  const list = reviewerSetup()[cls];
  return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
}

/** All reviewer types in the setup (unique, in order). */
function reviewerTypes() {
  const out = [];
  for (const list of Object.values(reviewerSetup()))
    for (const t of Array.isArray(list) ? list : []) if (!out.includes(String(t))) out.push(String(t));
  return out;
}

/**
 * The short message the orchestrator starts the track agent with; the mission is in the prompt file. "track <id>" and
 * "prompt-<id>.md" in the text are what timeCost.trackFromText recognizes the track by (the cost per task).
 */
function trackMessage(id, promptPath) {
  return (
    `You are track ${id} in the work queue (continuous queue, wave "queue"). Your mission is in ${promptPath} and is ` +
    'binding: read it first and follow the protocol there. Your answer to the orchestrator is at most approx. 1,500 characters: ' +
    'RESULT line first, at most 5 lines, then the path to report.md (the long version is there).'
  );
}

/** The summary line under `show` (same in the short and full view). `t` is queueLogic.state. */
function stateLine(t) {
  return (
    `${t.activeOnes} active · ${t.picked ? `${t.picked} picked · ` : ''}${t.waiting} waiting · ${t.proposed} proposed · ` +
    `${t.canStart} can start now` +
    `${t.batched ? ` · ${t.batched} in the batch queue (cq batch)` : ''}` +
    `${t.qa ? ` · ${t.qa} in the QA list (cq qa)` : ''}${t.external ? ` · ${t.external} outside the queue (cq external)` : ''}` +
    `${t.parked ? ` · ${t.parked} parked (cq continue)` : ''}` +
    `${t.focus?.notice ? ' · FOCUS WARNING (cq focus)' : ''}` +
    `${t.empty ? ' · THE QUEUE IS OUT OF WORK' : ''}`
  );
}

const SUMMARY_STATUSES = ['running', 'review', 'picked'];

/**
 * `queue.mjs show` (short, the default for the orchestrator): one line per active task (running, review, picked) and per
 * task that can start now, then the counts. The target is below approx. 3,000 characters (the full table was approx. 66,000 characters,
 * approx. 20,000 tokens per call). The full one is behind `show --full`.
 * @param {object} queue the queue
 * @param {{ now?: number, uncommitted?: string[], dailyUsage?: number, width?: number }} [option]
 * @returns {string[]} the lines
 */
function summaryView(
  queue,
  { now = Date.now(), uncommitted = [], dailyUsage, width = 110, cursor = null, load = null } = {},
) {
  const tasks = queue.tasks ?? [];
  const cut = (s) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);
  const out = [];

  const activeOnes = tasks.filter((o) => SUMMARY_STATUSES.includes(o.status) && !isExternalRow(o));
  out.push(`ACTIVE (${activeOnes.length}):`);
  for (const o of activeOnes) {
    // Age: in review since delivery, picked since picking, otherwise since start.
    const from =
      o.status === 'picked'
        ? o.picked_at
        : o.status === 'review'
          ? (o.delivered ?? o.started)
          : o.started;
    const age = from ? ageText(now - Date.parse(from)) : '?';
    const who = o.status === 'picked' ? ` by ${o.picked_by ?? '?'}` : '';
    out.push(
      cut(
        `  ${o.id.padEnd(12)} ${o.status.padEnd(7)} ${String(o.class).padEnd(2)} ${age.padEnd(10)} ` +
          `migr ${o.migr_block ?? '-'}${who}  ${o.title ?? ''}`,
      ),
    );
  }

  const guard = startGuard(queue, dailyUsage, { now, cursor, load });
  const startable = guard ? [] : selectNext(queue, now, { uncommitted });
  out.push(
    `STARTABLE NOW (${startable.length}${startable.length ? '; cq fill starts them' : ''}):`,
  );
  for (const v of startable) {
    const o = tasks.find((x) => x.id === v.id);
    out.push(
      cut(
        `  ${v.id.padEnd(12)} ${v.class.padEnd(2)} ${String(v.domain).padEnd(12)} ${`${v.estimate} min`.padEnd(8)} ` +
          `prio ${v.score}${'step' in v ? ` ${stepText(v)}` : ''}  ${o?.title ?? ''}`,
      ),
    );
  }
  if (guard) out.push(cut(`  ${guard.message}`));

  const t = state(queue, dailyUsage, { uncommitted, now, cursor, load });
  // The focus line and the warning (only when a focus is set).
  if (t.focus) {
    out.push(cut(`FOCUS${t.focus.name ? ` "${t.focus.name}"` : ''}: ${t.focus.text}`));
    if (t.focus.active)
      out.push(
        cut(
          `  ${t.focus.readyOnes} ready in focus · ${t.focus.in_focus} waiting in focus · ${t.focus.inProgress} in progress · ` +
            `${t.focus.dragged_with} pulled along`,
        ),
      );
    if (t.focus.notice) out.push(cut(`  ${t.focus.notice}`));
  }
  const waiting = tasks.filter((o) => o.status === 'waiting' && !isBatched(o));
  const perClass = Object.keys(WEIGHT)
    .map((k) => [k, waiting.filter((o) => o.class === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
  out.push('', stateLine(t));
  if (waiting.length)
    out.push(
      `Waiting per class: ${perClass}; ${t.blocked.length} of them are blocked now (see show --full).`,
    );
  const batch = batchGroups(queue);
  if (batch.length) {
    const n = batch.reduce((s, g) => s + g.count, 0);
    const readyOnes = batch.filter((g) => g.ready).length;
    out.push(
      `BATCH_QUEUE (${n} task(s) in ${batch.length} group(s)${readyOnes ? `, ${readyOnes} ready for packing` : ''}; ` +
        'cq batch)',
    );
  }
  if (t.ownerQuestion.length)
    out.push(
      cut(
        `Owner questions that unlock the most: ${t.ownerQuestion
          .slice(0, 5)
          .map((s) => `${s.sp} (${s.tasks})`)
          .join(' · ')}`,
      ),
    );
  if (!guard) {
    const b = budgetGuard(queue, dailyUsage);
    if (b.active && b.message) out.push(cut(b.message));
    const n = nightGuard(queue, now);
    if (n.active && n.message) out.push(cut(n.message));
  }
  out.push('Full list: cq show --full (or --all, --grouped, --project <pid>).');
  return out;
}

// ---- RESULT and FINDINGS lines ------------------------------------------------------------------------------

/**
 * Finds the first line that starts with `word` (RESULT or FINDINGS). Tolerant: markdown characters (`*`, backtick, `>`,
 * `#`, `-`) around the line and a colon after the word are accepted.
 * @returns {{ line: string, rest: string } | null}
 */
function fixedLine(text, word) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const l = raw
      .replace(/[`*]/g, '')
      .replace(/^[\s>#-]+/, '')
      .trim();
    if (l === word || l.startsWith(`${word} `) || l.startsWith(`${word}:`))
      return {
        line: l,
        rest: l.slice(word.length).replace(/^:/, '').trim(),
      };
  }
  return null;
}

/** The `key=value` pairs in the rest of a fixed line; the keys in lowercase. */
function keyValues(rest) {
  const out = {};
  // Keys are lowercased, so camelCase keys (ownerQuestions) are read as lowercase (ownerquestions).
  for (const m of String(rest).matchAll(/([A-Za-z\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5_]+)=(\S*)/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

const numberOrNull = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);

/**
 * The track's RESULT line, e.g. `RESULT status=DONE branch=queue/X commits=3 migr=3490-3492 gates=OK
 * probe=red→green(12/12) ownerQuestions=0 edge=-` (`probe`: the tests red before and green after; `edge`: deploy after
 * the merge, `-` = none). Missing line: null (the caller falls back to the current behavior).
 * @returns {null | { line: string, status: string|null, branch: string|null, commits: number|null, migr: string|null,
 *   gates: string|null, probe: string|null, ownerQuestions: number|null, edge: string|null, extra: object }}
 */
function parseResult(text) {
  const f = fixedLine(text, 'RESULT');
  if (!f) return null;
  const kv = keyValues(f.rest);
  const known = ['status', 'branch', 'commits', 'migr', 'gates', 'probe', 'ownerquestions', 'edge'];
  const extra = {};
  for (const [k, v] of Object.entries(kv)) if (!known.includes(k)) extra[k] = v;
  return {
    line: f.line,
    status: kv.status ? kv.status.toUpperCase() : null,
    branch: kv.branch ?? null,
    commits: numberOrNull(kv.commits),
    migr: kv.migr ?? null,
    gates: kv.gates ?? null,
    probe: kv.probe ?? null,
    ownerQuestions: numberOrNull(kv.ownerquestions),
    edge: kv.edge ?? null,
    extra,
  };
}

/**
 * The reviewer's FINDINGS line, e.g. `FINDINGS H=0 M=1 L=3 deferrable=L2,L3`. Missing line: null. A missing number
 * becomes 0 when at least one of H/M/L is there.
 * @returns {null | { line: string, H: number, M: number, L: number, deferrable: string[] }}
 */
function parseFindings(text) {
  const f = fixedLine(text, 'FINDINGS');
  if (!f) return null;
  const kv = keyValues(f.rest);
  const h = numberOrNull(kv.h);
  const m = numberOrNull(kv.m);
  const l = numberOrNull(kv.l);
  if (h == null && m == null && l == null) return null;
  const u = String(kv.deferrable ?? '').trim();
  return {
    line: f.line,
    H: h ?? 0,
    M: m ?? 0,
    L: l ?? 0,
    deferrable:
      !u || u === '-'
        ? []
        : u
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
  };
}

/** The sum of the review reports' FINDINGS lines (one per reviewer and round). No lines: null. */
function batchFindings(list) {
  const validOnes = (list ?? []).filter(Boolean);
  if (!validOnes.length) return null;
  const out = { H: 0, M: 0, L: 0, deferrable: [], reports: validOnes.length };
  for (const f of validOnes) {
    out.H += f.H;
    out.M += f.M;
    out.L += f.L;
    for (const x of f.deferrable) if (!out.deferrable.includes(x)) out.deferrable.push(x);
  }
  return out;
}

// ---- The transcripts (the track's and the reviewer's last answer) ----------------------------------------------------------

/** The lines in an agent transcript (JSONL) as objects; broken lines are skipped. */
function transcriptRows(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* half line (the transcript is written while we read) */
    }
  }
  return out;
}

/**
 * The agent's last answer: the last text from the assistant, or the message in a SubagentHandback call (the report
 * is delivered that way when the agent has that tool). Null when the transcript has no answer.
 */
function lastAnswer(text) {
  let last = null;
  for (const r of transcriptRows(text)) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const c of r.message.content) {
      if (c?.type === 'text' && String(c.text ?? '').trim()) last = c.text;
      else if (c?.type === 'tool_use' && c.name === 'SubagentHandback' && c.input?.message)
        last = c.input.message;
    }
  }
  return last;
}

/** The first user message in a transcript (the mission the agent got). */
function firstUserMessage(text) {
  for (const r of transcriptRows(text)) {
    if (r.type !== 'user' || !r.message) continue;
    const m = r.message.content;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.map((c) => c?.text ?? '').join(' ');
  }
  return null;
}

/**
 * Does the text mention the task id as a whole word? `A-1b` is found in "queue/A-1b" and "A-1b-r2", but not in "A-1b2" or
 * "XA-1b".
 */
function mentionsTask(text, id) {
  return new RegExp(`(^|[^A-Za-z0-9-])${regexSafe(id)}(?![A-Za-z0-9])`).test(String(text ?? ''));
}

// ---- Cost per task ---------------------------------------------------------------------------------------

/** The agent types that count toward a task: tracks and the reviewers (from the setup). */
const taskAgentTypes = () => ['track', 'track-d', ...reviewerTypes()];

/**
 * The agents in the time log (config().timeLog, written by hook-time.mjs from the transcripts) that belong to the
 * task. `secure`: the track label is the task or a fix round of it (timeCost.taskIdFor). `uncertainOnes`: agents
 * without a recognized track label (the label is the agent id) of the types track, track-d and the reviewers, that stopped after `from`
 * and started before `to`; the caller keeps them only when their mission mentions the task (mentionsTask).
 * The rows are cumulative; the last row with tokens per agent is the agent's total usage.
 * @returns {{ secure: {agent: string, type: string, row: object}[], uncertainOnes: {agent: string, type: string, row: object}[] }}
 */
function agentsForTask(rows, id, { from = null, to = null } = {}) {
  const last = new Map();
  const first = new Map();
  const types = new Map();
  for (const r of rows ?? []) {
    if (!r?.agent_id) continue;
    const t = Date.parse(r.time);
    if (!first.has(r.agent_id) || t < first.get(r.agent_id)) first.set(r.agent_id, t);
    if (r.agent_type) types.set(r.agent_id, require('./projectRoot.js').bareAgentType(r.agent_type));
    if (r.event !== 'done' || !r.tokens) continue;
    const f = last.get(r.agent_id);
    if (!f || t >= Date.parse(f.time)) last.set(r.agent_id, r);
  }
  const isId = (s) => s === id;
  const secure = [];
  const uncertainOnes = [];
  for (const [agent, row] of last) {
    const type = types.get(agent) ?? 'unknown';
    const track = row.track ?? null;
    if (track && TK.taskIdFor(track, isId) === id) {
      secure.push({ agent, type, row });
      continue;
    }
    const unknownTrack = !track || agent.startsWith(track);
    if (!unknownTrack || !taskAgentTypes().includes(type)) continue;
    if (from && Date.parse(row.time) < Date.parse(from)) continue;
    if (to && first.get(agent) > Date.parse(to)) continue;
    uncertainOnes.push({ agent, type, row });
  }
  return { secure, uncertainOnes };
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * The sum of the usage of the agents that belonged to the task. Each agent has `tokens` and `model` from the transcript
 * (timeCost.analyzeTranscript) or from the last row in the time log; the price is timeCost.costUsd (API-equivalent USD).
 * @param {{ agent: string, type: string, tokens: object, model?: string|null, turns?: number, source?: string }[]} agents
 * @returns {{ usd: number, tokens: { input: number, output: number, cache_read: number, cache_written: number,
 *   sum: number }, turns: number, agents: { agent: string, type: string, usd: number, source: string }[],
 *   measured: string }}
 */
function sumCost(agents, now = new Date().toISOString()) {
  const tokens = { input: 0, output: 0, cache_read: 0, cache_written: 0, sum: 0 };
  let usd = 0;
  let turns = 0;
  const list = [];
  for (const a of agents ?? []) {
    const u = TK.costUsd(a.tokens, a.model ?? undefined);
    usd += u;
    turns += Number(a.turns ?? 0) || 0;
    for (const k of ['input', 'output', 'cache_read', 'cache_written']) {
      const n = Number(a.tokens?.[k] ?? 0) || 0;
      tokens[k] += n;
      tokens.sum += n;
    }
    list.push({ agent: a.agent, type: a.type, usd: round2(u), source: a.source ?? 'timeLog' });
  }
  return { usd: round2(usd), tokens, turns, agents: list, measured: now };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The statistics `queue.mjs cost` shows: finished tasks with measured cost (since `since`), per class and total, with findings
 * from the review.
 * @returns {{ rows: object[], perClass: object[], total: { n: number, usd: number } }}
 */
function costStatistics(queue, { since = null } = {}) {
  const rows = (queue.tasks ?? [])
    .filter((o) => o.status === 'done' && o.cost && Number.isFinite(Number(o.cost.usd)))
    .filter((o) => !since || Date.parse(o.done ?? o.cost.measured) >= Date.parse(since))
    .map((o) => ({
      id: o.id,
      class: o.class,
      done: o.done ?? null,
      usd: Number(o.cost.usd),
      tokens: Number(o.cost.tokens?.sum ?? 0),
      agents: (o.cost.agents ?? []).length,
      findings: o.findings ?? null,
      result: o.result?.status ?? null,
    }))
    .sort((a, b) => String(b.done).localeCompare(String(a.done)));
  const perClass = Object.keys(WEIGHT)
    .map((cls) => {
      const r = rows.filter((x) => x.class === cls);
      const withFindings = r.filter((x) => x.findings);
      return {
        class: cls,
        n: r.length,
        usd: round2(r.reduce((s, x) => s + x.usd, 0)),
        median_usd: r.length ? round2(median(r.map((x) => x.usd))) : null,
        reviewed: withFindings.length,
        H: withFindings.reduce((s, x) => s + x.findings.H, 0),
        M: withFindings.reduce((s, x) => s + x.findings.M, 0),
        L: withFindings.reduce((s, x) => s + x.findings.L, 0),
      };
    })
    .filter((k) => k.n > 0);
  return {
    rows,
    perClass,
    total: { n: rows.length, usd: round2(rows.reduce((s, x) => s + x.usd, 0)) },
  };
}

// ---- Review package (`queue.mjs receive`) -------------------------------------------------------------------------------

/**
 * Which files the package gets in full version from the branch. `nameStatus` is `git diff --name-status --no-renames`, `numstat`
 * is `git diff --numstat --no-renames` (binary files have "-" in the numbers). Deleted and binary files are skipped.
 * @returns {{ copy: string[], skipped: { path: string, reason: string }[] }}
 */
function packageFiles(nameStatus, numstat) {
  const binary = new Set();
  for (const l of String(numstat ?? '').split(/\r?\n/)) {
    const m = l.match(/^-\t-\t(.+)$/);
    if (m) binary.add(m[1]);
  }
  const copy = [];
  const skipped = [];
  for (const l of String(nameStatus ?? '').split(/\r?\n/)) {
    const m = l.match(/^([A-Z])\d*\t(.+)$/);
    if (!m) continue;
    const [, s, filePath] = m;
    if (s === 'D') skipped.push({ path: filePath, reason: 'deleted' });
    else if (binary.has(filePath)) skipped.push({ path: filePath, reason: 'binary' });
    else copy.push(filePath);
  }
  return { copy, skipped };
}

/**
 * Changed DB objects in the diff: `create`/`alter`/`drop` of function, table, policy, trigger, view, index and type on
 * new lines in .sql files under the migration folder (config().migrations.folder). Policies get the table included when it is
 * on the same line. Without a migration folder: empty list.
 * @param {string} diff
 * @param {{ folder?: string|null }} [migrations]
 * @returns {string[]} e.g. "create function public.foo", "create policy "read" on public.bar"
 */
function dbObjectsFromDiff(diff, migrations = cfg().migrations) {
  const folder = migrations?.folder
    ? String(migrations.folder).replace(/\\/g, '/').replace(/\/+$/, '')
    : null;
  if (!folder) return [];
  const fileRe = new RegExp(`^${regexSafe(folder)}/.+\\.sql$`);
  const out = [];
  let file = null;
  const re =
    /^\+\s*(create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(function|procedure|table|policy|trigger|materialized\s+view|view|index|type)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:concurrently\s+)?("[^"]+"|[\w.]+(?:\."[^"]+")?)(.*)$/i;
  for (const l of String(diff ?? '').split(/\r?\n/)) {
    if (l.startsWith('+++ ')) {
      file = l.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (!file || !fileRe.test(file) || l.startsWith('+++')) continue;
    const m = l.match(re);
    if (!m) continue;
    const type = m[2].toLowerCase().replace(/\s+/g, ' ');
    let name = `${m[1].toLowerCase()} ${type} ${m[3]}`;
    if (type === 'policy') {
      const on = m[4].match(/\bon\s+([\w."]+)/i);
      if (on) name += ` on ${on[1]}`;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The index file in the review package (`00-package.md`): what the task is, the track's RESULT line, the diff statistics, changed
 * DB objects and which files are in the package. The package is PLAIN FILES (a reviewer without Bash cannot read
 * git objects).
 */
function reviewPackageIndex({
  o,
  branch,
  stat,
  dbObjects = [],
  copied = [],
  skipped = [],
  result = null,
  files = {},
  base = baseBranch(),
  migrFolder = cfg().migrations?.folder ?? null,
}) {
  const lines = [
    `# Review package ${o.id} (${o.class}): ${o.title ?? ''}`,
    '',
    `Branch \`${branch}\`, diff against \`${base}\` (merge-base).` +
      (migrFolder ? ` Migration block: ${o.migr_block ?? 'none'}.` : ''),
    `Track result line: ${result ? `\`${result.line}\`` : "(missing; see the track's answer and report)"}`,
    '',
    '## The files in the package',
    '',
    `- \`diff.patch\`: the whole diff (\`git diff ${base}...<branch>\`).`,
    `- \`files/\`: ${copied.length} changed file(s) in full version from the branch (same paths as in the repo).`,
  ];
  if (files.trackReply)
    lines.push("- `trackReply.md`: the track's last answer (the report to the orchestrator).");
  if (files.report)
    lines.push("- `trackReport.md`: the track's `report.md` (self-review, test run, connections).");
  if (files.handover) lines.push('- `handover.md`: the handover from a PARTIAL track.');
  if (skipped.length)
    lines.push(`- Not included: ${skipped.map((h) => `\`${h.path}\` (${h.reason})`).join(', ')}.`);
  if (migrFolder) {
    lines.push('', '## Changed DB objects', '');
    if (dbObjects.length) for (const d of dbObjects) lines.push(`- ${d}`);
    else lines.push(`- (none in ${migrFolder})`);
  }
  lines.push('', '## Diff statistics', '', '```', String(stat ?? '').trimEnd(), '```', '');
  return lines.join('\n');
}

/** The short reviewer prompt. "track <id>" in the text ties the reviewer's cost to the task. */
function reviewerPrompt({ o, type, folder }) {
  const sep = String(folder).includes('\\') ? '\\' : '/';
  return [
    `You are ${type} for track ${o.id} (class ${o.class}, branch ${o.branch ?? queueBranch(o.id)}) in the work queue.`,
    `Read the review package: ${folder}${sep}00-package.md first, then diff.patch and the files under files${sep} (full version from the`,
    "branch), and the track's answer and report when they are there. Look things up in the rest of the repo only for a concrete",
    'question, with grep -n and excerpts. At most approx. 40 turns; rather leave the question open in the report.',
    'Your answer is at most approx. 1,500 characters. First line in fixed format: FINDINGS H=<count> M=<count> L=<count>',
    'deferrable=<finding codes that can wait, comma-separated, or ->. Then one short point per H and M finding (code,',
    'file:line, fix), L findings only with code and one sentence. Do not repeat the package.',
  ].join('\n');
}

// ---- Bulk edit, changelog and undo, block moves, proposed projects ----------------------
//
// Used by queue.mjs
// (edit-many --dry/--expect-changed, ranger, undo, classify, the warnings in add and project) and by the board via
// queue.mjs. New, optional fields in queue.json:
//   changelog: [{ nr, at, by, action, changes: [{ id|pid, field, before, after }], undone? }]   the last 50
//                 writes from edit, edit-many, ranger, park, continue, project and classify. Only fields that
//                 actually changed (id, field and values; no personal data). `null` = the field did not exist.
//   projects.<pid>.fileRoot: [path]       folders/files that characterize the project (signal for classify).
//   projects.<pid>.features: [name]  known feature names (add warns about new ones).

/** At most this many entries in the changelog (the oldest fall out). */
const CHANGELOG_MAX = 50;
/** How far past the neighbor a block lands at the top or bottom (in priority points; like queueBoard.STEP). */
const RANK_STEP = 10;
/** Fields that are owned by their own commands (set, start, pick …) and are never rolled back by undo. */
const UNDO_BLOCKED = new Set([
  'id',
  'status',
  'started',
  'done',
  'branch',
  'migr_block',
  'picked_by',
  'picked_at',
  'added_at',
  'external',
  'external_name',
  'done_outside_queue',
]);

/** Deep copy of a JSON value; undefined becomes null. */
function cloneJson(x) {
  return x === undefined ? null : JSON.parse(JSON.stringify(x));
}

/** JSON with sorted keys, so two equal objects always compare equal. */
function stableJson(x) {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (x && typeof x === 'object')
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(x[k])}`)
      .join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

/** Are two field values equal? null and a missing field are the same. */
function equalValue(a, b) {
  return stableJson(a ?? null) === stableJson(b ?? null);
}

/**
 * The difference between two versions of the queue: tasks (per id, only those that exist in both) and the project register (per pid).
 * Only fields that actually changed. For the preview (`edit-many --dry`) and the changelog.
 * @returns {{ id?: string, pid?: string, field: string, before: unknown, after: unknown }[]}
 */
function bulkDiff(forQueue, afterQueue) {
  const out = [];
  const forPerId = new Map((forQueue?.tasks ?? []).map((o) => [o.id, o]));
  for (const o of afterQueue?.tasks ?? []) {
    const f = forPerId.get(o.id);
    if (!f) continue;
    for (const field of [...new Set([...Object.keys(f), ...Object.keys(o)])].sort()) {
      if (!equalValue(f[field], o[field]))
        out.push({
          id: o.id,
          field,
          before: cloneJson(f[field] ?? null),
          after: cloneJson(o[field] ?? null),
        });
    }
  }
  const forReg = forQueue?.projects ?? {};
  const afterReg = afterQueue?.projects ?? {};
  for (const pid of [...new Set([...Object.keys(forReg), ...Object.keys(afterReg)])]) {
    const f = forReg[pid] ?? {};
    const e = afterReg[pid] ?? {};
    for (const field of [...new Set([...Object.keys(f), ...Object.keys(e)])].sort()) {
      if (!equalValue(f[field], e[field]))
        out.push({ pid, field, before: cloneJson(f[field] ?? null), after: cloneJson(e[field] ?? null) });
    }
  }
  return out;
}

/** Short text for a value in the preview and error messages. */
function valueText(v, max = 60) {
  if (v == null) return '(none)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** What a change concerns: the task id, "project <pid>" or "focus" (cleanFocus). */
function changeWho(e) {
  if (e?.id != null) return e.id;
  if (e?.pid != null) return `project ${e.pid}`;
  return e?.focus ? 'focus' : '?';
}

/** The lines in the preview: "A-1 project: alpha → beta". */
function diffLines(changes, { max = 200 } = {}) {
  const lines = (changes ?? [])
    .slice(0, max)
    .map((e) => `${changeWho(e)} ${e.field}: ${valueText(e.before)} → ${valueText(e.after)}`);
  if ((changes ?? []).length > max) lines.push(`… and ${changes.length - max} more`);
  return lines;
}

/**
 * Adds an entry to the changelog (the last CHANGELOG_MAX are kept). No entry when nothing changed.
 * @returns {object|null} entry
 */
function logChange(queue, { by = null, action, changes, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(changes) || !changes.length) return null;
  const log = Array.isArray(queue.changelog) ? queue.changelog : [];
  const nr = log.reduce((m, p) => Math.max(m, Number(p?.nr) || 0), 0) + 1;
  const entry = {
    nr,
    at: now,
    by: String(by ?? '').trim() || 'unknown',
    action: String(action ?? 'unknown'),
    changes: cloneJson(changes),
  };
  log.push(entry);
  queue.changelog = log.slice(-CHANGELOG_MAX);
  return entry;
}

/** The last entry that is not undone (the one `undo` rolls back), or null. */
function lastUndoable(queue) {
  const log = Array.isArray(queue?.changelog) ? queue.changelog : [];
  for (let i = log.length - 1; i >= 0; i -= 1) if (!log[i]?.undone) return log[i];
  return null;
}

/**
 * Rolls back the last entry in the changelog that is not undone (queue.mjs undo). Refuses (nothing is changed) when a
 * field no longer has the "after" value (someone has changed it since), when a task is gone, or when the result breaks
 * the rules (the project must exist, only waiting and proposed can be parked, the batch queue rules). The entry stays, marked
 * `undone`, so the log shows what happened; the next undo takes the entry before it. `show` checks without editing anything.
 * @returns {{ error: string[], entry?: object, show?: boolean }}
 */
function undoEntry(queue, { by = null, now = new Date().toISOString(), show = false } = {}) {
  const entry = lastUndoable(queue);
  if (!entry)
    return { error: ['nothing to undo (the changelog is empty, or everything in it is undone)'] };
  const tasks = cloneJson(queue.tasks ?? []);
  const register = cloneJson(queue.projects ?? {});
  const perId = new Map(tasks.map((o) => [o.id, o]));
  const error = [];
  const affected = new Set();
  const batchedAffected = new Set();
  const pids = new Set();
  // Changes to the focus itself (focus clean) have `focus: true` and are rolled back on a copy.
  const focus = cloneJson(queue.focus ?? {});
  let focusAffected = false;
  for (const e of entry.changes ?? []) {
    const who = changeWho(e);
    if (e.id != null && UNDO_BLOCKED.has(e.field)) {
      error.push(`${who}: ${e.field} cannot be undone (use the command that owns the field)`);
      continue;
    }
    let measure;
    if (e.id == null && e.pid == null && e.focus === true) {
      measure = focus;
      focusAffected = true;
    } else if (e.id != null) {
      measure = perId.get(e.id);
      if (!measure) {
        error.push(`${e.id}: no longer exists in the queue`);
        continue;
      }
    } else if (e.pid != null) {
      measure = register[e.pid] ?? {};
      register[e.pid] = measure;
      pids.add(e.pid);
    } else {
      error.push('the entry has a change without id or pid');
      continue;
    }
    if (!equalValue(measure[e.field], e.after)) {
      error.push(
        `${who} ${e.field} has changed since (now ${valueText(measure[e.field])}, the entry set ${valueText(e.after)})`,
      );
      continue;
    }
    if (e.before == null) delete measure[e.field];
    else measure[e.field] = cloneJson(e.before);
    if (e.id != null) {
      affected.add(e.id);
      if (e.field === 'batched') batchedAffected.add(e.id);
    }
  }
  // A project the entry created disappears again when all fields are rolled back.
  const removed = [...pids].filter((pid) => !Object.keys(register[pid]).length);
  for (const pid of removed) delete register[pid];
  if (!error.length) {
    for (const pid of pids) {
      if (removed.includes(pid)) continue;
      const r = newRegister({}, { [pid]: register[pid] }, queue.areas);
      error.push(...r.error);
    }
    for (const o of tasks) {
      if (removed.includes(o.project))
        error.push(`${o.id} uses the project ${o.project}, which undo would remove`);
    }
    for (const id of affected) {
      const o = perId.get(id);
      for (const f of validateNewField(o, register, { stringProject: true }))
        error.push(`${id}: ${f}`);
      if (o.parked && o.status !== 'waiting' && o.status !== 'proposed')
        error.push(`${id}: status ${o.status} (only waiting and proposed can be parked)`);
      if (batchedAffected.has(id))
        for (const f of batchedError(o, tasks, queue.resolved)) error.push(`${id}: ${f}`);
    }
  }
  if (error.length) return { error, entry };
  if (show) return { error: [], entry, show: true };
  queue.tasks = (queue.tasks ?? []).map((o) => (affected.has(o.id) ? perId.get(o.id) : o));
  if (pids.size) queue.projects = register;
  if (focusAffected) {
    if (!Array.isArray(focus.history) || !focus.history.length) delete focus.history;
    queue.focus = focus;
  }
  entry.undone = { at: now, by: String(by ?? '').trim() || 'unknown' };
  return { error: [], entry };
}

/**
 * Optimistic concurrency (`--expect-changed <iso>`): null when the queue has not changed after the time the board (or another
 * caller) previewed, otherwise the error text. Called under the lock.
 */
function expectCheck(queue, expectValue) {
  if (expectValue == null) return null;
  const f = Date.parse(String(expectValue));
  if (!Number.isFinite(f))
    return `invalid --expect-changed ${expectValue} (ISO time, e.g. the field changed in /api/state)`;
  const e = Date.parse(String(queue?.changed ?? ''));
  if (Number.isFinite(e) && e > f)
    return (
      `the queue was changed ${queue.changed}, after ${expectValue} which the preview was built on. ` +
      'Get the queue again and review the change again.'
    );
  return null;
}

/**
 * Block move (queue.mjs ranger): moves tasks together to the top (`top`), the bottom (`bottom`), right above (`over: id`)
 * or right below (`under: id`) another, WITHIN the focus stage, and keeps their mutual order. Computes
 * new `priority_bonus` (generalization of queueBoard.boostBonus): the block is spread evenly between the neighbors, or
 * RANK_STEP past the neighbor at the top/bottom. If the block is in several stages, each part is moved within its stage (top/bottom);
 * over/under requires that all are in the reference's stage. Only waiting and proposed.
 * @returns {{ error: string[], changes?: Record<string, number|null>, warnings?: string[] }}
 */
function rankBlock(queue, ids, space = {}, now = Date.now()) {
  const error = [];
  const list = [...new Set(ids ?? [])];
  if (!list.length) error.push('ranger <id> … --top|--bottom|--over <id>|--under <id>');
  const selected = ['top', 'bottom', 'over', 'under'].filter((k) => space?.[k]);
  if (selected.length !== 1) error.push('choose one of --top, --bottom, --over <id> and --under <id>');
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const perId = new Map(tasks.map((o) => [o.id, o]));
  const canBeRanked = (o) => o.status === 'waiting' || o.status === 'proposed';
  for (const id of list) {
    const o = perId.get(id);
    if (!o || isExternalRow(o)) error.push(`unknown task ${id}`);
    else if (!canBeRanked(o))
      error.push(`${id}: status ${o.status} (only waiting and proposed can be ranked)`);
  }
  const ref = space?.over ?? space?.under ?? null;
  if (ref && selected.length === 1) {
    const r = perId.get(ref);
    if (!r || isExternalRow(r)) error.push(`unknown task ${ref}`);
    else if (list.includes(ref)) error.push(`${ref} is in the block itself`);
    else if (!canBeRanked(r)) error.push(`${ref}: status ${r.status} (is not ranked)`);
  }
  if (error.length) return { error };
  const k = rankingContext(queue, now);
  const rank = new Map();
  const ra = (o) => {
    if (!rank.has(o.id)) rank.set(o.id, ranking(o, queue, k));
    return rank.get(o.id);
  };
  const without = (o) => score({ ...o, priority_bonus: 0 }, tasks, now, register);
  const block = list
    .map((id) => perId.get(id))
    .map((o) => ({ o, r: ra(o) }))
    .sort(compareRanking);
  const perStep = new Map();
  for (const x of block) {
    if (!perStep.has(x.r.stage)) perStep.set(x.r.stage, []);
    perStep.get(x.r.stage).push(x);
  }
  if (ref) {
    const t = ra(perId.get(ref)).stage;
    const outside = block.filter((x) => x.r.stage !== t).map((x) => x.o.id);
    if (outside.length)
      return {
        error: [
          `${outside.join(', ')} is in another stage than ${ref}; ranger only moves within the stage (edit the focus to move between stages)`,
        ],
      };
  }
  const inBlock = new Set(list);
  const changes = {};
  const warnings = [];
  for (const [stage, parts] of perStep) {
    const others = tasks
      .filter(
        (o) => !inBlock.has(o.id) && !isExternalRow(o) && canBeRanked(o) && ra(o).stage === stage,
      )
      .map((o) => ({ o, r: ra(o) }))
      .sort(compareRanking);
    let high = null;
    let low = null;
    if (space.top) low = others.length ? others[0].r.score : null;
    else if (space.bottom) high = others.length ? others[others.length - 1].r.score : null;
    else {
      const i = others.findIndex((x) => x.o.id === ref);
      if (space.over) {
        low = others[i].r.score;
        high = i > 0 ? others[i - 1].r.score : null;
      } else {
        high = others[i].r.score;
        low = i < others.length - 1 ? others[i + 1].r.score : null;
      }
    }
    const n = parts.length;
    if (high != null && low != null && high - low < 0.02 * (n + 1))
      warnings.push(
        `too little room between the neighbors (${high} and ${low} score); the block may end up tied with a neighbor (id then decides)`,
      );
    parts.forEach((x, j) => {
      let measure;
      if (high == null && low == null) return; // no others in the stage: the order is already correct
      if (high == null) measure = low + RANK_STEP * (n - j);
      else if (low == null) measure = high - RANK_STEP * (j + 1);
      else measure = low + ((high - low) * (n - j)) / (n + 1);
      const t = round2(measure - without(x.o));
      changes[x.o.id] = Math.abs(t) < 0.005 ? null : t;
    });
  }
  return { error: [], changes, warnings };
}

/** Projects where the source or the mission (the text in the field, not the file) points to the project's plan. */
function planMatch(o, register) {
  const text = norm(
    [o?.source, typeof o?.mission === 'string' ? o.mission : '']
      .filter((x) => typeof x === 'string' && x)
      .join('\n'),
  ).toLowerCase();
  if (!text) return [];
  const match = [];
  for (const [pid, p] of Object.entries(register ?? {})) {
    if (typeof p?.plan !== 'string' || !p.plan.trim()) continue;
    const filePath = norm(p.plan.trim()).toLowerCase();
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    if (text.includes(filePath) || (name.length >= 8 && text.includes(name))) match.push(pid);
  }
  return match;
}

/** Is the file (or folder) under the file root? A root that ends in "/" is a folder; otherwise a file or folder. */
function underRoot(file, root) {
  const f = norm(file);
  const r = norm(root);
  if (r.endsWith('/')) return f.startsWith(r);
  return f === r || f.startsWith(`${r}/`);
}

/** Number of owned files under each project's fileRoot, most first: [{ pid, n }] (only projects with at least one match). */
function fileRootMatch(o, register) {
  const files = (o?.owned_files ?? []).filter((x) => typeof x === 'string' && x);
  const out = [];
  for (const [pid, p] of Object.entries(register ?? {})) {
    const roots = Array.isArray(p?.fileRoot)
      ? p.fileRoot.filter((x) => typeof x === 'string' && x)
      : [];
    if (!roots.length) continue;
    const n = files.filter((f) => roots.some((r) => underRoot(f, r))).length;
    if (n) out.push({ pid, n });
  }
  return out.sort((a, b) => b.n - a.n || a.pid.localeCompare(b.pid));
}

/**
 * Proposed project for a task (add, classify, the "Sort" list). Signals in decreasing strength: (1) explicit
 * `project`, (2) longest prefix, (3) `source`/`mission` points to the project's `plan`, (4) most owned files under
 * the project's `fileRoot`. "Strong" signals are an unambiguous plan and a fileRoot that covers ALL the owned files; if they contradict
 * the choice, the suggestion is uncertain (or, with an explicit project, `disagree`). No or ambiguous signals: pid null
 * ("Sort"). Never an error, so add never stops on this.
 * @returns {{ pid: string|null, signal: 'explicit'|'prefix'|'plan'|'fileRoot'|null, safe: boolean, disagree: boolean,
 *   counterProposal: string|null, reason: string, candidates: { pid: string, signal: string, reason: string }[] }}
 */
function suggestProject(o, register) {
  const reg = register ?? {};
  const candidates = [];
  const pre = longestPrefix(o?.id, reg);
  if (pre) candidates.push({ pid: pre.pid, signal: 'prefix', reason: `the prefix ${pre.prefix}` });
  const plan = planMatch(o, reg);
  for (const pid of plan)
    candidates.push({ pid, signal: 'plan', reason: `the source points to the plan ${reg[pid].plan}` });
  const countFiles = (o?.owned_files ?? []).filter((x) => typeof x === 'string' && x).length;
  const root = fileRootMatch(o, reg);
  for (const r of root)
    candidates.push({
      pid: r.pid,
      signal: 'fileRoot',
      reason: `${r.n} of ${countFiles} owned files under the file root`,
    });
  const cand = (signal, pid) => candidates.find((x) => x.signal === signal && x.pid === pid);
  const strong = [];
  if (plan.length === 1) strong.push(cand('plan', plan[0]));
  const allRoot = root.filter((r) => r.n === countFiles);
  if (countFiles && allRoot.length === 1) strong.push(cand('fileRoot', allRoot[0].pid));

  let selected = null;
  const ambiguous = [];
  if (pre && !pre.also.length) selected = cand('prefix', pre.pid);
  else if (pre)
    ambiguous.push(`the prefix ${pre.prefix} is in ${[pre.pid, ...pre.also].join(', ')}`);
  if (!selected && plan.length === 1) selected = cand('plan', plan[0]);
  else if (!selected && plan.length > 1)
    ambiguous.push(`the source points to the plans of ${plan.join(', ')}`);
  if (!selected && root.length) {
    if (root.length === 1 || root[0].n > root[1].n) selected = cand('fileRoot', root[0].pid);
    else
      ambiguous.push(
        `equally many owned files under the file root of ${root
          .filter((r) => r.n === root[0].n)
          .map((r) => r.pid)
          .join(', ')}`,
      );
  }
  const against = (pid) => {
    const m = strong.filter((s) => s.pid !== pid);
    const pids = [...new Set(m.map((s) => s.pid))];
    return { m, counterProposal: pids.length === 1 ? pids[0] : null };
  };
  const explicit = typeof o?.project === 'string' && o.project ? o.project : null;
  if (explicit) {
    const { m, counterProposal } = against(explicit);
    return {
      pid: explicit,
      signal: 'explicit',
      safe: !m.length,
      disagree: m.length > 0,
      counterProposal,
      reason: m.length
        ? `set to ${explicit}, but ${m.map((s) => `${s.reason} (${s.pid})`).join('; ')}`
        : `set to ${explicit}`,
      candidates,
    };
  }
  if (!selected)
    return {
      pid: null,
      signal: null,
      safe: false,
      disagree: false,
      counterProposal: null,
      reason: ambiguous.length
        ? `ambiguous: ${ambiguous.join('; ')}`
        : 'no prefix, plan or fileRoot matches',
      candidates,
    };
  const { m, counterProposal } = against(selected.pid);
  const reservation = [...ambiguous, ...m.map((s) => `${s.reason} (${s.pid})`)];
  return {
    pid: selected.pid,
    signal: selected.signal,
    safe: !reservation.length,
    disagree: m.length > 0,
    counterProposal,
    reason: reservation.length ? `${selected.reason}, but ${reservation.join('; ')}` : selected.reason,
    candidates,
  };
}

/** The statuses classify looks at (open work; finished and cancelled ones stay as they are). */
const CLASSIFY_STATUSES = new Set(['proposed', 'waiting', 'running', 'picked', 'review']);

/**
 * Proposals for tasks that are already in the queue (queue.mjs classify, the "Sort" list on the board):
 *   move  = without a project today, and a safe proposal (`--execute` sets `project` on them);
 *   disagree  = the project today (explicit or prefix) contradicts a strong signal (the owner decides; never automatic);
 *   sort = without a project, and no or an ambiguous proposal.
 * Filters: `withoutProject` (only those in without-project today), `disagreeing` (only disagree).
 * @returns {{ move: object[], sort: object[] }} rows { id, title, now, proposed, signal, type, reason }
 */
function classifyQueue(queue, { withoutProject = false, disagreeing = false } = {}) {
  const register = queue.projects ?? {};
  const move = [];
  const sort = [];
  for (const o of queue.tasks ?? []) {
    if (isExternalRow(o) || !CLASSIFY_STATUSES.has(o.status)) continue;
    const now = projectFor(o, register);
    const f = suggestProject(o, register);
    let type = null;
    let proposed = f.pid;
    if (now === WITHOUT_PROJECT) type = f.pid && f.safe ? 'move' : 'sort';
    else if (f.disagree) {
      type = 'disagree';
      proposed = f.counterProposal;
    } else if (!f.safe) type = 'sort';
    if (!type) continue;
    if (withoutProject && now !== WITHOUT_PROJECT) continue;
    if (disagreeing && type !== 'disagree') continue;
    const row = {
      id: o.id,
      title: o.title ?? null,
      status: o.status,
      now,
      proposed: proposed ?? null,
      signal: f.signal,
      type,
      reason: f.reason,
    };
    (type === 'move' ? move : sort).push(row);
  }
  return { move, sort };
}

/**
 * Warnings about the prefixes in the register: a one-character prefix without a separator (catches everything starting with it, like "4"), a prefix
 * that is the start of another project's prefix (the longest wins), and the same prefix in two projects (the first in the
 * register wins). `pid` limits to warnings that apply to that project.
 */
function prefixWarnings(register, { pid: bare = null } = {}) {
  const out = [];
  const list = [];
  for (const [pid, p] of Object.entries(register ?? {}))
    for (const pre of Array.isArray(p?.prefixes) ? p.prefixes : [])
      if (typeof pre === 'string' && pre) list.push({ pid, pre });
  for (const a of list) {
    if (bare && a.pid !== bare) continue;
    if (a.pre.length === 1)
      out.push(
        `the prefix ${a.pre} in ${a.pid} is only one character and catches all ids that start with ${a.pre}`,
      );
  }
  for (const a of list) {
    for (const b of list) {
      if (a.pid === b.pid) continue;
      if (bare && a.pid !== bare && b.pid !== bare) continue;
      if (a.pre === b.pre && a.pid < b.pid)
        out.push(
          `the prefix ${a.pre} is in both ${a.pid} and ${b.pid} (the first in the register wins)`,
        );
      else if (a.pre !== b.pre && b.pre.startsWith(a.pre))
        out.push(
          `the prefix ${a.pre} in ${a.pid} is the start of ${b.pre} in ${b.pid} (longest prefix wins: ${b.pre}… goes to ${b.pid})`,
        );
    }
  }
  return out;
}

/**
 * The warnings `add` writes about project and feature for new tasks (never stops add): without a project (with the suggestion
 * and which signal decided, or "Sort"), an explicit project that contradicts strong signals, and a feature
 * that is not in the project's `features` (when that list exists).
 * @returns {string[]}
 */
function addProjectWarnings(newOnes, register) {
  const reg = register ?? {};
  if (!Object.keys(reg).length) return [];
  const out = [];
  for (const n of newOnes ?? []) {
    if (!n || typeof n !== 'object') continue;
    const pid = projectFor(n, reg);
    const f = suggestProject(n, reg);
    if (pid === WITHOUT_PROJECT) {
      out.push(
        f.pid
          ? `${n.id} has no project; proposed ${f.pid} (${f.reason}). Set "project": "${f.pid}", or run cq classify --execute${f.safe ? '' : ' (the suggestion is uncertain: see cq classify)'}`
          : `${n.id} has no project and lands in "Sort" (${f.reason}). Set "project", or give the project a fileRoot/prefix`,
      );
    } else if (f.disagree) {
      out.push(`${n.id}: ${f.reason}. Check the project (cq classify --disagree)`);
    }
    const known = reg[pid]?.features;
    if (
      Array.isArray(known) &&
      known.length &&
      typeof n.feature === 'string' &&
      n.feature.trim() &&
      !known.includes(n.feature.trim())
    ) {
      const equal = known.filter((x) => x.toLowerCase() === n.feature.trim().toLowerCase());
      out.push(
        equal.length
          ? `${n.id}: feature "${n.feature}" is called "${equal[0]}" in ${pid}`
          : `${n.id}: new feature "${n.feature}" in ${pid} (known: ${known.slice(0, 8).join(', ')}${known.length > 8 ? ' …' : ''})`,
      );
    }
  }
  return out;
}

// ---- Fewer orchestrator turns ----
//
// The decisions behind the commands that save orchestrator turns (the I/O lives in queue.mjs):
//   merge <id>        merge-track → (migrationPush, with environment guard) → gates --quick → set done → fill, in one call
//   info / activeOnes     fixed lookups instead of `node -e`
//   edit --bonus   text for the mission (the track block) and the remarks, with a timestamp
//   next-migr [<n>]  show or set the next migration number; never backward and never down into a used number
//   "Start these in the SAME turn:" after fill and receive, and the report cap (approx. 1,500 characters) for the agents' answers.
// The migration step exists only when config().migrations has both `folder` and `pushCommand`.

/** The cap for the agent's answer to the orchestrator (characters). The long version is in report.md. */
const REPORT_CAP = 1500;

/** The migration setup from config(), or "off" when the config cannot be read (pure tests without config). */
function migrSetup(migrations) {
  if (migrations !== undefined) return migrations ?? { folder: null };
  try {
    return require('./queueConfig.js').config().migrations ?? { folder: null };
  } catch {
    return { folder: null };
  }
}

/**
 * Is the environment the migrations are pushed to an allowed environment? Without `environmentFile` in the setup there is no guard (ok). With
 * `environmentFile` the content must be in `allowedEnvironment`; if the file is missing or empty, `merge` stops before the push.
 * @param {string|null|undefined} environment the content of the environment file (null when the file is missing)
 * @param {{ environmentFile?: string|null, allowedEnvironment?: string[] }} [migrations]
 * @returns {{ ok: boolean, environment: string, message: string }}
 */
function environmentCheck(environment, migrations) {
  const m = migrSetup(migrations);
  if (!m.environmentFile) return { ok: true, environment: 'without-guard', message: 'no environment file set' };
  const allowedOnes = Array.isArray(m.allowedEnvironment) ? m.allowedEnvironment : [];
  const r = typeof environment === 'string' ? environment.trim() : '';
  if (!r)
    return {
      ok: false,
      environment: 'missing',
      message:
        `Did not find the environment file ${m.environmentFile} (or it is empty). STOP: merge pushes migrations only to an environment in ` +
        `migrations.allowedEnvironment (${allowedOnes.length ? allowedOnes.join(', ') : 'empty list'}).`,
    };
  if (!allowedOnes.includes(r))
    return {
      ok: false,
      environment: 'unknown',
      message:
        `${m.environmentFile} points to "${r}", which is not in migrations.allowedEnvironment ` +
        `(${allowedOnes.length ? allowedOnes.join(', ') : 'empty list'}). STOP: link to the correct environment first.`,
    };
  return { ok: true, environment: r, message: `${r} (allowed)` };
}

/**
 * The migration files in a file list (the paths from `git diff --name-only`): files directly under `migrations.folder` that
 * match `filePattern`. Without a folder: none.
 */
function migrFiles(files, migrations) {
  const m = migrSetup(migrations);
  if (!m.folder) return [];
  const folder = String(m.folder).replace(/\\/g, '/').replace(/\/+$/, '');
  const pattern = new RegExp(m.filePattern ?? '^(\\d+)_.*\\.sql$');
  return (Array.isArray(files) ? files : []).filter((f) => {
    const s = String(f).replace(/\\/g, '/');
    if (!s.startsWith(`${folder}/`)) return false;
    const name = s.slice(folder.length + 1);
    return !name.includes('/') && pattern.test(name);
  });
}

/**
 * Which steps `merge` runs. Migration push when the project has a migration flow (folder + pushCommand) and the branch has
 * migration files; if the diff cannot be read (`files` null), the migration block decides (rather one push too many than one too
 * few). A block without files gives only a note. Without a migration folder there is never a push step.
 * @param {{ o: object, files: string[]|null, withoutMigrPush?: boolean, withoutFill?: boolean, base?: string,
 *   migrations?: object }} x
 * @returns {{ step: string[], migrPush: boolean, migr: string[], notes: string[] }}
 */
function mergePlan({ o, files, withoutMigrPush = false, withoutFill = false, base = 'baseBranch', migrations }) {
  const m = migrSetup(migrations);
  const notes = [];
  let migr = [];
  let migrPush = false;
  if (m.folder) {
    migr = migrFiles(files, m);
    const hasMigr = Array.isArray(files) ? migr.length > 0 : !!o?.migr_block;
    if (Array.isArray(files) && !migr.length && o?.migr_block)
      notes.push(`migration block ${o.migr_block}, but no migration files in the branch: no push`);
    if (!Array.isArray(files))
      notes.push(`did not find the diff against ${base}; the migration block decides the push`);
    if (hasMigr && !m.pushCommand)
      notes.push(
        'the branch has migrations, but migrations.pushCommand is not set: push them yourself after the merge',
      );
    else if (hasMigr && withoutMigrPush)
      notes.push('migration push skipped (--without-migr-push): the migrations are NOT pushed yet');
    migrPush = hasMigr && !!m.pushCommand && !withoutMigrPush;
  }
  const step = ['merge', ...(migrPush ? ['migr-push'] : []), 'gates', 'done'];
  if (!withoutFill) step.push('fill');
  return { step, migrPush, migr, notes };
}

/** The last `n` non-empty lines (the error excerpt when a step stops). */
function errorExcerpt(out, n = 20) {
  return String(out ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}

/** The last line that matches the pattern (or the last non-empty one), cut to `max` characters. */
function lastLine(out, pattern = null, max = 140) {
  const lines = errorExcerpt(out, 1000);
  const match = pattern ? lines.filter((l) => pattern.test(l)) : lines;
  const l = (match.length ? match[match.length - 1] : (lines[lines.length - 1] ?? '')).trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

/** Exit codes from `fill` that are not errors: dailyBudget (4), nightPause (5), windDown (6), the machine is full (7). */
const FILL_STOP_CODES = new Set([4, 5, 6, 7]);

/**
 * Runs the steps in `merge` in order and stops at the first error. Does no I/O itself: `run({ step })` runs one
 * step and gives `{ code, out }` (stdout and stderr combined), `readEnvironment()` gives the content of migrations.environmentFile (null when
 * the file is missing), and `guard(environment)` is the push guard for the migration command (null = free). The order, the stop rules
 * and the environment check are here, so they can be tested without git, database or the gates.
 * @param {{ o: object, plan: object, branch: string, currentBranch: string|null, run: Function,
 *   readEnvironment?: Function, guard?: Function, base?: string, migrations?: object }} x
 * @returns {{ ok: boolean, lines: string[], stop: { step: string, message: string, excerpt: string[] }|null }}
 */
function executeMerge({
  o,
  plan,
  branch,
  currentBranch,
  run,
  readEnvironment = () => null,
  guard = () => null,
  base = 'main',
  migrations,
}) {
  const lines = [...plan.notes.map((n) => `NB: ${n}`)];
  const stop = (step, message, out = '') => ({
    ok: false,
    lines,
    stop: { step, message, excerpt: errorExcerpt(out) },
  });
  if (currentBranch !== base)
    return stop(
      'merge',
      `The main tree is on ${currentBranch ?? 'unknown branch'}, not ${base}. Nothing was done.`,
    );
  for (const step of plan.step) {
    if (step === 'merge') {
      const r = run({ step });
      if (r.code !== 0)
        return stop(
          step,
          `merge-track.mjs ${branch} failed (exit ${r.code}). Nothing after the merge was done; ` +
            'if the merge is still in progress, resolve it or undo with git merge --abort.',
          r.out,
        );
      const wt = lastLine(r.out, /^Worktree:/);
      lines.push(
        `merge: ${lastLine(r.out, /^Merged/)}${/^Worktree:/.test(wt) ? ` · ${wt}` : ''}`,
      );
    } else if (step === 'migr-push') {
      const m = migrSetup(migrations);
      const environment = readEnvironment();
      const ms = environmentCheck(environment, m);
      if (!ms.ok) return stop(step, `Merged, but no migration push: ${ms.message}`);
      const v = guard(environment);
      if (v)
        return stop(
          step,
          `Merged, but no migration push: the push guard says ${v.decision}: ${v.reason}`,
        );
      const r = run({ step });
      if (r.code !== 0)
        return stop(
          step,
          `Merged, but the migration push failed (exit ${r.code}). The gates, set done and fill have not run.`,
          r.out,
        );
      lines.push(
        `migrationPush: OK${m.environmentFile ? ` (environment ${ms.environment})` : ''}: ${lastLine(r.out) || 'no output'}`,
      );
      if (m.environmentFile) {
        const after = environmentCheck(readEnvironment(), m);
        if (!after.ok || after.environment !== ms.environment)
          return stop(step, `The environment changed during the migration push: ${after.message}`);
      }
    } else if (step === 'gates') {
      const r = run({ step });
      if (r.code !== 0)
        return stop(
          step,
          `The gates (--quick) are red after the merge${plan.migrPush ? ' and the migration push' : ''}. The task stays in ` +
            'review; fix it (or send a fix round), and then run set <id> done and fill.',
          r.out,
        );
      lines.push(`gates --quick: ${lastLine(r.out)}`);
    } else if (step === 'done') {
      const r = run({ step });
      if (r.code !== 0) return stop(step, `set ${o.id} done failed (exit ${r.code}).`, r.out);
      lines.push(`done: ${lastLine(r.out, /^Cost |: done/)}`);
    } else if (step === 'fill') {
      const r = run({ step });
      if (FILL_STOP_CODES.has(r.code)) {
        lines.push(`fill: no new ones (exit ${r.code}): ${lastLine(r.out)}`);
        continue;
      }
      if (r.code !== 0)
        return stop(step, `fill failed (exit ${r.code}). ${o.id} is done.`, r.out);
      lines.push(...fillExcerpt(r.out));
    }
  }
  return { ok: true, lines, stop: null };
}

/**
 * From the `fill` output: the FILLED line, one line per track and the agent list "Start these in the SAME turn:"; otherwise the last line
 * (e.g. "Nothing can be started now").
 */
function fillExcerpt(out) {
  const lines = String(out ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const i = lines.findIndex((l) => /^FILLED /.test(l));
  if (i >= 0) return [`fill: ${lines[i]}`, ...lines.slice(i + 1)];
  return [`fill: ${lines[lines.length - 1] ?? 'no output'}`];
}

const SAME_TURN = 'Start these in the SAME turn:';

/**
 * The agent list the orchestrator starts in ONE turn (in parallel): one line per agent with subagent_type and the message
 * (the track message mentions the prompt file; a reviewer gets the content of the prompt file as the message).
 * @param {{ subagent_type: string, prompt: string, message?: string|null }[]} agents
 */
function concurrentBlock(agents) {
  if (!agents?.length) return [];
  return [
    SAME_TURN,
    ...agents.map((x) =>
      x.message
        ? `  subagent_type=${require('./projectRoot.js').agentRef(x.subagent_type)} · message: ${x.message}`
        : `  subagent_type=${require('./projectRoot.js').agentRef(x.subagent_type)} · message: the content of ${x.prompt}`,
    ),
  ];
}

/** The warning `receive` gives when the track's answer is over the report cap (null otherwise). */
function reportCapWarning(text, cap = REPORT_CAP) {
  const n = String(text ?? '').trim().length;
  if (n <= cap) return null;
  return (
    `WARNING: trackReply.md is ${n} characters (cap approx. ${cap}). The answer should be the RESULT line, at most 5 lines and the path to ` +
    'report.md; the long version goes in report.md (see docs/mission-template.md, "Report").'
  );
}

/** The fields `info` shows by default (summary), in this order. */
const INFO_FIELD = [
  'id',
  'title',
  'status',
  'class',
  'domain',
  'project',
  'feature',
  'branch',
  'migr_block',
  'head_start',
  'started',
  'delivered',
  'done',
  'depends_on',
  'waiting_on',
  'owned_files',
  'owner_db',
  'scratchpad',
  'review_package',
];

/** The value of a field, also with a dot (`cost.usd`, `result.line`). undefined when it does not exist. */
function infoField(o, field) {
  let v = o;
  for (const chunk of String(field).split('.')) {
    if (v == null || typeof v !== 'object' || !(chunk in v)) return undefined;
    v = v[chunk];
  }
  return v;
}

/** One field as text: strings raw (so they can be used in a shell), everything else as compact JSON. */
function infoValueText(v) {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Summary default view of one task (`queue.mjs info <id>`): one field per line, the mission and remarks shortened. */
function infoView(o) {
  const out = [];
  for (const f of INFO_FIELD) {
    const v = o[f];
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    out.push(
      `${f}: ${Array.isArray(v) ? v.join(', ') : f === 'head_start' ? String(v).slice(0, 12) : v}`,
    );
  }
  if (o.result?.line) out.push(`result: ${o.result.line}`);
  if (o.cost)
    out.push(
      `cost: $${o.cost.usd} (${o.cost.agents?.length ?? 0} agent(s), ${o.cost.turns ?? '?'} turns)`,
    );
  if (o.findings) out.push(`findings: H=${o.findings.H} M=${o.findings.M} L=${o.findings.L}`);
  const bonus = Array.isArray(o.bonus) ? o.bonus : [];
  if (bonus.length)
    out.push(`bonus: ${bonus.length} (last ${bonus[bonus.length - 1].time})`);
  const mark = Array.isArray(o.remarks) ? o.remarks : [];
  if (mark.length)
    out.push(`remarks: ${mark.length}; last: ${cutText(mark[mark.length - 1], 160)}`);
  if (o.mission) out.push(`mission: ${cutText(String(o.mission).replace(/\s+/g, ' '), 200)}`);
  out.push('One field: cq info <id> --field <name> (also cost.usd, result.line).');
  return out;
}

function cutText(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Adds a bonus to the mission: in `bonus` (the track block shows it, so the prompt file gets it at the next fill/trackFile)
 * and in the remarks, both with a timestamp. Mutates the task; returns the error text or null.
 */
function addToBonus(o, text, now) {
  const t = String(text ?? '').trim();
  if (!t) return 'the addition is empty';
  o.bonus = [...(Array.isArray(o.bonus) ? o.bonus : []), { time: now, text: t }];
  o.remarks = [
    ...(Array.isArray(o.remarks) ? o.remarks : []),
    `${now} bonus to the mission: ${t}`,
  ];
  return null;
}

/** The additions as a separate section in the track block (null when there are none). */
function bonusBlock(o) {
  const t = Array.isArray(o?.bonus) ? o.bonus : [];
  if (!t.length) return null;
  return [
    '**Bonus from the orchestrator (binding, newest last):**',
    ...t.map((x) => `- ${x.time}: ${x.text}`),
  ].join('\n');
}

// The age is written with ageText (above), same format as in show.
const ACTIVE_STATUSES = ['running', 'picked', 'review'];

/**
 * The active tasks (running, picked, review) as short lines: id, status, class, branch, migration block,
 * head_start and age (from start/pick; for review also the time since delivery).
 */
function activeLines(queue, now = Date.now()) {
  const rows = (queue?.tasks ?? []).filter((o) => ACTIVE_STATUSES.includes(o.status));
  if (!rows.length) return ['No active tasks (running, picked, review).'];
  return rows.map((o) => {
    const from = Date.parse(o.started ?? o.picked_at ?? '');
    const vendorList =
      o.status === 'review' && o.delivered
        ? `, delivered ${ageText(now - Date.parse(o.delivered))} ago`
        : '';
    return (
      `${o.id}  ${o.status}  ${o.class}  ${o.branch ?? '-'}  migr ${o.migr_block ?? '-'}  ` +
      `head ${o.head_start ? String(o.head_start).slice(0, 8) : '-'}  age ${Number.isNaN(from) ? '?' : ageText(now - from)}${vendorList}` +
      `${o.picked_by ? `  picked by ${o.picked_by}` : ''}`
    );
  });
}

/** Highest used number in the queue's migration blocks ("3600–3609" → 3609). */
function highestBlockNr(queue) {
  let max = 0;
  for (const o of queue?.tasks ?? []) {
    // Via blockInterval, so a hyphen or a short end number ("3450–59") is read the same way as in takenBlocks.
    const b = blockInterval(o.migr_block);
    if (b) max = Math.max(max, b.to);
  }
  return max;
}

/**
 * Guard for `next-migr <n>`: refuses to go backward (below the current next_migr) and down into a used number (highest
 * migration file in the series or highest assigned block). `taken` (takenBlocks) also refuses a number inside a taken
 * block, e.g. a block moved by hand that only stands in the prompt file. Returns { ok, error } (error = null when ok).
 */
function nextMigrGuard({ now, new: fresh, highestFile = 0, highestBlock = 0, taken = [] }) {
  if (!Number.isInteger(fresh) || fresh <= 0)
    return { ok: false, error: `invalid number "${fresh}" (integer above 0)` };
  if (Number.isInteger(now) && fresh < now)
    return { ok: false, error: `${fresh} is backward (next_migr is ${now}); the queue never goes backward` };
  const used = Math.max(highestFile || 0, highestBlock || 0);
  if (fresh <= used)
    return {
      ok: false,
      error: `${fresh} is not above the highest used number ${used} (migration file ${highestFile || 0}, block ${highestBlock || 0})`,
    };
  const inside = taken.find((t) => t.from <= fresh && t.to >= fresh);
  if (inside)
    return {
      ok: false,
      error: `${fresh} lies in a taken block ${inside.from}–${inside.to} (${inside.source})`,
    };
  return { ok: true, error: null };
}

// ---- Adoption: a new orchestrator session adopts tracks that are running ----------------------------------------
//
// The only thing that ties a track to the session that started it is the <task-notification> when the track delivers.
// These functions make the delivery visible without the notification:
//   - report.md in the track folder (<scratchpad>/<id>/, or the fix round <scratchpad>/<id>-r<N>/) is a SAFE delivery
//     signal when its first line is the RESULT line (status DONE or PARTIAL);
//   - `queue.mjs orchestrator pulse` and `queue.mjs deliveries` report reports that came after the start or the last receive;
//   - `queue.mjs resume <id>` makes the mission for a NEW agent on the same branch (fix round or continuation).
// The fields on the task (all optional): report_received (mtime in ms of the report `receive` read) and report_seen
// (mtime in ms of the newest report a pulse has reported), so the same report is only reported as new once.
// findTrackReport is the one function here that touches the file system: it only reads, and fs/path can be swapped in tests.

/** The reasons `resume` accepts: a fix round after review, or a continuation after the context guard (PARTIAL). */
const RESUME_REASONS = ['fix', 'context'];

/**
 * Safe delivery signal: the first non-empty line of report.md is `RESULT status=DONE|PARTIAL …` (markdown decoration
 * such as `#` and backticks is tolerated, as in parseResult). Otherwise null: a report that is half written or lacks the
 * line is not a delivery (then the heuristic in assessActive applies).
 * @returns {null | { status: 'DONE' | 'PARTIAL', line: string }}
 */
function deliverySignal(text) {
  const first = String(text ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim() !== '');
  if (!first) return null;
  const r = parseResult(first);
  if (!r || !['DONE', 'PARTIAL'].includes(r.status)) return null;
  return { status: r.status, line: r.line };
}

/** The round a scratchpad folder belongs to: `<id>` is 0, `<id>-r<N>` is N, anything else null. */
function trackFolderRound(name, id) {
  const n = String(name ?? '');
  if (n === id) return 0;
  const prefix = `${id}-r`;
  if (!n.startsWith(prefix)) return null;
  const rest = n.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/**
 * Looks in the scratchpad roots (the orchestrator's own and the one saved on the task, o.scratchpad) for the track's
 * folders `<id>` and `<id>-r<N>`, and for the fix round prompts `prompt-<id>-r<N>.md`. Gives the newest report.md, the
 * newest handover.md and the next free round number. Only reads; `fsx` and `pathx` can be swapped in tests.
 * @returns {{ report: null | { path: string, folder: string, round: number, mtimeMs: number, text: string },
 *   handover: null | { path: string, mtimeMs: number }, nextRound: number }}
 */
function findTrackReport(id, roots, fsx = require('node:fs'), pathx = require('node:path')) {
  let report = null;
  let handover = null;
  let maxRound = 0;
  const seen = new Set();
  for (const root of roots ?? []) {
    if (!root) continue;
    const r = pathx.resolve(root);
    if (seen.has(r.toLowerCase())) continue;
    seen.add(r.toLowerCase());
    let names = [];
    try {
      names = fsx.readdirSync(r);
    } catch {
      continue; // the root does not exist (e.g. an old session's scratchpad that has been cleaned up)
    }
    for (const n of names) {
      const prompt = /^prompt-(.+)\.md$/.exec(n);
      const promptRound = prompt ? trackFolderRound(prompt[1], id) : null;
      if (promptRound != null) maxRound = Math.max(maxRound, promptRound);
      const round = trackFolderRound(n, id);
      if (round == null) continue;
      maxRound = Math.max(maxRound, round);
      const folder = pathx.join(r, n);
      for (const file of ['report.md', 'handover.md']) {
        const filePath = pathx.join(folder, file);
        let mtimeMs;
        try {
          const st = fsx.statSync(filePath);
          if (!st.isFile()) continue;
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
        if (file === 'handover.md') {
          if (!handover || mtimeMs > handover.mtimeMs) handover = { path: filePath, mtimeMs };
        } else if (!report || mtimeMs > report.mtimeMs) {
          let text;
          try {
            text = fsx.readFileSync(filePath, 'utf8');
          } catch {
            continue; // file lock while the track writes: the next pulse takes it
          }
          report = { path: filePath, folder, round, mtimeMs, text };
        }
      }
    }
  }
  return { report, handover, nextRound: maxRound + 1 };
}

/** The baseline for a new delivery: the start, the delivery to review or the last receive, whichever is latest (ms). */
function deliveryBase(o) {
  const t = [
    Date.parse(o?.started ?? ''),
    Date.parse(o?.delivered ?? ''),
    Number(o?.report_received ?? Number.NaN),
  ].filter(Number.isFinite);
  return t.length ? Math.max(...t) : 0;
}

/**
 * Is the report a delivery that has not been received? Requires the delivery signal and that the report is newer than
 * deliveryBase (a report from before the start, or the one `receive` has already read, does not count). `new` is true
 * when no pulse has reported exactly this report before (o.report_seen).
 * @param {object} o the task
 * @param {null | { path: string, mtimeMs: number, text: string }} report from findTrackReport
 */
function assessDelivery(o, report) {
  if (!o || !report) return null;
  const sig = deliverySignal(report.text);
  if (!sig) return null;
  if (!(report.mtimeMs > deliveryBase(o))) return null;
  return {
    id: o.id,
    taskStatus: o.status,
    status: sig.status,
    line: sig.line,
    path: report.path,
    mtimeMs: report.mtimeMs,
    new: report.mtimeMs > Number(o.report_seen ?? 0),
  };
}

/**
 * The classification in queue-takeover.mjs for an active task. The safe signal (a delivery from assessDelivery) goes
 * first; the heuristic is the fallback:
 *   DELIVERED: commits ahead of baseBranch, a clean worktree, and no new commit in 20 min (the agent has finished).
 *   EMPTY: no commits and started over an hour ago (the agent died before it did anything). `anotherBranch` is only
 *          called then (git log --all is expensive) and gives a commit on another branch that mentions the id, or null.
 */
function assessActive({
  status,
  commits = 0,
  uncommitted = null,
  lastMs = null,
  startedMs = null,
  delivery = null,
  anotherBranch = () => null,
}) {
  if (delivery)
    return `DELIVERED (report.md ${delivery.status}${status === 'review' ? ', new round after receive' : ''})`;
  if (status === 'review') return commits > 0 ? 'DELIVERED (review)' : 'UNCERTAIN (review without commits)';
  if (commits > 0 && (uncommitted ?? 0) === 0 && (lastMs ?? 0) > 20 * 60_000) return 'DELIVERED';
  if (commits === 0 && (startedMs ?? 0) > 60 * 60_000) {
    const another = anotherBranch();
    return another ? `UNCERTAIN (commit ${another} mentions the id on another branch)` : 'EMPTY';
  }
  if ((uncommitted ?? 0) > 0) return 'UNCERTAIN (uncommitted in worktree)';
  return 'UNCERTAIN';
}

/** The lines pulse and `deliveries` print: one per new delivery (with the next command), and one summary line for the rest. */
function deliveryLines(deliveries, nowMs = Date.now()) {
  const cq = require('./projectRoot.js').cqCommand();
  const fresh = (deliveries ?? []).filter((l) => l.new);
  const old = (deliveries ?? []).filter((l) => !l.new);
  const out = fresh.map(
    (l) =>
      `NEW DELIVERY (report.md): ${l.id} ${l.status}, written ${ageText(nowMs - l.mtimeMs)} ago. ` +
      `Next: ${cq} receive ${l.id}`,
  );
  if (old.length)
    out.push(
      `Report waiting, not received: ${old.map((l) => `${l.id} (${l.status})`).join(', ')} (${cq} deliveries)`,
    );
  return out;
}

/**
 * The track block (make-mission.mjs format) for a NEW agent that continues a track on the same branch: a fix round after
 * review (`fix`) or a continuation after the context guard or PARTIAL (`context`). The track id is `<id>-r<round>`, so the
 * agent's folder becomes `<scratchpad>/<id>-r<round>/` (findTrackReport finds the report there). `original` is the
 * trackBlock text of the task (ownership, mission) and comes along as reference.
 */
function resumeBlock({
  o,
  round,
  reason,
  reportPath = null,
  handoverPath = null,
  reviewFolder = null,
  reviewFiles = [],
  findingsFile = null,
  original = '',
}) {
  const base = baseBranch();
  const trackId = `${o.id}-r${round}`;
  const branch = o.branch ?? `${branchPrefix()}${o.id}`;
  const block =
    o.migr_block ?? 'none (the track must not have migrations; if it needs them, ask the orchestrator)';
  const fix = reason === 'fix';
  const name = fix ? 'Fix round' : 'Continuation';
  const cq = require('./projectRoot.js').cqCommand();
  const read = [
    `1. \`git log --oneline ${base}..${branch}\` and \`git diff --stat ${base}...${branch}\` (what is done; do not redo it).`,
    reportPath
      ? `2. The track's last report: ${reportPath}`
      : '2. The track has no report: build the picture from the commits and the commit messages.',
    handoverPath
      ? `3. The handover (done, remaining, next command, open questions): ${handoverPath}`
      : `3. No handover.md${fix ? '' : ': continue from the report and the commits'}.`,
  ];
  if (reviewFolder)
    read.push(
      `4. The review package: ${reviewFolder} (00-package.md first)` +
        (reviewFiles.length ? `; the reviewers' files there: ${reviewFiles.join(', ')}` : ''),
    );
  if (findingsFile) read.push(`${reviewFolder ? 5 : 4}. The findings to fix: ${findingsFile}`);
  const work = fix
    ? [
        'Fix the review findings: HIGH, and MEDIUM that is not small and mechanical; LOW findings in the same files come along.',
        'Fix at the file:line the findings point to, and only in the files the track owns. A finding you disagree with:',
        'give the reason in the report instead of fixing it.',
      ]
    : [
        'Continue where the previous agent stopped (context guard): do "remaining" from the handover, with "next command"',
        'first. What is already committed is not redone.',
      ];
  return [
    `=====${trackId}=====`,
    `TITLE: TRACK ${trackId} (${name.toLowerCase()} ${round} for ${o.id}: ${o.title})`,
    `CLASS: ${o.class}`,
    `BLOCK: ${block}`,
    `BRANCH: ${branch}`,
    '',
    `## ${name} ${round} for ${o.id} (new agent on the same branch, adoption)`,
    '',
    `The branch ${branch} already has the track's commits. The first call is prepare-track WITH \`--continue\` (it is in the setup`,
    `above): the branch is taken over with \`git switch\` without reset, and its own commits are counted against ${base}. Never`,
    `run it without \`--continue\`: \`checkout -B ${branch} ${base}\` would reset the branch. If it refuses because the branch is`,
    'checked out in another worktree, stop and report the path (the orchestrator frees it).',
    '',
    'Read first (excerpts, not whole files):',
    ...read,
    '',
    ...work,
    '',
    `Report: write report.md in your own folder (\`<folder>\`, that is ${trackId}) with the RESULT line as the FIRST line;`,
    `it covers the whole track (branch=${branch}, commits = all on the branch ahead of ${base}). The orchestrator finds it there`,
    `(${cq} deliveries and ${cq} receive ${o.id}), also without a notification. Your answer starts with the same RESULT line.`,
    '',
    `## The original mission for ${o.id} (reference; ownership, gates and "Do NOT touch" still apply)`,
    '',
    String(original ?? '').trim(),
    '',
  ].join('\n');
}

/**
 * Adapts a prompt from make-mission.mjs to a continuation: the setup call gets `--continue`, and the git line says
 * `git switch` instead of `checkout -B` (the common protocol is written for a new track).
 * @returns {{ text: string, swapped: number }}
 */
function resumePromptAdjust(text, { trackId, branch, base = baseBranch() }) {
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  let swapped = 0;
  let t = String(text ?? '').replace(
    new RegExp(`(prepare-track(?:\\.mjs)? ${esc(trackId)} --branch ${esc(branch)})(?! --continue)`, 'g'),
    (m) => {
      swapped++;
      return `${m} --continue`;
    },
  );
  t = t.replace(
    new RegExp(`\`prepare-track\` runs \`git checkout -B ${esc(branch)} ${esc(base)}\``, 'g'),
    () => {
      swapped++;
      return `\`prepare-track --continue\` runs \`git switch ${branch}\` (without reset)`;
    },
  );
  return { text: t, swapped };
}

module.exports = {
  WEIGHT,
  CALIBRATED,
  estimateWall,
  estimateCost,
  DEFAULT_LIMITS,
  LIMIT_NAME,
  LIMIT_EXTRA,
  estimate,
  validate,
  fileOverlap,
  conflict,
  conflictPart,
  blockers,
  blockerParts,
  childrenMap,
  withIndex,
  successors,
  lockUpCount,
  score,
  hasMigr,
  ACTIVE,
  spaceUse,
  selectNext,
  assignMigrBlock,
  migrTens,
  // Taken migration blocks (start, fill, pick, next-migr, migr move)
  MIGR_FREE_STATUS,
  blockInterval,
  blocksInText,
  promptTask,
  takenBlocks,
  assignStartBlock,
  parseMoveBlock,
  moveBlockInText,
  resetConfig,
  baseBranch,
  branchPrefix,
  queueBranch,
  state,
  budgetGuard,
  NIGHT_TZ,
  parseNightWindow,
  inNightWindow,
  nightGuard,
  startGuard,
  windDownGuard,
  loadGuard,
  minFreeMemoryFor,
  limitText,
  parseLimit,
  isAgentSource,
  statusAtAdd,
  approve,
  // Project, feature, picking and visual QA
  STATUSES,
  WITHOUT_PROJECT,
  WITHOUT_FEATURE,
  OLD_PICK_MS,
  validateNewField,
  projectFor,
  projectPaused,
  blockersWithPause,
  hasLabel,
  counterAsAgent,
  groups,
  projectOverview,
  newRegister,
  editMany,
  // Areas, focus period, pulled along and parking
  WITHOUT_AREA,
  FOCUS_REST,
  areaFor,
  parseStep,
  stepMatch,
  focusApplies,
  ownStep,
  parkedNow,
  draggedWith,
  rankingContext,
  focusSpace,
  ranking,
  compareRanking,
  parseToDate,
  stepText,
  focusText,
  setFocus,
  removeFocus,
  FOCUS_PLAN_MAX,
  saveFocusPlan,
  scoreParts,
  stepTitle,
  openQuestion,
  focusStatus,
  // Done focus stages are evaluated and taken out
  evaluateFocusStep,
  focusWithoutDone,
  cleanFocus,
  focusCleanLines,
  restText,
  setArea,
  areaOverview,
  park,
  continue: proceed,
  migrBlockText,
  pickable,
  pick,
  deliver,
  release,
  isOldPick,
  ageText,
  setStatus,
  qaList,
  qaOk,
  qaDeviation,
  // Work outside the queue, push check and orchestrator marker
  ORCHESTRATOR_TRAILER,
  ORCHESTRATOR_EXPIRY_MS,
  COLLISION_STATUSES,
  isExternalRow,
  hasOrchestratorTrailer,
  queueIdFromMerge,
  classifyCommit,
  mentionedIds,
  consistency,
  pushPlan,
  uncommittedCollision,
  uncommittedSkipped,
  externalCollisions,
  collisionText,
  trackFileWarning,
  externalId,
  externalAdd,
  externalDone,
  externalAccept,
  orchestratorStatus,
  newCursor,
  missingProject,
  QUESTION_TYPES,
  validQuestionId,
  setQuestion,
  resolve,
  unlogged,
  markLogged,
  questionOverview,
  questionWithoutText,
  answerBlock,
  // Owner answers cannot be lost
  QUESTION_ID_PATTERN,
  questionRegistered,
  waitingOnError,
  resolveWaits,
  resolveWaitsLines,
  ownerAnswerBonus,
  // The track block (trackFile and cloud package) and queue tasks in cloud sessions
  trackBlock,
  CLOUD_BY,
  CLOUD_MAX,
  isCloud,
  cloudReferences,
  cloudSuitable,
  cloudPackage,
  CLOUD_BUNDLE_MAX,
  CLOUD_BUNDLE_MIN,
  cloudBundleCap,
  cloudBundlePackage,
  cloudBundles,
  cloudSessions,
  cloudStart,
  cloudDone,
  cloudCancel,
  // Batch queue
  BATCHED_BLOCKER,
  BATCH_MEASURE,
  isBatched,
  inBatchQueue,
  batchedError,
  smallTaskError,
  SMALL_FIX_MIN,
  SMALL_LOW_VALUE,
  batchGroups,
  batchSuggestion,
  batchPack,
  batchMissionText,
  // The orchestrator's routine as script (show summary, fill, receive) and cost per task
  agentTypeFor,
  reviewersFor,
  trackMessage,
  stateLine,
  summaryView,
  parseResult,
  parseFindings,
  batchFindings,
  lastAnswer,
  firstUserMessage,
  mentionsTask,
  DEFAULT_REVIEWERS,
  reviewerTypes,
  get REVIEWER_TYPES() {
    return reviewerTypes();
  },
  get TASK_AGENT_TYPES() {
    return taskAgentTypes();
  },
  agentsForTask,
  sumCost,
  costStatistics,
  packageFiles,
  dbObjectsFromDiff,
  reviewPackageIndex,
  reviewerPrompt,
  // Bulk edit, changelog and undo, block moves, proposed projects
  CHANGELOG_MAX,
  RANK_STEP,
  longestPrefix,
  parkedValue,
  cloneJson,
  equalValue,
  bulkDiff,
  diffLines,
  logChange,
  lastUndoable,
  undoEntry,
  expectCheck,
  rankBlock,
  planMatch,
  fileRootMatch,
  suggestProject,
  classifyQueue,
  prefixWarnings,
  addProjectWarnings,
  // The bulk actions on the board (queueBoard.bulkPlan, packPreview).
  batchId,
  LABEL_PATTERN,
  // Merge in one call, fixed lookups, concurrent calls and the report cap
  REPORT_CAP,
  environmentCheck,
  migrSetup,
  migrFiles,
  mergePlan,
  errorExcerpt,
  executeMerge,
  fillExcerpt,
  SAME_TURN,
  concurrentBlock,
  reportCapWarning,
  infoField,
  infoValueText,
  infoView,
  addToBonus,
  bonusBlock,
  activeLines,
  highestBlockNr,
  nextMigrGuard,
  // Adoption of running tracks (deliveries, resume)
  RESUME_REASONS,
  deliverySignal,
  trackFolderRound,
  findTrackReport,
  deliveryBase,
  assessDelivery,
  assessActive,
  deliveryLines,
  resumeBlock,
  resumePromptAdjust,
};
