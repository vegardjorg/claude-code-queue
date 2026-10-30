// =============================================================
// setup.test.ts: setup.mjs merges settings.queue.json into a project's .claude/settings.json.
//
// The hooks in settings.queue.json are the vendored install's copy of plugin/hooks/hooks.json. The test proves that a
// project set up before a hook was added gets the new hook next to the old ones (never twice), and that the two hook
// files list the same scripts.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error: plain ESM script without types
import { mergeSettings, PLUGIN_ROOT } from '../setup.mjs';

type Settings = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> } & Record<
  string,
  unknown
>;

/** The hook scripts per event in a settings or hooks.json file. */
function scriptsPerEvent(s: Settings) {
  const out: Record<string, string[]> = {};
  for (const [event, groups] of Object.entries(s.hooks ?? {}))
    out[event] = groups
      .flatMap((g) => g.hooks.map((h) => /(hook-[\w-]+\.mjs)/.exec(h.command)?.[1] ?? h.command))
      .sort();
  return out;
}

describe('setup.mjs mergeSettings', () => {
  let target: string;
  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), 'queue-setup-'));
  });
  afterEach(() => rmSync(target, { recursive: true, force: true }));

  it('hooks.json and settings.queue.json list the same hook scripts per event', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const vendored = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'settings.queue.json'), 'utf8'));
    expect(scriptsPerEvent(vendored)).toEqual(scriptsPerEvent(plugin));
    expect(scriptsPerEvent(plugin).SubagentStop).toEqual(['hook-time.mjs', 'hook-track-end.mjs']);
  });

  it('an older install gets hook-track-end.mjs on SubagentStop, once', () => {
    mkdirSync(join(target, '.claude'));
    const file = join(target, '.claude', 'settings.json');
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          SubagentStop: [
            { matcher: '*', hooks: [{ type: 'command', command: 'node scripts/orchestrator/hook-time.mjs' }] },
          ],
        },
      }),
    );
    const notes = mergeSettings(target, { hooks: true }).join('\n');
    expect(notes).toContain('hook SubagentStop: hook-track-end.mjs');
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(scriptsPerEvent(after).SubagentStop).toEqual(['hook-time.mjs', 'hook-track-end.mjs']);
    // A second run adds nothing.
    mergeSettings(target, { hooks: true });
    expect(scriptsPerEvent(JSON.parse(readFileSync(file, 'utf8'))).SubagentStop).toEqual([
      'hook-time.mjs',
      'hook-track-end.mjs',
    ]);
  });

  const settingsFile = () => join(target, '.claude', 'settings.json');
  const read = () => JSON.parse(readFileSync(settingsFile(), 'utf8'));
  const pluginCommand = `node "${join(PLUGIN_ROOT, 'scripts', 'orchestrator', 'statusline.mjs').split('\\').join('/')}"`;

  it('statusLine: a plugin install writes the absolute plugin path, a vendored one the $CLAUDE_PROJECT_DIR form', () => {
    mergeSettings(target, { keys: true });
    expect(read().statusLine).toMatchObject({ type: 'command', command: pluginCommand, padding: 0 });
    rmSync(settingsFile());
    mergeSettings(target, { keys: true, hooks: true });
    expect(read().statusLine.command).toBe('node "$CLAUDE_PROJECT_DIR/scripts/orchestrator/statusline.mjs"');
  });

  it('statusLine: without --settings it is only recommended', () => {
    const notes = mergeSettings(target, {}).join('\n');
    expect(notes).toContain('recommended, not set');
    expect(notes).toContain('statusLine=');
  });

  it('statusLine: an old plugin path is refreshed, someone else`s status line is kept', () => {
    mkdirSync(join(target, '.claude'));
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        statusLine: { type: 'command', command: 'node "/old/cq/1.0.0/scripts/orchestrator/statusline.mjs"', padding: 1 },
      }),
    );
    mergeSettings(target, { keys: true });
    expect(read().statusLine).toEqual({ type: 'command', command: pluginCommand, padding: 1 });

    writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: 'command', command: 'my-line.sh' } }));
    const notes = mergeSettings(target, { keys: true }).join('\n');
    expect(notes).toContain('statusLine: kept your own');
    expect(read().statusLine).toEqual({ type: 'command', command: 'my-line.sh' });
  });
});
