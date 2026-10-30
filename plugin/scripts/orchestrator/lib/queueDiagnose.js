// =============================================================
// queueDiagnose.js: quick diagnosis when the work queue runs at low parallelism.
//
// Background: a queue can run on few of the possible tracks without anyone noticing. Typical errors that block the focus are a
// dependency on a cancelled task (merged into another), a dependency on an id that does not exist, a
// "dragged along" dependency in a paused project, and loose waits (questions the owner does not see, or that are answered
// but block anyway).
//
// The guard: if the number of running agents (queueLogic.counterAsAgent: running and review without picked_by) is below the threshold
// (default 70 %) of limits.maxConcurrent, `queue.mjs fill`, `receive`, `orchestrator pulse` and `state` (the field
// `parallel`) print a short paragraph. `queue.mjs diagnose` always shows the whole diagnosis.
//
// The diagnosis never fixes anything itself. It INFORMS, and each finding is classified:
//   "simple"   mechanical and unambiguous (cancelled dependency with a known replacement, unknown id with one candidate, dragged
//              along into a pause, answered question that blocks anyway): a ready command the orchestrator runs.
//   "complex"  several possible replacements, unknown id without an unambiguous candidate, bottleneck, waiting on the owner: options
//              with a recommendation that are put before the owner.
//
// Pure logic: reads the queue, never writes (tested in scripts/orchestrator/lib/__tests__/queueDiagnose.test.ts). The logic for
// what can be started, the priority and the limits lives in queueLogic.js and is only read here.
// =============================================================

const L = require('./queueLogic.js');

/** The default threshold: low parallelism when active < threshold × maxConcurrent (`queue.mjs limit parallelThreshold`). */
const DEFAULT_THRESHOLD = 0.7;

/** The command the findings suggest (run from the repo root, also from a worktree). */
const QUEUE = require('./projectRoot.js').cqCommand();

/**
 * The remark batch pack (and the orchestrator) writes on a cancelled task: "<time> merged into <new-id>".
 */
const REPLACER_PATTERN =
  /(?:merged into)\s+([A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5][A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5._-]*)/;

/** At most this many bottlenecks in the diagnosis. */
const BOTTLENECK_MAX = 3;

/** The order the findings are shown in (within the same class): those that block the most, first. */
const TYPE_ORDER = [
  'depends-on-cancelled',
  'depends-on-unknown',
  'dragged-with-paused',
  'lose-waiting',
  'waiting-on-resolved',
  'capacity',
  'bottleneck',
];

/**
 * The limits that can hold back an otherwise ready task, in the same order selectNext tries them.
 * `holders` = tracks that hold the places the limit counts.
 */
const CAPACITY = [
  {
    name: 'maxDPlus',
    matches: (o) => o.class === 'D+',
    holders: (all) => all.filter((o) => L.counterAsAgent(o) && o.class === 'D+'),
  },
  {
    name: 'maxDb',
    matches: (o) => L.hasMigr(o),
    holders: (all) =>
      all.filter((o) => L.ACTIVE.has(o.status) && !L.isExternalRow(o) && L.hasMigr(o)),
  },
];

/** Cleanup: findings that do not block anything (an answered question that is still in waiting_on). */
const isCleanup = (f) => f?.type === 'waiting-on-resolved';

/** The threshold from the queue file, or the default. Only numbers in [0, 1] apply. */
function thresholdFor(queue) {
  const v = Number(queue?.limits?.parallelThreshold);
  return queue?.limits?.parallelThreshold != null && Number.isFinite(v) && v >= 0 && v <= 1
    ? v
    : DEFAULT_THRESHOLD;
}

/**
 * Parses a new threshold (`queue.mjs limit parallelThreshold <0-1>`): a number between 0 and 1 (comma or period), or a
 * percentage like "70 %". 0 turns the guard off.
 * @returns {{ val: number } | { error: string }}
 */
function parseThreshold(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(',', '.');
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
  const v = percent ? Number(percent[1]) / 100 : s ? Number(s) : NaN;
  if (!Number.isFinite(v) || v < 0 || v > 1)
    return {
      error: 'parallelThreshold must be a number from 0 to 1 (e.g. 0.7) or a percentage (70 %)',
    };
  return { val: Math.round(v * 100) / 100 };
}

/** The command that sets `depends_on` to a new list. */
const editDependsOn = (id, list) =>
  `${QUEUE} edit ${id} --json '${JSON.stringify({ depends_on: list })}'`;

/** depends_on list where `from` is swapped with `to` (without duplicates; `to` = null removes it). */
function swapDependency(list, from, to) {
  const out = [];
  for (const d of list ?? []) {
    const fresh = d === from ? to : d;
    if (fresh != null && !out.includes(fresh)) out.push(fresh);
  }
  return out;
}

/**
 * The replacement for a cancelled task: from the remark "merged into X", otherwise from `merged_from` on another
 * task. Follows the chain (X may itself have been merged further), at most 10 steps. Returns all the candidates; one =
 * unambiguous.
 */
function replacers(dep, perId, tasks) {
  const found = new Set();
  const direct = (id) => {
    const o = perId.get(id);
    const out = new Set();
    for (const m of o?.remarks ?? []) {
      const t = REPLACER_PATTERN.exec(String(m));
      if (t && t[1] !== id) out.add(t[1]);
    }
    for (const x of tasks)
      if (Array.isArray(x.merged_from) && x.merged_from.includes(id) && x.id !== id)
        out.add(x.id);
    return [...out];
  };
  for (const start of direct(dep)) {
    let id = start;
    const set = new Set([dep]);
    for (let i = 0; i < 10; i++) {
      const o = perId.get(id);
      if (!o || o.status !== 'cancelled' || set.has(id)) break;
      set.add(id);
      const next = direct(id);
      if (next.length !== 1) break;
      id = next[0];
    }
    found.add(id);
  }
  return [...found];
}

/** The base lineage of an id: without the revision suffix "-r<n>" (A-1-r2 → A-1). */
const baseLineage = (id) => String(id).replace(/-r\d+$/i, '');
/** The revision number (A-1-r3 → 3), or null without a revision suffix. */
const revision = (id) => {
  const t = /-r(\d+)$/i.exec(String(id));
  return t ? Number(t[1]) : null;
};

/**
 * Candidates for an unknown dependency: tasks with the same base lineage (A-1-r2 → A-1, A-1-r3) that are not
 * cancelled, with finished ones preferred. If the unknown id is a revision and other revisions exist, the highest
 * (preferably finished) revision is the one candidate: a later revision replaces the earlier ones. Otherwise all the matches.
 */
function nearIds(dep, tasks, ownId) {
  const stem = baseLineage(dep);
  if (!stem) return [];
  const match = tasks.filter(
    (o) =>
      o.id !== ownId &&
      o.id !== dep &&
      o.status !== 'cancelled' &&
      !L.isExternalRow(o) &&
      baseLineage(o.id) === stem,
  );
  const doneFirst = (list) => {
    const finished = list.filter((o) => o.status === 'done');
    return finished.length ? finished : list;
  };
  if (revision(dep) != null) {
    const rev = doneFirst(match.filter((o) => revision(o.id) != null));
    if (rev.length) {
      const highest = Math.max(...rev.map((o) => revision(o.id)));
      return rev.filter((o) => revision(o.id) === highest).map((o) => o.id);
    }
  }
  return doneFirst(match)
    .map((o) => o.id)
    .sort((a, b) => a.localeCompare(b));
}

/** Why can a task not start itself (bottleneck)? Short text. */
function ownReason(o, queue, k) {
  if (o.status === 'running') return 'running (track or fix round)';
  if (o.status === 'review') return 'in review (waiting on review and merge)';
  if (o.status === 'picked') return `picked by ${o.picked_by ?? '?'}`;
  if (o.status === 'proposed') return 'proposed (not approved)';
  const h = L.blockersWithPause(o, queue, k);
  return h.length ? h.slice(0, 2).join('; ') : 'ready, but got no place (limits or conflict)';
}

/** The recommendation for a bottleneck, based on what it is waiting on. */
function bottleneckRecommendation(o, queue) {
  if (o.status === 'review') return `prioritize review and merge of ${o.id}`;
  if (o.status === 'running')
    return `let ${o.id} finish; no action unless the track is stuck`;
  if (o.status === 'picked')
    return `ask ${o.picked_by ?? 'whoever picked it'} about progress, or cq release ${o.id}`;
  if (o.status === 'proposed') return `the owner approves or rejects: ${QUEUE} approve ${o.id}`;
  const sp = L.openQuestion(o, queue.resolved);
  if (sp.length) return `an owner answer on ${sp.join(', ')} unlocks it`;
  if (L.projectPaused(o, queue.projects ?? {}))
    return `the owner decides whether project ${L.projectFor(o, queue.projects ?? {})} should be unpaused`;
  return 'see the blockers (cq show --full); no mechanical fix';
}

/**
 * The diagnosis for low parallelism. Pure: reads the queue, never writes.
 * @param {object} queue the queue
 * @param {{ now?: number }} [option] now = the time (ms) the focus and parking are evaluated against
 * `empty` = no task is waiting to run; then `low` is always false (an empty queue is not an alarm).
 * @returns {{ activeOnes: number, max: number, threshold: number, share: number, low: boolean, empty: boolean, focus: boolean,
 *   findings: Array<{ type: string, id: string, back: number, class: 'simple'|'complex', text: string,
 *   command?: string, option?: Array<{ text: string, command?: string }>, recommendation?: string, dep?: string,
 *   sp?: string }> }}
 */
function parallelDiagnose(queue, { now = Date.now() } = {}) {
  const tasks = (queue?.tasks ?? []).filter((o) => !L.isExternalRow(o));
  const register = queue?.projects ?? {};
  const use = L.spaceUse(queue ?? {});
  const max = Number(use.limits.maxConcurrent) || 0;
  const activeOnes = use.agents;
  const threshold = thresholdFor(queue);
  const share = max > 0 ? activeOnes / max : 1;
  // Nothing waiting to run (an empty or finished queue): few tracks is then expected, not an alarm.
  const empty = !tasks.some((o) => o.status === 'waiting');
  const low = !empty && max > 0 && activeOnes < threshold * max;

  const all = queue?.tasks ?? [];
  const perId = new Map(all.map((o) => [o.id, o]));
  const children = L.childrenMap(all);
  const k = L.rankingContext(queue, now);
  const space = new Map();
  const spaceFor = (o) => {
    if (!space.has(o.id)) space.set(o.id, L.focusSpace(o, k));
    return space.get(o.id);
  };
  // "In focus": pending tasks with their own stage or dragged along (without a current focus: all pending).
  const inFocus = (o) => !k.applies || spaceFor(o).step != null;
  const focusSet = new Set(
    tasks.filter((o) => o.status === 'waiting' && !L.isBatched(o) && inFocus(o)).map((o) => o.id),
  );
  // How many focus tasks are held back (the task itself included when it is in focus)?
  const backMemo = new Map();
  const back = (id, { withSelf = true } = {}) => {
    const key = `${id}|${withSelf}`;
    if (!backMemo.has(key)) {
      const ids = L.successors(id, all, children).filter((x) => focusSet.has(x));
      backMemo.set(key, ids.length + (withSelf && focusSet.has(id) ? 1 : 0));
    }
    return backMemo.get(key);
  };

  const findings = [];
  const opened = tasks.filter((o) => o.status === 'waiting' || o.status === 'proposed');

  // 1 and 2: dependency on a cancelled or unknown task.
  for (const o of opened) {
    for (const dep of o.depends_on ?? []) {
      const d = perId.get(dep);
      if (d && d.status === 'cancelled') {
        const cand = replacers(dep, perId, all).filter((x) => x !== o.id);
        const reason = `${dep} is cancelled`;
        if (cand.length === 1) {
          findings.push({
            type: 'depends-on-cancelled',
            id: o.id,
            dep,
            back: back(o.id),
            class: 'simple',
            text: `${reason}, merged into ${cand[0]}`,
            command: editDependsOn(o.id, swapDependency(o.depends_on, dep, cand[0])),
          });
        } else {
          findings.push({
            type: 'depends-on-cancelled',
            id: o.id,
            dep,
            back: back(o.id),
            class: 'complex',
            text: cand.length
              ? `${reason}; several possible replacements: ${cand.join(', ')}`
              : `${reason} without a known replacement`,
            option: [
              ...cand.map((x) => ({
                text: `repoint to ${x}`,
                command: editDependsOn(o.id, swapDependency(o.depends_on, dep, x)),
              })),
              {
                text: `remove the dependency (the work in ${dep} is no longer needed)`,
                command: editDependsOn(o.id, swapDependency(o.depends_on, dep, null)),
              },
            ],
            recommendation: cand.length
              ? `select the replacement that actually did the work in ${dep} (see the remarks)`
              : `remove the dependency if ${dep} was dropped on purpose; otherwise add the replacement`,
          });
        }
      } else if (!d) {
        const cand = nearIds(dep, all, o.id);
        if (cand.length === 1) {
          findings.push({
            type: 'depends-on-unknown',
            id: o.id,
            dep,
            back: back(o.id),
            class: 'simple',
            text: `${dep} does not exist; near id ${cand[0]} (${perId.get(cand[0])?.status})`,
            command: editDependsOn(o.id, swapDependency(o.depends_on, dep, cand[0])),
          });
        } else {
          findings.push({
            type: 'depends-on-unknown',
            id: o.id,
            dep,
            back: back(o.id),
            class: 'complex',
            text: cand.length
              ? `${dep} does not exist; several near ids: ${cand.join(', ')}`
              : `${dep} does not exist, and no near id`,
            option: [
              ...cand.map((x) => ({
                text: `repoint to ${x}`,
                command: editDependsOn(o.id, swapDependency(o.depends_on, dep, x)),
              })),
              {
                text: 'remove the dependency',
                command: editDependsOn(o.id, swapDependency(o.depends_on, dep, null)),
              },
            ],
            recommendation: cand.length
              ? 'select the last delivered revision if it covers what the task needs'
              : 'find out what the id was meant to point to (source, mission); remove it if the work is completed',
          });
        }
      }
    }
  }

  // 3: dragged along by a focus task, but the project is paused (the pause takes precedence, so it is never started).
  for (const [id, d] of k.dragged) {
    const o = perId.get(id);
    if (!o || o.status !== 'waiting' || !L.projectPaused(o, register)) continue;
    const drags = perId.get(d.by);
    const pid = drags ? L.projectFor(drags, register) : null;
    if (!pid || L.projectPaused(drags, register)) continue;
    findings.push({
      type: 'dragged-with-paused',
      id,
      back: back(id),
      class: 'simple',
      text:
        `dragged along by ${d.by} (${pid}), but project ${L.projectFor(o, register)} is paused; ` +
        `move it to ${pid}`,
      command: `${QUEUE} edit ${id} --json '${JSON.stringify({ project: pid })}'`,
    });
  }

  // 4: loose waits. An answered question that blocks anyway is mechanical; the rest need text.
  for (const x of L.resolveWaits(queue ?? {})) {
    if (L.isExternalRow(perId.get(x.id))) continue;
    if (x.reason === 'resolved-blocks') {
      findings.push({
        type: 'lose-waiting',
        id: x.id,
        sp: x.sp,
        back: back(x.id),
        class: 'simple',
        text: `${x.sp} is answered, but is not in resolved (blocks anyway)`,
        command: `${QUEUE} resolve ${x.sp}`,
      });
    } else {
      findings.push({
        type: 'lose-waiting',
        id: x.id,
        sp: x.sp,
        back: back(x.id),
        class: 'complex',
        text:
          x.reason === 'freeText'
            ? `waiting on free text "${String(x.sp).slice(0, 50)}", not a registered question (the owner does not see it)`
            : `waiting on ${x.sp}, which is not registered with text (the owner does not see it)`,
        option: [
          {
            text: 'register the question with text and type, and let the task wait on the id',
            command: `${QUEUE} question <id> --text "…" --type question`,
          },
          { text: 'remove the wait if it no longer applies (edit waiting_on)' },
        ],
        recommendation:
          'register the question (the text from the mission), so the owner sees it in "Waiting on you"',
      });
    }
  }

  // 5: waiting_on still has a resolved question (does not block, but confuses "Waiting on you" and the counts).
  const resolved = new Set(queue?.resolved ?? []);
  for (const o of opened) {
    const vp = Array.isArray(o.waiting_on) ? o.waiting_on : [];
    const answered = vp.filter((sp) => resolved.has(sp));
    if (!answered.length) continue;
    findings.push({
      type: 'waiting-on-resolved',
      id: o.id,
      sp: answered.join(', '),
      back: back(o.id),
      class: 'simple',
      text: `waiting_on has answered ${answered.join(', ')} (does not block; cleanup)`,
      command: `${QUEUE} edit ${o.id} --json '${JSON.stringify({ waiting_on: vp.filter((sp) => !resolved.has(sp)) })}'`,
    });
  }

  const canStart = (o) =>
    o.status === 'waiting' &&
    !L.isBatched(o) &&
    L.blockers(o, all, queue?.resolved).length === 0 &&
    !spaceFor(o).out;

  // 6: ready focus tasks held back by a capacity limit. Without this the diagnosis would show empty blockers and
  // only bottlenecks (e.g. a ready D+ that waits because maxDPlus is used up). Raising a limit is an owner option, so
  // the finding is complex with the limit command as the recommendation.
  if (use.available > 0) {
    const counts = { maxDPlus: use.dPlus, maxDb: use.db };
    for (const g of CAPACITY) {
      const limit = Number(use.limits[g.name]);
      if (!Number.isFinite(limit) || counts[g.name] < limit) continue;
      const heldLeft = tasks
        .filter((o) => focusSet.has(o.id) && canStart(o) && g.matches(o))
        .map((o) => o.id)
        .sort((a, b) => a.localeCompare(b));
      if (!heldLeft.length) continue;
      const holders = g
        .holders(all)
        .map((o) => o.id)
        .sort((a, b) => a.localeCompare(b));
      findings.push({
        type: 'capacity',
        id: g.name,
        back: heldLeft.length,
        class: 'complex',
        text:
          `the limit ${g.name} (${limit}) is reached by ${holders.join(', ')}; ` +
          `ready in focus and waiting for a place: ${heldLeft.join(', ')}`,
        recommendation: `let the places free up, or raise the limit: ${QUEUE} limit ${g.name} ${limit + 1}`,
      });
    }
  }

  // 7: bottlenecks: non-startable tasks in focus that the most focus tasks wait on (transitively). Information only.
  const flask = tasks
    .filter(
      (o) =>
        L.STATUSES.has(o.status) &&
        !['done', 'cancelled'].includes(o.status) &&
        !L.isBatched(o) &&
        inFocus(o) &&
        !canStart(o),
    )
    .map((o) => ({ o, n: back(o.id, { withSelf: false }) }))
    .filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n || x.o.id.localeCompare(y.o.id))
    .slice(0, BOTTLENECK_MAX);
  for (const { o, n } of flask) {
    findings.push({
      type: 'bottleneck',
      id: o.id,
      back: n,
      class: 'complex',
      text: `${n} focus task(s) waiting on it; itself: ${ownReason(o, queue, k)}`,
      recommendation: bottleneckRecommendation(o, queue),
    });
  }

  // Simple first (they can be fixed right away), then the type, then most held back; bottlenecks and cleanup last.
  const typeNr = (t) => TYPE_ORDER.indexOf(t);
  const latest = (f) => (isCleanup(f) ? 2 : f.type === 'bottleneck' ? 1 : 0);
  findings.sort(
    (x, y) =>
      latest(x) - latest(y) ||
      (x.class === 'simple' ? 0 : 1) - (y.class === 'simple' ? 0 : 1) ||
      typeNr(x.type) - typeNr(y.type) ||
      y.back - x.back ||
      x.id.localeCompare(y.id),
  );
  return { activeOnes, max, threshold, share, low, empty, focus: k.applies, findings };
}

const pst = (x) => `${Math.round(x * 100)} %`;

/** The heading: "LOW PARALLELISM: 2 of 6 tracks (33 %, threshold 70 %). Quick diagnosis:". */
function heading(d) {
  if (d.empty) return `Parallelism: ${d.activeOnes} of ${d.max} tracks (nothing waiting to run).`;
  return (
    `${d.low ? 'LOW PARALLELISM' : 'Parallelism'}: ${d.activeOnes} of ${d.max} tracks ` +
    `(${pst(d.share)}, threshold ${pst(d.threshold)}).${d.low ? ' Quick diagnosis:' : ''}`
  );
}

/** One line for a finding (short paragraph). */
function findingsLine(f) {
  const where = `${f.id}${f.back ? ` (${f.back} in focus held back)` : ''}`;
  const what = `  [${f.class}] ${f.type} ${where}: ${f.text}`;
  if (f.class === 'simple') return `${what}. Run: ${f.command}`;
  return `${what}. The owner: ${f.recommendation}`;
}

/**
 * The short paragraph (fill, receive, orchestrator pulse): at most `max` lines, empty when parallelism is not low.
 * Cleanup (waiting-on-resolved) is left out: it does not block, and the queue has many of those (they only appear in queue.mjs diagnose).
 */
function diagnoseLines(d, { max = 12 } = {}) {
  if (!d?.low) return [];
  const important = d.findings.filter((f) => !isCleanup(f));
  const out = [heading(d)];
  if (!important.length) {
    out.push(
      '  No mechanical errors in dependencies or waits. See cq show (limits, conflicts, focus that is waiting).',
    );
    return out;
  }
  const tail = [
    '  Simple: the orchestrator runs the command. Complex: put the choice with the recommendation before the owner (cq diagnose).',
  ];
  const space = Math.max(1, max - 1 - tail.length);
  const show = important.slice(0, important.length > space ? space - 1 : space);
  for (const f of show) out.push(findingsLine(f));
  if (important.length > show.length)
    out.push(`  +${important.length - show.length} more findings (cq diagnose)`);
  return [...out, ...tail];
}

/** The whole diagnosis (queue.mjs diagnose): all findings, with options and recommendation for the complex ones. */
function diagnoseFull(d) {
  const out = [heading(d).replace(' Quick diagnosis:', '')];
  out.push(
    d.empty
      ? 'Nothing waiting to run: low parallelism is expected, and the paragraph is not shown in fill, receive and pulse.'
      : d.low
        ? 'Below the threshold: the paragraph is shown in fill, receive, orchestrator pulse and state (the field parallel).'
        : 'Above the threshold: the paragraph is not shown in fill, receive and pulse.',
  );
  if (!d.findings.length) {
    out.push('No findings.');
    return out;
  }
  const simple = d.findings.filter((f) => f.class === 'simple' && !isCleanup(f));
  const complex = d.findings.filter((f) => f.class === 'complex');
  const cleanup = d.findings.filter(isCleanup);
  if (simple.length) {
    out.push('', `SIMPLE (${simple.length}): mechanical and unambiguous; the orchestrator runs the command.`);
    for (const f of simple) {
      out.push(`  ${f.type} ${f.id}${f.back ? ` (${f.back} in focus held back)` : ''}: ${f.text}`);
      out.push(`    ${f.command}`);
    }
  }
  if (complex.length) {
    out.push('', `COMPLEX (${complex.length}): options with a recommendation for the owner.`);
    for (const f of complex) {
      out.push(`  ${f.type} ${f.id}${f.back ? ` (${f.back} in focus held back)` : ''}: ${f.text}`);
      for (const v of f.option ?? [])
        out.push(`    option: ${v.text}${v.command ? `: ${v.command}` : ''}`);
      out.push(`    recommendation: ${f.recommendation}`);
    }
  }
  if (cleanup.length) {
    out.push(
      '',
      `CLEANUP (${cleanup.length}): answered questions still in waiting_on. Does not block; simple, but ` +
        'optional (waiting_on also shows which answer unlocked the task).',
    );
    for (const f of cleanup) out.push(`  ${f.id}: ${f.sp}    ${f.command}`);
  }
  return out;
}

module.exports = {
  DEFAULT_THRESHOLD,
  REPLACER_PATTERN,
  thresholdFor,
  parseThreshold,
  replacers,
  baseLineage,
  nearIds,
  parallelDiagnose,
  diagnoseLines,
  diagnoseFull,
};
