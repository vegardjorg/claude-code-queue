/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardUpdate.test.ts: the update banner on the board (board.js draws `update` from the state with the rules in
// lib/queueUpdate.js). A newer version shows "cq X is out (you have Y)", the CHANGELOG link and copyable steps; closing it
// hides it for that version (localStorage) until a newer one is out; the setup notice cannot be closed and goes away
// when the state no longer carries it. The whole board runs in jsdom with a small synthetic queue (no network).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const U = require('../queueUpdate.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');

function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [],
    projects: {},
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// The state the mock server answers with; the tests change it and fire `focus` (the board fetches again).
let nr = 0;
let state: { version: string; data: Record<string, unknown> };
const base = T.board(makeQueue());
function setUpdate(update: unknown) {
  nr += 1;
  state = { version: `v${nr}`, data: { ...base, gitError: null, logo: false, update } };
}
async function refetch() {
  window.dispatchEvent(new Event('focus'));
  await flush();
}
const banner = () => document.getElementById('update-banner') as HTMLElement;

beforeAll(async () => {
  setUpdate(U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.4.0', setupVersion: '0.3.0' }));
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      filePath.startsWith('/api/state')
        ? filePath.includes(`version=${state.version}`)
          ? { version: state.version, unchanged: true }
          : state
        : {},
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueUpdate.js', 'board.js'])
    (0, eval)(readFileSync(join(CLIENT, f), 'utf8'));
  await flush();
}, 60_000);

describe('the update banner', () => {
  it('shows the new version, the CHANGELOG link and the copyable steps, as a status region', () => {
    const b = banner();
    expect(b.hidden).toBe(false);
    expect(b.getAttribute('role')).toBe('status');
    expect(b.textContent).toContain('cq 0.4.0 is out (you have 0.3.0).');
    const link = b.querySelector('a') as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/vegardjorg/claude-code-queue/blob/main/CHANGELOG.md');
    expect(link.rel).toContain('noopener');
    const commands = [...b.querySelectorAll('code')].map((c) => c.textContent);
    expect(commands).toEqual(['claude plugin update cq@claude-code-queue', '/reload-plugins', 'cq setup --settings']);
    expect(b.querySelectorAll('.cloud-command button').length).toBe(3);
    expect(b.querySelector('.update-banner-close')?.getAttribute('aria-label')).toBe(
      'Close the notice about cq 0.4.0',
    );
  });

  it('closing hides it for that version, also after a new fetch, until a newer version is out', async () => {
    (banner().querySelector('.update-banner-close') as HTMLButtonElement).click();
    expect(banner().hidden).toBe(true);
    expect(localStorage.getItem(U.DISMISS_KEY)).toBe('0.4.0');
    // A new state with the same version: still hidden.
    setUpdate(U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.4.0', setupVersion: '0.3.0' }));
    await refetch();
    expect(banner().hidden).toBe(true);
    // A newer version: back.
    setUpdate(U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.5.0', setupVersion: '0.3.0' }));
    await refetch();
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('cq 0.5.0 is out');
  });

  it('the setup notice shows without a close button and goes away when setup has been run', async () => {
    setUpdate(U.notice({ mode: 'plugin', installed: '0.5.0', latest: null, setupVersion: '0.3.0' }));
    await refetch();
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('last set up for cq 0.3.0');
    expect([...banner().querySelectorAll('code')].map((c) => c.textContent)).toEqual(['cq setup --settings']);
    expect(banner().querySelector('.update-banner-close')).toBeNull();
    setUpdate(U.notice({ mode: 'plugin', installed: '0.5.0', latest: null, setupVersion: '0.5.0' }));
    await refetch();
    expect(banner().hidden).toBe(true);
  });

  it('works when localStorage throws (the banner shows, closing is just not remembered)', async () => {
    const proto = Object.getPrototypeOf(window.localStorage);
    const get = proto.getItem;
    const set = proto.setItem;
    proto.getItem = () => {
      throw new Error('blocked');
    };
    proto.setItem = () => {
      throw new Error('blocked');
    };
    try {
      setUpdate(U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.6.0', setupVersion: '0.3.0' }));
      await refetch();
      expect(banner().hidden).toBe(false);
      (banner().querySelector('.update-banner-close') as HTMLButtonElement).click();
      // Not remembered, so it stays: no crash.
      expect(banner().hidden).toBe(false);
    } finally {
      proto.getItem = get;
      proto.setItem = set;
    }
  });
});
