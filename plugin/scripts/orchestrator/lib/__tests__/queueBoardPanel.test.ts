/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPanel.test.ts: the detail panel for a ready card in "In queue" shows "Placement" and "Score" as
// real dt/dd pairs, not "[object HTMLElement]" (placementFacts once gave a list of lists, and el() flattens one level).
// The whole board runs in jsdom with a small synthetic queue (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');

/** Two ready tasks in one project, so both get a place ("space") in the queue. */
function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  const task = (id: string, value: number) => ({
    id,
    title: `Task ${id}`,
    domain: 'ui',
    class: 'K',
    value,
    content_min: 90,
    status: 'waiting',
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso,
  });
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [task('EX-1', 8), task('EX-2', 3)],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeAll(async () => {
  const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false } };
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
    // The board polls with its version; "unchanged" for the same version, as the server answers.
    json: async () =>
      filePath.startsWith('/api/state')
        ? filePath.includes(`version=${state.version}`)
          ? { version: state.version, unchanged: true }
          : state
        : {},
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board.js'])
    // Indirect eval: the scripts run in the global scope (as in the browser).
    (0, eval)(readFileSync(join(CLIENT, f), 'utf8'));
  await flush();
}, 60_000);

describe('the detail panel for a ready card', () => {
  it('shows Placement and Score as dt/dd pairs, with no "[object HTMLElement]"', async () => {
    const card = document.querySelector('.summary[data-id="EX-1"]') as HTMLElement;
    expect(card).not.toBeNull();
    (card.querySelector('.summary-button') as HTMLButtonElement).click();
    await flush();
    const panel = document.getElementById('panel') as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).not.toContain('[object');
    const dl = panel.querySelector('dl.facts') as HTMLElement;
    const labels = [...dl.querySelectorAll(':scope > dt')].map((d) => d.textContent);
    expect(labels).toContain('Placement');
    expect(labels).toContain('Score');
    // Every dt is followed by its own dd, so the labels stay by their values.
    for (const dt of dl.querySelectorAll(':scope > dt'))
      expect(dt.nextElementSibling?.tagName).toBe('DD');
    const score = [...dl.querySelectorAll(':scope > dt')].find((d) => d.textContent === 'Score');
    expect(score?.nextElementSibling?.textContent).toMatch(/= value 8/);
  });
});
