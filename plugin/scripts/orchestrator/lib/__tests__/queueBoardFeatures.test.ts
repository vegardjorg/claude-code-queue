/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardFeatures.test.ts: the module switches and the first-run card on the board.
//   - With the default features (cloud off) the Cloud tab is hidden, the "Suitable for cloud" filter is gone, and the
//     gear's "Modules" section lists each module as On or Off with the config key.
//   - With focus and statistics off their tabs are hidden too, and Plans off hides the Plans button.
//   - A queue with nothing open shows the onboarding card (three steps and a link to the help) instead of empty columns.
// The whole board runs in jsdom with a small synthetic queue (no real data); the state is swapped and fetched again
// through the window's focus event, as in the browser.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as {
  STANDARD: Record<string, unknown>;
  merge: (a: unknown, b: unknown) => Record<string, unknown>;
  features: (cfg?: unknown) => Record<string, boolean>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const iso = new Date(Date.now() - 86_400_000).toISOString();

function makeQueue(statuses: string[]) {
  const task = (id: string, status: string) => ({
    id,
    title: `Task ${id}`,
    domain: 'ui',
    class: 'K',
    value: 5,
    content_min: 90,
    status,
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso,
    ...(status === 'done' ? { done: iso } : {}),
  });
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: statuses.map((s, i) => task(`EX-${i + 1}`, s)),
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

/** The state the server sends: the board data plus the resolved features (as queue-board.mjs does). */
const stateFor = (version: string, statuses: string[], own: object = {}) => ({
  version,
  data: {
    ...T.board(makeQueue(statuses)),
    gitError: null,
    logo: false,
    features: KK.features(KK.merge(KK.STANDARD, own)),
  },
});

let state = stateFor('v1', ['waiting', 'waiting']);

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
/** A new state from the "server": the board fetches again on the window's focus event. */
async function serve(next: typeof state) {
  state = next;
  window.dispatchEvent(new Event('focus'));
  await flush();
}

beforeAll(async () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<\/?html[^>]*>/g, '');
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
        : filePath.startsWith('/api/settings')
          ? { ok: false, message: 'not in this test' }
          : {},
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board.js'])
    // Indirect eval: the scripts run in the global scope (as in the browser).
    (0, eval)(readFileSync(join(CLIENT, f), 'utf8'));
  await flush();
}, 60_000);

const $ = (id: string) => document.getElementById(id) as HTMLElement;

describe('the module switches on the board', () => {
  it('hides the Cloud tab by default and keeps Focus, Statistics and the Plans button', () => {
    expect($('show-cloud').hidden).toBe(true);
    expect($('show-plan').hidden).toBe(false);
    expect($('show-statistics').hidden).toBe(false);
    expect($('room-plans').hidden).toBe(false);
    expect((window as any).QueueFeatures.on('cloud')).toBe(false);
  });

  it('has no "Suitable for cloud" filter while cloud is off', () => {
    $('filter-button').click();
    expect(document.body.textContent).not.toContain('Suitable for cloud');
    expect(document.body.textContent).toContain('Only ready now');
    $('filter-button').click();
  });

  it('shows the Cloud tab when features.cloud is true, and hides Focus, Statistics and Plans when they are off', async () => {
    await serve(stateFor('v2', ['waiting'], { features: { cloud: true } }));
    expect($('show-cloud').hidden).toBe(false);
    await serve(stateFor('v3', ['waiting'], { features: { focus: false, statistics: false, plans: false } }));
    expect($('show-cloud').hidden).toBe(true);
    expect($('show-plan').hidden).toBe(true);
    expect($('show-statistics').hidden).toBe(true);
    expect($('room-plans').hidden).toBe(true);
  });

  it('shows the cards (not the onboarding card) while tasks are open', async () => {
    await serve(stateFor('v4', ['waiting', 'done']));
    expect(document.querySelector('.onboarding')).toBeNull();
    expect(document.querySelector('.summary[data-id="EX-1"]')).not.toBeNull();
  });

  it('shows the onboarding card when nothing is open (only done and cancelled tasks)', async () => {
    await serve(stateFor('v5', ['done', 'cancelled']));
    const card = document.querySelector('.onboarding') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelectorAll('ol.onboarding-steps > li')).toHaveLength(3);
    expect(card.textContent).toContain('add to the queue');
    expect(card.textContent).toContain('cq add --file');
    expect(card.textContent).toContain('/cq:queue');
    expect(card.textContent).toContain('Waiting on you');
    expect(document.querySelectorAll('section.column')).toHaveLength(0);
    // The link opens the help in the panel.
    const help = [...card.querySelectorAll('button')].find((b) => /How to use the board/.test(b.textContent ?? ''));
    expect(help).toBeDefined();
    help!.click();
    await flush();
    expect($('panel').hidden).toBe(false);
    expect($('panel-title').textContent).toBe('How to use the board');
  });
});
