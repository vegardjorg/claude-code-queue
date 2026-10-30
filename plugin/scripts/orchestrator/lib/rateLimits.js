// =============================================================
// rateLimits.js: the subscription's quota as Claude Code reports it to the status line, saved for the queue.
//
// The status line's stdin JSON has `rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` and
// `resets_at` (Unix seconds; only on Pro/Max, and only after the first API answer in the session). statusline.mjs saves
// the last reading in <dataFolder>/rate-limits.json, and `queue.mjs capacity --calibrate auto` uses the 7-day
// percentage as a calibration point for usd_per_100 (lib/queueCapacity.js), so the owner does not have to read the
// percentage off the usage page by hand. Manual calibration stays as the override.
//
// Kept apart from queueCapacity.js on purpose: the status line runs every few seconds and must not load queueLogic.js.
// Pure functions (no I/O beyond readObserved), tested in lib/__tests__/rateLimits.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The file name in the data folder. */
const FILE = 'rate-limits.json';
/** A reading is written at most this often when the percentages have not changed. */
const WRITE_INTERVAL_MS = 15 * 60 * 1000;
/** A reading older than this is not used for calibration (the percentage keeps moving while tracks run). */
const MAX_AGE_MS = 60 * 60 * 1000;

const number = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** One window ({ used_percentage, resets_at }) cleaned, or null when the percentage is missing. */
function windowFrom(w) {
  const pct = number(w?.used_percentage);
  if (pct === null) return null;
  const at = number(w?.resets_at);
  return { used_percentage: pct, resets_at: at };
}

/**
 * The reading to save from the status line input, or null when it has no quota fields.
 * @param {object} input the status line's stdin JSON
 * @param {number} [now]
 */
function fromStatusInput(input, now = Date.now()) {
  const fiveHour = windowFrom(input?.rate_limits?.five_hour);
  const sevenDay = windowFrom(input?.rate_limits?.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { time: new Date(now).toISOString(), five_hour: fiveHour, seven_day: sevenDay };
}

/** Should `next` be written over `previous`? When the percentages changed, or the previous one is older than the interval. */
function shouldWrite(previous, next, now = Date.now()) {
  if (!next) return false;
  if (!previous) return true;
  const same = (a, b) => (a?.used_percentage ?? null) === (b?.used_percentage ?? null);
  if (!same(previous.five_hour, next.five_hour) || !same(previous.seven_day, next.seven_day)) return true;
  const t = Date.parse(previous.time);
  return !Number.isFinite(t) || now - t >= WRITE_INTERVAL_MS;
}

/** The saved reading in `folder`, or null. */
function readObserved(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The 7-day percentage to calibrate with, or { error }. Refused when there is no reading, when it is older than
 * `maxAgeMs`, or when its week has already reset (resets_at in the past).
 * @returns {{ percent: number, age_min: number, resets_at: number|null } | { error: string }}
 */
function observedPercent(observed, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const w = observed?.seven_day;
  if (!w || number(w.used_percentage) === null) return { error: 'the status line has saved no 7-day percentage yet' };
  const t = Date.parse(observed.time);
  if (!Number.isFinite(t)) return { error: 'the saved reading has no valid time' };
  if (now - t > maxAgeMs) return { error: `the saved reading is ${Math.round((now - t) / 60000)} min old` };
  if (number(w.resets_at) !== null && w.resets_at * 1000 <= now)
    return { error: 'the saved reading is from a quota week that has already reset' };
  return { percent: w.used_percentage, age_min: Math.round((now - t) / 60000), resets_at: number(w.resets_at) };
}

module.exports = { FILE, WRITE_INTERVAL_MS, MAX_AGE_MS, fromStatusInput, shouldWrite, readObserved, observedPercent };
