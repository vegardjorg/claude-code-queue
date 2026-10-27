// =============================================================
// queueStatistics.test.ts: the statistics on the kanban board for the work queue (scripts/orchestrator/lib/queueStatistics.js).
//
// Proves that the numbers are computed from the queue and the time log without a copy of the rules: the estimate is queueLogic.estimate
// (content × class weight), usage is timeCost.usageEvents (cumulative rows per agent), the night share follows
// the night window, and the dates are local dates (Europe/Oslo in the tests). The median is the main number; tasks without a start time or with impossible times
// are not counted in the times, and the number excluded is in the answer.
// =============================================================
import { describe, it, expect } from 'vitest';

type Task = {
  id: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  content_min?: number;
  started?: string;
  delivered?: string;
  done?: string;
  external?: boolean;
};
type Row = Record<string, unknown>;
type Stat = {
  windowDays: number;
  keyFigures: {
    finished: number;
    cycleMedian: number | null;
    cycleCount: number;
    accuracy: number | null;
    usageToday: number;
    dailyBudget: number | null;
  };
  donePerDay: { day: string; K: number; D: number; 'D+': number; U: number; sum: number }[];
  perClass: {
    class: string;
    count: number;
    work: { median: number | null; average: number | null };
    review: { median: number | null; average: number | null };
    estimateAverage: number | null;
  }[];
  costPerDay: { day: string; usd: number; night: number }[];
  context: { count: number; median: number | null; max: number | null; cap: number };
  excluded: { cycle: number; class: number; context: number };
  models: { model: string; count: number }[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../queueStatistics') as {
  WINDOW_DAYS: number;
  CONTEXT_CAP: number;
  median: (xs: number[]) => number | null;
  average: (xs: number[]) => number | null;
  daysBackward: (now: number, n: number) => string[];
  statistics: (
    queue: { tasks: Task[]; limits?: Record<string, unknown> },
    rows: Row[],
    option?: { now?: number },
  ) => Stat;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TK = require('../timeCost') as {
  costUsd: (tokens: Record<string, number>, model?: string) => number;
};

// Now: 30.09.2026 at 12:00 in Oslo (summer time, UTC+2).
const NOW = Date.parse('2026-09-30T10:00:00Z');
const ts = (iso: string) => new Date(Date.parse(iso)).toISOString();

describe('helpers', () => {
  it('median and average', () => {
    expect(S.median([])).toBeNull();
    expect(S.median([5, 1, 3])).toBe(3);
    expect(S.median([4, 1, 3, 2])).toBe(2.5);
    expect(S.average([1, 2, 6])).toBe(3);
  });

  it('daysBackward: Oslo dates, today last, no day skipped at the daylight saving switch', () => {
    const d = S.daysBackward(NOW, 3);
    expect(d).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
    // 26.10.2026 at 00:30 Oslo time (standard time); summer time ended the night before 25.10.
    const after = S.daysBackward(Date.parse('2026-10-25T23:30:00Z'), 3);
    expect(after).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    // Late evening UTC is the next day in Oslo.
    expect(S.daysBackward(Date.parse('2026-09-30T22:30:00Z'), 1)).toEqual(['2026-10-01']);
  });
});

describe('statistics: tasks', () => {
  const queue = {
    limits: { dailyBudget: 50 },
    tasks: [
      // K: estimate 30 min. 60 min work + 30 min review = 90 min cycle (3.0 × the estimate).
      {
        id: 'K1',
        class: 'K',
        status: 'done',
        content_min: 30,
        started: ts('2026-09-30T06:00:00Z'),
        delivered: ts('2026-09-30T07:00:00Z'),
        done: ts('2026-09-30T07:30:00Z'),
      },
      // K: 20 + 10 = 30 min (1.0 ×).
      {
        id: 'K2',
        class: 'K',
        status: 'done',
        content_min: 30,
        started: ts('2026-09-29T06:00:00Z'),
        delivered: ts('2026-09-29T06:20:00Z'),
        done: ts('2026-09-29T06:30:00Z'),
      },
      // D: estimate 30 × 1.3 = 39 min. Done 23:30 UTC 28.09 = 29.09 Oslo date. 78 min (2.0 ×).
      {
        id: 'D1',
        class: 'D',
        status: 'done',
        content_min: 30,
        started: ts('2026-09-28T22:12:00Z'),
        delivered: ts('2026-09-28T23:00:00Z'),
        done: ts('2026-09-28T23:30:00Z'),
      },
      // Without delivered: included in the cycle time, excluded from the time per class.
      {
        id: 'U1',
        class: 'U',
        status: 'done',
        content_min: 50,
        started: ts('2026-09-27T10:00:00Z'),
        done: ts('2026-09-27T10:30:00Z'),
      },
      // Done outside the queue (no started): counted as done, excluded from the times.
      { id: 'X1', class: 'K', status: 'done', done: ts('2026-09-30T08:00:00Z') },
      // Impossible time (done before started): excluded.
      {
        id: 'X2',
        class: 'K',
        status: 'done',
        started: ts('2026-09-30T08:00:00Z'),
        done: ts('2026-09-30T07:00:00Z'),
      },
      // Older than 7 days: not in "finished last 7 days", but in the 14-day window.
      {
        id: 'G1',
        class: 'K',
        status: 'done',
        content_min: 30,
        started: ts('2026-09-20T06:00:00Z'),
        delivered: ts('2026-09-20T06:30:00Z'),
        done: ts('2026-09-20T06:30:00Z'),
      },
      // Outside the 14-day window: not included at all.
      {
        id: 'G2',
        class: 'K',
        status: 'done',
        started: ts('2026-09-01T06:00:00Z'),
        done: ts('2026-09-01T09:00:00Z'),
      },
      // Not done, and an entry outside the queue: never included.
      { id: 'V1', class: 'K', status: 'waiting' },
      {
        id: 'E1',
        class: 'K',
        status: 'done',
        external: true,
        started: ts('2026-09-30T06:00:00Z'),
        done: ts('2026-09-30T09:00:00Z'),
      },
    ] as Task[],
  };
  const s = S.statistics(queue, [], { now: NOW });

  it('finished last 7 days (Oslo date), without entries outside the queue', () => {
    // K1, K2, D1, U1, X1, X2 (G1 is 10 days old, G2 outside the window, E1 is an external entry).
    expect(s.keyFigures.finished).toBe(6);
  });

  it('median cycle time and accuracy; without a start time and impossible times are excluded', () => {
    // Cycles: K1 90, K2 30, D1 78, U1 30, G1 30 → median 30.
    expect(s.keyFigures.cycleMedian).toBe(30);
    expect(s.keyFigures.cycleCount).toBe(5);
    expect(s.excluded.cycle).toBe(2); // X1, X2
    // Actual / estimated: K1 3.0, K2 1.0, D1 2.0, U1 30/30 = 1.0, G1 1.0 → median 1.0.
    expect(s.keyFigures.accuracy).toBe(1);
  });

  it('finished per day, stacked per class, by Oslo date', () => {
    expect(s.donePerDay).toHaveLength(S.WINDOW_DAYS);
    const day = (d: string) => s.donePerDay.find((r) => r.day === d);
    expect(day('2026-09-30')).toMatchObject({ K: 3, sum: 3 }); // K1, X1, X2
    expect(day('2026-09-29')).toMatchObject({ K: 1, D: 1, sum: 2 }); // K2, D1 (23:30 UTC 28.09)
    expect(day('2026-09-28')?.sum).toBe(0);
  });

  it('time per class: work and review, median and average, and estimated average from queueLogic.estimate', () => {
    const k = s.perClass.find((x) => x.class === 'K');
    // K1 (60/30), K2 (20/10), G1 (30/0).
    expect(k).toMatchObject({
      count: 3,
      work: { median: 30, average: 37 },
      review: { median: 10, average: 13 },
      estimateAverage: 30,
    });
    const d = s.perClass.find((x) => x.class === 'D');
    expect(d).toMatchObject({
      count: 1,
      work: { median: 48 },
      review: { median: 30 },
      estimateAverage: 39,
    });
    expect(s.perClass.find((x) => x.class === 'U')?.count).toBe(0); // U1 missing delivered
    expect(s.excluded.class).toBe(3); // X1, X2, U1
  });

  it('the daily budget is included when it is set', () => {
    expect(s.keyFigures.dailyBudget).toBe(50);
    expect(S.statistics({ tasks: [] }, [], { now: NOW }).keyFigures.dailyBudget).toBeNull();
  });
});

describe('statistics: the time log', () => {
  const tok = (output: number) => ({
    input: 0,
    output,
    cache_read: 0,
    cache_written: 0,
    cache_written_5m: 0,
    cache_written_1h: 0,
  });
  const usd = (output: number) => TK.costUsd(tok(output), 'claude-opus-5-5');
  const rows: Row[] = [
    // Agent a1 (track): two cumulative rows; growth at night (00:30 Oslo time) and during the day (11:00).
    {
      time: '2026-09-29T22:30:00Z',
      event: 'done',
      agent_id: 'a1',
      agent_type: 'track',
      track: 'K1',
      tokens: tok(100_000),
      model: 'claude-opus-5-5',
      context: { start: 1, median: 2, end: 100_000 },
    },
    {
      time: '2026-09-30T09:00:00Z',
      event: 'done',
      agent_id: 'a1',
      agent_type: 'track',
      track: 'K1',
      tokens: tok(300_000),
      model: 'claude-opus-5-5',
      context: { start: 1, median: 2, end: 250_000 },
    },
    // Agent a2 (track) yesterday during the day, large context.
    {
      time: '2026-09-29T10:00:00Z',
      event: 'done',
      agent_id: 'a2',
      agent_type: 'track',
      track: 'D1',
      tokens: tok(50_000),
      model: 'claude-opus-5-5',
      context: { start: 1, median: 2, end: 400_000 },
    },
    // Reviewer: included in the cost, not in the context of the track agents.
    {
      time: '2026-09-30T08:00:00Z',
      event: 'done',
      agent_id: 'r1',
      agent_type: 'reviewer',
      tokens: tok(10_000),
      context: { start: 1, median: 2, end: 900_000 },
    },
    // Track without context: excluded from the context.
    { time: '2026-09-30T08:30:00Z', event: 'done', agent_id: 'a3', agent_type: 'track' },
    // Other events do not count.
    { time: '2026-09-30T08:00:00Z', event: 'gate', agent_id: 'x', tokens: tok(999_999) },
  ];
  const s = S.statistics({ tasks: [] }, rows, { now: NOW });

  it('cost per day with the night share (default window 23-06), deduplicated per agent', () => {
    const today = s.costPerDay.find((r) => r.day === '2026-09-30');
    const yesterday = s.costPerDay.find((r) => r.day === '2026-09-29');
    const r2 = (x: number) => Math.round(x * 100) / 100;
    // 30.09: a1 first row (00:30, night) + a1 growth (11:00) + r1 (10:00).
    expect(today?.usd).toBe(r2(usd(300_000) + usd(10_000)));
    expect(today?.night).toBe(r2(usd(100_000)));
    expect(yesterday).toEqual({ day: '2026-09-29', usd: r2(usd(50_000)), night: 0 });
    expect(s.keyFigures.usageToday).toBe(today?.usd);
  });

  it('a different night window gives a different night share', () => {
    const s2 = S.statistics({ tasks: [], limits: { nightWindow: '01-05' } }, rows, { now: NOW });
    expect(s2.costPerDay.find((r) => r.day === '2026-09-30')?.night).toBe(0);
  });

  it('context: last row per track agent, median and max against the cap; a track without context is excluded', () => {
    expect(s.context).toEqual({
      count: 2,
      median: 325_000,
      max: 400_000,
      cap: S.CONTEXT_CAP,
    });
    expect(s.excluded.context).toBe(1);
  });

  it('the model in the last tracks', () => {
    expect(s.models).toEqual([{ model: 'claude-opus-5-5', count: 2 }]);
  });

  it('track-d (D and D+) is a build agent and counts in context and model; reviewer does not', () => {
    const withD: Row[] = [
      ...rows,
      {
        time: '2026-09-30T07:00:00Z',
        event: 'done',
        agent_id: 'd1',
        agent_type: 'track-d',
        track: 'D2',
        tokens: tok(20_000),
        model: 'claude-opus-5-5',
        context: { start: 1, median: 2, end: 600_000 },
      },
    ];
    const sd = S.statistics({ tasks: [] }, withD, { now: NOW });
    expect(sd.context).toEqual({
      count: 3,
      median: 400_000,
      max: 600_000,
      cap: S.CONTEXT_CAP,
    });
    expect(sd.models).toEqual([{ model: 'claude-opus-5-5', count: 3 }]);
  });
});

// =============================================================
// In versus out, median time from question to answer, and the age limits (p85) for aging work.
// =============================================================
type O3 = Task & { added_at?: string; waiting_on?: string[] };
type Queue3 = {
  tasks: O3[];
  question?: Record<string, { type: string; text: string; added_at?: string }>;
  resolutions?: Record<string, { time: string; answer: string | null; by: string | null }>;
};
type Stat3 = Stat & {
  keyFigures: Stat['keyFigures'] & {
    inOut: { in: number; out: number; net: number };
    responseTime: { median: number; count: number } | null;
  };
  inOutPerDay: { day: string; in: number; out: number }[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S3 = require('../queueStatistics') as {
  AGE_MIN_COUNT: number;
  RESPONSE_TIME_MIN_COUNT: number;
  percentile: (xs: number[], p: number) => number | null;
  ageBounds: (
    queue: Queue3,
    option?: { now?: number },
  ) => Record<string, { work: number | null; cycle: number | null; count: number }>;
  statistics: (queue: Queue3, rows: Row[], option?: { now?: number }) => Stat3;
};

describe('percentile and ageBounds (aging work over p85)', () => {
  it('percentile by nearest rank', () => {
    expect(S3.percentile([], 85)).toBeNull();
    expect(S3.percentile([10, 20, 30, 40, 50], 85)).toBe(50);
    expect(S3.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 85)).toBe(9);
    expect(S3.percentile([7], 85)).toBe(7);
  });

  it('per class p85 of work (start–delivered) and cycle (start–done); too few finished gives no limit', () => {
    // Five K tasks in the window: work 10, 20, 30, 40, 100 min; review 10 min each.
    const k = [10, 20, 30, 40, 100].map((min, i) => ({
      id: `K${i}`,
      class: 'K' as const,
      status: 'done',
      started: ts('2026-09-29T06:00:00Z'),
      delivered: new Date(Date.parse('2026-09-29T06:00:00Z') + min * 60_000).toISOString(),
      done: new Date(Date.parse('2026-09-29T06:10:00Z') + min * 60_000).toISOString(),
    }));
    // Four D tasks: below the minimum.
    const d = [1, 2, 3, 4].map((i) => ({ ...k[0], id: `D${i}`, class: 'D' as const }));
    // A K outside the window (20 days ago) does not count.
    const old = {
      ...k[0],
      id: 'OLD',
      started: ts('2026-09-10T06:00:00Z'),
      delivered: ts('2026-09-10T20:00:00Z'),
      done: ts('2026-09-10T21:00:00Z'),
    };
    const g = S3.ageBounds({ tasks: [...k, ...d, old] }, { now: NOW });
    expect(g.K).toEqual({ work: 100, cycle: 110, count: 5 });
    expect(g.D).toEqual({ work: null, cycle: null, count: 4 });
    expect(g['D+']).toEqual({ work: null, cycle: null, count: 0 });
    expect(S3.AGE_MIN_COUNT).toBe(5);
  });
});

describe('in versus out and time from question to answer', () => {
  const day = (d: string, t = '08:00') => ts(`${d}T${t}:00Z`);
  const done = (id: string, d: string): O3 => ({
    id,
    class: 'K',
    status: 'done',
    started: day(d, '06:00'),
    done: day(d),
    added_at: day(d, '05:00'),
  });
  const waiting = (id: string, d: string, field: Partial<O3> = {}): O3 => ({
    id,
    class: 'K',
    status: 'waiting',
    added_at: day(d),
    ...field,
  });

  it('added and finished per day for 14 days; the key figure is the average per day over the last 7, net > 0 = queue grows', () => {
    const queue: Queue3 = {
      tasks: [
        done('F1', '2026-09-30'),
        done('F2', '2026-09-29'),
        waiting('V1', '2026-09-30'),
        waiting('V2', '2026-09-30'),
        waiting('V3', '2026-09-24'),
        waiting('V4', '2026-09-20'), // added within the 14-day window, but before the last 7
        { ...waiting('EXT', '2026-09-30'), external: true }, // an entry outside the queue does not count
      ],
    };
    const s = S3.statistics(queue, [], { now: NOW });
    expect(s.inOutPerDay).toHaveLength(14);
    expect(s.inOutPerDay.at(-1)).toEqual({ day: '2026-09-30', in: 3, out: 1 });
    expect(s.inOutPerDay.at(-2)).toEqual({ day: '2026-09-29', in: 1, out: 1 });
    expect(s.inOutPerDay.find((r) => r.day === '2026-09-20')?.in).toBe(1);
    // Last 7 days: 5 added (F1, F2, V1, V2, V3) and 2 finished.
    expect(s.keyFigures.inOut).toEqual({ in: 0.7, out: 0.3, net: 0.4 });
  });

  it('median time from question to answer only with enough resolutions; from when the question existed', () => {
    const tasks: O3[] = [];
    const resolutions: Queue3['resolutions'] = {};
    // Four resolutions: too few, the number is left out.
    for (let i = 1; i <= 4; i++) {
      tasks.push(waiting(`V${i}`, '2026-09-28', { waiting_on: [`S${i}`] }));
      resolutions[`S${i}`] = {
        time: day('2026-09-28', `${String(8 + i).padStart(2, '0')}:00`),
        answer: 'Yes',
        by: 'owner',
      };
    }
    expect(
      S3.statistics({ tasks, resolutions }, [], { now: NOW }).keyFigures.responseTime,
    ).toBeNull();
    // The fifth: the question was registered earlier (question.added_at) than the task came in.
    tasks.push(waiting('V5', '2026-09-29', { waiting_on: ['S5'] }));
    resolutions.S5 = { time: day('2026-09-29', '10:00'), answer: 'Yes', by: 'owner' };
    const question = { S5: { type: 'question', text: '?', added_at: day('2026-09-28') } };
    const s = S3.statistics({ tasks, resolutions, question }, [], { now: NOW });
    // The response times: 60, 120, 180, 240 and 26 h (1560) min; the median is 180.
    expect(s.keyFigures.responseTime).toEqual({ median: 180, count: 5 });
    expect(S3.RESPONSE_TIME_MIN_COUNT).toBe(5);
  });

  it('an old queue.json without the new fields gives numbers without error', () => {
    const s = S3.statistics({ tasks: [done('F1', '2026-09-30')] }, [], { now: NOW });
    expect(s.keyFigures.responseTime).toBeNull();
    expect(s.keyFigures.inOut.out).toBe(0.1);
  });
});
