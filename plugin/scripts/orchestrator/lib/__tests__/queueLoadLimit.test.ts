// =============================================================
// queueLoadLimit.test.ts: the load guard in the work queue (lib/queueLogic.js + queue.mjs).
//
// When many tracks run at once, gates can go red from lack of memory and timeouts, not from code errors. With
// `limits.minFreeMemoryPct` (or loadGuard.minFreeMemoryPct in queue.config.json) set, `next`, `start` and `fill` refuse
// new starts (exit 7) while free memory is below the limit. `show` shows the reason. `start --force` and
// `fill --over-load` override. Default: off (null), so nothing changes without the owner's yes.
// The tests lock the rules where they are enforced: the pure functions in queueLogic, and queue.mjs against a copy of
// the queue in a temporary folder (QUEUE_FOLDER) with the measurement replaced by QUEUE_LOAD.
// =============================================================
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Task = {
  id: string;
  title?: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
};
type Queue = {
  tasks: Task[];
  limits?: Record<string, number | boolean | string | null>;
  next_migr?: number;
};
type Load = { freeMemoryPct: number | null } | null;

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic') as {
  loadGuard: (
    queue: Queue,
    load: Load,
  ) => { active: boolean; stop: boolean; reasons?: string[]; summary?: string; message?: string };
  minFreeMemoryFor: (queue: Queue) => number | null;
  startGuard: (
    queue: Queue,
    dailyUsage?: number,
    option?: { force?: boolean; load?: Load },
  ) => { code: number; stop: string; message: string } | null;
  state: (
    queue: Queue,
    dailyUsage?: number,
    option?: { load?: Load },
  ) => { canStart: number; stop?: string; load?: string; blocked: { blockers: string[] }[] };
  parseLimit: (name: string, raw: string) => { val: unknown } | { error: string };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const task = (id: string): Task => ({
  id,
  title: id,
  domain: 'client',
  class: 'K',
  status: 'waiting',
  mission: 'x',
});
const queueWith = (limits: Record<string, number | null> = {}): Queue => ({
  tasks: [task('A')],
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 5, ...limits },
});

describe('loadGuard', () => {
  it('off by default: no stop even with little memory', () => {
    expect(L.minFreeMemoryFor(queueWith())).toBeNull();
    expect(L.loadGuard(queueWith(), { freeMemoryPct: 1 })).toEqual({ active: false, stop: false });
  });

  it('free memory below the limit stops; equal to the limit does not', () => {
    const queue = queueWith({ minFreeMemoryPct: 15 });
    const low = L.loadGuard(queue, { freeMemoryPct: 9.44 });
    expect(low.stop).toBe(true);
    expect(low.message).toContain('THE MACHINE IS FULL');
    expect(low.summary).toContain('free memory 9.4 %');
    expect(L.loadGuard(queue, { freeMemoryPct: 15 }).stop).toBe(false);
  });

  it('an unknown measurement (null) or no measurement never stops', () => {
    const queue = queueWith({ minFreeMemoryPct: 15 });
    expect(L.loadGuard(queue, { freeMemoryPct: null }).stop).toBe(false);
    expect(L.loadGuard(queue, null).stop).toBe(false);
  });

  it('"off" in the queue (null) wins over a value from the config', () => {
    expect(L.minFreeMemoryFor(queueWith({ minFreeMemoryPct: null }))).toBeNull();
  });

  it('startGuard gives exit 7; --force overrides; state shows the reason as a blocker', () => {
    const queue = queueWith({ minFreeMemoryPct: 15 });
    const load = { freeMemoryPct: 3 };
    const v = L.startGuard(queue, 0, { load });
    expect(v?.code).toBe(7);
    expect(v?.stop).toBe('load');
    expect(L.startGuard(queue, 0, { load, force: true })).toBeNull();
    const t = L.state(queue, 0, { load });
    expect(t.canStart).toBe(0);
    expect(t.stop).toBe('load');
    expect(t.blocked[0].blockers[0]).toContain('the machine is full');
  });

  it('parseLimit: integer, "off"/0 = null, at most 100', () => {
    expect(L.parseLimit('minFreeMemoryPct', '15')).toEqual({ val: 15 });
    expect(L.parseLimit('minFreeMemoryPct', 'off')).toEqual({ val: null });
    expect(L.parseLimit('minFreeMemoryPct', '0')).toEqual({ val: null });
    expect('error' in L.parseLimit('minFreeMemoryPct', '101')).toBe(true);
    expect('error' in L.parseLimit('minFreeMemoryPct', 'x')).toBe(true);
  });
});

describe('queue.mjs: the load guard', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;

  function run(args: string[], load: string): { code: number | null; out: string; error: string } {
    const r = spawnSync(process.execPath, [QUEUE_MJS, ...args], {
      env: {
        ...process.env,
        QUEUE_FOLDER: folder,
        QUEUE_GIT: folder,
        QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
        QUEUE_LOAD: load,
      },
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  }
  const readQueue = (): Queue => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-load-'));
    writeFileSync(join(folder, 'queue.json'), JSON.stringify({ ...queueWith(), next_migr: 100 }));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('off by default: next proposes as before even with little memory', () => {
    const r = run(['next'], 'free=1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('A');
  });

  it('on: next and start give exit 7, show shows the reason, start --force starts', () => {
    expect(run(['limit', 'minFreeMemoryPct', '15'], 'free=50').code).toBe(0);
    expect(readQueue().limits?.minFreeMemoryPct).toBe(15);
    const next = run(['next'], 'free=4');
    expect(next.code).toBe(7);
    expect(next.error).toContain('THE MACHINE IS FULL');
    expect(run(['start', 'A'], 'free=4').code).toBe(7);
    expect(readQueue().tasks[0].status).toBe('waiting');
    const show = run(['show'], 'free=4');
    expect(show.code).toBe(0);
    expect(show.out).toContain('THE MACHINE IS FULL');
    expect(run(['limit'], 'free=4').out).toMatch(/minFreeMemoryPct +15/);
    expect(run(['next'], 'free=40').code).toBe(0);
    expect(run(['start', 'A', '--force'], 'free=4').code).toBe(0);
    expect(readQueue().tasks[0].status).toBe('running');
  });
});
