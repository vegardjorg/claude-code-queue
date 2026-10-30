// =============================================================
// queueBoard.js: pure logic for the kanban board over the work queue (scripts/orchestrator/queue-board.mjs, see docs/board.md).
//
// The board must show the same as `queue.mjs show/next/projects`. That is why no queue rules live here: priority
// (score), project (projectFor), blockers (blockersWithPause, uncommittedCollision), agent slots
// (counterAsAgent) and limits come from queueLogic.js. This file only holds what the board adds on top:
//   - which column a card sits in (In queue, In progress, Review, Built, and proposed on its own),
//   - which priority_bonus lands a card BETWEEN two neighbors when the owner drags it,
//   - the order and moving of project lanes (the project's priority_bonus),
//   - the WIP counter in the column header,
//   - the colors: an own, neutral palette (light and dark) turned into CSS variables (`PALETTE`, `themeCss`),
//   - the guard rules that warn before a move or action causes problems (`assess`), "Boost dependencies too"
//     (`boostBonus`), the settings panel (`settings`, `SETTINGS`) and the setup that is only shown
//     (`hooksCoverage`, `skillsCoverage`, `highestMigration`, `SKILL_RULES`, `boardTitle`),
//   - "unlocks N" and the chain around a card (`unlocksOf`, `chain`; the successors from queueLogic.successors, same
//     count as the bonus in the priority), aging work against p85 for the class (the bounds from
//     queueStatistics.ageBounds), "Next up" (`nextUp`: queueLogic.selectNext and startGuard directly) and "Waiting on
//     you" (`inbox`: owner questions, QA, proposed and what is stuck),
//   - the batch queue: the cards in their own column (`batch`) and the groups with sum against the target (queueLogic.batchGroups),
//   - the bulk actions from the selection bar: action → queue.mjs command (`bulkPlan`), the explanation in the preview
//     (`bulkSummary`), "Pack into track" previewed on a copy (`packPreview`) and the guard rules for
//     bulk actions (`assess` with type 'bulk'). Tested in lib/__tests__/queueBoardBulk.test.ts,
//   - the path guard for /api/doc (`readDocument`), with the file system passed in by the server.
//
// No I/O here: the server reads queue.json, git and the settings and calls these functions. Writes ALWAYS go through
// queue.mjs (edit, project, edit-many, pick, release, qa, limit, resolve, approve), never from here.
// Tested in lib/__tests__/queueBoard.test.ts.
// =============================================================

const L = require('./queueLogic.js');

/** How far past the neighbor a card or a lane lands at the top or bottom (in priority points). */
const STEP = 10;
/** The Built column shows the last 7 days (plus what is waiting on QA); the rest sits behind "show more". */
const RECENT_MS = 7 * 86_400_000;
/** "Next up" when the slots are full: this many are shown as the next ones. */
const NEXT_WHEN_FULL = 3;

/**
 * The project colors: the category colors from the palette (PALETTE below), chosen because they are made to be told apart (also
 * with color blindness) and keep contrast in both modes. The order spreads neighboring colors. Project no. i in the register
 * gets color no. i (modulo), so the color is stable when the priority changes. `without-project` gets the neutral one.
 */
const PROJECT_COLORS = [
  'category-teal',
  'category-plum',
  'category-ocean-blue',
  'category-moss',
  'category-violet',
  'category-petrol',
  'category-green',
  'category-bla',
  'category-slate',
];
const WITHOUT_PROJECT_COLOR = 'category-graphite';

const round2 = (x) => Math.round(x * 100) / 100;

/** Default branchPrefix (like config().branchPrefix). */
const BRANCH_PREFIX = 'queue/';
/** Branch a task is built on: `branch` in the queue, otherwise <branchPrefix><id>. */
const branchFor = (o, prefix = BRANCH_PREFIX) => o.branch ?? `${prefix}${o.id}`;

/**
 * The column a card sits in: queue, proposed, batch, inProgress, review, built, or null (cancelled, ended registration).
 * A task in the batch queue (waiting or proposed with batched) sits in `batch`, never as startable or pending.
 */
function columnFor(o) {
  if (L.isExternalRow(o)) return o.status === 'external' ? 'inProgress' : null;
  if (L.inBatchQueue(o)) return 'batch';
  switch (o.status) {
    case 'waiting':
      return 'queue';
    case 'proposed':
      return 'proposed';
    case 'running':
    case 'picked':
      return 'inProgress';
    case 'review':
      return 'review';
    case 'done':
      return 'built';
    default:
      return null;
  }
}

/** Agent slots in use, with the same rule as the queue (counterAsAgent: running and review without picked_by). */
function wip(queue) {
  const tasks = queue.tasks ?? [];
  const g = { ...L.DEFAULT_LIMITS, ...(queue.limits ?? {}) };
  const agents = tasks.filter(L.counterAsAgent);
  return {
    agents: agents.length,
    max: g.maxConcurrent,
    dPlus: agents.filter((o) => o.class === 'D+').length,
    maxDPlus: g.maxDPlus,
    picked: tasks.filter((o) => o.status === 'picked').length,
    external: tasks.filter((o) => L.isExternalRow(o) && o.status === 'external').length,
  };
}

/**
 * Projects in lane order: highest priority_bonus first, otherwise the queue's own order (register, then unknown
 * alphabetically, `without-project` last, via projectOverview). `movable` = is in the register (only then can the bonus
 * be set). The color follows the register's order, not the lane order.
 */
function projectLanes(queue) {
  const rows = L.projectOverview(queue);
  const color = new Map();
  let i = 0;
  for (const r of rows) {
    color.set(
      r.pid,
      r.pid === L.WITHOUT_PROJECT
        ? WITHOUT_PROJECT_COLOR
        : PROJECT_COLORS[i++ % PROJECT_COLORS.length],
    );
  }
  const lanes = rows.map((r, index) => ({
    pid: r.pid,
    title: r.title,
    pause: r.pause,
    priority_bonus: r.priority_bonus,
    movable: r.in_register,
    color: color.get(r.pid),
    index,
  }));
  lanes.sort((a, b) => {
    const ua = a.pid === L.WITHOUT_PROJECT ? 1 : 0;
    const ub = b.pid === L.WITHOUT_PROJECT ? 1 : 0;
    return ua - ub || b.priority_bonus - a.priority_bonus || a.index - b.index;
  });
  return lanes.map(({ index: _i, ...b }) => b);
}

/** The remarks on a task combined: the list `remarks` and the simple fields `remark*`. */
function remarksFor(o) {
  const out = Array.isArray(o.remarks) ? [...o.remarks] : [];
  for (const [k, v] of Object.entries(o)) {
    if (/^remark(_|$)/.test(k) && typeof v === 'string' && v.trim()) out.push(v);
  }
  return out;
}

// ---- The chain around a card --------------------------------------------------------------------------

const isOpen = (o) => !!o && o.status !== 'done' && o.status !== 'cancelled';

/** The lookups the chain needs, made once for the whole board: the successors (queueLogic.childrenMap) and tasks per id. */
function chainMap(tasks) {
  return { children: L.childrenMap(tasks), perId: new Map(tasks.map((o) => [o.id, o])) };
}

/**
 * "Unlocks N": tasks that wait on `id`, directly or transitively through `depends_on`, and that are not finished
 * (queueLogic.successors, same count as the bonus in the priority; cycles are tolerated), and the sum of their estimates.
 * @returns {{ count: number, minutes: number, direct: string[], ids: string[] }}
 */
function unlocksOf(queue, id, map = chainMap(queue.tasks ?? [])) {
  const ids = L.successors(id, queue.tasks ?? [], map.children).sort();
  const direct = [...new Set(map.children.get(id) ?? [])]
    .filter((x) => x !== id && isOpen(map.perId.get(x)))
    .sort();
  const minutes = ids.reduce((sum, x) => sum + L.estimate(map.perId.get(x) ?? {}), 0);
  return { count: ids.length, minutes, direct, ids };
}

/**
 * The chain around a card: the predecessors (transitively through `depends_on`) and the successors (like unlocksOf) that still
 * need doing. Unknown ids and finished tasks are left out (a done predecessor blocks nothing), but the search goes
 * through them. Cycles are tolerated, and the card itself is never included.
 * @returns {{ before: string[], after: string[] }}
 */
function chain(queue, id, map = chainMap(queue.tasks ?? [])) {
  return { before: predecessors(id, map), after: unlocksOf(queue, id, map).ids };
}

/** The predecessors (transitively through `depends_on`) that still need doing, sorted. See chain. */
function predecessors(id, map) {
  const set = new Set();
  const stack = [...(map.perId.get(id)?.depends_on ?? [])];
  while (stack.length) {
    const x = stack.pop();
    if (set.has(x) || x === id) continue;
    set.add(x);
    stack.push(...(map.perId.get(x)?.depends_on ?? []));
  }
  return [...set].filter((x) => isOpen(map.perId.get(x))).sort();
}

/**
 * Aging work: a card in In progress (running) or Review is older than p85 for the class. Running: the time
 * since start against p85 of the work time (start to delivered). Review: the time since start against p85 of the whole cycle (start
 * to done). The bounds are queueStatistics.ageBounds; a class without a limit (too few finished) is not marked.
 * @returns {{ measure: 'work'|'cycle', limit: number, age: number } | null} minutes
 */
function aging(o, ageLimits, now = Date.now()) {
  const measure = o.status === 'running' ? 'work' : o.status === 'review' ? 'cycle' : null;
  const start = Date.parse(o.started ?? o.picked_at ?? '');
  const limit = ageLimits?.[o.class]?.[measure];
  if (!measure || !Number.isFinite(start) || !(limit > 0)) return null;
  const age = Math.round((now - start) / 60_000);
  return age > limit ? { measure, limit, age } : null;
}

/**
 * Board: cards per column, WIP and project lanes, and "Next up" and "Waiting on you".
 * @param {object} queue queue (queue.json)
 * @param {{ now?: number, uncommitted?: string[], branches?: Record<string, { commits: number, lastCommit: string|null }>,
 *   ageLimits?: object, dailyUsage?: number, branchPrefix?: string }} option
 *   `uncommitted`: the paths `git status` shows in the main tree (like `queue.mjs show`). `branches`: commits on <branchPrefix><id> for picked
 *   tasks (for "old"). `ageLimits`: queueStatistics.ageBounds (aging work). `dailyUsage`: USD today
 *   (only when a dailyQuota is set; for "Next up"). `cloud`: { pushedHead, changed, mission(o) → { text, path } }
 *   (<remote>/<baseBranch>, the paths changed locally since then, the mission text) for queueLogic.cloudSuitable on the cards in the queue and in
 *   cloud sessions. Without `cloud` the cards get no suitability.
 */
function board(queue, option = {}) {
  // The lookups for the whole queue (id map, active ones, successors, conflicts) are built once for the board, not per
  // card (queueLogic.withIndex). The board does not change the queue, so the index cannot go stale while it is built.
  const tasks = queue.tasks ?? [];
  return L.withIndex(tasks, () => buildBoard(queue, tasks, option));
}

function buildBoard(
  queue,
  tasks,
  {
    now = Date.now(),
    uncommitted = [],
    branches = {},
    ageLimits = {},
    dailyUsage,
    cloud,
    branchPrefix = BRANCH_PREFIX,
  } = {},
) {
  const register = queue.projects ?? {};
  const lanes = projectLanes(queue);
  const colorFor = new Map(lanes.map((b) => [b.pid, b.color]));
  const map = chainMap(tasks);
  // The groups in the batch queue with sum against the target (queueLogic.batchGroups, same as queue.mjs batch).
  const batchQueue = L.batchGroups(queue);
  // The focus context (stage, dragged along) is computed once for the whole board, as in queue.mjs show.
  const fk = L.rankingContext(queue, now);
  const spaceFor = (o) => {
    const p = L.focusSpace(o, fk);
    return {
      sort: p.stage,
      step: p.step,
      dragged_by: p.dragged_by,
      outside: fk.applies ? p.outside : false,
      out: p.out,
      reason: p.reason,
      nr: null,
      by: null,
    };
  };

  const summary = (o) => {
    const pid = L.projectFor(o, register);
    const waiting = o.status === 'waiting';
    // The blockers as `queue.mjs show` shows them: pause first, otherwise an uncommitted owned file when nothing else stops it.
    let blockers = [];
    if (waiting) {
      blockers = L.blockersWithPause(o, queue, fk);
      const u = blockers.length ? null : L.uncommittedCollision(o, uncommitted);
      if (u) blockers = [`file ${u.path} is uncommitted in the main tree`];
    }
    const start = o.started ?? o.picked_at ?? (L.isExternalRow(o) ? o.added_at : null) ?? null;
    // "old": the queue's 72 h rule for picked ones (isOldPick) and for registrations outside the queue. Running and review
    // are instead marked against p85 for the class (aging).
    let old = false;
    if (o.status === 'picked') {
      old = L.isOldPick(o, branches[branchFor(o, branchPrefix)] ?? {}, now);
    } else if (start && L.isExternalRow(o)) {
      old = now - Date.parse(start) > L.OLD_PICK_MS;
    }
    const agingState = L.isExternalRow(o) ? null : aging(o, ageLimits, now);
    const lockState = unlocksOf(queue, o.id, map);
    const k = { before: predecessors(o.id, map), after: lockState.ids }; // = chain(queue, o.id), without computing twice
    const doneMs = o.done ? Date.parse(o.done) : NaN;
    // Suitable for cloud? Only for cards in the queue and in cloud sessions (the rest cannot be sent there anyway).
    let cloudSuitable = null;
    if (cloud && (waiting || L.isCloud(o))) {
      const up = cloud.mission(o);
      cloudSuitable = L.cloudSuitable(queue, o.id, {
        pushedHead: cloud.pushedHead,
        changed: cloud.changed,
        missionText: up.text,
        ownPath: up.path,
      });
    }
    return {
      id: o.id,
      title: o.title ?? '',
      status: o.status,
      class: o.class ?? null,
      domain: o.domain ?? null,
      estimate: L.estimate(o),
      value: Number(o.value ?? 5),
      project: pid,
      color: colorFor.get(pid) ?? WITHOUT_PROJECT_COLOR,
      feature: typeof o.feature === 'string' && o.feature.trim() ? o.feature.trim() : null,
      // The plan entry the task belongs to, for the marker on the card and the "Plan entry" filter.
      plan: typeof o.plan === 'string' && o.plan ? o.plan : null,
      labels: Array.isArray(o.labels) ? o.labels : [],
      visual: L.hasLabel(o, 'visual'),
      depends_on: o.depends_on ?? [],
      waiting_on: (o.waiting_on ?? []).map((sp) => ({
        sp,
        resolved: (queue.resolved ?? []).includes(sp),
      })),
      owned_files: o.owned_files ?? [],
      owner_db: o.owner_db ?? [],
      remarks: remarksFor(o),
      source: o.source ?? null,
      added_by: o.added_by ?? null,
      priority_bonus: Number(o.priority_bonus ?? 0) || 0,
      branch: branchFor(o, branchPrefix),
      migr_block: o.migr_block ?? null,
      score: waiting ? L.score(o, tasks, now, register) : null,
      // "Placement" in the detail panel: what the points consist of, and the focus step (queueLogic.focusSpace, same
      // source as selectNext). `nr`/`by` (place among the ready ones in the step) are filled in after the sorting below.
      score_parts: waiting ? L.scoreParts(o, tasks, now, register) : null,
      space: waiting ? spaceFor(o) : null,
      area: L.areaFor(o, queue),
      added_at: o.added_at ?? null,
      ready: waiting && blockers.length === 0,
      batched: L.isBatched(o),
      // "on hold" (queueLogic.parkedNow: a parking with a passed date does not count).
      parked:
        o.parked && L.parkedNow(o, now)
          ? { reason: o.parked.reason ?? null, to: o.parked.to ?? null, by: o.parked.by ?? null }
          : null,
      blockers,
      start,
      old,
      aging: agingState,
      // "Unlocks N" and the chain (only when they exist, so the response does not grow for cards without a chain).
      unlocks: lockState.count
        ? { count: lockState.count, minutes: lockState.minutes, direct: lockState.direct }
        : null,
      chain: k.before.length || k.after.length ? k : null,
      picked_by: o.picked_by ?? null,
      external_name: o.external_name ?? null,
      delivered: o.delivered ?? null,
      done: o.done ?? null,
      recent:
        o.status === 'done' &&
        ((Number.isFinite(doneMs) && now - doneMs <= RECENT_MS) || o.qa_status === 'waiting'),
      qa_status: o.qa_status ?? null,
      qa_note: o.qa_note ?? null,
      cloud: cloudSuitable,
      in_cloud: L.isCloud(o),
      cloud_session: o.cloud
        ? {
            started: o.cloud.started ?? null,
            execution: o.cloud.execution ?? null,
            done: o.cloud.done ?? null,
            branch: o.cloud.branch ?? null,
          }
        : null,
    };
  };

  const columns = { queue: [], proposed: [], batch: [], inProgress: [], review: [], built: [] };
  for (const o of tasks) {
    const k = columnFor(o);
    if (k) columns[k].push(summary(o));
  }
  const time = (s) => (s ? Date.parse(s) || 0 : 0);
  // In the queue: ready ones now at the top, both parts by the queue's ranking (queueLogic.ranking: focusStep, then priority, then id, like
  // selectNext). Without focus the step is 0 for all that are not parked, so the order is just priority and id.
  columns.queue.sort(
    (a, b) =>
      Number(b.ready) - Number(a.ready) ||
      a.space.sort - b.space.sort ||
      b.score - a.score ||
      a.id.localeCompare(b.id),
  );
  // "no. 4 of 38 ready ones in the step" (Placement): the place among the ready ones with the same stage.
  const readyPerStep = new Map();
  for (const k of columns.queue) {
    if (!k.ready) continue;
    const key = k.space.step ?? 'rest';
    if (!readyPerStep.has(key)) readyPerStep.set(key, []);
    readyPerStep.get(key).push(k);
  }
  for (const list of readyPerStep.values())
    list.forEach((k, i) => {
      k.space.nr = i + 1;
      k.space.by = list.length;
    });
  columns.proposed.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  // The batch queue's order is the groups' order (batchGroups: project → class, feature, id).
  const batchSequence = new Map(
    batchQueue.flatMap((g) => g.tasks.map((x) => x.id)).map((id, i) => [id, i]),
  );
  columns.batch.sort((a, b) => (batchSequence.get(a.id) ?? 0) - (batchSequence.get(b.id) ?? 0));
  columns.inProgress.sort((a, b) => time(a.start) - time(b.start) || a.id.localeCompare(b.id));
  columns.review.sort((a, b) => time(a.delivered) - time(b.delivered) || a.id.localeCompare(b.id));
  columns.built.sort((a, b) => time(b.done) - time(a.done) || a.id.localeCompare(b.id));
  const next = nextUp(queue, { now, uncommitted, dailyUsage });

  return {
    wip: wip(queue),
    limits: { ...L.DEFAULT_LIMITS, ...(queue.limits ?? {}) },
    // The night pause is shown in the In progress header when it stops new ones from starting now.
    night: L.nightGuard(queue, now),
    projects: lanes,
    columns,
    // The groups (pid, class, measure, sum, ready, over, tasks …); the cards sit in columns.batch.
    batchQueue,
    // What the queue would start now, and what is waiting on the owner.
    next,
    inbox: inbox(queue, columns, { map, context: fk }),
    // The focus line, areas and the basis for the plan view.
    focus: focusLine(queue, { now, context: fk, canStart: next.startable.map((v) => v.id) }),
    areas: L.areaOverview(queue, now).map((r) => ({
      oid: r.oid,
      title: r.title,
      description: r.description,
      in_register: r.in_register,
      projects: r.projects,
    })),
    plan: planBasis(queue, { now, context: fk }),
    // The queue's version (the board sends it back as --expect-changed) and the last entry in the changelog
    // that can be undone ("Undo last").
    changed: queue.changed ?? null,
    undo: undoSummary(queue),
  };
}

/** The last entry in the changelog that is not undone, in short (for "Undo last"), or null. */
function undoSummary(queue) {
  const p = L.lastUndoable(queue);
  if (!p) return null;
  const ids = new Set((p.changes ?? []).filter((e) => e.id).map((e) => e.id));
  return {
    nr: p.nr,
    action: p.action,
    by: p.by,
    at: p.at,
    field: (p.changes ?? []).length,
    tasks: ids.size,
  };
}

/**
 * "Next up": what the queue would start now, with queueLogic.startGuard (dailyQuota, nightPause) and
 * queueLogic.selectNext (limits, pause, blockers, uncommitted files) directly, never an own copy. If there are available
 * slots, `startable` is what selectNext starts now (at most as many as are available). If the slots are full, `whenAvailable` is the
 * NEXT_WHEN_FULL next ones (selectNext with that many more slots). If the queue stops, the reason is in `stop` and `text`.
 * @returns {{ stop: null|'dailyBudget'|'nightPause'|'maxConcurrent', text: string|null, message: string|null,
 *   available: number, startable: object[], whenAvailable: object[] }}
 */
function nextUp(queue, { now = Date.now(), uncommitted = [], dailyUsage } = {}) {
  const use = L.spaceUse(queue);
  const g = use.limits;
  const available = Math.max(0, use.available);
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const withTitle = (list) => list.map((v) => ({ ...v, title: perId.get(v.id)?.title ?? '' }));
  const empty = { available, startable: [], whenAvailable: [] };
  const guard = L.startGuard(queue, dailyUsage, { now });
  if (guard?.stop === 'dailyBudget')
    return {
      ...empty,
      stop: guard.stop,
      text: 'The daily quota is used up: no new ones start today.',
      message: guard.message,
    };
  if (guard?.stop === 'nightPause')
    return {
      ...empty,
      stop: guard.stop,
      text: `Night pause until ${L.nightGuard(queue, now).to}: no new ones start.`,
      message: guard.message,
    };
  if (!(Number(g.maxConcurrent) > 0))
    return {
      ...empty,
      stop: 'maxConcurrent',
      text: 'Concurrent tracks are set to 0: the queue starts nothing.',
      message: 'Set concurrent tracks above 0 in the settings (the gear) to start the queue again.',
    };
  if (available > 0)
    return {
      ...empty,
      stop: null,
      text: null,
      message: null,
      startable: withTitle(L.selectNext(queue, now, { uncommitted })),
    };
  const moreSpace = { ...queue, limits: { ...g, maxConcurrent: use.agents + NEXT_WHEN_FULL } };
  return {
    ...empty,
    stop: null,
    text: null,
    message: null,
    whenAvailable: withTitle(L.selectNext(moreSpace, now, { uncommitted })),
  };
}

/**
 * "Waiting on you": what is waiting on the owner, in four parts.
 *   - question: open owner questions (not resolved) that a pending task waits on, or that are registered in
 *     `question`. Sorted by how much the answer unlocks: tasks that wait directly plus their successors
 *     (queueLogic.successors), and the sum of the estimates.
 *   - qa: finished with `qa_status: waiting` grouped project → feature (queueLogic.qaList).
 *   - proposed: tasks that must be approved.
 *   - stuck: running and review over p85 for the class, and picked ones that are old (the 72 h rule).
 * `unlogged` (answers not entered in the decision log) is info for the orchestrator and is not counted in `count`.
 * @param {object} columns the board's columns (the cards have aging and old)
 */
function inbox(queue, columns, { map = chainMap(queue.tasks ?? []), context = null } = {}) {
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const resolved = new Set(queue.resolved ?? []);
  // With focus the questions are sorted by what the answer unlocks IN FOCUS (stage 1 first), not in the whole queue.
  const fk = context ?? L.rankingContext(queue);
  const countStep = fk.applies ? (queue.focus?.order?.length ?? 0) : 0;
  const direct = new Map();
  for (const o of tasks) {
    if (o.status !== 'waiting') continue;
    for (const sp of o.waiting_on ?? []) {
      if (resolved.has(sp)) continue;
      if (!direct.has(sp)) direct.set(sp, new Set());
      direct.get(sp).add(o.id);
    }
  }
  for (const sp of Object.keys(queue.question ?? {}))
    if (!resolved.has(sp) && !direct.has(sp)) direct.set(sp, new Set());
  const question = [...direct.entries()]
    .map(([sp, ids]) => {
      const all = new Set(ids);
      for (const id of ids) for (const x of L.successors(id, tasks, map.children)) all.add(x);
      const q = queue.question?.[sp];
      return {
        sp,
        type: q?.type ?? 'question',
        text: q?.text ?? null,
        recommendation: q?.recommendation ?? null,
        source: q?.source ?? null,
        direct: [...ids].sort(),
        count: all.size,
        minutes: [...all].reduce((sum, x) => sum + L.estimate(map.perId.get(x) ?? {}), 0),
        projects: [...new Set([...ids].map((x) => L.projectFor(map.perId.get(x), register)))],
        focus: countStep ? inFocus(all) : null,
      };
    })
    .sort(
      (a, b) =>
        focusCompare(a.focus, b.focus) ||
        b.count - a.count ||
        b.minutes - a.minutes ||
        a.sp.localeCompare(b.sp),
    );
  /** What the answer unlocks in focus: minutes and count per stage (pending, not parked), and the sum. */
  function inFocus(ids) {
    const min = Array(countStep).fill(0);
    let count = 0;
    for (const x of ids) {
      const o = map.perId.get(x);
      if (!o || o.status !== 'waiting') continue;
      const p = L.focusSpace(o, fk);
      if (p.step == null || p.parked) continue;
      min[p.step] += L.estimate(o);
      count += 1;
    }
    return { per_step: min, count, minutes: min.reduce((s, m) => s + m, 0) };
  }

  const qa = L.qaList(queue).map((p) => ({
    pid: p.pid,
    title: p.title,
    features: p.features.map((f) => ({
      feature: f.feature,
      tasks: f.tasks.map((o) => ({
        id: o.id,
        title: o.title ?? '',
        done: o.done ?? null,
      })),
    })),
  }));
  const qaCount = qa.reduce(
    (n, p) => n + p.features.reduce((m, f) => m + f.tasks.length, 0),
    0,
  );

  const proposed = (columns.proposed ?? []).map((k) => ({
    id: k.id,
    title: k.title,
    class: k.class,
    estimate: k.estimate,
    value: k.value,
    added_by: k.added_by,
  }));

  const stuck = [...(columns.inProgress ?? []), ...(columns.review ?? [])]
    .filter((k) => k.aging || (k.status === 'picked' && k.old))
    .map((k) => ({
      id: k.id,
      title: k.title,
      status: k.status,
      class: k.class,
      start: k.start,
      picked_by: k.picked_by,
      aging: k.aging,
    }));

  const unlogged = L.unlogged(queue).map((x) => ({ sp: x.sp, time: x.time ?? null, by: x.by ?? null }));
  const sort = sortList(queue);
  return {
    // "Sort" is not counted in count: it is cleanup, not something that stops the queue (and without a project register everything
    // would end up there).
    count: question.length + qaCount + proposed.length + stuck.length,
    // True when the questions are sorted by what they unlock in focus.
    focus_sorted: countStep > 0,
    question,
    sort,
    qa,
    qaCount,
    proposed,
    stuck,
    unlogged: unlogged,
  };
}

// ---- Focus, plan view, "Sort" and areas ----------------------------------------------------------
// The rules (stage, dragged
// along, parking, classification) live in queueLogic; here is only what the board shows and the previews before writing.

/**
 * Compares two questions by what the answer unlocks in focus: most minutes in stage 1, then stage 2 etc. (stage 1
 * weighs most), then most tasks in focus. Without focus (null) all are equal.
 */
function focusCompare(a, b) {
  if (!a || !b) return 0;
  for (let i = 0; i < Math.max(a.per_step.length, b.per_step.length); i += 1) {
    const d = (b.per_step[i] ?? 0) - (a.per_step[i] ?? 0);
    if (d) return d;
  }
  return b.count - a.count;
}

/** The statuses the "Sort" list shows (the same ones that can be bulk edited: waiting and proposed). */
const SORT_STATUSES = new Set(['waiting', 'proposed']);

/**
 * The suggestions "Accept proposed" uses: id → project (queueLogic.classifyQueue: move, sort with proposed, and disagree with
 * counterProposal), only for tasks that are waiting or proposed.
 * @returns {Map<string, string>}
 */
function sortSuggestion(queue) {
  const out = new Map();
  for (const r of sortList(queue)) if (r.proposed) out.set(r.id, r.proposed);
  return out;
}

/**
 * The "Sort" list: tasks without a project, with an uncertain proposal, or where the project conflicts with strong
 * signals (queueLogic.classifyQueue). Only waiting and proposed, sorted by type (disagree, move, sort) and id.
 * @returns {{ id: string, title: string|null, status: string, now: string, proposed: string|null, type: string,
 *   reason: string }[]}
 */
function sortList(queue) {
  // Without a project register there is nothing to sort by.
  if (!Object.keys(queue.projects ?? {}).length) return [];
  const k = L.classifyQueue(queue);
  const orderState = { disagree: 0, move: 1, sort: 2 };
  return [...k.move, ...k.sort]
    .filter((r) => SORT_STATUSES.has(r.status))
    .map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      now: r.now,
      proposed: r.proposed,
      type: r.type,
      reason: r.reason,
    }))
    .sort((a, b) => orderState[a.type] - orderState[b.type] || a.id.localeCompare(b.id));
}

/**
 * The focus line at the top of the board and the columns "Now" and "Next" in the plan view: queueLogic.focusStatus plus
 * the steps with title and type, and the split between Now (the first `now_count` steps, default 1) and Next.
 * null when no focus is set.
 */
function focusLine(queue, { now = Date.now(), context = null, canStart = [] } = {}) {
  const st = L.focusStatus(queue, { now, canStart, context });
  if (!st) return null;
  const f = queue.focus;
  const sequence = st.order;
  const n = Math.min(Math.max(Number(f.now_count) || 1, 1), Math.max(sequence.length, 1));
  return {
    ...st,
    from: f.from ?? null,
    set_by: f.set_by ?? null,
    drag_with: f.drag_with_dependencies !== false,
    now_count: n,
    stage: sequence.map((t, i) => ({
      stage: t,
      type: String(t).slice(0, String(t).indexOf(':')),
      title: L.stepTitle(t, queue),
      waiting: st.per_step[i]?.waiting ?? 0,
      readyOnes: st.per_step[i]?.readyOnes ?? 0,
      min_left: st.per_step[i]?.min_left ?? 0,
    })),
    now: sequence.slice(0, n),
    next: sequence.slice(n),
  };
}

/**
 * The basis for the plan view: per area and project (and feature in the project) pending tasks, ready ones
 * (no blockers apart from focus and pause, i.e. ready if they came into focus), parked, minutes left, open
 * owner questions and how many are dragged along in focus. Batch queue and proposed are not counted (they do not start alone).
 * The areas in the register's order (queueLogic.areaOverview), `without-area` last.
 */
function planBasis(queue, { now = Date.now(), context = null } = {}) {
  const fk = context ?? L.rankingContext(queue, now);
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const empty = () => ({
    waiting: 0,
    readyOnes: 0,
    parked: 0,
    activeOnes: 0,
    min_left: 0,
    sp: new Set(),
    dragged: 0,
  });
  const perProject = new Map();
  const perFeature = new Map();
  const countRow = (r, o) => {
    if (['running', 'review', 'picked'].includes(o.status)) {
      r.activeOnes += 1;
      return;
    }
    r.waiting += 1;
    r.min_left += L.estimate(o);
    if (L.parkedNow(o, now)) r.parked += 1;
    else if (L.blockers(o, tasks, queue.resolved).length === 0) r.readyOnes += 1;
    for (const s of L.openQuestion(o, queue.resolved)) r.sp.add(s);
    if (fk.dragged.has(o.id)) r.dragged += 1;
  };
  for (const o of tasks) {
    if (L.isExternalRow(o)) continue;
    const active = ['running', 'review', 'picked'].includes(o.status);
    if (!active && (o.status !== 'waiting' || L.isBatched(o))) continue;
    const pid = L.projectFor(o, register);
    if (!perProject.has(pid)) perProject.set(pid, empty());
    countRow(perProject.get(pid), o);
    if (active) continue;
    const name = typeof o.feature === 'string' && o.feature.trim() ? o.feature.trim() : null;
    if (!name) continue;
    const key = `${pid}/${name}`;
    if (!perFeature.has(key)) perFeature.set(key, { pid, name, ...empty() });
    countRow(perFeature.get(key), o);
  }
  const out = (r) => ({
    waiting: r.waiting,
    readyOnes: r.readyOnes,
    parked: r.parked,
    activeOnes: r.activeOnes,
    min_left: r.min_left,
    question: r.sp.size,
    dragged: r.dragged,
  });
  const projects = L.projectOverview(queue).map((p) => {
    const r = perProject.get(p.pid) ?? empty();
    return {
      pid: p.pid,
      title: p.title ?? null,
      area: L.areaFor({ project: p.pid }, queue),
      pause: p.pause === true,
      movable: p.in_register === true,
      ...out(r),
      features: [...perFeature.values()]
        .filter((f) => f.pid === p.pid)
        .sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name, 'en'))
        .map((f) => ({ name: f.name, stage: `feature:${p.pid}/${f.name}`, ...out(f) })),
    };
  });
  const areas = L.areaOverview(queue, now).map((o) => {
    const mine = projects.filter((p) => p.area === o.oid);
    const sp = new Set();
    for (const p of mine)
      for (const x of tasks)
        if (
          x.status === 'waiting' &&
          !L.isBatched(x) &&
          !L.isExternalRow(x) &&
          L.projectFor(x, register) === p.pid
        )
          for (const s of L.openQuestion(x, queue.resolved)) sp.add(s);
    const sum = (field) => mine.reduce((s, p) => s + p[field], 0);
    return {
      oid: o.oid,
      title: o.title,
      in_register: o.in_register,
      projects: mine.map((p) => p.pid),
      waiting: sum('waiting'),
      readyOnes: sum('readyOnes'),
      parked: sum('parked'),
      activeOnes: sum('activeOnes'),
      min_left: sum('min_left'),
      question: sp.size,
      dragged: sum('dragged'),
    };
  });
  return { areas, projects };
}

/** "3 h 20 min" / "45 min" (the previews). */
function minutesText(min) {
  const m = Math.round(Number(min) || 0);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/**
 * The preview of "Save focus" from the plan view (POST /api/focus with dry): queueLogic.saveFocusPlan on a copy
 * of the queue (same rules as `queue.mjs focus save`), and what it gives: focus before and after, the steps with numbers, what
 * happens to the rest, how many are dragged along, the pause changes and "Next up" after saving. Writes nothing.
 * @param {object} input { order, now_count?, rest?, to?, name?, drag_with_dependencies?, pause?, continue? }
 * @returns {{ error: string[], warnings: string[], lines: string[], before_text: string, after_text: string,
 *   next: { id: string, title: string }[], next_text: string|null }}
 */
function focusPreview(queue, input, { now = Date.now(), uncommitted = [] } = {}) {
  const copy = L.cloneJson(queue);
  const r = L.saveFocusPlan(copy, input, new Date(now).toISOString());
  const beforeText = queue.focus ? L.focusText(queue) : 'no focus';
  if (r.error.length)
    return {
      error: r.error,
      warnings: r.warnings ?? [],
      lines: [],
      before_text: beforeText,
      after_text: beforeText,
      next: [],
      next_text: null,
    };
  const lines = [];
  const k = L.rankingContext(copy, now);
  const st = L.focusStatus(copy, { now, context: k });
  if (!copy.focus) {
    lines.push(
      r.removed
        ? 'Focus is removed: the queue goes by score and projectBonus, as before focus existed.'
        : 'No focus: the queue goes by score and projectBonus.',
    );
  } else {
    const parts = focusLine(copy, { now, context: k });
    parts.stage.forEach((t, i) =>
      lines.push(
        `${i < parts.now_count ? 'Now' : 'Next'}, stage ${i + 1}: ${t.title} (${t.type}): ` +
          `${t.waiting} waiting, ${t.readyOnes} ready, ${minutesText(t.min_left)} left.`,
      ),
    );
    let outside = 0;
    for (const o of copy.tasks ?? []) {
      if (o.status !== 'waiting' || L.isBatched(o) || L.isExternalRow(o)) continue;
      const p = L.focusSpace(o, k);
      if (p.outside && !p.parked) outside += 1;
    }
    lines.push(
      copy.focus.rest === 'fill'
        ? `Rest (${outside} pending outside the steps) fills available slots only when focus has nothing ready.`
        : `Rest (${outside} pending outside the steps) waits fully: they do not start until focus changes.`,
    );
    if (copy.focus.drag_with_dependencies !== false)
      lines.push(
        st.dragged_with
          ? `${st.dragged_with} task(s) outside the steps dragged along, because something in focus waits on them.`
          : 'No tasks outside the steps are needed by focus now.',
      );
    else lines.push('Dependencies are not dragged along: focus can get stuck on something outside the steps.');
    lines.push(
      copy.focus.to
        ? `Focus applies up to and including ${String(copy.focus.to).slice(0, 10)}; after that you get a notice.`
        : 'Focus applies until you change it.',
    );
  }
  if (r.paused.length)
    lines.push(
      `Paused: ${r.paused.join(', ')} (not started, not even if they are in a stage).`,
    );
  if (r.still.length) lines.push(`Unpaused: ${r.still.join(', ')}.`);
  const n = nextUp(copy, { now, uncommitted });
  const list = n.startable.length ? n.startable : n.whenAvailable;
  return {
    error: [],
    warnings: r.warnings,
    lines,
    before_text: beforeText,
    after_text: copy.focus ? L.focusText(copy) : 'no focus',
    next: list.map((v) => ({ id: v.id, title: v.title })),
    next_text: n.stop
      ? n.text
      : n.startable.length
        ? `Starts now (${n.available} available slots):`
        : n.whenAvailable.length
          ? 'Next when a slot becomes available:'
          : 'Nothing can be started with this focus now.',
  };
}

/** The actions POST /api/area can perform. */
const AREA_ACTIONS = ['save', 'delete', 'move'];

/**
 * The areas from the board (POST /api/area): translates the action into the `queue.mjs area` arguments, tries it on a copy
 * (queueLogic.setArea, same rules) and explains what changes. Writes nothing.
 *   save { oid, title, description? }   create or edit title/description
 *   delete { oid }                          delete (denied when a project or focus uses the area)
 *   move { pid, oid|null }                move the project to the area (null = out of the area it is in)
 * @returns {{ error: string[], args?: string[], lines?: string[] }}
 */
function areaPlan(queue, b = {}) {
  const action = String(b.action ?? '');
  if (!AREA_ACTIONS.includes(action)) return { error: [`unknown action ${action}`] };
  const copy = L.cloneJson(queue);
  const register = queue.projects ?? {};
  const focusStep = (oid) => {
    const i = (queue.focus?.order ?? []).indexOf(`area:${oid}`);
    return i < 0 ? null : i + 1;
  };
  if (action === 'move') {
    const pid = String(b.pid ?? '');
    if (!Object.hasOwn(register, pid)) return { error: [`unknown project ${pid}`] };
    const from = register[pid]?.area ?? null;
    const to = b.oid == null || b.oid === '' ? null : String(b.oid);
    if (from === to) return { error: [`${pid} is already ${to ? `in ${to}` : 'without area'}`] };
    const args = to ? ['area', to, '--projects', pid] : ['area', from, '--remove', pid];
    const s = to
      ? L.setArea(copy, to, { projects: [pid] })
      : L.setArea(copy, from, { remove: [pid] });
    if (s.error.length) return { error: s.error };
    const lines = [
      `The project ${pid} moves from ${from ?? 'without area'} to ${to ?? 'without area'}.`,
    ];
    const tf = from ? focusStep(from) : null;
    const tt = to ? focusStep(to) : null;
    if (tf || tt)
      lines.push(
        `Tasks in ${pid} follow the area: from ${tf ? `stage ${tf}` : 'outside focus'} to ` +
          `${tt ? `stage ${tt}` : 'outside focus'} (unless the project has its own stage).`,
      );
    return { error: [], args, lines };
  }
  const oid = String(b.oid ?? '');
  if (action === 'delete') {
    const s = L.setArea(copy, oid, { delete: true });
    if (s.error.length) return { error: s.error };
    return {
      error: [],
      args: ['area', oid, '--delete'],
      lines: [`Area ${oid} is deleted. No projects or stages use it.`],
    };
  }
  const field = { title: b.title == null ? null : String(b.title) };
  if (b.description != null) field.description = String(b.description) || null;
  const exists = Object.hasOwn(queue.areas ?? {}, oid);
  const s = L.setArea(copy, oid, field);
  if (s.error.length) return { error: s.error };
  const args = ['area', oid, '--title', s.area.title];
  if ('description' in field) args.push('--description', field.description ?? '');
  return {
    error: [],
    args,
    lines: [
      exists
        ? `Area ${oid} gets the title "${s.area.title}".`
        : `New area ${oid} "${s.area.title}". Move projects into it afterwards.`,
    ],
  };
}

/**
 * New `priority_bonus` for a card in the queue that the owner has moved. The landing spot is midway between the neighbors'
 * effective priority (queueLogic.score, with their own bonus and the project's bonus). The card's bonus is REPLACED:
 * the bonus = the target − the card's priority without its own bonus. Top/bottom: one STEP past the neighbor. `top`: above the
 * highest in the whole queue. The priority has two decimals; if the neighbors are closer than 0.02, the card can tie with one
 * of them (equal priority is ordered by id, as in the queue).
 * @param {{ over?: string|null, under?: string|null, top?: boolean }} space the neighbor above and below after the move
 * @returns {{ bonus: number } | { error: string }}
 */
function newBonus(queue, id, { over = null, under = null, top = false } = {}, now = Date.now()) {
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const o = tasks.find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (o.status !== 'waiting')
    return { error: `only tasks in the queue can be moved (${id} has status ${o.status})` };
  const eff = (x) => L.score(x, tasks, now, register);
  const without = L.score({ ...o, priority_bonus: 0 }, tasks, now, register);
  const neighbor = (nid) => {
    if (nid == null) return { o: null };
    const n = tasks.find((x) => x.id === nid);
    if (!n) return { error: `unknown neighbor ${nid}` };
    if (n.id === id) return { error: `${id} cannot be its own neighbor` };
    if (n.status !== 'waiting') return { error: `the neighbor ${nid} is not in the queue (status ${n.status})` };
    return { o: n };
  };
  let measure;
  if (top) {
    const others = tasks.filter((x) => x.status === 'waiting' && x.id !== id);
    if (!others.length) return { bonus: Number(o.priority_bonus ?? 0) || 0 };
    measure = Math.max(...others.map(eff)) + STEP;
  } else {
    const a = neighbor(over);
    if (a.error) return { error: a.error };
    const b = neighbor(under);
    if (b.error) return { error: b.error };
    if (!a.o && !b.o) return { error: 'the move is missing neighbors (over or under)' };
    if (a.o && b.o) measure = (eff(a.o) + eff(b.o)) / 2;
    else if (a.o) measure = eff(a.o) - STEP;
    else measure = eff(b.o) + STEP;
  }
  return { bonus: round2(measure - without) };
}

/**
 * New `priority_bonus` for projects when the owner drags a project lane. `lanes` are the movable lanes in
 * the order the board shows them (projectLanes, without `without-project`). Only the moved lane changes when there is room
 * (integer midway between the neighbors). If the neighbors are equal (or 1 apart), the smaller side is shifted by STEP, so
 * the other projects keep their order among themselves. Top/bottom: one STEP past the neighbor.
 * @param {{ pid: string, priority_bonus: number }[]} lanes
 * @param {{ over?: string|null, under?: string|null }} space the neighbor lane above and below after the move
 * @returns {{ changes: Record<string, number> } | { error: string }}
 */
function laneBonus(lanes, pid, { over = null, under = null } = {}) {
  const t = (b) => Number(b.priority_bonus) || 0;
  if (!lanes.some((b) => b.pid === pid)) return { error: `unknown or locked project lane ${pid}` };
  const others = lanes.filter((b) => b.pid !== pid);
  for (const n of [over, under]) {
    if (n != null && !others.some((b) => b.pid === n)) return { error: `unknown neighbor lane ${n}` };
  }
  if (over == null && under == null) return { error: 'the move is missing neighbors (over or under)' };
  // The place in the list without the moved lane: right before `under`, otherwise right after `over`.
  const idx =
    under != null
      ? others.findIndex((b) => b.pid === under)
      : others.findIndex((b) => b.pid === over) + 1;
  const A = others[idx - 1];
  const B = others[idx];
  const changes = {};
  if (!A) changes[pid] = t(B) + STEP;
  else if (!B) changes[pid] = t(A) - STEP;
  else if (t(A) - t(B) >= 2) changes[pid] = Math.round((t(A) + t(B)) / 2);
  else if (idx <= others.length - idx) {
    // Fewer lanes above: raise them (and A) one STEP; the moved one lands midway between.
    for (const b of others.slice(0, idx)) changes[b.pid] = t(b) + STEP;
    changes[pid] = t(B) + STEP / 2;
  } else {
    // Fewer lanes below: lower them (and B) one STEP.
    for (const b of others.slice(idx)) changes[b.pid] = t(b) - STEP;
    changes[pid] = t(A) - STEP / 2;
  }
  return { changes };
}

/**
 * "Boost dependencies too": the card `id` is moved as in newBonus, and the open dependencies that sit
 * in the queue BELOW the new place are put right above the card (between the card and the neighbor above, in their current order).
 * A dependency that already sits above is not touched (raise, never lower). The server writes everything in one edit-many call.
 * @param {{ over?: string|null, under?: string|null, top?: boolean }} space
 * @returns {{ changes: Record<string, number> } | { error: string }}
 */
function boostBonus(queue, id, space = {}, now = Date.now()) {
  const r = newBonus(queue, id, space, now);
  if (r.error) return r;
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const perId = new Map(tasks.map((x) => [x.id, x]));
  const eff = (x) => L.score(x, tasks, now, register);
  const without = (x) => L.score({ ...x, priority_bonus: 0 }, tasks, now, register);
  const o = perId.get(id);
  const sX = without(o) + r.bonus;
  const over = !space.top && space.over ? perId.get(space.over) : null;
  const sOver = over ? eff(over) : null;
  const deps = L.blockerParts(o, tasks, queue.resolved)
    .filter((h) => h.type === 'depends_on' && perId.get(h.id)?.status === 'waiting')
    .map((h) => perId.get(h.id))
    .filter((d) => eff(d) <= sX)
    .sort((a, b) => eff(b) - eff(a) || a.id.localeCompare(b.id));
  const changes = { [id]: r.bonus };
  const n = deps.length;
  deps.forEach((d, i) => {
    // Evenly spread between the card and the neighbor above; without a neighbor above: within one STEP above the card.
    const room = sOver != null ? sOver - sX : STEP;
    changes[d.id] = round2(sX + (room * (n - i)) / (n + 1) - without(d));
  });
  return { changes };
}

// ---- Guard rules --------------------------------------------------------------------------------------

/** Saver mode: the recommendation in the settings panel and the limit for rule 10. */
const SAVER_MODE = { maxConcurrent: 5, maxDPlus: 2 };

/** "A", "A and B", "A, B and C". */
function andList(xs) {
  const l = [...xs];
  return l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
}
const usdText = (x) => `${Number(x ?? 0).toFixed(2)} USD`;

/**
 * Simple notices before a move or action on the board causes problems. The blockers come from queueLogic
 * (blockerParts, projectPaused, spaceUse, parseLimit), never from an own copy. queue.mjs is still the truth and
 * itself denies what it denies; these are only advance notices.
 *   stop    → the server answers 422 and does nothing,
 *   warning → the server answers 409 until the call sends `confirm: true`,
 *   info     → the action is performed, and the texts are shown afterwards.
 * @param {object} queue queue
 * @param {{ type: string, id?: string, pid?: string, over?: string|null, under?: string|null, top?: boolean,
 *   text?: string, name?: string, val?: string }} action
 * @param {{ now?: number, usageToday?: number, branches?: Record<string, { commits: number }>,
 *   orchestrator?: { active: boolean } }} [context]
 * @returns {{ level: 'info'|'warning'|'stop', text: string, proposed?: { text: string, field: object } }[]}
 */
function assess(queue, action = {}, context = {}) {
  const now = context.now ?? Date.now();
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const out = [];
  const add = (level, text, proposed) =>
    out.push(proposed ? { level, text, proposed } : { level, text });
  const find = (id) => tasks.find((x) => x.id === id);

  if (action.type === 'move') {
    const o = find(action.id);
    if (!o || o.status !== 'waiting') return out;
    // The rules apply when the card moves AHEAD in the queue (higher priority); down or in the same place warns of nothing.
    const r = newBonus(queue, o.id, action, now);
    if (r.error || r.bonus <= (Number(o.priority_bonus ?? 0) || 0)) return out;
    const parts = L.blockerParts(o, tasks, queue.resolved);
    // 1. Dependency not done.
    const deps = parts.filter((h) => h.type === 'depends_on').map((h) => h.id);
    if (deps.length) {
      const l = boostBonus(queue, o.id, action, now);
      const canBeBoosted = !!l.changes && Object.keys(l.changes).length > 1;
      add(
        'warning',
        `${o.id} cannot start before ${andList(deps)} ${deps.length > 1 ? 'are finished' : 'is done'}.`,
        canBeBoosted ? { text: 'Boost dependencies too', field: { boost: true } } : undefined,
      );
    }
    // 2. Waiting on an owner question.
    const sp = parts.filter((h) => h.type === 'question').map((h) => h.sp);
    if (sp.length) add('warning', `${o.id} is waiting on your answer to ${andList(sp)}.`);
    // 3. Owned file (or DB feature, shared patch) is shared with something in progress.
    const set = new Set();
    for (const h of parts.filter((x) => x.type === 'conflict')) {
      const k = h.conflict;
      if (set.has(k.with)) continue;
      set.add(k.with);
      const what =
        k.type === 'file'
          ? `the file ${k.name}`
          : k.type === 'db'
            ? `DB feature ${k.name}`
            : `the shared patch ${k.name}`;
      add('info', `${o.id} shares ${what} with ${k.with} and starts only when ${k.with} is done.`);
    }
    // 4. The project is paused.
    if (L.projectPaused(o, register))
      add(
        'info',
        `The project ${L.projectFor(o, register)} is paused: the move takes effect only when the project continues.`,
      );
    // 5. Limit reached (the D+ slots or tracks with migrations).
    const use = L.spaceUse(queue);
    if (o.class === 'D+' && use.dPlus >= use.limits.maxDPlus)
      add(
        'info',
        `The D+ slots are full (${use.dPlus} of ${use.limits.maxDPlus}): ${o.id} starts when a slot becomes available.`,
      );
    if (L.hasMigr(o) && use.db >= use.limits.maxDb)
      add(
        'info',
        `The limit for tracks with migrations is reached (${use.db} of ${use.limits.maxDb}): ${o.id} starts when a slot becomes available.`,
      );
    return out;
  }

  if (action.type === 'pause') {
    // 6. Pause a project with something in progress.
    const n = tasks.filter(
      (o) =>
        !L.isExternalRow(o) &&
        (o.status === 'running' || o.status === 'picked') &&
        L.projectFor(o, register) === action.pid,
    ).length;
    if (n)
      add('warning', `${n} in progress in ${action.pid} and will run to completion; the pause only stops new ones.`);
    return out;
  }

  if (action.type === 'release') {
    // 7. Release with commits on the branch.
    const o = find(action.id);
    if (!o) return out;
    const branch = branchFor(o, context.branchPrefix ?? BRANCH_PREFIX);
    const n = Number(context.branches?.[branch]?.commits ?? 0);
    if (n > 0)
      add(
        'warning',
        `Branch ${branch} has ${n} ${n === 1 ? 'commit' : 'commits'} that will be left behind.`,
      );
    return out;
  }

  if (action.type === 'pick') {
    // 8. Pick: the orchestrator merges, and a task with migrations gets a migration block.
    const o = find(action.id);
    if (!o) return out;
    if (context.orchestrator?.active)
      add(
        'info',
        `An orchestrator is active: deliver when you are done (cq deliver ${o.id}), then the orchestrator merges.`,
      );
    if (L.hasMigr(o))
      add(
        'info',
        `${o.id} has migrations and gets a migration block (${Number(o.migr_tens)} tens) when it is picked.`,
      );
    return out;
  }

  if (action.type === 'qa-deviation') {
    // 9. QA deviation without text.
    if (!String(action.text ?? '').trim())
      add('stop', 'Write what is wrong, and where, before you report a QA deviation.');
    return out;
  }

  if (action.type === 'resolve') {
    // 15. Answer to an owner question without text: tracks build on the answer, so an empty answer stops.
    if (!String(action.text ?? '').trim()) {
      const type = queue.question?.[action.sp]?.type;
      add(
        'stop',
        type === 'condition' || type === 'lawyer'
          ? 'Write how the condition is fulfilled before you mark it fulfilled.'
          : 'Write the answer before you resolve: waiting tracks build on it.',
      );
    }
    return out;
  }

  if (action.type === 'bulk') {
    // 16. Bulk actions from the selection bar, see assessBulk.
    assessBulk(queue, { ...action, now }, add);
    return out;
  }

  if (action.type === 'limit') {
    const g = { ...L.DEFAULT_LIMITS, ...(queue.limits ?? {}) };
    const t = L.parseLimit(action.name, action.val, g);
    // An invalid value is not flagged here: queue.mjs denies with its own message, which the panel shows.
    if ('error' in t) return out;
    const { name } = action;
    const v = t.val;
    // 10. Over saverMode.
    if (
      (name === 'maxConcurrent' && v > SAVER_MODE.maxConcurrent) ||
      (name === 'maxDPlus' && v > SAVER_MODE.maxDPlus)
    )
      add(
        'warning',
        `Above the recommended limit (at most ${SAVER_MODE.maxConcurrent} concurrent and ${SAVER_MODE.maxDPlus} D+): the quota is used faster.`,
      );
    // 11. maxDb is raised.
    if (name === 'maxDb' && v > Number(g.maxDb))
      add(
        'warning',
        'More tracks with migrations concurrently: the database and the connection pool must handle parallel dry runs.',
      );
    // 12. maxConcurrent = 0.
    if (name === 'maxConcurrent' && v === 0)
      add('warning', 'With 0 concurrent the queue stops: no new tasks are started.');
    // 13. The daily quota below today's usage.
    const usage = Number(context.usageToday ?? 0);
    if (name === 'dailyBudget' && v != null && usage >= v)
      add(
        'warning',
        `The daily quota (${usdText(v)}) is already used up today (${usdText(usage)}): the queue stops new tasks right away.`,
      );
    // 14. Night run off while something is running.
    if (name === 'nightRun' && v === false) {
      const n = tasks.filter((o) => o.status === 'running').length;
      if (n) add('info', `${n} running and will run to completion; the night pause only stops new ones.`);
    }
    return out;
  }
  return out;
}

// ---- Bulk actions ---------------------------------------------------------------------------------
// Multi select on the board: the owner marks cards and does one thing with all of them. The board sends the id list the owner saw (never a search that
// the server evaluates again), the server previews with `queue.mjs edit-many --dry` (or `rank --dry`), and
// writes with --expect-changed when the owner confirms. The rules (valid fields, batch queue, parking, ranking) live in
// queueLogic and are enforced by queue.mjs; here is only the translation from action to command, the summary and the guard rules.

/** At most this many ids per call (like QA and approve). */
const BULK_MAX = 500;
/** Above this many ids the bulk action requires an extra confirmation (warning). */
const BULK_CONFIRM = 50;
/** The actions the selection bar can perform (the value in `action`). */
const BULK_ACTIONS = [
  'project',
  'feature',
  'park',
  'continue',
  'rank',
  'batch-in',
  'batch-out',
  'batch-pack',
  'label-add',
  'label-remove',
  // "Accept proposed" in the "Sort" list: every task gets the project queueLogic.classifyQueue proposes.
  'accept-suggestion',
];
/** Only tasks with these statuses can be bulk edited (running, review and finished are owned by queue.mjs's commands). */
const BULK_STATUSES = new Set(['waiting', 'proposed']);
const BULK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const BULK_PID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d\d-\d\d$/;

/** Text from the board: control characters removed, trimmed and cut (queue.mjs validates the content). */
const bulkText = (x, max) =>
  String(x ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

/**
 * Translates a bulk action from the board into the command that does it. Changes nothing.
 *   project     val { pid: string|null }       → edit-many [{ id, project }] (null = back to the prefix rule)
 *   feature     val { name: string|null }      → edit-many [{ id, feature }]
 *   park       val { reason?, to? }            → edit-many [{ id, parked: { reason?, to? } | true }]
 *   continue                                      → edit-many [{ id, parked: null }] (only those that are parked)
 *   batch-in / batch-out                          → edit-many [{ id, batched: true | false }]
 *   label-add / label-remove val { label } → edit-many [{ id, labels }] (only those that actually change)
 *   rank       val { space: top|bottom|over|under, ref? } → queue.mjs rank
 *   batch-pack   val { new_id?, title? }        → queue.mjs batch pack (a new id is proposed when it is missing)
 * @returns {{ error: string[] } | { error: [], command: 'edit-many', content: object }
 *   | { error: [], command: 'rank', space: object } | { error: [], command: 'batch-pack', newId: string, title: string|null }}
 */
function bulkPlan(queue, action, ids, val = {}) {
  const error = [];
  const v = val && typeof val === 'object' ? val : {};
  if (!BULK_ACTIONS.includes(action)) return { error: [`unknown bulk action ${action}`] };
  const list = Array.isArray(ids) ? ids.map(String) : [];
  if (!list.length) error.push('no tasks are marked');
  if (list.length > BULK_MAX) error.push(`at most ${BULK_MAX} tasks per action`);
  if (list.some((id) => !BULK_ID.test(id))) error.push('invalid id in the list');
  if (new Set(list).size !== list.length) error.push('the same id appears more than once');
  if (error.length) return { error };
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const tasks = (field) => ({ tasks: list.map((id) => ({ id, ...field(perId.get(id)) })) });

  if (action === 'accept-suggestion') {
    const proposed = sortSuggestion(queue);
    const rows = list
      .filter((id) => proposed.has(id))
      .map((id) => ({ id, project: proposed.get(id) }));
    if (!rows.length) return { error: ['none of the marked ones has a proposed project'] };
    return { error: [], command: 'edit-many', content: { tasks: rows } };
  }
  if (action === 'project') {
    const pid = v.pid == null || v.pid === '' ? null : String(v.pid);
    if (pid != null && !BULK_PID.test(pid)) return { error: ['invalid project id'] };
    return { error: [], command: 'edit-many', content: tasks(() => ({ project: pid })) };
  }
  if (action === 'feature') {
    const name = v.name == null ? null : bulkText(v.name, 80) || null;
    return { error: [], command: 'edit-many', content: tasks(() => ({ feature: name })) };
  }
  if (action === 'park') {
    const reason = bulkText(v.reason, 200);
    const to = v.to == null || v.to === '' ? null : String(v.to).trim();
    if (to != null && !DATE.test(to)) return { error: ['the date must be in the form YYYY-MM-DD'] };
    const p = reason || to ? { ...(reason ? { reason } : {}), ...(to ? { to } : {}) } : true;
    return { error: [], command: 'edit-many', content: tasks(() => ({ parked: p })) };
  }
  if (action === 'continue') {
    const parked = list.filter((id) => perId.get(id)?.parked);
    if (!parked.length) return { error: ['none of the marked ones is on hold'] };
    return {
      error: [],
      command: 'edit-many',
      content: { tasks: parked.map((id) => ({ id, parked: null })) },
    };
  }
  if (action === 'batch-in' || action === 'batch-out') {
    const input = action === 'batch-in';
    return { error: [], command: 'edit-many', content: tasks(() => ({ batched: input })) };
  }
  if (action === 'label-add' || action === 'label-remove') {
    const label = String(v.label ?? '')
      .trim()
      .toLowerCase();
    if (!L.LABEL_PATTERN.test(label))
      return { error: ['the label must be one short word in lowercase letters (e.g. visual)'] };
    const add = action === 'label-add';
    const rows = [];
    for (const id of list) {
      const now = Array.isArray(perId.get(id)?.labels) ? perId.get(id).labels : [];
      if (add === now.includes(label)) continue; // already so
      const fresh = add ? [...now, label] : now.filter((e) => e !== label);
      rows.push({ id, labels: fresh.length ? fresh : null });
    }
    if (!rows.length)
      return {
        error: [
          add
            ? `all of the marked ones already have the label ${label}`
            : `none of the marked ones has the label ${label}`,
        ],
      };
    return { error: [], command: 'edit-many', content: { tasks: rows } };
  }
  if (action === 'rank') {
    const space = String(v.space ?? '');
    if (!['top', 'bottom', 'over', 'under'].includes(space))
      return { error: ['choose top, bottom, right above or right below'] };
    if (space === 'over' || space === 'under') {
      const ref = String(v.ref ?? '').trim();
      if (!BULK_ID.test(ref)) return { error: ['write the id of the task the block should sit next to'] };
      return { error: [], command: 'rank', space: { [space]: ref } };
    }
    return { error: [], command: 'rank', space: { [space]: true } };
  }
  // batch-pack
  const used = new Set(perId.keys());
  let newId = v.new_id == null || v.new_id === '' ? null : String(v.new_id).trim();
  if (newId == null) {
    const pid = L.projectFor(perId.get(list[0]) ?? {}, queue.projects ?? {});
    newId = L.batchId(pid, queue.projects ?? {}, used);
  }
  if (!BULK_ID.test(newId)) return { error: ['invalid id for the new track'] };
  const title = bulkText(v.title, 200) || null;
  return { error: [], command: 'batch-pack', newId, title };
}

/**
 * The preview of "Pack into track": queueLogic.batchPack on a copy of the queue (same rules and merging as
 * `queue.mjs batch pack`), without writing anything. Returns the new track as it will be, and the parts that are cancelled.
 * @returns {{ error: string[], new?: object, cancelled?: string[], redirected?: string[] }}
 */
function packPreview(queue, ids, { newId, title = null } = {}) {
  const copy = L.cloneJson(queue);
  const r = L.batchPack(copy, ids, {
    newId,
    title,
    mission: `scripts/.queue/mission/${newId}.md`,
    by: 'theBoard',
  });
  if (r.error.length) return { error: r.error };
  const n = r.new;
  return {
    error: [],
    new: {
      id: n.id,
      title: n.title ?? '',
      class: n.class ?? null,
      status: n.status,
      content_min: Number(n.content_min ?? 0) || 0,
      value: Number(n.value ?? 5),
      migr_tens: Number(n.migr_tens ?? 0) || 0,
      project: L.projectFor(n, copy.projects ?? {}),
      feature: n.feature ?? null,
      depends_on: n.depends_on ?? [],
      waiting_on: n.waiting_on ?? [],
      owned_files: n.owned_files ?? [],
      labels: n.labels ?? [],
      mission: n.mission ?? null,
    },
    cancelled: r.cancelled,
    redirected: r.redirected,
  };
}

/** "1 task" / "3 tasks". */
const countTasks = (n) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

/**
 * The short explanation at the top of the preview: what happens, and how many are already so.
 * `changes` is the diff from `edit-many --dry` (queueLogic.bulkDiff: { id, field, before, after }).
 * @returns {string}
 */
function bulkSummary(queue, action, ids, val = {}, changes = []) {
  const n = ids.length;
  const changed = new Set((changes ?? []).filter((e) => e.id).map((e) => e.id));
  const same = n - changed.size;
  const rest = same > 0 ? ` ${same} are already so.` : '';
  const v = val ?? {};
  const fromTo = () => {
    // "11 move from alpha to beta": grouped by the project they have now.
    const register = queue.projects ?? {};
    const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
    const from = new Map();
    for (const id of changed) {
      const pid = L.projectFor(perId.get(id) ?? {}, register);
      from.set(pid, (from.get(pid) ?? 0) + 1);
    }
    return [...from].map(([pid, x]) => `${x} from ${pid}`).join(', ');
  };
  switch (action) {
    case 'project':
      return v.pid
        ? `${countTasks(n)}: ${changed.size} move to the project ${v.pid}${changed.size ? ` (${fromTo()})` : ''}.${rest}`
        : `${countTasks(n)}: ${changed.size} lose the fixed project and follow the prefix again.${rest}`;
    case 'feature':
      return v.name
        ? `${countTasks(n)}: ${changed.size} get feature "${v.name}".${rest}`
        : `${countTasks(n)}: ${changed.size} lose feature.${rest}`;
    case 'park':
      return (
        `${countTasks(n)}: ${changed.size} are put on hold` +
        (v.to ? ` up to and including ${v.to}` : ' until you take them off') +
        '. They stay in the queue, but are not started or picked.' +
        rest
      );
    case 'continue':
      return `${countTasks(n)}: ${changed.size} are taken off hold and can be started again.${rest}`;
    case 'batch-in':
      return (
        `${countTasks(n)}: ${changed.size} are put in the batch queue. There they do not start alone, but are packed ` +
        `together with other small tasks into a track.${rest}`
      );
    case 'batch-out':
      return `${countTasks(n)}: ${changed.size} are taken out of the batch queue and start as their own tracks.${rest}`;
    case 'accept-suggestion': {
      const proposed = sortSuggestion(queue);
      const without = ids.filter((id) => !proposed.has(id)).length;
      return (
        `${countTasks(n)}: ${changed.size} get the project the queue proposes` +
        `${changed.size ? ` (${fromTo()})` : ''}.` +
        (without ? ` ${without} have no proposal and stay as before.` : '') +
        (same - without > 0 ? ` ${same - without} already have that project.` : '')
      );
    }
    case 'label-add':
      return `${countTasks(n)}: ${changed.size} get the label ${v.label}.${rest}`;
    case 'label-remove':
      return `${countTasks(n)}: ${changed.size} lose the label ${v.label}.${rest}`;
    case 'rank': {
      const where =
        v.space === 'top'
          ? 'to the top of the step'
          : v.space === 'bottom'
            ? 'to the bottom of the step'
            : `right ${v.space === 'over' ? 'above' : 'below'} ${v.ref}`;
      return (
        `${countTasks(n)} move together ${where} and keep their order among themselves ` +
        `(${(changes ?? []).length} priorities changed).`
      );
    }
    case 'batch-pack':
      return (
        `${countTasks(n)} are merged into one new track. The parts are cancelled with a remark, and whatever ` +
        'depends_on them points to the new track. This cannot be undone with "Undo".'
      );
    default:
      return countTasks(n);
  }
}

/**
 * The guard rules for a bulk action (called from assess with type 'bulk'). Uses queueLogic directly, never a copy.
 *   stop: unknown task; a status that cannot be bulk edited (only waiting and proposed); the batch queue rules
 *          (queueLogic.batchedError against the queue as it will be) for "Add to batch queue"; the packing rules for "Pack into track";
 *          unknown project.
 *   warning: many at once (over BULK_CONFIRM); moving to a paused project; parking a task that something in
 *          focus waits on.
 *   info: parking a task others wait on (without focus); marked ones that are already so.
 */
function assessBulk(queue, action, add) {
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const perId = new Map(tasks.map((o) => [o.id, o]));
  const ids = [...new Set(action.ids ?? [])];
  const val = action.val ?? {};
  const h = action.action;
  const unknown = ids.filter((id) => !perId.has(id) || L.isExternalRow(perId.get(id)));
  if (unknown.length) add('stop', `Not in the queue: ${andList(unknown)}.`);
  const locked = ids
    .map((id) => perId.get(id))
    .filter((o) => o && !L.isExternalRow(o) && !BULK_STATUSES.has(o.status));
  if (locked.length)
    add(
      'stop',
      `Only tasks that are waiting or proposed can be changed together: ${andList(
        locked.map((o) => `${o.id} (${o.status})`),
      )}. Remove them from the selection.`,
    );
  if (ids.length > BULK_CONFIRM)
    add(
      'warning',
      `You are changing ${ids.length} tasks at once. Look over the list before you confirm.`,
    );
  if (unknown.length || locked.length) return;
  const marked = ids.map((id) => perId.get(id));

  if (h === 'project' && val.pid) {
    if (!Object.hasOwn(register, val.pid))
      add('stop', `The project ${val.pid} does not exist. Create it first (cq project).`);
    else if (register[val.pid]?.pause === true)
      add(
        'warning',
        `The project ${val.pid} is paused: tasks do not start until it continues.`,
      );
  }
  if (h === 'park') {
    const k = L.rankingContext(queue, action.now ?? Date.now());
    const inBlock = new Set(ids);
    const focus = [];
    const others = [];
    for (const o of marked) {
      const dependents = tasks.filter(
        (x) =>
          !inBlock.has(x.id) &&
          x.status === 'waiting' &&
          !L.isExternalRow(x) &&
          (x.depends_on ?? []).includes(o.id),
      );
      if (!dependents.length) continue;
      const inFocus = k.applies
        ? dependents.filter((x) => L.focusSpace(x, k).step != null).map((x) => x.id)
        : [];
      if (inFocus.length) focus.push(`${o.id} (${andList(inFocus)} waiting on it)`);
      else others.push(`${o.id} (${andList(dependents.map((x) => x.id))})`);
    }
    if (focus.length)
      add(
        'warning',
        `Something in focus is waiting on ${andList(focus)}. On hold also stops them until you take the task off hold.`,
      );
    if (others.length) add('info', `Other tasks are waiting on ${andList(others)}.`);
    const alt = marked.filter((o) => o.parked).map((o) => o.id);
    if (alt.length) add('info', `Already on hold: ${andList(alt)}.`);
  }
  if (h === 'batch-in') {
    // The rules against the queue as it will be when ALL the marked ones are in the batch queue.
    const after = tasks.map((o) => (ids.includes(o.id) ? { ...o, batched: true } : o));
    const error = [];
    for (const o of after.filter((x) => ids.includes(x.id)))
      for (const f of L.batchedError(o, after, queue.resolved)) error.push(`${o.id}: ${f}`);
    if (error.length) add('stop', `Cannot be put in the batch queue:\n${error.join('\n')}`);
  }
  if (h === 'batch-out') {
    const not = marked.filter((o) => !L.inBatchQueue(o)).map((o) => o.id);
    if (not.length === marked.length) add('stop', 'None of the marked ones is in the batch queue.');
    else if (not.length) add('info', `Not in the batch queue: ${andList(not)}.`);
  }
  if (h === 'batch-pack') {
    const plan = bulkPlan(queue, h, ids, val);
    if (plan.error.length) add('stop', plan.error.join('\n'));
    else {
      const p = packPreview(queue, ids, { newId: plan.newId, title: plan.title });
      if (p.error.length) add('stop', `Cannot be packed:\n${p.error.join('\n')}`);
    }
  }
  if (h === 'continue') {
    const not = marked.filter((o) => !o.parked).map((o) => o.id);
    if (not.length && not.length < marked.length)
      add('info', `Not on hold: ${andList(not)}.`);
  }
}

// ---- Settings and setup -------------------------------------------------------------------------

/**
 * The fields in the settings panel: all the limits `queue.mjs limit` can set (the test checks that the list equals
 * queueLogic.LIMIT_NAME), with a readable name, a one-line explanation and the saver mode recommendation where it exists.
 */
const SETTINGS = [
  {
    name: 'maxConcurrent',
    title: 'Concurrent tracks',
    explanation: 'How many agents the queue runs concurrently. Picked tasks do not count.',
    type: 'integer',
  },
  {
    name: 'maxDPlus',
    title: 'Concurrent D+ tracks',
    explanation: 'The heaviest tracks (D+, two reviewers each). At most as many as concurrent tracks.',
    type: 'integer',
  },
  {
    name: 'maxPerDomain',
    title: 'Track per domain',
    explanation: 'At most this many concurrently in the same domain.',
    type: 'integer',
  },
  {
    name: 'maxDb',
    title: 'Tracks with migrations',
    explanation:
      'Tracks with migrations concurrently, i.e. the load on the database. Picked tasks count here too.',
    type: 'integer',
  },
  {
    name: 'dailyBudget',
    title: 'Daily quota (USD)',
    explanation:
      'When today\'s usage (API equivalent) reaches the quota, no new tasks are started. "off" = no quota.',
    type: 'text',
  },
  {
    name: 'nightRun',
    title: 'Night run',
    explanation: 'Off: no new tasks are started in the night window. What is running runs to completion.',
    type: 'onoff',
  },
  {
    name: 'nightWindow',
    title: 'Night window (local time)',
    explanation: 'The hours the night pause applies, like "23-06" (from 23:00 to 06:00).',
    type: 'text',
  },
  {
    name: 'autocompact',
    title: 'Automatic compaction',
    explanation:
      'On: the orchestrator session is compacted by Claude Code itself at 300k (Auto-compact on, the default, and ' +
      'autoCompactWindow 300000) and continues on its own. Off: a notice with a ready /compact line, so you stay in ' +
      'control; then also turn off auto-compaction in Claude Code ("autoCompactEnabled": false), or it compacts anyway.',
    type: 'onoff',
  },
];

/**
 * The settings panel: each field with current value, default and saverMode (all as text, as queue.mjs shows them).
 * `migrations: false` (no migrations.folder in queue.config.json) leaves out maxDb, which only matters for the migration flow.
 */
function settings(queue, { migrations = true } = {}) {
  const g = { ...L.DEFAULT_LIMITS, ...(queue.limits ?? {}) };
  return SETTINGS.filter((f) => migrations || f.name !== 'maxDb').map((f) => ({
    ...f,
    val: L.limitText(f.name, g[f.name]),
    standard: L.limitText(f.name, L.DEFAULT_LIMITS[f.name]),
    saverMode: f.name in SAVER_MODE ? String(SAVER_MODE[f.name]) : null,
  }));
}

/**
 * The "Helper agents" tab writes a switch: the body { name, enabled } becomes `cq helpers on|off <name>` (queue.mjs does
 * the write under the lock, never the board). `names` are the helpers in the setup; anything else is refused here.
 * `setup` (helperSetup with the files checked) refuses to switch on a custom helper that is not approved for its file
 * as it is now, before queue.mjs is even asked (queue.mjs refuses it too). The board can never approve.
 * @returns {{ args: string[] } | { error: string }}
 */
function helperSwitchArgs(b, names, setup = null) {
  const name = String(b?.name ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name) || !(names ?? []).includes(name))
    return { error: `unknown helper agent ${name}` };
  if (typeof b.enabled !== 'boolean') return { error: 'enabled must be true or false' };
  if (b.enabled) {
    const block = require('./queueHelpers.js').enableBlock(name, setup?.[name] ?? null);
    if (block) return { error: block };
  }
  return { args: ['helpers', b.enabled ? 'on' : 'off', name] };
}

/**
 * The "Add helper" field: the body { path, name? } becomes `cq helpers add <path> [--name <name>]`. queue.mjs reads,
 * copies, hashes and scans the file on the server side and leaves the helper OFF; nothing from the file is run.
 * Only a .md path without control characters, and a valid agent name, get through.
 * @returns {{ args: string[] } | { error: string }}
 */
function helperAddArgs(b) {
  const file = String(b?.path ?? '').trim();
  if (!file || file.length > 1024 || /[\u0000-\u001f\u007f]/.test(file)) return { error: 'paste the path to the agent file (.md)' };
  if (!/\.md$/i.test(file)) return { error: 'the agent file must be a .md file' };
  if (file.startsWith('-')) return { error: 'the path cannot start with -' };
  const args = ['helpers', 'add', file];
  const name = String(b?.name ?? '').trim();
  if (name) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) return { error: `invalid agent name "${name}"` };
    args.push('--name', name);
  }
  return { args };
}

/**
 * The working rules the panel shows (static text, see docs/orchestration.md and the parallel-wave skill). The saver mode numbers
 * come from SAVER_MODE, so the panel and the settings always say the same.
 */
const SKILL_RULES = [
  {
    text: `Recommended to save quota: at most ${SAVER_MODE.maxConcurrent} concurrent tracks and ${SAVER_MODE.maxDPlus} D+.`,
  },
  {
    text:
      'Review by class: K none, D one reviewer, D+ two; the helper agents that are on add to it (the Helper agents tab).',
  },
  {
    text:
      'Context: a track delivers partial before the context is full, and the orchestrator compacts instead of rotating.',
  },
  { text: 'Fix rounds and continuations go in a new agent.' },
];
const SKILL_SOURCE = '.claude/skills/parallel-wave/SKILL.md and docs/orchestration.md';

/**
 * The queue system's own hooks in .claude/settings.json (see docs/orchestration.md): the script under scripts/orchestrator/, the
 * events it must be listed under, and (for the time log) that the matcher must cover all agent types.
 */
const QUEUE_HOOKS = [
  {
    file: 'hook-time.mjs',
    events: ['SubagentStart', 'SubagentStop'],
    allMatchers: true,
    what: 'time log for all agents',
  },
  { file: 'hook-push-guard.mjs', events: ['PreToolUse'], what: 'push guard' },
  { file: 'hook-read-guard.mjs', events: ['PreToolUse'], what: 'read guard' },
  { file: 'hook-track-context.mjs', events: ['PostToolUse'], what: 'context measurement in tracks' },
  { file: 'hook-track-end.mjs', events: ['SubagentStop'], what: 'end gate for tracks' },
  {
    file: 'hook-after-compact.mjs',
    events: ['PreCompact', 'SessionStart'],
    what: 'recovery after compaction',
  },
  { file: 'hook-effort.mjs', events: ['UserPromptSubmit'], what: 'thinking level' },
  { file: 'hook-context.mjs', events: ['UserPromptSubmit'], what: 'context warning' },
];

/**
 * Are the queue system's hooks set up? Reads `hooks.<event>` in .claude/settings.json and looks for entries where a
 * command points to scripts/orchestrator/<file>. Matcher "*" or no matcher counts as "all".
 * @returns {{ all: boolean, hooks: { file: string, what: string, ok: boolean,
 *   events: { event: string, matchers: string[], ok: boolean }[] }[], missing: string[] }}
 *   `all` = every hook is listed under all its events; `missing` = "file (event)" for what is missing.
 */
function hooksCoverage(settings, expected = QUEUE_HOOKS) {
  const matchers = (event, file) =>
    (settings?.hooks?.[event] ?? [])
      .filter(
        (e) =>
          Array.isArray(e?.hooks) &&
          e.hooks.some((h) =>
            String(h?.command ?? '')
              .replace(/\\/g, '/')
              .includes(`scripts/orchestrator/${file}`),
          ),
      )
      .map((e) => (e.matcher == null || e.matcher === '' ? '*' : String(e.matcher)));
  const missing = [];
  const hooks = expected.map((h) => {
    const events = h.events.map((event) => {
      const m = matchers(event, h.file);
      const ok = h.allMatchers ? m.includes('*') : m.length > 0;
      if (!ok) missing.push(`${h.file} (${event})`);
      return { event, matchers: m, ok };
    });
    return { file: h.file, what: h.what, ok: events.every((x) => x.ok), events };
  });
  return { all: missing.length === 0, hooks, missing };
}

/** The queue system's skills (.claude/skills/<name>/SKILL.md). */
const QUEUE_SKILLS = ['queue', 'add-to-queue', 'parallel-wave', 'plans', 'pick', 'start'];

/**
 * Are the queue system's skills installed? `exists(name)` answers whether .claude/skills/<name>/SKILL.md exists (the server passes
 * in the file check, so the function is pure).
 * @returns {{ all: boolean, exists: string[], missing: string[] }}
 */
function skillsCoverage(exists, name = QUEUE_SKILLS) {
  const yes = name.filter((n) => {
    try {
      return !!exists(n);
    } catch {
      return false;
    }
  });
  const missing = name.filter((n) => !yes.includes(n));
  return { all: missing.length === 0, exists: yes, missing };
}

/**
 * Where the setup check looks for the queue system's hooks and skills. Two ways to install:
 *   - plugin: the board runs from <plugin>/scripts/orchestrator/, next to <plugin>/.claude-plugin/plugin.json. The hooks are
 *     in <plugin>/hooks/hooks.json (same `hooks` shape as settings.json) and the skills in <plugin>/skills/.
 *   - vendored: the scripts are copied into the project, the hooks are in .claude/settings.json and the skills in
 *     .claude/skills/.
 * `exists(filePath)` is the file check from the server, so the function does no I/O itself.
 * @param {string} here the folder of queue-board.mjs (scripts/orchestrator/)
 * @param {string} gitRoot the project's main tree
 * @returns {{ mode: 'plugin'|'vendored', pluginRoot: string|null, manifest: string|null, hooksFile: string, skillsFolder: string }}
 */
function setupSources(here, gitRoot, exists) {
  const path = require('path');
  const pluginRoot = path.resolve(here, '..', '..');
  const manifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  let plugin = false;
  try {
    plugin = !!exists(manifest);
  } catch {
    plugin = false;
  }
  if (plugin)
    return {
      mode: 'plugin',
      pluginRoot,
      manifest,
      hooksFile: path.join(pluginRoot, 'hooks', 'hooks.json'),
      skillsFolder: path.join(pluginRoot, 'skills'),
    };
  return {
    mode: 'vendored',
    pluginRoot: null,
    manifest: null,
    hooksFile: path.join(gitRoot, '.claude', 'settings.json'),
    skillsFolder: path.join(gitRoot, '.claude', 'skills'),
  };
}

/** The default pattern for migration files (like config().migrations.filePattern): the first group is the number. */
const MIGRATION_PATTERN = '^(\\d+)_.*\\.sql$';

/**
 * The highest migration among the file names, with the project's file pattern (config().migrations.filePattern; the first group is
 * the number). The numbers are compared as integers. null when no file matches or the pattern is invalid.
 * @returns {{ number: number, version: string, file: string } | null}
 */
function highestMigration(fileName, filePattern = MIGRATION_PATTERN) {
  let re;
  try {
    re = new RegExp(filePattern || MIGRATION_PATTERN);
  } catch {
    return null;
  }
  let bestOne = null;
  for (const f of fileName ?? []) {
    const m = re.exec(String(f));
    if (!m || m[1] == null) continue;
    let number;
    try {
      number = BigInt(m[1]);
    } catch {
      continue;
    }
    if (!bestOne || number > bestOne.large) bestOne = { large: number, version: m[1], file: f };
  }
  return bestOne ? { number: Number(bestOne.large), version: bestOne.version, file: bestOne.file } : null;
}

/**
 * The board's title: config().board.title, followed by config().projectName when the project has given itself a name
 * (the default name "theProject" is not shown).
 */
function boardTitle(config = {}, { defaultName = 'theProject' } = {}) {
  const title = String(config?.board?.title ?? '').trim() || 'Queue board';
  const name = String(config?.projectName ?? '').trim();
  return name && name !== defaultName ? `${title} · ${name}` : title;
}

// ---- The colors ----------------------------------------------------------------------------------------------------

/**
 * The board's own, neutral palette: light and dark, with the same names in both. The names follow the Material pattern (primary,
 * on-primary, surface-container-low etc.), and board.css and plans.css use them as `var(--color-<name>)`.
 * The category colors are the project colors: chosen to be told apart (also with color blindness) and keep contrast
 * against the surfaces in both modes. If a project wants its own colors, they are changed here.
 */
const PALETTE = Object.freeze({
  light: Object.freeze({
    primary: '#2f5d8a',
    'on-primary': '#ffffff',
    'primary-container': '#d3e3f5',
    'on-primary-container': '#0b2a47',
    secondary: '#55606e',
    'secondary-container': '#dde3ea',
    'on-secondary-container': '#1a2430',
    tertiary: '#6a5089',
    'tertiary-container': '#ece0f7',
    'on-tertiary-container': '#2a1446',
    error: '#b3261e',
    'error-container': '#f9dedc',
    'on-error-container': '#410e0b',
    surface: '#f8f9fb',
    'on-surface': '#1b1d21',
    'on-surface-variant': '#4a505a',
    'surface-container-lowest': '#ffffff',
    'surface-container-low': '#f2f4f7',
    'surface-container': '#eceff3',
    'surface-container-high': '#e4e8ed',
    outline: '#737a85',
    'outline-variant': '#c4c9d1',
    'inverse-surface': '#2e3136',
    'inverse-on-surface': '#eff1f4',
    placeholder: '#6e7580',
    'module-amber-container': '#fbe7c2',
    'module-purple-container': '#e9defa',
    'category-teal': '#0f7c7a',
    'category-plum': '#8e3b6e',
    'category-ocean-blue': '#1f5fa8',
    'category-moss': '#5a731c',
    'category-violet': '#6b46c1',
    'category-petrol': '#155e75',
    'category-green': '#2e7d32',
    'category-bla': '#3949ab',
    'category-slate': '#546e7a',
    'category-graphite': '#5f6368',
  }),
  dark: Object.freeze({
    primary: '#9cc4ee',
    'on-primary': '#0b2a47',
    'primary-container': '#1d4469',
    'on-primary-container': '#d3e3f5',
    secondary: '#bcc6d2',
    'secondary-container': '#3a4552',
    'on-secondary-container': '#dde3ea',
    tertiary: '#d0bcf0',
    'tertiary-container': '#4f3770',
    'on-tertiary-container': '#ece0f7',
    error: '#f2b8b5',
    'error-container': '#8c1d18',
    'on-error-container': '#f9dedc',
    surface: '#121418',
    'on-surface': '#e3e5e9',
    'on-surface-variant': '#b9bfc8',
    'surface-container-lowest': '#0d0f12',
    'surface-container-low': '#1a1d22',
    'surface-container': '#1f2228',
    'surface-container-high': '#292d33',
    outline: '#8b929c',
    'outline-variant': '#41474f',
    'inverse-surface': '#e3e5e9',
    'inverse-on-surface': '#2e3136',
    placeholder: '#9aa0a9',
    'module-amber-container': '#5a4210',
    'module-purple-container': '#43306a',
    'category-teal': '#5fc4c0',
    'category-plum': '#e08cbd',
    'category-ocean-blue': '#8ab8f0',
    'category-moss': '#b2cc6b',
    'category-violet': '#b9a0f0',
    'category-petrol': '#6cc3dc',
    'category-green': '#81c784',
    'category-bla': '#9fa8f0',
    'category-slate': '#a7bcc6',
    'category-graphite': '#bdbdbd',
  }),
});

/**
 * The CSS variables for the board: `--color-<token>` for light in :root, dark when the system is dark (and the toggle has not chosen
 * light), and dark when the toggle has chosen dark (`<html data-theme="dark">`).
 */
function themeCss({ light, dark } = PALETTE) {
  const vars = (p) =>
    Object.entries(p)
      .filter(([k, v]) => /^[a-z0-9-]+$/.test(k) && /^#[0-9a-fA-F]{6}$/.test(v))
      .map(([k, v]) => `  --color-${k}: ${v};`)
      .join('\n');
  return [
    '/* Generated by queue-board.mjs from the palette in lib/queueBoard.js (light and dark). Never edit here. */',
    `:root {\n  color-scheme: light;\n${vars(light)}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n  color-scheme: dark;\n${vars(dark)}\n  }\n}`,
    `:root[data-theme="dark"] {\n  color-scheme: dark;\n${vars(dark)}\n}`,
    '',
  ].join('\n');
}

// ---- /api/doc (the markdown reading view, see docs/plan-register.md) ----------------------------------------------

/**
 * Reads one markdown document for the reading view on the board, with the path guard in several layers:
 *   1. queuePlanView.readPathError: relative path, no `.`/`..`/hidden parts, only `.md` under the allowlist.
 *   2. Each part under the root is checked with lstat: a symlink or junction (which Node also reports as a symlink) is rejected.
 *   3. The real path (realpath) must be exactly root + path: catches short 8.3 names, wrong upper/lower case and
 *      links we did not see in stage 2.
 *   4. Only regular files, at most `max` bytes.
 * The file system is passed in (`io = { fs, path }`), so the function can be tested against a temporary folder; no other I/O.
 * The error texts never mention anything outside the path the client itself sent.
 * @returns {{ ok: true, path: string, text: string, bytes: number, changed: string } |
 *   { ok: false, status: number, message: string }}
 */
function readDocument(root, filePath, io, { max } = {}) {
  const PRIVACY = require('./queuePlanView.js');
  const { fs, path } = io;
  const limit = max ?? PRIVACY.READ_MAX_BYTE;
  const no = (status, message) => ({ ok: false, status, message });
  const error = PRIVACY.readPathError(filePath);
  if (error) return no(400, `Cannot be read: ${error}.`);
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    return no(503, 'Could not find the project root.');
  }
  const parts = filePath.split('/');
  let here = realRoot;
  try {
    for (const d of parts) {
      here = path.join(here, d);
      if (fs.lstatSync(here).isSymbolicLink())
        return no(403, 'Cannot be read: the path goes through a symlink.');
    }
  } catch (e) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR'
      ? no(404, `Does not exist: ${filePath}`)
      : no(500, 'Could not read the document.');
  }
  try {
    const real = fs.realpathSync.native(here);
    if (real !== path.join(realRoot, ...parts))
      return no(403, 'Cannot be read: the path is not the real path to the file.');
    const st = fs.statSync(real);
    if (!st.isFile()) return no(404, `Not a document: ${filePath}`);
    if (st.size > limit)
      return no(
        413,
        `The document is too large for the reading view (over ${Math.round(limit / 1024)} KB).`,
      );
    const text = fs.readFileSync(real, 'utf8');
    return { ok: true, path: filePath, text, bytes: st.size, changed: st.mtime.toISOString() };
  } catch (e) {
    return e?.code === 'ENOENT'
      ? no(404, `Does not exist: ${filePath}`)
      : no(500, 'Could not read the document.');
  }
}

module.exports = {
  readDocument,
  STEP,
  RECENT_MS,
  NEXT_WHEN_FULL,
  PROJECT_COLORS,
  WITHOUT_PROJECT_COLOR,
  BRANCH_PREFIX,
  branchFor,
  columnFor,
  wip,
  projectLanes,
  chainMap,
  unlocksOf,
  chain,
  aging,
  nextUp,
  inbox,
  sortList,
  sortSuggestion,
  focusLine,
  planBasis,
  focusPreview,
  AREA_ACTIONS,
  areaPlan,
  board,
  newBonus,
  laneBonus,
  boostBonus,
  SAVER_MODE,
  assess,
  BULK_MAX,
  BULK_CONFIRM,
  BULK_ACTIONS,
  bulkPlan,
  packPreview,
  bulkSummary,
  SETTINGS,
  settings,
  helperSwitchArgs,
  helperAddArgs,
  SKILL_RULES,
  SKILL_SOURCE,
  QUEUE_HOOKS,
  hooksCoverage,
  QUEUE_SKILLS,
  skillsCoverage,
  setupSources,
  MIGRATION_PATTERN,
  highestMigration,
  boardTitle,
  PALETTE,
  themeCss,
};
