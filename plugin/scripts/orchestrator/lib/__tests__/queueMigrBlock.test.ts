// =============================================================
// queueMigrBlock.test.ts: the block choice in the queue (taken migration blocks).
//
// The bug: `fill` gave new tracks a migration block a running track already had. The orchestrator moved a block by
// hand in the prompt file, but the queue (migr_block) and next_migr did not know, so the next fill got the same
// block. The tests lock the rule where it is enforced: the pure functions in queueLogic.js that queue.mjs (start,
// fill, pick, next-migr, migr move) calls, and queue.mjs itself against a copy of the queue in a temporary folder
// (QUEUE_FOLDER) with a migration flow in its own config (QUEUE_CONFIG). Never the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Interval = { from: number; to: number; source?: string };
type Task = { id: string; status: string; migr_tens?: number; migr_block?: string | null } & Record<
  string,
  unknown
>;
type Queue = { next_migr: number; tasks: Task[] };
const MIGR = { folder: 'db/migrations', blockSize: 10 };

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic') as {
  assignMigrBlock: (
    n: number,
    t: number,
    size?: number,
    taken?: Interval[],
  ) => Interval & { nextAvailable: number; skipped?: Interval[] };
  blockInterval: (t: string | null | undefined) => Interval | null;
  blocksInText: (t: string) => Interval[];
  takenBlocks: (x: {
    tasks?: Task[];
    fileNrs?: number[];
    prompts?: { name: string; text: string }[];
    except?: string | null;
  }) => Interval[];
  assignStartBlock: (
    queue: Queue,
    o: Task,
    taken?: Interval[],
    migrations?: object,
  ) => { block: string | null; skipped: Interval[] };
  parseMoveBlock: (t: string, tens?: number, size?: number) => Interval | { error: string };
  moveBlockInText: (t: string, old: Interval | null, fresh: Interval) => string;
  promptTask: (name: string, tasks: Task[]) => string | null;
  highestBlockNr: (queue: { tasks: Task[] }) => number;
  nextMigrGuard: (x: {
    now: number;
    new: number;
    highestFile?: number;
    highestBlock?: number;
    taken?: Interval[];
  }) => { ok: boolean; error: string | null };
  pick: (
    queue: Queue,
    id: string,
    x: { by: string; taken?: Interval[]; migrations?: object },
  ) => { task?: Task; error?: string };
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** One fill round the way queue.mjs does it: taken blocks from the queue, the files and the prompt files, then assign. */
function fillRound(queue: Queue, id: string, fileNrs: number[], prompts: { name: string; text: string }[]) {
  const o = queue.tasks.find((x) => x.id === id)!;
  const taken = L.takenBlocks({ tasks: queue.tasks, fileNrs, prompts, except: id });
  o.status = 'running';
  o.migr_block = L.assignStartBlock(queue, o, taken, MIGR).block;
  return o.migr_block;
}

describe('taken blocks: the block choice skips them', () => {
  it('two fill rounds with tracks running give different blocks', () => {
    const queue: Queue = {
      next_migr: 12040,
      tasks: [
        { id: 'A', status: 'waiting', migr_tens: 1 },
        { id: 'B', status: 'waiting', migr_tens: 1 },
      ],
    };
    expect(fillRound(queue, 'A', [], [])).toBe('12040–12049');
    expect(fillRound(queue, 'B', [], [])).toBe('12050–12059');
  });

  it('a block moved by hand in the prompt file counts as taken (the queue is stale)', () => {
    // B-5 got 12050 from fill, but was moved by hand to 12060 in the prompt file; next_migr is 12060.
    const queue: Queue = {
      next_migr: 12060,
      tasks: [
        { id: 'B-5', status: 'running', migr_tens: 1, migr_block: '12050–12059' },
        { id: 'B-4', status: 'waiting', migr_tens: 1 },
      ],
    };
    const prompts = [{ name: 'prompt-B-5.md', text: '# TRACK B-5\n\nMigration block: 12060–12069\n' }];
    expect(fillRound(queue, 'B-4', [], prompts)).toBe('12070–12079');
    expect(queue.next_migr).toBe(12080);
  });

  it('a migration file makes the block taken', () => {
    const queue: Queue = { next_migr: 11950, tasks: [{ id: 'X', status: 'waiting', migr_tens: 2 }] };
    // 11950 already exists as a file: two blocks from 11960.
    expect(fillRound(queue, 'X', [11950], [])).toBe('11960–11979');
  });

  it('done and cancelled tasks do not hold the block, nor do their prompt files', () => {
    const tasks: Task[] = [
      { id: 'F', status: 'done', migr_block: '12000–12009' },
      { id: 'K', status: 'cancelled', migr_block: '12010–12019' },
      { id: 'R', status: 'review', migr_block: '12020–12029' },
    ];
    const taken = L.takenBlocks({
      tasks,
      prompts: [
        { name: 'prompt-F.md', text: 'Migration block: 12030–12039' },
        { name: 'prompt-R-r2.md', text: 'Migration block: 12040-12049' },
        { name: 'prompt-UNKNOWN.md', text: 'Migration block: 12050–12059' },
      ],
    });
    expect(taken.map((t) => [t.from, t.source])).toEqual([
      [12020, 'task R'],
      [12040, 'prompt-R-r2.md'],
      [12050, 'prompt-UNKNOWN.md'],
    ]);
  });

  it('only lines about the migration block count in a prompt file (no line ranges or dates)', () => {
    const text = [
      'Migration block: 3450–3459',
      'Read lines 120-129 in the file. Date 2026-10-30.',
      '- Only your own migration block (3450–3459); migrations are idempotent.',
    ].join('\n');
    expect(L.blocksInText(text)).toEqual([
      { from: 3450, to: 3459 },
      { from: 3450, to: 3459 },
    ]);
  });

  it('pick uses the same taken blocks', () => {
    const queue: Queue = {
      next_migr: 12060,
      tasks: [
        { id: 'A', status: 'running', migr_block: '12060–12069' },
        { id: 'P', status: 'waiting', migr_tens: 1, domain: 'x', class: 'K' },
      ],
    };
    const taken = L.takenBlocks({ tasks: queue.tasks, except: 'P' });
    const r = L.pick(queue, 'P', { by: 'test', taken, migrations: MIGR });
    expect(r.task?.migr_block).toBe('12070–12079');
  });

  it('without taken blocks the assignment is as before', () => {
    expect(L.assignMigrBlock(3455, 2)).toMatchObject({ from: 3460, to: 3479, nextAvailable: 3480 });
    expect(L.assignMigrBlock(3455, 2)).not.toHaveProperty('skipped');
  });

  it('next-migr refuses a number inside a taken block', () => {
    const v = L.nextMigrGuard({
      now: 12060,
      new: 12065,
      taken: [{ from: 12060, to: 12069, source: 'prompt-A.md' }],
    });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/prompt-A\.md/);
    expect(L.nextMigrGuard({ now: 12060, new: 12070, taken: [{ from: 12060, to: 12069 }] }).ok).toBe(true);
  });
});

describe('migr move', () => {
  it('parses the block in two forms and requires whole blocks', () => {
    expect(L.parseMoveBlock('12070', 2)).toEqual({ from: 12070, to: 12089 });
    expect(L.parseMoveBlock('12070-12079')).toEqual({ from: 12070, to: 12079 });
    expect(L.parseMoveBlock('12070–12079')).toEqual({ from: 12070, to: 12079 });
    expect(L.parseMoveBlock('12075')).toHaveProperty('error');
    expect(L.parseMoveBlock('nonsense')).toHaveProperty('error');
    expect(L.parseMoveBlock('100', 1, 100)).toEqual({ from: 100, to: 199 });
  });

  it('swaps the Migration block line and the mentions in the prompt file', () => {
    const before = [
      '# TRACK B-4 (x)',
      '',
      'Migration block: 12060–12069',
      '',
      '- Only your own migration block (12060–12069); migrations are idempotent.',
      'Another block 12000-12009 stays.',
    ].join('\n');
    const after = L.moveBlockInText(before, { from: 12060, to: 12069 }, { from: 12070, to: 12079 });
    expect(after).toContain('Migration block: 12070–12079');
    expect(after).toContain('migration block (12070–12079)');
    expect(after).toContain('12000-12009 stays');
    expect(after).not.toMatch(/1206\d/);
  });

  it('also swaps the block the file itself names when the queue is stale (an earlier move by hand)', () => {
    const before = 'Migration block: 12070–12079\n\nmigration block (12070 - 12079)\n';
    // The queue says 12060 (stale); the file says 12070; the new block is 12200.
    const after = L.moveBlockInText(before, { from: 12060, to: 12069 }, { from: 12200, to: 12209 });
    expect(after).toBe('Migration block: 12200–12209\n\nmigration block (12200–12209)\n');
  });

  it('the prompt file of a fix round belongs to the task; short end numbers are read', () => {
    const o = [{ id: 'B-4', status: 'running' }];
    expect(L.promptTask('prompt-B-4-r2.md', o)).toBe('B-4');
    expect(L.promptTask('C:\\x\\prompt-B-4.md', o)).toBe('B-4');
    expect(L.blockInterval('2340–49')).toEqual({ from: 2340, to: 2349 });
    expect(L.blockInterval('2340 - 2349')).toEqual({ from: 2340, to: 2349 });
    expect(
      L.highestBlockNr({ tasks: [{ id: 'A', status: 'done', migr_block: '10380-10389' }] }),
    ).toBe(10389);
  });
});

describe('queue.mjs: start, next-migr and migr move skip taken blocks (against a copy)', () => {
  const QUEUE_MJS = path.join(__dirname, '..', '..', 'queue.mjs');
  const temporary: string[] = [];
  afterAll(() => {
    for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
  });

  function setup() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-migr-'));
    temporary.push(folder);
    const scratch = path.join(folder, 'scratch');
    fs.mkdirSync(scratch);
    fs.mkdirSync(path.join(folder, 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'db', 'migrations', '0100_first.sql'), '');
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ migrations: { folder: 'db/migrations', blockSize: 10 } }));
    const task = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      title: id,
      domain: id.toLowerCase(),
      class: 'K',
      status: 'waiting',
      mission: 'x',
      migr_tens: 1,
      ...extra,
    });
    const queue = {
      next_migr: 110,
      limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 6 },
      tasks: [
        task('A', { status: 'running', migr_block: '110–119', scratchpad: scratch }),
        task('B'),
      ],
    };
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify(queue, null, 2));
    // A was moved by hand to 120–129 in its prompt file; the queue still says 110–119.
    fs.writeFileSync(
      path.join(scratch, 'prompt-A.md'),
      '# TRACK A\n\nMigration block: 120–129\n\n- Only your own migration block (120–129).\n',
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: folder,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_SCRATCHPAD: scratch,
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [QUEUE_MJS, ...args], { encoding: 'utf8', env });
      return { code: r.status, out: r.stdout, error: r.stderr };
    };
    const readQueue = () =>
      JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue & {
        tasks: (Task & { remarks?: string[] })[];
      };
    return { folder, scratch, run, readQueue };
  }

  it('start skips the block in the prompt file and next-migr refuses it', () => {
    const { run, readQueue } = setup();
    const n = run('next-migr', '125');
    expect(n.code).toBe(1);
    expect(n.error).toMatch(/taken block 120–129 \(prompt-A\.md\)/);
    const s = run('start', 'B');
    expect(s.code).toBe(0);
    expect(s.error).toMatch(/skipped taken blocks .*120–129 prompt-A\.md/);
    expect(readQueue().tasks.find((x) => x.id === 'B')?.migr_block).toBe('130–139');
    expect(readQueue().next_migr).toBe(140);
  });

  it('migr move updates the queue and the prompt file, and refuses a taken block', () => {
    const { scratch, run, readQueue } = setup();
    const taken = run('migr', 'move', 'B', '120');
    expect(taken.code).toBe(1);
    expect(taken.error).toMatch(/120–129 is taken/);
    const m = run('migr', 'move', 'A', '150');
    expect(m.code).toBe(0);
    expect(m.out).toMatch(/A: migr_block 110–119 → 150–159/);
    expect(m.out).toMatch(/next_migr 110 → 160/);
    const a = readQueue().tasks.find((x) => x.id === 'A')!;
    expect(a.migr_block).toBe('150–159');
    expect(a.remarks?.at(-1)).toMatch(/migr move: 110–119 → 150–159/);
    const text = fs.readFileSync(path.join(scratch, 'prompt-A.md'), 'utf8');
    expect(text).toContain('Migration block: 150–159');
    expect(text).toContain('migration block (150–159)');
    expect(text).not.toMatch(/12\d–/);
    expect(text).toMatch(/has been moved to 150–159/);
    expect(run('migr', 'move', 'B', '125').error).toMatch(/whole blocks/);
  });
});
