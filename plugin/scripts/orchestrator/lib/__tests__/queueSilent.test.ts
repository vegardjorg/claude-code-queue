// =============================================================
// queueSilent.test.ts: running tracks whose agent has a worktree but shows no sign of life ("SILENT").
//
// Why: a hung agent (or one that lost its context) leaves its track "running" with a worktree, so neither the delivery
// check nor STARTED WITHOUT AGENT sees it, and the slot is lost until someone looks. The rule is enforced in
// queueLogic.silentTracks (pure), the sign of life is measured by lib/trackActivity.js, and queue.mjs show/state/pulse
// print it. All three are tested here; queue.mjs against a temporary git repo with a real worktree (never the main repo
// or the real queue).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Hit = { id: string; branch: string; last_activity: string; silent_ms: number };

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic') as {
  silentTracks: (
    queue: { tasks: Task[]; limits?: Record<string, unknown> },
    option?: {
      worktreeBranches?: Set<string>;
      lastActivity?: Record<string, number | null> | Map<string, number>;
      hasReport?: (o: Task) => boolean;
      now?: number;
      limitMin?: number;
    },
  ) => Hit[];
  silentLines: (list: Hit[]) => string[];
  silentMinFor: (queue: { limits?: Record<string, unknown> }) => number;
  parseLimit: (name: string, raw: string) => { val?: unknown; error?: string };
  SILENT_DEFAULT_MIN: number;
};
const ACT = require('../trackActivity') as {
  newestMtime: (dir: string, option?: { maxEntries?: number; maxDepth?: number; freshMs?: number }) => number | null;
  agentsByTask: (
    rows: Record<string, unknown>[],
    ids: string[],
  ) => Map<string, { agents: Set<string>; lastRow: number | null }>;
  lastActivity: (x: {
    branch: string;
    worktree?: string | null;
    trackDirs?: string[];
    agents?: { agents: Set<string>; lastRow: number | null } | null;
    findTranscript?: (id: string) => string | null;
    git?: (args: string[]) => string | null;
    freshMs?: number;
  }) => { ms: number | null; source: string | null };
};

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(d);
  return d;
};

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const running = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  status: 'running',
  class: 'K',
  branch: `queue/${id}`,
  started: ago(120),
  ...extra,
});
const withWorktree = new Set(['queue/A', 'queue/B']);

describe('silentTracks (pure)', () => {
  it('finds a running track with a worktree and no activity for the limit', () => {
    const hits = L.silentTracks(
      { tasks: [running('A')] },
      { worktreeBranches: withWorktree, lastActivity: { A: NOW - 30 * 60_000 }, now: NOW },
    );
    expect(hits).toEqual([
      { id: 'A', branch: 'queue/A', last_activity: ago(30), silent_ms: 30 * 60_000 },
    ]);
  });

  it('recent activity keeps it quiet; the start counts as activity (grace for a new track)', () => {
    expect(
      L.silentTracks(
        { tasks: [running('A')] },
        { worktreeBranches: withWorktree, lastActivity: { A: NOW - 5 * 60_000 }, now: NOW },
      ),
    ).toEqual([]);
    // No activity found at all, but started 10 min ago: still within the limit.
    const fresh = running('A', { started: ago(L.SILENT_DEFAULT_MIN - 1) });
    expect(L.silentTracks({ tasks: [fresh] }, { worktreeBranches: withWorktree, now: NOW })).toEqual([]);
    const late = running('A', { started: ago(L.SILENT_DEFAULT_MIN) });
    expect(L.silentTracks({ tasks: [late] }, { worktreeBranches: withWorktree, now: NOW })).toHaveLength(1);
  });

  it('only tracks that HAVE an agent: no worktree is STARTED WITHOUT AGENT, not SILENT', () => {
    expect(L.silentTracks({ tasks: [running('C')] }, { worktreeBranches: withWorktree, now: NOW })).toEqual([]);
  });

  it('leaves out delivered, picked, cloud and non-running tasks', () => {
    const tasks = [
      running('A'),
      running('B', { picked_by: 'owner' }),
      running('B', { cloud: { started: ago(60) } }),
      running('B', { status: 'review' }),
    ];
    const hits = L.silentTracks({ tasks }, { worktreeBranches: withWorktree, hasReport: (o) => o.id === 'A', now: NOW });
    expect(hits).toEqual([]);
  });

  it('the limit: limits.silentMin wins over the default, 0 turns it off, and limit accepts it', () => {
    const tasks = [running('A')];
    const last = { A: NOW - 30 * 60_000 };
    expect(L.silentMinFor({})).toBe(20);
    expect(L.silentMinFor({ limits: { silentMin: 45 } })).toBe(45);
    expect(L.silentTracks({ tasks, limits: { silentMin: 45 } }, { worktreeBranches: withWorktree, lastActivity: last, now: NOW })).toEqual([]);
    expect(L.silentTracks({ tasks, limits: { silentMin: 0 } }, { worktreeBranches: withWorktree, lastActivity: last, now: NOW })).toEqual([]);
    expect(L.parseLimit('silentMin', '30')).toEqual({ val: 30 });
    expect(L.parseLimit('silentMin', 'x').error).toMatch(/integer/);
  });

  it('the warning says what to do and names each track; nothing when all is well', () => {
    expect(L.silentLines([])).toEqual([]);
    const lines = L.silentLines(
      L.silentTracks({ tasks: [running('A'), running('B')] }, { worktreeBranches: withWorktree, now: NOW }),
    );
    expect(lines[0]).toMatch(/^SILENT \(2\)/);
    expect(lines[0]).toContain('cq resume <id> --reason context');
    expect(lines.slice(1).map((l) => l.trim().split(/\s+/)[0])).toEqual(['A', 'B']);
  });
});

describe('trackActivity: the sources of a sign of life', () => {
  const setTime = (p: string, ms: number) => fs.utimesSync(p, ms / 1000, ms / 1000);

  it('newestMtime skips node_modules and .git and stops early at a fresh entry', () => {
    const d = tmp('silent-walk-');
    const old = Date.now() - 3 * 3600_000;
    fs.mkdirSync(path.join(d, 'src'));
    fs.mkdirSync(path.join(d, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'a.ts'), 'a');
    fs.writeFileSync(path.join(d, 'node_modules', 'x', 'fresh.js'), 'x');
    for (const p of [path.join(d, 'src', 'a.ts'), path.join(d, 'src'), path.join(d, 'node_modules'), d]) setTime(p, old);
    // node_modules (whose content is fresh) is not walked; the folder itself was set old.
    expect(ACT.newestMtime(d)).toBe(old);
    fs.writeFileSync(path.join(d, 'src', 'b.ts'), 'b');
    expect(ACT.newestMtime(d)! > old + 60_000).toBe(true);
    expect(ACT.newestMtime(path.join(d, 'missing'))).toBeNull();
  });

  it('agentsByTask ties agents to the task by the track label (fix rounds too) and keeps the newest row', () => {
    const rows = [
      { time: ago(50), agent_id: 'a1', track: 'A', event: 'start' },
      { time: ago(40), agent_id: 'a2', track: 'A-r2', event: 'start' },
      { time: ago(10), agent_id: 'a2', track: 'A-r2', event: 'done' },
      { time: ago(5), agent_id: 'z', track: 'Z', event: 'start' },
    ];
    const m = ACT.agentsByTask(rows, ['A']);
    expect([...m.get('A')!.agents].sort()).toEqual(['a1', 'a2']);
    expect(m.get('A')!.lastRow).toBe(NOW - 10 * 60_000);
    expect(m.has('Z')).toBe(false);
  });

  it('lastActivity takes the newest of commit, track folder, time log, transcript and worktree', () => {
    const d = tmp('silent-src-');
    const wt = path.join(d, 'wt');
    const track = path.join(d, 'scratch', 'A');
    const transcript = path.join(d, 'agent-a1.jsonl');
    fs.mkdirSync(wt);
    fs.mkdirSync(track, { recursive: true });
    fs.writeFileSync(transcript, '{}\n');
    const t0 = Date.now() - 5 * 3600_000;
    for (const p of [wt, track, path.dirname(track), transcript]) setTime(p, t0);
    const git = (min: number) => () => String(Math.floor((Date.now() - min * 60_000) / 1000));
    const base = { branch: 'queue/A', worktree: wt, trackDirs: [track] };
    // Only the commit is recent.
    const c = ACT.lastActivity({ ...base, git: git(90) });
    expect(c.source).toBe('commit');
    // The transcript is newer than the commit.
    setTime(transcript, Date.now() - 30 * 60_000);
    const tr = ACT.lastActivity({
      ...base,
      git: git(90),
      agents: { agents: new Set(['a1']), lastRow: null },
      findTranscript: (id) => (id === 'a1' ? transcript : null),
    });
    expect(tr.source).toBe('transcript');
    // A file in the worktree just now beats them all.
    fs.writeFileSync(path.join(wt, 'x.ts'), 'x');
    expect(ACT.lastActivity({ ...base, git: git(90) }).source).toBe('worktree');
    // A fresh commit stops before the walk (freshMs).
    expect(ACT.lastActivity({ ...base, git: git(1), freshMs: Date.now() - 20 * 60_000 }).source).toBe('commit');
    // Nothing readable: null.
    expect(ACT.lastActivity({ branch: 'queue/A', git: () => null })).toEqual({ ms: null, source: null });
  });
});

describe('queue.mjs show, state and pulse warn about SILENT (against a temporary repo)', () => {
  it('warns when the worktree, the branch and the transcripts are old, and stops when a file changes', () => {
    const folder = tmp('queue-silent-');
    const repo = path.join(folder, 'repo');
    fs.mkdirSync(repo);
    const oldMs = Date.now() - 3 * 3600_000;
    const oldIso = new Date(oldMs).toISOString();
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_COMMITTER_DATE: oldIso, GIT_AUTHOR_DATE: oldIso },
      }).trim();
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    const wt = path.join(folder, 'wt-A');
    g(['worktree', 'add', '-q', '-b', 'queue/A', wt]);
    // Everything in the worktree is set 3 h old (a hung agent wrote nothing since).
    const age = (p: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) age(q);
        fs.utimesSync(q, oldMs / 1000, oldMs / 1000);
      }
      fs.utimesSync(p, oldMs / 1000, oldMs / 1000);
    };
    age(wt);
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created: oldIso,
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
            started: oldIso,
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
    expect(show.out).not.toContain('STARTED WITHOUT AGENT');
    expect(show.out.split('\n')[0]).toMatch(/^SILENT \(1\)/);
    expect(show.out).toMatch(/^\s+A\s+queue\/A\s+silent for/m);
    expect(run('show', '--full').out).toMatch(/^SILENT \(1\)/m);
    const state = JSON.parse(run('state').out) as { silent: Hit[] };
    expect(state.silent.map((x) => x.id)).toEqual(['A']);
    expect(run('orchestrator', 'pulse', '--session', 'test').out).toContain('SILENT (1)');

    // The limit is shown and can be turned off.
    expect(run('limit').out).toMatch(/silentMin\s+20 min/);
    expect(run('limit', 'silentMin', '0').out).toContain('silentMin = 0');
    expect(run('show').out).not.toContain('SILENT');
    run('limit', 'silentMin', '20');

    // The agent writes a file: alive again.
    fs.writeFileSync(path.join(wt, 'lib.ts'), 'export const a = 1;\n');
    expect(run('show').out).not.toContain('SILENT');
    expect((JSON.parse(run('state').out) as { silent: Hit[] }).silent).toEqual([]);
  });
});
