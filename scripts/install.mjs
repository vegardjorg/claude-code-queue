#!/usr/bin/env node
// =============================================================
// install.mjs: installs the queue system (claude-code-queue) into an existing project as plain files ("vendored"),
// for when you do not want it as a Claude Code plugin. The plugin is the recommended way: see README.md.
//
// Usage:
//   node scripts/install.mjs <target-project> [--overwrite] [--with-tester] [--dry]
//
// What it does (everything is "add to", nothing is deleted):
//   1. Copies plugin/scripts/orchestrator/ -> <target>/scripts/orchestrator/ (without __tests__ unless --with-tester).
//      If a file already exists, it is skipped (with --overwrite it is replaced).
//   2. Copies the skills (plugin/skills/*, except setup, which is this script's job) to <target>/.claude/skills/ and the
//      agents (plugin/agents/*) to <target>/.claude/agents/ the same way.
//   3. The project files, through setup.mjs (the same code /cq:setup runs): queue.config.json, docs/queue/,
//      CLAUDE.queue.md, .gitignore, and plugin/settings.queue.json merged into <target>/.claude/settings.json, here
//      WITH the hooks (a plugin brings its own hooks/hooks.json; a vendored install needs them in the settings).
// The Markdown is written for the plugin: `cq <...>` becomes `node scripts/orchestrator/cq.mjs <...>` and
// ${CLAUDE_PLUGIN_ROOT}/skills/ becomes .claude/skills/ on the way.
// --dry shows what would happen, without writing anything.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupProject } from '../plugin/scripts/orchestrator/setup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PLUGIN = path.join(REPO, 'plugin');

const args = process.argv.slice(2);
const flag = new Set(args.filter((a) => a.startsWith('--')));
const targetArg = args.find((a) => !a.startsWith('--'));
if (!targetArg) {
  console.error('usage: node scripts/install.mjs <target-project> [--overwrite] [--with-tester] [--dry]');
  process.exit(2);
}
const TARGET = path.resolve(targetArg);
const OVERWRITE = flag.has('--overwrite');
const WITH_TESTS = flag.has('--with-tester');
const DRY = flag.has('--dry');

if (!fs.existsSync(TARGET) || !fs.statSync(TARGET).isDirectory()) {
  console.error(`Could not find the target folder: ${TARGET}`);
  process.exit(2);
}
if (TARGET === REPO) {
  console.error('The target cannot be the claude-code-queue repo itself.');
  process.exit(2);
}

// Counters for the summary at the end.
const log = { copied: [], skippedOver: [], replaced: [] };

/** Creates the folder (recursively) when we are not doing a dry run. */
function makeFolder(dir) {
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
}

/**
 * The skills, agents and docs are written for the plugin, where `cq` is on PATH and the skills live under
 * ${CLAUDE_PLUGIN_ROOT}. A vendored install has neither: `cq <...>` becomes `node scripts/orchestrator/cq.mjs <...>`
 * (the same entry point) and ${CLAUDE_PLUGIN_ROOT}/skills/ becomes .claude/skills/.
 */
function vendoredCommands(text) {
  return text
    .replace(/(?<![\w./-])cq(?= )/g, 'node scripts/orchestrator/cq.mjs')
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\//g, '.claude/skills/');
}

/** Copies one file, but respects existing files unless --overwrite. Markdown goes through vendoredCommands. */
function copyFile(from, to) {
  const rel = path.relative(TARGET, to);
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
  if (from.endsWith('.md')) fs.writeFileSync(to, vendoredCommands(fs.readFileSync(from, 'utf8')));
  else fs.copyFileSync(from, to);
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

// ---- 1-2: scripts, skills, agents ----
copyFolder(
  path.join(PLUGIN, 'scripts', 'orchestrator'),
  path.join(TARGET, 'scripts', 'orchestrator'),
  (name) => !WITH_TESTS && name === '__tests__',
);
// The libraries are CommonJS (.js with require). A package.json with "type": "commonjs" in the folder makes them work
// also when the target project itself has "type": "module".
{
  const pj = path.join(TARGET, 'scripts', 'orchestrator', 'package.json');
  if (!fs.existsSync(pj)) {
    log.copied.push(path.relative(TARGET, pj));
    if (!DRY) {
      makeFolder(path.dirname(pj));
      fs.writeFileSync(pj, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
    }
  }
}
copyFolder(path.join(PLUGIN, 'skills'), path.join(TARGET, '.claude', 'skills'), (name) => name === 'setup');
copyFolder(path.join(PLUGIN, 'agents'), path.join(TARGET, '.claude', 'agents'));

// ---- 3: project files and settings (setup.mjs) ----
const project = setupProject({
  target: TARGET,
  dry: DRY,
  overwrite: OVERWRITE,
  settings: true,
  hooks: true,
  transformMd: vendoredCommands,
});
log.copied.push(...project.copied);
log.replaced.push(...project.replaced);
log.skippedOver.push(...project.skipped);

// ---- Summary ----
console.log(`${DRY ? '[DRY] ' : ''}Installed claude-code-queue (vendored) in ${TARGET}`);
console.log(`  copied: ${log.copied.length}, replaced: ${log.replaced.length}, skipped (already existed): ${log.skippedOver.length}`);
if (log.skippedOver.length) console.log(`  skipped: ${log.skippedOver.slice(0, 15).join(', ')}${log.skippedOver.length > 15 ? ' ...' : ''}`);
for (const n of project.notes) console.log(`  ${n}`);
console.log('');
console.log('Next steps:');
console.log('  1. Edit queue.config.json (baseBranch, gates, modules).');
console.log("  2. Add the line @CLAUDE.queue.md to the project's CLAUDE.md.");
console.log('  3. node scripts/orchestrator/cq.mjs init');
console.log('  4. node scripts/orchestrator/cq.mjs show');
