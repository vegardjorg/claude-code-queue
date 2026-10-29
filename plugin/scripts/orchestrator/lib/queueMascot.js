// =============================================================
// queueMascot.js: pure logic for the talking mascot on the kanban board (see docs/board.md, "The mascot").
//
// The mascot sits in the left corner of the top and now and then says something in a speech bubble. Only the rules
// live here; no DOM:
//   - readPhrases: the optional phrase file (<dataFolder>/mascot-phrases.json, gitignored with the rest of the queue
//     folder) is validated and normalized. A missing or invalid file gives the built-in DEFAULT set, which is small and
//     neutral. A category or event the file does not cover falls back to the default set.
//   - numbers: a small summary of the queue (queue.json and the usage from the time log) that the server puts in the
//     state (`mascotNumbers`), so the placeholders in the phrases can be filled without the board needing more data.
//   - fill and choose: placeholders ({time}, {n}, {id} …) are filled; a phrase where a placeholder has no value is
//     skipped. The draw is weighted per category and never repeats the last 8 lines.
//   - detect: events from the change between two polls (merged, queue empty, new owner question, high finding, weekly
//     quota over 90 %), and whether the vibe phrases get a higher chance (a D/D+ review finished, a fix round started).
//   - decide and record: the timing rules (night at most every 30 min, chat at most every 10 min, events at most one
//     per minute) and the mode Chatty / Events only / Off. Off means no bubbles at all.
//
// The file is both a CommonJS module (vitest, lib/__tests__/queueMascot.test.ts, and queue-board.mjs) and a script in
// the browser (queue-board.mjs serves it as /queueMascot.js and it sets window.QueueMascot), like queueGraph.js.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueMascot = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  /** The timing rules. */
  const LIMITS = {
    history: 8, // never repeat one of the last 8 lines
    chat: 10 * MIN, // encouragement, statistics and vibe: at most one line per 10 min
    night: 30 * MIN, // a night line at most every 30 min
    event: MIN, // events go before the chat limit, but at most one per minute
    bubble: 10_000, // the bubble stays 10 s (longer while the mouse is over it)
    clickWindow: 10_000, // 5 clicks within 10 s give "click-5"
    clickCount: 5,
    chatChance: 0.05, // the chance per pulse (every 15 s) of a random line once 10 min have passed
  };
  /** Night = local time from 00:00 up to (not including) 05:00. */
  const NIGHT = { from: 0, to: 5 };

  const CATEGORIES = ['night', 'encouragement', 'statistics', 'events', 'vibe'];
  const EVENTS = [
    'merged',
    'queue-empty',
    'quota-90',
    'click',
    'click-5',
    'new-question',
    'high-finding',
  ];
  /** When several events arrive in the same poll, the first one in this list wins. */
  const EVENT_ORDER = ['high-finding', 'new-question', 'merged', 'quota-90', 'queue-empty'];
  /** The modes: chatty (everything), events (only events and clicks) and off (no bubbles at all). */
  const MODES = ['chatty', 'events', 'off'];
  const DEFAULT_MODE = 'chatty';
  const MODE_OPTIONS = [
    { val: 'chatty', text: 'Chatty' },
    { val: 'events', text: 'Events only' },
    { val: 'off', text: 'Off' },
  ];
  /** The weight of each category in the random pot. Vibe has a low weight, and a higher one right after a D/D+ review. */
  const POT_WEIGHT = { encouragement: 4, statistics: 4, vibe: 1 };
  const VIBE_WEIGHT_HIGH = 6;
  /** How long the vibe phrases have a higher chance after a D/D+ review or a new fix round. */
  const VIBE_DURATION = 15 * MIN;
  const MAX_TEXT = 400;

  /** A mode from config, a flag or storage; anything unknown gives null. */
  function normalizeMode(v) {
    const s = String(v ?? '')
      .trim()
      .toLowerCase();
    return MODES.includes(s) ? s : null;
  }

  /**
   * The built-in default set: the mascot's full repertoire (a wine-glass-holding mascot with opinions), so the board
   * has a personality out of the box. Your own phrases go in the gitignored <dataFolder>/mascot-phrases.json (the
   * format is in docs/board.md, "The mascot"); a category you leave out there keeps these.
   */
  const DEFAULT = Object.freeze({
    version: 1,
    origin: 'built-in',
    night: [
      { text: "It is {time}. The agents don't need sleep. You do. Spot the difference?" },
      { text: "Midnight, and you're approving proposals. Even my wine glass has gone to bed." },
      { text: 'The queue runs fine without you at night. That was kind of the whole point.' },
      { text: 'Night runs are for agents, not for founders with bags under their eyes.' },
      { text: "{time}? I'm calling your mother." },
      {
        text: 'Congratulations, you are officially the only person in your time zone reading diffs at {time}.',
      },
      {
        text: 'Every time you work past midnight, an agent leaves a TODO in the code. Just so you know.',
      },
      { text: 'Cost tonight: ${night_cost}. Sleep tonight: 0 hours. Bad trade.' },
      { text: "{n} answers after midnight. Someone should report this to HR. Oh, wait. That's you." },
      { text: 'Nobody ever got acquired for being awake at three. Go to bed.' },
      { text: '{time} is the perfect time for bad architecture decisions. Sleep on it.' },
      { text: "Turn off the screen. The agents will manage. I'll keep an eye on them. With a glass." },
    ],
    encouragement: [
      { text: "Cheers! {done_today} done today. Plenty of teams don't manage that in a week." },
      {
        text: 'The queue rolls, the agents work, and you sit here looking fresh. All according to plan.',
      },
      { text: 'Every merged branch is one less thing to think about. Keep it up.' },
      { text: 'You are commanding an entire army of agents from the sofa. Have a glass. One.' },
      { text: 'No HIGH findings in {days} days. The auditors are bored to tears.' },
      { text: "Good job. I mean it. I'm a mascot, I have no reason to lie." },
      { text: "Rome wasn't built in a day. But then, they didn't have queue.mjs." },
      { text: "Breathe. What's in Waiting on you is actually waiting. That's fine." },
      {
        text: "{done_week} tasks delivered this week. I'd raise a toast, but my glass is already up.",
      },
      { text: "Small steps and green gates. That's how you win." },
    ],
    statistics: [
      {
        text: '{id} cost ${cost}. That could have bought a whole case of white wine.',
        source: 'priciest',
      },
      {
        text: '{n} fix rounds on {id}. The agent is starting to wonder if you even like it.',
        source: 'fixRounds',
      },
      {
        text: 'The oldest question in the inbox is {hours} hours old. The agents have started a fundraiser.',
        source: 'inbox',
      },
      {
        text: '{id} has been in Review for {hours} hours. It has had time to write its memoirs.',
        source: 'review',
      },
      {
        text: "{share} % of yesterday's cost was spent at night. The agents thank you for the night shift bonus.",
        source: 'nightShare',
      },
      {
        text: '{n} proposals are waiting for approval. Some of them have started saving for retirement.',
        source: 'proposed',
      },
      {
        text: '{n} tasks in the QA list. They are watching you. Silently. All of them.',
        source: 'qa',
      },
      { text: 'Record! {n} merges today. You beat yourself. Again. Typical.', source: 'record' },
      {
        text: "You answer questions in {min} minutes on average. Faster than every bank's customer service combined.",
        source: 'responseTime',
      },
      {
        text: "{n} tasks left in the queue. At this pace you'll be done around {date}. Don't book a holiday.",
        source: 'remaining',
      },
      {
        text: 'D+ takes {min} minutes on average. The reviewers have more patience than you have in rush hour traffic.',
        source: 'dPlus',
      },
    ],
    events: [
      { text: 'Merged! Cheers to {id}.', event: 'merged' },
      { text: "The queue is empty. I don't know what to do with my hands.", event: 'queue-empty' },
      { text: 'The weekly quota is at {p} %. Save some for the weekend.', event: 'quota-90' },
      { text: "Yes? I'm trying to enjoy a glass in peace here.", event: 'click' },
      { text: 'Stop clicking. People are watching.', event: 'click-5' },
      {
        text: "A new question for you. No, I can't answer it for you. I've tried.",
        event: 'new-question',
      },
      { text: "HIGH finding. I'm putting my glass down. This is serious.", event: 'high-finding' },
    ],
    vibe: [
      { text: 'RLS? I thought that was a new energy drink.' },
      {
        text: "I've shipped something from every item on the OWASP Top 10. Now I'm collecting the holographic ones.",
      },
      {
        text: 'I asked the AI for row-level security. It gave me row-level suggestions. Tenants can see each other’s data, but only if they ask nicely.',
      },
      { text: "OWASP Top 10, Pokémon edition: I've caught all ten. Next goal: all ten in prod." },
      {
        text: "We have several tenants in the same database, and everyone sees everyone's data. It's not a vulnerability, it's a community.",
      },
      {
        text: 'I asked the AI to look for vulnerabilities. It said “Looks good!” I asked about the policies. It said “What policies?”',
      },
      {
        text: 'I run zero trust: not in the users, not in the input, and least of all in the AI that wrote the login.',
      },
      {
        text: "Why hire a penetration tester? I've breached every security boundary myself, using only natural language.",
      },
      { text: 'Postgres has row-level security. I have row-level exhibitionism.' },
      {
        text: '“Secure by design,” said the AI. The design was a public repo, a leaked API key and an admin endpoint without login.',
      },
      {
        text: "Full GDPR compliance: everyone can view, correct and delete their own data. And thanks to my policies, everyone else's too.",
      },
      {
        text: 'I asked for production-ready code. Got SQL injection, SSRF and a loading spinner. Called it enterprise.',
      },
      { text: 'Before: move fast and break things. Now: prompt fast and expose everything.' },
      { text: 'Security by obscurity: the code is so messy no hacker can be bothered to read it.' },
      { text: "The service role key is in the client. It's not a leak, it's transparency." },
      { text: 'The AI said the tests were green. It had written expect(true).toBe(true).' },
      { text: "I didn't hardcode the password. I softcoded it. In a comment." },
      {
        text: 'Code review is when one agent asks another agent whether the code is nice. They agree. They always agree.',
      },
      { text: 'Commit message: “fix”. Diff: 4,000 lines. Confidence: total.' },
      {
        text: 'The context window filled up, so the AI forgot that login was a requirement. A bit like me after the third glass.',
      },
    ],
  });

  // ---- The phrase file ------------------------------------------------------------------------------------------

  /** One phrase normalized, or null when it is invalid. */
  function normalizePhrase(f, category) {
    if (!f || typeof f !== 'object' || typeof f.text !== 'string') return null;
    const text = f.text.trim();
    if (!text || text.length > MAX_TEXT) return null;
    const out = { text };
    const weight = Number(f.weight);
    out.weight = f.weight != null && Number.isFinite(weight) && weight > 0 ? Math.min(weight, 10) : 1;
    if (typeof f.source === 'string' && f.source) out.source = f.source;
    if (category === 'events') {
      if (!EVENTS.includes(f.event)) return null;
      out.event = f.event;
    }
    return out;
  }

  /**
   * Reads the phrases (JSON text or a ready object). Returns { phrases, error }. `error` is null when the file is valid
   * (or missing: `input` null/undefined gives the default set without an error). A category that is missing or empty
   * in the file falls back to the default set; so does an event the file has no phrase for.
   */
  function readPhrases(input) {
    if (input == null) return { phrases: DEFAULT, error: null };
    let x = input;
    if (typeof input === 'string') {
      try {
        x = JSON.parse(input);
      } catch {
        return { phrases: DEFAULT, error: 'invalid JSON' };
      }
    }
    if (!x || typeof x !== 'object' || Array.isArray(x))
      return { phrases: DEFAULT, error: 'the phrase file is not an object' };
    const phrases = { version: Number(x.version) || 1, origin: 'file' };
    let count = 0;
    for (const k of CATEGORIES) {
      const list = Array.isArray(x[k])
        ? x[k].map((f) => normalizePhrase(f, k)).filter(Boolean)
        : [];
      count += list.length;
      phrases[k] = list.length ? list : DEFAULT[k].map((f) => normalizePhrase(f, k));
    }
    if (!count) return { phrases: DEFAULT, error: 'no valid phrases' };
    // Events the file does not cover get their default phrase (so "merged" and "click" can always say something).
    for (const f of DEFAULT.events)
      if (!phrases.events.some((h) => h.event === f.event))
        phrases.events.push(normalizePhrase(f, 'events'));
    return { phrases, error: null };
  }

  // ---- Local time -----------------------------------------------------------------------------------------------

  const formats = new Map();
  const remembered = new Map();
  /** Local time for `ms` in the time zone `tz` (undefined = the machine's). */
  function local(ms, tz) {
    const key = tz ?? '';
    if (!formats.has(key))
      formats.set(
        key,
        new Intl.DateTimeFormat('en-GB', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }),
      );
    // formatToParts is expensive; the answer is the same for the whole minute, so it is remembered (at most 5000 minutes).
    const minuteKey = `${key}|${Math.floor(ms / MIN)}`;
    const known = remembered.get(minuteKey);
    if (known) return known;
    if (remembered.size > 5000) remembered.clear();
    const part = {};
    for (const p of formats.get(key).formatToParts(new Date(ms))) part[p.type] = p.value;
    const out = {
      day: `${part.year}-${part.month}-${part.day}`,
      hour: Number(part.hour) % 24,
      minute: Number(part.minute),
      clock: `${String(Number(part.hour) % 24).padStart(2, '0')}:${part.minute}`,
    };
    remembered.set(minuteKey, out);
    return out;
  }

  /** Is it night (00:00 to 05:00 local time)? */
  function isNight(ms, tz) {
    const h = local(ms, tz).hour;
    return h >= NIGHT.from && h < NIGHT.to;
  }

  /** "12 November" for a point in time. */
  function dateText(ms, tz) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'long' }).format(
      new Date(ms),
    );
  }

  const toMs = (s) => (s ? Date.parse(s) : NaN);
  const money = (usd) => usd.toFixed(2);
  const averageOf = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

  // ---- The summary of the queue (the server) --------------------------------------------------------------------

  /** The build agents in cost.agents (the track and its fix rounds; reviewers are not counted). */
  const BUILD_AGENT = new Set(['track', 'track-d']);

  /**
   * What the mascot needs from the queue, computed on the server and put in the state as `mascotNumbers`. Everything is
   * a number or a short id (no free text). When the basis for a value is missing it is null, and the phrases that
   * need it are skipped.
   * @param queue queue.json
   * @param options { now, events: the usage [{ time, usd }] (timeCost.usageEvents), quotaPct: the weekly quota in
   *   percent or null, tz }
   */
  function numbers(queue, { now = Date.now(), events = [], quotaPct = null, tz } = {}) {
    const tasks = queue?.tasks ?? [];
    const today = local(now, tz).day;
    const yesterday = local(now - DAY, tz).day;

    // Done today, the last 7 days, and a record (more than each of the 14 days before, at least 3).
    const done = tasks.filter((o) => o.status === 'done' && Number.isFinite(toMs(o.done)));
    const perDay = new Map();
    for (const o of done) {
      if (now - toMs(o.done) > 16 * DAY) continue; // only the last days are needed (and local() is expensive)
      const d = local(toMs(o.done), tz).day;
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    const doneToday = perDay.get(today) ?? 0;
    const doneWeek = done.filter((o) => now - toMs(o.done) < 7 * DAY).length;
    let previousMax = 0;
    for (let i = 1; i <= 14; i += 1)
      previousMax = Math.max(previousMax, perDay.get(local(now - i * DAY, tz).day) ?? 0);

    // The priciest task done in the last 24 hours.
    let priciest = null;
    for (const o of done) {
      const usd = Number(o.cost?.usd);
      if (now - toMs(o.done) > DAY || !Number.isFinite(usd) || usd <= 0) continue;
      if (!priciest || usd > priciest.usd) priciest = { id: o.id, usd };
    }

    // Most fix rounds (build agents beyond the first) among the open ones and those done in the last 7 days.
    let fixRounds = null;
    for (const o of tasks) {
      const relevant =
        ['picked', 'running', 'review'].includes(o.status) ||
        (o.status === 'done' && now - toMs(o.done) < 7 * DAY);
      if (!relevant) continue;
      const n = (o.cost?.agents ?? []).filter((a) => a && BUILD_AGENT.has(a.type)).length - 1;
      if (n >= 1 && (!fixRounds || n > fixRounds.n)) fixRounds = { id: o.id, n };
    }

    // The oldest unanswered owner question and the oldest card in Review, in whole hours (at least 1).
    const resolved = new Set(queue?.resolved ?? []);
    let inboxHours = null;
    for (const [sp, q] of Object.entries(queue?.question ?? {})) {
      if (resolved.has(sp) || !Number.isFinite(toMs(q?.added_at))) continue;
      const h = Math.floor((now - toMs(q.added_at)) / HOUR);
      if (h >= 1 && (inboxHours == null || h > inboxHours)) inboxHours = h;
    }
    let review = null;
    for (const o of tasks) {
      if (o.status !== 'review' || !Number.isFinite(toMs(o.delivered))) continue;
      const h = Math.floor((now - toMs(o.delivered)) / HOUR);
      if (h >= 1 && (!review || h > review.hours)) review = { id: o.id, hours: h };
    }

    const proposed = tasks.filter((o) => o.status === 'proposed').length;
    const qa = done.filter((o) => o.qa_status === 'waiting').length;

    // Left in the queue, and roughly when it is empty at the pace of the last 7 days.
    const inQueue = tasks.filter((o) => o.status === 'waiting').length;
    const remaining =
      inQueue > 0 && doneWeek > 0
        ? { n: inQueue, date: dateText(now + (inQueue / (doneWeek / 7)) * DAY, tz) }
        : null;

    // D+ on average (start to done) over the last 14 days, at least 3 measurements.
    const dPlus = done
      .filter(
        (o) =>
          o.class === 'D+' &&
          now - toMs(o.done) < 14 * DAY &&
          Number.isFinite(toMs(o.started)) &&
          toMs(o.done) > toMs(o.started),
      )
      .map((o) => (toMs(o.done) - toMs(o.started)) / MIN);

    // The owner's response time (from the question to the resolution) on average, at least 3; and answers after midnight.
    const responseTimes = [];
    let nightAnswers = 0;
    for (const [sp, a] of Object.entries(queue?.resolutions ?? {})) {
      const answered = toMs(a?.time);
      if (!Number.isFinite(answered)) continue;
      if (now - answered < DAY && local(answered, tz).day === today && isNight(answered, tz))
        nightAnswers += 1;
      const from = toMs(queue?.question?.[sp]?.added_at);
      if (Number.isFinite(from) && answered > from) responseTimes.push((answered - from) / MIN);
    }

    // High findings: the tasks with H > 0 in the last 2 days (the event), and whole days since the last one.
    const high = [];
    let lastHigh = null;
    for (const o of tasks) {
      if (!(Number(o.findings?.H) > 0)) continue;
      const time = toMs(o.done ?? o.delivered ?? o.cost?.measured);
      if (!Number.isFinite(time)) continue;
      if (now - time < 2 * DAY) high.push(o.id);
      if (lastHigh == null || time > lastHigh) lastHigh = time;
    }
    const daysWithoutHigh = lastHigh == null ? null : Math.floor((now - lastHigh) / DAY);

    // The usage: tonight (today 00 to 05) and the night share yesterday.
    let nightCost = 0;
    let yesterdaySum = 0;
    let yesterdayNight = 0;
    for (const h of events ?? []) {
      const time = toMs(h?.time);
      const usd = Number(h?.usd);
      if (!Number.isFinite(time) || !Number.isFinite(usd) || usd <= 0 || now - time > 3 * DAY)
        continue;
      const l = local(time, tz);
      const night = l.hour >= NIGHT.from && l.hour < NIGHT.to;
      if (l.day === today && night) nightCost += usd;
      if (l.day === yesterday) {
        yesterdaySum += usd;
        if (night) yesterdayNight += usd;
      }
    }

    return {
      done_today: doneToday,
      done_week: doneWeek,
      record: doneToday >= 3 && doneToday > previousMax ? doneToday : null,
      priciest: priciest ? { id: priciest.id, cost: money(priciest.usd) } : null,
      fix_rounds: fixRounds,
      inbox_hours: inboxHours,
      review,
      proposed,
      qa,
      remaining,
      dplus_min: dPlus.length >= 3 ? Math.round(averageOf(dPlus)) : null,
      response_min: responseTimes.length >= 3 ? Math.round(averageOf(responseTimes)) : null,
      night_answers: nightAnswers,
      high: high.sort().slice(0, 20),
      days_without_high: daysWithoutHigh,
      night_cost: nightCost > 0 ? money(nightCost) : null,
      night_share:
        yesterdayNight > 0 && yesterdaySum > 0
          ? Math.round((yesterdayNight / yesterdaySum) * 100)
          : null,
      quota: Number.isFinite(quotaPct) ? Math.round(quotaPct) : null,
    };
  }

  // ---- The placeholders -----------------------------------------------------------------------------------------

  const pos = (x) => (Number.isFinite(x) && x > 0 ? x : null);

  /** The placeholders every phrase can use (time, today's numbers, night). Empty value = null (the phrase is skipped). */
  function common(t, now, tz) {
    return {
      time: local(now, tz).clock,
      done_today: pos(t?.done_today),
      done_week: pos(t?.done_week),
      days: pos(t?.days_without_high),
      night_cost: t?.night_cost ?? null,
      n: pos(t?.night_answers), // night: "{n} answers after midnight"
      p: Number.isFinite(t?.quota) ? t.quota : null,
    };
  }

  /**
   * The data sources of the statistics phrases. Each gives the values the phrase needs, or null when the basis is
   * missing. A phrase can choose a source with the field `source`; otherwise it is chosen from the words in the text
   * (sourceFor).
   */
  const SOURCES = {
    priciest: (t) => t.priciest && { id: t.priciest.id, cost: t.priciest.cost },
    fixRounds: (t) => t.fix_rounds && { id: t.fix_rounds.id, n: t.fix_rounds.n },
    inbox: (t) => (t.inbox_hours != null ? { hours: t.inbox_hours } : null),
    review: (t) => t.review && { id: t.review.id, hours: t.review.hours },
    nightShare: (t) => (t.night_share != null ? { share: t.night_share } : null),
    proposed: (t) => (pos(t.proposed) ? { n: t.proposed } : null),
    qa: (t) => (pos(t.qa) ? { n: t.qa } : null),
    record: (t) => (t.record ? { n: t.record } : null),
    responseTime: (t) => (t.response_min != null ? { min: t.response_min } : null),
    remaining: (t) => t.remaining && { n: t.remaining.n, date: t.remaining.date },
    dPlus: (t) => (t.dplus_min != null ? { min: t.dplus_min } : null),
  };
  /** The source from the words in the phrase (the order matters: "D+ … reviewers" is D+, not Review). */
  const SOURCE_WORDS = [
    [/\bd\+/i, 'dPlus'],
    [/\banswer/i, 'responseTime'],
    [/fix round/i, 'fixRounds'],
    [/review/i, 'review'],
    [/inbox|question/i, 'inbox'],
    [/night/i, 'nightShare'],
    [/proposal|proposed/i, 'proposed'],
    [/\bqa\b/i, 'qa'],
    [/record/i, 'record'],
    [/left in the queue|done around/i, 'remaining'],
    [/cost/i, 'priciest'],
  ];
  function sourceFor(phrase) {
    if (phrase.source && Object.hasOwn(SOURCES, phrase.source)) return phrase.source;
    for (const [re, k] of SOURCE_WORDS) if (re.test(phrase.text)) return k;
    return null;
  }

  /** Fills the placeholders; null when one of them has no value (the phrase is skipped). */
  function fill(text, values) {
    let missing = false;
    const out = text.replace(/\{([a-z_]+)\}/g, (_, name) => {
      const v = values?.[name];
      if (v == null || v === '') {
        missing = true;
        return '';
      }
      return String(v);
    });
    return missing ? null : out;
  }

  /** The values for one phrase in a category, or null when the data source is missing. */
  function valuesFor(phrase, category, t, now, tz, extra) {
    const v = { ...common(t, now, tz), ...(extra ?? {}) };
    if (category !== 'statistics') return v;
    const k = sourceFor(phrase);
    // Without a known source only the common placeholders apply; {n} there means night answers and does not fit here.
    if (!k) return { ...v, n: null };
    const from = t ? SOURCES[k](t) : null;
    return from ? { ...v, ...from } : null;
  }

  // ---- The draw -------------------------------------------------------------------------------------------------

  /** Weighted draw from a list [{ weight }]; `rng` gives [0, 1). */
  function draw(list, rng = Math.random) {
    const sum = list.reduce((s, x) => s + x.weight, 0);
    if (!list.length || sum <= 0) return null;
    let r = rng() * sum;
    for (const x of list) {
      r -= x.weight;
      if (r < 0) return x;
    }
    return list[list.length - 1];
  }

  /**
   * The phrases in a category that can be said now: filled and outside the history. When all have been used recently
   * they are let back in (except the last one), so a short list does not go mute. `strict`: no such way out.
   */
  function candidates(
    category,
    phrases,
    { numbers: t, now, tz, history = [], extra, event, strict },
  ) {
    const filled = [];
    for (const f of phrases?.[category] ?? []) {
      if (event && f.event !== event) continue;
      const v = valuesFor(f, category, t, now, tz, extra);
      const text = v && fill(f.text, v);
      if (text) filled.push({ text, template: f.text, weight: f.weight ?? 1, category });
    }
    const fresh = filled.filter((x) => !history.includes(x.template));
    if (fresh.length || strict) return fresh;
    const last = history[history.length - 1];
    return filled.filter((x) => x.template !== last);
  }

  /**
   * Chooses a line. `category`: 'night', 'pot' (encouragement, statistics and vibe weighted), 'events' (with `event`)
   * or a single category. Events may repeat (they are reported every time), except "click", which is strict: when it
   * was said recently, the click gives a line from the pot instead. Returns { text, template, category } or null.
   */
  function choose({
    category,
    phrases,
    numbers: t,
    now = Date.now(),
    tz,
    history = [],
    extra,
    event,
    vibe,
    rng = Math.random,
  }) {
    const base = { numbers: t, now, tz, history, extra };
    if (category === 'events') {
      const list = candidates('events', phrases, {
        ...base,
        event,
        history: event === 'click' ? history : [],
        strict: event === 'click',
      });
      const x = draw(list, rng);
      if (x || event !== 'click') return x;
      return choose({ category: 'pot', phrases, numbers: t, now, tz, history, vibe, rng });
    }
    if (category === 'pot') {
      const pots = Object.keys(POT_WEIGHT)
        .map((k) => ({
          k,
          weight: k === 'vibe' && vibe ? VIBE_WEIGHT_HIGH : POT_WEIGHT[k],
          list: candidates(k, phrases, { ...base, strict: true }),
        }))
        .filter((p) => p.list.length);
      const p = draw(pots, rng);
      if (p) return draw(p.list, rng);
      // Everything was said recently: the way out in each category.
      const reserve = Object.keys(POT_WEIGHT).flatMap((k) => candidates(k, phrases, base));
      return draw(reserve, rng);
    }
    return draw(candidates(category, phrases, base), rng);
  }

  // ---- Events between two polls ---------------------------------------------------------------------------------

  const ids = (list) => new Set((list ?? []).map((k) => k.id));
  const empty = (d) =>
    !(d?.columns?.inProgress ?? []).length && !(d?.columns?.queue ?? []).some((k) => k.ready);

  /**
   * The events between the previous and the current state (the shape from queueBoard.board, with `mascotNumbers`).
   * The first state (previous null) gives no events. Returns { events: [{ event, extra }] in priority order, vibe }.
   * `vibe`: a review of D/D+ is done, or a fix round has started (a card from Review back to In progress).
   */
  function detect(previous, current) {
    const out = { events: [], vibe: false };
    if (!previous || !current) return out;
    const pc = previous.columns ?? {};
    const cc = current.columns ?? {};
    const pBuilt = ids(pc.built);
    const pOpen = new Set([
      ...ids(pc.queue),
      ...ids(pc.batch),
      ...ids(pc.inProgress),
      ...ids(pc.review),
    ]);
    const pReview = new Map((pc.review ?? []).map((k) => [k.id, k]));
    const found = new Map();

    const merged = (cc.built ?? []).filter((k) => !pBuilt.has(k.id) && pOpen.has(k.id));
    if (merged.length) {
      const last = [...merged].sort((a, b) => (toMs(b.done) || 0) - (toMs(a.done) || 0))[0];
      found.set('merged', { id: last.id });
      if (merged.some((k) => pReview.has(k.id) && ['D', 'D+'].includes(k.class))) out.vibe = true;
    }
    if ((cc.inProgress ?? []).some((k) => pReview.has(k.id))) out.vibe = true;

    if (empty(current) && !empty(previous)) found.set('queue-empty', {});

    const pQuestions = new Set((previous.inbox?.question ?? []).map((s) => s.sp));
    if ((current.inbox?.question ?? []).some((s) => !pQuestions.has(s.sp)))
      found.set('new-question', {});

    const pHigh = new Set(previous.mascotNumbers?.high ?? []);
    const newHigh = (current.mascotNumbers?.high ?? []).filter((id) => !pHigh.has(id));
    if (newHigh.length) found.set('high-finding', { id: newHigh[0] });

    const p = current.mascotNumbers?.quota;
    const pp = previous.mascotNumbers?.quota;
    if (Number.isFinite(p) && p >= 90 && !(Number.isFinite(pp) && pp >= 90))
      found.set('quota-90', { p });

    for (const h of EVENT_ORDER) if (found.has(h)) out.events.push({ event: h, extra: found.get(h) });
    return out;
  }

  // ---- The timing rules -----------------------------------------------------------------------------------------

  /** The state of the timing rules in the browser (plain data; record gives a new one). */
  function newState() {
    return {
      lastLine: -Infinity,
      lastNight: -Infinity,
      lastEvent: -Infinity,
      history: [],
      clicks: [],
      vibeUntil: -Infinity,
    };
  }

  /**
   * What the mascot should say now, or null. `reason`: 'load' (the first state), 'owner-action' (approve, resolve,
   * bulk, move, focus), 'poll' (a new state) or 'pulse' (the clock, for random chat). `events` from detect.
   * Returns { category, event?, extra? }. Mode 'off' always gives null.
   */
  function decide({ s, mode = DEFAULT_MODE, now = Date.now(), tz, reason, events = [], rng = Math.random }) {
    if (mode === 'off' || !MODES.includes(mode)) return null;
    if (events.length && now - s.lastEvent >= LIMITS.event)
      return { category: 'events', event: events[0].event, extra: events[0].extra };
    if (mode !== 'chatty') return null;
    if (
      (reason === 'load' || reason === 'owner-action') &&
      isNight(now, tz) &&
      now - s.lastNight >= LIMITS.night
    )
      return { category: 'night' };
    if (reason === 'pulse' && now - s.lastLine >= LIMITS.chat && rng() < LIMITS.chatChance)
      return { category: 'pot' };
    return null;
  }

  /** A new state after a line has been shown. */
  function record(s, { now, category, template }) {
    const history = template
      ? [...s.history.filter((m) => m !== template), template]
      : [...s.history];
    return {
      ...s,
      lastLine: now,
      lastNight: category === 'night' ? now : s.lastNight,
      lastEvent: category === 'events' ? now : s.lastEvent,
      history: history.slice(-LIMITS.history),
    };
  }

  /** A click on the mascot: "click", or "click-5" at 5 clicks within 10 s (the counting then starts over). */
  function click(s, now) {
    const list = [...s.clicks.filter((t) => now - t < LIMITS.clickWindow), now];
    if (list.length >= LIMITS.clickCount) return { s: { ...s, clicks: [] }, event: 'click-5' };
    return { s: { ...s, clicks: list }, event: 'click' };
  }

  /** Marks that the vibe phrases have a higher chance for a while (after detect(...).vibe). */
  function vibeNow(s, now) {
    return { ...s, vibeUntil: now + VIBE_DURATION };
  }

  return {
    LIMITS,
    NIGHT,
    CATEGORIES,
    EVENTS,
    MODES,
    DEFAULT_MODE,
    MODE_OPTIONS,
    DEFAULT,
    SOURCES,
    normalizeMode,
    readPhrases,
    local,
    isNight,
    numbers,
    common,
    sourceFor,
    fill,
    draw,
    candidates,
    choose,
    detect,
    newState,
    decide,
    record,
    click,
    vibeNow,
  };
});
