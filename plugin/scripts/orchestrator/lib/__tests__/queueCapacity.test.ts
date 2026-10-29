// =============================================================
// queueCapacity.test.ts: the weekly quota model in the work queue (scripts/orchestrator/lib/queueCapacity.js).
//
// Proves: the reset follows the default (tuesday at 19.00 Europe/Oslo) also across the switch to standard time, and
// day, time of day, time zone and planName can be set in the config; usage is computed from the time log's cumulative rows
// (growth per agent, timeCost.usageEvents); percent and "empty" time follow the constant; the calibration corrects
// the constant from the percentage Claude shows; and the quota cap in fill is soft (notice changes nothing, cap limits, off turns
// it off). Plus the calibrated wall time and cost model in queueLogic.
// =============================================================
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';

// No config file: the default values apply, whatever is in the project root.
process.env.QUEUE_CONFIG = path.join(os.tmpdir(), 'queue-capacity-test-does-not-exist.json');

type Reset = { weekday: number; time: number; minute: number; tz: string; planName: string | null };

type Event = { agent: string; time: string; usd: number; tokens?: Record<string, number> };
type Forecast = {
  from: number;
  to: number;
  now: number;
  usd: number;
  pct: number;
  paceAverage: number;
  emptyAverage: number | null;
  holds: boolean;
  trackHours: number;
  parallelAverage: number;
  suggestionTrack: number | null;
  mode: string;
  tokens: Record<string, number>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CH = require('../queueCapacity') as {
  lastReset: (now: number, n?: Reset) => number;
  nextReset: (now: number, n?: Reset) => number;
  resetFrom: (ch?: object) => Reset;
  reset: () => Reset;
  forecast: (input: {
    queue: object;
    events: Event[];
    now?: number;
    reset?: Reset;
  }) => Forecast;
  calibrate: (
    queue: object,
    input: { percent: unknown; events: Event[]; now?: number },
  ) => {
    error?: string;
    previous?: number;
    capacity?: { usd_per_100: number; calibrations: unknown[] };
  };
  quotaCap: (p: Forecast, activeOnes: number) => { limit: number | null; message: string | null };
  lines: (p: Forecast) => string[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TK = require('../timeCost') as {
  usageEvents: (r: object[]) => Event[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  estimate: (o: object) => number;
  estimateWall: (o: object) => number;
  estimateCost: (o: object) => number;
};

const iso = (s: string) => new Date(s).toISOString();
const ms = (s: string) => Date.parse(s);

describe('the reset (default: tuesday at 19.00 Europe/Oslo)', () => {
  it('without config the default applies, without planName', () => {
    expect(CH.reset()).toEqual({
      weekday: 2,
      hour: 19,
      minute: 0,
      tz: 'Europe/Oslo',
      planName: null,
    });
  });
  it('finds the previous tuesday 19.00 in summer time (17.00 UTC)', () => {
    expect(iso(new Date(CH.lastReset(ms('2026-10-23T08:35:00Z'))).toISOString())).toBe(
      '2026-10-20T17:00:00.000Z',
    );
  });
  it('the next reset after the switch to standard time is 19.00 CET (18.00 UTC)', () => {
    expect(new Date(CH.nextReset(ms('2026-10-23T08:35:00Z'))).toISOString()).toBe(
      '2026-10-27T18:00:00.000Z',
    );
  });
  it('exactly at the reset the new week has started; one minute before, the previous one applies', () => {
    expect(CH.lastReset(ms('2026-10-20T17:00:00Z'))).toBe(ms('2026-10-20T17:00:00Z'));
    expect(CH.lastReset(ms('2026-10-20T16:59:00Z'))).toBe(ms('2026-10-13T17:00:00Z'));
  });
});

// Two agents with cumulative rows: a1 has $4 before the reset and $204 after, a2 $400 after.
const rows = [
  {
    event: 'done',
    agent_id: 'a1',
    time: '2026-10-20T16:00:00Z',
    tokens: { output: 0, cache_read: 20_000_000 },
  },
  {
    event: 'done',
    agent_id: 'a1',
    time: '2026-10-21T10:00:00Z',
    tokens: { output: 0, cache_read: 1_020_000_000 },
  },
  {
    event: 'done',
    agent_id: 'a2',
    time: '2026-10-22T10:00:00Z',
    tokens: { output: 20_000_000, cache_read: 0 },
  },
];
const NOW = ms('2026-10-23T05:00:00Z'); // 60 h after the reset
const queue = (extra: object = {}) => ({
  capacity: { usd_per_100: 1000, ...extra },
  tasks: [
    // 30 track hours in the week: 20 h done (the part before the reset is not counted) + 10 h running now.
    {
      id: 'A',
      class: 'K',
      status: 'done',
      started: '2026-10-20T07:00:00Z',
      delivered: '2026-10-21T13:00:00Z',
    },
    { id: 'B', class: 'D', status: 'running', started: '2026-10-22T19:00:00Z', content_min: 40 },
    {
      id: 'S',
      class: 'K',
      status: 'done',
      cloud: true,
      started: '2026-10-21T00:00:00Z',
      delivered: '2026-10-22T00:00:00Z',
    },
  ],
});

describe('the reset from the config', () => {
  it('day, time of day, time zone and planName can be set; invalid values give the default', () => {
    expect(
      CH.resetFrom({
        resetDay: 1,
        resetClock: '08:30',
        timeZone: 'UTC',
        planName: 'Example plan',
      }),
    ).toEqual({ weekday: 1, hour: 8, minute: 30, tz: 'UTC', planName: 'Example plan' });
    expect(
      CH.resetFrom({ resetDay: 9, resetClock: '25:00', timeZone: 'None/Zone' }),
    ).toEqual(CH.resetFrom({}));
  });
  it('monday 08.30 UTC: last and next reset', () => {
    const n = CH.resetFrom({ resetDay: 1, resetClock: '08:30', timeZone: 'UTC' });
    // Friday 23.10.2026: the last monday was 19.10, the next 26.10.
    expect(new Date(CH.lastReset(ms('2026-10-23T08:35:00Z'), n)).toISOString()).toBe(
      '2026-10-19T08:30:00.000Z',
    );
    expect(new Date(CH.nextReset(ms('2026-10-23T08:35:00Z'), n)).toISOString()).toBe(
      '2026-10-26T08:30:00.000Z',
    );
  });
});

describe('forecast', () => {
  const h = TK.usageEvents(rows);
  it('counts only the growth after the reset and computes percent from the constant', () => {
    const p = CH.forecast({ queue: queue(), events: h, now: NOW });
    expect(p.usd).toBeCloseTo(600, 5); // a1: (1 020M − 20M) × $0.2/M = 200; a2: 20M output × $20/M = 400
    expect(p.pct).toBeCloseTo(60, 5);
    expect(p.tokens.cache_read).toBe(1_000_000_000);
  });
  it('the pace is the average since the reset, and the quota is empty when the rest is used at that pace', () => {
    const p = CH.forecast({ queue: queue(), events: h, now: NOW });
    expect(p.paceAverage).toBeCloseTo(1, 5); // 60 % in 60 h
    expect(p.emptyAverage).toBe(NOW + 40 * 3_600_000);
    expect(p.holds).toBe(false);
  });
  it('track hours: overlap with the week, without cloud tracks; running ones count until now', () => {
    const p = CH.forecast({ queue: queue(), events: h, now: NOW });
    expect(p.trackHours).toBeCloseTo(20 + 10, 5);
    expect(p.parallelAverage).toBeCloseTo(0.5, 5);
    // 2 % per track hour; the remaining 40 % over (to − now) hours.
    const left = (p.to - NOW) / 3_600_000;
    expect(p.suggestionTrack).toBe(Math.floor(40 / left / 2));
  });
});

describe('calibration', () => {
  const h = TK.usageEvents(rows);
  it('sets usd_per_100 from the percentage Claude shows, and saves the point', () => {
    const r = CH.calibrate(queue(), { percent: 30, events: h, now: NOW });
    expect(r.previous).toBe(1000);
    expect(r.capacity?.usd_per_100).toBe(2000);
    expect(r.capacity?.calibrations).toHaveLength(1);
  });
  it('rejects an invalid percentage', () => {
    expect(CH.calibrate(queue(), { percent: 'x', events: h, now: NOW }).error).toBeTruthy();
    expect(CH.calibrate(queue(), { percent: 0, events: h, now: NOW }).error).toBeTruthy();
  });
});

describe('the quota cap in fill is soft', () => {
  const h = TK.usageEvents(rows);
  it('notice (default): message, no limit', () => {
    const p = CH.forecast({ queue: queue(), events: h, now: NOW });
    const t = CH.quotaCap(p, 5);
    expect(t.limit).toBeNull();
    expect(t.message).toMatch(/Notice only/);
  });
  it('cap: at most the suggestion minus those running, but at least 1 when nothing is running', () => {
    const p = CH.forecast({ queue: queue({ mode: 'cap' }), events: h, now: NOW });
    expect(CH.quotaCap(p, 5).limit).toBe(Math.max(0, (p.suggestionTrack ?? 0) - 5));
    expect(CH.quotaCap(p, 0).limit).toBeGreaterThanOrEqual(1);
  });
  it('off: nothing', () => {
    const p = CH.forecast({ queue: queue({ mode: 'off' }), events: h, now: NOW });
    expect(CH.quotaCap(p, 5)).toEqual({ limit: null, message: null });
  });
  it('the lines mention percent, empty time and the suggestion', () => {
    const p = CH.forecast({
      queue: queue({ cloudCredit: { left_usd: 47, total_usd: 250 } }),
      events: h,
      now: NOW,
    });
    const t = CH.lines(p).join('\n');
    expect(t).toMatch(/Used: 60 %/);
    expect(t).toMatch(/Empty \(100 %\)/);
    expect(t).toMatch(/Cloud credit.*47 of 250/);
    // Generic text: "Weekly quota" without planName, the day from the reset.
    expect(t).toMatch(/^Weekly quota: reset/);
    expect(t).toMatch(/resets every tuesday/);
  });
  it('planName and a different reset day are shown in the text', () => {
    const n = CH.resetFrom({ resetDay: 4, planName: 'Example plan' });
    const p = CH.forecast({ queue: queue(), events: h, now: NOW, reset: n });
    const t = CH.lines(p).join('\n');
    expect(t).toMatch(/^Weekly quota \(Example plan\): reset thursday/);
    expect(t).toMatch(/resets every thursday/);
    expect(t).not.toMatch(/tuesday/);
  });
});

describe('calibrated wall time and cost (queueLogic)', () => {
  it('estimate (the priority) is unchanged', () => {
    expect(L.estimate({ class: 'K', content_min: 30 })).toBe(30);
    expect(L.estimate({ class: 'D+', content_min: 30 })).toBe(54);
  });
  it('wall time: K is shorter than the estimate, D and D+ longer', () => {
    expect(L.estimateWall({ class: 'K', content_min: 120 })).toBe(33);
    expect(L.estimateWall({ class: 'D', content_min: 40 })).toBe(72);
    expect(L.estimateWall({ class: 'D+', content_min: 30 })).toBe(98);
    expect(L.estimateCost({ class: 'D', content_min: 40 })).toBe(5.2);
  });
});
