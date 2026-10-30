// =============================================================
// queueHelpers.js: the helper agents (optional reviewers that can be turned on and off) and the ONE place the reviewers
// for a task are worked out. See docs/orchestration.md ("Helper agents").
//
// Two kinds of reviewers:
//   - fixed reviewers: config().reviewers per class (D `reviewer`, D+ also `reviewer-security`). Always run for the
//     class; not switches. Kept exactly as before, so an existing queue.config.json behaves the same.
//   - helpers: config().helpers, { "<agent>": { enabled, classes, labels, paths, mostlyPaths, plan, minMissionItems } }.
//     A helper runs for a task when it is enabled AND at least one of its conditions hits:
//       classes          the task's class is in the list
//       labels           the task has one of the labels
//       paths            at least one changed file matches one of the patterns
//       mostlyPaths      more than half of the changed files match one of the patterns
//       plan             (true) the task has a plan field (a plan register entry)
//       minMissionItems  the mission file has at least this many numbered points
//     The register is open: a helper is `source: "builtin"` (one of the agents the plugin ships, CATALOG) or
//     `source: "custom"` (an agent file of the project's own, with `path` and `sha256` of that file). The selection,
//     the switch and the measurement below never look at the source; adding, scanning and approving custom helpers is
//     a separate step that only fills in these fields.
//     The on/off switch the owner flips (`cq helpers on|off <agent>`, the board's "Helper agents" tab) is stored in
//     queue.json (`helpers.<agent>.enabled`) and wins over queue.config.json, like `cq limit` does for the limits.
//
// reviewersForTask() is used by `cq receive` (the reviewer prompts and the review package), allReviewerTypes() by the
// cost per task, the cost guard and the read guard. helperStatistics() is the measurement (runs, minutes, tokens, USD,
// share of the task cost, findings per run) in the board tab, `cq helpers` and `cq cost`.
//
// Pure logic (no file I/O), tested in lib/__tests__/queueHelpers.test.ts.
// =============================================================
'use strict';

/** The helper agents the plugin ships (plugin/agents/<name>.md): one sentence each for the board and `cq helpers`. */
const CATALOG = Object.freeze({
  'reviewer-challenger': {
    title: 'Challenger',
    text: 'Tries to prove the delivery wrong: counter-evidence, a root cause that is a symptom, a fix that does not fix.',
  },
  'reviewer-design': {
    title: 'Design',
    text: 'UI/UX review: clear controls and states, empty and error states, WCAG 2.2 AA, keyboard, light and dark mode.',
  },
  'reviewer-tests': {
    title: 'Tests',
    text: 'Checks that the tests prove the behavior and cover the edge cases that matter, and fail without the change.',
  },
  'reviewer-gap': {
    title: 'Gap',
    text: 'Compares the delivery with the mission point by point: missing, partial, divergent or outside the mission.',
  },
  'reviewer-docs': {
    title: 'Docs',
    text: 'For documentation changes: no true fact lost in a rewrite, easy to find your way, and the docs match the code.',
  },
});

/** A valid agent name (the file plugin/agents/<name>.md, the subagent_type). */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/i;

const list = (x) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * A path pattern as a regular expression. `*` = anything but "/", `**` = anything (also "/"), `?` = one character.
 * A pattern ending in "/" is a folder from the root ("docs/" = everything under docs). A pattern without "/" matches
 * the file name in any folder ("*.md"). Otherwise the pattern is from the root. Case does not matter.
 */
function pathPattern(pattern) {
  let g = norm(pattern);
  if (g.endsWith('/')) g += '**';
  const anywhere = !g.includes('/');
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        r += '(?:.*/)?';
        i++;
      } else r += '.*';
    } else if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anywhere ? `(^|/)${r}$` : `^${r}$`, 'i');
}

/** Does the path match one of the patterns? */
function matchesAny(filePath, patterns) {
  const p = norm(filePath);
  return patterns.some((x) => pathPattern(x).test(p));
}

/** The number of numbered points in a mission text ("1. ...", "2) ..." at the start of a line). */
function missionItems(text) {
  return (String(text ?? '').match(/^\s*\d{1,3}[.)]\s+\S/gm) ?? []).length;
}

/** One helper's settings, cleaned: lists are lists, enabled is a boolean. */
function cleanHelper(h) {
  const x = isObject(h) ? h : {};
  const n = Number(x.minMissionItems);
  return {
    enabled: x.enabled === true,
    classes: list(x.classes),
    labels: list(x.labels),
    paths: list(x.paths),
    mostlyPaths: list(x.mostlyPaths),
    plan: x.plan === true,
    minMissionItems: Number.isInteger(n) && n > 0 ? n : null,
  };
}

/**
 * The helpers in effect: config().helpers (already merged with the defaults by queueConfig) with the switches in
 * queue.json (`helpers.<agent>.enabled`) on top. Names that are not valid agent names are skipped.
 * @returns {Record<string, ReturnType<typeof cleanHelper> & { switchedInQueue: boolean, title: string, text: string }>}
 */
function helperSetup(config, queue = null) {
  const own = isObject(config?.helpers) ? config.helpers : {};
  const switches = isObject(queue?.helpers) ? queue.helpers : {};
  const out = {};
  for (const [name, h] of Object.entries(own)) {
    if (!NAME.test(name)) continue;
    const c = cleanHelper(h);
    const s = switches[name];
    const switchedInQueue = isObject(s) && typeof s.enabled === 'boolean';
    if (switchedInQueue) c.enabled = s.enabled;
    out[name] = {
      ...c,
      switchedInQueue,
      ...helperSource(name, h),
      title: (isObject(h) && typeof h.title === 'string' && h.title) || CATALOG[name]?.title || name,
      text:
        (isObject(h) && typeof h.text === 'string' && h.text) ||
        CATALOG[name]?.text ||
        'A helper agent from queue.config.json.',
    };
  }
  return out;
}

/**
 * Where a helper comes from: "builtin" (in CATALOG, unless the config says custom) or "custom" with the agent file's
 * `path` and `sha256` (null when not given). Only data: nothing here reads the file.
 */
function helperSource(name, h) {
  const x = isObject(h) ? h : {};
  const custom = x.source === 'custom' || (x.source !== 'builtin' && !CATALOG[name]);
  if (!custom) return { source: 'builtin', path: null, sha256: null };
  return {
    source: 'custom',
    path: typeof x.path === 'string' && x.path ? norm(x.path) : null,
    sha256: typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(x.sha256) ? x.sha256.toLowerCase() : null,
  };
}

/** The fixed reviewers per class (config().reviewers); an invalid value gives the plugin's defaults. */
const DEFAULT_REVIEWERS = Object.freeze({ D: ['reviewer'], 'D+': ['reviewer', 'reviewer-security'] });
function fixedSetup(config) {
  const r = config?.reviewers;
  return isObject(r) ? r : DEFAULT_REVIEWERS;
}
function fixedFor(config, cls) {
  return list(fixedSetup(config)[cls]);
}

/**
 * Why a helper runs for a task: the conditions that hit, in plain text. Empty list = it does not run (also when it is
 * off: `ignoreEnabled` checks the conditions only, for "would run" in the views).
 * @param {object} h a helper from helperSetup
 * @param {object} o the task (class, labels, plan)
 * @param {{ changedPaths?: string[], missionText?: string|null, ignoreEnabled?: boolean }} [c]
 */
function helperReasons(h, o, { changedPaths = [], missionText = null, ignoreEnabled = false } = {}) {
  if (!h || (!h.enabled && !ignoreEnabled)) return [];
  const why = [];
  if (h.classes.includes(String(o?.class))) why.push(`class ${o.class}`);
  const labels = Array.isArray(o?.labels) ? o.labels : [];
  const label = h.labels.find((l) => labels.includes(l));
  if (label) why.push(`label ${label}`);
  const files = list(changedPaths);
  if (h.paths.length) {
    const hit = files.find((f) => matchesAny(f, h.paths));
    if (hit) why.push(`changes ${norm(hit)}`);
  }
  if (h.mostlyPaths.length && files.length) {
    const n = files.filter((f) => matchesAny(f, h.mostlyPaths)).length;
    if (n * 2 > files.length) why.push(`${n} of ${files.length} changed files match`);
  }
  if (h.plan && o?.plan) why.push(`plan ${o.plan}`);
  if (h.minMissionItems && missionText != null) {
    const n = missionItems(missionText);
    if (n >= h.minMissionItems) why.push(`${n} numbered points in the mission`);
  }
  return why;
}

/**
 * THE reviewers for a task: the fixed ones for its class first, then the helpers that are on and hit, each once.
 * @param {object} o the task
 * @param {{ config: object, queue?: object|null, changedPaths?: string[], missionText?: string|null }} c
 * @returns {{ type: string, fixed: boolean, reasons: string[] }[]}
 */
function reviewersForTask(o, { config, queue = null, changedPaths = [], missionText = null }) {
  const out = fixedFor(config, o?.class).map((type) => ({ type, fixed: true, reasons: [`class ${o?.class}`] }));
  for (const [type, h] of Object.entries(helperSetup(config, queue))) {
    const reasons = helperReasons(h, o, { changedPaths, missionText });
    if (!reasons.length) continue;
    const there = out.find((x) => x.type === type);
    if (there) there.reasons.push(...reasons.filter((r) => !there.reasons.includes(r)));
    else out.push({ type, fixed: false, reasons });
  }
  return out;
}

/**
 * All reviewer types the queue knows: the fixed ones in every class and every helper (on or off, so earlier runs of a
 * helper that is now off are still counted). Used by the cost per task, the cost guard and the read guard.
 */
function allReviewerTypes(config) {
  const out = [];
  const add = (t) => {
    if (t && !out.includes(t)) out.push(t);
  };
  for (const l of Object.values(fixedSetup(config))) for (const t of list(l)) add(t);
  for (const t of Object.keys(isObject(config?.helpers) ? config.helpers : {})) if (NAME.test(t)) add(t);
  return out;
}

/** The classes where a helper is also a fixed reviewer (then the switch does not stop it there). */
function fixedClasses(config, name) {
  return Object.entries(fixedSetup(config))
    .filter(([, l]) => list(l).includes(name))
    .map(([k]) => k);
}

/** When the helper runs, in plain text: "class U · label bug", "files under docs/ or *.md are most of the diff". */
function conditionText(h) {
  const parts = [];
  if (h.classes.length) parts.push(`class ${h.classes.join(', ')}`);
  if (h.labels.length) parts.push(`label ${h.labels.join(', ')}`);
  if (h.paths.length) parts.push(`changes ${h.paths.join(', ')}`);
  if (h.mostlyPaths.length) parts.push(`most changed files match ${h.mostlyPaths.join(', ')}`);
  if (h.plan) parts.push('the task has a plan entry');
  if (h.minMissionItems) parts.push(`the mission has ${h.minMissionItems} or more numbered points`);
  return parts.length ? `When: ${parts.join(' or ')}.` : 'When: no condition set, so it never runs.';
}

const round = (x, d = 2) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const numbers = (xs) => xs.map(Number).filter((x) => Number.isFinite(x));
const stat = (xs, d) => {
  const v = numbers(xs);
  return v.length ? { n: v.length, median: round(median(v), d), sum: round(v.reduce((s, x) => s + x, 0), d) } : null;
};

/**
 * The measurement per helper over the finished tasks (cost.agents, saved at `set done` and `cost measure`): runs,
 * median and sum of minutes, tokens and USD, the share of the task cost it added (its USD over the total USD of the
 * tasks it ran on), and the findings from its FINDINGS lines. Tasks measured before this field existed have no minutes,
 * tokens or findings per agent; they count as runs and USD only.
 * @param {object} queue
 * @param {string[]} names the helpers to measure
 * @param {{ since?: string|null }} [o]
 * @returns {Record<string, { runs: number, tasks: number, minutes: object|null, tokens: object|null, usd: object|null,
 *   sharePct: number|null, findings: { H: number, M: number, L: number, reviewed: number, perRun: number|null } }>}
 */
function helperStatistics(queue, names, { since = null } = {}) {
  const done = (queue?.tasks ?? [])
    .filter((o) => o.status === 'done' && o.cost && Array.isArray(o.cost.agents))
    .filter((o) => !since || Date.parse(o.done ?? o.cost.measured) >= Date.parse(since));
  const out = {};
  for (const name of names) {
    const runs = [];
    let taskUsd = 0;
    let tasks = 0;
    for (const o of done) {
      const mine = o.cost.agents.filter((a) => a?.type === name);
      if (!mine.length) continue;
      tasks++;
      taskUsd += Number(o.cost.usd) || 0;
      runs.push(...mine);
    }
    const usd = stat(
      runs.map((a) => a.usd),
      2,
    );
    const withFindings = runs.filter((a) => isObject(a.findings));
    const f = { H: 0, M: 0, L: 0, reviewed: withFindings.length, perRun: null };
    for (const a of withFindings) for (const k of ['H', 'M', 'L']) f[k] += Number(a.findings[k]) || 0;
    if (f.reviewed) f.perRun = round((f.H + f.M + f.L) / f.reviewed, 1);
    out[name] = {
      runs: runs.length,
      tasks,
      minutes: stat(
        runs.map((a) => a.minutes),
        1,
      ),
      tokens: stat(
        runs.map((a) => a.tokens),
        0,
      ),
      usd,
      sharePct: usd && taskUsd > 0 ? round((usd.sum / taskUsd) * 100, 1) : null,
      findings: f,
    };
  }
  return out;
}

const EMPTY = 'No runs yet';

/** "1.2M" / "850k" / "900" tokens. */
function tokenText(n) {
  if (n == null) return '?';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** The measurement in one line ("No runs yet" when the helper has none). */
function measurementText(s) {
  if (!s || !s.runs) return EMPTY;
  const parts = [`${s.runs} run(s) on ${s.tasks} task(s)`];
  if (s.minutes) parts.push(`${s.minutes.median} min median, ${s.minutes.sum} min total`);
  if (s.tokens) parts.push(`${tokenText(s.tokens.median)} tokens median, ${tokenText(s.tokens.sum)} total`);
  if (s.usd) parts.push(`$${s.usd.median} median, $${s.usd.sum} total`);
  if (s.sharePct != null) parts.push(`${s.sharePct} % of the task cost`);
  parts.push(
    s.findings.reviewed
      ? `findings H=${s.findings.H} M=${s.findings.M} L=${s.findings.L} (${s.findings.perRun} per run)`
      : 'no FINDINGS lines measured',
  );
  return parts.join(' · ');
}

/**
 * The rows for the board tab and `cq helpers`: one per helper, with the switch, the condition text, the classes where
 * it is also fixed, and the measurement.
 */
function helperRows(config, queue) {
  const setup = helperSetup(config, queue);
  const names = Object.keys(setup);
  const st = helperStatistics(queue, names);
  return names.map((name) => {
    const h = setup[name];
    return {
      name,
      title: h.title,
      text: h.text,
      source: h.source,
      path: h.path,
      sha256: h.sha256,
      enabled: h.enabled,
      switchedInQueue: h.switchedInQueue,
      when: conditionText(h),
      fixedIn: fixedClasses(config, name),
      stats: st[name],
      measurement: measurementText(st[name]),
    };
  });
}

/** Validates `cq helpers on|off <agent>`: the helper must be in the setup. */
function parseSwitch(mode, name, config) {
  if (mode !== 'on' && mode !== 'off') return { error: 'use: cq helpers on|off <agent>' };
  const n = String(name ?? '');
  if (!NAME.test(n)) return { error: `invalid agent name "${n}"` };
  const known = Object.keys(isObject(config?.helpers) ? config.helpers : {});
  if (!known.includes(n))
    return { error: `${n} is not a helper (known: ${known.join(', ') || 'none'}; add it under helpers in queue.config.json)` };
  return { name: n, enabled: mode === 'on' };
}

module.exports = {
  CATALOG,
  DEFAULT_REVIEWERS,
  EMPTY,
  pathPattern,
  matchesAny,
  missionItems,
  helperSetup,
  helperSource,
  fixedFor,
  helperReasons,
  reviewersForTask,
  allReviewerTypes,
  fixedClasses,
  conditionText,
  helperStatistics,
  measurementText,
  helperRows,
  parseSwitch,
};
