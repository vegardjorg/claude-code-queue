/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardHelpers.test.ts: the "Helper agents" tab in the board's settings (board.js). The settings have two real
// tabs (General, Helper agents) with the arrow keys; the helper tab has one row per helper with what it does, when it
// runs, a real checkbox with role switch and a label, and the measurement ("No runs yet" when empty). Flipping the
// switch posts { name, enabled } to /api/helper (the server turns it into `cq helpers on|off`), and a refused write puts
// the switch back and shows the message. The whole board runs in jsdom with a mock server (no network).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const H = require('../queueHelpers.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KK = require('../queueConfig.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');

function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      {
        id: 'A-1',
        title: 'x',
        class: 'U',
        status: 'done',
        done: iso,
        cost: {
          usd: 4,
          agents: [
            { agent: 'a', type: 'track', usd: 3 },
            { agent: 'b', type: 'reviewer-challenger', usd: 1, minutes: 5, tokens: 250_000, findings: { H: 0, M: 1, L: 1 } },
          ],
        },
      },
    ],
    projects: {},
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const config = KK.merge(KK.STANDARD, {});
// Two custom helpers (cq helpers add): db-check approved for the file as it is now, new-check never reviewed.
const SHA = 'ab'.repeat(32);
const custom = (name: string, o: object = {}) => ({
  source: 'custom',
  path: `.claude/agents/${name}.md`,
  sha256: SHA,
  added_at: '2026-10-30T10:00:00.000Z',
  labels: ['db'],
  enabled: false,
  scan: { level: 'yellow', red: 0, yellow: 1, sha256: SHA, at: '2026-10-30T10:00:00.000Z' },
  ...o,
});
let switches: Record<string, object> = {
  'db-check': custom('db-check', { approved_sha256: SHA, approved_path: '.claude/agents/db-check.md', approved_by: 'owner', approved_at: '2026-10-30T11:00:00.000Z' }),
  'new-check': custom('new-check', { scan: { level: 'red', red: 2, yellow: 0, sha256: SHA, at: '2026-10-30T10:00:00.000Z' } }),
};
const hashes = { 'db-check': SHA, 'new-check': SHA };
let refuse = false;
const posts: { path: string; body: any }[] = [];
const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false, update: null } };

function settingsAnswer() {
  return {
    ok: true,
    field: [],
    usageToday: 0,
    night: { active: false },
    setup: { rules: [], rulesSource: 'docs/orchestration.md' },
    helpers: H.helperRows(config, { ...makeQueue(), helpers: switches }, { hashes }),
  };
}

const panel = () => document.getElementById('panel') as HTMLElement;
const tab = (id: string) => document.getElementById(`settings-tab-${id}`) as HTMLButtonElement;
const box = (name: string) => document.getElementById(`helper-${name}`) as HTMLInputElement;

beforeAll(async () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      posts.push({ path: filePath, body });
      if (filePath === '/api/helper') {
        if (refuse) return { ok: false, status: 409, json: async () => ({ ok: false, message: 'the queue is locked' }) };
        switches = { ...switches, [body.name]: { ...(switches[body.name] ?? {}), enabled: body.enabled } };
        return { ok: true, status: 200, json: async () => ({ ok: true, message: 'ok', info: [] }) };
      }
      if (filePath === '/api/helper-add') {
        if (!String(body.path).endsWith('.md'))
          return { ok: false, status: 400, json: async () => ({ ok: false, message: 'the agent file must be a .md file' }) };
        switches = { ...switches, [body.name || 'added']: custom(body.name || 'added') };
        return { ok: true, status: 200, json: async () => ({ ok: true, message: 'Added', info: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (filePath.startsWith('/api/settings')) return { ok: true, status: 200, json: async () => settingsAnswer() };
    if (filePath.startsWith('/api/state'))
      return {
        ok: true,
        status: 200,
        json: async () => (filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state),
      };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueUpdate.js', 'board.js'])
    (0, eval)(readFileSync(join(CLIENT, f), 'utf8'));
  await flush();
  (document.getElementById('settings') as HTMLButtonElement).click();
  await flush();
}, 60_000);

describe('the settings tabs', () => {
  it('are real tabs: General selected first, one tab stop, each controls its panel', () => {
    const list = panel().querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe('Settings');
    expect([...list.querySelectorAll('[role="tab"]')].map((x) => x.textContent)).toEqual(['General', 'Helper agents']);
    expect(tab('general').getAttribute('aria-selected')).toBe('true');
    expect(tab('general').tabIndex).toBe(0);
    expect(tab('helpers').tabIndex).toBe(-1);
    expect(tab('general').getAttribute('aria-controls')).toBe('settings-panel-general');
    expect(document.getElementById('settings-panel-general')?.getAttribute('role')).toBe('tabpanel');
    expect(document.getElementById('settings-panel-helpers')).toBeNull();
  });

  it('ArrowRight moves to Helper agents, selects it and keeps focus on the tab; the choice is remembered', async () => {
    tab('general').focus();
    tab('general').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(tab('helpers').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('helpers'));
    expect(document.getElementById('settings-panel-helpers')?.getAttribute('aria-labelledby')).toBe(
      'settings-tab-helpers',
    );
    expect(localStorage.getItem('queue-board-settings-tab')).toBe('helpers');
  });
});

describe('the Helper agents tab', () => {
  it('has one row per helper with what it does, when it runs, a labelled switch and the measurement', () => {
    const rows = [...panel().querySelectorAll('.helper-row')] as HTMLElement[];
    expect(rows.map((r) => r.dataset.helper)).toEqual([
      'reviewer-challenger',
      'reviewer-design',
      'reviewer-tests',
      'reviewer-gap',
      'reviewer-docs',
      'db-check',
      'new-check',
    ]);
    const b = box('reviewer-challenger');
    expect(b.type).toBe('checkbox');
    expect(b.getAttribute('role')).toBe('switch');
    expect(b.checked).toBe(true);
    expect(box('reviewer-tests').checked).toBe(false);
    const label = panel().querySelector('label[for="helper-reviewer-challenger"]') as HTMLLabelElement;
    expect(label.textContent).toContain('Challenger');
    expect(label.textContent).toContain('reviewer-challenger');
    // The description, the condition and the measurement describe the switch.
    const described = (b.getAttribute('aria-describedby') ?? '').split(' ');
    const texts = described.map((id) => document.getElementById(id)?.textContent ?? '');
    expect(texts[0]).toMatch(/prove the delivery wrong/);
    expect(texts[1]).toBe('When: class U or label bug.');
    expect(texts[2]).toContain('1 on 1 task(s)');
    expect(texts[2]).toContain('H=0 M=1 L=1');
  });

  it('a helper without runs says "No runs yet"', () => {
    expect(document.getElementById('helper-reviewer-docs-measure')?.textContent).toBe('No runs yet');
  });

  it('flipping a switch posts { name, enabled } to /api/helper and redraws from the server', async () => {
    const b = box('reviewer-tests');
    b.checked = true;
    b.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(posts.at(-1)).toEqual({ path: '/api/helper', body: { name: 'reviewer-tests', enabled: true } });
    expect(box('reviewer-tests').checked).toBe(true);
    expect(box('reviewer-tests').disabled).toBe(false);
  });

  it('a refused write puts the switch back and shows the message by the row', async () => {
    refuse = true;
    const b = box('reviewer-design');
    b.checked = false;
    b.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    refuse = false;
    expect(b.checked).toBe(true);
    const err = b.closest('.helper-row')?.querySelector('.setting-error') as HTMLElement;
    expect(err.hidden).toBe(false);
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toBe('the queue is locked');
  });
});

describe('custom helpers in the tab', () => {
  const row = (name: string) => panel().querySelector(`.helper-row[data-helper="${name}"]`) as HTMLElement;

  it('an approved custom helper: custom, scan and Approved badges, who approved it, and a working switch', () => {
    const r = row('db-check');
    const badges = [...r.querySelectorAll('.helper-badges .badge')].map((b) => b.textContent);
    expect(badges).toEqual(['custom', 'Scan: yellow', 'Approved']);
    expect(r.querySelector('.helper-review')?.getAttribute('data-review')).toBe('approved');
    expect(box('db-check').disabled).toBe(false);
    expect(document.getElementById('helper-db-check-review')?.textContent).toMatch(/^Approved by owner on \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./);
    expect(box('db-check').getAttribute('aria-describedby')).toContain('helper-db-check-review');
  });

  it('a custom helper that needs review: off, the switch disabled with the reason, Needs review and the red scan', () => {
    const r = row('new-check');
    const b = box('new-check');
    expect(b.checked).toBe(false);
    expect(b.disabled).toBe(true);
    expect(r.classList.contains('helper-locked')).toBe(true);
    const badges = [...r.querySelectorAll('.helper-badges .badge')].map((x) => x.textContent);
    expect(badges).toEqual(['custom', 'Scan: red', 'Needs review']);
    const why = document.getElementById('helper-new-check-review')?.textContent ?? '';
    expect(why).toContain('Not approved yet.');
    expect(why).toContain('review the helper agent new-check');
    expect(why).toContain('never done from the board');
    // The reason describes the switch, so a screen reader hears why it is disabled.
    expect(b.getAttribute('aria-describedby')?.split(' ')).toContain('helper-new-check-review');
  });

  it('a file changed since approval: Changed since approval, the switch off and disabled', async () => {
    switches = { ...switches, 'db-check': { ...(switches['db-check'] as object), enabled: true } };
    (hashes as Record<string, string>)['db-check'] = 'cd'.repeat(32);
    // Open the settings again: the rows are fetched from the server (the tab is remembered).
    (document.getElementById('settings') as HTMLButtonElement).click();
    await flush();
    const r = row('db-check');
    expect(r.querySelector('.helper-review')?.textContent).toBe('Changed since approval');
    expect(r.querySelector('.helper-scan')?.textContent).toBe('Scan: yellow (older file)');
    expect(box('db-check').checked).toBe(false);
    expect(box('db-check').disabled).toBe(true);
    expect(document.getElementById('helper-db-check-review')?.textContent).toContain('for an earlier version of the file');
  });

  it('there is no approve control anywhere in the tab', () => {
    const text = [...panel().querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(text.some((t) => /approve/i.test(t))).toBe(false);
  });

  it('Add helper posts the pasted path (and name) to /api/helper-add and redraws with the new row', async () => {
    const file = document.getElementById('helper-add-path') as HTMLInputElement;
    const name = document.getElementById('helper-add-name') as HTMLInputElement;
    expect(document.querySelector('label[for="helper-add-path"]')?.textContent).toBe('Path to the agent file');
    file.value = '  C:\\agents\\lint-check.md ';
    name.value = 'lint-check';
    (document.getElementById('helper-add') as HTMLButtonElement).click();
    await flush();
    expect(posts.at(-1)).toEqual({ path: '/api/helper-add', body: { path: 'C:\\agents\\lint-check.md', name: 'lint-check' } });
    expect(row('lint-check')).toBeTruthy();
    expect(box('lint-check').disabled).toBe(true);
  });

  it('a refused add shows the message by the field', async () => {
    const file = document.getElementById('helper-add-path') as HTMLInputElement;
    file.value = 'notes.txt';
    (document.getElementById('helper-add') as HTMLButtonElement).click();
    await flush();
    const err = document.getElementById('helper-add-error') as HTMLElement;
    expect(err.hidden).toBe(false);
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toBe('the agent file must be a .md file');
  });
});
