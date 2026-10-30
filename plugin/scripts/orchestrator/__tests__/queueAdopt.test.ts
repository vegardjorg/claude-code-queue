// =============================================================
// queueAdopt.test.ts: a new orchestrator session adopts tracks that are running.
//
// Locks: (1) the safe delivery signal (report.md with the RESULT line as the first line) goes before the heuristic in
// queue-takeover; (2) pulse and `queue.mjs deliveries` see a delivery without <task-notification>, report it as new only
// once, and `receive` makes it received; (3) `queue.mjs resume` makes the mission for a new agent on the same branch with
// prepare-track --continue, and the fix round's report (<id>-r<N>/) becomes a new delivery that receive reads.
// The smoke test runs queue.mjs against a copy of the queue in a temporary folder (QUEUE_FOLDER) and a temporary git repo
// (QUEUE_GIT) with a configured base branch other than main, as lib/__tests__/queueOrchestrator.test.ts. Never the main
// repo and never the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Delivery = {
  id: string;
  taskStatus: string;
  status: string;
  line: string;
  path: string;
  mtimeMs: number;
  new: boolean;
};
type Report = { path: string; folder: string; round: number; mtimeMs: number; text: string };

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../lib/queueLogic') as {
  RESUME_REASONS: string[];
  deliverySignal: (t: string | null) => { status: string; line: string } | null;
  trackFolderRound: (name: string, id: string) => number | null;
  findTrackReport: (
    id: string,
    roots: (string | null | undefined)[],
  ) => {
    report: Report | null;
    handover: { path: string; mtimeMs: number } | null;
    nextRound: number;
  };
  deliveryBase: (o: object) => number;
  assessDelivery: (o: object, r: Partial<Report> | null) => Delivery | null;
  assessActive: (x: {
    status: string;
    commits?: number;
    uncommitted?: number | null;
    lastMs?: number | null;
    startedMs?: number | null;
    delivery?: Delivery | null;
    anotherBranch?: () => string | null;
  }) => string;
  deliveryLines: (l: Delivery[], now?: number) => string[];
  resumeBlock: (x: object) => string;
  resumePromptAdjust: (
    t: string,
    x: { trackId: string; branch: string; base?: string },
  ) => { text: string; swapped: number };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES =
  'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
const tmp = () => {
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adopt-'));
  temporary.push(m);
  return m;
};

describe('deliverySignal', () => {
  it('accepts RESULT status=DONE|PARTIAL as the first non-empty line, also with markdown decoration', () => {
    expect(L.deliverySignal(`${RES}\n\n# Report`)).toEqual({ status: 'DONE', line: RES });
    expect(L.deliverySignal('\n\n`RESULT status=partial branch=queue/A`\n')?.status).toBe('PARTIAL');
    expect(L.deliverySignal(`# ${RES}`)?.status).toBe('DONE');
  });
  it('rejects half written reports, the line further down and an unknown status', () => {
    expect(L.deliverySignal('')).toBeNull();
    expect(L.deliverySignal(null)).toBeNull();
    expect(L.deliverySignal(`# Report\n${RES}`)).toBeNull();
    expect(L.deliverySignal('RESULT status=ONGOING branch=queue/A')).toBeNull();
    expect(L.deliverySignal('RESULT branch=queue/A')).toBeNull();
  });
});

describe('trackFolderRound and findTrackReport', () => {
  it('knows <id> and <id>-r<N>, not the folders of other tracks', () => {
    expect(L.trackFolderRound('A', 'A')).toBe(0);
    expect(L.trackFolderRound('A-r2', 'A')).toBe(2);
    expect(L.trackFolderRound('AB', 'A')).toBeNull();
    expect(L.trackFolderRound('A-rx', 'A')).toBeNull();
    expect(L.trackFolderRound('rev-A', 'A')).toBeNull();
  });

  it('gives the newest report across roots and rounds, and the next free round', () => {
    const r1 = tmp();
    const r2 = tmp();
    fs.mkdirSync(path.join(r1, 'A'));
    fs.writeFileSync(path.join(r1, 'A', 'report.md'), `${RES}\nround 0`);
    fs.writeFileSync(path.join(r1, 'A', 'handover.md'), 'remaining');
    fs.mkdirSync(path.join(r2, 'A-r1'));
    fs.writeFileSync(path.join(r2, 'A-r1', 'report.md'), `${RES}\nround 1`);
    fs.writeFileSync(path.join(r2, 'prompt-A-r2.md'), 'prompt');
    fs.mkdirSync(path.join(r2, 'AB'));
    fs.writeFileSync(path.join(r2, 'AB', 'report.md'), RES);
    const later = Date.now() / 1000 + 120;
    fs.utimesSync(path.join(r2, 'A-r1', 'report.md'), later, later);
    const f = L.findTrackReport('A', [r1, r2, r1, null, path.join(r1, 'does-not-exist')]);
    expect(f.report?.round).toBe(1);
    expect(f.report?.text).toContain('round 1');
    expect(f.handover?.path).toBe(path.join(r1, 'A', 'handover.md'));
    expect(f.nextRound).toBe(3); // prompt-A-r2.md already exists
    expect(L.findTrackReport('Z', [r1]).report).toBeNull();
    expect(L.findTrackReport('Z', [r1]).nextRound).toBe(1);
  });
});

describe('assessDelivery and assessActive', () => {
  const started = '2026-10-30T10:00:00.000Z';
  const t = (iso: string) => Date.parse(iso);
  const report = (iso: string, text = RES) => ({ path: 'x', mtimeMs: t(iso), text });

  it('a report after the start is a new delivery; one from before the start or before receive does not count', () => {
    const o = { id: 'A', status: 'running', started };
    expect(L.assessDelivery(o, report('2026-10-30T11:00:00Z'))).toMatchObject({
      id: 'A',
      status: 'DONE',
      new: true,
    });
    expect(L.assessDelivery(o, report('2026-10-30T09:00:00Z'))).toBeNull();
    expect(L.assessDelivery(o, report('2026-10-30T11:00:00Z', '# half written'))).toBeNull();
    expect(L.assessDelivery(o, null)).toBeNull();
    const received = { ...o, status: 'review', report_received: t('2026-10-30T11:00:00Z') };
    expect(L.assessDelivery(received, report('2026-10-30T11:00:00Z'))).toBeNull();
    // The fix round: a newer report after the receive is a new delivery.
    expect(L.assessDelivery(received, report('2026-10-30T12:00:00Z'))?.new).toBe(true);
    // delivered (set by receive) counts as the baseline for older tasks without report_received.
    const delivered = { ...o, status: 'review', delivered: '2026-10-30T11:30:00Z' };
    expect(L.assessDelivery(delivered, report('2026-10-30T11:00:00Z'))).toBeNull();
    expect(L.deliveryBase({})).toBe(0);
  });

  it('reported by a pulse (report_seen) is no longer new, but still a delivery', () => {
    const o = { id: 'A', status: 'running', started, report_seen: t('2026-10-30T11:00:00Z') };
    const l = L.assessDelivery(o, report('2026-10-30T11:00:00Z'));
    expect(l?.new).toBe(false);
    const lines = L.deliveryLines([l!], t('2026-10-30T11:10:00Z'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Report waiting, not received: A \(DONE\) \(.*deliveries\)$/);
    const fresh = L.deliveryLines([{ ...l!, new: true }], t('2026-10-30T11:10:00Z'));
    expect(fresh[0]).toMatch(/^NEW DELIVERY \(report\.md\): A DONE, written 10 min ago/);
    expect(fresh[0]).toMatch(/receive A$/);
    expect(L.deliveryLines([])).toEqual([]);
  });

  it('the signal goes before the heuristic; the heuristic is unchanged as the fallback', () => {
    const del = L.assessDelivery(
      { id: 'A', status: 'running', started },
      report('2026-10-30T11:00:00Z', 'RESULT status=PARTIAL branch=queue/A'),
    );
    // The signal beats "uncommitted in worktree" and "last commit 2 min ago".
    expect(
      L.assessActive({ status: 'running', commits: 2, uncommitted: 3, lastMs: 120_000, delivery: del }),
    ).toBe('DELIVERED (report.md PARTIAL)');
    expect(L.assessActive({ status: 'review', commits: 2, delivery: del })).toBe(
      'DELIVERED (report.md PARTIAL, new round after receive)',
    );
    expect(L.assessActive({ status: 'running', commits: 2, uncommitted: 0, lastMs: 21 * 60_000 })).toBe(
      'DELIVERED',
    );
    expect(L.assessActive({ status: 'running', commits: 2, uncommitted: 0, lastMs: 60_000 })).toBe(
      'UNCERTAIN',
    );
    expect(L.assessActive({ status: 'review', commits: 1 })).toBe('DELIVERED (review)');
    expect(L.assessActive({ status: 'review', commits: 0 })).toBe('UNCERTAIN (review without commits)');
    expect(L.assessActive({ status: 'running', commits: 0, startedMs: 2 * 3_600_000 })).toBe('EMPTY');
    expect(
      L.assessActive({
        status: 'running',
        commits: 0,
        startedMs: 2 * 3_600_000,
        anotherBranch: () => 'abc1234',
      }),
    ).toBe('UNCERTAIN (commit abc1234 mentions the id on another branch)');
    expect(L.assessActive({ status: 'running', commits: 1, uncommitted: 2, lastMs: 1 })).toBe(
      'UNCERTAIN (uncommitted in worktree)',
    );
    // anotherBranch is only called in the EMPTY branch (git log --all is expensive).
    let called = 0;
    L.assessActive({ status: 'running', commits: 1, anotherBranch: () => String(++called) });
    expect(called).toBe(0);
  });
});

describe('resumeBlock and resumePromptAdjust', () => {
  const o = { id: 'A', title: 'Title A', class: 'D', branch: 'queue/A', migr_block: '3600–3609' };

  it('the track block has <id>-r<N>, the same branch and block, the paths and the original mission', () => {
    const b = L.resumeBlock({
      o,
      round: 2,
      reason: 'fix',
      reportPath: 'C:\\s\\A\\report.md',
      handoverPath: null,
      reviewFolder: 'C:\\s\\rev-A',
      reviewFiles: ['findings-review.md'],
      findingsFile: 'C:\\s\\findings.md',
      original: '## TRACK A (Title A; class D, estimate 60 min)\n\nThe mission for A.',
    });
    expect(b.split('\n')[0]).toBe('=====A-r2=====');
    expect(b).toContain('CLASS: D');
    expect(b).toContain('BLOCK: 3600–3609');
    expect(b).toContain('BRANCH: queue/A');
    expect(b).toContain('## Fix round 2 for A');
    expect(b).toContain('C:\\s\\A\\report.md');
    expect(b).toContain("the reviewers' files there: findings-review.md");
    expect(b).toContain('5. The findings to fix: C:\\s\\findings.md');
    expect(b).toContain('The mission for A.');
    expect(b).toMatch(/--continue/);
    const k = L.resumeBlock({ o: { ...o, migr_block: null }, round: 1, reason: 'context' });
    expect(k).toContain('## Continuation 1 for A');
    expect(k).toContain('BLOCK: none');
    expect(k).toContain('The track has no report');
    expect(L.RESUME_REASONS).toEqual(['fix', 'context']);
  });

  it('adds --continue to the setup call and swaps checkout -B for git switch, once', () => {
    const common =
      '**Setup (first call):** `cq prepare-track A-r1 --branch queue/A --scratchpad\n"s"`\n' +
      '**Git:** `prepare-track` runs `git checkout -B queue/A develop`; HEAD must be abc.';
    const j = L.resumePromptAdjust(common, { trackId: 'A-r1', branch: 'queue/A', base: 'develop' });
    expect(j.swapped).toBe(2);
    expect(j.text).toContain('prepare-track A-r1 --branch queue/A --continue --scratchpad\n');
    expect(j.text).toContain('`prepare-track --continue` runs `git switch queue/A` (without reset)');
    expect(j.text).not.toContain('checkout -B queue/A develop`;');
    // Idempotent: a new adjustment does not add another --continue.
    expect(
      L.resumePromptAdjust(j.text, { trackId: 'A-r1', branch: 'queue/A', base: 'develop' }).swapped,
    ).toBe(0);
  });
});

describe('queue.mjs: pulse, deliveries, receive and resume against a temporary queue', () => {
  it('sees the delivery without a notification, reports it once, and the fix round becomes a new delivery', () => {
    const folder = tmp();
    const repo = path.join(folder, 'repo');
    const scratch = path.join(folder, 'scratch');
    fs.mkdirSync(repo);
    fs.mkdirSync(scratch);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    // A configured base branch other than main: the prompts must use it.
    g(['init', '-q', '-b', 'develop']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    g(['switch', '-q', '-c', 'queue/A']);
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.writeFileSync(path.join(repo, 'lib', 'A.ts'), 'export const a = 1;\n');
    g(['add', '--', 'lib/A.ts']);
    g(['commit', '-q', '-m', 'feat: A']);
    g(['switch', '-q', 'develop']);
    const task: Task = {
      id: 'A',
      title: 'Task A',
      domain: 'dom-A',
      class: 'K',
      status: 'running',
      mission: 'The mission for A.',
      value: 5,
      content_min: 60,
      migr_tens: 0,
      depends_on: [],
      waiting_on: [],
      owned_files: ['lib/A.ts'],
      started: '2026-01-01T00:00:00.000Z',
      branch: 'queue/A',
      migr_block: null,
      scratchpad: scratch,
    };
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created: task.started,
        limits: {},
        next_migr: 3600,
        resolved: [],
        tasks: [task],
      }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
    // The mission template (resume builds the prompt from the common part) is read from the root.
    fs.mkdirSync(path.join(folder, 'docs'));
    fs.copyFileSync(
      path.join(ROOT, 'docs', 'mission-template.md'),
      path.join(folder, 'docs', 'mission-template.md'),
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    } as NodeJS.ProcessEnv;
    // The task's saved scratchpad must be used (an adopted task), not one from the environment.
    delete env.QUEUE_SCRATCHPAD;
    delete env.QUEUE_SESSION;
    const run = (...args: string[]) => {
      const r = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args],
        { encoding: 'utf8', env },
      );
      return { code: r.status, out: r.stdout, error: r.stderr };
    };
    const find = () =>
      (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as { tasks: Task[] })
        .tasks[0];
    const deliveries = () => JSON.parse(run('deliveries', '--json').out) as Delivery[];

    // No report yet: nothing to report.
    expect(deliveries()).toEqual([]);
    expect(run('orchestrator', 'pulse', '--session', 'new-session').out).not.toMatch(
      /DELIVERY|Report waiting/,
    );

    // The track delivers (the old session gets the notification; the new one only sees the file).
    fs.mkdirSync(path.join(scratch, 'A'));
    fs.writeFileSync(path.join(scratch, 'A', 'report.md'), `${RES}\n\n# Report A\n`);
    expect(deliveries()).toMatchObject([{ id: 'A', status: 'DONE', new: true }]);
    const p1 = run('orchestrator', 'pulse', '--session', 'new-session');
    expect(p1.out).toMatch(/NEW DELIVERY \(report\.md\): A DONE/);
    expect(find().report_seen).toBeGreaterThan(0);
    // Second pulse: no longer new, but still not received.
    const p2 = run('orchestrator', 'pulse', '--session', 'new-session');
    expect(p2.out).not.toMatch(/NEW DELIVERY/);
    expect(p2.out).toContain('Report waiting, not received: A (DONE)');

    // receive (the task's scratchpad is used without --scratchpad): review, the report is read and no longer a delivery.
    const m = run('receive', 'A');
    expect(m.error).toBe('');
    expect(m.code).toBe(0);
    expect(m.out).toContain(RES);
    expect(find()).toMatchObject({ status: 'review' });
    expect(find().report_received).toBeGreaterThan(0);
    // No label that needs QA evidence (config().qa.evidenceLabels): no evidence warning.
    expect(m.out).not.toMatch(/EVIDENCE/);
    expect(fs.readFileSync(path.join(scratch, 'rev-A', 'trackReport.md'), 'utf8')).toContain(
      '# Report A',
    );
    expect(deliveries()).toEqual([]);

    // resume: an unknown reason and an unknown task are refused.
    expect(run('resume', 'A', '--reason', 'nonsense').code).toBe(1);
    expect(run('resume', 'Z').code).toBe(1);
    fs.writeFileSync(path.join(scratch, 'findings.md'), 'FINDINGS H=1 M=0 L=0');
    const res = run('resume', 'A', '--reason', 'fix', '--findings-file', path.join(scratch, 'findings.md'));
    expect(res.error).toBe('');
    expect(res.code).toBe(0);
    expect(res.out).toContain('RESUME A-r1 (fix)');
    expect(res.out).not.toContain('WARNING');
    expect(res.out).toMatch(/subagent_type (cq:)?track,/);
    const prompt = fs.readFileSync(path.join(scratch, 'prompt-A-r1.md'), 'utf8');
    expect(prompt).toContain('prepare-track A-r1 --branch queue/A --continue');
    expect(prompt).toContain('`prepare-track --continue` runs `git switch queue/A` (without reset)');
    expect(prompt).not.toMatch(/git checkout -B queue\/A develop`;/);
    expect(prompt).toContain('## Fix round 1 for A');
    expect(prompt).toContain('git log --oneline develop..queue/A');
    expect(prompt).toContain(path.join(scratch, 'A', 'report.md'));
    expect(prompt).toContain(path.join(scratch, 'rev-A'));
    expect(prompt).toContain(path.join(scratch, 'findings.md'));
    expect(prompt).toContain('The mission for A.');
    expect(find().resumed).toMatchObject([{ round: 1, reason: 'fix' }]);
    // The next resume gets the next round (prompt-A-r1.md exists).
    expect(run('resume', 'A', '--reason', 'context').out).toContain('RESUME A-r2 (context)');

    // The fix round delivers in its own folder: a new delivery, and receive reads it.
    fs.mkdirSync(path.join(scratch, 'A-r1'));
    const r1 = path.join(scratch, 'A-r1', 'report.md');
    fs.writeFileSync(r1, `${RES}\nEVIDENCE test=src/a.test.ts\n\n# Fix round 1\n`);
    const later = Date.now() / 1000 + 120;
    fs.utimesSync(r1, later, later);
    expect(deliveries()).toMatchObject([{ id: 'A', taskStatus: 'review', new: true, path: r1 }]);
    const m2 = run('receive', 'A');
    expect(m2.code).toBe(0);
    expect(fs.readFileSync(path.join(scratch, 'rev-A', 'trackReport.md'), 'utf8')).toContain(
      '# Fix round 1',
    );
    // The EVIDENCE line in report.md is stored on the task (QA evidence).
    expect(m2.out).toContain('QA evidence: test src/a.test.ts');
    expect((find() as unknown as { evidence: unknown }).evidence).toEqual({
      type: 'test',
      ref: ['src/a.test.ts'],
    });
    expect(deliveries()).toEqual([]);
  });
});
