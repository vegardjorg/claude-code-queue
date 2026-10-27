#!/usr/bin/env node
// =============================================================
// install.mjs: installs the queue system (claude-cowie-qeue) into an existing project.
//
// Usage:
//   node scripts/install.mjs <target-project> [--overwrite] [--with-tester] [--dry]
//
// What it does (everything is "add to", nothing is deleted):
//   1. Copies template/scripts/orchestrator/ -> <target>/scripts/orchestrator/ (without __tests__ unless --with-tester).
//      If a file already exists, it is skipped (with --overwrite it is replaced).
//   2. Copies skills (template/.claude/skills/*) and agents (template/.claude/agents/*) the same way.
//   3. Copies docs/*.md -> <target>/docs/queue/, CLAUDE.queue.md -> <target>/CLAUDE.queue.md and
//      queue.config.example.json -> <target>/queue.config.json (only when they are missing).
//   4. Merges template/.claude/settings.queue.json into <target>/.claude/settings.json: missing keys are added,
//      existing values are always kept, and hooks are added only when the same command does not already exist.
//   5. Adds the lines for the queue's data folder and worktrees to <target>/.gitignore when they are missing.
// --dry shows what would happen, without writing anything.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TEMPLATE = path.join(REPO, 'template');

const args = process.argv.slice(2);
const flag = new Set(args.filter((a) => a.startsWith('--')));
const templateArg = args.find((a) => !a.startsWith('--'));
if (!templateArg) {
  console.error('usage: node scripts/install.mjs <target-project> [--overwrite] [--with-tester] [--dry]');
  process.exit(2);
}
const TEMPLATE_ROOT = path.resolve(templateArg);
const OVERWRITE = flag.has('--overwrite');
const WITH_TESTS = flag.has('--with-tester');
const DRY = flag.has('--dry');

if (!fs.existsSync(TEMPLATE_ROOT) || !fs.statSync(TEMPLATE_ROOT).isDirectory()) {
  console.error(`Could not find the target folder: ${TEMPLATE_ROOT}`);
  process.exit(2);
}
if (path.resolve(TEMPLATE_ROOT) === REPO) {
  console.error('The target cannot be the claude-cowie-qeue repo itself.');
  process.exit(2);
}

// Counters for the summary at the end.
const log = { copied: [], skippedOver: [], replaced: [] };

/** Creates the folder (recursively) when we are not doing a dry run. */
function makeFolder(dir) {
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
}

/** Copies one file, but respects existing files unless --overwrite. */
function copyFile(from, to) {
  const rel = path.relative(TEMPLATE_ROOT, to);
  if (fs.existsSync(to)) {
    if (!OVERWRITE) {
      log.skippedOver.push(rel);
      return;
    }
    log.replaced.push(rel);
  } else {
    log.copied.push(rel);
  }
  if (DRY) return;
  makeFolder(path.dirname(to));
  fs.copyFileSync(from, to);
}

/** Copies a folder recursively. `skip(name)` can leave out folders (e.g. __tests__). */
function copyFolder(from, to, skip = () => false) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const f = path.join(from, e.name);
    const t = path.join(to, e.name);
    if (e.isDirectory()) copyFolder(f, t, skip);
    else copyFile(f, t);
  }
}

// ---- 1-3: files ----
copyFolder(
  path.join(TEMPLATE, 'scripts', 'orchestrator'),
  path.join(TEMPLATE_ROOT, 'scripts', 'orchestrator'),
  (name) => !WITH_TESTS && name === '__tests__',
);
// The libraries are CommonJS (.js with require). A package.json with "type": "commonjs" in the folder makes them work
// also when the target project itself has "type": "module".
{
  const pj = path.join(TEMPLATE_ROOT, 'scripts', 'orchestrator', 'package.json');
  if (!fs.existsSync(pj)) {
    log.copied.push(path.relative(TEMPLATE_ROOT, pj));
    if (!DRY) {
      makeFolder(path.dirname(pj));
      fs.writeFileSync(pj, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
    }
  }
}
copyFolder(path.join(TEMPLATE, '.claude', 'skills'), path.join(TEMPLATE_ROOT, '.claude', 'skills'));
copyFolder(path.join(TEMPLATE, '.claude', 'agents'), path.join(TEMPLATE_ROOT, '.claude', 'agents'));
for (const f of fs.readdirSync(path.join(REPO, 'docs'))) {
  if (f.endsWith('.md')) copyFile(path.join(REPO, 'docs', f), path.join(TEMPLATE_ROOT, 'docs', 'queue', f));
}
copyFile(path.join(REPO, 'CLAUDE.queue.md'), path.join(TEMPLATE_ROOT, 'CLAUDE.queue.md'));
// queue.config.json is never overwritten, not even with --overwrite (it holds the project's own options).
{
  const to = path.join(TEMPLATE_ROOT, 'queue.config.json');
  if (fs.existsSync(to)) log.skippedOver.push('queue.config.json');
  else {
    log.copied.push('queue.config.json');
    if (!DRY) fs.copyFileSync(path.join(REPO, 'queue.config.example.json'), to);
  }
}

// ---- 4: settings ----
/** All the commands in a hook list (to see whether a hook already exists). */
function commands(groups) {
  const out = new Set();
  for (const g of groups ?? []) for (const h of g.hooks ?? []) if (h.command) out.add(h.command);
  return out;
}

const settingsPath = path.join(TEMPLATE_ROOT, '.claude', 'settings.json');
const fresh = JSON.parse(fs.readFileSync(path.join(TEMPLATE, '.claude', 'settings.queue.json'), 'utf8'));
let existing = {};
if (fs.existsSync(settingsPath)) {
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error(`Could not read ${settingsPath} as JSON (${e.message}). Fix the file and run again.`);
    process.exit(1);
  }
}
const changes = [];
for (const [key, val] of Object.entries(fresh)) {
  if (key.startsWith('_') || key.startsWith('$')) continue; // comments
  if (key === 'hooks') continue;
  if (existing[key] === undefined) {
    existing[key] = val;
    changes.push(`added ${key}`);
  } else if (typeof val === 'object' && !Array.isArray(val) && typeof existing[key] === 'object') {
    for (const [k, v] of Object.entries(val)) {
      if (existing[key][k] === undefined) {
        existing[key][k] = v;
        changes.push(`added ${key}.${k}`);
      }
    }
  } else {
    changes.push(`kept existing ${key}`);
  }
}
existing.hooks = existing.hooks ?? {};
for (const [event, groups] of Object.entries(fresh.hooks ?? {})) {
  const list = (existing.hooks[event] = existing.hooks[event] ?? []);
  const exists = commands(list);
  for (const g of groups) {
    const newHooks = (g.hooks ?? []).filter((h) => !exists.has(h.command));
    if (newHooks.length === 0) continue;
    list.push({ ...g, hooks: newHooks });
    changes.push(`hook ${event}: ${newHooks.map((h) => h.command.split('/').pop()).join(', ')}`);
  }
}
if (!DRY) {
  makeFolder(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
}

// ---- 5: .gitignore ----
const gitignorePath = path.join(TEMPLATE_ROOT, '.gitignore');
const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
const hasLine = (l) => gitignore.split(/\r?\n/).some((x) => x.trim() === l);
const newLines = ['scripts/.queue/', '.claude/worktrees/'].filter((l) => !hasLine(l));
if (newLines.length && !DRY) {
  const pre = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gitignorePath, `${pre}\n# claude-cowie-qeue (the queue's data and the agents' worktrees)\n${newLines.join('\n')}\n`);
}

// ---- Summary ----
console.log(`${DRY ? '[DRY] ' : ''}Installed claude-cowie-qeue in ${TEMPLATE_ROOT}`);
console.log(`  copied: ${log.copied.length}, replaced: ${log.replaced.length}, skipped (already existed): ${log.skippedOver.length}`);
if (log.skippedOver.length) console.log(`  skipped: ${log.skippedOver.slice(0, 15).join(', ')}${log.skippedOver.length > 15 ? ' ...' : ''}`);
console.log(`  .claude/settings.json: ${changes.length ? changes.join('; ') : 'no changes'}`);
console.log(`  .gitignore: ${newLines.length ? 'added ' + newLines.join(' ') : 'unchanged'}`);
console.log('');
console.log('Next steps:');
console.log('  1. Edit queue.config.json (baseBranch, gates, modules).');
console.log('  2. Add the line @CLAUDE.queue.md to the project\'s CLAUDE.md.');
console.log('  3. node scripts/orchestrator/queue.mjs init');
console.log('  4. node scripts/orchestrator/queue.mjs show');
