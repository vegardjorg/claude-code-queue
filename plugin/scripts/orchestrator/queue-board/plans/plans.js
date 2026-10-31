// =============================================================
// plans.js: the Plans room on the queue board (see docs/board.md).
// Vanilla JS, no build step, no CDN.
//
// The board has two workspaces at the top: Plans and Queue. The room is in the url (`?room=plans`), together with the
// filters, the search, the selected entry and the tab, so the back button and bookmarks work. The Queue room is
// today's board (board.js), unchanged.
//
// Plans has three panes: filters with match counts (left), a foldable list module › project › entry with rolled-up
// progress (middle) and the detail panel with tabs (right). Above them sits the breadcrumb with copy buttons.
// All the rules (url, the facets, the tree, path, the copy lines, the queue status) are the pure functions in
// scripts/lib/queuePlanView.js (window.QueuePlanView, tested in jest); here is only the view and the interplay.
//
// Reading: GET /api/plans (plans.json and queue.json, read only, with a version so unchanged data is not sent again).
// The room writes nothing: changes to the plan register are made with `queue.mjs plan …` (and later batches).
// All text is set with textContent (never innerHTML), so content from the register cannot become HTML.
//
// The link to the queue: window.QueuePlans.openEntry(id) (marker on the queue cards) and window.QueueBoard.showTask(id)
// (the links in the Queue tab, set by board.js).
//
// The room has two surfaces, Plan entries and Documents and agreements (`surface=doc` in the url).
// The document surface is drawn by plans/documents.js (window.QueuePlanDoc.cells) with helpers from here.
//
// The plan entries can be shown as List or Priority map (`show=map`), and the deadline band sits above
// the panes. Both are drawn by plans/map.js (window.QueuePlanMap) with helpers from here; the map is the only thing in
// the room that writes (POST /api/plan-prioritize, after a preview).
//
// In addition Tree map (`show=treeMap`) and Dependencies (`show=dep`, the selection or the selected entry with
// its neighbors), drawn by plans/structure.js (window.QueuePlanStructure) with helpers from here. They write nothing.
//
// The Documents tab reads the sources (GET /api/doc), and the Unregistered box sits above the panes on the Plan
// entries surface with "New entry" and "Add as source" (preview first). Both are drawn by plans/read.js
// (window.QueuePlanRead) with helpers from here.
//
// The Legal, Decisions and Launch surfaces are drawn by plans/legal.js
// (window.QueuePlanLegal), which also does its own two write calls (answer via resolve and the lawyer package).
//
// The Overview surface (the start page when you enter Plans) is drawn by plans/overview.js
// (window.QueuePlanOverview). The keyboard (j, k, Enter, /, 1 to 4, c, x), Ctrl+K, multi select with the action bar,
// the row menu and "changed by session" live in plans/work.js (window.QueuePlanWork). Here is only the wiring, and the
// live update: a call to /api/plans with wait=1 that the server holds until the register changes.
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;
  const $ = (id) => document.getElementById(id);
  const room = $('plans-room');
  const KEY = 'queue-board-key'; // same as board.js (sessionStorage)
  const OPEN_STORAGE = 'queue-board-plans-open';
  const FACET_STORAGE = 'queue-board-plans-facets';
  const VIEW_STORAGE = 'queue-board-plans-views';
  const CLOSED_STORAGE = 'queue-board-plans-doc-closed'; // the document groups you have closed

  const s = {
    data: null,
    version: null,
    error: null,
    fetching: false,
    state: V.readUrl(location.search),
    // The Plans state the last time the room was open, so "Plans" at the top takes you back to where you were.
    lastPlans: null,
    openOnes: new Set(readList(OPEN_STORAGE)),
    facetOpen: new Set(readList(FACET_STORAGE, ['module', 'pri'])),
    ownOnes: readList(VIEW_STORAGE).map(V.cleanOwnView).filter(Boolean),
    undo: [], // previous filter choices (search parts), for "Undo filter"
    drawer: false, // narrow screen: the filters are open as a drawer
    saves: false, // the "Save view" form is open
    closed: new Set(readList(CLOSED_STORAGE)), // closed document groups (open by default)
  };

  // ---- Helpers ----
  function el(tag, attr, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attr ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k.startsWith('--')) e.style.setProperty(k, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const b of children.flat()) if (b != null && b !== false) e.append(b);
    return e;
  }
  // PLAN-3a-QA1: the room is filled only with the parts that apply to the surface. Optional parts are null, and adding
  // them directly would insert a raw "null" text under the tabs (Element.append turns null into text).
  const fillRoom = (...children) => room.append(...V.roomChildren(children));
  function readList(key, standard = []) {
    try {
      const x = JSON.parse(localStorage.getItem(key) ?? 'null');
      return Array.isArray(x) ? x : standard;
    } catch {
      return standard;
    }
  }
  function save(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* private mode or full storage: applies only to this session */
    }
  }
  function message(text, error) {
    if (window.QueueBoard?.message) window.QueueBoard.message(text, error);
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      // The confirmation shows exactly what was copied.
      message(`Copied: ${text}`);
    } catch {
      message(`Could not copy automatically. Select and copy it yourself: ${text}`, true);
    }
  }
  function copyButton(text, label, cls = 'button-small button-outline plans-copy') {
    return el('button', {
      type: 'button',
      class: cls,
      text: 'Copy',
      title: text,
      'aria-label': label,
      onclick: (e) => {
        e.stopPropagation();
        copy(text);
      },
    });
  }
  const date = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? String(iso)
      : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  };
  const entryFor = (id) => s.data?.entries.find((p) => p.id === id) ?? null;

  // ---- The room and the url ----
  const isPlans = () => s.state.room === 'plans';
  // The modules that can be switched off (features in queue.config.json; board.js sets window.QueueFeatures from the
  // state). The surfaces that belong to one; a surface that is off is not shown and its url falls back to the overview.
  const featureOn = (name) => window.QueueFeatures?.on(name) ?? true;
  const SURFACE_FEATURE = { jur: 'plans.legal', launch: 'plans.launch', doc: 'plans.documents' };
  const surfaceOn = (id) => !SURFACE_FEATURE[id] || featureOn(SURFACE_FEATURE[id]);

  /**
   * New state: the url is updated (push = a new step in the history; otherwise the step is replaced, e.g. while you
   * type in the search), the room is shown and Plans is drawn. The Queue room has no search part, so its address is as before.
   */
  function useState(fresh, { push = true, scroll = false } = {}) {
    if (isPlans() && fresh.room !== 'plans') s.lastPlans = s.state;
    s.state = fresh;
    const url = location.pathname + (fresh.room === 'plans' ? V.writeUrl(fresh) : '');
    if (url !== location.pathname + location.search) {
      if (push) history.pushState(null, '', url);
      else history.replaceState(null, '', url);
    }
    showRoom();
    if (isPlans()) draw({ scroll });
  }

  /** Filter change: the previous choice goes on the undo stack. */
  function newFilter(filter, extra = {}) {
    const previous = V.writeUrl({ ...s.state, entry: null });
    s.undo.push(previous);
    if (s.undo.length > 20) s.undo.shift();
    useState({ ...s.state, filter, ...extra });
  }

  function showRoom() {
    const p = isPlans();
    document.body.classList.toggle('room-plans', p);
    room.hidden = !p;
    for (const [id, selected] of [
      ['room-plans', p],
      ['room-queue', !p],
    ]) {
      const b = $(id);
      b.setAttribute('aria-selected', selected ? 'true' : 'false');
      b.tabIndex = selected ? 0 : -1;
    }
    document.title = p ? 'Plans' : 'Work queue';
    const h1 = document.querySelector('.top .title');
    if (h1) h1.textContent = p ? 'Plans' : 'Work queue';
    if (p && !s.data) get();
  }

  window.addEventListener('popstate', () => {
    const fresh = V.readUrl(location.search);
    if (isPlans() && fresh.room !== 'plans') s.lastPlans = s.state;
    s.state = fresh;
    showRoom();
    if (isPlans()) draw({ scroll: true });
  });

  function selectRoom(r) {
    if (r === 'plans') {
      if (isPlans()) return;
      // The overview is the start page in Plans.
      useState(s.lastPlans ?? V.readUrl('?room=plans&surface=overview'));
    } else if (isPlans()) useState({ ...s.state, room: 'queue' });
  }
  $('room-plans').addEventListener('click', () => selectRoom('plans'));
  $('room-queue').addEventListener('click', () => selectRoom('queue'));
  // The room tabs: the arrow keys move focus, Enter or space selects (like the view tabs).
  $('room-option').addEventListener('keydown', (e) => {
    const buttons = [$('room-plans'), $('room-queue')].filter((b) => !b.hidden); // Plans can be off
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const j = window.QueueA11y.tabMeasure(buttons.length, i, e.key);
    if (j == null) return;
    e.preventDefault();
    buttons[i].tabIndex = -1;
    buttons[j].tabIndex = 0;
    buttons[j].focus();
  });

  // ---- Fetching ----
  async function get(force = false, { wait = false } = {}) {
    const key = sessionStorage.getItem(KEY);
    // the waiting call (wait) has its own flag, so a normal fetch (e.g. after a save) is not
    // held back by it.
    const flag = wait ? 'listener' : 'fetching';
    if (s[flag] || !key) return;
    s[flag] = true;
    try {
      // wait=1 holds the answer until plans.json or queue.json changes (live update).
      const q =
        s.version && !force
          ? `?version=${encodeURIComponent(s.version)}${wait ? '&wait=1' : ''}`
          : '';
      const res = await fetch(`/api/plans${q}`, { headers: { 'X-Queue-Key': key } });
      let answer = null;
      try {
        answer = await res.json();
      } catch {
        answer = null;
      }
      if (!res.ok) throw new Error(answer?.message ?? `HTTP ${res.status}`);
      s.error = null;
      if (!answer.unchanged) {
        // entries a session has changed since last time get a short "changed by session" marker.
        window.QueuePlanWork?.changed(V.changedEntries(s.data, answer.data));
        s.data = answer.data;
        // the document folders the reader allows come from the configuration on the server.
        if (Array.isArray(answer.data?.read_folders)) V.setReadFolders(answer.data.read_folders);
        s.version = answer.version;
        // while a chip is dragged or lifted in the priority map, the drawing waits until it is dropped.
        // the same while a row menu is open (it redraws when it closes).
        if (isPlans() && !window.QueuePlanMap?.busy() && !window.QueuePlanWork?.busy()) draw();
      }
    } catch (e) {
      s.error = e.message;
      if (isPlans() && !s.data) draw();
    } finally {
      s[flag] = false;
    }
  }

  // ---- Drawing ----
  /**
   * Redraws the whole room. Focus and scrolling are kept (the element with the same data-focus gets focus back,
   * and the search field gets the cursor where it was), so an update from the server does not move you.
   */
  function draw({ scroll = false, focus = null } = {}) {
    window.QueuePlanMap?.doneDrawn();
    const active = document.activeElement;
    // `focus` is the element that should have focus afterwards (e.g. the chip that was just moved).
    const focusKey = focus ?? (room.contains(active) ? active?.dataset?.focus : null);
    const cursor = active?.selectionStart ?? null;
    const scrolling = [...room.querySelectorAll('[data-scroll]')].map((e) => [
      e.dataset.scroll,
      e.scrollTop,
    ]);

    room.replaceChildren();
    if (!s.data) {
      fillRoom(
        el('p', {
          class: 'empty plans-fetching',
          text: s.error ? `Could not read the plan register: ${s.error}` : 'Fetching the plan register …',
        }),
      );
      return;
    }
    const d = s.data;
    // A surface whose module is off (an old link or bookmark) shows the overview instead.
    if (!surfaceOn(s.state.surface)) s.state = { ...s.state, surface: 'overview' };
    const t = s.state;
    // The overview is drawn by overview.js.
    if (t.surface === 'overview' && window.QueuePlanOverview) {
      room.classList.remove('has-selected');
      fillRoom(
        pathEl(d),
        surfaceOptionEl(d),
        window.QueuePlanMap ? window.QueuePlanMap.deadlineBand(mapHelp, d, null) : null,
        window.QueuePlanOverview.side(workHelp, d),
      );
      afterDrawing(focusKey, cursor, scrolling, false);
      return;
    }
    // the document surface is drawn by documents.js; the plan entries as before.
    const docSurface = t.surface === 'doc' && !!window.QueuePlanDoc;
    // Legal, Decisions and Launch are drawn by legal.js.
    const jbSurface = V.JB_SURFACES.includes(t.surface) && !!window.QueuePlanLegal;
    if (jbSurface) {
      room.classList.toggle('has-selected', window.QueuePlanLegal.hasSelected(legalHelp, d));
      room.classList.toggle('drawer-open', s.drawer);
      fillRoom(
        pathEl(d),
        surfaceOptionEl(d),
        t.surface === 'launch' && window.QueuePlanMap
          ? window.QueuePlanMap.deadlineBand(mapHelp, d, window.QueuePlanLegal.launchIds(d))
          : null,
        window.QueuePlanLegal.cells(legalHelp, d),
      );
      afterDrawing(focusKey, cursor, scrolling, scroll);
      return;
    }
    // the priority map (show=map) has the same filters and selection as the list, plus the dropped ones for the folded
    // Drop column.
    const map = !docSurface && t.show === 'map' && !!window.QueuePlanMap;
    // tree map (show=treeMap) and dependencies (show=dep), with the same filters and selection as the list.
    const structure =
      !docSurface && (t.show === 'treeMap' || t.show === 'dep') && !!window.QueuePlanStructure;
    const match = docSurface ? [] : V.filter(d.entries, t.filter, t.search);
    const selected = !docSurface && t.entry ? entryFor(t.entry) : null;
    const selectedDoc = docSurface && t.doc ? (d.documents ?? []).some((x) => x.id === t.doc) : false;
    room.classList.toggle('has-selected', docSurface ? selectedDoc : !!selected);
    room.classList.toggle('drawer-open', s.drawer);
    const pickedOut = V.countFilters(t.filter) > 0 || !!t.search;
    fillRoom(
      pathEl(d),
      surfaceOptionEl(d),
      docSurface || !window.QueuePlanMap
        ? null
        : window.QueuePlanMap.deadlineBand(mapHelp, d, pickedOut ? match.map((p) => p.id) : null),
      // The Unregistered box, only on the Plan entries surface.
      docSurface || !window.QueuePlanRead ? null : window.QueuePlanRead.unregisteredBox(readHelp, d),
      docSurface
        ? window.QueuePlanDoc.cells(docHelp, d)
        : el(
            'div',
            { class: 'plans-grid' },
            filtersEl(d, match),
            map
              ? window.QueuePlanMap.middle(mapHelp, d, V.mapEntries(d.entries, t.filter, t.search), selected)
              : structure
                ? window.QueuePlanStructure[t.show](structureHelp, d, match, selected)
                : listEl(d, match, selected),
            detailEl(d, selected),
          ),
      // the action bar for multi select, at the bottom.
      docSurface || !window.QueuePlanWork ? null : window.QueuePlanWork.optionLine(workHelp, d),
    );
    afterDrawing(focusKey, cursor, scrolling, scroll && (selected || selectedDoc));
  }

  /** After drawing: scrolling, focus and cursor back, and the chosen row in view (with `scroll`). */
  function afterDrawing(focusKey, cursor, scrolling, scroll) {
    for (const [n, top] of scrolling) {
      const e = room.querySelector(`[data-scroll="${n}"]`);
      if (e) e.scrollTop = top;
    }
    if (focusKey) {
      const fresh = room.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
      if (fresh) {
        fresh.focus();
        if (cursor != null && typeof fresh.setSelectionRange === 'function')
          fresh.setSelectionRange(cursor, cursor);
      }
    }
    if (scroll)
      room
        .querySelector('.plans-entry.selected, .doc-row.selected, .jb-row.selected')
        ?.scrollIntoView({ block: 'nearest' });
  }

  // ---- the surfaces in the room (Plan entries, Documents and agreements, and Legal, Decisions and
  // Launch) ----
  function surfaceOptionEl(d) {
    const now = V.SURFACES.some((f) => f.id === s.state.surface) ? s.state.surface : 'entries';
    // Legal and Decisions show the open ones, Launch what remains.
    const count = V.surfaceCount(d);
    const tabs = el(
      'div',
      {
        class: 'plans-surfaces',
        role: 'tablist',
        'aria-label': 'What the room shows',
        onkeydown: (e) => {
          const buttons = [...e.currentTarget.querySelectorAll('[role="tab"]')];
          const i = buttons.indexOf(document.activeElement);
          if (i < 0) return;
          const j = window.QueueA11y.tabMeasure(buttons.length, i, e.key);
          if (j == null) return;
          e.preventDefault();
          buttons[i].tabIndex = -1;
          buttons[j].tabIndex = 0;
          buttons[j].focus();
        },
      },
      ...V.SURFACES.filter((f) => surfaceOn(f.id)).map((f) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: 'plans-surface',
            'aria-selected': f.id === now ? 'true' : 'false',
            tabindex: f.id === now ? '0' : '-1',
            'data-focus': `surface:${f.id}`,
            onclick: () => {
              if (f.id !== now) useState({ ...s.state, surface: f.id });
            },
          },
          f.text,
          el('span', { class: 'plans-count', text: String(count[f.id]) }),
        ),
      ),
    );
    if (now !== 'entries' || !window.QueuePlanMap) return tabs;
    // the view of the plan entries, List or Priority map (show=map in the url).
    const show = V.VIEWS.includes(s.state.show) ? s.state.show : 'list';
    return el(
      'div',
      { class: 'plans-surfaces-row' },
      tabs,
      el(
        'div',
        { class: 'toggles plans-show', role: 'group', 'aria-label': 'View' },
        ...[
          ['list', 'List'],
          ['map', 'Priority map'],
          // tree map and dependencies for the selection.
          ...(window.QueuePlanStructure
            ? [
                ['treeMap', 'Tree map'],
                ['dep', 'Dependencies'],
              ]
            : []),
        ].map(([id, text]) =>
          el('button', {
            type: 'button',
            class: 'toggles-button',
            text,
            'aria-pressed': show === id ? 'true' : 'false',
            'data-focus': `show:${id}`,
            onclick: () => {
              if (show !== id) useState({ ...s.state, show: id });
            },
          }),
        ),
      ),
    );
  }

  /** The helpers map.js gets (same building blocks as the list, so there is one design language). */
  const mapHelp = {
    el,
    message,
    draw: (opts) => draw(opts),
    get: (force) => get(force),
    activeFilters: (d) => activeFiltersEl(d),
    selectEntry: (id, tab) =>
      useState({ ...s.state, entry: id, tab: tab ?? s.state.tab }, { push: true }),
    selectDoc: (id) => useState({ ...s.state, surface: 'doc', doc: id }, { scroll: true }),
  };

  /**
   * The helpers structure.js gets. The zoom in the tree map is the filter (module and project; the other filters stay),
   * so the breadcrumb zooms out and undo filter and the back button work.
   */
  const structureHelp = {
    el,
    state: () => s.state,
    activeFilters: (d) => activeFiltersEl(d),
    pickedOut: () => V.countFilters(s.state.filter) > 0 || !!s.state.search,
    selectEntry: (id) => useState({ ...s.state, entry: id }, { push: true }),
    zoom: (part) => newFilter({ ...s.state.filter, ...part }, { entry: null }),
    setDep: (dep) => useState({ ...s.state, dep }),
  };

  /** The helpers read.js gets (the reader and the Unregistered box). */
  const readHelp = {
    el,
    message,
    copyButton,
    date,
    list: (...a) => list(...a),
    draw: (opts) => draw(opts),
    get: (force) => get(force),
    goToEntry: (id) =>
      useState(
        {
          ...s.state,
          surface: 'entries',
          filter: V.emptyFilter(),
          search: '',
          entry: id,
          tab: 'summary',
        },
        { scroll: true },
      ),
  };

  /** The helpers documents.js gets (same building blocks as the plan entries, so there is one design language). */
  const docHelp = {
    el,
    copy,
    copyButton,
    date,
    field: (...a) => field(...a),
    list: (...a) => list(...a),
    priEl: (p) => priEl(p),
    state: () => s.state,
    use: (change, opts) => useState({ ...s.state, ...change }, opts),
    newDocFilter: (dfilter, extra = {}) =>
      useState({ ...s.state, dfilter, doc: null, ...extra }),
    facetIsOpen: (key, standard = []) =>
      s.facetOpen.has(key) || (standard.includes(key) && !s.facetOpen.has(`!${key}`)),
    setFacetOpen: (key, open) => {
      if (open) {
        s.facetOpen.add(key);
        s.facetOpen.delete(`!${key}`);
      } else {
        s.facetOpen.delete(key);
        s.facetOpen.add(`!${key}`);
      }
      save(FACET_STORAGE, [...s.facetOpen]);
    },
    isClosed: (key) => s.closed.has(key),
    toggleClosed: (key) => {
      if (s.closed.has(key)) s.closed.delete(key);
      else s.closed.add(key);
      save(CLOSED_STORAGE, [...s.closed]);
      draw();
    },
    goToEntry: (id) =>
      useState(
        {
          ...s.state,
          surface: 'entries',
          filter: V.emptyFilter(),
          search: '',
          entry: id,
          tab: 'summary',
        },
        { scroll: true },
      ),
  };

  /** The helpers legal.js gets (the document helpers plus message and fetching; the writing lives in legal.js). */
  const legalHelp = {
    ...docHelp,
    message,
    draw: (opts) => draw(opts),
    get: (force) => get(force),
  };

  /**
   * The helpers overview.js and work.js get (same building blocks, so there is one design language). The order of
   * entries in the list is the one shown (DOM), so j and k follow the folding.
   */
  const workHelp = {
    ...legalHelp,
    room,
    isPlans,
    data: () => s.data,
    entryFor,
    progressEl: (f, name) => progressEl(f, name),
    newFilter: (filter, extra) => newFilter(filter, extra),
    visibleEntries: () =>
      [...room.querySelectorAll('.plans-middle .plans-entry[data-entry]')].map((e) => e.dataset.entry),
    selectEntry: (id, { push = false } = {}) =>
      useState({ ...s.state, surface: 'entries', entry: id }, { push, scroll: true }),
    goToList: (change = {}) =>
      useState({ ...s.state, surface: 'entries', ...change }, { scroll: true }),
    selectRoom,
  };

  // ---- The breadcrumb ----
  function pathEl(d) {
    const part = V.breadcrumbs(s.state, d);
    return el(
      'nav',
      { class: 'plans-path', 'aria-label': 'Breadcrumb trail' },
      el(
        'ol',
        { class: 'plans-path-list' },
        ...part.map((l, i) => {
          const latest = i === part.length - 1;
          return el(
            'li',
            { class: 'plans-path-part' },
            latest
              ? el('span', { class: 'plans-path-here', 'aria-current': 'location', text: l.text })
              : el('button', {
                  type: 'button',
                  class: 'link-button',
                  text: l.text,
                  'data-focus': `path:${l.level}`,
                  // the parts on the document surface carry the state a click gives.
                  onclick: () =>
                    l.state
                      ? useState({ ...s.state, ...l.state })
                      : newFilter(l.filter, { entry: null, search: '' }),
                }),
            l.copy
              ? copyButton(
                  l.copy,
                  `Copy the start line for ${l.text}`,
                  'button-small button-outline',
                )
              : null,
          );
        }),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'button button-outline plans-drawer-button',
          'aria-expanded': s.drawer ? 'true' : 'false',
          'aria-controls': 'plans-filters',
          'data-focus': 'drawer',
          onclick: () => {
            s.drawer = !s.drawer;
            draw();
          },
        },
        (() => {
          const fl = s.state.surface;
          const n =
            fl === 'doc'
              ? V.countDocFilters(s.state.dfilter)
              : fl === 'jur' || fl === 'decision'
                ? V.countJbFilters(fl, fl === 'jur' ? s.state.jfilter : s.state.bfilter)
                : V.countFilters(s.state.filter);
          return `Filters${n ? ` (${n})` : ''}`;
        })(),
      ),
    );
  }

  // ---- Left pane: search, views and facets ----
  let searchTime = null;
  function filtersEl(d, match) {
    const t = s.state;
    const facets = V.facetNumber(d.entries, t.filter, t.search, d);
    const now = V.writeUrl({ ...t, entry: null });
    const viewButton = (v, own) =>
      el(
        'li',
        { class: 'plans-view' },
        el('button', {
          type: 'button',
          class: 'link-button',
          text: v.name,
          'aria-pressed': V.sameView(v.search, now) ? 'true' : 'false',
          'data-focus': `show:${own ? 'own' : 'done'}:${v.name}`,
          onclick: () => {
            const fresh = V.readUrl(v.search);
            newFilter(fresh.filter, { search: fresh.search, entry: null });
          },
        }),
        own
          ? el('button', {
              type: 'button',
              class: 'button-icon plans-remove',
              text: '✕',
              'aria-label': `Delete the view ${v.name}`,
              onclick: () => {
                s.ownOnes = s.ownOnes.filter((x) => x !== v);
                save(VIEW_STORAGE, s.ownOnes);
                draw();
              },
            })
          : null,
      );
    return el(
      'aside',
      {
        id: 'plans-filters',
        class: 'plans-filters',
        'aria-label': 'Filters',
        'data-scroll': 'filters',
      },
      el(
        'label',
        { class: 'plans-search-label' },
        el('span', { class: 'hidden-for-eye', text: 'Search in the plans' }),
        el('input', {
          type: 'search',
          class: 'search plans-search',
          placeholder: 'Search in id, title, sources',
          autocomplete: 'off',
          value: t.search,
          'data-focus': 'search',
          oninput: (e) => {
            clearTimeout(searchTime);
            const v = e.target.value.slice(0, 120);
            searchTime = setTimeout(
              () => useState({ ...s.state, search: v.trim() }, { push: false }),
              200,
            );
          },
        }),
      ),
      el(
        'section',
        { class: 'plans-views', 'aria-label': 'Saved views' },
        el('h2', { class: 'plans-cell-title', text: 'Views' }),
        el(
          'ul',
          { class: 'plans-view-list' },
          ...V.DONE_VIEWS.map((v) => viewButton(v, false)),
          ...s.ownOnes.map((v) => viewButton(v, true)),
        ),
        saveViewEl(now),
      ),
      ...facets
        .filter((f) => f.option.length)
        .map((f) => {
          const open = s.facetOpen.has(f.id) || f.option.some((v) => v.selected);
          return el(
            'details',
            {
              class: 'plans-facet',
              open: open,
              ontoggle: (e) => {
                if (e.target.open) s.facetOpen.add(f.id);
                else s.facetOpen.delete(f.id);
                save(FACET_STORAGE, [...s.facetOpen]);
              },
            },
            el(
              'summary',
              { class: 'plans-facet-title', 'data-focus': `facet:${f.id}` },
              `${f.title} (${f.option.length})`,
            ),
            el(
              'ul',
              { class: 'plans-facet-list' },
              ...f.option.map((v) =>
                el(
                  'li',
                  {},
                  el(
                    'label',
                    { class: 'plans-facet-option' },
                    el('input', {
                      type: 'checkbox',
                      checked: v.selected,
                      'data-focus': `f:${f.id}:${v.val}`,
                      onchange: (e) => {
                        const fresh = { ...s.state.filter };
                        const list = new Set(fresh[f.id]);
                        if (e.target.checked) list.add(v.val);
                        else list.delete(v.val);
                        fresh[f.id] = [...list];
                        newFilter(fresh);
                      },
                    }),
                    f.id === 'pri'
                      ? el('span', {
                          class: `plans-pri pri-${v.val}`,
                          'aria-hidden': 'true',
                          text: V.PRIORITY[v.val]?.symbol ?? '',
                        })
                      : null,
                    el('span', { class: 'plans-facet-text', text: v.text }),
                    el('span', {
                      class: 'plans-count',
                      text: String(v.count),
                      'aria-label': `${v.count} matches`,
                    }),
                  ),
                ),
              ),
            ),
          );
        }),
      el('p', {
        class: 'plans-match',
        role: 'status',
        text: `${match.length} of ${d.entries.length} entries`,
      }),
    );
  }

  function saveViewEl(now) {
    if (!s.saves)
      return el('button', {
        type: 'button',
        class: 'button-small button-outline',
        text: 'Save this view',
        'data-focus': 'save-view',
        disabled: !V.countFilters(s.state.filter) && !s.state.search,
        onclick: () => {
          s.saves = true;
          draw();
          room.querySelector('.plans-save-name')?.focus();
        },
      });
    return el(
      'form',
      {
        class: 'plans-save',
        onsubmit: (e) => {
          e.preventDefault();
          const fresh = V.cleanOwnView({ name: e.target.elements.name.value, search: now });
          if (!fresh) return;
          s.ownOnes = [...s.ownOnes.filter((x) => x.name !== fresh.name), fresh];
          save(VIEW_STORAGE, s.ownOnes);
          s.saves = false;
          message(`The view "${fresh.name}" is saved in this browser.`);
          draw();
        },
      },
      el(
        'label',
        {},
        el('span', { class: 'hidden-for-eye', text: 'Name of the view' }),
        el('input', {
          name: 'name',
          class: 'search plans-save-name',
          type: 'text',
          maxlength: '60',
          placeholder: 'Name of the view',
          'data-focus': 'save-name',
        }),
      ),
      el('button', { type: 'submit', class: 'button-small button-filled', text: 'Save' }),
      el('button', {
        type: 'button',
        class: 'button-small button-outline',
        text: 'Cancel',
        onclick: () => {
          s.saves = false;
          draw();
        },
      }),
    );
  }

  // ---- Middle: the chips and the foldable list ----
  function listEl(d, match, selected) {
    const t = s.state;
    const actively = V.chips(t.filter, d).length > 0 || !!t.search;
    const tree = V.tree(match, d);
    const header = activeFiltersEl(d);
    let content;
    if (!d.exists)
      content = el('p', {
        class: 'empty',
        text: 'The plan register does not exist yet (scripts/.queue/plans.json).',
      });
    else if (!match.length)
      content = el(
        'div',
        { class: 'empty empty-state' },
        el('p', {
          text: actively ? 'No entries match the filters and the search.' : 'No entries in the register.',
        }),
        actively
          ? el('button', {
              type: 'button',
              class: 'link-button',
              text: 'Reset the filters',
              onclick: () => newFilter(V.emptyFilter(), { search: '' }),
            })
          : null,
      );
    else
      content = el(
        'ul',
        { class: 'plans-tree', 'aria-label': 'The plans by area and project' },
        ...tree.map((m) => moduleEl(m, actively, selected, d)),
      );
    return el(
      'section',
      { class: 'plans-middle', 'aria-label': 'Plan list', 'data-scroll': 'list' },
      header,
      content,
    );
  }

  /** The active filters as chips above the list (and above the priority map), with Reset and Undo filter. */
  function activeFiltersEl(d) {
    const t = s.state;
    const chips = V.chips(t.filter, d);
    const actively = chips.length > 0 || !!t.search;
    return el(
      'div',
      { class: 'plans-chips', 'aria-label': 'Active filters' },
      ...chips.map((b) =>
        el(
          'span',
          { class: 'badge plans-chip' },
          b.text,
          el('button', {
            type: 'button',
            class: 'plans-chip-remove',
            text: '✕',
            'aria-label': `Remove the filter ${b.text}`,
            'data-focus': `chip:${b.facet}:${b.val}`,
            onclick: () => {
              const fresh = {
                ...t.filter,
                [b.facet]: t.filter[b.facet].filter((x) => x !== b.val),
              };
              newFilter(fresh);
            },
          }),
        ),
      ),
      t.search ? el('span', { class: 'badge plans-chip', text: `Search: ${t.search}` }) : null,
      actively
        ? el('button', {
            type: 'button',
            class: 'button-small button-outline',
            text: 'Reset',
            'data-focus': 'reset',
            onclick: () => newFilter(V.emptyFilter(), { search: '' }),
          })
        : null,
      s.undo.length
        ? el('button', {
            type: 'button',
            class: 'button-small button-outline',
            text: 'Undo filter',
            'data-focus': 'undo-filter',
            onclick: () => {
              const previous = V.readUrl(s.undo.pop());
              useState({ ...s.state, filter: previous.filter, search: previous.search });
            },
          })
        : null,
    );
  }

  /** Is the group open? With a filter or search everything with matches is open; otherwise what you opened, and the path to the selected entry. */
  function isOpen(key, actively, selected, check) {
    return actively || s.openOnes.has(key) || (selected && check(selected));
  }
  function toggleOpen(key) {
    if (s.openOnes.has(key)) s.openOnes.delete(key);
    else s.openOnes.add(key);
    save(OPEN_STORAGE, [...s.openOnes]);
    draw();
  }

  function progressEl(f, name) {
    const pst = Math.round(f.share * 100);
    return el(
      'span',
      { class: 'plans-progress' },
      el(
        'span',
        {
          class: 'plans-bar',
          role: 'img',
          'aria-label': `${name}: ${f.built} of ${f.n} built, ${pst} percent done`,
        },
        el('span', { class: 'plans-bar-fill', '--share': `${pst}%` }),
      ),
      el('span', {
        class: 'plans-progress-text',
        'aria-hidden': 'true',
        text: `${f.built}/${f.n}`,
      }),
    );
  }

  function groupRow(levelClass, key, open, title, count, f, copyText, fullTitle) {
    const id = `plans-g-${key.replace(/[^a-z0-9-]/gi, '_')}`;
    return el(
      'div',
      { class: `plans-row ${levelClass}` },
      el(
        'button',
        {
          type: 'button',
          class: 'plans-fold',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': id,
          'data-focus': `g:${key}`,
          title: fullTitle ?? null,
          onclick: () => toggleOpen(key),
        },
        el('span', { class: 'plans-fold-arrow', 'aria-hidden': 'true', text: open ? '▾' : '▸' }),
        el('span', { class: 'plans-group-title', text: title }),
        el('span', {
          class: 'plans-count',
          text: String(count),
          'aria-label': `${count} entries`,
        }),
      ),
      progressEl(f, title),
      copyText ? copyButton(copyText, `Copy the start line for ${title}`) : null,
    );
  }

  function moduleEl(m, actively, selected, d) {
    const key = `m:${m.oid}`;
    const open = isOpen(key, actively, selected, (p) => (p.module ?? V.WITHOUT_MODULE) === m.oid);
    const id = `plans-g-${key.replace(/[^a-z0-9-]/gi, '_')}`;
    const modCopy = m.oid === V.WITHOUT_MODULE ? null : V.copyLine('module', m.oid, [m.title]);
    return el(
      'li',
      { class: 'plans-module' },
      groupRow('plans-row-module', key, open, m.title, m.count, m.progress, modCopy),
      open
        ? el(
            'ul',
            { id, class: 'plans-projects' },
            ...m.projects.map((pr) => projectEl(m, pr, actively, selected, d)),
          )
        : null,
    );
  }

  function projectEl(m, pr, actively, selected, d) {
    const key = `p:${m.oid}/${pr.pid}`;
    const open = isOpen(
      key,
      actively,
      selected,
      (p) => (p.module ?? V.WITHOUT_MODULE) === m.oid && (p.project ?? V.WITHOUT_PROJECT) === pr.pid,
    );
    const id = `plans-g-${key.replace(/[^a-z0-9-]/gi, '_')}`;
    const modCopy =
      pr.pid === V.WITHOUT_PROJECT ? null : V.copyLine('project', pr.pid, [m.title, pr.title]);
    return el(
      'li',
      { class: 'plans-project' },
      groupRow(
        'plans-row-project',
        key,
        open,
        pr.title,
        pr.entries.length,
        pr.progress,
        modCopy,
        pr.fullTitle,
      ),
      open
        ? el('ul', { id, class: 'plans-entries' }, ...pr.entries.map((p) => entryEl(p, selected, d)))
        : null,
    );
  }

  /** The warning icons on the row: owner question, legal, stale and deadline. The symbol always carries a text as well. */
  function notices(p) {
    const out = [];
    const openSp = (p.ownerQuestions ?? []).filter((x) => !x.resolved).length;
    if (openSp) out.push({ k: 'owner', draw: '?', text: `${openSp} open owner questions` });
    if (p.legal_open) out.push({ k: 'jur', draw: '§', text: `${p.legal_open} open legal points` });
    if (p.stale) out.push({ k: 'stale', draw: '⟳', text: 'The verification is stale' });
    if (p.deadline) {
      const band = V.deadlineBand(p.deadline);
      out.push({
        k: `deadline deadline-${band}`,
        draw: '◷',
        text: `Deadline ${p.deadline}${band === 'overdue' ? ' (overdue)' : ''}`,
      });
    }
    if (p.active) out.push({ k: 'active', draw: '◉', text: 'Being worked on in Claude Code' });
    return out;
  }

  function priEl(p) {
    const v = V.PRIORITY[p.priority] ?? { text: p.priority ?? 'unknown', symbol: '·' };
    const cat =
      p.priority === 'now' && p.now_category?.length
        ? ` · ${p.now_category.map((k) => V.CATEGORY[k] ?? k).join(', ')}`
        : '';
    return el(
      'span',
      { class: `plans-pri pri-${p.priority}` },
      el('span', { class: 'plans-pri-symbol', 'aria-hidden': 'true', text: v.symbol }),
      el('span', { text: `${v.text}${cat}` }),
    );
  }

  function maturityText(p) {
    const t = V.MATURITY[p.maturity] ?? p.maturity ?? '';
    return p.maturity === 'partial' && p.fraction ? `${t} ${p.fraction}` : t;
  }

  function entryEl(p, selected, d) {
    const isSelected = selected?.id === p.id;
    const vars = notices(p);
    // multi select (x), "changed by session" and the pulse for "Working now" (work.js).
    const A = window.QueuePlanWork;
    const extra = A ? A.rowClasses(p) : '';
    return el(
      'li',
      { class: `plans-entry${isSelected ? ' selected' : ''}${extra}`, 'data-entry': p.id },
      A ? A.markEl(workHelp, p) : null,
      el(
        'button',
        {
          type: 'button',
          class: 'plans-entry-button',
          'aria-current': isSelected ? 'true' : null,
          'data-focus': `entry:${p.id}`,
          onclick: () =>
            useState({ ...s.state, entry: p.id, tab: s.state.tab }, { push: true }),
        },
        priEl(p),
        el('span', { class: 'plans-entry-id', text: p.id }),
        el('span', { class: 'plans-entry-title', text: p.title }),
        el('span', { class: 'badge plans-maturity', text: maturityText(p) }),
        p.size
          ? el('span', {
              class: 'badge',
              text: p.size,
              title: `Size: ${V.SIZE[p.size] ?? p.size}`,
              'aria-label': `Size ${p.size}`,
            })
          : null,
        vars.length
          ? el(
              'span',
              { class: 'plans-warnings' },
              ...vars.map((x) =>
                el(
                  'span',
                  { class: `plans-warning v-${x.k}`, title: x.text },
                  el('span', { 'aria-hidden': 'true', text: x.draw }),
                  el('span', { class: 'hidden-for-eye', text: x.text }),
                ),
              ),
            )
          : null,
      ),
      // "changed by session" as text (not only color), and the row menu for priority and maturity.
      A ? A.changedBadge(p) : null,
      A ? A.rowMenuEl(workHelp, p, d) : null,
      copyButton(V.entryLine(p, d), `Copy the start line for ${p.id}`),
    );
  }

  // ---- Right pane: the detail panel with tabs ----
  function detailEl(d, p) {
    if (!p)
      return el(
        'aside',
        { class: 'plans-detail empty-detail', 'aria-label': 'Detail panel' },
        el('p', {
          class: 'empty',
          text: s.state.entry
            ? `Did not find ${s.state.entry} in the register (merged or removed).`
            : 'Select an entry in the list to see the details.',
        }),
      );
    const t = s.state;
    const k = V.prepare(p, d);
    const tabIdx = Math.max(
      0,
      V.TABS.findIndex((f) => f.id === t.tab),
    );
    const counters = {
      doc: p.sources.length,
      queue: p.queue.length,
      legal: p.legal_open,
      decisions: p.ownerQuestions.filter((x) => !x.resolved).length,
      history: p.history.length,
    };
    const tabList = el(
      'div',
      {
        class: 'plans-tabs',
        role: 'tablist',
        'aria-label': 'Details about the entry',
        onkeydown: (e) => {
          const buttons = [...e.currentTarget.querySelectorAll('[role="tab"]')];
          const i = buttons.indexOf(document.activeElement);
          if (i < 0) return;
          const j = window.QueueA11y.tabMeasure(buttons.length, i, e.key);
          if (j == null) return;
          e.preventDefault();
          buttons[i].tabIndex = -1;
          buttons[j].tabIndex = 0;
          buttons[j].focus();
        },
      },
      ...V.TABS.map((f, i) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            id: `plans-tab-${f.id}`,
            class: 'plans-tab',
            'aria-selected': i === tabIdx ? 'true' : 'false',
            'aria-controls': 'plans-tab-content',
            tabindex: i === tabIdx ? '0' : '-1',
            'data-focus': `tab:${f.id}`,
            onclick: () => useState({ ...s.state, tab: f.id }, { push: false }),
          },
          f.text,
          counters[f.id]
            ? el('span', { class: 'plans-count', text: String(counters[f.id]) })
            : null,
        ),
      ),
    );
    return el(
      'aside',
      { class: 'plans-detail', 'aria-label': `Details for ${p.id}`, 'data-scroll': 'detail' },
      el('button', {
        type: 'button',
        class: 'button-small button-outline plans-back',
        text: 'Back to the list',
        onclick: () => useState({ ...s.state, entry: null }),
      }),
      el(
        'header',
        { class: 'plans-detail-header' },
        el('p', { class: 'plans-detail-id', text: p.id }),
        el('h2', { class: 'plans-detail-title', text: p.title }),
        el(
          'p',
          { class: 'plans-detail-badges' },
          priEl(p),
          el('span', { class: 'badge plans-maturity', text: maturityText(p) }),
          p.size ? el('span', { class: 'badge', text: `Size ${p.size}` }) : null,
          p.active
            ? el('span', {
                class: 'badge plans-active',
                text: 'Being worked on in Claude Code',
                title: `Pulse ${date(p.active.at)} (${p.active.by})`,
              })
            : null,
        ),
        el(
          'div',
          { class: 'plans-actions' },
          el('button', {
            type: 'button',
            class: 'button button-filled',
            text: 'Copy start line',
            title: V.entryLine(p, d),
            'data-focus': 'copy-start',
            onclick: () => copy(V.entryLine(p, d)),
          }),
          el('button', {
            type: 'button',
            class: 'button button-outline',
            text: 'Prepare for queue',
            title: k.line,
            'data-focus': 'prepare',
            onclick: () => copy(k.line),
          }),
        ),
        k.warnings.length
          ? el(
              'div',
              { class: 'plans-control' },
              el('p', { class: 'plans-control-title', text: 'Check before packing' }),
              el('ul', {}, ...k.warnings.map((a) => el('li', { text: a }))),
            )
          : null,
      ),
      tabList,
      el(
        'section',
        {
          id: 'plans-tab-content',
          class: 'plans-tab-content',
          role: 'tabpanel',
          'aria-labelledby': `plans-tab-${V.TABS[tabIdx].id}`,
        },
        tabContent(V.TABS[tabIdx].id, p, d),
      ),
    );
  }

  function field(name, ...val) {
    const v = val.flat().filter((x) => x != null && x !== '' && x !== false);
    if (!v.length) return null;
    return [el('dt', { text: name }), el('dd', {}, ...v)];
  }

  function entryLink(id) {
    const q = entryFor(id);
    return el('button', {
      type: 'button',
      class: 'link-button',
      text: q ? `${id} ${q.title}` : id,
      onclick: () => useState({ ...s.state, entry: id }, { scroll: true }),
    });
  }

  function list(elements, emptyText) {
    return elements.length
      ? el('ul', { class: 'plans-detail-list' }, ...elements)
      : el('p', { class: 'empty', text: emptyText });
  }

  function tabContent(tab, p, d) {
    const over = [
      ...V.breadcrumbs({ entry: p.id, filter: V.emptyFilter() }, d)
        .slice(1, 3)
        .map((l) => l.text),
      p.id,
    ];
    if (tab === 'summary') {
      const v = V.PRIORITY[p.priority];
      return el(
        'div',
        {},
        p.summary ? el('p', { class: 'plans-summary', text: p.summary }) : null,
        el(
          'dl',
          { class: 'plans-field' },
          field(
            'Priority in the plan register',
            `${v ? `${v.symbol} ${v.text}` : p.priority}${
              p.now_category.length
                ? ` (${p.now_category.map((x) => V.CATEGORY[x] ?? x).join(', ')})`
                : ''
            }, set by ${p.priority_set_by === 'owner' ? 'the owner' : 'agent'}`,
          ),
          field('Reason', p.priority_reason),
          field(
            'Maturity',
            `${maturityText(p)}${
              p.maturity_plan && p.maturity_plan !== p.maturity
                ? ` (from the plan work: ${V.MATURITY[p.maturity_plan] ?? p.maturity_plan})`
                : ''
            }`,
          ),
          field('Size', p.size ? `${p.size}: ${V.SIZE[p.size] ?? ''}` : null),
          field('Deadline', p.deadline),
          field(
            'Depends on',
            p.depends_on.length
              ? list(
                  p.depends_on.map((id) => el('li', {}, entryLink(id))),
                  '',
                )
              : null,
          ),
          field(
            'Blocks',
            p.blocks.length
              ? list(
                  p.blocks.map((id) => el('li', {}, entryLink(id))),
                  '',
                )
              : null,
          ),
          field(
            'Verified',
            p.verified
              ? `${p.verified.date ?? ''} by ${p.verified.by ?? 'unknown'}${p.verified.findings ? `: ${p.verified.findings}` : ''}${
                  p.stale ? ' (stale)' : ''
                }`
              : 'Not verified against the code yet',
          ),
          field('Reason for drop', p.drop_reason),
          field('Merged from', p.merged_from.join(', ')),
          field('Roadmap', p.roadmap.join(', ')),
          field('Remark', p.remark),
        ),
      );
    }
    // the sources with the reader (plans/read.js).
    if (tab === 'doc' && window.QueuePlanRead) return window.QueuePlanRead.sourceTab(readHelp, p);
    if (tab === 'doc')
      return el(
        'div',
        {},
        el('p', {
          class: 'plans-help',
          text: 'The sources the entry points to (the reader is not loaded).',
        }),
        list(
          p.sources.map((k) =>
            el(
              'li',
              { class: 'plans-source' },
              el('code', { text: k.path }),
              k.anchor ? el('span', { class: 'badge', text: k.anchor }) : null,
              k.role ? el('span', { class: 'badge', text: k.role }) : null,
              copyButton(k.path, `Copy path ${k.path}`),
            ),
          ),
          'The entry has no sources.',
        ),
      );
    if (tab === 'queue') {
      const v = V.PRIORITY[p.priority];
      return el(
        'div',
        {},
        el('p', {
          class: 'plans-help',
          text:
            `Priority in the plan register: ${v?.text ?? p.priority}. The focus step is the queue's own order and is set ` +
            'per task. Click a task to see its card in Queue.',
        }),
        list(
          p.queue.map((o) =>
            el(
              'li',
              { class: 'plans-queue-task' },
              el('button', {
                type: 'button',
                class: 'link-button',
                text: `${o.id} ${o.title ?? ''}`.trim(),
                'aria-label': `Show ${o.id} in Queue`,
                onclick: () => showInQueue(o.id),
              }),
              el('span', {
                class: `badge plans-queue-status queue-${o.column ?? 'none'}`,
                text: V.queueStatusText(o),
              }),
            ),
          ),
          'No queue tasks yet. "Prepare for queue" copies the line for /add-to-queue.',
        ),
      );
    }
    if (tab === 'legal') {
      const j = p.legal;
      if (!j) return el('p', { class: 'empty', text: 'No legal points on the entry.' });
      const pv = j.privacy ?? null;
      return el(
        'div',
        {},
        el(
          'dl',
          { class: 'plans-field' },
          field('Affects', (j.affects ?? []).join('; ')),
          field(
            'Privacy',
            pv
              ? [
                  pv.art9 ? 'art. 9 data' : null,
                  pv.dpia ? `DPIA: ${pv.dpia}` : null,
                  pv.dpa_change ? 'DPA must change' : null,
                ]
                  .filter(Boolean)
                  .join(', ')
              : null,
          ),
        ),
        list(
          (j.points ?? []).map((x) =>
            el(
              'li',
              { class: 'plans-point' },
              el('p', {}, el('strong', { text: x.id ?? '' }), ` ${x.question ?? ''}`),
              el(
                'p',
                { class: 'plans-point-meta' },
                el('span', { class: 'badge', text: `Status: ${x.status ?? 'unknown'}` }),
                x.blocks
                  ? el('span', { class: 'badge', text: `Blocks: ${x.blocks}` })
                  : null,
                x.deadline ? el('span', { class: 'badge', text: `Deadline ${x.deadline}` }) : null,
                x.id
                  ? copyButton(V.copyLine('jur', x.id, over), `Copy the start line for ${x.id}`)
                  : null,
              ),
              x.ai_assessment
                ? el('p', { class: 'plans-help', text: `AI assessment: ${x.ai_assessment}` })
                : null,
            ),
          ),
          'No points.',
        ),
      );
    }
    if (tab === 'decisions') {
      const sorted = [...p.ownerQuestions].sort((a, b) => Number(a.resolved) - Number(b.resolved));
      return list(
        sorted.map((x) =>
          el(
            'li',
            { class: `plans-point${x.resolved ? ' resolved' : ''}` },
            el(
              'p',
              {},
              el('strong', { text: x.id }),
              ` ${x.text ?? '(the question does not exist in the queue)'}`,
            ),
            el(
              'p',
              { class: 'plans-point-meta' },
              el('span', { class: 'badge', text: x.resolved ? 'Answered' : 'Open' }),
              copyButton(V.copyLine('owner', x.id, over), `Copy the start line for ${x.id}`),
            ),
            x.answer ? el('p', { class: 'plans-help', text: `Answer: ${x.answer}` }) : null,
          ),
        ),
        'No owner questions on the entry.',
      );
    }
    return list(
      p.history.map((h) =>
        el(
          'li',
          { class: 'plans-history' },
          el('span', { class: 'badge', text: `nr. ${h.nr}` }),
          ` ${date(h.at)} · ${h.action ?? ''} · ${h.by ?? ''} · `,
          el('span', { text: h.field.includes('*') ? 'whole entry' : h.field.join(', ') }),
        ),
      ),
      'No changes in the changelog (it keeps the last 50).',
    );
  }

  // ---- The link to the queue ----
  function showInQueue(id) {
    useState({ ...s.state, room: 'queue' });
    window.QueueBoard?.showTask?.(id);
  }

  window.QueuePlans = {
    /** Marker on a queue card: switch to Plans with the entry open (the filters reset, so the entry is always in the list). */
    openEntry(id) {
      if (!featureOn('plans')) return; // the Plans module is off (features.plans)
      useState({ ...V.readUrl('?room=plans'), entry: id, tab: 'summary' }, { scroll: true });
      room.querySelector('.plans-entry.selected .plans-entry-button')?.focus();
    },
    /** The title of a plan entry (for the marker on the queue card), or null before the register is fetched. */
    title(id) {
      return entryFor(id)?.title ?? null;
    },
    /** The module switches came with a new state (board.js): leave Plans when it is off, otherwise redraw the surfaces. */
    featuresChanged() {
      if (!isPlans()) return;
      if (!featureOn('plans')) useState({ ...s.state, room: 'queue' }, { push: false });
      else if (s.data) draw();
    },
  };

  // ---- Start ----
  showRoom();
  get();
  // the keyboard and Ctrl+K (work.js), and live update: a call that waits until the register changes, so
  // changes from a Claude Code session show without a reload. If it fails, it is retried shortly; the interval
  // below is the fallback.
  window.QueuePlanWork?.install(workHelp);
  async function listen() {
    if (isPlans() && !document.hidden && s.version && !s.listener) {
      await get(false, { wait: true });
      setTimeout(listen, s.error ? 10_000 : 50);
      return;
    }
    setTimeout(listen, 1_000);
  }
  listen();
  setInterval(() => {
    if (!document.hidden && isPlans()) get();
  }, 15_000);
  window.addEventListener('focus', () => {
    if (isPlans()) get();
  });
})();
