// =============================================================
// queueQaEvidence.test.ts: evidence in the QA entry (lib/queueLogic.js + `queue.mjs qa evidence|auto`).
//
// A track writes `EVIDENCE <type>[=<ref>]` in report.md and `receive` stores it; `qa evidence` sets it by hand, the QA
// list is split into what the owner looks at, a manual round and auto entries, and `qa auto --run` closes the auto
// entries whose configured command is green. The types and the command are config().qa (queue.config.json) with the
// generic defaults screenshot, test and manual. The rules are asserted where they are enforced: the pure functions,
// and queue.mjs against a temporary data folder (QUEUE_FOLDER) with its own queue.config.json (QUEUE_CONFIG).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

type Evidence = { type: string; ref: string[] };
type Task = {
  id: string;
  title?: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  labels?: string[];
  project?: string;
  feature?: string;
  qa_status?: string;
  qa_ok?: string;
  qa_ok_by?: string;
  qa_note?: string;
  evidence?: Evidence;
  remarks?: string[];
  done?: string;
};
type Queue = { tasks: Task[]; projects?: Record<string, { title?: string }> };
type Group = { pid: string; features: { feature: string; tasks: Task[] }[] };
type Qa = {
  evidenceTypes: string[];
  autoTypes: string[];
  manualTypes: string[];
  autoCommand: string | Record<string, string> | null;
  evidenceLabels: string[];
};

const L = require('../queueLogic.js') as {
  qaConfig: (qa?: unknown) => Qa;
  validateEvidence: (e: unknown, qa?: Qa) => string[];
  parseEvidence: (t: string | null, qa?: Qa) => null | { error: string } | { evidence: Evidence };
  evidenceRequired: (o: Task, qa?: Qa) => boolean;
  evidenceWarning: (x: { o: Task; evidence?: Evidence | null; evidenceError?: string | null }, qa?: Qa) => string | null;
  evidenceText: (e: Evidence | null | undefined, qa?: Qa) => string;
  qaSplit: (queue: Queue, qa?: Qa) => { look: Group[]; manual: Task[]; auto: Task[] };
  evidenceCommand: (o: Task, qa?: Qa) => { command: string } | { error: string };
  qaAutoOutcome: (queue: Queue, id: string, green: boolean, now?: string, qa?: Qa) => { error: string } | { closed: boolean };
  setStatus: (o: Task, s: string, now?: string) => { qa?: boolean; error?: string };
  validate: (o: Task, all: Task[]) => string[];
};

const ISO = '2026-10-28T10:00:00.000Z';
const QA = L.qaConfig(null);
const task = (over: Partial<Task> = {}): Task => ({
  id: 'V-1',
  title: 'New screen',
  domain: 'client',
  class: 'K',
  status: 'done',
  mission: 'x',
  labels: ['visual'],
  qa_status: 'waiting',
  ...over,
});

describe('the defaults in config().qa', () => {
  it('are generic: screenshot, test and manual, test is automatic, no command, the label visual', () => {
    expect(QA).toEqual({
      evidenceTypes: ['screenshot', 'test', 'manual'],
      autoTypes: ['test'],
      manualTypes: ['manual'],
      autoCommand: null,
      evidenceLabels: ['visual'],
    });
    // The same defaults as queueConfig.STANDARD (the file the projects edit).
    expect(require('../queueConfig.js').STANDARD.qa).toEqual(QA);
  });

  it('own types replace the lists; a broken value falls back to the default', () => {
    const own = L.qaConfig({ evidenceTypes: ['flow', 'probe'], autoTypes: ['probe'], manualTypes: 'x' });
    expect(own.evidenceTypes).toEqual(['flow', 'probe']);
    expect(own.manualTypes).toEqual(['manual']);
    expect(L.parseEvidence('EVIDENCE probe=rls_tasks', own)).toEqual({ evidence: { type: 'probe', ref: ['rls_tasks'] } });
    expect(L.parseEvidence('EVIDENCE screenshot', own)).toMatchObject({ error: expect.stringMatching(/flow, probe/) });
  });
});

describe('the EVIDENCE line', () => {
  it('reads the type and the refs, with or without colon, bullet and backticks', () => {
    expect(L.parseEvidence('RESULT status=DONE\nEVIDENCE test=src/a.test.ts,src/b.test.ts\n')).toEqual({
      evidence: { type: 'test', ref: ['src/a.test.ts', 'src/b.test.ts'] },
    });
    expect(L.parseEvidence('- EVIDENCE: screenshot=/settings')).toEqual({
      evidence: { type: 'screenshot', ref: ['/settings'] },
    });
    expect(L.parseEvidence('`EVIDENCE screenshot`')).toEqual({ evidence: { type: 'screenshot', ref: [] } });
    // A manual type keeps the free text whole (commas and spaces included).
    expect(L.parseEvidence('* EVIDENCE manual=the camera, on a real phone')).toEqual({
      evidence: { type: 'manual', ref: ['the camera, on a real phone'] },
    });
  });

  it('no line gives null; an unknown type, test without a ref and shell characters give an error', () => {
    expect(L.parseEvidence('RESULT status=DONE')).toBeNull();
    expect(L.parseEvidence(null)).toBeNull();
    expect(L.parseEvidence('EVIDENCE photo')).toMatchObject({ error: expect.stringMatching(/screenshot, test, manual/) });
    expect(L.parseEvidence('EVIDENCE test')).toMatchObject({ error: expect.stringMatching(/needs a ref/) });
    expect(L.parseEvidence('EVIDENCE test=a.test.ts;rm -rf x')).toMatchObject({
      error: expect.stringMatching(/must be a path or a name/),
    });
  });

  it('the field evidence is validated when a task is added or changed', () => {
    expect(L.validate({ ...task(), evidence: { type: 'test', ref: ['a.test.ts'] } }, [])).toEqual([]);
    expect(L.validate({ ...task(), evidence: { type: 'photo', ref: [] } }, []).join(' ')).toMatch(/evidence.type/);
    expect(L.validate({ ...task(), evidence: 'test' as unknown as Evidence }, []).join(' ')).toMatch(/\{ type, ref \}/);
  });

  it('evidenceText for lists', () => {
    expect(L.evidenceText(undefined)).toBe('no evidence');
    expect(L.evidenceText({ type: 'screenshot', ref: [] })).toBe('screenshot');
    expect(L.evidenceText({ type: 'test', ref: ['a.test.ts', 'b.test.ts'] })).toBe('test a.test.ts, b.test.ts');
    expect(L.evidenceText({ type: 'manual', ref: ['the camera'] })).toBe('manual: the camera');
  });
});

describe('the warning in receive', () => {
  it('a task without a label that needs evidence: no warning', () => {
    expect(L.evidenceWarning({ o: task({ labels: [] }) })).toBeNull();
    expect(L.evidenceRequired(task({ labels: ['backend'] }))).toBe(false);
  });

  it('a visual task without an EVIDENCE line gets a warning with the types and the manual command', () => {
    const w = L.evidenceWarning({ o: task() });
    expect(w).toMatch(/V-1 has the label visual, but report\.md has no EVIDENCE line/);
    expect(w).toMatch(/screenshot=<ref> \| test=<ref> \| manual=<what>/);
    expect(w).toMatch(/cq qa evidence V-1/);
  });

  it('a line, or evidence already stored on the task, is enough', () => {
    expect(L.evidenceWarning({ o: task(), evidence: { type: 'screenshot', ref: [] } })).toBeNull();
    expect(L.evidenceWarning({ o: task({ evidence: { type: 'manual', ref: ['x'] } }) })).toBeNull();
  });

  it('an invalid line gives a warning with the error, also without the label', () => {
    expect(L.evidenceWarning({ o: task({ labels: [] }), evidenceError: 'the EVIDENCE line is invalid: x' })).toMatch(
      /V-1: the EVIDENCE line is invalid: x/,
    );
  });

  it('evidenceLabels from the config: [] never warns, another label does', () => {
    expect(L.evidenceWarning({ o: task() }, L.qaConfig({ evidenceLabels: [] }))).toBeNull();
    expect(L.evidenceWarning({ o: task({ labels: ['ui'] }) }, L.qaConfig({ evidenceLabels: ['ui'] }))).toMatch(/label ui/);
  });
});

describe('the QA list by evidence and automatic closing', () => {
  const queue = (): Queue => ({
    tasks: [
      task({ id: 'S-1', evidence: { type: 'screenshot', ref: ['/x'] } }),
      task({ id: 'S-2' }),
      task({ id: 'M-1', evidence: { type: 'manual', ref: ['push on a phone'] } }),
      task({ id: 'A-1', evidence: { type: 'test', ref: ['src/a.test.ts'] } }),
      task({ id: 'OK-1', qa_status: 'ok', evidence: { type: 'test', ref: ['src/a.test.ts'] } }),
    ],
  });

  it('look (screenshot and without evidence), the manual round and auto', () => {
    const s = L.qaSplit(queue());
    expect(s.look.flatMap((p) => p.features.flatMap((f) => f.tasks.map((o) => o.id)))).toEqual(['S-1', 'S-2']);
    expect(s.manual.map((o) => o.id)).toEqual(['M-1']);
    expect(s.auto.map((o) => o.id)).toEqual(['A-1']);
  });

  it('the command: the configured one with {refs} and {id}, per type, appended without a placeholder, or an error', () => {
    const o = task({ id: 'A-1', evidence: { type: 'test', ref: ['src/a.test.ts', 'src/b.test.ts'] } });
    expect(L.evidenceCommand(o, QA)).toMatchObject({ error: expect.stringMatching(/qa\.autoCommand is not set/) });
    expect(L.evidenceCommand(o, L.qaConfig({ autoCommand: 'npx vitest run {refs} --tag {id}' }))).toEqual({
      command: 'npx vitest run src/a.test.ts src/b.test.ts --tag A-1',
    });
    expect(L.evidenceCommand(o, L.qaConfig({ autoCommand: { test: 'npm test --' } }))).toEqual({
      command: 'npm test -- src/a.test.ts src/b.test.ts',
    });
    expect(L.evidenceCommand(task({ evidence: { type: 'screenshot', ref: [] } }), QA)).toMatchObject({
      error: expect.stringMatching(/no test evidence/),
    });
  });

  it('green closes the entry (qa_ok_by auto); red stays with a remark', () => {
    const q = queue();
    expect(L.qaAutoOutcome(q, 'A-1', false, ISO)).toEqual({ closed: false });
    const a = q.tasks.find((o) => o.id === 'A-1')!;
    expect(a.qa_status).toBe('waiting');
    expect(a.remarks).toEqual([`${ISO} QA auto red: test src/a.test.ts`]);
    expect(L.qaAutoOutcome(q, 'A-1', true, ISO)).toEqual({ closed: true });
    expect(a).toMatchObject({ qa_status: 'ok', qa_ok: ISO, qa_ok_by: 'auto', qa_note: 'green test src/a.test.ts' });
    expect(L.qaAutoOutcome(q, 'A-1', true, ISO)).toMatchObject({ error: expect.stringMatching(/not waiting on QA/) });
    expect(L.qaAutoOutcome(q, 'S-1', true, ISO)).toMatchObject({ error: expect.stringMatching(/no test evidence/) });
    expect(L.qaAutoOutcome(q, 'NONE', true, ISO)).toMatchObject({ error: 'unknown task NONE' });
  });

  it('the evidence comes along when the task is done and lands in the QA list', () => {
    const o = task({ status: 'review', qa_status: undefined, evidence: { type: 'test', ref: ['a.test.ts'] } });
    expect(L.setStatus(o, 'done', ISO).qa).toBe(true);
    expect(L.qaSplit({ tasks: [o] }).auto.map((x) => x.id)).toEqual(['V-1']);
  });
});

// ---- queue.mjs qa evidence and qa auto against a temporary data folder --------------------------------------------
describe('queue.mjs qa evidence and qa auto', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder = '';
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_ROOT: folder,
          QUEUE_CONFIG: join(folder, 'queue.config.json'),
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
  const find = (id: string): Task =>
    (JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')) as Queue).tasks.find((o) => o.id === id)!;
  const config = (qa: Record<string, unknown>) =>
    writeFileSync(join(folder, 'queue.config.json'), JSON.stringify({ qa }));

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-qa-evidence-'));
    // Two "tests" the command runs: one green and one red (exit code only).
    writeFileSync(join(folder, 'green.mjs'), 'process.exit(0);\n');
    writeFileSync(join(folder, 'red.mjs'), 'process.exit(1);\n');
    const base = { domain: 'client', class: 'K', status: 'done', mission: 'x', labels: ['visual'], qa_status: 'waiting' };
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        tasks: [
          { ...base, id: 'G-1', title: 'green' },
          { ...base, id: 'R-1', title: 'red' },
          { ...base, id: 'S-1', title: 'look', evidence: { type: 'screenshot', ref: ['/home'] } },
        ],
        limits: {},
        next_migr: 100,
      }),
    );
    config({ autoCommand: 'node {refs}' });
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('qa evidence sets the evidence and refuses an invalid one', () => {
    expect(run(['qa', 'evidence', 'G-1', 'test=green.mjs']).out).toMatch(/G-1: evidence test green\.mjs/);
    expect(find('G-1').evidence).toEqual({ type: 'test', ref: ['green.mjs'] });
    const bad = run(['qa', 'evidence', 'G-1', 'photo']);
    expect(bad.code).toBe(1);
    expect(bad.error).toMatch(/screenshot, test, manual/);
    expect(run(['qa', 'evidence', 'NONE', 'screenshot']).error).toMatch(/Unknown task NONE/);
  });

  it('qa lists by evidence; qa auto lists, and --run closes the green and keeps the red', () => {
    run(['qa', 'evidence', 'G-1', 'test=green.mjs']);
    run(['qa', 'evidence', 'R-1', 'test=red.mjs']);
    const list = run(['qa']).out;
    expect(list).toMatch(/QA list: 3 finished task\(s\) waiting on QA/);
    expect(list).toMatch(/S-1 .* screenshot \/home/);
    expect(list).toMatch(/Closed automatically when the command is green \(2\)/);

    const dry = run(['qa', 'auto']).out;
    expect(dry).toMatch(/G-1 +test green\.mjs/);
    expect(dry).toMatch(/qa auto --run/);
    expect(find('G-1').qa_status).toBe('waiting');

    const r = run(['qa', 'auto', '--run']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/G-1 +green, QA ok \(auto\)/);
    expect(r.out).toMatch(/R-1 +red \(exit 1\), stays in the QA list/);
    expect(find('G-1')).toMatchObject({ qa_status: 'ok', qa_ok_by: 'auto' });
    expect(find('R-1').qa_status).toBe('waiting');
    expect(find('R-1').remarks?.[0]).toMatch(/QA auto red: test red\.mjs/);
    expect(find('S-1').qa_status).toBe('waiting');
  });

  it('qa auto --run without a configured command refuses and changes nothing', () => {
    config({});
    run(['qa', 'evidence', 'G-1', 'test=green.mjs']);
    const r = run(['qa', 'auto', '--run']);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/qa\.autoCommand is not set/);
    expect(find('G-1').qa_status).toBe('waiting');
  });
});
