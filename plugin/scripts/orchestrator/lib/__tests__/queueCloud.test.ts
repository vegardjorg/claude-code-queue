// =============================================================
// queueCloud.test.ts: queue tasks in cloud sessions.
//
// The cloud session on claude.ai only sees what is pushed and has no database. The rules are proven where they are enforced:
//   - the pure functions in lib/queueLogic.js (cloudSuitable, cloudPackage/cloudBundlePackage, cloudBundles, cloudStart/Done/Cancel),
//   - queue.mjs (cloud-package, cloud start/done/cancel) against a copy of the queue in a temporary folder (QUEUE_FOLDER), a
//     temporary git repo with a fake origin (QUEUE_GIT, a bare folder in os.tmpdir()) and a temporary time log
//     (QUEUE_TIME_LOG). Never the main repo, never the real queue, and without `git config` (the identity is given with -c).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = {
  id: string;
  title?: string;
  domain?: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  value?: number;
  content_min?: number;
  migr_tens?: number;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  owner_db?: string[];
  shared_patch?: string[];
  project?: string;
  feature?: string;
  branch?: string;
  picked_by?: string;
  picked_at?: string;
  delivered?: string;
  remarks?: string[];
  cloud?: {
    started: string;
    execution?: string;
    bundle?: string;
    done?: string;
    branch?: string;
    sha?: string;
  };
};
type Queue = { tasks: Task[]; resolved?: string[]; next_migr?: number; projects?: object };
type Suitable = { suitable: boolean; reasons: string[] };
type Del = { o: Task; text: string; ownPath?: string | null };

// The config the tests run with: the defaults (baseBranch main, remote origin, branchPrefix queue/) plus folders the cloud
// does not see, and the cloud module on (features.cloud is off by default). Set before queueLogic reads the config the
// first time.
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-cloud-config-'));
const CONFIG_FILE = path.join(CONFIG_DIR, 'queue.config.json');
fs.writeFileSync(
  CONFIG_FILE,
  JSON.stringify({ cloudHidden: ['docs/private', 'notes'], features: { cloud: true } }),
);
process.env.QUEUE_CONFIG = CONFIG_FILE;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../queueLogic') as {
  resetConfig: () => void;
  CLOUD_MAX: number;
  CLOUD_BUNDLE_MAX: number;
  CLOUD_BUNDLE_MIN: number;
  isCloud: (o: Task) => boolean;
  cloudReferences: (
    text: string,
    v?: { id?: string; ownPath?: string | null },
  ) => { path: string; area: string; boosted: boolean }[];
  cloudSuitable: (
    queue: Queue,
    id: string,
    v?: {
      pushedHead?: string | null;
      changed?: string[];
      missionText?: string;
      ownPath?: string | null;
    },
  ) => Suitable;
  cloudPackage: (o: Task, queue: Queue, v: { text: string; ownPath?: string | null }) => string;
  cloudBundlePackage: (parts: Del[], queue: Queue) => string;
  cloudBundleCap: (o: Task[], v?: { max?: number; maxMin?: number }) => string[];
  cloudBundles: (
    k: { id: string; project: string; feature?: string | null; estimate: number; score: number }[],
    v?: { max?: number; maxMin?: number },
  ) => { ids: string[]; minutes: number; areas: string[] }[];
  cloudSessions: (queue: Queue) => number;
  cloudStart: (
    queue: Queue,
    ids: string | string[],
    v?: {
      suitability?: Record<string, Suitable>;
      execution?: string | null;
      force?: boolean;
      now?: string;
    },
  ) => { error?: string; newOnes?: string[]; left?: string[]; overridden?: string[] };
  cloudDone: (
    queue: Queue,
    id: string,
    v?: { branch?: string; sha?: string | null; now?: string },
  ) => {
    error?: string;
  };
  cloudCancel: (
    queue: Queue,
    id: string,
    v?: { commits?: number },
  ) => { error?: string; warning?: string | null };
  release: (queue: Queue, id: string) => { error?: string };
};

const NOW = '2026-10-01T10:00:00.000Z';
const HEAD = 'a'.repeat(40);

/** A pending K task without migrations and DB: suitable for the cloud when nothing else is said. */
function o(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    domain: 'tool',
    class: 'K',
    status: 'waiting',
    value: 5,
    content_min: 30,
    migr_tens: 0,
    depends_on: [],
    waiting_on: [],
    owned_files: [`lib/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `# ${id}\nDo ${id}.\nmore text`,
    ...extra,
  };
}
const queue = (...tasks: Task[]): Queue => ({ tasks, resolved: [], next_migr: 2840 });
const suitable = (k: Queue, id: string, v: Parameters<typeof K.cloudSuitable>[2] = {}) =>
  K.cloudSuitable(k, id, { pushedHead: HEAD, changed: [], ...v });

// ---- Suitability ---------------------------------------------------------------------------------------------------
describe('cloudSuitable', () => {
  it('a pending K task without migrations, DB and blockers is suitable; U too', () => {
    expect(suitable(queue(o('A')), 'A')).toEqual({ suitable: true, reasons: [] });
    expect(suitable(queue(o('A', { class: 'U' })), 'A').suitable).toBe(true);
  });

  it('D, D+, migrations, owner_db and shared_patch each give their own reason', () => {
    const r = suitable(
      queue(o('A', { class: 'D', migr_tens: 1, owner_db: ['fn_x'], shared_patch: ['anonymize_user'] })),
      'A',
    );
    expect(r.suitable).toBe(false);
    expect(r.reasons).toHaveLength(4);
    expect(r.reasons.join('\n')).toMatch(/class D/);
    expect(r.reasons.join('\n')).toMatch(/migrations/);
    expect(r.reasons.join('\n')).toMatch(/fn_x/);
    expect(r.reasons.join('\n')).toMatch(/anonymize_user/);
    expect(suitable(queue(o('A', { class: 'D+' })), 'A').suitable).toBe(false);
  });

  it('open dependencies and owner questions stop it; resolved and done do not', () => {
    const k = queue(o('A', { depends_on: ['B'], waiting_on: ['Q1'] }), o('B'));
    const r = suitable(k, 'A');
    expect(r.reasons.some((g) => g.includes('open dependency') && g.includes('B'))).toBe(true);
    expect(r.reasons.some((g) => g.includes('open owner question: Q1'))).toBe(true);
    k.tasks[1].status = 'done';
    k.resolved = ['Q1'];
    expect(suitable(k, 'A').suitable).toBe(true);
  });

  it('references to folders in config().cloudHidden stop it', () => {
    K.resetConfig();
    for (const filePath of ['docs/private/note.md', 'C:\\project\\notes\\x.md', 'notes/y.ts']) {
      const r = suitable(queue(o('A')), 'A', { missionText: `Read \`${filePath}\` first.` });
      expect(r.suitable).toBe(false);
      expect(r.reasons.join(' ')).toMatch(/files the cloud does not see/);
    }
  });

  it('the own mission file and a source line where the binding content is "lifted in" do not stop it', () => {
    const text = [
      'Source: `C:\\project\\docs\\private\\plan.md` (GITIGNORED; everything binding is lifted in here)',
      'See also scripts/.queue/mission/A.md (this file).',
    ].join('\n');
    expect(suitable(queue(o('A')), 'A', { missionText: text }).suitable).toBe(true);
    expect(
      suitable(queue(o('A')), 'A', {
        missionText: 'Read scripts/.queue/mission/ownOne.md',
        ownPath: 'scripts/.queue/mission/ownOne.md',
      }).suitable,
    ).toBe(true);
    // Another task's mission is context: the package explains that the file does not exist, and it does not
    // close.
    expect(suitable(queue(o('A')), 'A', { missionText: 'See scripts/.queue/mission/B.md' }).suitable).toBe(
      true,
    );
  });

  it('owned files changed locally since origin/main ("push first"), also under an owned folder', () => {
    const r = suitable(queue(o('A', { owned_files: ['lib/a/', 'lib/b.ts'] })), 'A', {
      changed: ['lib/a/x.ts', 'other.ts'],
    });
    expect(r.suitable).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/lib\/a\/x\.ts.*push main first/);
    expect(suitable(queue(o('A')), 'A', { changed: ['other.ts'] }).suitable).toBe(true);
  });

  it('without origin/main it cannot be checked: not suitable', () => {
    const r = K.cloudSuitable(queue(o('A')), 'A', { pushedHead: null });
    expect(r.suitable).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/origin\/main/);
  });

  it('running and picked tasks are not suitable; a task in the cloud still is (the package can be copied again)', () => {
    expect(suitable(queue(o('A', { status: 'running' })), 'A').reasons).toEqual(['status running']);
    expect(suitable(queue(o('A', { status: 'picked', picked_by: 'owner' })), 'A').suitable).toBe(false);
    const cloud = o('A', { status: 'picked', picked_by: 'cloud', cloud: { started: NOW } });
    expect(suitable(queue(cloud), 'A').suitable).toBe(true);
  });
});

// ---- The package -----------------------------------------------------------------------------------------------
describe('cloudPackage and cloudBundlePackage', () => {
  it('one task: the whole mission with the track block, the branch rule, the lock rule and the report line', () => {
    const a = o('A', { source: 'plan § 1' } as Partial<Task>);
    const text =
      '# A\nWhole mission.\nOther line.\nRead docs/private/x.md (everything binding is lifted in).';
    const p = K.cloudPackage(a, queue(a), { text });
    expect(p).toMatch(/^# CLOUD TRACK A \(class K, approx\. 30 min\)/);
    expect(p).toContain('git checkout -b queue/A origin/main');
    expect(p).toContain('Push only branch queue/A');
    expect(p).toMatch(/Never main, never PR/);
    expect(p).toContain('package-lock.json');
    expect(p).toContain('"CLOUD-DONE A <sha>" or "CLOUD-STOP A <reason>"');
    expect(p).toContain('## TRACK A (Task A; source: plan § 1; class K, estimate 30 min)');
    expect(p).toContain('**Ownership in the queue:** files lib/A.ts; DB none; shared patch none.');
    expect(p).toContain('stop with CLOUD-STOP');
    expect(p).not.toContain('SendMessage');
    expect(p).toContain('Whole mission.\nOther line.');
    // The reference the cloud cannot follow is explained.
    expect(p).toMatch(/Files the cloud does not see.*docs\/private\/x\.md/);
  });

  it('bundle: the order is kept, own branch per task from origin/main, a report line per task and the summary line', () => {
    const [a, b, c] = [o('A'), o('B'), o('C')];
    const k = queue(a, b, c);
    const p = K.cloudBundlePackage(
      [
        { o: c, text: 'Mission C' },
        { o: a, text: 'Mission A' },
        { o: b, text: 'Mission B' },
      ],
      k,
    );
    expect(p).toMatch(/^# CLOUD BUNDLE C, A, B \(3 tasks, approx\. 90 min\)/);
    expect(p).toContain('C → A → B');
    expect(p).toContain('git checkout -b queue/<id> origin/main');
    expect(p).toMatch(/never from the previous\s+task's branch/);
    expect(p).toContain('"CLOUD-DONE <id> <sha>"');
    expect(p).toContain('"CLOUD-STOP <id> <reason>"');
    expect(p).toContain('A stop does not hinder the next ones');
    expect(p).toContain('"CLOUD-BUNDLE-DONE <count CLOUD-DONE>/3"');
    expect(p).toContain('package-lock.json');
    const i = (s: string) => p.indexOf(s);
    expect(i('# Task 1 of 3: C (branch queue/C)')).toBeGreaterThan(0);
    expect(i('# Task 1 of 3: C')).toBeLessThan(i('# Task 2 of 3: A'));
    expect(i('# Task 2 of 3: A')).toBeLessThan(i('# Task 3 of 3: B'));
    expect(i('Mission C')).toBeLessThan(i('Mission A'));
  });

  it('a bundle with one task is the usual cloudPackage', () => {
    const a = o('A');
    expect(K.cloudBundlePackage([{ o: a, text: 'x' }], queue(a))).toBe(
      K.cloudPackage(a, queue(a), { text: 'x' }),
    );
  });

  it('the cap: at most 4 tasks, approx. 120 min and no id twice', () => {
    expect(K.CLOUD_BUNDLE_MAX).toBe(4);
    expect(K.CLOUD_BUNDLE_MIN).toBe(120);
    expect(K.cloudBundleCap([o('A'), o('B'), o('C'), o('D')])).toEqual([]);
    expect(K.cloudBundleCap([o('A'), o('B'), o('C'), o('D'), o('E')]).join(' ')).toMatch(/5 tasks/);
    expect(
      K.cloudBundleCap([o('A', { content_min: 70 }), o('B', { content_min: 60 })]).join(' '),
    ).toMatch(/130 min/);
    expect(K.cloudBundleCap([o('A'), o('A')]).join(' ')).toMatch(/twice/);
  });

  it('proposals for bundles: the same area one after the other, best priority first, the cap holds', () => {
    const k = (id: string, project: string, score: number, estimate = 30) => ({
      id,
      project,
      feature: null,
      estimate,
      score,
    });
    const b = K.cloudBundles([
      k('X1', 'x', 50),
      k('Y1', 'y', 90),
      k('X2', 'x', 40),
      k('Y2', 'y', 10),
      k('Z1', 'z', 5, 200),
    ]);
    expect(b.map((x) => x.ids)).toEqual([['Y1', 'Y2', 'X1', 'X2'], ['Z1']]);
    expect(b[0].minutes).toBe(120);
    expect(b[0].areas).toEqual(['y', 'x']);
    expect(K.cloudBundles([k('A', 'p', 1), k('B', 'p', 2)], { max: 1 }).map((x) => x.ids)).toEqual([
      ['B'],
      ['A'],
    ]);
  });
});

// ---- Status ----------------------------------------------------------------------------------------------------
describe('cloudStart, cloudDone and cloudCancel', () => {
  it('start picks for "cloud" with branch queue/<id> and cloud.started/execution; done gives review; cancel gives waiting', () => {
    const k = queue(o('A'));
    const r = K.cloudStart(k, 'A', { execution: 'cse_1', now: NOW });
    expect(r.error).toBeUndefined();
    const a = k.tasks[0];
    expect(a).toMatchObject({ status: 'picked', picked_by: 'cloud', branch: 'queue/A' });
    expect(a.cloud).toEqual({ started: NOW, execution: 'cse_1' });
    expect(K.isCloud(a)).toBe(true);

    expect(
      K.cloudDone(k, 'A', { branch: 'claude/x', sha: 'abc1234', now: NOW }).error,
    ).toBeUndefined();
    expect(a.status).toBe('review');
    expect(a.delivered).toBe(NOW);
    expect(a.cloud).toMatchObject({ done: NOW, branch: 'claude/x', sha: 'abc1234' });
    expect(K.cloudDone(k, 'A').error).toMatch(/is not in a cloud session/);

    const k2 = queue(o('B'));
    K.cloudStart(k2, 'B', { now: NOW });
    expect(K.cloudCancel(k2, 'B').error).toBeUndefined();
    expect(k2.tasks[0].status).toBe('waiting');
    expect(k2.tasks[0].cloud).toBeUndefined();
    expect(k2.tasks[0].picked_by).toBeUndefined();
    expect(k2.tasks[0].remarks?.join(' ')).toMatch(/cloud session aborted/);
  });

  it('not suitable, over the cap and four cloud sessions refuse; --force overrides', () => {
    const k = queue(o('A'));
    const not = { A: { suitable: false, reasons: ['class D'] } };
    expect(K.cloudStart(k, 'A', { suitability: not }).error).toMatch(/not suitable.*class D.*--force/);
    expect(k.tasks[0].status).toBe('waiting');
    expect(K.cloudStart(k, 'A', { suitability: not, force: true }).overridden).toContain(
      'A is not suitable for the cloud: class D',
    );

    const five = queue(o('A'), o('B'), o('C'), o('D'), o('E'));
    expect(K.cloudStart(five, ['A', 'B', 'C', 'D', 'E']).error).toMatch(/over the cap/);

    const many = queue(o('A'), o('B'), o('C'), o('D'));
    for (const id of ['A', 'B', 'C']) expect(K.cloudStart(many, id).error).toBeUndefined();
    expect(K.cloudSessions(many)).toBe(3);
    expect(K.cloudStart(many, 'D').error).toMatch(/3 cloud sessions are already running/);
    expect(K.cloudStart(many, 'D', { force: true }).error).toBeUndefined();
  });

  it('a bundle is one cloud session; the same id again only sets the run', () => {
    const k = queue(o('A'), o('B'), o('C'));
    const r = K.cloudStart(k, ['A', 'B', 'C'], { now: NOW });
    expect(r.newOnes).toEqual(['A', 'B', 'C']);
    expect(K.cloudSessions(k)).toBe(1);
    expect(k.tasks[0].cloud?.bundle).toBe('A,B,C');
    const left = K.cloudStart(k, ['A', 'B', 'C'], { execution: 'cse_9' });
    expect(left.left).toEqual(['A', 'B', 'C']);
    expect(k.tasks.every((x) => x.cloud?.execution === 'cse_9')).toBe(true);
    expect(K.cloudSessions(k)).toBe(1);
  });

  it('a usual release also removes the cloud field', () => {
    const k = queue(o('A'));
    K.cloudStart(k, 'A');
    K.release(k, 'A');
    expect(k.tasks[0].cloud).toBeUndefined();
  });
});

// ---- queue.mjs against a copy and a fake origin ------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const cleanup: string[] = [];
afterAll(() => {
  for (const r of [...cleanup, CONFIG_DIR]) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* Windows can hold a file for a moment; os.tmpdir is cleaned up anyway */
    }
  }
});

function tmp(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

describe('queue.mjs cloud-package and cloud start/done/cancel (copy of the queue, fake origin)', () => {
  it('package, bundle, start, done from another branch, cancel and the time log', () => {
    const origin = tmp('queue-cloud-origin-');
    const repo = tmp('queue-cloud-repo-');
    const folder = tmp('queue-cloud-folder-');
    const log = path.join(folder, 'times.jsonl');
    const g = (args: string[], cwd = repo) =>
      execFileSync('git', ['-C', cwd, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const commit = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
      g(['add', '--', file]);
      g(['commit', '-q', '-m', `edit ${file}`]);
    };
    g(['init', '-q', '--bare'], origin);
    g(['init', '-q', '-b', 'main']);
    commit('README.md', 'start\n');
    g(['remote', 'add', 'origin', origin]);
    g(['push', '-q', 'origin', 'main']);
    g(['fetch', '-q', 'origin']);
    // Changed locally and not pushed: the owned file of C.
    commit('lib/C.ts', 'local\n');

    const missionA = path.join(folder, 'A.md');
    fs.writeFileSync(missionA, '# A\nWhole mission for A.\n');
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created: NOW,
        limits: {},
        next_migr: 2840,
        resolved: [],
        tasks: [o('A', { mission: missionA }), o('B'), o('C'), o('D', { class: 'D' })],
      }),
    );
    const env = { ...process.env, QUEUE_FOLDER: folder, QUEUE_GIT: repo, QUEUE_TIME_LOG: log };
    const run = (...args: string[]) => {
      const r = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args],
        {
          encoding: 'utf8',
          env,
        },
      );
      return { code: r.status, out: r.stdout, error: r.stderr };
    };
    const read = (): Queue => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'));
    const find = (id: string) => read().tasks.find((x) => x.id === id)!;

    // cloud-package: the mission from the file, the branch rule and the report line; refuses for D and for a locally changed owned file.
    const p = run('cloud-package', 'A');
    expect(p.code).toBe(0);
    expect(p.out).toContain('Whole mission for A.');
    expect(p.out).toContain('git checkout -b queue/A origin/main');
    expect(p.out).toContain('"CLOUD-DONE A <sha>"');
    const d = run('cloud-package', 'D');
    expect(d.code).toBe(1);
    expect(d.error).toMatch(/class D/);
    const c = run('cloud-package', 'C');
    expect(c.code).toBe(1);
    expect(c.error).toMatch(/lib\/C\.ts.*push main first/);
    expect(run('cloud-package', 'D', '--force').code).toBe(0);
    // Bundle to a file.
    const out = path.join(folder, 'bundle.md');
    expect(run('cloud-package', 'A', 'B', '--out', out).code).toBe(0);
    const bundle = fs.readFileSync(out, 'utf8');
    expect(bundle).toMatch(/^# CLOUD BUNDLE A, B/);
    expect(bundle).toContain('CLOUD-BUNDLE-DONE <count CLOUD-DONE>/2');

    // cloud start (bundle) with execution; D is refused.
    expect(run('cloud', 'start', 'D').code).toBe(1);
    const s = run('cloud', 'start', 'A', 'B', '--run', 'cse_test');
    expect(s.code).toBe(0);
    expect(find('A')).toMatchObject({ status: 'picked', picked_by: 'cloud', branch: 'queue/A' });
    expect(find('A').cloud).toMatchObject({ execution: 'cse_test', bundle: 'A,B' });

    // cloud done: the branch does not exist on origin -> refuses and stays in the cloud.
    const missing = run('cloud', 'done', 'A');
    expect(missing.code).toBe(1);
    expect(find('A').status).toBe('picked');

    // The cloud pushed to claude/jolly-x (not queue/A): one commit above origin/main.
    g(['checkout', '-q', '-b', 'cloud-work', 'origin/main']);
    commit('lib/A.ts', 'from the cloud\n');
    g(['push', '-q', 'origin', 'cloud-work:claude/jolly-x']);
    const sha = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    g(['branch', '-q', '-D', 'cloud-work']);

    const f = run('cloud', 'done', 'A', '--branch', 'claude/jolly-x', '--sha', sha.slice(0, 10));
    expect(f.code).toBe(0);
    expect(f.out).toContain('cq merge-track queue/A');
    expect(f.out).toContain('git push origin --delete claude/jolly-x');
    expect(find('A').status).toBe('review');
    expect(find('A').cloud).toMatchObject({ branch: 'claude/jolly-x', sha: sha.slice(0, 10) });
    // Local queue/A is on the cloud's commit, so merge-track and "Merge branch 'queue/A'" work as for a local track.
    expect(g(['rev-parse', 'queue/A'])).toBe(sha);

    // A wrong sha refuses (B stays in the cloud).
    g(['push', '-q', 'origin', `${sha}:refs/heads/queue/B`]);
    expect(run('cloud', 'done', 'B', '--sha', 'deadbee').code).toBe(1);
    // cancel = release.
    expect(run('cloud', 'cancel', 'B').code).toBe(0);
    expect(find('B').status).toBe('waiting');
    expect(find('B').cloud).toBeUndefined();

    const events = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((r) => `${r.track} ${r.event}`);
    expect(events).toEqual(
      expect.arrayContaining(['A cloud-start', 'B cloud-start', 'A cloud-done', 'B cloud-aborted']),
    );
  }, 120_000);
});
