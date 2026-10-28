// =============================================================
// queueConfig.js: the project settings for the queue system (queue.config.json in the project root).
//
// Everything project specific (the name of the integration branch, the commands that are "gates", an optional
// migration flow, the modules in the plan register, the architecture rules to include in cloud missions, etc.) lives in
// queue.config.json, not in the code. The file is optional: if it is missing, STANDARD below applies. The fields are merged
// recursively (objects field by field, lists and numbers are replaced entirely).
//
// The project root is found like this: two folders above scripts/orchestrator/, and when a script runs from an agent worktree
// (<root>/.claude/worktrees/<name>/...), mainTree is used. QUEUE_ROOT overrides (tests).
// QUEUE_CONFIG overrides the path to the file (tests).
// =============================================================

const fs = require('node:fs');
const path = require('node:path');

/** The default values. Edit them in queue.config.json, not here. */
const STANDARD = Object.freeze({
  // The project name in texts (mission, agent messages, the board).
  projectName: 'theProject',
  // The integration branch: everything is merged here, and this is what is pushed in batches. Often main or develop.
  baseBranch: 'main',
  // Remote for push and for cloud sessions (origin/<baseBranch>).
  remote: 'origin',
  // Where the queue, the plan register and the logs live (relative to the project root, gitignored).
  dataFolder: 'scripts/.queue',
  // The time log hook-time.mjs writes (usage per agent).
  timeLog: 'scripts/.queue/times.jsonl',
  // Branch prefix for queue tasks: <branchPrefix><id>.
  branchPrefix: 'queue/',
  // Folders (relative to the root) linked into each agent worktree instead of being installed again.
  sharedLinks: ['node_modules'],
  // The gates tracks run before delivery (gates.mjs). Each is a shell command; empty list = no gate.
  gates: {
    quick: [],
    full: [],
  },
  // Optional migration flow (e.g. database migrations that must be numbered and pushed after merge).
  // With folder = null everything to do with migrations is turned off (no number blocks, no push in merge).
  migrations: {
    folder: null, // e.g. "db/migrations"
    filePattern: '^(\\d+)_.*\\.sql$', // first group = the number
    blockSize: 10, // numbers per task that touches migrations
    pushCommand: null, // e.g. "npm run db:migrate"; null = merge never pushes
    // Optional guard: the file that says which environment is linked, and the values it is allowed to push to.
    environmentFile: null,
    allowedEnvironment: [],
  },
  // Architecture rules written into cloud missions and the mission text (short lines, the project's own).
  architectureRules: [],
  // The plan register modules (areas). Created with `queue.mjs plan modules`.
  modules: [
    { oid: 'example', title: 'Example', description: 'Example module, give it a new name or delete it' },
    { oid: 'without-module', title: 'No fixed module', description: 'Projects that do not belong to a module yet' },
  ],
  // Suggested module per project id (used by `plan modules --link`).
  projectModuleSuggestion: {},
  // Optional path to a script that backs up the plan register (`queue.mjs plan backup`).
  planBackup: null,
  // The document register: optional list of vendors/subprocessors checked against documents.
  // One element in vendors: { id, name, word?, documents?: (path | { doc, section?, where? })[] }. Empty = off.
  documents: {
    vendors: [],
    secretsManifest: null, // file listing the vendors actually in use; null = no filtering
    vendorSwitches: [], // planned switches: { out, in, planEntry?, text? }
  },
  // The folders the plan register looks for documents in (unregistered documents, the read view, the index).
  documentFolders: ['docs'],
  // The document index make-index.mjs maintains; null turns the index off.
  indexFile: 'docs/INDEX.md',
  // The priority rules in the plan register. null = the generic default rules (`queue.mjs plan rules`).
  priorityRules: null,
  // The reviewer agents run per class after `queue.mjs receive`.
  reviewers: { K: [], U: [], D: ['reviewer'], 'D+': ['reviewer', 'reviewer-security'] },
  // Read guard (hook-read-guard.mjs): in addition to the built-in lists.
  readGuard: {
    agentTypes: [], // more agent types the guard applies to (track, track-d and the reviewers are already included)
    autoLoaded: [], // files Claude Code loads itself and that must never be read with Read
    largeFiles: [], // glob patterns for files that must always be read in excerpts
    maxLines: 300,
    blockLines: 2000,
  },
  // Branches never counted as queue branches (in addition to baseBranch).
  excludeBranches: ['main', 'master'],
  // Paths a cloud session cannot see (e.g. gitignored folders); a mission that points there is stopped.
  cloudHidden: [],
  // Weekly quota (queue.mjs capacity): when it resets, and the subscription name in the text (null = "weeklyQuota").
  capacity: {
    resetDay: null, // 0-6 (0 = Sunday)
    resetClock: null, // "HH:MM"
    timeZone: null, // IANA, e.g. "Europe/Berlin"
    planName: null,
  },
  // Queue board (queue-board.mjs).
  board: {
    port: 2000,
    title: 'Queue board',
    // The mascot's speech bubble: "chatty" (everything), "events" (only events and clicks) or "off" (no bubbles at
    // all, for every viewer; the choice in the gear is then locked). `queue-board.mjs --mascot <mode>` overrides it.
    mascot: 'chatty',
  },
});

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursive merge: objects field by field, everything else (lists, numbers, text, null) is replaced. */
function merge(standard, own) {
  if (!isObject(own)) return own === undefined ? standard : own;
  const out = { ...standard };
  for (const [k, v] of Object.entries(own)) {
    if (k.startsWith('$') || k.startsWith('_')) continue; // $schema, _comment
    out[k] = isObject(standard?.[k]) && isObject(v) ? merge(standard[k], v) : v;
  }
  return out;
}

/** The project root: two folders above scripts/orchestrator/, or mainTree when we are in an agent worktree. */
function findRoot() {
  if (process.env.QUEUE_ROOT) return path.resolve(process.env.QUEUE_ROOT);
  const root = path.resolve(__dirname, '..', '..', '..');
  return root.split(`${path.sep}.claude${path.sep}worktrees${path.sep}`)[0];
}

let buffer = null;

/**
 * Reads queue.config.json (once per process) and merges it with STANDARD.
 * @param {{ root?: string, fresh?: boolean }} [o]
 */
function config(o = {}) {
  if (buffer && !o.fresh && !o.root) return buffer;
  const root = o.root ?? findRoot();
  const file = process.env.QUEUE_CONFIG ?? path.join(root, 'queue.config.json');
  let own = {};
  try {
    own = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      process.stderr.write(`WARNING: could not read ${file} (${e?.message}); using the default values.\n`);
    }
  }
  const k = merge(STANDARD, own);
  k.root = root;
  if (!o.root) buffer = k;
  return k;
}

/** Absolute path to the data folder (QUEUE_FOLDER overrides). */
function dataFolder() {
  return process.env.QUEUE_FOLDER ?? path.join(config().root, config().dataFolder);
}

/** Absolute path to the time log (QUEUE_TIME_LOG overrides). */
function timeLog() {
  return process.env.QUEUE_TIME_LOG ?? path.join(config().root, config().timeLog);
}

module.exports = { STANDARD, merge, findRoot, config, dataFolder, timeLog };
