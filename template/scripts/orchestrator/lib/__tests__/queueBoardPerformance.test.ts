/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPerformance.test.ts: queueBoard does not redraw the whole board on search, marking and a new version.
//
// Two parts:
//   1. The pure functions in scripts/orchestrator/queue-board/performance.js: the diff (old and new list give the operations
//      reuse, build and remove), the card buffer that uses it, the keyboard navigation between cards and columns, and
//      the choice of compression for responses from the server.
//   2. The whole board in jsdom with a synthetic queue of 1 150 tasks (made here, no real data in the repo): the search hides
//      cards without building them again, a marking and a new version reuse the nodes of the cards that are not changed,
//      Blocked is closed and not built until it opens, and the card has one button (the title) instead of tabindex and
//      aria-label on the whole card. The times are written out with performance.now() (the numbers go to the console).
//
// Measuring another version of the board (e.g. the one before a change): set QUEUE_BOARD_JS to the path of that board.js file. Then
// the times are written out, and the behavior tests say what that version is missing.
// =============================================================
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Y = require('../../queue-board/performance.js') as {
  plan: (
    oldOnes: Map<string, string>,
    newOnes: Iterable<[string, string]>,
  ) => { reuse: string[]; build: string[]; remove: string[] };
  makeSummaryBuffer: () => {
    start: () => void;
    node: <N>(key: string, signature: string, build: () => N) => N;
    end: () => { reused: number; built: number; removed: number };
    size: () => number;
  };
  rovingMeasure: (
    count: number[],
    o: number,
    i: number,
    keyPress: string,
  ) => { o: number; i: number } | null;
  selectEncoding: (acceptEncoding: string | undefined, bytes: number) => 'br' | 'gzip' | null;
  COMPRESS_FROM: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');

// The time limit for every test and hook in the file. Alone the file runs in a few seconds, but in a full test run with
// parallel tracks beforeAll can take more than the default limit of 5 000 ms. The times here are only logged, not asserted, so a roomier limit weakens
// no performance requirement: the behavior tests (reuse of nodes, no rebuilding) are what guard the performance.
const TIME_LIMIT_MS = 60_000;
vi.setConfig({ testTimeout: TIME_LIMIT_MS });

// ---------------------------------------------------------------------------------------------------------------
// 1. The pure functions
// ---------------------------------------------------------------------------------------------------------------
describe('plan (the diff)', () => {
  it('reuses unchanged ones, builds changed and new ones, and removes those that are gone', () => {
    const oldOnes = new Map([
      ['a', '1'],
      ['b', '1'],
      ['c', '1'],
    ]);
    const ops = Y.plan(oldOnes, [
      ['a', '1'],
      ['b', '2'],
      ['d', '1'],
    ]);
    expect(ops).toEqual({ reuse: ['a'], build: ['b', 'd'], remove: ['c'] });
  });

  it('builds a key that appears twice in the new list again (one node can only sit in one place)', () => {
    const ops = Y.plan(new Map([['a', '1']]), [
      ['a', '1'],
      ['a', '1'],
    ]);
    expect(ops).toEqual({ reuse: ['a'], build: ['a'], remove: [] });
  });

  it('an empty old list builds everything, an empty new list removes everything', () => {
    expect(Y.plan(new Map(), [['x', 's']])).toEqual({ reuse: [], build: ['x'], remove: [] });
    expect(Y.plan(new Map([['x', 's']]), [])).toEqual({ reuse: [], build: [], remove: ['x'] });
  });
});

describe('makeSummaryBuffer', () => {
  it('gives the same node for the same key and signature, a new node when the signature changes, and clears unused ones', () => {
    const b = Y.makeSummaryBuffer();
    let n = 0;
    const make = () => ({ nr: ++n });
    b.start();
    const a1 = b.node('a', 's1', make);
    const c1 = b.node('c', 's1', make);
    expect(b.end()).toEqual({ reused: 0, built: 2, removed: 0 });

    b.start();
    expect(b.node('a', 's1', make)).toBe(a1);
    const a2 = b.node('a', 's1', make); // same key twice in one round: new node
    expect(a2).not.toBe(a1);
    expect(b.end()).toEqual({ reused: 1, built: 1, removed: 1 }); // c is gone
    expect(b.size()).toBe(1);

    b.start();
    expect(b.node('a', 's2', make)).not.toBe(a1);
    expect(b.node('c', 's1', make)).not.toBe(c1);
    b.end();
  });
});

describe('rovingMeasure (the keyboard between cards and columns)', () => {
  const count = [3, 0, 5, 1];
  it('arrow up and down move within the column and stop at the ends', () => {
    expect(Y.rovingMeasure(count, 0, 0, 'ArrowDown')).toEqual({ o: 0, i: 1 });
    expect(Y.rovingMeasure(count, 0, 2, 'ArrowDown')).toBeNull();
    expect(Y.rovingMeasure(count, 0, 0, 'ArrowUp')).toBeNull();
    expect(Y.rovingMeasure(count, 2, 4, 'ArrowUp')).toEqual({ o: 2, i: 3 });
  });
  it('arrow left and right skip empty columns and keep the position (clamped to the length)', () => {
    expect(Y.rovingMeasure(count, 0, 2, 'ArrowRight')).toEqual({ o: 2, i: 2 });
    expect(Y.rovingMeasure(count, 2, 4, 'ArrowRight')).toEqual({ o: 3, i: 0 });
    expect(Y.rovingMeasure(count, 3, 0, 'ArrowRight')).toBeNull();
    expect(Y.rovingMeasure(count, 2, 4, 'ArrowLeft')).toEqual({ o: 0, i: 2 });
    expect(Y.rovingMeasure(count, 0, 1, 'ArrowLeft')).toBeNull();
  });
  it('Home and End go to the first and last card in the column; other keys give null', () => {
    expect(Y.rovingMeasure(count, 2, 2, 'Home')).toEqual({ o: 2, i: 0 });
    expect(Y.rovingMeasure(count, 2, 2, 'End')).toEqual({ o: 2, i: 4 });
    expect(Y.rovingMeasure(count, 2, 2, 'a')).toBeNull();
    expect(Y.rovingMeasure(count, 1, 0, 'ArrowDown')).toBeNull(); // empty column
  });
});

describe('selectEncoding (compression in send)', () => {
  const large = Y.COMPRESS_FROM + 1;
  it('compresses only responses over the limit, and only when the client says it supports it', () => {
    expect(Y.COMPRESS_FROM).toBe(50 * 1024);
    expect(Y.selectEncoding('gzip, deflate, br', 1000)).toBeNull();
    expect(Y.selectEncoding(undefined, large)).toBeNull();
    expect(Y.selectEncoding('', large)).toBeNull();
    expect(Y.selectEncoding('identity', large)).toBeNull();
  });
  it('prefers brotli, takes gzip otherwise, and respects q=0', () => {
    expect(Y.selectEncoding('gzip, deflate, br', large)).toBe('br');
    expect(Y.selectEncoding('gzip, deflate', large)).toBe('gzip');
    expect(Y.selectEncoding('GZIP', large)).toBe('gzip');
    expect(Y.selectEncoding('br;q=0, gzip;q=0.5', large)).toBe('gzip');
    expect(Y.selectEncoding('gzip;q=0', large)).toBeNull();
    expect(Y.selectEncoding('*', large)).toBe('gzip');
    expect(Y.selectEncoding('*;q=0', large)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The whole board in jsdom with a synthetic queue
// ---------------------------------------------------------------------------------------------------------------

/** A synthetic queue.json with 1 150 tasks in 60 projects (no real data). */
function makeQueue() {
  const now = Date.now();
  const iso = (daysSince: number) => new Date(now - daysSince * 86_400_000).toISOString();
  const projects: Record<string, unknown> = {};
  for (let p = 0; p < 60; p++)
    projects[`p${p}`] = { title: `Project ${p}`, prefixes: [`P${p}-`], area: 'example' };
  const tasks: Record<string, unknown>[] = [];
  const common = (id: string, i: number) => ({
    id,
    title: `Task ${id} about theme ${i % 37}`,
    domain: `d${i % 9}`,
    class: ['K', 'D', 'D+', 'U'][i % 4],
    value: (i % 10) + 1,
    content_min: 20 + (i % 90),
    migr_tens: i % 3,
    depends_on: [] as string[],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso(30 - (i % 30)),
  });
  let n = 0;
  const id = () => `P${n % 60}-${n}`;
  // 460 in the queue: every other one depends on another one that is waiting (blocked).
  const pending: string[] = [];
  for (let i = 0; i < 460; i++, n++) {
    const o = { ...common(id(), n), status: 'waiting' };
    if (i % 2 && pending.length) o.depends_on = [pending[pending.length - 1]];
    pending.push(o.id);
    tasks.push(o);
  }
  for (let i = 0; i < 90; i++, n++) tasks.push({ ...common(id(), n), status: 'proposed' });
  for (let i = 0; i < 5; i++, n++)
    tasks.push({ ...common(id(), n), status: 'running', started: iso(0.1), agent: 'a' });
  for (let i = 0; i < 595; i++, n++)
    tasks.push({
      ...common(id(), n),
      status: 'done',
      started: iso((i % 40) + 1),
      done: iso(i % 40),
    });
  return {
    created: iso(60),
    limits: { maxConcurrent: 6, maxDPlus: 3, maxPerDomain: 7, maxDb: 6 },
    tasks,
    projects,
    areas: { example: { title: 'Example', description: 'Test' } },
    question: [],
    resolutions: [],
    changelog: [],
  };
}

type State = { version: string; data: any };
let state: State;
const waitingSearch: (() => void)[] = [];
const times: Record<string, number> = {};
let main: HTMLElement;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const summaryNode = (summaryId: string) =>
  main.querySelector(`.summary[data-id="${summaryId}"]`) as HTMLElement | null;

beforeAll(async () => {
  const queue = makeQueue();
  state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false } };
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
  const realTimeout = w.setTimeout.bind(w);
  // The search waits 150 ms; the test runs the callback itself, so the time is measured without the wait.
  w.setTimeout = (fn: () => void, ms?: number) => {
    if (ms === 150) {
      waitingSearch.push(fn);
      return 0;
    }
    return realTimeout(fn, ms);
  };
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
  const files = [
    join(CLIENT, 'a11y.js'),
    join(CLIENT, '..', 'lib', 'queueGraph.js'),
    join(CLIENT, 'graph.js'),
    join(CLIENT, 'plan.js'),
  ];
  // performance.js is newer than the first versions; an older board.js (QUEUE_BOARD_JS) does not need it.
  if (!process.env.QUEUE_BOARD_JS) files.push(join(CLIENT, 'performance.js'));
  files.push(process.env.QUEUE_BOARD_JS ?? join(CLIENT, 'board.js'));
  const t0 = performance.now();
  for (const f of files) {
    // Indirect eval: the scripts run in the global scope (as in the browser), where `module` does not exist.
    (0, eval)(readFileSync(f, 'utf8'));
  }
  await flush();
  times.first = performance.now() - t0;
  main = document.getElementById('board') as HTMLElement;
  // The first drawing of 1 150 cards in jsdom often takes more than the default limit of 5 s (especially under load).
  // The times are only logged, not asserted, so a roomier limit does not make the test weaker.
}, TIME_LIMIT_MS);

describe('the board with 1 150 tasks', () => {
  it('draws the columns, with Blocked closed and not built until it opens', () => {
    expect(main.querySelectorAll('.column').length).toBe(4);
    const blocked = main.querySelector('details[data-section="blocked"]') as HTMLDetailsElement;
    expect(blocked).not.toBeNull();
    expect(blocked.open).toBe(false);
    expect(blocked.querySelectorAll('.summary').length).toBe(0);
    blocked.open = true;
    blocked.dispatchEvent(new Event('toggle'));
    expect(blocked.querySelectorAll('.summary').length).toBeGreaterThan(100);
    blocked.open = false;
    blocked.dispatchEvent(new Event('toggle'));
  });

  it('the card has no tabindex or aria-label; the title is a button with aria-describedby to the metadata', () => {
    const li = main.querySelector('.summary') as HTMLElement;
    expect(li.hasAttribute('tabindex')).toBe(false);
    expect(li.hasAttribute('aria-label')).toBe(false);
    const button = li.querySelector('button.summary-button') as HTMLButtonElement;
    expect(button).not.toBeNull();
    for (const ref of (button.getAttribute('aria-describedby') ?? '').split(' '))
      expect(document.getElementById(ref)).not.toBeNull();
    // The checkbox sits outside the button.
    expect(button.querySelector('input')).toBeNull();
  });

  it('roving tabindex: one tab stop per column, and the arrow keys move between cards and columns', () => {
    for (const body of main.querySelectorAll('.col-body')) {
      const stop = [...body.querySelectorAll('.summary-button')].filter(
        (b) => (b as HTMLElement).tabIndex === 0,
      );
      expect(stop.length).toBeLessThanOrEqual(1);
    }
    const colQueue = main.querySelector('.col-body[data-scroll="queue"]') as HTMLElement;
    const first = colQueue.querySelector('.summary-button[tabindex="0"]') as HTMLButtonElement;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const next = document.activeElement as HTMLElement;
    expect(next).not.toBe(first);
    expect(next.classList.contains('summary-button')).toBe(true);
    expect(next.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
    next.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const right = document.activeElement as HTMLElement;
    expect(right.closest('.col-body')?.getAttribute('data-scroll')).toBe('inProgress');
  });

  it('the search hides cards with hidden without building them again', () => {
    const forMatch = summaryNode('P4-4') as HTMLElement;
    const forOther = summaryNode('P2-2') as HTMLElement;
    expect(forMatch).not.toBeNull();
    const search = document.getElementById('search') as HTMLInputElement;
    search.value = 'p4-4';
    search.dispatchEvent(new Event('input'));
    const t0 = performance.now();
    waitingSearch.splice(0).forEach((f) => f());
    times.search = performance.now() - t0;
    expect(summaryNode('P4-4')).toBe(forMatch);
    expect(forMatch.hidden).toBe(false);
    expect(summaryNode('P2-2')).toBe(forOther);
    expect(forOther.hidden).toBe(true);
    search.value = '';
    search.dispatchEvent(new Event('input'));
    const t1 = performance.now();
    waitingSearch.splice(0).forEach((f) => f());
    times.searchEmpty = performance.now() - t1;
    expect(forOther.hidden).toBe(false);
  });

  it('marking updates the card where it is, without rebuilding', () => {
    const li = summaryNode('P4-4') as HTMLElement;
    const others = summaryNode('P2-2') as HTMLElement;
    const box = li.querySelector('.mark-box input') as HTMLInputElement;
    const t0 = performance.now();
    box.click();
    times.mark = performance.now() - t0;
    expect(summaryNode('P4-4')).toBe(li);
    expect(li.classList.contains('marked')).toBe(true);
    expect(summaryNode('P2-2')).toBe(others);
    box.click();
    expect(li.classList.contains('marked')).toBe(false);
  });

  it('a new version from the server builds only the cards that changed', async () => {
    const unchanged = summaryNode('P2-2') as HTMLElement;
    const changed = summaryNode('P4-4') as HTMLElement;
    const data = JSON.parse(JSON.stringify(state.data));
    for (const list of Object.values(data.columns) as any[])
      for (const k of list) if (k.id === 'P4-4') k.title = 'New title';
    state = { version: 'v2', data };
    const t0 = performance.now();
    window.dispatchEvent(new Event('focus'));
    await flush();
    times.newVersion = performance.now() - t0;
    expect(summaryNode('P2-2')).toBe(unchanged);
    expect(summaryNode('P4-4')).not.toBe(changed);
    expect(summaryNode('P4-4')?.textContent).toContain('New title');
  });

  it('measures search, marking and new version (median of five) with the same state for both versions', async () => {
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const search = document.getElementById('search') as HTMLInputElement;
    const searchAfter = (text: string) => {
      search.value = text;
      search.dispatchEvent(new Event('input'));
      const t0 = performance.now();
      waitingSearch.splice(0).forEach((f) => f());
      return performance.now() - t0;
    };
    const s: number[] = [];
    const m: number[] = [];
    const v: number[] = [];
    for (let round = 0; round < 5; round++) {
      s.push(searchAfter(`theme ${round + 3}`));
      s.push(searchAfter(''));
      const box = summaryNode('P2-2')?.querySelector('.mark-box input') as HTMLInputElement;
      const t0 = performance.now();
      box.click();
      m.push(performance.now() - t0);
      (summaryNode('P2-2')?.querySelector('.mark-box input') as HTMLInputElement).click();
      const data = JSON.parse(JSON.stringify(state.data));
      for (const list of Object.values(data.columns) as any[])
        for (const k of list) if (k.id === 'P2-2') k.title = `Title ${round}`;
      state = { version: `m${round}`, data };
      const t1 = performance.now();
      window.dispatchEvent(new Event('focus'));
      await flush();
      v.push(performance.now() - t1);
    }
    times.searchMedian = median(s);
    times.markMedian = median(m);
    times.newVersionMedian = median(v);
    expect(s.length).toBe(10);
    // The time limit comes from vi.setConfig({ testTimeout: TIME_LIMIT_MS }) at the top of the file.
  });

  it('writes the times (performance.now) to the log', () => {
    // The numbers are for the report, not a limit: the machine and jsdom decide the level.

    console.log(
      `Performance measurement (${process.env.QUEUE_BOARD_JS ? 'another board.js' : 'this'}): ` +
        Object.entries(times)
          .map(([k, v]) => `${k}=${v.toFixed(1)}ms`)
          .join(' '),
    );
    expect(Object.keys(times).length).toBeGreaterThan(0);
  });
});
