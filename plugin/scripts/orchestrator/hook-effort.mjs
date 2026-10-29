#!/usr/bin/env node
// Hook (UserPromptSubmit): writes the session's thinking level (effort) to <dataFolder>/effort.json, so queue-takeover and
// queue.mjs can warn when the orchestrator is not running on medium (medium is the default; high/xhigh only when the owner
// has confirmed). The level comes from the hook input (`effort.level`) or the env var CLAUDE_EFFORT. Writes only when the
// data folder has a queue.json (the queue is set up), and never fails: a hook must not stop a message.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);

let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}
try {
  let data = {};
  try {
    data = JSON.parse(input || '{}');
  } catch {
    /* invalid JSON: use the env var */
  }
  const level = data?.effort?.level ?? process.env.CLAUDE_EFFORT ?? null;
  // The data folder in mainTree (config().root is mainTree, also from a worktree; QUEUE_FOLDER overrides).
  const folder = require('./lib/queueConfig.js').dataFolder();
  if (level && fs.existsSync(path.join(folder, 'queue.json'))) {
    const out = { level, time: new Date().toISOString(), session: data?.session_id ?? null };
    const tmp = path.join(folder, `effort.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, path.join(folder, 'effort.json'));
  }
} catch {
  /* never stop the message */
}
process.exit(0);
