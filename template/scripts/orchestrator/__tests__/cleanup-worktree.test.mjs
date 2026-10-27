// Unit test for the decision in cleanup-worktree.mjs (vitest; the include pattern covers .test.mjs).
// Only the pure functions are tested here; the cleanup itself has been shown with a real merge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import { isUnder, fingerprint, shouldCleanUp } from '../cleanup-worktree.mjs';

const ok = {
  underWorktreesFolder: true,
  locked: false,
  isCurrentDirectory: false,
  merged: true,
  forNew: false,
  dirty: 0,
  realLinkFolder: null,
};

test('everything in order: clean up', () => {
  expect(shouldCleanUp(ok)).toEqual({ cleanup: true, reason: 'merged, clean and unlocked' });
});

test('a locked worktree is never cleaned up', () => {
  const r = shouldCleanUp({ ...ok, locked: true });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('locked');
});

test('a dirty worktree is not cleaned up (count and boolean)', () => {
  expect(shouldCleanUp({ ...ok, dirty: 3 }).cleanup).toBe(false);
  expect(shouldCleanUp({ ...ok, dirty: 3 }).reason).toMatch(/uncommitted changes \(3\)/);
  expect(shouldCleanUp({ ...ok, dirty: true }).cleanup).toBe(false);
  expect(shouldCleanUp({ ...ok, dirty: false }).cleanup).toBe(true);
});

test('unknown git status (negative or missing) does not count as clean', () => {
  expect(shouldCleanUp({ ...ok, dirty: -1 }).cleanup).toBe(false);
  expect(shouldCleanUp({ ...ok, dirty: undefined }).cleanup).toBe(false);
});

test('not merged: not cleaned up', () => {
  const r = shouldCleanUp({ ...ok, merged: false });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('not merged');
});

test('the current directory is not cleaned up', () => {
  const r = shouldCleanUp({ ...ok, isCurrentDirectory: true });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('is the current directory');
});

test('a real node_modules folder (not a link) stops the cleanup', () => {
  const r = shouldCleanUp({ ...ok, realLinkFolder: 'node_modules' });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('node_modules is not a link');
});

test('outside .claude/worktrees/ is never cleaned up, and that check comes before everything else', () => {
  const r = shouldCleanUp({ ...ok, underWorktreesFolder: false, locked: true });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('not under .claude/worktrees/');
});

test('recently changed (below the minimum age) is not cleaned up', () => {
  expect(shouldCleanUp({ ...ok, forNew: true }).cleanup).toBe(false);
});

test('locked comes before dirty (cheap reason first)', () => {
  expect(shouldCleanUp({ ...ok, locked: true, dirty: 5 }).reason).toBe('locked');
});

test('isUnder: only paths INSIDE the root, never the root itself or a neighbor with the same prefix', () => {
  const root = path.resolve('/x/example/.claude/worktrees');
  expect(isUnder(path.join(root, 'agent-a'), root)).toBe(true);
  expect(isUnder(root, root)).toBe(false);
  expect(isUnder(path.resolve('/x/example/.claude/worktrees-other/agent-a'), root)).toBe(false);
  expect(isUnder(path.resolve('/x/example'), root)).toBe(false);
});


test('fingerprint counts the entries in each shared folder, -1 when it is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-fp-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'b'), { recursive: true });
    expect(fingerprint(root, ['node_modules', 'web/node_modules'])).toEqual({
      node_modules: 2,
      'web/node_modules': -1,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
