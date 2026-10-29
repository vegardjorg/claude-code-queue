// =============================================================
// queueSmall.test.ts: the small-task guard in the work queue.
//
// A small task must not become its own track: <= 10 min is offered to the owner as "fix now" or the batch queue, a
// larger but still small task with low priority goes to the batch queue, and without value (uncertain priority) the
// owner is asked. The tests assert the pure function in queueLogic.js that `queue.mjs add` calls.
// =============================================================
import { describe, it, expect } from 'vitest';

type Task = Record<string, unknown> & { id: string };
/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic') as {
  smallTaskError: (o: Task, tasks?: Task[], resolved?: string[]) => string[];
};
/* eslint-enable @typescript-eslint/no-require-imports */

const up = (field: Record<string, unknown> = {}): Task => ({
  id: 'A',
  class: 'K',
  status: 'waiting',
  value: 4,
  content_min: 5,
  depends_on: [],
  waiting_on: [],
  ...field,
});

describe('smallTaskError', () => {
  it('<= 10 min: not in the queue, the owner picks fix now or the batch queue', () => {
    expect(L.smallTaskError(up()).join()).toMatch(/fix now \(recommended\) or batch queue/);
    expect(L.smallTaskError(up({ content_min: 10 })).join()).toMatch(/fix now/);
    expect(L.smallTaskError(up({ batched: true }))).toEqual([]);
  });

  it('over 10 min, below the class lower target and low priority: batch queue', () => {
    expect(L.smallTaskError(up({ content_min: 30 })).join()).toMatch(
      /batch queue with "batched": true/,
    );
    expect(L.smallTaskError(up({ content_min: 30, batched: true }))).toEqual([]);
    expect(L.smallTaskError(up({ class: 'D', content_min: 20 })).join()).toMatch(/batch queue/);
  });

  it('high priority over 10 min may be its own track', () => {
    expect(L.smallTaskError(up({ content_min: 30, value: 8 }))).toEqual([]);
  });

  it('uncertain priority (no value): ask the owner', () => {
    expect(L.smallTaskError(up({ value: undefined })).join()).toMatch(/Ask the owner/);
    expect(L.smallTaskError(up({ content_min: 30, value: undefined })).join()).toMatch(
      /the priority is uncertain/,
    );
  });

  it('does not trigger at the right size, without content_min, for D+, own_track, an owner question or a blocking task', () => {
    expect(L.smallTaskError(up({ content_min: 90 }))).toEqual([]);
    expect(L.smallTaskError(up({ class: 'D', content_min: 40 }))).toEqual([]);
    expect(L.smallTaskError(up({ content_min: undefined }))).toEqual([]);
    expect(L.smallTaskError(up({ class: 'D+' }))).toEqual([]);
    expect(L.smallTaskError(up({ own_track: 'the owner asked for it' }))).toEqual([]);
    expect(L.smallTaskError(up({ waiting_on: ['Q1'] }))).toEqual([]);
    expect(L.smallTaskError(up({ waiting_on: ['Q1'] }), [], ['Q1']).join()).toMatch(/fix now/);
    const b = { id: 'B', status: 'waiting', depends_on: ['A'] };
    expect(L.smallTaskError(up(), [b])).toEqual([]);
  });

  it('own_track must be a reason', () => {
    expect(L.smallTaskError(up({ own_track: '' })).join()).toMatch(/own_track must be/);
    expect(L.smallTaskError(up({ own_track: true })).join()).toMatch(/own_track must be/);
  });
});
