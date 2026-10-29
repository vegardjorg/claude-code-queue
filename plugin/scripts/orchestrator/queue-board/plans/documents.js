// =============================================================
// documents.js: the "Documents and agreements" surface in the Plans room (see docs/plan-register.md).
// Vanilla JS, no build step, no CDN.
//
// Same three-pane pattern as the plan entries: facets with count (group, status, audience, priority and
// problems) on the left, "What must be done", the revision timeline and one table per group in the middle, and
// the detail panel on the right. The rules (the filters, the facet counts, the groups, the timeline, path and copy
// line) are the pure functions in scripts/lib/queuePlanView.js (window.QueuePlanView, tested in jest); the data comes
// from /api/plans.
//
// The surface writes nothing: the document register is changed with `queue.mjs plan doc …` (same lock, changelog and
// undo as the plan entries). The copy line on every row (`/plans doc DOC-X. Instruction:`) takes the work on in
// Claude Code. All text is set with textContent (never innerHTML). Color is never the only carrier: status, priority
// and notices have symbol and text.
//
// plans.js owns the room, the url and the drawing and calls window.QueuePlanDoc.cells(h, data), where `h` is the
// helpers from there (el, copy, useState, …).
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;

  /** Date YYYY-MM-DD as "15 Oct 2026". */
  function summaryDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return s ?? '';
    return new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  /** "in 12 days", "today", "overdue by 3 days". */
  function daysText(n) {
    if (n === 0) return 'today';
    if (n > 0) return `in ${n} ${n === 1 ? 'day' : 'days'}`;
    return `overdue by ${-n} ${n === -1 ? 'day' : 'days'}`;
  }

  function nextText(nr) {
    if (!nr) return '';
    if (nr.event) return nr.event;
    return `${summaryDate(nr.date)} (${daysText(nr.days)})`;
  }

  // ---- The main entry point ----
  /**
   * The three panes for the document surface.
   * @param {object} h helpers from plans.js
   * @param {object} d the data from /api/plans
   */
  function cells(h, d) {
    const t = h.state();
    const all = d.documents ?? [];
    const match = V.docFilter(all, t.dfilter, t.dsearch);
    const selected = t.doc ? (all.find((x) => x.id === t.doc) ?? null) : null;
    return h.el(
      'div',
      { class: 'plans-grid doc-grid' },
      filtersEl(h, all, match),
      middleEl(h, d, match, selected),
      detailEl(h, d, selected),
    );
  }

  // ---- Small building blocks ----
  function statusEl(h, status) {
    const v = V.DOC_STATUS[status] ?? { text: status ?? 'unknown', symbol: '·' };
    return h.el(
      'span',
      { class: `doc-status st-${status ?? 'unknown'}` },
      h.el('span', { class: 'doc-status-symbol', 'aria-hidden': 'true', text: v.symbol }),
      h.el('span', { text: v.text }),
    );
  }

  function selectDoc(h, id, opts = {}) {
    h.use({ surface: 'doc', doc: id }, { push: true, ...opts });
  }

  function docButton(h, id, text, focus) {
    return h.el('button', {
      type: 'button',
      class: 'link-button',
      text,
      'data-focus': focus ?? null,
      onclick: () => selectDoc(h, id, { scroll: true }),
    });
  }

  // ---- Left: search, shortcuts and facets ----
  let searchTime = null;
  const SHORTCUTS = [
    { name: 'Has problems', search: '?dvars=problem-high,problem,miss,overdue' },
    { name: 'To lawyer', search: '?dst=to-lawyer' },
    { name: 'Missing', search: '?dst=missing' },
    { name: 'Before prod', search: '?dpri=now' },
  ];

  function filtersEl(h, all, match) {
    const t = h.state();
    const facets = V.docFacetNumber(all, t.dfilter, t.dsearch);
    const nowSearch = JSON.stringify(t.dfilter);
    return h.el(
      'aside',
      {
        id: 'plans-filters',
        class: 'plans-filters',
        'aria-label': 'Filters for documents',
        'data-scroll': 'dfilter',
      },
      h.el(
        'label',
        { class: 'plans-search-label' },
        h.el('span', { class: 'hidden-for-eye', text: 'Search in documents' }),
        h.el('input', {
          type: 'search',
          class: 'search plans-search',
          placeholder: 'Search in id, title, source, problems',
          autocomplete: 'off',
          value: t.dsearch,
          'data-focus': 'dsearch',
          oninput: (e) => {
            clearTimeout(searchTime);
            const v = e.target.value.slice(0, 120);
            searchTime = setTimeout(() => h.use({ dsearch: v.trim() }, { push: false }), 200);
          },
        }),
      ),
      h.el(
        'section',
        { class: 'plans-views', 'aria-label': 'Shortcuts' },
        h.el('h2', { class: 'plans-cell-title', text: 'Shortcuts' }),
        h.el(
          'ul',
          { class: 'plans-view-list' },
          ...SHORTCUTS.map((v) => {
            const f = V.readUrl(v.search).dfilter;
            return h.el(
              'li',
              { class: 'plans-view' },
              h.el('button', {
                type: 'button',
                class: 'link-button',
                text: v.name,
                'aria-pressed': JSON.stringify(f) === nowSearch ? 'true' : 'false',
                'data-focus': `dview:${v.name}`,
                onclick: () => h.newDocFilter(f, { dsearch: '', doc: null }),
              }),
            );
          }),
        ),
      ),
      ...facets
        .filter((f) => f.option.length)
        .map((f) => {
          const key = `d-${f.id}`;
          const open =
            h.facetIsOpen(key, ['d-group', 'd-status']) || f.option.some((v) => v.selected);
          return h.el(
            'details',
            {
              class: 'plans-facet',
              open: open,
              ontoggle: (e) => h.setFacetOpen(key, e.target.open),
            },
            h.el(
              'summary',
              { class: 'plans-facet-title', 'data-focus': `dfacet:${f.id}` },
              `${f.title} (${f.option.length})`,
            ),
            h.el(
              'ul',
              { class: 'plans-facet-list' },
              ...f.option.map((v) =>
                h.el(
                  'li',
                  {},
                  h.el(
                    'label',
                    { class: 'plans-facet-option' },
                    h.el('input', {
                      type: 'checkbox',
                      checked: v.selected,
                      'data-focus': `df:${f.id}:${v.val}`,
                      onchange: (e) => {
                        const fresh = { ...h.state().dfilter };
                        const list = new Set(fresh[f.id]);
                        if (e.target.checked) list.add(v.val);
                        else list.delete(v.val);
                        fresh[f.id] = [...list];
                        h.newDocFilter(fresh);
                      },
                    }),
                    v.symbol
                      ? h.el('span', {
                          class: `doc-facet-symbol ${f.id === 'status' ? `st-${v.val}` : `pri-${v.val}`}`,
                          'aria-hidden': 'true',
                          text: v.symbol,
                        })
                      : null,
                    h.el('span', { class: 'plans-facet-text', text: v.text }),
                    h.el('span', {
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
      h.el('p', {
        class: 'plans-match',
        role: 'status',
        text: `${match.length} of ${all.length} documents`,
      }),
    );
  }

  // ---- Middle: chips, "What must be done", the timeline and the tables ----
  function middleEl(h, d, match, selected) {
    const t = h.state();
    const chips = V.docChips(t.dfilter);
    const actively = chips.length > 0 || !!t.dsearch;
    const header = h.el(
      'div',
      { class: 'plans-chips', 'aria-label': 'Active filters' },
      ...chips.map((b) =>
        h.el(
          'span',
          { class: 'badge plans-chip' },
          b.text,
          h.el('button', {
            type: 'button',
            class: 'plans-chip-remove',
            text: '✕',
            'aria-label': `Remove the filter ${b.text}`,
            'data-focus': `dchip:${b.facet}:${b.val}`,
            onclick: () =>
              h.newDocFilter({
                ...t.dfilter,
                [b.facet]: t.dfilter[b.facet].filter((x) => x !== b.val),
              }),
          }),
        ),
      ),
      t.dsearch ? h.el('span', { class: 'badge plans-chip', text: `Search: ${t.dsearch}` }) : null,
      actively
        ? h.el('button', {
            type: 'button',
            class: 'button-small button-outline',
            text: 'Reset',
            'data-focus': 'dreset',
            onclick: () => h.newDocFilter(V.emptyDocFilter(), { dsearch: '' }),
          })
        : null,
    );

    const all = d.documents ?? [];
    let content;
    if (!all.length)
      content = h.el(
        'div',
        { class: 'empty empty-state' },
        h.el('p', { text: 'The document register is empty.' }),
        h.el('p', {
          class: 'plans-help',
          text:
            'Add documents with cq plan doc new --file <json> (the fields are listed in docs/plan-register.md).',
        }),
      );
    else if (!match.length)
      content = h.el(
        'div',
        { class: 'empty empty-state' },
        h.el('p', { text: 'No documents match the filters and the search.' }),
        h.el('button', {
          type: 'button',
          class: 'link-button',
          text: 'Reset the filters',
          onclick: () => h.newDocFilter(V.emptyDocFilter(), { dsearch: '' }),
        }),
      );
    else
      content = h.el('div', {}, ...V.docGroups(match).map((g) => groupEl(h, g, selected, actively)));

    return h.el(
      'section',
      { class: 'plans-middle doc-middle', 'aria-label': 'Documents', 'data-scroll': 'dlist' },
      header,
      all.length ? mustBeDoneEl(h, d.doc_must_be_done ?? []) : null,
      all.length ? timelineEl(h, d.doc_timeline ?? []) : null,
      content,
    );
  }

  /** "What must be done" at the top: missing, overdue revisions, high severity, version skew and for-prod. */
  function mustBeDoneEl(h, list) {
    if (!list.length)
      return h.el('p', { class: 'doc-alt-ok', text: '✓ No documents need anything done right now.' });
    const open = h.facetIsOpen('d-must', ['d-must']);
    return h.el(
      'details',
      {
        class: 'doc-must',
        open: open,
        ontoggle: (e) => h.setFacetOpen('d-must', e.target.open),
      },
      h.el(
        'summary',
        { class: 'doc-section-title', 'data-focus': 'dmust' },
        h.el('span', { 'aria-hidden': 'true', text: '! ' }),
        `What must be done (${list.length})`,
      ),
      h.el(
        'ul',
        { class: 'doc-must-list' },
        ...list.map((m) =>
          h.el(
            'li',
            {},
            docButton(h, m.id, `${m.id} ${m.title}`, `dmust:${m.id}`),
            h.el('span', {
              class: 'doc-must-reasons',
              text: m.reasons.map((g) => g.text).join(' · '),
            }),
          ),
        ),
      ),
    );
  }

  /** The timeline for revisions and deadlines, one column per month with Overdue first. */
  function timelineEl(h, elements) {
    const columns = V.timelineMonths(elements);
    if (!columns.length) return null;
    const open = h.facetIsOpen('d-time', ['d-time']);
    return h.el(
      'details',
      { class: 'doc-time', open: open, ontoggle: (e) => h.setFacetOpen('d-time', e.target.open) },
      h.el(
        'summary',
        { class: 'doc-section-title', 'data-focus': 'dtime' },
        `Revisions and deadlines in the next 12 months (${elements.length})`,
      ),
      h.el(
        'ol',
        { class: 'doc-time-band', 'aria-label': 'Timeline per month' },
        ...columns.map((k) =>
          h.el(
            'li',
            { class: `doc-time-month${k.overdue ? ' overdue' : ''}` },
            h.el('h3', { class: 'doc-time-month-title', text: k.title }),
            h.el(
              'ul',
              {},
              ...k.elements.map((e) =>
                h.el(
                  'li',
                  { class: `doc-time-point t-${e.type}` },
                  h.el('span', {
                    class: 'doc-time-type',
                    text: `${e.type === 'deadline' ? '◷ Deadline' : '⟳ Revision'} ${summaryDate(e.date)}`,
                  }),
                  docButton(h, e.id, e.id, `dtime:${e.type}:${e.id}`),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /** One group: a foldable heading and the table. */
  function groupEl(h, g, selected, actively) {
    const key = `dg:${g.id}`;
    // The groups are open by default; what you close is remembered. With a filter or search everything with matches is open.
    const open = actively || !h.isClosed(key) || (selected && selected.group === g.id);
    const id = `doc-g-${g.id}`;
    const summary = Object.entries(g.status)
      .map(([st, n]) => `${n} ${(V.DOC_STATUS[st]?.text ?? st).toLowerCase()}`)
      .join(', ');
    return h.el(
      'section',
      { class: 'doc-group', 'aria-labelledby': `${id}-t` },
      h.el(
        'div',
        { class: 'plans-row plans-row-module' },
        h.el(
          'button',
          {
            type: 'button',
            class: 'plans-fold',
            id: `${id}-t`,
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': id,
            'data-focus': `dg:${g.id}`,
            onclick: () => h.toggleClosed(key),
          },
          h.el('span', {
            class: 'plans-fold-arrow',
            'aria-hidden': 'true',
            text: open ? '▾' : '▸',
          }),
          h.el('span', { class: 'plans-group-title', text: g.title }),
          h.el('span', {
            class: 'plans-count',
            text: String(g.count),
            'aria-label': `${g.count} documents`,
          }),
        ),
        h.el('span', { class: 'doc-group-summary', text: summary }),
        g.must ? h.el('span', { class: 'doc-warning v-must', text: `! ${g.must} must be done` }) : null,
      ),
      open ? tableEl(h, g, selected, id) : null,
    );
  }

  function tableEl(h, g, selected, id) {
    const col = [
      'Status',
      'Document',
      'Audience',
      'Version',
      'Published',
      'Next revision',
      'Problems',
      'Priority',
    ];
    return h.el(
      'div',
      { class: 'doc-table-frame', id },
      h.el(
        'table',
        { class: 'doc-table' },
        h.el('caption', { class: 'hidden-for-eye', text: `${g.title}: ${g.count} documents` }),
        h.el(
          'thead',
          {},
          h.el(
            'tr',
            {},
            ...col.map((k) => h.el('th', { scope: 'col', text: k })),
            h.el(
              'th',
              { scope: 'col' },
              h.el('span', { class: 'hidden-for-eye', text: 'Copy' }),
            ),
          ),
        ),
        h.el('tbody', {}, ...g.documents.map((x) => rowEl(h, x, selected))),
      ),
    );
  }

  function rowEl(h, x, selected) {
    const isSelected = selected?.id === x.id;
    const high = x.problems.filter((p) => p?.severity === 'high').length;
    const pub = x.published.map(
      (p) => `${V.DOC_PUBLISHED[p.where] ?? p.where}${p.version ? ` ${p.version}` : ''}`,
    );
    const nr = x.next_revision;
    return h.el(
      'tr',
      { class: `doc-row${isSelected ? ' selected' : ''}`, 'data-doc': x.id },
      h.el('td', {}, statusEl(h, x.status)),
      h.el(
        'th',
        { scope: 'row', class: 'doc-name' },
        h.el(
          'button',
          {
            type: 'button',
            class: 'doc-select',
            'aria-current': isSelected ? 'true' : null,
            'data-focus': `doc:${x.id}`,
            onclick: () => selectDoc(h, x.id),
          },
          h.el('span', { class: 'plans-entry-id', text: x.id }),
          h.el('span', { class: 'doc-title', text: x.title }),
        ),
      ),
      h.el('td', { text: V.DOC_AUDIENCE[x.audience] ?? x.audience ?? '' }),
      h.el(
        'td',
        {},
        h.el('span', { text: x.version ?? '–' }),
        x.current_version && x.current_version !== x.version
          ? h.el('span', { class: 'doc-small', text: ` (applies ${x.current_version})` })
          : null,
        x.miss.length
          ? h.el(
              'span',
              { class: 'doc-warning v-miss', title: x.miss.map((g) => g.text).join('\n') },
              h.el('span', { 'aria-hidden': 'true', text: '⚠' }),
              h.el('span', { class: 'doc-warning-text', text: ' Version skew' }),
            )
          : null,
      ),
      h.el('td', { text: pub.length ? pub.join(', ') : '–' }),
      h.el(
        'td',
        { class: nr?.overdue ? 'doc-overdue' : nr?.soon ? 'doc-soon' : null },
        nr?.overdue ? h.el('span', { 'aria-hidden': 'true', text: '⟳ ' }) : null,
        nr ? nextText(nr) : '–',
      ),
      h.el(
        'td',
        {},
        x.problems.length
          ? h.el('span', {
              class: `doc-warning${high ? ' v-high' : ''}`,
              text: `! ${x.problems.length}${high ? ` (${high} high)` : ''}`,
              title: x.problems
                .map((p) => `${V.DOC_SEVERITY[p.severity] ?? p.severity}: ${p.text}`)
                .join('\n'),
            })
          : '–',
      ),
      h.el('td', {}, x.priority ? h.priEl(x) : '–'),
      h.el('td', {}, h.copyButton(V.docLine(x), `Copy the start line for ${x.id}`)),
    );
  }

  // ---- Right: the detail panel ----
  function detailEl(h, d, x) {
    const t = h.state();
    if (!x)
      return h.el(
        'aside',
        { class: 'plans-detail empty-detail', 'aria-label': 'Detail panel' },
        h.el('p', {
          class: 'empty',
          text: t.doc
            ? `Did not find ${t.doc} in the document register.`
            : 'Select a document in the table to see the details.',
        }),
      );
    const section = (title, ...content) =>
      h.el(
        'section',
        { class: 'doc-section' },
        h.el('h3', { class: 'plans-cell-title', text: title }),
        ...content,
      );
    const v = V.DOC_STATUS[x.status];
    return h.el(
      'aside',
      { class: 'plans-detail', 'aria-label': `Details for ${x.id}`, 'data-scroll': 'ddetail' },
      h.el('button', {
        type: 'button',
        class: 'button-small button-outline plans-back',
        text: 'Back to the table',
        onclick: () => h.use({ doc: null }),
      }),
      h.el(
        'header',
        { class: 'plans-detail-header' },
        h.el('p', { class: 'plans-detail-id', text: x.id }),
        h.el('h2', { class: 'plans-detail-title', text: x.title }),
        h.el(
          'p',
          { class: 'plans-detail-badges' },
          statusEl(h, x.status),
          h.el('span', { class: 'badge', text: V.DOC_GROUP[x.group] ?? x.group ?? '' }),
          h.el('span', {
            class: 'badge',
            text: `For ${(V.DOC_AUDIENCE[x.audience] ?? x.audience ?? '').toLowerCase()}`,
          }),
          x.priority ? h.priEl(x) : null,
        ),
        h.el(
          'div',
          { class: 'plans-actions' },
          h.el('button', {
            type: 'button',
            class: 'button button-filled',
            text: 'Copy start line',
            title: V.docLine(x),
            'data-focus': 'dcopy',
            onclick: () => h.copy(V.docLine(x)),
          }),
        ),
        x.reasons.length
          ? h.el(
              'div',
              { class: 'plans-control' },
              h.el('p', { class: 'plans-control-title', text: 'Must be done' }),
              h.el('ul', {}, ...x.reasons.map((g) => h.el('li', { text: g.text }))),
            )
          : null,
      ),
      h.el(
        'dl',
        { class: 'plans-field' },
        h.field('Status', v ? `${v.symbol} ${v.text}` : x.status),
        h.field('Working version', x.version),
        h.field('Current (accepted)', x.current_version),
        h.field(
          'Source',
          x.source ? h.el('code', { text: x.source }) : null,
          x.source
            ? h.copyButton(x.source, `Copy path ${x.source}`, 'button-small button-outline')
            : null,
        ),
        h.field('Revised', x.revision_every),
        h.field('Last revised', x.last_revised ? summaryDate(x.last_revised) : null),
        h.field('Next revision', nextText(x.next_revision)),
        h.field('Deadline', x.deadline ? summaryDate(x.deadline) : null),
        h.field(
          'Priority',
          x.priority
            ? `${V.PRIORITY[x.priority]?.text ?? x.priority}${
                x.now_category.length
                  ? ` (${x.now_category.map((k) => V.CATEGORY[k] ?? k).join(', ')})`
                  : ''
              }, set by ${x.priority_set_by === 'owner' ? 'the owner' : 'agent'}`
            : null,
        ),
        h.field('Reason', x.priority_reason),
        h.field('Dropped', x.drop_reason),
        h.field('Remark', x.remark),
      ),
      x.miss.length
        ? section(
            'Version skew',
            h.list(
              x.miss.map((g) =>
                h.el(
                  'li',
                  { class: 'doc-miss' },
                  h.el('span', { 'aria-hidden': 'true', text: '⚠ ' }),
                  g.text,
                ),
              ),
              '',
            ),
          )
        : null,
      section(
        'Published',
        h.list(
          x.published.map((p) =>
            h.el(
              'li',
              {},
              h.el('span', { class: 'badge', text: V.DOC_PUBLISHED[p.where] ?? p.where }),
              ` ${p.version ? `version ${p.version}` : 'without version'} `,
              p.url
                ? h.el('a', {
                    href: p.url,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: p.url,
                  })
                : p.path
                  ? h.el('code', { text: p.path })
                  : null,
            ),
          ),
          'Not published anywhere.',
        ),
      ),
      section(
        'Problems',
        h.list(
          x.problems.map((p) =>
            h.el(
              'li',
              { class: `doc-problem a-${p.severity}` },
              h.el('span', { class: 'badge', text: V.DOC_SEVERITY[p.severity] ?? p.severity }),
              ` ${p.text}`,
              p.source ? h.el('span', { class: 'doc-small', text: ` (${p.source})` }) : null,
            ),
          ),
          'No known problems.',
        ),
      ),
      section('Revisions', revisionsEl(h, x)),
      section(
        'Depended on by',
        h.list(
          x.depends_on_docs.map((a) =>
            h.el(
              'li',
              {},
              docButton(h, a.id, `${a.id}${a.title ? ` ${a.title}` : ' (unknown)'}`),
              a.status
                ? h.el('span', {
                    class: 'doc-small',
                    text: ` ${V.DOC_STATUS[a.status]?.text ?? a.status}`,
                  })
                : null,
            ),
          ),
          'None.',
        ),
      ),
      x.used_by.length
        ? section(
            'Used by',
            h.list(
              x.used_by.map((id) => h.el('li', {}, docButton(h, id, id))),
              '',
            ),
          )
        : null,
      section(
        'Plan entries',
        h.list(
          x.planEntries.map((p) =>
            h.el(
              'li',
              {},
              h.el('button', {
                type: 'button',
                class: 'link-button',
                text: p.title ? `${p.id} ${p.title}` : `${p.id} (does not exist)`,
                onclick: () => h.goToEntry(p.id),
              }),
            ),
          ),
          'No linked plan entries.',
        ),
      ),
      x.legal_points.length
        ? section(
            'Legal points',
            h.list(
              x.legal_points.map((j) => h.el('li', { text: j })),
              '',
            ),
          )
        : null,
      x.ownerQuestions.length
        ? section(
            'Owner question',
            h.list(
              x.ownerQuestions.map((s) =>
                h.el(
                  'li',
                  {},
                  h.el('span', { class: 'badge', text: s.resolved ? '✓ Resolved' : '? Open' }),
                  ` ${s.id}${s.text ? `: ${s.text}` : ''}`,
                ),
              ),
              '',
            ),
          )
        : null,
      section(
        'History',
        h.list(
          x.history.map((e) =>
            h.el('li', {
              text: `nr. ${e.nr} ${h.date(e.at)} ${e.by ?? ''}: ${e.action ?? ''} (${e.field.join(', ')})`,
            }),
          ),
          'No changes in the log.',
        ),
      ),
    );
  }

  /** The revisions for one document as a vertical timeline: the registered ones, then the next. */
  function revisionsEl(h, x) {
    const points = x.revisions.map((r) =>
      h.el(
        'li',
        { class: 'doc-rev' },
        h.el('span', { class: 'doc-rev-date', text: summaryDate(r.date) }),
        h.el('span', {
          text: `${r.version ? `version ${r.version}` : 'revised'}${r.remark ? `: ${r.remark}` : ''}`,
        }),
      ),
    );
    const nr = x.next_revision;
    if (nr)
      points.push(
        h.el(
          'li',
          { class: `doc-rev next${nr.overdue ? ' overdue' : ''}` },
          h.el('span', {
            class: 'doc-rev-date',
            text: nr.date ? summaryDate(nr.date) : 'On event',
          }),
          h.el('span', {
            text: nr.event
              ? `Next: ${nr.event}`
              : `Next revision, ${daysText(nr.days)}`,
          }),
        ),
      );
    return points.length
      ? h.el('ol', { class: 'doc-rev-line' }, ...points)
      : h.el('p', {
          class: 'empty',
          text: 'No revisions registered and no plan (revision_every).',
        });
  }

  window.QueuePlanDoc = { cells };
})();
