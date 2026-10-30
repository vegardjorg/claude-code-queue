// =============================================================
// queueUpdate.test.ts: the rules for the board's update banner (lib/queueUpdate.js).
// Semver comparison, the 24-hour cache, off via config and env, errors give null, the setup notice, closing per version.
// fetch is always a mock: no test goes on the network.
// =============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const U = require('../queueUpdate.js');

const HOUR = 3_600_000;
/** A fetch mock that answers with a manifest (or the given body / status). */
const answering = (body: string, ok = true) =>
  vi.fn(async () => ({ ok, status: ok ? 200 : 500, text: async () => body }));

describe('compare (semver)', () => {
  it('orders major, minor and patch numerically', () => {
    expect(U.compare('0.3.0', '0.3.0')).toBe(0);
    expect(U.compare('0.4.0', '0.3.9')).toBe(1);
    expect(U.compare('0.3.10', '0.3.9')).toBe(1);
    expect(U.compare('1.0.0', '0.99.99')).toBe(1);
    expect(U.compare('0.2.0', '0.10.0')).toBe(-1);
    expect(U.compare('v1.2.3', '1.2.3')).toBe(0);
  });
  it('a prerelease is older than the release, and build metadata is ignored', () => {
    expect(U.compare('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(U.compare('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(U.compare('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(U.compare('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(U.compare('1.0.0+abc', '1.0.0+def')).toBe(0);
  });
  it('gives null for anything that is not semver', () => {
    expect(U.compare('1.0', '1.0.0')).toBeNull();
    expect(U.compare('latest', '1.0.0')).toBeNull();
    expect(U.compare(null, '1.0.0')).toBeNull();
  });
});

describe('disabledReason (config and env)', () => {
  it('is on by default', () => {
    expect(U.disabledReason({ board: { updateCheck: true } }, {})).toBeNull();
    expect(U.disabledReason({}, {})).toBeNull();
  });
  it('DISABLE_AUTOUPDATER does not turn it off (the desktop app sets it in every session)', () => {
    expect(U.disabledReason({}, { DISABLE_AUTOUPDATER: '1' })).toBeNull();
  });
  it('board.updateCheck: false turns it off', () => {
    expect(U.disabledReason({ board: { updateCheck: false } }, {})).toMatch(/updateCheck/);
  });
  it.each(['DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])(
    '%s set turns it off, empty or "0" does not',
    (name) => {
      expect(U.disabledReason({}, { [name]: '1' })).toMatch(name);
      expect(U.disabledReason({}, { [name]: '' })).toBeNull();
      expect(U.disabledReason({}, { [name]: '0' })).toBeNull();
    },
  );
});

describe('latestVersion (fetch and cache)', () => {
  let dir: string;
  let cacheFile: string;
  const base = () => ({ config: {}, env: {}, cacheFile, fs, now: 1_000 * HOUR });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-update-'));
    cacheFile = join(dir, 'data', 'update-check.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fetches with a plain GET (no headers, only the timeout signal) and writes the cache', async () => {
    const fetch = answering(JSON.stringify({ name: 'cq', version: '0.4.0' }));
    const r = await U.latestVersion({ ...base(), fetch });
    expect(r).toEqual({ latest: '0.4.0', checkedAt: 1_000 * HOUR, cached: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe(U.MANIFEST_URL);
    expect(Object.keys(init)).toEqual(['signal']);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({ checkedAt: 1_000 * HOUR, latest: '0.4.0' });
  });

  it('uses the cache within 24 hours and fetches again after', async () => {
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ checkedAt: 1_000 * HOUR - 23 * HOUR, latest: '0.5.0' }));
    cacheFile = join(dir, 'c.json');
    const fetch = answering(JSON.stringify({ version: '0.6.0' }));
    expect(await U.latestVersion({ ...base(), fetch })).toMatchObject({ latest: '0.5.0', cached: true });
    expect(fetch).not.toHaveBeenCalled();
    // 25 hours later the cache is old: one new fetch, and the cache is refreshed.
    const later = await U.latestVersion({ ...base(), now: 1_000 * HOUR + 2 * HOUR, fetch });
    expect(later).toMatchObject({ latest: '0.6.0', cached: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).latest).toBe('0.6.0');
  });

  it('off via config or env: no fetch, null', async () => {
    const fetch = answering(JSON.stringify({ version: '9.0.0' }));
    expect(await U.latestVersion({ ...base(), config: { board: { updateCheck: false } }, fetch })).toBeNull();
    expect(await U.latestVersion({ ...base(), env: { DISABLE_UPDATES: '1' }, fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('every error gives null and writes no cache', async () => {
    const cases = [
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
      vi.fn(async () => {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      }),
      answering('<html>not json</html>'),
      answering(JSON.stringify({ version: 'soon' })),
      answering('{}', false),
    ];
    for (const fetch of cases) expect(await U.latestVersion({ ...base(), fetch })).toBeNull();
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('a broken cache file is ignored (fetched again)', async () => {
    writeFileSync(join(dir, 'c.json'), '{ broken');
    cacheFile = join(dir, 'c.json');
    const fetch = answering(JSON.stringify({ version: '0.4.0' }));
    expect(await U.latestVersion({ ...base(), fetch })).toMatchObject({ latest: '0.4.0' });
  });
});

describe('notice and visible', () => {
  it('a newer version gives the banner with the CHANGELOG and the plugin steps', () => {
    const n = U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.4.0', setupVersion: '0.3.0' });
    expect(n.newVersion.latest).toBe('0.4.0');
    expect(n.newVersion.changelog).toBe('https://github.com/vegardjorg/claude-code-queue/blob/main/CHANGELOG.md');
    expect(n.newVersion.steps.map((s: { command: string }) => s.command)).toEqual([
      'claude plugin update cq@claude-code-queue',
      '/reload-plugins',
      'cq setup --settings',
    ]);
    expect(n.setup).toBeNull();
  });
  it('the same or an older published version gives nothing', () => {
    expect(U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.3.0', setupVersion: '0.3.0' })).toBeNull();
    expect(U.notice({ mode: 'plugin', installed: '0.4.0', latest: '0.3.0', setupVersion: '0.4.0' })).toBeNull();
    expect(U.notice({ mode: 'plugin', installed: '0.3.0', latest: null, setupVersion: '0.3.0' })).toBeNull();
  });
  it('vendored: the steps are git pull and the installer with the project folder', () => {
    const n = U.notice({ mode: 'vendored', installed: '0.3.0', latest: '0.4.0', projectFolder: 'C:\\p\\app' });
    expect(n.newVersion.steps.map((s: { command: string }) => s.command)).toEqual([
      'git pull',
      'node scripts/install.mjs "C:/p/app" --overwrite',
    ]);
    // A vendored install never gets the setup notice (the installer writes the settings itself).
    expect(n.setup).toBeNull();
  });
  it('setup: a record that differs from the installed plugin, or none, says run setup (no network needed)', () => {
    expect(U.notice({ mode: 'plugin', installed: '0.4.0', latest: null, setupVersion: '0.3.0' })).toMatchObject({
      setup: 'run',
      newVersion: null,
    });
    expect(U.notice({ mode: 'plugin', installed: '0.4.0', latest: null, setupVersion: null }).setup).toBe('run');
    expect(U.notice({ mode: 'plugin', installed: '0.4.0', latest: null, setupVersion: '0.4.0' })).toBeNull();
    // Set up for a newer plugin than this board runs: the board must be restarted.
    expect(U.notice({ mode: 'plugin', installed: '0.3.0', latest: null, setupVersion: '0.4.0' }).setup).toBe('restart');
  });
  it('closing hides the new-version part for that version until a newer one is out; setup always shows', () => {
    const n = U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.4.0', setupVersion: null });
    expect(U.visible(n, null)).toEqual({ newVersion: true, setup: true });
    expect(U.visible(n, '0.4.0')).toEqual({ newVersion: false, setup: true });
    const newer = U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.5.0', setupVersion: '0.3.0' });
    expect(U.visible(newer, '0.4.0')).toEqual({ newVersion: true, setup: false });
    expect(U.visible(null, '0.4.0')).toEqual({ newVersion: false, setup: false });
  });
});

describe('the marketplace name', () => {
  it('matches the repo marketplace.json and the plugin name', () => {
    const root = join(__dirname, '..', '..', '..', '..', '..');
    const market = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(market.name).toBe(U.MARKETPLACE);
    expect(plugin.name).toBe(U.PLUGIN);
    expect(market.plugins.map((p: { name: string }) => p.name)).toContain(U.PLUGIN);
  });
});
