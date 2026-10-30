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
//     `source: "custom"` (an agent file of the project's own, with `path` and `sha256` of that file). Conditions, the
//     switch and the measurement are the same for both.
//     The on/off switch the owner flips (`cq helpers on|off <agent>`, the board's "Helper agents" tab) is stored in
//     queue.json (`helpers.<agent>.enabled`) and wins over queue.config.json, like `cq limit` does for the limits.
//   - custom helpers: `cq helpers add <file.md>` registers one in queue.json (`helpers.<agent>` with source custom,
//     path, sha256, added_at, its conditions, enabled false). It is only ON when the owner approved the file as it is
//     now: `cq helpers approve` stores approved_sha256 (queue.json only; queue.config.json can never approve), and the
//     caller passes the current sha256 per custom helper (`hashes`, lib/helperFiles.js). Never approved, changed since
//     approval, missing, or not checked = off in the selection, whatever the switch or the config says.
//
// reviewersForTask() is used by `cq receive` (the reviewer prompts and the review package), allReviewerTypes() by the
// cost per task, the cost guard and the read guard. helperStatistics() is the measurement (runs, minutes, tokens, USD,
// share of the task cost, findings per run) in the board tab, `cq helpers` and `cq cost`.
//
// Pure logic (no file I/O), tested in lib/__tests__/queueHelpers.test.ts and helperCustom.test.ts.
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

/** Is this queue.json entry a custom helper registered with `cq helpers add` (not only a switch)? */
const isRegistered = (r) => isObject(r) && r.source === 'custom';

/** The registration fields a `cq helpers add` record carries into the setup (conditions, path, hash, texts). */
const REGISTRATION_KEYS = ['source', 'path', 'sha256', 'title', 'text', 'classes', 'labels', 'paths', 'mostlyPaths', 'plan', 'minMissionItems'];

/**
 * The review state of a custom helper: is the file on disk the one the owner approved?
 *   approved      the current sha256 (and path) equals the approved one
 *   needs-review  never approved
 *   changed       approved, but the file (or its path) has changed since: approve again after a new review
 *   missing       the file is not there (or the path points outside the project)
 *   unverified    the caller gave no current hashes, so nothing is known: treated as not approved (fail closed)
 * Only queue.json (`helpers.<name>`, written by `cq helpers approve` under the lock) can hold an approval; an
 * approval field in queue.config.json is never read, so a branch cannot approve its own helper.
 * @param {{ path: string|null }} src helperSource()
 * @param {object|undefined} rec the helper's entry in queue.json
 * @param {string|null|undefined} current the file's sha256 now (null = missing, undefined = not given)
 */
function reviewState(src, rec, current) {
  if (current === undefined) return 'unverified';
  if (current === null || !src.path) return 'missing';
  const r = isObject(rec) ? rec : {};
  if (!r.approved_sha256) return 'needs-review';
  if (String(r.approved_sha256).toLowerCase() !== String(current).toLowerCase()) return 'changed';
  if (r.approved_path && norm(r.approved_path) !== src.path) return 'changed';
  return 'approved';
}

/** The review state in words, for `cq helpers` and the board. */
const REVIEW_TEXT = Object.freeze({
  approved: 'Approved',
  'needs-review': 'Needs review',
  changed: 'Changed since approval',
  missing: 'File missing',
  unverified: 'Not verified',
});

/**
 * The helpers in effect: config().helpers (already merged with the defaults by queueConfig) and the custom helpers
 * registered in queue.json (`cq helpers add`), with the switches in queue.json (`helpers.<agent>.enabled`) on top.
 * Names that are not valid agent names are skipped.
 *
 * A custom helper is only on when the owner approved the file as it is now: `hashes` gives the current sha256 per
 * custom helper (lib/helperFiles.js currentHashes; null = the file is missing). Without it, or with another hash than
 * the approved one, the helper is off whatever the switch says (`wantedOn` keeps what the switch says).
 * @param {object} config
 * @param {object|null} [queue]
 * @param {{ hashes?: Record<string, string|null>|null }} [o]
 * @returns {Record<string, ReturnType<typeof cleanHelper> & { switchedInQueue: boolean, wantedOn: boolean, title: string,
 *   text: string, source: string, path: string|null, sha256: string|null, review: string|null }>}
 */
function helperSetup(config, queue = null, { hashes = null } = {}) {
  const own = isObject(config?.helpers) ? config.helpers : {};
  const switches = isObject(queue?.helpers) ? queue.helpers : {};
  const names = [...Object.keys(own), ...Object.keys(switches).filter((n) => !(n in own) && isRegistered(switches[n]))];
  const out = {};
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const s = switches[name];
    // A registered custom helper takes its conditions and texts from its queue.json record (`cq helpers when`).
    const h = isRegistered(s)
      ? { ...(isObject(own[name]) ? own[name] : {}), ...Object.fromEntries(REGISTRATION_KEYS.filter((k) => k in s).map((k) => [k, s[k]])) }
      : own[name];
    const c = cleanHelper(h);
    const switchedInQueue = isObject(s) && typeof s.enabled === 'boolean';
    if (switchedInQueue) c.enabled = s.enabled;
    const src = helperSource(name, h);
    const wantedOn = c.enabled;
    let review = null;
    let current = null;
    if (src.source === 'custom') {
      current = isObject(hashes) && name in hashes ? hashes[name] : undefined;
      review = reviewState(src, s, current);
      if (review !== 'approved') c.enabled = false;
    }
    const r = isObject(s) ? s : {};
    out[name] = {
      ...c,
      switchedInQueue,
      wantedOn,
      ...src,
      registered: isRegistered(s),
      review,
      currentSha256: typeof current === 'string' ? current.toLowerCase() : null,
      approvedSha256: src.source === 'custom' && typeof r.approved_sha256 === 'string' ? r.approved_sha256 : null,
      approvedBy: src.source === 'custom' && typeof r.approved_by === 'string' ? r.approved_by : null,
      approvedAt: src.source === 'custom' && typeof r.approved_at === 'string' ? r.approved_at : null,
      addedAt: typeof r.added_at === 'string' ? r.added_at : null,
      scan: src.source === 'custom' && isObject(r.scan) ? r.scan : null,
      title: (isObject(h) && typeof h.title === 'string' && h.title) || CATALOG[name]?.title || name,
      text:
        (isObject(h) && typeof h.text === 'string' && h.text) ||
        CATALOG[name]?.text ||
        (isRegistered(s) ? 'A custom helper agent of the project.' : 'A helper agent from queue.config.json.'),
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

/**
 * The custom helpers whose switch is on in queue.json but which are not approved for the file as it is now (changed,
 * missing or never approved). `cq helpers` and `cq receive` turn these off in queue.json, so a file that is changed
 * back later does not silently come back on.
 */
function switchesToTurnOff(setup) {
  return Object.entries(setup ?? {})
    .filter(([, h]) => h.source === 'custom' && h.switchedInQueue && h.wantedOn && h.review && !['approved', 'unverified'].includes(h.review))
    .map(([name, h]) => ({ name, review: h.review }));
}

/** The agent files of the custom helpers (project relative): merge-track protects them like .claude/. */
function customPaths(setup) {
  return Object.values(setup ?? {})
    .filter((h) => h.source === 'custom' && h.path)
    .map((h) => h.path);
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
 * A custom helper is never chosen without a valid approval for its file as it is now (`hashes`, see helperSetup), not
 * even when the config says enabled or lists it as a fixed reviewer for the class. `custom: true` on a reviewer means
 * the agent lives in the project's .claude/agents/ (started by its bare name).
 * @param {object} o the task
 * @param {{ config: object, queue?: object|null, changedPaths?: string[], missionText?: string|null,
 *   hashes?: Record<string, string|null>|null }} c
 * @returns {{ type: string, fixed: boolean, reasons: string[], custom?: boolean }[]}
 */
function reviewersForTask(o, { config, queue = null, changedPaths = [], missionText = null, hashes = null }) {
  const setup = helperSetup(config, queue, { hashes });
  const blocked = (type) => setup[type]?.source === 'custom' && setup[type].review !== 'approved';
  const out = fixedFor(config, o?.class)
    .filter((type) => !blocked(type))
    .map((type) => ({ type, fixed: true, reasons: [`class ${o?.class}`], ...(setup[type]?.source === 'custom' ? { custom: true } : {}) }));
  for (const [type, h] of Object.entries(setup)) {
    if (blocked(type)) continue;
    const reasons = helperReasons(h, o, { changedPaths, missionText });
    if (!reasons.length) continue;
    const there = out.find((x) => x.type === type);
    if (there) there.reasons.push(...reasons.filter((r) => !there.reasons.includes(r)));
    else out.push({ type, fixed: false, reasons, ...(h.source === 'custom' ? { custom: true } : {}) });
  }
  return out;
}

/**
 * All reviewer types the queue knows: the fixed ones in every class and every helper (on or off, so earlier runs of a
 * helper that is now off are still counted), also the custom helpers registered in queue.json when `queue` is given.
 * Used by the cost per task, the cost guard and the read guard.
 */
function allReviewerTypes(config, queue = null) {
  const out = [];
  const add = (t) => {
    if (t && !out.includes(t)) out.push(t);
  };
  for (const l of Object.values(fixedSetup(config))) for (const t of list(l)) add(t);
  for (const t of Object.keys(isObject(config?.helpers) ? config.helpers : {})) if (NAME.test(t)) add(t);
  for (const [t, r] of Object.entries(isObject(queue?.helpers) ? queue.helpers : {}))
    if (NAME.test(t) && isRegistered(r)) add(t);
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
 * it is also fixed, and the measurement. A custom helper also has its review state (`review`, `reviewText`), who
 * approved it and when, the last scan (level and counts) and `canEnable` (approved for the file as it is now).
 * @param {object} config
 * @param {object} queue
 * @param {{ hashes?: Record<string, string|null>|null }} [o] the current sha256 per custom helper (helperFiles.js)
 */
function helperRows(config, queue, { hashes = null } = {}) {
  const setup = helperSetup(config, queue, { hashes });
  const names = Object.keys(setup);
  const st = helperStatistics(queue, names);
  return names.map((name) => {
    const h = setup[name];
    const custom = h.source === 'custom';
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
      review: h.review,
      reviewText: custom ? REVIEW_TEXT[h.review] ?? h.review : null,
      canEnable: !custom || h.review === 'approved',
      approvedBy: h.approvedBy,
      approvedAt: h.approvedAt,
      addedAt: h.addedAt,
      scan: h.scan ? { level: h.scan.level, red: h.scan.red, yellow: h.scan.yellow, at: h.scan.at, current: h.scan.sha256 === h.currentSha256 } : null,
    };
  });
}

/** Why a custom helper cannot be switched on, in one sentence with what to do (null when it can). */
function enableBlock(name, h) {
  if (!h || h.source !== 'custom' || h.review === 'approved') return null;
  const how = `have Claude review it (cq helpers scan ${name}, then read the file), then cq helpers approve ${name}`;
  if (h.review === 'changed') return `${name} changed since approval: ${how}.`;
  if (h.review === 'missing') return `${name}: the agent file ${h.path ?? '(no path)'} is missing.`;
  if (h.review === 'unverified') return `${name}: the agent file could not be checked against its approval.`;
  return `${name} needs review before it can be on: ${how}.`;
}

/**
 * Validates `cq helpers on|off <agent>`: the helper must be in the setup, and a custom helper can only be switched on
 * when it is approved for the file as it is now. `setup` = helperSetup(config, queue, { hashes }); without it the
 * config's helpers only, and no custom helper can be switched on (nothing verified).
 */
function parseSwitch(mode, name, config, setup = null) {
  if (mode !== 'on' && mode !== 'off') return { error: 'use: cq helpers on|off <agent>' };
  const n = String(name ?? '');
  if (!NAME.test(n)) return { error: `invalid agent name "${n}"` };
  const s = setup ?? helperSetup(config, null);
  const known = Object.keys(s);
  if (!known.includes(n))
    return {
      error: `${n} is not a helper (known: ${known.join(', ') || 'none'}; add it under helpers in queue.config.json, or cq helpers add <file.md>)`,
    };
  if (mode === 'on') {
    const block = enableBlock(n, s[n]);
    if (block) return { error: block };
  }
  return { name: n, enabled: mode === 'on' };
}

/**
 * Agent names a custom helper can never take: Claude Code's own agents, the agents the plugin ships, and the fixed
 * reviewers. A custom file with one of these names would shadow (or be shadowed by) the real one.
 */
const RESERVED = Object.freeze([
  'general-purpose',
  'explore',
  'plan',
  'statusline-setup',
  'output-style-setup',
  'claude-code-guide',
  'track',
  'track-d',
  'reviewer',
  'reviewer-security',
  ...Object.keys(CATALOG),
]);

/**
 * Validates the name for `cq helpers add`: a valid agent name, not reserved, not a fixed reviewer, not already in the
 * setup (builtin or custom), and no agent file with that name in the project yet.
 * @param {string} name
 * @param {{ config: object, setup: object, fileExists?: boolean, pluginAgents?: string[] }} c
 */
function checkNewName(name, { config, setup, fileExists = false, pluginAgents = [] }) {
  const n = String(name ?? '');
  if (!NAME.test(n)) return { error: `invalid agent name "${n}" (letters, digits and -, at most 64)` };
  const lower = n.toLowerCase();
  const reserved = [...RESERVED, ...list(pluginAgents), ...allReviewerTypes({ reviewers: fixedSetup(config) })];
  if (reserved.some((r) => r.toLowerCase() === lower))
    return { error: `${n} is a builtin agent name; choose another with --name` };
  if (Object.keys(setup ?? {}).some((k) => k.toLowerCase() === lower))
    return { error: `${n} is already a helper (cq helpers remove ${n} first, or choose another --name)` };
  if (fileExists) return { error: `.claude/agents/${n}.md already exists; choose another --name` };
  return { name: n };
}

/** A list flag value: "a,b" and repeated values both work; "none" (or "-") clears the list. */
function splitList(values) {
  const out = list(values)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  return out.length === 1 && (out[0] === 'none' || out[0] === '-') ? [] : out;
}

/** The project relative path the agent file of a custom helper is copied to (where Claude Code finds project agents). */
const agentFile = (name) => `.claude/agents/${name}.md`;

/**
 * The agent text with `name: <name>` in the frontmatter, so Claude Code starts it under the registered name (the
 * subagent_type is the frontmatter name, not the file name). Everything else is kept byte for byte.
 * @returns {string|null} null when the text has no frontmatter
 */
function withAgentName(text, name) {
  const src = String(text ?? '');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  if (lines[0]?.replace(/^\uFEFF/, '').trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const at = lines.findIndex((l, i) => i > 0 && i < end && /^name\s*:/.test(l));
  if (at > 0) lines[at] = `name: ${name}`;
  else lines.splice(1, 0, `name: ${name}`);
  return lines.join(nl);
}

module.exports = {
  CATALOG,
  DEFAULT_REVIEWERS,
  EMPTY,
  REVIEW_TEXT,
  RESERVED,
  pathPattern,
  matchesAny,
  missionItems,
  helperSetup,
  helperSource,
  reviewState,
  switchesToTurnOff,
  customPaths,
  fixedFor,
  helperReasons,
  reviewersForTask,
  allReviewerTypes,
  fixedClasses,
  conditionText,
  helperStatistics,
  measurementText,
  helperRows,
  enableBlock,
  parseSwitch,
  checkNewName,
  splitList,
  agentFile,
  withAgentName,
};
