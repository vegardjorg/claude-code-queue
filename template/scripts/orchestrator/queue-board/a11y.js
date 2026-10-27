// =============================================================
// a11y.js: shared accessibility logic for queueBoard.
//
// The file is both a CommonJS module (vitest, lib/__tests__/queueBoardA11y.test.ts) and a browser script
// (queue-board.mjs serves it as /a11y.js, and it sets window.QueueA11y), so the board uses exactly the code the tests
// check. The pure parts (no DOM) are tested; the DOM helpers below are thin wrappers around them.
//
//   - Focus trap: one shared feature for all the dialogs (the side panel, the guard dialog, the bulk actions and the
//     plan dialog), instead of three copies. `nextInTrap` is the rule, `trapKey` applies it on a Tab press.
//   - Inert: the rest of the page (the top, the board, the strips) is made inert while the side panel is open.
//   - Toast queue: one stack for the message and "Undo", so they never sit on top of each other.
//   - Contrast: the WCAG 2 ratio between two colors (K1 is computed from the palette in the test).
//   - Tabs: which tab the arrow keys go to.
//   - Legend: the classes K, D, D+ and U, and the WIP text in In progress.
//   - The key from a link pasted in after a server restart.
//   - Theme choice (System, Light, Dark).
//   - Empty state and stale data.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueA11y = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Focus trap ----

  /** The elements that can get focus with Tab inside a dialog. */
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  /**
   * Where focus goes when Tab is pressed in a dialog with `count` focusable elements, where the focused element has
   * index `i` (-1 = focus is outside the list, e.g. on the dialog itself). Tab wraps from last to first,
   * Shift+Tab from first to last. Returns -1 when there is nothing to focus.
   */
  function nextInTrap(count, i, backward) {
    if (!(count > 0)) return -1;
    if (backward) return i <= 0 ? count - 1 : Math.min(i, count) - 1;
    return i < 0 || i >= count - 1 ? 0 : i + 1;
  }

  /** The focusable elements in `box`, except those inside something hidden or inert. */
  function focusable(box) {
    return [...box.querySelectorAll(FOCUSABLE)].filter(
      (x) => !x.closest('[hidden]') && !x.closest('[inert]'),
    );
  }

  /**
   * Focus trap: called from the dialog's keydown. On Tab, focus stays in `box` (wraps at the ends). Returns true when
   * the key was handled. Each dialog handles Esc and other keys itself.
   */
  function trapKey(e, box) {
    if (e.key !== 'Tab' || !box) return false;
    const list = focusable(box);
    const j = nextInTrap(list.length, list.indexOf(document.activeElement), e.shiftKey);
    e.preventDefault();
    if (j >= 0) list[j].focus();
    return true;
  }

  /** Sets or removes `inert` on the elements (those that exist). Used while the side panel is open. */
  function setInert(elements, on) {
    for (const x of elements) {
      if (!x) continue;
      if (on) x.setAttribute('inert', '');
      else x.removeAttribute('inert');
    }
  }

  // ---- Toast queue ----

  /**
   * One stack for the messages at the bottom. The queue is a list of keys (e.g. 'message' and 'undo'),
   * oldest first. A key shown again moves to the bottom (newest), so the stack never holds the same one twice.
   * If the list grows longer than `max`, the oldest drop out, but never a key in `kept` (Undo must stay for 30 s).
   */
  function toastAdd(queue, key, { max = 3, kept = [] } = {}) {
    const fresh = [...queue.filter((x) => x !== key), key];
    while (fresh.length > max) {
      const i = fresh.findIndex((x) => x !== key && !kept.includes(x));
      if (i < 0) break;
      fresh.splice(i, 1);
    }
    return fresh;
  }
  function toastRemove(queue, key) {
    return queue.filter((x) => x !== key);
  }

  // ---- Contrast (WCAG 2) ----

  /** Relative luminance for a color in the form #rrggbb. */
  function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
    if (!m) return NaN;
    const channel = (i) => {
      const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  }

  /** The contrast ratio between two colors (1 to 21), rounded down to two decimals so 4.499 never becomes "4.5". */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    if (!Number.isFinite(la) || !Number.isFinite(lb)) return NaN;
    const r = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    return Math.floor(r * 100) / 100;
  }

  // ---- Tabs (View) ----

  /**
   * The tab the arrow keys move focus to: left and right wrap around, Home and End go to the ends. Returns null for
   * other keys. Activation is manual (Enter or Space), because redrawing the board can take time.
   */
  function tabMeasure(count, i, keyPress) {
    if (!(count > 0)) return null;
    switch (keyPress) {
      case 'ArrowRight':
        return (i + 1) % count;
      case 'ArrowLeft':
        return (i - 1 + count) % count;
      case 'Home':
        return 0;
      case 'End':
        return count - 1;
      default:
        return null;
    }
  }

  // ---- Legend ----

  /** The risk classes, with short name and explanation (same split as the add-to-queue skill). */
  const CLASSES = [
    {
      class: 'K',
      name: 'client and interface',
      explanation: 'Code in the application or the tools, and read-only database calls.',
    },
    {
      class: 'D',
      name: 'database',
      explanation: 'Migrations that redefine features or create new RPCs.',
    },
    {
      class: 'D+',
      name: 'database with new table or privacy',
      explanation:
        'New table, retention or anonymization, edge without login, or a change in a shared feature. ' +
        'At most a fixed number at once.',
    },
    { class: 'U', name: 'investigation', explanation: 'Investigation and proposals without code.' },
  ];

  /** Readable label for the class badge, e.g. "Risk class D+: database with new table or privacy". */
  function classLabel(cls) {
    const k = CLASSES.find((x) => x.class === cls);
    return k ? `Risk class ${k.class}: ${k.name}` : `Risk class ${cls}`;
  }

  /** The WIP chip in In progress as plain text: "Agents 3 of 4 · heavy 1 of 2 · 2 picked". */
  function wipText(w) {
    if (!w) return '';
    return (
      `Agents ${w.agents} of ${w.max} · heavy ${w.dPlus} of ${w.maxDPlus}` +
      (w.picked ? ` · ${w.picked} picked` : '')
    );
  }

  // ---- The key after a restart ----

  /**
   * The key from the link queue-board wrote in the terminal (`…/#key=abc`), pasted into the banner. Reads only the #
   * part (or &key= in it). A bare key without a link is also accepted. Returns null when the text has no key.
   */
  function keyFromLink(text) {
    const s = String(text ?? '').trim();
    if (!s) return null;
    const hash = s.includes('#') ? s.slice(s.indexOf('#')) : null;
    if (hash) {
      const m = /[#&]key=([A-Za-z0-9_-]+)/.exec(hash);
      return m ? m[1] : null;
    }
    return /^[A-Za-z0-9_-]{16,}$/.test(s) ? s : null;
  }

  // ---- Theme ----

  const THEME_OPTION = [
    { val: 'system', text: 'System' },
    { val: 'light', text: 'Light' },
    { val: 'dark', text: 'Dark' },
  ];
  /** The saved choice from localStorage: 'light', 'dark' or 'system' (no value or an unknown one). */
  function themeFromSaved(v) {
    return v === 'light' || v === 'dark' ? v : 'system';
  }
  /** The next option when the theme button at the top is pressed: System → Light → Dark → System. */
  function nextTheme(v) {
    const i = THEME_OPTION.findIndex((x) => x.val === themeFromSaved(v));
    return THEME_OPTION[(i + 1) % THEME_OPTION.length].val;
  }

  // ---- Empty state ----

  /**
   * Why a list is empty, and which action shows the cards again. One rule for all the empty states.
   *   text:        the base text for the list ("Nothing here.")
   *   searchHides: the list has cards, but the search hides all of them
   *   search:      the search text (empty string when search is off)
   *   filters:     number of options in the Filter menu
   *   selection:   the name of the selection in use, or null
   * Answer: { text, action: 'search' | 'filter' | 'selection' | null, label }. Search comes before the filter, and the
   * filter before the selection: one action at a time, and whatever hides the cards here is named first.
   */
  function emptyReason({ text, searchHides = false, search = '', filters = 0, selection = null }) {
    if (searchHides && search)
      return { text: `Nothing matches "${search}".`, action: 'search', label: 'Clear search' };
    if (filters > 0)
      return {
        text: `${text} The filter is on (${filters} selected).`,
        action: 'filter',
        label: 'Remove filter',
      };
    if (selection)
      return {
        text: `${text} Selection "${selection}" is in use.`,
        action: 'selection',
        label: 'Show all',
      };
    return { text, action: null, label: null };
  }

  // ---- Stale data ----

  /** Limit for when the data counts as stale: the last successful fetch is older than one minute. */
  const STALE_MS = 60_000;

  /** Is the last fetch (ms since epoch, or null) older than the limit at `now`? Without a fetch: not stale. */
  function stale(fetchedMs, nowMs, limit = STALE_MS) {
    return Number.isFinite(fetchedMs) && nowMs - fetchedMs > limit;
  }

  /** "Not updated since 14:05" (local time, hours and minutes). */
  function staleText(fetched) {
    const t = String(fetched.getHours()).padStart(2, '0');
    const m = String(fetched.getMinutes()).padStart(2, '0');
    return `Not updated since ${t}:${m}`;
  }

  return {
    emptyReason,
    STALE_MS,
    stale,
    staleText,
    FOCUSABLE,
    nextInTrap,
    focusable,
    trapKey,
    setInert,
    toastAdd,
    toastRemove,
    luminance,
    contrast,
    tabMeasure,
    CLASSES,
    classLabel,
    wipText,
    keyFromLink,
    THEME_OPTION,
    themeFromSaved,
    nextTheme,
  };
});
