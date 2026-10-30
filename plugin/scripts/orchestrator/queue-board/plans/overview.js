// =============================================================
// overview.js: the overview page in the Plans room (see docs/board.md).
// Vanilla JS, no build step, no CDN. All text is set with textContent (via h.el), never innerHTML.
//
// One screen that answers "where are we":
//   - "Working now" at the top: entries a /plans session is working on (active_session, pulse marker, gone after 2 hours),
//   - eight module cards (count, bar by priority and by maturity, how much is built, and up to three warning counts:
//     owner questions, legal and stale, each only when it is over 0); a click opens the list filtered on the module,
//   - "Waiting on you": the five owner questions and legal points that block the most, with an answer button,
//   - the capacity in Now, with a notice when Now grows faster than the queue drains,
//   - recently changed and recently registered.
// The rules (moduleSummary, waitingOnYou, workingNow, capacity and recent) are the pure functions in queuePlanView.js;
// here is only the drawing. The deadline band above the page is drawn by map.js (plans.js inserts it). The page writes nothing.
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;

  /** A bar split into parts (width by count). The text beside it carries the numbers, so color is never alone. */
  function bar(h, parts, name, cls) {
    const sum = parts.reduce((n, x) => n + x.count, 0);
    const text = parts.map((x) => `${x.text} ${x.count}`).join(', ');
    return h.el(
      'span',
      { class: 'overview-bar', role: 'img', 'aria-label': `${name}: ${text}` },
      ...parts
        .filter((x) => x.count > 0)
        .map((x) =>
          h.el('span', {
            class: `overview-del ${cls}-${x.id}`,
            '--share': `${sum ? (x.count / sum) * 100 : 0}%`,
          }),
        ),
    );
  }

  /** The legend under a bar: symbol (when there is one), text and number. */
  function explanation(h, parts) {
    return h.el(
      'span',
      { class: 'overview-explanation', 'aria-hidden': 'true' },
      parts.map((x) => `${x.symbol ? `${x.symbol} ` : ''}${x.text} ${x.count}`).join(' · '),
    );
  }

  function moduleCard(h, k) {
    const pst = Math.round(k.share * 100);
    // A warning count is shown only when there is something to act on: "0 owner questions" is not a warning.
    const notice = (draw, n, one, more, cls) =>
      n
        ? h.el(
            'span',
            { class: `overview-warning has ${cls}` },
            h.el('span', { 'aria-hidden': 'true', text: draw }),
            ` ${n} ${n === 1 ? one : more}`,
          )
        : null;
    return h.el(
      'li',
      { class: 'overview-summary-space' },
      h.el(
        'button',
        {
          type: 'button',
          class: 'overview-summary',
          'data-focus': `moduleCard:${k.oid}`,
          'aria-label': `${k.title}: ${k.count} entries. Open the list filtered on the area.`,
          onclick: () => {
            const f = V.emptyFilter();
            f.module = [k.oid];
            h.goToList({ filter: f, search: '', entry: null });
          },
        },
        h.el(
          'span',
          { class: 'overview-summary-header' },
          h.el('span', { class: 'overview-summary-title', text: k.title }),
          h.el('span', {
            class: 'overview-summary-count',
            text: `${k.count} ${k.count === 1 ? 'entry' : 'entries'}${k.dropped ? `, ${k.dropped} dropped` : ''}`,
          }),
        ),
        h.el('span', { class: 'overview-label', text: 'Priority' }),
        bar(h, k.priority, 'Priority', 'pri'),
        explanation(h, k.priority),
        h.el('span', { class: 'overview-label', text: 'Maturity' }),
        bar(h, k.maturity, 'Maturity', 'mod'),
        explanation(h, k.maturity),
        h.el('span', {
          class: 'overview-built',
          text: `Built: ${k.built} of ${k.count} (${pst} %)`,
        }),
        h.el(
          'span',
          { class: 'overview-warnings' },
          notice('?', k.ownerQuestions, 'owner question', 'owner questions', 'v-owner'),
          notice('§', k.legal, 'legal point', 'legal points', 'v-legal'),
          notice('⟳', k.stale, 'stale', 'stale', 'v-stale'),
          k.active
            ? h.el(
                'span',
                { class: 'overview-warning has v-active' },
                h.el('span', { class: 'pulse', 'aria-hidden': 'true', text: '◉' }),
                ` ${k.active} being worked on`,
              )
            : null,
        ),
      ),
    );
  }

  function workingNowEl(h, d) {
    const list = V.workingNow(d);
    if (!list.length) return null;
    return h.el(
      'section',
      { class: 'overview-box overview-working', 'aria-label': 'Working now' },
      h.el('h2', { class: 'overview-title', text: 'Working now' }),
      h.el(
        'ul',
        { class: 'overview-list' },
        ...list.map((x) =>
          h.el(
            'li',
            { class: 'overview-row' },
            h.el('span', { class: 'pulse', 'aria-hidden': 'true', text: '◉' }),
            h.el('span', { class: 'overview-mark', text: 'Being worked on in Claude Code' }),
            h.el('button', {
              type: 'button',
              class: 'link-button',
              text: `${x.id} ${x.title}`,
              'data-focus': `working:${x.id}`,
              onclick: () => h.goToEntry(x.id),
            }),
            h.el('span', {
              class: 'overview-time',
              text: `${x.by ? `${x.by}, ` : ''}last pulse ${h.date(x.at)}`,
            }),
          ),
        ),
      ),
    );
  }

  function waitingEl(h, d) {
    const v = V.waitingOnYou(d);
    return h.el(
      'section',
      { class: 'overview-box', 'aria-label': 'Waiting on you' },
      h.el(
        'h2',
        { class: 'overview-title' },
        'Waiting on you',
        v.total > v.points.length
          ? h.el('span', {
              class: 'overview-under',
              text: ` (the ${v.points.length} that block the most of ${v.total})`,
            })
          : null,
      ),
      v.points.length
        ? h.el(
            'ol',
            { class: 'overview-list' },
            ...v.points.map((x) =>
              h.el(
                'li',
                { class: 'overview-row overview-waiting' },
                h.el('span', {
                  class: `badge overview-type t-${x.type}`,
                  text: x.type === 'owner' ? '? Owner question' : '§ Legal',
                }),
                h.el('span', { class: 'overview-id', text: x.id }),
                h.el('span', {
                  class: 'overview-text',
                  text: x.text.length > 160 ? `${x.text.slice(0, 157)} …` : x.text,
                  title: x.text,
                }),
                h.el('span', {
                  class: 'overview-time',
                  text:
                    `blocks ${x.blocks} ${x.blocks === 1 ? 'entry' : 'entries'}` +
                    `${x.tasks ? `, ${x.tasks} queue tasks waiting` : ''}` +
                    `${x.deadline ? `, deadline ${x.deadline}` : ''}${x.urgent ? ' (urgent)' : ''}`,
                }),
                h.el('button', {
                  type: 'button',
                  class: 'button-small button-muted',
                  text: 'Answer',
                  'aria-label': `Answer ${x.id}`,
                  'data-focus': `answer:${x.type}:${x.id}`,
                  onclick: () =>
                    x.type === 'owner'
                      ? h.use({ surface: 'decision', sp: x.id }, { scroll: true })
                      : h.use({ surface: 'jur', jur: x.id }, { scroll: true }),
                }),
              ),
            ),
          )
        : h.el('p', { class: 'empty', text: 'Nothing is waiting on you.' }),
    );
  }

  function capacityEl(h, d) {
    const k = d.capacity;
    if (!k) return null;
    return h.el(
      'section',
      { class: 'overview-box', 'aria-label': 'Capacity in Now' },
      h.el('h2', { class: 'overview-title', text: 'Capacity in Now' }),
      h.el('p', { class: 'overview-capacity', text: k.text }),
      k.notice
        ? h.el(
            'p',
            { class: 'overview-capacity-warning' },
            h.el('span', { 'aria-hidden': 'true', text: '⚠ ' }),
            h.el('span', { class: 'hidden-for-eye', text: 'Warning: ' }),
            k.warning_text,
          )
        : null,
      (k.without_size ?? []).length
        ? h.el('p', {
            class: 'overview-under',
            text: `Without size: ${k.without_size.slice(0, 12).join(', ')}${k.without_size.length > 12 ? ' …' : ''}`,
          })
        : null,
    );
  }

  function entryButton(h, id) {
    return h.el('button', {
      type: 'button',
      class: 'link-button',
      text: id,
      onclick: () => h.goToEntry(id),
    });
  }

  function recentEl(h, d) {
    const n = d.recent ?? { changed: [], registered: [] };
    return h.el(
      'section',
      { class: 'overview-box', 'aria-label': 'Recent' },
      h.el('h2', { class: 'overview-title', text: 'Recent changed' }),
      n.changed.length
        ? h.el(
            'ul',
            { class: 'overview-list' },
            ...n.changed.map((x) =>
              h.el(
                'li',
                { class: `overview-row${x.undone ? ' undone' : ''}` },
                h.el('span', { class: 'badge', text: `nr. ${x.nr}` }),
                h.el('span', {
                  class: 'overview-time',
                  text: `${h.date(x.at)} · ${x.action ?? ''} · ${x.by ?? ''}${x.undone ? ' · undone' : ''}`,
                }),
                ...x.ids.filter((id) => /^PL-/.test(id)).map((id) => entryButton(h, id)),
              ),
            ),
          )
        : h.el('p', { class: 'empty', text: 'No changes in the changelog.' }),
      h.el('h2', { class: 'overview-title', text: 'Recent registered' }),
      n.registered.length
        ? h.el(
            'ul',
            { class: 'overview-list' },
            ...n.registered.map((x) =>
              h.el(
                'li',
                { class: 'overview-row' },
                entryButton(h, x.id),
                h.el('span', { class: 'overview-text', text: x.title }),
                h.el('span', { class: 'overview-time', text: h.date(x.at) }),
              ),
            ),
          )
        : h.el('p', { class: 'empty', text: 'No entries with a registration time.' }),
    );
  }

  window.QueuePlanOverview = {
    /** The whole overview page. `h` is the helpers from plans.js (workHelp). */
    side(h, d) {
      if (!d.exists)
        return h.el('p', {
          class: 'empty plans-fetching',
          text: 'The plan register does not exist yet (scripts/.queue/plans.json).',
        });
      return h.el(
        'div',
        { class: 'plans-overview', 'data-scroll': 'overview' },
        workingNowEl(h, d),
        h.el(
          'section',
          { class: 'overview-modules', 'aria-label': 'Areas' },
          h.el('h2', { class: 'hidden-for-eye', text: 'Areas' }),
          h.el(
            'ul',
            { class: 'overview-shortlist' },
            ...V.moduleSummary(d).map((k) => moduleCard(h, k)),
          ),
        ),
        h.el(
          'div',
          { class: 'overview-bottom' },
          waitingEl(h, d),
          h.el('div', { class: 'overview-column' }, capacityEl(h, d), recentEl(h, d)),
        ),
      );
    },
  };
})();
