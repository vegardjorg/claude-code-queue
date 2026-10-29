// =============================================================
// orchestratorHelp.test.ts: pure decisions in the gate runner (gates.mjs), worktree preparation
// (prepare-track.mjs) and the link list shared with cleanup-worktree.mjs.
// =============================================================
import { describe, expect, it } from 'vitest';

import {
  firstErrorLine,
  continueDecision,
  gateType,
  branchDecision,
  resultLine,
  trackLinks,
  worktreeWithBranch,
} from '../orchestratorHelp';

describe('gateType', () => {
  it('recognizes common tools', () => {
    expect(gateType('npx tsc --noEmit')).toBe('tsc');
    expect(gateType('npx eslint .')).toBe('eslint');
    expect(gateType('npx prettier --check .')).toBe('prettier');
    expect(gateType('npx vitest run')).toBe('test');
    expect(gateType('npm test')).toBe('test');
    expect(gateType('node --test')).toBe('test');
    expect(gateType('make check')).toBe('other');
  });
});

describe('first error line', () => {
  const root = 'C:\\repo';

  it('tsc', () => {
    const text =
      'something\nlib/a.ts(3,5): error TS2322: Type string is not assignable to type number.\nmore';
    expect(firstErrorLine('tsc', text, root)).toBe(
      'lib/a.ts(3,5): error TS2322: Type string is not assignable to type number.',
    );
  });

  it('eslint: combines the file path with the first error (not warning), relative to the root', () => {
    const text = [
      '',
      'C:\\repo\\lib\\a.ts',
      '  2:1  warning  Unused  no-unused-vars',
      '  4:9  error    x is not defined  no-undef',
      '',
      '✖ 2 problems',
    ].join('\n');
    expect(firstErrorLine('eslint', text, root)).toBe('lib\\a.ts:4:9 x is not defined no-undef');
  });

  it('prettier: the first file that is not formatted', () => {
    const text =
      'Checking formatting...\n[warn] lib/a.ts\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.';
    expect(firstErrorLine('prettier', text, root)).toBe('not formatted: lib/a.ts');
  });

  it('test: the first failing test, not console blocks', () => {
    const text = '  ● Console\n\n    console.log x\n\n  ● date › offset in July is -120\n';
    expect(firstErrorLine('test', text, root)).toBe('● date › offset in July is -120');
    expect(firstErrorLine('test', 'ok\n FAIL  lib/a.test.ts\n', root)).toBe('FAIL lib/a.test.ts');
  });

  it('generic: removes colors, finds the ERROR line, otherwise the last line', () => {
    expect(firstErrorLine('other', '\u001b[31mok\nERROR: 2 new violations\nend', root)).toBe(
      'ERROR: 2 new violations',
    );
    expect(firstErrorLine('other', 'line 1\nlast line\n\n', root)).toBe('last line');
  });
});

describe('resultLine', () => {
  it('GREEN and RED', () => {
    expect(resultLine({ name: 'tsc', status: 'GREEN', sec: 12.4 }, 5)).toBe('tsc   GREEN 12 s');
    expect(resultLine({ name: 'test', status: 'RED', sec: 40, first: 'x' }, 5)).toBe(
      'test  RED 40 s: x',
    );
    expect(resultLine({ name: 'test', status: 'RED', sec: 1 }, 5)).toBe('test  RED 1 s');
  });
});

describe('preparation: branch choice', () => {
  it('keeps the correct branch', () => {
    expect(
      branchDecision({ current: 'queue/A-1', branch: 'queue/A-1', dirty: true, ownCommits: 3 }),
    ).toEqual({ action: 'keep' });
  });
  it('checks out a clean, new worktree branch', () => {
    expect(
      branchDecision({
        current: 'worktree-agent-x',
        branch: 'queue/A-1',
        dirty: false,
        ownCommits: 0,
      }),
    ).toEqual({ action: 'checkout' });
  });
  it('denies when work would be lost', () => {
    expect(
      branchDecision({ current: 'another', branch: 'queue/A-1', dirty: true, ownCommits: 0 })
        .action,
    ).toBe('deny');
    expect(
      branchDecision({ current: 'another', branch: 'queue/A-1', dirty: false, ownCommits: 2 })
        .action,
    ).toBe('deny');
  });
  // An existing queue/<id> with commits ahead of the base (after release) must never be reset with -B.
  it('switches to an existing branch with commits ahead of the base instead of resetting it', () => {
    expect(
      branchDecision({
        current: 'worktree-agent-x',
        branch: 'queue/X',
        dirty: false,
        ownCommits: 0,
        measureCommits: 3,
      }),
    ).toEqual({ action: 'switch', measureCommits: 3 });
  });
  it('denies taking over an existing branch with commits from a dirty worktree', () => {
    const b = branchDecision({
      current: 'worktree-agent-x',
      branch: 'queue/X',
      dirty: true,
      ownCommits: 0,
      measureCommits: 2,
      base: 'main',
    });
    expect(b.action).toBe('deny');
    expect(b.reason).toContain('queue/X exists with 2 commit(s) ahead of main');
  });
  it('still denies when the worktree branch has commits, even if the target branch has some too', () => {
    expect(
      branchDecision({
        current: 'another',
        branch: 'queue/X',
        dirty: false,
        ownCommits: 1,
        measureCommits: 2,
      }).action,
    ).toBe('deny');
  });
  it('resets an existing branch without commits ahead of the base (nothing is lost)', () => {
    expect(
      branchDecision({
        current: 'worktree-agent-x',
        branch: 'queue/X',
        dirty: false,
        ownCommits: 0,
        measureCommits: 0,
      }),
    ).toEqual({ action: 'checkout' });
  });
});

// --continue takes over an existing branch (fix round or continuation in a new agent) without reset.
describe('preparation: --continue', () => {
  const basis = {
    current: 'worktree-agent-x',
    branch: 'queue/X',
    exists: true,
    dirty: false,
    ownCommits: 0,
    otherWorktree: null,
  };
  it('switches to the branch without reset when it exists and is available', () => {
    expect(continueDecision(basis)).toEqual({ action: 'switch' });
  });
  it('keeps the branch when the worktree is already on it', () => {
    expect(continueDecision({ ...basis, current: 'queue/X', dirty: true })).toEqual({
      action: 'keep',
    });
  });
  it('denies when the branch does not exist (nothing to continue)', () => {
    const b = continueDecision({ ...basis, exists: false });
    expect(b.action).toBe('deny');
    expect(b.reason).toContain('queue/X does not exist');
  });
  it('denies with path and detach command when the branch is checked out in another worktree', () => {
    const b = continueDecision({ ...basis, otherWorktree: 'C:/wt/old' });
    expect(b.action).toBe('deny');
    expect(b.reason).toContain('C:/wt/old');
    expect(b.reason).toContain('git -C "C:/wt/old" switch --detach');
  });
  it('denies from a dirty worktree', () => {
    expect(continueDecision({ ...basis, dirty: true }).action).toBe('deny');
  });
  it('denies from a detached HEAD with commits not on the base (they would be left dangling)', () => {
    const b = continueDecision({ ...basis, current: '', ownCommits: 2 });
    expect(b.action).toBe('deny');
    expect(b.reason).toContain('2 commit(s)');
  });
  it('switches from a worktree branch with its own commits (they stay on that branch)', () => {
    expect(continueDecision({ ...basis, ownCommits: 2 })).toEqual({ action: 'switch' });
  });
});

describe('preparation: worktreeWithBranch', () => {
  const porcelain = [
    'worktree C:/repo/example',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree C:/repo/example/.claude/worktrees/agent-1',
    'HEAD bbb',
    'branch refs/heads/queue/X',
    '',
    'worktree C:/repo/example/.claude/worktrees/agent-2',
    'HEAD ccc',
    'detached',
    '',
  ].join('\n');
  it('finds the worktree the branch is checked out in', () => {
    expect(worktreeWithBranch(porcelain, 'queue/X')).toBe('C:/repo/example/.claude/worktrees/agent-1');
  });
  it('gives null when the branch is not checked out anywhere', () => {
    expect(worktreeWithBranch(porcelain, 'queue/Y')).toBeNull();
  });
  it('does not confuse queue/X with queue/X-r1', () => {
    expect(worktreeWithBranch(porcelain.replace('queue/X', 'queue/X-r1'), 'queue/X')).toBeNull();
  });
  it('tolerates CRLF from git on Windows', () => {
    expect(worktreeWithBranch(porcelain.split('\n').join('\r\n'), 'main')).toBe('C:/repo/example');
  });
});

describe('the link list (sharedLinks)', () => {
  it('normalizes and removes invalid and duplicate paths', () => {
    expect(
      trackLinks(['node_modules', 'web\\node_modules/', './node_modules', '../out', '/abs', 'C:/x', '']),
    ).toEqual(['node_modules', 'web/node_modules']);
  });
  it('tolerates an empty and an invalid list', () => {
    expect(trackLinks([])).toEqual([]);
    expect(trackLinks('node_modules' as unknown as string[])).toEqual([]);
  });
});
