#!/usr/bin/env node
// =============================================================
// make-mission.mjs: makes one mission per track (queue or a parallel wave). See docs/orchestration.md.
//
// Input:
//   --common <file>  the shared protocol (made by make-queue-common.mjs from docs/queue/mission-template.md).
//                   Placeholders: __BRANCH__ __HEAD__ __TRACK__ __BLOCK__
//   --track <file>    the track blocks, each in the form:
//                     =====A-1=====
//                     TITLE: TRACK A-1 (short name)
//                     BRANCH: queue/A-1   (optional; otherwise <branchPrefix><id> from queue.config.json)
//                     BLOCK: 0040–0049 (optional migrationBlock; free text after it is allowed)
//                     CLASS: D+   (optional; otherwise "class X" in the ## TRACK line)
//                     <empty line or anything>
//                     ## TRACK A-1 ... (track content)
//   --head <sha>    the commit tracks start from (or newer)
//   --out <folder>    where prompt-<TRACK>.md is written (default: the same folder as --track)
//
// The text is made in missionText.js:
//   - The class sections in the shared protocol (<!-- class: D D+ --> … <!-- /class -->) are only included when the
//     track class is in the list. An unknown class gives the whole protocol.
//   - Section pointers in the track content ("docs/x.md § 3", "docs/x.md#heading") get "(line A–B)" appended, computed
//     now. Relative paths are looked up from this tree and then mainTree (gitignored documents exist only there).
//
// Example:
//   node scripts/orchestrator/make-mission.mjs --common scratch/queue-common.md --track scratch/queue-track.md --head 849a5773
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const O = require('./missionText.js');
const { config } = require('./lib/queueConfig.js');

const K = config();
// This tree (may be a worktree) and mainTree (config().root is always mainTree).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN_TREE = K.root;

/** Reads a referenced document: absolute path, otherwise relative to this tree and then mainTree. Null when missing. */
function readDocument(file) {
  const candidates = path.isAbsolute(file) ? [file] : [path.join(ROOT, file), path.join(MAIN_TREE, file)];
  for (const k of candidates) {
    try {
      return fs.readFileSync(k, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const commonFile = arg('--common');
const trackFile = arg('--track');
const head = arg('--head');
if (!commonFile || !trackFile || !head) {
  console.error('use: make-mission.mjs --common <file> --track <file> --head <sha> [--out <folder>]');
  process.exit(2);
}
const out = arg('--out') ?? path.dirname(trackFile);
const common = fs.readFileSync(commonFile, 'utf8');
const track = fs.readFileSync(trackFile, 'utf8');

// Swaps placeholders with split/join, never String.replace (a replacement containing "$'" duplicates text).
const swap = (s, from, to) => s.split(from).join(to);

// Ids may contain hyphens and dots (for example A-1a), not just \w.
const parts = track.split(/^=====([A-Za-z0-9._-]+)=====\r?\n/m).slice(1);
if (parts.length === 0) {
  console.error('found no track blocks (=====ID=====)');
  process.exit(1);
}
for (let i = 0; i < parts.length; i += 2) {
  const id = parts[i];
  const lines = parts[i + 1].split(/\r?\n/);
  const title = (lines.find((l) => l.startsWith('TITLE:')) ?? `TITLE: TRACK ${id}`)
    .slice('TITLE:'.length)
    .trim();
  const block = (lines.find((l) => l.startsWith('BLOCK:')) ?? 'BLOCK: (none)').slice('BLOCK:'.length).trim();
  // Optional BRANCH: line; otherwise <branchPrefix><id> (default queue/<id>).
  const branch = (lines.find((l) => l.startsWith('BRANCH:')) ?? `BRANCH: ${K.branchPrefix}${id}`).slice('BRANCH:'.length).trim();
  const start = lines.findIndex((l) => l.startsWith('## '));
  const body = O.sectionPointers(
    lines
      .slice(start >= 0 ? start : 0)
      .join('\n')
      .trim(),
    readDocument,
  );
  const cls = O.classFromBlock(parts[i + 1]);
  let text = O.filterClass(common, cls);
  text = swap(text, '__BRANCH__', branch);
  text = swap(text, '__HEAD__', head);
  text = swap(text, '__TRACK__', id);
  text = swap(text, '__BLOCK__', block);
  const file = path.join(out, `prompt-${id}.md`);
  const blockLine = block === '(none)' ? '' : `Migration block: ${block}\n\n`;
  fs.writeFileSync(file, `# ${title}\n\n${blockLine}${text}\n\n${body}\n`);
  console.log(
    `wrote ${file} (class ${cls ?? 'unknown, whole protocol'}, shared ${text.length} chars)`,
  );
}
