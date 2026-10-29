// =============================================================
// contextMeasure.test.ts: the computation behind context-measure.mjs.
//
// Locks: only the LAST done row per agent counts (the rows are cumulative), the time window, the grouping per agent type
// and class, median/p90 and the class lookup from the queue (also fix rounds and reviewer agents).
// =============================================================
import { describe, expect, it } from 'vitest';

import { classLookup, quantile, measureContext, lastDonePerAgent } from '../contextMeasure';

const row = (agent: string, time: string, o: Record<string, unknown> = {}) => ({
  time,
  event: 'done',
  agent_id: agent,
  agent_type: 'track',
  track: agent,
  modelTurns: 10,
  cost_usd: 1,
  call_for_first_change: 5,
  context: { start: 20_000, median: 100_000, end: 150_000 },
  ...o,
});

describe('quantile', () => {
  it('median and p90 with interpolation', () => {
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('lastDonePerAgent', () => {
  it('takes the last row per agent in the window and skips rows without context', () => {
    const r = [
      row('a', '2026-10-10T10:00:00Z', { modelTurns: 5 }),
      row('a', '2026-10-10T11:00:00Z', { modelTurns: 9 }),
      row('b', '2026-10-01T10:00:00Z'),
      row('c', '2026-10-10T10:00:00Z', { context: undefined }),
      { time: '2026-10-10T10:00:00Z', event: 'start', agent_id: 'd' },
    ];
    const out = lastDonePerAgent(r, { from: Date.parse('2026-10-05T00:00:00Z') });
    expect(
      out.map((x: { agent_id: string; modelTurns: number }) => [x.agent_id, x.modelTurns]),
    ).toEqual([['a', 9]]);
  });
});

describe('measureContext', () => {
  it('groups per agent type and class and sums cost', () => {
    const r = [
      row('a', '2026-10-10T10:00:00Z', { context: { start: 1, median: 100_000, end: 2 } }),
      row('b', '2026-10-10T10:00:00Z', {
        context: { start: 1, median: 200_000, end: 2 },
        cost_usd: 3,
      }),
      row('c', '2026-10-10T10:00:00Z', {
        agent_type: 'reviewer',
        call_for_first_change: null,
      }),
    ];
    const m = measureContext(r, {
      classFor: (x: { agent_type: string }) => (x.agent_type === 'track' ? 'K' : null),
    });
    const k = m.groups.find((g: { class: string }) => g.class === 'K');
    expect(k).toMatchObject({
      agenttype: 'track',
      count: 2,
      context_median: 150_000,
      cost_sum: 4,
      cost_average: 2,
    });
    const rls = m.groups.find((g: { agenttype: string }) => g.agenttype === 'reviewer');
    expect(rls).toMatchObject({
      class: 'unknown',
      call_for_first_change_median: null,
      call_for_first_change_count: 0,
    });
    expect(m.total.count).toBe(3);
  });
});

describe('classLookup', () => {
  const queue = {
    tasks: [
      { id: 'X-1', class: 'D', cost: { agents: [{ agent: 'rev1', type: 'reviewer' }] } },
      { id: 'Y', class: 'K' },
    ],
  };
  const f = classLookup(queue);
  it('looks up task id, fix round and agent id', () => {
    expect(f({ track: 'X-1' })).toBe('D');
    expect(f({ track: 'X-1-r2' })).toBe('D');
    expect(f({ track: 'rev1abc', agent_id: 'rev1' })).toBe('D');
    expect(f({ track: 'Y' })).toBe('K');
    expect(f({ track: 'unknown' })).toBeNull();
  });
});
