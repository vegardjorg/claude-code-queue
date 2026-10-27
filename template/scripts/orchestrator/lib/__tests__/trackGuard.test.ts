// =============================================================
// trackGuard.test.ts: the context guard and readGuard for the track agents.
//
// Locks: no effect in the main session (without agent_type) or for other agent types, no effect below the threshold,
// one message at the threshold, no repetition; and that readGuard denies files that are loaded automatically and whole large
// files, but lets excerpts through, and can be extended with config().readGuard. Finally a smoke test of the hooks themselves
// (child process, temp files). The logic: lib/trackGuard.js.
// =============================================================
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TRACK_THRESHOLD,
  readRules,
  lastContext,
  subagentTranscript,
  assessContext,
  assessReading,
} from '../trackGuard';

const useLine = (n: number) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      usage: { input_tokens: 10, cache_read_input_tokens: n - 10, cache_creation_input_tokens: 0 },
    },
  });

describe('lastContext', () => {
  it('reads the usage of the last assistant message and tolerates a cut first line', () => {
    const t = [
      '{"type":"assis',
      useLine(100_000),
      '{"type":"user","message":{}}',
      useLine(290_000),
    ].join('\n');
    expect(lastContext(t)).toBe(290_000);
    expect(lastContext('')).toBeNull();
  });

  it('gives null right after a compaction (usage before the boundary is the size BEFORE /compact)', () => {
    const limit =
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":346000}}';
    expect(lastContext([useLine(346_000), limit].join('\n'))).toBeNull();
    // After the first answer following the compaction, the new, small value applies.
    expect(lastContext([useLine(346_000), limit, useLine(95_000)].join('\n'))).toBe(95_000);
  });
});

describe('the context guard', () => {
  it('no effect in the main session or for other agent types', () => {
    expect(assessContext({ agentType: undefined, context: 500_000 })).toBeNull();
    expect(assessContext({ agentType: null, context: 500_000 })).toBeNull();
    expect(assessContext({ agentType: 'general-purpose', context: 500_000 })).toBeNull();
    expect(assessContext({ agentType: 'reviewer', context: 500_000 })).toBeNull();
  });
  it('no effect below the threshold or without a measurement', () => {
    expect(assessContext({ agentType: 'track', context: TRACK_THRESHOLD - 1 })).toBeNull();
    expect(assessContext({ agentType: 'track', context: null })).toBeNull();
  });
  it('one message at the threshold, for track and track-d', () => {
    const s = assessContext({ agentType: 'track', context: TRACK_THRESHOLD });
    expect(s?.threshold).toBe(TRACK_THRESHOLD);
    expect(s?.message).toMatch(/handover\.md/);
    expect(s?.message).toMatch(/PARTIAL/);
    expect(assessContext({ agentType: 'track-d', context: 300_000 })).not.toBeNull();
  });
  it('no repetition when the threshold has already fired', () => {
    expect(
      assessContext({ agentType: 'track', context: 350_000, triggered: [TRACK_THRESHOLD] }),
    ).toBeNull();
  });
  it('the threshold can be overridden', () => {
    expect(
      assessContext({ agentType: 'track', context: 150_000, threshold: 100_000 }),
    ).not.toBeNull();
  });
});

describe('subagentTranscript', () => {
  const exists = (allowed: string[]) => (p: string) => allowed.includes(p);
  it('finds the subagent file below the session folder, never the main session transcript', () => {
    const tp = path.join('/p', 'session1.jsonl');
    const sub = path.join('/p', 'session1', 'subagents', 'agent-abc.jsonl');
    expect(
      subagentTranscript(
        { agent_id: 'abc', session_id: 'session1', transcript_path: tp },
        exists([sub]),
      ),
    ).toBe(sub);
    expect(
      subagentTranscript(
        { agent_id: 'abc', session_id: 'session1', transcript_path: tp },
        exists([tp]),
      ),
    ).toBeNull();
    expect(subagentTranscript({ transcript_path: tp }, exists([tp]))).toBeNull();
  });
  it('uses agent_transcript_path when it exists', () => {
    expect(
      subagentTranscript(
        { agent_id: 'abc', agent_transcript_path: '/x/a.jsonl' },
        exists(['/x/a.jsonl']),
      ),
    ).toBe('/x/a.jsonl');
  });
});

describe('readGuard', () => {
  const R = readRules({}, { folder: 'db/migrations' });
  const mig = 'C:\\repo\\example\\db\\migrations\\0042_x.sql';
  const read = (a: Record<string, unknown>) => assessReading({ rules: R, ...a });
  it('no effect in the main session or for other agent types', () => {
    expect(read({ filePath: 'C:/r/CLAUDE.md' })).toBeNull();
    expect(read({ agentType: 'general-purpose', filePath: 'C:/r/CLAUDE.md' })).toBeNull();
  });
  it('denies whole reads of CLAUDE.md (in any folder) and MEMORY.md for track and the review agents', () => {
    for (const agentType of ['track', 'track-d', 'reviewer', 'reviewer-security']) {
      expect(read({ agentType, filePath: 'C:\\r\\CLAUDE.md' })?.reason).toMatch(/loaded automatically/);
      expect(read({ agentType, filePath: '/r/db/CLAUDE.md' })).not.toBeNull();
      expect(read({ agentType, filePath: '/h/.claude/projects/x/memory/MEMORY.md' })).not.toBeNull();
    }
  });
  it('lets an excerpt of CLAUDE.md through (Edit requires that the file has been read)', () => {
    expect(read({ agentType: 'track', filePath: '/r/CLAUDE.md', offset: 100, limit: 30 })).toBeNull();
  });
  it('denies a large migration (migrations.folder) without limit, with advice about Grep and offset/limit', () => {
    const s = read({ agentType: 'track', filePath: mig, countLines: 900 });
    expect(s?.reason).toMatch(/Grep/);
    expect(s?.reason).toMatch(/offset and limit/);
  });
  it('lets small migrations, excerpts and other files below the block limit through', () => {
    expect(read({ agentType: 'track', filePath: mig, countLines: 300 })).toBeNull();
    expect(read({ agentType: 'track', filePath: mig, countLines: 900, limit: 80 })).toBeNull();
    expect(read({ agentType: 'track', filePath: mig, countLines: null })).toBeNull();
    expect(read({ agentType: 'track', filePath: '/r/db/tests/x.sql', countLines: 900 })).toBeNull();
    expect(read({ agentType: 'track', filePath: '/r/CLAUDE.md.back' })).toBeNull();
  });
  it('without a migration folder no files are "large", but the block limit applies to all text files', () => {
    const empty = readRules({}, {});
    expect(assessReading({ agentType: 'track', filePath: mig, countLines: 900, rules: empty })).toBeNull();
    expect(
      assessReading({ agentType: 'track', filePath: '/r/a.ts', countLines: 2500, rules: empty })?.reason,
    ).toMatch(/2500 lines/);
    expect(
      assessReading({ agentType: 'track', filePath: '/r/a.png', countLines: 2500, rules: empty }),
    ).toBeNull();
  });
  it('the project extends the guard with config().readGuard', () => {
    const own = readRules(
      {
        agentTypes: ['review'],
        autoLoaded: ['docs/RULES.md', 'NOTE.md'],
        largeFiles: ['data/**/*.csv'],
        maxLines: 100,
        blockLines: 500,
      },
      {},
    );
    const v = (a: Record<string, unknown>) => assessReading({ rules: own, ...a });
    expect(v({ agentType: 'review', filePath: '/r/NOTE.md' })).not.toBeNull();
    expect(v({ agentType: 'track', filePath: 'C:\\r\\docs\\RULES.md' })).not.toBeNull();
    expect(v({ agentType: 'track', filePath: '/r/others/RULES.md' })).toBeNull();
    expect(v({ agentType: 'track', filePath: '/r/data/a/b/x.csv', countLines: 150 })).not.toBeNull();
    expect(v({ agentType: 'track', filePath: '/r/data/x.csv', countLines: 150 })).not.toBeNull();
    expect(v({ agentType: 'track', filePath: '/r/a.ts', countLines: 600 })).not.toBeNull();
    expect(v({ agentType: 'track', filePath: '/r/a.ts', countLines: 400 })).toBeNull();
  });
});

describe('the hooks (smoke test)', () => {
  const orch = path.join(__dirname, '..', '..');
  const run = (script: string, input: object, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [path.join(orch, script)], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  it('the context guard speaks up once per agent, and never in the main session', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trackGuard-'));
    const session = 'session1';
    const tp = path.join(d, `${session}.jsonl`);
    fs.writeFileSync(tp, useLine(400_000) + '\n'); // the main session is large: must not count for the subagent
    fs.mkdirSync(path.join(d, session, 'subagents'), { recursive: true });
    const sub = path.join(d, session, 'subagents', 'agent-a1.jsonl');
    fs.writeFileSync(
      sub,
      '{"type":"user","message":{"content":"read prompt-TEST-1.md"}}\n' + useLine(100_000) + '\n',
    );
    const env = {
      TRACK_CONTEXT_STATE: path.join(d, 'state'),
      QUEUE_TIME_LOG: path.join(d, 'log.jsonl'),
    };
    const input = {
      hook_event_name: 'PostToolUse',
      session_id: session,
      transcript_path: tp,
      agent_id: 'a1',
      agent_type: 'track',
    };

    expect(
      run('hook-track-context.mjs', { ...input, agent_id: undefined, agent_type: undefined }, env)
        .stdout,
    ).toBe('');
    expect(run('hook-track-context.mjs', input, env).stdout).toBe(''); // below the threshold

    fs.appendFileSync(sub, useLine(285_000) + '\n');
    const r = run('hook-track-context.mjs', input, env);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/PARTIAL/);
    expect(run('hook-track-context.mjs', input, env).stdout).toBe(''); // no repetition

    const rows = fs
      .readFileSync(env.QUEUE_TIME_LOG, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'contextGuard',
      track: 'TEST-1',
      agent_id: 'a1',
      threshold: TRACK_THRESHOLD,
    });
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('readGuard denies CLAUDE.md for track and fails open on garbage input', () => {
    const r = run('hook-read-guard.mjs', {
      agent_type: 'track',
      tool_input: { file_path: '/r/db/CLAUDE.md' },
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(run('hook-read-guard.mjs', { tool_input: { file_path: '/r/CLAUDE.md' } }).stdout).toBe(
      '',
    );
    const s = spawnSync(process.execPath, [path.join(orch, 'hook-read-guard.mjs')], {
      input: '{not json',
      encoding: 'utf8',
    });
    expect(s.status).toBe(0);
    expect(s.stdout).toBe('');
  });
});
