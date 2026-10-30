// =============================================================
// queueHelpers.test.ts: the helper agents (lib/queueHelpers.js) where the rules are enforced.
//
//   - which reviewers a task gets: the fixed ones for the class first (the floor), then the helpers that are on AND hit
//     on class, label, changed path, most of the diff, plan or mission points; a switch in queue.json wins over the config;
//   - an existing config with only `reviewers` (no helpers block) behaves as before for the fixed reviewers;
//   - the measurement per helper (runs, median and sum of minutes, tokens and USD, share, findings) and the empty state;
//   - the board's write (helperSwitchArgs turns { name, enabled } into `cq helpers on|off <name>`, nothing else);
//   - `cq helpers on|off` in queue.mjs against a temporary queue (QUEUE_FOLDER), and the cost from set done keeping the
//     per-agent numbers the measurement reads (queueLogic.sumCost).
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const H = require('../queueHelpers.js');
const KK = require('../queueConfig.js');
const L = require('../queueLogic.js');
const B = require('../queueBoard.js');
/* eslint-enable @typescript-eslint/no-require-imports */

/** The plugin defaults merged with an own config, the way queueConfig.config() does it. */
const conf = (own: object = {}) => KK.merge(KK.STANDARD, own);
const types = (o: object, c: object, x: object = {}) =>
  H.reviewersForTask(o, { config: c, ...x }).map((r: { type: string }) => r.type);

describe('reviewersForTask: the fixed reviewers are the floor, the helpers add to them', () => {
  const c = conf();
  it('K gets nothing, U gets the challenger, D and D+ keep their fixed reviewers', () => {
    expect(types({ class: 'K' }, c)).toEqual([]);
    expect(types({ class: 'U' }, c)).toEqual(['reviewer-challenger']);
    expect(types({ class: 'D' }, c)).toEqual(['reviewer']);
    expect(types({ class: 'D+' }, c)).toEqual(['reviewer', 'reviewer-security']);
  });
  it('labels: bug adds the challenger, visual adds design, both on top of the class floor', () => {
    expect(types({ class: 'D', labels: ['bug'] }, c)).toEqual(['reviewer', 'reviewer-challenger']);
    expect(types({ class: 'K', labels: ['visual'] }, c)).toEqual(['reviewer-design']);
    expect(types({ class: 'D+', labels: ['visual', 'bug'] }, c)).toEqual([
      'reviewer',
      'reviewer-security',
      'reviewer-challenger',
      'reviewer-design',
    ]);
  });
  it('the off helpers (tests, gap, docs) never run, whatever hits', () => {
    const o = { class: 'D', labels: ['bug'], plan: 'PL-1' };
    const t = types(o, c, { changedPaths: ['docs/a.md', 'b.md'], missionText: '1. a\n'.repeat(20) });
    expect(t).not.toContain('reviewer-tests');
    expect(t).not.toContain('reviewer-gap');
    expect(t).not.toContain('reviewer-docs');
  });
  it('each helper gets one line on why it was chosen', () => {
    const r = H.reviewersForTask({ class: 'D', labels: ['visual'] }, { config: c });
    expect(r).toEqual([
      { type: 'reviewer', fixed: true, reasons: ['class D'] },
      { type: 'reviewer-design', fixed: false, reasons: ['label visual'] },
    ]);
  });
});

describe('the conditions: class, label, paths, mostlyPaths, plan, mission points', () => {
  const on = conf({
    helpers: {
      'reviewer-tests': { enabled: true },
      'reviewer-gap': { enabled: true },
      'reviewer-docs': { enabled: true },
      'reviewer-design': { paths: ['app/', 'components/**/*.tsx'] },
    },
  });
  it('tests: class D/D+ or label bug', () => {
    expect(types({ class: 'D+' }, on)).toContain('reviewer-tests');
    expect(types({ class: 'K', labels: ['bug'] }, on)).toContain('reviewer-tests');
    expect(types({ class: 'K' }, on)).not.toContain('reviewer-tests');
  });
  it('design: a changed path under a configured UI path', () => {
    const r = H.reviewersForTask({ class: 'K' }, { config: on, changedPaths: ['app\\x.tsx'] });
    expect(r).toEqual([{ type: 'reviewer-design', fixed: false, reasons: ['changes app/x.tsx'] }]);
    expect(types({ class: 'K' }, on, { changedPaths: ['components/a/b/C.tsx'] })).toContain('reviewer-design');
    expect(types({ class: 'K' }, on, { changedPaths: ['components/a.ts', 'lib/app/x.tsx'] })).not.toContain(
      'reviewer-design',
    );
  });
  it('docs: more than half of the changed files are docs/ or *.md, not exactly half', () => {
    expect(types({ class: 'K' }, on, { changedPaths: ['docs/a.txt', 'README.md', 'x.js'] })).toContain(
      'reviewer-docs',
    );
    expect(types({ class: 'K' }, on, { changedPaths: ['docs/a.txt', 'x.js'] })).not.toContain('reviewer-docs');
    expect(types({ class: 'K' }, on, { changedPaths: [] })).not.toContain('reviewer-docs');
  });
  it('gap: a plan entry, or at least minMissionItems numbered points', () => {
    expect(types({ class: 'K', plan: 'PL-3' }, on)).toContain('reviewer-gap');
    expect(types({ class: 'K' }, on, { missionText: '1. a\n2) b\n'.repeat(4) })).toContain('reviewer-gap');
    expect(types({ class: 'K' }, on, { missionText: '1. a\n2. b\n3. c\n' })).not.toContain('reviewer-gap');
    expect(H.missionItems('1. a\n  12) b\nnot 3. this\n')).toBe(2);
  });
  it('no condition = never runs, even when on', () => {
    const c = conf({ helpers: { 'my-helper': { enabled: true } } });
    expect(types({ class: 'D', labels: ['bug'] }, c)).not.toContain('my-helper');
    expect(H.conditionText(H.helperSetup(c)['my-helper'])).toMatch(/never runs/);
  });
});

describe('the register is open: builtin and custom helpers are treated alike', () => {
  const c = conf({
    helpers: {
      'my-db-check': {
        enabled: true,
        labels: ['db'],
        path: '.claude\\agents\\my-db-check.md',
        sha256: 'AB'.repeat(32),
        title: 'DB check',
        text: 'Checks the migrations.',
      },
      'reviewer-docs': { source: 'custom', path: 'agents/docs.md' },
    },
  });
  it('source is builtin for the shipped agents and custom (with path and sha256) for the rest', () => {
    const s = H.helperSetup(c);
    expect(s['reviewer-design']).toMatchObject({ source: 'builtin', path: null, sha256: null });
    expect(s['my-db-check']).toMatchObject({
      source: 'custom',
      path: '.claude/agents/my-db-check.md',
      sha256: 'ab'.repeat(32),
      title: 'DB check',
      text: 'Checks the migrations.',
    });
    // An explicit source wins; an invalid hash is not kept.
    expect(s['reviewer-docs']).toMatchObject({ source: 'custom', path: 'agents/docs.md', sha256: null });
    expect(H.helperSetup(conf({ helpers: { x: { sha256: 'nope' } } })).x.sha256).toBeNull();
  });
  it('a custom helper is selected, switched and measured exactly like a builtin one', () => {
    expect(types({ class: 'K', labels: ['db'] }, c)).toEqual(['my-db-check']);
    expect(types({ class: 'K', labels: ['db'] }, c, { queue: { helpers: { 'my-db-check': { enabled: false } } } })).toEqual(
      [],
    );
    expect(H.parseSwitch('off', 'my-db-check', c)).toEqual({ name: 'my-db-check', enabled: false });
    expect(H.allReviewerTypes(c)).toContain('my-db-check');
    const row = H.helperRows(c, {}).find((r: { name: string }) => r.name === 'my-db-check');
    expect(row).toMatchObject({ source: 'custom', enabled: true, measurement: 'No runs yet', when: 'When: label db.' });
  });
});

describe('switches and backward compatibility', () => {
  it('a switch in queue.json wins over the config, in both directions', () => {
    const c = conf();
    expect(types({ class: 'U' }, c, { queue: { helpers: { 'reviewer-challenger': { enabled: false } } } })).toEqual(
      [],
    );
    expect(
      types({ class: 'D' }, c, { queue: { helpers: { 'reviewer-tests': { enabled: true } } } }),
    ).toEqual(['reviewer', 'reviewer-tests']);
    // Not a boolean: ignored.
    expect(types({ class: 'U' }, c, { queue: { helpers: { 'reviewer-challenger': { enabled: 'no' } } } })).toEqual([
      'reviewer-challenger',
    ]);
  });
  it('an old config with its own reviewers per class keeps them as fixed, also a helper listed there', () => {
    const c = conf({ reviewers: { U: ['reviewer-challenger'], D: ['reviewer', 'reviewer-security'] } });
    const off = { helpers: { 'reviewer-challenger': { enabled: false } } };
    // Listed in reviewers.U: fixed for U, the switch does not stop it there; it is also not listed twice.
    expect(H.reviewersForTask({ class: 'U' }, { config: c, queue: off })).toEqual([
      { type: 'reviewer-challenger', fixed: true, reasons: ['class U'] },
    ]);
    expect(types({ class: 'U' }, c)).toEqual(['reviewer-challenger']);
    expect(types({ class: 'D' }, c)).toEqual(['reviewer', 'reviewer-security']);
    // D+ comes from the plugin default (objects are merged field by field).
    expect(types({ class: 'D+' }, c)).toEqual(['reviewer', 'reviewer-security']);
    expect(H.fixedClasses(c, 'reviewer-challenger')).toEqual(['U']);
  });
  it('without a config at all the plugin defaults apply (queueLogic falls back to them)', () => {
    expect(H.fixedFor({}, 'D+')).toEqual(['reviewer', 'reviewer-security']);
    expect(types({ class: 'U' }, {})).toEqual([]);
  });
  it('allReviewerTypes has the fixed ones and every helper, on or off (cost, cost guard, read guard)', () => {
    expect(H.allReviewerTypes(conf())).toEqual([
      'reviewer',
      'reviewer-security',
      'reviewer-challenger',
      'reviewer-design',
      'reviewer-tests',
      'reviewer-gap',
      'reviewer-docs',
    ]);
    expect(L.REVIEWER_TYPES).toEqual(expect.arrayContaining(['reviewer-docs', 'reviewer-challenger']));
    expect(L.TASK_AGENT_TYPES).toEqual(expect.arrayContaining(['track', 'track-d', 'reviewer-gap']));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const V = require('../trackGuard.js');
    expect([...V.readRules({}, {}).types]).toEqual(expect.arrayContaining(['reviewer-challenger', 'reviewer-design']));
  });
  it('the review package lists the reviewers with a "why" line each', () => {
    const s = L.reviewPackageIndex({
      o: { id: 'A-1', class: 'D', title: 'x' },
      branch: 'queue/A-1',
      stat: '',
      base: 'main',
      migrFolder: null,
      files: { mission: true },
      reviewers: H.reviewersForTask({ class: 'D', labels: ['visual'] }, { config: conf() }),
    });
    expect(s).toContain('## Reviewers');
    expect(s).toContain('- `reviewer`: fixed for the class. why: class D');
    expect(s).toContain('- `reviewer-design`: helper agent. why: label visual');
    expect(s).toContain('`mission.md`');
  });
});

describe('the measurement per helper', () => {
  const agent = (type: string, usd: number, minutes?: number, tokens?: number, findings?: object) => ({
    agent: `${type}-${usd}`,
    type,
    usd,
    ...(minutes != null ? { minutes } : {}),
    ...(tokens != null ? { tokens } : {}),
    ...(findings ? { findings } : {}),
  });
  const queue = {
    tasks: [
      {
        id: 'A',
        status: 'done',
        done: '2026-10-20T10:00:00Z',
        cost: {
          usd: 10,
          agents: [agent('track', 7), agent('reviewer-challenger', 3, 6, 300_000, { H: 1, M: 0, L: 2 })],
        },
      },
      {
        id: 'B',
        status: 'done',
        done: '2026-10-25T10:00:00Z',
        cost: {
          usd: 20,
          agents: [agent('track-d', 19), agent('reviewer-challenger', 1, 2, 100_000, { H: 0, M: 1, L: 0 })],
        },
      },
      // An older task measured before the per-agent fields: a run with USD only.
      { id: 'C', status: 'done', done: '2026-10-26T10:00:00Z', cost: { usd: 5, agents: [agent('reviewer-challenger', 1)] } },
      // Not done: not counted.
      { id: 'D', status: 'review', cost: { usd: 9, agents: [agent('reviewer-challenger', 9, 9, 9)] } },
    ],
  };
  it('runs, median and sum of minutes, tokens and USD, share of the task cost and findings per run', () => {
    const s = H.helperStatistics(queue, ['reviewer-challenger'])['reviewer-challenger'];
    expect(s.runs).toBe(3);
    expect(s.tasks).toBe(3);
    expect(s.minutes).toEqual({ n: 2, median: 4, sum: 8 });
    expect(s.tokens).toEqual({ n: 2, median: 200_000, sum: 400_000 });
    expect(s.usd).toEqual({ n: 3, median: 1, sum: 5 });
    expect(s.sharePct).toBe(14.3); // 5 of 35
    expect(s.findings).toEqual({ H: 1, M: 1, L: 2, reviewed: 2, perRun: 2 });
    expect(H.measurementText(s)).toContain('3 run(s) on 3 task(s)');
    expect(H.measurementText(s)).toContain('14.3 % of the task cost');
  });
  it('since filters on the done time', () => {
    expect(H.helperStatistics(queue, ['reviewer-challenger'], { since: '2026-10-24T00:00:00Z' })['reviewer-challenger'].runs).toBe(2);
  });
  it('empty state: "No runs yet", no numbers invented', () => {
    const s = H.helperStatistics(queue, ['reviewer-docs'])['reviewer-docs'];
    expect(s).toEqual({
      runs: 0,
      tasks: 0,
      minutes: null,
      tokens: null,
      usd: null,
      sharePct: null,
      findings: { H: 0, M: 0, L: 0, reviewed: 0, perRun: null },
    });
    expect(H.measurementText(s)).toBe('No runs yet');
    expect(H.helperStatistics({}, ['x']).x.runs).toBe(0);
  });
  it('helperRows: one row per helper with the switch, the condition text and the measurement', () => {
    const rows = H.helperRows(conf(), { ...queue, helpers: { 'reviewer-design': { enabled: false } } });
    expect(rows.map((r: { name: string }) => r.name)).toEqual([
      'reviewer-challenger',
      'reviewer-design',
      'reviewer-tests',
      'reviewer-gap',
      'reviewer-docs',
    ]);
    const design = rows[1];
    expect(design.enabled).toBe(false);
    expect(design.switchedInQueue).toBe(true);
    expect(design.when).toBe('When: label visual.');
    expect(design.measurement).toBe('No runs yet');
    expect(rows[0].when).toBe('When: class U or label bug.');
  });
  it('sumCost keeps the per-agent tokens, minutes and findings the measurement reads', () => {
    const k = L.sumCost([
      {
        agent: 'a',
        type: 'reviewer-tests',
        tokens: { input: 10, output: 20, cache_read: 30, cache_written: 40 },
        minutes: 3.33,
        findings: { H: 1, M: 2, L: 3, deferrable: [], line: 'x' },
      },
      { agent: 'b', type: 'track', tokens: { input: 1 }, minutes: null },
    ]);
    expect(k.agents[0]).toMatchObject({ type: 'reviewer-tests', tokens: 100, minutes: 3.3, findings: { H: 1, M: 2, L: 3 } });
    expect(k.agents[1]).not.toHaveProperty('minutes');
    expect(k.agents[1]).not.toHaveProperty('findings');
  });
});

describe('the board write (helperSwitchArgs) and the switch in queue.mjs', () => {
  const names = ['reviewer-design', 'reviewer-tests'];
  it('turns { name, enabled } into cq helpers on|off <name>, and refuses anything else', () => {
    expect(B.helperSwitchArgs({ name: 'reviewer-tests', enabled: true }, names)).toEqual({
      args: ['helpers', 'on', 'reviewer-tests'],
    });
    expect(B.helperSwitchArgs({ name: 'reviewer-design', enabled: false }, names)).toEqual({
      args: ['helpers', 'off', 'reviewer-design'],
    });
    expect(B.helperSwitchArgs({ name: 'reviewer-gap', enabled: true }, names).error).toMatch(/unknown helper/);
    expect(B.helperSwitchArgs({ name: '--json', enabled: true }, [...names, '--json']).error).toMatch(/unknown/);
    expect(B.helperSwitchArgs({ name: 'reviewer-tests', enabled: 'true' }, names).error).toMatch(/true or false/);
    expect(B.helperSwitchArgs(null, names).error).toBeTruthy();
  });

  it('cq helpers on|off writes queue.json under the lock and the list shows it; unknown names are refused', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-helpers-'));
    try {
      const folder = path.join(root, 'q');
      fs.mkdirSync(folder);
      const env = {
        ...process.env,
        QUEUE_ROOT: root,
        QUEUE_FOLDER: folder,
        QUEUE_CONFIG: path.join(root, 'no-config.json'),
        QUEUE_TIME_LOG: path.join(root, 'times.jsonl'),
      };
      const cq = (...args: string[]) =>
        spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'queue.mjs'), ...args], {
          cwd: root,
          encoding: 'utf8',
          env,
        });
      expect(cq('init').status).toBe(0);
      const on = cq('helpers', 'on', 'reviewer-tests');
      expect(on.status, on.stderr).toBe(0);
      expect(on.stdout).toContain('reviewer-tests: on');
      expect(cq('helpers', 'off', 'reviewer-challenger').status).toBe(0);
      const queue = JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'));
      expect(queue.helpers).toEqual({
        'reviewer-tests': { enabled: true },
        'reviewer-challenger': { enabled: false },
      });
      const list = cq('helpers');
      expect(list.stdout).toMatch(/^on {2}reviewer-tests:/m);
      expect(list.stdout).toMatch(/^off reviewer-challenger:/m);
      expect(list.stdout).toContain('No runs yet');
      const json = JSON.parse(cq('helpers', '--json').stdout);
      expect(json.find((r: { name: string }) => r.name === 'reviewer-tests').enabled).toBe(true);
      const bad = cq('helpers', 'on', 'not-a-helper');
      expect(bad.status).not.toBe(0);
      expect(bad.stderr + bad.stdout).toMatch(/not a helper/);
      expect(cq('helpers', 'maybe', 'reviewer-tests').status).not.toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
