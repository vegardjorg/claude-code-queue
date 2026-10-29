#!/usr/bin/env node
// =============================================================
// setup.mjs: sets a project up for the work queue. Run by the /cq:setup skill as `cq setup`, and reused by
// scripts/install.mjs (vendored install), so both install paths write the same project files.
//
// Usage:
//   cq setup [--dry] [--overwrite] [--claude-md] [--settings] [--target <dir>]
//
// What it does (everything is "add to"; existing files are kept unless --overwrite, and queue.config.json is never replaced):
//   1. queue.config.json from <plugin>/queue.config.example.json, when missing.
//   2. <plugin>/docs/*.md -> docs/queue/ (the mission template there is the project's own copy and may be edited).
//   3. CLAUDE.queue.md (the queue's rules for Claude), when missing.
//   4. .gitignore: the data folder and the agents' worktrees.
//   5. --claude-md: adds the line @CLAUDE.queue.md to CLAUDE.md (creates the file when missing).
//   6. --settings: adds the recommended settings to .claude/settings.json (1 h prompt cache for subagents, compaction
//      at 300k, worktrees from HEAD). A plugin cannot set these itself; without the flag they are only listed.
// The target is the project's main tree (lib/projectRoot.js), or --target.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The plugin root: two folders above scripts/orchestrator/. */
export const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

/** The lines .gitignore needs: the queue's data and the agents' worktrees. */
export const GITIGNORE_LINES = ['scripts/.queue/', '.claude/worktrees/'];

/**
 * Sets up `target`. Returns a log { copied, replaced, skipped, notes } and writes nothing when `dry`.
 * @param {object} o
 * @param {string} o.target                 the project's main tree
 * @param {boolean} [o.dry]                 only report
 * @param {boolean} [o.overwrite]           replace existing docs and CLAUDE.queue.md
 * @param {boolean} [o.claudeMd]            add @CLAUDE.queue.md to CLAUDE.md
 * @param {boolean} [o.settings]            add the recommended keys to .claude/settings.json
 * @param {boolean} [o.hooks]               also merge the hooks into .claude/settings.json (vendored install only;
 *                                          a plugin has its own hooks/hooks.json)
 * @param {(text: string) => string} [o.transformMd]  rewrites the Markdown on the way (install.mjs: cq -> node form)
 */
export function setupProject(o) {
  const log = { copied: [], replaced: [], skipped: [], notes: [] };
  const t = path.resolve(o.target);
  const rel = (p) => path.relative(t, p).split(path.sep).join('/');
  const write = (to, text) => {
    if (o.dry) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, text);
  };
  /** Copies one file; Markdown goes through transformMd. Existing files are kept unless overwrite. */
  const copy = (from, to, overwrite = o.overwrite) => {
    if (fs.existsSync(to)) {
      if (!overwrite) return void log.skipped.push(rel(to));
      log.replaced.push(rel(to));
    } else log.copied.push(rel(to));
    const text = fs.readFileSync(from, 'utf8');
    write(to, from.endsWith('.md') && o.transformMd ? o.transformMd(text) : text);
  };

  // 1-3: files. queue.config.json holds the project's own options and is never replaced.
  copy(path.join(PLUGIN_ROOT, 'queue.config.example.json'), path.join(t, 'queue.config.json'), false);
  for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, 'docs')).filter((f) => f.endsWith('.md')).sort())
    copy(path.join(PLUGIN_ROOT, 'docs', f), path.join(t, 'docs', 'queue', f));
  copy(path.join(PLUGIN_ROOT, 'CLAUDE.queue.md'), path.join(t, 'CLAUDE.queue.md'));

  // 4: .gitignore
  const gitignorePath = path.join(t, '.gitignore');
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const missing = GITIGNORE_LINES.filter((l) => !gitignore.split(/\r?\n/).some((x) => x.trim() === l));
  if (missing.length) {
    const pre = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
    if (!o.dry)
      fs.appendFileSync(gitignorePath, `${pre}\n# claude-cowie-queue (the queue's data and the agents' worktrees)\n${missing.join('\n')}\n`);
    log.notes.push(`.gitignore: added ${missing.join(' ')}`);
  } else log.notes.push('.gitignore: unchanged');

  // 5: CLAUDE.md import line
  const claudeMd = path.join(t, 'CLAUDE.md');
  const hasImport =
    fs.existsSync(claudeMd) && fs.readFileSync(claudeMd, 'utf8').split(/\r?\n/).some((l) => l.trim() === '@CLAUDE.queue.md');
  if (hasImport) log.notes.push('CLAUDE.md: already imports CLAUDE.queue.md');
  else if (o.claudeMd) {
    const old = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';
    write(claudeMd, `${old}${old && !old.endsWith('\n') ? '\n' : ''}${old ? '\n' : ''}@CLAUDE.queue.md\n`);
    log.notes.push('CLAUDE.md: added @CLAUDE.queue.md');
  } else log.notes.push('CLAUDE.md: does not import CLAUDE.queue.md (run again with --claude-md, or add the line yourself)');

  // 6: settings
  log.notes.push(...mergeSettings(t, { dry: o.dry, keys: o.settings, hooks: o.hooks }));
  return log;
}

/**
 * Merges settings.queue.json into <target>/.claude/settings.json: missing keys are added, existing values are kept, and
 * hooks (only with `hooks`) are added when the same command is not there yet. Without `keys` the keys are only listed.
 */
export function mergeSettings(target, o = {}) {
  const fresh = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings.queue.json'), 'utf8'));
  const settingsPath = path.join(target, '.claude', 'settings.json');
  let existing = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return [`.claude/settings.json: could not read it as JSON (${e.message}); not changed`];
    }
  }
  const changes = [];
  const wanted = [];
  for (const [key, val] of Object.entries(fresh)) {
    if (key.startsWith('_') || key.startsWith('$') || key === 'hooks') continue; // comments; hooks below
    if (existing[key] === undefined) {
      wanted.push(`${key}=${JSON.stringify(val)}`);
      if (o.keys) existing[key] = val;
    } else if (typeof val === 'object' && !Array.isArray(val) && typeof existing[key] === 'object') {
      for (const [k, v] of Object.entries(val))
        if (existing[key][k] === undefined) {
          wanted.push(`${key}.${k}=${JSON.stringify(v)}`);
          if (o.keys) existing[key][k] = v;
        }
    }
  }
  if (wanted.length) changes.push(o.keys ? `added ${wanted.join(', ')}` : `recommended, not set (use --settings): ${wanted.join(', ')}`);
  if (o.hooks) {
    const commands = (groups) => new Set((groups ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command)));
    existing.hooks = existing.hooks ?? {};
    for (const [event, groups] of Object.entries(fresh.hooks ?? {})) {
      const list = (existing.hooks[event] = existing.hooks[event] ?? []);
      const there = commands(list);
      for (const g of groups) {
        const added = (g.hooks ?? []).filter((h) => !there.has(h.command));
        if (!added.length) continue;
        list.push({ ...g, hooks: added });
        changes.push(`hook ${event}: ${added.map((h) => h.command.split('/').pop()).join(', ')}`);
      }
    }
  }
  const touched = (o.keys && wanted.length) || changes.some((c) => c.startsWith('hook '));
  if (touched && !o.dry) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  }
  return [`.claude/settings.json: ${changes.length ? changes.join('; ') : 'nothing to add'}`];
}

// ---- command line (not when imported by install.mjs) ----
const started = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
const isMain =
  process.platform === 'win32' ? started.toLowerCase() === import.meta.url.toLowerCase() : started === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const i = args.indexOf('--target');
  const known = ['--dry', '--overwrite', '--claude-md', '--settings', '--target'];
  const unknown = [...flags].filter((f) => !known.includes(f));
  if (unknown.length) {
    console.error(`setup: unknown option ${unknown.join(' ')}. Use: cq setup [--dry] [--overwrite] [--claude-md] [--settings] [--target <dir>]`);
    process.exit(2);
  }
  const target = i >= 0 ? path.resolve(args[i + 1]) : require('./lib/projectRoot.js').roots().main;
  const log = setupProject({
    target,
    dry: flags.has('--dry'),
    overwrite: flags.has('--overwrite'),
    claudeMd: flags.has('--claude-md'),
    settings: flags.has('--settings'),
  });
  console.log(`${flags.has('--dry') ? '[DRY] ' : ''}Set up the work queue in ${target}`);
  console.log(`  copied: ${log.copied.join(', ') || '-'}`);
  if (log.replaced.length) console.log(`  replaced: ${log.replaced.join(', ')}`);
  if (log.skipped.length) console.log(`  kept (already there): ${log.skipped.join(', ')}`);
  for (const n of log.notes) console.log(`  ${n}`);
}
