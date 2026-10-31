/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardTaskEdit.test.ts: the detail panel shows "Edit" and "Cancel task" for a waiting task, "Edit" and
// "Decline" for a proposal, and for a running or review task no cancel button but the CLI command (instead of
// "No actions for this status"). The confirm step sends POST /api/task-edit only after "Yes". The whole board runs in
// jsdom with a small synthetic queue (no real data); the server side is tested in queueTaskEdit.test.ts.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');

function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  const task = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Task ${id}`,
    domain: 'ui',
    class: 'K',
    value: 6,
    content_min: 90,
    status,
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso,
    ...extra,
  });
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('EX-1', 'waiting'),
      task('EX-2', 'proposed', { added_by: 'EX-9' }),
      task('EX-3', 'running', { branch: 'queue/EX-3', started: iso }),
      task('EX-4', 'review', { branch: 'queue/EX-4', started: iso, delivered: iso }),
    ],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const posts: { path: string; body: any }[] = [];

beforeAll(async () => {
  const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false } };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') posts.push({ path: filePath, body: JSON.parse(init.body ?? '{}') });
    return {
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : filePath === '/api/task-edit'
            ? { ok: true, log: 7 }
            : {},
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board.js'])
    (0, eval)(readFileSync(join(CLIENT, f), 'utf8'));
  await flush();
}, 60_000);

const panel = () => document.getElementById('panel') as HTMLElement;
async function open(id: string) {
  // "Proposed" is a closed section by default: open it (its cards are built on toggle).
  for (const d of document.querySelectorAll('details.section:not([open])') as NodeListOf<HTMLDetailsElement>) {
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
  }
  await flush();
  const card = document.querySelector(`.summary[data-id="${id}"]`) as HTMLElement;
  expect(card, id).not.toBeNull();
  (card.querySelector('.summary-button') as HTMLButtonElement).click();
  await flush();
  expect(panel().hidden).toBe(false);
}
const buttons = () =>
  [...panel().querySelectorAll('.actions button')].map((b) => (b.textContent ?? '').trim());

describe('cancel, decline and edit in the detail panel', () => {
  it('a waiting task has Edit and Cancel task; a proposal has Edit and Decline', async () => {
    await open('EX-1');
    expect(buttons()).toEqual(expect.arrayContaining(['Edit', 'Cancel task']));
    expect(buttons()).not.toContain('Decline');
    await open('EX-2');
    expect(buttons()).toEqual(expect.arrayContaining(['Edit', 'Decline']));
    expect(buttons()).not.toContain('Cancel task');
  });

  it('running and review tasks get the CLI hint, no cancel or edit, and never "No actions for this status"', async () => {
    for (const id of ['EX-3', 'EX-4']) {
      await open(id);
      const actions = panel().querySelector('.actions') as HTMLElement;
      expect(actions.textContent).toContain(`cq set ${id} cancelled --remark`);
      expect(actions.textContent).not.toContain('No actions for this status');
      expect(buttons()).not.toContain('Cancel task');
      expect(buttons()).not.toContain('Edit');
    }
  });

  it('Cancel task asks first; only "Yes" sends POST /api/task-edit with the reason', async () => {
    await open('EX-1');
    const cancel = [...panel().querySelectorAll('.actions button')].find((b) => b.textContent === 'Cancel task') as HTMLButtonElement;
    cancel.click();
    await flush();
    expect(posts.filter((p) => p.path === '/api/task-edit')).toHaveLength(0);
    const reason = panel().querySelector('#cancel-reason') as HTMLInputElement;
    expect(reason).not.toBeNull();
    expect(panel().querySelector('label[for="cancel-reason"]')?.textContent).toMatch(/Reason/);
    reason.value = 'not needed';
    (panel().querySelector('.task-edit button[type="submit"]') as HTMLButtonElement).click();
    await flush();
    expect(posts.filter((p) => p.path === '/api/task-edit')).toEqual([
      { path: '/api/task-edit', body: { type: 'cancel', id: 'EX-1', reason: 'not needed' } },
    ]);
    // "Undo" is offered for exactly that change.
    expect(document.getElementById('undo-message')?.hidden).toBe(false);
  });

  it('Edit opens a labelled form with the task as it is, and Save sends the fields', async () => {
    posts.length = 0;
    await open('EX-2');
    const edit = [...panel().querySelectorAll('.actions button')].find((b) => b.textContent === 'Edit') as HTMLButtonElement;
    edit.click();
    await flush();
    const value = panel().querySelector('#edit-value') as HTMLInputElement;
    const content = panel().querySelector('#edit-content') as HTMLInputElement;
    const klass = panel().querySelector('#edit-class') as HTMLSelectElement;
    expect([value.value, content.value, klass.value]).toEqual(['6', '90', 'K']);
    for (const id of ['edit-value', 'edit-content', 'edit-class'])
      expect(panel().querySelector(`label[for="${id}"]`)).not.toBeNull();
    value.value = '9';
    klass.value = 'D';
    (panel().querySelector('.task-edit button[type="submit"]') as HTMLButtonElement).click();
    await flush();
    expect(posts.filter((p) => p.path === '/api/task-edit')).toEqual([
      {
        path: '/api/task-edit',
        body: { type: 'edit', id: 'EX-2', form: { value: '9', content_min: '90', class: 'D' } },
      },
    ]);
  });
});
