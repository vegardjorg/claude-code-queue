#!/usr/bin/env node
// =============================================================
// cost-guard-statistics.mjs: statistics for the cost guard, so the threshold (FACTOR in lib/costGuard.js) can be
// calibrated on data instead of gut feeling. See docs/orchestration.md.
//
// Reads:
//   * <dataFolder>/cost-guard-log.jsonl: one line per notice (written by hook-context.mjs).
//   * <dataFolder>/queue.json: the final cost (cost.usd) and status of every task.
//
// Prints:
//   1. Warnings per class: count, usage at notice, final cost and how much the track used AFTER the notice
//      (little after = the track was nearly done when it was wrapped up, i.e. an unnecessary notice).
//   2. Hypothetical hit rate for all finished tasks: share over 2x, 3x and 4x the average for the class.
//
// Usage: node scripts/orchestrator/cost-guard-statistics.mjs [--since <YYYY-MM-DD>]
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The data folder in mainTree (QUEUE_FOLDER overrides).
const QUEUE_FOLDER = require('./lib/queueConfig.js').dataFolder();
const LOG = path.join(QUEUE_FOLDER, 'cost-guard-log.jsonl');
const QUEUE = path.join(QUEUE_FOLDER, 'queue.json');

const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > 0 ? process.argv[sinceArg + 1] : null;

/** Reads jsonl tolerantly: broken lines are skipped. */
function readLog() {
  if (!fs.existsSync(LOG)) return [];
  return fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    })
    .filter((r) => !since || r.time >= since);
}

if (!fs.existsSync(QUEUE)) {
  console.log(`No queue yet (${QUEUE} does not exist); nothing to compute.`);
  process.exit(0);
}
const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const tasks = queue.tasks ?? [];
const perId = new Map(tasks.map((o) => [o.id, o]));
const usd = (o) => Number(o?.cost?.usd ?? NaN);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : '-');

// 1. The notices
const notices = readLog();
console.log(`Cost-guard-warnings${since ? ` since ${since}` : ''}: ${notices.length}`);
const perClass = {};
for (const v of notices) (perClass[v.class] ??= []).push(v);
for (const [cls, list] of Object.entries(perClass)) {
  const finished = list.filter((v) => perId.get(v.id)?.status === 'done');
  const after = finished.map((v) => usd(perId.get(v.id)) - v.usd).filter(Number.isFinite);
  const averageAfter = after.length ? after.reduce((a, b) => a + b, 0) / after.length : NaN;
  const small = after.filter((e) => e < 0.25 * (list[0]?.average ?? Infinity)).length;
  console.log(
    `  ${cls}: ${list.length} notices, ${finished.length} finished; used after notice average $${r2(averageAfter)}` +
      `; ${small} used under 0.25x the class average after the notice (probably nearly finished)`,
  );
}
for (const v of notices.slice(-15)) {
  const o = perId.get(v.id);
  console.log(
    `    ${v.time.slice(0, 16)} ${v.id.padEnd(14)} ${v.class.padEnd(3)} notice $${v.usd} (${v.factor}x $${v.average})` +
      ` -> end $${r2(usd(o))} ${o?.status ?? '?'}`,
  );
}

// 2. Hypothetical hit rate on all finished with measured cost (same period if --since)
const finished = tasks.filter(
  (o) => o.status === 'done' && Number.isFinite(usd(o)) && (!since || (o.done ?? '') >= since),
);
const group = {};
for (const o of finished) (group[o.class] ??= []).push(usd(o));
console.log(`\nHypothetical: share finished over Nx the class average (${finished.length} tasks)`);
for (const [cls, v] of Object.entries(group)) {
  const s = v.reduce((a, b) => a + b, 0) / v.length;
  const over = (f) => v.filter((x) => x > f * s).length;
  console.log(
    `  ${cls.padEnd(3)} n=${v.length} average $${r2(s)}  >2x ${over(2)}  >3x ${over(3)}  >4x ${over(4)}  max $${r2(Math.max(...v))}`,
  );
}
