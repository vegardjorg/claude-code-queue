// =============================================================
// queueForecast.test.ts: the Monte Carlo forecast "when will the remaining tasks be done" (lib/queueForecast.js).
//
// The rule is enforced in queueForecast.forecast (pure, a seeded random generator) and shown by `queue.mjs forecast`,
// so both are tested here: known percentiles, zero days, not enough data, cost, what counts as remaining (focus,
// project), and the CLI against a temporary queue (never the real queue).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Point = { days: number; date: string };
type Forecast = {
  enough: boolean;
  reason: string | null;
  remaining: number;
  windowDays: number;
  sample: number;
  runs: number;
  throughput: number[];
  p50: Point | null;
  p85: Point | null;
  p95: Point | null;
  medianCost: number | null;
  costCount: number;
  expectedCost: number | null;
  today: string;
  focus?: { name: string | null; stages: string[] } | null;
  project?: string | null;
  ids?: string[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FC = require('../queueForecast.js') as {
  MIN_DONE: number;
  seededRandom: (seed: number) => () => number;
  forecast: (input: Record<string, unknown>) => Forecast;
  remainingTasks: (queue: unknown, option?: Record<string, unknown>) => { tasks: { id: string }[]; focus: unknown };
  queueForecast: (queue: unknown, option?: Record<string, unknown>) => Forecast;
  boardForecast: (queue: unknown, option?: Record<string, unknown>) => Forecast & { text: string };
  forecastText: (f: Forecast) => string;
  dayText: (day: string) => string;
};

const NOW = Date.parse('2026-10-31T10:00:00.000Z'); // a Friday
const TZ = 'UTC';
const DAY = 86_400_000;
/** `n` done tasks on the day `back` days before today (noon UTC). */
const doneOn = (back: number, n = 1, usd: number | null = null) =>
  Array.from({ length: n }, () => ({ done: new Date(NOW - back * DAY + 2 * 3600_000).toISOString(), usd }));

describe('forecast (pure)', () => {
  it('a constant throughput gives exact percentiles: 2 per day and 14 left = 7 days at every level', () => {
    const done = Array.from({ length: 28 }, (_, i) => doneOn(i, 2)).flat();
    const f = FC.forecast({ done, remaining: 14, rng: FC.seededRandom(1), now: NOW, tz: TZ });
    expect(f.enough).toBe(true);
    expect(f.sample).toBe(56);
    expect(f.runs).toBe(2000);
    expect(f.today).toBe('2026-10-31');
    for (const p of [f.p50, f.p85, f.p95]) expect(p).toEqual({ days: 7, date: '2026-11-07' });
  });

  it('counts zero days: a two-day window of [0, 5] and 5 left gives the geometric percentiles 1, 3 and 5 days', () => {
    // P(done within n days) = 1 - 0.5^n: 50 % at day 1, 87.5 % at day 3 (>= 85), 96.9 % at day 5 (>= 95).
    const f = FC.forecast({ done: doneOn(0, 5), remaining: 5, days: 2, rng: FC.seededRandom(42), now: NOW, tz: TZ });
    expect(f.throughput).toEqual([0, 5]);
    expect([f.p50?.days, f.p85?.days, f.p95?.days]).toEqual([1, 3, 5]);
    expect(f.p85?.date).toBe('2026-11-03');
  });

  it('the same seed gives the same answer, and the levels never go backward', () => {
    const done = [...doneOn(0, 3), ...doneOn(2, 1), ...doneOn(5, 4), ...doneOn(9, 2), ...doneOn(20, 3)];
    const a = FC.forecast({ done, remaining: 12, rng: FC.seededRandom(7), now: NOW, tz: TZ });
    const b = FC.forecast({ done, remaining: 12, rng: FC.seededRandom(7), now: NOW, tz: TZ });
    expect(a).toEqual(b);
    expect(a.p50!.days).toBeLessThanOrEqual(a.p85!.days);
    expect(a.p85!.days).toBeLessThanOrEqual(a.p95!.days);
    // 13 done in 28 days (most of them zero days): 12 tasks take weeks, not days.
    expect(a.throughput.filter((x) => x === 0)).toHaveLength(23);
    expect(a.p50!.days).toBeGreaterThan(14);
  });

  it('says "not enough data" with fewer than MIN_DONE done in the window; tasks outside the window do not count', () => {
    const done = [...doneOn(0, FC.MIN_DONE - 1), ...doneOn(40, 10)];
    const f = FC.forecast({ done, remaining: 3, rng: FC.seededRandom(1), now: NOW, tz: TZ });
    expect(f.enough).toBe(false);
    expect(f.sample).toBe(FC.MIN_DONE - 1);
    expect(f.p50).toBeNull();
    expect(f.reason).toMatch(/^not enough data \(4 done in the last 28 days/);
    expect(FC.forecastText({ ...f, focus: null })).toMatch(/3 tasks left\. No forecast: not enough data/);
  });

  it('nothing left is day 0 (today)', () => {
    const f = FC.forecast({ done: doneOn(0, 6), remaining: 0, now: NOW, tz: TZ });
    expect(f.p95).toEqual({ days: 0, date: '2026-10-31' });
    expect(FC.forecastText({ ...f, focus: null })).toBe('The queue: nothing left.');
  });

  it('expected cost = remaining x the median measured cost in the window; null without cost data', () => {
    const done = [...doneOn(0, 2, 2), ...doneOn(1, 1, 3), ...doneOn(2, 1, 10), ...doneOn(3, 2, null), ...doneOn(50, 3, 99)];
    const f = FC.forecast({ done, remaining: 14, rng: FC.seededRandom(1), now: NOW, tz: TZ });
    expect(f.costCount).toBe(4);
    expect(f.medianCost).toBe(2.5);
    expect(f.expectedCost).toBe(35);
    const none = FC.forecast({ done: doneOn(0, 6), remaining: 4, rng: FC.seededRandom(1), now: NOW, tz: TZ });
    expect(none.medianCost).toBeNull();
    expect(none.expectedCost).toBeNull();
    expect(FC.forecastText({ ...none, focus: null })).toContain('No measured cost yet.');
  });
});

describe('remaining tasks and the paragraph', () => {
  const task = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: id,
    class: 'K',
    status,
    project: 'p1',
    ...extra,
  });
  const queue = {
    projects: { p1: { title: 'Project one' }, p2: { title: 'Project two' } },
    tasks: [
      task('A', 'waiting'),
      task('B', 'running'),
      task('C', 'review'),
      task('D', 'picked'),
      task('E', 'proposed'),
      task('F', 'cancelled'),
      task('G', 'waiting', { project: 'p2' }),
      ...Array.from({ length: 31 }, (_, i) => task(`X${i}`, 'done', { done: doneOn(i % 20)[0].done, cost: { usd: 3 } })),
    ],
  };

  it('without a focus: waiting, running, picked and review count; proposals, cancelled and done do not', () => {
    expect(FC.remainingTasks(queue, { now: NOW }).tasks.map((o) => o.id)).toEqual(['A', 'B', 'C', 'D', 'G']);
    expect(FC.remainingTasks(queue, { now: NOW, project: 'p2' }).tasks.map((o) => o.id)).toEqual(['G']);
  });

  it('with a focus: only the open tasks in the focus stages; --project narrows further', () => {
    const q = { ...queue, focus: { order: ['project:p2'], name: 'Two first' } };
    const r = FC.remainingTasks(q, { now: NOW });
    expect(r.tasks.map((o) => o.id)).toEqual(['G']);
    expect(r.focus).toEqual({ name: 'Two first', stages: ['Project two'] });
    expect(FC.remainingTasks(q, { now: NOW, project: 'p1' }).tasks).toEqual([]);
  });

  it('the paragraph has the focus name, the count, the three dates, the sample and the cost', () => {
    const q = {
      ...queue,
      focus: { order: ['project:p1'], name: 'X' },
      tasks: [...queue.tasks, ...Array.from({ length: 10 }, (_, i) => task(`R${i}`, 'waiting'))],
    };
    const f = FC.queueForecast(q, { rng: FC.seededRandom(3), now: NOW, tz: TZ });
    expect(f.remaining).toBe(14);
    const text = FC.forecastText(f);
    expect(text).toMatch(
      /^Focus "X": 14 tasks left\. 50 %: by \w{3} \d{1,2} \w{3} \(\d+ days\), 85 %: \w{3} \d{1,2} \w{3}, 95 %: \w{3} \d{1,2} \w{3}\. Based on 31 done in the last 28 days\. Expected cost about 42 USD\.$/,
    );
    expect(FC.dayText('2026-11-04')).toBe('Wed 4 Nov');
    // The board's version: the same numbers with a fixed seed, without the long lists.
    const b = FC.boardForecast(q, { now: NOW, tz: TZ });
    expect(b).toEqual(FC.boardForecast(q, { now: NOW, tz: TZ }));
    expect(b.text).toContain('Focus "X": 14 tasks left.');
    expect('throughput' in b || 'ids' in b).toBe(false);
  });
});

describe('queue.mjs forecast (against a temporary queue)', () => {
  const temporary: string[] = [];
  afterAll(() => {
    for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
  });

  it('prints one paragraph, --json gives the numbers, --project narrows and an unknown project is refused', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-forecast-'));
    temporary.push(folder);
    const now = Date.now();
    const tasks = [
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `D-${i}`,
        title: 'done',
        class: 'K',
        status: 'done',
        project: 'p1',
        done: new Date(now - i * DAY).toISOString(),
        cost: { usd: 2 },
      })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `W-${i}`, title: 'w', class: 'K', status: 'waiting', project: 'p1' })),
      { id: 'O-1', title: 'other', class: 'K', status: 'waiting', project: 'p2' },
    ];
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ limits: {}, resolved: [], projects: { p1: { title: 'One' }, p2: { title: 'Two' } }, tasks }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, '{}');
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: folder,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_FORECAST_SEED: '5',
    };
    const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const text = run('forecast');
    expect(text.code).toBe(0);
    expect(text.out.trim()).toMatch(
      /^The queue: 7 tasks left\. 50 %: by .+ \(\d+ days?\), 85 %: .+, 95 %: .+\. Based on 20 done in the last 28 days\. Expected cost about 14 USD\.$/,
    );
    const json = JSON.parse(run('forecast', '--json').out) as Forecast;
    expect(json.remaining).toBe(7);
    expect(json.sample).toBe(20);
    expect(json.p50!.days).toBeLessThanOrEqual(json.p95!.days);
    expect(json).toEqual(JSON.parse(run('forecast', '--json').out)); // the seed makes it repeatable
    const p2 = JSON.parse(run('forecast', '--project', 'p2', '--json', '--days', '14').out) as Forecast;
    expect(p2.remaining).toBe(1);
    expect(p2.windowDays).toBe(14);
    expect(p2.sample).toBe(14);
    expect(run('forecast', '--project', 'nope').code).toBe(1);
    expect(run('forecast', '--days', '0').code).toBe(1);
  });
});
