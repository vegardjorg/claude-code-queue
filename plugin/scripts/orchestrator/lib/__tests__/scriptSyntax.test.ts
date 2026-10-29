// =============================================================
// scriptSyntax.test.ts: every script the plugin ships parses (node --check).
//
// Many scripts (setup.mjs, install.mjs, the hooks) are never imported by a test, so a syntax error in them, such as a
// broken regular expression, would pass the rest of the suite and only show up when a user runs them. This test runs
// `node --check` on every .mjs and .js file under scripts/orchestrator and the repo's scripts/ folder.
// =============================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const orchestrator = join(__dirname, '..', '..');
const repoScripts = join(orchestrator, '..', '..', '..', 'scripts');

/** All .mjs and .js files under a folder, without tests and node_modules. */
function scripts(folder: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(folder)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(folder, name);
    if (statSync(p).isDirectory()) out.push(...scripts(p));
    else if (/\.m?js$/.test(name)) out.push(p);
  }
  return out;
}

describe('every shipped script parses', () => {
  it('node --check passes for all scripts', () => {
    const files = [...scripts(orchestrator), ...scripts(repoScripts)];
    expect(files.length).toBeGreaterThan(20); // guard against the check silently finding nothing
    const broken = files
      .map((f) => ({ f, r: spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }) }))
      .filter(({ r }) => r.status !== 0)
      .map(({ f, r }) => `${f}: ${(r.stderr ?? '').split('\n').find((l) => /Error/.test(l)) ?? 'error'}`);
    expect(broken).toEqual([]);
  }, 120_000);
});
