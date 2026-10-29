#!/usr/bin/env node
// =============================================================
// make-queue-common.mjs: makes the shared protocol for tracks started from the work queue (queue.mjs). See docs/orchestration.md.
//
// The source is the shared part of the project's mission template: docs/queue/mission-template.md (fallback:
// docs/mission-template.md). Ownership is in each track block ("Ownership in queue"), and what other running tasks
// own is shown by `queue.mjs show`. The placeholders __BRANCH__ __HEAD__ __TRACK__ __BLOCK__ are filled by make-mission.mjs.
// The class sections (<!-- class: … -->) are kept here; make-mission.mjs selects them per track.
// Project name, baseBranch, gates and architecture rules come from queue.config.json (config()).
// The text itself is built in missionText.js (makeQueueCommon), which the test also uses.
//
// Use: node scripts/orchestrator/make-queue-common.mjs --out <scratchpad>/queue-common.md [--scratchpad <folder>]
// Run again when the mission template or the config has changed.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const O = require('./missionText.js');
const { config } = require('./lib/queueConfig.js');

const K = config();
/**
 * The mission template: the project's own copy first (docs/queue/mission-template.md, then docs/mission-template.md,
 * relative to the root), and last the one shipped with the plugin (<plugin>/docs/), for a project that never copied it.
 */
const TEMPLATES = [
  path.join(K.root, 'docs', 'queue', 'mission-template.md'),
  path.join(K.root, 'docs', 'mission-template.md'),
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'mission-template.md'),
];
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const out = arg('--out');
if (!out) {
  console.error('use: make-queue-common.mjs --out <file> [--scratchpad <folder>]');
  process.exit(2);
}
const scratch = arg('--scratchpad') ?? path.dirname(path.resolve(out));

const templateFile = TEMPLATES.find((m) => fs.existsSync(m));
if (!templateFile) {
  console.error(`could not find the mission template (${TEMPLATES.join(' or ')})`);
  process.exit(1);
}
const template = fs.readFileSync(templateFile, 'utf8');
const s = O.makeQueueCommon(template, scratch, K);
const rest = s.match(/<[A-Z_]+>/g);
if (rest) console.log('WARNING, unfilled placeholders:', [...new Set(rest)].join(', '));
fs.writeFileSync(out, s);
const perClass = O.CLASSES.map((k) => `${k} ${O.filterClass(s, k).length}`).join(', ');
console.log(`wrote ${out} (${s.length} chars; per class: ${perClass})`);
