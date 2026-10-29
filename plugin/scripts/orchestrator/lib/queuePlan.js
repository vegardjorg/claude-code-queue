// =============================================================
// queuePlan.js: pure logic for the plan register (scripts/.queue/plans.json), used by `queue.mjs plan …`.
//
// See docs/plan-register.md for the data model, the derived maturity, the commands and the priority rules.
// The register is its own file next to queue.json, so plan work never bumps the queue's version.
// The writing (lock, atomic write, --expect-changed, changelog) happens in queue.mjs; here are only pure functions
// that take data in and give data out, tested in lib/__tests__/queuePlan*.test.ts. No file or network access:
// whatever needs the file system (does a sourcePath exist?) is passed in as a function. The project-specific parts
// (modules, the priority rules, the vendors in the document check) come from queue.config.json via queueConfig.js.
//
// Also: link queueTask → planEntry (`add --plan`, linkPlan), the `plan` phase on projects, modules (MODULES)
// and the hygiene in `plan check` (check). `plan backup` is pure I/O and lives in queue.mjs.
//
// Legal: validation of the legal field (validateLegal), the legal points across entries,
// privacy per module, ownerDecisions with their sorting, launchOverview and the lawyer package (text only).
//
// File (plans.json):
//   { version: 1, created, changed, entries: [planEntry], archive: { <id>: planEntry }, changelog: [entry] }
//   entries        the plan entries. The ids are stable and are never reused.
//   archive        entries merged into another one (`merged_to`). Nothing is deleted; the id stays taken.
//   changelog      the last CHANGELOG_MAX writes (field by field), so `plan undo` can roll back.
//   active_session (optional) the "Working now" markers [{ entry, at, by }] from `plan active`.
//
// The hierarchy: module (queue.json `areas`) → project (queue.json `projects`, with `area`) → planEntry → queueTask
// (queue.json `tasks`, with the field `plan`). Modules and projects are created with `queue.mjs area` and `queue.mjs project`.
// =============================================================

'use strict';

const { config } = require('./queueConfig.js');

// ---- Value lists ---------------------------------------------------------------------------------------

/** The priorities, in display order (Now first, Drop last). `owner` = waiting for an owner decision. */
const PRIORITIES = ['now', 'owner', 'later', 'drop'];
/** The subcategories of Now (several are allowed). */
const NOW_CATEGORIES = ['security', 'for-prod', 'important'];
/** Who set the priority. An agent never changes an owner-set priority (exception: rule 1, security). */
const SET_BY = ['agent', 'owner'];
/** Maturity levels set during plan work. */
const MATURITY_MANUAL = ['idea', 'investigated', 'planned', 'ready'];
/** Maturity levels derived from the queue and the verification; never set by hand. */
const MATURITY_DERIVED = ['in-queue', 'partial', 'built', 'verified'];
const MATURITIES = [...MATURITY_MANUAL, ...MATURITY_DERIVED];
/** Rough size: S (under half a day), M (1 to 3 tracks), L (4 to 10), XL (module). */
const SIZES = ['S', 'M', 'L', 'XL'];
/** After this many days without verification an entry is stale. */
const STALE_DAYS = 30;
/** At most this many entries in the changelog (like the queue). */
const CHANGELOG_MAX = 50;
/** Plan entry id: PL-, then capital letters, digits and hyphens (e.g. PL-EXPORT-1, PL-API-2b). */
const ID_PATTERN = /^PL-[A-Z0-9\u00C6\u00D8\u00C5](?:[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5-]*[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5])?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The fields a planEntry may have. Anything else is rejected, so a typo does not become a new field. */
const FIELD = [
  'id',
  'title',
  'summary',
  'project',
  'priority',
  'now_category',
  'priority_reason',
  'priority_set_by',
  'maturity',
  'size',
  'sources',
  'roadmap',
  'depends_on',
  'deadline',
  'legal',
  'ownerQuestions',
  'verified',
  'drop_reason',
  'merged_from',
  'remark',
  // Set by the tool:
  'created',
  'agent_boost',
];
/** Fields the tool owns: cannot be set with `plan new` or `plan edit`. */
const TOOL_FIELD = new Set(['id', 'created', 'agent_boost', 'merged_from']);
/** Derived from queue.json (task.plan); never saved in the register. */
const DERIVED_FIELD = new Set(['queue_tasks']);

// ---- The priority rules as data ----------------------------------------------------------
//
// The rules apply top to bottom; the first rule that matches decides. `priority` and `categories` are what the rule
// gives (categories: one of them, depending on what the matter concerns). `measurement` is set for the rules that can
// be computed from the data alone (deadline and blocking); the others require judgement from the agent or the owner.
//
// DEFAULT_PRIORITY_RULES are generic. A project can swap them for its own list in queue.config.json
// (`priorityRules`, same shape: { nr, name, matches, priority, categories, measurement?, always? }). Rule no. 1 is
// always the security rule: the only one an agent can use to raise a priority the owner has set.
const DEFAULT_PRIORITY_RULES = Object.freeze([
  {
    nr: 1,
    name: 'Security',
    matches:
      'Security holes, data leaking between customers or users, exposed secrets, findings of severity HIGH or CRITICAL',
    priority: 'now',
    categories: ['security'],
    always: true,
  },
  {
    nr: 2,
    name: 'Calendar deadline',
    matches: 'Calendar deadline within 60 days (law, agreement, authority, vendor)',
    priority: 'now',
    categories: ['for-prod', 'important'],
    measurement: { deadline_days: 60 },
  },
  {
    nr: 3,
    name: 'Before launch',
    matches:
      'What must be in place before launch or the first customer: legal requirements, agreements and terms, privacy, whatever blocks a pilot, errors that give a bad first impression',
    priority: 'now',
    categories: ['for-prod'],
  },
  {
    nr: 4,
    name: 'Blocks others',
    matches: 'Blocks two or more other plan entries, or a project in the current focus',
    priority: 'now',
    categories: ['important'],
    measurement: { blocks_min: 2 },
  },
  {
    nr: 5,
    name: 'Does not work as documented',
    matches: 'Something that is built does not work as documented (status deviation, known error for users)',
    priority: 'now',
    categories: ['important'],
  },
  {
    nr: 6,
    name: 'Owner option',
    matches:
      'Needs a decision only the owner can make (price, vendor, risk acceptance, scope), or two plans disagree',
    priority: 'owner',
    categories: [],
  },
  {
    nr: 7,
    name: 'Drop',
    matches:
      'Replaced by a newer plan, covered by something that is built, conflicts with a decision, or low value and high cost',
    priority: 'drop',
    categories: [],
  },
  {
    nr: 8,
    name: 'Later',
    matches:
      'New modules and extensions without a deadline, performance and cost before a problem has been measured, large entries (L/XL) without a concrete need',
    priority: 'later',
    categories: [],
  },
]);

/**
 * The priority rules in effect: `priorityRules` in queue.config.json when it is a non-empty list, otherwise
 * DEFAULT_PRIORITY_RULES. Read again on every call (config() caches the file).
 */
function priorityRules() {
  const ownOnes = config().priorityRules;
  return Array.isArray(ownOnes) && ownOnes.length ? ownOnes : DEFAULT_PRIORITY_RULES;
}

// ---- Small helpers ----------------------------------------------------------------------------------------------

/** Deep copy of a JSON value; undefined becomes null. */
function cloneJson(x) {
  return x === undefined ? null : JSON.parse(JSON.stringify(x));
}

/** JSON with sorted keys, so equal objects always compare equal. */
function stableJson(x) {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (x && typeof x === 'object')
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(x[k])}`)
      .join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

/** Equal values? null and a missing field are the same. */
function equalValue(a, b) {
  return stableJson(a ?? null) === stableJson(b ?? null);
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Today's date in local time (YYYY-MM-DD). */
function osloDate(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now instanceof Date ? now : new Date(now));
}

/** A valid calendar date in the form YYYY-MM-DD? */
function validDate(s) {
  if (typeof s !== 'string' || !DATE_PATTERN.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Whole days from date a to date b (both YYYY-MM-DD). */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** An empty register (a new plans.json). */
function emptyRegister(now = new Date().toISOString()) {
  return { version: 1, created: now, changed: now, entries: [], archive: {}, changelog: [] };
}

/** The register with the standard fields in place (an old or empty file works). */
function normalize(reg) {
  const r = isObject(reg) ? reg : {};
  return {
    ...r,
    version: r.version ?? 1,
    entries: Array.isArray(r.entries) ? r.entries : [],
    archive: isObject(r.archive) ? r.archive : {},
    changelog: Array.isArray(r.changelog) ? r.changelog : [],
    // the document register; an older file without the field gets an empty list.
    documents: Array.isArray(r.documents) ? r.documents : [],
  };
}

/** Is the id used (in entries or in the archive)? Ids are never reused. */
function idUsed(reg, id) {
  return (reg.entries ?? []).some((p) => p.id === id) || Object.hasOwn(reg.archive ?? {}, id);
}

/** The plan entry with the id, or null. */
function findEntry(reg, id) {
  return (reg.entries ?? []).find((p) => p.id === id) ?? null;
}

/** The module (area) an entry belongs to, via the project's `area`. */
function moduleFor(entry, projects) {
  return projects?.[entry?.project]?.area ?? null;
}

// ---- Validation --------------------------------------------------------------------------------------------------

/**
 * Is a sourcePath safe to look up? Relative to the project root, forward slashes, no `..` and no absolute path.
 * @returns {string|null} the error text, or null
 */
function sourcePathError(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return 'missing path';
  if (/^[A-Za-z]:|^[\\/]/.test(filePath))
    return `${filePath}: must be relative to the project root (e.g. docs/…)`;
  if (filePath.includes('\\')) return `${filePath}: use slash /, not \\`;
  if (filePath.split('/').some((d) => d === '..' || d === '.'))
    return `${filePath}: . and .. are not allowed in a path`;
  return null;
}

/**
 * Validates a whole planEntry as it will be saved.
 * @param {object} entry
 * @param {{ projects?: object, entries?: object[], question?: object, existsPath?: (path: string) => boolean }} ctx
 *   projects: queue.json `projects`; entries: the other entries in the register (for depends_on); question: queue.json
 *   `question` (the owner questions); existsPath: checks that a sourcePath exists (omitted = not checked).
 * @returns {{ error: string[], warnings: string[] }}
 */
function validateEntry(entry, ctx = {}) {
  const error = [];
  const warnings = [];
  if (!isObject(entry)) return { error: ['planEntry must be an object'], warnings };
  const who = typeof entry.id === 'string' ? entry.id : '(no id)';
  const f = (t) => error.push(`${who}: ${t}`);
  const adv = (t) => warnings.push(`${who}: ${t}`);

  for (const k of Object.keys(entry))
    if (!FIELD.includes(k)) f(`unknown field ${k} (allowed: ${FIELD.join(', ')})`);

  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id))
    f('id must look like PL-NAME-1 (PL-, capital letters, digits and hyphens)');
  if (!text(entry.title)) f('title missing');
  else if (entry.title.length > 160) f('title is over 160 characters (summary is the place for more)');
  if (entry.summary != null && typeof entry.summary !== 'string') f('summary must be text');
  if (entry.remark != null && typeof entry.remark !== 'string') f('remark must be text');

  // The project must exist (the module follows from the project's area).
  if (!text(entry.project))
    f('project missing (create it with cq project <pid> --title "…")');
  else if (!Object.hasOwn(ctx.projects ?? {}, entry.project))
    f(
      `unknown project ${entry.project} (create it first: cq project ${entry.project} --title "…")`,
    );
  else if (!ctx.projects[entry.project]?.area)
    adv(
      `the project ${entry.project} has no module (cq project ${entry.project} --area <oid>)`,
    );

  // Priority, category, reason and who set it.
  if (!PRIORITIES.includes(entry.priority)) f(`priority must be one of ${PRIORITIES.join(', ')}`);
  if (entry.now_category != null) {
    if (!Array.isArray(entry.now_category)) f('now_category must be a list');
    else {
      for (const k of entry.now_category)
        if (!NOW_CATEGORIES.includes(k))
          f(`unknown now_category ${k} (allowed: ${NOW_CATEGORIES.join(', ')})`);
      if (entry.now_category.length && entry.priority !== 'now')
        f('now_category is only used when priority is now');
    }
  }
  if (entry.priority === 'now' && !(entry.now_category ?? []).length)
    adv('now without a category (security, for-prod or important)');
  if (entry.priority === 'drop' && !text(entry.drop_reason))
    f('drop requires one sentence as the reason (drop_reason)');
  if (entry.priority !== 'drop' && entry.drop_reason != null)
    f('drop_reason is only used when priority is drop');
  if (entry.priority === 'owner' && !(entry.ownerQuestions ?? []).length)
    adv('owner without a linked owner question (ownerQuestions)');
  if (!SET_BY.includes(entry.priority_set_by))
    f(`priority_set_by must be ${SET_BY.join(' or ')}`);
  if (entry.priority_reason != null && typeof entry.priority_reason !== 'string')
    f('priority_reason must be text');
  if (entry.priority_set_by === 'agent' && !text(entry.priority_reason))
    f('an agent must give priority_reason (one sentence: which priority rule and why)');
  const ruleCheck = ruleAgainstPriority(entry);
  error.push(...ruleCheck.error.map((t) => `${who}: ${t}`));
  warnings.push(...ruleCheck.warnings.map((t) => `${who}: ${t}`));

  // Maturity: only the manual levels are set; in-queue, partial, built and verified are derived.
  if (entry.maturity == null) f(`maturity missing (${MATURITY_MANUAL.join(', ')})`);
  else if (MATURITY_DERIVED.includes(entry.maturity))
    f(
      `maturity ${entry.maturity} is derived from the queue and the verification; set ${MATURITY_MANUAL.join(', ')}`,
    );
  else if (!MATURITY_MANUAL.includes(entry.maturity))
    f(`unknown maturity ${entry.maturity} (allowed: ${MATURITY_MANUAL.join(', ')})`);

  if (entry.size != null && !SIZES.includes(entry.size))
    f(`size must be one of ${SIZES.join(', ')}`);

  // The sources must exist. A plan entry points to documents, it does not copy them.
  if (entry.sources != null && !Array.isArray(entry.sources)) f('sources must be a list');
  for (const k of Array.isArray(entry.sources) ? entry.sources : []) {
    if (!isObject(k)) {
      f('every source must be { path, anchor?, role? }');
      continue;
    }
    for (const n of Object.keys(k))
      if (!['path', 'anchor', 'role'].includes(n)) f(`source ${k.path ?? '?'}: unknown field ${n}`);
    const sf = sourcePathError(k.path);
    if (sf) f(`source ${sf}`);
    else if (ctx.existsPath && !ctx.existsPath(k.path)) f(`source ${k.path} does not exist`);
    if (k.anchor != null && typeof k.anchor !== 'string') f(`source ${k.path}: anchor must be text`);
    if (k.role != null && typeof k.role !== 'string') f(`source ${k.path}: role must be text`);
  }

  for (const field of ['roadmap', 'depends_on', 'ownerQuestions', 'merged_from']) {
    const v = entry[field];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim()))
      f(`${field} must be a list of text`);
  }
  const others = new Set((ctx.entries ?? []).map((p) => p.id));
  for (const d of Array.isArray(entry.depends_on) ? entry.depends_on : []) {
    if (d === entry.id) f('depends_on on itself');
    else if (ctx.entries && !others.has(d)) f(`depends_on on unknown planEntry ${d}`);
  }
  for (const s of Array.isArray(entry.ownerQuestions) ? entry.ownerQuestions : [])
    if (ctx.question && !Object.hasOwn(ctx.question, s))
      adv(`ownerQuestion ${s} is not in the queue (cq question ${s} --text "…")`);

  if (entry.deadline != null && !validDate(entry.deadline))
    f('deadline must be a date (YYYY-MM-DD) or null');
  // the legal field is validated field by field, and a point id can only be used in one entry.
  if (entry.legal != null) {
    const others = new Map();
    for (const q of ctx.entries ?? [])
      if (q?.id !== entry.id)
        for (const pk of q?.legal?.points ?? []) if (pk?.id) others.set(pk.id, q.id);
    const j = validateLegal(entry.legal, { otherPoints: others });
    for (const t of j.error) f(t);
    for (const t of j.warnings) adv(t);
  }
  if (entry.verified != null) {
    const v = entry.verified;
    if (!isObject(v) || !validDate(v.date) || !text(v.findings) || !SET_BY.includes(v.by))
      f('verified must be { date: YYYY-MM-DD, commit?, by: agent|owner, findings }');
  }
  return { error, warnings };
}

/**
 * Does the priority match the rule `priority_reason` refers to ("Rule 3: …")? A reason without a rule number is accepted.
 * A wrong priority is an error (the code and the plan must not diverge); a wrong category is a warning.
 */
function ruleAgainstPriority(entry) {
  const error = [];
  const warnings = [];
  const nr = ruleNrFromReason(entry?.priority_reason);
  if (nr == null) return { error, warnings };
  const rule = priorityRules().find((r) => r.nr === nr);
  if (!rule) {
    error.push(
      `priority_reason refers to rule ${nr}, but the rules are 1 to ${priorityRules().length}`,
    );
    return { error, warnings };
  }
  if (rule.priority !== entry.priority)
    error.push(
      `priority_reason refers to rule ${nr} (${rule.name}), which gives ${rule.priority}, not ${entry.priority}`,
    );
  else if (
    rule.categories.length &&
    !(entry.now_category ?? []).some((k) => rule.categories.includes(k))
  )
    warnings.push(
      `rule ${nr} (${rule.name}) gives Now with category ${rule.categories.join(' or ')}`,
    );
  return { error, warnings };
}

/** The rule number in a priority_reason ("Rule 3: …" or "rule 3"), or null. */
function ruleNrFromReason(reason) {
  const m = /\brule\s+(\d+)/i.exec(String(reason ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * The rule the data alone points to (only the rules with `measurement`: deadline and blocking),
 * or null. The judgement rules are for the agent or the owner to assess. Rule 1 always wins: if
 * security is the category, this gives rule 1.
 * @returns {{ nr: number, name: string, priority: string, category: string|null, reason: string }|null}
 */
function measuredRule(entry, entries, { now = new Date() } = {}) {
  if ((entry?.now_category ?? []).includes('security') && entry.priority === 'now') {
    const r = priorityRules()[0];
    return {
      nr: r.nr,
      name: r.name,
      priority: r.priority,
      category: 'security',
      reason: 'category security',
    };
  }
  for (const r of priorityRules()) {
    if (!r.measurement) continue;
    if (r.measurement.deadline_days != null && entry?.deadline && validDate(entry.deadline)) {
      const days = daysBetween(osloDate(now), entry.deadline);
      if (days <= r.measurement.deadline_days)
        return {
          nr: r.nr,
          name: r.name,
          priority: r.priority,
          category: null,
          reason:
            days < 0
              ? `the deadline ${entry.deadline} has passed`
              : `deadline in ${days} days (${entry.deadline})`,
        };
    }
    if (r.measurement.blocks_min != null) {
      const n = blocks(entry, entries).length;
      if (n >= r.measurement.blocks_min)
        return {
          nr: r.nr,
          name: r.name,
          priority: r.priority,
          category: 'important',
          reason: `blocks ${n} entries`,
        };
    }
  }
  return null;
}

/** Entries (not dropped) that depend on this one. */
function blocks(entry, entries) {
  return (entries ?? []).filter(
    (p) => p.id !== entry?.id && p.priority !== 'drop' && (p.depends_on ?? []).includes(entry?.id),
  );
}

// ---- Priority changes: the limits for the agent -----------------------------------------------------------

/**
 * May `role` change the priority from `old` to `new`? An agent never changes an owner-set priority, with one exception
 * (rule 1): a security finding can raise the entry to Now with category security. That gives `boost: true` (shown in
 * the inbox, the field agent_boost).
 * @returns {{ error: string|null, boost: boolean }}
 */
function priorityAccess(old, fresh, role) {
  if (role === 'owner' || !old || old.priority_set_by !== 'owner')
    return { error: null, boost: false };
  const changed =
    old.priority !== fresh.priority ||
    !equalValue(old.now_category ?? [], fresh.now_category ?? []);
  if (!changed) return { error: null, boost: false };
  if (fresh.priority === 'now' && (fresh.now_category ?? []).includes('security'))
    return { error: null, boost: true };
  return {
    error:
      `${old.id}: the priority (${old.priority}) is set by the owner, and an agent does not change it. ` +
      'The exception is rule 1: a security finding can raise the entry to now with category security.',
    boost: false,
  };
}

// ---- Create and edit --------------------------------------------------------------------------------------------

/**
 * Creates a new planEntry in the register (mutates `reg` only when everything is valid). `role` is the caller (agent or
 * owner); priority_set_by becomes the role. An agent cannot create an owner-set priority.
 * @param {object} reg the register (normalized)
 * @param {object} input the fields from `plan new --file`
 * @param {{ role?: 'agent'|'owner', projects?: object, question?: object, existsPath?: Function, now?: string }} ctx
 * @returns {{ error: string[], warnings: string[], entry?: object }}
 */
function newEntry(reg, input, ctx = {}) {
  const role = ctx.role === 'owner' ? 'owner' : 'agent';
  if (!isObject(input)) return { error: ['planEntry must be an object'], warnings: [] };
  const error = [];
  const warnings = [];
  const who = typeof input.id === 'string' ? input.id : '(no id)';
  if (typeof input.id === 'string' && idUsed(reg, input.id))
    error.push(`${who}: the id is already used (ids are never reused)`);
  for (const k of Object.keys(input)) {
    if (DERIVED_FIELD.has(k))
      warnings.push(`${who}: ${k} is derived from the queue (task.plan) and is not saved`);
    else if (TOOL_FIELD.has(k) && k !== 'id') error.push(`${who}: ${k} is set by the tool`);
  }
  if (input.priority_set_by === 'owner' && role !== 'owner')
    error.push(
      `${who}: an agent cannot set priority_set_by owner (use --set-by owner when the owner decides)`,
    );
  const entry = {};
  for (const [k, v] of Object.entries(input)) {
    if (DERIVED_FIELD.has(k) || v === undefined) continue;
    entry[k] = cloneJson(v);
  }
  entry.priority_set_by = role;
  if (entry.maturity == null) entry.maturity = 'idea';
  entry.created = ctx.now ?? new Date().toISOString();
  const v = validateEntry(entry, {
    projects: ctx.projects,
    entries: reg.entries,
    question: ctx.question,
    existsPath: ctx.existsPath,
  });
  error.push(...v.error);
  warnings.push(...v.warnings);
  if (error.length) return { error, warnings };
  reg.entries.push(entry);
  return { error: [], warnings, entry };
}

/**
 * Changes the fields of one planEntry (`plan edit`, `plan prioritize`, `plan verify`). `field` is { name: val }, where
 * null removes the field. Mutates only when the result is valid. The priority fields follow the limits for the agent.
 * @returns {{ error: string[], warnings: string[], entry?: object, changed?: string[], boost?: boolean }}
 */
function editEntry(reg, id, field, ctx = {}) {
  const role = ctx.role === 'owner' ? 'owner' : 'agent';
  const i = (reg.entries ?? []).findIndex((p) => p.id === id);
  if (i < 0)
    return {
      error: [
        reg.archive?.[id]
          ? `${id} is merged into ${reg.archive[id].merged_to}`
          : `unknown planEntry ${id}`,
      ],
      warnings: [],
    };
  if (!isObject(field)) return { error: [`${id}: the fields must be an object`], warnings: [] };
  const old = reg.entries[i];
  const error = [];
  const warnings = [];
  for (const k of Object.keys(field)) {
    if (DERIVED_FIELD.has(k)) error.push(`${id}: ${k} is derived from the queue and is not changed here`);
    else if (TOOL_FIELD.has(k) || k === 'priority_set_by')
      error.push(`${id}: ${k} is set by the tool`);
  }
  if (error.length) return { error, warnings };
  const fresh = cloneJson(old);
  for (const [k, v] of Object.entries(field)) {
    if (v === null || v === undefined) delete fresh[k];
    else fresh[k] = cloneJson(v);
  }
  // If the priority changes away from now or drop, the category or the drop reason goes with it (unless the caller
  // has set them itself).
  if (fresh.priority !== 'now' && !('now_category' in field)) delete fresh.now_category;
  if (fresh.priority !== 'drop' && !('drop_reason' in field)) delete fresh.drop_reason;
  const priorityChanged =
    old.priority !== fresh.priority ||
    !equalValue(old.now_category ?? [], fresh.now_category ?? []);
  let boost = false;
  if (priorityChanged) {
    const t = priorityAccess(old, fresh, role);
    if (t.error) return { error: [t.error], warnings };
    boost = t.boost;
    fresh.priority_set_by = role;
    // A new priority needs a new reason from an agent (the reason for the old one no longer applies). The owner needs
    // no reason, but the old one is not carried over.
    if (!('priority_reason' in field)) delete fresh.priority_reason;
    if (role === 'agent' && !('priority_reason' in field))
      error.push(
        `${id}: new priority requires priority_reason (one sentence: which priority rule and why)`,
      );
    if (boost)
      fresh.agent_boost = {
        at: ctx.now ?? new Date().toISOString(),
        by: ctx.by ?? 'agent',
        from: { priority: old.priority, now_category: old.now_category ?? null },
      };
    else if (role === 'owner') delete fresh.agent_boost;
  } else if (
    role === 'agent' &&
    old.priority_set_by === 'owner' &&
    !equalValue(old.priority_reason, fresh.priority_reason)
  )
    return {
      error: [`${id}: priority_reason belongs to the owner's priority, and an agent does not change it`],
      warnings,
    };
  const v = validateEntry(fresh, {
    projects: ctx.projects,
    entries: reg.entries.filter((p) => p.id !== id),
    question: ctx.question,
    existsPath: ctx.existsPath,
  });
  error.push(...v.error);
  warnings.push(...v.warnings);
  if (error.length) return { error, warnings };
  const changed = [...new Set([...Object.keys(old), ...Object.keys(fresh)])].filter(
    (k) => !equalValue(old[k], fresh[k]),
  );
  reg.entries[i] = fresh;
  return { error: [], warnings, entry: fresh, changed, boost };
}

/**
 * The fields a priority change sets (shared by `prioritize` and `prioritizeMany`), or null when a category is given
 * for a priority other than now.
 * @param {{ priority: string, category?: string[]|null, reason?: string|null }} option
 */
function priorityField(option) {
  const field = { priority: option.priority };
  if (option.priority === 'now') field.now_category = option.category?.length ? option.category : null;
  else if (option.category?.length) return null;
  if (option.priority === 'drop') field.drop_reason = option.reason ?? null;
  if (option.reason != null) field.priority_reason = option.reason;
  return field;
}

/**
 * Bulk edit of priority (`plan prioritize <id…> <priority>`). All or nothing: if one entry fails, none is changed.
 * @param {{ priority: string, category?: string[]|null, reason?: string|null }} option
 * @returns {{ error: string[], warnings: string[], changed: string[], unchanged: string[], boost: string[] }}
 */
function prioritize(reg, ids, option, ctx = {}) {
  const error = [];
  const warnings = [];
  const changed = [];
  const unchanged = [];
  const boost = [];
  if (!PRIORITIES.includes(option?.priority))
    return {
      error: [`priority must be one of ${PRIORITIES.join(', ')}`],
      warnings,
      changed,
      unchanged,
      boost,
    };
  if (!ids?.length) return { error: ['no plan entries selected'], warnings, changed, unchanged, boost };
  const copy = cloneJson(reg);
  for (const id of [...new Set(ids)]) {
    const field = priorityField(option);
    if (!field) {
      error.push(`--category is only used with now`);
      break;
    }
    const r = editEntry(copy, id, field, ctx);
    error.push(...r.error);
    warnings.push(...r.warnings);
    if (r.error.length) continue;
    if (r.changed.length) changed.push(id);
    else unchanged.push(id);
    if (r.boost) boost.push(id);
  }
  if (error.length) return { error, warnings, changed: [], unchanged: [], boost: [] };
  reg.entries = copy.entries;
  return { error, warnings, changed, unchanged, boost };
}

/**
 * Many priority changes in one write (`plan prioritize-many --file <json>`), the way priorityMap saves
 * a whole draft: one lock, one changelog entry and one undo. Each element is { id, priority, category?, reason? } and
 * is handled like `prioritize` for that one entry (same access rules and validation). All or nothing: if one
 * element is invalid, or one entry fails, none is changed.
 * @param {{ id: string, priority: string, category?: string[]|null, reason?: string|null }[]} list
 * @returns {{ error: string[], warnings: string[], changed: string[], unchanged: string[], boost: string[] }}
 */
function prioritizeMany(reg, list, ctx = {}) {
  const error = [];
  const warnings = [];
  const empty = () => ({ error, warnings, changed: [], unchanged: [], boost: [] });
  if (!Array.isArray(list) || !list.length) {
    error.push('the file must be a non-empty list of { id, priority, category?, reason? }');
    return empty();
  }
  // The shape first, for the whole list, so the owner sees all the errors at once.
  const set = new Set();
  list.forEach((x, i) => {
    const where = `element ${i + 1}`;
    if (!isObject(x))
      return void error.push(`${where}: must be { id, priority, category?, reason? }`);
    for (const n of Object.keys(x))
      if (!['id', 'priority', 'category', 'reason'].includes(n))
        error.push(`${where}: unknown field ${n}`);
    if (typeof x.id !== 'string' || !x.id) error.push(`${where}: id missing`);
    else if (set.has(x.id)) error.push(`${x.id}: appears more than once in the list`);
    else set.add(x.id);
    if (!PRIORITIES.includes(x.priority))
      error.push(`${x.id ?? where}: priority must be one of ${PRIORITIES.join(', ')}`);
    if (
      x.category != null &&
      !(Array.isArray(x.category) && x.category.every((k) => typeof k === 'string'))
    )
      error.push(`${x.id ?? where}: category must be a list of text`);
    if (x.reason != null && typeof x.reason !== 'string')
      error.push(`${x.id ?? where}: reason must be text`);
  });
  if (error.length) return empty();

  const changed = [];
  const unchanged = [];
  const boost = [];
  const copy = cloneJson(reg);
  for (const x of list) {
    const field = priorityField({
      priority: x.priority,
      category: x.category,
      reason: x.reason ?? null,
    });
    if (!field) {
      error.push(`${x.id}: category is only used with now`);
      continue;
    }
    const r = editEntry(copy, x.id, field, ctx);
    error.push(...r.error);
    warnings.push(...r.warnings);
    if (r.error.length) continue;
    if (r.changed.length) changed.push(x.id);
    else unchanged.push(x.id);
    if (r.boost) boost.push(x.id);
  }
  if (error.length) return empty();
  reg.entries = copy.entries;
  return { error, warnings, changed, unchanged, boost };
}

/**
 * Sets `verified` (`plan verify <id> --findings "…"`): today's date (Norwegian time), commit and who. `ctx` as in editEntry
 * (projects, question, existsPath), so the validation of the entry is the same.
 */
function verify(
  reg,
  id,
  { findings, commit = null, role = 'agent', now = new Date() } = {},
  ctx = {},
) {
  if (!text(findings))
    return {
      error: [`${id}: --findings missing (short: what was checked against the code and what was found)`],
      warnings: [],
    };
  const v = { date: osloDate(now), by: role === 'owner' ? 'owner' : 'agent', findings: findings.trim() };
  if (commit) v.commit = String(commit).trim();
  // Verification is not a priority change: the role plays no part in the access here.
  return editEntry(reg, id, { verified: v }, { ...ctx, role: 'owner' });
}

/**
 * Merges the entries `from` into `to` (`plan combine <to> <from…>`). `to` gets the sources, roadmap anchors,
 * dependencies and owner questions of the others (without duplicates) and `merged_from`. The others move to
 * `archive` with `merged_to`, so the ids stay taken and can be looked up. Dependencies in other entries that
 * pointed to a merged entry point to `to` afterwards. Queue tasks with `plan: <old id>` are counted in `to`
 * (derivedMaturity). The priority of `to` is not changed.
 */
function combineTogether(reg, to, from, { now = new Date().toISOString() } = {}) {
  const error = [];
  const measure = findEntry(reg, to);
  if (!measure) error.push(`unknown planEntry ${to}`);
  const others = [...new Set(from ?? [])];
  if (!others.length) error.push('give at least one entry to merge into the first');
  for (const id of others) {
    if (id === to) error.push(`${id} cannot be merged with itself`);
    else if (!findEntry(reg, id)) error.push(`unknown planEntry ${id}`);
  }
  if (error.length) return { error, warnings: [] };
  const fresh = cloneJson(measure);
  const union = (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])];
  const sources = [...(fresh.sources ?? [])];
  for (const id of others) {
    const p = findEntry(reg, id);
    for (const k of p.sources ?? [])
      if (!sources.some((x) => x.path === k.path && (x.anchor ?? null) === (k.anchor ?? null)))
        sources.push(cloneJson(k));
    fresh.roadmap = union(fresh.roadmap, p.roadmap);
    fresh.depends_on = union(fresh.depends_on, p.depends_on);
    fresh.ownerQuestions = union(fresh.ownerQuestions, p.ownerQuestions);
    fresh.merged_from = union(fresh.merged_from, [id, ...(p.merged_from ?? [])]);
  }
  if (sources.length) fresh.sources = sources;
  const out = new Set([to, ...others]);
  fresh.depends_on = (fresh.depends_on ?? []).filter((d) => !out.has(d));
  for (const field of ['roadmap', 'depends_on', 'ownerQuestions']) if (!fresh[field]?.length) delete fresh[field];
  const entries = [];
  for (const p of reg.entries) {
    if (others.includes(p.id)) {
      reg.archive[p.id] = { ...cloneJson(p), merged_to: to, merged_at: now };
      continue;
    }
    if (p.id === to) {
      entries.push(fresh);
      continue;
    }
    if ((p.depends_on ?? []).some((d) => others.includes(d))) {
      const q = cloneJson(p);
      q.depends_on = [...new Set(q.depends_on.map((d) => (others.includes(d) ? to : d)))].filter(
        (d) => d !== q.id,
      );
      if (!q.depends_on.length) delete q.depends_on;
      entries.push(q);
    } else entries.push(p);
  }
  reg.entries = entries;
  return { error: [], warnings: [], entry: fresh, archived: others };
}

// ---- Derived maturity -----------------------------------------------------------------------------------

/** The ids that count for an entry: the entry itself and the entries merged into it (recursively). */
function planIds(entry) {
  return new Set([entry.id, ...(entry.merged_from ?? [])]);
}

/**
 * The queue tasks that belong to the entry (task.plan = the entry's id, or an id merged into it).
 * Cancelled ones do not count.
 */
function queueTasksFor(entry, tasks) {
  const ids = planIds(entry);
  return (tasks ?? []).filter((o) => o?.plan && ids.has(o.plan) && o.status !== 'cancelled');
}

/** Is the verification stale: over STALE_DAYS days old? (Changed files are checked in `plan check`.) */
function isStale(entry, { now = new Date() } = {}) {
  const d = entry?.verified?.date;
  if (!d || !validDate(d)) return false;
  return daysBetween(d, osloDate(now)) > STALE_DAYS;
}

/**
 * The maturity as displayed:
 * - no tasks: the maturity from the plan work,
 * - at least one open and none done: in-queue,
 * - some done and some open: partial (a fraction, e.g. 3/7),
 * - all done: built; verified when the entry is verified the same day as or after the last finished task
 *   and the verification is not stale.
 * @returns {{ maturity: string, finished: number, total: number, fraction: string|null, queue_tasks: string[],
 *   stale: boolean }}
 */
function derivedMaturity(entry, tasks, { now = new Date() } = {}) {
  const list = queueTasksFor(entry, tasks);
  const total = list.length;
  const finished = list.filter((o) => o.status === 'done').length;
  const stale = isStale(entry, { now });
  const out = { finished, total, fraction: null, queue_tasks: list.map((o) => o.id), stale };
  if (!total) return { ...out, maturity: entry.maturity ?? 'idea' };
  if (finished === 0) return { ...out, maturity: 'in-queue' };
  if (finished < total) return { ...out, maturity: 'partial', fraction: `${finished}/${total}` };
  const lastDone = list
    .map((o) => (o.done ? osloDate(new Date(o.done)) : null))
    .filter(Boolean)
    .sort()
    .pop();
  const vdate = entry.verified?.date;
  const verified = vdate && !stale && (!lastDone || vdate >= lastDone);
  return { ...out, maturity: verified ? 'verified' : 'built' };
}

// ---- Sorting, filtering and fetching --------------------------------------------------------------------------------

/**
 * Sorting: priority (Now, Owner, Later, Drop), then deadline (earliest first, no deadline last), then the number of
 * entries blocked (most first), then small size first, then id.
 */
function sortEntries(entries) {
  const all = entries ?? [];
  const block = new Map(all.map((p) => [p.id, blocks(p, all).length]));
  const pri = (p) => {
    const i = PRIORITIES.indexOf(p.priority);
    return i < 0 ? PRIORITIES.length : i;
  };
  const est = (p) => {
    const i = SIZES.indexOf(p.size);
    return i < 0 ? SIZES.length : i;
  };
  return [...all].sort(
    (a, b) =>
      pri(a) - pri(b) ||
      (a.deadline ?? '9999-12-31').localeCompare(b.deadline ?? '9999-12-31') ||
      block.get(b.id) - block.get(a.id) ||
      est(a) - est(b) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Filter for `plan show`. Dropped entries are hidden by default and included when the filter asks for drop
 * or `all` is set. The search is case-insensitive, in id, title, summary, remark, roadmap anchors,
 * source paths and project.
 * @param {{ module?: string|null, project?: string|null, priority?: string[], maturity?: string[], search?: string|null,
 *   all?: boolean }} filter
 * @returns {object[]} entries with `derived` and `module`, sorted (sortEntries)
 */
function filterEntries(reg, queue, filter = {}, { now = new Date() } = {}) {
  const projects = queue?.projects ?? {};
  const search = text(filter.search).toLowerCase();
  const pri = filter.priority?.length ? new Set(filter.priority) : null;
  const mod = filter.maturity?.length ? new Set(filter.maturity) : null;
  const out = [];
  for (const p of sortEntries(reg.entries)) {
    if (p.priority === 'drop' && !filter.all && !pri?.has('drop')) continue;
    if (pri && !pri.has(p.priority)) continue;
    if (filter.project && p.project !== filter.project) continue;
    const modName = moduleFor(p, projects);
    if (filter.module && modName !== filter.module) continue;
    const derived = derivedMaturity(p, queue?.tasks, { now });
    if (mod && !mod.has(derived.maturity)) continue;
    if (search) {
      const hay = [
        p.id,
        p.title,
        p.summary,
        p.remark,
        p.project,
        ...(p.roadmap ?? []),
        ...(p.sources ?? []).map((k) => k.path),
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!hay.includes(search)) continue;
    }
    out.push({ ...p, module: modName, derived });
  }
  return out;
}

/**
 * Everything `/plans` needs about an entry, a project or a module (`plan get <id|project|module>`): entries with
 * derived maturity, the sources (do they exist?), queue status, the owner questions with text and whether they are
 * resolved, and legal points. The copy lines contain only ids and titles.
 * @param {{ existsPath?: Function, now?: Date }} ctx
 * @returns {{ error: string[], type?: 'entry'|'project'|'module', sortKey?: string, title?: string|null,
 *   entries?: object[], copy?: string }}
 */
function get(reg, queue, sortKey, ctx = {}) {
  const projects = queue?.projects ?? {};
  const areas = queue?.areas ?? {};
  const now = ctx.now ?? new Date();
  let type;
  let selection;
  let title = null;
  if (findEntry(reg, sortKey)) {
    type = 'entry';
    selection = [findEntry(reg, sortKey)];
    title = selection[0].title;
  } else if (reg.archive?.[sortKey]) {
    return { error: [`${sortKey} is merged into ${reg.archive[sortKey].merged_to}`] };
  } else if (Object.hasOwn(projects, sortKey)) {
    type = 'project';
    selection = reg.entries.filter((p) => p.project === sortKey);
    title = projects[sortKey]?.title ?? null;
  } else if (Object.hasOwn(areas, sortKey)) {
    type = 'module';
    selection = reg.entries.filter((p) => moduleFor(p, projects) === sortKey);
    title = areas[sortKey]?.title ?? null;
  } else return { error: [`found no plan entry, project or module named ${sortKey}`] };

  const perId = new Map((queue?.tasks ?? []).map((o) => [o.id, o]));
  const resolved = new Set(queue?.resolved ?? []);
  const entries = sortEntries(selection).map((p) => {
    const derived = derivedMaturity(p, queue?.tasks, { now });
    return {
      ...cloneJson(p),
      module: moduleFor(p, projects),
      derived,
      sources: (p.sources ?? []).map((k) => ({
        ...k,
        exists: ctx.existsPath ? Boolean(ctx.existsPath(k.path)) : null,
      })),
      queue: derived.queue_tasks.map((id) => {
        const o = perId.get(id);
        return { id, title: o?.title ?? null, status: o?.status ?? null };
      }),
      ownerQuestion: (p.ownerQuestions ?? []).map((s) => ({
        id: s,
        text: queue?.question?.[s]?.text ?? null,
        resolved: resolved.has(s),
        answer: queue?.resolutions?.[s]?.answer ?? null,
      })),
      legal: p.legal ?? null,
      blocks: blocks(p, reg.entries).map((q) => q.id),
      measured_rule: measuredRule(p, reg.entries, { now }),
    };
  });
  return {
    error: [],
    type,
    sortKey,
    title,
    entries,
    copy: copyLine(type, sortKey, title, entries),
  };
}

/** The start line for Claude Code: only ids and titles, never content from documents. */
function copyLine(type, sortKey, title, entries) {
  const what = type === 'entry' ? 'plan entry' : type === 'project' ? 'project' : 'module';
  const ids =
    type === 'entry'
      ? ''
      : ` (${entries.length} entries: ${entries
          .map((p) => p.id)
          .slice(0, 12)
          .join(', ')}${entries.length > 12 ? ', …' : ''})`;
  return `/plans ${sortKey}: work on ${what} "${title ?? sortKey}"${ids}`;
}

// ---- Changelog and undo (like the queue) -----------------------------------------------------------------------------

/**
 * The difference between two versions of the register, field by field per entry (`collection: 'entries'`) and per
 * archive entry (`collection: 'archive'`). An entry that appears or disappears gives one change with `field: '*'`
 * (the whole entry). Documents (`collection: 'documents'`) the same way.
 * @returns {{ collection: 'entries'|'archive'|'documents', id: string, field: string, before: unknown, after: unknown }[]}
 */
function planDiff(forReg, afterReg) {
  const out = [];
  const forP = new Map((forReg?.entries ?? []).map((p) => [p.id, p]));
  const afterP = new Map((afterReg?.entries ?? []).map((p) => [p.id, p]));
  const compare = (collection, f, e) => {
    for (const id of [...new Set([...f.keys(), ...e.keys()])]) {
      const a = f.get(id);
      const b = e.get(id);
      if (!a || !b) {
        if (!equalValue(a, b))
          out.push({ collection, id, field: '*', before: cloneJson(a ?? null), after: cloneJson(b ?? null) });
        continue;
      }
      for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
        if (!equalValue(a[field], b[field]))
          out.push({
            collection,
            id,
            field,
            before: cloneJson(a[field] ?? null),
            after: cloneJson(b[field] ?? null),
          });
    }
  };
  compare('entries', forP, afterP);
  // the document register, with the same shape (field by field per document).
  compare(
    'documents',
    new Map((forReg?.documents ?? []).map((d) => [d.id, d])),
    new Map((afterReg?.documents ?? []).map((d) => [d.id, d])),
  );
  compare(
    'archive',
    new Map(Object.entries(forReg?.archive ?? {})),
    new Map(Object.entries(afterReg?.archive ?? {})),
  );
  return out;
}

/** Adds an entry to the register's changelog; null when nothing changed. */
function logChange(reg, { by = null, action, changes, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(changes) || !changes.length) return null;
  const log = Array.isArray(reg.changelog) ? reg.changelog : [];
  const nr = log.reduce((m, p) => Math.max(m, Number(p?.nr) || 0), 0) + 1;
  const entry = {
    nr,
    at: now,
    by: String(by ?? '').trim() || 'unknown',
    action: String(action ?? 'unknown'),
    changes: cloneJson(changes),
  };
  log.push(entry);
  reg.changelog = log.slice(-CHANGELOG_MAX);
  return entry;
}

/** The last changelog entry that is not undone, or null. */
function lastUndoable(reg) {
  const log = Array.isArray(reg?.changelog) ? reg.changelog : [];
  for (let i = log.length - 1; i >= 0; i -= 1) if (!log[i]?.undone) return log[i];
  return null;
}

/**
 * Rolls back the last changelog entry that is not undone (`plan undo`). Refuses when a field no longer has the
 * value the entry set (someone has changed it since). The log entry stays, marked `undone`. Undone entries keep
 * their order; an entry that comes back (from a merge) is put last. `show` checks without editing.
 * @returns {{ error: string[], entry?: object, show?: boolean }}
 */
function undo(reg, { by = null, now = new Date().toISOString(), show = false } = {}) {
  const entry = lastUndoable(reg);
  if (!entry)
    return { error: ['nothing to undo (the changelog is empty, or everything in it is undone)'] };
  const entries = new Map(cloneJson(reg.entries ?? []).map((p) => [p.id, p]));
  const sequence = (reg.entries ?? []).map((p) => p.id);
  const archive = new Map(Object.entries(cloneJson(reg.archive ?? {})));
  const documents = new Map(cloneJson(reg.documents ?? []).map((d) => [d.id, d]));
  const docSequence = (reg.documents ?? []).map((d) => d.id);
  const error = [];
  for (const e of entry.changes ?? []) {
    const m = e.collection === 'archive' ? archive : e.collection === 'documents' ? documents : entries;
    const nowValue = e.field === '*' ? (m.get(e.id) ?? null) : (m.get(e.id)?.[e.field] ?? null);
    if (e.field !== '*' && !m.has(e.id)) {
      error.push(`${e.id}: no longer exists`);
      continue;
    }
    if (!equalValue(nowValue, e.after)) {
      error.push(`${e.id} ${e.field === '*' ? '(whole entry)' : e.field} has changed since`);
      continue;
    }
    if (e.field === '*') {
      if (e.before == null) m.delete(e.id);
      else {
        m.set(e.id, cloneJson(e.before));
        if (m === entries && !sequence.includes(e.id)) sequence.push(e.id);
        if (m === documents && !docSequence.includes(e.id)) docSequence.push(e.id);
      }
    } else if (e.before == null) delete m.get(e.id)[e.field];
    else m.get(e.id)[e.field] = cloneJson(e.before);
  }
  if (error.length) return { error, entry };
  if (show) return { error: [], entry, show: true };
  reg.entries = sequence.filter((id) => entries.has(id)).map((id) => entries.get(id));
  reg.archive = Object.fromEntries(archive);
  if (Array.isArray(reg.documents) || documents.size)
    reg.documents = docSequence.filter((id) => documents.has(id)).map((id) => documents.get(id));
  entry.undone = { at: now, by: String(by ?? '').trim() || 'unknown' };
  return { error: [], entry };
}

/** Optimistic concurrency for the register: null when it has not changed after `expect`, otherwise the error text. */
function expectCheck(reg, expectValue) {
  if (expectValue == null) return null;
  const f = Date.parse(String(expectValue));
  if (!Number.isFinite(f))
    return `invalid --expect-changed ${expectValue} (ISO time, the field changed in plans.json)`;
  const e = Date.parse(String(reg?.changed ?? ''));
  if (Number.isFinite(e) && e > f)
    return `the plan register was changed ${reg.changed}, after ${expectValue} that the preview was built on. Fetch it again and review the change again.`;
  return null;
}

/**
 * Parses `--field name=val` (repeatable). The value is read as JSON when it is valid JSON (number, list, object, null,
 * true/false, "text"), otherwise as text. An empty value (`name=`) removes the field.
 * @returns {{ field: object, error: string[] }}
 */
function parseFieldArg(list) {
  const field = {};
  const error = [];
  for (const s of list ?? []) {
    const i = String(s).indexOf('=');
    if (i <= 0) {
      error.push(`--field ${s}: use name=val`);
      continue;
    }
    const name = s.slice(0, i).trim();
    const raw = s.slice(i + 1);
    if (raw === '') {
      field[name] = null;
      continue;
    }
    try {
      field[name] = JSON.parse(raw);
    } catch {
      field[name] = raw;
    }
  }
  return { field, error };
}

// ---- Modules ---------------------------------------------------------------------------------------------------
//
// Modules are areas in queue.json (`areas`). Which modules the project has is set in queue.config.json (`modules`:
// [{ oid, title, description }]); the default in queueConfig.js is an example module and "No fixed module".
// `queue.mjs plan modules` creates the missing ones; an existing area is never changed (the owner may have given it
// another title). The order in the list is the order the modules are shown in.

/** Modules from the configuration (an empty or invalid list gives no modules). */
function modules() {
  const m = config().modules;
  return Array.isArray(m) ? m.filter((x) => x && typeof x.oid === 'string') : [];
}

/**
 * Suggested module per project id (queue.config.json `projectModuleSuggestion`: { <pid>: <oid> }). Only used with
 * `queue.mjs plan modules --link`, and only for projects that do not have a module yet.
 */
function projectModuleSuggestion() {
  const f = config().projectModuleSuggestion;
  return isObject(f) ? f : {};
}

/**
 * What `plan modules` will do: modules missing from `areas`, the ones that exist (unchanged, with their title), and
 * with `link` the projects without a module that get the suggestion from projectModuleSuggestion().
 * Modules and suggestions can be passed in (tests); otherwise they come from the configuration.
 * @returns {{ newOnes: object[], exists: { oid: string, title: string|null }[], link: { pid: string, oid: string }[] }}
 */
function modulePlan(queue, { link = false, list = modules(), proposed = projectModuleSuggestion() } = {}) {
  const areas = queue?.areas ?? {};
  const newOnes = list.filter((m) => !Object.hasOwn(areas, m.oid)).map((m) => ({ ...m }));
  const exists = list.filter((m) => Object.hasOwn(areas, m.oid)).map((m) => ({
    oid: m.oid,
    title: areas[m.oid]?.title ?? null,
  }));
  const out = [];
  if (link)
    for (const [pid, p] of Object.entries(queue?.projects ?? {})) {
      const oid = Object.hasOwn(proposed, pid) ? proposed[pid] : null;
      if (oid && !p?.area) out.push({ pid, oid });
    }
  return { newOnes, exists, link: out };
}

// ---- The project phase ----------------------------------------------------------------------------------------

/** Valid values for the project's `phase`. `plan`: the project exists in the plan work, but has no queue tasks yet. */
const PROJECT_PHASES = ['plan'];

/**
 * Projects with `phase: plan` that get queue tasks now (add), so the phase is removed in the same write. The phase
 * only means "no queue tasks yet".
 */
function phasePlanEnds(projects, newOnes) {
  const out = new Set();
  for (const n of newOnes ?? []) {
    const pid = n?.project;
    if (pid && projects?.[pid]?.phase === 'plan') out.add(pid);
  }
  return [...out];
}

// ---- Link queueTask → planEntry (`add --plan`) -------------------------------------------------------------

/** The error text when `planId` is not a planEntry in the register (archived entries point to the target), otherwise null. */
function planLinkError(reg, planId) {
  if (typeof planId !== 'string' || !ID_PATTERN.test(planId))
    return `plan ${String(planId)}: must be a plan entry id (PL-NAME-1)`;
  if (findEntry(reg, planId)) return null;
  if (reg?.archive?.[planId])
    return `planEntry ${planId} is merged into ${reg.archive[planId].merged_to}; use that one`;
  return `unknown planEntry ${planId} (create it first: cq plan new --file <json>)`;
}

/**
 * Links new queue tasks to plan entries (`add --plan <id>` and the field `plan` in the add file). `planId` is set on
 * tasks without their own `plan`. Refuses an unknown or merged planEntry (all or nothing). If the task has no project,
 * it gets the entry's project (every task gets plan, project and source). Warns when the entry is not ready, is
 * dropped, or belongs to another project than the task. The entry becomes in-queue by itself (derivedMaturity).
 * @returns {{ error: string[], warnings: string[], tasks: object[] }} tasks as copies with the fields set
 */
function linkPlan(reg, newOnes, planId = null) {
  const error = [];
  const warnings = [];
  const tasks = [];
  const notified = new Set();
  for (const n of newOnes ?? []) {
    const o = isObject(n) ? { ...n } : n;
    if (!isObject(o)) {
      tasks.push(o);
      continue;
    }
    if (o.plan == null && planId) o.plan = planId;
    if (o.plan != null) {
      const who = o.id ?? '(no id)';
      const fe = planLinkError(reg, o.plan);
      if (fe) error.push(`${who}: ${fe}`);
      else {
        const entry = findEntry(reg, o.plan);
        if (!o.project && entry.project) o.project = entry.project;
        else if (o.project && entry.project && o.project !== entry.project)
          warnings.push(
            `${who}: project ${o.project}, but planEntry ${entry.id} belongs to ${entry.project}`,
          );
        if (!notified.has(entry.id)) {
          notified.add(entry.id);
          if (entry.priority === 'drop')
            warnings.push(
              `planEntry ${entry.id} is dropped (${entry.drop_reason ?? 'no reason'}); bring it back with plan prioritize`,
            );
          else if (MATURITY_MANUAL.includes(entry.maturity) && entry.maturity !== 'ready')
            warnings.push(
              `planEntry ${entry.id} is ${entry.maturity}, not ready (check before packing)`,
            );
        }
      }
    }
    tasks.push(o);
  }
  return { error, warnings, tasks };
}

// ---- Hygiene: `plan check` ----------------------------------------------------------------------------------

/**
 * Rough number of queue tracks per size, for the capacity calculation (S under half a day, M 1 to 3 tracks, L 4 to
 * 10, XL a module). Rough on purpose; change it here.
 */
const SIZE_TRACK = { S: 1, M: 2, L: 7, XL: 15 };
/** The window (days) for the throughput in the capacity calculation. */
const CAPACITY_WINDOW_DAYS = 28;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Documents never counted as unregistered (overviews and agent instructions, not plans): README, CLAUDE.md and
 * the optional document index (queue.config.json `indexFile`, see queueIndex.js).
 */
function unregisteredException() {
  const out = [/(^|\/)README\.md$/i, /(^|\/)CLAUDE\.md$/];
  // Same rule as queueIndex.indexFile(): if the field is missing, docs/INDEX.md applies; null turns the index off.
  const raw = config().indexFile;
  const index =
    raw === null ? null : typeof raw === 'string' && raw.trim() ? raw.trim() : 'docs/INDEX.md';
  if (index) out.unshift(new RegExp(`^${escRe(index)}$`));
  return out;
}

/**
 * The folders `plan check` looks for documents in (relative to mainTree): queue.config.json `documentFolders`
 * (a list of folders), default ['docs'].
 */
function documentFolders() {
  const m = config().documentFolders;
  return Array.isArray(m) && m.length ? m.filter((x) => typeof x === 'string' && x.trim()) : ['docs'];
}
/** Threshold for two titles to count as possible duplicates (Jaccard on the words, at least three words). */
const DUPLICATE_SIMILARITY = 0.8;

const DONE_STATUS = /\bstatus\s*[:=]\s*\**\s*(done|built|delivered|implemented)\b/i;
const NOT_STARTED_STATUS =
  /\bstatus\s*[:=]\s*\**\s*(not\s+started|not\s+begun|not\s+built|planned|draft)\b/i;
const NOT_STARTED_PHRASE = /\bnot\s+(started|begun)\b/i;

/**
 * Source roles that are not plans for the entry (history, reference documents): they count as registered (the
 * unregistered list), but are never read for the status deviation, since a done or old document says nothing about the entry's status.
 */
const SOURCE_ROLES_WITHOUT_STATUS = ['history', 'reference'];
/** A section with more lines than this counts as a large section: only the top is read for status. */
const LARGE_SECTION_LINES = 25;
/** How many lines from the top of a large section are read for status. */
const LARGE_SECTION_TOP = 12;

/**
 * Does the heading match the anchor? "§ 3.4" matches both "§ 3.4" and "### 3.4 Maturity …". A number must stand alone:
 * "9.10" does not match "9.108" (otherwise the check would read a completely different roadmap section).
 */
function headingMatches(line, anchor) {
  const t = line.replace(/^#{1,6}\s+/, '').trim();
  const nr = anchor.replace(/^§\s*/, '');
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The anchor as its own "word": not followed by a digit or ".digit", not preceded by a digit or a letter.
  const alone = (x) => new RegExp(`(^|[^0-9A-Za-z\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5.])${esc(x)}(?![0-9]|\\.[0-9])`).test(t);
  return alone(anchor) || t === nr || t.startsWith(`${nr} `) || t.startsWith(`${nr}. `);
}

/**
 * The lines that belong to the anchor: the section under a heading with the anchor (with its subsections), otherwise
 * the lines that mention it. Also used by the view; the status deviation uses `anchorSection` (only the section's own text).
 */
function anchorText(text, anchor) {
  const s = anchorSection(text, anchor, { subsections: true });
  return s ? s.text : null;
}

/**
 * The section the anchor points to: `{ text, heading }`, where `heading` is true when the anchor hit a heading.
 * Without `subsections` the text stops at the first heading (also a deeper one), so status words in subsections about
 * other things are not read as the entry's status. If no heading matches, it is the rows that mention the anchor.
 */
function anchorSection(text, anchor, { subsections = false } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const a = text && anchor ? String(anchor).trim() : '';
  if (!a) return null;
  const isHeading = (l) => /^#{1,6}\s/.test(l);
  const i = lines.findIndex((l) => isHeading(l) && headingMatches(l, a));
  if (i >= 0) {
    const level = /^(#+)/.exec(lines[i])[1].length;
    const out = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const m = /^(#{1,6})\s/.exec(lines[j]);
      if (m && (m[1].length <= level || !subsections)) break;
      out.push(lines[j]);
    }
    return { text: out.join('\n'), heading: true };
  }
  const rows = lines.filter((l) => l.includes(a));
  return rows.length ? { text: rows.join('\n'), heading: false } : null;
}

/**
 * What the document says about status, for the status deviation in `plan check`: 'done', 'not-started' or null (says
 * nothing, or both). With an anchor only the section's own text is read (not the subsections), and in a large section
 * (over LARGE_SECTION_LINES lines, typically the roadmap) only the top; without an anchor the first 30 lines (the header),
 * since a whole plan nearly always has both finished and open parts. ✅ and ⬜ only count as a status badge first on a
 * line, in a list item or in a table cell, not inside running text (the "✅" metrics). Deliberately cautious: a
 * match is a hint to the owner, never a change.
 */
function docStatus(text, anchor = null) {
  if (typeof text !== 'string' || !text) return null;
  let chunk;
  if (anchor) {
    const s = anchorSection(text, anchor);
    if (!s) return null;
    const lines = s.text.split('\n');
    // A large section: only the top, where the status line sits. A "done" far down is usually about something else.
    chunk =
      s.heading && lines.length > LARGE_SECTION_LINES
        ? lines.slice(0, LARGE_SECTION_TOP).join('\n')
        : s.text;
  } else chunk = text.split(/\r?\n/).slice(0, 30).join('\n');
  if (!chunk) return null;
  const cross = (chunk.match(/^\s*[-*]\s+\[[xX]\]/gm) ?? []).length;
  const emptyOnes = (chunk.match(/^\s*[-*]\s+\[ \]/gm) ?? []).length;
  // The status badge first on the line, after a list marker or first in a table cell.
  const badge = (draw) => new RegExp(`(^|\\|)\\s*(?:[-*]\\s+)?(?:\\*\\*)?${draw}`, 'm').test(chunk);
  const checkmark = badge('✅');
  const box = badge('⬜');
  const done = DONE_STATUS.test(chunk) || (cross > 0 && emptyOnes === 0) || (checkmark && !box);
  const not =
    NOT_STARTED_STATUS.test(chunk) ||
    NOT_STARTED_PHRASE.test(chunk) ||
    (emptyOnes > 0 && cross === 0) ||
    (box && !checkmark);
  if (done === not) return null;
  return done ? 'done' : 'not-started';
}

/** The words in a title (lower case, without punctuation, at least three characters). */
function titleWord(t) {
  return new Set(
    String(t ?? '')
      .toLowerCase()
      .split(/[^a-z0-9\u00E6\u00F8\u00E5]+/)
      .filter((w) => w.length >= 3),
  );
}

/** Possible duplicates: similar titles (Jaccard ≥ DUPLICATE_SIMILARITY on at least three words) or the same source and anchor. */
function duplicates(entries) {
  const out = [];
  const list = (entries ?? []).filter((p) => p.priority !== 'drop');
  const word = new Map(list.map((p) => [p.id, titleWord(p.title)]));
  for (let i = 0; i < list.length; i += 1)
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const oa = word.get(a.id);
      const ob = word.get(b.id);
      const common = [...oa].filter((w) => ob.has(w)).length;
      const union = new Set([...oa, ...ob]).size;
      if (Math.min(oa.size, ob.size) >= 3 && union && common / union >= DUPLICATE_SIMILARITY) {
        out.push({ ids: [a.id, b.id], reason: 'nearly identical titles' });
        continue;
      }
      const sourceA = new Set((a.sources ?? []).map((k) => `${k.path}#${k.anchor ?? ''}`));
      const together = (b.sources ?? []).find((k) => sourceA.has(`${k.path}#${k.anchor ?? ''}`));
      if (together)
        out.push({
          ids: [a.id, b.id],
          reason: `same source ${together.path}${together.anchor ? ` ${together.anchor}` : ''}`,
        });
    }
  return out;
}

/**
 * The capacity: how many queue tracks the Now entries need (SIZE_TRACK, minus finished queue tasks, at least the open ones),
 * against how many queue tasks get finished per week. Built and verified entries do not count.
 * @returns {{ entries: number, track: number, without_size: string[], per_week: number|null, weeks: number|null,
 *   text: string }}
 */
function capacity(reg, queue, { donePerWeek = null, now = new Date() } = {}) {
  let track = 0;
  let entries = 0;
  const withoutSize = [];
  for (const p of reg.entries ?? []) {
    if (p.priority !== 'now') continue;
    const by = derivedMaturity(p, queue?.tasks, { now });
    if (by.maturity === 'built' || by.maturity === 'verified') continue;
    entries += 1;
    const est = SIZE_TRACK[p.size];
    if (est == null) {
      withoutSize.push(p.id);
      continue;
    }
    track += Math.max(est - by.finished, by.total - by.finished);
  }
  const perWeek = Number.isFinite(donePerWeek) && donePerWeek > 0 ? donePerWeek : null;
  const weeks = perWeek ? Math.round((track / perWeek) * 10) / 10 : null;
  const text = !entries
    ? 'No open entries in Now.'
    : perWeek
      ? `Now is about ${String(weeks).replace('.', ',')} weeks at the current pace (${track} tracks in ${entries} entries, ` +
        `${String(Math.round(perWeek * 10) / 10).replace('.', ',')} finished queue tasks per week)` +
        `${withoutSize.length ? `; ${withoutSize.length} without a size are not counted` : ''}.`
      : `Now is ${track} tracks in ${entries} entries; the pace is unknown (no finished queue tasks in the last ${CAPACITY_WINDOW_DAYS} days).`;
  return { entries, track, without_size: withoutSize, per_week: perWeek, weeks, text };
}

/** Is the path a document that no entry needs to point to? */
const isExempt = (filePath) => unregisteredException().some((re) => re.test(filePath));

/**
 * The hygiene in `plan check`, without editing anything. Whatever needs the file system or git is passed in:
 * @param {{ documents?: string[], existsPath?: (path: string) => boolean, readDoc?: (path: string) => string|null,
 *   changedFiles?: (files: string[], from: { date: string, commit?: string|null }) => string[],
 *   donePerWeek?: number|null, projectFor?: (task: object) => string|null, now?: Date }} ctx
 *   documents: the .md files in documentFolders() (relative paths); readDoc: the text of a source; changedFiles: the
 *   files (of those given) changed after the verification; projectFor: the project a task belongs to (queueLogic, with
 *   the prefixes), otherwise the field `project`.
 * @returns {{ unregistered: string[], dead_paths: object[], stale: object[], not_verified: string[],
 *   statusDeviation: object[], ruleDeviation: object[], gaps: object[], duplicates: object[], capacity: object,
 *   references: { id: string, path: string, role: string }[], count: number }}
 */
function check(reg, queue, ctx = {}) {
  const now = ctx.now ?? new Date();
  const entries = reg.entries ?? [];
  const projects = queue?.projects ?? {};
  const tasks = queue?.tasks ?? [];
  const resolved = new Set(queue?.resolved ?? []);

  // Unregistered: documents that no entry (not even an archived one) points to.
  const pointed = new Set();
  for (const p of [...entries, ...Object.values(reg.archive ?? {})])
    for (const k of p.sources ?? []) if (k?.path) pointed.add(k.path);
  const unregistered = (ctx.documents ?? []).filter((s) => !pointed.has(s) && !isExempt(s)).sort();

  const deadPaths = [];
  const stale = [];
  const notVerified = [];
  const statusDeviation = [];
  const ruleDeviation = [];
  const gaps = [];
  const references = [];
  for (const p of entries) {
    // Dead paths: sources that were moved or deleted.
    if (ctx.existsPath)
      for (const k of p.sources ?? [])
        if (!sourcePathError(k.path) && !ctx.existsPath(k.path)) deadPaths.push({ id: p.id, path: k.path });

    const by = derivedMaturity(p, tasks, { now });
    const doneTasks = queueTasksFor(p, tasks).filter((o) => o.status === 'done');

    // Stale: the verification is over STALE_DAYS days old, or the files of finished queue tasks have changed since.
    if (p.verified?.date) {
      if (isStale(p, { now }))
        stale.push({
          id: p.id,
          reason: `verified ${p.verified.date}, over ${STALE_DAYS} days since`,
        });
      else if (ctx.changedFiles) {
        const files = [...new Set(doneTasks.flatMap((o) => o.owned_files ?? []))].sort();
        const changed = files.length
          ? ctx.changedFiles(files, {
              date: p.verified.date,
              commit: p.verified.commit ?? null,
            })
          : [];
        if (changed.length)
          stale.push({
            id: p.id,
            reason: `${changed.length} file(s) changed after the verification ${p.verified.date}: ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}`,
            files: changed,
          });
      }
    } else if (by.maturity === 'built') notVerified.push(p.id);

    // Reference documents and history: registered, but never read for status (marked separately in the output).
    for (const k of p.sources ?? [])
      if (SOURCE_ROLES_WITHOUT_STATUS.includes(k?.role))
        references.push({ id: p.id, path: k.path, role: k.role });

    // Status deviation: the queue and the document disagree. Dropped entries are skipped (they will not be built, so a
    // "not started" or "done" in the document is no contradiction), and so are the reference and history sources.
    if (ctx.readDoc && p.priority !== 'drop') {
      const mod = by.maturity;
      const queueDone = mod === 'built' || mod === 'verified';
      const noneQueue = by.total === 0;
      for (const k of p.sources ?? []) {
        if (SOURCE_ROLES_WITHOUT_STATUS.includes(k.role)) continue;
        if (sourcePathError(k.path) || (ctx.existsPath && !ctx.existsPath(k.path))) continue;
        const st = docStatus(ctx.readDoc(k.path), k.anchor ?? null);
        const where = `${k.path}${k.anchor ? ` ${k.anchor}` : ''}`;
        if (queueDone && st === 'not-started')
          statusDeviation.push({
            id: p.id,
            reason: `the queue says ${mod} (${by.finished}/${by.total}), but ${where} says not started`,
          });
        else if (noneQueue && st === 'done')
          statusDeviation.push({
            id: p.id,
            reason: `no queue tasks (${p.maturity}), but ${where} says done`,
          });
      }
    }

    // Rule deviation: the measurable rules point to a different priority than the one set.
    if (p.priority !== 'drop') {
      const m = measuredRule(p, entries, { now });
      if (m && m.priority !== p.priority)
        ruleDeviation.push({
          id: p.id,
          rule: m.nr,
          reason: `rule ${m.nr} (${m.name}) gives ${m.priority}${m.category ? `/${m.category}` : ''}: ${m.reason}; is ${p.priority}${p.priority_set_by === 'owner' ? ' (set by the owner, not changed by an agent)' : ''}`,
        });
    }
    for (const t of ruleAgainstPriority(p).error) ruleDeviation.push({ id: p.id, reason: t });

    // Gaps: drop without a reason, now without a category, owner without an owner question, and entries without a module.
    if (p.priority === 'drop' && !text(p.drop_reason))
      gaps.push({ id: p.id, reason: 'drop without a reason' });
    if (p.priority === 'now' && !(p.now_category ?? []).length)
      gaps.push({ id: p.id, reason: 'now without a category' });
    if (p.priority === 'owner') {
      const question = p.ownerQuestions ?? [];
      if (!question.length) gaps.push({ id: p.id, reason: 'owner without a linked owner question' });
      else if (question.every((s) => resolved.has(s)))
        gaps.push({
          id: p.id,
          reason: `all the owner questions are resolved (${question.join(', ')}); set a new priority`,
        });
    }
    if (p.project && Object.hasOwn(projects, p.project) && !projects[p.project]?.area)
      gaps.push({ id: p.id, reason: `the project ${p.project} has no module` });
    else if (p.project && !Object.hasOwn(projects, p.project))
      gaps.push({ id: p.id, reason: `unknown project ${p.project}` });
  }

  // Status deviation in the queue: tasks that point to a planEntry that does not exist, and projects in phase plan with queue tasks.
  const known = new Set([...entries.map((p) => p.id), ...Object.keys(reg.archive ?? {})]);
  for (const o of tasks)
    if (o?.plan && o.status !== 'cancelled' && !known.has(o.plan))
      statusDeviation.push({ task: o.id, reason: `${o.id} points to unknown planEntry ${o.plan}` });
  for (const [pid, pr] of Object.entries(projects)) {
    if (pr?.phase !== 'plan') continue;
    const n = tasks.filter(
      (o) => o && o.status !== 'cancelled' && (ctx.projectFor?.(o) ?? o.project) === pid,
    ).length;
    if (n)
      statusDeviation.push({
        project: pid,
        reason: `the project ${pid} has phase plan, but ${n} queue task(s) (cq project ${pid} --phase none)`,
      });
  }

  const dup = duplicates(entries);
  const ch = capacity(reg, queue, { donePerWeek: ctx.donePerWeek ?? null, now });
  const out = {
    unregistered,
    dead_paths: deadPaths,
    stale,
    not_verified: notVerified,
    statusDeviation,
    ruleDeviation,
    gaps,
    duplicates: dup,
    capacity: ch,
    // Not findings: the sources with role history or reference, which are not read for status (not counted in count).
    references,
  };
  // the consistency checks for the document register, only when the register has documents.
  const dk = docConsistency(reg, queue, { ...ctx, now });
  if (dk.ran.length) out.doc_consistency = dk.findings;
  out.count =
    unregistered.length +
    deadPaths.length +
    stale.length +
    notVerified.length +
    statusDeviation.length +
    ruleDeviation.length +
    gaps.length +
    dup.length +
    dk.findings.length;
  return out;
}

// ---- "Working now" -------------------------------------------------------------------------
//
// When a `/plans` session works on an entry, the skill writes a marker with `queue.mjs plan active <id>`; `--end` removes
// it. The markers live at register level, not in the planEntry, so they never mix with the entry fields (FIELD), planDiff
// or the changelog (frequent pulses, nothing to undo):
//   active_session: [{ entry: 'PL-EXPORT-1', at: '<iso>', by: 'session-name' }]   (at most one marker per entry; last pulse wins)
// The reader (the board) only needs activeEntries(reg): { <entry-id>: { at, by } } for the markers that are live. A
// marker dies by itself ACTIVE_SESSION_HOURS hours after the last pulse; dead markers are cleaned up on the next write.

/** How many hours a marker lives without a new pulse (the marker disappears by itself). */
const ACTIVE_SESSION_HOURS = 2;
/** Clock skew: a marker up to this many minutes ahead in time counts as valid (different machines, different clocks). */
const ACTIVE_SESSION_TOLERANCE_MIN = 5;

/**
 * Is the marker live? True when `at` is a valid time less than ACTIVE_SESSION_HOURS hours before `now` (and at most
 * ACTIVE_SESSION_TOLERANCE_MIN minutes after).
 * @param {{ at?: string }|null|undefined} cursor
 * @param {{ now?: Date|string }} [o]
 */
function isActiveSession(cursor, { now = new Date() } = {}) {
  if (!isObject(cursor) || typeof cursor.at !== 'string') return false;
  const t = Date.parse(cursor.at);
  const n = new Date(now).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(n)) return false;
  const diff = n - t;
  return diff < ACTIVE_SESSION_HOURS * 3600000 && diff >= -ACTIVE_SESSION_TOLERANCE_MIN * 60000;
}

/** The markers that are well-formed (an object with the entry id as text); the rest are ignored. */
function activeSessionList(reg) {
  const l = Array.isArray(reg?.active_session) ? reg.active_session : [];
  return l.filter((m) => isObject(m) && typeof m.entry === 'string' && m.entry);
}

/**
 * Entries being worked on now: `{ <entry-id>: { at, by } }`, only live markers on entries that exist (an entry
 * merged into the archive gets no pulse). If an entry has several markers, the newest wins.
 * @param {object} reg the plan register
 * @param {{ now?: Date|string }} [o]
 * @returns {Record<string, { at: string, by: string }>}
 */
function activeEntries(reg, { now = new Date() } = {}) {
  const exists = new Set((reg?.entries ?? []).map((p) => p.id));
  const out = {};
  for (const m of activeSessionList(reg)) {
    if (!exists.has(m.entry) || !isActiveSession(m, { now })) continue;
    const previous = out[m.entry];
    if (!previous || Date.parse(m.at) > Date.parse(previous.at))
      out[m.entry] = { at: m.at, by: text(m.by) || 'unknown' };
  }
  return out;
}

/**
 * Sets (pulse) or removes (`end`) the marker for an entry. Changes `reg.active_session` in place and cleans away dead and
 * invalid markers. Not touched: entries, the archive and the changelog.
 * @param {object} reg
 * @param {string} postId
 * @param {{ by?: string|null, now?: Date|string, end?: boolean }} [o]
 * @returns {{ error: string[], changed: boolean, cursor: { entry: string, at: string, by: string }|null }}
 */
function setActiveSession(reg, entryId, { by = null, now = new Date(), end = false } = {}) {
  const id = text(entryId);
  if (!id)
    return {
      error: ['missing entry id (plan active <PL-id> [--end])'],
      changed: false,
      cursor: null,
    };
  if (!end && !findEntry(reg, id)) {
    const archive = reg?.archive?.[id];
    return {
      error: [
        archive
          ? `${id} is merged into ${archive.merged_to ?? 'another entry'}; mark that one instead`
          : `${id} does not exist in the plan register`,
      ],
      changed: false,
      cursor: null,
    };
  }
  const iso = new Date(now).toISOString();
  const for_ = JSON.stringify(reg.active_session ?? null);
  // Keep only live markers for other entries; the marker for this entry is replaced or removed.
  const kept = activeSessionList(reg).filter((m) => m.entry !== id && isActiveSession(m, { now: iso }));
  const cursor = end ? null : { entry: id, at: iso, by: text(by) || 'unknown' };
  reg.active_session = cursor ? [...kept, cursor] : kept;
  return { error: [], changed: JSON.stringify(reg.active_session) !== for_, cursor };
}

// ---- Documents and agreements ----------------------------------------------------------------------
//
// A small register of its own in plans.json (`documents`): one object per legal or governing document, with status,
// version, where it is published, problems, priority and revision. The register stores only metadata; the text itself
// stays where it is (in the repo, on the web page or in an admin surface). Writing works as for the plan entries
// (`queue.mjs plan doc …` under the same lock, --expect-changed, changelog and undo; the collection is called
// `documents` in the changelog). The consistency checks against vendors, revisions and web addresses are in the block
// further down.

/** The groups in the tab, in display order. */
const DOC_GROUPS = [
  { id: 'customerAgreements', title: 'Customer agreements' },
  { id: 'privacy', title: 'Privacy' },
  { id: 'public', title: 'Public on the web page' },
  { id: 'governance', title: 'Governance documents' },
  { id: 'vendors', title: 'Purchasing and vendors' },
  { id: 'contract', title: 'Contract work' },
];
/** Who the document is written for. */
const DOC_AUDIENCES = ['customer', 'public', 'internal', 'vendor'];
/** The life cycle of a document, in order. */
const DOC_STATUSES = [
  'missing',
  'draft',
  'ai-assessed',
  'to-lawyer',
  'approved',
  'published',
  'outdated',
];
/** Where a document can be published. `signed` = signed per customer or vendor (e.g. an agreement signed per customer). */
const DOC_PUBLISHED_WHERE = ['webPage', 'admin', 'app', 'signed', 'other'];
/** The severity of a problem (high first). */
const DOC_SEVERITY = ['high', 'medium', 'low'];
/** Document id: DOC-, then capital letters, digits and hyphens (e.g. DOC-TERMS, DOC-ROUTINE-2). */
const DOC_ID_PATTERN = /^DOC-[A-Z0-9\u00C6\u00D8\u00C5](?:[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5-]*[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5])?$/;
/** Revisions due within this many days show on the timeline and in "What must be done" as soon overdue. */
const DOC_REVISION_SOON_DAYS = 30;

/** The fields a document may have. Anything else is rejected. */
const DOC_FIELD = [
  'id',
  'title',
  'group',
  'audience',
  'source',
  'published',
  'version',
  'current_version',
  'status',
  'last_revised',
  'revision_every',
  'revisions',
  'depends_on_docs',
  'problems',
  'priority',
  'now_category',
  'priority_reason',
  'priority_set_by',
  'drop_reason',
  'legal_points',
  'planEntries',
  'ownerQuestions',
  'deadline',
  'remark',
  // the modules the document covers (the oids in the configuration's `modules`).
  'modules',
  // Set by the tool:
  'created',
  'agent_boost',
];
const DOC_TOOL_FIELD = new Set(['id', 'created', 'agent_boost']);

/** The document with the id, or null. */
function findDoc(reg, id) {
  return (reg?.documents ?? []).find((d) => d.id === id) ?? null;
}

/**
 * Parses `revision_every`: "12 mo", "6 months", "1 year", "4 weeks", "90 days" give an interval; "on …" (the event
 * keyword, e.g. "on change of subprocessor") is an event without a date. Anything else gives null.
 * @returns {{ mo?: number, days?: number, event?: string }|null}
 */
function revisionInterval(s) {
  const t = text(s).toLowerCase();
  if (!t) return null;
  if (/^on\s+\S/.test(t)) return { event: text(s) };
  const m = /^(\d{1,3})\s*(mo|md|month|months|year|years|week|weeks|day|days)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!n) return null;
  if (['mo', 'md', 'month', 'months'].includes(m[2])) return { mo: n };
  if (m[2] === 'year' || m[2] === 'years') return { mo: n * 12 };
  if (m[2] === 'week' || m[2] === 'weeks') return { days: n * 7 };
  return { days: n };
}

/** The date `n` months after `date` (YYYY-MM-DD); the day is cut to the month's last (Jan 31 + 1 mo = Feb 28/29). */
function addToMonth(date, n) {
  const [aa, mm, dd] = date.split('-').map(Number);
  const tot = aa * 12 + (mm - 1) + n;
  const yr = Math.floor(tot / 12);
  const nm = (tot % 12) + 1;
  const lastDay = new Date(Date.UTC(yr, nm, 0)).getUTCDate();
  return `${yr}-${String(nm).padStart(2, '0')}-${String(Math.min(dd, lastDay)).padStart(2, '0')}`;
}

/** The date `n` days after `date` (YYYY-MM-DD). */
function addToDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The next revision of a document: last_revised + revision_every. An event ("on change of …") has no date.
 * A document that is missing or outdated has no planned revision (it must be written or replaced first).
 * @returns {{ date: string, days: number, overdue: boolean, soon: boolean }|{ event: string }|null}
 */
function nextRevision(doc, { now = new Date() } = {}) {
  if (!doc || doc.status === 'missing' || doc.status === 'outdated') return null;
  const iv = revisionInterval(doc.revision_every);
  if (!iv) return null;
  if (iv.event) return { event: iv.event };
  if (!validDate(doc.last_revised)) return null;
  const date = iv.mo
    ? addToMonth(doc.last_revised, iv.mo)
    : addToDays(doc.last_revised, iv.days);
  const days = daysBetween(osloDate(now), date);
  return {
    date,
    days,
    overdue: days < 0,
    soon: days >= 0 && days <= DOC_REVISION_SOON_DAYS,
  };
}

/** The version number without whitespace (null when it is missing). */
const ver = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Version skew: what is published differs from what applies, two publishing places differ, or customers
 * have accepted an older version than the approved one (duty to notify on changes to agreements or terms).
 * `current_version` is the version the customers have actually accepted; `version` is the working version, which is
 * approved when status is approved or published.
 * @returns {{ type: 'published-different'|'places-different'|'accepted-older'|'not-rolled-out', text: string }[]}
 */
function versionSkew(doc) {
  const out = [];
  if (!doc || doc.status === 'missing') return out;
  const current = ver(doc.current_version);
  const pub = (Array.isArray(doc.published) ? doc.published : []).filter(
    (p) => isObject(p) && ver(p.version),
  );
  if (current)
    for (const p of pub)
      if (ver(p.version) !== current)
        out.push({
          type: 'published-different',
          text: `${p.where ?? 'published'} shows ${ver(p.version)}, but the current version is ${current}`,
        });
  const different = [...new Set(pub.map((p) => ver(p.version)))];
  if (different.length > 1)
    out.push({
      type: 'places-different',
      text: `the publishing places differ: ${pub.map((p) => `${p.where ?? '?'} ${ver(p.version)}`).join(', ')}`,
    });
  const work = ver(doc.version);
  if (
    (doc.status === 'approved' || doc.status === 'published') &&
    work &&
    current &&
    work !== current
  )
    out.push(
      doc.audience === 'customer'
        ? {
            type: 'accepted-older',
            text: `the customers have accepted ${current}, but ${work} is approved: notify the customers before the change applies`,
          }
        : {
            type: 'not-rolled-out',
            text: `${work} is approved, but ${current} still applies`,
          },
    );
  return out;
}

/**
 * What must be done with one document ("What must be done"): missing, overdue revision, problems with high severity,
 * versionSkew and everything marked for-prod. Empty list = nothing urgent.
 * @returns {{ type: string, text: string }[]}
 */
function docReasons(doc, { now = new Date() } = {}) {
  const out = [];
  if (!doc || doc.status === 'outdated') return out;
  if (doc.status === 'missing') out.push({ type: 'missing', text: 'The document is missing' });
  const nr = nextRevision(doc, { now });
  if (nr?.overdue)
    out.push({ type: 'overdue', text: `The revision was due ${nr.date} (${-nr.days} days ago)` });
  const high = (doc.problems ?? []).filter((p) => p?.severity === 'high');
  if (high.length)
    out.push({
      type: 'problem-high',
      text: `${high.length} ${high.length === 1 ? 'problem' : 'problems'} with high severity`,
    });
  const miss = versionSkew(doc);
  if (miss.length) out.push({ type: 'miss', text: `Version skew: ${miss[0].text}` });
  if (doc.priority === 'now' && (doc.now_category ?? []).includes('for-prod'))
    out.push({ type: 'for-prod', text: 'Marked Now, before prod' });
  if (validDate(doc.deadline) && daysBetween(osloDate(now), doc.deadline) < 0)
    out.push({ type: 'deadline', text: `Deadline ${doc.deadline} has passed` });
  return out;
}

/** The order in "What must be done": the most serious first. */
const DOC_REASON_WEIGHT = {
  missing: 0,
  'problem-high': 1,
  deadline: 2,
  overdue: 3,
  miss: 4,
  'for-prod': 5,
};

/**
 * "What must be done", at the top of the tab and in launchOverview: documents with at least one reason, the most
 * serious first (then for-prod, then id). Outdated and dropped documents are not included.
 * @returns {{ id: string, title: string, group: string, reasons: { type: string, text: string }[] }[]}
 */
function docMustBeDone(documents, { now = new Date() } = {}) {
  return (documents ?? [])
    .filter((d) => d?.priority !== 'drop')
    .map((d) => ({
      id: d.id,
      title: d.title ?? d.id,
      group: d.group ?? null,
      reasons: docReasons(d, { now }),
    }))
    .filter((x) => x.reasons.length)
    .sort((a, b) => {
      const va = Math.min(...a.reasons.map((g) => DOC_REASON_WEIGHT[g.type] ?? 9));
      const vb = Math.min(...b.reasons.map((g) => DOC_REASON_WEIGHT[g.type] ?? 9));
      return va - vb || a.id.localeCompare(b.id, 'en');
    });
}

/**
 * The timeline for revisions and deadlines: the overdue ones and those due within `days` days, sorted by date.
 * Revisions "on <event>" have no date and are not here (they are shown in the panel).
 * @returns {{ id: string, title: string, type: 'revision'|'deadline', date: string, days: number, overdue: boolean }[]}
 */
function revisionTimeline(documents, { now = new Date(), days = 365 } = {}) {
  const out = [];
  const today = osloDate(now);
  for (const d of documents ?? []) {
    if (!d || d.priority === 'drop') continue;
    const nr = nextRevision(d, { now });
    if (nr?.date && nr.days <= days)
      out.push({
        id: d.id,
        title: d.title ?? d.id,
        type: 'revision',
        date: nr.date,
        days: nr.days,
        overdue: nr.overdue,
      });
    if (validDate(d.deadline) && d.status !== 'outdated') {
      const n = daysBetween(today, d.deadline);
      if (n <= days)
        out.push({
          id: d.id,
          title: d.title ?? d.id,
          type: 'deadline',
          date: d.deadline,
          days: n,
          overdue: n < 0,
        });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id, 'en'));
}

/** Copy line for a row: `/plans doc DOC-TERMS. Instruction:` (only the id, never content). */
function docCopyLine(doc) {
  return `/plans doc ${doc.id}. Instruction:`;
}

/**
 * Validates a complete document as it will be saved.
 * @param {object} doc
 * @param {{ documents?: object[], entries?: object[], archive?: object, question?: object,
 *   existsPath?: (path: string) => boolean }} ctx documents: the other documents (for depends_on_docs); entries and archive:
 *   the plan entries (for planEntries); question: the queue's owner questions; existsPath: checks that the source exists.
 * @returns {{ error: string[], warnings: string[] }}
 */
function validateDoc(doc, ctx = {}) {
  const error = [];
  const warnings = [];
  if (!isObject(doc)) return { error: ['the document must be an object'], warnings };
  const who = typeof doc.id === 'string' ? doc.id : '(no id)';
  const f = (t) => error.push(`${who}: ${t}`);
  const adv = (t) => warnings.push(`${who}: ${t}`);

  for (const k of Object.keys(doc))
    if (!DOC_FIELD.includes(k)) f(`unknown field ${k} (allowed: ${DOC_FIELD.join(', ')})`);
  if (typeof doc.id !== 'string' || !DOC_ID_PATTERN.test(doc.id))
    f('id must look like DOC-NAME (DOC-, capital letters, digits and hyphens)');
  if (!text(doc.title)) f('title missing');
  else if (doc.title.length > 160) f('title is over 160 characters');
  if (!DOC_GROUPS.some((g) => g.id === doc.group))
    f(`group must be one of ${DOC_GROUPS.map((g) => g.id).join(', ')}`);
  if (!DOC_AUDIENCES.includes(doc.audience))
    f(`audience must be one of ${DOC_AUDIENCES.join(', ')}`);
  if (!DOC_STATUSES.includes(doc.status)) f(`status must be one of ${DOC_STATUSES.join(', ')}`);
  for (const k of ['remark', 'version', 'current_version', 'revision_every'])
    if (doc[k] != null && typeof doc[k] !== 'string') f(`${k} must be text`);

  // Source: the working file (relative path from the project root). A missing document needs none.
  if (doc.source != null) {
    const sf = sourcePathError(doc.source);
    if (sf) f(`source ${sf}`);
    else if (ctx.existsPath && !ctx.existsPath(doc.source)) f(`source ${doc.source} does not exist`);
  } else if (doc.status && !['missing', 'outdated'].includes(doc.status))
    adv('no source (the working file); the tab cannot show where the document is');

  // Published: [{ where, url?, path?, version? }]. Web addresses must be https (the web check fetches them).
  if (doc.published != null && !Array.isArray(doc.published)) f('published must be a list');
  for (const p of Array.isArray(doc.published) ? doc.published : []) {
    if (!isObject(p)) {
      f('every publication must be { where, url?, path?, version? }');
      continue;
    }
    for (const n of Object.keys(p))
      if (!['where', 'url', 'path', 'version'].includes(n)) f(`published: unknown field ${n}`);
    if (!DOC_PUBLISHED_WHERE.includes(p.where))
      f(`published.where must be one of ${DOC_PUBLISHED_WHERE.join(', ')}`);
    if (p.url != null && (typeof p.url !== 'string' || !/^https:\/\/[^\s]+$/.test(p.url)))
      f(`published.url must be an https address (${p.where ?? '?'})`);
    for (const n of ['path', 'version'])
      if (p[n] != null && typeof p[n] !== 'string') f(`published.${n} must be text`);
  }
  if (doc.status === 'published' && !(doc.published ?? []).length)
    adv('status published, but published is empty (where is it?)');

  // Revision: last_revised + revision_every gives the next revision. revisions is the history (oldest first).
  if (doc.last_revised != null && !validDate(doc.last_revised))
    f('last_revised must be a date (YYYY-MM-DD)');
  if (doc.revision_every != null && !revisionInterval(doc.revision_every))
    f('revision_every must be e.g. "12 mo", "1 year", "90 days" or "on <event>"');
  if (doc.revisions != null && !Array.isArray(doc.revisions)) f('revisions must be a list');
  for (const r of Array.isArray(doc.revisions) ? doc.revisions : []) {
    if (!isObject(r) || !validDate(r.date)) {
      f('every revision must be { date: YYYY-MM-DD, version?, remark?, by? }');
      continue;
    }
    for (const n of Object.keys(r))
      if (!['date', 'version', 'remark', 'by'].includes(n)) f(`revisions: unknown field ${n}`);
  }

  // Problems: [{ text, severity, source? }].
  if (doc.problems != null && !Array.isArray(doc.problems)) f('problems must be a list');
  for (const p of Array.isArray(doc.problems) ? doc.problems : []) {
    if (!isObject(p) || !text(p.text)) {
      f('every problem must be { text, severity, source? }');
      continue;
    }
    for (const n of Object.keys(p))
      if (!['text', 'severity', 'source'].includes(n)) f(`problems: unknown field ${n}`);
    if (!DOC_SEVERITY.includes(p.severity)) f(`problems.severity must be one of ${DOC_SEVERITY.join(', ')}`);
  }

  // Priority is optional for a document; if it is set, the same rules apply as for the plan entries.
  if (doc.priority != null) {
    if (!PRIORITIES.includes(doc.priority))
      f(`priority must be one of ${PRIORITIES.join(', ')}`);
    if (!SET_BY.includes(doc.priority_set_by))
      f(`priority_set_by must be ${SET_BY.join(' or ')}`);
    if (doc.priority_set_by === 'agent' && !text(doc.priority_reason))
      f('an agent must give priority_reason (one sentence: which priority rule and why)');
    if (doc.priority === 'now' && !(doc.now_category ?? []).length)
      adv('now without a category (security, for-prod or important)');
    if (doc.priority === 'drop' && !text(doc.drop_reason))
      f('drop requires one sentence as the reason (drop_reason)');
    const rs = ruleAgainstPriority(doc);
    error.push(...rs.error.map((t) => `${who}: ${t}`));
    warnings.push(...rs.warnings.map((t) => `${who}: ${t}`));
  } else
    for (const k of ['now_category', 'priority_reason', 'priority_set_by', 'drop_reason'])
      if (doc[k] != null) f(`${k} is only used when priority is set`);
  if (doc.now_category != null) {
    if (!Array.isArray(doc.now_category)) f('now_category must be a list');
    else {
      for (const k of doc.now_category)
        if (!NOW_CATEGORIES.includes(k))
          f(`unknown now_category ${k} (allowed: ${NOW_CATEGORIES.join(', ')})`);
      if (doc.now_category.length && doc.priority !== 'now')
        f('now_category is only used when priority is now');
    }
  }
  if (doc.priority !== 'drop' && doc.priority != null && doc.drop_reason != null)
    f('drop_reason is only used when priority is drop');

  // The links: lists of text. depends_on_docs must be other documents, planEntries must exist in the register.
  for (const field of ['depends_on_docs', 'legal_points', 'planEntries', 'ownerQuestions']) {
    const v = doc[field];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim()))
      f(`${field} must be a list of text`);
  }
  const otherDoc = new Set((ctx.documents ?? []).map((d) => d.id));
  for (const d of Array.isArray(doc.depends_on_docs) ? doc.depends_on_docs : []) {
    if (d === doc.id) f('depends_on on itself');
    else if (ctx.documents && !otherDoc.has(d)) f(`depends_on on unknown document ${d}`);
  }
  if (ctx.entries)
    for (const pid of Array.isArray(doc.planEntries) ? doc.planEntries : []) {
      if ((ctx.entries ?? []).some((p) => p.id === pid)) continue;
      if (ctx.archive?.[pid])
        adv(`planEntry ${pid} is merged into ${ctx.archive[pid].merged_to}`);
      else f(`unknown planEntry ${pid}`);
    }
  for (const s of Array.isArray(doc.ownerQuestions) ? doc.ownerQuestions : [])
    if (ctx.question && !Object.hasOwn(ctx.question, s))
      adv(`ownerQuestion ${s} is not in the queue (cq question ${s} --text "…")`);
  if (doc.deadline != null && !validDate(doc.deadline))
    f('deadline must be a date (YYYY-MM-DD) or null');
  // modules is a list of module ids from the configuration's `modules`.
  if (doc.modules != null) {
    if (!Array.isArray(doc.modules) || doc.modules.some((x) => typeof x !== 'string'))
      f('modules must be a list of module ids');
    else
      for (const m of doc.modules)
        if (!modules().some((x) => x.oid === m))
          f(`unknown module ${m} (allowed: ${modules().map((x) => x.oid).join(', ')})`);
  }
  return { error, warnings };
}

/** The context validateDoc needs, from the register and the queue. */
function docContext(reg, ctx, withoutId = null) {
  return {
    documents: (reg.documents ?? []).filter((d) => d.id !== withoutId),
    entries: reg.entries ?? [],
    archive: reg.archive ?? {},
    question: ctx.question,
    existsPath: ctx.existsPath,
  };
}

/**
 * New document (`plan doc new --file`). Mutates `reg` only when everything is valid. If priority is set,
 * priority_set_by becomes the caller's role (as for the plan entries).
 * @returns {{ error: string[], warnings: string[], doc?: object }}
 */
function newDoc(reg, input, ctx = {}) {
  const role = ctx.role === 'owner' ? 'owner' : 'agent';
  if (!isObject(input)) return { error: ['the document must be an object'], warnings: [] };
  if (!Array.isArray(reg.documents)) reg.documents = [];
  const who = typeof input.id === 'string' ? input.id : '(no id)';
  const error = [];
  if (typeof input.id === 'string' && findDoc(reg, input.id))
    error.push(`${who}: the id is already used (ids are never reused)`);
  for (const k of Object.keys(input))
    if (DOC_TOOL_FIELD.has(k) && k !== 'id') error.push(`${who}: ${k} is set by the tool`);
  if (input.priority_set_by === 'owner' && role !== 'owner')
    error.push(`${who}: an agent cannot set priority_set_by owner (use --set-by owner)`);
  const doc = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) doc[k] = cloneJson(v);
  if (doc.priority != null) doc.priority_set_by = role;
  else delete doc.priority_set_by;
  doc.created = ctx.now ?? new Date().toISOString();
  const v = validateDoc(doc, docContext(reg, ctx));
  error.push(...v.error);
  if (error.length) return { error, warnings: v.warnings };
  reg.documents.push(doc);
  return { error: [], warnings: v.warnings, doc };
}

/**
 * Changes the fields of one document (`plan doc edit`). null removes the field. The priority follows the limits for
 * the agent: an agent never changes a priority the owner has set, except under rule 1 (security).
 * @returns {{ error: string[], warnings: string[], doc?: object, changed?: string[], boost?: boolean }}
 */
function editDoc(reg, id, field, ctx = {}) {
  const role = ctx.role === 'owner' ? 'owner' : 'agent';
  const list = Array.isArray(reg.documents) ? reg.documents : [];
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return { error: [`unknown document ${id}`], warnings: [] };
  if (!isObject(field)) return { error: [`${id}: the fields must be an object`], warnings: [] };
  const error = [];
  for (const k of Object.keys(field))
    if (DOC_TOOL_FIELD.has(k) || k === 'priority_set_by')
      error.push(`${id}: ${k} is set by the tool`);
  if (error.length) return { error, warnings: [] };
  const old = list[i];
  const fresh = cloneJson(old);
  for (const [k, v] of Object.entries(field)) {
    if (v === null || v === undefined) delete fresh[k];
    else fresh[k] = cloneJson(v);
  }
  if (fresh.priority !== 'now' && !('now_category' in field)) delete fresh.now_category;
  if (fresh.priority !== 'drop' && !('drop_reason' in field)) delete fresh.drop_reason;
  const priorityChanged =
    (old.priority ?? null) !== (fresh.priority ?? null) ||
    !equalValue(old.now_category ?? [], fresh.now_category ?? []);
  let boost = false;
  if (priorityChanged) {
    const t = priorityAccess(old, fresh, role);
    if (t.error) return { error: [t.error], warnings: [] };
    boost = t.boost;
    if (!('priority_reason' in field)) delete fresh.priority_reason;
    if (fresh.priority == null) {
      delete fresh.priority_set_by;
      delete fresh.priority_reason;
      delete fresh.agent_boost;
    } else {
      fresh.priority_set_by = role;
      if (role === 'agent' && !('priority_reason' in field))
        error.push(
          `${id}: new priority requires priority_reason (one sentence: which priority rule and why)`,
        );
      if (boost)
        fresh.agent_boost = {
          at: ctx.now ?? new Date().toISOString(),
          by: ctx.by ?? 'agent',
          from: { priority: old.priority ?? null, now_category: old.now_category ?? null },
        };
      else if (role === 'owner') delete fresh.agent_boost;
    }
  } else if (
    role === 'agent' &&
    old.priority_set_by === 'owner' &&
    !equalValue(old.priority_reason, fresh.priority_reason)
  )
    return {
      error: [`${id}: priority_reason belongs to the owner's priority, and an agent does not change it`],
      warnings: [],
    };
  const v = validateDoc(fresh, docContext(reg, ctx, id));
  error.push(...v.error);
  if (error.length) return { error, warnings: v.warnings };
  const changed = [...new Set([...Object.keys(old), ...Object.keys(fresh)])].filter(
    (k) => !equalValue(old[k], fresh[k]),
  );
  list[i] = fresh;
  return { error: [], warnings: v.warnings, doc: fresh, changed, boost };
}

/**
 * Records a revision (`plan doc revise`): last_revised becomes the date, version becomes the new one (when given), and
 * the revision is added last in the history. Gives the timeline a new next revision.
 * @param {{ date?: string|null, version?: string|null, remark?: string|null, by?: string|null }} option
 */
function reviseDoc(reg, id, option = {}, ctx = {}) {
  const d = findDoc(reg, id);
  if (!d) return { error: [`unknown document ${id}`], warnings: [] };
  const date = option.date ?? osloDate(ctx.now ? new Date(ctx.now) : new Date());
  if (!validDate(date)) return { error: [`${id}: --date must be YYYY-MM-DD`], warnings: [] };
  const rev = { date };
  if (text(option.version)) rev.version = text(option.version);
  if (text(option.remark)) rev.remark = text(option.remark);
  if (text(option.by)) rev.by = text(option.by);
  const field = { last_revised: date, revisions: [...(d.revisions ?? []), rev] };
  if (rev.version) field.version = rev.version;
  return editDoc(reg, id, field, ctx);
}

/**
 * Filters documents (`plan doc show`). Within a field the choices are "or", between the fields "and". Dropped ones are
 * hidden without `all` or priority drop.
 * @param {{ group?: string[], status?: string[], audience?: string[], priority?: string[], problems?: boolean,
 *   search?: string|null, all?: boolean }} filter
 */
function filterDoc(reg, filter = {}, { now = new Date() } = {}) {
  const includesOr = (list, v) => !list?.length || list.includes(v);
  const search = text(filter.search).toLowerCase();
  return (reg.documents ?? []).filter((d) => {
    if (d.priority === 'drop' && !filter.all && !(filter.priority ?? []).includes('drop'))
      return false;
    if (!includesOr(filter.group, d.group) || !includesOr(filter.status, d.status)) return false;
    if (!includesOr(filter.audience, d.audience) || !includesOr(filter.priority, d.priority ?? 'none'))
      return false;
    if (
      filter.problems &&
      !(d.problems ?? []).length &&
      !versionSkew(d).length &&
      !nextRevision(d, { now })?.overdue
    )
      return false;
    if (!search) return true;
    return [d.id, d.title, d.source, d.remark, ...(d.problems ?? []).map((p) => p?.text)]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
      .includes(search);
  });
}

/**
 * Everything about one document (`plan doc get`): the fields, dependencies both ways, the plan entries, the owner
 * questions, versionSkew, next revision, what must be done and the copy line. Only metadata; the text is read where it is.
 */
function getDoc(reg, queue, id, { now = new Date(), existsPath = null } = {}) {
  const d = findDoc(reg, id);
  if (!d) return { error: [`unknown document ${id}`] };
  const all = reg.documents ?? [];
  const resolved = new Set(queue?.resolved ?? []);
  return {
    error: [],
    doc: cloneJson(d),
    source_exists: d.source && existsPath ? existsPath(d.source) : null,
    depends_on_docs: (d.depends_on_docs ?? []).map((x) => {
      const a = findDoc(reg, x);
      return { id: x, title: a?.title ?? null, status: a?.status ?? null };
    }),
    used_by: all.filter((x) => (x.depends_on_docs ?? []).includes(d.id)).map((x) => x.id),
    planEntries: (d.planEntries ?? []).map((pid) => ({
      id: pid,
      title: findEntry(reg, pid)?.title ?? null,
    })),
    ownerQuestions: (d.ownerQuestions ?? []).map((s) => ({
      id: s,
      text: queue?.question?.[s]?.text ?? null,
      resolved: resolved.has(s),
    })),
    miss: versionSkew(d),
    next_revision: nextRevision(d, { now }),
    reasons: docReasons(d, { now }),
    copy: docCopyLine(d),
  };
}

// ---- The consistency checks for Documents and agreements ---------------------------------------------------------------
//
// Derived findings that `plan check` and `plan doc check` show: the vendors the project uses against the documents that
// must mention them, planned vendor switches against documents that go outward, overdue revisions and (only manually)
// that published web addresses respond with the correct version. The functions here are pure: the text of the documents
// is passed in from queue.mjs. `plan doc check --write` records the findings as problems with source "check:<type>"
// (logged and undoable), so the tab and "What must be done" show them without code of their own.
//
// The vendor check is optional and controlled by queue.config.json (`documents`):
//   vendors          [{ id, name, word?: string[], documents?: (string | { doc, section?, where? })[] }]
//                    `word` is the words that count as the vendor being mentioned (default: the name). `documents` is
//                    the document ids in the register that must mention the vendor; `section` (optional) is a regular
//                    expression for the heading that delimits the part that counts.
//   secretsManifest  null, or the path to a file listing the vendors actually in use (e.g. the secrets
//                    per environment). With null all vendors in the list count as in use, and the reverse is not checked.
//   vendorSwitches   [{ out, in, planEntry?, text? }]: a document that goes outward and still mentions `out` is a finding
//                    (high when the planEntry is built or verified, otherwise medium).
// Empty lists (the default) turn the check off.

/** The types of consistency checks. `web` only runs manually (`plan doc web`); `revision` is never recorded as a problem. */
const DOC_CHECKS = ['vendor', 'revision', 'web'];

/** The word as a word of its own (not part of another word), case-insensitive. */
function wordPattern(...alternatives) {
  const alt = alternatives.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![A-Za-z\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5])(?:${alt})(?![A-Za-z\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5])`, 'i');
}

/**
 * The document settings from the configuration, with whatever is passed in ctx taking precedence (tests).
 * @returns {{ vendors: object[], secretsManifest: string|null, switches: object[] }}
 */
function docSettings(ctx = {}) {
  const k = config().documents ?? {};
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    vendors: list(ctx.vendors ?? k.vendors),
    secretsManifest:
      ctx.secretsManifest !== undefined ? ctx.secretsManifest : (k.secretsManifest ?? null),
    switches: list(ctx.vendorSwitches ?? k.vendorSwitches),
  };
}

/**
 * The vendor list as the check uses it: id, name, the pattern that finds them in a text, and the document requirements
 * ({ doc, section: RegExp|null, where }). Invalid items are skipped.
 */
function parseVendors(list) {
  const out = [];
  for (const l of list ?? []) {
    if (!isObject(l) || !text(l.id)) continue;
    const name = text(l.name) || l.id;
    const word = (Array.isArray(l.word) && l.word.length ? l.word : [name]).filter((o) => text(o));
    const requirement = [];
    for (const d of Array.isArray(l.documents) ? l.documents : []) {
      const doc = typeof d === 'string' ? d : d?.doc;
      if (!text(doc)) continue;
      let section = null;
      if (isObject(d) && text(d.section)) {
        try {
          section = new RegExp(d.section, 'i');
        } catch {
          section = null;
        }
      }
      requirement.push({ doc, section, where: (isObject(d) && text(d.where)) || doc });
    }
    out.push({ id: l.id, name, pattern: wordPattern(...word), requirement });
  }
  return out;
}

/**
 * The text under the first markdown heading whose text (without #) matches `heading`, up to the next
 * heading at the same or a higher level. Null when the heading does not exist.
 */
function sectionInText(t, heading) {
  if (typeof t !== 'string') return null;
  const lines = t.split('\n');
  const start = lines.findIndex((l) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    return m && heading.test(m[2].trim());
  });
  if (start < 0) return null;
  const level = /^(#{1,6})/.exec(lines[start])[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/**
 * The vendors (ids) mentioned in the text. With `onlyTable` only the first cell in table rows counts.
 * @param {string} t
 * @param {{ onlyTable?: boolean, vendors?: object[] }} [o] vendors: the raw list (default: the configuration)
 */
function vendorsInText(t, { onlyTable = false, vendors } = {}) {
  if (typeof t !== 'string') return [];
  const source = onlyTable
    ? t
        .split('\n')
        .filter((l) => /^\s*\|/.test(l) && !/^\s*\|\s*-/.test(l))
        .map((l) => l.split('|')[1] ?? '')
        .join('\n')
    : t;
  const vendorList = parseVendors(vendors ?? docSettings().vendors);
  return vendorList.filter((l) => l.pattern.test(source)).map((l) => l.id);
}

/** Is the document live (does it have text that must be correct)? */
const docDeliver = (d) =>
  d && !['missing', 'outdated'].includes(d.status) && d.priority !== 'drop' && d.source;
/** Does the document go out to customers, the web page or vendors, or does it belong to privacy? */
const docOutward = (d) =>
  ['customer', 'public', 'vendor'].includes(d.audience) ||
  ['privacy', 'customerAgreements', 'public'].includes(d.group);

/**
 * The vendors against the documents that must mention them, and planned vendor switches against documents that go outward.
 * @param {{ readDoc: (path: string) => string|null, now?: Date, vendors?: object[], secretsManifest?: string|null,
 *   vendorSwitches?: object[] }} ctx vendors, secretsManifest and vendorSwitches override the configuration
 */
function checkVendors(reg, queue, ctx) {
  const findings = [];
  const now = ctx.now ?? new Date();
  const input = docSettings(ctx);
  const vendorList = parseVendors(input.vendors);
  const name = (id) => vendorList.find((l) => l.id === id)?.name ?? id;
  const tasks = queue?.tasks ?? [];

  // The switches: is the planEntry done (built or verified)?
  const switches = input.switches
    .filter((b) => isObject(b) && text(b.out))
    .map((b) => {
      const p = b.planEntry ? findEntry(reg, b.planEntry) : null;
      const mod = p ? derivedMaturity(p, tasks, { now }).maturity : null;
      return { ...b, done: mod === 'built' || mod === 'verified' };
    });
  const onPathOut = new Set(switches.map((b) => b.out));

  // Which vendors are in use? With a manifest: the ones mentioned there. Without: all in the list.
  let inUse = new Set(vendorList.map((l) => l.id));
  let manifest = null;
  if (input.secretsManifest) {
    manifest = ctx.readDoc(input.secretsManifest);
    if (manifest == null)
      findings.push({
        doc: null,
        check: 'vendor',
        severity: 'low',
        text: `Could not find ${input.secretsManifest}, so all the vendors in the list count as in use`,
      });
    else inUse = new Set(vendorList.filter((l) => l.pattern.test(manifest)).map((l) => l.id));
  }

  // The document requirements: every document that must mention a vendor in use must do so.
  const perDoc = new Map();
  for (const l of vendorList)
    for (const k of l.requirement) {
      if (!perDoc.has(k.doc)) perDoc.set(k.doc, []);
      perDoc.get(k.doc).push({ vendorList: l, requirement: k });
    }
  for (const [docId, list] of perDoc) {
    const d = findDoc(reg, docId);
    if (!d) {
      findings.push({
        doc: null,
        check: 'vendor',
        severity: 'medium',
        text: `${docId} is not in the document register, so the vendors could not be checked against it`,
      });
      continue;
    }
    if (!docDeliver(d)) continue;
    const t = ctx.readDoc(d.source);
    if (t == null) {
      findings.push({
        doc: d.id,
        check: 'vendor',
        severity: 'medium',
        text: `Could not find the source ${d.source}, so the vendors could not be checked`,
      });
      continue;
    }
    for (const { vendorList: l, requirement } of list) {
      const chunk = (requirement.section ? sectionInText(t, requirement.section) : null) ?? t;
      const mentioned = l.pattern.test(chunk);
      if (inUse.has(l.id) && !onPathOut.has(l.id) && !mentioned)
        findings.push({
          doc: d.id,
          check: 'vendor',
          severity: 'high',
          text: `${l.name} is in use${manifest != null ? ` (${input.secretsManifest})` : ''}, but is not in ${requirement.where}`,
        });
      else if (manifest != null && !inUse.has(l.id) && mentioned)
        findings.push({
          doc: d.id,
          check: 'vendor',
          severity: 'low',
          text: `${l.name} is in ${requirement.where}, but not in ${input.secretsManifest}: still in use?`,
        });
    }
  }

  // All documents that go outward: do they mention a vendor on its way out?
  if (switches.length)
    for (const d of reg.documents ?? []) {
      if (!docDeliver(d) || !docOutward(d)) continue;
      const t = ctx.readDoc(d.source);
      if (t == null) continue;
      for (const b of switches) {
        const out = vendorList.find((l) => l.id === b.out);
        const pattern = out ? out.pattern : wordPattern(b.out);
        if (!pattern.test(t)) continue;
        const status = b.planEntry ? ` (${b.planEntry}${b.done ? ', built' : ', planned'})` : '';
        findings.push({
          doc: d.id,
          check: 'vendor',
          severity: b.done ? 'high' : 'medium',
          text: `Mentions ${name(b.out)}; ${b.text ?? `to be replaced by ${name(b.in)}`}${status}`,
        });
      }
    }
  return findings;
}

/** Overdue revisions (shown in the check; "What must be done" already has them, so they are never recorded as a problem). */
function checkRevisions(reg, { now = new Date() } = {}) {
  const findings = [];
  for (const d of reg.documents ?? []) {
    if (d.priority === 'drop') continue;
    const nr = nextRevision(d, { now });
    if (nr?.overdue)
      findings.push({
        doc: d.id,
        check: 'revision',
        severity: 'medium',
        text: `The revision was due ${nr.date} (${-nr.days} days ago)`,
      });
  }
  return findings;
}

/**
 * The read-only web check for one publication: does the address respond, and is the version number on the page? `answer`
 * comes from a GET without login ({ status, text } or { error }). Only for publications with an https url.
 */
function assessWebAnswer(doc, pub, answer) {
  const findings = [];
  const severity = doc.audience === 'public' || doc.group === 'public' ? 'high' : 'medium';
  const where = pub.url;
  if (!answer || answer.error) {
    findings.push({
      doc: doc.id,
      check: 'web',
      severity,
      text: `${where} does not respond (${answer?.error ?? 'unknown error'})`,
    });
    return findings;
  }
  if (!(answer.status >= 200 && answer.status < 300)) {
    findings.push({ doc: doc.id, check: 'web', severity, text: `${where} responds ${answer.status}` });
    return findings;
  }
  const v = ver(pub.version);
  if (v) {
    const re = new RegExp(`(?<![0-9.])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`);
    if (!re.test(String(answer.text ?? '')))
      findings.push({
        doc: doc.id,
        check: 'web',
        severity: 'medium',
        text: `${where} does not show version ${v} (the register says ${v})`,
      });
  }
  return findings;
}

/** The publications the web check fetches: [{ doc, pub }] with an https url. */
function webAddresses(reg) {
  const out = [];
  for (const d of reg.documents ?? []) {
    if (d.priority === 'drop' || d.status === 'missing') continue;
    for (const p of d.published ?? [])
      if (typeof p?.url === 'string' && /^https:\/\/\S+$/.test(p.url)) out.push({ doc: d, pub: p });
  }
  return out;
}

/** The order the findings are shown in: high severity first, then document id. */
const SEVERITY_SEQUENCE = { high: 0, medium: 1, low: 2 };
const sortFindings = (findings) =>
  findings.sort(
    (a, b) =>
      (SEVERITY_SEQUENCE[a.severity] ?? 9) - (SEVERITY_SEQUENCE[b.severity] ?? 9) ||
      String(a.doc ?? '').localeCompare(String(b.doc ?? ''), 'en') ||
      a.text.localeCompare(b.text, 'en'),
  );

/**
 * The consistency checks for the document register, without the web check (it only runs manually).
 * @param {{ readDoc?: (path: string) => string|null, now?: Date, vendors?: object[],
 *   secretsManifest?: string|null, vendorSwitches?: object[] }} ctx
 *   readDoc: the text of a file under the project root. The vendor check only runs with readDoc and a non-empty
 *   vendor list (or vendor switches); the rest override the configuration (tests).
 * @returns {{ findings: { doc: string|null, check: string, severity: string, text: string }[], ran: string[] }}
 */
function docConsistency(reg, queue, ctx = {}) {
  const now = ctx.now ?? new Date();
  if (!(reg.documents ?? []).length) return { findings: [], ran: [] };
  const findings = [];
  const ran = ['revision'];
  const input = docSettings(ctx);
  if (ctx.readDoc && (input.vendors.length || input.switches.length)) {
    findings.push(...checkVendors(reg, queue, { ...ctx, now }));
    ran.push('vendor');
  }
  findings.push(...checkRevisions(reg, { now }));
  return { findings: sortFindings(findings), ran: DOC_CHECKS.filter((s) => ran.includes(s)) };
}

/**
 * Records the findings as problems (`plan doc check --write`): for every check that ran, the old problems
 * with source "check:<type>" are replaced by the new ones. Problems others have written are not touched. Revisions are
 * not recorded (they are already in "What must be done"), and findings without a document are only shown. Mutates `reg`
 * only when everything is valid.
 * @returns {{ error: string[], warnings: string[], changed: string[] }}
 */
function syncConsistency(reg, findings, ran, ctx = {}) {
  const set = new Set((ran ?? []).filter((s) => s !== 'revision'));
  const error = [];
  const warnings = [];
  const changed = [];
  const copy = cloneJson(reg);
  for (const d of copy.documents ?? []) {
    const oldOnes = Array.isArray(d.problems) ? d.problems : [];
    const kept = oldOnes.filter((p) => {
      const m = /^check:(\w+)$/.exec(p?.source ?? '');
      return !m || !set.has(m[1]);
    });
    const newOnes = [];
    for (const f of findings ?? [])
      if (f.doc === d.id && set.has(f.check) && !newOnes.some((x) => x.text === f.text))
        newOnes.push({ text: f.text, severity: f.severity, source: `check:${f.check}` });
    const all = [...kept, ...newOnes];
    if (equalValue(oldOnes, all)) continue;
    const s = editDoc(copy, d.id, { problems: all.length ? all : null }, ctx);
    error.push(...s.error);
    warnings.push(...s.warnings);
    if (!s.error.length) changed.push(d.id);
  }
  if (error.length) return { error, warnings, changed: [] };
  reg.documents = copy.documents;
  return { error: [], warnings, changed };
}

// ---- Legal panel, owner decisions and launchOverview -----------------------------
//
// Everything here is VIEWS over data that already exists: the legal field on the plan entries, `question`, `resolved` and
// `resolutions` in queue.json, and the document register. Nothing new is saved. An answer to an owner question goes as
// before via `queue.mjs resolve <id> --answer … --by owner` (the board uses the same call as "Waiting on you"), and legal
// points are changed with `queue.mjs plan edit <id> --set '{"legal":…}'` (validated by validateLegal below). The lawyer
// package is a draft in <dataFolder>/lawyerPackages/lawyerPackage-<date>.md that the board writes locally; it is never sent anywhere.

/** The statuses of a legal point, in working order (AI assessment first, then lawyer). */
const LEGAL_STATUSES = ['open', 'ai-assessed', 'to-lawyer', 'resolved', 'not-relevant'];
/** The statuses that count as open. */
const LEGAL_OPEN = ['open', 'ai-assessed', 'to-lawyer'];
/** What an open point stops, the most serious first. */
const LEGAL_BLOCKS = ['prod', 'packing', 'nothing'];
/** The DPIA assessment on an entry (null = not assessed yet). */
const DPIA_VALUES = ['needed', 'exists', 'not-relevant'];
/** The id of a legal point (e.g. J-EXPORT-2; short ids such as J7b and E1 are also allowed). */
const LEGAL_POINT_ID = /^[A-Za-z\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5][A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5._-]{0,39}$/;
const LEGAL_FIELD = ['affects', 'privacy', 'points'];
const LEGAL_PRIVACY_FIELD = ['art9', 'dpia', 'dpa_change'];
const LEGAL_POINT_FIELD = ['id', 'question', 'status', 'ai_assessment', 'lawyer', 'blocks', 'deadline'];
const LAWYER_FIELD = ['answer', 'date', 'source'];
/** An owner question with a deadline within this many days (or overdue) goes to the top of Decisions. */
const DECISION_URGENT_DAYS = 14;
/** Minutes a queue task counts when content_min is missing (like queueLogic). */
const TASK_MIN_DEFAULT = 30;
/** The question type that is an owner action (sign, order, send a letter, set a secret). */
const OWNER_ACTION_TYPE = 'owner-task';

/**
 * Validates the legal field on a planEntry.
 * @param {object} j
 * @param {{ otherPoints?: Map<string, string> }} ctx point id → entry id for the points in the other entries
 * @returns {{ error: string[], warnings: string[] }}
 */
function validateLegal(j, ctx = {}) {
  const error = [];
  const warnings = [];
  const f = (t) => error.push(`legal: ${t}`);
  const adv = (t) => warnings.push(`legal: ${t}`);
  if (!isObject(j)) return { error: ['legal must be an object or null'], warnings };
  for (const k of Object.keys(j))
    if (!LEGAL_FIELD.includes(k)) f(`unknown field ${k} (allowed: ${LEGAL_FIELD.join(', ')})`);

  if (j.affects != null && (!Array.isArray(j.affects) || j.affects.some((x) => !text(x))))
    f('affects must be a list of legal references (text)');

  const pv = j.privacy;
  if (pv != null) {
    if (!isObject(pv)) f('privacy must be { art9, dpia, dpa_change } or null');
    else {
      for (const k of Object.keys(pv))
        if (!LEGAL_PRIVACY_FIELD.includes(k))
          f(`privacy: unknown field ${k} (allowed: ${LEGAL_PRIVACY_FIELD.join(', ')})`);
      for (const k of ['art9', 'dpa_change'])
        if (pv[k] != null && typeof pv[k] !== 'boolean')
          f(`privacy.${k} must be true or false`);
      if (pv.dpia != null && !DPIA_VALUES.includes(pv.dpia))
        f(`privacy.dpia must be ${DPIA_VALUES.join(', ')} or null`);
      if (pv.art9 === true && pv.dpia == null)
        adv(
          'art. 9 data without a DPIA assessment (privacy.dpia: needed, exists or not-relevant)',
        );
    }
  }

  if (j.points != null && !Array.isArray(j.points)) f('points must be a list');
  const set = new Set();
  for (const p of Array.isArray(j.points) ? j.points : []) {
    if (!isObject(p)) {
      f('every point must be an object');
      continue;
    }
    const who = typeof p.id === 'string' ? p.id : '(no id)';
    const pf = (t) => f(`point ${who}: ${t}`);
    const pointAdv = (t) => adv(`point ${who}: ${t}`);
    for (const k of Object.keys(p))
      if (!LEGAL_POINT_FIELD.includes(k)) pf(`unknown field ${k} (allowed: ${LEGAL_POINT_FIELD.join(', ')})`);
    if (typeof p.id !== 'string' || !LEGAL_POINT_ID.test(p.id))
      pf(
        'id must be letters, digits, periods, underscores and hyphens (e.g. J-EXPORT-2), at most 40 characters',
      );
    else if (set.has(p.id)) pf('the id appears twice in the entry');
    else if (ctx.otherPoints?.has(p.id))
      pf(`the id is used in ${ctx.otherPoints.get(p.id)} (point ids are unique in the register)`);
    if (typeof p.id === 'string') set.add(p.id);
    if (!text(p.question)) pf('question missing');
    if (!LEGAL_STATUSES.includes(p.status)) pf(`status must be one of ${LEGAL_STATUSES.join(', ')}`);
    if (!LEGAL_BLOCKS.includes(p.blocks))
      pf(`blocks must be one of ${LEGAL_BLOCKS.join(', ')}`);
    if (p.ai_assessment != null && typeof p.ai_assessment !== 'string')
      pf('ai_assessment must be text or null');
    if (p.deadline != null && !validDate(p.deadline))
      pf('deadline must be a date (YYYY-MM-DD) or null');
    if (p.lawyer != null) {
      const ju = p.lawyer;
      if (!isObject(ju)) pf('lawyer must be { answer, date, source? } or null');
      else {
        for (const k of Object.keys(ju))
          if (!LAWYER_FIELD.includes(k))
            pf(`lawyer: unknown field ${k} (allowed: ${LAWYER_FIELD.join(', ')})`);
        if (!text(ju.answer)) pf('lawyer.answer missing');
        if (!validDate(ju.date)) pf('lawyer.date must be a date (YYYY-MM-DD)');
        if (ju.source != null && typeof ju.source !== 'string') pf('lawyer.source must be text');
      }
    }
    if (p.status === 'ai-assessed' && !text(p.ai_assessment))
      pointAdv('ai-assessed without ai_assessment (short conclusion and path to the note)');
    if (p.status === 'resolved' && p.lawyer == null && !text(p.ai_assessment))
      pointAdv('resolved without a lawyer answer or AI assessment');
    if (p.lawyer != null && LEGAL_OPEN.includes(p.status))
      pointAdv('the lawyer has answered, but the point is still open (set status resolved)');
  }
  return { error, warnings };
}

/** The order of a point: open by working order, then the most serious, then deadline. */
function pointSequence(a, b) {
  const s = (x) => {
    const i = LEGAL_STATUSES.indexOf(x.status);
    return i < 0 ? 99 : i;
  };
  const bl = (x) => {
    const i = LEGAL_BLOCKS.indexOf(x.blocks);
    return i < 0 ? 9 : i;
  };
  const fr = (x) => (validDate(x.deadline) ? x.deadline : '9999-99-99');
  return (
    s(a) - s(b) ||
    bl(a) - bl(b) ||
    fr(a).localeCompare(fr(b)) ||
    String(a.id).localeCompare(String(b.id), 'en')
  );
}

/**
 * All legal points across the plan entries, flat, with entry, module and the legal references. Open ones first
 * (open, ai-assessed, to-lawyer), then blocks prod before packing, then deadline.
 * @returns {object[]}
 */
function legalPoints(reg, queue, { now = new Date() } = {}) {
  const today = osloDate(now);
  const out = [];
  for (const p of reg?.entries ?? []) {
    const j = isObject(p?.legal) ? p.legal : null;
    if (!j) continue;
    for (const x of Array.isArray(j.points) ? j.points : []) {
      if (!isObject(x) || typeof x.id !== 'string') continue;
      out.push({
        id: x.id,
        question: typeof x.question === 'string' ? x.question : '',
        status: x.status ?? 'open',
        open: LEGAL_OPEN.includes(x.status ?? 'open'),
        blocks: x.blocks ?? 'nothing',
        deadline: validDate(x.deadline) ? x.deadline : null,
        deadline_days: validDate(x.deadline) ? daysBetween(today, x.deadline) : null,
        ai_assessment: typeof x.ai_assessment === 'string' ? x.ai_assessment : null,
        lawyer: isObject(x.lawyer) ? x.lawyer : null,
        entry: p.id,
        entry_title: p.title ?? p.id,
        entry_priority: p.priority ?? null,
        project: p.project ?? null,
        module: moduleFor(p, queue?.projects) ?? null,
        affects: Array.isArray(j.affects) ? j.affects.filter((s) => typeof s === 'string') : [],
        privacy: isObject(j.privacy) ? j.privacy : null,
        sources: (p.sources ?? [])
          .filter((k) => isObject(k) && typeof k.path === 'string')
          .map((k) => ({ path: k.path, anchor: k.anchor ?? null })),
      });
    }
  }
  return out.sort(pointSequence);
}

/**
 * Privacy status per module: art. 9 surfaces, DPIA (needed, exists, not-relevant, not assessed) and
 * DPA changes. Only modules with at least one entry that has privacy set; dropped entries are not counted.
 * @returns {{ module: string|null, art9: string[], dpia: Record<string, string[]>, dpa_change: string[] }[]}
 */
function privacyPerModule(reg, queue) {
  const per = new Map();
  for (const p of reg?.entries ?? []) {
    if (p?.priority === 'drop') continue;
    const pv = isObject(p?.legal?.privacy) ? p.legal.privacy : null;
    if (!pv) continue;
    const m = moduleFor(p, queue?.projects) ?? null;
    if (!per.has(m))
      per.set(m, {
        module: m,
        art9: [],
        dpia: { needed: [], exists: [], 'not-relevant': [], unassessed: [] },
        dpa_change: [],
      });
    const r = per.get(m);
    if (pv.art9 === true) {
      r.art9.push(p.id);
      r.dpia[DPIA_VALUES.includes(pv.dpia) ? pv.dpia : 'unassessed'].push(p.id);
    } else if (DPIA_VALUES.includes(pv.dpia)) r.dpia[pv.dpia].push(p.id);
    if (pv.dpa_change === true) r.dpa_change.push(p.id);
  }
  const sequence = modules().map((m) => m.oid);
  const space = (m) => {
    const i = sequence.indexOf(m);
    return i < 0 ? 99 : i;
  };
  return [...per.values()].sort(
    (a, b) => space(a.module) - space(b.module) || String(a.module).localeCompare(String(b.module)),
  );
}

/** The date (YYYY-MM-DD) from an ISO time, otherwise null. */
function isoDay(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * Owner decisions: every owner question in queue.json with what it blocks (plan entries directly and via depends_on,
 * waiting queue tasks and their minutes), deadline, module and project, and how long it has been open.
 *
 * The sorting of the open ones (the top is "answer this first"):
 *   1. deadline overdue or within DECISION_URGENT_DAYS, earliest first,
 *   2. most blocked plan entries,
 *   3. most minutes waiting in the queue,
 *   4. deadline (no deadline last), then oldest first, then id.
 * The answered ones (the history) are separate, newest answer first.
 * @returns {{ openOnes: object[], answered: object[] }}
 */
function ownerDecisions(reg, queue, { now = new Date() } = {}) {
  const today = osloDate(now);
  const resolved = new Set(queue?.resolved ?? []);
  const entries = (reg?.entries ?? []).filter((p) => p?.priority !== 'drop');
  const perSp = new Map();
  const fa = (sp) => {
    if (!perSp.has(sp)) perSp.set(sp, { entries: new Set(), tasks: [] });
    return perSp.get(sp);
  };
  for (const p of entries)
    for (const sp of p.ownerQuestions ?? []) if (typeof sp === 'string') fa(sp).entries.add(p.id);
  for (const o of queue?.tasks ?? []) {
    if (o?.status !== 'waiting' && o?.status !== 'proposed') continue;
    for (const sp of o.waiting_on ?? []) if (typeof sp === 'string') fa(sp).tasks.push(o);
  }
  const ids = new Set([...Object.keys(queue?.question ?? {}), ...perSp.keys()]);
  const openOnes = [];
  const answered = [];
  for (const sp of ids) {
    const q = Object.hasOwn(queue?.question ?? {}, sp) ? queue.question[sp] : null;
    const links = perSp.get(sp) ?? { entries: new Set(), tasks: [] };
    const direct = [...links.entries];
    const blocked = new Set(direct);
    for (const id of direct) {
      const p = entries.find((x) => x.id === id);
      if (p) for (const b of blocks(p, entries)) blocked.add(b.id);
    }
    const waiting = links.tasks.filter((o) => o.status === 'waiting');
    const minutes = waiting.reduce(
      (n, o) => n + (Number(o.content_min ?? TASK_MIN_DEFAULT) || 0),
      0,
    );
    const deadlines = [
      validDate(q?.deadline) ? q.deadline : null,
      ...direct.map((id) => entries.find((x) => x.id === id)?.deadline),
    ].filter((d) => validDate(d));
    const deadline = deadlines.length ? deadlines.sort()[0] : null;
    const modules = new Set();
    const projects = new Set();
    for (const id of direct) {
      const p = entries.find((x) => x.id === id);
      if (!p) continue;
      if (p.project) projects.add(p.project);
      const m = moduleFor(p, queue?.projects);
      if (m) modules.add(m);
    }
    for (const o of links.tasks) {
      if (!o.project) continue;
      projects.add(o.project);
      const m = queue?.projects?.[o.project]?.area;
      if (m) modules.add(m);
    }
    const added = isoDay(q?.added_at);
    const answer = queue?.resolutions?.[sp] ?? null;
    const row = {
      id: sp,
      type: q?.type ?? 'question',
      action: q?.type === OWNER_ACTION_TYPE,
      text: q?.text ?? null,
      recommendation: q?.recommendation ?? null,
      source: q?.source ?? null,
      added_at: added,
      days_open: added ? Math.max(0, daysBetween(added, today)) : null,
      resolved: resolved.has(sp),
      answer: typeof answer?.answer === 'string' ? answer.answer : null,
      answer_time: typeof answer?.time === 'string' ? answer.time : null,
      answer_by: typeof answer?.by === 'string' ? answer.by : null,
      entries: direct.sort(),
      blocked_entries: [...blocked].sort(),
      tasks: waiting.map((o) => o.id),
      proposed: links.tasks.filter((o) => o.status === 'proposed').map((o) => o.id),
      minutes,
      deadline,
      deadline_days: deadline ? daysBetween(today, deadline) : null,
      modules: [...modules].sort(),
      projects: [...projects].sort(),
    };
    row.urgent = row.deadline_days != null && row.deadline_days <= DECISION_URGENT_DAYS;
    (row.resolved ? answered : openOnes).push(row);
  }
  openOnes.sort(
    (a, b) =>
      Number(b.urgent) - Number(a.urgent) ||
      (a.urgent ? a.deadline.localeCompare(b.deadline) : 0) ||
      b.blocked_entries.length - a.blocked_entries.length ||
      b.minutes - a.minutes ||
      (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') ||
      (b.days_open ?? -1) - (a.days_open ?? -1) ||
      a.id.localeCompare(b.id, 'en'),
  );
  answered.sort(
    (a, b) =>
      String(b.answer_time ?? '').localeCompare(String(a.answer_time ?? '')) ||
      a.id.localeCompare(b.id, 'en'),
  );
  return { openOnes, answered };
}

/**
 * Launch overview: "what stands between us and the first paying customer?". A view, not a store:
 *   - entries: plan entries in Now with the category for-prod (done = built or verified),
 *   - legal: open legal points that block prod,
 *   - actions: open owner actions (type owner-task), with deadline first,
 *   - decisions: other open owner questions linked to a for-prod entry,
 *   - documents: documents marked Now before prod that have something that must be done (the reasons from docReasons).
 * @returns {{ entries: object[], legal: object[], actions: object[], decisions: object[],
 *   documents: object[], remaining: number, total: number }}
 */
function launchOverview(reg, queue, { now = new Date() } = {}) {
  const forProd = (reg?.entries ?? []).filter(
    (p) => p?.priority === 'now' && (p.now_category ?? []).includes('for-prod'),
  );
  const entries = forProd
    .map((p) => {
      const by = derivedMaturity(p, queue?.tasks, { now });
      return {
        id: p.id,
        title: p.title ?? p.id,
        project: p.project ?? null,
        module: moduleFor(p, queue?.projects) ?? null,
        maturity: by.maturity,
        fraction: by.fraction ?? null,
        deadline: validDate(p.deadline) ? p.deadline : null,
        done: by.maturity === 'built' || by.maturity === 'verified',
      };
    })
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') ||
        a.id.localeCompare(b.id, 'en'),
    );
  const legal = legalPoints(reg, queue, { now }).filter(
    (x) => x.open && x.blocks === 'prod' && x.entry_priority !== 'drop',
  );
  const b = ownerDecisions(reg, queue, { now });
  const forProdIds = new Set(forProd.map((p) => p.id));
  const actions = b.openOnes
    .filter((x) => x.action)
    .sort(
      (x, y) =>
        (x.deadline ?? '9999').localeCompare(y.deadline ?? '9999') || x.id.localeCompare(y.id, 'en'),
    );
  const decisions = b.openOnes.filter(
    (x) => !x.action && x.entries.some((id) => forProdIds.has(id)),
  );
  const documents = docMustBeDone(
    (reg?.documents ?? []).filter(
      (d) => d?.priority === 'now' && (d.now_category ?? []).includes('for-prod'),
    ),
    { now },
  );
  const left = entries.filter((p) => !p.done).length;
  const remaining =
    left + legal.length + actions.length + decisions.length + documents.length;
  return {
    entries,
    legal,
    actions,
    decisions,
    documents,
    remaining,
    total:
      entries.length + legal.length + actions.length + decisions.length + documents.length,
  };
}

/**
 * The path to the lawyer package for a date (relative to mainTree). It lives in the data folder (queue.config.json
 * `dataFolder`, which must be gitignored), so the draft never ends up in git.
 */
function lawyerPackagePath(date, { folder = config().dataFolder } = {}) {
  if (!validDate(date)) throw new Error(`invalid date ${date}`);
  return `${String(folder).replace(/\\/g, '/').replace(/\/+$/, '')}/lawyerPackages/lawyer-package-${date}.md`;
}

/** One line of markdown without line breaks (free text from the register must not be able to create new headings). */
function oneLine(s) {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * The lawyer package: the points with status to-lawyer combined into one draft with context, AI assessment,
 * legal references and plan links. Text only; the file is written locally by the board (in the data folder, gitignored)
 * and is never sent. Dropped entries are not included.
 * @returns {{ path: string, text: string, points: string[] }}
 */
function lawyerPackage(reg, queue, { date = null, now = new Date() } = {}) {
  const day = date ?? osloDate(now);
  const filePath = lawyerPackagePath(day);
  const points = legalPoints(reg, queue, { now }).filter(
    (x) => x.status === 'to-lawyer' && x.entry_priority !== 'drop',
  );
  const moduleName = (m) =>
    queue?.areas?.[m]?.title ?? modules().find((x) => x.oid === m)?.title ?? m ?? 'No module';
  const l = [];
  l.push(`# Lawyer package ${day}`, '');
  l.push(
    'Draft made from the plan register (scripts/.queue/plans.json) by queueBoard. It has not been sent to anyone. Read it through,',
    'remove what should not be included, and send it yourself.',
    '',
  );
  if (!points.length) {
    l.push('No legal points have status to-lawyer.', '');
    return { path: filePath, text: `${l.join('\n')}`, points: [] };
  }
  l.push(
    `Points: ${points.length}. Sorted by what they block (prod before packing) and deadline.`,
    '',
  );
  l.push('| Point | Blocks | Deadline | Plan |', '|---|---|---|---|');
  for (const x of points)
    l.push(
      `| ${x.id} | ${x.blocks} | ${x.deadline ?? ''} | ${x.entry} ${oneLine(x.entry_title).replace(/\|/g, '/')} |`,
    );
  l.push('');
  for (const x of points) {
    l.push(`## ${x.id}: ${oneLine(x.question)}`, '');
    l.push(`- Plan: ${x.entry} ${oneLine(x.entry_title)}`);
    l.push(`- Module and project: ${moduleName(x.module)}, ${x.project ?? 'no project'}`);
    l.push(`- Blocks: ${x.blocks}${x.deadline ? `, deadline ${x.deadline}` : ''}`);
    if (x.affects.length) l.push(`- Legal references: ${x.affects.map(oneLine).join('; ')}`);
    const pv = x.privacy;
    if (pv) {
      const parts = [
        pv.art9 ? 'art. 9 data' : 'not art. 9',
        pv.dpia ? `DPIA ${pv.dpia}` : 'DPIA not assessed',
        pv.dpa_change ? 'DPA must be changed' : null,
      ].filter(Boolean);
      l.push(`- Privacy: ${parts.join(', ')}`);
    }
    l.push(`- AI assessment: ${x.ai_assessment ? oneLine(x.ai_assessment) : 'none yet'}`);
    if (x.sources.length)
      l.push(
        `- Plan links: ${x.sources.map((k) => `${k.path}${k.anchor ? ` (${oneLine(k.anchor)})` : ''}`).join('; ')}`,
      );
    l.push('');
  }
  return { path: filePath, text: l.join('\n'), points: points.map((x) => x.id) };
}

module.exports = {
  PRIORITIES,
  NOW_CATEGORIES,
  SET_BY,
  MATURITY_MANUAL,
  MATURITY_DERIVED,
  MATURITIES,
  SIZES,
  STALE_DAYS,
  CHANGELOG_MAX,
  // The priority rules from the configuration (or the default), read on every lookup.
  get PRIORITY_RULES() {
    return priorityRules();
  },
  DEFAULT_PRIORITY_RULES,
  priorityRules,
  FIELD,
  emptyRegister,
  normalize,
  osloDate,
  validDate,
  idUsed,
  findEntry,
  moduleFor,
  sourcePathError,
  validateEntry,
  ruleAgainstPriority,
  ruleNrFromReason,
  measuredRule,
  blocks,
  priorityAccess,
  newEntry,
  editEntry,
  prioritize,
  prioritizeMany,
  verify,
  combineTogether,
  queueTasksFor,
  isStale,
  derivedMaturity,
  sortEntries,
  filterEntries,
  get,
  copyLine,
  planDiff,
  logChange,
  lastUndoable,
  undo,
  expectCheck,
  parseFieldArg,
  // Modules and suggestions from the configuration, read on every lookup (P.MODULES works as before).
  get MODULES() {
    return modules();
  },
  get PROJECT_MODULE_SUGGESTION() {
    return projectModuleSuggestion();
  },
  modules,
  projectModuleSuggestion,
  PROJECT_PHASES,
  SIZE_TRACK,
  CAPACITY_WINDOW_DAYS,
  get UNREGISTERED_EXCEPTION() {
    return unregisteredException();
  },
  get DOCUMENT_FOLDERS() {
    return documentFolders();
  },
  unregisteredException,
  documentFolders,
  modulePlan,
  phasePlanEnds,
  planLinkError,
  linkPlan,
  anchorText,
  anchorSection,
  docStatus,
  SOURCE_ROLES_WITHOUT_STATUS,
  duplicates,
  capacity,
  check,
  ACTIVE_SESSION_HOURS,
  isActiveSession,
  activeEntries,
  setActiveSession,
  DOC_GROUPS,
  DOC_AUDIENCES,
  DOC_STATUSES,
  DOC_PUBLISHED_WHERE,
  DOC_SEVERITY,
  DOC_FIELD,
  DOC_REVISION_SOON_DAYS,
  findDoc,
  revisionInterval,
  nextRevision,
  versionSkew,
  docReasons,
  docMustBeDone,
  revisionTimeline,
  docCopyLine,
  validateDoc,
  newDoc,
  editDoc,
  reviseDoc,
  filterDoc,
  getDoc,
  DOC_CHECKS,
  docSettings,
  parseVendors,
  sectionInText,
  vendorsInText,
  checkVendors,
  checkRevisions,
  assessWebAnswer,
  webAddresses,
  docConsistency,
  syncConsistency,
  LEGAL_STATUSES,
  LEGAL_OPEN,
  LEGAL_BLOCKS,
  DPIA_VALUES,
  DECISION_URGENT_DAYS,
  OWNER_ACTION_TYPE,
  validateLegal,
  legalPoints,
  privacyPerModule,
  ownerDecisions,
  launchOverview,
  lawyerPackagePath,
  lawyerPackage,
};
