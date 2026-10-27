#!/usr/bin/env node
// =============================================================
// log-time.mjs: time log for parallel waves and the queue (benchmarking ways of working), and usage measurement.
//
// Writes one JSON line per event to the time log in MAIN_TREE (config().timeLog, default scripts/.queue/times.jsonl,
// gitignored), also when run from a worktree (same rule as queue.mjs and gates.mjs). QUEUE_TIME_LOG overrides
// the file (tests).
//
// Use:
//   node scripts/orchestrator/log-time.mjs <wave> <track|orchestrator> <event> [--duration-s N] [--remark "..."]
//   events: start, done, merged, migration, gates, push (free form, but stick to these)
//   node scripts/orchestrator/log-time.mjs --show [wave]
//       table of the events. The "done" rows from hook-time are cumulative per agent (one per stop); only the LAST
//       per agent_id is shown, otherwise a resumed agent would count several times.
//   node scripts/orchestrator/log-time.mjs --cost [--day YYYY-MM-DD | --day today] [--track-top N] [--json]
//       usage in API-equivalent USD (the list prices in lib/timeCost.js: Opus 5.5 input $4, output $20, cache read
//       $0.20, cache write 5 min $5 / 1 h $8 per MTok), deduplicated per agent: total, per agent type, per
//       risk class (from the queue) and the most expensive tracks with the number of cache expiries. Day = local date.
//       Without --day: everything. The orchestrator session itself is not included (the hook only covers subagents).
//
// Example:
//   node scripts/orchestrator/log-time.mjs b1 A-1 done --duration-s 938 --remark "example"
//   node scripts/orchestrator/log-time.mjs --cost --day today
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('./lib/timeCost.js');
const { dataFolder, timeLog } = require('./lib/queueConfig.js');

// The time log and the queue file in mainTree, also from a worktree (config().root is always mainTree). QUEUE_TIME_LOG and
// QUEUE_FOLDER override.
const LOG = timeLog();
const QUEUE_FILE = path.join(dataFolder(), 'queue.json');

const a = process.argv.slice(2);

const val = (name) => {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
};
const readLog = () => (fs.existsSync(LOG) ? T.readRows(fs.readFileSync(LOG, 'utf8')) : []);

if (a[0] === '--show') {
  const filter = a[1];
  const rows = T.deduplicateDone(readLog());
  for (const r of rows.filter((r) => !filter || r.wave === filter)) {
    const v = r.duration_s != null ? `${Math.round(r.duration_s / 60)} min` : '';
    console.log([r.time, r.wave, r.track, r.event, v, r.remark ?? ''].join('\t'));
  }
  process.exit(0);
}

if (a[0] === '--cost') {
  let day = val('--day') ?? null;
  if (day === 'today') day = T.dayFor(new Date().toISOString());
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error('--day requires YYYY-MM-DD (or today).');
    process.exit(2);
  }
  // Risk class per track from the queue (fix rounds such as "A-1-r2" belong to A-1). No queue: class "unknown".
  let classes = new Map();
  try {
    const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    classes = new Map((queue.tasks ?? []).map((o) => [o.id, o.class]));
  } catch {
    // no queue: no classes
  }
  const classFor = (track) => {
    const id = T.taskIdFor(track, (x) => classes.has(x));
    return id ? classes.get(id) : null;
  };
  const o = T.summarizeCost(readLog(), { day, classFor });
  if (a.includes('--json')) {
    console.log(JSON.stringify(o, null, 1));
    process.exit(0);
  }
  const usd = (x) => `$${x.toFixed(2)}`.padStart(10);
  console.log(
    `Usage ${day ? `${day} (local date)` : 'whole log'}: ${usd(o.total).trim()} API equivalent, deduplicated per agent` +
      `${o.assumed ? ' (some models without their own price: priced as Opus 5.5)' : ''}.`,
  );
  console.log('\nPer agent type:');
  for (const t of o.perType)
    console.log(
      `  ${t.type.padEnd(20)} ${usd(t.usd)} ${`${t.share} %`.padStart(7)}  ${String(t.agents).padStart(4)} agents  ${t.cache_expiry} cache expiries`,
    );
  if (o.perClass.some((k) => k.class !== 'unknown')) {
    console.log('\nPer risk class (from the queue):');
    for (const k of o.perClass) console.log(`  ${k.class.padEnd(20)} ${usd(k.usd)}`);
  }
  const top = Number(val('--track-top') ?? 15);
  if (o.perTrack.length && top > 0) {
    console.log(
      `\nMost expensive tracks (top ${Math.min(top, o.perTrack.length)} of ${o.perTrack.length}):`,
    );
    for (const s of o.perTrack.slice(0, top))
      console.log(
        `  ${s.track.padEnd(20)} ${usd(s.usd)}  ${String(s.turns).padStart(4)} turns  ${String(s.cache_expiry).padStart(3)} cache expiries  ${s.types.join(', ')}`,
      );
  }
  process.exit(0);
}

const [wave, track, event] = a;
if (!wave || !track || !event) {
  console.error('use: log-time.mjs <wave> <track> <event> [--duration-s N] [--remark "..."]');
  process.exit(2);
}
const row = { time: new Date().toISOString(), wave, track, event };
const v = val('--duration-s');
if (v) row.duration_s = Number(v);
const m = val('--remark');
if (m) row.remark = m;
fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
console.log('logged', JSON.stringify(row));
