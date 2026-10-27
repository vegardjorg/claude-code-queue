// =============================================================
// queueAnswer.test.ts: an owner answer cannot get lost in the work queue.
//
// A task could stay blocked even after the owner had answered: `waiting_on` held free text instead of a registered
// question id. Three measures, proven where they are enforced (the pure functions in queueLogic.js and queue.mjs against a
// copy of the queue in a temporary folder, never the real one):
//   1. add and edit reject a new waiting_on id that is not registered (free text and unregistered), all or nothing;
//      registering it in the same add ({ tasks, question }) is accepted.
//   2. Loose waits (free text, unregistered, answered but blocks) are reported by fill, show and state.
//   3. resolve --answer puts "OWNER_ANSWER <id> (<date>): <answer>" in the mission of every waiting task, once.
// Red first: without these rules waitingOnError/resolveWaits/ownerAnswerBonus do not exist, and add with free text exits 0.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Bonus = { time: string; text: string };
type Task = {
  id: string;
  title?: string;
  domain?: string;
  class?: string;
  status: string;
  mission?: string;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  owner_db?: string[];
  shared_patch?: string[];
  bonus?: Bonus[];
  remarks?: string[];
  added_at?: string;
  added_by?: string;
};
type Queue = {
  tasks: Task[];
  resolved?: string[];
  question?: Record<string, { type: string; text: string; added_at?: string }>;
  resolutions?: Record<string, { time: string; answer: string | null; by: string | null }>;
  limits?: Record<string, unknown>;
  next_migr?: number;
};
type Loose = { id: string; status: string; sp: string; reason: string };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  QUESTION_ID_PATTERN: RegExp;
  waitingOnError: (o: Task, queue: Queue, option?: { earlier?: string[] }) => string[];
  resolveWaits: (queue: Queue) => Loose[];
  resolveWaitsLines: (list: Loose[], option?: { max?: number }) => string[];
  ownerAnswerBonus: (
    queue: Queue,
    ids: string[],
    answer: string | null,
    now?: string,
  ) => { id: string; sp: string }[];
  setQuestion: (queue: Queue, input: unknown, now?: string) => { set: string[]; error: string[] };
  trackBlock: (o: Task, queue: Queue) => string;
};

const T1 = '2026-10-10T10:00:00.000Z';
const T2 = '2026-10-11T08:00:00.000Z';
const FREE_TEXT = 'owner: (a) tear down deactivate_user and build new';

function up(id: string, field: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    domain: 'client',
    class: 'K',
    status: 'waiting',
    mission: `Do ${id}.`,
    depends_on: [],
    waiting_on: [],
    owned_files: [],
    owner_db: [],
    shared_patch: [],
    added_at: T1,
    ...field,
  };
}

const registered = (): Queue['question'] => ({
  'SP-M8d': { type: 'question', text: 'Do we tear down deactivate_user?', added_at: T1 },
});

describe('waitingOnError (the block in add and edit)', () => {
  it('a free-text id is rejected, even when registered with text (the pattern is strict)', () => {
    const queue: Queue = { tasks: [], question: registered() };
    const f = L.waitingOnError(up('X', { waiting_on: [FREE_TEXT] }), queue);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/is not a question id/);
    expect(L.QUESTION_ID_PATTERN.test('SP-M8d')).toBe(true);
    expect(L.QUESTION_ID_PATTERN.test('a'.repeat(41))).toBe(false);
    expect(L.QUESTION_ID_PATTERN.test('Q 9')).toBe(false);
  });

  it('an unregistered id is rejected; a registered id (text and type) is accepted', () => {
    const queue: Queue = { tasks: [], question: registered() };
    expect(L.waitingOnError(up('X', { waiting_on: ['SP-UNKNOWN'] }), queue)[0]).toMatch(
      /SP-UNKNOWN is not registered/,
    );
    expect(L.waitingOnError(up('X', { waiting_on: ['SP-M8d'] }), queue)).toEqual([]);
  });

  it('waits that were already there (edit) are not rejected; new ones are', () => {
    const queue: Queue = { tasks: [], question: registered() };
    const o = up('X', { waiting_on: ['OLD', 'NEW'] });
    const f = L.waitingOnError(o, queue, { earlier: ['OLD'] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/NEW is not registered/);
  });

  it('setQuestion: a new question with a free-text id is rejected', () => {
    const queue: Queue = { tasks: [] };
    expect(L.setQuestion(queue, { [FREE_TEXT]: { text: 'x' } }).error[0]).toMatch(/invalid id/);
    expect(queue.question).toBeUndefined();
  });
});

describe('resolveWaits (check at fill, show and state)', () => {
  it('free text, unregistered and answered-but-blocks; resolved without text and finished tasks are left out', () => {
    const queue: Queue = {
      tasks: [
        up('A', { waiting_on: [FREE_TEXT] }),
        up('B', { status: 'proposed', waiting_on: ['SP-UNREGISTERED'] }),
        up('C', { waiting_on: ['SP-BLACK'] }),
        up('D', { waiting_on: ['SP-M8d', 'SP-RESOLVED'] }),
        up('E', { status: 'done', waiting_on: [FREE_TEXT] }),
      ],
      question: registered(),
      resolved: ['SP-RESOLVED'],
      resolutions: { 'SP-BLACK': { time: T1, answer: 'Yes', by: 'owner' } },
    };
    expect(L.resolveWaits(queue)).toEqual([
      { id: 'A', status: 'waiting', sp: FREE_TEXT, reason: 'freeText' },
      { id: 'B', status: 'proposed', sp: 'SP-UNREGISTERED', reason: 'unregistered' },
      { id: 'C', status: 'waiting', sp: 'SP-BLACK', reason: 'resolved-blocks' },
    ]);
    const lines = L.resolveWaitsLines(L.resolveWaits(queue), { max: 2 });
    expect(lines[0]).toMatch(/^NOTICE: 3 loose wait\(s\) in 3 task\(s\)/);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatch(/\+1 more/);
    expect(L.resolveWaitsLines([])).toEqual([]);
  });
});

describe('ownerAnswerBonus (the answer goes into the mission)', () => {
  it('adds the addendum to every waiting task, once; a new answer gives a new line; done is skipped', () => {
    const queue: Queue = {
      tasks: [
        up('A', { waiting_on: ['SP-M8d'] }),
        up('B', { status: 'proposed', waiting_on: ['SP-M8d', 'OTHER'] }),
        up('C', { status: 'done', waiting_on: ['SP-M8d'] }),
        up('D'),
      ],
    };
    expect(L.ownerAnswerBonus(queue, ['SP-M8d'], ' (a) tear down ', T1)).toEqual([
      { id: 'A', sp: 'SP-M8d' },
      { id: 'B', sp: 'SP-M8d' },
    ]);
    expect(queue.tasks[0].bonus).toEqual([
      { time: T1, text: 'OWNER_ANSWER SP-M8d (2026-10-10): (a) tear down' },
    ]);
    // Idempotent, also on another day.
    expect(L.ownerAnswerBonus(queue, ['SP-M8d'], '(a) tear down', T2)).toEqual([]);
    expect(queue.tasks[0].bonus).toHaveLength(1);
    expect(queue.tasks[2].bonus).toBeUndefined();
    expect(queue.tasks[3].bonus).toBeUndefined();
    // A changed answer is new information and gets added.
    expect(L.ownerAnswerBonus(queue, ['SP-M8d'], '(b) keep', T2)).toHaveLength(2);
    expect(queue.tasks[0].bonus?.[1].text).toBe('OWNER_ANSWER SP-M8d (2026-10-11): (b) keep');
    // Without an answer: nothing.
    expect(L.ownerAnswerBonus(queue, ['SP-M8d'], null, T2)).toEqual([]);
  });

  it('the track block (and so the prompt) shows the OWNER_ANSWER addendum', () => {
    const queue: Queue = { tasks: [up('A', { waiting_on: ['SP-M8d'] })], question: registered() };
    L.ownerAnswerBonus(queue, ['SP-M8d'], 'tear down', T1);
    expect(L.trackBlock(queue.tasks[0], queue)).toContain('OWNER_ANSWER SP-M8d (2026-10-10): tear down');
  });
});

// ---- queue.mjs against a copy of the queue (never the real one) ----
describe('queue.mjs: add/edit reject, state/show give notices, resolve writes the answer in', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;

  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: String(x.stdout ?? ''), error: String(x.stderr ?? '') };
    }
  }
  const readQueue = (): Queue => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));
  const writeFile = (name: string, content: unknown) => {
    const filePath = join(folder, name);
    writeFileSync(filePath, JSON.stringify(content));
    return filePath;
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-answer-'));
    const queue: Queue = {
      tasks: [
        up('A', { waiting_on: ['SP-M8d'] }),
        // Old data: free text from before the block.
        up('B', { status: 'proposed', waiting_on: [FREE_TEXT], added_by: 'X-9' }),
      ],
      resolved: [],
      question: registered(),
      limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 6 },
      next_migr: 100,
    };
    writeFileSync(join(folder, 'queue.json'), JSON.stringify(queue));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('add: free text and an unregistered id are rejected (all or nothing); registering in the same file is accepted', () => {
    const free = run(['add', '--json', JSON.stringify(up('C', { waiting_on: [FREE_TEXT] }))]);
    expect(free.code).toBe(1);
    expect(free.error).toMatch(/C: .*is not a question id/);
    const unreg = run([
      'add',
      '--file',
      writeFile('unreg.json', [up('D'), up('E', { waiting_on: ['SP-NEW'] })]),
    ]);
    expect(unreg.code).toBe(1);
    expect(unreg.error).toMatch(/E: waiting_on SP-NEW is not registered/);
    expect(readQueue().tasks.map((o) => o.id)).toEqual(['A', 'B']);

    const ok = run([
      'add',
      '--file',
      writeFile('ok.json', {
        tasks: [up('E', { waiting_on: ['SP-NEW', 'SP-M8d'] })],
        question: { 'SP-NEW': { type: 'condition', text: 'When the pilot is underway.' } },
      }),
    ]);
    expect(ok.code).toBe(0);
    expect(readQueue().tasks.map((o) => o.id)).toEqual(['A', 'B', 'E']);
  });

  it('edit: new free-text/unregistered waiting_on is rejected; old free text does not stop other changes', () => {
    const r = run(['edit', 'A', '--json', JSON.stringify({ waiting_on: ['SP-M8d', FREE_TEXT] })]);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/is not a question id/);
    expect(run(['edit', 'A', '--json', '{"waiting_on":["SP-UNREGISTERED"]}']).code).toBe(1);
    expect(readQueue().tasks[0].waiting_on).toEqual(['SP-M8d']);
    expect(run(['edit', 'B', '--json', '{"value":8}']).code).toBe(0);
  });

  it('edit-many cannot edit waiting_on', () => {
    const r = run([
      'edit-many',
      '--file',
      writeFile('m.json', [{ id: 'A', waiting_on: [FREE_TEXT] }]),
    ]);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/unknown field waiting_on/);
  });

  it('state has the resolveWaits field; show has a WARNING line', () => {
    const t = JSON.parse(run(['state']).out || '{}') as { resolveWaits?: Loose[] };
    expect(t.resolveWaits).toEqual([
      { id: 'B', status: 'proposed', sp: FREE_TEXT, reason: 'freeText' },
    ]);
    const v = run(['show']);
    expect(v.out).toMatch(/NOTICE: 1 loose wait\(s\)/);
    expect(v.out).toContain('B (proposed) waiting on');
  });

  it('resolve --answer puts OWNER_ANSWER in the mission once', () => {
    expect(run(['resolve', 'SP-M8d', '--answer', '(a) tear down', '--by', 'owner']).code).toBe(0);
    const r2 = run(['resolve', 'SP-M8d', '--answer', '(a) tear down', '--by', 'owner']);
    expect(r2.code).toBe(0);
    const t = readQueue().tasks[0].bonus ?? [];
    expect(t).toHaveLength(1);
    expect(t[0].text).toMatch(/^OWNER_ANSWER SP-M8d \(\d{4}-\d\d-\d\d\): \(a\) tear down$/);
    expect(readQueue().resolved).toEqual(['SP-M8d']);
  });
});
