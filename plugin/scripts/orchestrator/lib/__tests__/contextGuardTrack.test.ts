// =============================================================
// contextGuardTrack.test.ts: the context guards after automatic compaction (lib/contextGuard.js).
//
// The rules are enforced in lib/contextGuard.js and used by hook-track-context.mjs (PostToolUse), hook-context.mjs
// (UserPromptSubmit, the pause advice) and hook-track-end.mjs (SubagentStop). The tests prove them there: the pure
// functions, and the two track hooks run as processes with a fake transcript, a temporary queue file and (for the end
// gate) a temporary git repo, never the real ones.
//   - A track may compact once: one reminder after the first compaction, PARTIAL at the second or at the hard limit.
//   - The pause advice is given only to the orchestrator, only over 150k and only for whole words.
//   - The end gate blocks ONCE a track that stops without own commits and without an end line, and fails open.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type TrackAnswer = null | { key: string; cause: string; message: string; compactions: number };

/* eslint-disable @typescript-eslint/no-require-imports */
const KV = require('../contextGuard') as {
  TRACK_HARD_LIMIT: number;
  COMPACT1_MESSAGE: string;
  PAUSE_TIP: string;
  END_REASON: string;
  assessTrackContext: (a: {
    agentType?: string | null;
    compactions?: number;
    context?: number | null;
    hardLimit?: number;
    triggered?: (string | number)[];
  }) => TrackAnswer;
  isPauseMessage: (p: string) => boolean;
  pauseAdvice: (a: {
    prompt: string;
    n: number | null;
    orchestrator: boolean;
    threshold?: number;
  }) => null | { systemMessage: string };
  hasEndLine: (a: { lastMessage?: string | null; text?: string | null }) => boolean;
  assessEndGate: (a: {
    agentType?: string | null;
    commits: number | null;
    hasEndLine: boolean;
    alreadyBlocked: boolean;
    stopHookActive?: boolean;
  }) => null | { decision: string; reason: string };
};

describe('assessTrackContext', () => {
  it('0 compactions below the hard limit: nothing', () => {
    expect(KV.assessTrackContext({ agentType: 'track', compactions: 0, context: 200_000 })).toBeNull();
  });
  it('1 compaction: one reminder, no PARTIAL, and only once', () => {
    const s = KV.assessTrackContext({ agentType: 'track', compactions: 1, context: 60_000 });
    expect(s).toMatchObject({ key: 'compact1', compactions: 1 });
    expect(s?.message).toBe(KV.COMPACT1_MESSAGE);
    expect(s?.message).not.toMatch(/PARTIAL/);
    expect(KV.assessTrackContext({ agentType: 'track', compactions: 1, triggered: ['compact1'] })).toBeNull();
  });
  it('2 compactions: PARTIAL with the count, also when the reminder was given', () => {
    const s = KV.assessTrackContext({
      agentType: 'track-d',
      compactions: 2,
      context: null,
      triggered: ['compact1'],
    });
    expect(s).toMatchObject({ key: 'partial', cause: 'compaction', compactions: 2 });
    expect(s?.message).toMatch(/compacted 2 times.*deliver PARTIAL/);
    expect(KV.assessTrackContext({ agentType: 'track', compactions: 3, triggered: ['partial'] })).toBeNull();
  });
  it('the hard limit without compaction gives PARTIAL; an old state (number threshold) counts as given', () => {
    const s = KV.assessTrackContext({ agentType: 'track', compactions: 0, context: 290_000 });
    expect(s).toMatchObject({ key: 'partial', cause: 'hard' });
    expect(KV.TRACK_HARD_LIMIT).toBe(280_000);
    expect(KV.assessTrackContext({ agentType: 'track', context: 290_000, triggered: [280_000] })).toBeNull();
  });
  it('other agent types and the main session: no effect', () => {
    expect(KV.assessTrackContext({ agentType: 'reviewer', compactions: 2 })).toBeNull();
    expect(KV.assessTrackContext({ agentType: null, compactions: 2 })).toBeNull();
  });
});

describe('pause words and pause advice', () => {
  it.each([
    'I have to go now',
    'heading out, see you',
    'brb',
    'be back in an hour',
    'going to bed',
    'Taking a BREAK',
    'pause.',
    'good night',
    'Jeg må reise nå',
    'tilbake om en time',
    'god natt',
  ])('triggers: %s', (p) => expect(KV.isPauseMessage(p)).toBe(true));
  it.each([
    'Add a pauseButton',
    'paused tracks in the board',
    'fix it right away',
    'put it back in the list',
    'run the gates',
    'bortetid i fraværet',
    '<task-notification>pause</task-notification>',
  ])('does not trigger: %s', (p) => expect(KV.isPauseMessage(p)).toBe(false));
  it('only the orchestrator, and only above the threshold', () => {
    expect(KV.pauseAdvice({ prompt: 'pause', n: 151_000, orchestrator: true })?.systemMessage).toBe(KV.PAUSE_TIP);
    expect(KV.pauseAdvice({ prompt: 'pause', n: 150_000, orchestrator: true })).toBeNull();
    expect(KV.pauseAdvice({ prompt: 'pause', n: 300_000, orchestrator: false })).toBeNull();
    expect(KV.pauseAdvice({ prompt: 'pause', n: null, orchestrator: true })).toBeNull();
  });
});

describe('the SubagentStop end gate', () => {
  const empty = { agentType: 'track', commits: 0, hasEndLine: false, alreadyBlocked: false };
  it('no commit and no end line: block once', () => {
    expect(KV.assessEndGate(empty)).toEqual({ decision: 'block', reason: KV.END_REASON });
    expect(KV.assessEndGate({ ...empty, alreadyBlocked: true })).toBeNull();
    expect(KV.assessEndGate({ ...empty, stopHookActive: true })).toBeNull();
  });
  it('a commit or an end line passes; unknown fails open', () => {
    expect(KV.assessEndGate({ ...empty, commits: 1 })).toBeNull();
    expect(KV.assessEndGate({ ...empty, hasEndLine: true })).toBeNull();
    expect(KV.assessEndGate({ ...empty, commits: null })).toBeNull();
    expect(KV.assessEndGate({ ...empty, agentType: 'general-purpose' })).toBeNull();
  });
  it('hasEndLine: the last message, the text or the SubagentHandback call', () => {
    expect(KV.hasEndLine({ lastMessage: 'RESULT status=DONE branch=queue/X' })).toBe(true);
    expect(KV.hasEndLine({ lastMessage: 'REFUSE X: the base branch is missing' })).toBe(true);
    expect(KV.hasEndLine({ lastMessage: 'Done, everything looks fine.' })).toBe(false);
    const row = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });
    const handback = row([
      {
        type: 'tool_use',
        name: 'SubagentHandback',
        input: { message: 'RESULT status=PARTIAL branch=queue/X commits=1' },
      },
    ]);
    expect(KV.hasEndLine({ text: [handback, row([{ type: 'text', text: 'ok' }])].join('\n') })).toBe(true);
    expect(KV.hasEndLine({ text: row([{ type: 'text', text: 'still working' }]) })).toBe(false);
  });
});

describe('the track hooks as processes (echoed payload)', () => {
  const ORCHESTRATOR = join(__dirname, '..', '..');
  let folder: string;
  const run = (file: string, input: object, extra: Record<string, string> = {}) =>
    execFileSync(process.execPath, [join(ORCHESTRATOR, file)], {
      env: {
        ...process.env,
        // A QUEUE_* variable marks this as a queue project (lib/projectRoot.js queueActive).
        QUEUE_ROOT: folder,
        QUEUE_FOLDER: folder,
        QUEUE_CONFIG: join(folder, 'queue.config.json'),
        QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
        TRACK_CONTEXT_STATE: join(folder, 'cg'),
        TRACK_END_STATE: join(folder, 'end'),
        TRACK_CONTEXT_WARNING: '',
        TRACK_REPORT_WARNING: '',
        ...extra,
      },
      encoding: 'utf8',
      input: JSON.stringify(input),
    });
  const usage = (n: number) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, cache_read_input_tokens: n - 1 },
      },
    });
  const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-compact-'));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('hook-track-context: a reminder at the 1st compaction, PARTIAL (logged) at the 2nd', () => {
    const tp = join(folder, 'agent-a1.jsonl');
    const input = { agent_type: 'cq:track', agent_id: 'a1', agent_transcript_path: tp };
    writeFileSync(tp, usage(50_000) + '\n');
    expect(run('hook-track-context.mjs', input)).toBe('');
    writeFileSync(tp, [usage(260_000), boundary, usage(40_000)].join('\n') + '\n');
    const one = JSON.parse(run('hook-track-context.mjs', input));
    expect(one.hookSpecificOutput.additionalContext).toContain('You have been compacted once');
    expect(run('hook-track-context.mjs', input)).toBe(''); // once
    writeFileSync(
      tp,
      [usage(260_000), boundary, usage(40_000), usage(260_000), boundary, usage(40_000)].join('\n') + '\n',
    );
    const two = JSON.parse(run('hook-track-context.mjs', input));
    expect(two.hookSpecificOutput.additionalContext).toMatch(/compacted 2 times.*PARTIAL/);
    const log = readFileSync(join(folder, 'times.jsonl'), 'utf8').trim().split('\n');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0])).toMatchObject({ event: 'contextGuard', compactions: 2, cause: 'compaction' });
    expect(run('hook-track-context.mjs', input)).toBe('');
  });

  it('hook-track-end: an empty track is blocked once; with a commit or RESULT it passes', () => {
    // A temporary repo: base branch "trunk" (from queue.config.json), one empty track branch and one with a commit.
    const repo = join(folder, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
    git('init', '-q', '-b', 'trunk');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'start');
    const start = git('rev-parse', 'HEAD');
    git('branch', 'queue/T-EMPTY');
    git('checkout', '-q', '-b', 'queue/T-DONE');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git('add', 'b.txt');
    git('commit', '-q', '-m', 'work');
    git('checkout', '-q', 'trunk');
    writeFileSync(join(folder, 'queue.config.json'), JSON.stringify({ baseBranch: 'trunk' }));
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        tasks: [
          { id: 'T-EMPTY', branch: 'queue/T-EMPTY', head_start: start },
          { id: 'T-DONE', head_start: start }, // no branch field: <branchPrefix><id>
        ],
      }),
    );
    const transcript = (id: string, track: string) => {
      const tp = join(folder, `agent-${id}.jsonl`);
      const first = JSON.stringify({
        type: 'user',
        message: { content: `The mission is in C:\\x\\prompt-${track}.md` },
      });
      writeFileSync(tp, [first, usage(10_000)].join('\n') + '\n');
      return tp;
    };
    const input = (id: string, track: string, last = 'Done.') => ({
      hook_event_name: 'SubagentStop',
      agent_type: 'track',
      agent_id: id,
      agent_transcript_path: transcript(id, track),
      last_assistant_message: last,
    });
    const env = { QUEUE_GIT: repo };
    expect(JSON.parse(run('hook-track-end.mjs', input('b1', 'T-EMPTY'), env))).toEqual({
      decision: 'block',
      reason: KV.END_REASON,
    });
    expect(run('hook-track-end.mjs', input('b1', 'T-EMPTY'), env)).toBe(''); // only once
    expect(
      run('hook-track-end.mjs', input('b2', 'T-EMPTY', 'RESULT status=DONE branch=queue/T-EMPTY commits=0'), env),
    ).toBe('');
    expect(run('hook-track-end.mjs', input('b3', 'T-DONE'), env)).toBe(''); // one own commit
    expect(run('hook-track-end.mjs', { ...input('b4', 'T-EMPTY'), agent_type: 'Explore' }, env)).toBe('');
    // Fails open: an unknown base branch makes git fail, so nothing is blocked.
    writeFileSync(join(folder, 'queue.config.json'), JSON.stringify({ baseBranch: 'no-such-branch' }));
    expect(run('hook-track-end.mjs', input('b5', 'T-EMPTY'), env)).toBe('');
  });
});
