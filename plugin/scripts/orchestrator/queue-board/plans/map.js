// =============================================================
// map.js: the priority map and the deadline band in the Plans room (see docs/board.md).
// Vanilla JS, no build step, no CDN. All text is set with textContent (via el), never innerHTML.
//
// The priority map is the main view for prioritizing: modules as rows, and the columns Now (security, before prod,
// important), Owner, Later and Drop (folded). It sits in the middle of the three panes (`show=map` in the url), with
// the same filters and the same selection as the list, and the detail panel shows the entry you select.
//
// Entries are small chips that move between the columns in the same row (the module follows the project, not changed here):
//   - mouse: drag the chip and release it in another cell in the row,
//   - keyboard: space lifts the chip, left and right arrow move it, space drops it, Esc cancels
//     (as in the focus view); Enter opens the entry in the panel, and up and down arrow move between chips in the cell.
// The moves are batched in a draft (saved in the session, so a reload does not lose it). "Preview" shows what
// changes (POST /api/plan-prioritize with dry; nothing written), and "Save all" saves it all together with the plan
// register's version from the preview (queue.mjs plan prioritize --set-by owner; all or nothing). Drop requires one
// sentence as reason.
//
// The deadline band sits at the top above the panes when you look at the plan entries: a horizontal stripe over the
// next 90 days with deadlines from entries, documents and owner actions in the selection, and what is overdue apart.
//
// The rules (the columns, the draft, the groups for queue.mjs, the deadlines and the rows on the stripe) are the pure
// functions in scripts/lib/queuePlanView.js (window.QueuePlanView, tested in jest). Here is only the view and the interplay.
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;
  const KEY = 'queue-board-key'; // same as board.js (sessionStorage)
  const DRAFT_STORAGE = 'queue-board-plans-map-draft'; // sessionStorage: the draft survives a reload
  const DROP_STORAGE = 'queue-board-plans-map-drop'; // localStorage: the Drop column is open
  const BAND_STORAGE = 'queue-board-plans-deadline-band'; // localStorage: the deadline band is closed

  const k = {
    draft: readDraft(),
    // The preview: null, { loading: true } or the server's answer ({ changes, warnings, error, can, changed }).
    preview: null,
    saves: false,
    // The chip lifted with the keyboard: { id, oid, from } (from = the column when it was lifted, for Esc).
    boosted: null,
    // The chip being dragged with the mouse: { id, oid }.
    drag: null,
    dropOpen: readFlag(DROP_STORAGE),
    bandClosed: readFlag(BAND_STORAGE),
    waitingDrawing: false,
  };

  // ---- Storage in the browser ----
  function readDraft() {
    try {
      const x = JSON.parse(sessionStorage.getItem(DRAFT_STORAGE) ?? 'null');
      return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
    } catch {
      return {};
    }
  }
  function saveDraft() {
    try {
      if (Object.keys(k.draft).length)
        sessionStorage.setItem(DRAFT_STORAGE, JSON.stringify(k.draft));
      else sessionStorage.removeItem(DRAFT_STORAGE);
    } catch {
      /* private mode: the draft applies only on this page */
    }
  }
  function readFlag(key) {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }
  function setFlag(key, val) {
    try {
      if (val) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch {
      /* applies only to this session */
    }
  }

  // Unsaved draft: the browser asks before the page is closed or reloaded (the draft is in the session anyway).
  window.addEventListener('beforeunload', (e) => {
    if (!Object.keys(k.draft).length) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /** The draft has changed: the preview no longer applies. */
  function newDraft(h, draft, { draw = true } = {}) {
    k.draft = draft;
    k.preview = null;
    saveDraft();
    if (draw) h.draw();
  }

  // ---- The write call ----
  async function postJson(body) {
    const key = sessionStorage.getItem(KEY) ?? '';
    const res = await fetch('/api/plan-prioritize', {
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
    if (!res.ok) {
      const e = new Error(answer?.message ?? `HTTP ${res.status}`);
      e.answer = answer;
      throw e;
    }
    return answer;
  }

  async function previewList(h, d) {
    const { changes, error } = V.draftChanges(k.draft, d.entries);
    if (error.length) {
      k.preview = { changes: [], warnings: [], error, can: false, local: true };
      h.draw();
      return;
    }
    if (!changes.length) return;
    k.preview = { loading: true };
    h.draw();
    try {
      const answer = await postJson({ groups: V.draftGroups(changes), dry: true });
      k.preview = answer;
    } catch (e) {
      k.preview = { changes: [], warnings: [], error: [e.message], can: false };
    }
    h.draw({ focus: 'map-preview' });
  }

  async function save(h, d) {
    if (!k.preview?.can || k.saves) return;
    const { changes, error } = V.draftChanges(k.draft, d.entries);
    if (error.length || !changes.length) return;
    k.saves = true;
    h.draw();
    try {
      const answer = await postJson({
        groups: V.draftGroups(changes),
        expect: k.preview.changed ?? null,
      });
      k.draft = {};
      k.preview = null;
      saveDraft();
      h.message(answer?.message ?? 'The priorities are saved.');
    } catch (e) {
      // Draft kept. If the register changed meanwhile, the preview must be run again.
      k.preview = { changes: [], warnings: [], error: [e.message], can: false };
      h.message(e.message, true);
    } finally {
      k.saves = false;
    }
    await h.get(true);
    h.draw();
  }

  // ---- Keyboard and mouse ----
  function move(h, p, to, { draw = true } = {}) {
    newDraft(h, V.moveInDraft(k.draft, p, to), { draw });
  }

  function chipKey(h, e, p, oid) {
    const id = p.id;
    const now = V.columnWithDraft(p, k.draft);
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (k.boosted?.id === id) {
        k.boosted = null;
        si(`${id} released in ${V.mapColumn(now)?.text ?? now}.`);
      } else {
        k.boosted = { id, oid, from: now };
        si(
          `${id} is lifted from ${V.mapColumn(now)?.text ?? now}. Move with left and right arrow, release with space, cancel with Esc.`,
        );
      }
      h.draw({ focus: `chip:${id}` });
      return;
    }
    if (e.key === 'Escape' && k.boosted?.id === id) {
      e.preventDefault();
      const from = k.boosted.from;
      k.boosted = null;
      move(h, p, from, { draw: false });
      si(`Cancelled. ${id} is in ${V.mapColumn(from)?.text ?? from}.`);
      h.draw({ focus: `chip:${id}` });
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const direction = e.key === 'ArrowLeft' ? -1 : 1;
      if (k.boosted?.id === id) {
        const to = V.columnNeighbor(now, direction);
        if (!to) return;
        move(h, p, to, { draw: false });
        si(`${id} in ${V.mapColumn(to).text}.`);
        h.draw({ focus: `chip:${id}` });
        return;
      }
      // Not lifted: focus to the first chip in the neighbor cell in the same row (skips empty cells).
      let col = V.columnNeighbor(now, direction);
      while (col) {
        const template = document.querySelector(
          `.map-cell[data-row="${CSS.escape(oid)}"][data-column="${col}"] .map-chip`,
        );
        if (template) {
          template.focus();
          return;
        }
        col = V.columnNeighbor(col, direction);
      }
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !k.boosted) {
      const chips = [...e.currentTarget.closest('.map-cell').querySelectorAll('.map-chip')];
      const i = chips.indexOf(e.currentTarget);
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (chips[j]) {
        e.preventDefault();
        chips[j].focus();
      }
    }
  }

  // The screen reader announcements (own region, so the toast is not filled on every arrow).
  let siEl = null;
  function si(text) {
    if (siEl?.isConnected) {
      siEl.textContent = '';
      siEl.textContent = text;
    }
  }

  // ---- Priority map (the middle) ----
  /**
   * The middle pane with the map. `match` is the entries from V.mapEntries (same filters as the list, plus the dropped
   * ones for the folded column), `selected` the entry in the panel.
   */
  function middle(h, d, match, selected) {
    const el = h.el;
    const clean = V.cleanDraft(k.draft, d.entries);
    if (Object.keys(clean).length !== Object.keys(k.draft).length) {
      k.draft = clean;
      saveDraft();
    }
    const web = V.mapGrid(match, d.modules, k.draft);
    const columns = web.columns.filter((x) => !x.folded || k.dropOpen);
    const drop = web.columns.find((x) => x.id === 'drop');
    siEl = el('p', { class: 'hidden-for-eye', 'aria-live': 'assertive' });

    let content;
    if (!d.exists)
      content = el('p', {
        class: 'empty',
        text: 'The plan register does not exist yet (scripts/.queue/plans.json).',
      });
    else if (!web.rows.length)
      content = el(
        'div',
        { class: 'empty empty-state' },
        el('p', { text: 'No entries match the filters and the search.' }),
      );
    else
      content = el(
        'div',
        { class: 'map-scroll', 'data-scroll': 'map' },
        el(
          'table',
          {
            class: `map${k.dropOpen ? '' : ' map-drop-folded'}`,
            'aria-label': 'Priority map: areas by priority',
            'aria-describedby': 'map-help',
          },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { scope: 'col', class: 'map-corner', text: 'Area' }),
              ...columns.map((col) => columnHeader(h, d, col)),
              k.dropOpen ? null : columnHeader(h, d, drop),
            ),
          ),
          el('tbody', {}, ...web.rows.map((r) => rowEl(h, d, r, columns, selected))),
        ),
      );

    return el(
      'section',
      { class: 'plans-middle map-middle', 'aria-label': 'Priority map', 'data-scroll': 'list' },
      h.activeFilters(d),
      el('p', {
        id: 'map-help',
        class: 'map-help',
        text:
          'Drag an entry to another column in the same row, or lift it with space and move it with the arrow keys. ' +
          'The changes are batched in a draft that you review before everything is saved together. Enter opens the entry.',
      }),
      siEl,
      draftEl(h, d),
      content,
      web.withoutPriority.length
        ? el('p', {
            class: 'map-remark',
            text: `${web.withoutPriority.length} entries have an unknown priority and are not in the map (see the list).`,
          })
        : null,
    );
  }

  function columnHeader(h, d, col) {
    const el = h.el;
    const rules = V.columnRules(d.rules, col.id);
    const help = rules.length
      ? `Rule ${rules.map((r) => `${r.nr} (${r.name})`).join(', ')} in the priority rules`
      : '';
    if (col.folded) {
      return el(
        'th',
        { scope: 'col', class: 'map-column col-drop' },
        el(
          'button',
          {
            type: 'button',
            class: 'map-fold',
            'aria-expanded': k.dropOpen ? 'true' : 'false',
            'data-focus': 'map-drop',
            title: help || null,
            onclick: () => {
              k.dropOpen = !k.dropOpen;
              setFlag(DROP_STORAGE, k.dropOpen);
              h.draw({ focus: 'map-drop' });
            },
          },
          el('span', { 'aria-hidden': 'true', text: k.dropOpen ? '▾' : '▸' }),
          el('span', { class: 'map-symbol', 'aria-hidden': 'true', text: col.symbol }),
          el('span', { text: col.text }),
          el('span', { class: 'plans-count', text: String(col.count) }),
        ),
      );
    }
    return el(
      'th',
      {
        scope: 'col',
        class: `map-column col-${col.priority}`,
        title: help || null,
      },
      el(
        'span',
        { class: `plans-pri pri-${col.priority}` },
        el('span', { class: 'plans-pri-symbol', 'aria-hidden': 'true', text: col.symbol }),
        el('span', { text: col.text }),
      ),
      el('span', {
        class: 'plans-count',
        text: String(col.count),
        'aria-label': `${col.count} entries`,
      }),
      help ? el('span', { class: 'hidden-for-eye', text: help }) : null,
    );
  }

  function rowEl(h, d, r, columns, selected) {
    const el = h.el;
    const cells = columns.map((col) => cellEl(h, d, r, col, selected));
    if (!k.dropOpen) cells.push(cellEl(h, d, r, V.mapColumn('drop'), selected, true));
    return el(
      'tr',
      { class: 'map-row' },
      el(
        'th',
        { scope: 'row', class: 'map-module' },
        el('span', { class: 'map-module-title', text: r.title }),
        el('span', { class: 'plans-count', text: String(r.count) }),
      ),
      ...cells,
    );
  }

  function cellEl(h, d, r, col, selected, folded = false) {
    const el = h.el;
    const chips = r.cells[col.id] ?? [];
    // Only the cells in the same row accept a drop (the module follows the project, not changed here).
    const dropTemplate = () => k.drag && k.drag.oid === r.oid;
    const td = el('td', {
      class: `map-cell col-${col.priority}${folded ? ' map-cell-folded' : ''}`,
      'data-row': r.oid,
      'data-column': col.id,
      'aria-label': `${r.title}, ${col.text}: ${chips.length} entries`,
      ondragover: (e) => {
        if (!dropTemplate()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        e.currentTarget.classList.add('drop-template');
      },
      ondragleave: (e) => e.currentTarget.classList.remove('drop-template'),
      ondrop: (e) => {
        e.currentTarget.classList.remove('drop-template');
        if (!dropTemplate()) return;
        e.preventDefault();
        const p = d.entries.find((x) => x.id === k.drag.id);
        k.drag = null;
        if (p) {
          move(h, p, col.id, { draw: false });
          si(`${p.id} in ${col.text}.`);
        }
        h.draw({ focus: p ? `chip:${p.id}` : null });
      },
    });
    if (folded) {
      const moved = chips.filter((b) => b.moved).length;
      if (chips.length)
        td.append(
          el('span', {
            class: 'map-folded-tall',
            text: `${chips.length}${moved ? ` (${moved} in draft)` : ''}`,
          }),
        );
      return td;
    }
    if (chips.length)
      td.append(
        el(
          'ul',
          { class: 'map-chips' },
          ...chips.map((b) => el('li', {}, chipEl(h, b, r, col, selected))),
        ),
      );
    return td;
  }

  function chipEl(h, b, r, col, selected) {
    const el = h.el;
    const p = b.entry;
    const isSelected = selected?.id === p.id;
    const boosted = k.boosted?.id === p.id;
    const from = b.moved ? V.mapColumn(b.from) : null;
    const cat =
      p.priority === 'now' && (p.now_category ?? []).length > 1 && !b.moved
        ? ` (also ${p.now_category
            .filter((x) => `now-${x}` !== col.id)
            .map((x) => V.CATEGORY[x] ?? x)
            .join(', ')})`
        : '';
    const label =
      `${p.id} ${p.title}. ${col.text}${cat}` +
      `${from ? `, moved in draft from ${from.text}` : ''}` +
      `${p.size ? `, size ${p.size}` : ''}${p.deadline ? `, deadline ${p.deadline}` : ''}` +
      `${boosted ? ', lifted' : ''}`;
    return el(
      'button',
      {
        type: 'button',
        class: `map-chip${b.moved ? ' moved' : ''}${isSelected ? ' selected' : ''}${boosted ? ' boosted' : ''}`,
        draggable: 'true',
        'data-focus': `chip:${p.id}`,
        'aria-label': label,
        'aria-pressed': boosted ? 'true' : 'false',
        'aria-current': isSelected ? 'true' : null,
        title: `${p.id} ${p.title}`,
        onclick: () => h.selectEntry(p.id),
        onkeydown: (e) => {
          if (e.key === 'Enter') return; // click = select
          chipKey(h, e, p, r.oid);
        },
        ondragstart: (e) => {
          k.drag = { id: p.id, oid: r.oid };
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', p.id);
          e.currentTarget.classList.add('dragged');
        },
        ondragend: () => {
          k.drag = null;
          if (k.waitingDrawing) h.draw();
        },
      },
      b.moved
        ? el('span', { class: 'map-draft-badge', 'aria-hidden': 'true', text: '✎' })
        : null,
      el('span', { class: 'map-chip-id', text: p.id }),
      el('span', { class: 'map-chip-title', text: p.title }),
      p.size
        ? el('span', { class: 'map-chip-est', 'aria-hidden': 'true', text: p.size })
        : null,
      p.deadline
        ? el('span', { class: 'map-chip-deadline', 'aria-hidden': 'true', text: '◷' })
        : null,
    );
  }

  // ---- Draft and preview ----
  function draftEl(h, d) {
    const el = h.el;
    const { changes, error } = V.draftChanges(k.draft, d.entries);
    if (!changes.length && !k.preview) return null;
    const f = k.preview;
    const lines = changes.map((e) =>
      el(
        'li',
        { class: 'map-change' },
        el('span', {
          class: 'map-change-text',
          text: `${e.id} ${e.title}: ${e.fromText} → ${e.toText}`,
        }),
        e.to === 'drop'
          ? el(
              'label',
              { class: 'map-reason' },
              el('span', { text: 'Reason (one sentence)' }),
              el('input', {
                type: 'text',
                maxlength: String(V.REASON_MAX),
                value: e.reason ?? '',
                'data-focus': `reason:${e.id}`,
                'aria-invalid': e.reason ? null : 'true',
                oninput: (ev) => {
                  k.draft = V.setDraftReason(k.draft, e.id, ev.target.value);
                  k.preview = null;
                  saveDraft();
                },
                onchange: () => h.draw({ focus: `reason:${e.id}` }),
              }),
            )
          : null,
        el('button', {
          type: 'button',
          class: 'button-small button-outline',
          text: 'Undo',
          'aria-label': `Undo the move of ${e.id}`,
          onclick: () => {
            const p = d.entries.find((x) => x.id === e.id);
            if (p) move(h, p, e.from);
          },
        }),
      ),
    );

    let previewEl = null;
    if (f?.loading)
      previewEl = el('p', { class: 'map-preview-text', text: 'Fetching preview …' });
    else if (f) {
      const written = (f.changes ?? []).map((x) =>
        el('li', {
          text: `${x.id}: ${x.field === '*' ? 'entry' : x.field} ${val(x.before)} → ${val(x.after)}`,
        }),
      );
      previewEl = el(
        'div',
        {
          class: 'map-preview',
          tabindex: '-1',
          'data-focus': 'map-preview',
          role: 'region',
          'aria-label': 'The preview',
        },
        el('h3', {
          class: 'map-preview-title',
          text: 'Preview (nothing is saved yet)',
        }),
        (f.error ?? []).length
          ? el(
              'ul',
              { class: 'map-error', role: 'alert' },
              ...f.error.map((x) => el('li', { text: x })),
            )
          : null,
        written.length ? el('ul', { class: 'map-written' }, ...written) : null,
        (f.warnings ?? []).length
          ? el(
              'ul',
              { class: 'map-warnings' },
              ...f.warnings.map((x) => el('li', { text: `Warning: ${x}` })),
            )
          : null,
      );
    }

    return el(
      'section',
      { class: 'map-draft', 'aria-label': 'Draft' },
      el(
        'div',
        { class: 'map-draft-header' },
        el('h3', {
          class: 'map-draft-title',
          text: `Draft: ${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`,
        }),
        el('button', {
          type: 'button',
          class: 'button button-muted',
          text: 'Preview',
          'data-focus': 'map-preview',
          disabled: !changes.length || f?.loading || k.saves,
          onclick: () => previewList(h, d),
        }),
        el('button', {
          type: 'button',
          class: 'button button-filled',
          text: k.saves ? 'Saving …' : 'Save all',
          'data-focus': 'map-save',
          disabled: !f?.can || !!error.length || k.saves,
          title: f?.can ? null : 'Preview first',
          onclick: () => save(h, d),
        }),
        el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Discard',
          disabled: k.saves,
          onclick: () => {
            k.boosted = null;
            newDraft(h, {});
            h.message('The draft is discarded.');
          },
        }),
      ),
      lines.length ? el('ul', { class: 'map-changes' }, ...lines) : null,
      previewEl,
    );
  }

  /** A value from the changes (planDiff) as short text. */
  function val(x) {
    if (x == null) return '(empty)';
    if (Array.isArray(x)) return x.length ? x.join(', ') : '(empty)';
    if (typeof x === 'object') return x.title ?? JSON.stringify(x).slice(0, 80);
    return String(x).slice(0, 120);
  }

  // ---- The deadline band ----
  const TYPE = {
    entry: { symbol: '◷', text: 'Deadline on plan entry' },
    owner: { symbol: '?', text: 'Owner action' },
    doc: { symbol: '§', text: 'Document deadline' },
    revision: { symbol: '⟳', text: 'Revision' },
  };

  /**
   * The deadline band above the panes. `ids` is the entries in the selection (null without filter and search: all included).
   */
  function deadlineBand(h, d, ids) {
    const el = h.el;
    const all = V.deadlineElements(d.entries, d.documents, { ids });
    const overdueOnes = all.filter((e) => e.overdue);
    const upcoming = all.filter((e) => !e.overdue);
    const { rows, hidden } = V.deadlineRows(upcoming);
    const scale = V.deadlineScale(new Date(), V.DEADLINE_DAYS);

    const badge = (e, cls) =>
      el(
        'button',
        {
          type: 'button',
          class: `${cls} deadline-${e.type}`,
          '--x': `${(e.share * 100).toFixed(2)}%`,
          'aria-label': V.deadlineText(e),
          title: V.deadlineText(e),
          'data-focus': `deadline:${e.type}:${e.id}`,
          onclick: () => opened(h, e),
        },
        el('span', { class: 'deadline-symbol', 'aria-hidden': 'true', text: TYPE[e.type].symbol }),
        el('span', { class: 'deadline-id', 'aria-hidden': 'true', text: e.id }),
      );
    const listEl = (list) =>
      el(
        'ul',
        { class: 'deadline-list' },
        ...list.map((e) =>
          el(
            'li',
            {},
            el(
              'button',
              { type: 'button', class: 'link-button', onclick: () => opened(h, e) },
              el('span', { 'aria-hidden': 'true', text: `${TYPE[e.type].symbol} ` }),
              V.deadlineText(e),
            ),
          ),
        ),
      );

    const recap = `Deadlines in the next ${V.DEADLINE_DAYS} days: ${upcoming.length}${overdueOnes.length ? `, overdue: ${overdueOnes.length}` : ''}`;
    return el(
      'details',
      {
        class: 'deadlineBand',
        open: !k.bandClosed,
        ontoggle: (e) => {
          k.bandClosed = !e.currentTarget.open;
          setFlag(BAND_STORAGE, k.bandClosed);
        },
      },
      el(
        'summary',
        { class: 'deadline-band-title', 'data-focus': 'deadlineBand' },
        el('span', { text: recap }),
        ids ? el('span', { class: 'deadline-band-selection', text: '(selection)' }) : null,
      ),
      !all.length
        ? el('p', {
            class: 'empty deadline-band-empty',
            text: 'No deadlines in the selection in the next 90 days.',
          })
        : el(
            'div',
            { class: 'deadline-band-content' },
            overdueOnes.length
              ? el(
                  'div',
                  {
                    class: 'deadline-band-overdue',
                    role: 'group',
                    'aria-label': `Overdue: ${overdueOnes.length}`,
                  },
                  el('span', {
                    class: 'deadline-band-overdue-title',
                    text: `⚠ Overdue (${overdueOnes.length})`,
                  }),
                  el(
                    'div',
                    { class: 'deadline-band-overdue-badges' },
                    ...overdueOnes.map((e) => badge(e, 'deadline-badge deadline-overdue')),
                  ),
                )
              : null,
            el(
              'div',
              {
                class: 'deadline-band-stripe',
                role: 'group',
                'aria-label': `The next ${V.DEADLINE_DAYS} days, in date order`,
                '--rows': String(Math.max(1, rows.length)),
              },
              ...rows.flatMap((row, i) =>
                row.map((e) => {
                  const b = badge(e, 'deadline-badge');
                  b.style.setProperty('--row', String(i));
                  return b;
                }),
              ),
              el(
                'div',
                { class: 'deadline-band-scale', 'aria-hidden': 'true' },
                ...scale.map((s) =>
                  el('span', {
                    class: 'deadline-band-line',
                    '--x': `${(s.share * 100).toFixed(2)}%`,
                    text: s.text,
                  }),
                ),
              ),
            ),
            hidden.length
              ? el(
                  'details',
                  { class: 'deadline-band-more' },
                  el('summary', { text: `+${hidden.length} more (close together)` }),
                  listEl(hidden),
                )
              : null,
            el(
              'p',
              { class: 'deadline-band-draw' },
              ...Object.values(TYPE).map((t) =>
                el(
                  'span',
                  { class: 'deadline-band-draw-part' },
                  el('span', { 'aria-hidden': 'true', text: t.symbol }),
                  ` ${t.text}`,
                ),
              ),
            ),
          ),
    );
  }

  /** Click on a badge: the entry (the owner action in the Decisions tab) or the document. */
  function opened(h, e) {
    if (e.doc) h.selectDoc(e.doc);
    else if (e.entry) h.selectEntry(e.entry, e.type === 'owner' ? 'decisions' : 'summary');
  }

  window.QueuePlanMap = {
    middle,
    deadlineBand,
    /** A drag or a lifted chip in progress: an update from the server waits until it is done. */
    busy() {
      // A lifted chip counts only as long as it has focus (Tab away drops it where it is).
      if (k.boosted && document.activeElement?.dataset?.focus !== `chip:${k.boosted.id}`)
        k.boosted = null;
      const x = !!(k.drag || k.boosted);
      if (x) k.waitingDrawing = true;
      return x;
    },
    doneDrawn() {
      k.waitingDrawing = false;
    },
    hasDraft: () => Object.keys(k.draft).length > 0,
  };
})();
