// =============================================================
// queueOrchestrator.test.ts: the orchestrator routine as a script and cost per task.
//
// The tests prove the rules where they are enforced: the pure functions in queueLogic.js (short view, the RESULT and
// FINDINGS parsers, the track last answer, which agents belong to a task, the cost sum, the review package content), and
// queue.mjs (show, fill, receive, set done, cost) against a copy of the queue in a temporary folder (QUEUE_FOLDER), a
// temporary git repo (QUEUE_GIT), its own time log (QUEUE_TIME_LOG) and its own transcripts (QUEUE_TRANSCRIPTS).
// Never the main repo, never the real queue, and without `git config` (the identity is given with -c).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = {
  id: string;
  title: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  value?: number;
  content_min?: number;
  migr_tens?: number;
  depends_on?: string[];
  waiting_on?: string[];
  owned_files?: string[];
  started?: string;
  delivered?: string;
  done?: string;
  branch?: string;
  migr_block?: string | null;
  head_start?: string;
  scratchpad?: string;
  cost?: { usd: number; tokens: { sum: number }; agents: { agent: string; type: string }[] };
  findings?: { H: number; M: number; L: number; deferrable: string[]; reports: number };
  result?: { status: string | null; commits: number | null; line: string };
  review_package?: string;
};
type Queue = { tasks: Task[]; resolved?: string[]; limits?: object; next_migr?: number };
type Result = {
  line: string;
  status: string | null;
  branch: string | null;
  commits: number | null;
  migr: string | null;
  gates: string | null;
  probe: string | null;
  ownerQuestions: number | null;
  edge: string | null;
  extra: Record<string, string>;
};
type Findings = { line: string; H: number; M: number; L: number; deferrable: string[] };
type Row = Record<string, unknown>;
type AgentOption = { agent: string; type: string; row: Row };

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic') as {
  agentTypeFor: (k: string) => string;
  reviewersFor: (k: string) => string[];
  trackMessage: (id: string, path: string) => string;
  summaryView: (
    queue: Queue,
    option?: { now?: number; uncommitted?: string[]; dailyUsage?: number },
  ) => string[];
  parseResult: (t: string | null | undefined) => Result | null;
  parseFindings: (t: string | null | undefined) => Findings | null;
  batchFindings: (
    l: (Findings | null)[],
  ) => { H: number; M: number; L: number; deferrable: string[]; reports: number } | null;
  lastAnswer: (t: string) => string | null;
  firstUserMessage: (t: string) => string | null;
  mentionsTask: (t: string, id: string) => boolean;
  agentsForTask: (
    rows: Row[],
    id: string,
    option?: { from?: string | null; to?: string | null },
  ) => { secure: AgentOption[]; uncertainOnes: AgentOption[] };
  sumCost: (
    a: {
      agent: string;
      type: string;
      tokens: Record<string, number>;
      model?: string;
      turns?: number;
      source?: string;
    }[],
    now?: string,
  ) => {
    usd: number;
    tokens: Record<string, number>;
    turns: number;
    agents: { agent: string; usd: number }[];
  };
  costStatistics: (
    queue: Queue,
    option?: { since?: string | null },
  ) => {
    rows: { id: string; usd: number }[];
    perClass: {
      class: string;
      n: number;
      usd: number;
      median_usd: number | null;
      H: number;
      M: number;
      L: number;
    }[];
    total: { n: number; usd: number };
  };
  packageFiles: (
    ns: string,
    num: string,
  ) => { copy: string[]; skipped: { path: string; reason: string }[] };
  dbObjectsFromDiff: (d: string, m?: { folder: string | null }) => string[];
  reviewPackageIndex: (x: object) => string;
  reviewerPrompt: (x: { o: Partial<Task>; type: string; folder: string }) => string;
};
const TK = require('../timeCost') as {
  trackFromText: (t: string) => string | null;
  costUsd: (t: Record<string, number>, m?: string) => number;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const NOW = '2026-10-06T10:00:00.000Z';
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

function o(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    domain: `dom-${id}`,
    class: 'K',
    status: 'waiting',
    mission: `The mission for ${id}.`,
    value: 5,
    content_min: 60,
    migr_tens: 0,
    depends_on: [],
    waiting_on: [],
    owned_files: [`lib/${id}.ts`],
    ...extra,
  };
}

/** A transcript line (JSONL) from the assistant with usage and content. */
function assistant(
  mid: string,
  content: object[],
  usage = { input_tokens: 10, output_tokens: 100 },
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: NOW,
    message: { id: mid, model: 'claude-opus-5-5', usage, content: content },
  });
}
const user = (text: string) =>
  JSON.stringify({ type: 'user', timestamp: NOW, message: { content: text } });

describe('short view (show)', () => {
  it('stays under 3,000 characters even with hundreds pending, and shows active ones, startable ones and counts', () => {
    const tasks: Task[] = [
      o('ACT-1', { status: 'running', started: NOW, migr_block: '3500–3509' }),
      o('REV-1', { status: 'review', class: 'D', started: NOW, delivered: NOW }),
      o('FREE-1', { value: 9 }),
    ];
    // 300 pending that wait on an owner question (blocked), with long titles.
    for (let i = 0; i < 300; i++)
      tasks.push(
        o(`V-${i}`, { waiting_on: ['Q9'], title: `A long title ${'x'.repeat(120)}` }),
      );
    const lines = L.summaryView(
      { tasks, limits: {}, resolved: [] },
      { now: Date.parse(NOW) + 3_600_000 },
    );
    const text = lines.join('\n');
    expect(text.length).toBeLessThan(3000);
    expect(text).toMatch(/^ACTIVE \(2\):/m);
    expect(text).toMatch(/^ {2}ACT-1 +running/m);
    expect(text).toMatch(/^ {2}REV-1 +review/m);
    expect(text).toMatch(/STARTABLE NOW \(1; queue\.mjs fill starts them\)/);
    expect(text).toMatch(/^ {2}FREE-1 /m);
    expect(text).toMatch(/2 active · 301 waiting/);
    expect(text).toMatch(/Waiting per class: K 301; 300 of them are blocked now/);
    expect(text).toMatch(/Owner questions that unlock the most: Q9 \(300\)/);
    expect(text).not.toMatch(/V-17/);
  });
});

describe('agent type, reviewers and agent message', () => {
  it('follows the class', () => {
    expect(L.agentTypeFor('K')).toBe('track');
    expect(L.agentTypeFor('U')).toBe('track');
    expect(L.agentTypeFor('D')).toBe('track-d');
    expect(L.agentTypeFor('D+')).toBe('track-d');
    expect(L.reviewersFor('K')).toEqual([]);
    expect(L.reviewersFor('D')).toEqual(['reviewer']);
    expect(L.reviewersFor('D+')).toEqual(['reviewer', 'reviewer-security']);
  });
  it('the agent message and the reviewer prompt tie the cost to the task (timeCost.trackFromText)', () => {
    expect(TK.trackFromText(L.trackMessage('E-1b2', 'C:\\s\\prompt-E-1b2.md'))).toBe('E-1b2');
    const p = L.reviewerPrompt({
      o: { id: 'E-1b2', class: 'D+' },
      type: 'reviewer-security',
      folder: 'C:\\s\\rev-E-1b2',
    });
    expect(TK.trackFromText(p)).toBe('E-1b2');
    expect(p).toContain('C:\\s\\rev-E-1b2\\00-package.md');
    expect(p).toMatch(/FINDINGS H=<count> M=<count> L=<count>/);
  });
});

describe('RESULT and FINDINGS lines', () => {
  it('parses the track RESULT line, also with markdown around it', () => {
    const r = L.parseResult(
      'Introduction\n**RESULT** status=done branch=queue/X commits=3 migr=3490-3492 gates=OK probe=red→green(12/12) ownerQuestions=0 edge=- new=1\nrest',
    );
    expect(r).toMatchObject({
      status: 'DONE',
      branch: 'queue/X',
      commits: 3,
      migr: '3490-3492',
      gates: 'OK',
      probe: 'red→green(12/12)',
      ownerQuestions: 0,
      edge: '-',
      extra: { new: '1' },
    });
    expect(L.parseResult('`RESULT status=PARTIAL`')?.status).toBe('PARTIAL');
  });
  it('is tolerant: with no line, the answer is null (current behavior)', () => {
    expect(L.parseResult('Status: DONE, no fixed line')).toBeNull();
    expect(L.parseResult(null)).toBeNull();
    expect(L.parseFindings('None HIGH-findings.')).toBeNull();
    expect(L.parseFindings('FINDINGS see below')).toBeNull();
  });
  it('parses and sums FINDINGS lines', () => {
    const a = L.parseFindings('FINDINGS H=0 M=1 L=3 deferrable=L2,L3');
    expect(a).toMatchObject({ H: 0, M: 1, L: 3, deferrable: ['L2', 'L3'] });
    const b = L.parseFindings('> FINDINGS: H=1 L=2 deferrable=-');
    expect(b).toMatchObject({ H: 1, M: 0, L: 2, deferrable: [] });
    expect(L.batchFindings([a, null, b])).toEqual({
      H: 1,
      M: 1,
      L: 5,
      deferrable: ['L2', 'L3'],
      reports: 2,
    });
    expect(L.batchFindings([null])).toBeNull();
  });
});

describe('the transcripts: last answer and the mission', () => {
  it('the last answer is the last text or the SubagentHandback message', () => {
    const t = [
      user('You are track X'),
      assistant('m1', [{ type: 'text', text: 'inProgress' }]),
      assistant('m2', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'SubagentHandback',
          input: { message: 'RESULT status=DONE' },
        },
      ]),
      '{half line',
    ].join('\n');
    expect(L.lastAnswer(t)).toBe('RESULT status=DONE');
    expect(
      L.lastAnswer([user('x'), assistant('m1', [{ type: 'text', text: 'FINDINGS H=0' }])].join('\n')),
    ).toBe('FINDINGS H=0');
    expect(L.firstUserMessage(t)).toBe('You are track X');
  });
  it('mentionsTask requires the id as a word of its own', () => {
    expect(L.mentionsTask('review of queue/E-1b', 'E-1b')).toBe(true);
    expect(L.mentionsTask('fix round E-1b-r2', 'E-1b')).toBe(true);
    expect(L.mentionsTask('E-1b2 is another one', 'E-1b')).toBe(false);
    expect(L.mentionsTask('XE-1b', 'E-1b')).toBe(false);
  });
});

describe('cost per task', () => {
  const tok = { input: 100, output: 1000, cache_read: 1_000_000, cache_written: 50_000 };
  const rows: Row[] = [
    {
      time: '2026-10-06T10:00:00Z',
      agent_id: 'aaa111',
      agent_type: 'track',
      event: 'start',
      track: 'aaa111',
    },
    // Cumulative rows: only the last one per agent counts.
    {
      time: '2026-10-06T10:30:00Z',
      agent_id: 'aaa111',
      agent_type: 'track',
      event: 'done',
      track: 'X-1',
      tokens: { input: 1 },
    },
    {
      time: '2026-10-06T11:00:00Z',
      agent_id: 'aaa111',
      agent_type: 'track',
      event: 'done',
      track: 'X-1',
      tokens: tok,
    },
    // Fix round: belongs to X-1.
    {
      time: '2026-10-06T12:00:00Z',
      agent_id: 'bbb222',
      agent_type: 'track',
      event: 'done',
      track: 'X-1-r2',
      tokens: tok,
    },
    // Reviewer without a recognized track (the label is the agent id): uncertain.
    {
      time: '2026-10-06T11:30:00Z',
      agent_id: 'ccc333ddd',
      agent_type: 'reviewer',
      event: 'done',
      track: 'ccc333',
      tokens: tok,
    },
    // Another task and a planner without a track: left out.
    {
      time: '2026-10-06T11:30:00Z',
      agent_id: 'eee444',
      agent_type: 'track',
      event: 'done',
      track: 'X-10',
      tokens: tok,
    },
    {
      time: '2026-10-06T11:30:00Z',
      agent_id: 'fff555',
      agent_type: 'general-purpose',
      event: 'done',
      track: 'fff555',
      tokens: tok,
    },
    // Uncertain, but before the task started: left out.
    {
      time: '2026-10-05T11:30:00Z',
      agent_id: 'ggg666',
      agent_type: 'reviewer-security',
      event: 'done',
      track: 'ggg666',
      tokens: tok,
    },
  ];
  it('agentsForTask: secure via the track label (with fix rounds), uncertain ones in the time window', () => {
    const r = L.agentsForTask(rows, 'X-1', {
      from: '2026-10-06T09:00:00Z',
      to: '2026-10-06T13:00:00Z',
    });
    expect(r.secure.map((x) => x.agent).sort()).toEqual(['aaa111', 'bbb222']);
    expect(r.secure.find((x) => x.agent === 'aaa111')?.row.tokens).toEqual(tok);
    expect(r.uncertainOnes.map((x) => x.agent)).toEqual(['ccc333ddd']);
  });
  it('sumCost uses the timeCost prices and sums tokens and turns', () => {
    const k = L.sumCost(
      [
        { agent: 'a', type: 'track', tokens: tok, model: 'claude-opus-5-5', turns: 10 },
        { agent: 'b', type: 'reviewer', tokens: tok, turns: 5, source: 'transcript' },
      ],
      NOW,
    );
    const one = TK.costUsd(tok, 'claude-opus-5-5');
    expect(k.usd).toBeCloseTo(2 * one, 2);
    expect(k.tokens.sum).toBe(2 * (100 + 1000 + 1_000_000 + 50_000));
    expect(k.turns).toBe(15);
    expect(k.agents.map((x) => x.agent)).toEqual(['a', 'b']);
  });
  it('costStatistics per class, with findings', () => {
    const queue: Queue = {
      tasks: [
        o('A', {
          status: 'done',
          done: NOW,
          cost: { usd: 4, tokens: { sum: 1 }, agents: [] },
        }),
        o('B', {
          status: 'done',
          done: NOW,
          class: 'D',
          cost: { usd: 10, tokens: { sum: 1 }, agents: [] },
          findings: { H: 0, M: 1, L: 2, deferrable: [], reports: 1 },
        }),
        o('C', {
          status: 'done',
          done: NOW,
          cost: { usd: 6, tokens: { sum: 1 }, agents: [] },
        }),
        o('D', {
          status: 'done',
          done: '2026-09-01T00:00:00Z',
          cost: { usd: 100, tokens: { sum: 1 }, agents: [] },
        }),
        o('E', { status: 'waiting' }),
      ],
    };
    const s = L.costStatistics(queue, { since: '2026-10-01T00:00:00Z' });
    expect(s.total).toEqual({ n: 3, usd: 20 });
    expect(s.perClass.find((k) => k.class === 'K')).toMatchObject({
      n: 2,
      usd: 10,
      median_usd: 5,
    });
    expect(s.perClass.find((k) => k.class === 'D')).toMatchObject({ n: 1, H: 0, M: 1, L: 2 });
  });
});

describe('review-package', () => {
  it('packageFiles skips deleted and binary files', () => {
    const r = L.packageFiles(
      'M\tscripts/a.js\nA\tdb/migrations/1_x.sql\nD\told.ts\nA\timage.png\n',
      '1\t2\tscripts/a.js\n5\t0\tdb/migrations/1_x.sql\n0\t9\told.ts\n-\t-\timage.png\n',
    );
    expect(r.copy).toEqual(['scripts/a.js', 'db/migrations/1_x.sql']);
    expect(r.skipped).toEqual([
      { path: 'old.ts', reason: 'deleted' },
      { path: 'image.png', reason: 'binary' },
    ]);
  });
  it('dbObjectsFromDiff takes only new lines in migrations', () => {
    const diff = [
      'diff --git a/db/migrations/1_x.sql b/db/migrations/1_x.sql',
      '+++ b/db/migrations/1_x.sql',
      '+create or replace function public.foo(p uuid)',
      '+CREATE TABLE IF NOT EXISTS public.bar (',
      '+create policy "read bar" on public.bar for select',
      '+create or replace trigger t_bar before insert on public.bar',
      '-create function public.old()',
      '+  -- create function in a comment mid-line does not count',
      '+create function public.foo(p uuid)',
      '+++ b/lib/x.ts',
      '+create function not_sql()',
    ].join('\n');
    expect(L.dbObjectsFromDiff(diff, { folder: null })).toEqual([]);
    expect(L.dbObjectsFromDiff(diff, { folder: 'db/migrations' })).toEqual([
      'create function public.foo',
      'create table public.bar',
      'create policy "read bar" on public.bar',
      'create trigger t_bar',
    ]);
  });
  it('the index lists the files and the result line', () => {
    const t = L.reviewPackageIndex({
      o: { id: 'X', class: 'D', title: 'T', migr_block: '1–9' },
      branch: 'queue/X',
      stat: ' a | 1 +',
      dbObjects: ['create function public.foo'],
      copied: ['a'],
      skipped: [{ path: 'b.png', reason: 'binary' }],
      result: { line: 'RESULT status=DONE' },
      files: { trackReply: true, report: true },
      base: 'main',
      migrFolder: 'db/migrations',
    });
    expect(t).toContain('# Review package X (D): T');
    expect(t).toContain('diff against `main`');
    expect(t).toContain('Migration block: 1–9');
    expect(t).toContain('`RESULT status=DONE`');
    expect(t).toContain('`trackReply.md`');
    expect(t).toContain('`trackReport.md`');
    expect(t).toContain('`b.png` (binary)');
    expect(t).toContain('- create function public.foo');
  });
});

describe('queue.mjs show, fill, receive, set done and cost (against a copy)', () => {
  it('the whole routine from fill to done with cost and findings', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-orchestrator-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    const scratch = path.join(folder, 'scratch');
    const transcripts = path.join(folder, 'transcripts');
    const log = path.join(folder, 'times.jsonl');
    fs.mkdirSync(repo);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const writeFile = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
      g(['add', '--', file]);
    };
    g(['init', '-q', '-b', 'main']);
    writeFile('README.md', 'start\n');
    g(['commit', '-q', '-m', 'start']);
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created: NOW,
        limits: {},
        next_migr: 3600,
        resolved: [],
        tasks: [
          o('A', { class: 'D', migr_tens: 1, value: 9 }),
          o('B', { waiting_on: ['Q1'] }),
        ],
      }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        migrations: {
          folder: 'db/migrations',
          blockSize: 10,
          pushCommand: 'node migr-push.js',
          environmentFile: '.environment',
          allowedEnvironment: ['test'],
        },
      }),
    );
    // The mission template (fill builds the track block from the common part) is read from the root: a copy of the repo template.
    fs.mkdirSync(path.join(folder, 'docs'));
    fs.copyFileSync(
      path.join(ROOT, '..', 'docs', 'mission-template.md'),
      path.join(folder, 'docs', 'mission-template.md'),
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: log,
      QUEUE_TRANSCRIPTS: transcripts,
    };
    const run = (...args: string[]) => {
      const r = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args],
        {
          encoding: 'utf8',
          env,
        },
      );
      return { code: r.status, out: r.stdout, error: r.stderr };
    };
    const find = (id: string) =>
      (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue).tasks.find(
        (x) => x.id === id,
      )!;

    // show: short by default, full behind --full.
    const v = run('show');
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/STARTABLE NOW \(1;/);
    expect(v.out).toContain('Full list: queue.mjs show --full');
    expect(run('show', '--full').out).toMatch(/Q1/);

    // fill: starts A (D, migration block), creates the prompt file and the JSON with agent type and message.
    expect(run('fill').code).toBe(1); // without scratchpad
    const f = run('fill', '--scratchpad', scratch);
    expect(f.error).toBe('');
    expect(f.code).toBe(0);
    expect(f.out).toMatch(/A {2}subagent_type=track-d/);
    const json = JSON.parse(fs.readFileSync(path.join(scratch, 'queue-fill.json'), 'utf8')) as {
      head: string;
      track: { id: string; subagent_type: string; prompt: string; message: string }[];
    };
    expect(json.track.map((s) => s.id)).toEqual(['A']);
    expect(json.track[0].subagent_type).toBe('track-d');
    const prompt = fs.readFileSync(json.track[0].prompt, 'utf8');
    expect(prompt).toContain('The mission for A.');
    expect(prompt).toContain('queue/A');
    expect(prompt).toContain('3600–3609');
    const a1 = find('A');
    expect(a1).toMatchObject({
      status: 'running',
      branch: 'queue/A',
      head_start: json.head,
      scratchpad: scratch,
    });
    // Nothing more can be started (B waits on Q1).
    expect(run('fill', '--scratchpad', scratch).out).toMatch(/Nothing can start now/);

    // The track works on queue/A: a migration, a changed file and a deleted one.
    g(['switch', '-q', '-c', 'queue/A']);
    writeFile(
      'db/migrations/3600_a.sql',
      'create or replace function public.a_fn() returns int as $$ select 1 $$;\n',
    );
    writeFile('README.md', 'changed\n');
    g(['commit', '-q', '-m', 'A']);
    g(['switch', '-q', 'main']);
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'A', 'report.md'), '# Report A\nSelf-review OK.\n');

    // The transcripts and the time log: the track agent (answers with RESULT) and two reviewers (FINDINGS), one without a track label.
    const session = path.join(transcripts, 'session1', 'subagents');
    fs.mkdirSync(session, { recursive: true });
    const usage = { input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 500_000 };
    fs.writeFileSync(
      path.join(session, 'agent-trackA1.jsonl'),
      [
        user(json.track[0].message),
        assistant(
          's1',
          [
            {
              type: 'text',
              text: 'RESULT status=DONE branch=queue/A commits=1 migr=3600 gates=OK ownerQuestions=0 edge=-\nrest',
            },
          ],
          usage,
        ),
      ].join('\n'),
    );
    const rowA = (agent: string, type: string, track: string, time: string) =>
      JSON.stringify({
        time,
        wave: 'queue',
        track,
        event: 'done',
        agent_id: agent,
        agent_type: type,
        tokens: { input: 1 },
        model: 'claude-opus-5-5',
      });
    // After start (fill) and before set done: the time window for agents without a track label.
    const areasRun = () => new Date().toISOString();
    fs.writeFileSync(log, rowA('trackA1', 'track-d', 'A', areasRun()) + '\n');

    // receive: review, package as plain files, RESULT from the transcript, reviewer prompt for D.
    const m = run('receive', 'A');
    expect(m.error).toBe('');
    expect(m.code).toBe(0);
    expect(m.out).toMatch(/A: review · RESULT status=DONE/);
    expect(m.out).toMatch(/subagent_type=reviewer/);
    expect(m.out).not.toMatch(/reviewer-security/);
    expect(m.out).toContain(`--wave-base ${json.head}`);
    const pkg = path.join(scratch, 'rev-A');
    expect(fs.readFileSync(path.join(pkg, 'files', 'README.md'), 'utf8')).toBe('changed\n');
    expect(
      fs.existsSync(path.join(pkg, 'files', 'db', 'migrations', '3600_a.sql')),
    ).toBe(true);
    expect(fs.readFileSync(path.join(pkg, 'diff.patch'), 'utf8')).toContain('+changed');
    expect(fs.readFileSync(path.join(pkg, 'trackReport.md'), 'utf8')).toContain(
      'Self-review OK.',
    );
    expect(fs.readFileSync(path.join(pkg, 'trackReply.md'), 'utf8')).toContain(
      'RESULT status=DONE',
    );
    const index = fs.readFileSync(path.join(pkg, '00-package.md'), 'utf8');
    expect(index).toContain('create function public.a_fn');
    const revPrompt = fs.readFileSync(path.join(pkg, 'reviewer-reviewer.md'), 'utf8');
    expect(revPrompt).toContain('track A ');
    const a2 = find('A');
    expect(a2.status).toBe('review');
    expect(a2.result).toMatchObject({ status: 'DONE', commits: 1 });
    expect(a2.review_package).toBe(pkg);

    // The reviewers: one with a track label, one without (the mission mentions A), and another task's reviewer (left out).
    fs.writeFileSync(
      path.join(session, 'agent-revA1.jsonl'),
      [
        user(revPrompt),
        assistant(
          'r1',
          [{ type: 'text', text: 'FINDINGS H=0 M=1 L=2 deferrable=L2\nDetails' }],
          usage,
        ),
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(session, 'agent-revunknown.jsonl'),
      [
        user('Verify the fix in queue/A'),
        assistant(
          'r2',
          [
            {
              type: 'tool_use',
              id: 'h',
              name: 'SubagentHandback',
              input: { message: '**FINDINGS** H=1 M=0 L=0' },
            },
          ],
          usage,
        ),
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(session, 'agent-revother.jsonl'),
      [
        user('Review of queue/B'),
        assistant('r3', [{ type: 'text', text: 'FINDINGS H=5 M=5 L=5' }], usage),
      ].join('\n'),
    );
    fs.appendFileSync(
      log,
      [
        rowA('revA1', 'reviewer', 'A', areasRun()),
        rowA('revunknown', 'reviewer', 'revunk', areasRun()),
        rowA('revother', 'reviewer', 'revoth', areasRun()),
      ].join('\n') + '\n',
    );

    // set done: cost from the transcripts (three agents), findings summed from two FINDINGS lines.
    const s = run('set', 'A', 'done', '--remark', 'review 1 round');
    expect(s.error).toBe('');
    expect(s.out).toMatch(/Cost A: \$[\d.]+ \(3 agent\(s\)/);
    expect(s.out).toMatch(/findings H=1 M=1 L=2 \(2 report\(s\)\)/);
    const a3 = find('A');
    expect(a3.status).toBe('done');
    expect(a3.cost?.agents.map((x) => x.agent).sort()).toEqual(['revA1', 'revunknown', 'trackA1']);
    const oneUsd = TK.costUsd({ input: 100, output: 1000, cache_read: 500_000 }, 'claude-opus-5-5');
    expect(a3.cost?.usd).toBeCloseTo(3 * oneUsd, 2);
    expect(a3.findings).toEqual({ H: 1, M: 1, L: 2, deferrable: ['L2'], reports: 2 });

    // cost: the statistics per class; cost measure with --findings overrides the transcripts.
    const k = run('cost');
    expect(k.out).toMatch(/Cost per task \(1 finished/);
    expect(k.out).toMatch(/D {2}n=1/);
    expect(run('cost', 'measure', 'A', '--findings', 'FINDINGS H=0 M=0 L=1').out).toMatch(/findings H=0 M=0 L=1/);
    expect(find('A').findings).toMatchObject({ H: 0, M: 0, L: 1 });
  });
});

// =============================================================
// Fewer orchestrator turns: merge in one call, fixed lookups, concurrent calls and a report cap. No real merge,
// migration push or gates: the pure functions get a runner, and queue.mjs merge gets an injected runner
// (QUEUE_MERGE_RUNNING).
// =============================================================
type Step = { step: string };
type RunAnswer = { code: number; out: string };
type Plan = { step: string[]; migrPush: boolean; migr: string[]; notes: string[] };
type Migr = {
  folder: string | null;
  filePattern?: string;
  pushCommand?: string | null;
  environmentFile?: string | null;
  allowedEnvironment?: string[];
};
type MergeRes = {
  ok: boolean;
  lines: string[];
  stop: { step: string; message: string; excerpt: string[] } | null;
};
/* eslint-disable @typescript-eslint/no-require-imports */
const K2 = require('../queueLogic') as {
  REPORT_CAP: number;
  SAME_TURN: string;
  environmentCheck: (
    r: string | null | undefined,
    m?: Migr,
  ) => { ok: boolean; environment: string; message: string };
  mergePlan: (x: {
    o: Partial<Task>;
    files: string[] | null;
    withoutMigrPush?: boolean;
    withoutFill?: boolean;
    base?: string;
    migrations?: Migr;
  }) => Plan;
  errorExcerpt: (out: string, n?: number) => string[];
  executeMerge: (x: {
    o: Partial<Task>;
    plan: Plan;
    branch: string;
    currentBranch: string | null;
    run: (s: Step) => RunAnswer;
    readEnvironment?: () => string | null;
    guard?: (environment: string | null) => { decision: string; reason: string } | null;
    base?: string;
    migrations?: Migr;
  }) => MergeRes;
  concurrentBlock: (
    a: { subagent_type: string; prompt: string; message?: string | null }[],
  ) => string[];
  reportCapWarning: (t: string | null) => string | null;
  infoField: (o: object, f: string) => unknown;
  infoView: (o: object) => string[];
  addToBonus: (o: Record<string, unknown>, t: string, now: string) => string | null;
  trackBlock: (o: object, queue: object, x: { text: string }) => string;
  activeLines: (queue: object, now?: number) => string[];
  highestBlockNr: (queue: object) => number;
  nextMigrGuard: (x: { now: number; new: number; highestFile?: number; highestBlock?: number }) => {
    ok: boolean;
    error: string | null;
  };
  trackMessage: (id: string, path: string) => string;
};
const PRIVACY = require('../pushGuard') as {
  assess: (k: string, x: object) => { decision: string; reason: string } | null;
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** The migration setup the tests use: folder, pushCommand and an environment guard with one allowed environment. */
const MIGR: Migr = {
  folder: 'db/migrations',
  filePattern: '^(\\d+)_.*\\.sql$',
  pushCommand: 'node migr-push.js',
  environmentFile: '.environment',
  allowedEnvironment: ['test'],
};
const WITHOUT_MIGR: Migr = { folder: null };

describe('environment check and step plan for merge', () => {
  it('only an allowed environment gets through; unknown and a missing file stop; without an environment file no guard', () => {
    expect(K2.environmentCheck('test\n', MIGR)).toMatchObject({ ok: true, environment: 'test' });
    expect(K2.environmentCheck('production', MIGR)).toMatchObject({ ok: false, environment: 'unknown' });
    expect(K2.environmentCheck('production', MIGR).message).toMatch(/allowedEnvironment \(test\)/);
    expect(K2.environmentCheck(null, MIGR)).toMatchObject({ ok: false, environment: 'missing' });
    expect(K2.environmentCheck('  ', MIGR)).toMatchObject({ ok: false, environment: 'missing' });
    expect(K2.environmentCheck(null, { ...MIGR, environmentFile: null })).toMatchObject({
      ok: true,
      environment: 'without-guard',
    });
  });

  it('migration push only when the branch has migration files (the block decides when the diff is missing)', () => {
    const m = K2.mergePlan({
      o: { id: 'M', migr_block: '3600–3609' },
      files: ['lib/x.ts', 'db/migrations/3600_m.sql'],
      migrations: MIGR,
    });
    expect(m.step).toEqual(['merge', 'migr-push', 'gates', 'done', 'fill']);
    expect(m.migr).toEqual(['db/migrations/3600_m.sql']);
    // Block assigned, but no migration files: no push, with a note.
    const b = K2.mergePlan({
      o: { id: 'B', migr_block: '3600–3609' },
      files: ['lib/x.ts'],
      migrations: MIGR,
    });
    expect(b.step).toEqual(['merge', 'gates', 'done', 'fill']);
    expect(b.notes.join(' ')).toMatch(/no migration files/);
    // The diff could not be read: the block decides (better one push too many).
    expect(
      K2.mergePlan({ o: { id: 'X', migr_block: '3600–3609' }, files: null, migrations: MIGR })
        .migrPush,
    ).toBe(true);
    expect(K2.mergePlan({ o: { id: 'Y' }, files: null, migrations: MIGR }).migrPush).toBe(false);
    // Other .sql outside the folder, in a subfolder or outside the file pattern does not count.
    for (const f of ['db/tester/x.sql', 'db/migrations/old/1_x.sql', 'db/migrations/x.sql'])
      expect(K2.mergePlan({ o: { id: 'P' }, files: [f], migrations: MIGR }).migrPush).toBe(false);
    // --without-migr-push and --without-fill.
    const u = K2.mergePlan({
      o: { id: 'M' },
      files: ['db/migrations/1_a.sql'],
      withoutMigrPush: true,
      withoutFill: true,
      migrations: MIGR,
    });
    expect(u.step).toEqual(['merge', 'gates', 'done']);
    expect(u.notes.join(' ')).toMatch(/NOT pushed/);
  });

  it('without a migration folder there is never a push step; without pushCommand only a note', () => {
    const files = ['db/migrations/3600_m.sql'];
    const a = K2.mergePlan({ o: { id: 'M', migr_block: '3600–3609' }, files, migrations: WITHOUT_MIGR });
    expect(a.step).toEqual(['merge', 'gates', 'done', 'fill']);
    expect(a.migr).toEqual([]);
    expect(a.notes).toEqual([]);
    const b = K2.mergePlan({ o: { id: 'M' }, files, migrations: { ...MIGR, pushCommand: null } });
    expect(b.migrPush).toBe(false);
    expect(b.notes.join(' ')).toMatch(/pushCommand is not set/);
  });

  it('the error excerpt is at most 20 non-empty lines from the end', () => {
    const out = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n\n');
    const u = K2.errorExcerpt(out);
    expect(u).toHaveLength(20);
    expect(u[19]).toBe('line 49');
  });
});

describe('executeMerge (order and stop rules)', () => {
  const oM = { id: 'M', class: 'D' as const, migr_block: '3600–3609' };
  const planM = () =>
    K2.mergePlan({ o: oM, files: ['db/migrations/3600_m.sql'], migrations: MIGR });
  /** Common arguments: baseBranch main, the migration setup above and the environment "test". */
  const common = { branch: 'queue/M', currentBranch: 'main', base: 'main', migrations: MIGR };
  /** Runner with a canned answer per step that remembers the calls. */
  const running = (answer: Record<string, RunAnswer>) => {
    const call: string[] = [];
    const run = (s: Step) => {
      call.push(s.step);
      return answer[s.step] ?? { code: 0, out: 'ok' };
    };
    return { call, run };
  };
  const FILL = {
    code: 0,
    out: `FILLED 1 track (head abc); details in x.\nB  subagent_type=track  migr -\n${K2.SAME_TURN}\n  subagent_type=track · message: You are track B`,
  };

  it('the whole run: merge → migration push → gates → done → fill', () => {
    const { call, run } = running({
      merge: { code: 0, out: 'Merged and committed: abc1234 Merge\nWorktree: cleaned up: ok' },
      'migr-push': { code: 0, out: 'Running 3600_m.sql\nRunning 3601_n.sql\nDone: 2 migrations.' },
      gates: { code: 0, out: 'typecheck OK\ngates: 14 OK, 0 RED (3 min)' },
      done: { code: 0, out: 'Cost M: $3.1 (2 agent(s))\nM: done' },
      fill: FILL,
    });
    const r = K2.executeMerge({
      ...common,
      o: oM,
      plan: planM(),
      run,
      readEnvironment: () => 'test',
      guard: (environment) =>
        PRIVACY.assess(String(MIGR.pushCommand), {
          branch: 'main',
          environment,
          baseBranch: 'main',
          migrations: MIGR,
        }),
    });
    expect(r.ok).toBe(true);
    expect(call).toEqual(['merge', 'migr-push', 'gates', 'done', 'fill']);
    const t = r.lines.join('\n');
    expect(t).toMatch(/merge: Merged and committed: abc1234 Merge · Worktree: cleaned up/);
    expect(t).toMatch(/migrationPush: OK \(environment test\): Done: 2 migrations\./);
    expect(t).toMatch(/gates --quick: gates: 14 OK/);
    expect(t).toMatch(/done: M: done/);
    expect(t).toContain(K2.SAME_TURN);
    expect(t).toContain('message: You are track B');
    // Short output: at most about 15 lines.
    expect(r.lines.length).toBeLessThanOrEqual(15);
  });

  it('environment outside allowedEnvironment: stops before the push, and nothing after runs', () => {
    const { call, run } = running({});
    const r = K2.executeMerge({ ...common, o: oM, plan: planM(), run, readEnvironment: () => 'production' });
    expect(r.ok).toBe(false);
    expect(r.stop?.step).toBe('migr-push');
    expect(r.stop?.message).toMatch(/production/);
    expect(call).toEqual(['merge']);
  });

  it('a missing environment file stops too', () => {
    const { call, run } = running({});
    const r = K2.executeMerge({ ...common, o: oM, plan: planM(), run, readEnvironment: () => null });
    expect(r.stop?.step).toBe('migr-push');
    expect(r.stop?.message).toMatch(/Did not find the environment file \.environment/);
    expect(call).toEqual(['merge']);
  });

  it('the push guard has the last word: an opinion from it stops the push', () => {
    const { call, run } = running({});
    const r = K2.executeMerge({
      ...common,
      o: oM,
      plan: planM(),
      run,
      readEnvironment: () => 'test',
      guard: () => ({ decision: 'ask', reason: 'test' }),
    });
    expect(r.stop?.message).toMatch(/push guard says ask/);
    expect(call).toEqual(['merge']);
  });

  it('the environment changed during the push: stop after the push', () => {
    const environments = ['test', 'production'];
    const { call, run } = running({});
    const r = K2.executeMerge({
      ...common,
      o: oM,
      plan: planM(),
      run,
      readEnvironment: () => environments.shift() ?? null,
    });
    expect(r.stop?.step).toBe('migr-push');
    expect(r.stop?.message).toMatch(/changed during the migration push/);
    expect(call).toEqual(['merge', 'migr-push']);
  });

  it('without an environment file in the setup the push runs without an environment guard', () => {
    const migr = { ...MIGR, environmentFile: null };
    const { call, run } = running({ 'migr-push': { code: 0, out: 'ok' } });
    const r = K2.executeMerge({
      ...common,
      migrations: migr,
      o: oM,
      plan: K2.mergePlan({ o: oM, files: ['db/migrations/3600_m.sql'], migrations: migr }),
      run,
    });
    expect(r.ok).toBe(true);
    expect(call).toEqual(['merge', 'migr-push', 'gates', 'done', 'fill']);
    expect(r.lines.join('\n')).toMatch(/migrationPush: OK: ok/);
  });

  it('the main tree is not on baseBranch: nothing runs', () => {
    const { call, run } = running({});
    const r = K2.executeMerge({
      ...common,
      currentBranch: 'another',
      o: oM,
      plan: planM(),
      run,
      readEnvironment: () => 'test',
    });
    expect(r.stop?.step).toBe('merge');
    expect(r.stop?.message).toMatch(/not main/);
    expect(call).toEqual([]);
  });

  it('a failing merge or migration push stops with an excerpt', () => {
    const a = running({ merge: { code: 1, out: 'MUST BE RESOLVED BY HAND\n  lib/x.ts' } });
    const r = K2.executeMerge({
      ...common,
      o: oM,
      plan: planM(),
      run: a.run,
      readEnvironment: () => 'test',
    });
    expect(r.stop).toMatchObject({ step: 'merge', excerpt: ['MUST BE RESOLVED BY HAND', '  lib/x.ts'] });
    expect(a.call).toEqual(['merge']);
    const b = running({ 'migr-push': { code: 1, out: 'connection refused' } });
    const r2 = K2.executeMerge({
      ...common,
      o: oM,
      plan: planM(),
      run: b.run,
      readEnvironment: () => 'test',
    });
    expect(r2.stop?.step).toBe('migr-push');
    expect(r2.stop?.excerpt).toEqual(['connection refused']);
    expect(b.call).toEqual(['merge', 'migr-push']);
  });

  it('red gates stop before set done and fill', () => {
    const { call, run } = running({ gates: { code: 1, out: 'typecheck RED\nsee the log' } });
    const plan = K2.mergePlan({ o: { id: 'K' }, files: ['lib/k.ts'], migrations: MIGR });
    const r = K2.executeMerge({ ...common, o: { id: 'K' }, plan, branch: 'queue/K', run });
    expect(r.stop?.step).toBe('gates');
    expect(r.stop?.message).toMatch(/stays in review/);
    // Without migration files the environment is not read, and the push does not run.
    expect(call).toEqual(['merge', 'gates']);
  });

  it('a fill that stops on budget, night or wind-down is not an error', () => {
    const { run } = running({ fill: { code: 6, out: 'Orchestrator is in wind-down.' } });
    const plan = K2.mergePlan({ o: { id: 'K' }, files: ['lib/k.ts'], migrations: WITHOUT_MIGR });
    const r = K2.executeMerge({ ...common, o: { id: 'K' }, plan, branch: 'queue/K', run });
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toMatch(/fill: no new ones \(exit 6\)/);
  });
});

describe('concurrent calls, report cap, info, bonus, activeOnes and next-migr', () => {
  it('concurrentBlock: one line per agent after the heading', () => {
    expect(K2.concurrentBlock([])).toEqual([]);
    const l = K2.concurrentBlock([
      { subagent_type: 'track-d', prompt: 'C:\\s\\prompt-A.md', message: 'You are track A' },
      { subagent_type: 'reviewer', prompt: 'C:\\s\\rev-A\\reviewer-reviewer.md' },
    ]);
    expect(l[0]).toBe(K2.SAME_TURN);
    expect(l[1]).toMatch(/subagent_type=track-d · message: You are track A/);
    expect(l[2]).toMatch(
      /subagent_type=reviewer · message: the content of .*reviewer-reviewer\.md/,
    );
  });

  it('the report cap: about 1,500 characters, and the agent message says so', () => {
    expect(K2.REPORT_CAP).toBe(1500);
    expect(K2.reportCapWarning('RESULT status=DONE\nshort')).toBeNull();
    expect(K2.reportCapWarning(null)).toBeNull();
    expect(K2.reportCapWarning('x'.repeat(1501))).toMatch(/1501 characters \(cap approx\. 1500\)/);
    expect(K2.trackMessage('A', 'C:\\s\\prompt-A.md')).toMatch(/at most approx\. 1,500 characters/);
  });

  it('info: one field (also with a dot) and short view', () => {
    const o = {
      id: 'A',
      title: 'T',
      status: 'review',
      class: 'D',
      head_start: 'abcdef1234567890',
      cost: { usd: 3.2, agents: [], turns: 9 },
      mission: 'x'.repeat(500),
      depends_on: [],
    };
    expect(K2.infoField(o, 'cost.usd')).toBe(3.2);
    expect(K2.infoField(o, 'does.not.exist')).toBeUndefined();
    const v = K2.infoView(o).join('\n');
    expect(v).toMatch(/^id: A$/m);
    expect(v).toMatch(/head_start: abcdef123456$/m);
    expect(v).not.toMatch(/depends_on/);
    expect(v.length).toBeLessThan(700);
  });

  it('bonus: with a timestamp in bonus and remarks, and in the track block', () => {
    const o: Record<string, unknown> = { id: 'A', title: 'T', class: 'K', remarks: ['old'] };
    expect(K2.addToBonus(o, '  ', NOW)).toMatch(/empty/);
    expect(K2.addToBonus(o, 'Use the RPC x_v2.', NOW)).toBeNull();
    expect(o.bonus).toEqual([{ time: NOW, text: 'Use the RPC x_v2.' }]);
    expect(o.remarks).toEqual(['old', `${NOW} bonus to the mission: Use the RPC x_v2.`]);
    const block = K2.trackBlock(o, { tasks: [o] }, { text: 'The mission.' });
    expect(block).toMatch(/The mission\.\n\n\*\*Bonus from the orchestrator/);
    expect(block).toContain(`- ${NOW}: Use the RPC x_v2.`);
  });

  it('activeOnes: running, picked and review with branch, block, head and age', () => {
    const now = Date.parse(NOW);
    const queue = {
      tasks: [
        o('A', {
          status: 'running',
          branch: 'queue/A',
          migr_block: '3600–3609',
          head_start: 'abcdef1234',
          started: '2026-10-06T09:15:00.000Z',
        }),
        o('B', {
          status: 'review',
          branch: 'queue/B',
          started: '2026-10-06T06:00:00.000Z',
          delivered: '2026-10-06T09:50:00.000Z',
        }),
        o('C', { status: 'waiting' }),
      ],
    };
    const l = K2.activeLines(queue, now);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatch(
      /^A {2}running {2}K {2}queue\/A {2}migr 3600–3609 {2}head abcdef12 {2}age 45 min$/,
    );
    expect(l[1]).toMatch(/B {2}review .* age 4 h 0 min, delivered 10 min ago/);
    expect(K2.activeLines({ tasks: [] })[0]).toMatch(/No active tasks/);
  });

  it('next-migr: never backward, never down into a used number', () => {
    const queue = { tasks: [o('A', { migr_block: '3600–3619' }), o('B')] };
    expect(K2.highestBlockNr(queue)).toBe(3619);
    expect(K2.nextMigrGuard({ now: 3620, new: 3700, highestFile: 3605, highestBlock: 3619 })).toEqual(
      { ok: true, error: null },
    );
    expect(
      K2.nextMigrGuard({ now: 3620, new: 3610, highestFile: 3605, highestBlock: 3619 }).error,
    ).toMatch(/backward/);
    // As high as next_migr, but a file above it is already used (manual migration outside the queue).
    expect(K2.nextMigrGuard({ now: 3620, new: 3620, highestFile: 3650 }).error).toMatch(
      /highest used number 3650/,
    );
    expect(K2.nextMigrGuard({ now: 3620, new: 1.5 }).ok).toBe(false);
  });
});

describe('queue.mjs merge, info, activeOnes, edit --bonus and next-migr (against a copy)', () => {
  it('merge with an injected runner: push to an allowed environment, stop otherwise, no push without migrations', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-orchestrator2-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    const scratch = path.join(folder, 'scratch');
    fs.mkdirSync(repo);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const writeFile = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
      g(['add', '--', file]);
    };
    g(['init', '-q', '-b', 'main']);
    writeFile('README.md', 'start\n');
    g(['commit', '-q', '-m', 'start']);
    const head = g(['rev-parse', 'main']);
    g(['switch', '-q', '-c', 'queue/M']);
    writeFile('db/migrations/3600_m.sql', 'select 1;\n');
    g(['commit', '-q', '-m', 'M']);
    g(['switch', '-q', 'main']);
    g(['switch', '-q', '-c', 'queue/K']);
    writeFile('lib/k.ts', 'export const k = 1;\n');
    g(['commit', '-q', '-m', 'K']);
    g(['switch', '-q', 'main']);
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        migrations: {
          folder: 'db/migrations',
          blockSize: 10,
          pushCommand: 'node migr-push.js',
          environmentFile: '.environment',
          allowedEnvironment: ['test'],
        },
      }),
    );
    const setEnvironment = (m: string) => fs.writeFileSync(path.join(repo, '.environment'), m);
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created: NOW,
        limits: {},
        next_migr: 3610,
        resolved: [],
        tasks: [
          o('M', {
            class: 'D',
            status: 'review',
            branch: 'queue/M',
            migr_block: '3600–3609',
            head_start: head,
            scratchpad: scratch,
            started: NOW,
          }),
          o('K', {
            status: 'review',
            branch: 'queue/K',
            head_start: head,
            scratchpad: scratch,
            started: NOW,
          }),
          o('V', { status: 'waiting' }),
        ],
      }),
    );
    // The injected runner: remembers the calls and answers from a scenario per step.
    const callFile = path.join(folder, 'call.jsonl');
    const scenarioFile = path.join(folder, 'scenario.json');
    const runningFile = path.join(folder, 'running.mjs');
    fs.writeFileSync(
      runningFile,
      [
        "import fs from 'node:fs';",
        'export default function run(x) {',
        '  fs.appendFileSync(process.env.MERGE_TEST_CALL, JSON.stringify({ step: x.step, cmd: x.cmd, args: x.args }) + "\\n");',
        "  const sc = JSON.parse(fs.readFileSync(process.env.MERGE_TEST_SCENARIO, 'utf8'));",
        "  return sc[x.step] ?? { code: 0, out: 'ok' };",
        '}',
      ].join('\n'),
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
      QUEUE_MERGE_RUNNING: runningFile,
      MERGE_TEST_CALL: callFile,
      MERGE_TEST_SCENARIO: scenarioFile,
    };
    const run = (...args: string[]) => {
      const r = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args],
        {
          encoding: 'utf8',
          env,
        },
      );
      return { code: r.status, out: r.stdout, error: r.stderr };
    };
    const call = () => {
      const t = fs.existsSync(callFile) ? fs.readFileSync(callFile, 'utf8') : '';
      fs.rmSync(callFile, { force: true });
      return t
        .split('\n')
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as { step: string; cmd: string; args: string[] },
        );
    };
    fs.writeFileSync(
      scenarioFile,
      JSON.stringify({
        merge: { code: 0, out: 'Merged and committed: abc M' },
        'migr-push': { code: 0, out: 'Running 3600_m.sql\nDone: 1 migration.' },
        gates: { code: 0, out: 'gates: OK' },
        done: { code: 0, out: 'M: done' },
        fill: { code: 0, out: 'Nothing can be started now (see show and state).' },
      }),
    );

    // Environment outside allowedEnvironment: STOP before the push, no push call, full log written.
    setEnvironment('production');
    const p = run('merge', 'M');
    expect(p.code).toBe(1);
    expect(p.out).toMatch(/STOP in the step migr-push: .*production/);
    expect(call().map((x) => x.step)).toEqual(['merge']);
    expect(fs.readFileSync(path.join(scratch, 'merge-M.log'), 'utf8')).toMatch(/===== merge: /);

    // Allowed environment: the whole run, merge-track with --wave-base, the push command from the config, set done and fill.
    setEnvironment('test');
    const s = run('merge', 'M');
    expect(s.error).toBe('');
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/MERGE M \(queue\/M\): merge → migr-push → gates → done → fill/);
    expect(s.out).toMatch(/migrationPush: OK \(environment test\): Done: 1 migration\./);
    expect(s.out.split('\n').filter(Boolean).length).toBeLessThanOrEqual(15);
    const k1 = call();
    expect(k1.map((x) => x.step)).toEqual(['merge', 'migr-push', 'gates', 'done', 'fill']);
    expect(k1[0].args.slice(1)).toEqual(['queue/M', '--wave-base', head]);
    expect(k1[1]).toMatchObject({ cmd: 'node migr-push.js', args: [] });
    // The gates get the branch fork point and tip, so rule 1 in "known red" works after the merge.
    expect(k1[2].args.slice(1, 6)).toEqual([
      '--quick',
      '--track-base',
      head,
      '--track-tip',
      g(['rev-parse', 'queue/M']),
    ]);
    expect(k1[3].args.slice(1, 4)).toEqual(['set', 'M', 'done']);
    expect(k1[4].args.slice(1)).toEqual(['fill', '--scratchpad', scratch]);

    // Without migrations: no push, and the environment plays no role; --without-fill skips fill.
    setEnvironment('production');
    const u = run('merge', 'K', '--without-fill');
    expect(u.code).toBe(0);
    expect(call().map((x) => x.step)).toEqual(['merge', 'gates', 'done']);

    // Wrong status: waiting cannot be merged.
    expect(run('merge', 'V').error).toMatch(/merge applies to review/);

    // info, activeOnes, edit --bonus and next-migr.
    expect(run('info', 'M', '--field', 'branch').out.trim()).toBe('queue/M');
    expect(run('info', 'M').out).toMatch(/^migr_block: 3600–3609$/m);
    expect(run('info', 'M', '--field', 'exists').code).toBe(1);
    expect(run('activeOnes').out).toMatch(/^M {2}review {2}D {2}queue\/M/m);
    const t = run('edit', 'M', '--bonus', 'Remember the probe x.');
    expect(t.code).toBe(0);
    expect(t.out).toMatch(/M changed: bonus, remarks/);
    expect(run('info', 'M', '--field', 'bonus').out).toMatch(/Remember the probe x\./);
    expect(run('edit', 'M', '--bonus', ' ').code).toBe(1);
    expect(run('next-migr').out).toMatch(/next_migr 3610/);
    expect(run('next-migr', '3605').error).toMatch(/backward/);
    expect(run('next-migr', '3640').out).toMatch(/next_migr 3610 → 3640/);
  });
});
