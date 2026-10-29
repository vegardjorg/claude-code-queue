// =============================================================
// readHint.test.ts: soft read and report hints for the track agents.
//
// Locks: hint (never block) on whole reading over 300 lines and on the same file whole twice, no effect for excerpts,
// other agent types or the main session; the report reminder comes once above the threshold; the output hint comes
// for large Bash/PowerShell results in tracks, at most BASH_HINT_MAX times. Finally smoke tests of hook-read-guard.mjs and
// hook-track-context.mjs as child processes (temp files).
// =============================================================
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BASH_HINT_MAX,
  commandType,
  outputLength,
  assessBashHint,
  assessReadHint,
  assessReportHint,
} from '../readHint';

describe('assessReadHint', () => {
  const base = { agentType: 'track', filePath: 'C:\\x\\Large.ts', countLines: 500 };

  it('hint on whole reading over the limit, and the file is remembered', () => {
    const r = assessReadHint(base);
    expect(r?.hint).toMatch(/500 lines/);
    expect(r?.key).toBe('c:/x/large.ts');
  });

  it('same file whole twice gives a hint, also for small files', () => {
    const r = assessReadHint({ ...base, countLines: 10, readWhole: ['c:/x/large.ts'] });
    expect(r?.hint).toMatch(/already read/);
    expect(r?.key).toBeNull();
  });

  it('small file first time: no message, but remembered', () => {
    expect(assessReadHint({ ...base, countLines: 100 })).toEqual({
      key: 'c:/x/large.ts',
      hint: '',
    });
  });

  it('no effect for excerpts, other agent types, the main session and images', () => {
    expect(assessReadHint({ ...base, limit: 50 })).toBeNull();
    expect(assessReadHint({ ...base, offset: 1 })).toBeNull();
    expect(assessReadHint({ ...base, agentType: 'general-purpose' })).toBeNull();
    expect(assessReadHint({ ...base, agentType: null })).toBeNull();
    expect(assessReadHint({ ...base, filePath: 'C:\\x\\image.PNG' })).toBeNull();
  });
});

describe('assessReportHint', () => {
  it('once above the threshold, only for tracks', () => {
    expect(assessReportHint({ agentType: 'track', context: 199_000 })).toBeNull();
    expect(assessReportHint({ agentType: 'track-d', context: 201_000 })).toMatch(/report\.md/);
    expect(assessReportHint({ agentType: 'track', context: 250_000, said: true })).toBeNull();
    expect(assessReportHint({ agentType: 'general-purpose', context: 250_000 })).toBeNull();
  });
});

describe('hook-read-guard.mjs (smoke test)', () => {
  const hook = path.resolve(__dirname, '..', 'hook-read-guard.mjs');
  const run = (input: object, state: string) =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      // The hooks exit at once outside a queue project (lib/projectRoot.js queueActive); a QUEUE_* variable marks this as one.
      env: { ...process.env, READ_HINT_STATE: state, QUEUE_ROOT: os.tmpdir() },
    });

  it('gives readHint (not deny) for a large file, and a hint on repeated whole reading', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'readHint-'));
    const file = path.join(folder, 'large.ts');
    fs.writeFileSync(file, 'x\n'.repeat(400));
    const small = path.join(folder, 'small.ts');
    fs.writeFileSync(small, 'x\n');
    const state = path.join(folder, 'state');
    const input = { agent_type: 'track', agent_id: 'a1', tool_input: { file_path: file } };
    const one = JSON.parse(run(input, state).stdout);
    expect(one.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(one.hookSpecificOutput.additionalContext).toMatch(/401 lines/);
    const small1 = run({ ...input, tool_input: { file_path: small } }, state).stdout;
    expect(small1).toBe('');
    const small2 = JSON.parse(run({ ...input, tool_input: { file_path: small } }, state).stdout);
    expect(small2.hookSpecificOutput.additionalContext).toMatch(/already read/);
    // excerpt and main session: no output
    expect(run({ ...input, tool_input: { file_path: file, limit: 10 } }, state).stdout).toBe('');
    expect(run({ tool_input: { file_path: file } }, state).stdout).toBe('');
    fs.rmSync(folder, { recursive: true, force: true });
  });
});

describe('outputLength and commandType', () => {
  it('counts stdout + stderr, strings, output and content blocks', () => {
    expect(outputLength({ stdout: 'abc', stderr: 'de', interrupted: false })).toBe(5);
    expect(outputLength('abcd')).toBe(4);
    expect(outputLength({ output: 'xy' })).toBe(2);
    expect(outputLength([{ type: 'text', text: 'abc' }])).toBe(3);
    expect(outputLength(null)).toBe(0);
    expect(outputLength(42)).toBe(0);
  });

  it('recognizes the categories', () => {
    expect(commandType("psql -XAtc 'select pg_get_functiondef(...)'")).toBe('psql');
    expect(commandType('grep -rn foo src')).toBe('grep');
    expect(commandType('rg -n foo')).toBe('grep');
    expect(commandType('Select-String -Path x -Pattern y')).toBe('grep');
    expect(commandType('sed -n 1,400p x.sql')).toBe('read');
    expect(commandType('cat large.sql')).toBe('read');
    expect(commandType('Get-Content x.sql')).toBe('read');
    expect(commandType('npx vitest')).toBe('other');
    expect(commandType('concatenate')).toBe('other');
  });
});

describe('assessBashHint', () => {
  const base = { agentType: 'track', tool: 'Bash', command: 'grep -rn x .', length: 20_000 };

  it('hint above the threshold, tailored to the command', () => {
    expect(assessBashHint(base)).toMatch(/20k characters.*grep -m/);
    expect(assessBashHint({ ...base, command: 'sed -n 1,900p a.sql' })).toMatch(/sed -n 'a,bp'/);
    expect(
      assessBashHint({ ...base, agentType: 'track-d', command: 'psql -c "select *"' }),
    ).toMatch(/psql: select narrowly/);
    expect(assessBashHint({ ...base, tool: 'PowerShell', command: 'npm test' })).toMatch(
      /\| head/,
    );
  });

  it('no effect below the threshold, for other tools, agent types, the main session or after max', () => {
    expect(assessBashHint({ ...base, length: 15_000 })).toBeNull();
    expect(assessBashHint({ ...base, length: null })).toBeNull();
    expect(assessBashHint({ ...base, tool: 'Read' })).toBeNull();
    expect(assessBashHint({ ...base, agentType: 'general-purpose' })).toBeNull();
    expect(assessBashHint({ ...base, agentType: null })).toBeNull();
    expect(assessBashHint({ ...base, given: BASH_HINT_MAX })).toBeNull();
    expect(assessBashHint({ ...base, given: BASH_HINT_MAX - 1 })).not.toBeNull();
  });
});

describe('hook-track-context.mjs (smoke test, output hint)', () => {
  const hook = path.resolve(__dirname, '..', 'hook-track-context.mjs');
  const run = (input: object, state: string) =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      // The hooks exit at once outside a queue project (lib/projectRoot.js queueActive); a QUEUE_* variable marks this as one.
      env: { ...process.env, TRACK_CONTEXT_STATE: state, QUEUE_ROOT: os.tmpdir() },
    });

  it('large Bash output gives a hint at most BASH_HINT_MAX times; small output and the main session give nothing', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bashhint-'));
    const state = path.join(folder, 'state');
    const input = {
      agent_type: 'track',
      agent_id: 'b1',
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn x src' },
      tool_response: { stdout: 'x'.repeat(16_000), stderr: '' },
    };
    for (let i = 0; i < BASH_HINT_MAX; i++) {
      const out = JSON.parse(run(input, state).stdout);
      expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(out.hookSpecificOutput.additionalContext).toMatch(/\[output hint\].*grep -m/);
    }
    expect(run(input, state).stdout).toBe('');
    const small = { ...input, agent_id: 'b2', tool_response: { stdout: 'short', stderr: '' } };
    expect(run(small, state).stdout).toBe('');
    const { agent_type: _away, ...main } = input;
    expect(run({ ...main, agent_id: 'b3' }, state).stdout).toBe('');
    fs.rmSync(folder, { recursive: true, force: true });
  });
});
