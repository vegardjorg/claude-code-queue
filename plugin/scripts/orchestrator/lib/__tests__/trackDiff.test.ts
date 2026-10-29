// =============================================================
// trackDiff.test.ts: which files a merged track branch changed (scripts/orchestrator/lib/trackDiff.js).
//
// After `queue.mjs merge` the gates run on baseBranch, where HEAD equals base, so base...HEAD is empty. The tests prove in a
// real (temporary) git repo that:
//   - the branch's own files are the diff separator...tip when the gates get --track-base/--track-tip;
//   - without the arguments the list is only `changed` (empty after the merge);
//   - another track merged after the fork point does not count as this track;
//   - `changed` (the working tree) is added, without duplicates;
//   - an unknown base gives null (the gates stop instead of guessing);
//   - trackArgs gives the arguments only when both separator and tip exist.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const SD = require('../trackDiff') as {
  trackArgs: (k: { separator?: string | null; tip?: string | null }) => string[];
  trackChangedFiles: (k: {
    git: (...args: string[]) => string | null;
    trackBase?: string | null;
    trackTip?: string | null;
    changed: string[];
  }) => string[] | null;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

/**
 * Repo on `main` where branch track/a changes src/a.txt and adds src/new.txt, and track/b (merged first) changes
 * src/b.txt. The fork point and tip of track/a are remembered BEFORE the merge, as the merge step does.
 */
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'trackDiff-'));
  temporary.push(repo);
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
    g('add', '--', file);
  };
  g('init', '-q', '-b', 'main');
  write('src/a.txt', 'a\n');
  write('src/b.txt', 'b\n');
  g('commit', '-q', '-m', 'start');
  g('switch', '-q', '-c', 'track/a');
  write('src/a.txt', 'a2\n');
  write('src/new.txt', 'new\n');
  g('commit', '-q', '-m', 'A');
  g('switch', '-q', 'main');
  g('switch', '-q', '-c', 'track/b');
  write('src/b.txt', 'b2\n');
  g('commit', '-q', '-m', 'B');
  g('switch', '-q', 'main');
  g('merge', '-q', '--no-ff', '--no-edit', 'track/b');
  // What the merge step remembers BEFORE merging track/a:
  const separator = g('merge-base', 'main', 'track/a');
  const tip = g('rev-parse', 'track/a');
  g('merge', '-q', '--no-ff', '--no-edit', 'track/a');
  const gitFn = (...x: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...x], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  };
  // What the gates see on main after the merge: base...HEAD (empty) + the working tree (clean).
  const changed = (gitFn('diff', '--name-only', 'main...HEAD') ?? '')
    .split('\n')
    .filter(Boolean);
  return { separator, tip, gitFn, changed };
}

const sorted = (x: string[] | null) => [...(x ?? [])].sort();

describe('trackChangedFiles after merge', () => {
  it('the files of the branch itself are the diff separator...tip', () => {
    const { separator, tip, gitFn, changed } = makeRepo();
    expect(changed).toEqual([]);
    const files = SD.trackChangedFiles({ git: gitFn, trackBase: separator, trackTip: tip, changed });
    expect(sorted(files)).toEqual(['src/a.txt', 'src/new.txt']);
  });

  it('without track-base the list is only `changed` (empty after the merge), as a copy', () => {
    const { gitFn, changed } = makeRepo();
    expect(SD.trackChangedFiles({ git: gitFn, changed })).toEqual([]);
    const input = ['x.txt'];
    const out = SD.trackChangedFiles({ git: gitFn, changed: input });
    expect(out).toEqual(['x.txt']);
    expect(out).not.toBe(input);
  });

  it('another track merged after the fork point does not count as this track', () => {
    const { separator, tip, gitFn, changed } = makeRepo();
    const files = SD.trackChangedFiles({ git: gitFn, trackBase: separator, trackTip: tip, changed });
    expect(files).not.toContain('src/b.txt');
    // Without tip, HEAD is used, and then track/b is included (which is why the merge step passes the tip).
    expect(SD.trackChangedFiles({ git: gitFn, trackBase: separator, changed })).toContain(
      'src/b.txt',
    );
  });

  it('changed files in the working tree are added, without duplicates', () => {
    const { separator, tip, gitFn } = makeRepo();
    const files = SD.trackChangedFiles({
      git: gitFn,
      trackBase: separator,
      trackTip: tip,
      changed: ['src/a.txt', 'local.txt'],
    });
    expect(sorted(files)).toEqual(['local.txt', 'src/a.txt', 'src/new.txt']);
  });

  it('an unknown track-base gives null (the gates stop instead of guessing)', () => {
    const { gitFn } = makeRepo();
    expect(
      SD.trackChangedFiles({
        git: gitFn,
        trackBase: 'exists-not',
        trackTip: 'HEAD',
        changed: [],
      }),
    ).toBeNull();
  });
});

describe('trackArgs', () => {
  it('gives --track-base and --track-tip when both exist', () => {
    expect(SD.trackArgs({ separator: 'abc', tip: 'def' })).toEqual([
      '--track-base',
      'abc',
      '--track-tip',
      'def',
    ]);
  });

  it('is empty when separator or tip is missing', () => {
    expect(SD.trackArgs({ separator: null, tip: 'abc' })).toEqual([]);
    expect(SD.trackArgs({ separator: 'abc', tip: null })).toEqual([]);
    expect(SD.trackArgs({})).toEqual([]);
  });
});
