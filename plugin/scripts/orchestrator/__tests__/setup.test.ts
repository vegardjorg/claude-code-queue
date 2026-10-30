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
});
