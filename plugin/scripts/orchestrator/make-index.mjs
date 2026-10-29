#!/usr/bin/env node
// =============================================================
// make-index.mjs: orders the optional document index by the plan register (see docs/plan-register.md).
//
// The index file is set in queue.config.json (`indexFile`, default docs/INDEX.md; null turns the feature off). If the file
// does not exist, the script does nothing (exit 0): make a file with an introduction first, and the script fills in the rest.
//
//   node scripts/orchestrator/make-index.mjs            writes INDEX again (only when it has changed)
//   node scripts/orchestrator/make-index.mjs --dry     shows what would change, writes nothing
//   node scripts/orchestrator/make-index.mjs --check    drift check: exit 1 when INDEX does not match the register
//
// The sections (modules), the plan entry lines and new documents come from the register; descriptions are kept verbatim.
// The logic is pure and lives in lib/queueIndex.js. The register and queue are only READ (never written, so no lock):
// queue.mjs writes them atomically, so a reader always sees a whole file.
//
// The register is gitignored and lives in mainTree. When the tool runs from a worktree, it is read from there (same rule as
// queue.mjs); INDEX is written in the tree the script lives in. Without a register (CI, clean clone) --check skips with exit 0.
// Documents git ignores never get an item automatically (the index is tracked, they are not).
// QUEUE_FOLDER overrides the register folder, QUEUE_INDEX_FILE the file that is written and QUEUE_DOC_ROOT the project root
// the paths are relative to (tests).
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const I = require('./lib/queueIndex.js');
const { dataFolder } = require('./lib/queueConfig.js');

// The tree we run in (lib/projectRoot.js); the index is written here, also in a worktree.
const ROOT = require('./lib/projectRoot.js').roots().tree;
const CQ = require('./lib/projectRoot.js').cqCommand();
const FOLDER = dataFolder();
const indexRel = I.indexFile();
if (!process.env.QUEUE_INDEX_FILE && !indexRel) {
  console.log('make-index: the index is turned off (indexFile: null in queue.config.json); skipping.');
  process.exit(0);
}
const INDEX = process.env.QUEUE_INDEX_FILE ?? path.join(ROOT, ...indexRel.split('/'));
// The source paths are relative to the project root.
const DOC_ROOT = process.env.QUEUE_DOC_ROOT ?? ROOT;

const arg = new Set(process.argv.slice(2));
const unknown = [...arg].filter((a) => !['--check', '--dry'].includes(a));
if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(' ')}. Use: make-index.mjs [--dry | --check]`);
  process.exit(2);
}
const check = arg.has('--check');
const dry = arg.has('--dry');

const planFile = path.join(FOLDER, 'plans.json');
if (!fs.existsSync(planFile)) {
  console.log(`make-index: the plan register does not exist (${planFile}); skipping.`);
  process.exit(0);
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const reg = readJson(planFile);
const queueFile = path.join(FOLDER, 'queue.json');
const queue = fs.existsSync(queueFile) ? readJson(queueFile) : {};

if (!fs.existsSync(INDEX)) {
  console.log(`make-index: the index file does not exist (${INDEX}); skipping.`);
  process.exit(0);
}

/** Does git ignore the path? (Without git, or outside a repo: no.) */
function gitIgnores(filePath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', filePath], { cwd: DOC_ROOT, stdio: 'ignore' });
    return true; // exit 0: ignored
  } catch {
    return false; // exit 1 (not ignored) or git missing
  }
}

const old = fs.readFileSync(INDEX, 'utf8');
const r = I.makeIndex(old, reg, queue, {
  exists: (filePath) => fs.existsSync(path.join(DOC_ROOT, filePath)) && !gitIgnores(filePath),
  index: path.relative(DOC_ROOT, INDEX).split(path.sep).join('/'),
});

if (r.error.length) {
  console.error(
    'make-index: INDEX cannot be read without losing text. Fix the lines and run again:',
  );
  for (const f of r.error) console.error(`  ${f}`);
  process.exit(2);
}

const sections = Object.entries(r.count)
  .map(([oid, n]) => `${oid} ${n}`)
  .join(', ');
const difference = I.firstDifference(old, r.text);

if (!difference) {
  console.log(`make-index: OK, INDEX matches the register (${sections}).`);
  process.exit(0);
}

const newText = r.newOnes.length ? ` New documents from the register: ${r.newOnes.join(', ')}.` : '';
if (check || dry) {
  console.log(
    `make-index: DRIFT, INDEX does not match the register (first different line ${difference.line}).${newText}`,
  );
  console.log(`  now:  ${difference.now ?? '(end)'}`);
  console.log(`  new:  ${difference.new ?? '(end)'}`);
  console.log(`  Fix: ${CQ} make-index`);
  process.exit(check ? 1 : 0);
}

// Atomic write: temporary file in the same folder, then rename.
const tmp = `${INDEX}.${process.pid}.tmp`;
fs.writeFileSync(tmp, r.text, 'utf8');
fs.renameSync(tmp, INDEX);
console.log(`make-index: wrote ${path.relative(DOC_ROOT, INDEX)} (${sections}).${newText}`);
