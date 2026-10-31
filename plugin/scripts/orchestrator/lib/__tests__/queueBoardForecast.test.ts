/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardForecast.test.ts: the forecast box in the Focus view, the forecast line in Statistics, and the
// "Auto-accept proposals" section in the gear (board.js, plan.js). The server computes the numbers
// (queueForecast.boardForecast, queueProposals.boardData); the board only shows them and posts the rules to
// /api/proposals and an undo to /api/proposals-undo. The whole board runs in jsdom with a mock server (no network).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../queueStatistics.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FC = require('../queueForecast.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PR = require('../queueProposals.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KK = require('../queueConfig.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const DAY = 86_400_000;

function makeQueue() {
  const now = Date.now();
  return {
    created: new Date(now - 30 * DAY).toISOString(),
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    projects: { p1: { title: 'Project one' } },
    areas: {},
    focus: { order: ['project:p1'], name: 'Launch', rest: 'wait' },
    tasks: [
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `D-${i}`,
        title: 'done',
        class: 'K',
        status: 'done',
        project: 'p1',
        started: new Date(now - i * DAY - 3600_000).toISOString(),
        done: new Date(now - i * DAY).toISOString(),
        cost: { usd: 3 },
      })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `W-${i}`, title: 'open', class: 'K', status: 'waiting', project: 'p1', feature: 'f' })),
      { id: 'A-1', title: 'Accepted one', class: 'K', status: 'waiting', project: 'p1', feature: 'f' },
    ],
    question: {},
    resolutions: {},
    changelog: [],
    proposals: { autoAccept: { enabled: true, classes: ['K'], maxEstimateMin: 60, maxValue: null } },
    auto_accepted: [{ id: 'A-1', at: new Date(now - 3600_000).toISOString(), reason: 'class K, estimate 30 min <= 60' }],
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const queue = makeQueue();
const forecast = FC.boardForecast(queue);
const state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false, update: null, forecast } };
const posts: { path: string; body: any }[] = [];

function settingsAnswer() {
  return {
    ok: true,
    field: [],
    usageToday: 0,
    night: { active: false },
    setup: { rules: [], rulesSource: 'docs/orchestration.md' },
    helpers: [],
    autoAccept: PR.boardData(KK.STANDARD.proposals.autoAccept, queue),
  };
}

const panel = () => document.getElementById('panel') as HTMLElement;

beforeAll(async () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      posts.push({ path: filePath, body });
      return { ok: true, status: 200, json: async () => ({ ok: true, message: 'ok', info: [] }) };
    }
    if (filePath.startsWith('/api/settings')) return { ok: true, status: 200, json: async () => settingsAnswer() };
    if (filePath.startsWith('/api/statistics'))
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: 's1', data: { ...S.statistics(queue, []), timeLogError: null, forecast } }),
      };
    if (filePath.startsWith('/api/state'))
      return {
        ok: true,
        status: 200,
        json: async () => (filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state),
      };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueUpdate.js', 'board.js'])
    (0, eval)(readFileSync(join(CLIENT, f), 'utf8'));
  await flush();
}, 60_000);

describe('the forecast on the board', () => {
  it('the server data: 5 open in the focus "Launch" (A-1 too), 12 done in the window, cost 5 x 3 USD', () => {
    expect(forecast.remaining).toBe(5);
    expect(forecast.sample).toBe(12);
    expect(forecast.expectedCost).toBe(15);
    expect(forecast.text).toMatch(/^Focus "Launch": 5 tasks left\. 50 %: by /);
  });

  it('the Focus view has a labelled box with the paragraph', async () => {
    (document.getElementById('show-plan') as HTMLButtonElement).click();
    await flush();
    const box = document.querySelector('.plan-forecast') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.getAttribute('aria-labelledby')).toBe('plan-forecast-title');
    expect(document.getElementById('plan-forecast-title')?.textContent).toBe('Forecast');
    expect(box.querySelector('.plan-forecast-text')?.textContent).toBe(forecast.text);
    expect(box.querySelector('.plan-forecast-how')?.textContent).toMatch(/Monte Carlo: 2000 runs/);
  });

  it('Statistics has the same paragraph as a line', async () => {
    (document.getElementById('show-statistics') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('.stat-forecast')?.textContent).toBe(`Forecast: ${forecast.text}`);
  });
});

describe('Auto-accept proposals in the gear', () => {
  it('has the labelled switch, the class boxes, the number fields and the log with Undo', async () => {
    (document.getElementById('settings') as HTMLButtonElement).click();
    await flush();
    const section = panel().querySelector('.auto-accept') as HTMLElement;
    expect(section.querySelector('h3')?.textContent).toBe('Auto-accept proposals');
    const sw = document.getElementById('aa-enabled') as HTMLInputElement;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.checked).toBe(true);
    expect(panel().querySelector('label[for="aa-enabled"]')?.textContent).toBe('Auto-accept proposals');
    expect((document.getElementById('aa-class-K') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('aa-class-U') as HTMLInputElement).checked).toBe(false);
    expect(document.getElementById('aa-class-D')).toBeNull(); // D and D+ are never a choice
    expect((document.getElementById('aa-max-estimate') as HTMLInputElement).value).toBe('60');
    expect((document.getElementById('aa-max-value') as HTMLInputElement).value).toBe('');
    expect(panel().querySelector('label[for="aa-max-value"]')).not.toBeNull();
    const rows = [...section.querySelectorAll('.aa-row')] as HTMLElement[];
    expect(rows.map((r) => r.dataset.id)).toEqual(['A-1']);
    expect(rows[0].textContent).toContain('A-1 Accepted one: class K, estimate 30 min <= 60');
  });

  it('Save posts the whole rule set to /api/proposals (empty = no cap)', async () => {
    (document.getElementById('aa-class-U') as HTMLInputElement).checked = true;
    (document.getElementById('aa-max-estimate') as HTMLInputElement).value = '90';
    (document.getElementById('aa-enabled') as HTMLInputElement).checked = false;
    (document.getElementById('aa-save') as HTMLButtonElement).click();
    await flush();
    expect(posts.at(-1)).toEqual({
      path: '/api/proposals',
      body: { enabled: false, classes: ['K', 'U'], maxEstimateMin: 90, maxValue: null },
    });
  });

  it('Undo posts the id to /api/proposals-undo', async () => {
    const undo = panel().querySelector('.aa-row button') as HTMLButtonElement;
    expect(undo.getAttribute('aria-label')).toBe('Undo the auto-accept of A-1');
    undo.click();
    await flush();
    expect(posts.at(-1)).toEqual({ path: '/api/proposals-undo', body: { id: 'A-1' } });
  });
});
