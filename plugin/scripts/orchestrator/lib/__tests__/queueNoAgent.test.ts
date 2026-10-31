// =============================================================
// queueNoAgent.test.ts: tracks marked running that no agent works on ("STARTED WITHOUT AGENT").
//
// Why: `fill` and `start` only mark a track running; the orchestrator starts the agent from the "Start these" lines.
// When fill ran where nobody read the output (a merge in the background, a script chaining merges), tracks stood
// "running" for hours without an agent and the queue stalled with no error. The rule is enforced in
// queueLogic.startedWithoutAgent (pure) and shown by queue.mjs show/state/pulse, so both are tested here: the pure
// function, and queue.mjs against a temporary git repo with a real worktree (never the main repo or the real queue).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Hit = { id: string; branch: string; migr_block: string | null; age_ms: number };

const L = require('../queueLogic') as {
  startedWithoutAgent: (
    queue: { tasks: Task[] },
    option?: {
      worktreeBranches?: Set<string>;
      hasReport?: (o: Task) => boolean;
      now?: number;
      graceMin?: number;
    },
  ) => Hit[];
  withoutAgentLines: (list: Hit[]) => string[];
  fillExcerpt: (out: string) => string[];
  NO_AGENT_GRACE_MIN: number;
};

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const running = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  status: 'running',
  class: 'K',
  branch: `queue/${id}`,
  started: ago(60),
  ...extra,
});

describe('startedWithoutAgent (pure)', () => {
  it('finds a running track older than the grace time with no worktree and no report', () => {
    const hits = L.startedWithoutAgent(
      { tasks: [running('A', { migr_block: '3600-3609' })] },
      { worktreeBranches: new Set(), now: NOW },
    );
    expect(hits).toEqual([{ id: 'A', branch: 'queue/A', migr_block: '3600-3609', age_ms: 60 * 60_000 }]);
  });

  it('leaves out a track whose branch is checked out in a worktree (the agent ran prepare-track)', () => {
    const hits = L.startedWithoutAgent(
      { tasks: [running('A')] },
      { worktreeBranches: new Set(['queue/A']), now: NOW },
    );
    expect(hits).toEqual([]);
  });

  it('gives a newly started track the grace time (the agent has not reached prepare-track yet)', () => {
    const fresh = running('A', { started: ago(L.NO_AGENT_GRACE_MIN - 1) });
    expect(L.startedWithoutAgent({ tasks: [fresh] }, { now: NOW })).toEqual([]);
    const late = running('A', { started: ago(L.NO_AGENT_GRACE_MIN) });
    expect(L.startedWithoutAgent({ tasks: [late] }, { now: NOW })).toHaveLength(1);
  });

  it('leaves out a delivered track (report.md exists, the worktree may be gone)', () => {
    const hits = L.startedWithoutAgent(
      { tasks: [running('A')] },
      { hasReport: (o) => o.id === 'A', now: NOW },
    );
    expect(hits).toEqual([]);
  });

  it('only looks at running tracks: picked, cloud, review, waiting and done are left out', () => {
    const tasks = [
      running('P', { picked_by: 'owner' }),
      running('C', { cloud: { started: ago(60) } }),
      running('R', { status: 'review' }),
      running('W', { status: 'waiting' }),
      running('D', { status: 'done' }),
      running('X', { started: 'not a date' }),
      running('N', { branch: undefined }),
    ];
    expect(L.startedWithoutAgent({ tasks }, { now: NOW })).toEqual([]);
  });

  it('the warning says what to do and names each track; nothing when all is well', () => {
    expect(L.withoutAgentLines([])).toEqual([]);
    const lines = L.withoutAgentLines(
      L.startedWithoutAgent({ tasks: [running('A'), running('B')] }, { now: NOW }),
    );
    expect(lines[0]).toMatch(/^STARTED WITHOUT AGENT \(2\)/);
    expect(lines[0]).toContain('cq set <id> waiting');
    expect(lines[0]).toContain('fill --ids <id>');
    expect(lines.slice(1).map((l) => l.trim().split(/\s+/)[0])).toEqual(['A', 'B']);
  });
});

describe('fillExcerpt in merge', () => {
  it('ends with the note that the tracks are only marked and that merge must not run unread', () => {
    const out = ['something', 'FILLED 1 track(s)', 'A: running', 'Start these in the SAME turn:', '  track A'].join(
      '\n',
    );
    const lines = L.fillExcerpt(out);
    expect(lines[0]).toBe('fill: FILLED 1 track(s)');
    expect(lines.at(-1)).toMatch(/only marked running/);
    expect(lines.at(-1)).toContain('--without-fill');
  });

  it('no note when nothing was filled', () => {
    expect(L.fillExcerpt('Nothing can be started now')).toEqual(['fill: Nothing can be started now']);
  });
});

describe('queue.mjs show, state and pulse warn (against a temporary repo)', () => {
  it('warns about a running track without a worktree, and stops warning once a worktree has the branch', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-noagent-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    fs.mkdirSync(repo);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created: old,
        limits: {},
        next_migr: 3600,
        resolved: [],
        tasks: [
          {
            id: 'A',
            title: 'Task A',
            domain: 'dom-a',
            class: 'K',
            status: 'running',
            branch: 'queue/A',
            started: old,
            value: 5,
            content_min: 60,
            migr_tens: 0,
            depends_on: [],
            waiting_on: [],
            owned_files: ['lib/A.ts'],
          },
        ],
      }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({}));
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };

    const show = run('show');
    expect(show.error).toBe('');
    // First in the output, so the after-compact hook's trimming never cuts it.
    expect(show.out.split('\n')[0]).toMatch(/^STARTED WITHOUT AGENT \(1\)/);
    expect(show.out).toMatch(/^\s+A\s+queue\/A\s+running for/m);
    expect(run('show', '--full').out.split('\n')[0]).toMatch(/^STARTED WITHOUT AGENT \(1\)/);
    const state = JSON.parse(run('state').out) as { withoutAgent: Hit[] };
    expect(state.withoutAgent.map((x) => x.id)).toEqual(['A']);
    expect(run('orchestrator', 'pulse', '--session', 'test').out).toContain('STARTED WITHOUT AGENT (1)');

    // The agent has run prepare-track: its worktree has the branch checked out.
    g(['worktree', 'add', '-q', '-b', 'queue/A', path.join(folder, 'wt-A')]);
    expect(run('show').out).not.toContain('STARTED WITHOUT AGENT');
    expect((JSON.parse(run('state').out) as { withoutAgent: Hit[] }).withoutAgent).toEqual([]);
  });
});
