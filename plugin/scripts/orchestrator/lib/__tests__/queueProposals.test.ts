// =============================================================
// queueProposals.test.ts: auto-accept of agent proposals by the owner's rules (lib/queueProposals.js). Default off.
//
// The rule is enforced in queueProposals.autoAcceptDecision (pure; the hard rules no setting overrides) and applied by
// queue.mjs add and `orchestrator pulse`, with `proposals log` and `proposals undo`. Both are tested here: every hard
// rule, the owner's rules, the log and undo, and queue.mjs against a temporary queue and repo (never the real queue).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Rules = { enabled: boolean; classes: string[]; maxEstimateMin: number | null; maxValue: number | null };
type Queue = { tasks: Task[]; auto_accepted?: { id: string; at: string; reason: string; undone?: string }[]; proposals?: unknown };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PR = require('../queueProposals.js') as {
  DEFAULT_RULES: Rules;
  LOG_CAP: number;
  rulesFor: (configRules: unknown, queue: unknown) => Rules;
  rulesError: (change: unknown) => string[];
  autoAcceptDecision: (task: Task, rules: Rules, ctx?: Record<string, unknown>) => { accept: boolean; reason: string };
  openLegalPlans: (reg: unknown) => Set<string>;
  applyAutoAccept: (queue: Queue, rules: Rules, ctx?: Record<string, unknown>, o?: Record<string, unknown>) => { id: string; reason: string }[];
  undoAutoAccept: (queue: Queue, id: string, now?: string) => string | null;
  boardData: (configRules: unknown, queue: unknown) => { rules: Rules; log: { id: string; canUndo: boolean }[] };
  boardArgs: (b: unknown) => { args?: string[]; error?: string };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KK = require('../queueConfig.js');

const ON: Rules = { enabled: true, classes: ['K', 'U'], maxEstimateMin: 120, maxValue: null };
const CTX = { protectedPaths: KK.STANDARD.protectedPaths, openLegalPlans: new Set(['PL-LEGAL']) };
const proposal = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  class: 'K',
  status: 'proposed',
  content_min: 30,
  value: 5,
  waiting_on: [],
  owned_files: ['src/feature.ts'],
  added_by: 'rev-1',
  ...extra,
});

describe('autoAcceptDecision: the hard rules (no setting overrides them)', () => {
  const cases: [string, Partial<Task>, RegExp][] = [
    ['class D', { class: 'D' }, /class D is never/],
    ['class D+', { class: 'D+' }, /class D\+ is never/],
    ['waiting_on', { waiting_on: ['Q-1'] }, /waits on Q-1/],
    ['a legal label', { labels: ['legal'] }, /label legal/],
    ['an owner label', { labels: ['owner-task'] }, /label owner-task/],
    ['a label starting with legal', { labels: ['legal-review'] }, /label legal-review/],
    ['a plan entry with open legal points', { plan: 'PL-LEGAL' }, /PL-LEGAL has open legal points/],
    ['a protected file', { owned_files: ['.claude/settings.json'] }, /protected path \.claude\/settings\.json/],
    ['a protected bare name', { owned_files: ['web/package.json'] }, /protected path web\/package\.json/],
    ['a folder that covers a protected one', { owned_files: ['plugin/'] }, /protected path plugin\//],
    ['a protected shared_patch', { shared_patch: ['scripts/orchestrator/queue.mjs'] }, /protected path/],
  ];
  for (const [name, extra, why] of cases)
    it(`never ${name}, even with the most permissive rules`, () => {
      const d = PR.autoAcceptDecision(proposal('A', extra), { ...ON, classes: ['K', 'U', 'D', 'D+'], maxEstimateMin: null }, CTX);
      expect(d.accept).toBe(false);
      expect(d.reason).toMatch(why);
    });

  it('never a task whose auto-accept the owner undid', () => {
    const d = PR.autoAcceptDecision(proposal('A'), ON, { ...CTX, undone: new Set(['A']) });
    expect(d).toEqual({ accept: false, reason: 'the owner undid an earlier auto-accept' });
  });

  it('only proposals', () => {
    expect(PR.autoAcceptDecision(proposal('A', { status: 'waiting' }), ON, CTX).accept).toBe(false);
  });
});

describe('autoAcceptDecision: the owner\'s rules', () => {
  it('off by default (the config default and an empty queue)', () => {
    const r = PR.rulesFor(KK.STANDARD.proposals.autoAccept, {});
    expect(r).toEqual({ enabled: false, classes: ['K'], maxEstimateMin: 60, maxValue: null });
    expect(PR.autoAcceptDecision(proposal('A'), r, CTX)).toEqual({ accept: false, reason: 'auto-accept is off' });
  });

  it('the queue\'s rules win over the config field by field, and D is dropped from a rule list', () => {
    const r = PR.rulesFor(KK.STANDARD.proposals.autoAccept, {
      proposals: { autoAccept: { enabled: true, classes: ['U', 'D'] } },
    });
    expect(r).toEqual({ enabled: true, classes: ['U'], maxEstimateMin: 60, maxValue: null });
  });

  it('class, estimate (content_min x class weight) and value', () => {
    const rules: Rules = { enabled: true, classes: ['K'], maxEstimateMin: 60, maxValue: 6 };
    expect(PR.autoAcceptDecision(proposal('A', { class: 'U' }), rules, CTX).reason).toMatch(/class U is not in the rules/);
    expect(PR.autoAcceptDecision(proposal('A', { content_min: 90 }), rules, CTX).reason).toMatch(/estimate 90 min is over 60/);
    expect(PR.autoAcceptDecision(proposal('A', { value: 8 }), rules, CTX).reason).toBe('value 8 is over 6');
    const ok = PR.autoAcceptDecision(proposal('A'), rules, CTX);
    expect(ok).toEqual({ accept: true, reason: 'class K, estimate 30 min <= 60, value 5 <= 6' });
  });

  it('rulesError refuses D, D+, unknown fields and bad numbers', () => {
    expect(PR.rulesError({ classes: ['K', 'D+'] })).toEqual(['class D+ is never auto-accepted (a hard rule)']);
    expect(PR.rulesError({ maxValue: 11 })[0]).toMatch(/maxValue must be a whole number 1-10/);
    expect(PR.rulesError({ maxEstimateMin: 'x' })[0]).toMatch(/maxEstimateMin/);
    expect(PR.rulesError({ nope: 1 })).toEqual(['unknown field nope']);
    expect(PR.rulesError({ enabled: true, classes: [], maxEstimateMin: null, maxValue: 3 })).toEqual([]);
  });

  it('openLegalPlans finds the entries with an open, AI-assessed or to-lawyer point', () => {
    const reg = {
      entries: [
        { id: 'P1', legal: { points: [{ id: 'J1', status: 'resolved' }] } },
        { id: 'P2', legal: { points: [{ id: 'J2', status: 'to-lawyer' }] } },
        { id: 'P3', legal: { points: [{ id: 'J3' }] } },
        { id: 'P4' },
      ],
    };
    expect([...PR.openLegalPlans(reg)]).toEqual(['P2', 'P3']);
  });
});

describe('applyAutoAccept and undoAutoAccept', () => {
  it('approves through the approve path, adds a remark and a log entry; undo goes back to proposed once', () => {
    const queue: Queue = { tasks: [proposal('A'), proposal('B', { class: 'D' }), proposal('C')] };
    const now = '2026-10-31T10:00:00.000Z';
    const acc = PR.applyAutoAccept(queue, ON, CTX, { now, ids: ['A', 'B'] });
    expect(acc.map((x) => x.id)).toEqual(['A']);
    const a = queue.tasks[0];
    expect(a.status).toBe('waiting');
    expect(a.approved).toBe(now);
    expect((a.remarks as string[])[0]).toMatch(/auto-accepted by the owner's rules: class K/);
    expect(queue.tasks[1].status).toBe('proposed');
    expect(queue.tasks[2].status).toBe('proposed'); // not in ids
    expect(queue.auto_accepted).toEqual([{ id: 'A', at: now, reason: acc[0].reason }]);
    expect(PR.boardData({}, queue).log).toEqual([expect.objectContaining({ id: 'A', canUndo: true })]);

    expect(PR.undoAutoAccept(queue, 'A', now)).toBeNull();
    expect(a.status).toBe('proposed');
    expect(a.approved).toBeUndefined();
    expect(queue.auto_accepted![0].undone).toBe(now);
    expect(PR.undoAutoAccept(queue, 'A')).toMatch(/already undone/);
    // Never accepted again by itself.
    expect(PR.applyAutoAccept(queue, ON, CTX)).toEqual([{ id: 'C', reason: expect.any(String) }]);
    expect(a.status).toBe('proposed');
  });

  it('undo refuses a task that has been started, and one that was never auto-accepted', () => {
    const queue: Queue = { tasks: [proposal('A')] };
    PR.applyAutoAccept(queue, ON, CTX);
    queue.tasks[0].status = 'running';
    queue.tasks[0].started = '2026-10-31T11:00:00.000Z';
    expect(PR.undoAutoAccept(queue, 'A')).toMatch(/has moved on \(status running, started\)/);
    expect(PR.boardData({}, queue).log[0].canUndo).toBe(false);
    expect(PR.undoAutoAccept(queue, 'Z')).toMatch(/was not auto-accepted/);
  });

  it('nothing happens while off, and the log keeps the last LOG_CAP entries', () => {
    const queue: Queue = { tasks: [proposal('A')] };
    expect(PR.applyAutoAccept(queue, { ...ON, enabled: false }, CTX)).toEqual([]);
    expect(queue.tasks[0].status).toBe('proposed');
    queue.auto_accepted = Array.from({ length: PR.LOG_CAP }, (_, i) => ({ id: `old-${i}`, at: 'x', reason: 'r' }));
    PR.applyAutoAccept(queue, ON, CTX);
    expect(queue.auto_accepted).toHaveLength(PR.LOG_CAP);
    expect(queue.auto_accepted.at(-1)!.id).toBe('A');
  });

  it('boardArgs turns the board\'s save into queue.mjs arguments, and refuses what queue.mjs would refuse', () => {
    expect(PR.boardArgs({ enabled: true, classes: ['K', 'U'], maxEstimateMin: 90, maxValue: null }).args).toEqual([
      'proposals', 'auto', 'on', '--classes', 'K,U', '--max-estimate', '90', '--max-value', 'none',
    ]);
    expect(PR.boardArgs({ enabled: false, classes: [], maxEstimateMin: null, maxValue: 4 }).args).toEqual([
      'proposals', 'auto', 'off', '--classes', 'none', '--max-estimate', 'none', '--max-value', '4',
    ]);
    expect(PR.boardArgs({ enabled: true, classes: ['D'] }).error).toMatch(/never auto-accepted/);
    expect(PR.boardArgs({ enabled: 'yes', classes: [] }).error).toMatch(/enabled must be/);
  });
});

describe('queue.mjs proposals, add and orchestrator pulse (against a temporary repo)', () => {
  const temporary: string[] = [];
  afterAll(() => {
    for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
  });

  it('pulse accepts older proposals that fit, add accepts new ones, log lists them and undo puts one back', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-proposals-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    fs.mkdirSync(repo);
    const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
    const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: 'pipe' });
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    const base = { domain: 'd', mission: 'm', value: 5, content_min: 30, migr_tens: 0, depends_on: [], waiting_on: [] };
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        limits: {},
        resolved: [],
        tasks: [
          { ...base, id: 'A-1', title: 'fits', class: 'K', status: 'proposed', owned_files: ['src/a.ts'], added_by: 'rev-x' },
          { ...base, id: 'A-2', title: 'hooks', class: 'K', status: 'proposed', owned_files: ['.claude/settings.json'] },
          { ...base, id: 'A-3', title: 'db', class: 'D', status: 'proposed', owned_files: ['src/c.ts'] },
        ],
      }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, '{}');
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    };
    const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'));
    const status = (id: string) => queue().tasks.find((o: Task) => o.id === id).status;

    // Off by default: the pulse leaves everything proposed.
    expect(run('proposals').out).toMatch(/Auto-accept of proposals: off: classes K, estimate <= 60 min, any value/);
    run('orchestrator', 'pulse', '--session', 'test');
    expect(status('A-1')).toBe('proposed');

    // The board's form of the save; D is refused before anything is written.
    expect(run('proposals', 'auto', 'on', '--classes', 'K,D').code).toBe(1);
    expect(queue().proposals).toBeUndefined();
    const on = run('proposals', 'auto', 'on', '--classes', 'K,U', '--max-estimate', '90', '--max-value', 'none');
    expect(on.code).toBe(0);
    expect(on.out).toContain('1 proposal(s) fit the rules now: A-1');
    expect(queue().proposals.autoAccept).toEqual({ enabled: true, classes: ['K', 'U'], maxEstimateMin: 90, maxValue: null });

    const pulse = run('orchestrator', 'pulse', '--session', 'test');
    expect(pulse.out).toMatch(/Auto-accepted A-1 by the owner's rules \(class K, estimate 30 min <= 90\)/);
    expect([status('A-1'), status('A-2'), status('A-3')]).toEqual(['waiting', 'proposed', 'proposed']);

    // A new agent proposal is accepted in the same write as the add.
    const add = run('add', '--json', JSON.stringify({ ...base, id: 'A-4', title: 'new', class: 'U', feature: 'f', own_track: 'test', owned_files: ['src/d.ts'], added_by: 'A-1' }));
    expect(add.error).toBe('');
    expect(add.code).toBe(0);
    expect(add.out).toContain('Auto-accepted A-4');
    expect(status('A-4')).toBe('waiting');

    expect(run('proposals', 'log').out.split('\n')[0]).toMatch(/A-4 {2}class U/);
    const undo = run('proposals', 'undo', 'A-1');
    expect(undo.code).toBe(0);
    expect(status('A-1')).toBe('proposed');
    expect(queue().tasks.find((o: Task) => o.id === 'A-1').remarks.at(-1)).toMatch(/auto-accept undone/);
    // The next pulse does not take it again, and a second undo is refused.
    run('orchestrator', 'pulse', '--session', 'test');
    expect(status('A-1')).toBe('proposed');
    expect(run('proposals', 'undo', 'A-1').code).toBe(1);
    expect(run('proposals', 'log', '--json').out).toContain('"undone"');
  });
});
