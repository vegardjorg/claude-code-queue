// =============================================================
// queueTaskEdit.test.ts: cancel, decline and edit ONE task from the board, with "Undo".
//
// Why: the board could approve a proposal but not decline it, and could not cancel or edit a waiting task, although
// README promised it. The rules live in lib/queueTaskEdit.js (only waiting and proposed tasks; decline only a proposal;
// the edit checked with queueLogic.validate, as add/edit), the write is `queue.mjs cancel` / `queue.mjs edit`, and
// undo of a logged cancel is allowed by queueLogic.undoEntry. All three places are tested: the pure functions,
// queue.mjs against a temporary queue, and the board server (POST /api/task-edit and /api/undo) against the same
// temporary queue (never the real queue or the main repo).
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TE = require('../queueTaskEdit.js') as {
  cancelError: (o: Task | undefined) => string | null;
  cancelTask: (o: Task, option?: { remark?: string | null; now?: string }) => { error: string | null };
  cancelRemark: (reason: unknown, option?: { declined?: boolean }) => string;
  cliCancelHint: (o: Task) => string | null;
  editFields: (form: unknown) => { error: string[]; field: Record<string, unknown> };
  editPlan: (queue: unknown, id: string, form: unknown) => { error: string[]; field?: Record<string, unknown> };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic.js') as {
  undoEntry: (queue: unknown, option?: unknown) => { error: string[]; entry?: { action: string } };
};

const task = (id: string, status: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 90,
  mission: `scripts/.queue/mission/${id}.md`,
  status,
  depends_on: [],
  waiting_on: [],
  owned_files: [],
  owner_db: [],
  shared_patch: [],
  ...extra,
});

describe('the rules (pure)', () => {
  it('cancel is allowed for waiting (also on hold) and proposed, refused for running, picked, review and done', () => {
    expect(TE.cancelError(task('A', 'waiting'))).toBeNull();
    expect(TE.cancelError(task('A', 'waiting', { parked: { by: 'x', at: '2026-10-01T00:00:00Z' } }))).toBeNull();
    expect(TE.cancelError(task('A', 'proposed'))).toBeNull();
    for (const s of ['running', 'picked', 'review', 'done', 'cancelled'])
      expect(TE.cancelError(task('A', s))).toMatch(/only waiting and proposed/);
    expect(TE.cancelError(undefined)).toBe('unknown task');
  });

  it('cancelTask sets cancelled and the remark in the same form as set --remark', () => {
    const o = task('A', 'proposed');
    expect(TE.cancelTask(o, { remark: 'declined: duplicate', now: '2026-10-31T10:00:00.000Z' })).toEqual({ error: null });
    expect(o.status).toBe('cancelled');
    expect(o.remarks).toEqual(['2026-10-31T10:00:00.000Z declined: duplicate']);
  });

  it('the remark: "declined: <reason>", "cancelled", and control characters are removed', () => {
    expect(TE.cancelRemark('  not needed ', { declined: true })).toBe('declined: not needed');
    expect(TE.cancelRemark('', { declined: true })).toBe('declined');
    expect(TE.cancelRemark(undefined)).toBe('cancelled');
    expect(TE.cancelRemark('a\nb')).toBe('cancelled: a b');
  });

  it('the CLI hint is for running, picked and review only', () => {
    expect(TE.cliCancelHint(task('A', 'running'))).toContain('cq set A cancelled --remark');
    expect(TE.cliCancelHint(task('A', 'review'))).toContain('cq set A cancelled');
    expect(TE.cliCancelHint(task('A', 'waiting'))).toBeNull();
  });

  it('editFields: value 1-10, content minutes 1-1000, class K/D/D+/U; empty fields are left as they are', () => {
    expect(TE.editFields({ value: '8', content_min: '45', class: 'D+' })).toEqual({
      error: [],
      field: { value: 8, content_min: 45, class: 'D+' },
    });
    expect(TE.editFields({ value: '', content_min: null })).toEqual({ error: [], field: {} });
    expect(TE.editFields({ value: '11' }).error).toEqual(['value must be a whole number 1-10']);
    expect(TE.editFields({ value: '2.5' }).error).toHaveLength(1);
    expect(TE.editFields({ content_min: '0' }).error[0]).toMatch(/content minutes/);
    expect(TE.editFields({ class: 'X' }).error[0]).toMatch(/class must be one of K, D, D\+, U/);
    expect(TE.editFields({ status: 'done' }).error[0]).toMatch(/unknown field status/);
  });

  it('editPlan: only waiting and proposed, only the fields that change, and queueLogic.validate on the result', () => {
    const queue = { tasks: [task('A', 'waiting'), task('R', 'running'), task('B', 'proposed', { title: '' })], projects: {} };
    expect(TE.editPlan(queue, 'A', { value: '7', content_min: '90', class: 'K' })).toEqual({ error: [], field: { value: 7 } });
    expect(TE.editPlan(queue, 'A', { value: '5' }).error).toEqual(['nothing changed']);
    expect(TE.editPlan(queue, 'R', { value: '7' }).error[0]).toMatch(/only waiting and proposed/);
    expect(TE.editPlan(queue, 'X', { value: '7' }).error[0]).toMatch(/unknown task X/);
    // The same check as add/edit: a task without a title is refused.
    expect(TE.editPlan(queue, 'B', { value: '7' }).error).toContain('title missing');
  });

  it('undo rolls back a logged cancel of a waiting/proposed task, but still not other status changes', () => {
    const entry = (action: string, before: string) => ({
      nr: 1,
      at: '2026-10-31T10:00:00.000Z',
      by: 'theBoard',
      action,
      changes: [{ id: 'A', field: 'status', before, after: 'cancelled' }],
    });
    const q1 = { tasks: [task('A', 'cancelled')], projects: {}, changelog: [entry('cancel', 'proposed')] };
    expect(L.undoEntry(q1).error).toEqual([]);
    expect(q1.tasks[0].status).toBe('proposed');
    const q2 = { tasks: [task('A', 'cancelled')], projects: {}, changelog: [entry('edit', 'waiting')] };
    expect(L.undoEntry(q2).error[0]).toMatch(/status cannot be undone/);
    const q3 = { tasks: [task('A', 'cancelled')], projects: {}, changelog: [entry('cancel', 'running')] };
    expect(L.undoEntry(q3).error[0]).toMatch(/status cannot be undone/);
  });
});

// ---- queue.mjs and the board server against a temporary queue ----
let root = '';
let folder = '';
let env: NodeJS.ProcessEnv = {};
// Async on purpose (spawnSync blocks the test worker; see helperCustom.test.ts).
const cq = (...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'queue.mjs'), ...args], { cwd: root, env });
    let stdout = '';
    let stderr = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    p.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    p.on('error', reject);
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const queueFile = () => path.join(folder, 'queue.json');
const readQueue = () => JSON.parse(fs.readFileSync(queueFile(), 'utf8'));
const find = (id: string) => (readQueue().tasks as Task[]).find((o) => o.id === id)!;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-task-edit-'));
  folder = path.join(root, 'q');
  fs.mkdirSync(folder);
  env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: path.join(root, 'no-config.json'),
    QUEUE_TIME_LOG: path.join(root, 'times.jsonl'),
    QUEUE_GIT: root,
    DISABLE_UPDATES: '1',
  };
  expect((await cq('init')).status).toBe(0);
  const q = readQueue();
  q.tasks = [
    task('W-1', 'waiting'),
    task('W-2', 'waiting'),
    task('W-3', 'waiting'),
    task('P-1', 'proposed', { added_by: 'X-9' }),
    task('P-2', 'proposed', { added_by: 'X-9' }),
    task('R-1', 'running', { branch: 'queue/R-1', started: '2026-10-31T08:00:00.000Z' }),
    task('V-1', 'review', { branch: 'queue/V-1', started: '2026-10-31T08:00:00.000Z' }),
  ];
  fs.writeFileSync(queueFile(), JSON.stringify(q, null, 2));
}, 30_000);
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('queue.mjs cancel and edit --answer-json', () => {
  it('cancel sets a waiting task cancelled with the remark, logged; undo puts it back', async () => {
    const r = await cq('cancel', 'W-3', '--remark', 'cancelled: not needed', '--by', 'test', '--json');
    expect(r.status, r.stderr).toBe(0);
    const answer = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(answer).toMatchObject({ ok: true, id: 'W-3' });
    expect(find('W-3').status).toBe('cancelled');
    expect(String((find('W-3').remarks as string[])[0])).toMatch(/ cancelled: not needed$/);
    const entry = readQueue().changelog.find((p: { nr: number }) => p.nr === answer.log);
    expect(entry).toMatchObject({ action: 'cancel', by: 'test' });
    const u = await cq('undo', '--nr', String(answer.log), '--json');
    expect(u.status, u.stdout + u.stderr).toBe(0);
    expect(find('W-3').status).toBe('waiting');
    expect(find('W-3').remarks ?? null).toBeNull();
  }, 30_000);

  it('cancel refuses a running task and leaves it as it is', async () => {
    const r = await cq('cancel', 'R-1', '--json');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout.trim()).error[0]).toMatch(/only waiting and proposed/);
    expect(find('R-1').status).toBe('running');
  }, 30_000);

  it('edit --answer-json gives the changelog no.', async () => {
    const r = await cq('edit', 'W-3', '--json', '{"value":9}', '--by', 'test', '--answer-json');
    expect(r.status, r.stderr).toBe(0);
    const answer = JSON.parse(r.stdout.trim());
    expect(answer).toMatchObject({ ok: true, id: 'W-3', changed: ['value'] });
    expect(typeof answer.log).toBe('number');
    expect(find('W-3').value).toBe(9);
  }, 30_000);
});

describe('the board server: POST /api/task-edit', () => {
  let board: ChildProcess | null = null;
  let base = '';
  let key = '';
  beforeAll(async () => {
    const port = await new Promise<number>((done) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => done(p));
      });
    });
    board = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'queue-board.mjs'), '--port', String(port)], {
      cwd: root,
      env,
    });
    await new Promise<void>((done, fail) => {
      let out = '';
      let err = '';
      board!.stderr!.on('data', (d) => (err += String(d)));
      const t = setTimeout(() => fail(new Error(`no start line: ${out} ${err}`)), 20_000);
      board!.stdout!.on('data', (d) => {
        out += String(d);
        const m = /Open: (http:\/\/[^/\s]+)\/#key=(\S+)/.exec(out);
        if (m) {
          clearTimeout(t);
          base = m[1];
          key = m[2];
          done();
        }
      });
    });
  }, 30_000);
  afterAll(async () => {
    // Wait for the process to end: Windows will not delete the folder it runs in before that.
    if (board && board.exitCode == null) {
      const gone = new Promise((done) => board!.once('exit', done));
      board.kill();
      await gone;
    }
  });

  const post = async (p: string, body: object) => {
    const r = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-queue-key': key },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as { ok: boolean; message?: string; log?: number } };
  };

  it('decline: a proposal becomes cancelled with "declined: <reason>"; Undo (nr) makes it proposed again', async () => {
    const r = await post('/api/task-edit', { type: 'decline', id: 'P-1', reason: 'duplicate of W-1' });
    expect(r.status, r.body.message).toBe(200);
    expect(typeof r.body.log).toBe('number');
    expect(find('P-1').status).toBe('cancelled');
    expect(String((find('P-1').remarks as string[]).at(-1))).toMatch(/ declined: duplicate of W-1$/);
    const u = await post('/api/undo', { nr: r.body.log });
    expect(u.status, u.body.message).toBe(200);
    expect(find('P-1').status).toBe('proposed');
  }, 30_000);

  it('decline is only for proposals; cancel refuses running and review (the agent may be working)', async () => {
    const d = await post('/api/task-edit', { type: 'decline', id: 'W-1' });
    expect(d.status).toBe(400);
    expect(d.body.message).toMatch(/not a proposal/);
    for (const id of ['R-1', 'V-1']) {
      const c = await post('/api/task-edit', { type: 'cancel', id });
      expect(c.status).toBe(400);
      expect(c.body.message).toMatch(/only waiting and proposed/);
    }
    expect(find('R-1').status).toBe('running');
    expect(find('V-1').status).toBe('review');
    expect((await post('/api/task-edit', { type: 'cancel', id: 'NOPE' })).status).toBe(400);
    expect((await post('/api/task-edit', { type: 'drop', id: 'W-1' })).status).toBe(400);
  }, 30_000);

  it('cancel: a waiting task on hold is cancelled, and Undo puts it back with the hold', async () => {
    const q = readQueue();
    q.tasks.find((o: Task) => o.id === 'W-2').parked = { by: 'test', at: '2026-10-30T10:00:00.000Z' };
    fs.writeFileSync(queueFile(), JSON.stringify(q, null, 2));
    const r = await post('/api/task-edit', { type: 'cancel', id: 'W-2' });
    expect(r.status, r.body.message).toBe(200);
    expect(find('W-2').status).toBe('cancelled');
    expect(String((find('W-2').remarks as string[]).at(-1))).toMatch(/ cancelled$/);
    expect((await post('/api/undo', { nr: r.body.log })).status).toBe(200);
    expect(find('W-2')).toMatchObject({ status: 'waiting', parked: { by: 'test' } });
  }, 30_000);

  it('edit: validated (value, content minutes, class, status), saved with a log no., and Undo rolls it back', async () => {
    const bad = await post('/api/task-edit', { type: 'edit', id: 'W-1', form: { value: '12', class: 'Z' } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/value must be a whole number 1-10/);
    expect(bad.body.message).toMatch(/class must be one of/);
    const running = await post('/api/task-edit', { type: 'edit', id: 'R-1', form: { value: '7' } });
    expect(running.status).toBe(400);
    expect(running.body.message).toMatch(/only waiting and proposed/);
    const ok = await post('/api/task-edit', {
      type: 'edit',
      id: 'P-2',
      form: { value: '8', content_min: '40', class: 'D' },
    });
    expect(ok.status, ok.body.message).toBe(200);
    expect(find('P-2')).toMatchObject({ value: 8, content_min: 40, class: 'D', status: 'proposed' });
    expect((await post('/api/undo', { nr: ok.body.log })).status).toBe(200);
    expect(find('P-2')).toMatchObject({ value: 5, content_min: 90, class: 'K' });
  }, 30_000);
});
