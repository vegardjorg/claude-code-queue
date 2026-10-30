#!/usr/bin/env node
// =============================================================
// statusline.mjs: Claude Code's status line for a queue project. See docs/orchestration.md.
//
// Why: the owner saw the quota use only afterwards. The line shows it as it happens, on one line:
//   ctx 142k 71% | $3.21 | 5h 23% 7d 41% | tracks 2 (+1 review)
//   - context used: context_window.total_input_tokens (input + cache write + cache read in the last call, which is what
//     is in the context now) and context_window.used_percentage (computed from the size when the field is missing),
//   - session cost: cost.total_cost_usd,
//   - quota: rate_limits.five_hour.used_percentage and rate_limits.seven_day.used_percentage ("-" when the field is
//     missing, e.g. before the first answer or without a subscription),
//   - active tracks: tasks with status running (and review) in <dataFolder>/queue.json in the main tree.
// The field names follow the status line payload of Claude Code 2.x (code.claude.com/docs/en/statusline).
//
// Calibration point: when the input has rate_limits, the last reading is saved in <dataFolder>/rate-limits.json (when
// the percentages change, otherwise at most every 15 min; lib/rateLimits.js). `cq capacity --calibrate auto` uses it.
//
// Set up: a plugin cannot set `statusLine` itself (it is a user or project setting, not a plugin component), so
// `cq setup --settings` writes it to .claude/settings.json (settings.queue.json has the vendored form). An existing
// status line of your own is kept.
//
// Cheap: the script runs every few seconds in every session. queue.json can be several MB, so the count is cached in a
// small file in tmpdir keyed on the queue file's path, mtime and size; the file is parsed only when the queue has
// actually changed. QUEUE_STATUSLINE_CACHE overrides the cache file (tests). No colours (ANSI codes break in some
// Windows terminals). Fails QUIETLY to a short line, never with a stack trace.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const MISSING = '-';

const number = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const percent = (x) => (number(x) === null ? MISSING : `${Math.round(x)}%`);

/** "ctx 142k 71%", or "ctx -" when the field is missing (before the first answer). */
export function contextPart(cw) {
  const used = number(cw?.total_input_tokens);
  const size = number(cw?.context_window_size);
  if (used === null || used === 0) return `ctx ${MISSING}`;
  let pct = number(cw?.used_percentage);
  if (pct === null && size) pct = (used / size) * 100;
  return `ctx ${Math.round(used / 1000)}k ${percent(pct)}`;
}

export function costPart(cost) {
  const usd = number(cost?.total_cost_usd);
  return usd === null ? `$${MISSING}` : `$${usd.toFixed(2)}`;
}

export function quotaPart(rl) {
  return `5h ${percent(rl?.five_hour?.used_percentage)} 7d ${percent(rl?.seven_day?.used_percentage)}`;
}

export function tracksPart(t) {
  if (!t) return null;
  return `tracks ${t.running}${t.review ? ` (+${t.review} review)` : ''}`;
}

/** The whole line (pure apart from the count, which is passed in). */
export function makeLine(input, count) {
  return [contextPart(input?.context_window), costPart(input?.cost), quotaPart(input?.rate_limits), tracksPart(count)]
    .filter(Boolean)
    .join(' | ');
}

/** The queue's data folder for the session's project, or null when the project does not use the queue. */
function queueFolder(input) {
  const PR = require('./lib/projectRoot.js');
  const cwd = input?.workspace?.project_dir || input?.workspace?.current_dir || input?.cwd || process.cwd();
  const { main } = PR.resolveRoots({ cwd });
  if (!PR.queueActive({ main })) return null;
  const k = require('./lib/queueConfig.js').config({ root: main });
  return process.env.QUEUE_FOLDER ?? path.join(main, k.dataFolder);
}

/** The count of active tracks, from the cache when queue.json is unchanged. Null when there is no queue. */
function trackCount(folder) {
  const file = path.join(folder, 'queue.json');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const cache = process.env.QUEUE_STATUSLINE_CACHE ?? path.join(os.tmpdir(), 'queue-statusline-count.json');
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (c.key === key) return c;
  } catch {
    // error-ignored: no cache or a broken one, count again
  }
  const queue = JSON.parse(fs.readFileSync(file, 'utf8'));
  let running = 0;
  let review = 0;
  for (const o of queue.tasks ?? []) {
    if (o?.status === 'running') running++;
    else if (o?.status === 'review') review++;
  }
  const answer = { key, running, review };
  try {
    fs.writeFileSync(cache, JSON.stringify(answer));
  } catch {
    // error-ignored: without a cache we just count again next time
  }
  return answer;
}

/** Saves the quota reading for `cq capacity --calibrate auto` (lib/rateLimits.js decides when). */
function saveRateLimits(folder, input) {
  const RL = require('./lib/rateLimits.js');
  const next = RL.fromStatusInput(input);
  if (!RL.shouldWrite(RL.readObserved(folder), next)) return;
  const file = path.join(folder, RL.FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next) + '\n');
  fs.renameSync(tmp, file);
}

async function main() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  const input = JSON.parse(s || '{}');
  let count = null;
  try {
    const folder = queueFolder(input);
    if (folder) {
      count = trackCount(folder);
      try {
        saveRateLimits(folder, input);
      } catch {
        // error-ignored: the calibration point is an aid; the line must still be written
      }
    }
  } catch {
    count = null; // error-ignored: the status line must never fail on the queue file
  }
  process.stdout.write(makeLine(input, count) + '\n');
}

// Run as a script (not when a test imports the functions).
const started = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
const isMain =
  process.platform === 'win32' ? started.toLowerCase() === import.meta.url.toLowerCase() : started === import.meta.url;
if (isMain) main().catch(() => process.stdout.write('statusline: -\n'));
