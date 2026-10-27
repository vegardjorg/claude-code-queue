#!/usr/bin/env node
// =============================================================
// context-measure.mjs: baseline and after-measurement of context per turn in the queue tracks. See docs/orchestration.md.
//
// Reads the time log (config().timeLog in mainTree; QUEUE_TIME_LOG overrides), takes the LAST "done" row per agent in
// the time window and writes per agent type and risk class (from the queue, <dataFolder>/queue.json; QUEUE_FOLDER overrides):
// count, median start context, median and p90 context (the agent's median context), median end context, median
// calls before first change, median turns, sum and average cost. The computation lives in contextMeasure.js (tested).
//
// Usage:
//   node scripts/orchestrator/context-measure.mjs [--days N | --from <iso>] [--to <iso>] [--json]
//   Default: --days 14. After-measurement: --from <merge time of the measure>.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('./contextMeasure.js');
const T = require('./lib/timeCost.js');
const { dataFolder, timeLog } = require('./lib/queueConfig.js');

// The time log and the queue file in mainTree, also from a worktree (config().root is always mainTree). QUEUE_TIME_LOG and
// QUEUE_FOLDER override.
const LOG = timeLog();
const QUEUE_FILE = path.join(dataFolder(), 'queue.json');

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const die = (m) => {
  console.error(m);
  process.exit(2);
};

let from = null;
if (arg('--from') != null) {
  from = Date.parse(arg('--from'));
  if (!Number.isFinite(from)) die(`invalid --from: ${arg('--from')}`);
} else {
  const days = arg('--days') != null ? Number(arg('--days')) : 14;
  if (!(days > 0)) die('--days must be a number above 0');
  from = Date.now() - days * 86_400_000;
}
let to = null;
if (arg('--to') != null) {
  to = Date.parse(arg('--to'));
  if (!Number.isFinite(to)) die(`invalid --to: ${arg('--to')}`);
}

let text = '';
try {
  text = fs.readFileSync(LOG, 'utf8');
} catch {
  die(`could not find the time log ${LOG}`);
}
let queue = { tasks: [] };
try {
  queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
} catch {
  // no queue: all classes become "unknown"
}

const measurement = M.measureContext(T.readRows(text), { from, to, classFor: M.classLookup(queue) });
if (process.argv.includes('--json')) console.log(JSON.stringify(measurement, null, 2));
else console.log(M.formatTable(measurement));
