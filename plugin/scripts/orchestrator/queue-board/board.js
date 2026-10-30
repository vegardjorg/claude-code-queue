// =============================================================
// board.js: the client for the kanban board of the work queue. Vanilla JS, no build step.
//
// The board fetches the state from queue-board.mjs (which uses the queue's own rules) and writes only via the server, which
// runs queue.mjs. "Waiting on you" (side panel with owner questions, QA, proposed and what is stuck), the "Next up" strip,
// "unlocks N" and the chain around a selected card (highlighted, the rest muted; Esc resets). The chain, "Next up" and
// the inbox are computed on the server (queueBoard.js); here is only the view. The "Dependencies" view (circles and
// strokes) is drawn by graph.js with the layout from queueGraph.js; here is only the wiring (draw and the chain).
// Here is only view and interaction: search and the Filter menu, flat view, project lanes or statistics,
// detail panel, settings (the gear), drag to reprioritize (mouse) and lift/move/drop with the keyboard
// (Space, arrow keys, Space; Esc cancels). If the server answers with a warning from the guard rules (409), the board asks
// the owner first ("Do it anyway" / "Cancel", and a proposal when there is one).
// All text is set with textContent (never innerHTML), so content from the queue cannot become HTML. The charts are inline
// SVG made here, with the colors from the CSS variables.
// =============================================================
'use strict';

(function () {
  const KEY = 'queue-board-key';
  const FILTER_STORAGE = 'queue-board-filter';
  const COLUMNS = [
    { key: 'queue', name: 'In queue' },
    { key: 'inProgress', name: 'In progress' },
    { key: 'review', name: 'Review' },
    { key: 'built', name: 'Built' },
  ];

  // The columns where the cards can be bulk edited (status waiting or proposed, also in the batch queue).
  const MARKABLE_COLUMNS = new Set(['queue', 'proposed', 'batch']);

  const $ = (id) => document.getElementById(id);
  const main = $('board');
  const panel = $('panel');
  const background = $('panel-background');

  // "graph" is the "Dependencies" view (graph.js, the layout in queueGraph.js). "plan" is
  // the plan view (Now, Next, Later, Waiting) in plan.js. The tab is called "Focus" (the id `plan` is kept), so
  // it is not confused with the Plans room (the plan register, plans/plans.js).
  const VIEWS = ['flat', 'lanes', 'plan', 'graph', 'cloud', 'statistics'];
  // Browser storage throws when it is blocked (some private modes, strict settings). Every read and write goes through
  // this wrapper, so the board still works then; the choices just are not remembered.
  const store = {
    getItem(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* blocked storage: not remembered */
      }
    },
    removeItem(k) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* blocked storage: nothing stored */
      }
    },
  };
  const savedView = store.getItem('queue-board-view');

  const t = {
    key: null,
    data: null,
    version: null,
    fetched: null,
    error: null,
    perId: new Map(),
    // The filters: checked options per section in the Filter menu (FILTER_SECTIONS), plus the search.
    filter: { selected: readFilter(), search: '' },
    view: VIEWS.includes(savedView) ? savedView : 'flat',
    showMore: false,
    // Closed sections. Blocked is closed from the start (400+ cards), and the content of a closed
    // section is built only when it is opened (section()).
    closed: new Set(['proposed', 'blocked']),
    // The card that is the tab stop in each column or cell (area key → card id).
    roving: new Map(),
    // What depends on the search (counters, empty texts, groups, lanes). Filled by draw(); the search
    // updates them without rebuilding the board (useSearch()).
    searchDep: [],
    selected: null, // the id in detailPanel
    setting: null, // the settings panel: the answer from /api/settings (null = closed)
    stat: { data: null, version: null, error: null }, // the statistics from /api/statistics
    cloudQueue: { data: null, error: null }, // the "Cloud" view: bundle proposals from /api/cloud-bundles
    details: new Map(), // id → { mission, branch } from /api/task
    busy: false, // a move is being saved: do not redraw the board meanwhile
    pending: false,
    // The chain view
    chain: null, // the id of the card whose chain is highlighted (null = none)
    inbox: false, // "Waiting on you" is open in the side panel
    selectedQa: new Set(), // checked in the QA part
    selectedSuggestion: new Set(), // checked in the Suggestion part
    selectedSort: new Set(), // checked in the Sort part
    answerOpen: null, // the question whose answer field is open
    answerDraft: new Map(), // question → text written so far (survives redraws)
    fromInbox: false, // detailPanel was opened from the inbox (the "Back" button)
    // The cloud view
    cloudSelected: new Set(), // cards in the queue checked for a cloud bundle (the "Suitable for cloud" filter)
    cloudPackage: null, // { ids, text, copied } the last fetched cloud package (the text field is the fallback when copying fails)
    // Multi-select. The selection is ids (survives redraws, filter and view changes); `anchor` is the last selected
    // (Shift-click selects everything between). `bulk` is the bulk action dialog (null = closed).
    marked: new Set(),
    anchor: null,
    bulk: null,
    // The server answered 401 (restarted); the banner is shown and polling stops.
    keyInvalid: false,
  };

  // ---- The filters (the Filter menu) ----
  // The sections are data, so more filters (e.g. class or migrations) are one more entry. `mode`:
  //   'all' → every checked option must match (narrowing, like "Only ready now"),
  //   'any' → the card must match at least one checked option; none checked = no filtering (like projects).
  const FILTER_SECTIONS = [
    {
      key: 'show',
      title: 'Show',
      mode: 'all',
      option: () => [
        {
          val: 'readyOnes',
          text: 'Only ready now',
          matches: (k, col) => (col !== 'queue' && col !== 'proposed' && col !== 'batch') || k.ready,
        },
        { val: 'visuals', text: 'Only visuals', matches: (k) => k.visual },
        // Suitable for a cloud session (queueLogic.cloudSuitable), or already in the cloud. With this filter the cards in the
        // queue get a checkbox, so several can be sent as one bundle.
        {
          val: 'cloud',
          text: 'Suitable for cloud',
          matches: (k, col) =>
            (col !== 'queue' && col !== 'proposed' && col !== 'batch') || !!k.cloud?.suitable,
        },
      ],
    },
    {
      key: 'projects',
      title: 'Projects',
      mode: 'any',
      option: () =>
        (t.data?.projects ?? []).map((p) => ({
          val: p.pid,
          text: p.pid,
          project: p,
          matches: (k) => k.project === p.pid,
        })),
    },
    // The cards (and the project lanes) filtered by plan entry.
    {
      key: 'plan',
      title: 'Plan entry',
      mode: 'any',
      option: () =>
        [...new Set([...t.perId.values()].map((x) => x.k?.plan).filter(Boolean))]
          .sort()
          .map((id) => ({
            val: id,
            text: [id, window.QueuePlans?.title(id)].filter(Boolean).join(' '),
            matches: (k) => k.plan === id,
          })),
    },
  ];

  /** Saved filters from this browser (localStorage). Empty or broken gives the default: no filters. */
  function readFilter() {
    const selected = {};
    let saved = null;
    try {
      saved = JSON.parse(store.getItem(FILTER_STORAGE) ?? 'null');
    } catch {
      saved = null;
    }
    for (const key of ['show', 'projects', 'plan']) {
      const list = saved && Array.isArray(saved[key]) ? saved[key] : [];
      selected[key] = new Set(list.filter((x) => typeof x === 'string' && x.length <= 60));
    }
    return selected;
  }
  function saveFilter() {
    try {
      const out = {};
      for (const [k, set] of Object.entries(t.filter.selected)) out[k] = [...set];
      store.setItem(FILTER_STORAGE, JSON.stringify(out));
    } catch {
      /* private mode or full storage: the filters apply only to this session */
    }
  }
  const countFilters = () =>
    Object.values(t.filter.selected).reduce((sum, set) => sum + set.size, 0);
  let drag = null; // { type: 'summary' | 'lane', el, list, previous, next, released }
  let boosted = null; // same shape, lifted with the keyboard

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

  const ICONS = {
    lock: [
      ['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2, fill: 'currentColor' }],
      [
        'path',
        { d: 'M8 11V7a4 4 0 0 1 8 0v4', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 },
      ],
    ],
    close: [
      [
        'path',
        {
          d: 'M6 6l12 12M18 6L6 18',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 2,
          'stroke-linecap': 'round',
        },
      ],
    ],
    // Checkmark: empty inbox ("Nothing waiting on you").
    checkmark: [
      [
        'path',
        {
          d: 'M5 12.5l4.5 4.5L19 7',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 2.5,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      ],
    ],
    handle: [9, 15].flatMap((x) =>
      [6, 12, 18].map((y) => ['circle', { cx: x, cy: y, r: 1.6, fill: 'currentColor' }]),
    ),
    // Gear: a ring and eight teeth.
    gear: [
      ...[0, 45, 90, 135, 180, 225, 270, 315].map((v) => [
        'rect',
        {
          x: 10.25,
          y: 1.5,
          width: 3.5,
          height: 5,
          rx: 1,
          fill: 'currentColor',
          transform: `rotate(${v} 12 12)`,
        },
      ]),
      [
        'circle',
        { cx: 12, cy: 12, r: 5.25, fill: 'none', stroke: 'currentColor', 'stroke-width': 3 },
      ],
    ],
  };
  function icon(name, label) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', `icon ${name}`);
    if (label) {
      s.setAttribute('role', 'img');
      s.setAttribute('aria-label', label);
    } else s.setAttribute('aria-hidden', 'true');
    for (const [tag, attr] of ICONS[name]) {
      const d = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attr)) d.setAttribute(k, String(v));
      s.append(d);
    }
    return s;
  }

  /** "14 min", "3 h 12 min", "4 d" (display only). */
  function age(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '?';
    const min = Math.max(0, Math.round(ms / 60_000));
    if (min < 60) return `${min} min`;
    const hours = Math.floor(min / 60);
    return hours < 48 ? `${hours} h ${min % 60} min` : `${Math.floor(hours / 24)} d`;
  }
  const clock = (d) =>
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ---- The toast stack ----
  // The message and "Undo" sit in the same stack (#toaster, flex-column), so they never overlap. The queue
  // (QueueA11y.toastAdd) says which are shown and in which order: newest at the bottom. "Undo" never drops out of the
  // queue before the 30 seconds have passed or the owner closes it.
  const TOAST_EL = { message: 'message', undo: 'undo-message' };
  let toastQueue = [];
  function drawToaster() {
    for (const [key, id] of Object.entries(TOAST_EL)) {
      const i = toastQueue.indexOf(key);
      const box = $(id);
      box.hidden = i < 0;
      box.style.order = String(Math.max(0, i));
    }
  }
  function showToast(key) {
    toastQueue = window.QueueA11y.toastAdd(toastQueue, key, { max: 3, kept: ['undo'] });
    drawToaster();
  }
  function hideToast(key) {
    toastQueue = window.QueueA11y.toastRemove(toastQueue, key);
    drawToaster();
  }

  let messageTime = null;
  function message(text, error, ms) {
    const m = $('message');
    m.textContent = text;
    m.classList.toggle('error', !!error);
    showToast('message');
    clearTimeout(messageTime);
    messageTime = setTimeout(() => hideToast('message'), ms ?? (error ? 9000 : 6000));
  }

  // ---- Key and API ----
  function getKey() {
    const m = /[#&]key=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (m) {
      sessionStorage.setItem(KEY, m[1]);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return sessionStorage.getItem(KEY);
  }

  // ---- The banner after a restart ----
  const keyBanner = $('key-banner');
  /** Shows the banner and stops polling (t.keyInvalid). Old data stays, but the banner says so. */
  function showKeyBanner() {
    t.keyInvalid = true;
    if (!keyBanner.hidden) return;
    keyBanner.hidden = false;
    document.body.classList.add('key-invalid');
  }
  $('key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const field = $('key-link');
    const error = $('key-error');
    const fresh = window.QueueA11y.keyFromLink(field.value);
    if (!fresh) {
      error.textContent = 'No key found. The link ends with #key=… .';
      error.hidden = false;
      field.focus();
      return;
    }
    sessionStorage.setItem(KEY, fresh);
    t.key = fresh;
    t.keyInvalid = false;
    t.version = null;
    field.value = '';
    error.hidden = true;
    keyBanner.hidden = true;
    document.body.classList.remove('key-invalid');
    update(true);
    if (t.view === 'statistics') getStatistics();
    if (t.view === 'cloud') getCloudQueue();
  });

  // The write calls that are the owner's actions (approve, resolve, mark, bulk, move, focus). After a successful call the
  // mascot may say something (the night line on an owner action); a dry run or a preview does not count.
  const OWNER_ACTIONS = new Set(['/api/action', '/api/bulk', '/api/move', '/api/focus']);
  async function api(filePath, body) {
    const init = { headers: { 'X-Queue-Key': t.key ?? '' } };
    if (body) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(filePath, init);
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
    // 401 means the server has been restarted with a new key. The banner asks for the link, and
    // polling stops until the key is in place.
    if (res.status === 401) showKeyBanner();
    if (!res.ok) {
      // The status and the answer come along, so a warning from the guard rules (409 + confirm) can be confirmed.
      const e = new Error(answer?.message ?? `HTTP ${res.status}`);
      e.status = res.status;
      e.answer = answer;
      throw e;
    }
    if (body && OWNER_ACTIONS.has(filePath) && !body.dry && !body.show)
      window.QueueMascotView?.ownerAction();
    return answer;
  }

  /**
   * A write call with the guard rules: if the server answers with a warning (409 with `confirm`), the board asks the owner
   * first and sends the call again with `confirm: true` (and the proposal's fields when the owner chose the proposal).
   * Returns the answer, or null when the owner cancelled. A stop (422) and other errors are thrown as before.
   */
  async function writeWithGuard(filePath, body) {
    try {
      return await api(filePath, body);
    } catch (e) {
      if (e.status !== 409 || !e.answer?.confirm) throw e;
      const option = await confirmGuard(e.answer.guard ?? []);
      if (!option) return null;
      return api(filePath, { ...body, ...option, confirm: true });
    }
  }

  // ---- The confirmation on a warning ----
  const guardBackground = $('guard-background');
  const guardBox = $('guard');
  /** Shows the warnings and waits for the owner: {} = do it anyway, the proposal's fields = the proposal, null = cancel. */
  function confirmGuard(guard) {
    return new Promise((done) => {
      const from = document.activeElement;
      const warnings = guard.filter((v) => v.level === 'warning');
      const others = guard.filter((v) => v.level === 'info');
      const proposed = warnings.find((v) => v.proposed)?.proposed ?? null;
      const answer = (val) => {
        guardBackground.hidden = true;
        guardBox.replaceChildren();
        guardBox.removeEventListener('keydown', keys);
        if (from?.isConnected) from.focus();
        done(val);
      };
      const keys = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          answer(null);
        } else {
          // Focus stays in the dialog (the shared trap in a11y.js).
          window.QueueA11y.trapKey(e, guardBox);
        }
      };
      const cancel = el('button', {
        type: 'button',
        class: 'button button-outline',
        text: 'Cancel',
        onclick: () => answer(null),
      });
      guardBox.replaceChildren(
        el('h2', { id: 'guard-title', text: 'Are you sure?' }),
        el(
          'ul',
          { id: 'guard-text', class: 'guard-list' },
          warnings.map((v) => el('li', { text: v.text })),
          others.map((v) => el('li', { class: 'guard-info', text: v.text })),
        ),
        el(
          'div',
          { class: 'guard-buttons' },
          cancel,
          proposed
            ? el('button', {
                type: 'button',
                class: 'button button-muted',
                text: proposed.text,
                onclick: () => answer({ ...proposed.field }),
              })
            : null,
          el('button', {
            type: 'button',
            class: 'button button-filled',
            text: 'Do it anyway',
            onclick: () => answer({}),
          }),
        ),
      );
      guardBox.addEventListener('keydown', keys);
      guardBackground.hidden = false;
      cancel.focus();
    });
  }
  guardBackground.addEventListener('click', (e) => {
    if (e.target === guardBackground) guardBox.querySelector('button')?.click();
  });

  /** Message after a successful write, with the info texts from the guard rules below. */
  function messageWithInfo(ok, answer) {
    const info = Array.isArray(answer?.info) ? answer.info : [];
    message([ok, ...info].join('\n'), false, info.length ? 9000 : null);
  }

  // ---- Fetching (every 15 seconds and when the tab gets focus; the server answers "unchanged" when nothing is new) ----
  let fetching = false;
  let forceAfter = false; // a forced fetch that came while another was running: runs when that one is done
  async function update(force) {
    // Without a valid key polling stops (the banner asks for the link); a forced fetch tries anyway.
    if (fetching && force) forceAfter = true; // otherwise the row would stay until the next poll
    if (fetching || !t.key || (t.keyInvalid && !force)) return;
    fetching = true;
    try {
      const q = t.version && !force ? `?version=${encodeURIComponent(t.version)}` : '';
      const answer = await api(`/api/state${q}`);
      t.error = null;
      t.fetched = new Date();
      if (!answer.unchanged) {
        t.data = answer.data;
        t.version = answer.version;
        indexes();
        drawLogo();
        drawUpdateBanner();
        // The mascot sees the change (events between two polls) and may say something.
        window.QueueMascotView?.newState(t.data);
        if (drag || boosted || t.busy || window.QueuePlan?.busy()) t.pending = true;
        else if (t.view === 'cloud')
          getCloudQueue(); // the bundles depend on the queue: fetch again
        else if (t.view !== 'statistics')
          draw(); // the statistics have their own fetching
        else drawFilter();
        // "Waiting on you": the counter at the top, and the panel when it is open.
        drawInboxButton();
        if (t.inbox) drawInbox();
      }
    } catch (e) {
      t.error = e.message;
      if (!t.data) draw();
    } finally {
      fetching = false;
      // While a card is lifted, the keyboard help text stays in the status line.
      if (!boosted) drawStatus();
    }
    if (forceAfter) {
      forceAfter = false;
      await update(true);
    }
  }

  function indexes() {
    t.perId = new Map();
    for (const [col, list] of Object.entries(t.data.columns))
      for (const k of list) t.perId.set(k.id, { k, col });
    // A selected card that has started, is done or is gone drops out of the selection.
    for (const id of t.marked) if (!markable(id)) t.marked.delete(id);
    if (t.anchor && !markable(t.anchor)) t.anchor = null;
  }

  function drawStatus() {
    const s = $('status');
    if (!t.key) {
      s.textContent = 'Missing key: open the link queue-board wrote in the terminal.';
      s.classList.add('error');
      return;
    }
    s.classList.toggle('error', !!t.error);
    // The last successful fetch is over one minute old (the clock at the bottom calls drawStatus).
    const old =
      !t.error && !t.keyInvalid && window.QueueA11y.stale(t.fetched?.getTime() ?? NaN, Date.now());
    s.classList.toggle('stale', old);
    if (old) s.textContent = window.QueueA11y.staleText(t.fetched);
    else if (t.keyInvalid)
      s.textContent = t.fetched
        ? `The key is old. Showing the state from ${clock(t.fetched)}.`
        : 'The key is old.';
    else if (t.error)
      s.textContent = t.fetched
        ? `Could not read the queue (${t.error}). Showing the state from ${clock(t.fetched)}.`
        : `Could not read the queue (${t.error}).`;
    else if (t.fetched)
      s.textContent =
        `Updated at ${clock(t.fetched)}` +
        (t.data?.gitError
          ? ' (git status could not be read; uncommitted files are not checked)'
          : '');
  }

  // ---- Filters ----
  function visible(k, col) {
    return visibleWithoutSearch(k, col) && searchMatch(k);
  }

  /** The search alone (the search hides cards with `hidden`, while the filters decide what is built). */
  function searchMatch(k) {
    if (!t.filter.search) return true;
    return `${k.id} ${k.title} ${k.feature ?? ''} ${k.project}`
      .toLowerCase()
      .includes(t.filter.search);
  }

  /** The filters and views without the search: the cards built in Flat and Project lanes. */
  function visibleWithoutSearch(k, col) {
    // A built-in view (t.special) filters the cards in queue, proposed and the batch queue. "New since last"
    // applies to all columns. t.special is null until the views are set up, so SPECIAL is never used before it exists.
    if (t.special && (MARKABLE_COLUMNS.has(col) || t.special === 'newEntry') && !SPECIAL[t.special](k))
      return false;
    for (const s of FILTER_SECTIONS) {
      const selected = t.filter.selected[s.key];
      if (!selected?.size) continue;
      const activeOnes = s.option().filter((v) => selected.has(v.val));
      if (!activeOnes.length) continue; // a saved option that no longer exists (e.g. a removed project)
      const ok =
        s.mode === 'all'
          ? activeOnes.every((v) => v.matches(k, col))
          : activeOnes.some((v) => v.matches(k, col));
      if (!ok) return false;
    }
    return true;
  }

  // ---- The search without rebuilding ----
  /**
   * Registers something that depends on the search: `update(match)` gets the cards in `summary` that match the search, now
   * and every time the search changes. Used for counters, empty texts, groups and lanes; the cards themselves are hidden in useSearch().
   */
  function searchBound(summary, update) {
    t.searchDep.push({ summary, update });
    update(t.filter.search ? summary.filter(searchMatch) : summary);
  }

  /**
   * The search has changed: hide and show the built cards (hidden), and update what is registered with searchBound.
   * No card is rebuilt. `root` limits the cards to a part of the board (a section that was just built).
   */
  function useSearch(root = main) {
    for (const li of root.querySelectorAll('.summary[data-id]')) {
      const x = t.perId.get(li.dataset.id);
      li.hidden = !!x && !searchMatch(x.k);
    }
    if (root !== main) return;
    updateSearchDep();
    afterSearch();
  }

  /** Runs what is registered with searchBound (the search or the selection has changed). */
  function updateSearchDep() {
    for (const a of t.searchDep) a.update(t.filter.search ? a.summary.filter(searchMatch) : a.summary);
  }

  /**
   * After drawing and after the search: an area heading with no visible lanes below it is hidden, the empty text in
   * Project lanes is shown only when no lane is visible, and every column gets its tab stop (rovingSetup).
   */
  function afterSearch() {
    let heading = null;
    let visibleUnder = false;
    let visibleLanes = 0;
    let empty = null;
    for (const li of main.querySelectorAll(':scope > .laneList > li')) {
      if (li.classList.contains('lane-empty')) empty = li;
      else if (li.classList.contains('area-heading')) {
        if (heading) heading.hidden = !visibleUnder;
        heading = li;
        visibleUnder = false;
      } else if (!li.hidden) {
        visibleUnder = true;
        visibleLanes++;
      }
    }
    if (heading) heading.hidden = !visibleUnder;
    if (empty) {
      empty.hidden = visibleLanes > 0;
      // The shared emptyState (the reason and the action), built when it is shown.
      if (!empty.hidden) empty.replaceChildren(emptyState('No cards here.'));
    }
    rovingSetup();
  }

  function project(pid) {
    return t.data?.projects.find((p) => p.pid === pid) ?? null;
  }

  // ---- The card ----
  /** The tooltip for aging work: over p85 for the class. */
  function agingText(k) {
    const a = k.aging;
    if (!a) return null;
    return a.measure === 'work'
      ? `Older than usual: 85 % of ${k.class} tasks in the last 14 days were delivered within ` +
          `${duration(a.limit)} of starting. This one has been running for ${duration(a.age)}.`
      : `Older than usual: 85 % of ${k.class} tasks in the last 14 days were finished within ` +
          `${duration(a.limit)} of starting. This one started ${duration(a.age)} ago.`;
  }

  function footerFor(k, col) {
    const footer = [];
    if (col === 'queue') {
      if (k.ready) footer.push(el('span', { class: 'badge ready-badge', text: 'Ready now' }));
      else {
        const h = k.blockers[0] ?? '';
        const more = k.blockers.length > 1 ? ` (+${k.blockers.length - 1})` : '';
        footer.push(
          el('span', { class: 'blocker', text: h + more, title: k.blockers.join('\n') }),
        );
      }
    } else if (col === 'proposed') {
      footer.push(el('span', { text: k.added_by ? `proposed by ${k.added_by}` : 'proposed' }));
    } else if (col === 'batch') {
      // Not started alone; the orchestrator packs the group into a track (queue.mjs batch pack).
      footer.push(
        el('span', {
          text: k.status === 'proposed' ? 'proposed in the batch queue' : 'packed into a track',
        }),
      );
    } else if (col === 'inProgress') {
      // A card in a cloud session gets a small cloud badge instead of "picked by cloud".
      if (k.in_cloud)
        footer.push(
          el('span', {
            class: 'badge cloud-badge',
            text: 'Cloud',
            title: k.cloud_session?.execution ? `Cloud session: ${k.cloud_session.execution}` : 'Running in a cloud session',
          }),
        );
      const who = k.in_cloud
        ? 'in the cloud'
        : k.status === 'picked'
          ? `picked by ${k.picked_by ?? '?'}`
          : k.status === 'external'
            ? `outside the queue: ${k.external_name ?? '?'}`
            : 'running';
      footer.push(el('span', { text: who }));
      if (k.start)
        footer.push(
          el('span', {
            'data-start': k.start,
            class: k.aging ? 'age-over' : null,
            title: k.aging ? 'Running longer than 85 % of finished tasks of this class' : null,
            text: age(k.start),
          }),
        );
      if (k.old) footer.push(el('span', { class: 'badge old', text: 'old', title: 'Picked over 72 hours ago with no commits on its branch' }));
    } else if (col === 'review') {
      if (k.delivered)
        footer.push(
          el('span', {
            class: k.aging ? 'age-over' : null,
            title: k.aging ? 'Waiting in review longer than 85 % of finished tasks of this class' : null,
            text: `delivered ${age(k.delivered)} ago`,
          }),
        );
    } else if (col === 'built') {
      if (k.qa_status === 'waiting')
        footer.push(el('span', { class: 'badge qa', text: 'Waiting for QA' }));
      else if (k.qa_status === 'deviation')
        footer.push(el('span', { class: 'badge deviation', text: 'QA deviation' }));
      if (k.done) footer.push(el('span', { text: `done ${age(k.done)} ago` }));
    }
    return footer;
  }

  /** The project name on the card is redundant in Project lanes and when Flat is grouped by project. */
  function showProjectName() {
    if (t.view === 'lanes') return false;
    return !['area', 'feature'].includes(t.grouping);
  }

  function summaryEl(k, col) {
    const movable = col === 'queue';
    const p = project(k.project);
    const classes = ['summary'];
    if (col === 'queue') classes.push(k.ready ? 'ready' : 'blocked');
    if (col === 'batch') classes.push('batchCard');
    if (k.aging) classes.push('aging');
    // Cards that can be bulk edited (waiting, proposed, batch queue) get a checkbox.
    const canBeMarked = MARKABLE_COLUMNS.has(col);
    if (canBeMarked && t.marked.has(k.id)) classes.push('marked');
    const statusText =
      col === 'queue'
        ? k.ready
          ? 'ready now'
          : `blocked: ${k.blockers.join('; ')}`
        : col === 'batch'
          ? 'in the batch queue, packed into a track'
          : k.status;
    // "Unlocks N": not on Built, where the card itself is done.
    const lockState = col !== 'built' ? k.unlocks : null;
    const lockText = lockState
      ? `Unlocks ${lockState.count} ${lockState.count === 1 ? 'task' : 'tasks'} (${duration(lockState.minutes)} estimated) via the chain`
      : null;
    // The button (the title) is described by the metadata and the footer. What is otherwise only in tooltips
    // (all the blockers, unlocks, older than usual) is added as hidden text among the metadata.
    const metaId = `summary-meta-${col}-${k.id}`;
    const footerId = `summary-footer-${col}-${k.id}`;
    const hiddenText = [
      col === 'queue' && !k.ready && k.blockers.length > 1 ? statusText : null,
      col === 'batch' ? statusText : null,
      lockText,
      k.aging ? 'Older than usual for the class' : null,
    ]
      .filter(Boolean)
      .join('. ');
    return el(
      'li',
      {
        // The card itself is not focusable and has no aria-label overriding its content.
        // The title is the button (roving tabindex), and the metadata describes it (aria-describedby).
        class: classes.join(' '),
        draggable: movable ? 'true' : null,
        'data-id': k.id,
        'data-col': col,
        'data-markable': canBeMarked ? '1' : null,
        '--p': `var(--color-${k.color})`,
        title: [
          `${p?.title ?? k.project}${k.feature ? ` · ${k.feature}` : ''}`,
          agingText(k),
        ]
          .filter(Boolean)
          .join('\n'),
      },
      el(
        'div',
        { class: 'summary-header' },
        // The checkbox sits outside the button and outside the metadata (it has its own label).
        canBeMarked ? markBox(k) : null,
        el(
          'span',
          { class: 'summary-meta', id: metaId },
          el('span', { class: 'summary-id', text: k.id }),
          // The project's short name as text (the color stripe alone has too low contrast), but not when
          // the cards are already grouped per project.
          showProjectName()
            ? el('span', {
                class: 'summary-project',
                text: k.project,
                title: p?.title ?? k.project,
              })
            : null,
          // The plan entry the card belongs to. A click switches to Plans with the entry open. The badge is not a
          // tab stop of its own (roving tabindex); with the keyboard the way goes via "Plan entry" in detailPanel.
          k.plan
            ? el('button', {
                type: 'button',
                class: 'badge plan-entry-badge',
                tabindex: '-1',
                text: k.plan,
                title: `Plan entry ${k.plan}: open in Plans`,
                onclick: (e) => {
                  e.stopPropagation();
                  window.QueuePlans?.openEntry(k.plan);
                },
              })
            : null,
          k.class
            ? el('span', {
                class: `badge${k.class === 'D+' ? ' class-dplus' : ''}`,
                text: k.class,
                title: window.QueueA11y.classLabel(k.class),
                'aria-label': window.QueueA11y.classLabel(k.class),
              })
            : null,
          el('span', { class: 'badge', text: `${k.estimate} min`, title: 'Estimated work minutes for an agent, not wall-clock time' }),
          k.visual ? el('span', { class: 'badge visual', text: 'visual', title: 'Needs a manual visual check after merge (the QA list)' }) : null,
          k.parked
            ? el('span', {
                class: 'badge wait-badge',
                text: 'on hold',
                title: waitText(k.parked),
              })
            : null,
          lockState
            ? el('span', {
                class: 'badge locks',
                text: `unlocks ${lockState.count}`,
                title: lockText,
              })
            : null,
          col === 'queue' && !k.ready ? icon('lock', 'blocked') : null,
          hiddenText ? el('span', { class: 'hidden-for-eye', text: hiddenText }) : null,
        ),
        col === 'queue' && cloudFilterOn() && k.cloud?.suitable ? cloudSelect(k) : null,
      ),
      el(
        'p',
        { class: 'summary-title' },
        el('button', {
          type: 'button',
          class: 'summary-button',
          tabindex: '-1', // rovingSetup() makes one card per column the tab stop
          'aria-describedby': `${metaId} ${footerId}`,
          text: k.title,
        }),
      ),
      el('p', { class: 'summary-footer', id: footerId }, footerFor(k, col)),
    );
  }

  // ---- The card buffer ----
  // The board does not rebuild the cards when they are unchanged: the node is reused by column and task id, and only cards
  // that changed are built (window.QueuePerformance.makeSummaryBuffer, the diff is tested in vitest). The selection and the
  // search are outside the signature; they are set on the node every time (syncSummary), so selecting or searching builds no card.
  const summaryBuffer = window.QueuePerformance.makeSummaryBuffer();

  /** Everything the card's DOM depends on, except the selection, the search and the chain (those are set on the node afterward). */
  function summarySignature(k, col) {
    return JSON.stringify([
      k,
      col,
      project(k.project)?.title ?? null,
      showProjectName(),
      col === 'queue' && cloudFilterOn() && k.cloud?.suitable ? t.cloudSelected.has(k.id) : null,
      // The age in the text (In progress is also updated by the clock, see setInterval at the bottom).
      k.delivered ? age(k.delivered) : null,
      k.done ? age(k.done) : null,
    ]);
  }

  /** The node for the card: reused when unchanged, otherwise built. Selection and search are set on it here. */
  function summaryNode(k, col) {
    const node = summaryBuffer.node(`${col}|${k.id}`, summarySignature(k, col), () => summaryEl(k, col));
    syncSummary(node);
    return node;
  }

  /** Sets the selection and the search on an existing card node (no rebuild). */
  function syncSummary(node) {
    const id = node.dataset.id;
    const x = t.perId.get(id);
    if (x) node.hidden = !searchMatch(x.k);
    if (!node.dataset.markable) return;
    const marked = t.marked.has(id);
    node.classList.toggle('marked', marked);
    const box = node.querySelector('.mark-box input');
    if (box && box.checked !== marked) box.checked = marked;
  }

  // ---- Cloud ----
  const cloudFilterOn = () => !!t.filter.selected.show?.has('cloud');

  /** The checkbox on a cloud-suitable card (only with the "Suitable for cloud" filter). */
  function cloudSelect(k) {
    return el(
      'label',
      { class: 'cloud-select', title: 'Include in the cloud bundle' },
      el('input', {
        type: 'checkbox',
        checked: t.cloudSelected.has(k.id),
        'aria-label': `Include ${k.id} in the cloud bundle`,
        tabindex: '-1', // roving tabindex: only the card that is the stop in the column
        onchange: (e) => {
          if (e.target.checked) t.cloudSelected.add(k.id);
          else t.cloudSelected.delete(k.id);
          draw();
        },
      }),
      el('span', { text: 'Cloud' }),
    );
  }

  /** The checked ones that are still cloud-suitable and in the queue (a card may have moved since). */
  function cloudSelected() {
    const out = [];
    for (const id of t.cloudSelected) {
      const x = t.perId.get(id);
      if (x && x.col === 'queue' && x.k.cloud?.suitable) out.push(id);
      else t.cloudSelected.delete(id);
    }
    return out;
  }

  /** Fetches the cloud package (one task or a bundle) via the server (queue.mjs cloud-package) and copies it. */
  async function copyCloudPackage(ids) {
    try {
      const q = ids.map((x) => `id=${encodeURIComponent(x)}`).join('&');
      const d = await api(`/api/cloudPackage?${q}`);
      t.cloudPackage = { ids: [...ids], text: d.text, copied: false };
      try {
        await navigator.clipboard.writeText(d.text);
        t.cloudPackage.copied = true;
        message(
          `The cloud package for ${ids.join(', ')} is copied. Paste it into a cloud session, and press "Started in cloud".`,
        );
      } catch {
        message('Could not copy automatically: select the text in the field and copy it yourself.', true);
      }
    } catch (e) {
      message(e.message, true);
    }
    draw();
    if (t.selected) drawPanel(true);
  }

  /** The fallback when the clipboard does not work: the package in a text field, only for the same ids. */
  function cloudPackageField(ids) {
    const p = t.cloudPackage;
    if (!p || p.copied || p.ids.join(' ') !== ids.join(' ')) return null;
    return el(
      'div',
      { class: 'field cloud-package-field' },
      el('label', { for: 'cloud-package-text', text: 'Cloud package (select all and copy)' }),
      el('textarea', { id: 'cloud-package-text', rows: 6, readonly: true, text: p.text }),
    );
  }

  /** The line above In queue with the checked ones: copy the bundle package, register the start, or clear the selection. */
  function cloudBundleLine() {
    if (!cloudFilterOn()) return null;
    const ids = cloudSelected();
    if (!ids.length)
      return el('p', {
        class: 'cloud-bundle empty',
        text: 'Check up to 4 cards to send them as one cloud bundle.',
      });
    const sum = ids.reduce((s, id) => s + (t.perId.get(id)?.k.estimate ?? 0), 0);
    return el(
      'div',
      { class: 'cloud-bundle' },
      el('span', { text: `${ids.length} selected for cloud · ${sum} min` }),
      el('button', {
        type: 'button',
        class: 'button button-filled',
        text: 'Copy cloud package',
        onclick: () => copyCloudPackage(ids),
      }),
      el('button', {
        type: 'button',
        class: 'button button-muted',
        text: 'Started in cloud',
        onclick: async () => {
          if (await action({ type: 'cloud-start', ids }, `${ids.join(', ')} started in the cloud`))
            t.cloudSelected.clear();
        },
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: 'Clear',
        onclick: () => {
          t.cloudSelected.clear();
          draw();
        },
      }),
      cloudPackageField(ids),
    );
  }

  /** The cloud part of detailPanel: suitability and the cloud session. */
  function cloudFacts(k) {
    if (k.in_cloud) {
      const s = k.cloud_session ?? {};
      return [
        `In the cloud for ${s.started ? age(s.started) : '?'}`,
        s.execution ? ' · ' : null,
        s.execution ? cloudLink(s.execution) : null,
      ];
    }
    if (k.cloud_session?.done)
      return `Completed in the cloud (branch ${k.cloud_session.branch ?? k.branch}); the orchestrator merges`;
    if (!k.cloud) return null;
    return k.cloud.suitable
      ? 'Suitable for cloud'
      : el('div', null, el('span', { text: 'Not suitable:' }), list2(k.cloud.reasons));
  }

  /** The session as a link when it is an https address, otherwise as text (never a javascript: link from the queue). */
  function cloudLink(execution) {
    return /^https:\/\/[^\s]+$/.test(execution)
      ? el('a', { href: execution, target: '_blank', rel: 'noopener noreferrer', text: execution })
      : el('code', { text: execution });
  }

  function list(summary, col, section) {
    const ol = el('ol', { class: 'shortlist', 'data-section': section ?? col });
    for (const k of summary) ol.append(summaryNode(k, col));
    return ol;
  }

  // ---- Empty state ----
  // All empty lists say why they are empty and have one action that shows the cards: "Clear search", "Remove filter"
  // or "Show all" (selection). The rule is QueueA11y.emptyReason (a11y.js, tested in queueBoardA11y.test.ts).

  /** The text and the button for an empty list. `searchHides`: the list has cards, but the search hides all of them. */
  function emptyContent(text, searchHides) {
    const g = window.QueueA11y.emptyReason({
      text,
      searchHides,
      search: t.filter.search,
      filters: countFilters(),
      selection: t.viewName ?? null,
    });
    const parts = [el('p', { text: g.text })];
    if (g.action)
      parts.push(
        el('button', {
          type: 'button',
          class: 'link-button',
          text: g.label,
          onclick: (e) => {
            e.stopPropagation();
            emptyAction(g.action);
          },
        }),
      );
    return parts;
  }

  /** The shared emptyState as an element of its own (batch queue, Project lanes and the graph). */
  function emptyState(text, searchHides = !!t.filter.search) {
    return el('div', { class: 'empty empty-state' }, ...emptyContent(text, searchHides));
  }
  // The graph (graph.js) uses the same empty state.
  window.QueueEmpty = (text) => emptyState(text);

  /** The action in emptyState. Focus goes to the control that was changed, so the keyboard does not lose its place. */
  function emptyAction(action) {
    if (action === 'search') {
      const search = $('search');
      search.value = '';
      search.dispatchEvent(new Event('input'));
      search.focus();
    } else if (action === 'filter') {
      for (const set of Object.values(t.filter.selected)) set.clear();
      changedFilter();
      $('filter-button').focus();
    } else if (action === 'selection') showAll();
  }

  /** Empty state for a list: shown when none of the cards match the search (also when the list was empty already). */
  function emptyText(summary, text) {
    const box = el('div', { class: 'empty empty-state' });
    searchBound(summary, (match) => {
      box.hidden = match.length > 0;
      if (!box.hidden) box.replaceChildren(...emptyContent(text, summary.length > 0));
    });
    return box;
  }

  /**
   * The content of a column (flat) or a cell (lane) for the given cards. The cards are filtered, but not
   * searched: the search hides cards, and the counters and empty texts follow the search via searchBound.
   */
  function columnContent(col, summary, proposed, batch) {
    const parts = [];
    if (col === 'queue') {
      const readyOnes = summary.filter((k) => k.ready);
      const blocked = summary.filter((k) => !k.ready);
      const title = el('h3', { class: 'section-title' });
      searchBound(readyOnes, (match) => (title.textContent = `Ready now (${match.length})`));
      parts.push(title, emptyText(readyOnes, 'Nothing is ready now.'));
      if (readyOnes.length) parts.push(groupedList(readyOnes, 'queue', 'ready'));
      if (blocked.length)
        parts.push(
          section(
            'blocked',
            blocked,
            (n) => `Blocked (${n})`,
            () => groupedList(blocked, 'queue', 'blocked'),
          ),
        );
      if (proposed?.length)
        parts.push(
          section(
            'proposed',
            proposed,
            (n) => `Proposed (${n})`,
            () => groupedList(proposed, 'proposed'),
          ),
        );
      // The batch queue on its own, grouped with the sum toward the target; the cards are not started alone.
      if (batch?.length)
        parts.push(
          section(
            'batch',
            batch,
            (n) => `Batch queue (${n})`,
            () => batchContent(batch),
          ),
        );
      return parts;
    }
    let show = summary;
    let hidden = 0;
    if (col === 'built' && !t.showMore) {
      show = summary.filter((k) => k.recent);
      hidden = summary.length - show.length;
    }
    parts.push(emptyText(show, 'Nothing here.'));
    if (show.length) parts.push(groupedList(show, col));
    if (col === 'built' && (hidden || t.showMore)) {
      const button = el('button', {
        type: 'button',
        class: 'button button-outline show-more',
        text: 'Show only the last 7 days',
        onclick: () => {
          t.showMore = !t.showMore;
          draw();
        },
      });
      if (!t.showMore)
        searchBound(
          summary,
          (match) => (button.textContent = `Show more (${match.filter((k) => !k.recent).length})`),
        );
      parts.push(button);
    }
    return parts;
  }

  /**
   * The batch queue grouped (project → class) with the sum of content minutes toward the class target, a bar with
   * the lower target marked, "Ready for packing" from the lower target, and the cards in the group. The groups come from
   * the server (queueLogic.batchGroups); here only those with visible cards after search and filter are shown.
   */
  function batchContent(summary) {
    // The sums, the buttons and "hidden by the filter" follow the search, so the batch queue (which is small) is redrawn
    // in its own box when the search or the selection changes; the rest of the board stays.
    const box = el('div', { class: 'batch-box' });
    searchBound(summary, (match) => box.replaceChildren(batchGroups(match)));
    return box;
  }

  function batchGroups(summary) {
    const visibleOnes = new Map(summary.map((k) => [k.id, k]));
    const groups = (t.data.batchQueue ?? [])
      .map((g) => ({ g, summary: g.tasks.map((o) => visibleOnes.get(o.id)).filter(Boolean) }))
      .filter((x) => x.summary.length);
    if (!groups.length) return emptyState('Nothing here.');
    return el(
      'div',
      { class: 'batch-groups' },
      groups.map(({ g, summary: gk }) => {
        const p = project(g.pid);
        const max = g.measure?.max ?? 0;
        const share = max ? Math.min(g.sum / max, 1) : 0;
        const measureText = g.measure ? `${g.measure.min}–${g.measure.max}` : '?';
        const status = g.invalid
          ? `${g.class} is not packed`
          : g.ready
            ? g.over
              ? 'Ready for packing (becomes several tracks)'
              : 'Ready for packing'
            : `${g.measure.min - g.sum} min short`;
        return el(
          'section',
          {
            class: `batch-group${g.ready ? ' ready' : ''}`,
            'aria-label': `${p?.title ?? g.pid}, class ${g.class}: ${g.sum} of ${measureText} min. ${status}.`,
            '--p': `var(--color-${p?.color ?? 'category-graphite'})`,
          },
          el(
            'div',
            { class: 'batch-header' },
            el('span', { class: 'batch-name', text: g.pid, title: p?.title ?? g.pid }),
            el('span', {
              class: `badge${g.class === 'D+' ? ' class-dplus' : ''}`,
              text: g.class,
              title: window.QueueA11y.classLabel(g.class),
            }),
            g.ready && !g.invalid
              ? el('span', { class: 'badge ready-badge', text: status })
              : el('span', { class: 'batch-missing', text: status }),
          ),
          el(
            'div',
            {
              class: 'batch-bar',
              role: 'img',
              'aria-label': `${g.sum} of ${measureText} content minutes`,
              title: `Target for ${g.class}: ${measureText} min of content. Ready for packing from ${g.measure?.min ?? '?'} min.`,
            },
            el('span', { class: 'batch-fill', '--share': String(share) }),
            g.measure
              ? el('span', {
                  class: 'batch-lower',
                  '--lower': String(Math.min(g.measure.min / max, 1)),
                })
              : null,
          ),
          el('p', {
            class: 'batch-sum',
            text:
              `${g.sum} / ${measureText} min · ${g.count} ${g.count === 1 ? 'task' : 'tasks'}` +
              (g.common_files.length ? ` · ${g.common_files.length} common file(s)` : ''),
            title: g.common_files.length ? `Common files: ${g.common_files.join(', ')}` : null,
          }),
          batchButtons(g, gk),
          list(gk, 'batch', 'batch'),
        );
      }),
    );
  }

  /**
   * The buttons in a batch group. "Pack into track" shows the new track before it is created,
   * "Take out of batch queue" makes the tasks their own tracks again, and the box selects the group for the selection bar.
   * They apply to the cards shown (search and filter); the line says so when any in the group are hidden.
   */
  function batchButtons(g, summary) {
    const ids = summary.map((k) => k.id);
    const hidden = g.count - ids.length;
    const allMarked = ids.length > 0 && ids.every((id) => t.marked.has(id));
    const canBePacked = !g.invalid && ids.length >= 2;
    const who = hidden
      ? `the ${ids.length} shown (${hidden} hidden by the filter)`
      : 'the whole group';
    return el(
      'div',
      { class: 'batch-buttons' },
      el(
        'label',
        {
          class: 'mark-group',
          title: `Select ${who} for the selection bar (bulk actions)`,
        },
        el('input', {
          type: 'checkbox',
          checked: allMarked,
          'aria-label': `Select the batch group ${g.pid} ${g.class}`,
          onchange: (e) => markMany(ids, e.target.checked),
        }),
        el('span', { text: 'Select' }),
      ),
      el('button', {
        type: 'button',
        class: 'button button-muted button-small',
        text: 'Pack into track',
        disabled: !canBePacked,
        title: g.invalid
          ? `${g.class} is not packed (D+ is never merged with others)`
          : ids.length < 2
            ? 'Packing requires at least two tasks. Take a single task out of the batch queue instead.'
            : `Merge ${who} into one new track. You see the new track before it is created.`,
        onclick: () => openBulk('batch-pack', ids),
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text: 'Take out of batch queue',
        title: `Take ${who} out of the batch queue, so they start as their own tracks. You see the change before it is saved.`,
        onclick: () => openBulk('batch-out', ids),
      }),
    );
  }

  /**
   * A section that can be closed (Blocked, Proposed, Batch queue). The content is built only when
   * the section is open (`build()`), so a closed Blocked costs nothing. The title (`title(count)`) follows the search,
   * and the section is hidden when none of the cards match.
   */
  function section(name, summary, title, build) {
    const d = el('details', { class: 'section', 'data-section': name, open: !t.closed.has(name) });
    const sum = el('summary');
    searchBound(summary, (match) => {
      sum.textContent = title(match.length);
      d.hidden = !match.length;
    });
    d.append(sum);
    let built = false;
    const fill = (afterDrawing) => {
      if (built) return;
      built = true;
      d.append(build());
      if (!afterDrawing) return;
      // Opened after drawing: the search, the chain and the tab stop are set on the new cards.
      useSearch(d);
      markChain();
      rovingSetup();
    };
    if (d.open) fill(false);
    d.addEventListener('toggle', () => {
      if (d.open) {
        t.closed.delete(name);
        fill(true);
      } else t.closed.add(name);
    });
    return d;
  }

  /** The column header. `summary` is the cards the counter counts (filtered, the counter follows the search); null = no counter. */
  function columnHeader(col, summary) {
    const w = t.data.wip;
    let counter = null;
    if (summary) {
      counter = el('span', { class: 'counter' });
      searchBound(summary, (match) => (counter.textContent = String(match.length)));
    }
    const header = el(
      'header',
      { class: 'col-header' },
      el('h2', { text: COLUMNS.find((k) => k.key === col).name }),
      counter,
      col === 'queue' ? cloudBundleLine() : null,
    );
    if (col === 'inProgress') {
      const full = w.agents >= w.max;
      header.append(
        el('span', {
          class: `wip${full ? ' full' : ''}`,
          // Readable text ("Agents 3 of 4 · heavy 1 of 2"); the explanation is in the legend.
          text: window.QueueA11y.wipText(w),
          title:
            'Agent slots in use (running and review), with the same rule as queue.mjs. Picked tasks and work ' +
            'outside the queue take no agent slot.',
        }),
      );
      // Night pause (night run off and inside the night window): no new ones start before the window is over.
      if (t.data.night?.stop)
        header.append(
          el('span', {
            class: 'badge old',
            text: `Night pause until ${t.data.night.to}`,
            title: t.data.night.message,
          }),
        );
    }
    return header;
  }

  // ---- Drawing ----
  function draw() {
    t.pending = false;
    // The selection bar and "Select all matches" follow the state and the filter in all views.
    drawOptionLine();
    drawMarkMatch();
    const focus = document.activeElement?.closest?.('[data-id], [data-pid]');
    const focusKey = focus ? (focus.dataset.id ?? `lane:${focus.dataset.pid}`) : null;
    const scrolling = new Map(
      [...main.querySelectorAll('[data-scroll]')].map((e) => [e.dataset.scroll, e.scrollTop]),
    );
    const mainScroll = [main.scrollTop, main.scrollLeft];

    // The skeleton (columns, groups, lanes) is rebuilt, but the cards are fetched from the card buffer,
    // so only cards that are new or changed are built. The search and the selection bypass draw() (useSearch, updateMarking).
    t.searchDep = [];
    main.replaceChildren();
    main.className = `board ${t.view}${t.marked.size ? ' has-option' : ''}`;
    // Search and filter apply to the cards, not the statistics (and not the plan, which shows areas and projects).
    $('search-filter').hidden = ['statistics', 'cloud', 'plan'].includes(t.view);
    // The grouping applies to Flat and Project lanes.
    $('grouping').hidden = !['flat', 'lanes'].includes(t.view);
    drawFocusLine();
    if (t.view === 'plan') {
      if (t.data) window.QueuePlan.draw(planContext());
      else
        main.append(
          el('p', {
            class: 'empty',
            text: t.error ? `Could not read the queue: ${t.error}` : 'Fetching the queue …',
          }),
        );
      drawStripe();
      [main.scrollTop, main.scrollLeft] = mainScroll;
      return;
    }
    if (t.view === 'cloud') {
      drawCloudQueue();
      drawStripe();
      [main.scrollTop, main.scrollLeft] = mainScroll;
      return;
    }
    if (t.view === 'statistics') {
      drawStatistics();
      drawStripe();
      [main.scrollTop, main.scrollLeft] = mainScroll;
      return;
    }
    if (!t.data) {
      main.append(
        el('p', {
          class: 'empty',
          text: t.error
            ? `Could not read the queue: ${t.error}`
            : t.key
              ? 'Fetching the queue …'
              : 'Missing key: open the link queue-board wrote in the terminal.',
        }),
      );
      return;
    }
    drawFilter();
    const k = t.data.columns;
    // The filters decide what is built; the search hides afterward (useSearch). The graph uses visible() with the search itself.
    const filtered = {};
    for (const col of ['queue', 'proposed', 'batch', 'inProgress', 'review', 'built'])
      filtered[col] = (k[col] ?? []).filter((x) => visibleWithoutSearch(x, col));
    // The graph has no card nodes: the buffer is left untouched there, so the cards are ready when Flat or lanes show again.
    const withSummary = t.view !== 'graph';
    if (withSummary) summaryBuffer.start();

    if (t.view === 'graph') {
      // Dependencies: graph.js draws; the search and the filter menu apply here too (visible).
      window.QueueGraphView.draw({
        main,
        data: t.data,
        version: t.version,
        filterKey: JSON.stringify([
          Object.entries(t.filter.selected).map(([n, set]) => [n, [...set].sort()]),
          t.filter.search,
        ]),
        visible,
        el,
        openPanel,
        openInbox,
        drawOnNew: draw,
      });
    } else if (t.view === 'flat') {
      for (const { key } of COLUMNS) {
        const counted =
          key === 'built' && !t.showMore
            ? filtered.built.filter((x) => x.recent)
            : filtered[key];
        main.append(
          el(
            'section',
            {
              class: 'column',
              'data-col': key,
              'aria-label': COLUMNS.find((x) => x.key === key).name,
            },
            columnHeader(key, counted),
            el(
              'div',
              { class: 'col-body', 'data-scroll': key },
              columnContent(
                key,
                filtered[key],
                key === 'queue' ? filtered.proposed : null,
                key === 'queue' ? filtered.batch : null,
              ),
            ),
          ),
        );
      }
    } else {
      main.append(
        el(
          'div',
          { class: 'lane-headers' },
          COLUMNS.map(({ key }) => columnHeader(key, null)),
        ),
      );
      const ol = el('ol', { class: 'laneList', 'aria-label': 'Project lanes' });
      // Grouping "Area → project" sorts lanes by area (the area order, without area
      // last; otherwise the lane order is kept) and inserts a heading where the area changes.
      const areaBy = new Map();
      (t.data.areas ?? []).forEach((o, i) => {
        for (const pid of o.projects ?? []) areaBy.set(pid, { i, title: o.title ?? o.oid });
      });
      const withArea = t.grouping === 'area';
      const lanes = withArea
        ? t.data.projects
            .map((p, j) => ({ p, j, o: areaBy.get(p.pid) ?? { i: 9999, title: 'No area' } }))
            .sort((a, b) => a.o.i - b.o.i || a.j - b.j)
        : t.data.projects.map((p, j) => ({ p, j, o: null }));
      let previousArea = null;
      for (const { p, o } of lanes) {
        const per = {};
        // The batch queue is also shown in lanes (in the queue cell, as in flat view).
        for (const col of ['queue', 'batch', 'inProgress', 'review', 'built'])
          per[col] = filtered[col].filter((x) => x.project === p.pid);
        const visibleBuilt = t.showMore ? per.built : per.built.filter((x) => x.recent);
        const count =
          per.queue.length +
          per.batch.length +
          per.inProgress.length +
          per.review.length +
          visibleBuilt.length;
        if (!count && !t.filter.selected.projects.has(p.pid)) continue;
        if (withArea && o.title !== previousArea) {
          previousArea = o.title;
          ol.append(
            el(
              'li',
              {
                class: 'area-heading',
                role: 'presentation',
                title: `Area ${o.title}: the project lanes below belong to it. Edit areas with "Areas …" in Queue → Focus.`,
              },
              el('h2', { text: o.title }),
            ),
          );
        }
        ol.append(laneEl(p, per));
      }
      // The empty text is always there; afterSearch() shows it when no lane is visible (not even after the search).
      ol.append(el('li', { class: 'empty lane-empty', text: 'No cards with these filters.' }));
      main.append(ol);
    }
    if (withSummary) {
      t.lastDrawing = summaryBuffer.end(); // { reused, built, removed }: for debugging
      afterSearch();
    }

    for (const [key, top] of scrolling) {
      const e = main.querySelector(`[data-scroll="${key}"]`);
      if (e) e.scrollTop = top;
    }
    [main.scrollTop, main.scrollLeft] = mainScroll;
    if (focusKey) {
      const e = focusKey.startsWith('lane:')
        ? main.querySelector(`.lane[data-pid="${CSS.escape(focusKey.slice(5))}"] > .lane-header`)
        : main
            .querySelector(`.summary[data-id="${CSS.escape(focusKey)}"]`)
            ?.querySelector('.summary-button');
      e?.focus({ preventScroll: true });
    }
    markChain();
    drawStripe();
    if (t.selected) drawPanel();
  }

  // ---- The chain around the chosen card: predecessors and successors are highlighted, the rest is dimmed ----
  /** Selects the card's chain (click or Enter). A card without a chain resets an earlier chain. */
  function selectChain(id) {
    t.chain = t.perId.get(id)?.k.chain ? id : null;
    markChain();
    drawStripe();
  }
  function resetChain() {
    t.chain = null;
    markChain();
    drawStripe();
  }
  /** Sets the classes on the drawn cards. Is the card gone (done, removed)? Then the chain is reset. */
  function markChain() {
    const k = t.chain ? t.perId.get(t.chain)?.k : null;
    if (!k?.chain) t.chain = null;
    const kj = t.chain ? k.chain : { before: [], after: [] };
    const forSet = new Set(kj.before);
    const afterSet = new Set(kj.after);
    main.classList.toggle('chain-active', !!t.chain);
    for (const e of main.querySelectorAll('.summary')) {
      const id = e.dataset.id;
      e.classList.toggle('chain-selected', id === t.chain);
      e.classList.toggle('chain-for', forSet.has(id));
      e.classList.toggle('chain-after', afterSet.has(id));
    }
    if (t.view === 'graph') window.QueueGraphView.mark(t.chain, t.chain ? kj : null);
  }

  // ---- The strip above the columns: "Next up" and the chain ----
  const stripe = $('stripe');
  function nextButton(v) {
    return el(
      'button',
      {
        type: 'button',
        class: 'next-summary',
        title: `${v.id}: ${v.title}`,
        onclick: () => openPanel(v.id),
      },
      el('span', { class: 'next-id', text: v.id }),
      el('span', { class: 'next-title', text: v.title }),
    );
  }
  function drawStripe() {
    stripe.hidden = t.view === 'statistics' || !t.data;
    if (stripe.hidden) return;
    const n = t.data.next;
    const row = el('div', { class: 'stripe-row' });
    const name = (text) => el('span', { class: 'stripe-name', text });
    if (!n) row.append(name('Next up'));
    else if (n.stop)
      row.append(
        name('Next up'),
        el('span', { class: 'badge old', text: n.text, title: n.message ?? n.text }),
      );
    else if (n.startable.length)
      row.append(
        name(`Next up (${n.available} ${n.available === 1 ? 'free slot' : 'free slots'})`),
        ...n.startable.map(nextButton),
      );
    else if (n.whenAvailable.length)
      row.append(name('When a slot frees up'), ...n.whenAvailable.map(nextButton));
    else
      row.append(
        name('Next up'),
        el('span', {
          class: 'stripe-empty',
          text: n.available ? 'Nothing is ready to start.' : 'Nothing is waiting for a slot.',
        }),
      );
    const parts = [row];
    const selected = t.chain ? t.perId.get(t.chain)?.k : null;
    if (selected?.chain) {
      const ids = [...selected.chain.before, ...selected.chain.after];
      const drawn = new Set(
        [...main.querySelectorAll('.summary:not([hidden]), .graph-svg .node')].map((e) => e.dataset.id),
      );
      const hidden = ids.filter((id) => !drawn.has(id)).length;
      parts.push(
        el(
          'div',
          { class: 'stripe-row chain-line', role: 'status' },
          el('span', {
            class: 'stripe-name',
            text:
              `Chain for ${selected.id}: ${selected.chain.before.length} before, ${selected.chain.after.length} after` +
              (hidden ? ` · ${hidden} hidden by the filter` : '') +
              ' · Esc resets',
          }),
          el('span', { class: 'draw-chain chain-for-draw', 'aria-hidden': 'true' }),
          el('span', { class: 'chain-explanation', text: 'before' }),
          el('span', { class: 'draw-chain chain-after-draw', 'aria-hidden': 'true' }),
          el('span', { class: 'chain-explanation', text: 'after' }),
          el('button', {
            type: 'button',
            class: 'link-button',
            text: 'Reset',
            onclick: resetChain,
          }),
        ),
      );
    }
    stripe.replaceChildren(...parts);
  }

  // ---- The plan view (plan.js), the focus line, grouping, saved views and the help ----
  /** What plan.js needs from the board (the same helpers and the same write path). */
  function planContext() {
    return {
      main,
      data: t.data,
      el,
      icon,
      api,
      message,
      messageWithInfo,
      update: (force) => update(force),
      drawOnNew: draw,
      status: (text) => ($('status').textContent = text),
      pending: () => t.pending,
    };
  }

  /** The focus line at the top: the steps, the rest, ready in focus, dragged along, and the warning when the focus has nothing ready. */
  const focusLine = $('focusLine');
  function drawFocusLine() {
    if (!t.data) {
      focusLine.hidden = true;
      return;
    }
    focusLine.hidden = false;
    const f = t.data.focus;
    const toPlan = (text, title) =>
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text,
        title: title,
        onclick: () => {
          setView('plan');
          draw();
        },
      });
    const draft = window.QueuePlan?.hasDraft()
      ? el('span', {
          class: 'badge old',
          text: 'unsaved draft',
          title:
            'The focus view has changes that are not saved. Open Focus and press "Save focus" or "Discard".',
        })
      : null;
    if (!f) {
      focusLine.className = 'focusLine';
      focusLine.replaceChildren(
        el(
          'div',
          { class: 'focus-row' },
          el('span', { class: 'stripe-name', text: 'Focus' }),
          el('span', {
            class: 'focus-text',
            text: 'No focus: the queue starts the most valuable work per minute first.',
            title:
              'With a focus you decide the order: "Auth first, then Payments" makes everything in Auth start before anything in Payments, ' +
              'regardless of score.',
          }),
          draft,
          toPlan('Set focus', 'Open Focus and drag areas or projects to Now and Next.'),
        ),
      );
      return;
    }
    const notice = f.notice ?? null;
    focusLine.className = `focusLine${notice ? ' notice' : ''}`;
    const stage = (f.stage ?? []).flatMap((x, i) => [
      i ? el('span', { class: 'focus-arrow', 'aria-hidden': 'true', text: '→' }) : null,
      el('span', {
        class: `focus-step${i < f.now_count ? ' now' : ''}`,
        text: `${i + 1} ${x.title}`,
        title:
          `Step ${i + 1} (${i < f.now_count ? 'Now' : 'Next'}): ${x.title}, ${x.type}. ` +
          `${x.waiting} waiting, ${x.readyOnes} ready, ${duration(x.min_left)} left.`,
      }),
    ]);
    const counts = [
      el('span', {
        text: f.rest === 'fill' ? 'rest fills free slots' : 'rest waits',
        title:
          f.rest === 'fill'
            ? 'Tasks outside the steps start only when the focus has nothing ready.'
            : 'Tasks outside the steps do not start until the focus changes (slots may stay empty).',
      }),
      f.active
        ? el('span', {
            text: `${f.readyOnes} ready in focus`,
            title: 'Pending tasks in the steps that can start now (no blockers).',
          })
        : null,
      f.active && f.dragged_with
        ? el('span', {
            text: `${f.dragged_with} dragged along`,
            title:
              'Tasks outside the steps that something in focus waits on. They get the focus task\'s step.',
          })
        : null,
      f.to
        ? el('span', {
            text: `until ${String(f.to).slice(0, 10)}`,
            title: 'The focus period applies up to and including this day.',
          })
        : null,
      f.expired ? el('span', { class: 'badge old', text: 'expired' }) : null,
      f.not_started ? el('span', { class: 'badge', text: 'not started' }) : null,
    ].filter(Boolean);
    // The DOM's replaceChildren turns null into the text "null", so the warning row is included only when it exists.
    focusLine.replaceChildren(
      ...[
        el(
          'div',
          { class: 'focus-row' },
          el('span', { class: 'stripe-name', text: f.name ? `Focus "${f.name}"` : 'Focus' }),
          el('span', { class: 'focus-step-list' }, stage),
          el('span', { class: 'focus-tall' }, counts),
          draft,
          toPlan(
            'Edit focus',
            'Open Focus: drag areas and projects between Now, Next, Later and Waiting.',
          ),
        ),
        notice ? el('p', { class: 'focus-warning', role: 'status', text: notice }) : null,
      ].filter(Boolean),
    );
  }

  // Grouping in Flat and Project lanes. Closed groups are remembered in the browser.
  const GROUPINGS = {
    none: 'No grouping',
    area: 'Area → project',
    feature: 'Project → feature',
    stage: 'Focus step',
  };
  const savedGrouping = store.getItem('queue-board-grouping');
  t.grouping = Object.hasOwn(GROUPINGS, savedGrouping ?? '') ? savedGrouping : 'none';
  t.closedGroups = new Set(readList('queue-board-closed-groups'));

  /** A list of short texts from localStorage (empty on error). */
  function readList(key) {
    try {
      const x = JSON.parse(store.getItem(key) ?? '[]');
      return Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v.length <= 200) : [];
    } catch {
      return [];
    }
  }
  function saveLocally(key, val) {
    try {
      store.setItem(key, JSON.stringify(val));
    } catch {
      /* private mode or full storage: applies only to this session */
    }
  }

  /** The group a card belongs to in the selected grouping: { key, title, orderState }. */
  function groupFor(k, g) {
    const projects = t.data.projects ?? [];
    const pIndex = Math.max(
      0,
      projects.findIndex((p) => p.pid === k.project),
    );
    if (g === 'area') {
      const areas = t.data.areas ?? [];
      const oi = areas.findIndex((o) => o.oid === k.area);
      const o = areas[oi];
      const name = o?.title ?? (k.area === 'without-area' ? 'No area' : k.area);
      return {
        key: `o:${k.area}/${k.project}`,
        title: `${name} › ${k.project}`,
        orderState: [oi < 0 ? 9999 : oi, pIndex, ''],
      };
    }
    if (g === 'feature')
      return {
        key: `f:${k.project}/${k.feature ?? ''}`,
        title: `${k.project} › ${k.feature ?? '(no feature)'}`,
        orderState: [pIndex, k.feature ? 0 : 1, k.feature ?? ''],
      };
    // Focus step: the steps in order, then dragged along into the step, outside focus, and on hold last.
    const pl = k.space;
    const f = t.data.focus;
    if (!pl) return { key: 't:other', title: 'Not in the queue', orderState: [9998, 0, ''] };
    if (k.parked) return { key: 't:wait', title: 'On hold', orderState: [9997, 0, ''] };
    if (!f?.active) return { key: 't:none', title: 'No focus', orderState: [0, 0, ''] };
    if (pl.step == null)
      return { key: 't:outside', title: 'Outside focus', orderState: [9990, 0, ''] };
    return {
      key: `t:${pl.step}`,
      title: `T${pl.step + 1} ${f.stage?.[pl.step]?.title ?? ''}`,
      orderState: [pl.step, 0, ''],
    };
  }
  const compareOrder = (a, b) =>
    a.orderState[0] - b.orderState[0] ||
    a.orderState[1] - b.orderState[1] ||
    a.orderState[2].localeCompare(b.orderState[2], 'en');

  /** Like list(), but grouped by the selected grouping (every group can be closed and selected together). */
  function groupedList(summary, col, section) {
    const g = t.grouping;
    // Focus step exists only for cards in the queue (in In progress, Review and Built everything would end up in "Not in the queue").
    if (
      g === 'none' ||
      (t.view === 'lanes' && g === 'area') ||
      (g === 'stage' && !MARKABLE_COLUMNS.has(col)) ||
      !summary.length
    )
      return list(summary, col, section);
    const groups = new Map();
    for (const k of summary) {
      const x = groupFor(k, g);
      if (!groups.has(x.key)) groups.set(x.key, { ...x, summary: [] });
      groups.get(x.key).summary.push(k);
    }
    return el(
      'div',
      { class: 'groups' },
      [...groups.values()].sort(compareOrder).map((gr) => {
        const saved = `${section ?? col}|${gr.key}`;
        // The ids, the counter and the box follow the search and the selection (searchBound at the bottom).
        let ids = [];
        const d = el('details', { class: 'group', open: !t.closedGroups.has(saved) });
        d.addEventListener('toggle', () => {
          if (d.open) t.closedGroups.delete(saved);
          else t.closedGroups.add(saved);
          saveLocally('queue-board-closed-groups', [...t.closedGroups].slice(-300));
          rovingSetup(); // the cards in a closed group cannot be the tab stop
        });
        const sum = el('summary', { class: 'group-header' });
        const box = MARKABLE_COLUMNS.has(col)
          ? el('input', {
              type: 'checkbox',
              class: 'mark-group-box',
              'aria-label': `Select the whole group ${gr.title}`,
              onclick: (e) => e.stopPropagation(),
              onchange: (e) => markMany(ids, e.target.checked),
            })
          : null;
        const counter = el('span', { class: 'counter' });
        sum.append(
          ...[box, el('span', { class: 'group-name', text: gr.title }), counter].filter(Boolean),
        );
        d.append(sum, list(gr.summary, col, section));
        searchBound(gr.summary, (match) => {
          ids = match.map((k) => k.id);
          d.hidden = !match.length;
          sum.title = `${gr.title}: ${ids.length} cards. Click to close or open.`;
          counter.textContent = `${ids.length} · ${duration(match.reduce((s2, k) => s2 + (Number(k.estimate) || 0), 0))}`;
          if (box) {
            box.checked = ids.length > 0 && ids.every((id) => t.marked.has(id));
            box.title = `Select all ${ids.length} cards in the group for the selection bar (bulk actions)`;
          }
        });
        return d;
      }),
    );
  }

  const groupingOption = $('grouping');
  groupingOption.replaceChildren(
    ...Object.entries(GROUPINGS).map(([val, text]) =>
      el('option', { value: val, text, selected: val === t.grouping }),
    ),
  );
  groupingOption.addEventListener('change', () => {
    t.grouping = groupingOption.value;
    store.setItem('queue-board-grouping', t.grouping);
    draw();
  });

  // Saved and built-in views: in the browser (localStorage) for now.
  const VIEWS_STORAGE = 'queue-board-views';
  const LAST_VISIT = 'queue-board-last-visit';
  t.lastVisit = Date.parse(store.getItem(LAST_VISIT) ?? '') || null;
  const rememberVisit = () => {
    try {
      store.setItem(LAST_VISIT, new Date().toISOString());
    } catch {
      /* no storage */
    }
  };
  window.addEventListener('pagehide', rememberVisit);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) rememberVisit();
  });

  /** The built-in views (cannot be deleted). `special` is a filter on the cards in queue, proposed and the batch queue. */
  const BUILT_IN = [
    {
      name: 'Focus now',
      special: 'focus1',
      title: 'Only tasks in the first focus step, ready ones first.',
    },
    {
      name: 'Ready in focus',
      special: 'readyFocus',
      title: 'Ready tasks in the focus steps, including those dragged along.',
    },
    {
      name: 'Outside focus, ready',
      special: 'outsideReady',
      title: 'Tasks stopped only by the focus: they can start if you give them a step.',
    },
    { name: 'On hold', special: 'onWait', title: 'Tasks that are put on hold.' },
    {
      name: 'Sort',
      special: 'sort',
      title:
        'Tasks without a project, with an uncertain proposal, or where the project conflicts with the files and the plan they come from.',
    },
    {
      name: 'New since last visit',
      special: 'newEntry',
      title: 'Tasks added after the previous time the board was open in this browser.',
    },
    { name: 'Waiting on me', inbox: true, title: 'Opens "Waiting on you".' },
  ];
  const SPECIAL = {
    focus1: (k) => k.space?.step === 0,
    readyFocus: (k) => k.ready && k.space?.step != null,
    outsideReady: (k) =>
      !!k.space?.outside && !k.parked && k.blockers.every((h) => h === k.space.reason),
    onWait: (k) => !!k.parked,
    sort: (k) => (t.data?.inbox?.sort ?? []).some((r) => r.id === k.id),
    newEntry: (k) => !!t.lastVisit && !!k.added_at && Date.parse(k.added_at) > t.lastVisit,
  };
  t.special = null;
  t.viewName = null;

  function ownViews() {
    try {
      const x = JSON.parse(store.getItem(VIEWS_STORAGE) ?? '[]');
      return Array.isArray(x)
        ? x.filter((v) => v && typeof v.name === 'string' && v.name.length <= 60).slice(0, 30)
        : [];
    } catch {
      return [];
    }
  }

  function useView(v) {
    closeViews(false);
    if (v.inbox) return openInbox();
    t.special = v.special && SPECIAL[v.special] ? v.special : null;
    t.viewName = v.name;
    // Your own views include search, filter, grouping and view; the built-in ones reset search and filter.
    t.filter.search = typeof v.search === 'string' ? v.search.slice(0, 100) : '';
    $('search').value = t.filter.search;
    for (const [n, set] of Object.entries(t.filter.selected)) {
      set.clear();
      for (const x of v.filter?.[n] ?? []) if (typeof x === 'string') set.add(x);
    }
    saveFilter();
    if (v.grouping && Object.hasOwn(GROUPINGS, v.grouping)) {
      t.grouping = v.grouping;
      groupingOption.value = v.grouping;
      store.setItem('queue-board-grouping', v.grouping);
    }
    const show = VIEWS.includes(v.view) ? v.view : null;
    if (show && ['flat', 'lanes', 'graph'].includes(show)) setView(show);
    else if (!['flat', 'lanes', 'graph'].includes(t.view)) setView('flat');
    drawViewButton();
    draw();
  }

  function saveView(name) {
    const n = name.trim().slice(0, 60);
    if (!n) return message('Write a name for the selection.', true);
    if (BUILT_IN.some((v) => v.name === n))
      return message(`"${n}" is a built-in selection. Choose another name.`, true);
    const fresh = {
      name: n,
      view: t.view,
      search: t.filter.search,
      filter: Object.fromEntries(Object.entries(t.filter.selected).map(([k, set]) => [k, [...set]])),
      grouping: t.grouping,
      special: t.special,
    };
    const list = ownViews().filter((v) => v.name !== n);
    saveLocally(VIEWS_STORAGE, [...list, fresh].slice(-30));
    t.viewName = n;
    message(`Selection "${n}" is saved in this browser.`);
    drawViewButton();
    drawViewMenu();
  }

  const viewButton = $('views');
  const viewMenu = $('views-menu');
  function drawViewButton() {
    const name = t.viewName;
    // The saved filters are called "Selection", so they are not confused with the "View" tabs. "Show all"
    // sits at the top of the Selection menu when a selection is in use.
    viewButton.textContent = name ? `Selection: ${name}` : 'Selection';
    viewButton.classList.toggle('active', !!t.special || !!name);
    viewButton.setAttribute(
      'aria-label',
      name ? `Selection, selected: ${name}` : 'Selection: saved and built-in',
    );
  }
  /** Removes the selection and shows all the cards again (search and filter stay as they are). */
  function showAll() {
    closeViews(true);
    t.special = null;
    t.viewName = null;
    drawViewButton();
    draw();
  }
  function drawViewMenu() {
    const ownOnes = ownViews();
    const row = (v, removeIt) =>
      el(
        'li',
        { class: 'filter-row' },
        el('button', {
          type: 'button',
          class: 'link-button view-option',
          text: v.name,
          title: v.title ?? 'Your saved selection: search, filter, grouping and view.',
          'aria-current': t.viewName === v.name ? 'true' : null,
          onclick: () => useView(v),
        }),
        removeIt
          ? el('button', {
              type: 'button',
              class: 'pause-button',
              text: 'Delete',
              title: `Delete selection "${v.name}" from this browser. The queue does not change.`,
              onclick: () => {
                saveLocally(
                  VIEWS_STORAGE,
                  ownViews().filter((x) => x.name !== v.name),
                );
                if (t.viewName === v.name) t.viewName = null;
                drawViewButton();
                drawViewMenu();
              },
            })
          : null,
      );
    const nameField = el('input', {
      id: 'view-name',
      type: 'text',
      maxlength: 60,
      placeholder: 'Name of the selection',
      'aria-label': 'Name of the selection',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveView(e.target.value);
        }
      },
    });
    const inUse = !!t.special || !!t.viewName;
    viewMenu.replaceChildren(
      // replaceChildren() turns null into the text "null", so the button is added only when a selection is in use.
      ...(inUse
        ? [
            el(
              'div',
              { class: 'filter-footer show-all' },
              el('button', {
                type: 'button',
                class: 'button button-outline button-small',
                text: 'Show all',
                title: 'Remove the selection and show all cards again',
                onclick: showAll,
              }),
            ),
          ]
        : []),
      el(
        'section',
        { class: 'filter-section' },
        el('div', { class: 'filter-section-header' }, el('h3', { text: 'Built in' })),
        el(
          'ul',
          { class: 'filter-list' },
          BUILT_IN.map((v) => row(v, false)),
        ),
      ),
      el(
        'section',
        { class: 'filter-section' },
        el('div', { class: 'filter-section-header' }, el('h3', { text: 'Your' })),
        ownOnes.length
          ? el(
              'ul',
              { class: 'filter-list' },
              ownOnes.map((v) => row(v, true)),
            )
          : el('p', { class: 'empty', text: 'No saved selections yet.' }),
      ),
      el(
        'div',
        { class: 'filter-footer view-save' },
        nameField,
        el('button', {
          type: 'button',
          class: 'button button-outline button-small',
          text: 'Save current',
          title:
            'Saves the search, the filter, the grouping and the view you see now under the name, in this browser. The queue does not change.',
          onclick: () => saveView(nameField.value),
        }),
      ),
    );
  }
  function openViews() {
    closeFilter(false);
    viewMenu.hidden = false;
    viewButton.setAttribute('aria-expanded', 'true');
    drawViewMenu();
    viewMenu.querySelector('button')?.focus();
  }
  function closeViews(focusOn) {
    if (viewMenu.hidden) return;
    viewMenu.hidden = true;
    viewButton.setAttribute('aria-expanded', 'false');
    if (focusOn) viewButton.focus();
  }
  viewButton.addEventListener('click', () =>
    viewMenu.hidden ? openViews() : closeViews(true),
  );
  viewMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeViews(true);
    }
  });
  document.addEventListener('click', (e) => {
    if (viewMenu.hidden) return;
    const filePath = e.composedPath();
    if (!filePath.includes(viewMenu) && !filePath.includes(viewButton)) closeViews(false);
  });

  // "How to use the board" (in the gear): short help in the side panel.
  const HELP = [
    [
      'Areas',
      'An area groups projects that belong together, for example Auth or Payments and invoicing. ' +
        'You prioritize areas instead of many projects. Create and edit them with "Areas …" in Queue → Focus. A project ' +
        'belongs to one area.',
    ],
    [
      'Focus',
      'The focus is the order in which the queue takes work: everything in step 1 before step 2, regardless of score. Within a ' +
        'step the points apply. A step is an area, a project or a feature. The most specific wins: a project with ' +
        'a step of its own takes precedence over its area\'s step. "Rest waits" means nothing outside the steps starts; "fill ' +
        'free slots" starts them only when the focus has nothing ready. Tasks that something in focus waits on are dragged ' +
        'along. The focus applies until you change it, or until the end date. The focus line at the top turns red when the focus ' +
        'has nothing ready, and says which answer unlocks the most.',
    ],
    [
      'The Focus tab',
      'Focus shows the focus as four columns: Now and Next (the steps in order), Later (the rest) and Waiting ' +
        '(projects on pause). Drag areas, projects and features between the columns, or lift with Space, ' +
        'move with the arrow keys and drop with Space (Esc cancels). The changes are a draft until you press "Save ' +
        'focus"; then you first see what changes and what the queue starts next.',
    ],
    [
      'Plans and Queue',
      'The switch at the top left changes workspace. Plans opens on the Overview, with one card per area. "Plan entries" ' +
        'is the plan register: area › project › entry in the list (click to fold), the details on the right, and the filters ' +
        'with counts on the left (on a narrower screen behind the "Filters" button). The copy buttons give the start line for ' +
        '/plans. A badge like PL-ALONE-1 on a card opens the entry in Plans; the Queue tab in the entry\'s ' +
        'details lists its tasks, and a click shows the card here.',
    ],
    [
      'Waiting on you',
      'Owner questions, QA, proposed and what is stuck. With a focus, the questions are sorted by what the answer unlocks in ' +
        'the focus (step 1 first). "Sort" shows tasks without a project or with the wrong project, with proposals you can ' +
        'accept.',
    ],
    [
      'Batch queue',
      'Small tasks that do not block anything can go into the batch queue. There they do not start alone, but are packed ' +
        'together into one track of the right size ("Pack into track" when the group is large enough). D+, tasks others wait on and ' +
        'tasks with open owner questions cannot be there.',
    ],
    [
      'Bulk actions',
      'Select cards with the checkbox, x on the card, Ctrl/Cmd-click or Shift-click, Ctrl/Cmd+A or "Select all ' +
        'matches". The group header selects the whole group. The selection bar at the bottom moves to a project, puts on hold, moves as ' +
        'a block, adds to the batch queue or sets a label. You always see what changes before it is saved, everything happens ' +
        'together or not at all, and "Undo" is ready afterward. Esc clears the selection.',
    ],
    [
      'Selection, tabs and grouping',
      '"Selection" has built-in selections (Focus now, Ready in focus, On hold, Sort, New since last visit …) and your own ' +
        '(search, filter, grouping and view), saved in this browser. "Show all" at the top of the menu removes ' +
        'the selection. The tabs (Flat, Project lanes, Focus …) are the views; the arrow keys move between them, Enter selects. ' +
        'The grouping beside the tabs ' +
        'splits the cards by area and project, project and feature, or focus step.',
    ],
    [
      'The keyboard on the board',
      'Tab goes to one card title per column (or per cell in Project lanes). Arrow up and down move between the cards, ' +
        'arrow left and right to the neighboring column, Home and End to the first and last card. Enter opens the card, x selects ' +
        'it, and Space lifts a card in the queue (the arrow keys move, Space drops, Esc cancels). "Blocked" is ' +
        'closed from the start; open it to see the cards there.',
    ],
  ];

  // The legend for the classes, WIP and the badges on the cards. Shown in the help and in the statistics tab,
  // because the tooltips do not work on touch or with the keyboard.
  const BADGES = [
    ['badge ready-badge', 'Ready now', 'Can start now: no blockers.'],
    ['badge', '45 min', 'Estimated content in minutes.'],
    ['badge visual', 'visual', 'The owner does a visual check after delivery.'],
    ['badge wait-badge', 'on hold', 'Parked until a date or an event.'],
    ['badge locks', 'unlocks 3', 'This many tasks are waiting on this one via the chain.'],
    ['badge cloud-badge', 'Cloud', 'Running in a cloud session.'],
    ['badge old', 'old', 'Picked or registered outside the queue more than 72 hours ago.'],
    ['badge qa', 'Waiting for QA', 'Built, but the owner has not looked it over.'],
    ['badge deviation', 'QA deviation', 'The owner found something during the check.'],
  ];
  function legend(idPrefix) {
    const row = (badge, text) =>
      el('div', { class: 'explanation-row' }, el('dt', null, badge), el('dd', { text }));
    return el(
      'section',
      { class: 'legend', 'aria-labelledby': `${idPrefix}-draw` },
      el('h3', { id: `${idPrefix}-draw`, class: 'setting-title', text: 'Legend' }),
      el('h4', { class: 'explanation-title', text: 'Risk classes' }),
      el(
        'dl',
        { class: 'explanation' },
        window.QueueA11y.CLASSES.map((k) =>
          row(
            el('span', {
              class: `badge${k.class === 'D+' ? ' class-dplus' : ''}`,
              text: k.class,
            }),
            `${k.name[0].toUpperCase()}${k.name.slice(1)}. ${k.explanation}`,
          ),
        ),
      ),
      el('h4', { class: 'explanation-title', text: 'Slots in In progress' }),
      el(
        'dl',
        { class: 'explanation' },
        row(
          el('span', {
            class: 'wip',
            text: window.QueueA11y.wipText({ agents: 3, max: 4, dPlus: 1, maxDPlus: 2 }),
          }),
          'Agents: the slots in use (running and review) out of at most this many at once. Heavy: D+ tasks out of at most ' +
            'this many at once. Picked tasks and work outside the queue take no slot. Red when everything is full.',
        ),
      ),
      el('h4', { class: 'explanation-title', text: 'Badges on the cards' }),
      el(
        'dl',
        { class: 'explanation' },
        BADGES.map(([cls, text, explanation]) =>
          row(el('span', { class: cls, text }), explanation),
        ),
        row(
          el('span', { class: 'summary-project', text: 'project' }),
          'The project\'s short name; the color stripe on the left of the card is the project\'s color. Not shown when the cards ' +
            'are already grouped per project.',
        ),
        row(
          el('span', { class: 'explanation-edge', text: 'dashed edge' }),
          'Blocked: waiting on something (the blocker is at the bottom of the card). Solid edge in the primary color: ready now.',
        ),
      ),
    );
  }

  function openHelp() {
    t.selected = null;
    t.setting = null;
    t.inbox = false;
    t.help = true;
    showPanel();
    panel.scrollTop = 0;
    panel.replaceChildren(
      el(
        'div',
        { class: 'panel-header' },
        el('div', null, el('h2', { id: 'panel-title', text: 'How to use the board' })),
        el(
          'button',
          { type: 'button', class: 'button-icon', 'aria-label': 'Close', onclick: closePanel },
          icon('close'),
        ),
      ),
      ...HELP.map(([title, text]) =>
        el(
          'section',
          { class: 'help-del' },
          el('h3', { class: 'setting-title', text: title }),
          el('p', { class: 'help-text', text }),
        ),
      ),
      legend('help'),
      el('p', {
        class: 'inbox-info',
        text:
          'Everything the board writes goes via cq with a lock, and nothing changes before you have seen the explanation and confirmed.',
      }),
    );
    panel.querySelector('.button-icon')?.focus();
  }
  // The help opens from the gear (the button at the top of the settings), no longer from "?" at the top.

  function laneEl(p, per) {
    // The numbers in the lane header and whether the lane is shown follow the search (searchBound at the bottom).
    const countsEl = el('span', { class: 'counts' });
    const visibleBuilt = t.showMore ? per.built : per.built.filter((x) => x.recent);
    const allSummary = [...per.queue, ...per.batch, ...per.inProgress, ...per.review, ...visibleBuilt];
    const header = el(
      'header',
      {
        class: 'lane-header',
        tabindex: p.movable ? 0 : null,
        draggable: p.movable ? 'true' : null,
        'aria-label': p.movable
          ? `Project ${p.title ?? p.pid}. Space lifts the lane, the arrow keys move it.`
          : null,
      },
      p.movable ? icon('handle') : null,
      el('span', { class: 'dot', '--p': `var(--color-${p.color})` }),
      el('h2', { text: p.title ?? p.pid }),
      el('span', { class: 'pid', text: p.pid }),
      p.pause ? el('span', { class: 'badge old', text: 'paused' }) : null,
      p.priority_bonus
        ? el('span', {
            class: 'badge',
            text: `${p.priority_bonus > 0 ? '+' : ''}${p.priority_bonus}`,
            title: 'The project\'s priority bonus',
          })
        : null,
      countsEl,
      markLaneButton(p, per),
      p.movable ? pauseButton(p) : null,
    );
    const row = el(
      'div',
      { class: 'lane-row' },
      ['queue', 'inProgress', 'review', 'built'].map((col) =>
        el(
          'div',
          { class: 'lane-cell', 'data-col': col },
          columnContent(col, per[col], null, col === 'queue' ? per.batch : null),
        ),
      ),
    );
    const lane = el(
      'li',
      { class: 'lane', 'data-pid': p.pid, 'data-movable': p.movable ? '1' : null },
      header,
      row,
    );
    searchBound(allSummary, (match) => {
      const ids = new Set(match.map((k) => k.id));
      const n = (list) => list.filter((k) => ids.has(k.id)).length;
      countsEl.textContent = [
        n(per.queue) ? `${n(per.queue)} in queue` : null,
        n(per.batch) ? `${n(per.batch)} in batch queue` : null,
        n(per.inProgress) ? `${n(per.inProgress)} in progress` : null,
        n(per.review) ? `${n(per.review)} in review` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      // A lane selected in the Projects filter is shown even when empty (as before).
      lane.hidden = !match.length && !t.filter.selected.projects.has(p.pid);
    });
    return lane;
  }

  /** "Select" in the lane header selects the cards in the lane that can be bulk edited (in queue and batch queue, after the filter). */
  function markLaneButton(p, per) {
    const summary = [...per.queue, ...per.batch];
    if (!summary.length) return null;
    // The button applies to the cards matching the search, and follows the search and the selection (searchBound).
    let ids = [];
    let all = false;
    const button = el('button', {
      type: 'button',
      class: 'pause-button',
      onclick: (e) => {
        e.stopPropagation();
        markMany(ids, !all);
      },
    });
    searchBound(summary, (match) => {
      ids = match.map((k) => k.id);
      all = ids.length > 0 && ids.every((id) => t.marked.has(id));
      button.hidden = !ids.length;
      button.textContent = all ? 'Deselect' : 'Select';
      button.setAttribute('aria-pressed', all ? 'true' : 'false');
      button.title = all
        ? `Remove the ${ids.length} cards in ${p.pid} from the selection`
        : `Select the ${ids.length} shown cards in queue and batch queue in ${p.pid}, for the selection bar`;
    });
    return button;
  }

  // ---- The Filter menu (one line with search and "Filter" instead of the chip row) ----
  const filterButton = $('filter-button');
  const filterMenu = $('filter-menu');

  /** Pause or resume a project (guard rule 6 warns when something is in progress). In the Filter menu and the lane header. */
  function pauseButton(p) {
    return el('button', {
      type: 'button',
      class: 'pause-button',
      'data-focus': `pause:${p.pid}`,
      text: p.pause ? 'Continue' : 'Pause',
      'aria-label': `${p.pause ? 'Continue' : 'Pause'} the project ${p.pid}`,
      onclick: (e) => {
        e.stopPropagation();
        action(
          { type: p.pause ? 'continue' : 'pause', pid: p.pid },
          `${p.pid}: ${p.pause ? 'continues' : 'paused'}`,
        );
      },
    });
  }

  /** The button shows the number of active filters; the menu is redrawn when it is open. */
  function drawFilter() {
    const n = countFilters();
    filterButton.textContent = n ? `Filter · ${n}` : 'Filter';
    filterButton.setAttribute('aria-label', n ? `Filter, ${n} active` : 'Filter');
    filterButton.classList.toggle('active', n > 0);
    if (!filterMenu.hidden) drawFilterMenu();
  }

  function drawFilterMenu() {
    const focus = filterMenu.contains(document.activeElement)
      ? document.activeElement.dataset.focus
      : null;
    // Open cards per project (In queue, In progress, Review).
    const opened = new Map();
    for (const col of ['queue', 'inProgress', 'review'])
      for (const k of t.data?.columns[col] ?? [])
        opened.set(k.project, (opened.get(k.project) ?? 0) + 1);
    const parts = FILTER_SECTIONS.map((s) => {
      const option = s.option();
      const selected = t.filter.selected[s.key];
      const all = option.length > 0 && option.every((v) => selected.has(v.val));
      return el(
        'section',
        { class: 'filter-section', 'aria-labelledby': `filter-${s.key}` },
        el(
          'div',
          { class: 'filter-section-header' },
          el('h3', { id: `filter-${s.key}`, text: s.title }),
          el('button', {
            type: 'button',
            class: 'link-button',
            'data-focus': `all:${s.key}`,
            text: all ? 'Select none' : 'Select all',
            onclick: () => {
              if (all) selected.clear();
              else for (const v of option) selected.add(v.val);
              changedFilter();
            },
          }),
        ),
        el(
          'ul',
          { class: 'filter-list' },
          option.map((v) => {
            const id = `f-${s.key}-${v.val}`;
            const p = v.project;
            return el(
              'li',
              { class: 'filter-row' },
              el('input', {
                type: 'checkbox',
                id,
                'data-focus': id,
                checked: selected.has(v.val),
                onchange: (e) => {
                  if (e.target.checked) selected.add(v.val);
                  else selected.delete(v.val);
                  changedFilter();
                },
              }),
              el(
                'label',
                { for: id, title: p?.title ?? null },
                p ? el('span', { class: 'dot', '--p': `var(--color-${p.color})` }) : null,
                el('span', { class: 'filter-name', text: v.text }),
                p?.pause ? el('span', { class: 'paused', text: 'paused' }) : null,
                p
                  ? el('span', {
                      class: 'filter-count',
                      text: String(opened.get(p.pid) ?? 0),
                      title: 'Open: in queue, in progress and review',
                    })
                  : null,
              ),
              p?.movable ? pauseButton(p) : null,
            );
          }),
        ),
      );
    });
    parts.push(
      el(
        'div',
        { class: 'filter-footer' },
        el('button', {
          type: 'button',
          class: 'button button-outline',
          'data-focus': 'reset',
          text: 'Reset',
          disabled: countFilters() === 0,
          onclick: () => {
            for (const set of Object.values(t.filter.selected)) set.clear();
            changedFilter();
          },
        }),
      ),
    );
    filterMenu.replaceChildren(...parts);
    if (focus) filterMenu.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
  }

  function changedFilter() {
    saveFilter();
    draw();
  }
  function openFilter() {
    filterMenu.hidden = false;
    filterButton.setAttribute('aria-expanded', 'true');
    drawFilterMenu();
    filterMenu.querySelector('input')?.focus();
  }
  function closeFilter(focusOn) {
    if (filterMenu.hidden) return;
    filterMenu.hidden = true;
    filterButton.setAttribute('aria-expanded', 'false');
    if (focusOn) filterButton.focus();
  }
  filterButton.addEventListener('click', () =>
    filterMenu.hidden ? openFilter() : closeFilter(true),
  );
  filterMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFilter(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // The arrow keys move between the rows (the checkboxes); Space checks.
      const rows = [...filterMenu.querySelectorAll('input[type="checkbox"]')];
      const i = rows.indexOf(document.activeElement);
      const j = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      e.preventDefault();
      rows[j]?.focus();
    }
  });
  // A click outside closes. composedPath is the path when the click happened, so an element the menu just redrew still counts.
  document.addEventListener('click', (e) => {
    if (filterMenu.hidden) return;
    const filePath = e.composedPath();
    if (!filePath.includes(filterMenu) && !filePath.includes(filterButton)) closeFilter(false);
  });

  // ---- Statistics (inline SVG, the colors from the CSS variables via the classes in board.css) ----
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function s(tag, attr, ...children) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attr ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else e.setAttribute(k, String(v));
    }
    for (const b of children.flat()) if (b != null && b !== false) e.append(b);
    return e;
  }
  /** The tooltip in a chart. */
  const tips = (text) => s('title', { text });
  const CLASS_CSS = { K: 's-K', D: 's-D', 'D+': 's-Dp', U: 's-U' };
  const counts = (x, d = 0) =>
    Number(x ?? 0).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (x) => `${counts(x, Math.abs(Number(x ?? 0)) >= 100 ? 0 : 2)} USD`;
  const date = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  const thousand = (x) => `${counts(Number(x ?? 0) / 1000)}k`;
  /** "25 min", "1 h 38 min". */
  function duration(min) {
    if (min == null) return 'no data';
    const m = Math.round(min);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  /** A nice cap for the axis: 1, 2, 2.5 or 5 × 10^n, at least x. */
  function roundUp(x) {
    if (!(x > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(x));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
    return 10 * p;
  }

  /** Stacked bars per day (charts 1 and 3). `series`: [{ key, css }]; `stroke`: horizontal line (quota). */
  function barGraph({ rows, series, tipsFor, format, stroke, summary }) {
    const B = 560;
    const H = 200;
    const V = 52;
    const HO = 8;
    const TO = 10;
    const BU = 24;
    const ph = H - TO - BU;
    const max = Math.max(
      0,
      ...rows.map((r) => series.reduce((sum, se) => sum + (r[se.key] ?? 0), 0)),
    );
    const top = roundUp(Math.max(max, stroke?.val ?? 0));
    const y = (v) => TO + ph - (v / top) * ph;
    const svg = s('svg', {
      viewBox: `0 0 ${B} ${H}`,
      class: 'graph-svg',
      role: 'img',
      'aria-label': summary,
    });
    for (const v of [0, top / 2, top])
      svg.append(
        s('line', { x1: V, x2: B - HO, y1: y(v), y2: y(v), class: 'axis' }),
        s('text', { x: V - 6, y: y(v) + 4, 'text-anchor': 'end', text: format(v) }),
      );
    const step = (B - V - HO) / rows.length;
    const width = Math.max(4, step * 0.7);
    rows.forEach((r, i) => {
      const x = V + i * step + (step - width) / 2;
      const g = s('g', null, tips(tipsFor(r)));
      let bottom = 0;
      for (const se of series) {
        const v = r[se.key] ?? 0;
        if (v <= 0) continue;
        g.append(
          s('rect', {
            x,
            y: y(bottom + v),
            width: width,
            height: y(bottom) - y(bottom + v),
            class: se.css,
          }),
        );
        bottom += v;
      }
      // A hidden surface over the whole height, so the tooltip also exists on empty days.
      g.append(s('rect', { x, y: TO, width: width, height: ph, class: 'match' }));
      svg.append(g);
      if ((rows.length - 1 - i) % 2 === 0)
        svg.append(
          s('text', { x: x + width / 2, y: H - 8, 'text-anchor': 'middle', text: date(r.day) }),
        );
    });
    if (stroke)
      svg.append(
        s(
          'line',
          { x1: V, x2: B - HO, y1: y(stroke.val), y2: y(stroke.val), class: stroke.css },
          tips(stroke.tips),
        ),
      );
    return svg;
  }

  /** Horizontal bars (charts 2 and 4). `rows`: [{ label, strong?, parts: [{ val, css }], tips, text }]. */
  function horizontalGraph({ groups, max, strokes = [], summary, format }) {
    const B = 560;
    const V = 96;
    const HO = 84;
    const TO = 6;
    const BU = 22;
    const ROW = 14;
    const BETWEEN = 4;
    const GROUP = 14;
    const height = (g) => g.rows.length * (ROW + BETWEEN) - BETWEEN;
    const H = TO + groups.reduce((sum, g) => sum + height(g) + GROUP, 0) - GROUP + BU;
    const top = roundUp(max);
    const pw = B - V - HO;
    const x = (v) => V + (Math.min(v, top) / top) * pw;
    const svg = s('svg', {
      viewBox: `0 0 ${B} ${H}`,
      class: 'graph-svg',
      role: 'img',
      'aria-label': summary,
    });
    for (const v of [0, top / 2, top])
      svg.append(
        s('line', { x1: x(v), x2: x(v), y1: TO, y2: H - BU, class: 'axis' }),
        s('text', { x: x(v), y: H - 6, 'text-anchor': 'middle', text: format(v) }),
      );
    let y = TO;
    for (const g of groups) {
      const y0 = y;
      for (const r of g.rows) {
        svg.append(
          s('text', {
            x: V - 8,
            y: y + ROW - 3,
            'text-anchor': 'end',
            class: r.strong ? 'label-strong' : null,
            text: r.label,
          }),
        );
        const chunk = s('g', null, tips(r.tips));
        let from = 0;
        for (const d of r.parts) {
          if (!(d.val > 0)) continue;
          chunk.append(
            s('rect', {
              x: x(from),
              y,
              width: x(from + d.val) - x(from),
              height: ROW,
              class: d.css,
            }),
          );
          from += d.val;
        }
        svg.append(chunk, s('text', { x: x(from) + 6, y: y + ROW - 3, text: r.text }));
        y += ROW + BETWEEN;
      }
      for (const st of g.strokes ?? [])
        svg.append(
          s(
            'line',
            { x1: x(st.val), x2: x(st.val), y1: y0 - 3, y2: y - BETWEEN + 3, class: st.css },
            tips(st.tips),
          ),
        );
      y += GROUP - BETWEEN;
    }
    for (const st of strokes)
      svg.append(
        s(
          'line',
          { x1: x(st.val), x2: x(st.val), y1: TO - 2, y2: H - BU, class: st.css },
          tips(st.tips),
        ),
      );
    return svg;
  }

  /**
   * Lines per day (In versus out). `series`: [{ key, css }]; every series becomes a line with a point per
   * day, and every day has a tooltip over the whole height (like the bar chart).
   */
  function lineGraph({ rows, series, tipsFor, format, summary }) {
    const B = 560;
    const H = 200;
    const V = 52;
    const HO = 8;
    const TO = 10;
    const BU = 24;
    const ph = H - TO - BU;
    const max = Math.max(0, ...rows.flatMap((r) => series.map((se) => r[se.key] ?? 0)));
    const top = roundUp(max);
    const y = (v) => TO + ph - (v / top) * ph;
    const step = (B - V - HO) / rows.length;
    const x = (i) => V + i * step + step / 2;
    const svg = s('svg', {
      viewBox: `0 0 ${B} ${H}`,
      class: 'graph-svg',
      role: 'img',
      'aria-label': summary,
    });
    for (const v of [0, top / 2, top])
      svg.append(
        s('line', { x1: V, x2: B - HO, y1: y(v), y2: y(v), class: 'axis' }),
        s('text', { x: V - 6, y: y(v) + 4, 'text-anchor': 'end', text: format(v) }),
      );
    for (const se of series) {
      svg.append(
        s('polyline', {
          class: `line ${se.css}`,
          points: rows.map((r, i) => `${x(i)},${y(r[se.key] ?? 0)}`).join(' '),
        }),
      );
      for (const [i, r] of rows.entries())
        svg.append(
          s('circle', { cx: x(i), cy: y(r[se.key] ?? 0), r: 3, class: `point ${se.css}` }),
        );
    }
    rows.forEach((r, i) => {
      svg.append(
        s(
          'g',
          null,
          tips(tipsFor(r)),
          s('rect', { x: x(i) - step / 2, y: TO, width: step, height: ph, class: 'match' }),
        ),
      );
      if ((rows.length - 1 - i) % 2 === 0)
        svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', text: date(r.day) }));
    });
    return svg;
  }

  /** "3 d" for long times (response time on owner questions), otherwise as duration. */
  const length = (min) =>
    min == null ? 'no data' : min >= 48 * 60 ? `${counts(min / 1440, 1)} d` : duration(min);

  /** A chart with title, explanation (the colors) and a short remark (e.g. how many are excluded). */
  function graph(title, content, explanation, remark) {
    return el(
      'figure',
      { class: 'graph' },
      el('figcaption', { text: title }),
      content,
      explanation?.length
        ? el(
            'ul',
            { class: 'explanation', 'aria-hidden': 'true' },
            explanation.map(([css, text, stroke]) =>
              el(
                'li',
                null,
                el('span', {
                  class: `${stroke === 'line' ? 'draw-line' : stroke ? 'draw-line' : 'draw-dot'} ${css}`,
                }),
                text,
              ),
            ),
          )
        : null,
      remark ? el('p', { class: 'graph-remark', text: remark }) : null,
    );
  }

  function tile(name, val, under) {
    return el(
      'div',
      { class: 'tile' },
      el('p', { class: 'tile-name', text: name }),
      el('p', { class: 'tile-value', text: val }),
      under ? el('p', { class: 'tile-under', text: under }) : null,
    );
  }

  function drawStatistics() {
    const d = t.stat.data;
    if (!d) {
      main.append(
        el('p', {
          class: 'empty',
          text: t.stat.error
            ? `Could not build the statistics: ${t.stat.error}`
            : 'Fetching the statistics …',
        }),
      );
      return;
    }
    const n = d.keyFigures;
    const night = String(d.nightWindow ?? '23-06').replace('-', ' to ');

    // Chart 1: finished per day, stacked per class.
    const doneTotal = d.donePerDay.reduce((sum, r) => sum + r.sum, 0);
    const most = d.donePerDay.reduce((a, r) => (r.sum > a.sum ? r : a), d.donePerDay[0]);
    const graph1 = graph(
      `Done per day, last ${d.windowDays} days`,
      barGraph({
        rows: d.donePerDay,
        series: ['K', 'D', 'D+', 'U'].map((k) => ({ key: k, css: CLASS_CSS[k] })),
        format: (v) => counts(v, v % 1 ? 1 : 0),
        tipsFor: (r) =>
          `${date(r.day)}: ${r.sum} finished (K ${r.K}, D ${r.D}, D+ ${r['D+']}, U ${r.U})`,
        summary:
          `Done per day in the last ${d.windowDays} days, stacked per class: ${doneTotal} in total` +
          (most?.sum ? `, most ${most.sum} on ${date(most.day)}.` : '.'),
      }),
      ['K', 'D', 'D+', 'U'].map((k) => [CLASS_CSS[k], k]),
    );

    // In versus out: added and finished per day, two lines.
    const inOut = d.inOutPerDay ?? [];
    const inTotal = inOut.reduce((a, r) => a + r.in, 0);
    const outTotal = inOut.reduce((a, r) => a + r.out, 0);
    const graphInOut = graph(
      `Added and finished per day, last ${d.windowDays} days`,
      lineGraph({
        rows: inOut,
        series: [
          { key: 'in', css: 's-in' },
          { key: 'out', css: 's-out' },
        ],
        format: (v) => counts(v, v % 1 ? 1 : 0),
        tipsFor: (r) => `${date(r.day)}: ${r.in} added, ${r.out} finished`,
        summary:
          `Added and finished per day in the last ${d.windowDays} days: ${inTotal} added and ${outTotal} ` +
          `finished in total.`,
      }),
      [
        ['s-in', 'Added', 'line'],
        ['s-out', 'Done', true],
      ],
    );

    // Chart 2: time per class, median and average, split into work and review/merge, with estimated average as a line.
    const classes = d.perClass.filter((k) => k.count > 0);
    const sum = (k, template) => (k.work[template] ?? 0) + (k.review[template] ?? 0);
    const graph2 = graph(
      'Time per class (start to done)',
      classes.length
        ? horizontalGraph({
            groups: classes.map((k) => ({
              rows: ['median', 'average'].map((template) => ({
                label: template === 'median' ? `${k.class} median` : 'average',
                strong: template === 'median',
                parts: [
                  { val: k.work[template] ?? 0, css: 's-work' },
                  { val: k.review[template] ?? 0, css: 's-review' },
                ],
                text: duration(sum(k, template)),
                tips:
                  `${k.class}, ${template} of ${k.count}: work ${duration(k.work[template])} + review and merge ` +
                  `${duration(k.review[template])}`,
              })),
              strokes:
                k.estimateAverage != null
                  ? [
                      {
                        val: k.estimateAverage,
                        css: 'line-estimate',
                        tips: `${k.class}: estimated average ${duration(k.estimateAverage)}`,
                      },
                    ]
                  : [],
            })),
            max: Math.max(
              1,
              ...classes.flatMap((k) => [sum(k, 'median'), sum(k, 'average'), k.estimateAverage ?? 0]),
            ),
            format: (v) => duration(v),
            summary:
              'Median time from start to done per class: ' +
              classes.map((k) => `${k.class} ${duration(sum(k, 'median'))}`).join(', ') +
              '. The line is the estimated average.',
          })
        : el('p', { class: 'empty', text: 'No finished tasks with all the times yet.' }),
      [
        ['s-work', 'Work (start to delivered)'],
        ['s-review', 'Review and merge (delivered to done)'],
        ['line-estimate', 'Estimated average', true],
      ],
      d.excluded.class
        ? `${d.excluded.class} finished without start, delivery or done time are excluded.`
        : null,
    );

    // Chart 3: cost per day, night separately, with the daily quota as a line.
    const costTotal = d.costPerDay.reduce((a, r) => a + r.usd, 0);
    const nightTotal = d.costPerDay.reduce((a, r) => a + r.night, 0);
    const graph3 = graph(
      `Cost per day, last ${d.windowDays} days (USD, API equivalent)`,
      barGraph({
        rows: d.costPerDay.map((r) => ({
          day: r.day,
          dayPart: Math.max(0, r.usd - r.night),
          night: r.night,
          usd: r.usd,
        })),
        series: [
          { key: 'dayPart', css: 's-day' },
          { key: 'night', css: 's-night' },
        ],
        format: (v) => counts(v),
        tipsFor: (r) => `${date(r.day)}: ${usd(r.usd)}, of which night ${usd(r.night)}`,
        stroke: n.dailyBudget
          ? { val: n.dailyBudget, css: 'line-quota', tips: `Daily quota ${usd(n.dailyBudget)}` }
          : null,
        summary:
          `Cost per day in the last ${d.windowDays} days: ${usd(costTotal)} in total, ` +
          `${costTotal ? Math.round((nightTotal / costTotal) * 100) : 0} % at night (${night})` +
          (n.dailyBudget ? `, daily quota ${usd(n.dailyBudget)}.` : '.'),
      }),
      [
        ['s-day', 'Day'],
        ['s-night', `Night (${night})`],
        ...(n.dailyBudget ? [['line-quota', 'Daily quota', true]] : []),
      ],
    );

    // Chart 4: the context of the track agents against the cap.
    const k = d.context;
    const graph4 = graph(
      `Context at end, track agents last ${d.windowDays} days`,
      k.count
        ? horizontalGraph({
            groups: [
              {
                rows: [
                  ['median', k.median],
                  ['max', k.max],
                ].map(([label, v]) => ({
                  label,
                  strong: label === 'median',
                  parts: [{ val: v, css: v > k.cap ? 's-over' : 's-context' }],
                  text: thousand(v),
                  tips: `${label} of ${k.count} tracks: ${thousand(v)} tokens`,
                })),
              },
            ],
            strokes: [{ val: k.cap, css: 'line-quota', tips: `Cap approx. ${thousand(k.cap)}` }],
            max: Math.max(k.max ?? 0, k.cap),
            format: thousand,
            summary: `Context at end for ${k.count} track agents: median ${thousand(k.median)}, max ${thousand(k.max)}, cap approx. ${thousand(k.cap)}.`,
          })
        : el('p', { class: 'empty', text: 'No track agents with context logged yet.' }),
      [
        ['s-context', 'Context'],
        ['line-quota', `Cap approx. ${thousand(k.cap)}`, true],
      ],
      d.excluded.context ? `${d.excluded.context} tracks without context in the log are excluded.` : null,
    );

    main.append(
      el(
        'section',
        { class: 'keyFigures', 'aria-label': 'Key figures' },
        tile(
          `Done last ${d.doneDays} days`,
          counts(n.finished),
          'tasks set to done in the queue',
        ),
        tile(
          'Median cycle time',
          duration(n.cycleMedian),
          `start to done, ${n.cycleCount} tasks last ${d.windowDays} days` +
            (d.excluded.cycle ? `; ${d.excluded.cycle} without start time are excluded` : ''),
        ),
        tile(
          'Estimate accuracy',
          n.accuracy == null ? 'no data' : `${counts(n.accuracy, 2)} ×`,
          'median of actual time divided by the estimate (1.00 = as estimated)',
        ),
        // Only with a daily quota: without one, "0.00 USD" as a large number says nothing to act on.
        n.dailyBudget
          ? tile(
              'Usage today',
              usd(n.usageToday),
              `of ${usd(n.dailyBudget)} daily quota (${Math.round((n.usageToday / n.dailyBudget) * 100)} %)`,
            )
          : null,
        // Batch queue counted separately (waiting to be packed, not to be started).
        n.batchQueue?.count
          ? tile(
              'In batch queue',
              counts(n.batchQueue.count),
              `${counts(n.batchQueue.minutes)} content minutes in ${n.batchQueue.groups} ` +
                `${n.batchQueue.groups === 1 ? 'group' : 'groups'}, ${n.batchQueue.readyOnes} ready for packing`,
            )
          : null,
        // In versus out: arrow up when the queue grows.
        n.inOut
          ? tile(
              `In versus out, last ${d.doneDays} days`,
              `${counts(n.inOut.in, 1)} / ${counts(n.inOut.out, 1)}`,
              `added / finished per day · ` +
                (n.inOut.net > 0
                  ? `↑ queue grows by ${counts(n.inOut.net, 1)} per day`
                  : n.inOut.net < 0
                    ? `↓ queue shrinks by ${counts(-n.inOut.net, 1)} per day`
                    : '→ as many in as out'),
            )
          : null,
        // Only when enough resolutions have a time (otherwise the number is excluded).
        n.responseTime
          ? tile(
              'Median time from question to answer',
              length(n.responseTime.median),
              `${n.responseTime.count} owner questions resolved with timestamp`,
            )
          : null,
      ),
      el('div', { class: 'graphs' }, graph1, graphInOut, graph2, graph3, graph4),
      // The legend for the classes and badges (same as in the help).
      legend('stat'),
      // append() turns null into the text "null", so the remark is only added when it exists.
      ...(d.timeLogError
        ? [
            el('p', {
              class: 'graph-remark',
              text: `Could not find the time log (${d.timeLogError}); cost and context missing.`,
            }),
          ]
        : []),
    );
  }

  // ---- Settings (the gear) ----
  async function openSettings() {
    t.selected = null;
    t.inbox = false;
    t.setting = { loading: true };
    showPanel();
    drawSettings();
    panel.querySelector('.button-icon')?.focus();
    await getSettings();
  }
  async function getSettings() {
    let answer;
    try {
      answer = await api('/api/settings');
    } catch (e) {
      answer = { error: e.message };
    }
    if (t.setting === null) return; // closed meanwhile
    t.setting = answer;
    drawSettings();
  }

  function drawSettings() {
    const d = t.setting;
    const scroll = panel.scrollTop;
    const header = el(
      'div',
      { class: 'panel-header' },
      el('div', null, el('h2', { id: 'panel-title', text: 'Settings' })),
      el(
        'button',
        { type: 'button', class: 'button-icon', 'aria-label': 'Close', onclick: closePanel },
        icon('close'),
      ),
    );
    if (!d || d.loading || d.error) {
      panel.replaceChildren(
        header,
        helpSection(),
        themeSection(),
        mascotSection(),
        el('p', {
          class: 'empty',
          text: d?.error ? `Could not read the settings: ${d.error}` : 'Fetching the settings …',
        }),
      );
      return;
    }
    const o = d.setup;
    panel.replaceChildren(
      header,
      helpSection(),
      themeSection(),
      mascotSection(),
      el(
        'section',
        { class: 'setting', 'aria-labelledby': 'setting-queue' },
        el('h3', { id: 'setting-queue', class: 'setting-title', text: 'The queue' }),
        d.field.map((f) => settingField(f, d)),
      ),
      undoSection(),
      el(
        'section',
        { class: 'setting', 'aria-labelledby': 'setting-setup' },
        el('h3', { id: 'setting-setup', class: 'setting-title', text: 'Setup (read only)' }),
        el('dl', { class: 'facts' }, setupFacts(o)),
      ),
      el(
        'section',
        { class: 'setting', 'aria-labelledby': 'setting-rules' },
        el('h3', { id: 'setting-rules', class: 'setting-title', text: 'Rules from the skill' }),
        list2(o.rules),
        el('p', { class: 'setting-source', text: `Source: ${o.rulesSource}` }),
      ),
    );
    panel.scrollTop = scroll;
  }

  function settingField(f, d) {
    const id = `g-${f.name}`;
    const error = el('p', { class: 'setting-error', role: 'alert', hidden: true });
    const control =
      f.type === 'onoff'
        ? el(
            'select',
            { id, 'aria-describedby': `${id}-help` },
            ['on', 'off'].map((v) =>
              el('option', { value: v, selected: f.val === v, text: v === 'on' ? 'On' : 'Off' }),
            ),
          )
        : el('input', {
            id,
            type: 'text',
            value: f.val,
            inputmode: f.type === 'integer' ? 'numeric' : null,
            autocomplete: 'off',
            'aria-describedby': `${id}-help`,
          });
    const save = el('button', {
      type: 'button',
      class: 'button button-muted',
      text: 'Save',
      'aria-label': `Save ${f.title.toLowerCase()}`,
      onclick: () => saveLimit(f, control.value, error),
    });
    control.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save.click();
      }
    });
    const meta = [
      `now: ${f.val}`,
      `default: ${f.standard}`,
      // SAVER_MODE: the recommended ceiling that keeps the weekly quota from running out early.
      f.saverMode ? `recommended: at most ${f.saverMode}` : null,
      f.name === 'dailyBudget' ? `used today: ${usd(d.usageToday)}` : null,
      f.name === 'nightRun' && d.night?.stop ? 'night pause now' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return el(
      'div',
      { class: 'setting-field' },
      el('label', { for: id, text: f.title }),
      el('p', { id: `${id}-help`, class: 'setting-explanation', text: f.explanation }),
      el('div', { class: 'setting-control' }, control, save),
      el('p', { class: 'setting-meta', text: meta }),
      error,
    );
  }

  async function saveLimit(f, val, errorEl) {
    errorEl.hidden = true;
    try {
      const answer = await writeWithGuard('/api/limit', { name: f.name, val: String(val).trim() });
      if (!answer) return; // aborted
      messageWithInfo(`${f.title}: saved`, answer);
      await getSettings();
      update(true);
    } catch (e) {
      // The message from queue.mjs (or the guard rules) is shown by the field.
      errorEl.textContent = e.message;
      errorEl.hidden = false;
    }
  }

  function setupFacts(o) {
    const orch = o.orchestrator ?? {};
    const orchestrator = orch.updated
      ? `${orch.session ?? '?'}: ${orch.active ? 'active' : (orch.reason ?? 'not active')}, last pulse ${age(orch.updated)} ago` +
        (orch.event ? ` (${orch.event})` : '')
      : 'no marker (no orchestrator has reported in)';
    const model = o.models?.length
      ? o.models.map((m) => `${m.model} (${m.count})`).join(', ')
      : 'not logged yet';
    // Plugin install: the hooks are in the plugin's hooks/hooks.json and the skills in its skills/ folder.
    // Vendored install: they are in the project's .claude/settings.json and .claude/skills/<name>/SKILL.md.
    const plugin = o.install?.mode === 'plugin';
    const from = plugin ? ' (from the plugin)' : '';
    const hooks = !o.hooks
      ? plugin
        ? "could not read the plugin's hooks/hooks.json"
        : 'could not find .claude/settings.json'
      : o.hooks.all
        ? `yes, all the queue system hooks are in place${from}`
        : el('strong', { class: 'fare', text: `missing: ${o.hooks.missing.join(', ')}` });
    const skills = !o.skills
      ? 'unknown'
      : o.skills.all
        ? `yes, all (${o.skills.exists.join(', ')})${from}`
        : el('strong', { class: 'fare', text: `missing: ${o.skills.missing.join(', ')}` });
    const install = plugin
      ? `plugin${o.install.name ? ` ${o.install.name}` : ''}${o.install.version ? ` ${o.install.version}` : ''}`
      : 'vendored (scripts and skills copied into the project)';
    const rows = [
      ...facts('Installed as', o.install ? install : null),
      ...facts('Base branch', o.baseBranch ?? 'main'),
    ];
    // The migrations are shown only when the project has turned them on (migrations.folder in queue.config.json).
    const m = o.migrations;
    if (m) {
      const highest = m.highest ? `${m.highest.number} (${m.highest.file})` : 'none';
      rows.push(
        ...facts(
          'Migrations',
          m.error
            ? `could not read ${m.folder} (${m.error})`
            : `next available block ${m.next ?? '?'}; highest in ${m.folder}: ${highest}`,
        ),
      );
    }
    rows.push(
      ...facts('Orchestrator', orchestrator),
      ...facts('Model in the last tracks', model),
      ...facts('Queue system hooks', hooks),
      ...facts('Queue system skills', skills),
    );
    return rows;
  }

  // ---- "Waiting on you": what is waiting on the owner, in the side panel ----
  const inboxButton = $('inbox');
  const QUESTION_TYPE = {
    question: { name: 'Question', button: 'Answer', field: 'Your answer' },
    condition: {
      name: 'Waiting on condition',
      button: 'Mark fulfilled',
      field: 'How is the condition fulfilled?',
    },
    lawyer: {
      name: 'Waiting on lawyer',
      button: 'Mark fulfilled',
      field: 'What did the lawyer say, and what does it mean?',
    },
    'owner-task': { name: 'Owner task', button: 'Answer', field: 'What is completed?' },
  };
  const spType = (type) => QUESTION_TYPE[type] ?? QUESTION_TYPE.question;

  /** The counter on the button at the top: everything waiting on the owner (question, QA, proposed, what is stuck). */
  function drawInboxButton() {
    const n = t.data?.inbox?.count ?? 0;
    inboxButton.replaceChildren(
      'Waiting on you',
      ...(n ? [el('span', { class: 'inbox-count', text: String(n) })] : []),
    );
    inboxButton.setAttribute('aria-label', n ? `Waiting on you: ${n}` : 'Waiting on you: nothing');
    inboxButton.classList.toggle('active', n > 0);
    inboxButton.setAttribute('aria-expanded', t.inbox ? 'true' : 'false');
  }

  function openInbox() {
    t.selected = null;
    t.setting = null;
    t.fromInbox = false;
    t.inbox = true;
    showPanel();
    panel.scrollTop = 0;
    drawInbox(true);
    drawInboxButton();
    panel.querySelector('.button-icon')?.focus();
  }
  inboxButton.addEventListener('click', () => (t.inbox ? closePanel() : openInbox()));

  /** A part of the inbox: title with count, content, and (optional) an action for the checked ones. */
  function inboxPart(name, title, count, content, footer) {
    return el(
      'section',
      { class: 'inbox-del', 'aria-labelledby': `inbox-${name}` },
      el('h3', { id: `inbox-${name}`, class: 'setting-title' }, `${title} (${count})`),
      content,
      footer ?? null,
    );
  }

  /** Check off (QA, proposed): the selected set survives a redraw; focus follows data-focus. */
  function checkOff(set, id, label) {
    return el('input', {
      type: 'checkbox',
      'data-focus': `option:${id}`,
      'aria-label': label,
      checked: set.has(id),
      onchange: (e) => {
        if (e.target.checked) set.add(id);
        else set.delete(id);
        drawInbox(true); // an action from the owner: redraw even if an answer field has focus
      },
    });
  }

  function questionRow(s, i) {
    const type = spType(s.type);
    const open = t.answerOpen === s.sp;
    const row = el(
      'li',
      { class: 'inbox-row' },
      el(
        'div',
        { class: 'row-header' },
        el('span', { class: `badge sp-type sp-${s.type}`, text: type.name }),
        el('span', { class: 'sp-id', text: s.sp }),
        el('span', {
          class: 'sp-locks',
          text: s.count
            ? `unlocks ${s.count} ${s.count === 1 ? 'task' : 'tasks'} · ${duration(s.minutes)}`
            : 'no task waiting',
        }),
        // What the answer unlocks in focus (the sort basis when focus is set).
        s.focus
          ? el('span', {
              class: `badge sp-focus${s.focus.count ? '' : ' empty-focus'}`,
              text: s.focus.count
                ? `in focus: unlocks ${s.focus.count} (${duration(s.focus.minutes)})`
                : 'nothing in focus',
              title: s.focus.count
                ? 'Tasks in the focus steps waiting on this answer, directly or via the chain. ' +
                  s.focus.per_step
                    .map((m, j) => (m ? `T${j + 1}: ${duration(m)}` : null))
                    .filter(Boolean)
                    .join(', ')
                : 'The answer does not unlock anything in the focus steps now. It is therefore sorted after those that do.',
            })
          : null,
      ),
      el('p', {
        class: s.text ? 'sp-text' : 'sp-text missing',
        text: s.text ?? 'No text registered yet (cq question <id> --text …).',
      }),
      s.recommendation ? el('p', { class: 'sp-meta', text: `Recommendation: ${s.recommendation}` }) : null,
      s.source ? el('p', { class: 'sp-meta', text: `Source: ${s.source}` }) : null,
      s.direct.length
        ? el(
            'p',
            { class: 'sp-meta' },
            'Waiting: ',
            s.direct.map((id) =>
              el('button', {
                type: 'button',
                class: 'link-button',
                text: id,
                onclick: () => openPanel(id, { fromInbox: true }),
              }),
            ),
          )
        : null,
    );
    if (!open) {
      row.append(
        el('button', {
          type: 'button',
          class: 'button button-muted',
          'data-focus': `answer:${i}`,
          text: type.button,
          'aria-label': `${type.button}: ${s.sp}`,
          onclick: () => {
            t.answerOpen = s.sp;
            drawInbox(true);
            panel.querySelector(`#answer-${i}`)?.focus();
          },
        }),
      );
      return row;
    }
    const field = el('textarea', {
      id: `answer-${i}`,
      rows: 3,
      'data-focus': `answerText:${i}`,
      oninput: (e) => t.answerDraft.set(s.sp, e.target.value),
    });
    field.value = t.answerDraft.get(s.sp) ?? '';
    const save = async () => {
      const answer = field.value.trim();
      // Guard rule 15: an empty answer stops (the server checks the same).
      if (!answer) return message(`${type.field.replace(/\?$/, '')}: write the answer first.`, true);
      const completed = await action({ type: 'resolve', sp: s.sp, answer }, `${s.sp}: resolved`);
      if (completed) {
        t.answerOpen = null;
        t.answerDraft.delete(s.sp);
        drawInbox(true);
      }
    };
    row.append(
      el(
        'div',
        { class: 'actions answer-form' },
        el('div', { class: 'field' }, el('label', { for: `answer-${i}`, text: type.field }), field),
        s.recommendation
          ? el('button', {
              type: 'button',
              class: 'button button-outline',
              text: 'Use the recommendation',
              onclick: () => {
                field.value = s.recommendation;
                t.answerDraft.set(s.sp, field.value);
                field.focus();
              },
            })
          : null,
        el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Cancel',
          onclick: () => {
            t.answerOpen = null;
            drawInbox(true);
          },
        }),
        el('button', {
          type: 'button',
          class: 'button button-filled',
          text: s.type === 'condition' || s.type === 'lawyer' ? 'Mark fulfilled' : 'Save answer',
          onclick: save,
        }),
      ),
    );
    return row;
  }

  /**
   * "Sort" in "Waiting on you": tasks without a project, with an uncertain proposal, or where the project conflicts
   * with the files and the plan. Rows with a proposal can be accepted one by one or combined (the bulk action accept-suggestion, with
   * preview). Not counted in the number on the button: it is cleanup, not something that stops the queue.
   */
  function sortPart(rows) {
    const ids = new Set(rows.map((r) => r.id));
    for (const id of [...t.selectedSort]) if (!ids.has(id)) t.selectedSort.delete(id);
    const withSuggestion = rows.filter((r) => r.proposed && markable(r.id));
    const chosen = [...t.selectedSort].filter((id) => withSuggestion.some((r) => r.id === id));
    const TYPE = {
      disagree: [
        'conflicts',
        'The current project conflicts with a strong signal (files, plan or prefix).',
      ],
      move: ['without project', 'Without a project today, with a confident proposal.'],
      sort: ['uncertain', 'Without a project or with an uncertain proposal: pick the project yourself.'],
    };
    const row = (r) =>
      el(
        'li',
        { class: 'inbox-row sort-row' },
        el(
          'div',
          { class: 'row-header' },
          r.proposed && markable(r.id)
            ? checkOff(t.selectedSort, r.id, `Select ${r.id} for "Accept all proposals for selected"`)
            : null,
          el('button', {
            type: 'button',
            class: 'link-button',
            text: r.id,
            title: 'Open task',
            onclick: () => openPanel(r.id, { fromInbox: true }),
          }),
          el('span', {
            class: 'badge',
            text: TYPE[r.type]?.[0] ?? r.type,
            title: TYPE[r.type]?.[1] ?? null,
          }),
        ),
        el('p', { class: 'sp-text', text: r.title ?? '' }),
        el('p', {
          class: 'sp-meta',
          text:
            `Now: ${r.now}` +
            (r.proposed ? ` · proposed: ${r.proposed}` : ' · no proposal') +
            (r.reason ? ` · ${r.reason}` : ''),
        }),
        r.proposed && markable(r.id)
          ? el('button', {
              type: 'button',
              class: 'button button-muted button-small',
              text: 'Accept proposal',
              title: `Move ${r.id} to the project ${r.proposed}. You see the change before it is saved.`,
              onclick: () => openBulk('accept-suggestion', [r.id]),
            })
          : null,
      );
    return inboxPart(
      'sort',
      'Sort',
      rows.length,
      [
        el('p', {
          class: 'inbox-info',
          text:
            'Cleanup, not something that stops the queue: the project decides the area and the focus step a task ends up in.',
        }),
        el('ol', { class: 'inbox-list' }, rows.map(row)),
      ],
      withSuggestion.length
        ? el(
            'div',
            { class: 'actions' },
            el('button', {
              type: 'button',
              class: 'link-button',
              'data-focus': 'sort-all',
              text: chosen.length === withSuggestion.length ? 'Select none' : 'Select all with proposal',
              onclick: () => {
                if (chosen.length === withSuggestion.length) t.selectedSort.clear();
                else for (const r of withSuggestion) t.selectedSort.add(r.id);
                drawInbox(true);
              },
            }),
            el('button', {
              type: 'button',
              class: 'button button-muted',
              'data-focus': 'sort-accept',
              text: `Accept all proposals for selected (${chosen.length})`,
              disabled: !chosen.length,
              title:
                'Gives every selected task the project the queue proposes. You see the changes before they are saved.',
              onclick: () => openBulk('accept-suggestion', chosen),
            }),
          )
        : null,
    );
  }

  function drawInbox(fresh) {
    if (!t.inbox) return;
    // Do not redraw while the owner writes an answer (the text field would lose the cursor).
    if (
      !fresh &&
      panel.contains(document.activeElement) &&
      document.activeElement.tagName === 'TEXTAREA'
    )
      return;
    const focus = panel.contains(document.activeElement)
      ? document.activeElement.dataset?.focus
      : null;
    const scroll = panel.scrollTop;
    const d = t.data?.inbox;
    const header = el(
      'div',
      { class: 'panel-header' },
      el('div', null, el('h2', { id: 'panel-title', text: 'Waiting on you' })),
      el(
        'button',
        { type: 'button', class: 'button-icon', 'aria-label': 'Close', onclick: closePanel },
        icon('close'),
      ),
    );
    if (!d) {
      panel.replaceChildren(header, el('p', { class: 'empty', text: 'Fetching the queue …' }));
      return;
    }
    // Checked items no longer waiting (approved, QA ok, gone) are removed from the selection.
    const qaIds = new Set(
      d.qa.flatMap((p) => p.features.flatMap((f) => f.tasks.map((o) => o.id))),
    );
    for (const id of [...t.selectedQa]) if (!qaIds.has(id)) t.selectedQa.delete(id);
    const suggestionIds = new Set(d.proposed.map((f) => f.id));
    for (const id of [...t.selectedSuggestion]) if (!suggestionIds.has(id)) t.selectedSuggestion.delete(id);
    if (t.answerOpen && !d.question.some((s) => s.sp === t.answerOpen)) t.answerOpen = null;

    const parts = [header];
    if (!d.count)
      parts.push(
        el(
          'p',
          { class: 'inbox-empty' },
          icon('checkmark'),
          el('span', { text: 'Nothing waiting on you' }),
        ),
      );

    if (d.question.length)
      parts.push(
        inboxPart('question', 'Question', d.question.length, [
          d.focus_sorted
            ? el('p', {
                class: 'inbox-info',
                text:
                  'Sorted by how much the answer unlocks in focus: stage 1 first, then the minutes. Questions that ' +
                  'do not touch focus come last.',
              })
            : null,
          el('ol', { class: 'inbox-list' }, d.question.map(questionRow)),
        ]),
      );

    if (d.sort?.length) parts.push(sortPart(d.sort));

    if (d.qaCount) {
      const allSelected = qaIds.size > 0 && [...qaIds].every((id) => t.selectedQa.has(id));
      const n = t.selectedQa.size;
      parts.push(
        inboxPart(
          'qa',
          'QA',
          d.qaCount,
          [
            el('button', {
              type: 'button',
              class: 'link-button',
              'data-focus': 'qa-all',
              text: allSelected ? 'Select none' : 'Select all',
              onclick: () => {
                if (allSelected) t.selectedQa.clear();
                else for (const id of qaIds) t.selectedQa.add(id);
                drawInbox(true);
              },
            }),
            ...d.qa.map((p) =>
              el(
                'div',
                { class: 'qa-project' },
                el('h4', { class: 'qa-name', text: p.title ? `${p.title} (${p.pid})` : p.pid }),
                p.features.map((f) =>
                  el(
                    'div',
                    { class: 'qa-feature' },
                    el('p', { class: 'qa-feature-name', text: f.feature }),
                    el(
                      'ul',
                      { class: 'inbox-list' },
                      f.tasks.map((o) =>
                        el(
                          'li',
                          { class: 'inbox-row row-summary' },
                          el(
                            'label',
                            { class: 'row-option' },
                            checkOff(t.selectedQa, o.id, `Select ${o.id} for QA ok`),
                            el('span', { class: 'sp-id', text: o.id }),
                            el('span', { class: 'row-title', text: o.title }),
                            o.done
                              ? el('span', {
                                  class: 'sp-meta',
                                  text: `done ${age(o.done)} ago`,
                                })
                              : null,
                          ),
                          el('button', {
                            type: 'button',
                            class: 'button button-outline',
                            text: 'Deviation',
                            'aria-label': `Report deviation on ${o.id}`,
                            onclick: () => {
                              openPanel(o.id, { fromInbox: true });
                              panel.querySelector('#qa-text')?.focus();
                            },
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
          el(
            'div',
            { class: 'inbox-footer' },
            el('button', {
              type: 'button',
              class: 'button button-filled',
              'data-focus': 'qa-ok',
              text: n ? `QA ok for selected (${n})` : 'QA ok for selected',
              disabled: n === 0,
              onclick: async () => {
                const ids = [...t.selectedQa];
                if (await action({ type: 'qa-ok', ids }, `QA ok: ${ids.join(', ')}`))
                  t.selectedQa.clear();
                drawInbox(true);
              },
            }),
          ),
        ),
      );
    }

    if (d.proposed.length) {
      const n = t.selectedSuggestion.size;
      parts.push(
        inboxPart(
          'proposed',
          'Proposed',
          d.proposed.length,
          el(
            'ul',
            { class: 'inbox-list' },
            d.proposed.map((f) =>
              el(
                'li',
                { class: 'inbox-row row-summary' },
                el(
                  'label',
                  { class: 'row-option' },
                  checkOff(t.selectedSuggestion, f.id, `Select ${f.id} for approval`),
                  el('span', { class: 'sp-id', text: f.id }),
                  el('span', { class: 'row-title', text: f.title }),
                  el('span', {
                    class: 'sp-meta',
                    // Who proposed it, only when known (no "from ?").
                    text: `${f.class ?? '?'} · ${f.estimate} min · value ${f.value}${f.added_by ? ` · from ${f.added_by}` : ''}`,
                  }),
                ),
                el('button', {
                  type: 'button',
                  class: 'button button-muted',
                  text: 'Approve',
                  'aria-label': `Approve ${f.id}`,
                  onclick: async () => {
                    await action(
                      { type: 'approve', id: f.id },
                      `${f.id} is approved and waiting in the queue`,
                    );
                    drawInbox(true);
                  },
                }),
              ),
            ),
          ),
          el(
            'div',
            { class: 'inbox-footer' },
            el('button', {
              type: 'button',
              class: 'button button-filled',
              'data-focus': 'approve-selected',
              text: n ? `Approve selected (${n})` : 'Approve selected',
              disabled: n === 0,
              onclick: async () => {
                const ids = [...t.selectedSuggestion];
                if (await action({ type: 'approve', ids }, `Approved: ${ids.join(', ')}`))
                  t.selectedSuggestion.clear();
                drawInbox(true);
              },
            }),
          ),
        ),
      );
    }

    if (d.stuck.length)
      parts.push(
        inboxPart(
          'stuck',
          'Stuck',
          d.stuck.length,
          el(
            'ul',
            { class: 'inbox-list' },
            d.stuck.map((h) =>
              el(
                'li',
                { class: 'inbox-row row-summary' },
                el(
                  'div',
                  { class: 'row-option' },
                  el('span', { class: 'sp-id', text: h.id }),
                  el('span', { class: 'row-title', text: h.title }),
                  el('span', {
                    class: 'sp-meta',
                    text: h.aging
                      ? `${h.status === 'review' ? 'in review' : 'running'}, started ${duration(h.aging.age)} ago; ` +
                        `85 % of ${h.class ?? '?'} tasks are ${h.aging.measure === 'work' ? 'delivered' : 'finished'} within ${duration(h.aging.limit)}`
                      : `picked by ${h.picked_by ?? '?'} ${h.start ? age(h.start) : '?'} ago, without commits in the last 72 h`,
                  }),
                ),
                el('button', {
                  type: 'button',
                  class: 'button button-outline',
                  text: 'Open',
                  'aria-label': `Open ${h.id}`,
                  onclick: () => openPanel(h.id, { fromInbox: true }),
                }),
              ),
            ),
          ),
        ),
      );

    if (d.unlogged.length)
      parts.push(
        el('p', {
          class: 'inbox-info',
          text:
            `${d.unlogged.length} ${d.unlogged.length === 1 ? 'answer is' : 'answers are'} not entered in the decision log yet ` +
            `(${d.unlogged.map((x) => x.sp).join(', ')}). The orchestrator enters them (cq resolutions --unlogged).`,
        }),
      );

    panel.replaceChildren(...parts);
    panel.scrollTop = scroll;
    if (focus) panel.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
  }

  // ---- Detail panel ----
  let panelFrom = null;
  /**
   * Shows the side panel as a modal dialog: remembers the element that opened it (focus goes back there
   * on close), and makes the rest of the page inert so Tab and the screen reader stay in the panel. The focus trap below catches Tab
   * at the ends. Everything that opens the panel (details, inbox, settings, help) goes here.
   */
  const PANEL_INERT = ['header.top', '#focusLine', '#stripe', '#board', '#optionLine'];
  function showPanel() {
    if (panel.hidden) panelFrom = document.activeElement;
    panel.hidden = false;
    background.hidden = false;
    window.QueueA11y.setInert(
      PANEL_INERT.map((v) => document.querySelector(v)),
      true,
    );
  }
  panel.addEventListener('keydown', (e) => window.QueueA11y.trapKey(e, panel));
  /** Opens the detail panel and selects the card's chain. `fromInbox`: the panel gets "Back to Waiting on you". */
  function openPanel(id, { fromInbox = false } = {}) {
    if (!t.perId.has(id)) return;
    t.setting = null;
    t.inbox = false;
    t.help = false;
    t.fromInbox = fromInbox;
    t.selected = id;
    showPanel();
    selectChain(id);
    drawPanel(true);
    panel.querySelector('.button-icon')?.focus();
    if (!t.details.has(id)) getDetails(id);
  }
  function closePanel() {
    t.selected = null;
    t.setting = null;
    t.inbox = false;
    t.help = false;
    t.fromInbox = false;
    panel.hidden = true;
    background.hidden = true;
    panel.replaceChildren();
    // Inert off before focus moves back (an inert element cannot get focus).
    window.QueueA11y.setInert(
      PANEL_INERT.map((v) => document.querySelector(v)),
      false,
    );
    drawInboxButton();
    // If the card that opened the panel was redrawn meanwhile, the new card with the same id gets focus.
    // The card may have been rebuilt while the panel was open: find it again by id (on the card it is the button
    // that has focus; the id sits on the card around it).
    const fromId = panelFrom?.isConnected ? null : panelFrom?.closest?.('[data-id]')?.dataset.id;
    if (fromId) {
      const fresh = main.querySelector(`[data-id="${CSS.escape(fromId)}"]`);
      panelFrom = fresh?.querySelector('.summary-button') ?? fresh;
    }
    if (panelFrom?.isConnected) panelFrom.focus();
    panelFrom = null;
  }
  async function getDetails(id) {
    try {
      const d = await api(`/api/task?id=${encodeURIComponent(id)}`);
      t.details.set(id, d);
    } catch (e) {
      t.details.set(id, { error: e.message });
    }
    if (t.selected === id) drawPanel();
  }

  function facts(dt, dd) {
    if (dd == null || dd === '' || (Array.isArray(dd) && !dd.length)) return [];
    return [el('dt', { text: dt }), el('dd', null, dd)];
  }
  const list2 = (values, code) =>
    el(
      'ul',
      null,
      values.map((v) => el('li', null, code ? el('code', { text: v }) : v)),
    );

  /** The title of an area (oid) from the board, "Without area" for without-area, or null when the card has no area. */
  function areaTitle(oid) {
    if (!oid) return null;
    if (oid === 'without-area') return 'Without area';
    return (t.data?.areas ?? []).find((o) => o.oid === oid)?.title ?? oid;
  }

  /**
   * "Placement" in the detail panel for a card in the queue: the focus step (or why it is outside), the place
   * among the ready ones in the step, who dragged it along, and the points with the formula (queueLogic.scoreParts, same numbers the
   * queue uses).
   */
  function placementFacts(k, idButton) {
    const pl = k.space;
    const f = t.data.focus;
    let stage;
    if (k.parked) stage = 'On hold (not ranked until the wait is over)';
    else if (!f?.active) stage = 'No focus (the whole queue is ranked by score)';
    else if (pl.step == null)
      stage = pl.out
        ? `Outside focus: ${pl.reason ?? 'waiting until focus is done'}`
        : 'Outside focus (fills available capacity after the focus steps)';
    else stage = `T${pl.step + 1} ${f.stage?.[pl.step]?.title ?? ''}`.trim();
    if (pl.nr && pl.by)
      stage += ` · no. ${pl.nr} of ${pl.by} ready ${f?.active && pl.step != null ? 'in the step' : 'here'}`;
    const sd = k.score_parts;
    const counts = (x) => String(Math.round(x * 100) / 100);
    const formula = sd
      ? `${counts(sd.score)} = value ${sd.value} / ${sd.minutes} min × 100 × unlocks (1 + 0.25 × ${sd.unlocks}) × ` +
        `age (1 + 0.02 × ${counts(Math.min(sd.days, 14))} d)` +
        (sd.bonus
          ? ` ${sd.bonus > 0 ? '+' : '−'} ${Math.abs(sd.bonus)} (the task's bonus)`
          : '') +
        (sd.project_bonus
          ? ` ${sd.project_bonus > 0 ? '+' : '−'} ${Math.abs(sd.project_bonus)} (the project's bonus)`
          : '')
      : String(k.score ?? '?');
    // One flat list of dt/dd: el() flattens only one level, so a list of facts() lists would show up as
    // "[object HTMLElement]" in the panel.
    return [
      ...facts('Placement', stage),
      ...facts('Dragged along by', pl.dragged_by ? idButton(pl.dragged_by) : null),
      ...facts(
        'Score',
        el('span', { text: formula, title: 'Higher score is started first within the same stage.' }),
      ),
    ];
  }

  function drawPanel(fresh) {
    const found = t.perId.get(t.selected);
    if (!found) return closePanel();
    // Do not redraw the panel while the owner writes in a field there.
    if (
      !fresh &&
      panel.contains(document.activeElement) &&
      /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)
    )
      return;
    const { k, col } = found;
    const p = project(k.project);
    const d = t.details.get(k.id);
    const scroll = panel.scrollTop;

    const idButton = (id) => {
      const x = t.perId.get(id);
      return x
        ? el('button', {
            type: 'button',
            class: 'link-button',
            text: `${id} (${x.k.status})`,
            onclick: () => openPanel(id, { fromInbox: t.fromInbox }),
          })
        : el('code', { text: id });
    };
    const depends_on = k.depends_on.map(idButton);
    // "Unlocks": the direct successors as clickable ids, and the whole chain as numbers.
    const lockState = col !== 'built' ? k.unlocks : null;
    const unlocksOf = lockState
      ? [
          ...lockState.direct.map(idButton),
          el('span', {
            class: 'facts-remark',
            text: `total ${lockState.count} via the chain (${duration(lockState.minutes)} estimated)`,
          }),
        ]
      : null;
    // The question text (from the inbox) for what the card waits on and that is not resolved.
    const spText = new Map((t.data.inbox?.question ?? []).map((s) => [s.sp, s.text]));
    const branch = d?.branch
      ? d.branch.exists
        ? `${d.branch.name}: ${d.branch.commits} commit(s) ahead ${t.data?.baseBranch ?? 'main'}`
        : `${d.branch.name} does not exist yet`
      : d?.error
        ? `could not read (${d.error})`
        : 'fetching …';
    const status = k.batched
      ? 'In batch queue (not started alone; packed into a track with cq batch pack)'
      : ({
          waiting: k.ready ? 'In queue, ready now' : 'In queue, blocked',
          proposed: 'Proposed (must be approved)',
          running: 'Running',
          picked: `Picked by ${k.picked_by ?? '?'}`,
          external: `Work outside queue (${k.external_name ?? '?'})`,
          review: 'Review',
          done: 'Built',
        }[k.status] ?? k.status);

    panel.replaceChildren(
      el(
        'div',
        { class: 'panel-header' },
        el(
          'div',
          null,
          t.fromInbox
            ? el('button', {
                type: 'button',
                class: 'link-button back',
                text: '← Waiting on you',
                onclick: () => openInbox(),
              })
            : null,
          el('span', { class: 'summary-id', text: k.id }),
          el('h2', { id: 'panel-title', text: k.title }),
        ),
        el(
          'button',
          { type: 'button', class: 'button-icon', 'aria-label': 'Close', onclick: closePanel },
          icon('close'),
        ),
      ),
      el(
        'dl',
        { class: 'facts' },
        facts(
          'Status',
          `${status}${k.start ? ` · ${age(k.start)}` : ''}${k.old ? ' · old' : ''}` +
            (k.aging ? ' · older than usual for the class' : ''),
        ),
        k.aging ? facts('Age', agingText(k)) : [],
        facts('On hold', k.parked ? waitText(k.parked) : null),
        facts('Project', `${p?.title ?? k.project} (${k.project})`),
        facts('Feature', k.feature),
        // Link to the plan entry (switches to Plans with the entry open).
        facts(
          'Plan entry',
          k.plan
            ? el('button', {
                type: 'button',
                class: 'link-button',
                text: [k.plan, window.QueuePlans?.title(k.plan)].filter(Boolean).join(' '),
                onclick: () => {
                  closePanel();
                  window.QueuePlans?.openEntry(k.plan);
                },
              })
            : null,
        ),
        facts(
          'Class',
          `${k.class ?? '?'} · value ${k.value} · ${k.estimate} min${k.domain ? ` · ${k.domain}` : ''}`,
        ),
        col === 'queue' && k.space ? placementFacts(k, idButton) : [],
        col === 'queue' && !k.space
          ? facts(
              'Priority',
              `${k.score}${k.priority_bonus ? ` (bonus ${k.priority_bonus > 0 ? '+' : ''}${k.priority_bonus})` : ''}`,
            )
          : [],
        facts('Area', areaTitle(k.area)),
        facts('Depends on', depends_on.length ? depends_on : null),
        facts('Unlocks', unlocksOf),
        facts(
          'Waiting on',
          k.waiting_on.length
            ? list2(
                k.waiting_on.map(
                  (v) =>
                    `${v.sp}${v.resolved ? ' (resolved)' : ''}` +
                    (spText.get(v.sp) ? `: ${spText.get(v.sp)}` : ''),
                ),
              )
            : null,
        ),
        col === 'queue' && k.blockers.length ? facts('Blockers', list2(k.blockers)) : [],
        facts('Owner files', k.owned_files.length ? list2(k.owned_files, true) : null),
        facts('DB', k.owner_db.length ? list2(k.owner_db, true) : null),
        facts('Branch', branch),
        facts('Cloud', cloudFacts(k)),
        facts('Migrations', k.migr_block),
        facts('QA', k.qa_status ? `${k.qa_status}${k.qa_note ? `: ${k.qa_note}` : ''}` : null),
        facts(
          'Source',
          [k.source, k.added_by ? `added by ${k.added_by}` : null]
            .filter(Boolean)
            .join(' · '),
        ),
        facts('Remarks', k.remarks.length ? list2(k.remarks) : null),
      ),
      actionsFor(k, col),
      el(
        'section',
        { class: 'mission', 'aria-label': 'The mission' },
        el('h3', {
          class: 'mission-title',
          text: d?.mission?.path ? `The mission (${d.mission.path})` : 'The mission',
        }),
        d?.mission
          ? markdown(d.mission.text)
          : el('p', { class: 'empty', text: d?.error ?? 'Fetching the mission …' }),
      ),
    );
    panel.scrollTop = scroll;
  }

  function actionsFor(k, col) {
    const box = el('div', { class: 'actions', 'aria-label': 'Actions' });
    if (col === 'queue') {
      const name = el('input', {
        id: 'pick-name',
        type: 'text',
        value: store.getItem('queue-board-name') ?? '',
        autocomplete: 'off',
      });
      box.append(
        el('button', {
          type: 'button',
          class: 'button button-muted',
          text: 'To the top of the queue',
          onclick: () => move({ id: k.id, top: true }, `${k.id} is at the top of the queue`),
        }),
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'pick-name', text: 'Who is picking?' }),
          name,
        ),
        el('button', {
          type: 'button',
          class: 'button button-filled',
          text: 'Pick',
          onclick: () => {
            const by = name.value.trim();
            if (!by) return message('Write who is picking.', true);
            store.setItem('queue-board-name', by);
            action({ type: 'pick', id: k.id, by }, `${k.id} is picked by ${by}`);
          },
        }),
      );
      // Send the task to a cloud session (paste the package), and register that it is started there.
      if (k.cloud?.suitable) {
        const session = el('input', {
          id: 'cloud-session',
          type: 'text',
          autocomplete: 'off',
          placeholder: 'https://claude.ai/code/…',
        });
        box.append(
          el('button', {
            type: 'button',
            class: 'button button-muted',
            text: 'Copy cloud package',
            onclick: () => copyCloudPackage([k.id]),
          }),
          el(
            'div',
            { class: 'field' },
            el('label', { for: 'cloud-session', text: 'Link to the cloud session (optional)' }),
            session,
          ),
          el('button', {
            type: 'button',
            class: 'button button-muted',
            text: 'Started in cloud',
            onclick: () =>
              action(
                { type: 'cloud-start', id: k.id, execution: session.value.trim() || undefined },
                `${k.id} is started in the cloud`,
              ),
          }),
        );
        const field = cloudPackageField([k.id]);
        if (field) box.append(field);
      }
    } else if (k.in_cloud) {
      // The cloud session is done (branch checked with git fetch by queue.mjs cloud done), or is canceled.
      const branch = el('input', {
        id: 'cloud-branch',
        type: 'text',
        autocomplete: 'off',
        placeholder: k.branch,
      });
      box.append(
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'cloud-branch', text: 'Branch the cloud pushed (empty = ' + k.branch + ')' }),
          branch,
        ),
        el('button', {
          type: 'button',
          class: 'button button-filled',
          text: 'Completed in cloud',
          onclick: () =>
            action(
              { type: 'cloud-done', id: k.id, branch: branch.value.trim() || undefined },
              `${k.id} is completed in the cloud and waiting for merge`,
            ),
        }),
        el('button', {
          type: 'button',
          class: 'button button-muted',
          text: 'Copy cloud package',
          onclick: () => copyCloudPackage([k.id]),
        }),
        el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Cancel cloud',
          onclick: () =>
            action({ type: 'cloud-cancel', id: k.id }, `${k.id}: the cloud session is aborted, waiting again`),
        }),
      );
      const field = cloudPackageField([k.id]);
      if (field) box.append(field);
    } else if (k.status === 'picked') {
      box.append(
        el('button', {
          type: 'button',
          class: 'button button-muted',
          text: 'Release',
          onclick: () =>
            action({ type: 'release', id: k.id }, `${k.id} is released and waiting again`),
        }),
      );
    } else if (k.status === 'done' && (k.qa_status === 'waiting' || k.qa_status === 'deviation')) {
      box.append(
        el('button', {
          type: 'button',
          class: 'button button-filled',
          text: 'QA ok',
          title: 'Mark the visual check as passed; the task leaves the QA list',
          onclick: () => action({ type: 'qa-ok', id: k.id }, `${k.id}: QA ok`),
        }),
      );
      if (k.qa_status === 'waiting') {
        const text = el('textarea', { id: 'qa-text', rows: 3 });
        box.append(
          el(
            'div',
            { class: 'field' },
            el('label', { for: 'qa-text', text: 'What is wrong, and where?' }),
            text,
          ),
          el('button', {
            type: 'button',
            class: 'button button-fare',
            text: 'QA deviation',
            onclick: () => {
              const s = text.value.trim();
              if (!s) return message('Write what is wrong, and where.', true);
              action(
                { type: 'qa-deviation', id: k.id, text: s },
                `${k.id}: QA deviation, fix task added to the queue`,
              );
            },
          }),
        );
      }
    }
    // Select and act (same dialog with preview as the selection bar).
    const mark = markButtons(k, col);
    if (mark) box.append(mark);
    if (!box.children.length)
      box.append(el('p', { class: 'none', text: 'No actions for this status.' }));
    return box;
  }

  /**
   * The buttons in the detail panel for multi-select ("Select chain", "Select feature", select this card) and the
   * most common single actions (on hold, batch queue) for a card that can be bulk edited.
   */
  function markButtons(k, col) {
    const parts = [];
    const chain = k.chain ? [k.id, ...k.chain.before, ...k.chain.after].filter(markable) : [];
    const feature = k.feature
      ? [...t.perId.values()]
          .filter(
            (x) =>
              MARKABLE_COLUMNS.has(x.col) &&
              x.k.project === k.project &&
              x.k.feature === k.feature,
          )
          .map((x) => x.k.id)
      : [];
    const can = MARKABLE_COLUMNS.has(col);
    if (can)
      parts.push(
        el('button', {
          type: 'button',
          class: 'button button-outline',
          text: t.marked.has(k.id) ? 'Remove from selection' : 'Select card',
          title: 'Add the card to the selection (or take it out). Shortcut: x on the card, Ctrl-click.',
          onclick: () => markMany([k.id], !t.marked.has(k.id)),
        }),
      );
    if (chain.length > 1)
      parts.push(
        el('button', {
          type: 'button',
          class: 'button button-outline',
          text: `Select chain (${chain.length})`,
          title:
            'Select the card, what it waits on, and what waits on it (only those waiting or proposed), ' +
            'so they can be moved or put on hold together.',
          onclick: () => markMany(chain, true),
        }),
      );
    if (feature.length > 1)
      parts.push(
        el('button', {
          type: 'button',
          class: 'button button-outline',
          text: `Select feature (${feature.length})`,
          title: `Select all in queue and batch queue in ${k.project} with feature "${k.feature}".`,
          onclick: () => markMany(feature, true),
        }),
      );
    if (can) {
      parts.push(
        k.parked
          ? el('button', {
              type: 'button',
              class: 'button button-muted',
              text: 'Take off hold',
              title: 'The task can be started and picked again. You see the change before it is saved.',
              onclick: () => openBulk('continue', [k.id]),
            })
          : el('button', {
              type: 'button',
              class: 'button button-muted',
              text: 'Put on hold',
              title:
                'The task stays in the queue, but is not started or picked until you take it off hold (or the date ' +
                'has passed). You see the change before it is saved.',
              onclick: () => openBulk('park', [k.id]),
            }),
        k.batched
          ? el('button', {
              type: 'button',
              class: 'button button-muted',
              text: 'Take out of batch queue',
              title: 'The task is started as its own track again. You see the change before it is saved.',
              onclick: () => openBulk('batch-out', [k.id]),
            })
          : el('button', {
              type: 'button',
              class: 'button button-muted',
              text: 'Add to batch queue',
              title:
                'Small tasks that do not block anything are packed together into a track of the right size instead of being ' +
                'started alone. You see the change before it is saved.',
              onclick: () => openBulk('batch-in', [k.id]),
            }),
      );
    }
    if (!parts.length) return null;
    return el('div', { class: 'mark-actions', 'aria-label': 'Select and combine' }, parts);
  }

  // ---- Simple markdown (headings, lists, code blocks, tables as code, **bold** and `code`) ----
  function inline(text) {
    const out = [];
    for (const chunk of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
      if (!chunk) continue;
      if (chunk.startsWith('`') && chunk.endsWith('`') && chunk.length > 1)
        out.push(el('code', { text: chunk.slice(1, -1) }));
      else if (chunk.startsWith('**') && chunk.endsWith('**') && chunk.length > 4)
        out.push(el('strong', { text: chunk.slice(2, -2) }));
      else out.push(chunk.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
    }
    return out;
  }
  function markdown(text) {
    const root = document.createDocumentFragment();
    const lines = String(text ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n');
    let paragraph = [];
    let listEl = null;
    const emptyParagraph = () => {
      if (paragraph.length) root.append(el('p', null, inline(paragraph.join(' '))));
      paragraph = [];
    };
    const closeList = () => {
      listEl = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*```/.test(l)) {
        emptyParagraph();
        closeList();
        const code = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
        root.append(el('pre', null, el('code', { text: code.join('\n') })));
        continue;
      }
      if (/^\s*\|/.test(l)) {
        emptyParagraph();
        closeList();
        const rows = [l];
        while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(lines[++i]);
        root.append(el('pre', null, el('code', { text: rows.join('\n') })));
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) {
        emptyParagraph();
        closeList();
        root.append(el(h[1].length <= 2 ? 'h3' : 'h4', null, inline(h[2])));
        continue;
      }
      const li = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(l);
      if (li) {
        emptyParagraph();
        const number = /^\s*\d/.test(l);
        if (!listEl || listEl.tagName !== (number ? 'OL' : 'UL')) {
          listEl = el(number ? 'ol' : 'ul');
          root.append(listEl);
        }
        listEl.append(el('li', null, inline(li[1])));
        continue;
      }
      if (!l.trim()) {
        emptyParagraph();
        closeList();
        continue;
      }
      // Continuation of a list item (indented line right after).
      if (listEl && /^\s+\S/.test(l)) {
        listEl.lastElementChild.append(' ', ...inline(l.trim()));
        continue;
      }
      closeList();
      paragraph.push(l.trim());
    }
    emptyParagraph();
    return root;
  }

  // ---- Multi-select and bulk actions ----
  // The owner selects cards (checkbox, x, Ctrl/Cmd-click, Shift-click, Ctrl/Cmd+A, "Select all matches", group, lane,
  // chain or feature) and does one thing with all of them from the selection bar at the bottom. Every action is previewed first
  // (/api/bulk with dry: queue.mjs works out what changes, without writing), and saved only when the owner presses
  // "Do it" (with the queue version from the preview, so a queue changed meanwhile is not overwritten). Afterwards
  // "Undo" is ready for 30 seconds, and "Undo last" in the gear. The board always sends the id list the owner saw.

  /** A text field where keys belong to the field (checkboxes do not count). */
  function inputField(e) {
    if (!e) return false;
    if (e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') return true;
    return e.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(e.type);
  }

  /** Can the card be bulk edited now (in queue, proposed or batch queue)? */
  function markable(id) {
    const x = t.perId.get(id);
    return !!x && MARKABLE_COLUMNS.has(x.col);
  }

  /** "On hold through 2026-10-12: waiting on vendor (set by owner)". */
  function waitText(p) {
    return (
      `On hold${p.to ? ` through ${String(p.to).slice(0, 10)}` : ' until you take it off'}` +
      (p.reason ? `: ${p.reason}` : '') +
      (p.by ? ` (set by ${p.by})` : '') +
      '. It stays in the queue, but is not started or picked.'
    );
  }

  /** The checkbox on a card (shown on hover and focus, and always when something is selected). */
  function markBox(k) {
    return el(
      'label',
      {
        class: 'mark-box',
        title:
          'Select the card for the selection bar (bulk actions). Shortcuts: x on the card, Ctrl/Cmd-click, Shift-click selects ' +
          'everything from the previous selected, Ctrl/Cmd+A selects all matches, Esc clears the selection.',
      },
      el('input', {
        type: 'checkbox',
        checked: t.marked.has(k.id),
        'aria-label': `Select ${k.id}`,
        tabindex: '-1', // roving tabindex: only the card that is the stop in the column; x selects too
        onclick: (e) => {
          // Shift-click on the box also selects everything from the previous selected.
          if (e.shiftKey && t.anchor && t.anchor !== k.id) {
            e.preventDefault();
            markArea(t.anchor, k.id);
          }
        },
        onchange: (e) => markMany([k.id], e.target.checked),
      }),
    );
  }

  /** Selects (on = true) or removes the ids from the selection, and redraws the selection. */
  function markMany(ids, on) {
    for (const id of ids) {
      if (!markable(id)) continue;
      if (on) t.marked.add(id);
      else t.marked.delete(id);
    }
    const last = ids.filter(markable).pop();
    if (on && last) t.anchor = last;
    updateMarking();
  }

  /** Shift: selects all cards between `from` and `to` on the board now (both included). */
  function markArea(from, to) {
    const sequence = [...main.querySelectorAll('.summary[data-markable]:not([hidden])')].map(
      (e) => e.dataset.id,
    );
    const i = sequence.indexOf(from);
    const j = sequence.indexOf(to);
    if (i < 0 || j < 0) return markMany([to], true);
    markMany(sequence.slice(Math.min(i, j), Math.max(i, j) + 1), true);
    t.anchor = to;
  }

  /** The cards shown after search and filter that can be bulk edited (what "Select all matches" and Ctrl+A take). */
  function visibleMarkable() {
    if (!t.data) return [];
    const out = [];
    for (const col of MARKABLE_COLUMNS)
      for (const k of t.data.columns[col] ?? []) if (visible(k, col)) out.push(k.id);
    return out;
  }

  function markAllMatch() {
    const ids = visibleMarkable();
    if (!ids.length)
      return message('No cards in queue, proposed or batch queue match the search and the filter.', true);
    markMany(ids, true);
    message(
      `${ids.length} selected. Pick an action in the bar at the bottom, or Esc to clear the selection.`,
    );
  }

  function emptyOption() {
    t.marked.clear();
    t.anchor = null;
    updateMarking();
  }

  function updateMarking() {
    if (drag || boosted) return;
    // In Flat and Project lanes the selection is set on the existing cards (no rebuild).
    if (t.data && (t.view === 'flat' || t.view === 'lanes')) {
      for (const node of main.querySelectorAll('.summary[data-markable]')) syncSummary(node);
      main.classList.toggle('has-option', t.marked.size > 0);
      updateSearchDep(); // the group boxes, "Select" in the lane header and batch queue
      drawOptionLine();
      drawMarkMatch();
      if (t.selected) drawPanel();
      return;
    }
    draw();
  }

  /** "Select all matches (N)" by the search: when search or filter is in use, and something can be selected. */
  function drawMarkMatch() {
    const button = $('mark-match');
    const search = !!t.filter.search || countFilters() > 0;
    const ids = search && t.view !== 'statistics' && t.view !== 'cloud' ? visibleMarkable() : [];
    button.hidden = !ids.length;
    if (!ids.length) return;
    const all = ids.every((id) => t.marked.has(id));
    button.textContent = all
      ? `All matches selected (${ids.length})`
      : `Select all matches (${ids.length})`;
    button.disabled = all;
    button.title =
      'Select all cards shown after the search and the filter that can be changed together (in queue, proposed and batch queue). ' +
      'Shortcut: Ctrl/Cmd+A.';
  }
  $('mark-match').addEventListener('click', markAllMatch);

  // What every action does (title, explanation in the dialog, tooltip on the button in the selection bar).
  const BULK_INFO = {
    project: {
      title: 'Move to project',
      explanation:
        'The tasks get a fixed project. The project controls the lane, the color, the pause and the priority bonus they get.',
    },
    feature: {
      title: 'Set feature',
      explanation:
        'Feature groups tasks within the project (project, feature, task). An empty field removes the feature.',
    },
    park: {
      title: 'Put on hold',
      explanation:
        'The tasks stay in the queue with status waiting, but are not started or picked until you take them off hold. ' +
        'With a date the hold ends by itself after that day.',
    },
    continue: {
      title: 'Take off hold',
      explanation: 'The tasks can be started and picked again, in the order the priority gives.',
    },
    rank: {
      title: 'Move as block',
      explanation:
        'The tasks are moved together within the focus step and keep their order among themselves. The board works out new ' +
        'priority bonuses; the points otherwise do not change.',
    },
    'batch-in': {
      title: 'Add to batch queue',
      explanation:
        'Small tasks that do not block anything are not started alone, but packed together into a track of the right size. ' +
        'D+, tasks others wait on, and tasks with unanswered owner questions cannot be there.',
    },
    'batch-out': {
      title: 'Take out of batch queue',
      explanation: 'The tasks are started as their own tracks again, in the order the priority gives.',
    },
    'batch-pack': {
      title: 'Pack into track',
      explanation:
        'The tasks are merged into one new track with the same class: the content minutes are added together, ownership and ' +
        'dependencies merged, and the mission file gets all the parts\' missions. The parts are canceled with a remark. Packing ' +
        'cannot be undone with "Undo".',
    },
    label: {
      title: 'Label',
      explanation:
        'Add or remove a label (one short word in lowercase). The label "visual" gives a QA queue when the task is ' +
        'done.',
    },
    undo: {
      title: 'Undo last change',
      explanation:
        'Rolls back the last entry in the change log. It is refused when someone has changed the same fields since.',
    },
    // The "Sort" list in "Waiting on you".
    'accept-suggestion': {
      title: 'Accept proposed project',
      explanation:
        'Every task gets the project the queue proposes from the prefix, the plan it comes from and the files it touches. ' +
        'The project decides the area and thus the focus step the task ends up in. Can be undone.',
    },
  };
  // The actions where all fields are optional: the preview comes as soon as the dialog opens.
  const AUTO_PREVIEW = new Set([
    'continue',
    'batch-in',
    'batch-out',
    'batch-pack',
    'park',
    'accept-suggestion',
  ]);

  const countText = (n) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

  /** The selection bar at the bottom: count (and how many are hidden by the filter), minutes and the actions. */
  function drawOptionLine() {
    const line = $('optionLine');
    const summary = [...t.marked].map((id) => t.perId.get(id)).filter(Boolean);
    if (!summary.length || !t.data || t.view === 'statistics') {
      line.hidden = true;
      line.replaceChildren();
      document.body.classList.remove('with-option-line');
      return;
    }
    const hidden = summary.filter((x) => !visible(x.k, x.col)).length;
    const min = summary.reduce((s, x) => s + (Number(x.k.estimate) || 0), 0);
    const allBatch = summary.every((x) => x.col === 'batch');
    const anyBatch = summary.some((x) => x.col === 'batch');
    const anyParked = summary.some((x) => x.k.parked);
    const button = (text, title, fn, cls = 'button-outline') =>
      el('button', {
        type: 'button',
        class: `button ${cls} button-small`,
        text,
        title: title,
        onclick: fn,
      });
    line.replaceChildren(
      el('p', {
        class: 'option-tall',
        text:
          `${summary.length} selected` +
          (hidden ? ` (${hidden} hidden by the filter)` : '') +
          ` · ${duration(min)}`,
        title: hidden
          ? `${hidden} of the selected are not shown with the search and the filter now, but are included in the action.`
          : 'Number selected and the sum of the estimates.',
      }),
      el(
        'div',
        { class: 'option-buttons', role: 'toolbar', 'aria-label': 'Bulk actions for the selected' },
        button(
          'Move to project',
          `${BULK_INFO.project.explanation} You see the change before it is saved.`,
          () => openBulk('project'),
        ),
        button('Feature', BULK_INFO.feature.explanation, () => openBulk('feature')),
        button('Put on hold', BULK_INFO.park.explanation, () => openBulk('park')),
        anyParked
          ? button('Take off hold', BULK_INFO.continue.explanation, () => openBulk('continue'))
          : null,
        button('Move as block', BULK_INFO.rank.explanation, () => openBulk('rank')),
        !allBatch
          ? button('Add to batch queue', BULK_INFO['batch-in'].explanation, () =>
              openBulk('batch-in'),
            )
          : null,
        anyBatch
          ? button('Take out of batch queue', BULK_INFO['batch-out'].explanation, () =>
              openBulk('batch-out'),
            )
          : null,
        allBatch && summary.length >= 2
          ? button(
              'Pack into track',
              BULK_INFO['batch-pack'].explanation,
              () => openBulk('batch-pack'),
              'button-muted',
            )
          : null,
        button('Label', BULK_INFO.label.explanation, () => openBulk('label')),
        button('Clear selection', 'Remove all from the selection (Esc). Nothing in the queue changes.', emptyOption),
      ),
    );
    line.hidden = false;
    document.body.classList.add('with-option-line');
  }

  // ---- The dialog for a bulk action: fields, preview, "Do it" ----
  const bulkBackground = $('bulk-background');
  const bulkBox = $('bulk');

  /** The action the server gets (the label dialog selects add or remove). */
  const bulkAction = (m) =>
    m.type === 'label' ? (m.val.remove ? 'label-remove' : 'label-add') : m.type;

  /** What is missing before the preview can be worked out, or null. */
  function bulkMissing(m) {
    const v = m.val;
    if (m.type === 'project' && !v.selected) return 'Select the project the tasks go to.';
    if (m.type === 'rank') {
      if (!v.space) return 'Select where the block goes.';
      if ((v.space === 'over' || v.space === 'under') && !v.ref)
        return 'Write the id of the task the block goes next to.';
    }
    if (m.type === 'label' && !v.label) return 'Write the label.';
    return null;
  }

  /** The fields for the action (null when it has none). If a field changes, the preview must be worked out again. */
  function bulkField(type) {
    const set = (field, val) => {
      if (!t.bulk) return;
      t.bulk.val[field] = val;
      t.bulk.preview = null;
      t.bulk.error = null;
      drawPreview();
    };
    const enter = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        previewBulk();
      }
    };
    const field = (id, label, control, help) =>
      el(
        'div',
        { class: 'field' },
        el('label', { for: id, text: label }),
        control,
        help ? el('p', { class: 'field-help', text: help }) : null,
      );
    const textField = (id, name, attr = {}) =>
      el('input', {
        id,
        type: 'text',
        autocomplete: 'off',
        oninput: (e) => set(name, e.target.value.trim() || null),
        onkeydown: enter,
        ...attr,
      });
    const datalist = (id, values) =>
      el(
        'datalist',
        { id },
        [...new Set(values)].sort().map((v) => el('option', { value: v })),
      );
    const allSummary = [...t.perId.values()].map((x) => x.k);

    if (type === 'project') {
      const option = el(
        'select',
        {
          id: 'bulk-project',
          onchange: (e) => {
            const v = e.target.value;
            t.bulk.val.selected = v !== '';
            set('pid', v === '' || v === '__none' ? null : v);
            if (v !== '') previewBulk();
          },
        },
        el('option', { value: '', text: 'Select project …' }),
        (t.data.projects ?? [])
          .filter((p) => p.pid !== 'without-project')
          .map((p) =>
            el('option', {
              value: p.pid,
              text: `${p.title ?? p.pid} (${p.pid})${p.pause ? ', paused' : ''}`,
            }),
          ),
        el('option', { value: '__none', text: 'No fixed project (follow the prefix)' }),
      );
      return field(
        'bulk-project',
        'Project',
        option,
        'A new project is created with cq project <pid> --title "…".',
      );
    }
    if (type === 'feature')
      return el(
        'div',
        null,
        field(
          'bulk-feature',
          'Feature',
          textField('bulk-feature', 'name', { list: 'bulk-features' }),
          'An empty field removes the feature. The suggestions are the features that exist in the queue.',
        ),
        datalist('bulk-features', allSummary.map((k) => k.feature).filter(Boolean)),
      );
    if (type === 'park')
      return el(
        'div',
        null,
        field(
          'bulk-reason',
          'Reason (optional)',
          textField('bulk-reason', 'reason', { maxlength: 200 }),
        ),
        field(
          'bulk-to',
          'Through date (optional)',
          el('input', {
            id: 'bulk-to',
            type: 'date',
            min: new Date().toISOString().slice(0, 10),
            onchange: (e) => set('to', e.target.value || null),
          }),
          'Without a date the tasks stay on hold until you take them off.',
        ),
      );
    if (type === 'rank') {
      const ref = el(
        'div',
        { class: 'field', hidden: true },
        el('label', { for: 'bulk-ref', text: 'Task the block goes next to' }),
        textField('bulk-ref', 'ref', { list: 'bulk-ids' }),
        datalist(
          'bulk-ids',
          (t.data.columns.queue ?? []).map((k) => k.id).filter((id) => !t.bulk?.ids.includes(id)),
        ),
      );
      const space = el(
        'select',
        {
          id: 'bulk-space',
          onchange: (e) => {
            const v = e.target.value;
            ref.hidden = !(v === 'over' || v === 'under');
            set('space', v || null);
            if (v === 'top' || v === 'bottom') previewBulk();
          },
        },
        el('option', { value: '', text: 'Select place …' }),
        el('option', { value: 'top', text: 'Top of the step' }),
        el('option', { value: 'bottom', text: 'Bottom of the step' }),
        el('option', { value: 'over', text: 'Right above another task' }),
        el('option', { value: 'under', text: 'Right below another task' }),
      );
      return el('div', null, field('bulk-space', 'Place', space), ref);
    }
    if (type === 'label')
      return el(
        'div',
        null,
        field(
          'bulk-label-option',
          'Action',
          el(
            'select',
            {
              id: 'bulk-label-option',
              onchange: (e) => set('remove', e.target.value === 'remove'),
            },
            el('option', { value: 'add', text: 'Add the label' }),
            el('option', { value: 'remove', text: 'Remove the label' }),
          ),
        ),
        field(
          'bulk-label',
          'Label',
          textField('bulk-label', 'label', { list: 'bulk-labels', maxlength: 31 }),
        ),
        datalist(
          'bulk-labels',
          allSummary.flatMap((k) => k.labels ?? []),
        ),
      );
    if (type === 'batch-pack')
      return el(
        'div',
        null,
        field(
          'bulk-new-id',
          'Id for the new track (optional)',
          textField('bulk-new-id', 'new_id', { maxlength: 41, placeholder: 'proposed automatically' }),
        ),
        field(
          'bulk-title-field',
          'Title (optional)',
          textField('bulk-title-field', 'title', { maxlength: 200 }),
        ),
      );
    return null;
  }

  /** Opens the dialog for a bulk action on the selected (or the given ids, e.g. a batch group). */
  function openBulk(type, ids) {
    const list = (ids ?? [...t.marked]).filter(markable);
    if (!list.length)
      return message(
        'None of the cards can be changed together (only those waiting, proposed and in batch queue).',
        true,
      );
    const info = BULK_INFO[type];
    t.bulk = {
      type,
      ids: list,
      val: {},
      preview: null,
      loading: false,
      error: null,
      remark: null,
      from: document.activeElement,
    };
    const field = bulkField(type);
    buildDialog(
      info,
      field,
      `${countText(list.length)}: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ' …' : ''}`,
    );
    if (AUTO_PREVIEW.has(type)) previewBulk();
    else drawPreview();
  }

  /** "Undo last" (the gear): shows the entry that is rolled back, and whether it is possible now. */
  function openUndo() {
    closePanel();
    t.bulk = {
      type: 'undo',
      ids: [],
      val: {},
      preview: null,
      loading: false,
      error: null,
      remark: null,
      from: document.activeElement,
    };
    buildDialog(BULK_INFO.undo, null, null);
    previewBulk();
  }

  function buildDialog(info, field, count) {
    const m = t.bulk;
    const cancel = el('button', {
      type: 'button',
      class: 'button button-outline',
      text: 'Cancel',
      title: 'Close without changing anything (Esc)',
      onclick: closeBulk,
    });
    const perform = el('button', {
      type: 'button',
      class: 'button button-filled',
      text: m.type === 'undo' ? 'Undo' : 'Do it',
      disabled: true,
      onclick: executeBulk,
    });
    const show = field
      ? el('button', {
          type: 'button',
          class: 'button button-muted',
          text: 'Show the changes',
          title:
            'Works out what changes, without saving anything (Enter in a text field does the same).',
          onclick: previewBulk,
        })
      : null;
    const preview = el('div', { class: 'bulk-preview', 'aria-live': 'polite' });
    m.el = { preview, do: perform };
    // Like the focus line: replaceChildren turns null into the text "null", so empty parts are filtered away.
    bulkBox.replaceChildren(
      ...[
        el('h2', { id: 'bulk-title', text: info.title }),
        el('p', { id: 'bulk-explanation', class: 'bulk-explanation', text: info.explanation }),
        count ? el('p', { class: 'bulk-count', text: count }) : null,
        field,
        show ? el('div', { class: 'bulk-show' }, show) : null,
        preview,
        el('div', { class: 'guard-buttons' }, cancel, perform),
      ].filter(Boolean),
    );
    bulkBackground.hidden = false;
    (bulkBox.querySelector('select, input') ?? cancel).focus();
  }

  function closeBulk() {
    const from = t.bulk?.from;
    t.bulk = null;
    bulkBackground.hidden = true;
    bulkBox.replaceChildren();
    if (from?.isConnected) from.focus();
  }
  bulkBox.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeBulk();
    } else {
      // Focus stays in the dialog (the common trap in a11y.js).
      window.QueueA11y.trapKey(e, bulkBox);
    }
  });
  bulkBackground.addEventListener('click', (e) => {
    if (e.target === bulkBackground) closeBulk();
  });

  /** The preview: what changes, the guard rules and the warnings. Writes nothing. */
  async function previewBulk() {
    const m = t.bulk;
    if (!m || m.loading) return;
    const missing = m.type === 'undo' ? null : bulkMissing(m);
    if (missing) {
      m.preview = null;
      m.error = missing;
      return drawPreview();
    }
    m.loading = true;
    m.error = null;
    m.preview = null;
    drawPreview();
    try {
      const answer =
        m.type === 'undo'
          ? await api('/api/undo', { show: true })
          : await api('/api/bulk', {
              action: bulkAction(m),
              ids: m.ids,
              val: m.val,
              dry: true,
            });
      if (t.bulk !== m) return;
      m.preview = answer;
    } catch (e) {
      if (t.bulk !== m) return;
      m.error = e.message;
    }
    m.loading = false;
    drawPreview();
  }

  /** The new track in the preview of "Pack into track". */
  function packageView(p) {
    const n = p.new;
    return el(
      'section',
      { class: 'bulk-package', 'aria-label': 'The new track' },
      el('h3', { class: 'bulk-package-title', text: `New track ${n.id}` }),
      el(
        'dl',
        { class: 'facts' },
        facts('Title', n.title || '(none)'),
        facts(
          'Class',
          `${n.class ?? '?'} · ${n.content_min} min content · value ${n.value}` +
            (n.migr_tens ? ` · ${n.migr_tens} migration tiers` : ''),
        ),
        facts('Project', `${n.project}${n.feature ? ` · ${n.feature}` : ''}`),
        facts(
          'Status',
          n.status === 'waiting' ? 'waiting (can be started)' : `${n.status} (must be approved)`,
        ),
        facts('Depends on', n.depends_on.length ? n.depends_on.join(', ') : null),
        facts('Waiting on', n.waiting_on.length ? n.waiting_on.join(', ') : null),
        facts('Owner files', n.owned_files.length ? list2(n.owned_files.slice(0, 30), true) : null),
        facts('Labels', n.labels.length ? n.labels.join(', ') : null),
        facts('Canceled', p.cancelled.join(', ')),
        facts('Redirected', p.redirected.length ? p.redirected.join(', ') : null),
        facts('Mission', n.mission),
      ),
    );
  }

  function drawPreview() {
    const m = t.bulk;
    if (!m?.el) return;
    const f = m.preview;
    const parts = [];
    if (m.remark)
      parts.push(el('p', { class: 'bulk-remark', role: 'status', text: m.remark }));
    if (m.loading) parts.push(el('p', { class: 'empty', text: 'Working out the change …' }));
    if (m.error) parts.push(el('p', { class: 'bulk-error', role: 'alert', text: m.error }));
    const list = (texts, cls) =>
      texts.length
        ? el(
            'ul',
            { class: `guard-list ${cls}` },
            texts.map((x) => el('li', { text: x })),
          )
        : null;
    let can = false;
    if (f && m.type === 'undo') {
      can = f.can === true;
      parts.push(
        f.entry
          ? el('p', {
              class: 'bulk-summary',
              text:
                `No. ${f.entry.nr}: ${f.entry.action} by ${f.entry.by}, ${age(f.entry.at)} ago. ` +
                'The fields below are set back to the value before the arrow.',
            })
          : null,
        list(f.error ?? [], 'bulk-stop'),
      );
      if (f.lines?.length) parts.push(lineList(f.lines, f.lines.length));
    } else if (f) {
      const guard = f.guard ?? [];
      const text = (level) => guard.filter((v) => v.level === level).map((v) => v.text);
      can = f.can === true;
      parts.push(
        el('p', { class: 'bulk-summary', text: f.recap }),
        list([...text('stop'), ...(f.error ?? [])], 'bulk-stop'),
        list([...text('warning'), ...(f.warnings ?? [])], 'bulk-warning'),
        list(text('info'), 'bulk-info'),
      );
      if (f.package) parts.push(packageView(f.package));
      if (f.lines?.length) parts.push(lineList(f.lines, f.field));
      else if (!f.package && can)
        parts.push(el('p', { class: 'empty', text: 'Nothing changes: all are already like that.' }));
    }
    m.el.preview.replaceChildren(...parts.filter(Boolean));
    // "Do it" only when the preview is valid and has something to do.
    const empty = f && m.type !== 'undo' && !f.package && !f.lines?.length;
    m.el.do.disabled = !can || m.loading || !!empty;
    m.el.do.title = !f
      ? 'See the changes first'
      : !can
        ? 'Cannot be done: see the reason above'
        : m.type === 'undo'
          ? 'Rolls back the change as shown above'
          : 'Saves the change as the preview shows it. "Undo" is ready afterwards.';
  }

  /** The change lines ("A-1 project: alpha → beta"), collapsed when there are many. */
  function lineList(lines, count) {
    return el(
      'details',
      { class: 'bulk-lines', open: lines.length <= 12 },
      el('summary', { text: `The changes field by field (${count})` }),
      el(
        'ul',
        null,
        lines.map((l) => el('li', null, el('code', { text: l }))),
      ),
    );
  }

  /** "Do it": writes with the queue version from the preview. If the queue changed meanwhile, it is shown again. */
  async function executeBulk() {
    const m = t.bulk;
    const f = m?.preview;
    if (!f?.can || m.loading) return;
    m.loading = true;
    drawPreview();
    if (m.type === 'undo') {
      closeBulk();
      return undoNr(f.entry?.nr ?? null);
    }
    const val =
      m.type === 'batch-pack' && !m.val.new_id && f.package
        ? { ...m.val, new_id: f.package.new.id }
        : m.val;
    let answer;
    try {
      answer = await api('/api/bulk', {
        action: bulkAction(m),
        ids: m.ids,
        val,
        dry: false,
        expect: f.changed ?? undefined,
        confirm: true,
      });
    } catch (e) {
      if (t.bulk !== m) return;
      m.loading = false;
      if (e.answer?.outdated) {
        // The queue has changed since the preview: fetch it, and show the change again before the owner confirms.
        m.remark =
          'The queue was changed while you looked at the preview. Here it is again; look it over before you confirm.';
        await update(true);
        return previewBulk();
      }
      m.error = e.message;
      return drawPreview();
    }
    const info = BULK_INFO[m.type];
    closeBulk();
    const text =
      m.type === 'batch-pack'
        ? `Packed ${countText(m.ids.length)} into ${answer.new_id}.`
        : `${info.title}: ${countText(m.ids.length)}.`;
    if (answer.log) undoToast(answer.log, text, answer.info);
    else messageWithInfo(text, answer);
    await update(true);
  }

  // ---- "Undo" (30 seconds after a bulk action) and "Undo last" (the gear) ----
  let undoTime = null;
  function undoToast(nr, text, info) {
    const box = $('undo-message');
    const lines = [text, ...(Array.isArray(info) ? info : [])].join('\n');
    box.replaceChildren(
      el('span', { class: 'undo-text', text: lines }),
      el('button', {
        type: 'button',
        class: 'button button-muted button-small',
        text: 'Undo',
        title:
          `Rolls back exactly this change (no. ${nr} in the change log). It is refused when someone has changed ` +
          'the same fields since.',
        onclick: () => undoNr(nr),
      }),
      el(
        'button',
        {
          type: 'button',
          class: 'button-icon',
          'aria-label': 'Close the message',
          title: 'Close the message ("Undo last" is also in the gear)',
          onclick: closeUndoToast,
        },
        icon('close'),
      ),
    );
    showToast('undo');
    clearTimeout(undoTime);
    undoTime = setTimeout(closeUndoToast, 30_000);
  }
  function closeUndoToast() {
    clearTimeout(undoTime);
    const box = $('undo-message');
    hideToast('undo');
    box.replaceChildren();
  }
  async function undoNr(nr) {
    closeUndoToast();
    try {
      const answer = await api('/api/undo', nr ? { nr } : {});
      message(answer.message ?? 'Undone.');
    } catch (e) {
      message(`Could not undo: ${e.message}`, true);
    }
    await update(true);
  }

  /** The part in the gear: the last change that can be undone. */
  function undoSection() {
    const a = t.data?.undo;
    return el(
      'section',
      { class: 'setting', 'aria-labelledby': 'setting-undo' },
      el('h3', { id: 'setting-undo', class: 'setting-title', text: 'Undo last' }),
      a
        ? el('p', {
            text:
              `No. ${a.nr}: ${a.action} by ${a.by}, ${age(a.at)} ago ` +
              `(${a.field} fields in ${countText(a.tasks)}).`,
          })
        : el('p', {
            class: 'empty',
            text: 'Nothing to undo: the change log is empty, or everything in it is undone.',
          }),
      a
        ? el('button', {
            type: 'button',
            class: 'button button-outline',
            text: 'Undo last …',
            title:
              'Shows what is rolled back before anything changes. It is refused when someone has changed the same fields since.',
            onclick: openUndo,
          })
        : null,
    );
  }

  // ---- Writing (always via the server, which runs queue.mjs; the guard rules first) ----
  /** A write action via the server. Returns true when it was completed (not aborted or rejected). */
  async function action(body, ok) {
    let completed = false;
    const release = busyButton(lastButton);
    lastButton = null;
    try {
      const answer = await writeWithGuard('/api/action', body);
      if (answer) {
        messageWithInfo(ok, answer);
        if (body.id) t.details.delete(body.id);
        completed = true;
      }
    } catch (e) {
      message(e.message, true);
      release(); // error: the button can be used again right away
    }
    await update(true);
    // Success: the Cloud view is drawn after its own fetch that is not awaited here. The button therefore stays busy
    // a little longer, so it does not flash back before the row is redrawn. A button that was replaced is not affected.
    if (completed) setTimeout(release, 1500);
    else release();
    if (t.selected && !t.details.has(t.selected)) getDetails(t.selected);
    return completed;
  }

  /**
   * The button that was pressed last (captured before the button's own onclick), so action() knows which button is waiting.
   * Applies to all write buttons without each one having to pass the button along.
   */
  let lastButton = null;
  document.addEventListener(
    'click',
    (e) => {
      lastButton = e.target instanceof Element ? e.target.closest('button') : null;
    },
    true,
  );

  /**
   * Makes the button inactive with "Saving …" and aria-busy, and the row it sits in muted, until release() is called.
   * Blocks double clicks and shows right away that the press is registered. Returns release (safe to call several times).
   */
  function busyButton(button) {
    if (!button || button.disabled) return () => {};
    const text = button.textContent;
    const row = button.closest('li, .row, .cloud-row');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Saving …';
    row?.classList.add('saves');
    let released = false;
    return () => {
      if (released) return;
      released = true;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = text;
      row?.classList.remove('saves');
    };
  }

  async function move(body, ok) {
    t.busy = true;
    try {
      const answer = await writeWithGuard('/api/move', body);
      if (answer) messageWithInfo(ok, answer);
      else t.pending = true; // aborted at the warning: the card goes back
    } catch (e) {
      message(`The move was not saved: ${e.message}`, true);
      t.pending = true;
    } finally {
      t.busy = false;
    }
    await update(true);
    if (t.pending) draw();
  }

  /** Saves a move (drag or keyboard): the neighbors above and below at the new place. */
  async function save(f) {
    const previous = neighborFor(f, 'previousElementSibling');
    const next = neighborFor(f, 'nextElementSibling');
    if (previous === f.previous && next === f.next) return draw(); // same space
    if (f.type === 'summary') {
      const id = f.el.dataset.id;
      return move(
        { id, over: previous?.dataset.id ?? null, under: next?.dataset.id ?? null },
        `${id} moved`,
      );
    }
    const pid = f.el.dataset.pid;
    t.busy = true;
    try {
      await api('/api/lane', {
        pid,
        over: previous?.dataset.pid ?? null,
        under: next?.dataset.pid ?? null,
      });
      message(`The project ${pid} moved`);
    } catch (e) {
      message(`The move was not saved: ${e.message}`, true);
      t.pending = true;
    } finally {
      t.busy = false;
    }
    await update(true);
    if (t.pending) draw();
  }

  /** The neighbor card or neighbor lane (only movable lanes count). */
  function neighborFor(f, direction) {
    let n = f.el[direction];
    if (f.type === 'lane') while (n && n.dataset.movable !== '1') n = n[direction];
    return n ?? null;
  }

  function startMove(e, type) {
    return {
      type,
      el: e,
      list: e.parentElement,
      previous: null,
      next: null,
      released: false,
      init() {
        this.previous = neighborFor(this, 'previousElementSibling');
        this.next = neighborFor(this, 'nextElementSibling');
        return this;
      },
    }.init();
  }

  // ---- Drag with the mouse ----
  function nearestAfter(list, selector, y, exception) {
    for (const children of list.querySelectorAll(`:scope > ${selector}`)) {
      if (children === exception) continue;
      const r = children.getBoundingClientRect();
      if (y < r.top + r.height / 2) return children;
    }
    return null;
  }

  main.addEventListener('dragstart', (e) => {
    const summary = e.target.closest?.('.summary[draggable="true"]');
    const header = e.target.closest?.('.lane-header[draggable="true"]');
    if (summary) drag = startMove(summary, 'summary');
    else if (header) drag = startMove(header.parentElement, 'lane');
    else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.el.dataset.id ?? drag.el.dataset.pid);
    drag.el.classList.add('drags');
  });

  main.addEventListener('dragover', (e) => {
    if (!drag) return;
    const list = e.target.closest?.(drag.type === 'summary' ? '.shortlist' : '.laneList');
    if (!list || list !== drag.list) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    let after = nearestAfter(list, drag.type === 'summary' ? '.summary' : '.lane', e.clientY, drag.el);
    // A lane cannot be put below "without-project" (it is always last).
    if (drag.type === 'lane' && !after)
      after = list.querySelector(':scope > .lane:not([data-movable])');
    if (after === drag.el) return;
    if (after) {
      if (after !== drag.el.nextElementSibling) list.insertBefore(drag.el, after);
    } else if (list.lastElementChild !== drag.el) list.append(drag.el);
  });

  main.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    drag.released = true;
    const f = drag;
    save(f);
  });

  main.addEventListener('dragend', () => {
    if (!drag) return;
    const f = drag;
    drag = null;
    f.el.classList.remove('drags');
    // Aborted (released outside the list): the card goes back. After a release the save redraws the board.
    if (!f.released) draw();
  });

  // ---- Click and keyboard ----
  main.addEventListener('click', (e) => {
    // The checkboxes (the cloud bundle and multi-select) and the buttons in the groups do not open the detail panel.
    if (e.target.closest?.('.cloud-select, .mark-box, .batch-buttons')) return;
    const summary = e.target.closest?.('.summary');
    if (!summary || boosted) return;
    // Ctrl/Cmd-click selects one card, Shift-click everything from the previous selected to this one.
    if (summary.dataset.markable && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey && t.anchor) markArea(t.anchor, summary.dataset.id);
      else markMany([summary.dataset.id], !t.marked.has(summary.dataset.id));
      return;
    }
    openPanel(summary.dataset.id);
  });
  // Shift-click should not select the text on the cards.
  main.addEventListener('mousedown', (e) => {
    if (e.shiftKey && e.target.closest?.('.summary[data-markable]')) e.preventDefault();
  });

  // ---- Roving tabindex ----
  // One tab stop per column (Flat) or cell (Project lanes): the title button on one card, plus the boxes on the
  // same card. The rest of the cards are reached with the arrow keys (window.QueuePerformance.rovingMeasure, tested in vitest). The board remembers
  // which card was the stop in every column (t.roving), so the stop stays where it was after a redraw.
  const AREA = '.col-body, .lane-cell';
  let suppressWhitespace = false;

  function areaKey(o) {
    const lane = o.closest('.lane');
    return lane ? `${lane.dataset.pid}|${o.dataset.col}` : (o.dataset.scroll ?? '');
  }

  /** Can the card get focus: not hidden by the search, and not in a closed group or section. */
  const canBeFocused = (li) => !li.closest('[hidden], details:not([open])');

  /** The cards in an area that can get focus (for the arrow keys). */
  function visibleSummary(o) {
    return [...o.querySelectorAll('.summary')].filter(canBeFocused);
  }

  /** Makes the controls on the card (the title button and the boxes) a tab stop (on) or not. */
  function setStop(li, on) {
    const v = on ? 0 : -1;
    for (const c of li.querySelectorAll('.summary-button, input')) if (c.tabIndex !== v) c.tabIndex = v;
  }

  /** First card in the area that can get focus (without going through all). */
  function firstVisible(o) {
    for (const li of o.querySelectorAll('.summary')) if (canBeFocused(li)) return li;
    return null;
  }

  /**
   * Gives every column (or cell) one tab stop: the card that last had it, otherwise the first visible one. The controls
   * are built with tabindex -1, so only those that are the stop now (tabindex 0) and the new stop are touched.
   */
  function rovingSetup() {
    for (const o of main.querySelectorAll(AREA)) {
      const remembered = t.roving.get(areaKey(o));
      const rememberedEl = remembered ? o.querySelector(`.summary[data-id="${CSS.escape(remembered)}"]`) : null;
      const active = rememberedEl && canBeFocused(rememberedEl) ? rememberedEl : firstVisible(o);
      for (const c of o.querySelectorAll('[tabindex="0"]')) {
        const li = c.closest('.summary');
        if (li && li !== active) setStop(li, false);
      }
      if (active) setStop(active, true);
    }
  }

  /** Makes the card the tab stop in its area (when it gets focus with Tab, click or arrow key). */
  function selectStop(li) {
    const o = li.closest(AREA);
    if (!o) return;
    t.roving.set(areaKey(o), li.dataset.id);
    for (const c of o.querySelectorAll('[tabindex="0"]')) {
      const other = c.closest('.summary');
      if (other && other !== li) setStop(other, false);
    }
    setStop(li, true);
  }

  /** The arrow keys, Home and End from the card `li`: areas are the columns (Flat) or the cells in the same lane. */
  function moveFocus(li, keyPress) {
    const here = li.closest(AREA);
    if (!here) return;
    const lane = here.closest('.lane');
    const areas = lane
      ? [...lane.querySelectorAll('.lane-cell')]
      : [...main.querySelectorAll('.col-body')];
    const summary = areas.map(visibleSummary);
    const o = areas.indexOf(here);
    const measure = window.QueuePerformance.rovingMeasure(
      summary.map((k) => k.length),
      o,
      Math.max(0, summary[o].indexOf(li)),
      keyPress,
    );
    if (!measure) return;
    const fresh = summary[measure.o][measure.i];
    selectStop(fresh);
    const button = fresh.querySelector('.summary-button');
    button?.focus();
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  main.addEventListener('focusin', (e) => {
    const li = e.target.closest?.('.summary');
    if (li && !boosted) selectStop(li);
  });
  // A Space that lifted or dropped a card should not also "click" the title button when the key is released.
  main.addEventListener('keyup', (e) => {
    if (e.key !== ' ') return;
    if (suppressWhitespace && e.target.closest?.('.summary-button')) e.preventDefault();
    suppressWhitespace = false;
  });

  function moveBoosted(direction) {
    const f = boosted;
    const selector = f.type === 'summary' ? '.summary' : '.lane[data-movable]';
    // Cards the search has hidden are skipped (they are in the list, but not shown).
    const siblings = [...f.list.querySelectorAll(`:scope > ${selector}:not([hidden])`)];
    const i = siblings.indexOf(f.el);
    const j = i + direction;
    if (j < 0 || j >= siblings.length) return;
    if (direction < 0) f.list.insertBefore(f.el, siblings[j]);
    else f.list.insertBefore(f.el, siblings[j].nextElementSibling);
    // On the card it is the title button that has focus.
    const focus =
      f.type === 'summary'
        ? (f.el.querySelector('.summary-button') ?? f.el)
        : f.el.querySelector('.lane-header');
    focus.focus();
    focus.scrollIntoView?.({ block: 'nearest' });
    $('status').textContent =
      `Place ${j + 1} of ${siblings.length}. Space drops, Esc cancels.`;
  }

  main.addEventListener('keydown', (e) => {
    if (boosted) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveBoosted(e.key === 'ArrowUp' ? -1 : 1);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (e.key === ' ') suppressWhitespace = true; // the button's click on keyup should not open the panel
        const f = boosted;
        boosted = null;
        f.el.classList.remove('boosted');
        save(f);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        boosted.el.classList.remove('boosted');
        boosted = null;
        draw();
        drawStatus();
      }
      return;
    }
    // Keys work on the title button (the card itself no longer has focus).
    const button = e.target.closest?.('.summary-button');
    const summary = button?.closest('.summary');
    const header = e.target.closest?.('.lane-header');
    if (summary && e.target === button) {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // The shortcuts with Ctrl/Cmd/Alt (Ctrl+A etc.) go on to the document.
      } else if (e.key === 'Enter') {
        e.preventDefault();
        openPanel(summary.dataset.id);
      } else if (
        (e.key === 'x' || e.key === 'X') &&
        summary.dataset.markable &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        // X selects the card in focus (Shift+x: everything from the previous selected to here).
        e.preventDefault();
        if (e.shiftKey && t.anchor) markArea(t.anchor, summary.dataset.id);
        else markMany([summary.dataset.id], !t.marked.has(summary.dataset.id));
      } else if (e.key === ' ' && summary.draggable) {
        e.preventDefault();
        suppressWhitespace = true;
        boosted = startMove(summary, 'summary');
        summary.classList.add('boosted');
        $('status').textContent =
          `${summary.dataset.id} is lifted. Arrow up and down moves, Space drops, Esc cancels.`;
      } else if (
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)
      ) {
        // Without a lift: up and down within the column, left and right to the neighbor column (or neighbor cell in the lane).
        e.preventDefault();
        moveFocus(summary, e.key);
      }
    } else if (header && e.target === header && header.draggable && e.key === ' ') {
      e.preventDefault();
      boosted = startMove(header.parentElement, 'lane');
      header.parentElement.classList.add('boosted');
      $('status').textContent =
        'The lane is lifted. Arrow up and down moves, Space drops, Esc cancels.';
    }
  });

  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+A selects all shown cards that can be bulk edited (outside text fields and dialogs).
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      (e.key === 'a' || e.key === 'A') &&
      !t.bulk &&
      !boosted &&
      !inputField(document.activeElement) &&
      !panel.contains(document.activeElement) &&
      t.data &&
      t.view !== 'statistics' &&
      t.view !== 'cloud' &&
      t.view !== 'plan' && // the plan has no cards to select
      !document.body.classList.contains('room-plans') // the Queue room is hidden
    ) {
      e.preventDefault();
      markAllMatch();
      return;
    }
    if (e.key !== 'Escape' || boosted || t.bulk) return;
    if (t.selected || t.setting || t.inbox || t.help) {
      e.preventDefault();
      closePanel();
    } else if (t.chain) {
      // The first Esc closes the panel, the next resets the chain, then the selection is cleared.
      e.preventDefault();
      resetChain();
    } else if (
      t.marked.size &&
      !filterMenu.contains(document.activeElement) &&
      !inputField(document.activeElement)
    ) {
      e.preventDefault();
      emptyOption();
    }
  });
  background.addEventListener('click', closePanel);

  // ---- The top ----
  // Three options, System, Light and Dark. "System" removes the choice from localStorage and follows
  // the operating system. The theme is chosen only in the settings (the gear), as three radio buttons; the button
  // at the top is removed to give room to the two rows.
  function themeSelected() {
    return window.QueueA11y.themeFromSaved(store.getItem('queue-board-theme'));
  }
  function setTheme(option) {
    const html = document.documentElement;
    if (option === 'light' || option === 'dark') {
      html.dataset.theme = option;
      store.setItem('queue-board-theme', option);
    } else if (option === 'system') {
      delete html.dataset.theme;
      store.removeItem('queue-board-theme');
    }
    const now = themeSelected();
    // The radio buttons in the settings follow along when the panel is open.
    for (const r of panel.querySelectorAll('input[name="theme-option"]')) r.checked = r.value === now;
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTheme());

  /** The help lives in the gear. The button switches the panel's content to "How to use the board". */
  function helpSection() {
    return el(
      'section',
      { class: 'setting', 'aria-labelledby': 'setting-help' },
      el('h3', { id: 'setting-help', class: 'setting-title', text: 'Help' }),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: 'How to use the board',
        onclick: () => {
          openHelp();
        },
      }),
    );
  }

  /** Theme in the settings: System, Light and Dark as a radio group. */
  function themeSection() {
    const now = themeSelected();
    return el(
      'fieldset',
      { class: 'setting theme-option' },
      el('legend', { class: 'setting-title', text: 'Theme' }),
      window.QueueA11y.THEME_OPTION.map(({ val, text }) =>
        el(
          'label',
          { class: 'theme-row' },
          el('input', {
            type: 'radio',
            name: 'theme-option',
            value: val,
            checked: val === now,
            onchange: () => setTheme(val),
          }),
          val === 'system' ? `${text} (follows the operating system)` : text,
        ),
      ),
    );
  }

  /**
   * How much the mascot says: Chatty, Events only or Off (stored in localStorage by mascot.js). When the server has
   * turned the mascot off (board.mascot "off" in queue.config.json, or --mascot off), the choice is locked.
   */
  function mascotSection() {
    const m = window.QueueMascotView;
    if (!m) return el('div', { hidden: true });
    const now = m.mode();
    // Hidden with the password: the speech choice has no effect until the mascot is shown again.
    const locked = m.locked() || m.isHidden();
    return el(
      'fieldset',
      { class: 'setting theme-option' },
      el('legend', { class: 'setting-title', text: 'Mascot' }),
      el('p', {
        class: 'setting-explanation',
        text: 'How often the speech bubbles show. Off keeps the picture and turns the bubbles off.',
      }),
      m.MODE_OPTIONS.map(({ val, text }) =>
        el(
          'label',
          { class: 'theme-row' },
          el('input', {
            type: 'radio',
            name: 'mascot-option',
            value: val,
            checked: val === now,
            disabled: locked,
            onchange: () => m.setMode(val),
          }),
          text,
        ),
      ),
      m.locked()
        ? el('p', {
            class: 'empty',
            text: 'Turned off for this board (board.mascot in queue.config.json or --mascot off).',
          })
        : null,
      hideMascotField(m),
    );
  }

  /**
   * The whole mascot (picture and bubbles) can be hidden in this browser with a password: an easter egg for the
   * author's self-roast. The check (case and punctuation do not matter) is isPassword in lib/queueMascot.js.
   */
  function hideMascotField(m) {
    if (!m.hideMascot) return null;
    if (m.isHidden()) {
      return el(
        'div',
        { class: 'setting-field' },
        el('p', { class: 'setting-explanation', text: 'The mascot is hidden in this browser.' }),
        el(
          'div',
          { class: 'setting-control' },
          el('button', {
            type: 'button',
            class: 'button button-muted',
            text: 'Show the mascot again',
            onclick: () => {
              m.showMascot();
              drawSettings();
            },
          }),
        ),
      );
    }
    const id = 'mascot-password';
    const input = el('input', {
      id,
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-describedby': `${id}-help`,
    });
    const error = el('p', { class: 'setting-error', role: 'alert', hidden: true });
    const tryIt = () => {
      if (m.hideMascot(input.value)) {
        drawSettings();
        return;
      }
      error.textContent = 'Not quite. The bouncer says no.';
      error.hidden = false;
      input.select();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryIt();
      }
    });
    return el(
      'div',
      { class: 'setting-field' },
      el('label', { for: id, text: 'Hide the mascot completely' }),
      el('p', {
        id: `${id}-help`,
        class: 'setting-explanation',
        text:
          "Password needed. Hint: the password to the back room of Lefty's Bar in Leisure Suit Larry in the " +
          'Land of the Lounge Lizards.',
      }),
      el(
        'div',
        { class: 'setting-control' },
        input,
        el('button', { type: 'button', class: 'button button-muted', text: 'Hide', onclick: tryIt }),
      ),
      error,
    );
  }

  function setView(v) {
    t.view = v;
    store.setItem('queue-board-view', v);
    // Real tabs. The selected tab is the only tab stop in the tab list (roving tabindex).
    for (const x of VIEWS) {
      const tab = $(`show-${x}`);
      tab.setAttribute('aria-selected', x === v ? 'true' : 'false');
      tab.tabIndex = x === v ? 0 : -1;
    }
    if (v === 'statistics') {
      closeFilter(false);
      getStatistics();
    }
    if (v === 'cloud') {
      closeFilter(false);
      getCloudQueue();
    }
    // The plan shows areas and projects, not cards: the filter and view menus are closed.
    if (v === 'plan') {
      closeFilter(false);
      closeViews(false);
    }
  }
  for (const x of VIEWS)
    $(`show-${x}`).addEventListener('click', () => {
      setView(x);
      draw();
    });
  // The arrow keys, Home and End move focus between the tabs; Enter or Space selects (manual activation, because a
  // drawing of the board can take time).
  $('tabs').addEventListener('keydown', (e) => {
    const tabs = VIEWS.map((x) => $(`show-${x}`));
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const j = window.QueueA11y.tabMeasure(tabs.length, i, e.key);
    if (j == null) return;
    e.preventDefault();
    tabs[i].tabIndex = -1;
    tabs[j].tabIndex = 0;
    tabs[j].focus();
  });
  // If focus leaves the tab list without anything being selected, the selected tab is the tab stop again.
  $('tabs').addEventListener('focusout', (e) => {
    if ($('tabs').contains(e.relatedTarget)) return;
    for (const x of VIEWS) $(`show-${x}`).tabIndex = x === t.view ? 0 : -1;
  });

  // The statistics are fetched when the view is open (the server caches; "unchanged" when nothing is new).
  let fetchingStat = false;
  async function getStatistics() {
    if (fetchingStat || !t.key) return;
    fetchingStat = true;
    try {
      const q = t.stat.version ? `?version=${encodeURIComponent(t.stat.version)}` : '';
      const answer = await api(`/api/statistics${q}`);
      t.stat.error = null;
      if (!answer.unchanged) {
        t.stat.data = answer.data;
        t.stat.version = answer.version;
        if (t.view === 'statistics') draw();
      }
    } catch (e) {
      t.stat.error = e.message;
      if (t.view === 'statistics' && !t.stat.data) draw();
    } finally {
      fetchingStat = false;
    }
  }

  // ---- The "Cloud" view: bundles with a ready command for cloud-start.mjs (claude --cloud, draws from the cloud credit) ----
  let fetchingCloud = false;
  async function getCloudQueue() {
    if (fetchingCloud || !t.key) return;
    fetchingCloud = true;
    try {
      const answer = await api('/api/cloud-bundles');
      t.cloudQueue = { data: answer.data, error: null };
    } catch (e) {
      t.cloudQueue = { data: t.cloudQueue.data, error: e.message };
    } finally {
      fetchingCloud = false;
      if (t.view === 'cloud') draw();
    }
  }

  async function copyText(text, ok) {
    try {
      await navigator.clipboard.writeText(text);
      message(ok);
    } catch {
      message('Could not copy automatically: select the command and copy it yourself.', true);
    }
  }

  /** The help text in the Cloud view. The base branch comes from queue.config.json (baseBranch). */
  const cloudHelp = () =>
    'Copy a command and run it in a terminal in the project folder. It starts a cloud session with claude --cloud, ' +
    `which draws from the cloud credit. The cloud sees only what is pushed to ${t.data?.baseBranch ?? 'main'}. ` +
    'When the session reports CLOUD-DONE, press "Completed in cloud", and the orchestrator merges.';

  function cloudRow(id, title, ...extra) {
    return el(
      'li',
      { class: 'cloud-row' },
      el('span', { class: 'cloud-id', text: id }),
      el('span', { class: 'cloud-name', text: title ?? '' }),
      ...extra,
    );
  }

  function drawCloudQueue() {
    const d = t.cloudQueue.data;
    const inCloud = [...(t.perId?.values() ?? [])].map((x) => x.k).filter((k) => k?.in_cloud);
    const chunk = (title, content) =>
      el(
        'section',
        { class: 'cloud-del' },
        el('h2', { class: 'cloud-title', text: title }),
        content,
      );

    const inProgress = inCloud.length
      ? el(
          'ul',
          { class: 'cloud-list' },
          ...inCloud.map((k) =>
            cloudRow(
              k.id,
              k.title,
              k.cloud_session?.execution ? cloudLink(k.cloud_session.execution) : null,
              el('button', {
                type: 'button',
                class: 'button button-muted',
                text: 'Completed in cloud',
                onclick: () =>
                  action({ type: 'cloud-done', id: k.id }, `${k.id} is fetched from the cloud`),
              }),
            ),
          ),
        )
      : el('p', { class: 'empty', text: 'Nothing running in the cloud now.' });

    let bundles;
    if (!d)
      bundles = el('p', {
        class: 'empty',
        text: t.cloudQueue.error ? `Could not fetch the bundles: ${t.cloudQueue.error}` : 'Fetching the bundles …',
      });
    else if (!d.bundles.length)
      bundles = el('p', {
        class: 'empty',
        text: d.pushed
          ? 'No cloud-suitable tasks now.'
          : `Could not find the base branch (${t.data?.baseBranch ?? 'main'}) on the remote. Push it, so the cloud can see the code.`,
      });
    else
      bundles = el(
        'ol',
        { class: 'cloud-bundles' },
        ...d.bundles.map((b, i) =>
          el(
            'li',
            { class: 'cloud-bundle-summary' },
            el('p', {
              class: 'cloud-bundle-header',
              text:
                `Bundle ${i + 1} · ${b.ids.length} ${b.ids.length === 1 ? 'task' : 'tasks'} · ` +
                `${b.minutes} min · ${b.areas.join(' + ')}`,
            }),
            el('ul', { class: 'cloud-list' }, ...b.ids.map((id) => cloudRow(id, b.titles?.[id]))),
            el(
              'div',
              { class: 'cloud-command' },
              el('code', { text: b.command }),
              el('button', {
                type: 'button',
                class: 'button button-filled',
                text: 'Copy command',
                onclick: () =>
                  copyText(b.command, 'The command is copied. Run it in the terminal.'),
              }),
            ),
          ),
        ),
      );

    const sessions = d ? ` · ${d.sessions} of at most ${d.max} sessions` : '';
    main.append(
      el(
        'div',
        { class: 'cloud-view' },
        el('p', { class: 'cloud-help', text: cloudHelp() }),
        chunk(`In cloud now (${inCloud.length}${sessions})`, inProgress),
        chunk(`Ready bundles (${d?.bundles.length ?? 0})`, bundles),
      ),
    );
  }

  // The gear opens the settings in the side panel.
  $('settings').append(icon('gear'));
  $('settings').addEventListener('click', openSettings);

  /**
   * The logo (optional file in the queue folder, served at /logo) sits in the fixed mascot zone in the left corner of the top.
   * Without a logo the zone is empty, but keeps its space, so the top does not jump when the file comes or goes.
   */
  // ---- The update banner (the rules and texts in lib/queueUpdate.js; the server sends `update` in the state) ----
  /** The version whose banner was closed (localStorage through `store`, so blocked storage only means not remembered). */
  const dismissedUpdate = () => store.getItem(window.QueueUpdate?.DISMISS_KEY ?? 'queue-board-update-dismissed');

  /** One step: the text, and the command with a "Copy" button (the same look as the cloud commands). */
  function updateStep(s) {
    return el(
      'li',
      { class: 'update-step' },
      s.text ? el('span', { text: s.text }) : null,
      s.command
        ? el(
            'div',
            { class: 'cloud-command' },
            el('code', { text: s.command }),
            el('button', {
              type: 'button',
              class: 'button button-outline',
              text: 'Copy',
              'aria-label': `Copy ${s.command}`,
              onclick: () => copyText(s.command, 'The command is copied.'),
            }),
          )
        : null,
    );
  }

  function drawUpdateBanner() {
    const box = $('update-banner');
    const U = window.QueueUpdate;
    const n = t.data?.update ?? null;
    if (!box || !U || !n) {
      if (box) box.hidden = true;
      return;
    }
    const show = U.visible(n, dismissedUpdate());
    const parts = [];
    if (show.newVersion) {
      const v = n.newVersion;
      parts.push(
        el(
          'p',
          { class: 'update-banner-title' },
          `cq ${v.latest} is out (you have ${n.installed}). `,
          el('a', {
            href: v.changelog,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: 'What is new (CHANGELOG)',
          }),
        ),
        el('ol', { class: 'update-steps' }, ...v.steps.map(updateStep)),
      );
    }
    // The update steps already end with setup, so the setup notice shows on its own only without them.
    if (show.setup && !(show.newVersion && n.setup === 'run')) {
      if (n.setup === 'restart')
        parts.push(
          el('p', {
            class: 'update-banner-title',
            text:
              `Setup was run for cq ${n.setupVersion}, but this board still runs cq ${n.installed}. ` +
              'Stop the board and start it again to load the new version.',
          }),
        );
      else
        parts.push(
          el('p', {
            class: 'update-banner-title',
            text: n.setupVersion
              ? `cq ${n.installed} is installed, but the project was last set up for cq ${n.setupVersion}. Run setup again in Claude Code:`
              : `cq ${n.installed} is installed, but setup has not been recorded for it. Run setup again in Claude Code:`,
          }),
          el('ol', { class: 'update-steps' }, updateStep({ text: '', command: 'cq setup --settings' })),
        );
    }
    if (!parts.length) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const content = el('div', { class: 'update-banner-content' }, ...parts);
    // Only the new-version part can be closed (per version); the setup notice goes away when setup has been run.
    const close = show.newVersion
      ? el(
          'button',
          {
            type: 'button',
            class: 'button-icon update-banner-close',
            'aria-label': `Close the notice about cq ${n.newVersion.latest}`,
            title: 'Close until a newer version is out',
            onclick: () => {
              store.setItem(U.DISMISS_KEY, n.newVersion.latest);
              drawUpdateBanner();
            },
          },
          icon('close'),
        )
      : null;
    box.replaceChildren(content, ...(close ? [close] : []));
    box.hidden = false;
  }

  function drawLogo() {
    const zone = $('mascot');
    const exists = zone.querySelector('.logo');
    if (t.data?.logo && !exists) zone.append(el('img', { class: 'logo', src: '/logo', alt: '' }));
    else if (!t.data?.logo && exists) exists.remove();
    zone.classList.toggle('empty', !t.data?.logo);
  }

  // The speech bubble by the mascot: the logic lives in mascot.js and lib/queueMascot.js. The board reports new
  // states (update) and owner actions (api) there, and has the choice Chatty / Events only / Off in the gear.

  let searchTime = null;
  $('search').addEventListener('input', () => {
    clearTimeout(searchTime);
    searchTime = setTimeout(() => {
      t.filter.search = $('search').value.trim().toLowerCase();
      // Flat and Project lanes hide the cards that do not match (hidden); no rebuild.
      if (t.data && (t.view === 'flat' || t.view === 'lanes')) {
        useSearch();
        drawMarkMatch();
        drawOptionLine();
        drawStripe();
      } else draw();
    }, 150);
  });

  // The Plans room (plans/plans.js) shows a queue task in Queue and uses the message from here.
  window.QueueBoard = {
    showTask(id) {
      if (!t.perId.has(id)) {
        message(`${id} is not on the board (canceled or unknown).`, true);
        return;
      }
      if (!['flat', 'lanes'].includes(t.view)) setView('flat');
      draw();
      openPanel(id);
      main
        .querySelector(`.summary[data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    },
    message: (text, error) => message(text, error),
  };

  // ---- Start ----
  setTheme(themeSelected());
  setView(t.view);
  drawViewButton();
  t.key = getKey();
  if (!t.key) showKeyBanner();
  drawStatus();
  draw();
  update(true);
  const getAll = () => {
    if (t.keyInvalid) return; // the polling stops until the link is pasted
    update();
    if (t.view === 'statistics') getStatistics();
    if (t.view === 'cloud') getCloudQueue();
  };
  setInterval(() => {
    if (!document.hidden) getAll();
    // The age on the cards in In progress moves on without the queue changing.
    for (const e of main.querySelectorAll('[data-start]')) e.textContent = age(e.dataset.start);
    // The status becomes "Not updated since …" when fetching stops (closed tab, server down).
    if (!boosted) drawStatus();
  }, 15_000);
  window.addEventListener('focus', getAll);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) getAll();
  });
})();
