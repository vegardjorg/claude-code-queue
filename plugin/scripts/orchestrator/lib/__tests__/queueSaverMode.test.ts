// =============================================================
// queueSaverMode.test.ts: saverMode in workQueue (lib/queueLogic.js). The budget guard stops new tasks when
// today's usage has reached the daily budget, and proposals from agents are never started before they are approved.
// =============================================================
import { describe, it, expect } from 'vitest';

type Task = {
  id: string;
  title?: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  added_by?: string;
  depends_on?: string[];
  approved?: string;
};
type Queue = {
  tasks: Task[];
  limits?: Record<string, number | null>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../queueLogic') as {
  DEFAULT_LIMITS: Record<string, number | null>;
  validate: (o: unknown, ex?: Task[]) => string[];
  blockers: (o: Task, all: Task[], resolved?: string[]) => string[];
  selectNext: (queue: Queue) => { id: string }[];
  state: (
    queue: Queue,
    dailyUsage?: number,
  ) => {
    empty: boolean;
    canStart: number;
    proposed: number;
    stop?: string;
    budget?: string;
    blocked: { id: string; blockers: string[] }[];
  };
  budgetGuard: (
    queue: Queue,
    dailyUsage?: number,
  ) => { active: boolean; stop: boolean; message?: string };
  parseLimit: (name: string, raw: string) => { val: number | null } | { error: string };
  isAgentSource: (addedBy: string | undefined, tasks?: Task[]) => boolean;
  statusAtAdd: (fresh: Partial<Task>, tasks?: Task[], v?: { approved?: boolean }) => string;
  approve: (queue: Queue, ids: string[], now?: string) => { approved: string[]; error: string[] };
};

const o = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  domain: 'example',
  class: 'K',
  status: 'waiting',
  ...extra,
});

describe('budgetGuard', () => {
  it('default is off: no limit before the owner has set a number', () => {
    expect(K.DEFAULT_LIMITS.dailyBudget).toBeNull();
    expect(K.budgetGuard({ tasks: [] }, 10_000)).toEqual({ active: false, stop: false });
    expect(K.budgetGuard({ tasks: [], limits: { dailyBudget: 0 } }, 10_000).active).toBe(
      false,
    );
  });

  it('under the limit: active, not stop; at or over: stop with a clear message', () => {
    const queue = { tasks: [], limits: { dailyBudget: 300 } };
    expect(K.budgetGuard(queue, 299.99)).toMatchObject({ active: true, stop: false });
    const b = K.budgetGuard(queue, 300);
    expect(b.stop).toBe(true);
    expect(b.message).toMatch(/DAILY BUDGET USED UP: 300\.00 of 300\.00 USD/);
  });

  it('state: over the budget nothing can start, and a queue without running tasks is "empty" (the loop stops)', () => {
    const queue = { tasks: [o('a'), o('b')], limits: { dailyBudget: 100 } };
    expect(K.state(queue, 50)).toMatchObject({ canStart: 2, empty: false });
    const t = K.state(queue, 150);
    expect(t).toMatchObject({ canStart: 0, empty: true, stop: 'dailyBudget' });
    expect(t.budget).toMatch(/USED UP/);
    // The blocked list says why, instead of empty blockers.
    expect(t.blocked).toEqual([
      { id: 'a', blockers: ['the daily budget is used up'] },
      { id: 'b', blockers: ['the daily budget is used up'] },
    ]);
    // Without usage (budget off) as before.
    expect(K.state({ tasks: [o('a')] }).canStart).toBe(1);
  });

  it('limits are parsed strictly: dailyBudget in USD or "off", max* as an integer ≥ 0', () => {
    expect(K.parseLimit('dailyBudget', '250,5')).toEqual({ val: 250.5 });
    expect(K.parseLimit('dailyBudget', 'off')).toEqual({ val: null });
    expect(K.parseLimit('dailyBudget', '-1')).toHaveProperty('error');
    expect(K.parseLimit('maxConcurrent', '5')).toEqual({ val: 5 });
    expect(K.parseLimit('maxConcurrent', '-1')).toHaveProperty('error');
    expect(K.parseLimit('maxAll', '5')).toHaveProperty('error');
  });
});

describe('proposals from agents', () => {
  const queue: Task[] = [o('SB-D2', { status: 'done' }), o('B-4', { status: 'running' })];

  it('a track (task id in the queue, also a fix round), a reviewer or a fold agent are agent sources', () => {
    expect(K.isAgentSource('SB-D2', queue)).toBe(true);
    expect(K.isAgentSource('B-4-r2', queue)).toBe(true);
    expect(K.isAgentSource('rev-B-4', queue)).toBe(true);
    expect(K.isAgentSource('fold-agent 2026-09-30 (9.241 PART 7-10)', queue)).toBe(true);
  });

  it('the owner (add-to-queue) and the orchestrator are not agent sources', () => {
    expect(K.isAgentSource('add-to-queue 2026-09-30 (R2 security check)', queue)).toBe(false);
    expect(K.isAgentSource('orchestrator', queue)).toBe(false);
    expect(K.isAgentSource(undefined, queue)).toBe(false);
    expect(K.isAgentSource('revision of plan', queue)).toBe(false);
  });

  it('add: an agent gives proposed, otherwise waiting; --approved gives waiting', () => {
    expect(K.statusAtAdd({ id: 'NEW-1', added_by: 'SB-D2' }, queue)).toBe('proposed');
    expect(K.statusAtAdd({ id: 'NEW-2', added_by: 'orchestrator' }, queue)).toBe('waiting');
    expect(K.statusAtAdd({ id: 'NEW-3', added_by: 'SB-D2' }, queue, { approved: true })).toBe(
      'waiting',
    );
  });

  it('a proposal is never started, and the blocker says how it is approved', () => {
    const all = [o('F1', { status: 'proposed', added_by: 'SB-D2' }), o('V1')];
    expect(K.selectNext({ tasks: all }).map((v) => v.id)).toEqual(['V1']);
    expect(K.blockers(all[0], all)[0]).toMatch(/cq approve F1/);
    expect(K.state({ tasks: all }).proposed).toBe(1);
    expect(K.validate({ ...o('X', { status: 'proposed' }), mission: 'text' })).toEqual([]);
  });

  it('approve: proposed → waiting with a timestamp; everything else is an error', () => {
    const k: Queue = { tasks: [o('F1', { status: 'proposed' }), o('V1')] };
    const r = K.approve(k, ['F1', 'V1', 'Z'], '2026-09-30T12:00:00Z');
    expect(r.approved).toEqual(['F1']);
    expect(r.error).toEqual(['V1 is not proposed (status waiting)', 'unknown task Z']);
    expect(k.tasks[0]).toMatchObject({ status: 'waiting', approved: '2026-09-30T12:00:00Z' });
    expect(
      K.selectNext(k)
        .map((v) => v.id)
        .sort(),
    ).toEqual(['F1', 'V1']);
  });
});
