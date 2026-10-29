// =============================================================
// queueLogic.test.ts: work queue (lib/queueLogic.js): choice of next task, ownership conflicts,
// limits (concurrent, D+, per domain), dependencies, owner questions, priority and migration blocks.
// =============================================================
import { describe, it, expect } from 'vitest';

type Task = {
  id: string;
  title?: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  value?: number;
  content_min?: number;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  owner_db?: string[];
  shared_patch?: string[];
  added_at?: string;
  priority_bonus?: number;
  migr_tens?: number;
};
type Queue = {
  tasks: Task[];
  resolved?: string[];
  limits?: { maxConcurrent?: number; maxDPlus?: number; maxPerDomain?: number; maxDb?: number };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../queueLogic') as {
  DEFAULT_LIMITS: {
    maxConcurrent: number;
    maxDPlus: number;
    maxPerDomain: number;
    maxDb: number;
  };
  estimate: (o: Task) => number;
  validate: (o: unknown, ex?: Task[]) => string[];
  fileOverlap: (a: string, b: string) => boolean;
  conflict: (a: Task, b: Task) => string | null;
  blockers: (o: Task, all: Task[], resolved?: string[]) => string[];
  lockUpCount: (id: string, all: Task[]) => number;
  score: (o: Task, all: Task[], now?: number) => number;
  selectNext: (queue: Queue, now?: number) => { id: string; score: number; estimate: number }[];
  assignMigrBlock: (
    next: number,
    tens: number,
  ) => { from: number | null; to: number | null; nextAvailable: number };
  state: (queue: Queue) => {
    activeOnes: number;
    waiting: number;
    canStart: number;
    empty: boolean;
    blocked: { id: string; blockers: string[] }[];
    ownerQuestion: { sp: string; tasks: number }[];
  };
};

const NOW = Date.parse('2026-09-28T12:00:00Z');
const o = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  domain: 'ui',
  class: 'K',
  status: 'waiting',
  mission: 'x',
  title: id,
  ...extra,
});
const ids = (queue: Queue) => K.selectNext(queue, NOW).map((v) => v.id);

describe('estimate and validation', () => {
  it('estimate = content × weight', () => {
    expect(K.estimate(o('a', { content_min: 30, class: 'K' }))).toBe(30);
    expect(K.estimate(o('a', { content_min: 30, class: 'D+' }))).toBe(54);
    expect(K.estimate(o('a', { content_min: 30, class: 'U' }))).toBe(18);
  });
  it('validate catches missing fields, invalid class and duplicate id', () => {
    expect(K.validate(o('a'))).toEqual([]);
    expect(K.validate({ id: 'a' })).toEqual(
      expect.arrayContaining([
        'title missing',
        'domain missing',
        'mission missing (path to track description or text)',
      ]),
    );
    expect(K.validate(o('a', { class: 'X' as never })).join()).toMatch(/class/);
    expect(K.validate(o('a'), [o('a')]).join()).toMatch(/already exists/);
    expect(K.validate(o('a b')).join()).toMatch(/id/);
  });
});

describe('ownership', () => {
  it('a folder with / owns everything under it, otherwise exact path; slashes are normalized', () => {
    expect(K.fileOverlap('app/(app)/list.tsx', 'app\\(app)\\list.tsx')).toBe(true);
    expect(K.fileOverlap('components/list/', 'components/list/WeekMatrix.tsx')).toBe(
      true,
    );
    expect(K.fileOverlap('components/list/WeekMatrix.tsx', 'components/list/')).toBe(
      true,
    );
    expect(K.fileOverlap('components/ui/', 'components/list/X.tsx')).toBe(false);
    expect(K.fileOverlap('a.ts', 'b.ts')).toBe(false);
  });
  it('conflict on file, DB function (case-insensitive) and shared patch', () => {
    const active = o('A', {
      status: 'running',
      owned_files: ['x.ts'],
      owner_db: ['claim_open_shift'],
      shared_patch: ['anonymize_user'],
    });
    expect(K.conflict(o('b', { owned_files: ['x.ts'] }), active)).toMatch(/file/);
    expect(K.conflict(o('b', { owner_db: ['CLAIM_OPEN_SHIFT'] }), active)).toMatch(/DB function/);
    expect(K.conflict(o('b', { shared_patch: ['anonymize_user'] }), active)).toMatch(/shared patch/);
    expect(K.conflict(o('b', { owned_files: ['y.ts'] }), active)).toBeNull();
  });
});

describe('blockers', () => {
  it('a dependency that is not done, and an unknown dependency', () => {
    const all = [o('A', { status: 'running' }), o('b', { depends_on: ['A', 'Z'] })];
    const h = K.blockers(all[1], all);
    expect(h.join()).toMatch(/waiting on A/);
    expect(h.join()).toMatch(/unknown Z/);
  });
  it('an owner question blocks until it is resolved', () => {
    const b = o('b', { waiting_on: ['Q9'] });
    expect(K.blockers(b, [b]).join()).toMatch(/Q9/);
    expect(K.blockers(b, [b], ['Q9'])).toEqual([]);
  });
  it('a task in review still holds the ownership', () => {
    const all = [
      o('A', { status: 'review', owned_files: ['x.ts'] }),
      o('b', { owned_files: ['x.ts'] }),
    ];
    expect(K.blockers(all[1], all).join()).toMatch(/is owned by A/);
  });
});

describe('defaultLimits', () => {
  // The default limits: few concurrent agents and D+ tracks, to save tokens.
  it('are 5 concurrent and 2 D+ when queue.json does not set anything', () => {
    expect(K.DEFAULT_LIMITS.maxConcurrent).toBe(5);
    expect(K.DEFAULT_LIMITS.maxDPlus).toBe(2);
  });

  it('limits selectNext to 5 when the queue has no limits of its own', () => {
    const tasks = Array.from({ length: 8 }, (_, i) =>
      o(`S${i}`, { domain: `d${i}`, owned_files: [`f${i}.ts`] }),
    );
    expect(ids({ tasks })).toHaveLength(5);
  });
});

describe('selectNext', () => {
  it('fills available slots in priority order', () => {
    const queue: Queue = {
      limits: { maxConcurrent: 2 },
      tasks: [o('low', { value: 2 }), o('high', { value: 9 }), o('mid', { value: 5 })],
    };
    expect(ids(queue)).toEqual(['high', 'mid']);
  });
  it('subtracts slots that are in use', () => {
    const queue: Queue = {
      limits: { maxConcurrent: 2 },
      tasks: [o('A', { status: 'running' }), o('b'), o('c')],
    };
    expect(ids(queue)).toHaveLength(1);
  });
  it('two candidates that own the same file are not started concurrently', () => {
    const queue: Queue = {
      tasks: [
        o('a', { value: 9, owned_files: ['v.tsx'] }),
        o('b', { value: 8, owned_files: ['v.tsx'] }),
        o('c'),
      ],
    };
    expect(ids(queue)).toEqual(expect.arrayContaining(['a', 'c']));
    expect(ids(queue)).not.toContain('b');
  });
  it('the cap for D+ holds, and other classes fill the rest', () => {
    const queue: Queue = {
      limits: { maxDPlus: 1 },
      tasks: [
        o('A', { status: 'running', class: 'D+' }),
        o('b', { class: 'D+', value: 10 }),
        o('c', { class: 'K' }),
      ],
    };
    expect(ids(queue)).toEqual(['c']);
  });
  it('the cap for tracks with migrations holds, client tracks fill the rest', () => {
    const queue: Queue = {
      limits: { maxDb: 1 },
      tasks: [
        o('A', { status: 'running', class: 'D', migr_tens: 1 }),
        o('b', { class: 'D', value: 10, migr_tens: 1 }),
        o('c', { class: 'K', migr_tens: 0 }),
      ],
    };
    expect(ids(queue)).toEqual(['c']);
  });
  it('the cap per domain holds', () => {
    const queue: Queue = {
      limits: { maxPerDomain: 1 },
      tasks: [
        o('a', { domain: 'ui', value: 9 }),
        o('b', { domain: 'ui' }),
        o('c', { domain: 'gamma' }),
      ],
    };
    expect(ids(queue)).toEqual(['a', 'c']);
  });
  it('blocked tasks are not chosen', () => {
    const queue: Queue = { tasks: [o('a', { waiting_on: ['E-V3'] }), o('b', { depends_on: ['a'] })] };
    expect(ids(queue)).toEqual([]);
  });
});

describe('priority', () => {
  it('a task that unlocks others is ranked above an otherwise equal task', () => {
    const all = [
      o('reason'),
      o('another'),
      o('b1', { depends_on: ['reason'] }),
      o('b2', { depends_on: ['b1'] }),
    ];
    expect(K.lockUpCount('reason', all)).toBe(2);
    expect(K.score(all[0], all, NOW)).toBeGreaterThan(K.score(all[1], all, NOW));
  });
  it('a shorter estimate with the same value is ranked higher; a manual bonus works', () => {
    const short = o('short', { content_min: 20 });
    const long = o('long', { content_min: 40, class: 'D+' });
    expect(K.score(short, [short, long], NOW)).toBeGreaterThan(K.score(long, [short, long], NOW));
    const long2 = { ...long, priority_bonus: 1000 };
    expect(K.score(long2, [short, long2], NOW)).toBeGreaterThan(K.score(short, [short, long2], NOW));
  });
  it('finished dependents do not count as locked up', () => {
    const all = [o('reason'), o('b1', { depends_on: ['reason'], status: 'done' })];
    expect(K.lockUpCount('reason', all)).toBe(0);
  });
});

describe('migration blocks and state', () => {
  it('blocks start on a whole tier and follow each other', () => {
    expect(K.assignMigrBlock(2840, 2)).toEqual({ from: 2840, to: 2859, nextAvailable: 2860 });
    expect(K.assignMigrBlock(2861, 1)).toEqual({ from: 2870, to: 2879, nextAvailable: 2880 });
    expect(K.assignMigrBlock(2861, 0)).toEqual({ from: null, to: null, nextAvailable: 2861 });
  });
  it('empty = nothing running and nothing can start; owner questions are sorted by how much they unlock', () => {
    const queue: Queue = {
      tasks: [
        o('a', { waiting_on: ['Q9'] }),
        o('b', { waiting_on: ['Q9', 'E-V3'] }),
        o('c', { status: 'done' }),
      ],
    };
    const t = K.state(queue);
    expect(t.empty).toBe(true);
    expect(t.ownerQuestion[0]).toEqual({ sp: 'Q9', tasks: 2 });
    expect(t.blocked.map((b) => b.id)).toEqual(['a', 'b']);
    expect(K.state({ tasks: [o('x', { status: 'running' })] }).empty).toBe(false);
  });
});
