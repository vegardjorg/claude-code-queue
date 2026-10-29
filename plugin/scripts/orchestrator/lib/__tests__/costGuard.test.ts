// =============================================================
// costGuard.test.ts: the cost guard.
//
// The rule is enforced in lib/costGuard.js and run by hook-context.mjs in the active orchestrator session. The tests
// prove the threshold logic as pure functions, and the hook end to end as a process against a temporary queue
// (QUEUE_FOLDER, QUEUE_TIME_LOG, QUEUE_TRANSCRIPTS), never the real one.
//   - Warning when a track passes FACTOR (3) x the average cost for its class (finished last 7 days, at least 3), once per track.
//   - The class from the mission file, otherwise the queue's class.
//   - No automatic stop: the output is never decision: block.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Warning = { id: string; class: string; usd: number; average: number; limit: number; n: number };
type Candidate = { agent: string; type: string; safe: boolean; row: { time: string } | null };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../costGuard') as {
  FACTOR: number;
  MIN_N: number;
  INTERVAL_MS: number;
  classFromMission: (t: string | null) => string | null;
  averagePerClass: (s: unknown) => Record<string, { average: number; n: number }>;
  liveAgents: (rows: unknown[], id: string, o?: { from?: string | null }) => Candidate[];
  shouldMeasure: (t: unknown, now: number, interval?: number) => boolean;
  assess: (a: {
    measurements: { id: string; class: string | null; usd: number }[];
    average: Record<string, { average: number; n: number }>;
    notified?: Record<string, { usd: number; time: string }>;
    factor?: number;
    minN?: number;
    now?: number;
  }) => { notices: Warning[]; notified: Record<string, { usd: number; time: string }> };
  trackMessage: (v: Warning) => string;
  hookText: (v: Warning[]) => { systemMessage: string; additionalContext: string } | null;
};

const NOW = Date.parse('2026-10-07T12:00:00Z');
const AVERAGE = { K: { average: 10, n: 4 }, D: { average: 5, n: 2 } };

describe('classFromMission', () => {
  it('reads the table row in the mission file', () => {
    expect(
      K.classFromMission('# X\n\n| | |\n|---|---|\n| Class | K (weight 1.0), estimate about 30 min |\n'),
    ).toBe('K');
    expect(K.classFromMission('| Class | D+ (weight 2.0) |')).toBe('D+');
  });
  it('falls back to "class X" in the title, and gives null without a match', () => {
    expect(K.classFromMission('## TRACK A (Something; source: x; class D, estimate 40 min)')).toBe('D');
    expect(K.classFromMission('no class here')).toBeNull();
    expect(K.classFromMission(null)).toBeNull();
  });
});

describe('averagePerClass', () => {
  it('is sum / n per class from costStatistics', () => {
    expect(
      K.averagePerClass({
        perClass: [
          { class: 'K', n: 3, usd: 31 },
          { class: 'D', n: 0, usd: 0 },
        ],
      }),
    ).toEqual({ K: { average: 10.33, n: 3 } });
  });
});

describe('assess (the threshold)', () => {
  it('notifies above 3x the average (FACTOR), not at or below', () => {
    const r = K.assess({
      measurements: [
        { id: 'A', class: 'K', usd: 30.01 },
        { id: 'B', class: 'K', usd: 30 },
        { id: 'C', class: 'K', usd: 3 },
      ],
      average: AVERAGE,
      now: NOW,
    });
    expect(r.notices).toEqual([{ id: 'A', class: 'K', usd: 30.01, average: 10, limit: 30, n: 4 }]);
    expect(Object.keys(r.notified)).toEqual(['A']);
  });

  it('does not notify when the class has too few finished tasks or an unknown class', () => {
    const r = K.assess({
      measurements: [
        { id: 'D1', class: 'D', usd: 100 },
        { id: 'U1', class: 'U', usd: 100 },
        { id: 'X', class: null, usd: 100 },
      ],
      average: AVERAGE,
    });
    expect(r.notices).toEqual([]);
  });

  it('notifies each track once, and forgets tracks no longer running', () => {
    const first = K.assess({
      measurements: [{ id: 'A', class: 'K', usd: 35 }],
      average: AVERAGE,
      now: NOW,
    });
    const others = K.assess({
      measurements: [{ id: 'A', class: 'K', usd: 40 }],
      average: AVERAGE,
      notified: first.notified,
    });
    expect(others.notices).toEqual([]);
    const done = K.assess({ measurements: [], average: AVERAGE, notified: others.notified });
    expect(done.notified).toEqual({});
  });

  it('the hook text notifies the orchestrator and has a message for the track, never block', () => {
    const v = K.assess({ measurements: [{ id: 'A', class: 'K', usd: 45 }], average: AVERAGE }).notices;
    const t = K.hookText(v);
    expect(t?.systemMessage).toMatch(/Cost guard: A \(K\) \$45 > 3x average \$10/);
    expect(t?.additionalContext).toMatch(/SendMessage/);
    expect(K.trackMessage(v[0])).toMatch(/PARTIAL/);
    expect(t).not.toHaveProperty('decision');
    expect(K.hookText([])).toBeNull();
  });
});

describe('shouldMeasure', () => {
  it('measures the first time and when the interval has passed', () => {
    expect(K.shouldMeasure({}, NOW)).toBe(true);
    const t = { last_measured: new Date(NOW - 60_000).toISOString() };
    expect(K.shouldMeasure(t, NOW)).toBe(false);
    expect(K.shouldMeasure(t, NOW + K.INTERVAL_MS)).toBe(true);
    expect(K.shouldMeasure(t, NOW, 0)).toBe(true);
  });
});

describe('liveAgents', () => {
  const rows = [
    {
      time: '2026-10-07T10:00:00Z',
      track: 'a1b2c3',
      event: 'start',
      agent_id: 'a1b2c3d4',
      agent_type: 'track',
    },
    {
      time: '2026-10-07T10:30:00Z',
      track: 'A',
      event: 'done',
      agent_id: 'a1b2c3d4',
      tokens: { output: 1 },
    },
    {
      time: '2026-10-07T10:40:00Z',
      track: 'e5f6',
      event: 'start',
      agent_id: 'e5f6g7',
      agent_type: 'track',
    },
    {
      time: '2026-10-07T10:41:00Z',
      track: 'B',
      event: 'done',
      agent_id: 'b9',
      tokens: { output: 1 },
    },
    {
      time: '2026-10-07T10:42:00Z',
      track: 'g',
      event: 'start',
      agent_id: 'gx',
      agent_type: 'general-purpose',
    },
    {
      time: '2026-09-01T10:00:00Z',
      track: 'old',
      event: 'start',
      agent_id: 'old1',
      agent_type: 'track',
    },
    {
      time: '2026-10-07T11:00:00Z',
      track: 'A-r2',
      event: 'done',
      agent_id: 'r2',
      tokens: { output: 1 },
    },
  ];
  it('includes safe ones (label, also fix round) and running track candidates after start', () => {
    const r = K.liveAgents(rows, 'A', { from: '2026-10-07T09:00:00Z' });
    const summary = r.map((x) => [x.agent, x.safe]);
    expect(summary).toEqual([
      ['a1b2c3d4', true],
      ['e5f6g7', false],
      ['r2', true],
    ]);
    expect(r[0].row?.time).toBe('2026-10-07T10:30:00Z');
  });
});

// ---- Process: the hook against a temporary queue (never the real one) ----
describe('hook-context.mjs: the cost guard end to end', () => {
  const ORCHESTRATOR = join(__dirname, '..', '..');
  let folder: string;

  const env = () => ({
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_GIT: folder,
    QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: join(folder, 'transcripts'),
    COST_GUARD_INTERVAL_MIN: '0',
    COST_GUARD_BY: '',
    CONTEXT_WARNING: '',
    CONTEXT_STOP: '',
    CONTEXT_WIND_DOWN: '',
    CONTEXT_STOP_ORCHESTRATOR: '',
  });
  function run(file: string, args: string[], input?: string) {
    try {
      return execFileSync(process.execPath, [join(ORCHESTRATOR, file), ...args], {
        env: env(),
        encoding: 'utf8',
        input,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return String((e as { stdout?: string }).stdout ?? '');
    }
  }
  /** The orchestrator's transcript: an orchestrator call now and a small context (below all context limits). */
  function transcript() {
    const now = new Date().toISOString();
    const filePath = join(folder, 'orch.jsonl');
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: now,
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'node scripts/orchestrator/queue.mjs orchestrator pulse' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: now,
          message: {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, cache_read_input_tokens: 999 },
          },
        }),
      ].join('\n') + '\n',
    );
    return filePath;
  }
  const hook = (sessionId: string) => {
    const out = run(
      'hook-context.mjs',
      [],
      JSON.stringify({ session_id: sessionId, transcript_path: transcript(), prompt: 'hello' }),
    );
    return out ? JSON.parse(out) : null;
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-cost-guard-'));
    mkdirSync(join(folder, 'transcripts'));
    const mission = join(folder, 'X.md');
    writeFileSync(mission, '# X\n\n| | |\n|---|---|\n| Class | K (weight 1.0) |\n');
    const done = new Date(Date.now() - 86_400_000).toISOString();
    const doneK = (id: string) => ({
      id,
      title: id,
      domain: 'client',
      class: 'K',
      status: 'done',
      done,
      mission: 'x',
      cost: { usd: 10, tokens: { sum: 1 }, agents: [], measured: done },
    });
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        tasks: [
          doneK('F1'),
          doneK('F2'),
          doneK('F3'),
          {
            id: 'X',
            title: 'X',
            domain: 'client',
            // The queue says D, the mission file says K: the file wins.
            class: 'D',
            status: 'running',
            started: new Date(Date.now() - 3_600_000).toISOString(),
            mission,
          },
        ],
        limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 5 },
        next_migr: 100,
      }),
    );
    // Ten million output tokens: far above $20 with any model price.
    writeFileSync(
      join(folder, 'times.jsonl'),
      JSON.stringify({
        time: new Date().toISOString(),
        wave: 'queue',
        track: 'X',
        event: 'done',
        agent_id: 'agentX',
        agent_type: 'track',
        tokens: { output: 10_000_000 },
      }) + '\n',
    );
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('notifies the orchestrator once when the track passes FACTOR x the average; other sessions get nothing', () => {
    run('queue.mjs', ['orchestrator', 'pulse', '--session', 'queue A']);
    const out = hook('s1');
    expect(out).not.toHaveProperty('decision');
    expect(out.systemMessage).toMatch(/Cost guard: X \(K\)/);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/COST_GUARD X/);
    const state = JSON.parse(readFileSync(join(folder, 'costGuard.json'), 'utf8'));
    expect(Object.keys(state.notified)).toEqual(['X']);
    // Second time: already notified.
    expect(hook('s1')).toBeNull();
  });

  it('does nothing without an active orchestrator', () => {
    expect(hook('s2')).toBeNull();
  });
});
