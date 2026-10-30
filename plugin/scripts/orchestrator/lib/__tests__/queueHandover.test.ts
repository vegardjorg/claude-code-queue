// =============================================================
// queueHandover.test.ts: the running handover note in two parts (lib/queueHandover.js + `queue.mjs handover`), the
// "Now" part in hook-after-compact.mjs, and the status line (statusline.mjs + lib/rateLimits.js).
//
// The rules are asserted where they are enforced: the pure functions (date parsing, the 24 h limit, inherited dates,
// "Now" and the active trial section, the 40-line warning, idempotence), and queue.mjs, the hook and the status line run
// as processes against a temporary data folder (QUEUE_FOLDER), so the file writes, the monthly archive file and --dry
// are the real ones.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

type Result = {
  keep: string;
  archive: Record<string, string>;
  moved: number;
  movedLines: number;
  nowLines: number | null;
  warnings: string[];
};
const HO = require('../queueHandover.js') as {
  NOW_MAX_LINES: number;
  parseDate: (
    t: string,
    now: Date,
    o?: { wholeText?: boolean },
  ) => { time?: Date; timeOnly?: { hour: number; minute: number } } | null;
  activeTrial: (heading: string, now: Date) => boolean;
  nowPart: (t: string, max?: number) => string | null;
  archive: (t: string, now?: Date) => Result;
};
const RL = require('../rateLimits.js') as {
  fromStatusInput: (input: unknown, now?: number) => unknown;
  shouldWrite: (prev: unknown, next: unknown, now?: number) => boolean;
  observedPercent: (obs: unknown, o?: { now?: number }) => { percent?: number; error?: string };
};

// Local time, as in the note (the orchestrator writes local time).
const NOW = new Date(2026, 9, 30, 10, 0); // 30.10.2026 10:00

const NOTE = [
  '# Running handover note',
  '',
  'Intro that always stays.',
  '',
  '## Now (30.10 morning)',
  'Active: A, B.',
  'Push: last abc.',
  '',
  '## Compact trial (08.10 to 15.10)',
  '- 09.10: old trial log',
  '',
  '## Follow up: load watch (28.10 to 05.11)',
  '- 28.10: active trial log stays',
  '',
  '## 2026-10-09 (after compaction 20)',
  "- undated line inherits the heading's date",
  '  indented continuation goes along',
  '',
  '## Log',
  '- 2026-10-24: ISO dated, old',
  '## 18:39 only a time (inherits the date above)',
  '- 29.10: yesterday without a time counts until the end of the day',
  '- 29.10 09:2x: yesterday morning, over 24 h',
  '- 29.10 10:3x: under 24 h',
  '- 30.10 09:4x: today',
  '',
].join('\n');

describe('queueHandover: date parsing', () => {
  it('reads ISO, DD.MM, DD.MM.YYYY, time first and approximate minutes', () => {
    expect(HO.parseDate('- 2026-10-24: x', NOW)?.time).toEqual(new Date(2026, 9, 24, 23, 59, 59, 999));
    expect(HO.parseDate('- 2026-10-07T1830 x', NOW)?.time).toEqual(new Date(2026, 9, 7, 18, 30, 59, 999));
    expect(HO.parseDate('- 29.10 09:2x: x', NOW)?.time).toEqual(new Date(2026, 9, 29, 9, 29, 59, 999));
    expect(HO.parseDate('- 18:39 24.10: x', NOW)?.time).toEqual(new Date(2026, 9, 24, 18, 39, 59, 999));
    expect(HO.parseDate('## STATUS 18.10.2026 evening', NOW, { wholeText: true })?.time).toEqual(
      new Date(2026, 9, 18, 23, 59, 59, 999),
    );
    expect(HO.parseDate('## 18:39 x', NOW)).toEqual({ timeOnly: { hour: 18, minute: 39 } });
  });

  it('DD.MM without a year that would lie over a month ahead is last year', () => {
    expect(HO.parseDate('- 20.12: x', NOW)?.time?.getFullYear()).toBe(2025);
    expect(HO.parseDate('- 05.11: x', NOW)?.time?.getFullYear()).toBe(2026);
  });

  it('gives null for lines without a date and for invalid dates, and looks only at the start of the log line', () => {
    expect(HO.parseDate('- MO-6c done (db push 4640-4641)', NOW)).toBeNull();
    expect(HO.parseDate('- 31.02: x', NOW)).toBeNull();
    expect(HO.parseDate('- something long first, then a date far out 24.10', NOW)).toBeNull();
  });
});

describe('queueHandover: archive', () => {
  it('moves only entries older than 24 h, and keeps the header, "Now" and the active trial section', () => {
    const r = HO.archive(NOTE, NOW);
    expect(r.keep).toContain('Intro that always stays.');
    expect(r.keep).toContain('## Now (30.10 morning)');
    expect(r.keep).toContain('- 28.10: active trial log stays');
    expect(r.keep).toContain('- 29.10: yesterday without a time');
    expect(r.keep).toContain('- 29.10 10:3x: under 24 h');
    expect(r.keep).toContain('- 30.10 09:4x: today');
    for (const gone of [
      'old trial log',
      "inherits the heading's date",
      'indented continuation',
      'ISO dated',
      '18:39',
      'yesterday morning',
    ])
      expect(r.keep).not.toContain(gone);
    // Sections where everything moved disappear with their heading; an expired trial is archived as a normal log.
    expect(r.keep).not.toContain('## Compact trial');
    expect(r.keep).not.toContain('## 2026-10-09');
    expect(r.moved).toBe(5);
    expect(r.movedLines).toBe(6);
    expect(Object.keys(r.archive)).toEqual(['2026-10']);
    const archived = r.archive['2026-10'];
    expect(archived).toContain(
      "## 2026-10-09 (after compaction 20)\n- undated line inherits the heading's date\n  indented",
    );
    expect(archived).toContain('## Log\n- 2026-10-24: ISO dated, old\n## 18:39 only a time');
    expect(r.nowLines).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  it('archives per month by the entry date', () => {
    const r = HO.archive('## Now\nx\n\n## Log\n- 2026-09-30: sept\n- 2026-10-01: oct\n', NOW);
    expect(Object.keys(r.archive).sort()).toEqual(['2026-09', '2026-10']);
    expect(r.archive['2026-09']).toBe('## Log\n- 2026-09-30: sept\n');
  });

  it('is idempotent: a second run moves nothing and leaves the note as it is', () => {
    const first = HO.archive(NOTE, NOW);
    const second = HO.archive(first.keep, NOW);
    expect(second.moved).toBe(0);
    expect(second.keep).toBe(first.keep);
  });

  it('leaves entries without any time (own, inherited or heading date) in place', () => {
    const r = HO.archive('## Now\nx\n\n## Misc\n- without a date\n', NOW);
    expect(r.moved).toBe(0);
    expect(r.keep).toContain('- without a date');
  });

  it('warns when "Now" has over 40 lines or is missing', () => {
    const long = ['## Now', ...Array.from({ length: HO.NOW_MAX_LINES + 1 }, (_, i) => `- line ${i}`)].join('\n');
    expect(HO.archive(long, NOW).warnings[0]).toMatch(/41 lines, the limit is 40/);
    expect(HO.archive(['## Now', ...Array.from({ length: 40 }, () => '- x')].join('\n'), NOW).warnings).toEqual([]);
    expect(HO.archive('## Log\n- x\n', NOW).warnings[0]).toMatch(/no "## Now" section/);
  });

  it('active trial: the end date today or later, or no date', () => {
    expect(HO.activeTrial('## Compact trial (08.10 to 15.10)', NOW)).toBe(false);
    expect(HO.activeTrial('## Compact trial (25.10 to 30.10)', NOW)).toBe(true);
    expect(HO.activeTrial('## Follow up: something', NOW)).toBe(true);
    expect(HO.activeTrial('## Log 25.10 to 30.10', NOW)).toBe(false);
  });

  it('nowPart gives only the "Now" section, cut at max', () => {
    expect(HO.nowPart(NOTE)).toBe('## Now (30.10 morning)\nActive: A, B.\nPush: last abc.');
    expect(HO.nowPart(NOTE, 1)).toBe('## Now (30.10 morning)\nActive: A, B.\n(… 1 more lines in the note)');
    expect(HO.nowPart('## Log\n- x')).toBeNull();
  });
});

describe('rateLimits: the calibration point from the status line', () => {
  const T = Date.UTC(2026, 9, 30, 9, 0);
  const input = { rate_limits: { five_hour: { used_percentage: 23 }, seven_day: { used_percentage: 41, resets_at: T / 1000 + 86_400 } } };

  it('reads the windows, and writes when the percentages change or every 15 min', () => {
    const r = RL.fromStatusInput(input, T) as { seven_day: { used_percentage: number } };
    expect(r.seven_day.used_percentage).toBe(41);
    expect(RL.fromStatusInput({}, T)).toBeNull();
    expect(RL.shouldWrite(null, r, T)).toBe(true);
    expect(RL.shouldWrite(r, r, T + 60_000)).toBe(false);
    expect(RL.shouldWrite(r, r, T + 15 * 60_000)).toBe(true);
    expect(RL.shouldWrite(r, RL.fromStatusInput({ rate_limits: { seven_day: { used_percentage: 42 } } }, T), T + 1)).toBe(true);
  });

  it('gives the 7-day percentage, and refuses an old reading or one from a reset week', () => {
    const r = RL.fromStatusInput(input, T);
    expect(RL.observedPercent(r, { now: T + 10 * 60_000 }).percent).toBe(41);
    expect(RL.observedPercent(r, { now: T + 2 * 3_600_000 }).error).toMatch(/min old/);
    expect(RL.observedPercent(null, { now: T }).error).toMatch(/no 7-day percentage/);
    const reset = RL.fromStatusInput({ rate_limits: { seven_day: { used_percentage: 5, resets_at: T / 1000 - 1 } } }, T);
    expect(RL.observedPercent(reset, { now: T + 1 }).error).toMatch(/already reset/);
  });
});

describe('queue.mjs handover, hook-after-compact and statusline.mjs (against a temporary data folder)', () => {
  let folder: string;
  const script = (name: string) => join(__dirname, '..', '..', name);
  const env = () => ({ ...process.env, QUEUE_FOLDER: folder, QUEUE_GIT: folder });
  const cq = (...args: string[]) =>
    execFileSync(process.execPath, [script('queue.mjs'), 'handover', ...args], { encoding: 'utf8', env: env() });
  const note = () => join(folder, 'handover-ongoing.md');

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-handover-'));
    // Dates far back, so the test does not depend on when it runs.
    writeFileSync(note(), '# Note\n\n## Now\n- active: A\n\n## Log\n- 2020-01-05: old\n- 2020-01-06: also old\n');
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('--dry writes nothing', () => {
    expect(cq('archive', '--dry')).toMatch(/dry run.*2 entries/);
    expect(existsSync(join(folder, 'handover-archive'))).toBe(false);
    expect(readFileSync(note(), 'utf8')).toContain('old');
  });

  it('archive moves to handover-archive/<year-month>.md, and a second run moves nothing', () => {
    expect(cq('archive')).toMatch(/2 entries \(2 lines\) moved to handover-archive\/2020-01\.md/);
    expect(readFileSync(note(), 'utf8')).toBe('# Note\n\n## Now\n- active: A\n');
    const archived = readFileSync(join(folder, 'handover-archive', '2020-01.md'), 'utf8');
    expect(archived).toMatch(/<!-- archived .* -->\n## Log\n- 2020-01-05: old\n- 2020-01-06: also old\n$/);
    expect(cq('archive')).toMatch(/0 entries/);
    expect(readFileSync(join(folder, 'handover-archive', '2020-01.md'), 'utf8')).toBe(archived);
  });

  it('now prints only the "Now" part', () => {
    expect(cq('now').trim()).toBe('## Now\n- active: A');
  });

  it('hook-after-compact adds only the "Now" part, not the log', () => {
    writeFileSync(join(folder, 'orchestrator.json'), JSON.stringify({ session_id: 's1' }));
    const out = execFileSync(process.execPath, [script('hook-after-compact.mjs')], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 's1', source: 'compact' }),
      env: env(),
    });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('"Now" part');
    expect(ctx).toContain('handover archive');
    expect(ctx).toContain('## Now\n- active: A');
    expect(ctx).not.toContain('2020-01-05');
  });

  it('statusline.mjs (smoke test with a sample payload): one line, "-" for missing fields, quiet failure', () => {
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        tasks: [{ status: 'running' }, { status: 'running' }, { status: 'review' }, { status: 'done' }],
      }),
    );
    const line = (input: string) =>
      execFileSync(process.execPath, [script('statusline.mjs')], {
        encoding: 'utf8',
        input,
        env: { ...env(), QUEUE_STATUSLINE_CACHE: join(folder, 'cache.json') },
      });
    const full = JSON.stringify({
      cost: { total_cost_usd: 3.2149 },
      context_window: { total_input_tokens: 142310, context_window_size: 200000, used_percentage: 71.2 },
      rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 1 }, seven_day: { used_percentage: 41 } },
    });
    expect(line(full)).toBe('ctx 142k 71% | $3.21 | 5h 23% 7d 41% | tracks 2 (+1 review)\n');
    // The second time from the cache (same mtime and size), the same answer.
    expect(existsSync(join(folder, 'cache.json'))).toBe(true);
    expect(line(full)).toBe('ctx 142k 71% | $3.21 | 5h 23% 7d 41% | tracks 2 (+1 review)\n');
    // The quota reading was saved for `cq capacity --calibrate auto`.
    expect(JSON.parse(readFileSync(join(folder, 'rate-limits.json'), 'utf8')).seven_day.used_percentage).toBe(41);
    expect(line('{}')).toBe('ctx - | $- | 5h - 7d - | tracks 2 (+1 review)\n');
    expect(
      line(JSON.stringify({ context_window: { total_input_tokens: 50000, context_window_size: 1000000 } })),
    ).toMatch(/^ctx 50k 5% /);
    expect(line('not json')).toBe('statusline: -\n');
  });
});
