// =============================================================
// graph.js: the "Dependencies" view on the kanban board. Vanilla JS, no build step, no dependencies.
//
// Tasks are circles (area by estimate, fill in the project color, the ring shows status) and owner questions are
// rounded squares with "?". The lines go from predecessor to successor. Which nodes are shown and where they sit
// is computed by the pure functions in scripts/lib/queueGraph.js (served as /queueGraph.js, window.QueueGraph) once per
// queue change, filter and option (cached here), never per render: wheel and drag change only one transform.
//
// board.js owns the state, the search, the filter menu, detailPanel and the chain (t.chain). It calls
//   window.QueueGraphView.draw(ctx)  when the view is drawn, and
//   window.QueueGraphView.mark(id, chain)  when the chain is selected or reset (Esc).
// All text is set with textContent; the colors are the CSS variables from theme.css (light and dark).
// =============================================================
'use strict';

(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const STORAGE = 'queue-board-graph';
  const SP_TYPE = {
    question: 'Question',
    condition: 'Waiting on condition',
    lawyer: 'Waiting on lawyer',
    'owner-task': 'Owner-task',
  };
  const STATE = {
    ready: 'ready now',
    blocked: 'blocked',
    active: 'in progress',
    qa: 'done, waiting for QA',
    done: 'done',
    batch: 'in the batch queue: not started alone, packed into a track',
  };

  // The view's options (saved in the browser). Neighbors is on by default, the rest off.
  const option = readOption();
  // The layout for the last key (version + filter + option), and how many times it has been computed (for the check).
  let cache = { key: null, setup: null, counts: null };
  let calculations = 0;
  // The viewport: offset and scale. null = fit on the next render. Reset when the filter or an option changes.
  let snippet = null;
  let snippetFor = null;
  let svg = null;
  let make = null;
  let surface = null;
  let ctx = null;

  function readOption() {
    let v = null;
    try {
      v = JSON.parse(localStorage.getItem(STORAGE) ?? 'null');
    } catch {
      v = null;
    }
    return {
      mode: v?.mode === 'project' ? 'project' : 'combined',
      freeOnes: v?.freeOnes === true,
      finished: v?.finished === true,
      neighbors: v?.neighbors !== false,
    };
  }
  function saveOption() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(option));
    } catch {
      /* private mode: the options apply only to this session */
    }
  }

  /** SVG element with attributes and children (null and false are skipped, never passed to append). */
  function s(tag, attr, ...children) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attr ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k.startsWith('--')) e.style.setProperty(k, v);
      else e.setAttribute(k, String(v));
    }
    for (const b of children.flat()) if (b != null && b !== false) e.append(b);
    return e;
  }

  const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;

  /**
   * Approximate size of the view surface before it is drawn: the packing in queueGraph picks the row width from
   * it. The main surface's width, and the height below the top of the view (about 110 px for recap and options).
   * Rounded to 100 px, so small changes do not trigger a new layout. 0 (jsdom) gives the queueGraph default (1600 × 800).
   */
  function surfaceMeasure() {
    const r = ctx.main.getBoundingClientRect?.() ?? { top: 0 };
    const b = ctx.main.clientWidth || 0;
    const h = b ? Math.max(300, (window.innerHeight || 0) - r.top - 110) : 0;
    return { width: Math.round(b / 100) * 100, height: Math.round(h / 100) * 100 };
  }

  /** The layout for the current state and filter: from the cache when nothing has changed. */
  function setup() {
    const measure = surfaceMeasure();
    const key = [
      ctx.version,
      ctx.filterKey,
      option.mode,
      option.freeOnes,
      option.finished,
      option.neighbors,
      `${measure.width}x${measure.height}`,
    ].join('|');
    if (cache.key !== key) {
      const KG = window.QueueGraph;
      const graph = KG.buildGraph(ctx.data, {
        visible: ctx.visible,
        showDone: option.finished,
        showStandalone: option.freeOnes,
        neighbors: option.neighbors,
      });
      cache = {
        key,
        setup: KG.layer(graph, { mode: option.mode, surface: measure }),
        counts: KG.graphNumber(graph),
      };
      calculations++;
    }
    // New filter or new options: show everything again. A new version of the queue (same filter) keeps the viewport.
    const what = key.slice(key.indexOf('|') + 1);
    if (snippetFor !== what) {
      snippetFor = what;
      snippet = null;
    }
    return cache;
  }

  // ---- The top of the view: recap, legend and options ----
  function recap(counts, o) {
    const el = ctx.el;
    const parts = [
      plural(counts.tasks, 'task in chains', 'tasks in chains'),
      `${plural(counts.question, 'owner question', 'owner questions')} block ${plural(counts.blockedByQuestion, 'task', 'tasks')}`,
      `longest chain ${plural(counts.longestChain, 'link', 'links')}`,
    ];
    return el(
      'p',
      { class: 'graph-tall' },
      parts.join(' · '),
      o.cycles.length
        ? el('span', {
            class: 'badge old',
            text: plural(o.cycles.length, 'cycle', 'cycles'),
            title:
              'Circular dependencies (drawn, but broken in the layout):\n' +
              o.cycles.map((k) => `${k.from} → ${k.to}`).join('\n'),
          })
        : null,
    );
  }

  function legend() {
    const el = ctx.el;
    const chunk = (cls, text) =>
      el('li', null, el('span', { class: `draw ${cls}`, 'aria-hidden': 'true' }), text);
    return el(
      'ul',
      { class: 'graph-draw', 'aria-label': 'Legend' },
      chunk('t-ready', 'ready now'),
      chunk('t-blocked', 'blocked'),
      chunk('t-active', 'in progress'),
      // The batch queue has its own badge (dotted ring and "S").
      chunk('t-batch', 'in the batch queue (packed into a track)'),
      chunk('t-sp', 'owner question'),
    );
  }

  function optionRow() {
    const el = ctx.el;
    const toggle = (key, text) =>
      el(
        'label',
        { class: 'graph-switch' },
        el('input', {
          type: 'checkbox',
          checked: option[key],
          onchange: (e) => {
            option[key] = e.target.checked;
            saveOption();
            ctx.drawOnNew();
          },
        }),
        text,
      );
    const modeButton = (m, text) =>
      el('button', {
        type: 'button',
        class: 'toggles-button',
        'aria-pressed': option.mode === m ? 'true' : 'false',
        text,
        onclick: () => {
          if (option.mode === m) return;
          option.mode = m;
          saveOption();
          ctx.drawOnNew();
        },
      });
    return el(
      'div',
      { class: 'graph-option' },
      el(
        'div',
        { class: 'toggles', role: 'group', 'aria-label': 'Setup' },
        modeButton('combined', 'Combined'),
        modeButton('project', 'Per project'),
      ),
      toggle('freeOnes', 'Show standalone'),
      toggle('finished', 'Show finished'),
      toggle('neighbors', 'Show neighbors'),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: 'Fit',
        title: 'Show the whole graph',
        onclick: () => customize(),
      }),
    );
  }

  // ---- The graph itself ----
  /** Curved path with an arrowhead from the edge of the predecessor to the edge of the successor. */
  function filePath(a, b) {
    const x1 = a.x + a.r;
    const x2 = b.x - b.r - 4;
    const middle = x1 + Math.max(30, (x2 - x1) / 2);
    const back = x2 - x1 < 30 ? x2 - Math.max(30, (x2 - x1) / 2) : middle;
    return `M${x1} ${a.y}C${middle} ${a.y} ${back} ${b.y} ${x2} ${b.y}`;
  }

  function nodeTitle(n) {
    if (n.art === 'question')
      return [
        `${n.sp} (${SP_TYPE[n.type] ?? SP_TYPE.question})`,
        n.text,
        `Unlocks ${plural(n.locks, 'task', 'tasks')}`,
      ]
        .filter(Boolean)
        .join('\n');
    return [
      `${n.id}: ${n.title}`,
      `${STATE[n.state] ?? n.status}${n.role === 'neighbor' ? ' (hidden by the filter)' : ''}`,
      n.locks ? `Unlocks ${plural(n.locks, 'task', 'tasks')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  function nodeEl(n) {
    const common = {
      'data-id': n.id,
      tabindex: 0,
      role: 'button',
      'aria-label': nodeTitle(n).replace(/\n/g, '. '),
      transform: `translate(${n.x} ${n.y})`,
    };
    if (n.art === 'question') {
      const h = n.r;
      return s(
        'g',
        { ...common, class: `node sp sp-${n.type}`, 'data-sp': n.sp },
        s('title', { text: nodeTitle(n) }),
        s('rect', { class: 'sp-box', x: -h, y: -h, width: 2 * h, height: 2 * h, rx: 6 }),
        s('text', { class: 'sp-badge', y: 5, text: '?' }),
        n.locks
          ? s('text', { class: 'graph-locks', y: h + 13, text: `unlocks ${n.locks}` })
          : null,
        s('text', { class: 'label', y: -h - 6, text: n.sp }),
      );
    }
    const classes = ['node', 'task', `t-${n.state}`, `role-${n.role}`];
    if (n.r >= 16) classes.push('large');
    return s(
      'g',
      { ...common, class: classes.join(' ') },
      s('title', { text: nodeTitle(n) }),
      s('circle', {
        class: 'fill',
        r: n.r,
        '--p': n.color && n.role !== 'neighbor' ? `var(--color-${n.color})` : null,
      }),
      n.role === 'core' || n.role === 'free' ? s('circle', { class: 'ring', r: n.r + 3 }) : null,
      n.state === 'qa'
        ? s('circle', { class: 'qa-dot', cx: n.r + 3, cy: -n.r - 1, r: 3 })
        : null,
      // The batch queue gets a small "S" badge at the top right.
      n.state === 'batch'
        ? s(
            'g',
            { class: 'batch-badge', transform: `translate(${n.r + 2} ${-n.r - 2})` },
            s('circle', { r: 6.5 }),
            s('text', { y: 3.5, text: 'S' }),
          )
        : null,
      s('text', { class: 'label', y: n.r + 13, text: n.id }),
    );
  }

  function drawSvg(o) {
    const el = ctx.el;
    const perId = new Map(o.nodes.map((n) => [n.id, n]));
    make = s('g', { class: 'graph-make' });
    for (const b of o.lanes)
      make.append(
        s(
          'g',
          { class: 'graph-lane', '--p': b.color ? `var(--color-${b.color})` : null },
          s('rect', { x: 0, y: b.y, width: o.width, height: b.height, rx: 8 }),
          s('text', { x: 12, y: b.y + 20, text: b.title }),
        ),
      );
    // Every chain (component) gets a subtle background, so the packing in rows reads as separate groups.
    for (const k of o.components ?? [])
      make.append(
        s('rect', {
          class: 'graph-compact',
          x: k.x,
          y: k.y,
          width: k.width,
          height: k.height,
          rx: 10,
        }),
      );
    if (o.free)
      make.append(
        s('text', {
          class: 'graph-free-title',
          x: 12,
          y: o.free.y + 20,
          text: `Standalone (${o.free.count})`,
        }),
      );
    const edges = s('g', { class: 'edges' });
    for (const k of o.edges) {
      const a = perId.get(k.from);
      const b = perId.get(k.to);
      edges.append(
        s('path', {
          class: `edge ${k.art}${k.muted ? ' muted' : ''}${k.cycle ? ' cycle' : ''}`,
          d: filePath(a, b),
          'data-from': k.from,
          'data-to': k.to,
          'marker-end': 'url(#graph-arrow)',
        }),
      );
    }
    const nodes = s('g', { class: 'nodes' }, o.nodes.map(nodeEl));
    make.append(edges, nodes);
    svg = s(
      'svg',
      { class: 'graph-svg', role: 'group', 'aria-label': 'Dependencies as a graph' },
      s(
        'defs',
        null,
        s(
          'marker',
          {
            id: 'graph-arrow',
            viewBox: '0 0 10 10',
            refX: 1,
            refY: 5,
            markerWidth: 7,
            markerHeight: 7,
            orient: 'auto-start-reverse',
          },
          s('path', { class: 'arrow', d: 'M0 0L10 5L0 10z' }),
        ),
      ),
      make,
    );
    surface = el('div', { class: 'graph-surface' }, svg);
    linkInterplay();
    return surface;
  }

  // ---- Zoom and pan: only the transform changes ----
  function use() {
    if (!make || !snippet) return;
    make.setAttribute('transform', `translate(${snippet.x} ${snippet.y}) scale(${snippet.s})`);
    svg.classList.toggle('zoom-medium', snippet.s >= 0.8);
    svg.classList.toggle('zoom-near', snippet.s >= 1.4);
  }
  function customize() {
    const o = cache.setup;
    if (!surface || !o) return;
    const b = surface.clientWidth || 0;
    const h = surface.clientHeight || 0;
    let sk =
      b && h && o.width && o.height ? Math.min(b / (o.width + 20), h / (o.height + 20), 1.5) : 1;
    // If the circles become unreadable with the whole picture visible: fill the width, start at the top, scroll down.
    if (b && o.width && sk < (o.readableScale ?? 0)) sk = Math.min(b / (o.width + 20), 1.5);
    snippet = {
      s: sk,
      x: b ? (b - o.width * sk) / 2 : 0,
      y: h ? Math.max(0, (h - o.height * sk) / 2) : 0,
    };
    use();
  }

  let moved = false;
  function linkInterplay() {
    surface.addEventListener(
      'wheel',
      (e) => {
        if (!snippet) return;
        e.preventDefault();
        const r = surface.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const fresh = Math.min(4, Math.max(0.05, snippet.s * Math.exp(-e.deltaY * 0.0015)));
        snippet = {
          s: fresh,
          x: mx - ((mx - snippet.x) * fresh) / snippet.s,
          y: my - ((my - snippet.y) * fresh) / snippet.s,
        };
        use();
      },
      { passive: false },
    );
    let start = null;
    surface.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !snippet) return;
      start = { x: e.clientX, y: e.clientY, ux: snippet.x, uy: snippet.y, id: e.pointerId };
      moved = false;
    });
    surface.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        moved = true;
        surface.setPointerCapture?.(e.pointerId);
        surface.classList.add('drags');
      }
      snippet = { ...snippet, x: start.ux + dx, y: start.uy + dy };
      use();
    });
    const end = () => {
      start = null;
      surface.classList.remove('drags');
    };
    surface.addEventListener('pointerup', end);
    surface.addEventListener('pointercancel', end);

    // Click (not after a drag) and Enter: a task opens the panel and selects the chain; a question opens
    // "Waiting on you", where it is answered.
    const opened = (g) => {
      if (g.dataset.sp) ctx.openInbox();
      else ctx.openPanel(g.dataset.id);
    };
    surface.addEventListener('click', (e) => {
      if (moved) {
        moved = false;
        return;
      }
      const g = e.target.closest?.('.node');
      if (g) opened(g);
    });
    surface.addEventListener('keydown', (e) => {
      const g = e.target.closest?.('.node');
      if (g && e.key === 'Enter') {
        e.preventDefault();
        opened(g);
      }
    });
  }

  /** The chain from the board (queueBoard's chain): selected, before and after are highlighted; so are blocking questions. */
  function mark(id, chain) {
    if (!svg?.isConnected) return;
    const forSet = new Set(chain?.before ?? []);
    const afterSet = new Set(chain?.after ?? []);
    const inChain = (x) => x === id || forSet.has(x) || afterSet.has(x);
    const active = !!id && !!chain;
    svg.classList.toggle('chain-active', active);
    const spWith = new Set();
    for (const p of make.querySelectorAll('.edge')) {
      const from = p.dataset.from;
      const to = p.dataset.to;
      const withId = active && inChain(to) && (inChain(from) || p.classList.contains('sp'));
      if (withId && p.classList.contains('sp')) spWith.add(from);
      p.classList.toggle('i-chain', withId);
    }
    for (const g of make.querySelectorAll('.node')) {
      const x = g.dataset.id;
      g.classList.toggle('selected', active && x === id);
      g.classList.toggle('before', active && forSet.has(x));
      g.classList.toggle('after', active && afterSet.has(x));
      g.classList.toggle('i-chain', active && spWith.has(x));
    }
  }

  /** Draws the view in `ctx.main` (board.js has emptied it). */
  function draw(c) {
    ctx = c;
    const el = c.el;
    const { setup: o, counts } = setup();
    const focus = document.activeElement?.closest?.('.graph-svg .node')?.dataset.id ?? null;
    const top = el(
      'div',
      { class: 'graph-top' },
      recap(counts, o),
      legend(),
      optionRow(),
    );
    if (!o.nodes.length) {
      svg = null;
      make = null;
      surface = null;
      c.main.append(
        top,
        // The shared emptyState from board.js (the reason and the action).
        window.QueueEmpty
          ? window.QueueEmpty('No dependencies here.')
          : el('p', { class: 'empty', text: 'No dependencies with these filters.' }),
      );
      return;
    }
    c.main.append(top, drawSvg(o));
    if (snippet) use();
    else customize();
    if (focus)
      make.querySelector(`.node[data-id="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  }

  window.QueueGraphView = {
    draw,
    mark,
    get calculations() {
      return calculations;
    },
  };
})();
