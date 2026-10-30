// =============================================================
// helperFiles.js: the file side of the custom helper agents (lib/queueHelpers.js holds the rules, lib/helperScan.js the
// scan). See docs/orchestration.md ("Custom helper agents").
//
// Only reads and hashes files, and copies the one file `cq helpers add` brings in. Nothing here runs anything from an
// agent file. Every path is project relative and must stay inside the project root (no "..", no absolute path).
//
// Tested through lib/__tests__/helperCustom.test.ts (cq helpers add/approve/remove and the hash check).
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const HELP = require('./queueHelpers.js');

/** The sha256 of a file's bytes (lower case hex). */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** The absolute path of a project relative path, or null when it points outside the project (or is absolute). */
function insideRoot(root, rel) {
  const r = String(rel ?? '');
  if (!r || path.isAbsolute(r) || /^[A-Za-z]:/.test(r)) return null;
  const abs = path.resolve(root, r);
  const back = path.relative(path.resolve(root), abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  return abs;
}

/** The sha256 of a project file now, or null when it is missing, not a file or outside the project. */
function fileHash(root, rel) {
  const abs = insideRoot(root, rel);
  if (!abs) return null;
  try {
    const st = fs.lstatSync(abs);
    // A link could point anywhere and change without the file changing: not accepted as an agent file.
    if (!st.isFile()) return null;
    return sha256(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

/**
 * The current sha256 per custom helper (the input helperSetup needs to tell approved from changed). Builtin helpers
 * are not in the map.
 * @returns {Record<string, string|null>}
 */
function currentHashes(config, queue, root) {
  const out = {};
  for (const [name, h] of Object.entries(HELP.helperSetup(config, queue)))
    if (h.source === 'custom') out[name] = h.path ? fileHash(root, h.path) : null;
  return out;
}

/** The setup with the files checked: the one call `cq helpers`, `cq receive` and the board use. */
function verifiedSetup(config, queue, root) {
  const hashes = currentHashes(config, queue, root);
  return { hashes, setup: HELP.helperSetup(config, queue, { hashes }) };
}

/** The agents the plugin ships (plugin/agents/*.md), when that folder is next to the scripts. */
function pluginAgentNames(here = __dirname) {
  for (const dir of [path.join(here, '..', '..', '..', 'agents'), path.join(here, '..', '..', 'agents')]) {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3));
    } catch {
      // not this layout
    }
  }
  return [];
}

/**
 * Reads the agent file `cq helpers add` was given. Only a regular .md file up to 256 kB; its text is returned, never run.
 * @returns {{ text: string, abs: string } | { error: string }}
 */
function readSource(file, cwd) {
  const abs = path.resolve(cwd, String(file ?? ''));
  if (!/\.md$/i.test(abs)) return { error: `${file} is not a .md file (an agent definition is markdown with frontmatter)` };
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { error: `${file} not found` };
  }
  if (!st.isFile()) return { error: `${file} is not a file` };
  if (st.size > 256 * 1024) return { error: `${file} is larger than 256 kB; that is not a reviewer prompt` };
  return { text: fs.readFileSync(abs, 'utf8'), abs };
}

module.exports = { sha256, insideRoot, fileHash, currentHashes, verifiedSetup, pluginAgentNames, readSource };
