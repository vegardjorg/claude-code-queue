// =============================================================
// structure.js: tree map and dependencies in the Plans room (see docs/board.md).
// Vanilla JS, no build step, no CDN. All text is set with textContent (via el and s), never as HTML.
//
// Both views sit in the middle of the three panes (`show=treeMap` and `show=dep` in the url), with the same
// filters and the same selection as the list, and the detail panel shows the entry you select. They write nothing.
//
// The tree map answers where the volume lies and how much is built. The levels are module › project › entry: the area
// is the estimate, the color the priority (with symbol and text in the field) and the fill from below how much is built.
// The zoom is the filter: a click on a module or a project sets the filter one level down, and the breadcrumb (which
// is built from the filter) zooms out again. A click on an entry opens it in the panel.
//
// Dependencies answers what must come first. It shows only the selection (the filters and the search) or the selected
// entry with its neighbors (`dep=entry`), never the whole register. The layout is layered from left to right
// (queueGraph.layer, same as the queue's dependency view), blocked entries have a dashed ring and the critical path
// (queueGraph.criticalPath) is highlighted and also shown as text above the graph.
//
// The rules (the levels, the fields, the squarified cells, the graph, blocked and critical path) are the pure functions
// in scripts/lib/queuePlanView.js and scripts/lib/queueGraph.js (tested in jest). Here is only the view and the interplay.
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;
  const NS = 'http://www.w3.org/2000/svg';
  // The surface the dependency layout is packed for (queueGraph.layer picks the row width from it).
  const DEP_SURFACE = { width: 1100, height: 700 };

  /** SVG element with attributes and children (null and false are skipped). Text only via textContent. */
  function s(tag, attr, ...children) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attr ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, String(v));
    }
    for (const b of children.flat()) if (b != null && b !== false) e.append(b);
    return e;
  }

  const percent = (x, by) => `${Math.round((x / by) * 10000) / 100}%`;

  /** The legend: the priority with symbol and text (color is only a bonus), and what the area and the fill mean. */
  function explanation(h, extra) {
    const el = h.el;
    return el(
      'ul',
      { class: 'structure-explanation', 'aria-label': 'Explanation' },
      ...V.PRIORITIES.map((p) =>
        el(
          'li',
          { class: `structure-explanation-pri pri-${p}` },
          el('span', { class: 'structure-prove', 'aria-hidden': 'true' }),
          `${V.PRIORITY[p].symbol} ${V.PRIORITY[p].text}`,
        ),
      ),
      ...extra.map((t) => el('li', { text: t })),
    );
  }

  // ---- Tree map ----
  /**
   * The middle for `show=treeMap`. `match` is the filtered entries (same selection as the list), `selected` the entry in the panel.
   */
  function treeMap(h, d, match, selected) {
    const el = h.el;
    const t = h.state();
    const tk = V.treeMapFields(match, d, t.filter);
    const surface = V.TREE_MAP_SURFACE;
    const cells = V.treeMapCells(tk.fields, surface);
    const perId = new Map(tk.fields.map((f) => [f.id, f]));
    const levelText = { module: 'areas', project: 'projects', entry: 'entries' }[tk.level];

    let content;
    if (!d.exists)
      content = el('p', {
        class: 'empty',
        text: 'The plan register does not exist yet (scripts/.queue/plans.json).',
      });
    else if (!cells.length)
      content = el(
        'div',
        { class: 'empty empty-state' },
        el('p', { text: 'No entries match the filters and the search.' }),
      );
    else
      content = el(
        'div',
        {
          class: `treeMap level-${tk.level}`,
          role: 'group',
          'aria-label': `Tree map: ${levelText}, area by size`,
        },
        ...cells.map((r) => fieldEl(h, perId.get(r.id), r, surface, selected)),
      );

    return el(
      'section',
      { class: 'plans-middle structure-middle', 'aria-label': 'Tree map', 'data-scroll': 'treeMap' },
      h.activeFilters(d),
      el('p', {
        class: 'map-help',
        text:
          `Shows ${levelText} (${tk.fields.length}), together about ${V.trackText(tk.sum)}` +
          (tk.withoutSize ? `, ${tk.withoutSize} without size (counts as 1 track)` : '') +
          '. A click zooms in one level, the breadcrumb zooms out.',
      }),
      explanation(h, ['Area: the estimate', 'Fill from below: how much is built']),
      content,
    );
  }

  function fieldEl(h, field, r, surface, selected) {
    const el = h.el;
    const text = V.treeMapText(field);
    const small = V.treeMapSmall(r);
    const isSelected = field.level === 'entry' && selected?.id === field.entry;
    return el(
      'button',
      {
        type: 'button',
        class: `tree-map-field pri-${field.priority}${small ? ' small' : ''}${isSelected ? ' selected' : ''}${field.built > 0 ? '' : ' unbuilt'}`,
        '--x': percent(r.x, surface.width),
        '--y': percent(r.y, surface.height),
        '--b': percent(r.width, surface.width),
        '--h': percent(r.height, surface.height),
        '--fill': `${Math.round(field.built * 100)}%`,
        'aria-label': text.label,
        'aria-current': isSelected ? 'true' : null,
        title: [text.name, ...text.lines].join('\n'),
        'data-focus': `treeMap:${field.level}:${field.id}`,
        onclick: () => {
          if (field.level === 'entry') h.selectEntry(field.entry);
          else h.zoom(field.zoom);
        },
      },
      el('span', { class: 'tree-map-fill', 'aria-hidden': 'true' }),
      el(
        'span',
        { class: 'tree-map-content', 'aria-hidden': 'true' },
        el('span', { class: 'tree-map-name', text: field.level === 'entry' ? field.id : field.title }),
        small
          ? null
          : [
              field.level === 'entry'
                ? el('span', { class: 'tree-map-line tree-map-title', text: field.title })
                : null,
              ...text.lines.map((l) => el('span', { class: 'tree-map-line', text: l })),
            ],
      ),
    );
  }

  // ---- Dependencies ----
  /** The curve from the predecessor to the successor (as in the queue's dependency view). */
  function filePath(a, b) {
    const x1 = a.x + a.r;
    const x2 = b.x - b.r - 4;
    const middle = x1 + Math.max(30, (x2 - x1) / 2);
    const back = x2 - x1 < 30 ? x2 - Math.max(30, (x2 - x1) / 2) : middle;
    return `M${x1} ${a.y}C${middle} ${a.y} ${back} ${b.y} ${x2} ${b.y}`;
  }

  function nodeEl(h, n) {
    const lines = V.planNodeText(n);
    const classes = [
      'dep-node',
      `pri-${n.priority}`,
      `role-${n.role}`,
      n.blocked ? 'blocked' : null,
      n.critical ? 'critical' : null,
      n.selected ? 'selected' : null,
      n.isOpen ? null : 'done',
    ].filter(Boolean);
    const select = () => h.selectEntry(n.id);
    return s(
      'g',
      {
        class: classes.join(' '),
        transform: `translate(${n.x} ${n.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': lines.join('. '),
        'aria-current': n.selected ? 'true' : null,
        'data-focus': `dep:${n.id}`,
        onclick: select,
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select();
          }
        },
      },
      s('title', { text: lines.join('\n') }),
      s('circle', { class: 'dep-fill', r: n.r }),
      // Blocked: dashed ring outside (in addition to the text in the label).
      n.blocked ? s('circle', { class: 'dep-ring', r: n.r + 4 }) : null,
      n.role === 'neighbor'
        ? null
        : s('text', {
            class: 'dep-symbol',
            y: 4,
            text: V.PRIORITY[n.priority]?.symbol ?? '',
          }),
      s('text', { class: 'dep-label', y: n.r + 14, text: n.id }),
    );
  }

  function graphSvg(h, o) {
    const perId = new Map(o.nodes.map((n) => [n.id, n]));
    const edges = s(
      'g',
      { class: 'dep-edges' },
      // The critical path is drawn last, so it sits on top.
      [...o.edges]
        .sort((a, b) => Number(!!a.critical) - Number(!!b.critical))
        .map((k) =>
          s('path', {
            class: `dep-edge${k.critical ? ' critical' : ''}${k.muted ? ' muted' : ''}${k.cycle ? ' cycle' : ''}`,
            d: filePath(perId.get(k.from), perId.get(k.to)),
            'marker-end': k.critical ? 'url(#dep-arrow-critical)' : 'url(#dep-arrow)',
          }),
        ),
    );
    const arrow = (id, cls) =>
      s(
        'marker',
        {
          id,
          viewBox: '0 0 10 10',
          refX: 1,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: 'auto-start-reverse',
        },
        s('path', { class: cls, d: 'M0 0L10 5L0 10z' }),
      );
    const width = Math.max(200, Math.ceil(o.width));
    const height = Math.max(120, Math.ceil(o.height));
    return s(
      'svg',
      {
        class: 'dep-svg',
        role: 'group',
        'aria-label': 'Dependencies between entries, from left to right',
        width: width,
        height: height,
        viewBox: `0 0 ${width} ${height}`,
      },
      s('defs', null, arrow('dep-arrow', 'dep-arrow'), arrow('dep-arrow-critical', 'dep-arrow critical')),
      edges,
      s(
        'g',
        { class: 'dep-nodes' },
        o.nodes.map((n) => nodeEl(h, n)),
      ),
    );
  }

  /**
   * The middle for `show=dep`. The selection is `match` (the filters and the search); without filter and search the
   * selection is the whole register, and then nothing is drawn. `selected` is the entry in the panel (mode "Selected entry with neighbors").
   */
  function dep(h, d, match, selected) {
    const el = h.el;
    const t = h.state();
    const mode = t.dep === 'entry' ? 'entry' : 'selection';
    const g = V.planGraph(d.entries, {
      mode,
      selection: match.map((p) => p.id),
      selected: selected?.id ?? null,
      wholeRegister: !h.pickedOut(),
      graph: window.QueueGraph,
    });
    const toggles = el(
      'div',
      { class: 'toggles dep-mode', role: 'group', 'aria-label': 'What the graph shows' },
      ...[
        ['selection', 'Selection'],
        ['entry', 'Selected entry with neighbors'],
      ].map(([id, text]) =>
        el('button', {
          type: 'button',
          class: 'toggles-button',
          text,
          'aria-pressed': mode === id ? 'true' : 'false',
          'data-focus': `dep-mode:${id}`,
          onclick: () => {
            if (mode !== id) h.setDep(id);
          },
        }),
      ),
    );
    let content;
    if (!d.exists)
      content = el('p', {
        class: 'empty',
        text: 'The plan register does not exist yet (scripts/.queue/plans.json).',
      });
    else if (g.reason)
      content = el('div', { class: 'empty empty-state' }, el('p', { text: V.planGraphText(g) }));
    else {
      const o = window.QueueGraph.layer(g, { mode: 'combined', surface: DEP_SURFACE });
      const route = V.criticalPathText(g);
      content = el(
        'div',
        {},
        el('p', { class: 'dep-summary', text: V.planGraphText(g) }),
        route ? el('p', { class: 'dep-critical-text', text: route }) : null,
        o.cycles.length
          ? el('p', {
              class: 'map-remark',
              text: `Circular dependency: ${o.cycles.map((x) => `${x.from} → ${x.to}`).join(', ')} (dashed edge).`,
            })
          : null,
        el('div', { class: 'dep-surface', 'data-scroll': 'dep' }, graphSvg(h, o)),
      );
    }
    return el(
      'section',
      { class: 'plans-middle structure-middle', 'aria-label': 'Dependencies' },
      h.activeFilters(d),
      el(
        'div',
        { class: 'dep-header' },
        toggles,
        el('p', {
          class: 'map-help',
          text: 'What must come first is on the left. Click an entry to open it.',
        }),
      ),
      explanation(h, [
        'Dashed ring: blocked',
        'Thick stroke: critical path',
        'Small dot: outside the selection',
        'Size: the estimate',
      ]),
      content,
    );
  }

  window.QueuePlanStructure = { treeMap, dep };
})();
