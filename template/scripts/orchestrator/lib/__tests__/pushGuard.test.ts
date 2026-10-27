// =============================================================
// pushGuard.test.ts: the decisions of the PreToolUse hook hook-push-guard.mjs.
//
// Locks that the expensive/irreversible commands are stopped (forced push, push of branches other than baseBranch,
// migration push to an environment that is not allowed), and that normal work runs freely. See lib/pushGuard.js.
// =============================================================
import { describe, expect, it } from 'vitest';

import { isCommand, readEnvironment, assess } from '../pushGuard';

const MIG = {
  pushCommand: 'npx dbTool migrate push --yes',
  environmentFile: '.environment',
  allowedEnvironment: ['test'],
};
const STD = { baseBranch: 'main', migrations: MIG };
const decision = (k: string, context = {}) => assess(k, { ...STD, ...context })?.decision ?? null;

describe('git push', () => {
  it('lets push to baseBranch through, in any form', () => {
    expect(decision('git push origin main')).toBeNull();
    expect(decision('git push -u origin main')).toBeNull();
    expect(decision('git push origin HEAD:refs/heads/main')).toBeNull();
    expect(decision('git -C /repo push origin main')).toBeNull();
    expect(decision('git push', { branch: 'main' })).toBeNull();
    expect(decision('git push origin HEAD', { branch: 'main' })).toBeNull();
  });
  it('follows the configured baseBranch', () => {
    expect(decision('git push origin development', { baseBranch: 'development' })).toBeNull();
    expect(decision('git push origin main', { baseBranch: 'development' })).toBe('deny');
  });
  it('blocks push of other branches', () => {
    expect(decision('git push -u origin queue/A-1')).toBe('deny');
    expect(decision('git push', { branch: 'queue/A-1' })).toBe('deny');
    expect(decision('git push origin main queue/A-1')).toBe('deny');
    expect(assess('git push origin queue/A-1', STD)?.reason).toMatch(/baseBranch \(main\)/);
  });
  it('blocks forced push, also to own branches', () => {
    expect(decision('git push --force origin main')).toBe('deny');
    expect(decision('git push -f origin queue/A-1')).toBe('deny');
    expect(decision('git push origin +main')).toBe('deny');
    expect(decision('git push --force-with-lease origin main')).toBe('deny');
    expect(decision('git push -uf origin main')).toBe('deny');
    expect(decision('git push --all origin')).toBe('deny');
  });
  it('asks when the branch cannot be determined', () => {
    expect(decision('git push')).toBe('ask');
  });
  it('lets other git commands and text that only mentions push through', () => {
    expect(decision('git status && git log --oneline -3')).toBeNull();
    expect(decision('echo "git push origin queue/A-1" > note.txt')).toBeNull();
  });
});

describe('migrationPush', () => {
  it('lets through when the environment is allowed or the file is missing', () => {
    expect(decision('npx dbTool migrate push --yes', { environment: 'test' })).toBeNull();
    expect(decision('npx dbTool migrate push --yes', { environment: null })).toBeNull();
  });
  it('blocks when the environment is not allowed, also with other options and without npx', () => {
    expect(decision('npx dbTool migrate push --yes', { environment: 'production' })).toBe('deny');
    expect(decision('dbTool migrate push', { environment: 'production' })).toBe('deny');
    expect(decision('dbTool.exe migrate push --debug', { environment: 'production' })).toBe('deny');
  });
  it('an empty list of allowed environments blocks everything when the file exists', () => {
    expect(
      decision('dbTool migrate push', {
        environment: 'test',
        migrations: { ...MIG, allowedEnvironment: [] },
      }),
    ).toBe('deny');
  });
  it('is off without pushCommand or environmentFile', () => {
    expect(
      decision('dbTool migrate push', { environment: 'production', migrations: { ...MIG, environmentFile: null } }),
    ).toBeNull();
    expect(
      decision('dbTool migrate push', { environment: 'production', migrations: { ...MIG, pushCommand: null } }),
    ).toBeNull();
  });
  it('other subcommands are free', () => {
    expect(decision('dbTool migrate list', { environment: 'production' })).toBeNull();
  });
  it('isCommand compares the core words', () => {
    expect(isCommand(['npm', 'exec', 'dbTool', 'migrate', 'push'], MIG.pushCommand)).toBe(true);
    expect(isCommand(['dbTool', 'migrate'], MIG.pushCommand)).toBe(false);
  });
  it('readEnvironment gives null without a file', () => {
    expect(readEnvironment(['/does/not/exist'], '.environment')).toBeNull();
    expect(readEnvironment(['/does/not/exist'], null)).toBeNull();
  });
});

describe('several commands', () => {
  it('the strictest wins', () => {
    expect(decision('git push; git push -f origin main')).toBe('deny');
  });
});
