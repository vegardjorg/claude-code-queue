// =============================================================
// queueQuestion.test.ts: owner questions and resolutions with timestamps in the work queue.
//
// `question` is the text behind the ids in `waiting_on` (type, text, recommendation, source), and `resolutions` is the
// answer with time and who. Both are optional: an old queue.json without them works unchanged, and the id still sits in
// `resolved` (that list is what the blockers read). The tests prove the rules where they are enforced: the pure functions
// in queueLogic.js, and queue.mjs against a copy of the queue in a temporary folder (QUEUE_FOLDER), never the real one.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Question = {
  type: string;
  text: string;
  recommendation?: string;
  source?: string;
  added_at: string;
};
type Resolution = { time: string; answer: string | null; by: string | null; logged?: boolean };
type Task = {
  id: string;
  title?: string;
  domain?: string;
  class?: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  owner_db?: string[];
  shared_patch?: string[];
  branch?: string;
  added_at?: string;
};
type Queue = {
  tasks: Task[];
  resolved?: string[];
  question?: Record<string, Question>;
  resolutions?: Record<string, Resolution>;
  limits?: Record<string, unknown>;
  next_migr?: number;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  QUESTION_TYPES: string[];
  setQuestion: (queue: Queue, input: unknown, now?: string) => { set: string[]; error: string[] };
  resolve: (
    queue: Queue,
    ids: string[],
    option?: { answer?: string | null; by?: string | null; now?: string },
  ) => { resolved: string[]; error: string[] };
  unlogged: (queue: Queue) => ({ sp: string } & Resolution)[];
  markLogged: (queue: Queue, ids: string[]) => { marked: string[]; error: string[] };
  questionOverview: (queue: Queue) => {
    sp: string;
    type: string;
    text: string | null;
    resolved: boolean;
    answer: string | null;
    tasks: string[];
  }[];
  questionWithoutText: (tasks: Task[], queue: Queue) => string[];
  answerBlock: (o: Task, queue: Queue) => string | null;
  blockers: (o: Task, tasks: Task[], resolved?: string[]) => string[];
  selectNext: (queue: Queue, now?: number) => { id: string }[];
};

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T12:30:00.000Z';

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

describe('setQuestion', () => {
  it('sets new questions with added_at; type is question when not given', () => {
    const queue: Queue = { tasks: [] };
    const r = L.setQuestion(
      queue,
      {
        Q8: { text: 'Which accounting system?', recommendation: 'Answer when known.', source: 'plan § 2' },
        'CONDITIONAL-X': { type: 'condition', text: 'Delta 58 is stable.' },
      },
      T1,
    );
    expect(r).toEqual({ set: ['Q8', 'CONDITIONAL-X'], error: [] });
    expect(queue.question?.Q8).toEqual({
      type: 'question',
      text: 'Which accounting system?',
      recommendation: 'Answer when known.',
      source: 'plan § 2',
      added_at: T1,
    });
    expect(queue.question?.['CONDITIONAL-X'].type).toBe('condition');
    expect(L.QUESTION_TYPES).toEqual(['question', 'condition', 'lawyer', 'owner-task']);
  });

  it('all or nothing: one invalid question, and nothing is changed', () => {
    const queue: Queue = { tasks: [] };
    const r = L.setQuestion(queue, {
      A: { text: 'Valid' },
      B: { type: 'maybe', text: 'Invalid type' },
      C: { text: '   ' },
      D: { text: 'x', unknown: 1 },
      '-E': { text: 'id with a leading hyphen' },
    });
    expect(r.set).toEqual([]);
    expect(r.error.join('\n')).toMatch(/B: type must be/);
    expect(r.error.join('\n')).toMatch(/C: text missing/);
    expect(r.error.join('\n')).toMatch(/D: unknown field unknown/);
    expect(r.error.join('\n')).toMatch(/-E: invalid id/);
    expect(queue.question).toBeUndefined();
    expect(L.setQuestion(queue, [{ text: 'list' }]).error[0]).toMatch(/must be an object/);
  });

  it('an update keeps the fields not included and added_at; null removes the recommendation', () => {
    const queue: Queue = { tasks: [] };
    L.setQuestion(queue, { A: { type: 'lawyer', text: 'First', recommendation: 'Wait' } }, T1);
    L.setQuestion(queue, { A: { text: 'Other' } }, T2);
    expect(queue.question?.A).toEqual({
      type: 'lawyer',
      text: 'Other',
      recommendation: 'Wait',
      added_at: T1,
    });
    L.setQuestion(queue, { A: { recommendation: null } }, T2);
    expect(queue.question?.A).toEqual({ type: 'lawyer', text: 'Other', added_at: T1 });
  });
});

describe('resolve: resolved as before, and resolutions with timestamps', () => {
  it('with an answer: the id in resolved and in resolutions with time, answer, who and logged: false', () => {
    const queue: Queue = { tasks: [], resolved: ['OLD'] };
    expect(L.resolve(queue, ['Q8'], { answer: '  Ledgerly  ', by: 'owner', now: T1 })).toEqual({
      resolved: ['Q8'],
      error: [],
    });
    expect(queue.resolved).toEqual(['OLD', 'Q8']);
    expect(queue.resolutions?.Q8).toEqual({ time: T1, answer: 'Ledgerly', by: 'owner', logged: false });
  });

  it('without an answer (backward compatible): time, answer null; an earlier resolution is kept unchanged', () => {
    const queue: Queue = { tasks: [] };
    L.resolve(queue, ['A', 'B'], { now: T1 });
    expect(queue.resolutions?.A).toEqual({ time: T1, answer: null, by: null });
    L.resolve(queue, ['C'], { answer: 'Yes', by: 'owner', now: T1 });
    L.resolve(queue, ['C'], { now: T2 });
    expect(queue.resolutions?.C).toEqual({ time: T1, answer: 'Yes', by: 'owner', logged: false });
  });

  it('a new answer replaces the old one and must be logged again', () => {
    const queue: Queue = { tasks: [] };
    L.resolve(queue, ['A'], { answer: 'First', now: T1 });
    L.markLogged(queue, ['A']);
    L.resolve(queue, ['A'], { answer: 'Other', by: 'owner', now: T2 });
    expect(queue.resolutions?.A).toEqual({ time: T2, answer: 'Other', by: 'owner', logged: false });
  });

  it('an empty answer (the guard rule: empty answer = stop) is rejected, and nothing is changed', () => {
    const queue: Queue = { tasks: [], resolved: [] };
    const r = L.resolve(queue, ['A'], { answer: '   ' });
    expect(r.resolved).toEqual([]);
    expect(r.error[0]).toMatch(/the answer is empty/);
    expect(queue.resolved).toEqual([]);
    expect(queue.resolutions).toBeUndefined();
    expect(L.resolve(queue, []).error[0]).toMatch(/at least one/);
  });
});

describe('unlogged and markLogged', () => {
  it('unlogged = resolutions with an answer not yet logged; without an answer there is nothing to log', () => {
    const queue: Queue = { tasks: [] };
    L.resolve(queue, ['B'], { answer: 'No', now: T2 });
    L.resolve(queue, ['A'], { answer: 'Yes', now: T1 });
    L.resolve(queue, ['C'], { now: T1 });
    expect(L.unlogged(queue).map((x) => x.sp)).toEqual(['A', 'B']);
    expect(L.markLogged(queue, ['A'])).toEqual({ marked: ['A'], error: [] });
    expect(L.unlogged(queue).map((x) => x.sp)).toEqual(['B']);
    expect(queue.resolutions?.A.logged).toBe(true);
  });

  it('all or nothing: an unknown id or a resolution without an answer gives an error and marks nothing', () => {
    const queue: Queue = { tasks: [] };
    L.resolve(queue, ['A'], { answer: 'Yes', now: T1 });
    L.resolve(queue, ['C'], { now: T1 });
    const r = L.markLogged(queue, ['A', 'UNKNOWN', 'C']);
    expect(r.marked).toEqual([]);
    expect(r.error.join('\n')).toMatch(/UNKNOWN is not resolved/);
    expect(r.error.join('\n')).toMatch(/C has no answer/);
    expect(queue.resolutions?.A.logged).toBe(false);
  });
});

describe('answerBlock (the track file includes the answer)', () => {
  it('the answer for every resolved id in waiting_on, with the question, who and when', () => {
    const queue: Queue = { tasks: [] };
    L.setQuestion(queue, {
      Q8: { text: 'Which accounting system?' },
      'CONDITIONAL-Delta': { type: 'condition', text: 'Delta 58 is stable.' },
    });
    L.resolve(queue, ['Q8'], { answer: 'Ledgerly', by: 'owner', now: T1 });
    L.resolve(queue, ['CONDITIONAL-Delta'], { answer: 'Delta 58 is stable from 2.10', by: 'owner', now: T2 });
    L.resolve(queue, ['R2'], { now: T1 });
    const o = up('X', { waiting_on: ['Q8', 'CONDITIONAL-Delta', 'R2', 'OPEN'] });
    const block = L.answerBlock(o, queue) ?? '';
    expect(block).toContain('**Owner answer to what the task waited on**');
    expect(block).toContain(
      '- Q8 (question): "Which accounting system?" Answer: "Ledgerly" (owner, 2026-10-01 10:00 UTC).',
    );
    expect(block).toContain('Fulfilled: "Delta 58 is stable from 2.10"');
    expect(block).toContain('- R2 Resolved 2026-10-01 10:00 UTC, but the answer is not in the queue');
    expect(block).not.toContain('OPEN');
    expect(L.answerBlock(up('Y', { waiting_on: ['OPEN'] }), queue)).toBeNull();
  });
});

describe('questionOverview and questionWithoutText', () => {
  it('open first (most pending), then resolved; questions without text are included', () => {
    const queue: Queue = {
      tasks: [
        up('A', { waiting_on: ['S1', 'S2'] }),
        up('B', { waiting_on: ['S2'] }),
        up('C', { waiting_on: ['S3'], status: 'done' }),
      ],
    };
    L.setQuestion(queue, { S1: { text: 'One' }, S9: { text: 'None waiting' } });
    L.resolve(queue, ['S1'], { answer: 'Yes', now: T1 });
    const r = L.questionOverview(queue);
    expect(r.map((x) => `${x.sp}:${x.tasks.length}:${x.resolved}`)).toEqual([
      'S2:2:false',
      'S9:0:false',
      'S1:1:true',
    ]);
    expect(r[0].text).toBeNull();
    expect(r[2].answer).toBe('Yes');
    expect(L.questionWithoutText(queue.tasks, queue)).toEqual(['S2', 'S3']);
  });
});

describe('old queue.json without the new fields', () => {
  it('blockers and selectNext work as before; resolved without resolutions unblocks', () => {
    const queue: Queue = {
      tasks: [up('A', { waiting_on: ['S1'] }), up('B', { waiting_on: ['S2'] })],
      resolved: ['S1'],
    };
    expect(L.blockers(queue.tasks[0], queue.tasks, queue.resolved)).toEqual([]);
    expect(L.blockers(queue.tasks[1], queue.tasks, queue.resolved)).toEqual(['waiting on answer: S2']);
    expect(L.selectNext(queue).map((v) => v.id)).toEqual(['A']);
    expect(L.unlogged(queue)).toEqual([]);
    expect(L.questionOverview(queue).map((x) => x.sp)).toEqual(['S2', 'S1']);
  });
});

// ---- queue.mjs against a copy of the queue (never the real one) ----
describe('queue.mjs: question, resolve --answer, resolutions and add with { tasks, question }', () => {
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
    folder = mkdtempSync(join(tmpdir(), 'queue-question-'));
    // An old queue.json: without question and resolutions.
    const queue: Queue = {
      tasks: [up('A', { waiting_on: ['Q8'] }), up('B', { waiting_on: ['J2'] })],
      resolved: [],
      limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 6 },
      next_migr: 100,
    };
    writeFileSync(join(folder, 'queue.json'), JSON.stringify(queue));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('question <id> --text ... sets one, and question lists (including those missing text)', () => {
    const r = run([
      'question',
      'Q8',
      '--text',
      'Which accounting system does the pilot customer use?',
      '--type',
      'question',
      '--recommendation',
      'Answer when known.',
      '--source',
      'plan § 2',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Question set (1): Q8');
    expect(readQueue().question?.Q8).toMatchObject({
      type: 'question',
      text: 'Which accounting system does the pilot customer use?',
      recommendation: 'Answer when known.',
      source: 'plan § 2',
    });
    const list = run(['question']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('Q8  [question; open, 1 task waiting]');
    expect(list.out).toContain('J2');
    expect(list.out).toContain('(missing text');
    expect(run(['question', 'Q8', '--type', 'maybe']).code).toBe(1);
    expect(run(['question', '--text', 'without id']).code).toBe(1);
  });

  it('question --file: bulk import, all or nothing', () => {
    const error = run([
      'question',
      '--file',
      writeFile('error.json', { Q8: { text: 'Ok' }, J2: { type: 'unknown', text: 'No' } }),
    ]);
    expect(error.code).toBe(1);
    expect(readQueue().question).toBeUndefined();
    const ok = run([
      'question',
      '--file',
      writeFile('ok.json', {
        Q8: { type: 'question', text: 'Legacy system?', source: 'k' },
        J2: { type: 'lawyer', text: 'Offline-stamp?', recommendation: 'Send the letter.' },
      }),
    ]);
    expect(ok.code).toBe(0);
    expect(Object.keys(readQueue().question ?? {})).toEqual(['Q8', 'J2']);
  });

  it('resolve <id> --answer ... --by owner: resolved and resolutions with time; resolutions --unlogged and --mark-logged', () => {
    const r = run(['resolve', 'Q8', '--answer', 'Ledgerly', '--by', 'owner']);
    expect(r.code).toBe(0);
    const queue = readQueue();
    expect(queue.resolved).toEqual(['Q8']);
    expect(queue.resolutions?.Q8).toMatchObject({ answer: 'Ledgerly', by: 'owner', logged: false });
    expect(Date.parse(queue.resolutions?.Q8.time ?? '')).toBeGreaterThan(0);

    const u = run(['resolutions', '--unlogged']);
    expect(u.out).toContain('Q8');
    expect(u.out).toContain('[NOT LOGGED]');
    expect(u.out).toContain('answer: Ledgerly');
    expect(u.out).toContain('--mark-logged Q8');

    expect(run(['resolutions', '--mark-logged', 'UNKNOWN']).code).toBe(1);
    const m = run(['resolutions', '--mark-logged', 'Q8']);
    expect(m.code).toBe(0);
    expect(readQueue().resolutions?.Q8.logged).toBe(true);
    expect(run(['resolutions', '--unlogged']).out).toContain('No unlogged resolutions.');
    expect(run(['resolutions']).out).toContain('[logged]');
  });

  it('resolve without --answer works as before (timestamp, answer null); --answer "" stops and changes nothing', () => {
    expect(run(['resolve', 'J2']).code).toBe(0);
    expect(readQueue().resolutions?.J2).toMatchObject({ answer: null, by: null });
    const empty = run(['resolve', 'Q8', '--answer', '']);
    expect(empty.code).toBe(1);
    expect(empty.error).toContain('the answer is empty');
    expect(readQueue().resolved).toEqual(['J2']);
  });

  it('add with { tasks, question } adds both in one write; a plain list works as before', () => {
    const r = run([
      'add',
      '--file',
      writeFile('new.json', {
        tasks: [up('C', { waiting_on: ['NEW-1'] })],
        question: { 'NEW-1': { type: 'condition', text: 'When the pilot is underway.' } },
      }),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Added: C');
    expect(r.out).toContain('Question text set: NEW-1');
    expect(readQueue().question?.['NEW-1'].type).toBe('condition');
    // A waiting_on id without text is rejected (not just a warning); see queueAnswer.test.ts.

    const list = run(['add', '--file', writeFile('list.json', [up('D')])]);
    expect(list.code).toBe(0);
    expect(list.out).toContain('Added: D');
    const one = run(['add', '--json', JSON.stringify(up('E'))]);
    expect(one.code).toBe(0);
    expect(readQueue().tasks.map((o) => o.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('add is all or nothing: an invalid question stops the tasks too', () => {
    const r = run([
      'add',
      '--file',
      writeFile('error.json', {
        tasks: [up('C')],
        question: { 'NEW-1': { type: 'unknown', text: 'x' } },
      }),
    ]);
    expect(r.code).toBe(1);
    expect(r.error).toContain('question NEW-1: type must be');
    expect(readQueue().tasks.map((o) => o.id)).toEqual(['A', 'B']);
  });

  it('trackFile includes the owner answer the task was waiting on', () => {
    run(['question', 'Q8', '--text', 'Which accounting system?']);
    run(['resolve', 'Q8', '--answer', 'Ledgerly', '--by', 'owner']);
    expect(run(['start', 'A'])).toMatchObject({ code: 0 });
    const out = join(folder, 'track.md');
    expect(run(['trackFile', 'A', '--out', out]).code).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('**Owner answer to what the task waited on**');
    expect(text).toContain('- Q8 (question): "Which accounting system?" Answer: "Ledgerly" (owner, ');
  });
});
