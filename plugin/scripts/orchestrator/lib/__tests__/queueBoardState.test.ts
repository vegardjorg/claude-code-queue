// =============================================================
// queueBoardState.test.ts: the state for the whole queue (queueBoard.board, behind GET /api/state) is built in linear
// time.
//
// blockerParts, successors and score built the id map, the active ones and childrenMap for the WHOLE queue again for
// every card, so board(queue) was quadratic (3 000 tasks: close to a minute in node). Now the lookups are built once
// per board (queueLogic.withIndex), and the conflicts per card are buffered (conflictsWithActive). The tests prove that:
//   - a synthetic queue of 3 000 tasks (no real data) gives the board in under 2 s (before the change: about 59 s in
//     node; after: about 0.2 s). The fastest of two runs counts, so a random GC pause or a busy machine does not turn
//     the test red, while a quadratic board is still far above,
//   - successors and blockerParts give exactly the same with and without the index,
//   - the index applies only inside withIndex and only for the same list, so a changed queue afterwards never sees a
//     stale lookup.
//
// The time limit is measured in its own node process (plain require), the way queue-board.mjs runs the board, not
// inside the test runner's module context: there, global lookups can be many times slower, so the number would
// measure the test environment and the machine load, not the board. That the process gives exactly the same as the
// board inside the test runner is asserted below, so the measurement applies to the code under test.
// =============================================================
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const B = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic.js') as {
  withIndex: <R>(tasks: unknown[], fn: () => R) => R;
  successors: (id: string, tasks: unknown[], children?: Map<string, string[]>) => string[];
  blockerParts: (o: unknown, tasks: unknown[], resolved?: string[]) => { text: string }[];
  childrenMap: (tasks: unknown[]) => Map<string, string[]>;
};

/**
 * Runs board(queue) `times` times in its own node process (the queue is sent on stdin as JSON) and gives the fastest
 * time and the answer from the last run. No real data: only the synthetic queue from makeQueue.
 */
function boardInNode(queue: { now: number }, times: number): { ms: number; out: any } {
  const code = [
    'const B = require(process.argv[1]);',
    "const queue = JSON.parse(require('fs').readFileSync(0, 'utf8'));",
    'let ms = Infinity, out = null;',
    `for (let i = 0; i < ${times}; i++) {`,
    '  const t0 = performance.now();',
    '  out = B.board(queue, { now: queue.now });',
    '  ms = Math.min(ms, performance.now() - t0);',
    '}',
    'process.stdout.write(JSON.stringify({ ms, out }));',
  ].join('\n');
  const answer = execFileSync(process.execPath, ['-e', code, join(__dirname, '..', 'queueBoard.js')], {
    input: JSON.stringify(queue),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(answer);
}

type Task = Record<string, unknown> & { id: string; status: string; depends_on: string[] };

/** A synthetic queue.json with `count` tasks: chains of dependencies, active ones with owned files and many done. */
function makeQueue(count: number) {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const iso = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const projects: Record<string, unknown> = {};
  for (let p = 0; p < 40; p++) projects[`p${p}`] = { title: `P ${p}`, prefixes: [`P${p}-`] };
  const tasks: Task[] = [];
  const status = (i: number) => {
    const r = i / count;
    if (r < 0.4) return 'waiting';
    if (r < 0.5) return 'proposed';
    if (r < 0.505) return 'running';
    if (r < 0.51) return 'picked';
    if (r < 0.515) return 'review';
    return 'done';
  };
  for (let i = 0; i < count; i++) {
    const s = status(i);
    tasks.push({
      id: `P${i % 40}-${i}`,
      title: `Task ${i}`,
      domain: `d${i % 7}`,
      class: ['K', 'D', 'D+', 'U'][i % 4],
      status: s,
      value: (i % 10) + 1,
      content_min: 20 + (i % 60),
      // Chains of 25: each task (except the first in the chain) waits on the previous one, so "unlocks N" gets long.
      depends_on: i % 25 && i > 0 ? [tasks[i - 1].id] : [],
      waiting_on: [],
      owned_files: [`file/${i % 300}.ts`],
      owner_db: [],
      shared_patch: [],
      added_by: 'test',
      added_at: iso(i % 20),
      ...(s === 'running' || s === 'picked' ? { started: iso(0.1), picked_by: 'a' } : {}),
      ...(s === 'review' ? { started: iso(1), delivered: iso(0.5) } : {}),
      ...(s === 'done' ? { started: iso(3), delivered: iso(2), done: iso(1) } : {}),
    });
  }
  return { tasks, projects, resolved: [], limits: {}, now };
}

describe('board(queue) with the whole queue', () => {
  it('3 000 tasks give the state in under 2 s', { timeout: 30_000 }, () => {
    const queue = makeQueue(3000);
    const { ms, out } = boardInNode(queue, 2);
    console.log(`queueBoardState: board(3 000 tasks) ${Math.round(ms)} ms`);
    expect(out.columns.queue.length).toBe(1200);
    expect(ms).toBeLessThan(2000);
  });

  it('the board in the node process gives exactly the same as inside the test runner', () => {
    const queue = makeQueue(300);
    const { out } = boardInNode(queue, 1);
    // The JSON round makes the answer inside the test runner comparable with what came over stdout.
    expect(out).toEqual(JSON.parse(JSON.stringify(B.board(queue, { now: queue.now }))));
    expect(out.columns.queue.length).toBe(120);
  });
});

describe('withIndex', () => {
  it('successors and blockerParts give the same with and without the index', () => {
    const t = makeQueue(600).tasks;
    const without = t.map((x) => [L.successors(x.id, t), L.blockerParts(x, t, [])]);
    const withIx = L.withIndex(t, () => t.map((x) => [L.successors(x.id, t), L.blockerParts(x, t, [])]));
    expect(withIx).toEqual(without);
    // The chain: the first in a chain of waiting ones unlocks the next 24.
    expect(without[0][0]).toHaveLength(24);
    // The active ones own files, so some waiting tasks have conflicts (the buffer is exercised).
    expect(without.some(([, b]) => (b as { type: string }[]).some((h) => h.type === 'conflict'))).toBe(true);
  });

  it('a caller that sorts the list from successors does not change the next answer', () => {
    const t = makeQueue(100).tasks;
    L.withIndex(t, () => {
      const a = L.successors(t[0].id, t);
      a.reverse().push('X');
      expect(L.successors(t[0].id, t)).toEqual(L.successors(t[0].id, [...t]));
    });
  });

  it('a caller that changes a conflict does not change the buffered one', () => {
    const t = makeQueue(600).tasks;
    L.withIndex(t, () => {
      const card = t.find((x) =>
        L.blockerParts(x, t, []).some((h) => (h as { type: string }).type === 'conflict'),
      )!;
      const first = L.blockerParts(card, t, []) as { type: string; conflict?: { text: string } }[];
      const k = first.find((h) => h.type === 'conflict')!;
      k.conflict!.text = 'changed';
      const again = L.blockerParts(card, t, []) as { type: string; conflict?: { text: string } }[];
      expect(again.find((h) => h.type === 'conflict')!.conflict!.text).not.toBe('changed');
    });
  });

  it('applies only inside withIndex and only for the same list', () => {
    const t = makeQueue(100).tasks;
    const fresh = (id: string, depends_on: string[]): Task => ({ id, status: 'waiting', depends_on });
    L.withIndex(t, () => {
      const map = L.childrenMap(t);
      expect(L.childrenMap(t)).toBe(map); // the same lookup is reused
      const other = [...t, fresh('Z-1', [t[0].id])];
      expect(L.childrenMap(other)).not.toBe(map); // another list builds its own
      expect(L.successors(t[0].id, other)).toContain('Z-1');
    });
    // After withIndex: a change to the list is seen at once.
    const before = L.successors(t[0].id, t).length;
    t.push(fresh('Z-2', [t[0].id]));
    expect(L.successors(t[0].id, t)).toHaveLength(before + 1);
  });

  it('cleans up when fn throws', () => {
    const t = makeQueue(50).tasks;
    expect(() =>
      L.withIndex(t, () => {
        throw new Error('fail');
      }),
    ).toThrow('fail');
    const map = L.childrenMap(t);
    expect(L.childrenMap(t)).not.toBe(map); // no index left
  });
});
