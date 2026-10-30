// =============================================================
// mergeGuard.test.ts: the guard check merge-track.mjs runs before a track branch is merged.
//
// Locks that a change to a protected path (.claude/, scripts/orchestrator/, plugin hooks and agents, queue.config.json,
// package.json …) stops the merge unless the task owns the path, that folder ownership ("/" last) covers subfolders,
// that a rename into (or out of) a protected path is caught, and that files outside the ownership only warn. The last
// block runs merge-track.mjs in a temporary repo: exit 4 before the merge, and --allow-guard lets it through and logs.
// See lib/mergeGuard.js.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assessGuard, isProtected, migrCovered, readDiff, taskIdFromBranch } from '../mergeGuard';
import { STANDARD } from '../queueConfig';

const changed = (...paths: string[]) => paths.map((p) => ({ status: 'M', paths: [p] }));
const MIGR = { folder: 'db/migrations', filePattern: '^(\\d+)_.*\\.sql$' };

describe('protected paths (the default list)', () => {
  it('recognises hooks, settings, agents, skills, orchestrator scripts, the queue config and package files', () => {
    for (const p of [
      '.claude/settings.json',
      '.claude/agents/track.md',
      '.claude/skills/queue/SKILL.md',
      '.githooks/pre-commit',
      '.github/workflows/ci.yml',
      '.mcp.json',
      'scripts/orchestrator/merge-track.mjs',
      'scripts/orchestrator/lib/pushGuard.js',
      'plugin/scripts/orchestrator/hook-push-guard.mjs',
      'plugin/hooks/hooks.json',
      'plugin/agents/track-d.md',
      'plugin/skills/queue/SKILL.md',
      'plugin/.claude-plugin/plugin.json',
      'queue.config.json',
      'CLAUDE.queue.md',
      'plugin/CLAUDE.queue.md',
      'plugin/settings.queue.json',
      'package.json',
      'package-lock.json',
      'admin/package.json',
    ])
      expect(isProtected(p), p).toBe(true);
  });
  it('lets ordinary code through', () => {
    for (const p of [
      'src/index.ts',
      'scripts/orchestratorX.mjs',
      'plugin/docs/orchestration.md',
      'docs/mission-template.md',
      'README.md',
      'node_modules/foo/package.json',
      'app/node_modules/x/package.json',
    ])
      expect(isProtected(p), p).toBe(false);
  });
  it('normalises backslash and ./', () => {
    expect(isProtected('.\\.claude\\settings.json')).toBe(true);
    expect(isProtected('./package.json')).toBe(true);
  });
  it('follows a configured list, and an empty list turns the guard off', () => {
    expect(isProtected('infra/deploy.sh', ['infra/'])).toBe(true);
    expect(isProtected('.claude/settings.json', ['infra/'])).toBe(false);
    expect(isProtected('.claude/settings.json', [])).toBe(false);
    expect(STANDARD.protectedPaths).toContain('queue.config.json');
  });
});

describe('assessGuard', () => {
  it('stops a settings.json change without ownership', () => {
    const r = assessGuard({ changes: changed('.claude/settings.json', 'src/x.ts'), ownedFiles: ['src/x.ts'] });
    expect(r.violations.map((b) => b.path)).toEqual(['.claude/settings.json']);
    expect(r.stop).toBe(true);
  });
  it('lets a protected path through when the task owns it, in owned_files or shared_patch', () => {
    const r = assessGuard({
      changes: changed('plugin/agents/track.md', 'plugin/scripts/orchestrator/merge-track.mjs'),
      ownedFiles: ['plugin/agents/track.md'],
      sharedPatch: ['plugin/scripts/orchestrator/merge-track.mjs'],
    });
    expect(r.violations).toEqual([]);
    expect(r.drift).toEqual([]);
    expect(r.stop).toBe(false);
  });
  it('folder ownership with "/" last covers subfolders, but not look-alike names', () => {
    const r = assessGuard({
      changes: changed('.claude/skills/plan/SKILL.md', '.claude/skills-x/a.md'),
      ownedFiles: ['.claude/skills/'],
    });
    expect(r.violations.map((b) => b.path)).toEqual(['.claude/skills-x/a.md']);
  });
  it('file ownership without "/" does not cover a path with the same prefix', () => {
    const r = assessGuard({
      changes: changed('scripts/orchestrator/queue.mjs.bak'),
      ownedFiles: ['scripts/orchestrator/queue.mjs'],
    });
    expect(r.violations).toHaveLength(1);
  });
  it('a rename INTO a protected path is caught (new path), also from an owned file', () => {
    const r = assessGuard({
      changes: readDiff('R100\tsrc/harmless.js\t.githooks/pre-push\n'),
      ownedFiles: ['src/harmless.js'],
    });
    expect(r.violations.map((b) => b.path)).toEqual(['.githooks/pre-push']);
    expect(r.violations[0].reason).toMatch(/renamed from src\/harmless\.js/);
  });
  it('a rename OUT of a protected path is caught (it deletes the protected file)', () => {
    const r = assessGuard({
      changes: readDiff('R090\t.claude/settings.json\tdocs/old.json\n'),
      ownedFiles: ['docs/old.json'],
    });
    expect(r.violations.map((b) => b.path)).toEqual(['.claude/settings.json']);
  });
  it('a copy only counts the target', () => {
    const r = assessGuard({ changes: readDiff('C075\tqueue.config.json\tdocs/example.json\n'), ownedFiles: ['x'] });
    expect(r.violations).toEqual([]);
    expect(r.drift).toEqual(['docs/example.json']);
  });
  it('--allow-guard turns a violation into no stop, but the list is kept', () => {
    const r = assessGuard({ changes: changed('.github/workflows/ci.yml'), allowGuard: true });
    expect(r.violations).toHaveLength(1);
    expect(r.stop).toBe(false);
    expect(r.overridden).toBe(true);
  });
  it('files outside the ownership give a warning (drift), not a stop', () => {
    const r = assessGuard({
      changes: changed('src/x.ts', 'src/other.ts', 'components/y/z.tsx'),
      ownedFiles: ['src/x.ts', 'components/y/'],
    });
    expect(r.drift).toEqual(['src/other.ts']);
    expect(r.stop).toBe(false);
  });
  it('no drift warning when the task has no ownership registered', () => {
    expect(assessGuard({ changes: changed('src/x.ts') }).drift).toEqual([]);
  });
  it("migrations in the task's migr_block count as owned", () => {
    const r = assessGuard({
      changes: changed('db/migrations/3605_x.sql', 'db/migrations/3610_y.sql'),
      ownedFiles: ['src/x.ts'],
      migrBlock: '3600–3609',
      migrations: MIGR,
    });
    expect(r.drift).toEqual(['db/migrations/3610_y.sql']);
  });
});

describe('helpers', () => {
  it('readDiff keeps both paths on rename and copy', () => {
    expect(readDiff('M\ta.txt\nR100\tb.txt\tc.txt\nC075\td\te\nD\tf\n')).toEqual([
      { status: 'M', paths: ['a.txt'] },
      { status: 'R', paths: ['b.txt', 'c.txt'] },
      { status: 'C', paths: ['d', 'e'] },
      { status: 'D', paths: ['f'] },
    ]);
  });
  it('taskIdFromBranch follows the branch prefix', () => {
    expect(taskIdFromBranch('queue/A-1')).toBe('A-1');
    expect(taskIdFromBranch('origin/queue/B-2')).toBe('B-2');
    expect(taskIdFromBranch('wave/4a-track')).toBeNull();
    expect(taskIdFromBranch('q-C', 'q-')).toBe('C');
    expect(taskIdFromBranch('queue/A', '')).toBeNull();
  });
  it('migrCovered understands a shortened and a full end, the folder and the file pattern', () => {
    expect(migrCovered('db/migrations/3609_x.sql', '3600–3609', MIGR)).toBe(true);
    expect(migrCovered('db/migrations/20260926002849_x.sql', '20260926002840–2849', MIGR)).toBe(true);
    expect(migrCovered('db/migrations/20260926009265_x.sql', '20260926009260–20260926009269', MIGR)).toBe(true);
    expect(migrCovered('db/migrations/3599_x.sql', '3600–3609', MIGR)).toBe(false);
    expect(migrCovered('db/other/3605_x.sql', '3600–3609', MIGR)).toBe(false);
    expect(migrCovered('db/migrations/3605_x.txt', '3600–3609', MIGR)).toBe(false);
    expect(migrCovered('db/migrations/3605_x.sql', null, MIGR)).toBe(false);
    expect(migrCovered('db/migrations/3605_x.sql', '3600–3609', { folder: null })).toBe(false);
  });
});

describe('merge-track.mjs in a temporary repo', () => {
  const SCRIPT = path.resolve(__dirname, '..', '..', 'merge-track.mjs');
  const setup = () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-merge-guard-'));
    const g = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'Merge Guard Test');
    g('config', 'user.email', 'merge-guard@test.local');
    g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'base');
    g('switch', '-q', '-c', 'queue/A');
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{"hooks":{}}\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nb\n');
    g('add', '.claude/settings.json', 'a.txt');
    g('commit', '-q', '-m', 'track');
    g('switch', '-q', 'main');
    const data = path.join(repo, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(
      path.join(data, 'queue.json'),
      JSON.stringify({ tasks: [{ id: 'A', branch: 'queue/A', owned_files: ['a.txt'], shared_patch: [] }] }),
    );
    const env = {
      ...process.env,
      QUEUE_ROOT: repo,
      QUEUE_CONFIG: path.join(repo, 'no-config.json'),
      QUEUE_FOLDER: data,
      QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    };
    const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, 'queue/A', '--keep-worktree', ...a], {
      cwd: repo,
      encoding: 'utf8',
      env,
    });
    return { repo, g, data, run };
  };

  it('stops with exit 4 before the merge, and --allow-guard merges and logs the override', () => {
    const { repo, g, data, run } = setup();
    try {
      const head = g('rev-parse', 'HEAD');
      const stop = run();
      expect(stop.status).toBe(4);
      expect(stop.stderr).toMatch(/GUARD: queue\/A changes protected paths that the task A does not own/);
      expect(stop.stderr).toMatch(/\.claude\/settings\.json/);
      expect(stop.stderr).not.toMatch(/a\.txt/);
      expect(g('rev-parse', 'HEAD')).toBe(head);
      expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);

      const ok = run('--allow-guard');
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toMatch(/GUARD OVERRIDDEN \(--allow-guard\) for queue\/A/);
      expect(g('rev-parse', 'HEAD')).not.toBe(head);
      const row = JSON.parse(fs.readFileSync(path.join(data, 'times.jsonl'), 'utf8').trim());
      expect(row).toMatchObject({ track: 'A', event: 'guard-overridden', paths: ['.claude/settings.json'] });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
