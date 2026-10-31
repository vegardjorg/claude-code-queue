/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardSilent.test.ts: the "silent" badge on a running card and the "Blockers last 7 days" table in Statistics.
//
// The server measures SILENT (queueLogic.silentTracks, cached) and passes the list to queueBoard.board; the blocker
// table comes from queueLogic.blockerSummary in /api/statistics. Here: the card summary gets `silent`, and the whole
// board runs in jsdom with a small synthetic queue (no real data) and shows the badge and the table.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const S = require('../queueStatistics.js') as { statistics: (queue: unknown, rows: unknown[]) => any };
const L = require('../queueLogic.js') as { blockerSummary: (queue: unknown, option?: unknown) => unknown[] };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const hourAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function makeQueue() {
  const task = (id: string, extra: Record<string, unknown>) => ({
    id,
    title: `Task ${id}`,
    domain: `dom-${id}`,
    class: 'K',
    value: 5,
    content_min: 90,
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    added_by: 'test',
    added_at: hourAgo(48),
    ...extra,
  });
  return {
    created: hourAgo(48),
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('EX-1', { status: 'running', branch: 'queue/EX-1', started: hourAgo(2) }),
      task('EX-2', { status: 'running', branch: 'queue/EX-2', started: hourAgo(2) }),
      task('EX-3', {
        status: 'waiting',
        blocks: [
          { code: 'gate-red', from: hourAgo(5), to: hourAgo(3) },
          { code: 'context', from: hourAgo(1) },
        ],
      }),
    ],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}
const SILENT = [{ id: 'EX-1', branch: 'queue/EX-1', last_activity: hourAgo(0.5), silent_ms: 30 * 60_000 }];

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('the card summary', () => {
  it('a silent track gets silent with minutes; the others get null', () => {
    const b = T.board(makeQueue(), { silent: SILENT });
    const cards = b.columns.inProgress as { id: string; silent: unknown }[];
    expect(cards.find((k) => k.id === 'EX-1')?.silent).toEqual({ minutes: 30, last_activity: SILENT[0].last_activity });
    expect(cards.find((k) => k.id === 'EX-2')?.silent).toBeNull();
    // Without the option (older callers) nothing is marked.
    expect((T.board(makeQueue()).columns.inProgress as { silent: unknown }[]).every((k) => k.silent === null)).toBe(true);
  });
});

describe('the board in jsdom', () => {
  beforeAll(async () => {
    const queue = makeQueue();
    const state = { version: 'v1', data: { ...T.board(queue, { silent: SILENT }), gitError: null, logo: false } };
    const stat = {
      version: 's1',
      data: { ...S.statistics(queue, []), blockers: L.blockerSummary(queue, { days: 7 }), timeLogError: null },
    };
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
          : filePath.startsWith('/api/statistics')
            ? filePath.includes(`version=${stat.version}`)
              ? { version: stat.version, unchanged: true }
              : stat
            : {},
    });
    for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board.js'])
      (0, eval)(readFileSync(join(CLIENT, f), 'utf8'));
    await flush();
  }, 60_000);

  it('shows the silent badge on the silent card only, with the advice as text', () => {
    const silentCard = document.querySelector('.summary[data-id="EX-1"]') as HTMLElement;
    const otherCard = document.querySelector('.summary[data-id="EX-2"]') as HTMLElement;
    expect(silentCard).not.toBeNull();
    const badge = silentCard.querySelector('.silent-badge') as HTMLElement;
    expect(badge?.textContent).toBe('silent');
    expect(badge.getAttribute('title')).toContain('cq resume EX-1 --reason context');
    // Keyboard and screen reader users get the same text (not only the tooltip).
    expect(silentCard.textContent).toContain('Silent for 30 min');
    expect(otherCard.querySelector('.silent-badge')).toBeNull();
  });

  it('the Statistics view has the table "Blockers last 7 days", top first', async () => {
    (document.getElementById('show-statistics') as HTMLButtonElement).click();
    await flush();
    const section = document.querySelector('.blocker-stat') as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.querySelector('h3')?.textContent).toBe('Blockers last 7 days');
    const rows = [...section.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.children].map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ['gate-red', '1', '2 h 0 min'],
      ['context', '1 (1 open)', '1 h 0 min'],
    ]);
    expect([...section.querySelectorAll('thead th')].map((th) => th.getAttribute('scope'))).toEqual([
      'col',
      'col',
      'col',
    ]);
  });
});
