// =============================================================
// queueFollow.test.ts: the "Follow up" entries in the work queue (lib/queueFollow.js + `queue.mjs follow`).
//
// A follow-up entry is an observation with a start, an end, goals, a log and a fixed report template. The rules are
// asserted where they are enforced: the pure functions in queueFollow.js (data model, validation, due date, log,
// extend, report and the view lines), and queue.mjs follow against a temporary data folder (QUEUE_FOLDER), so the lock,
// the storage in follow.json and the report file are the real ones.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

type Goal = { name: string; how: string; expected: string };
type Log = { at: string; source: string; text?: string; values?: Record<string, string> };
type Entry = {
  id: string;
  title: string;
  why: string;
  start: string;
  end: string;
  status: string;
  owner: string;
  goals: Goal[];
  log: Log[];
  report_template: string[];
  related?: { tasks?: string[]; memory?: string[] };
  close_action?: string[];
  decision?: string;
  report?: string;
};
type Register = { entries: Entry[]; changed?: string | null };
type Answer = { error: string[]; entry?: Entry };

const F = require('../queueFollow.js') as {
  STATUSES: string[];
  REPORT_TEMPLATE: string[];
  LOCAL_TZ: string;
  emptyRegister: () => Register;
  normalize: (r: unknown) => Register;
  dayDate: (now: Date, tz?: string) => string;
  effectiveStatus: (p: Entry, today: string) => string;
  add: (r: Register, input: unknown, o: { now: string }) => Answer;
  log: (
    r: Register,
    id: string,
    input: { text?: string; values?: Record<string, string>; source?: string },
    o: { now: string },
  ) => Answer;
  extend: (r: Register, id: string, to: string, o: { now: string }) => Answer;
  close: (
    r: Register,
    id: string,
    input: { decision: string; cancelled?: boolean },
    o: { now: string },
  ) => Answer;
  markReported: (r: Register, id: string, path: string, o: { now: string }) => Answer;
  reportText: (p: Entry, o: { now: string }) => string;
  shortLines: (r: Register, today: string, o?: { pulse?: boolean }) => string[];
  listLines: (r: Register, today: string) => string[];
  showLines: (p: Entry, today: string) => string[];
  boardData: (r: Register, today: string) => { today: string; lines: string[]; entries: (Entry & { decided: boolean })[] };
};

const NOW = '2026-10-10T08:00:00.000Z';
const baseEntry = () => ({
  id: 'F-TEST',
  title: 'Trial of something',
  why: 'Does it hold over time?',
  start: '2026-10-08',
  end: '2026-10-15',
  owner: 'orchestrator',
  goals: [
    { name: 'count', how: 'count in the log', expected: '>= 1' },
    { name: 'loss', how: 'read the handover note', expected: 'no' },
  ],
});
const withEntry = (over: Record<string, unknown> = {}) => {
  const r = F.emptyRegister();
  const s = F.add(r, { ...baseEntry(), ...over }, { now: NOW });
  expect(s.error).toEqual([]);
  return r;
};

describe('queueFollow: data model and validation', () => {
  it('add fills in the defaults (status active, empty log, the fixed report template)', () => {
    const p = withEntry().entries[0];
    expect(p.status).toBe('active');
    expect(p.log).toEqual([]);
    expect(p.report_template).toEqual([
      'Question',
      'Setup',
      'Measurements',
      'Findings',
      'Deviations and losses',
      'Recommendation',
      'Owner decision',
    ]);
    expect(F.STATUSES).toEqual(['active', 'to-report', 'reported', 'cancelled']);
  });

  it('end must be after start (the same day and before are refused)', () => {
    for (const end of ['2026-10-08', '2026-10-01']) {
      const r = F.emptyRegister();
      expect(F.add(r, { ...baseEntry(), end }, { now: NOW }).error.join(' ')).toMatch(/end .* after start/);
      expect(r.entries).toEqual([]);
    }
  });

  it('the id must be unique and have the prefix F-', () => {
    const r = withEntry();
    expect(F.add(r, baseEntry(), { now: NOW }).error.join(' ')).toMatch(/already exists/);
    expect(F.add(r, { ...baseEntry(), id: 'COMPACT' }, { now: NOW }).error.join(' ')).toMatch(/F-/);
    expect(r.entries).toHaveLength(1);
  });

  it('refuses invalid dates, missing fields, unknown status and double goal names', () => {
    const r = F.emptyRegister();
    const s = F.add(
      r,
      {
        ...baseEntry(),
        start: '2026-13-01',
        title: '',
        status: 'ongoing',
        goals: [
          { name: 'a', how: 'x', expected: '1' },
          { name: 'a', how: 'y', expected: '2' },
        ],
      },
      { now: NOW },
    );
    const t = s.error.join(' | ');
    expect(t).toMatch(/start/);
    expect(t).toMatch(/title/);
    expect(t).toMatch(/status/);
    expect(t).toMatch(/twice/);
    expect(r.entries).toEqual([]);
  });

  it('requires at least one goal with name, how and expected', () => {
    const r = F.emptyRegister();
    expect(F.add(r, { ...baseEntry(), goals: [] }, { now: NOW }).error.join(' ')).toMatch(/at least one goal/);
    expect(F.add(r, { ...baseEntry(), goals: [{ name: 'a' }] }, { now: NOW }).error.join(' ')).toMatch(/how/);
  });

  it('accepts related and close_action (text or list) and refuses the wrong type', () => {
    const r = withEntry({
      related: { tasks: ['Q-COMPACT-2'], memory: ['compact-trial'] },
      close_action: 'cq compact manual',
    });
    expect(r.entries[0].close_action).toEqual(['cq compact manual']);
    const s = F.add(F.emptyRegister(), { ...baseEntry(), related: { tasks: 'X' } }, { now: NOW });
    expect(s.error.join(' ')).toMatch(/related/);
  });

  it('a log that comes with add must have at, source and known goal names', () => {
    const ok = withEntry({
      log: [{ at: NOW, source: 'memory', text: 'moved from the memory', values: { count: '1' } }],
    });
    expect(ok.entries[0].log).toHaveLength(1);
    const s = F.add(
      F.emptyRegister(),
      { ...baseEntry(), log: [{ at: NOW, source: 'x', values: { unknown: '1' } }, { text: 'y' }] },
      { now: NOW },
    );
    expect(s.error.join(' ')).toMatch(/unknown goal unknown/);
    expect(s.error.join(' ')).toMatch(/log\[1\] must have at and source/);
  });

  it('normalize tolerates an empty or broken file', () => {
    expect(F.normalize(null).entries).toEqual([]);
    expect(F.normalize({ entries: 'x' }).entries).toEqual([]);
  });
});

describe('queueFollow: due date', () => {
  it('active becomes to-report when the end date is reached', () => {
    const p = withEntry().entries[0];
    expect(F.effectiveStatus(p, '2026-10-14')).toBe('active');
    expect(F.effectiveStatus(p, '2026-10-15')).toBe('to-report');
    expect(F.effectiveStatus(p, '2026-10-30')).toBe('to-report');
    expect(F.effectiveStatus({ ...p, status: 'reported' }, '2026-10-30')).toBe('reported');
    expect(F.effectiveStatus({ ...p, status: 'cancelled' }, '2026-10-30')).toBe('cancelled');
  });

  it('dayDate follows the local time zone of the machine, not UTC', () => {
    expect(F.LOCAL_TZ).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // The local calendar day of the moment, computed with the Date's own local fields.
    const at = new Date('2026-10-14T22:30:00Z');
    const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    expect(F.dayDate(at)).toBe(local);
    // An explicit zone: 22:30 UTC on 14.10 is 15.10 in Oslo and still 14.10 in New York.
    expect(F.dayDate(at, 'Europe/Oslo')).toBe('2026-10-15');
    expect(F.dayDate(at, 'America/New_York')).toBe('2026-10-14');
  });

  it('shortLines: one line with the active ones, and a clear TO REPORT when the end is reached', () => {
    const r = withEntry();
    F.add(r, { ...baseEntry(), id: 'F-OTHER', start: '2026-10-01', end: '2026-12-01' }, { now: NOW });
    const before = F.shortLines(r, '2026-10-10');
    expect(before).toHaveLength(1);
    expect(before[0]).toMatch(/FOLLOW UP: 2 active/);
    expect(before[0]).not.toMatch(/TO REPORT/);
    const after = F.shortLines(r, '2026-10-20', { pulse: true });
    expect(after.join('\n')).toMatch(/TO REPORT: F-TEST/);
    expect(after.join('\n')).toMatch(/cq follow report F-TEST/);
    expect(after.join('\n')).toMatch(/every pulse/);
  });

  it('shortLines is empty without open entries, and reminds of the decision after the report', () => {
    expect(F.shortLines(F.emptyRegister(), '2026-10-10')).toEqual([]);
    const r = withEntry();
    F.markReported(r, 'F-TEST', 'scripts/.queue/follow/F-TEST-report.md', { now: NOW });
    const l = F.shortLines(r, '2026-10-20').join('\n');
    expect(l).not.toMatch(/TO REPORT/);
    expect(l).toMatch(/waiting on an owner decision: F-TEST/);
    F.close(r, 'F-TEST', { decision: 'keep' }, { now: NOW });
    expect(F.shortLines(r, '2026-10-20')).toEqual([]);
  });

  it('boardData sorts the open ones first and marks the decided ones', () => {
    const r = withEntry();
    F.add(r, { ...baseEntry(), id: 'F-DONE', start: '2026-09-01', end: '2026-09-10' }, { now: NOW });
    F.close(r, 'F-DONE', { decision: 'stop' }, { now: NOW });
    const d = F.boardData(r, '2026-10-20');
    expect(d.entries.map((p) => [p.id, p.status, p.decided])).toEqual([
      ['F-TEST', 'to-report', false],
      ['F-DONE', 'reported', true],
    ]);
    expect(d.lines.join('\n')).toMatch(/TO REPORT: F-TEST/);
  });
});

describe('queueFollow: log, extend and close', () => {
  it('log adds text and goal values with time and source', () => {
    const r = withEntry();
    const s = F.log(r, 'F-TEST', { text: 'first', values: { count: '1' }, source: 'orchestrator' }, { now: NOW });
    expect(s.error).toEqual([]);
    expect(r.entries[0].log).toEqual([{ at: NOW, source: 'orchestrator', text: 'first', values: { count: '1' } }]);
  });

  it('log refuses an unknown goal name, an empty entry, an unknown id and closed entries', () => {
    const r = withEntry();
    expect(F.log(r, 'F-TEST', { values: { unknown: '1' } }, { now: NOW }).error.join(' ')).toMatch(/count, loss/);
    expect(F.log(r, 'F-TEST', {}, { now: NOW }).error.join(' ')).toMatch(/--text/);
    expect(F.log(r, 'F-NO', { text: 'x' }, { now: NOW }).error.join(' ')).toMatch(/Unknown/);
    F.close(r, 'F-TEST', { decision: 'off' }, { now: NOW });
    expect(F.log(r, 'F-TEST', { text: 'x' }, { now: NOW }).error.join(' ')).toMatch(/closed/);
    expect(r.entries[0].log.filter((l) => l.source !== 'queue.mjs follow close')).toEqual([]);
  });

  it('extend moves the end forward, sets to-report back to active and logs it', () => {
    const r = withEntry();
    r.entries[0].status = 'to-report';
    expect(F.extend(r, 'F-TEST', '2026-10-14', { now: NOW }).error.join(' ')).toMatch(/after the current end/);
    const s = F.extend(r, 'F-TEST', '2026-10-22', { now: NOW });
    expect(s.error).toEqual([]);
    expect(r.entries[0].end).toBe('2026-10-22');
    expect(r.entries[0].status).toBe('active');
    expect(r.entries[0].log.at(-1)?.text).toMatch(/2026-10-15 -> 2026-10-22/);
  });

  it('close requires a decision; --cancelled gives status cancelled', () => {
    const r = withEntry();
    expect(F.close(r, 'F-TEST', { decision: ' ' }, { now: NOW }).error.join(' ')).toMatch(/decision/);
    expect(F.close(r, 'F-TEST', { decision: 'stop', cancelled: true }, { now: NOW }).error).toEqual([]);
    expect(r.entries[0].status).toBe('cancelled');
    expect(r.entries[0].decision).toBe('stop');
    expect(F.close(r, 'F-TEST', { decision: 'again' }, { now: NOW }).error.join(' ')).toMatch(/already closed/);
  });
});

describe('queueFollow: the report', () => {
  it('has the fixed headings in order, with setup, measurements and log filled in', () => {
    const r = withEntry({ close_action: ['cq compact manual'] });
    F.log(r, 'F-TEST', { text: 'went well', values: { count: '2' } }, { now: NOW });
    F.log(r, 'F-TEST', { values: { count: '3', loss: 'no' } }, { now: '2026-10-12T09:00:00Z' });
    const t = F.reportText(r.entries[0], { now: NOW });
    const headings = [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(F.REPORT_TEMPLATE);
    expect(t).toContain('# F-TEST: Trial of something');
    expect(t).toContain('Does it hold over time?');
    expect(t).toContain('2026-10-08 to 2026-10-15');
    expect(t).toMatch(/count.*count in the log.*>= 1/);
    expect(t).toMatch(/last: 3/);
    expect(t).toContain('went well');
    expect(t).toContain('cq compact manual');
    expect(t).toMatch(/Owner decision\n\n\(not decided/);
  });

  it('fills in the owner decision when the entry is closed', () => {
    const r = withEntry();
    F.close(r, 'F-TEST', { decision: 'Keep auto.' }, { now: NOW });
    expect(F.reportText(r.entries[0], { now: NOW })).toMatch(/## Owner decision\n\nKeep auto\./);
  });
});

// ---- queue.mjs follow against a temporary data folder -------------------------------------------------------------
describe('queue.mjs follow', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder = '';
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_ROOT: folder,
          QUEUE_CONFIG: join(folder, 'queue.config.json'),
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
  const readReg = (): Register => JSON.parse(readFileSync(join(folder, 'follow.json'), 'utf8'));

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-follow-'));
    writeFileSync(join(folder, 'queue.json'), JSON.stringify({ tasks: [], limits: { maxConcurrent: 5 }, next_migr: 100 }));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('add, log, show, report and close (the entry is due, so show prints TO REPORT)', () => {
    const file = join(folder, 'entry.json');
    writeFileSync(
      file,
      JSON.stringify({ ...baseEntry(), start: '2026-01-01', end: '2026-01-08', close_action: 'cq compact manual' }),
    );
    const added = run(['follow', 'add', '--file', file]);
    expect(added.error).toBe('');
    expect(added.code).toBe(0);
    expect(run(['follow', 'add', '--file', file]).error).toMatch(/already exists/);

    const l = run(['follow', 'log', 'F-TEST', '--text', 'measured', '--value', 'count=4']);
    expect(l.code).toBe(0);
    expect(readReg().entries[0].log[0].values).toEqual({ count: '4' });

    expect(run(['follow']).out).toMatch(/F-TEST.*to-report/);
    expect(run(['follow', 'show', 'F-TEST']).out).toContain('count=4');
    expect(run(['show']).out).toMatch(/TO REPORT: F-TEST/);
    expect(run(['show', '--full']).out).toMatch(/TO REPORT: F-TEST/);
    expect(run(['orchestrator', 'pulse', '--session', 'test']).out).toMatch(/TO REPORT: F-TEST/);

    const rep = run(['follow', 'report', 'F-TEST']);
    expect(rep.code).toBe(0);
    const repFile = join(folder, 'follow', 'F-TEST-report.md');
    expect(existsSync(repFile)).toBe(true);
    expect(readFileSync(repFile, 'utf8')).toContain('## Deviations and losses');
    expect(readReg().entries[0].status).toBe('reported');
    expect(run(['show']).out).not.toMatch(/TO REPORT/);

    const c = run(['follow', 'close', 'F-TEST', '--decision', 'Back to manual.']);
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/Close action.*\n {2}cq compact manual/);
    expect(readFileSync(repFile, 'utf8')).toContain('Back to manual.');
    expect(readReg().entries[0].decision).toBe('Back to manual.');
  });

  it('extend and an invalid add change nothing when the validation fails', () => {
    const file = join(folder, 'entry.json');
    writeFileSync(file, JSON.stringify({ ...baseEntry(), end: '2026-10-01' }));
    expect(run(['follow', 'add', '--file', file]).code).toBe(1);
    expect(existsSync(join(folder, 'follow.json'))).toBe(false);
    writeFileSync(file, JSON.stringify(baseEntry()));
    expect(run(['follow', 'add', '--file', file]).code).toBe(0);
    expect(run(['follow', 'extend', 'F-TEST', '--to', '2026-10-01']).code).toBe(1);
    expect(run(['follow', 'extend', 'F-TEST', '--to', '2026-10-20']).code).toBe(0);
    expect(readReg().entries[0].end).toBe('2026-10-20');
  });

  it('a broken follow.json never stops show', () => {
    writeFileSync(join(folder, 'follow.json'), '{ not json');
    const r = run(['show']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WARNING: could not read .*follow\.json/);
  });
});
