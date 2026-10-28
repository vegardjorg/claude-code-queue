// =============================================================
// mascot.js: the speech bubble by the mascot on the kanban board (see docs/board.md, "The mascot").
//
// The rules (what, when and how often) live in lib/queueMascot.js (window.QueueMascot, tested with vitest). Only the
// view lives here:
//   - the phrases are fetched from /mascot (your own <dataFolder>/mascot-phrases.json, otherwise the neutral default
//     set), and again when the state's `mascot.file` changes;
//   - board.js reports every new state (newState) and every owner action (ownerAction); a pulse of its own every 15 s
//     gives the random chat (encouragement, statistics, vibe) once 10 min have passed;
//   - the bubble stays 10 s, stays while the mouse is over it, and closes on click. The text is set with textContent,
//     never innerHTML. It fades in and out, but stands still with prefers-reduced-motion. role="note" (not aria-live);
//   - a click on the mascot gives a new line, and 5 clicks within 10 s give "click-5";
//   - the mode Chatty / Events only / Off is stored in localStorage (with try/catch). The server's default comes from
//     board.mascot in queue.config.json or --mascot; when the server says "off", the mascot is off for every viewer
//     (no bubbles, no click) and the choice in the gear is locked.
// =============================================================
(function () {
  'use strict';

  const M = window.QueueMascot;
  if (!M) return;
  const STORAGE = 'queue-board-mascot';
  const PULSE_MS = 15_000;
  const OUT_MS = 200; // as long as the fade-out in board.css (.bubble.out)

  const bubble = document.getElementById('bubble');
  const zone = document.getElementById('mascot');
  if (!bubble || !zone) return;

  let phrases = M.DEFAULT;
  let hasFile = null; // the state's `mascot.file` when the phrases were last fetched
  let s = M.newState();
  let previous = null; // the previous state (for the events)
  let numbers = null;
  let hideTime = null;
  let outTime = null;
  let over = false;
  // The server's mode (board.mascot / --mascot). null until the first state has arrived.
  let serverMode = null;

  function readSaved() {
    try {
      return M.normalizeMode(localStorage.getItem(STORAGE));
    } catch {
      return null; // localStorage blocked (private mode and the like): no own choice
    }
  }
  let saved = readSaved();

  /** The server has turned the mascot off for everyone. */
  const locked = () => serverMode === 'off';
  /** The mode that applies now: off when the server says so, otherwise this browser's choice or the server's default. */
  function mode() {
    if (locked()) return 'off';
    return saved ?? serverMode ?? M.DEFAULT_MODE;
  }

  function setMode(v) {
    const m = M.normalizeMode(v);
    if (!m || locked()) return;
    saved = m;
    try {
      localStorage.setItem(STORAGE, m);
    } catch {
      /* storage is blocked: the choice applies until the page is reloaded */
    }
    if (m === 'off') hide(true);
    clickable(m !== 'off');
  }

  async function fetchPhrases() {
    try {
      const res = await fetch('/mascot', { cache: 'no-store' });
      if (!res.ok) return;
      const answer = await res.json();
      phrases = M.readPhrases(answer?.phrases ?? null).phrases;
    } catch {
      phrases = M.DEFAULT; // the server did not answer: the default set
    }
  }

  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function show(text) {
    clearTimeout(hideTime);
    clearTimeout(outTime);
    bubble.textContent = text;
    bubble.classList.remove('out');
    bubble.hidden = false;
    if (!over) hideTime = setTimeout(() => hide(), M.LIMITS.bubble);
  }

  function hide(now) {
    clearTimeout(hideTime);
    clearTimeout(outTime);
    if (bubble.hidden) return;
    if (now || reduced()) {
      bubble.hidden = true;
      bubble.classList.remove('out');
      return;
    }
    bubble.classList.add('out');
    outTime = setTimeout(() => {
      bubble.hidden = true;
      bubble.classList.remove('out');
    }, OUT_MS);
  }

  bubble.addEventListener('mouseenter', () => {
    over = true;
    clearTimeout(hideTime);
    clearTimeout(outTime);
    bubble.classList.remove('out');
  });
  bubble.addEventListener('mouseleave', () => {
    over = false;
    if (!bubble.hidden) hideTime = setTimeout(() => hide(), M.LIMITS.bubble);
  });
  bubble.addEventListener('click', () => hide());

  /** Says something after a choice from M.decide (or a click). */
  function say(choice, now = Date.now()) {
    if (!choice || mode() === 'off') return;
    const r = M.choose({
      category: choice.category,
      event: choice.event,
      extra: choice.extra,
      phrases,
      numbers,
      now,
      history: s.history,
      vibe: now < s.vibeUntil,
    });
    if (!r) return;
    // A click does not count toward the minute between events; it may also have given a line from the pot when the
    // click phrase was said recently.
    const isClick = choice.event === 'click' || choice.event === 'click-5';
    const category = isClick ? 'click' : choice.category === 'events' ? 'events' : r.category;
    s = M.record(s, { now, category, template: r.template });
    show(r.text);
  }

  async function newState(data) {
    if (!data) return;
    const first = serverMode == null;
    serverMode = M.normalizeMode(data.mascot?.mode) ?? M.DEFAULT_MODE;
    if (first) clickable(mode() !== 'off');
    if (locked()) {
      hide(true);
      return; // off on the server: no phrases, no events, nothing
    }
    const file = !!data.mascot?.file;
    if (hasFile !== file) {
      hasFile = file;
      await fetchPhrases();
    }
    numbers = data.mascotNumbers ?? null;
    const now = Date.now();
    const firstState = previous == null;
    const found = M.detect(previous, data);
    previous = data;
    if (found.vibe) s = M.vibeNow(s, now);
    say(
      M.decide({
        s,
        mode: mode(),
        now,
        reason: firstState ? 'load' : 'poll',
        events: found.events,
      }),
      now,
    );
  }

  function ownerAction() {
    const now = Date.now();
    say(M.decide({ s, mode: mode(), now, reason: 'owner-action' }), now);
  }

  function onClick() {
    if (mode() === 'off') return;
    const now = Date.now();
    const r = M.click(s, now);
    s = r.s;
    say({ category: 'events', event: r.event }, now);
  }

  // The mascot is a button (click, Enter and space) while it can talk. The zone is 52 × 104 px, above the 44 px
  // touch target floor. With mode off it is a plain picture again.
  function clickable(on) {
    if (on) {
      zone.setAttribute('role', 'button');
      zone.tabIndex = 0;
      zone.setAttribute('aria-label', 'The mascot: say something');
    } else {
      zone.removeAttribute('role');
      zone.removeAttribute('tabindex');
      zone.removeAttribute('aria-label');
    }
    zone.classList.toggle('clickable', on);
  }
  zone.addEventListener('click', onClick);
  zone.addEventListener('keydown', (e) => {
    if (mode() === 'off') return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  });

  // The random chat: a pulse every 15 s (no network), only while the tab is visible.
  setInterval(() => {
    if (document.hidden || !previous || mode() === 'off') return;
    const now = Date.now();
    say(M.decide({ s, mode: mode(), now, reason: 'pulse' }), now);
  }, PULSE_MS);

  window.QueueMascotView = {
    newState,
    ownerAction,
    mode,
    setMode,
    locked,
    MODE_OPTIONS: M.MODE_OPTIONS,
  };
})();
