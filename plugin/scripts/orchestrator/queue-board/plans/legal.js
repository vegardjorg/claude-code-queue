// =============================================================
// legal.js: the Legal, Decisions and Launch surfaces in the Plans room (see docs/plan-register.md).
// Vanilla JS, no build step, no CDN.
//
// Legal and Decisions have the same three-pane pattern as the plan entries and documents: facets with count
// on the left, a foldable list in groups in the middle and the detail panel on the right. Launch is one overview
// ("what stands between us and the first paying customer?"), with the deadline band above (drawn by map.js).
//
// Everything is views over data that already exists: the legal field on the plan entries and the owner questions in
// queue.json. The surfaces write only two things:
//   - an answer to an owner question: POST /api/action { type: 'resolve' } (= `queue.mjs resolve <id> --answer … --by owner`,
//     same route and guard rules as "Waiting on you"; the plan entry is unblocked by itself),
//   - the lawyer package: POST /api/lawyerPackage saves a draft in <dataFolder>/lawyerPackages/lawyerPackage-<date>.md
//     locally. It is never sent anywhere.
// Legal points are changed with `queue.mjs plan edit <entry> --set '{"legal":…}'` (the copy line takes it on in
// Claude Code). The rules (the filters, the facet counts, the groups, path and the copy lines) are the pure functions
// in scripts/lib/queuePlanView.js; the data is computed by queuePlan.js on the server. All text is set with
// textContent. Color is never the only carrier: status and blocking have symbol and text.
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;

  // State that does not belong in the url: the lawyer package preview, the answer drafts (so an
  // update from the server does not wipe what you type) and an answer waiting for "Answer anyway".
  const u = { package: null, packageFetching: false, draft: new Map(), confirm: null, sender: false };
  const KEY = 'queue-board-key'; // same as board.js (sessionStorage)

  /** Write call with the key. Gives { status, answer } (the answer is JSON from the server, or an error text). */
  async function postJson(filePath, body) {
    const res = await fetch(filePath, {
      method: 'POST',
      headers: {
        'X-Queue-Key': sessionStorage.getItem(KEY) ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
    return { status: res.status, answer: answer ?? { ok: false, message: `HTTP ${res.status}` } };
  }

  function summaryDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(s)) return s ?? '';
    return new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  function deadlineText(deadline, days) {
    if (!deadline) return null;
    if (days == null) return `Deadline ${summaryDate(deadline)}`;
    if (days < 0) return `Deadline ${summaryDate(deadline)} (overdue by ${-days} days)`;
    if (days === 0) return `Deadline ${summaryDate(deadline)} (today)`;
    return `Deadline ${summaryDate(deadline)} (in ${days} ${days === 1 ? 'day' : 'days'})`;
  }

  function moduleName(d, oid) {
    if (!oid) return 'Without area';
    return (d.modules ?? []).find((m) => m.oid === oid)?.title ?? oid;
  }

  const filterKey = (surface) => (surface === 'jur' ? 'jfilter' : 'bfilter');
  const searchKey = (surface) => (surface === 'jur' ? 'jsearch' : 'bsearch');
  const optionKey = (surface) => (surface === 'jur' ? 'jur' : 'sp');

  function selectedFor(h, d) {
    const t = h.state();
    if (t.surface === 'jur') return t.jur ? (d.jur_points ?? []).find((x) => x.id === t.jur) : null;
    if (t.surface === 'decision')
      return t.sp ? V.jbList('decision', d).find((x) => x.id === t.sp) : null;
    return null;
  }

  /** Is a point or question selected (narrow screen: the panel covers the list)? */
  function hasSelected(h, d) {
    return !!selectedFor(h, d);
  }

  /** Entries in the launch overview (the selection for the deadline band above it). */
  function launchIds(d) {
    return (d.launch?.entries ?? []).map((p) => p.id);
  }

  function cells(h, d) {
    const t = h.state();
    if (t.surface === 'launch') return launchEl(h, d);
    const surface = t.surface;
    const all = V.jbList(surface, d);
    const filter = t[filterKey(surface)];
    const match = V.jbFilter(surface, all, filter, t[searchKey(surface)]);
    const selected = selectedFor(h, d);
    return h.el(
      'div',
      { class: `plans-grid jb-grid jb-${surface}` },
      filtersEl(h, d, surface, all, match),
      middleEl(h, d, surface, all, match, selected),
      surface === 'jur' ? legalDetailEl(h, d, selected) : decDetailEl(h, d, selected),
    );
  }

  // ---- Small building blocks ----
  function symbolBadge(h, cls, v, fallback) {
    const x = v ?? { text: fallback ?? 'unknown', symbol: '·' };
    return h.el(
      'span',
      { class: `badge jb-badge ${cls}` },
      h.el('span', { 'aria-hidden': 'true', text: `${x.symbol} ` }),
      h.el('span', { text: x.text }),
    );
  }
  const statusEl = (h, st) => symbolBadge(h, `jst-${st}`, V.LEGAL_STATUS[st], st);
  const blockEl = (h, b) =>
    symbolBadge(
      h,
      `jbl-${b}`,
      V.LEGAL_BLOCK[b] && {
        ...V.LEGAL_BLOCK[b],
        text: `Blocks ${V.LEGAL_BLOCK[b].text.toLowerCase()}`,
      },
      b,
    );

  function section(h, title, ...content) {
    return h.el(
      'section',
      { class: 'doc-section' },
      h.el('h3', { class: 'plans-cell-title', text: title }),
      ...content,
    );
  }

  function entryButton(h, id, title, focus) {
    return h.el('button', {
      type: 'button',
      class: 'link-button',
      text: title ? `${id} ${title}` : id,
      'data-focus': focus ?? null,
      onclick: () => h.goToEntry(id),
    });
  }

  function select(h, surface, id) {
    h.use({ surface, [optionKey(surface)]: id }, { push: true, scroll: true });
  }

  // ---- Left: search, shortcuts and facets ----
  const SHORTCUTS = {
    jur: [
      { name: 'Prod gate', search: '?jbl=prod' },
      { name: 'Open (AI first)', search: '?jst=open' },
      { name: 'To lawyer', search: '?jst=to-lawyer' },
      { name: 'Resolved', search: '?jst=resolved,not-relevant' },
    ],
    decision: [
      { name: 'Urgent', search: '?bfr=overdue,30' },
      { name: 'Blocks the most', search: '?bbl=many' },
      { name: 'Owner actions', search: '?bty=owner-task' },
      { name: 'History (answered)', search: '?bst=answered' },
    ],
  };
  let searchTime = null;

  function filtersEl(h, d, surface, all, match) {
    const t = h.state();
    const fn = filterKey(surface);
    const sn = searchKey(surface);
    const facets = V.jbFacetNumber(surface, all, t[fn], t[sn], { modules: d.modules ?? [] });
    const nowSearch = JSON.stringify(t[fn]);
    const newEntry = (filter, extra = {}) =>
      h.use({ [fn]: filter, [optionKey(surface)]: null, ...extra });
    return h.el(
      'aside',
      {
        id: 'plans-filters',
        class: 'plans-filters',
        'aria-label':
          surface === 'jur' ? 'Filters for the legal points' : 'Filters for the decisions',
        'data-scroll': `${surface}-filters`,
      },
      h.el(
        'label',
        { class: 'plans-search-label' },
        h.el('span', {
          class: 'hidden-for-eye',
          text: surface === 'jur' ? 'Search in the legal points' : 'Search in the decisions',
        }),
        h.el('input', {
          type: 'search',
          class: 'search plans-search',
          placeholder:
            surface === 'jur' ? 'Search in id, question, plan, law' : 'Search in id, text, answer, plan',
          autocomplete: 'off',
          value: t[sn],
          'data-focus': `${surface}-search`,
          oninput: (e) => {
            clearTimeout(searchTime);
            const v = e.target.value.slice(0, 120);
            searchTime = setTimeout(() => h.use({ [sn]: v.trim() }, { push: false }), 200);
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
          ...SHORTCUTS[surface].map((v) => {
            const f = V.readUrl(v.search)[fn];
            return h.el(
              'li',
              { class: 'plans-view' },
              h.el('button', {
                type: 'button',
                class: 'link-button',
                text: v.name,
                'aria-pressed': JSON.stringify(f) === nowSearch ? 'true' : 'false',
                'data-focus': `${surface}-show:${v.name}`,
                onclick: () => newEntry(f, { [sn]: '' }),
              }),
            );
          }),
        ),
      ),
      ...facets
        .filter((f) => f.option.length)
        .map((f) => {
          const key = `${surface}-${f.id}`;
          const open =
            h.facetIsOpen(key, [`${surface}-status`, `${surface}-block`]) ||
            f.option.some((v) => v.selected);
          return h.el(
            'details',
            {
              class: 'plans-facet',
              open: open,
              ontoggle: (e) => h.setFacetOpen(key, e.target.open),
            },
            h.el(
              'summary',
              { class: 'plans-facet-title', 'data-focus': `${surface}-facet:${f.id}` },
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
                      'data-focus': `${surface}-f:${f.id}:${v.val}`,
                      onchange: (e) => {
                        const fresh = { ...h.state()[fn] };
                        const list = new Set(fresh[f.id]);
                        if (e.target.checked) list.add(v.val);
                        else list.delete(v.val);
                        fresh[f.id] = [...list];
                        newEntry(fresh);
                      },
                    }),
                    v.symbol
                      ? h.el('span', {
                          class: `jb-facet-symbol ${f.id === 'status' ? `jst-${v.val}` : `jbl-${v.val}`}`,
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
        text:
          surface === 'jur'
            ? `${match.length} of ${all.length} legal points`
            : `${match.length} of ${all.length} owner questions`,
      }),
    );
  }

  // ---- Middle: chips, the extra boxes and the groups ----
  function middleEl(h, d, surface, all, match, selected) {
    const t = h.state();
    const fn = filterKey(surface);
    const sn = searchKey(surface);
    const chips = V.jbChips(surface, t[fn], { modules: d.modules ?? [] });
    const actively = chips.length > 0 || !!t[sn];
    const reset = () =>
      h.use({ [fn]: V.emptyJbFilter(surface), [sn]: '', [optionKey(surface)]: null });
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
            'data-focus': `${surface}-chip:${b.facet}:${b.val}`,
            onclick: () =>
              h.use({
                [fn]: { ...t[fn], [b.facet]: t[fn][b.facet].filter((x) => x !== b.val) },
              }),
          }),
        ),
      ),
      t[sn] ? h.el('span', { class: 'badge plans-chip', text: `Search: ${t[sn]}` }) : null,
      actively
        ? h.el('button', {
            type: 'button',
            class: 'button-small button-outline',
            text: 'Reset',
            'data-focus': `${surface}-reset`,
            onclick: reset,
          })
        : null,
    );

    let content;
    if (!all.length)
      content = h.el(
        'div',
        { class: 'empty empty-state' },
        h.el('p', {
          text:
            surface === 'jur'
              ? 'No plan entries have legal points yet.'
              : 'The queue has no owner questions.',
        }),
        surface === 'jur'
          ? h.el('p', {
              class: 'plans-help',
              text:
                'The points are added to the entry with cq plan edit <PL-id> --set \'{"legal":{…}}\' (the fields are listed in docs/plan-register.md).',
            })
          : null,
      );
    else if (!match.length)
      content = h.el(
        'div',
        { class: 'empty empty-state' },
        h.el('p', {
          text:
            surface === 'jur'
              ? 'No points match the filters and the search. Closed points show when the status filter includes them.'
              : 'No questions match the filters and the search. Answered ones show when the status filter includes Answered.',
        }),
        h.el('button', {
          type: 'button',
          class: 'link-button',
          text: 'Reset the filters',
          onclick: reset,
        }),
      );
    else
      content = h.el(
        'div',
        {},
        ...V.jbGroups(surface, match).map((g) => groupEl(h, d, surface, g, selected, actively)),
      );

    return h.el(
      'section',
      {
        class: 'plans-middle jb-middle',
        'aria-label': surface === 'jur' ? 'The legal points' : 'Owner decisions',
        'data-scroll': `${surface}-list`,
      },
      header,
      surface === 'jur' ? privacyEl(h, d) : null,
      surface === 'jur' ? lawyerPackageEl(h, d) : null,
      content,
    );
  }

  /** One group: a foldable heading and the rows. Open by default; what you close is remembered. */
  function groupEl(h, d, surface, g, selected, actively) {
    const key = `${surface}g:${g.id}`;
    const hasChosen = selected && g.elements.some((x) => x.id === selected.id);
    const closedDefault = surface === 'decision' && g.id === 'answered';
    const closed = closedDefault ? !h.isClosed(key) : h.isClosed(key);
    const open = actively || hasChosen || !closed;
    const id = `jb-g-${surface}-${g.id}`;
    return h.el(
      'section',
      { class: 'doc-group jb-group', 'aria-labelledby': `${id}-t` },
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
            'data-focus': `${surface}g:${g.id}`,
            onclick: () => h.toggleClosed(key),
          },
          h.el('span', {
            class: 'plans-fold-arrow',
            'aria-hidden': 'true',
            text: open ? '▾' : '▸',
          }),
          g.symbol
            ? h.el('span', {
                class: `jb-facet-symbol jst-${g.id}`,
                'aria-hidden': 'true',
                text: g.symbol,
              })
            : null,
          h.el('span', { class: 'plans-group-title', text: g.title }),
          h.el('span', {
            class: 'plans-count',
            text: String(g.elements.length),
            'aria-label': `${g.elements.length} in the group`,
          }),
        ),
      ),
      open
        ? h.el(
            'ul',
            { class: 'jb-list', id },
            ...g.elements.map((x) =>
              surface === 'jur' ? legalRowEl(h, d, x, selected) : decRowEl(h, d, x, selected),
            ),
          )
        : null,
    );
  }

  function rowButton(h, surface, x, isSelected, ...content) {
    return h.el(
      'button',
      {
        type: 'button',
        class: 'jb-select',
        'aria-current': isSelected ? 'true' : null,
        'data-focus': `${surface}:${x.id}`,
        onclick: () => select(h, surface, x.id),
      },
      ...content,
    );
  }

  function legalRowEl(h, d, x, selected) {
    const isSelected = selected?.id === x.id;
    return h.el(
      'li',
      { class: `jb-row${isSelected ? ' selected' : ''}` },
      rowButton(
        h,
        'jur',
        x,
        isSelected,
        h.el('span', { class: 'plans-entry-id', text: x.id }),
        h.el('span', { class: 'jb-text', text: x.question }),
      ),
      h.el(
        'span',
        { class: 'jb-meta' },
        blockEl(h, x.blocks),
        x.deadline
          ? h.el('span', {
              class: `badge${x.deadline_days != null && x.deadline_days < 0 ? ' jb-overdue' : ''}`,
              text: `◷ ${summaryDate(x.deadline)}`,
            })
          : null,
        h.el('span', { class: 'jb-entry', text: x.entry }),
      ),
      h.copyButton(V.legalLine(x, d), `Copy the start line for ${x.id}`),
    );
  }

  function decRowEl(h, d, x, selected) {
    const isSelected = selected?.id === x.id;
    const block = x.blocked_entries.length;
    return h.el(
      'li',
      { class: `jb-row${isSelected ? ' selected' : ''}${x.resolved ? ' resolved' : ''}` },
      rowButton(
        h,
        'decision',
        x,
        isSelected,
        h.el('span', { class: 'plans-entry-id', text: x.id }),
        h.el('span', { class: 'jb-text', text: x.text ?? '(the question has no text in the queue)' }),
      ),
      h.el(
        'span',
        { class: 'jb-meta' },
        h.el('span', { class: 'badge', text: V.DEC_TYPE[x.type] ?? x.type }),
        x.resolved
          ? h.el('span', { class: 'badge jb-answered', text: `✓ Answered ${summaryDate(x.answer_time)}` })
          : null,
        !x.resolved && x.urgent
          ? h.el('span', {
              class: 'badge jb-overdue',
              text: `! ${deadlineText(x.deadline, x.deadline_days)}`,
            })
          : null,
        !x.resolved && block
          ? h.el('span', { class: 'badge', text: `▣ ${block} ${block === 1 ? 'entry' : 'entries'}` })
          : null,
        !x.resolved && x.minutes
          ? h.el('span', { class: 'badge', text: `◷ ${x.minutes} min in queue` })
          : null,
        !x.resolved && x.days_open != null
          ? h.el('span', { class: 'jb-age', text: `open for ${x.days_open} d` })
          : null,
      ),
      h.copyButton(V.ownerLine(x, d), `Copy the start line for ${x.id}`),
    );
  }

  // ---- Legal: privacy per module and the lawyer package ----
  function privacyEl(h, d) {
    const rows = d.privacy ?? [];
    if (!rows.length) return null;
    const open = h.facetIsOpen('legal-privacy', ['legal-privacy']);
    const name = (ids) => (ids.length ? ids.join(', ') : '·');
    return h.el(
      'details',
      {
        class: 'doc-must jb-privacy',
        open: open,
        ontoggle: (e) => h.setFacetOpen('legal-privacy', e.target.open),
      },
      h.el(
        'summary',
        { class: 'doc-section-title', 'data-focus': 'legal-privacy' },
        'Privacy per area',
      ),
      h.el(
        'div',
        { class: 'doc-table-frame' },
        h.el(
          'table',
          { class: 'doc-table' },
          h.el('caption', { class: 'hidden-for-eye', text: 'Privacy status per area' }),
          h.el(
            'thead',
            {},
            h.el(
              'tr',
              {},
              ...[
                'Area',
                'Art. 9 surfaces',
                'DPIA needed',
                'DPIA not assessed',
                'DPIA exists',
                'DPA must change',
              ].map((k) => h.el('th', { scope: 'col', text: k })),
            ),
          ),
          h.el(
            'tbody',
            {},
            ...rows.map((r) =>
              h.el(
                'tr',
                {},
                h.el('th', { scope: 'row', text: moduleName(d, r.module) }),
                h.el('td', { text: `${r.art9.length}` }),
                h.el('td', {
                  class: r.dpia.needed.length ? 'doc-overdue' : null,
                  text: r.dpia.needed.length ? `! ${name(r.dpia.needed)}` : '·',
                }),
                h.el('td', {
                  class: r.dpia.unassessed.length ? 'doc-soon' : null,
                  text: r.dpia.unassessed.length ? `? ${name(r.dpia.unassessed)}` : '·',
                }),
                h.el('td', { text: name(r.dpia.exists) }),
                h.el('td', { text: name(r.dpa_change) }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  async function previewPackage(h) {
    u.packageFetching = true;
    h.draw();
    try {
      const r = await postJson('/api/lawyerPackage', { dry: true });
      if (r.status !== 200 || !r.answer?.ok) throw new Error(r.answer?.message ?? `HTTP ${r.status}`);
      u.package = r.answer;
    } catch (e) {
      h.message(`Could not make the lawyer package: ${e.message}`, true);
    } finally {
      u.packageFetching = false;
    }
    h.draw({ focus: 'legal-package-save' });
  }

  async function savePackage(h, replace = false) {
    u.packageFetching = true;
    h.draw();
    try {
      const r = await postJson('/api/lawyerPackage', replace ? { replace: true } : {});
      if (r.status === 409 && r.answer?.confirm) {
        u.package = { ...u.package, mustConfirm: r.answer.message };
      } else if (r.status !== 200 || !r.answer?.ok) {
        throw new Error(r.answer?.message ?? `HTTP ${r.status}`);
      } else {
        h.message(r.answer.message);
        u.package = null;
      }
    } catch (e) {
      h.message(`Could not save the lawyer package: ${e.message}`, true);
    } finally {
      u.packageFetching = false;
    }
    h.draw({ focus: 'legal-package' });
  }

  function lawyerPackageEl(h, d) {
    const toLawyer = (d.jur_points ?? []).filter((x) => x.status === 'to-lawyer').length;
    const p = u.package;
    return h.el(
      'section',
      { class: 'jb-package', 'aria-label': 'Lawyer package' },
      h.el(
        'div',
        { class: 'jb-package-header' },
        h.el(
          'p',
          {},
          h.el('strong', { text: 'Lawyer package. ' }),
          `${toLawyer} ${toLawyer === 1 ? 'point is' : 'points are'} marked to lawyer. The draft is saved locally in the data folder and never sent.`,
        ),
        h.el('button', {
          type: 'button',
          class: 'button button-outline',
          text: u.packageFetching ? 'Making …' : p ? 'Make again' : 'Preview lawyer package',
          disabled: u.packageFetching || !toLawyer,
          'data-focus': 'legal-package',
          onclick: () => previewPackage(h),
        }),
      ),
      p
        ? h.el(
            'div',
            { class: 'jb-package-show' },
            h.el('p', {
              class: 'plans-help',
              text: p.exists
                ? p.equal
                  ? `${p.path} already exists with exactly this content.`
                  : `${p.path} already exists with other content. Saving replaces it (you will be asked).`
                : `Saved as ${p.path}.`,
            }),
            h.el('pre', { class: 'jb-package-text', tabindex: '0', text: p.text }),
            p.mustConfirm
              ? h.el(
                  'div',
                  { class: 'plans-control', role: 'alert' },
                  h.el('p', { text: p.mustConfirm }),
                  h.el('button', {
                    type: 'button',
                    class: 'button button-filled',
                    text: 'Replace the file',
                    'data-focus': 'legal-package-replace',
                    onclick: () => savePackage(h, true),
                  }),
                )
              : null,
            h.el(
              'div',
              { class: 'plans-actions' },
              h.el('button', {
                type: 'button',
                class: 'button button-filled',
                text: 'Save draft',
                disabled: u.packageFetching || p.equal,
                'data-focus': 'legal-package-save',
                onclick: () => savePackage(h),
              }),
              h.el('button', {
                type: 'button',
                class: 'button button-outline',
                text: 'Close',
                onclick: () => {
                  u.package = null;
                  h.draw({ focus: 'legal-package' });
                },
              }),
            ),
          )
        : null,
    );
  }

  // ---- Right: the detail panels ----
  function emptyDetail(h, text) {
    return h.el(
      'aside',
      { class: 'plans-detail empty-detail', 'aria-label': 'Detail panel' },
      h.el('p', { class: 'empty', text }),
    );
  }

  function back(h, surface) {
    return h.el('button', {
      type: 'button',
      class: 'button-small button-outline plans-back',
      text: 'Back to the list',
      onclick: () => h.use({ [optionKey(surface)]: null }),
    });
  }

  function legalDetailEl(h, d, x) {
    const t = h.state();
    if (!x)
      return emptyDetail(
        h,
        t.jur ? `Did not find the point ${t.jur}.` : 'Select a legal point to see the details.',
      );
    const line = V.legalLine(x, d);
    const pv = x.privacy;
    return h.el(
      'aside',
      { class: 'plans-detail', 'aria-label': `Details for ${x.id}`, 'data-scroll': 'legal-detail' },
      back(h, 'jur'),
      h.el(
        'header',
        { class: 'plans-detail-header' },
        h.el('p', { class: 'plans-detail-id', text: x.id }),
        h.el('h2', { class: 'plans-detail-title', text: x.question }),
        h.el(
          'p',
          { class: 'plans-detail-badges' },
          statusEl(h, x.status),
          blockEl(h, x.blocks),
          x.deadline
            ? h.el('span', { class: 'badge', text: deadlineText(x.deadline, x.deadline_days) })
            : null,
        ),
        h.el(
          'div',
          { class: 'plans-actions' },
          h.el('button', {
            type: 'button',
            class: 'button button-filled',
            text: 'Copy start line',
            title: line,
            'data-focus': 'legal-copy',
            onclick: () => h.copy(line),
          }),
        ),
      ),
      h.el(
        'dl',
        { class: 'plans-field' },
        h.field('Plan', entryButton(h, x.entry, x.entry_title, 'legal-entry')),
        h.field('Module', moduleName(d, x.module)),
        h.field('Project', x.project),
        h.field('Affects', x.affects.join('; ')),
        h.field(
          'Privacy',
          pv
            ? [
                pv.art9 ? 'art. 9 data' : 'not art. 9',
                V.DPIA_TEXT[pv.dpia ?? 'unassessed'],
                pv.dpa_change ? 'DPA must change' : null,
              ]
                .filter(Boolean)
                .join(', ')
            : null,
        ),
      ),
      section(
        h,
        'AI assessment',
        h.el('p', {
          class: x.ai_assessment ? null : 'empty',
          text:
            x.ai_assessment ?? 'No AI assessment yet. Legal QA with AI comes before the lawyer.',
        }),
      ),
      x.lawyer
        ? section(
            h,
            'The lawyer\'s answer',
            h.el('p', { text: x.lawyer.answer ?? '' }),
            h.el('p', {
              class: 'plans-help',
              text: [x.lawyer.date ? summaryDate(x.lawyer.date) : null, x.lawyer.source ?? null]
                .filter(Boolean)
                .join(' · '),
            }),
          )
        : null,
      x.sources.length
        ? section(
            h,
            'Plan links',
            h.list(
              x.sources.map((k) =>
                h.el('li', { text: `${k.path}${k.anchor ? ` (${k.anchor})` : ''}` }),
              ),
              'No sources.',
            ),
          )
        : null,
      h.el('p', {
        class: 'plans-help',
        text: `Changed with cq plan edit ${x.entry} --set '{"legal":…}' (the whole field), or with the start line above.`,
      }),
    );
  }

  async function sendAnswer(h, x, confirm = false) {
    const text = u.draft.get(x.id) ?? '';
    const r0 = V.resolveBody(x.id, text, { confirm });
    if (r0.error) {
      h.message(r0.error, true);
      return;
    }
    u.sender = true;
    h.draw();
    try {
      const r = await postJson('/api/action', r0.body);
      if (r.status === 409 && r.answer?.confirm) {
        u.confirm = { sp: x.id, message: r.answer.message };
      } else if (r.status !== 200 || !r.answer?.ok) {
        throw new Error(r.answer?.message ?? `HTTP ${r.status}`);
      } else {
        u.draft.delete(x.id);
        u.confirm = null;
        h.message(`The answer to ${x.id} is saved.`);
        await h.get(true);
      }
    } catch (e) {
      h.message(`Could not save the answer: ${e.message}`, true);
    } finally {
      u.sender = false;
    }
    h.draw({ focus: `dec-answer:${x.id}` });
  }

  function decDetailEl(h, d, x) {
    const t = h.state();
    if (!x)
      return emptyDetail(
        h,
        t.sp
          ? `Did not find the question ${t.sp}.`
          : 'Select an owner question to see the details and answer.',
      );
    const line = V.ownerLine(x, d);
    const entryTitle = (id) => (d.entries ?? []).find((p) => p.id === id)?.title ?? null;
    const indirect = x.blocked_entries.filter((id) => !x.entries.includes(id));
    return h.el(
      'aside',
      { class: 'plans-detail', 'aria-label': `Details for ${x.id}`, 'data-scroll': 'dec-detail' },
      back(h, 'decision'),
      h.el(
        'header',
        { class: 'plans-detail-header' },
        h.el('p', { class: 'plans-detail-id', text: x.id }),
        h.el('h2', { class: 'plans-detail-title', text: x.text ?? '(no text in the queue)' }),
        h.el(
          'p',
          { class: 'plans-detail-badges' },
          h.el('span', { class: 'badge', text: V.DEC_TYPE[x.type] ?? x.type }),
          h.el('span', {
            class: `badge${x.resolved ? ' jb-answered' : ''}`,
            text: x.resolved ? '✓ Answered' : '○ Open',
          }),
          x.deadline
            ? h.el('span', {
                class: `badge${x.urgent ? ' jb-overdue' : ''}`,
                text: deadlineText(x.deadline, x.deadline_days),
              })
            : null,
        ),
        h.el(
          'div',
          { class: 'plans-actions' },
          h.el('button', {
            type: 'button',
            class: 'button button-outline',
            text: 'Copy start line',
            title: line,
            'data-focus': 'dec-copy',
            onclick: () => h.copy(line),
          }),
        ),
      ),
      h.el(
        'dl',
        { class: 'plans-field' },
        h.field('Recommendation', x.recommendation),
        h.field('Source', x.source),
        h.field(
          'Added',
          x.added_at ? `${summaryDate(x.added_at)} (${x.days_open} days ago)` : null,
        ),
        h.field('Areas', x.modules.map((m) => moduleName(d, m)).join(', ')),
        h.field('Projects', x.projects.join(', ')),
      ),
      section(
        h,
        'Blocks',
        h.list(
          [
            ...x.entries.map((id) =>
              h.el('li', {}, entryButton(h, id, entryTitle(id), `dec-entry:${id}`)),
            ),
            ...indirect.map((id) =>
              h.el(
                'li',
                {},
                entryButton(h, id, entryTitle(id), `dec-entry:${id}`),
                h.el('span', { class: 'plans-help', text: ' (depended on by an entry above)' }),
              ),
            ),
            ...x.tasks.map((id) =>
              h.el(
                'li',
                {},
                h.el('button', {
                  type: 'button',
                  class: 'link-button',
                  text: `Queue task ${id}`,
                  onclick: () => {
                    h.use({ room: 'queue' });
                    window.QueueBoard?.showTask?.(id);
                  },
                }),
              ),
            ),
          ],
          'No plan entries or queue tasks are waiting on this.',
        ),
        x.minutes
          ? h.el('p', { class: 'plans-help', text: `${x.minutes} minutes of queue work waiting.` })
          : null,
      ),
      x.resolved ? answerHistory(h, x) : answerForm(h, x),
    );
  }

  function answerHistory(h, x) {
    return section(
      h,
      'Answer',
      h.el('p', { text: x.answer ?? '(the answer is not in the queue)' }),
      h.el('p', {
        class: 'plans-help',
        text: [x.answer_time ? summaryDate(x.answer_time) : null, x.answer_by ? `by ${x.answer_by}` : null]
          .filter(Boolean)
          .join(' '),
      }),
    );
  }

  function answerForm(h, x) {
    const id = `dec-answer-${x.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const waiting = u.confirm?.sp === x.id ? u.confirm : null;
    return section(
      h,
      'Answer',
      h.el('label', {
        before: id,
        class: 'plans-help',
        text: 'The answer is saved with cq resolve and logged in the decision log.',
      }),
      (() => {
        const ta = h.el('textarea', {
          id,
          class: 'jb-answer',
          rows: '4',
          maxlength: '4000',
          'data-focus': `dec-answer:${x.id}`,
          oninput: (e) => {
            u.draft.set(x.id, e.target.value);
            if (u.confirm?.sp === x.id) u.confirm = null;
          },
        });
        // The draft survives the room being redrawn (update from the server every 15 seconds).
        ta.value = u.draft.get(x.id) ?? '';
        return ta;
      })(),
      waiting
        ? h.el(
            'div',
            { class: 'plans-control', role: 'alert' },
            h.el('p', { text: waiting.message }),
            h.el('button', {
              type: 'button',
              class: 'button button-filled',
              text: 'Answer anyway',
              disabled: u.sender,
              'data-focus': `dec-anyway:${x.id}`,
              onclick: () => sendAnswer(h, x, true),
            }),
          )
        : null,
      h.el(
        'div',
        { class: 'plans-actions' },
        h.el('button', {
          type: 'button',
          class: 'button button-filled',
          text: u.sender ? 'Saving …' : 'Answer',
          disabled: u.sender,
          'data-focus': `dec-send:${x.id}`,
          onclick: () => sendAnswer(h, x),
        }),
        x.recommendation
          ? h.el('button', {
              type: 'button',
              class: 'button button-outline',
              text: 'Use the recommendation',
              onclick: () => {
                u.draft.set(x.id, x.recommendation);
                h.draw({ focus: `dec-answer:${x.id}` });
              },
            })
          : null,
      ),
    );
  }

  // ---- Launch ----
  function launchEl(h, d) {
    const l = d.launch ?? null;
    const go = (change) => h.use(change, { push: true, scroll: true });
    const block = (title, n, content, empty) =>
      h.el(
        'section',
        { class: 'jb-launch-del' },
        h.el('h3', { class: 'plans-cell-title', text: `${title} (${n})` }),
        n ? content : h.el('p', { class: 'doc-alt-ok', text: `✓ ${empty}` }),
      );
    if (!l)
      return h.el(
        'section',
        { class: 'plans-middle' },
        h.el('p', { class: 'empty', text: 'No data.' }),
      );
    const left = l.entries.filter((p) => !p.done).length;
    return h.el(
      'section',
      {
        class: 'plans-middle jb-launch',
        'aria-label': 'Launch overview',
        'data-scroll': 'launch',
      },
      h.el(
        'header',
        { class: 'jb-launch-header' },
        h.el('h2', {
          class: 'plans-detail-title',
          text: 'What stands between us and the first paying customer?',
        }),
        h.el('p', {
          role: 'status',
          text: l.remaining
            ? `${l.remaining} things remaining: ${left} of ${l.entries.length} entries before prod, ${l.legal.length} legal points, ${l.actions.length} owner actions, ${l.decisions.length} owner questions and ${l.documents.length} documents.`
            : '✓ Nothing is in the way as the register sees it now.',
        }),
      ),
      block(
        'Entries before prod',
        l.entries.length,
        h.el(
          'ul',
          { class: 'jb-list' },
          ...l.entries.map((p) =>
            h.el(
              'li',
              { class: `jb-row${p.done ? ' resolved' : ''}` },
              h.el('span', {
                class: 'jb-check',
                'aria-hidden': 'true',
                text: p.done ? '✓' : '○',
              }),
              entryButton(h, p.id, p.title, `launch-entry:${p.id}`),
              h.el(
                'span',
                { class: 'jb-meta' },
                h.el('span', {
                  class: 'badge',
                  text: `${p.done ? 'Done' : 'Remaining'}: ${V.MATURITY?.[p.maturity]?.text ?? p.maturity}${p.fraction ? ` ${p.fraction}` : ''}`,
                }),
                p.deadline ? h.el('span', { class: 'badge', text: `◷ ${summaryDate(p.deadline)}` }) : null,
                h.el('span', { class: 'jb-entry', text: moduleName(d, p.module) }),
              ),
            ),
          ),
        ),
        'No entries are marked Now, before prod.',
      ),
      block(
        'Legal points that block prod',
        l.legal.length,
        h.el(
          'ul',
          { class: 'jb-list' },
          ...l.legal.map((x) =>
            h.el(
              'li',
              { class: 'jb-row' },
              h.el('button', {
                type: 'button',
                class: 'link-button',
                text: `${x.id} ${x.question}`,
                'data-focus': `launch-legal:${x.id}`,
                onclick: () => go({ surface: 'jur', jur: x.id }),
              }),
              h.el(
                'span',
                { class: 'jb-meta' },
                statusEl(h, x.status),
                h.el('span', { class: 'jb-entry', text: x.entry }),
              ),
            ),
          ),
        ),
        'No open legal points block prod.',
      ),
      block(
        'Owner actions',
        l.actions.length,
        decList(h, l.actions, go),
        'No open owner actions.',
      ),
      block(
        'Owner questions on entries before prod',
        l.decisions.length,
        decList(h, l.decisions, go),
        'No open owner questions on entries before prod.',
      ),
      block(
        'Documents before prod that need something done',
        l.documents.length,
        h.el(
          'ul',
          { class: 'doc-must-list' },
          ...l.documents.map((m) =>
            h.el(
              'li',
              {},
              h.el('button', {
                type: 'button',
                class: 'link-button',
                text: `${m.id} ${m.title}`,
                'data-focus': `launch-doc:${m.id}`,
                onclick: () => go({ surface: 'doc', doc: m.id }),
              }),
              h.el('span', {
                class: 'doc-must-reasons',
                text: m.reasons.map((g) => g.text).join(' · '),
              }),
            ),
          ),
        ),
        'No documents before prod need anything done.',
      ),
    );
  }

  function decList(h, list, go) {
    return h.el(
      'ul',
      { class: 'jb-list' },
      ...list.map((x) =>
        h.el(
          'li',
          { class: 'jb-row' },
          h.el('button', {
            type: 'button',
            class: 'link-button',
            text: `${x.id} ${x.text ?? ''}`,
            'data-focus': `launch-sp:${x.id}`,
            onclick: () => go({ surface: 'decision', sp: x.id }),
          }),
          h.el(
            'span',
            { class: 'jb-meta' },
            x.deadline
              ? h.el('span', {
                  class: `badge${x.urgent ? ' jb-overdue' : ''}`,
                  text: deadlineText(x.deadline, x.deadline_days),
                })
              : null,
            x.blocked_entries.length
              ? h.el('span', { class: 'badge', text: `▣ ${x.blocked_entries.length} entries` })
              : null,
          ),
        ),
      ),
    );
  }

  window.QueuePlanLegal = { cells, hasSelected, launchIds };
})();
