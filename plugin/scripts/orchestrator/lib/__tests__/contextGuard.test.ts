// =============================================================
// contextGuard.test.ts: the wind-down step and compaction in the context guard.
//
// The rules are enforced in lib/contextGuard.js (hook-context.mjs) and queueLogic.windDownGuard/startGuard (queue.mjs).
// The tests prove them there: the pure functions, the hook run as a process with a fake transcript, and queue.mjs against a
// copy of the queue in a temporary folder (QUEUE_FOLDER), never the real one.
//   - Not orchestrator: notice from 250k, stop at 400k.
//   - Orchestrator: wind-down at 350k (flag in the cursor), stop only at 550k.
//   - <task-notification> and <agent-message> are never stopped (otherwise the queue freezes).
//   - `start`/`next`/`fill` refuse during wind-down (exit 6); a new session (new --session name or new binding) resets.
//   - Compaction is the default. COMPACT at 280k after each compaction (no fixed
//     limit that triggers rotation), WIND_DOWN asks for compaction, not rotation, and the mode (manual or automatic
//     compaction, `queue.mjs compact auto|manual`) appears in the hook messages and on the board.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Cursor = {
  session: string;
  updated: string;
  event?: string | null;
  session_id?: string;
  session_id_time?: number;
  windDown?: { from: string; context: number | null; session_id: string };
};
type Decision = { action: string; setWindDown: boolean; limit?: number };
type G = {
  notice: number;
  stop: number;
  windDown: number;
  stopOrchestrator: number;
  compact: number;
};
type Mode = 'auto' | 'manual';
type Question = { sp: string; text?: string | null; recommendation?: string | null };

/* eslint-disable @typescript-eslint/no-require-imports */
const KV = require('../contextGuard') as {
  STANDARD: G;
  limits: (env?: Record<string, string | undefined>) => G;
  isSystemMessage: (p: string) => boolean;
  lastOrchestratorCall: (text: string) => number | null;
  orchestratorBinding: (input: {
    cursor: Cursor | null;
    sessionId: string | null;
    lastCall: number | null;
    now?: number;
  }) => { orchestrator: boolean; cursor: Cursor | null; changed: boolean };
  inWindDown: (m: Cursor | null, s: string) => boolean;
  assess: (input: {
    n: number | null;
    prompt: string;
    orchestrator: boolean;
    inWindDown?: boolean;
    compactions?: number;
    g?: G;
  }) => Decision;
  COMPACT_COMMAND: string;
  HANDOVER_NOTE: string;
  compactMode: (queue: unknown) => Mode;
  forCompactInstruction: () => string;
  countCompactions: (text: string) => number;
  afterCompactBound: (input: { cursor: Cursor | null; sessionId: string | null }) => boolean;
  withoutWindDown: (m: Cursor | null, s: string) => { cursor: Cursor | null; changed: boolean };
  afterCompactText: (input: {
    show: string;
    question: Question[];
    unpushed: number | null;
    compactions: number;
    windDownRevoked?: boolean;
    mode?: Mode;
    g?: G;
    maxDraw?: number;
  }) => string;
  withWindDown: (m: Cursor, input: { sessionId: string; n: number; now?: number }) => Cursor;
  hookOutput: (
    b: Decision,
    input: {
      n: number;
      orchestrator: boolean;
      g?: G;
      now?: number;
      compactions?: number;
      mode?: Mode;
    },
  ) => Record<string, unknown> | null;
};
const L = require('../queueLogic') as {
  windDownGuard: (m: Cursor | null, now?: number) => { active: boolean; stop: boolean };
  startGuard: (
    queue: unknown,
    usage?: number,
    option?: { now?: number; force?: boolean; cursor?: Cursor | null },
  ) => { code: number; stop: string } | null;
  state: (
    queue: unknown,
    usage?: number,
    option?: { now?: number; cursor?: Cursor | null },
  ) => { canStart: number; stop?: string };
  newCursor: (
    previous: Cursor | null,
    option: { session?: string; event?: string; now?: string },
  ) => Cursor;
  LIMIT_NAME: string[];
  parseLimit: (name: string, raw: string) => { val?: unknown; error?: string };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = Date.parse('2026-10-07T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const cursor = (field: Partial<Cursor> = {}): Cursor => ({
  session: 'queue A',
  updated: iso(NOW - 5 * MIN),
  event: 'pulse',
  ...field,
});
const g = KV.STANDARD;

describe('assess: the thresholds', () => {
  const v = (n: number, orchestrator: boolean, prompt = 'hello', inWindDown = false) =>
    KV.assess({ n, prompt, orchestrator, inWindDown, g });

  it('not orchestrator: nothing under 250k, notice from 250k, stop at 400k', () => {
    expect(v(249_999, false).action).toBe('none');
    expect(v(250_000, false).action).toBe('notice');
    expect(v(399_999, false).action).toBe('notice');
    expect(v(400_000, false)).toMatchObject({ action: 'stop', limit: 400_000 });
    expect(v(600_000, false).setWindDown).toBe(false);
  });

  it('orchestrator: notice from 250k, wind-down (flag set once) at 350k, stop only at 550k', () => {
    expect(v(279_999, true).action).toBe('notice');
    expect(v(300_000, true).action).toBe('compact');
    expect(v(350_000, true)).toEqual({ action: 'windDown', setWindDown: true });
    expect(v(450_000, true, 'hello', true)).toEqual({ action: 'windDown', setWindDown: false });
    expect(v(549_999, true, 'hello', true).action).toBe('windDown');
    expect(v(550_000, true, 'hello', true)).toMatchObject({ action: 'stop', limit: 550_000 });
    // If the context jumps straight past 550k, the flag is set anyway.
    expect(v(560_000, true).setWindDown).toBe(true);
  });

  it('task-notification and agent-message are never stopped, not even above the hard limit', () => {
    const tn = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>';
    const am = '<agent-message from="a28a2efcb1203133e"> [Subagent hand-back] …';
    expect(KV.isSystemMessage(tn)).toBe(true);
    expect(KV.isSystemMessage(am)).toBe(true);
    expect(KV.isSystemMessage('hello <task-notification>')).toBe(false);
    expect(v(900_000, false, tn).action).toBe('notice');
    expect(v(900_000, false, am).action).toBe('notice');
    expect(v(900_000, true, tn, true).action).toBe('windDown');
    expect(v(900_000, true, am).setWindDown).toBe(true);
  });

  it('"continue:" gets through', () => {
    expect(v(450_000, false, 'continue: write the note').action).toBe('notice');
    expect(v(600_000, true, '  Continue: note').action).toBe('windDown');
  });

  it('the limits can be overridden with environment variables; invalid gives the default', () => {
    expect(
      KV.limits({
        CONTEXT_WIND_DOWN: '300000',
        CONTEXT_STOP_ORCHESTRATOR: '500000',
        CONTEXT_STOP: 'x',
      }),
    ).toEqual({
      notice: 250_000,
      stop: 400_000,
      windDown: 300_000,
      stopOrchestrator: 500_000,
      compact: 280_000,
    });
    expect(KV.limits({ CONTEXT_COMPACT: '260000' })).toMatchObject({ compact: 260_000 });
    // No fixed limit on the number of compactions any more.
    expect(KV.limits({ CONTEXT_MAX_COMPACT: '0' })).not.toHaveProperty('maxCompact');
  });

  it('hookOutput: block only at stop; wind-down gives an instruction with the note path', () => {
    expect(
      KV.hookOutput({ action: 'none', setWindDown: false }, { n: 1, orchestrator: false }),
    ).toBeNull();
    const stop = KV.hookOutput(v(400_000, false), { n: 400_000, orchestrator: false, g });
    expect(stop).toMatchObject({ decision: 'block' });
    const by = KV.hookOutput(v(360_000, true), { n: 360_000, orchestrator: true, g, now: NOW });
    expect(by).not.toHaveProperty('decision');
    const ctx = (by as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(ctx).toContain(KV.HANDOVER_NOTE);
    expect(KV.HANDOVER_NOTE).toMatch(/\/handover-ongoing\.md$/);
    expect(ctx).toMatch(/start NO new tasks/);
  });
});

describe('COMPACT: /compact with focus before wind-down', () => {
  const limit = JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'x' });
  const v = (n: number, compactions: number, prompt = 'hello', inWindDown = false) =>
    KV.assess({ n, prompt, orchestrator: true, inWindDown, compactions, g });

  it('countCompactions counts only real compact_boundary rows', () => {
    expect(KV.countCompactions('')).toBe(0);
    const quote = JSON.stringify({
      type: 'user',
      message: { content: 'count "subtype":"compact_boundary" rows' },
    });
    const compactSpaced = '{"type": "system", "subtype": "compact_boundary"}';
    const text = [
      '{"type":"user"}',
      limit,
      quote,
      'broken {"subtype":"compact_boundary"',
      limit,
    ];
    expect(KV.countCompactions(text.join('\n'))).toBe(2);
    expect(KV.countCompactions(`${limit}\n${compactSpaced}\n`)).toBe(2);
  });

  it('orchestrator: compact from 280k after each compaction, wind-down only at 350k', () => {
    expect(v(279_999, 0).action).toBe('notice');
    expect(v(280_000, 0)).toEqual({ action: 'compact', setWindDown: false });
    expect(v(349_999, 1)).toEqual({ action: 'compact', setWindDown: false });
    // No fixed limit on the number of compactions: the cycle starts again each time.
    expect(v(280_000, 2)).toEqual({ action: 'compact', setWindDown: false });
    expect(v(300_000, 7)).toEqual({ action: 'compact', setWindDown: false });
    // The emergency brake: the owner has not compacted, so the wind-down comes at 350k regardless of count.
    expect(v(350_000, 1)).toEqual({ action: 'windDown', setWindDown: true });
    expect(v(350_000, 5)).toEqual({ action: 'windDown', setWindDown: true });
    expect(v(360_000, 3, 'hello', true)).toEqual({ action: 'windDown', setWindDown: false });
    expect(v(550_000, 0, 'hello', true)).toMatchObject({ action: 'stop', limit: 550_000 });
  });

  it('not orchestrator is unaffected by compactions', () => {
    const w = (n: number, k: number) =>
      KV.assess({ n, prompt: 'hello', orchestrator: false, compactions: k, g }).action;
    expect(w(300_000, 0)).toBe('notice');
    expect(w(300_000, 5)).toBe('notice');
    expect(w(400_000, 0)).toBe('stop');
  });

  it('system messages are never stopped, not even in the COMPACT step', () => {
    const tn = '<task-notification><task-id>a1</task-id>';
    const am = '<agent-message from="a1"> [Subagent hand-back]';
    expect(v(300_000, 0, tn).action).toBe('compact');
    expect(v(300_000, 2, am).action).toBe('compact');
    expect(v(900_000, 0, am).action).toBe('windDown');
    expect(v(900_000, 2, tn, true).action).toBe('windDown');
  });

  type HookOut = {
    systemMessage: string;
    reason?: string;
    hookSpecificOutput: { additionalContext: string };
  };
  const out = (n: number, compactions: number, mode: 'auto' | 'manual' = 'manual') =>
    KV.hookOutput(v(n, compactions), {
      n,
      orchestrator: true,
      g,
      now: NOW,
      compactions,
      mode,
    }) as HookOut;

  it('hookOutput for compact (manual): ready /compact line, the note, no rotation, no block', () => {
    const u = out(300_000, 1);
    expect(u).not.toHaveProperty('decision');
    expect(KV.COMPACT_COMMAND).toMatch(/^\/compact keep: /);
    expect(KV.COMPACT_COMMAND).toContain(KV.HANDOVER_NOTE);
    expect(u.systemMessage).toContain(KV.COMPACT_COMMAND);
    expect(u.systemMessage).toMatch(/compaction no\. 2/);
    expect(u.systemMessage).toMatch(/manual/);
    expect(u.systemMessage).not.toMatch(/rotate|new window/i);
    expect(u.systemMessage).not.toContain('—');
    const ctx = u.hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/finish/i);
    expect(ctx).toMatch(/cannot run \/compact yourself/);
    expect(ctx).toContain(KV.HANDOVER_NOTE);
    // After many compactions: the same message, never rotation.
    expect(out(300_000, 6).systemMessage).toContain(KV.COMPACT_COMMAND);
  });

  it('hookOutput for compact (auto): the compaction comes by itself, the line is a fallback', () => {
    const u = out(300_000, 0, 'auto');
    expect(u.systemMessage).toMatch(/automatic/i);
    expect(u.systemMessage).toContain(KV.COMPACT_COMMAND);
    expect(u.hookSpecificOutput.additionalContext).toContain(KV.HANDOVER_NOTE);
    expect(u.hookSpecificOutput.additionalContext).toMatch(/automatic/i);
  });

  it('hookOutput for wind-down: "compact now" with a ready line; a new session only as a last resort', () => {
    for (const k of [0, 2, 5]) {
      const u = out(360_000, k);
      expect(u.systemMessage).toContain(KV.COMPACT_COMMAND);
      expect(u.systemMessage).toMatch(/compact now/i);
      expect(u.systemMessage).toMatch(/last resort/);
      expect(u.systemMessage).not.toMatch(/Rotate the session/);
      expect(u.hookSpecificOutput.additionalContext).toMatch(/lifted/);
    }
    expect(out(360_000, 0, 'auto').systemMessage).toMatch(/automatic/i);
  });

  it('hookOutput for stop: the orchestrator is asked to compact, other sessions get a new session', () => {
    const orch = KV.hookOutput(v(560_000, 0), { n: 560_000, orchestrator: true, g }) as HookOut;
    expect(orch.reason).toContain(KV.COMPACT_COMMAND);
    expect(orch.reason).toMatch(/last resort/);
    const others = KV.hookOutput(KV.assess({ n: 410_000, prompt: 'hello', orchestrator: false, g }), {
      n: 410_000,
      orchestrator: false,
      g,
    }) as HookOut;
    expect(others.reason).toMatch(/new session/i);
    expect(others.reason).not.toContain('/compact keep');
  });

  it('compactMode: limits.autocompact in the queue file, default auto', () => {
    expect(KV.compactMode(null)).toBe('auto');
    expect(KV.compactMode({})).toBe('auto');
    expect(KV.compactMode({ limits: { autocompact: false } })).toBe('manual');
    expect(KV.compactMode({ limits: { autocompact: true } })).toBe('auto');
    expect(L.LIMIT_NAME).toContain('autocompact');
    expect(L.parseLimit('autocompact', 'on')).toEqual({ val: true });
    expect(L.parseLimit('autocompact', 'auto')).toEqual({ val: true });
    expect(L.parseLimit('autocompact', 'manual')).toEqual({ val: false });
    expect(L.parseLimit('autocompact', 'maybe')).toHaveProperty('error');
  });

  it('forCompactInstruction: focus for the summary (PreCompact), with the note', () => {
    const t = KV.forCompactInstruction();
    expect(t).toContain(KV.HANDOVER_NOTE);
    expect(t).toMatch(/active tracks/);
    expect(t).toMatch(/owner questions/);
  });

  it('afterCompactBound: only the session the cursor is bound to', () => {
    expect(KV.afterCompactBound({ cursor: cursor({ session_id: 's1' }), sessionId: 's1' })).toBe(true);
    expect(KV.afterCompactBound({ cursor: cursor({ session_id: 's1' }), sessionId: 's2' })).toBe(
      false,
    );
    expect(KV.afterCompactBound({ cursor: cursor(), sessionId: 's1' })).toBe(false);
    expect(KV.afterCompactBound({ cursor: null, sessionId: 's1' })).toBe(false);
    expect(KV.afterCompactBound({ cursor: cursor({ session_id: 's1' }), sessionId: null })).toBe(
      false,
    );
  });

  it('withoutWindDown: removes only the session\'s own wind-down', () => {
    const by = { from: iso(NOW), context: 360_000, session_id: 's1' };
    const m = cursor({ session_id: 's1', windDown: by });
    expect(KV.withoutWindDown(m, 's1')).toEqual({ cursor: cursor({ session_id: 's1' }), changed: true });
    expect(KV.withoutWindDown(m, 's2')).toEqual({ cursor: m, changed: false });
    expect(KV.withoutWindDown(cursor({ session_id: 's1' }), 's1').changed).toBe(false);
  });

  it('afterCompactText: queue state, open questions and unpushed commits, within the cap', () => {
    const t = KV.afterCompactText({
      show: 'ACTIVE (1):\n  X  running  queue/X',
      question: [{ sp: 'Q1', text: 'Should we?', recommendation: 'yes' }],
      unpushed: 4,
      base: 'main',
      compactions: 1,
      windDownRevoked: true,
      g,
    });
    expect(t).toMatch(/^\[hook-after-compact\]/);
    expect(t).toContain('ACTIVE (1):');
    expect(t).toContain('Q1: Should we? (recommendation: yes)');
    expect(t).toContain('Unpushed commits on main: 4');
    expect(t).toMatch(/compaction no\. 1/);
    expect(t).toMatch(/wind-down.*revoked/i);
    expect(t).toMatch(/manual/);
    // The resume instruction: the note, pulse, receive, fill, without waiting for the owner.
    expect(t).toMatch(/RESUME/);
    expect(t).toContain(KV.HANDOVER_NOTE);
    expect(t).toContain('cq orchestrator pulse');
    expect(t).toContain('cq receive');
    expect(t).toContain('cq fill');
    expect(t).toMatch(/without waiting for the owner/);
    const lang = KV.afterCompactText({
      show: 'x'.repeat(50_000),
      question: [],
      unpushed: null,
      compactions: 5,
      mode: 'auto',
      g,
    });
    expect(lang.length).toBeLessThanOrEqual(12_000);
    expect(lang).toContain('Unpushed commits on baseBranch: unknown');
    // No fixed limit: not even after 5 compactions is rotation the next step.
    expect(lang).not.toMatch(/rotate|new window/i);
    expect(lang).toMatch(/automatic/i);
    expect(lang).toMatch(/RESUME/);
    expect(lang).toContain('No open owner questions');
  });
});

describe('orchestratorBinding: who is the orchestrator', () => {
  it('no cursor, expired cursor or no session_id: not the orchestrator', () => {
    expect(
      KV.orchestratorBinding({ cursor: null, sessionId: 's1', lastCall: NOW, now: NOW })
        .orchestrator,
    ).toBe(false);
    const expired = cursor({ updated: iso(NOW - 3 * 60 * MIN) });
    expect(
      KV.orchestratorBinding({ cursor: expired, sessionId: 's1', lastCall: NOW, now: NOW })
        .orchestrator,
    ).toBe(false);
    expect(
      KV.orchestratorBinding({ cursor: cursor(), sessionId: null, lastCall: NOW, now: NOW })
        .orchestrator,
    ).toBe(false);
  });

  it('a session without orchestrator calls does not become the orchestrator', () => {
    const r = KV.orchestratorBinding({
      cursor: cursor(),
      sessionId: 's1',
      lastCall: null,
      now: NOW,
    });
    expect(r).toMatchObject({ orchestrator: false, changed: false });
  });

  it('the first session with a fresh call binds the cursor', () => {
    const r = KV.orchestratorBinding({
      cursor: cursor(),
      sessionId: 's1',
      lastCall: NOW - MIN,
      now: NOW,
    });
    expect(r).toMatchObject({ orchestrator: true, changed: true });
    expect(r.cursor).toMatchObject({ session_id: 's1', session_id_time: NOW - MIN });
  });

  it('the bound session stays orchestrator; an older session with an older call does not take it', () => {
    const m = cursor({ session_id: 's2', session_id_time: NOW - 2 * MIN });
    expect(
      KV.orchestratorBinding({ cursor: m, sessionId: 's2', lastCall: null, now: NOW }).orchestrator,
    ).toBe(true);
    expect(
      KV.orchestratorBinding({ cursor: m, sessionId: 's1', lastCall: NOW - 30 * MIN, now: NOW })
        .orchestrator,
    ).toBe(false);
  });

  it('a new session with a newer call takes over and resets the previous session\'s wind-down', () => {
    const m = KV.withWindDown(cursor({ session_id: 's1', session_id_time: NOW - 30 * MIN }), {
      sessionId: 's1',
      n: 360_000,
      now: NOW - 20 * MIN,
    });
    expect(L.windDownGuard(m, NOW).stop).toBe(true);
    const r = KV.orchestratorBinding({ cursor: m, sessionId: 's2', lastCall: NOW - MIN, now: NOW });
    expect(r).toMatchObject({ orchestrator: true, changed: true });
    expect(r.cursor?.session_id).toBe('s2');
    expect(r.cursor?.windDown).toBeUndefined();
    expect(L.windDownGuard(r.cursor, NOW).stop).toBe(false);
    expect(KV.inWindDown(m, 's1')).toBe(true);
    expect(KV.inWindDown(m, 's2')).toBe(false);
  });

  it('lastOrchestratorCall: finds the last pulse/start/fill in the transcript, not set or cloud start', () => {
    const line = (ts: string, cmd: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] },
      });
    const t = [
      'cut {"type":"assist',
      line('2026-10-07T10:00:00Z', 'node scripts/orchestrator/queue.mjs orchestrator pulse --session "x"'),
      line('2026-10-07T10:05:00Z', 'node scripts/orchestrator/queue.mjs fill --scratchpad s'),
      line('2026-10-07T10:10:00Z', 'node scripts/orchestrator/queue.mjs set A done'),
      line('2026-10-07T10:11:00Z', 'node scripts/orchestrator/queue.mjs cloud start B'),
    ].join('\n');
    expect(KV.lastOrchestratorCall(t)).toBe(Date.parse('2026-10-07T10:05:00Z'));
    expect(KV.lastOrchestratorCall(line('2026-10-07T10:00:00Z', 'queue.mjs show'))).toBeNull();
  });

  it('recognises the cq forms too (plugin `cq fill`, `cq queue fill`, vendored `node .../cq.mjs fill`)', () => {
    const at = '2026-10-07T10:05:00Z';
    const line = (ts: string, cmd: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] },
      });
    for (const cmd of [
      'cq fill --scratchpad s',
      'cd x && cq queue orchestrator pulse',
      'node scripts/orchestrator/cq.mjs start A',
    ])
      expect(KV.lastOrchestratorCall(line(at, cmd)), cmd).toBe(Date.parse(at));
    for (const cmd of ['cq show', 'cq cloud start B', 'echo acq fill'])
      expect(KV.lastOrchestratorCall(line(at, cmd)), cmd).toBeNull();
  });
});

describe('queueLogic: wind-down guard and cursor', () => {
  const queue = {
    tasks: [
      { id: 'A', title: 'A', domain: 'client', class: 'K', status: 'waiting', mission: 'x' },
    ],
  };
  const inWindDown = KV.withWindDown(cursor({ session_id: 's1' }), { sessionId: 's1', n: 360_000, now: NOW });

  it('start/next refuse with exit 6 during wind-down; --force overrides; an expired cursor does not count', () => {
    expect(L.startGuard(queue, 0, { now: NOW, cursor: inWindDown })).toMatchObject({
      code: 6,
      stop: 'windDown',
    });
    expect(L.startGuard(queue, 0, { now: NOW, cursor: inWindDown, force: true })).toBeNull();
    expect(L.startGuard(queue, 0, { now: NOW + 3 * 60 * MIN, cursor: inWindDown })).toBeNull();
    expect(L.startGuard(queue, 0, { now: NOW, cursor: cursor() })).toBeNull();
    const t = L.state(queue, 0, { now: NOW, cursor: inWindDown });
    expect(t).toMatchObject({ canStart: 0, stop: 'windDown' });
  });

  it('newCursor: the same session keeps binding and wind-down; a new name (new session) resets', () => {
    const now = iso(NOW + MIN);
    const same = L.newCursor(inWindDown, { event: 'set A done', now });
    expect(same.windDown).toEqual(inWindDown.windDown);
    expect(same.session_id).toBe('s1');
    const fresh = L.newCursor(inWindDown, { session: 'queue B', event: 'pulse', now });
    expect(fresh.windDown).toBeUndefined();
    expect(fresh.session_id).toBeUndefined();
    expect(fresh.session_id_time).toBe(NOW + MIN);
    // After the takeover the old session cannot bind itself with an older call.
    expect(
      KV.orchestratorBinding({
        cursor: fresh,
        sessionId: 's1',
        lastCall: NOW - MIN,
        now: NOW + 2 * MIN,
      }).orchestrator,
    ).toBe(false);
  });
});

// ---- Processes: the hook and queue.mjs against a temporary queue (never the real one) ----
describe('hook-context.mjs and queue.mjs: the wind-down step end to end', () => {
  const ORCHESTRATOR = join(__dirname, '..', '..');
  let folder: string;

  const env = () => ({
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_GIT: folder,
    QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
    CONTEXT_WARNING: '',
    CONTEXT_STOP: '',
    CONTEXT_WIND_DOWN: '',
    CONTEXT_STOP_ORCHESTRATOR: '',
    CONTEXT_COMPACT: '',
    COST_GUARD_BY: '1',
  });
  function run(file: string, args: string[], input?: string) {
    try {
      const out = execFileSync(process.execPath, [join(ORCHESTRATOR, file), ...args], {
        env: env(),
        encoding: 'utf8',
        input,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: String(x.stdout ?? ''), error: String(x.stderr ?? '') };
    }
  }
  /** Transcript: an orchestrator call now and a usage count of `n` tokens. */
  function transcript(n: number, withCall = true, compactions = 0) {
    const now = new Date().toISOString();
    const lines = [
      ...Array.from({ length: compactions }, () =>
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: now }),
      ),
      withCall
        ? JSON.stringify({
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
          })
        : '{}',
      JSON.stringify({
        type: 'assistant',
        timestamp: now,
        message: {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, cache_read_input_tokens: n - 1 },
        },
      }),
    ];
    const filePath = join(folder, `t-${n}-${withCall}-${compactions}.jsonl`);
    writeFileSync(filePath, lines.join('\n') + '\n');
    return filePath;
  }
  const hook = (
    sessionId: string,
    n: number,
    prompt: string,
    withCall = true,
    compactions = 0,
  ) => {
    const r = run(
      'hook-context.mjs',
      [],
      JSON.stringify({
        session_id: sessionId,
        transcript_path: transcript(n, withCall, compactions),
        prompt,
      }),
    );
    return r.out ? JSON.parse(r.out) : null;
  };
  const readCursor = (): Cursor => JSON.parse(readFileSync(join(folder, 'orchestrator.json'), 'utf8'));

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-wind-down-'));
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        tasks: [
          { id: 'A', title: 'A', domain: 'client', class: 'K', status: 'waiting', mission: 'x' },
        ],
        limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 5 },
        next_migr: 100,
      }),
    );
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('not orchestrator is stopped at 400k; task-notification gets through', () => {
    expect(hook('s9', 410_000, 'hello', false)).toMatchObject({ decision: 'block' });
    expect(
      hook('s9', 410_000, '<task-notification><task-id>x</task-id>', false),
    ).not.toHaveProperty('decision');
    expect(existsSync(join(folder, 'orchestrator.json'))).toBe(false);
  });

  it('orchestrator: 360k sets wind-down, start/next/fill refuse (exit 6), a new session resets', () => {
    expect(run('queue.mjs', ['orchestrator', 'pulse', '--session', 'queue A']).code).toBe(0);
    // Below the limit: no output, but the cursor is bound to the session.
    expect(hook('s1', 100_000, 'hello')).toBeNull();
    expect(readCursor().session_id).toBe('s1');
    const out = hook('s1', 360_000, 'hello');
    expect(out).not.toHaveProperty('decision');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/WIND_DOWN/);
    expect(readCursor().windDown).toMatchObject({ session_id: 's1', context: 360_000 });
    // 450k: the orchestrator is not stopped before 550k.
    expect(hook('s1', 450_000, 'hello')).not.toHaveProperty('decision');
    expect(hook('s1', 560_000, 'hello')).toMatchObject({ decision: 'block' });

    const next = run('queue.mjs', ['next']);
    expect(next.code).toBe(6);
    expect(next.error).toMatch(/WIND_DOWN/);
    expect(run('queue.mjs', ['start', 'A']).code).toBe(6);
    expect(run('queue.mjs', ['fill', '--scratchpad', join(folder, 's')]).code).toBe(6);
    // set is not affected, and the same session keeps the wind-down (pulse without a new name).
    expect(run('queue.mjs', ['orchestrator', 'pulse']).code).toBe(0);
    expect(readCursor().windDown).toBeDefined();

    // A new session takes the cursor with a new name: the wind-down is gone, and start works.
    expect(run('queue.mjs', ['orchestrator', 'pulse', '--session', 'queue B']).code).toBe(0);
    expect(readCursor().windDown).toBeUndefined();
    expect(run('queue.mjs', ['next']).code).toBe(0);
  });

  it('COMPACT: 300k gives a /compact suggestion without wind-down, also after many compactions', () => {
    expect(run('queue.mjs', ['orchestrator', 'pulse', '--session', 'queue A']).code).toBe(0);
    const out = hook('s1', 300_000, 'hello');
    expect(out).not.toHaveProperty('decision');
    expect(out.systemMessage).toContain('/compact keep:');
    expect(readCursor().windDown).toBeUndefined();
    expect(run('queue.mjs', ['next']).code).toBe(0);
    // Not orchestrator at 300k: only a notice, never a compact suggestion.
    expect(hook('s9', 300_000, 'hello', false).systemMessage).not.toContain('/compact');
    // The same session after three compactions: still only a compact suggestion, no wind-down.
    const left = hook('s1', 300_000, 'hello', true, 3);
    expect(left.systemMessage).toContain('/compact keep:');
    expect(left.hookSpecificOutput.additionalContext).not.toMatch(/WIND_DOWN/);
    expect(readCursor().windDown).toBeUndefined();
    expect(run('queue.mjs', ['next']).code).toBe(0);
  });

  it('queue.mjs compact auto|manual: the mode is saved in the queue file and shown in the hook message', () => {
    expect(run('queue.mjs', ['orchestrator', 'pulse', '--session', 'queue A']).code).toBe(0);
    const show = run('queue.mjs', ['compact']);
    expect(show.code).toBe(0);
    expect(show.out).toMatch(/auto/);
    const auto = run('queue.mjs', ['compact', 'auto']);
    expect(auto.code).toBe(0);
    expect(auto.out).toContain('autoCompactEnabled=true');
    const readQueue = () => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));
    expect(readQueue().limits.autocompact).toBe(true);
    expect(hook('s1', 300_000, 'hello').systemMessage).toMatch(/automatic/i);
    expect(run('queue.mjs', ['compact', 'manual']).code).toBe(0);
    expect(readQueue().limits.autocompact).toBe(false);
    expect(hook('s1', 300_000, 'hello').systemMessage).toMatch(/manual/);
    expect(run('queue.mjs', ['compact', 'maybe']).code).toBe(1);
  });

  it('hook-after-compact: queue state only for the bound session, lifts the wind-down', () => {
    const after = (sessionId: string, source = 'compact', compactions = 1) => {
      const r = run(
        'hook-after-compact.mjs',
        [],
        JSON.stringify({
          session_id: sessionId,
          source,
          transcript_path: transcript(120_000, true, compactions),
        }),
      );
      expect(r.code).toBe(0);
      return r.out ? JSON.parse(r.out) : null;
    };
    expect(after('s1')).toBeNull(); // no cursor
    expect(run('queue.mjs', ['orchestrator', 'pulse', '--session', 'queue A']).code).toBe(0);
    hook('s1', 360_000, 'hello');
    expect(readCursor().windDown).toBeDefined();
    expect(after('s2')).toBeNull(); // another session
    expect(after('s1', 'startup')).toBeNull(); // not a compaction
    const out = after('s1');
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^\[hook-after-compact\]/);
    expect(ctx).toContain('ACTIVE');
    expect(ctx).toMatch(/Unpushed commits on \S+: unknown/);
    expect(ctx).toMatch(/RESUME/);
    expect(ctx.length).toBeLessThanOrEqual(12_000);
    expect(readCursor().windDown).toBeUndefined();
    expect(run('queue.mjs', ['next']).code).toBe(0);
  });

  it('hook-after-compact as PreCompact: focus on stdout only for the bound session', () => {
    const forCompact = (sessionId: string) =>
      run(
        'hook-after-compact.mjs',
        [],
        JSON.stringify({ session_id: sessionId, hook_event_name: 'PreCompact', trigger: 'auto' }),
      );
    expect(forCompact('s1').out).toBe('');
    expect(run('queue.mjs', ['orchestrator', 'pulse', '--session', 'queue A']).code).toBe(0);
    hook('s1', 100_000, 'hello');
    const r = forCompact('s1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('handover-ongoing.md');
    expect(forCompact('s2').out).toBe('');
  });

  it('orchestrator stop removes the cursor and with it the wind-down', () => {
    expect(run('queue.mjs', ['orchestrator', 'pulse', '--session', 'queue A']).code).toBe(0);
    hook('s1', 360_000, 'hello');
    expect(run('queue.mjs', ['start', 'A']).code).toBe(6);
    expect(run('queue.mjs', ['orchestrator', 'stop']).code).toBe(0);
    expect(run('queue.mjs', ['start', 'A']).code).toBe(0);
  });
});
