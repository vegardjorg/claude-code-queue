// =============================================================
// missionText.js: pure text logic for make-queue-common.mjs and make-mission.mjs. See docs/orchestration.md.
//
// Why: the shared protocol is pasted into EVERY track prompt and stays in the context for all turns. The parts that
// only apply to D and D+ (DB, self-review, full gate) therefore sit in class sections that are only included for the
// classes that need them, and pointers such as "file.md § 3" get their line range appended, so the track reads only that section.
//
//   makeQueueCommon(template, scratch, k) the shared part of the mission template (docs/queue/mission-template.md), filled for queue and
//                                project (k = config(): projectName, baseBranch, gates, architectureRules)
//   filterClass(text, k)      keeps only the <!-- class: … --> … <!-- /class --> sections that apply to class k
//   classFromBlock(body)        the class in a track block ("class D+" in the ## TRACK line, or a CLASS: line)
//   sectionPointers(text, read)   appends "(line A–B)" after "file.md § N" and "file.md#heading"
// No I/O here (the read function and the config are injected); test: __tests__/missionText.test.ts.
// =============================================================

const CLASSES = ['K', 'D', 'D+', 'U'];

// Split/join, never String.replace (a replacement containing "$'" duplicates text).
const swap = (s, from, to) => s.split(from).join(to);

const CODE = '`';

/** The gate list as text: the commands in order, or "none set up". */
function gateText(list) {
  const l = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : [];
  return l.length ? l.map((x) => CODE + x + CODE).join(', ') : 'none set up in queue.config.json';
}

/**
 * Shared protocol for the queue tracks, with the placeholders __BRANCH__ __HEAD__ __TRACK__ __BLOCK__ left in (they are
 * filled per track by make-mission.mjs). The class markers are kept; make-mission filters per track.
 * @param {string} template the whole mission template (docs/queue/mission-template.md)
 * @param {string} scratch the scratchpad root
 * @param {{ projectName?: string, baseBranch?: string, gates?: { quick?: string[], full?: string[] },
 *   architectureRules?: string[] }} [k] the project config (config()); missing fields give neutral defaults
 */
function makeQueueCommon(template, scratch, k = {}) {
  const start = template.search(/^## Common protocol/m);
  if (start < 0) throw new Error('could not find "## Common protocol" in the mission template');
  const base = k.baseBranch || 'main';
  const rules = Array.isArray(k.architectureRules)
    ? k.architectureRules.filter((r) => typeof r === 'string' && r.trim())
    : [];
  let s = template.slice(start);
  // Saver mode: the track reads only its own part of the source, in excerpts.
  s = swap(
    s,
    '<READ_ALSO>',
    [
      'The source the track block names: read only the part that applies to this track (`grep -n` on the id or',
      '  heading, then excerpts with `offset`/`limit`).',
      ...(rules.length
        ? ['- The project architecture rules (binding, from `queue.config.json`):', ...rules.map((r) => `  - ${r}`)]
        : []),
    ].join('\n'),
  );
  s = swap(
    s,
    '<OWNERSHIP>',
    [
      'Your ownership is listed in the track block. Other tasks run at the same time and own their files',
      '(`node scripts/orchestrator/queue.mjs show`, works from the worktree). Never touch what they own.',
      '',
      '**New work you discover** (outside the mission, or a follow-up bug): do not do it yourself. Write a JSON file with',
      'Write (id, title, domain, class K|D|D+|U, mission = short self-contained description, value 1-10, content_min,',
      'depends_on, waiting_on, owned_files, shared_patch, source, added_by = your track id) and run',
      '`node scripts/orchestrator/queue.mjs add --file <file>`. It becomes a proposal the owner approves. Mention the id in',
      'the report, and a HIGH security finding in its own section.',
    ].join('\n'),
  );
  s = swap(s, '<BRANCH>', '__BRANCH__');
  s = swap(s, '<HEAD>', '__HEAD__');
  s = swap(s, '<BLOCK>', '__BLOCK__');
  s = swap(s, '<TRACK>', '__TRACK__');
  s = swap(s, '<base>', base);
  s = swap(s, '<scratchpad-root>', scratch);
  s = swap(s, '<scratchpad>', scratch);
  const header = [
    '## SHARED PROTOCOL FOR TRACKS FROM THE WORK QUEUE (binding)',
    '',
    'Made from `docs/queue/mission-template.md`' +
      (k.projectName ? ` for ${k.projectName}` : '') +
      '. Other tracks start and finish while you work. The class (K, D, D+, U) is in the track block; the parts ' +
      'below are selected for it.',
    `Base branch: ${CODE}${base}${CODE}. Quick gate: ${gateText(k.gates?.quick)}. ` +
      `Full gate: ${gateText(k.gates?.full)}.`,
    '',
    '',
  ].join('\n');
  return header + s.replace(/^## Common protocol[^\n]*\n/, '');
}

const START = /^\s*<!--\s*class:\s*([^>]*?)\s*-->\s*$/;
const END = /^\s*<!--\s*\/class\s*-->\s*$/;

/**
 * Keeps only the class sections that apply to the class. An unknown or missing class gives EVERYTHING (safe: nothing
 * binding is dropped). The marker lines are always removed, and three or more line breaks are collapsed to two.
 * @param {string} text
 * @param {string|null} class K, D, D+ or U
 */
function filterClass(text, cls) {
  const known = CLASSES.includes(cls);
  const stack = [];
  const out = [];
  for (const l of String(text).split('\n')) {
    const m = l.match(START);
    if (m) {
      stack.push(m[1].split(/[\s,]+/).filter(Boolean));
      continue;
    }
    if (END.test(l)) {
      if (!stack.length) throw new Error('<!-- /class --> without a start');
      stack.pop();
      continue;
    }
    if (!known || stack.every((list) => list.includes(cls))) out.push(l);
  }
  if (stack.length) throw new Error('<!-- class: … --> without <!-- /class -->');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * The class in a track block: a separate "CLASS: X" line wins, otherwise "class X" in the ## TRACK heading (queue.mjs writes
 * "## TRACK id (title; source: …; class D+, estimate 40 min)"). Null when there is none.
 * @param {string} body
 */
function classFromBlock(body) {
  const lines = String(body).split(/\r?\n/);
  const own = lines.find((l) => /^CLASS:/.test(l));
  const candidate = own
    ? own.slice('CLASS:'.length).trim()
    : (lines.find((l) => /^## TRACK\b/.test(l))?.match(/\bclass\s+(D\+|[KDU])(?![\w+])/)?.[1] ??
      null);
  return CLASSES.includes(candidate) ? candidate : null;
}

/** GitHub-style slug of a heading: lowercase, punctuation removed, whitespace to hyphens. */
function slug(t) {
  return String(t)
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * The line range (1-based, inclusive) of the section the pointer refers to, or null.
 * § N: a heading that starts with N (also "§ N", "N.", "N)" or "N:"), but not N.M when only N is referenced.
 * #anchor: a heading with the same slug, otherwise one that contains the anchor (hyphens as whitespace).
 * @param {string} text the whole document
 * @param {{ section?: string, anchor?: string }} p
 */
function sectionArea(text, { section, anchor }) {
  const lines = String(text).split(/\r?\n/);
  const headings = [];
  let inCode = false;
  lines.forEach((l, i) => {
    if (/^```/.test(l)) inCode = !inCode;
    const m = !inCode && l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) headings.push({ i, level: m[1].length, text: m[2] });
  });
  let match = null;
  if (section) {
    const esc = section.replace(/\./g, '\\.');
    const re = new RegExp(`^(?:§\\s*)?${esc}(?:$|[\\s):]|\\.(?!\\d))`);
    match = headings.find((o) => re.test(o.text.trim()));
  } else if (anchor) {
    const a = anchor.toLowerCase();
    match =
      headings.find((o) => slug(o.text) === a) ??
      headings.find((o) => o.text.toLowerCase().includes(a.replace(/-/g, ' ')));
  }
  if (!match) return null;
  const next = headings.find((o) => o.i > match.i && o.level <= match.level);
  let end = next ? next.i : lines.length;
  while (end > match.i + 1 && !lines[end - 1].trim()) end--; // empty lines at the end do not count
  return { from: match.i + 1, to: end };
}

// "docs/x.md § 6", "`docs/x.md` § 6.2", "`docs/x.md#heading`", also with an absolute Windows path. A closing
// backtick is included in the match, so "(line A–B)" ends up outside the code span.
const POINTER =
  /`?((?:[A-Za-z]:[\\/])?[\w.\\/-]*[\w-]\.md)`?(?:\s*§\s*(\d+(?:\.\d+)*)(?![\d.]\d)|#([\p{L}\p{N}_-]+)(?![\p{L}\p{N}_-]))`?(?!`?\s*\(line)/gu;

/**
 * Appends "(line A–B)" after every section pointer that can be looked up. Pointers without a section, and pointers to
 * files or sections that do not exist, are left untouched (backward compatible).
 * @param {string} text the mission
 * @param {(file: string) => string|null} read reads a document (path relative to the repo root, or absolute)
 */
function sectionPointers(text, read) {
  const cache = new Map();
  const get = (file) => {
    if (!cache.has(file)) {
      let t = null;
      try {
        t = read(file);
      } catch {
        t = null;
      }
      cache.set(file, t);
    }
    return cache.get(file);
  };
  return String(text).replace(POINTER, (whole, file, section, anchor) => {
    const doc = get(file);
    if (doc == null) return whole;
    const o = sectionArea(doc, { section, anchor });
    return o ? `${whole} (line ${o.from}–${o.to})` : whole;
  });
}

module.exports = {
  CLASSES,
  gateText,
  makeQueueCommon,
  filterClass,
  classFromBlock,
  sectionArea,
  sectionPointers,
};
