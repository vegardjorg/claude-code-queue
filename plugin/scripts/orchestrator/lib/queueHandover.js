// =============================================================
// queueHandover.js: the ongoing handover note in two parts. See docs/orchestration.md.
//
// Why: <dataFolder>/handover-ongoing.md (contextGuard.HANDOVER_NOTE) grows to thousands of lines when the orchestrator
// logs every merge and decision in it, and a takeover or a compaction that reads the whole note pays for every one of
// those tokens on every turn for the rest of the cycle. The note is therefore split into:
//   - "Now" (at most 40 lines: active tracks, open owner questions, push status, next step) and the active trial or
//     follow-up section, which stay in handover-ongoing.md,
//   - the archive <dataFolder>/handover-archive/<year-month>.md, where dated log entries older than 24 h end up (read
//     with grep when needed, never at startup).
//
// The rules (pure functions, tested in lib/__tests__/queueHandover.test.ts; `queue.mjs handover` does the file I/O):
//   - The note is split into a header (everything before the first `## `), sections (`## …`) and entries. An entry is
//     one top-level line (a bullet, a paragraph, a `###` heading or a `## HH:MM …` log line) with the indented lines
//     under it.
//   - The header, the "Now" section (`## Now …`, `## Nå …` is accepted too) and an active trial or follow-up section (a
//     heading with "trial" or "follow-up"/"follow up" where the last date in the heading has not passed, or that has no
//     date) are never moved.
//   - An entry gets its time from the date at the start of the line (2026-10-24, 24.10, 24.10.2026, with or without a
//     time of day, also 09:2x). Without its own date it inherits from the previous entry in the section, and then from
//     the heading. A time of day alone (`## 18:39 …`) uses the date it inherits. A date without a time of day counts
//     until the end of that day.
//   - Entries with a time older than 24 h before `now` move to the archive for their month, under their section
//     heading. Entries without any time stay (never guessing).
//   - Idempotent: what has been moved is gone from the note, so a new run moves nothing.
// All dates are local time (the machine's time zone), as the orchestrator writes them.
// =============================================================
'use strict';

const NOW_MAX_LINES = 40;
const AGE_MS = 24 * 60 * 60 * 1000;

/** A time-of-day part "09", "2x" or "xx": x reads as 9 (the latest minute), so a rough time is never archived too early. */
function num(s, xValue = 9) {
  if (s == null) return null;
  return Number(String(s).replace(/x/gi, String(xValue)));
}

/** A local time, or null for an invalid date. Without a time of day: the end of the day. */
function makeTime(year, month, day, hour, minute) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hasTime = hour != null;
  if (hasTime && (hour > 23 || minute > 59)) return null;
  const d = hasTime
    ? new Date(year, month - 1, day, hour, minute ?? 59, 59, 999)
    : new Date(year, month - 1, day, 23, 59, 59, 999);
  if (d.getMonth() !== month - 1) return null; // 31.02 and the like
  return d;
}

/** The year for "DD.MM" without a year: this year, or last year when the date would lie more than a month ahead. */
function guessYear(month, day, now) {
  const year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  return candidate.getTime() - now.getTime() > 31 * 24 * 60 * 60 * 1000 ? year - 1 : year;
}

const RE_ISO = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})[:.]?(\d{2}|\dx|xx)?)?/;
const RE_DOT =
  /(?<![\d.])(\d{2})\.(\d{2})(?:\.(\d{4}))?(?![\d.]*\d)(?:\s+(?:(?:kl|at)\.?\s*)?(\d{1,2}):(\d{2}|\dx|xx)\b)?/;
const RE_TIME_FIRST = /^(\d{1,2}):(\d{2}|\dx|xx)\s+(\d{2})\.(\d{2})(?:\.(\d{4}))?\b/;
const RE_TIME_ONLY = /^(\d{1,2}):(\d{2}|\dx|xx)\b/;

/**
 * The date at the start of a text (after a bullet, heading marks and bold).
 * Answer: { time: Date } with a full date, { timeOnly: { hour, minute } } with only a time of day, or null.
 * `wholeText` = search the whole text (headings); otherwise only the first 30 characters (log lines).
 */
function parseDate(text, now, { wholeText = false } = {}) {
  const clean = String(text)
    .replace(/^\s*(?:#{1,6}\s+|[-*]\s+)?/, '')
    .replace(/^\*\*/, '');
  const window = wholeText ? clean : clean.slice(0, 30);
  let m = RE_TIME_FIRST.exec(window);
  if (m) {
    const month = Number(m[4]);
    const day = Number(m[3]);
    const year = m[5] ? Number(m[5]) : guessYear(month, day, now);
    const time = makeTime(year, month, day, num(m[1]), num(m[2]));
    if (time) return { time };
  }
  const iso = RE_ISO.exec(window);
  const dot = RE_DOT.exec(window);
  // The first match in the text wins (a heading can hold several dates; the expiry check uses lastDate).
  const first = [iso, dot].filter(Boolean).sort((x, y) => x.index - y.index)[0];
  if (first === iso && iso) {
    const hour = iso[4] != null ? num(iso[4]) : null;
    const minute = iso[4] != null ? (iso[5] != null ? num(iso[5]) : 0) : null;
    const time = makeTime(Number(iso[1]), Number(iso[2]), Number(iso[3]), hour, minute);
    if (time) return { time };
  } else if (dot) {
    const month = Number(dot[2]);
    const day = Number(dot[1]);
    const year = dot[3] ? Number(dot[3]) : guessYear(month, day, now);
    const time = makeTime(
      year,
      month,
      day,
      dot[4] != null ? num(dot[4]) : null,
      dot[5] != null ? num(dot[5]) : null,
    );
    if (time) return { time };
  }
  m = RE_TIME_ONLY.exec(clean);
  if (m && num(m[1]) <= 23 && num(m[2]) <= 59)
    return { timeOnly: { hour: num(m[1]), minute: num(m[2]) } };
  return null;
}

/** The last date in a text (the end date in "Compaction trial (08.10 to 15.10)"), or null. */
function lastDate(text, now) {
  let last = null;
  const re = new RegExp(`${RE_ISO.source}|${RE_DOT.source}`, 'g');
  for (const m of String(text).matchAll(re)) {
    const t = parseDate(m[0], now, { wholeText: true });
    if (t?.time) last = t.time;
  }
  return last;
}

const isSection = (line) => /^##\s/.test(line) && !/^##\s+\d{1,2}:(\d{2}|\dx|xx)\b/.test(line);
// No \b after "å": without the u flag å is a non-word character, so \b would never match.
const isNow = (heading) => /^##\s+(?:Now|N[åa])(?=$|[\s(:,.-])/i.test(heading);
const isTrial = (heading) => /trial|follow[ -]?up|pr[øo]ve|f[øo]lg[ -]med/i.test(heading);

/** Splits the note into a header and sections with entries. Each entry is a list of lines. */
function split(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const header = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (isSection(line)) {
      current = { heading: line, entries: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      header.push(line);
      continue;
    }
    const list = current.entries;
    const previous = list[list.length - 1];
    const indented = /^\s+\S/.test(line);
    if (indented && previous && !previous.blank) previous.lines.push(line);
    else list.push({ lines: [line], blank: line.trim() === '' });
  }
  return { header, sections };
}

/** Is the section a trial or follow-up that is still going on (last date not passed, or no date)? */
function activeTrial(heading, now) {
  if (!isTrial(heading)) return false;
  const end = lastDate(heading, now);
  return !end || end.getTime() >= now.getTime();
}

const month = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Removes double and trailing blank lines from a list of lines. */
function tighten(lines) {
  const out = [];
  for (const l of lines) {
    if (l.trim() === '' && (out.length === 0 || out[out.length - 1].trim() === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/** The lines of the "Now" section (without the heading and trailing blank lines), or null when it is missing. */
function nowLines(text) {
  const s = split(text).sections.find((x) => isNow(x.heading));
  if (!s) return null;
  return tighten(s.entries.flatMap((o) => o.lines));
}

/** The "Now" part as text (heading + content), cut at `max` lines; null when it is missing. */
function nowPart(text, max = 60) {
  const s = split(text).sections.find((x) => isNow(x.heading));
  if (!s) return null;
  const lines = nowLines(text);
  const cut = lines.length > max;
  return [
    s.heading,
    ...lines.slice(0, max),
    ...(cut ? [`(… ${lines.length - max} more lines in the note)`] : []),
  ].join('\n');
}

/**
 * The archiving (pure). Answer:
 *   { keep: <new note>, archive: { '<year-month>': <text to append> }, moved: <entries>, movedLines,
 *     nowLines: <count | null>, warnings: [<text>] }
 * When nothing is moved, `keep` equals the input (apart from CRLF -> LF), so the write can be skipped.
 */
function archive(text, now = new Date(), { maxNow = NOW_MAX_LINES, ageMs = AGE_MS } = {}) {
  const limit = now.getTime() - ageMs;
  const { header, sections } = split(text);
  const out = [...header];
  const archiveParts = {}; // month -> [{ heading, lines }]
  let moved = 0;
  let movedLines = 0;

  for (const s of sections) {
    if (isNow(s.heading) || activeTrial(s.heading, now)) {
      out.push(s.heading, ...s.entries.flatMap((o) => o.lines));
      continue;
    }
    const headingTime = parseDate(s.heading, now, { wholeText: true })?.time ?? null;
    let inherited = headingTime;
    const left = [];
    for (const o of s.entries) {
      if (o.blank) {
        left.push(...o.lines);
        continue;
      }
      const t = parseDate(o.lines[0], now);
      let time = null;
      if (t?.time) time = t.time;
      else if (t?.timeOnly && inherited) {
        time = new Date(
          inherited.getFullYear(),
          inherited.getMonth(),
          inherited.getDate(),
          t.timeOnly.hour,
          t.timeOnly.minute,
          59,
          999,
        );
      } else time = inherited;
      if (time) inherited = time;
      if (time && time.getTime() < limit) {
        const m = month(time);
        const list = (archiveParts[m] ??= []);
        let block = list[list.length - 1];
        if (!block || block.heading !== s.heading) {
          block = { heading: s.heading, lines: [] };
          list.push(block);
        }
        block.lines.push(...o.lines);
        moved++;
        movedLines += o.lines.length;
      } else left.push(...o.lines);
    }
    const tightened = tighten(left);
    if (tightened.length) out.push(s.heading, ...tightened, '');
  }

  const archived = {};
  for (const [m, blocks] of Object.entries(archiveParts)) {
    archived[m] = blocks.map((b) => [b.heading, ...tighten(b.lines)].join('\n')).join('\n\n') + '\n';
  }

  const original = String(text).replace(/\r\n/g, '\n');
  let keep = original;
  if (moved > 0) {
    // A blank line before each section heading, no double blank lines, one trailing newline.
    const lines = [];
    for (const l of out) {
      if (isSection(l) && lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(l);
    }
    keep = tighten(lines).join('\n') + '\n';
  }

  const now_ = nowLines(keep);
  const warnings = [];
  if (now_ === null)
    warnings.push('the note has no "## Now" section (active tracks, open owner questions, push status, next step)');
  else if (now_.length > maxNow)
    warnings.push(`"Now" has ${now_.length} lines, the limit is ${maxNow}: shorten it (details belong in the log)`);

  return { keep, archive: archived, moved, movedLines, nowLines: now_ ? now_.length : null, warnings };
}

/** "2026-10-30 09:41" in local time, the way the note itself is written. */
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The text appended to an archive file (with a local time stamp for the run). */
function archiveAddition(text, now = new Date()) {
  return `\n<!-- archived ${localStamp(now)} from handover-ongoing.md (cq handover archive) -->\n${text}`;
}

module.exports = {
  NOW_MAX_LINES,
  AGE_MS,
  parseDate,
  lastDate,
  split,
  activeTrial,
  nowLines,
  nowPart,
  archive,
  archiveAddition,
};
