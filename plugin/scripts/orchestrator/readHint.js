// =============================================================
// readHint.js: soft read and report hints for the track agents. See docs/orchestration.md.
//
// Why: every turn reads the whole context again, so a large file read whole is paid for in all later turns. The read guard
// (hook-read-guard.mjs, lib/trackGuard.js) DENIES only files that are loaded automatically and whole large files. Here are
// the soft hints, which never block:
//   assessReadHint     Read without offset/limit of a file over about 300 lines, or the same file whole a second time.
//   assessReportHint  one reminder when the context passes about 200k: the long content in report.md, the reply under the cap.
//   assessBashHint     a Bash/PowerShell result over about 15,000 characters. Shell output (grep, sed/cat/head, psql) is
//                      often the largest read source, and the read guard only sees Read. The hint is tailored to the
//                      command and given at most BASH_HINT_MAX times per agent, so it never fills the context itself.
// Pure logic; the state (which files have been read whole, what has been said) is owned by the hooks. Test:
// scripts/orchestrator/__tests__/readHint.test.ts.
// =============================================================

const HINT_LINES = 300;
const REPORT_THRESHOLD = 200_000;
const TRACK_TYPES = new Set(['track', 'track-d']);
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|pdf|ipynb)$/;
const BASH_THRESHOLD = 15_000; // characters in one tool result
const BASH_HINT_MAX = 3; // hints per agent; the output is expensive, but the hint must not become noise
const SHELL_TOOL = new Set(['Bash', 'PowerShell']);

/** Normalized key for a file path (slashes, lower case: Windows does not distinguish upper and lower case). */
const fileKey = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .toLowerCase();

/**
 * Read hint for a Read that is LET THROUGH (assess denial first with trackGuard.assessReading).
 * @param {{ agentType?: string|null, filePath?: string, offset?: number|null, limit?: number|null,
 *   countLines?: number|null, readWhole?: string[], maxLines?: number }} a
 *   readWhole = the file keys the agent has already read whole.
 * @returns {null | { hint: string, key: string|null }} key = the file key to remember as read whole.
 */
function assessReadHint({
  agentType,
  filePath,
  offset = null,
  limit = null,
  countLines = null,
  readWhole = [],
  maxLines = HINT_LINES,
} = {}) {
  if (!agentType || !TRACK_TYPES.has(agentType) || !filePath) return null;
  if (offset != null || limit != null) return null; // excerpt: always fine
  const key = fileKey(filePath);
  if (NOT_TEXT.test(key)) return null; // images, PDF and notebooks are read on their own terms
  if (readWhole.includes(key)) {
    return {
      key: null,
      hint:
        'readHint: you have already read this file whole in this track, and it is in your context. Read only ' +
        'what has changed, with Grep and Read with offset and limit.',
    };
  }
  if (typeof countLines === 'number' && countLines > maxLines) {
    return {
      key,
      hint:
        `readHint: the file has ${countLines} lines (over ${maxLines}) and is read whole. It stays in the ` +
        'context and is paid for in every later turn. Next time: Grep -n for what you need, then Read with offset ' +
        'and limit around the match.',
    };
  }
  return { key, hint: '' }; // no message, but remember the file as read whole
}

/**
 * One reminder about the report cap when the context passes the threshold.
 * @param {{ agentType?: string|null, context?: number|null, said?: boolean, threshold?: number }} a
 * @returns {null | string}
 */
function assessReportHint({ agentType, context, said = false, threshold = REPORT_THRESHOLD } = {}) {
  if (!agentType || !TRACK_TYPES.has(agentType) || said) return null;
  if (typeof context !== 'number' || !Number.isFinite(context) || context < threshold) return null;
  return (
    `[report reminder] The context is over about ${Math.round(threshold / 1000)}k. Write the long content (gates, ` +
    'self-review, owner questions, coupling specification) with Write to <folder>\\report.md as you go. The reply to ' +
    'the orchestrator is only the RESULT line, at most 5 lines and the path to report.md (at most about 1,500 characters).'
  );
}

/**
 * Count characters in a tool result. Bash gives `{ stdout, stderr }`; other shapes (plain string, `{ output }`,
 * content blocks `[{ type: 'text', text }]`) are counted too, so the hook tolerates the format changing.
 * @param {unknown} answer  tool_response from PostToolUse
 * @returns {number}
 */
function outputLength(answer) {
  if (answer == null) return 0;
  if (typeof answer === 'string') return answer.length;
  if (Array.isArray(answer)) return answer.reduce((sum, x) => sum + outputLength(x), 0);
  if (typeof answer === 'object') {
    const o = /** @type {Record<string, unknown>} */ (answer);
    let sum = 0;
    for (const field of ['stdout', 'stderr', 'output', 'text', 'content']) {
      if (field in o) sum += outputLength(o[field]);
    }
    return sum;
  }
  return 0;
}

/** Which read source the command is (grep, read, psql, other), to pick the most fitting advice. */
function commandType(command) {
  const k = String(command || '');
  if (/\bpsql\b|pg_get_functiondef|prosrc/i.test(k)) return 'psql';
  if (/\b(?:grep|rg|Select-String)\b/i.test(k)) return 'grep';
  if (/\b(?:sed|cat|head|tail|Get-Content)\b/i.test(k)) return 'read';
  return 'other';
}

const BASH_ROW = {
  grep: 'grep: limit the matches with `grep -m 20`, `grep -l` (file names only) or `| head -40`, and narrow the path.',
  read: "sed/cat/head: read an excerpt with `sed -n 'a,bp'` around the line you need (find it with `grep -n`), not the whole file.",
  psql:
    'psql: select narrowly (only the columns you need, `limit`), and fetch only the part of a function body you need, ' +
    'e.g. with `position(...)`/`substr(...)` on `pg_get_functiondef`, not the whole body.',
  other: 'Limit the output with `| head -40` or `| tail -40`, or filter with `grep -m`.',
};

/**
 * Soft hint (never block) when a Bash/PowerShell result in a track is large.
 * @param {{ agentType?: string|null, tool?: string|null, command?: string, length?: number|null,
 *   given?: number, threshold?: number, max?: number }} a  given = number of Bash hints the agent has already got
 * @returns {null | string}
 */
function assessBashHint({
  agentType,
  tool,
  command = '',
  length = null,
  given = 0,
  threshold = BASH_THRESHOLD,
  max = BASH_HINT_MAX,
} = {}) {
  if (!agentType || !TRACK_TYPES.has(agentType) || !tool || !SHELL_TOOL.has(tool))
    return null;
  if (typeof length !== 'number' || !Number.isFinite(length) || length <= threshold) return null;
  if (given >= max) return null;
  const type = commandType(command);
  const row = type === 'other' ? BASH_ROW.other : `${BASH_ROW[type]} ${BASH_ROW.other}`;
  return (
    `[output hint] The command gave about ${Math.round(length / 1000)}k characters (over ${Math.round(threshold / 1000)}k). ` +
    `The output stays in the context and is paid for in every later turn. ${row}`
  );
}

module.exports = {
  HINT_LINES,
  REPORT_THRESHOLD,
  BASH_THRESHOLD,
  BASH_HINT_MAX,
  TRACK_TYPES,
  fileKey,
  assessReadHint,
  assessReportHint,
  outputLength,
  commandType,
  assessBashHint,
};
