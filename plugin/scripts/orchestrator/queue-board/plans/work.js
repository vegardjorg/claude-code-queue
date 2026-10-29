// =============================================================
// work.js: efficient work in the Plans room (see docs/board.md).
// Vanilla JS, no build step, no CDN. All text is set with textContent (via h.el), never innerHTML.
//
//   - Keyboard in the list: j and k move, Enter opens the panel, / jumps to the search, 1 to 4 set the priority (Now,
//     Later, Owner, Drop; Now asks for a category and Drop for a reason in the row menu), c copies the start line (for
//     all chosen when something is selected), x marks the row for multi select, Esc clears the selection.
//   - Ctrl+K (Cmd+K): the command line. Jumps to a module, project or entry (the matches show the breadcrumb, recently
//     used at the top) and runs actions such as "Copy start line for all chosen" and "Prepare for queue".
//   - Multi select: the action bar at the bottom (priority, project, maturity, merge and copy) with a preview before
//     saving, and "Undo" afterwards (POST /api/plan-bulk and /api/plan-undo; queue.mjs does the writing with the same
//     lock, --expect-changed and changelog as the queue).
//   - The row menu: priority and maturity for one entry, saved with --expect-changed and with "Undo".
//   - "Changed by session": entries a Claude Code session has changed get a short marker when the live update fetches them.
// The rules (keys, the neighbor entry, the command line matches, the calls and the undo) are the pure functions in
// queuePlanView.js; here is only the drawing and the interplay. `h` is the helpers from plans.js (workHelp).
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;
  const KEY = 'queue-board-key'; // same as board.js (sessionStorage)
  const RECENT_STORAGE = 'queue-board-plans-recent';
  const CHANGED_MS = 12_000; // how long "changed by session" shows

  const a = {
    h: null,
    marked: new Set(),
    changed: new Map(), // entry id → { by, to }
    menu: null, // { id, mode: 'main' | 'drop' }
    reason: '',
    bulk: {
      action: 'priority',
      priority: 'now',
      category: 'important',
      reason: '',
      project: '',
      maturity: 'ready',
      to: '',
    },
    preview: null,
    saves: false,
    last: null, // { log: number[], text } for "Undo"
    palette: { open: false, search: '', selected: 0, match: [], back: null },
    recentOnes: readRecent(),
  };

  function readRecent() {
    try {
      const x = JSON.parse(localStorage.getItem(RECENT_STORAGE) ?? '[]');
      return V.addToRecent(Array.isArray(x) ? x : [], null);
    } catch {
      return [];
    }
  }
  function saveRecent() {
    try {
      localStorage.setItem(RECENT_STORAGE, JSON.stringify(a.recentOnes));
    } catch {
      /* private mode: applies only to this session */
    }
  }

  /** Is the element a place where you type (where letter keys should write, not control)? */
  function inputField(e) {
    if (!e) return false;
    if (e.isContentEditable) return true;
    const tag = e.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(e.type);
  }

  // ---- The write calls ----
  async function postJson(filePath, body) {
    const key = sessionStorage.getItem(KEY) ?? '';
    const res = await fetch(filePath, {
      method: 'POST',
      headers: { 'X-Queue-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
    if (!res.ok) throw new Error(answer?.message ?? `HTTP ${res.status}`);
    return answer;
  }

  /** One change straight from the row or keys: saved with --expect-changed against the register you see, and can be undone. */
  async function saveDirect(h, body) {
    const d = h.data();
    try {
      const answer = await postJson('/api/plan-bulk', { ...body, expect: d?.changed ?? null });
      a.last = { log: answer.log ?? [], text: answer.message ?? 'Saved.' };
      h.message(answer.message ?? 'Saved.');
    } catch (e) {
      h.message(e.message, true);
    }
    await h.get(true);
    h.draw();
  }

  async function undo(h) {
    if (!a.last?.log?.length) return;
    try {
      const answer = await postJson('/api/plan-undo', { nr: a.last.log });
      h.message(answer.message ?? 'Undone.');
      a.last = null;
    } catch (e) {
      h.message(`Could not undo: ${e.message}`, true);
    }
    await h.get(true);
    h.draw({ focus: 'option-action' });
  }

  // ---- Multi select ----
  /** The marked entries in the list's order (those that no longer exist are removed). */
  function marked(h) {
    const d = h.data();
    const exists = new Set((d?.entries ?? []).map((p) => p.id));
    for (const id of [...a.marked]) if (!exists.has(id)) a.marked.delete(id);
    const orderState = (d?.entries ?? []).map((p) => p.id);
    return orderState.filter((id) => a.marked.has(id));
  }

  function toggleMarked(h, id, focus) {
    if (a.marked.has(id)) a.marked.delete(id);
    else a.marked.add(id);
    a.preview = null;
    h.draw({ focus });
  }

  function emptyOption(h) {
    a.marked.clear();
    a.preview = null;
    h.draw();
  }

  function bulkBody(h) {
    const m = a.bulk;
    const ids = marked(h);
    if (m.action === 'priority')
      return {
        action: 'priority',
        ids,
        priority: m.priority,
        category: m.priority === 'now' ? m.category : null,
        reason: m.priority === 'drop' ? m.reason : null,
      };
    if (m.action === 'project')
      return { action: 'project', ids, project: m.project || null };
    if (m.action === 'maturity') return { action: 'maturity', ids, maturity: m.maturity };
    return { action: 'combine', ids, to: ids.includes(m.to) ? m.to : (ids[0] ?? '') };
  }

  async function previewList(h) {
    const body = bulkBody(h);
    a.preview = { loading: true };
    h.draw();
    try {
      a.preview = {
        ...(await postJson('/api/plan-bulk', { ...body, dry: true })),
        body: JSON.stringify(body),
      };
    } catch (e) {
      a.preview = { changes: [], warnings: [], error: [e.message], can: false };
    }
    h.draw({ focus: 'option-preview' });
  }

  async function saveBulk(h) {
    const body = bulkBody(h);
    if (!a.preview?.can || a.saves || a.preview.body !== JSON.stringify(body)) return;
    a.saves = true;
    h.draw();
    try {
      const answer = await postJson('/api/plan-bulk', { ...body, expect: a.preview.changed ?? null });
      a.last = { log: answer.log ?? [], text: answer.message ?? 'Saved.' };
      a.preview = null;
      h.message(answer.message ?? 'Saved.');
    } catch (e) {
      a.preview = { changes: [], warnings: [], error: [e.message], can: false };
      h.message(e.message, true);
    } finally {
      a.saves = false;
    }
    await h.get(true);
    h.draw({ focus: 'option-undo' });
  }

  function copySelected(h) {
    const d = h.data();
    const ids = marked(h);
    const t = h.state();
    const list = ids.length ? ids : t.entry ? [t.entry] : [];
    if (!list.length) {
      h.message('Select an entry or mark several with x first.', true);
      return;
    }
    h.copy(V.startLines(list, d));
  }

  /** A small select field with a label. */
  function option(h, label, val, alternatives, edit, focus) {
    return h.el(
      'label',
      { class: 'plans-option-field' },
      h.el('span', { class: 'plans-option-label', text: label }),
      h.el(
        'select',
        {
          'data-focus': focus,
          onchange: (e) => {
            edit(e.target.value);
            a.preview = null;
            h.draw({ focus });
          },
        },
        ...alternatives.map(([v, text]) =>
          h.el('option', { value: v, selected: v === val ? true : null, text }),
        ),
      ),
    );
  }

  function valueText(x) {
    if (x == null) return 'none';
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) return x.join(', ') || 'none';
    return x.title ?? x.id ?? 'entry';
  }

  function previewEl(h) {
    const f = a.preview;
    if (!f) return null;
    if (f.loading)
      return h.el('p', { class: 'map-preview-text', text: 'Fetching preview …' });
    return h.el(
      'div',
      {
        class: 'map-preview plans-option-preview',
        tabindex: '-1',
        'data-focus': 'option-preview',
        role: 'region',
        'aria-label': 'The preview',
      },
      h.el('h3', {
        class: 'map-preview-title',
        text: 'Preview (nothing is saved yet)',
      }),
      (f.error ?? []).length
        ? h.el(
            'ul',
            { class: 'map-error', role: 'alert' },
            ...f.error.map((x) => h.el('li', { text: x })),
          )
        : null,
      (f.changes ?? []).length
        ? h.el(
            'ul',
            { class: 'map-written' },
            ...f.changes.slice(0, 60).map((x) =>
              h.el('li', {
                text: `${x.id}: ${x.field === '*' ? 'entry' : x.field} ${valueText(x.before)} → ${valueText(x.after)}`,
              }),
            ),
          )
        : f.can
          ? h.el('p', { text: 'Nothing changes.' })
          : null,
      (f.warnings ?? []).length
        ? h.el(
            'ul',
            { class: 'map-warnings' },
            ...f.warnings.map((x) => h.el('li', { text: `Warning: ${x}` })),
          )
        : null,
    );
  }

  function optionLine(h, d) {
    const ids = marked(h);
    if (!ids.length && !a.last) return null;
    const m = a.bulk;
    const body = bulkBody(h);
    const outdated = a.preview && !a.preview.loading && a.preview.body !== JSON.stringify(body);
    const parts = [];
    if (ids.length) {
      parts.push(
        h.el('p', { class: 'option-tall', text: `${ids.length} selected` }),
        option(
          h,
          'Edit',
          m.action,
          [
            ['priority', 'Priority'],
            ['project', 'Project'],
            ['maturity', 'Maturity'],
            ['combine', 'Merge'],
          ],
          (v) => (m.action = v),
          'option-action',
        ),
      );
      if (m.action === 'priority') {
        parts.push(
          option(
            h,
            'To',
            m.priority,
            V.PRIORITIES.map((k) => [k, `${V.PRIORITY[k].symbol} ${V.PRIORITY[k].text}`]),
            (v) => (m.priority = v),
            'option-pri',
          ),
        );
        if (m.priority === 'now')
          parts.push(
            option(
              h,
              'Category',
              m.category,
              Object.entries(V.CATEGORY),
              (v) => (m.category = v),
              'option-cat',
            ),
          );
        if (m.priority === 'drop')
          parts.push(
            h.el(
              'label',
              { class: 'plans-option-field' },
              h.el('span', { class: 'plans-option-label', text: 'Reason (one sentence)' }),
              h.el('input', {
                type: 'text',
                maxlength: '500',
                value: m.reason,
                'data-focus': 'option-reason',
                'aria-invalid': m.reason.trim() ? null : 'true',
                oninput: (e) => {
                  m.reason = e.target.value;
                  a.preview = null;
                },
                onchange: () => h.draw({ focus: 'option-reason' }),
              }),
            ),
          );
      } else if (m.action === 'project') {
        const pr = Object.entries(d.projects ?? {})
          .map(([pid, x]) => [pid, x.summary ?? pid])
          .sort((x, y) => x[1].localeCompare(y[1], 'en'));
        parts.push(
          option(
            h,
            'To',
            m.project,
            [['', 'No project'], ...pr],
            (v) => (m.project = v),
            'option-project',
          ),
        );
      } else if (m.action === 'maturity') {
        parts.push(
          option(
            h,
            'To',
            m.maturity,
            V.MATURITY_MANUAL.map((k) => [k, V.MATURITY[k]]),
            (v) => (m.maturity = v),
            'option-mod',
          ),
        );
      } else {
        const to = ids.includes(m.to) ? m.to : ids[0];
        parts.push(
          option(
            h,
            'Into',
            to,
            ids.map((id) => [id, id]),
            (v) => (m.to = v),
            'option-to',
          ),
        );
      }
      parts.push(
        h.el('button', {
          type: 'button',
          class: 'button button-muted',
          text: 'Preview',
          'data-focus': 'option-preview',
          disabled: a.preview?.loading || a.saves ? true : null,
          onclick: () => previewList(h),
        }),
        h.el('button', {
          type: 'button',
          class: 'button button-filled',
          text: a.saves ? 'Saving …' : 'Save',
          'data-focus': 'option-save',
          disabled: !a.preview?.can || outdated || a.saves ? true : null,
          title: a.preview?.can && !outdated ? null : 'Preview first',
          onclick: () => saveBulk(h),
        }),
        h.el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Copy start lines',
          onclick: () => copySelected(h),
        }),
        h.el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Clear selection',
          onclick: () => emptyOption(h),
        }),
      );
    }
    if (a.last)
      parts.push(
        h.el(
          'p',
          { class: 'plans-option-last', role: 'status' },
          a.last.text,
          ' ',
          a.last.log.length
            ? h.el('button', {
                type: 'button',
                class: 'button-small button-outline',
                text: 'Undo',
                'data-focus': 'option-undo',
                onclick: () => undo(h),
              })
            : null,
          h.el('button', {
            type: 'button',
            class: 'button-icon',
            text: '✕',
            'aria-label': 'Hide the message',
            onclick: () => {
              a.last = null;
              h.draw();
            },
          }),
        ),
      );
    return h.el(
      'section',
      { class: 'optionLine plans-option-line', 'aria-label': 'Multi select' },
      ...parts,
      outdated
        ? h.el('p', { class: 'plans-option-last', text: 'The selection has changed: preview again.' })
        : null,
      outdated ? null : previewEl(h),
    );
  }

  // ---- The row menu (priority and maturity) ----
  function closeMenu(h, focus = true) {
    const id = a.menu?.id;
    a.menu = null;
    a.reason = '';
    h.draw({ focus: focus && id ? `rowMenu:${id}` : null });
  }

  function openMenu(h, id, mode = 'main') {
    a.menu = { id, mode };
    a.reason = '';
    h.draw({ focus: mode === 'drop' ? `menu-reason:${id}` : `menu:${id}:0` });
  }

  function selectPriority(h, p, priority, category) {
    a.menu = null;
    saveDirect(h, {
      action: 'priority',
      ids: [p.id],
      priority,
      category: priority === 'now' ? category : null,
      reason: priority === 'drop' ? a.reason : null,
    });
  }

  function menuKey(h, e) {
    const buttons = [...e.currentTarget.querySelectorAll('[role="menuitem"]')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(h);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && buttons.length) {
      e.preventDefault();
      const j =
        i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[j].focus();
    } else if (e.key === 'Tab') {
      closeMenu(h, false);
    }
  }

  function rowMenuEl(h, p) {
    const open = a.menu?.id === p.id;
    const button = h.el('button', {
      type: 'button',
      class: 'button-small button-outline plans-row-menu-button',
      text: 'Edit',
      'aria-haspopup': 'menu',
      'aria-expanded': open ? 'true' : 'false',
      'aria-label': `Edit priority or maturity for ${p.id}`,
      'data-focus': `rowMenu:${p.id}`,
      onclick: (e) => {
        e.stopPropagation();
        if (open) closeMenu(h);
        else openMenu(h, p.id);
      },
    });
    if (!open) return h.el('span', { class: 'plans-row-menu-space' }, button);
    let n = 0;
    const point = (text, selected, perform, extra = {}) =>
      h.el('button', {
        type: 'button',
        role: 'menuitem',
        class: `plans-menu-point${selected ? ' is-selected' : ''}`,
        text: `${selected ? '✓ ' : ''}${text}`,
        'data-focus': `menu:${p.id}:${n++}`,
        onclick: (e) => {
          e.stopPropagation();
          perform();
        },
        ...extra,
      });
    let content;
    if (a.menu.mode === 'drop') {
      content = [
        h.el(
          'label',
          { class: 'plans-option-field' },
          h.el('span', {
            class: 'plans-option-label',
            text: `Drop ${p.id}: reason (one sentence)`,
          }),
          h.el('input', {
            type: 'text',
            maxlength: '500',
            value: a.reason,
            'data-focus': `menu-reason:${p.id}`,
            oninput: (e) => (a.reason = e.target.value),
            onkeydown: (e) => {
              if (e.key === 'Enter' && a.reason.trim()) {
                e.preventDefault();
                selectPriority(h, p, 'drop');
              }
            },
          }),
        ),
        point('Drop with the reason', false, () => {
          if (!a.reason.trim()) h.message('Drop requires one sentence as reason.', true);
          else selectPriority(h, p, 'drop');
        }),
        point('Cancel', false, () => closeMenu(h)),
      ];
    } else {
      const cat = p.priority === 'now' ? (p.now_category ?? []) : [];
      content = [
        h.el('p', { class: 'plans-menu-title', text: 'Priority' }),
        ...Object.entries(V.CATEGORY).map(([k, text]) =>
          point(`${V.PRIORITY.now.symbol} Now · ${text}`, cat.length === 1 && cat[0] === k, () =>
            selectPriority(h, p, 'now', k),
          ),
        ),
        point(`${V.PRIORITY.owner.symbol} Owner`, p.priority === 'owner', () =>
          selectPriority(h, p, 'owner'),
        ),
        point(`${V.PRIORITY.later.symbol} Later`, p.priority === 'later', () =>
          selectPriority(h, p, 'later'),
        ),
        point(`${V.PRIORITY.drop.symbol} Drop …`, p.priority === 'drop', () =>
          openMenu(h, p.id, 'drop'),
        ),
        h.el('p', { class: 'plans-menu-title', text: 'Maturity' }),
        ...V.MATURITY_MANUAL.map((k) =>
          point(V.MATURITY[k], p.maturity_plan === k, () => {
            a.menu = null;
            saveDirect(h, { action: 'maturity', ids: [p.id], maturity: k });
          }),
        ),
      ];
    }
    return h.el(
      'span',
      { class: 'plans-row-menu-space' },
      button,
      h.el(
        'div',
        {
          class: 'plans-row-menu',
          role: 'menu',
          'aria-label': `Edit ${p.id}`,
          onkeydown: (e) => menuKey(h, e),
        },
        ...content,
      ),
    );
  }

  // ---- The command line (Ctrl+K) ----
  let paletteEl = null;
  function buildPalette(h) {
    const search = h.el('input', {
      type: 'text',
      class: 'plans-palette-search',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'plans-palette-list',
      'aria-autocomplete': 'list',
      'aria-label': 'Jump to a module, project or entry, or run an action',
      placeholder: 'Jump to a module, project, entry or action',
      autocomplete: 'off',
      oninput: (e) => {
        a.palette.search = e.target.value.slice(0, 120);
        a.palette.selected = 0;
        drawPalette(h);
      },
    });
    const list = h.el('ul', {
      id: 'plans-palette-list',
      class: 'plans-palette-list',
      role: 'listbox',
    });
    const status = h.el('p', { class: 'hidden-for-eye', 'aria-live': 'polite' });
    const box = h.el(
      'div',
      {
        class: 'plans-palette-box',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Command line',
        onkeydown: (e) => paletteKey(h, e),
      },
      search,
      list,
      h.el('p', {
        class: 'plans-palette-help',
        text: 'Arrow up and down select, Enter goes, Esc closes.',
      }),
      status,
    );
    paletteEl = h.el(
      'div',
      {
        class: 'plans-palette',
        hidden: true,
        onclick: (e) => {
          if (e.target === paletteEl) closePalette();
        },
      },
      box,
    );
    paletteEl._search = search;
    paletteEl._list = list;
    paletteEl._status = status;
    paletteEl._box = box;
    document.body.append(paletteEl);
  }

  function drawPalette(h) {
    const d = h.data();
    a.palette.match = d ? V.paletteMatch(V.paletteCandidates(d), a.palette.search, a.recentOnes) : [];
    if (a.palette.selected >= a.palette.match.length)
      a.palette.selected = Math.max(0, a.palette.match.length - 1);
    const TYPE = { entry: 'Entry', project: 'Project', module: 'Module', action: 'Action' };
    paletteEl._list.replaceChildren(
      ...(d
        ? a.palette.match.map((k, i) =>
            h.el(
              'li',
              {
                id: `plans-palette-${i}`,
                role: 'option',
                class: `plans-palette-match${i === a.palette.selected ? ' active' : ''}`,
                'aria-selected': i === a.palette.selected ? 'true' : 'false',
                onclick: () => run(h, k),
                onmousemove: () => {
                  if (a.palette.selected !== i) {
                    a.palette.selected = i;
                    drawPalette(h);
                  }
                },
              },
              h.el('span', { class: 'badge', text: TYPE[k.type] ?? k.type }),
              h.el('span', { class: 'plans-palette-text', text: k.text }),
              h.el('span', { class: 'plans-palette-path', text: k.path }),
              k.recent ? h.el('span', { class: 'plans-palette-recent', text: 'recent' }) : null,
              k.drop ? h.el('span', { class: 'plans-palette-recent', text: 'dropped' }) : null,
            ),
          )
        : [h.el('li', { class: 'empty', text: 'Fetching the plan register …' })]),
    );
    if (d && !a.palette.match.length)
      paletteEl._list.append(h.el('li', { class: 'empty', text: 'No matches.' }));
    paletteEl._search.setAttribute(
      'aria-activedescendant',
      a.palette.match.length ? `plans-palette-${a.palette.selected}` : '',
    );
    paletteEl._status.textContent = `${a.palette.match.length} matches`;
    paletteEl._list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function openPalette(h) {
    if (!paletteEl) buildPalette(h);
    if (!h.data()) h.get();
    a.palette = { open: true, search: '', selected: 0, match: [], back: document.activeElement };
    paletteEl.hidden = false;
    paletteEl._search.value = '';
    drawPalette(h);
    paletteEl._search.focus();
  }

  function closePalette({ focus = true } = {}) {
    if (!paletteEl || !a.palette.open) return;
    a.palette.open = false;
    paletteEl.hidden = true;
    const t = a.palette.back;
    if (focus && t && document.contains(t)) t.focus();
  }

  function paletteKey(h, e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = a.palette.match.length;
      if (!n) return;
      a.palette.selected = (a.palette.selected + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      drawPalette(h);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const k = a.palette.match[a.palette.selected];
      if (k) run(h, k);
    } else if (e.key === 'Tab') {
      window.QueueA11y?.trapKey?.(e, paletteEl._box);
    }
  }

  /** Runs a match from the command line. */
  function run(h, k) {
    a.recentOnes = V.addToRecent(a.recentOnes, k.sortKey);
    saveRecent();
    closePalette({ focus: false });
    if (!h.isPlans()) h.selectRoom('plans');
    const d = h.data();
    if (k.type === 'entry') {
      h.goToEntry(k.id);
      h.room.querySelector(`[data-focus="entry:${CSS.escape(k.id)}"]`)?.focus();
      return;
    }
    if (k.type === 'module' || k.type === 'project') {
      const f = V.emptyFilter();
      if (k.type === 'module') f.module = [k.id];
      else f.project = [k.id];
      h.goToList({ filter: f, search: '', entry: null });
      return;
    }
    const t = h.state();
    const p = t.entry ? h.entryFor(t.entry) : null;
    if (k.id === 'copy-selected') copySelected(h);
    else if (k.id === 'prepare') {
      if (!p) {
        h.message('Select an entry first (Prepare for queue applies to one entry).', true);
        return;
      }
      const r = V.prepare(p, d);
      h.copy(r.line);
      if (r.warnings.length) h.message(`${r.line}\nMark: ${r.warnings.join(' ')}`, true);
    } else if (k.id === 'overview') h.use({ surface: 'overview' });
    else if (k.id === 'list') h.use({ surface: 'entries', show: 'list' });
    else if (k.id === 'map') h.use({ surface: 'entries', show: 'map' });
    else if (k.id === 'reset') h.newFilter(V.emptyFilter(), { search: '' });
    else if (k.id === 'empty-option') emptyOption(h);
  }

  // ---- The keyboard ----
  function focusEntry(h, id) {
    h.room.querySelector(`[data-focus="entry:${CSS.escape(id)}"]`)?.focus();
  }

  function keyPress(h, e) {
    const t = V.keyAction(e, {
      inputField: inputField(document.activeElement),
      busy: a.palette.open || !!a.menu,
    });
    if (!t) return;
    if (t.type === 'palette') {
      e.preventDefault();
      if (a.palette.open) closePalette();
      else openPalette(h);
      return;
    }
    if (!h.isPlans() || !h.data()) return;
    // Keys work in the room (or when nothing has focus), not in dialogs and the top bar.
    const active = document.activeElement;
    if (active && active !== document.body && !h.room.contains(active)) return;
    const tl = h.state();
    if (t.type === 'cancel') {
      if (a.marked.size) {
        e.preventDefault();
        emptyOption(h);
      }
      return;
    }
    if (tl.surface !== 'entries' || tl.show === 'map') return;
    // The row with focus applies (otherwise the chosen one), so x and c work where you are.
    const rowId = active?.closest?.('.plans-entry[data-entry]')?.dataset.entry ?? tl.entry;
    if (t.type === 'move') {
      e.preventDefault();
      const next = V.neighborEntry(h.visibleEntries(), rowId, t.direction);
      if (!next) return;
      h.selectEntry(next);
      focusEntry(h, next);
    } else if (t.type === 'opened') {
      if (!rowId) return;
      const onRow = active?.classList?.contains('plans-entry-button');
      if (!onRow && active && active !== document.body) return; // Enter on another button does what that button does
      // On the row the button's own click selects the entry; here focus only moves to the panel afterwards.
      if (!onRow && rowId !== tl.entry) h.selectEntry(rowId, { push: true });
      setTimeout(() => h.room.querySelector('.plans-tabs [aria-selected="true"]')?.focus(), 0);
    } else if (t.type === 'search') {
      e.preventDefault();
      const f = h.room.querySelector('[data-focus="search"]');
      f?.focus();
      f?.select?.();
    } else if (t.type === 'priority') {
      const p = rowId ? h.entryFor(rowId) : null;
      if (!p) return;
      e.preventDefault();
      const r = V.priorityFromKey(p, t.val);
      if (r.unchanged)
        h.message(`${p.id} already has the priority ${V.PRIORITY[t.val]?.text ?? t.val}.`);
      else if (r.menu === 'now') {
        if (rowId !== tl.entry) h.selectEntry(rowId);
        openMenu(h, p.id);
      } else if (r.menu === 'drop') {
        if (rowId !== tl.entry) h.selectEntry(rowId);
        openMenu(h, p.id, 'drop');
      } else saveDirect(h, { action: 'priority', ...r.group });
    } else if (t.type === 'copy') {
      e.preventDefault();
      if (a.marked.size) copySelected(h);
      else if (rowId && h.entryFor(rowId)) h.copy(V.entryLine(h.entryFor(rowId), h.data()));
    } else if (t.type === 'mark') {
      if (!rowId) return;
      e.preventDefault();
      if (a.marked.has(rowId)) a.marked.delete(rowId);
      else a.marked.add(rowId);
      a.preview = null;
      h.draw({ focus: `entry:${rowId}` });
    }
  }

  // ---- "Changed by session" (live update) ----
  let changedTime = null;
  let notify = null;
  function changed(list) {
    if (!Array.isArray(list) || !list.length) return;
    const to = Date.now() + CHANGED_MS;
    for (const x of list) a.changed.set(x.id, { by: x.by, to });
    if (notify) {
      const ids = list.map((x) => x.id);
      notify.textContent =
        `${ids.length === 1 ? `${ids[0]} was` : `${ids.length} entries were`} changed by session` +
        `${ids.length > 1 ? `: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ' …' : ''}` : ''}.`;
    }
    clearTimeout(changedTime);
    changedTime = setTimeout(() => {
      const now = Date.now();
      for (const [id, x] of [...a.changed]) if (x.to <= now) a.changed.delete(id);
      if (a.h?.isPlans() && !a.menu && !window.QueuePlanMap?.busy()) a.h.draw();
    }, CHANGED_MS + 200);
  }
  const isChanged = (id) => (a.changed.get(id)?.to ?? 0) > Date.now();

  window.QueuePlanWork = {
    /** Connects the keyboard and the command line to the helpers in plans.js (once). */
    install(h) {
      if (a.h) return;
      a.h = h;
      notify = h.el('p', { class: 'hidden-for-eye', 'aria-live': 'polite' });
      document.body.append(notify);
      document.addEventListener('keydown', (e) => keyPress(h, e));
      // A click outside the row menu closes it.
      document.addEventListener('click', (e) => {
        if (a.menu && !e.target.closest?.('.plans-row-menu-space')) closeMenu(h, false);
      });
    },
    /** True while a row menu is open (the live update then waits to draw). */
    busy: () => !!a.menu,
    changed,
    rowClasses: (p) =>
      `${a.marked.has(p.id) ? ' marked' : ''}${isChanged(p.id) ? ' changed-by-session' : ''}${p.active ? ' under-work' : ''}`,
    changedBadge: (p) =>
      isChanged(p.id)
        ? (a.h?.el ?? (() => null))('span', {
            class: 'badge plans-changed',
            text: 'changed by session',
            title: a.changed.get(p.id)?.by ? `Changed by ${a.changed.get(p.id).by}` : null,
          })
        : null,
    markEl: (h, p) =>
      h.el('input', {
        type: 'checkbox',
        class: 'plans-mark',
        checked: a.marked.has(p.id) ? true : null,
        'aria-label': `Mark ${p.id} for multi select`,
        'data-focus': `mark:${p.id}`,
        onchange: () => toggleMarked(h, p.id, `mark:${p.id}`),
      }),
    rowMenuEl: (h, p) => rowMenuEl(h, p),
    optionLine,
  };
})();
