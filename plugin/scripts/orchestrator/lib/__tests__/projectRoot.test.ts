// =============================================================
// projectRoot.test.ts: how the scripts find the project (lib/projectRoot.js).
//
// Locks: a vendored install (scripts in <project>/scripts/orchestrator, queue.config.json in the project) behaves as
// before, also from a worktree's copy; a plugin install (scripts outside the project) finds the project from cwd, and
// from a linked worktree it finds the MAIN tree for the queue and the worktree as `tree`; QUEUE_ROOT always wins;
// CLAUDE_PROJECT_DIR is used when cwd is outside any repo. Real temp repos with `git worktree add`, no mocks of git.
// =============================================================
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveRoots, gitTree, samePath, queueActive, cqCommand } from '../projectRoot';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

// realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var), and Windows may give a short 8.3 name.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-root-')));
const project = path.join(base, 'project');
const worktree = path.join(project, '.claude', 'worktrees', 'EX-1');
const outside = path.join(base, 'outside'); // not a git repo
const plugin = path.join(base, 'plugin', 'scripts', 'orchestrator'); // a plugin's script folder, outside the project
const same = (a: string, b: string) => expect(samePath(a, b)).toBe(true);
const noEnv = {};

beforeAll(() => {
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(plugin, { recursive: true });
  git(project, 'init', '-q');
  fs.writeFileSync(path.join(project, 'README.md'), 'x\n');
  git(project, 'add', 'README.md');
  git(project, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  git(project, 'worktree', 'add', '-q', worktree, '-b', 'queue/EX-1');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('gitTree', () => {
  it('finds the repo from a subfolder', () => {
    const t = gitTree(path.join(project, 'src'))!;
    same(t.top, project);
    same(t.main, project);
  });

  it('a linked worktree has itself as top and the main tree as main', () => {
    const t = gitTree(worktree)!;
    same(t.top, worktree);
    same(t.main, project);
  });

  it('null outside any repo', () => {
    expect(gitTree(outside)).toBeNull();
  });
});

describe('plugin install (scripts outside the project)', () => {
  it('main tree from cwd in the project', () => {
    const r = resolveRoots({ cwd: path.join(project, 'src'), env: noEnv, scriptDir: plugin });
    expect(r.mode).toBe('cwd');
    same(r.main, project);
    same(r.tree, project);
  });

  it('from a worktree: the queue stays in the main tree, tree is the worktree', () => {
    const r = resolveRoots({ cwd: worktree, env: noEnv, scriptDir: plugin });
    same(r.main, project);
    same(r.tree, worktree);
  });

  it('cwd outside any repo: CLAUDE_PROJECT_DIR', () => {
    const r = resolveRoots({ cwd: outside, env: { CLAUDE_PROJECT_DIR: worktree }, scriptDir: plugin });
    expect(r.mode).toBe('project-dir');
    same(r.main, project);
  });
});

describe('vendored install (scripts in <project>/scripts/orchestrator)', () => {
  const vendored = path.join(project, 'scripts', 'orchestrator');
  const vendoredInWorktree = path.join(worktree, 'scripts', 'orchestrator');
  beforeAll(() => fs.writeFileSync(path.join(project, 'queue.config.json'), '{}'));
  afterAll(() => fs.rmSync(path.join(project, 'queue.config.json')));

  it('uses the script location even when cwd is somewhere else', () => {
    const r = resolveRoots({ cwd: outside, env: noEnv, scriptDir: vendored });
    expect(r.mode).toBe('vendored');
    same(r.main, project);
    same(r.tree, project);
  });

  it("a worktree's own copy: main tree for the queue, the worktree as tree (as before)", () => {
    const r = resolveRoots({ cwd: outside, env: noEnv, scriptDir: vendoredInWorktree });
    same(r.main, project);
    same(r.tree, worktree);
  });
});

describe('overrides and fallback', () => {
  it('QUEUE_ROOT wins over everything', () => {
    const r = resolveRoots({ cwd: worktree, env: { QUEUE_ROOT: outside }, scriptDir: plugin });
    expect(r.mode).toBe('env');
    same(r.main, outside);
    same(r.tree, outside); // the worktree belongs to another repo than QUEUE_ROOT
  });

  it('QUEUE_ROOT pointing at the project keeps the worktree as tree', () => {
    const r = resolveRoots({ cwd: worktree, env: { QUEUE_ROOT: project }, scriptDir: plugin });
    same(r.tree, worktree);
  });

  it('no repo, no project dir: the old script-relative root', () => {
    const r = resolveRoots({ cwd: outside, env: noEnv, scriptDir: plugin });
    expect(r.mode).toBe('fallback');
    same(r.main, path.join(base, 'plugin'));
  });

  it('samePath ignores case only on Windows', () => {
    expect(samePath('/a/B', '/a/b', 'win32')).toBe(true);
    expect(samePath('/a/B', '/a/b', 'linux')).toBe(false);
  });
});

describe('queueActive (the hooks exit at once when it is false)', () => {
  it('false in a repo without queue.config.json, true with it', () => {
    expect(queueActive({ env: noEnv, main: project })).toBe(false);
    fs.writeFileSync(path.join(project, 'queue.config.json'), '{}');
    try {
      expect(queueActive({ env: noEnv, main: project })).toBe(true);
    } finally {
      fs.rmSync(path.join(project, 'queue.config.json'));
    }
  });

  it('any QUEUE_* variable counts as an explicit queue', () => {
    expect(queueActive({ env: { QUEUE_FOLDER: outside }, main: project })).toBe(true);
  });

  it('a hook started outside a queue project says nothing and exits 0', () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('QUEUE_')) delete env[k];
    delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'hook-read-guard.mjs')], {
      cwd: project,
      input: JSON.stringify({ agent_type: 'track', tool_input: { file_path: path.join(project, 'CLAUDE.md') } }),
      encoding: 'utf8',
      env,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('cq', () => {
  it('cqCommand: `cq` for a plugin, the node form for a vendored install', () => {
    expect(cqCommand({ mode: 'cwd' })).toBe('cq');
    expect(cqCommand({ mode: 'vendored' })).toBe('node scripts/orchestrator/cq.mjs');
    expect(cqCommand({ mode: 'vendored', fromWorktree: true })).toBe('node <mainTree>/scripts/orchestrator/cq.mjs');
  });

  it('dispatches: a queue command goes to queue.mjs, a script name to that script', () => {
    const cq = path.resolve(__dirname, '..', '..', 'cq.mjs');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cq, ...args], {
        cwd: project,
        encoding: 'utf8',
        env: { ...process.env, QUEUE_ROOT: project, QUEUE_FOLDER: path.join(base, 'cq-queue') },
      });
    expect(run('help').stdout).toContain('prepare-track');
    const init = run('init');
    expect(init.status, init.stderr).toBe(0);
    expect(fs.existsSync(path.join(base, 'cq-queue', 'queue.json'))).toBe(true);
    // `cq board --help` reaches queue-board.mjs (its usage line), not queue.mjs.
    expect(run('board', '--help').stdout).toContain('Kanban board');
  });
});
