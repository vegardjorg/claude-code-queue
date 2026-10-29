// =============================================================
// timeCost.test.ts: correct measurement of agent usage (lib/timeCost.js). Cumulative
// "done" rows must not be double counted, usage is split by local day, cache writes are priced by type, track ids
// with hyphens are recognized, and cache expiry is counted from the transcript.
// =============================================================
import { describe, it, expect } from 'vitest';

type Tokens = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_written?: number;
  cache_written_5m?: number;
  cache_written_1h?: number;
};
type Row = {
  time: string;
  event: string;
  track?: string;
  agent_id?: string | null;
  agent_type?: string | null;
  tokens?: Tokens;
  model?: string;
  modelTurns?: number;
  cache_expiry?: number;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../timeCost') as {
  costUsd: (t: Tokens, model?: string) => number;
  trackFromText: (t: string) => string | null;
  analyzeTranscript: (t: string) => {
    tokens: Required<Tokens>;
    modelTurns: number;
    toolCall: number;
    model: string | null;
    cache_expiry: number;
    cost_usd: number;
    track: string | null;
    first_change_s: number | null;
  };
  dayFor: (iso: string, tz?: string) => string | null;
  readRows: (t: string) => Row[];
  usageEvents: (r: Row[]) => { agent: string; day: string; usd: number }[];
  dailyUsage: (r: Row[], day: string) => number;
  summarizeCost: (
    r: Row[],
    v?: { day?: string | null; classFor?: (s: string) => string | null },
  ) => {
    total: number;
    perType: { type: string; usd: number; agents: number; share: number }[];
    perTrack: { track: string; usd: number }[];
    perClass: { class: string; usd: number }[];
  };
  deduplicateDone: (r: Row[]) => Row[];
  taskIdFor: (track: string, exists: (x: string) => boolean) => string | null;
};

const MILL = 1_000_000;

describe('price (API-equivalent, list prices from the investigation)', () => {
  it('Opus 5.5: input 4, output 20, cache read 0.20, write 5 min 5 and 1 h 8 USD per MTok', () => {
    expect(T.costUsd({ input: MILL })).toBeCloseTo(4);
    expect(T.costUsd({ output: MILL })).toBeCloseTo(20);
    expect(T.costUsd({ cache_read: MILL })).toBeCloseTo(0.2);
    expect(
      T.costUsd({ cache_written: MILL, cache_written_5m: MILL, cache_written_1h: 0 }),
    ).toBeCloseTo(5);
    expect(
      T.costUsd({ cache_written: MILL, cache_written_5m: 0, cache_written_1h: MILL }),
    ).toBeCloseTo(8);
  });

  it('older rows with only the sum are priced as 5 min (subagents have a 5 minute cache)', () => {
    expect(T.costUsd({ cache_written: 2 * MILL })).toBeCloseTo(10);
  });
});

describe('track id from the mission', () => {
  it('prompt file with hyphen and a letter first (the old regex only took [A-Za-z0-9]+)', () => {
    expect(
      T.trackFromText('The mission is in C:\\x\\scratchpad\\prompt-A-1b.md and is binding'),
    ).toBe('A-1b');
    expect(T.trackFromText('prompt-B4-r2.md')).toBe('B4-r2');
  });

  it('"track <ID>" and "TRACK <ID>", but not ordinary words after "track"', () => {
    expect(T.trackFromText('You are track D-2b in the continuous queue.')).toBe('D-2b');
    expect(T.trackFromText('## TRACK C-E3a (title)')).toBe('C-E3a');
    expect(T.trackFromText('You are one track in a parallel wave')).toBeNull();
  });

  it('fix rounds belong to the task in the queue', () => {
    const queue = new Set(['B4', 'A-1b']);
    expect(T.taskIdFor('B4-r2', (x) => queue.has(x))).toBe('B4');
    expect(T.taskIdFor('A-1b', (x) => queue.has(x))).toBe('A-1b');
    expect(T.taskIdFor('unknown-r1', (x) => queue.has(x))).toBeNull();
  });
});

describe('transcriptAnalysis', () => {
  const line = (o: object) => JSON.stringify(o);
  const turn = (id: string, ts: string, usage: object, content: object[] = []) =>
    line({
      type: 'assistant',
      timestamp: ts,
      message: { id, model: 'claude-opus-5-5', usage, content: content },
    });
  const transcript = [
    line({
      type: 'user',
      timestamp: '2026-09-30T10:00:00Z',
      message: { content: 'You are track A-1b. The mission is in prompt-A-1b.md' },
    }),
    turn(
      'm1',
      '2026-09-30T10:00:05Z',
      {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 50_000,
        cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 0 },
      },
      [{ type: 'tool_use', id: 't1', name: 'Read' }],
    ),
    // Same message streamed over two lines: counted once.
    turn('m1', '2026-09-30T10:00:06Z', {
      input_tokens: 10,
      output_tokens: 120,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 50_000,
      cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 0 },
    }),
    turn(
      'm2',
      '2026-09-30T10:01:00Z',
      {
        input_tokens: 5,
        output_tokens: 50,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 1_000,
      },
      [{ type: 'tool_use', id: 't2', name: 'Edit' }],
    ),
    // 8 minute pause: the cache (5 min) expired, the whole context written again.
    turn('m3', '2026-09-30T10:09:00Z', {
      input_tokens: 5,
      output_tokens: 50,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 31_000,
      cache_creation: { ephemeral_5m_input_tokens: 31_000, ephemeral_1h_input_tokens: 0 },
    }),
  ].join('\n');

  it('tokens per type, turns deduplicated per message.id, track from the mission', () => {
    const a = T.analyzeTranscript(transcript);
    expect(a.modelTurns).toBe(3);
    expect(a.tokens.output).toBe(120 + 50 + 50);
    expect(a.tokens.cache_written).toBe(82_000);
    expect(a.tokens.cache_written_5m).toBe(82_000); // m2 without a split counts as 5 min
    expect(a.tokens.cache_written_1h).toBe(0);
    expect(a.track).toBe('A-1b');
    expect(a.model).toBe('claude-opus-5-5');
    expect(a.toolCall).toBe(2);
    expect(a.first_change_s).toBe(60);
  });

  it('cache expiry: pause over 5 min before a turn that writes more than it reads', () => {
    expect(T.analyzeTranscript(transcript).cache_expiry).toBe(1);
  });

  it('cost_usd matches the prices', () => {
    const a = T.analyzeTranscript(transcript);
    expect(a.cost_usd).toBeCloseTo(Math.round(T.costUsd(a.tokens, 'claude-opus-5-5') * 100) / 100);
  });
});

describe('deduplicated usage rows', () => {
  // Agent A stopped twice (cumulative rows), past midnight Norwegian time; agent B once.
  const rows: Row[] = [
    { time: '2026-09-29T21:00:00Z', event: 'start', track: 'A1', agent_id: 'a' },
    {
      time: '2026-09-29T21:30:00Z',
      event: 'done',
      track: 'A1',
      agent_id: 'a',
      agent_type: 'track',
      tokens: { output: MILL }, // 20 USD cumulative
    },
    {
      time: '2026-09-29T23:00:00Z', // 01:00 Norwegian time 30.09
      event: 'done',
      track: 'A1',
      agent_id: 'a',
      agent_type: 'track',
      tokens: { output: 1.5 * MILL }, // 30 USD cumulative: 10 USD new today
    },
    {
      time: '2026-09-30T10:00:00Z',
      event: 'done',
      track: 'A1',
      agent_id: 'r',
      agent_type: 'reviewer',
      tokens: { input: MILL }, // 4 USD
    },
    { time: '2026-09-30T11:00:00Z', event: 'gate', track: 'A1' },
  ];

  it('the sum is the last row per agent, never the sum of cumulative rows', () => {
    const o = T.summarizeCost(rows);
    expect(o.total).toBeCloseTo(34);
    expect(o.perType.find((t) => t.type === 'track')).toMatchObject({ usd: 30, agents: 1 });
    expect(o.perType.find((t) => t.type === 'reviewer')).toMatchObject({ usd: 4, agents: 1 });
  });

  it('usage is split by local day (the growth lands on the day it happened)', () => {
    expect(T.dayFor('2026-09-29T23:00:00Z')).toBe('2026-09-30');
    expect(T.dailyUsage(rows, '2026-09-29')).toBeCloseTo(20);
    expect(T.dailyUsage(rows, '2026-09-30')).toBeCloseTo(14);
    expect(T.summarizeCost(rows, { day: '2026-09-30' }).total).toBeCloseTo(14);
  });

  it('per class and per track (the review is counted on the track it was for)', () => {
    const o = T.summarizeCost(rows, { classFor: (s) => (s === 'A1' ? 'D' : null) });
    expect(o.perClass).toEqual([{ class: 'D', usd: 34 }]);
    expect(o.perTrack[0]).toMatchObject({ track: 'A1', usd: 34 });
  });

  it('--show shows only the last "done" row per agent, everything else unchanged', () => {
    const shown = T.deduplicateDone(rows);
    expect(shown.filter((r) => r.event === 'done' && r.agent_id === 'a')).toHaveLength(1);
    expect(shown.find((r) => r.agent_id === 'a' && r.event === 'done')?.time).toBe(
      '2026-09-29T23:00:00Z',
    );
    expect(shown).toHaveLength(rows.length - 1);
  });

  it('broken lines (concurrent writers) are skipped', () => {
    expect(T.readRows('{"a":1}\n{"half\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
