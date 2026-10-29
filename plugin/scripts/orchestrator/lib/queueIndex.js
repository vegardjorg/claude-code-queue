// =============================================================
// queueIndex.js: an optional document index (a markdown file, default docs/INDEX.md) ordered by the plan register.
//
// The feature is optional: a project without indexFile notices nothing. The path is in queue.config.json (`indexFile`;
// null turns it off), and which folders count as tracked documents is in `documentFolders` (default docs).
// See docs/plan-register.md.
//
// Why: the plan register (plans.json in the data folder) is the truth about the plans. INDEX is the document list the
// agents read (it is tracked, the register is not). To keep a single source, the structure of INDEX is built from the register:
//   - which module a document belongs to (via the plan entries that point to it and the project's `area`),
//   - which plan entries point to it (the "Plan entries: …" line),
//   - new tracked documents that a plan entry points to but that lack a line.
// The description of each document (the text after the path) is written by hand and kept verbatim. It does not exist in
// the register (a source is only { path, anchor, role }), so the generator reads it from INDEX itself and writes it back.
// The generator is therefore idempotent: two runs in a row give the same file, and "drift" means the register has changed
// since last time (or that someone has edited the structure by hand).
//
// Pure functions (no file, no clock): whatever needs the file system is passed in. Modules and folders come from
// the configuration when not passed in. CLI: scripts/orchestrator/make-index.mjs. Tests: lib/__tests__/queueIndex.test.ts.
// =============================================================
'use strict';

const P = require('./queuePlan.js');
const { config } = require('./queueConfig.js');

/** The default path of the index file (relative to the project root) when queue.config.json says nothing. */
const INDEX_DEFAULT = 'docs/INDEX.md';

/** The index file from queue.config.json (`indexFile`): a relative path, or null when the feature is turned off. */
function indexFile() {
  const f = config().indexFile;
  if (f === null) return null;
  return typeof f === 'string' && f.trim() ? f.trim().replace(/\\/g, '/') : INDEX_DEFAULT;
}

/** The start of the generated line with the plan entries below an item. The line is removed on read and made again. */
const PLAN_ENTRIES_PREFIX = '  Plan entries: ';
/** More entries than this are shown as a count with a search command, so the line does not become a wall (the roadmap has ~100). */
const MAX_ENTRIES_ON_LINE = 6;
/** If a document points to entries in at least this many modules, it ends up under "Cross-cutting". */
const CROSS_CUTTING_MODULES = 3;
/**
 * The source roles that get a new item automatically. INDEX is the list of plans and reference works; history, investigations
 * and finding reports that only back an entry live in the register and need no line of their own (they can still
 * be added by hand, and are then kept). A source without a role counts as a plan.
 */
const AUTO_ROLES = ['plan', 'reference'];

const SECTION_CROSS_CUTTING = {
  oid: 'crossCutting',
  title: 'Cross-cutting (plan entries in several modules)',
};
const SECTION_UNLINKED = { oid: 'unlinked', title: 'Not linked to a plan entry' };

/**
 * The order of the sections: modules as the configuration lists them, then cross-cutting, then unlinked.
 * @param {{ oid: string, title: string }[]} [modules] default: queuePlan.modules()
 */
function sections(modules = P.modules()) {
  return [
    ...modules.map((m) => ({ oid: m.oid, title: m.title })),
    SECTION_CROSS_CUTTING,
    SECTION_UNLINKED,
  ];
}

/** The paths an item covers: the backtick paths at the start of the line, separated by "·", "and" or a comma. */
function pathsInEntry(firstLine) {
  const m = /^- ((?:`[^`]+`)(?:\s*(?:·|and|,)\s*`[^`]+`)*)/.exec(firstLine);
  if (!m) return [];
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
}

/**
 * Reads INDEX: the introduction (everything before the first item or section) and the items. The section headings and
 * plan entry lines are generated and discarded. Any other line in the body (not indented, not "- ", not "## ") is an
 * error: it would otherwise silently disappear on the next generation.
 * @param {string} text
 * @returns {{ introduction: string[], entries: { paths: string[], lines: string[] }[], error: string[] }}
 */
function readIndex(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const introduction = [];
  const entries = [];
  const error = [];
  let inBodyText = false;
  let now = null;
  lines.forEach((line, i) => {
    const isEntry = line.startsWith('- ');
    const isSection = line.startsWith('## ');
    if (!inBodyText && !isEntry && !isSection) {
      introduction.push(line);
      return;
    }
    inBodyText = true;
    if (isSection || line.trim() === '') {
      now = null;
      return;
    }
    if (isEntry) {
      const paths = pathsInEntry(line);
      if (!paths.length)
        error.push(`line ${i + 1}: the item does not start with a path in backticks`);
      now = { paths, lines: [line] };
      entries.push(now);
      return;
    }
    if (/^\s/.test(line) && now) {
      if (!line.startsWith(PLAN_ENTRIES_PREFIX)) now.lines.push(line);
      return;
    }
    error.push(
      `line ${i + 1}: unknown line in the body (neither item, indent nor section)`,
    );
  });
  while (introduction.length && introduction[introduction.length - 1].trim() === '') introduction.pop();
  return { introduction, entries, error };
}

/** Does a sourcePath match an item path? The same path, or below a folder (the item path ends with "/"). */
function pathMatches(entryPath, sourcePath) {
  if (entryPath === sourcePath) return true;
  return entryPath.endsWith('/') && sourcePath.startsWith(entryPath);
}

/** Entries (active ones, not the archive) that point to one of the paths, sorted by id. */
function entriesFor(paths, entries) {
  return entries
    .filter((p) => (p.sources ?? []).some((k) => paths.some((s) => pathMatches(s, k.path))))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The section an item ends up in: no entries gives "unlinked"; entries in at least CROSS_CUTTING_MODULES modules give
 * "cross-cutting"; otherwise the module most of the entries belong to (a tie: the first in module order). An entry
 * without a module (the project lacks `area`) counts as `without-module`.
 */
function sectionFor(entriesHere, projects, modules = P.modules()) {
  if (!entriesHere.length) return SECTION_UNLINKED.oid;
  const tally = new Map();
  for (const p of entriesHere) {
    const oid = projects?.[p.project]?.area ?? 'without-module';
    tally.set(oid, (tally.get(oid) ?? 0) + 1);
  }
  if (tally.size >= CROSS_CUTTING_MODULES) return SECTION_CROSS_CUTTING.oid;
  const order = sections(modules).map((s) => s.oid);
  const space = (oid) => (order.includes(oid) ? order.indexOf(oid) : order.length);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || space(a[0]) - space(b[0]))[0][0];
}

/** The generated line with the plan entries, or null when no entry points to the document. */
function planEntriesLine(paths, entriesHere) {
  if (!entriesHere.length) return null;
  if (entriesHere.length > MAX_ENTRIES_ON_LINE)
    return `${PLAN_ENTRIES_PREFIX}${entriesHere.length} entries, see \`${require('./projectRoot.js').cqCommand()} plan show --search ${paths[0]}\`.`;
  return `${PLAN_ENTRIES_PREFIX}${entriesHere.map((p) => `\`${p.id}\``).join(', ')}.`;
}

/**
 * Tracked documents that a plan entry points to with a role in AUTO_ROLES, but that lack an item: below one of the
 * document folders and not the index file itself. The description comes from the first entry (lowest id) that points to
 * the document with such a role. `exists` checks that the file is there and is tracked (make-index.mjs filters out what git
 * ignores); dead paths are reported by `plan check`, not here.
 * @param {{ folders?: string[], index?: string|null }} [o] folders: the document folders (default queuePlan.documentFolders()),
 *   index: the index file (default indexFile())
 */
function newDocuments(indexEntries, entries, exists = () => true, o = {}) {
  const folders = (o.folders ?? P.documentFolders()).map((m) => `${String(m).replace(/\/+$/, '')}/`);
  const index = o.index !== undefined ? o.index : indexFile();
  const known = (filePath) => indexEntries.some((o) => o.paths.some((s) => pathMatches(s, filePath)));
  const newOnes = new Map();
  for (const p of [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const k of p.sources ?? []) {
      const filePath = k.path;
      if (!AUTO_ROLES.includes(k.role ?? 'plan')) continue;
      if (typeof filePath !== 'string' || !folders.some((m) => filePath.startsWith(m))) continue;
      if (filePath === index || newOnes.has(filePath) || known(filePath) || !exists(filePath)) continue;
      newOnes.set(filePath, p);
    }
  }
  return [...newOnes.keys()].sort().map((filePath) => {
    const first = newOnes.get(filePath);
    return {
      paths: [filePath],
      lines: [
        `- \`${filePath}\`: ${first.title} (the description is taken from the plan entry; write a better one if needed).`,
      ],
      new: true,
    };
  });
}

/**
 * Makes INDEX again.
 * @param {string} text the current INDEX
 * @param {{ entries?: object[] }} reg the plan register
 * @param {{ projects?: Record<string, { area?: string }> }} queue the queue (projects give the module)
 * @param {{ exists?: (path: string) => boolean, modules?: object[], folders?: string[], index?: string|null }} ctx
 *   modules, folders and index override the configuration (tests)
 * @returns {{ text: string, error: string[], newOnes: string[], count: Record<string, number> }}
 */
function makeIndex(text, reg, queue, ctx = {}) {
  const read = readIndex(text);
  const entries = reg?.entries ?? [];
  const projects = queue?.projects ?? {};
  const modules = ctx.modules ?? P.modules();
  const newOnes = newDocuments(read.entries, entries, ctx.exists, ctx);
  const all = [...read.entries, ...newOnes].map((o, nr) => {
    const entriesHere = entriesFor(o.paths, entries);
    return {
      ...o,
      nr,
      section: sectionFor(entriesHere, projects, modules),
      planEntries: planEntriesLine(o.paths, entriesHere),
    };
  });
  const sortKey = (o) => (o.paths[0] ?? '').toLowerCase();
  const out = [...read.introduction, ''];
  const count = {};
  for (const s of sections(modules)) {
    const here = all
      .filter((o) => o.section === s.oid)
      .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : a.nr - b.nr));
    if (!here.length) continue;
    count[s.oid] = here.length;
    out.push(`## ${s.title}`, '');
    for (const o of here) {
      out.push(...o.lines);
      if (o.planEntries) out.push(o.planEntries);
    }
    out.push('');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return { text: `${out.join('\n')}\n`, error: read.error, newOnes: newOnes.map((o) => o.paths[0]), count };
}

/** The first line (1-based) where two texts differ, or null when they are equal (line breaks normalized). */
function firstDifference(a, b) {
  const la = a.replace(/\r\n/g, '\n').split('\n');
  const lb = b.replace(/\r\n/g, '\n').split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++)
    if (la[i] !== lb[i]) return { line: i + 1, now: la[i] ?? null, new: lb[i] ?? null };
  return null;
}

module.exports = {
  PLAN_ENTRIES_PREFIX,
  MAX_ENTRIES_ON_LINE,
  CROSS_CUTTING_MODULES,
  AUTO_ROLES,
  INDEX_DEFAULT,
  indexFile,
  get SECTIONS() {
    return sections();
  },
  sections,
  pathsInEntry,
  readIndex,
  pathMatches,
  entriesFor,
  sectionFor,
  planEntriesLine,
  newDocuments,
  makeIndex,
  firstDifference,
};
