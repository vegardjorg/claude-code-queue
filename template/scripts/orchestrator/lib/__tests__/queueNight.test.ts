// =============================================================
// queueNight.test.ts: the night pause in workQueue (lib/queueLogic.js and queue.mjs).
//
// With `limits.nightRun` = false no new tasks are started inside the night window (`limits.nightWindow`, default
// "23-06", Oslo time): `queue.mjs next` proposes nothing and `start` refuses, both with exit 5 and "Night pause until 06:00"
// (the same pattern as the budget guard, exit 4). `start --force` overrides. The default (on) gives unchanged behavior.
// The tests prove the rules where they are enforced: the pure functions in queueLogic, and queue.mjs against a copy of the queue in a
// temporary folder (QUEUE_FOLDER), with a nightWindow that always covers the current time.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Task = {
  id: string;
  title?: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  depends_on?: string[];
  started?: string;
};
type Queue = {
  tasks: Task[];
  limits?: Record<string, number | boolean | string | null>;
  next_migr?: number;
};
type Window = { from: number; to: number };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  DEFAULT_LIMITS: Record<string, unknown>;
  LIMIT_NAME: string[];
  parseNightWindow: (s: string) => Window | null;
  inNightWindow: (v: Window | null, now: number) => boolean;
  nightGuard: (
    queue: Queue,
    now?: number,
  ) => { active: boolean; stop: boolean; to?: string; message?: string };
  startGuard: (
    queue: Queue,
    dailyUsage?: number,
    option?: { now?: number; force?: boolean },
  ) => { code: number; stop: string; message: string } | null;
  state: (
    queue: Queue,
    dailyUsage?: number,
    option?: { now?: number },
  ) => {
    empty: boolean;
    canStart: number;
    stop?: string;
    night?: string;
    blocked: { id: string; blockers: string[] }[];
  };
  parseLimit: (
    name: string,
    raw: string,
    current?: Record<string, unknown>,
  ) => { val: unknown } | { error: string };
  limitText: (name: string, v: unknown) => string;
};

// 30.09.2026 is summer time (UTC+2); 01.12.2026 is standard time (UTC+1).
const oslo = (iso: string) => Date.parse(iso);
const NIGHT_SUMMER = oslo('2026-09-30T21:30:00Z'); // 23:30 in Oslo
const EVENING_SUMMER = oslo('2026-09-30T20:30:00Z'); // 22:30 in Oslo
const MORNING_IN = oslo('2026-10-01T03:59:00Z'); // 05:59 in Oslo
const MORNING_OUT = oslo('2026-10-01T04:00:00Z'); // 06:00 in Oslo
const NIGHT_WINTER = oslo('2026-12-01T22:00:00Z'); // 23:00 in Oslo (standard time)
const EVENING_WINTER = oslo('2026-12-01T21:59:00Z'); // 22:59 in Oslo

const up = (id: string, field: Partial<Task> = {}): Task => ({
  id,
  title: id,
  domain: 'client',
  class: 'K',
  status: 'waiting',
  mission: 'x',
  ...field,
});

describe('the night window (Oslo time)', () => {
  const standard = L.parseNightWindow('23-06');

  it('inside and outside the window "23-06", with summer time and standard time', () => {
    expect(L.inNightWindow(standard, NIGHT_SUMMER)).toBe(true);
    expect(L.inNightWindow(standard, EVENING_SUMMER)).toBe(false);
    expect(L.inNightWindow(standard, NIGHT_WINTER)).toBe(true);
    expect(L.inNightWindow(standard, EVENING_WINTER)).toBe(false);
  });

  it('window over midnight: applies until 06:00, not from 06:00', () => {
    expect(L.inNightWindow(standard, MORNING_IN)).toBe(true);
    expect(L.inNightWindow(standard, MORNING_OUT)).toBe(false);
  });

  it('window within the same day ("01-05")', () => {
    const v = L.parseNightWindow('01-05');
    expect(L.inNightWindow(v, oslo('2026-09-30T00:00:00Z'))).toBe(true); // 02:00
    expect(L.inNightWindow(v, oslo('2026-09-30T03:00:00Z'))).toBe(false); // 05:00
    expect(L.inNightWindow(v, oslo('2026-09-29T22:30:00Z'))).toBe(false); // 00:30
  });
});

describe('nightGuard and startGuard', () => {
  const queue = (limits: Queue['limits'] = {}): Queue => ({ tasks: [up('A')], limits });

  it('default (nightRun on) gives unchanged behavior, also in the middle of the night', () => {
    expect(L.DEFAULT_LIMITS.nightRun).toBe(true);
    expect(L.DEFAULT_LIMITS.nightWindow).toBe('23-06');
    expect(L.nightGuard(queue(), NIGHT_SUMMER)).toEqual({ active: false, stop: false });
    expect(L.startGuard(queue(), 0, { now: NIGHT_SUMMER })).toBeNull();
    const t = L.state(queue(), 0, { now: NIGHT_SUMMER });
    expect(t.canStart).toBe(1);
    expect(t.stop).toBeUndefined();
  });

  it('nightRun off: stops inside the window with exit 5 and "Night pause until 06:00", not outside it', () => {
    const k = queue({ nightRun: false });
    const inside = L.startGuard(k, 0, { now: NIGHT_SUMMER });
    expect(inside?.code).toBe(5);
    expect(inside?.stop).toBe('nightPause');
    expect(inside?.message).toMatch(/^Night pause until 06:00/);
    expect(L.startGuard(k, 0, { now: EVENING_SUMMER })).toBeNull();
    expect(L.nightGuard(k, EVENING_SUMMER)).toMatchObject({ active: true, stop: false });
  });

  it('--force (owner word) overrides the night pause', () => {
    expect(
      L.startGuard(queue({ nightRun: false }), 0, { now: NIGHT_SUMMER, force: true }),
    ).toBeNull();
  });

  it('the budget guard goes first (exit 4) when both stop', () => {
    const k = queue({ nightRun: false, dailyBudget: 10 });
    expect(L.startGuard(k, 20, { now: NIGHT_SUMMER })?.code).toBe(4);
  });

  it('state: nothing can start, stop nightPause, and the pending task gets the night pause as a blocker', () => {
    const t = L.state(queue({ nightRun: false }), 0, { now: NIGHT_SUMMER });
    expect(t.canStart).toBe(0);
    expect(t.stop).toBe('nightPause');
    expect(t.night).toMatch(/^Night pause until 06:00/);
    expect(t.blocked).toEqual([{ id: 'A', blockers: ['nightPause until 06:00'] }]);
  });

  it('a custom window sets the time in the message', () => {
    const k = queue({ nightRun: false, nightWindow: '22-07' });
    expect(L.startGuard(k, 0, { now: EVENING_SUMMER })?.message).toMatch(/^Night pause until 07:00/);
  });
});

describe('limit: validation', () => {
  it('nightRun and nightWindow are limits', () => {
    expect(L.LIMIT_NAME).toEqual(expect.arrayContaining(['nightRun', 'nightWindow']));
  });

  it('nightWindow rejects a wrong format', () => {
    for (const error of ['2306', '23-6', '24-06', '23-23', '', 'ab-cd', '23 - 06', '-1-06'])
      expect(L.parseLimit('nightWindow', error)).toHaveProperty('error');
    expect(L.parseLimit('nightWindow', '23-06')).toEqual({ val: '23-06' });
    expect(L.parseLimit('nightWindow', ' 00-05 ')).toEqual({ val: '00-05' });
  });

  it('nightRun: on or off', () => {
    expect(L.parseLimit('nightRun', 'on')).toEqual({ val: true });
    expect(L.parseLimit('nightRun', 'ON')).toEqual({ val: true });
    expect(L.parseLimit('nightRun', 'off')).toEqual({ val: false });
    expect(L.parseLimit('nightRun', 'maybe')).toHaveProperty('error');
    expect(L.limitText('nightRun', false)).toBe('off');
    expect(L.limitText('nightRun', true)).toBe('on');
  });

  it('max*: integer ≥ 0; maxDPlus at most maxConcurrent, maxDb can be larger', () => {
    expect(L.parseLimit('maxConcurrent', '0')).toEqual({ val: 0 });
    for (const error of ['-1', '1.5', '', 'five'])
      expect(L.parseLimit('maxConcurrent', error)).toHaveProperty('error');
    const g = { maxConcurrent: 5 };
    expect(L.parseLimit('maxDPlus', '9', g)).toEqual({
      error: 'maxDPlus cannot be larger than maxConcurrent (5)',
    });
    // Picked tasks count in maxDb, but not in maxConcurrent: 6 and 5 make sense together.
    expect(L.parseLimit('maxDb', '6', g)).toEqual({ val: 6 });
    expect(L.parseLimit('maxDb', '5', g)).toEqual({ val: 5 });
    // maxConcurrent itself can be set lower (0 stops the queue).
    expect(L.parseLimit('maxConcurrent', '0', { maxConcurrent: 5, maxDb: 6 })).toEqual({ val: 0 });
  });
});

// ---- queue.mjs against a copy of the queue (never the real one) ----
describe('queue.mjs: nightPause and limit', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;

  // A two-hour window from the current hour (Oslo time) always covers the time while the test runs.
  const timeNow = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Oslo',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  const pad = (x: number) => String(x % 24).padStart(2, '0');
  const windowNow = `${pad(timeNow)}-${pad(timeNow + 2)}`;

  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: String(x.stdout ?? ''), error: String(x.stderr ?? '') };
    }
  }
  const readQueue = (): Queue => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-night-'));
    const queue: Queue = {
      tasks: [up('A')],
      limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 5 },
      next_migr: 100,
    };
    writeFileSync(join(folder, 'queue.json'), JSON.stringify(queue));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('default: next proposes as before', () => {
    const r = run(['next']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('A');
  });

  it('nightRun off inside the window: next and start give exit 5, start --force starts', () => {
    expect(run(['limit', 'nightWindow', windowNow]).code).toBe(0);
    const off = run(['limit', 'nightRun', 'off']);
    expect(off.code).toBe(0);
    expect(off.out).toContain('nightRun = off');
    const next = run(['next']);
    expect(next.code).toBe(5);
    expect(next.error).toMatch(/Night pause until \d\d:00/);
    expect(run(['start', 'A']).code).toBe(5);
    expect(readQueue().tasks[0].status).toBe('waiting');
    const force = run(['start', 'A', '--force']);
    expect(force.code).toBe(0);
    expect(readQueue().tasks[0].status).toBe('running');
  });

  it('limit rejects a wrong nightWindow and maxDPlus over maxConcurrent, without editing the queue', () => {
    const window = run(['limit', 'nightWindow', '2306']);
    expect(window.code).toBe(1);
    expect(window.error).toContain('HH-HH');
    const dplus = run(['limit', 'maxDPlus', '9']);
    expect(dplus.code).toBe(1);
    expect(dplus.error).toContain('cannot be larger than maxConcurrent (5)');
    expect(readQueue().limits).toEqual({
      maxConcurrent: 5,
      maxDPlus: 2,
      maxPerDomain: 7,
      maxDb: 5,
    });
  });

  it('limit accepts maxDb over maxConcurrent (picked tasks count only in maxDb)', () => {
    const r = run(['limit', 'maxDb', '6']);
    expect(r.code).toBe(0);
    expect(readQueue().limits?.maxDb).toBe(6);
  });
});
