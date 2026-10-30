// =============================================================
// queueUpdate.js: the update banner on the board (see docs/board.md, "Update banner").
//
// Two independent notices, both computed on the server (queue-board.mjs) and drawn by board.js:
//   - NEW VERSION: at start (and at most once per 24 hours, cached in <dataFolder>/update-check.json) the server fetches
//     the published plugin.json from GitHub with a plain GET (no headers of its own, nothing about the user or the
//     project) and a short timeout. Any error (network, timeout, invalid JSON, no valid version) gives null and no
//     message. Off with board.updateCheck: false in queue.config.json, or when DISABLE_UPDATES, DISABLE_AUTOUPDATER or
//     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set.
//   - SETUP NOT RUN (local, no network, also with the check off): `cq setup --settings` records the plugin version it set
//     up in <dataFolder>/setup.json. A plugin install whose version differs from that record (or has none) shows that
//     setup must be run again (the status line holds the plugin's versioned path).
// Closing the banner hides the new-version part for that version until a newer one is out (localStorage in board.js,
// rules in `visible`). The setup part cannot be closed; it goes away when setup has been run.
//
// The file is both a CommonJS module (vitest, lib/__tests__/queueUpdate.test.ts, and queue-board.mjs) and a script in
// the browser (queue-board.mjs serves it as /queueUpdate.js and it sets window.QueueUpdate), like queueMascot.js.
// The functions that touch the disk or the network get fs and fetch passed in, so the tests never go on the net.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueUpdate = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The published manifest (the main branch of the public repo). */
  const MANIFEST_URL =
    'https://raw.githubusercontent.com/vegardjorg/claude-code-queue/main/plugin/.claude-plugin/plugin.json';
  const CHANGELOG_URL = 'https://github.com/vegardjorg/claude-code-queue/blob/main/CHANGELOG.md';
  /** The marketplace name in the repo's .claude-plugin/marketplace.json (a test checks they match). */
  const MARKETPLACE = 'claude-code-queue';
  const PLUGIN = 'cq';
  /** At most one check per day. */
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const TIMEOUT_MS = 3000;
  /** Any of these set (not empty, "0" or "false") turns the network check off. */
  const ENV_OFF = ['DISABLE_UPDATES', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
  /** The localStorage key in the browser for the version whose banner was closed. */
  const DISMISS_KEY = 'queue-board-update-dismissed';

  const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

  /** A version as { core: [major, minor, patch], pre: [...] }, or null when it is not semver. */
  function parse(v) {
    const m = SEMVER.exec(String(v ?? '').trim());
    if (!m) return null;
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
  }

  /**
   * Compares two semver versions: -1 when a is older, 0 when equal, 1 when a is newer, null when one is not valid.
   * A prerelease (1.0.0-beta) is older than the release (1.0.0); build metadata (+abc) is ignored.
   */
  function compare(a, b) {
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
      const p = x.pre[i];
      const q = y.pre[i];
      if (p === undefined) return -1;
      if (q === undefined) return 1;
      const pn = /^\d+$/.test(p);
      const qn = /^\d+$/.test(q);
      if (pn && qn) {
        if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
      } else if (pn !== qn) return pn ? -1 : 1;
      else if (p !== q) return p < q ? -1 : 1;
    }
    return 0;
  }

  /** Whether an environment variable counts as set (not empty, "0" or "false"). */
  const isSet = (v) => v != null && !['', '0', 'false'].includes(String(v).trim().toLowerCase());

  /**
   * Why the network check is off, or null when it is on. config is the merged queue.config.json, env is process.env.
   * @returns {string|null}
   */
  function disabledReason(config, env = {}) {
    if (config?.board?.updateCheck === false) return 'board.updateCheck is false';
    const name = ENV_OFF.find((n) => isSet(env[n]));
    return name ? `${name} is set` : null;
  }

  /** The cache file as { checkedAt, latest }, or null when it is missing or broken. */
  function readCache(fs, file) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof c?.checkedAt !== 'number' || !parse(c.latest)) return null;
      return { checkedAt: c.checkedAt, latest: String(c.latest) };
    } catch {
      return null;
    }
  }

  /**
   * Fetches the published version: a plain GET with only the timeout signal (no headers of our own). null on any error.
   * @returns {Promise<string|null>}
   */
  async function fetchLatest(fetchFn, o = {}) {
    try {
      const r = await fetchFn(o.url ?? MANIFEST_URL, { signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS) });
      if (!r || !r.ok) return null;
      const m = JSON.parse(await r.text());
      return parse(m?.version) ? String(m.version) : null;
    } catch {
      return null;
    }
  }

  /**
   * The latest published version, from the cache when it is younger than 24 hours, otherwise from the net (and then
   * written to the cache). null when the check is off, on any error, or when there is nothing to compare with.
   * Never throws.
   * @param {object} o
   * @param {object} o.config      queue.config.json (merged)
   * @param {object} [o.env]       process.env
   * @param {string} o.cacheFile   <dataFolder>/update-check.json
   * @param {object} o.fs          node:fs (readFileSync, writeFileSync, mkdirSync)
   * @param {Function} o.fetch     the fetch function (globalThis.fetch on the server, a mock in the tests)
   * @param {number} [o.now]       Date.now()
   * @returns {Promise<{ latest: string, checkedAt: number, cached: boolean } | null>}
   */
  async function latestVersion(o) {
    try {
      if (disabledReason(o.config, o.env ?? {})) return null;
      const now = o.now ?? Date.now();
      const cache = readCache(o.fs, o.cacheFile);
      if (cache && now - cache.checkedAt >= 0 && now - cache.checkedAt < MAX_AGE_MS)
        return { ...cache, cached: true };
      const latest = await fetchLatest(o.fetch, o);
      if (!latest) return null;
      try {
        o.fs.mkdirSync(folderOf(o.cacheFile), { recursive: true });
        o.fs.writeFileSync(o.cacheFile, JSON.stringify({ checkedAt: now, latest }, null, 2) + '\n');
      } catch {
        /* the cache is a convenience: without it the board checks again at the next start */
      }
      return { latest, checkedAt: now, cached: false };
    } catch {
      return null;
    }
  }

  /** The folder of a file path, without node:path (the file also runs in the browser). */
  function folderOf(file) {
    const s = String(file);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : '.';
  }

  /** The version `cq setup --settings` recorded last (<dataFolder>/setup.json), or null. */
  function readSetupRecord(fs, file) {
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parse(r?.pluginVersion) ? String(r.pluginVersion) : null;
    } catch {
      return null;
    }
  }

  /**
   * The steps to update, as { text, command } (command may be null). Plugin: claude plugin update, reload, setup.
   * Vendored: pull this repo and run the installer again (INSTALL.md).
   * @param {'plugin'|'vendored'} mode
   * @param {string} [projectFolder] the project's main tree (for the vendored installer command)
   */
  function steps(mode, projectFolder) {
    if (mode === 'plugin')
      return [
        { text: 'Update the plugin in a terminal:', command: `claude plugin update ${PLUGIN}@${MARKETPLACE}` },
        { text: 'Run /reload-plugins in Claude Code, or start a new session.', command: '/reload-plugins' },
        { text: 'Refresh the project settings (the status line path holds the version):', command: 'cq setup --settings' },
      ];
    const target = projectFolder ? `"${String(projectFolder).split('\\').join('/')}"` : '<your project folder>';
    return [
      { text: 'In your claude-code-queue folder, get the new version:', command: 'git pull' },
      { text: 'From that folder, install it into the project again:', command: `node scripts/install.mjs ${target} --overwrite` },
    ];
  }

  /**
   * What the banner says, computed on the server and sent in the state as `update`. null when there is nothing to say.
   * @param {object} o
   * @param {'plugin'|'vendored'} o.mode
   * @param {string|null} o.installed      the running version (plugin.json, or cq-version.json in a vendored install)
   * @param {string|null} [o.latest]       the published version (latestVersion), null when unknown or off
   * @param {string|null} [o.setupVersion] the version setup --settings recorded last
   * @param {string} [o.projectFolder]
   * @returns {null | { installed: string|null, newVersion: null|{ latest, changelog, steps }, setup: null|'run'|'restart' }}
   */
  function notice(o) {
    const installed = parse(o.installed) ? String(o.installed) : null;
    let newVersion = null;
    if (installed && o.latest && compare(o.latest, installed) === 1)
      newVersion = { latest: String(o.latest), changelog: CHANGELOG_URL, steps: steps(o.mode, o.projectFolder) };
    // Setup: only for a plugin install (the vendored installer writes the settings itself). An older or missing record
    // means setup was not run after the update. A NEWER record means the plugin was updated and set up while this
    // board still runs the old version: then the board itself must be restarted.
    let setup = null;
    if (o.mode === 'plugin' && installed) {
      const c = o.setupVersion ? compare(o.setupVersion, installed) : -1;
      if (c === null || c < 0) setup = 'run';
      else if (c > 0) setup = 'restart';
    }
    if (!newVersion && !setup) return null;
    return { installed, newVersion, setup, setupVersion: o.setupVersion ?? null };
  }

  /**
   * Which parts the board shows, given the version whose banner was closed (localStorage, may be null).
   * The new-version part stays hidden until a version newer than the closed one is out; setup always shows.
   * @returns {{ newVersion: boolean, setup: boolean }}
   */
  function visible(n, dismissed) {
    if (!n) return { newVersion: false, setup: false };
    const v = n.newVersion?.latest;
    const hiddenByDismiss = !!(v && dismissed && compare(v, dismissed) !== 1);
    return { newVersion: !!v && !hiddenByDismiss, setup: !!n.setup };
  }

  return {
    MANIFEST_URL,
    CHANGELOG_URL,
    MARKETPLACE,
    PLUGIN,
    MAX_AGE_MS,
    TIMEOUT_MS,
    ENV_OFF,
    DISMISS_KEY,
    parse,
    compare,
    disabledReason,
    readCache,
    fetchLatest,
    latestVersion,
    readSetupRecord,
    steps,
    notice,
    visible,
  };
});
