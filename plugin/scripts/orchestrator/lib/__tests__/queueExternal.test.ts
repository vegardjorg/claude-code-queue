// =============================================================
// queueExternal.test.ts: workQueue, work outside the queue and push-check.
//
// - Classification of commits on main: merge of queue/<id> = queue, the trailer "Queue: orchestrator" = orchestrator, the rest
//   external; id consistency in the message; cutPoint for the push check (exists / does not exist).
// - Collisions between the owned files and external commits (only after added_at), branches outside queue/* and uncommitted files.
// - `external add`/`done` (a row with status external that owns files like a picked task), `external accept`.
// - `next` skips tasks that collide with uncommitted files in the main tree.
// - Orchestrator cursor (active / expired after 2 h).
//
// The git parts run against a TEMPORARY repo (`git -C <tmp>` in os.tmpdir()), never the main repo, and without `git config`:
// the identity is given with `-c` per command.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = {
  id: string;
  title?: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  owned_files?: string[];
  owner_db?: string[];
  shared_patch?: string[];
  depends_on?: string[];
  waiting_on?: string[];
  added_at?: string;
  picked_by?: string;
  labels?: string[];
  project?: string;
  feature?: string;
  external?: boolean;
  external_name?: string;
  branch?: string;
  remarks?: string[];
  qa_status?: string;
  done_outside_queue?: string;
};
type Queue = {
  tasks: Task[];
  resolved?: string[];
  limits?: Record<string, number>;
  projects?: Record<string, { title: string; prefixes?: string[] }>;
  next_migr?: number;
};
type Commit = {
  sha: string;
  summary: string;
  parents: string[];
  date: string;
  subject: string;
  message: string;
  files: string[];
  source?: string;
  queue_id?: string;
  side?: Commit[];
};
type Collision = {
  id: string;
  status: string;
  file: string;
  owner: string;
  source: string;
  sha?: string;
  branch?: string;
};
type Plan = {
  total: number;
  queue: number;
  orchestrator: number;
  externalOnes: { sha: string }[];
  cutPoint: string | null;
  merged: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../queueLogic') as {
  classifyCommit: (c: Partial<Commit>) => { source: string; queue_id?: string };
  mentionedIds: (text: string, ids: string[]) => string[];
  consistency: (
    externalOnes: Partial<Commit>[],
    tasks: Task[],
  ) => { id: string; status: string; proposed: string | null }[];
  pushPlan: (c: { sha: string; source: string }[]) => Plan;
  externalCollisions: (
    tasks: Task[],
    sources: {
      commits?: Partial<Commit>[];
      branches?: { name: string; files: string[] }[];
      uncommitted?: string[];
    },
  ) => Collision[];
  uncommittedCollision: (o: Task, files: string[]) => { file: string; path: string } | null;
  uncommittedSkipped: (queue: Queue, files: string[]) => { id: string; path: string }[];
  selectNext: (queue: Queue, now?: number, opt?: { uncommitted?: string[] }) => { id: string }[];
  state: (
    queue: Queue,
    usage?: number,
    opt?: { uncommitted?: string[] },
  ) => { external: number; blocked: { id: string; blockers: string[] }[] };
  blockers: (o: Task, all: Task[], resolved?: string[]) => string[];
  pick: (queue: Queue, id: string, opt?: { by?: string }) => { error?: string };
  setStatus: (o: Task, status: string) => { error?: string };
  projectOverview: (queue: Queue) => { pid: string; total: number }[];
  externalAdd: (
    queue: Queue,
    opt: { name?: string; files?: string[]; db?: string[]; branch?: string | null; now?: string },
  ) => { error?: string; row?: Task; new?: boolean; warnings?: string[] };
  externalDone: (queue: Queue, name: string) => { error?: string; row?: Task };
  externalAccept: (
    queue: Queue,
    id: string,
    sha: string,
    opt?: { mentioned?: boolean },
  ) => { error?: string; task?: Task; qa?: boolean };
  orchestratorStatus: (
    m: unknown,
    now?: number,
  ) => { active: boolean; session: string | null; reason: string | null };
  newCursor: (
    previous: unknown,
    opt: { session?: string; event?: string; now?: string },
  ) => { session: string };
  missingProject: (
    tasks: Task[],
    register: Queue['projects'],
  ) => { withoutProject: string[]; withoutFeature: string[] };
  trackFileWarning: (
    o: Task,
    k: Collision[],
    mentioned?: { summary: string; subject: string }[],
  ) => string | null;
  ORCHESTRATOR_EXPIRY_MS: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const G = require('../queueGit') as {
  makeGit: (cwd: string) => (args: string[]) => string | null;
  readFirstParents: (
    git: (args: string[]) => string | null,
    window: { from?: string; to?: string; since?: string },
  ) => Commit[] | null;
  classify: (
    git: (args: string[]) => string | null,
    c: Commit[],
    opt?: { from?: string },
  ) => Commit[];
  readUncommitted: (
    git: (args: string[]) => string | null,
  ) => { xy: string; path: string; untracked: boolean }[];
  readOtherBranches: (
    git: (args: string[]) => string | null,
  ) => { name: string; count: number; files: string[] }[];
  externalImage: (
    git: (args: string[]) => string | null,
    queue: Queue,
    opt: { window: { from?: string; since?: string } },
  ) => {
    externalOnes: Commit[];
    consistency: { id: string; proposed: string | null }[];
    collisions: Collision[];
    branches: { name: string }[];
  };
  externalForTasks: (
    git: (args: string[]) => string | null,
    tasks: Task[],
  ) => Map<
    string,
    { collisions: Collision[]; mentioned: { summary: string }[]; warning: string | null }
  >;
};

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const o = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  status: 'waiting',
  mission: 'text',
  depends_on: [],
  waiting_on: [],
  owned_files: [],
  owner_db: [],
  shared_patch: [],
  ...extra,
});
const LONG_SINCE = '2000-01-01T00:00:00.000Z';
const FAR_AHEAD = '2999-01-01T00:00:00.000Z';

// ---- Temporary git repo (never the main repo, never git config) --------------------------------------------------
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const repos: string[] = [];
afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* Windows can hold a file for a moment; os.tmpdir is cleaned up anyway */
    }
  }
});

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-external-'));
  repos.push(dir);
  let n = 0;
  const g = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', ['-C', dir, ...ID, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  // Fixed, increasing times (September 2026), so "after added_at" is unambiguous.
  const time = () => {
    n += 1;
    const d = new Date(Date.parse('2026-09-01T10:00:00Z') + n * 60_000).toISOString();
    return { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d };
  };
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const commit = (file: string, ...messages: string[]) => {
    write(file, `${file} ${n}\n`);
    g(['add', '--', file]);
    g(['commit', '-q', ...messages.flatMap((m) => ['-m', m])], time());
    return g(['rev-parse', 'HEAD']);
  };
  /** A queue merge the way merge-track.mjs makes it: new branch queue/<id>, one commit, `merge --no-ff --no-edit`. */
  const queueMerge = (id: string, file: string) => {
    g(['checkout', '-q', '-b', `queue/${id}`]);
    commit(file, `feat: ${id}`);
    g(['checkout', '-q', 'main']);
    g(['merge', '-q', '--no-ff', '--no-edit', `queue/${id}`], time());
    return g(['rev-parse', 'HEAD']);
  };
  g(['init', '-q', '-b', 'main']);
  const base = commit('README.md', 'start');
  // origin/main without a remote: a ref is enough for the push check.
  g(['update-ref', 'refs/remotes/origin/main', base]);
  return { dir, g, commit, queueMerge, write, base, git: G.makeGit(dir) };
}

/** The first-parent line in origin/main..main, classified and oldest first (like push-check.mjs). */
function plan(r: ReturnType<typeof makeRepo>) {
  const raw = G.readFirstParents(r.git, { from: 'origin/main' }) ?? [];
  return K.pushPlan(
    G.classify(r.git, raw, { from: 'origin/main' }).reverse() as {
      sha: string;
      source: string;
    }[],
  );
}

function run(script: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'orchestrator', script), ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ---- Pure functions ----------------------------------------------------------------------------------------------
describe('classification of commits on main', () => {
  it('queue merge, orchestrator trailer, external, and a merge of another branch is external', () => {
    expect(
      K.classifyCommit({ parents: ['a', 'b'], subject: "Merge branch 'queue/A-T8c' into main" }),
    ).toEqual({
      source: 'queue',
      queue_id: 'A-T8c',
    });
    expect(
      K.classifyCommit({
        parents: ['a'],
        subject: 'chore(db): regenerate',
        message: 'chore\n\nQueue: orchestrator',
      }),
    ).toEqual({ source: 'orchestrator' });
    expect(
      K.classifyCommit({ parents: ['a'], subject: 'docs: plan', message: 'docs: plan' }).source,
    ).toBe('external');
    expect(
      K.classifyCommit({ parents: ['a', 'b'], subject: "Merge branch 'hotfix/x' into main" })
        .source,
    ).toBe('external');
    // A queue/ subject without a merge (two parents) is not a queue merge.
    expect(K.classifyCommit({ parents: ['a'], subject: "Merge branch 'queue/X'" }).source).toBe(
      'external',
    );
  });

  it('id consistency: (A-T8c) and A-T8c: match, but not A-T8c2, A-T8c-QA1 or XA-T8c', () => {
    const ids = ['A-T8c', 'A-T8'];
    expect(K.mentionedIds('fix: something (A-T8c)', ids)).toEqual(['A-T8c']);
    expect(K.mentionedIds('A-T8c: done', ids)).toEqual(['A-T8c']);
    expect(K.mentionedIds('A-T8c2 and A-T8c-QA1 and XA-T8c', ids)).toEqual([]);
    const s = K.consistency(
      [{ sha: 'abcdef1234', subject: 'fix: completed (A-T8c)', message: '' }],
      [o('A-T8c'), o('A-T8', { status: 'done' })],
    );
    expect(s).toEqual([
      expect.objectContaining({
        id: 'A-T8c',
        status: 'waiting',
        proposed: 'cq external accept A-T8c abcdef12',
      }),
    ]);
  });

  it('cutPoint: exists when all external commits come after the queue ones, otherwise not', () => {
    expect(
      K.pushPlan([
        { sha: 'k1', source: 'queue' },
        { sha: 'o1', source: 'orchestrator' },
      ]).externalOnes,
    ).toEqual([]);
    const after = K.pushPlan([
      { sha: 'k1', source: 'queue' },
      { sha: 'o1', source: 'orchestrator' },
      { sha: 'e1', source: 'external' },
      { sha: 'e2', source: 'external' },
    ]);
    expect(after).toMatchObject({ cutPoint: 'o1', merged: false });
    const between = K.pushPlan([
      { sha: 'k1', source: 'queue' },
      { sha: 'e1', source: 'external' },
      { sha: 'k2', source: 'queue' },
    ]);
    expect(between).toMatchObject({ cutPoint: null, merged: true });
    // Only external commits: nothing from the queue to push alone.
    expect(K.pushPlan([{ sha: 'e1', source: 'external' }])).toMatchObject({
      cutPoint: null,
      merged: false,
    });
  });
});

describe('collisions with the owned files', () => {
  const commit = {
    sha: 'c0ffee1234',
    subject: 'docs: changed plan',
    files: ['docs/plan.md'],
    date: '2026-09-30T10:00:00Z',
  };
  it('an external commit only counts for tasks added before it landed', () => {
    const k = K.externalCollisions(
      [
        o('BEFORE', { owned_files: ['docs/plan.md'], added_at: LONG_SINCE }),
        o('AFTER', { owned_files: ['docs/plan.md'], added_at: FAR_AHEAD }),
        o('DONE', { owned_files: ['docs/plan.md'], added_at: LONG_SINCE, status: 'done' }),
      ],
      { commits: [commit] },
    );
    expect(k.map((x) => x.id)).toEqual(['BEFORE']);
    expect(k[0]).toMatchObject({ source: 'commit', file: 'docs/plan.md', sha: 'c0ffee1234' });
  });

  it('branches, uncommitted files and folders (owner "folder/", untracked "new/")', () => {
    const k = K.externalCollisions(
      [
        o('RUN', { status: 'running', owned_files: ['src/lib/'], added_at: FAR_AHEAD }),
        o('V', { owned_files: ['new/file.md', 'other.md'], added_at: FAR_AHEAD }),
      ],
      { branches: [{ name: 'hotfix/x', files: ['src/lib/a.js'] }], uncommitted: ['new/'] },
    );
    expect(k).toEqual([
      expect.objectContaining({
        id: 'RUN',
        source: 'branch',
        branch: 'hotfix/x',
        file: 'src/lib/a.js',
        owner: 'src/lib/',
      }),
      expect.objectContaining({ id: 'V', source: 'uncommitted', file: 'new/', owner: 'new/file.md' }),
    ]);
    const text = K.trackFileWarning(o('RUN'), [k[0]]);
    expect(text).toContain('git diff main...hotfix/x -- src/lib/a.js');
    expect(K.trackFileWarning(o('X'), [])).toBeNull();
  });
});

describe('external add / done / accept', () => {
  it('a record owns the files like a picked task, until external done', () => {
    const queue: Queue = {
      tasks: [o('A', { owned_files: ['docs/plan.md'] }), o('B', { owned_files: ['b.md'] })],
      next_migr: 2840,
    };
    const r = K.externalAdd(queue, {
      name: 'owner-session 30.09',
      files: ['docs/plan.md'],
      branch: 'hotfix/y',
    });
    expect(r.error).toBeUndefined();
    expect(r.row).toMatchObject({
      id: 'external-owner-session-30-09',
      status: 'external',
      external: true,
      branch: 'hotfix/y',
    });
    expect(r.warnings?.join(' ')).toContain('A');
    expect(K.blockers(queue.tasks[0], queue.tasks).join(' ')).toContain(
      'work outside the queue: owner-session 30.09',
    );
    expect(K.selectNext(queue).map((v) => v.id)).toEqual(['B']);
    expect(K.pick(queue, 'A', { by: 'me' }).error).toContain('cannot be picked');
    // The record is not work: it does not count in projects and cannot be set to waiting.
    expect(K.projectOverview(queue).reduce((n, p) => n + p.total, 0)).toBe(2);
    expect(K.state(queue).external).toBe(1);
    expect(K.setStatus(r.row as Task, 'waiting').error).toContain('record outside the queue');
    expect(K.setStatus(queue.tasks[1], 'external').error).toContain('external add');
    // The same name again: the files are added.
    const r2 = K.externalAdd(queue, { name: 'owner-session 30.09', files: ['b.md'] });
    expect(r2.new).toBe(false);
    expect(r2.row?.owned_files).toEqual(['docs/plan.md', 'b.md']);
    expect(K.selectNext(queue)).toEqual([]);
    // Done: the files are free.
    expect(K.externalDone(queue, 'owner-session 30.09').row?.status).toBe('done');
    expect(
      K.selectNext(queue)
        .map((v) => v.id)
        .sort(),
    ).toEqual(['A', 'B']);
    expect(K.externalDone(queue, 'owner-session 30.09').error).toContain('no active record');
    expect(K.externalAdd(queue, { name: 'x' }).error).toContain('--files');
    expect(K.externalAdd(queue, { files: ['a'] }).error).toContain('--name');
  });

  it('accept: pending → done with a remark (visual → QA); picked and unknown are refused', () => {
    const queue: Queue = {
      tasks: [
        o('V1', { labels: ['visual'] }),
        o('P1', { status: 'picked', picked_by: 'me' }),
      ],
    };
    const r = K.externalAccept(queue, 'V1', 'abcdef1234567890', { mentioned: false });
    expect(r.task).toMatchObject({
      status: 'done',
      qa_status: 'waiting',
      done_outside_queue: 'abcdef1234567890',
    });
    expect(r.task?.remarks?.[0]).toMatch(
      /done outside the queue in abcdef12 \(the commit message does not mention the id\)$/,
    );
    expect(K.externalAccept(queue, 'P1', 'abc').error).toContain('picked by me');
    expect(K.externalAccept(queue, 'NO', 'abc').error).toContain('unknown');
  });

  it('tasks without a project or feature show up (the LK family 30.09)', () => {
    const m = K.missingProject(
      [
        o('LK-1a', { feature: 'Legal requirement' }),
        o('A-1', { feature: 'x' }),
        o('A-2'),
        o('OLD', { status: 'done' }),
      ],
      { tf: { title: 'TF', prefixes: ['A-'] } },
    );
    expect(m).toEqual({ withoutProject: ['LK-1a'], withoutFeature: ['A-2'] });
  });
});

describe('next skips uncommitted owned files', () => {
  it('selectNext, uncommittedSkipped and state say why', () => {
    const queue: Queue = {
      tasks: [o('A', { owned_files: ['docs/plan.md'] }), o('B', { owned_files: ['b.md'] })],
    };
    expect(K.selectNext(queue, Date.now(), { uncommitted: ['docs/plan.md'] }).map((v) => v.id)).toEqual([
      'B',
    ]);
    expect(K.uncommittedSkipped(queue, ['docs/plan.md'])).toEqual([
      { id: 'A', file: 'docs/plan.md', path: 'docs/plan.md' },
    ]);
    const t = K.state(queue, undefined, { uncommitted: ['docs/'] });
    expect(t.blocked).toEqual([{ id: 'A', blockers: ['file docs/ is uncommitted in the main tree'] }]);
    expect(K.uncommittedCollision(queue.tasks[1], ['docs/'])).toBeNull();
  });
});

describe('orchestrator cursor', () => {
  it('active until 2 h without an update, then expired; newCursor keeps the session name', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const m = K.newCursor(null, {
      session: 'queue-session 30.09',
      event: 'start X',
      now: '2026-09-30T11:00:00Z',
    });
    expect(K.orchestratorStatus(m, now)).toMatchObject({ active: true, session: 'queue-session 30.09' });
    expect(K.orchestratorStatus(m, now + K.ORCHESTRATOR_EXPIRY_MS)).toMatchObject({ active: false });
    expect(K.orchestratorStatus(null, now)).toMatchObject({ active: false, reason: 'no marker' });
    expect(K.newCursor(m, { event: 'pulse' }).session).toBe('queue-session 30.09');
    expect(K.newCursor(null, {}).session).toBe('orchestrator');
  });
});

// ---- Against a temporary git repo ------------------------------------------------------------------------------------
describe('against a temporary git repo', () => {
  it('queue merge + orchestrator trailer: no external commits, push-check exit 0', () => {
    const r = makeRepo();
    r.queueMerge('A-1', 'a.txt');
    r.commit('org.json', 'chore(db): regenerate org tables', 'Queue: orchestrator');
    const p = plan(r);
    expect(p).toMatchObject({ total: 2, queue: 1, orchestrator: 1, externalOnes: [] });
    const cli = run('push-check.mjs', [], { QUEUE_GIT: r.dir });
    expect(cli.code).toBe(0);
    expect(cli.out).toContain('0 external.');
  }, 60_000);

  it('external commit AFTER the queue ones: a safe cutPoint (exit 2, git push origin <sha>:main)', () => {
    const r = makeRepo();
    const merge = r.queueMerge('A-1', 'a.txt');
    r.commit('docs/plan.md', 'docs: plan from another session');
    const p = plan(r);
    expect(p).toMatchObject({ cutPoint: merge, merged: false });
    expect(p.externalOnes).toHaveLength(1);
    const cli = run('push-check.mjs', [], { QUEUE_GIT: r.dir });
    expect(cli.code).toBe(2);
    expect(cli.out).toContain(`safe cut point: ${merge.slice(0, 8)}`);
    expect(cli.out).toContain(`git push origin ${merge}:main`);
    expect(cli.out).toContain('docs/plan.md');
  }, 60_000);

  it('external commit BEFORE the queue ones: no cutPoint, and the history is never rewritten', () => {
    const r = makeRepo();
    r.commit('docs/plan.md', 'docs: plan from another session');
    r.queueMerge('A-1', 'a.txt');
    expect(plan(r)).toMatchObject({ cutPoint: null, merged: true });
    const cli = run('push-check.mjs', ['--json'], { QUEUE_GIT: r.dir });
    expect(cli.code).toBe(2);
    expect(JSON.parse(cli.out)).toMatchObject({ cutPoint: null, merged: true, queue: 1 });
  }, 60_000);

  it('a merge of a hotfix branch is external and brings its commits along', () => {
    const r = makeRepo();
    r.g(['checkout', '-q', '-b', 'hotfix/x']);
    r.commit('fix.txt', 'fix: urgent fix (A-T8c)');
    r.g(['checkout', '-q', 'main']);
    r.g(['merge', '-q', '--no-ff', '--no-edit', 'hotfix/x']);
    const [c] = G.classify(r.git, G.readFirstParents(r.git, { from: 'origin/main' }) ?? [], {
      from: 'origin/main',
    });
    expect(c.source).toBe('external');
    expect(c.files).toEqual(['fix.txt']);
    expect(c.side?.map((s) => s.subject)).toEqual(['fix: urgent fix (A-T8c)']);
  }, 60_000);

  it('the external image: id consistency, collisions (commit, branch, uncommitted) and the warning for the track file', () => {
    const r = makeRepo();
    r.queueMerge('A-1', 'a.txt');
    const external = r.commit('docs/plan.md', 'docs: A-T8c: the plan is written');
    // A branch outside queue/* that is not merged, and an uncommitted file in the tree.
    r.g(['checkout', '-q', '-b', 'hotfix/z']);
    r.commit('hot.md', 'fix: hot');
    r.g(['checkout', '-q', 'main']);
    r.write('README.md', 'changed, not committed\n');
    const queue: Queue = {
      tasks: [
        o('A-T8c', { owned_files: ['docs/plan.md'], added_at: LONG_SINCE }),
        o('NEW', { owned_files: ['docs/plan.md'], added_at: FAR_AHEAD }),
        o('HOT', { status: 'running', owned_files: ['hot.md', 'README.md'], added_at: FAR_AHEAD }),
        o('A-1', { status: 'done', owned_files: ['a.txt'] }),
      ],
    };
    const b = G.externalImage(r.git, queue, { window: { from: 'origin/main' } });
    expect(b.externalOnes.map((c) => c.sha)).toEqual([external]);
    expect(b.consistency).toEqual([
      expect.objectContaining({
        id: 'A-T8c',
        proposed: `cq external accept A-T8c ${external.slice(0, 8)}`,
      }),
    ]);
    expect(b.branches.map((g) => g.name)).toEqual(['hotfix/z']);
    const summary = b.collisions.map((k) => `${k.id}:${k.source}:${k.file}`).sort();
    expect(summary).toEqual([
      'A-T8c:commit:docs/plan.md',
      'HOT:branch:hot.md',
      'HOT:uncommitted:README.md',
    ]);
    // start/pick/trackFile: the warning for the running task.
    const v = G.externalForTasks(r.git, [queue.tasks[2]]).get('HOT');
    expect(v?.warning).toContain('hotfix/z');
    expect(v?.warning).toContain('README.md');
  }, 60_000);

  it('queue.mjs: next skips an uncommitted collision; external add/done; orchestrator cursor', () => {
    const r = makeRepo();
    r.commit('docs/plan.md', 'docs: plan');
    r.write('docs/plan.md', 'uncommitted change\n');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-folder-'));
    repos.push(folder);
    const task = (id: string, file: string) => ({
      ...o(id, { owned_files: [file] }),
      value: 5,
      content_min: 30,
      migr_tens: 0,
    });
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created: LONG_SINCE,
        limits: {},
        next_migr: 2840,
        resolved: [],
        tasks: [task('A', 'docs/plan.md'), task('B', 'b.md')],
      }),
    );
    const env = { QUEUE_FOLDER: folder, QUEUE_GIT: r.dir };
    const next = run('queue.mjs', ['next'], env);
    expect(next.code).toBe(0);
    expect(next.out).toMatch(/^B\s/m);
    expect(next.out).toContain('Skipped 1');
    expect(next.out).toMatch(/A\s+file docs\/plan\.md/);
    expect(run('queue.mjs', ['start', 'A'], env).out).toContain('uncommitted in the main tree');

    const add = run('queue.mjs', ['external', 'add', '--name', 'owner-session', '--files', 'b.md'], env);
    expect(add.out).toContain('Registered external-owner-session');
    expect(run('queue.mjs', ['next'], env).out).toContain('Nothing can start now');
    expect(run('queue.mjs', ['external', 'done', 'owner-session'], env).out).toContain('done');
    expect(run('queue.mjs', ['next'], env).out).toMatch(/^B\s/m);

    expect(run('queue.mjs', ['orchestrator'], env).out).toContain('NO ACTIVE ORCHESTRATOR');
    expect(run('queue.mjs', ['orchestrator', 'pulse', '--session', 'test-session'], env).code).toBe(0);
    expect(run('queue.mjs', ['orchestrator'], env).out).toContain('ACTIVE ORCHESTRATOR: "test-session"');
    run('queue.mjs', ['orchestrator', 'stop'], env);
    expect(run('queue.mjs', ['orchestrator'], env).out).toContain('NO ACTIVE ORCHESTRATOR');
  }, 120_000);
});
