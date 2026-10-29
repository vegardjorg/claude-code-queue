// =============================================================
// queueMascot.test.ts: the talking mascot on the kanban board (lib/queueMascot.js).
//
// The tests prove that the mascot:
//   - draws weighted without repeating the last 8 lines (and does not go mute with a short list),
//   - fills the placeholders from the state and skips a phrase when a value is missing (also {p}),
//   - computes night (00:00 to 05:00 local time) correctly over midnight,
//   - keeps the timing rules (night every 30 min, chat every 10 min, events at most one per minute) with fixture time,
//   - honours the modes Chatty, Events only and Off (Off never says anything),
//   - finds the events from two states (merged, queue empty, new question, high finding, quota, vibe),
//   - tolerates an invalid phrase file (the default set, with the error reported).
// The phrases in the tests are made here.
// =============================================================
import { describe, it, expect } from 'vitest';

const M = require('../queueMascot') as any;

const TZ = 'Europe/Oslo';
// 27.10.2026 is after daylight saving time: Oslo = UTC+1.
const at = (localTime: string) => Date.parse(`2026-10-27T${localTime}:00+01:00`);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** An rng that gives the values in order (and then the last one). */
const fixed = (...xs: number[]) => {
  let i = 0;
  return () => xs[Math.min(i++, xs.length - 1)];
};

const phrases = (over: Record<string, unknown> = {}) =>
  M.readPhrases({
    version: 1,
    night: [{ text: 'The clock is {time}.' }],
    encouragement: [{ text: 'E1' }, { text: 'E2 {done_today} today' }],
    statistics: [{ text: '{id} has cost {cost} dollars.' }],
    events: [
      { text: 'Merged {id}!', event: 'merged' },
      { text: 'The weekly quota is {p} %.', event: 'quota-90' },
      { text: 'Click.', event: 'click' },
      { text: 'Stop.', event: 'click-5' },
    ],
    vibe: [{ text: 'V1' }],
    ...over,
  }).phrases;

describe('the phrase file', () => {
  it('no file: the default set without an error', () => {
    const r = M.readPhrases(undefined);
    expect(r.error).toBeNull();
    expect(r.phrases).toBe(M.DEFAULT);
  });

  it('invalid JSON, wrong type and no valid phrases give the default set and an error', () => {
    expect(M.readPhrases('{ not json').error).toBe('invalid JSON');
    expect(M.readPhrases('[1,2]').error).toMatch(/not an object/);
    const none = M.readPhrases({
      night: [{ text: '' }, { x: 1 }],
      events: [{ text: 'a', event: 'unknown' }],
    });
    expect(none.error).toBe('no valid phrases');
    expect(none.phrases).toBe(M.DEFAULT);
  });

  it('the default set is the full repertoire, and every phrase in it is valid', () => {
    const count = M.CATEGORIES.reduce((n: number, k: string) => n + M.DEFAULT[k].length, 0);
    expect(count).toBeGreaterThanOrEqual(40);
    expect(count).toBeLessThanOrEqual(200);
    // Read through readPhrases as if it were a file: nothing is dropped.
    const again = M.readPhrases(JSON.parse(JSON.stringify(M.DEFAULT))).phrases;
    for (const k of M.CATEGORIES) expect(again[k].length).toBe(M.DEFAULT[k].length);
  });

  it('empty categories and missing events fall back to the default', () => {
    const f = M.readPhrases(JSON.stringify({ encouragement: [{ text: 'Hi {time}' }] })).phrases;
    expect(f.encouragement.map((x: any) => x.text)).toEqual(['Hi {time}']);
    expect(f.events.map((x: any) => x.event).sort()).toEqual(
      M.DEFAULT.events.map((x: any) => x.event).sort(),
    );
  });
});

describe('the modes', () => {
  it('normalizeMode accepts the three modes and nothing else', () => {
    expect(M.MODES).toEqual(['chatty', 'events', 'off']);
    expect(M.normalizeMode(' OFF ')).toBe('off');
    expect(M.normalizeMode('events')).toBe('events');
    expect(M.normalizeMode('quiet')).toBeNull();
    expect(M.normalizeMode(undefined)).toBeNull();
    expect(M.MODE_OPTIONS.map((o: any) => o.text)).toEqual(['Chatty', 'Events only', 'Off']);
  });

  it('isPassword: the bar password, case, punctuation and extra spaces do not matter', () => {
    for (const ok of ['Ken sent me', 'ken sent me.', 'KEN SENT ME!', ' ken  sent me ', '"Ken sent me."'])
      expect(M.isPassword(ok)).toBe(true);
    for (const no of ['ken', 'kensentme', 'ken sent you', '', null, undefined]) expect(M.isPassword(no)).toBe(false);
  });
});

describe('night over midnight', () => {
  it('00:00 to 04:59 is night, 05:00 and 23:59 are not', () => {
    expect(M.isNight(at('00:00'), TZ)).toBe(true);
    expect(M.isNight(at('04:59'), TZ)).toBe(true);
    expect(M.isNight(at('05:00'), TZ)).toBe(false);
    expect(M.isNight(at('23:59'), TZ)).toBe(false);
    expect(M.local(at('00:07'), TZ)).toMatchObject({ day: '2026-10-27', hour: 0, clock: '00:07' });
    // 23:59 the evening before is the previous day.
    expect(M.local(at('00:00') - MIN, TZ).day).toBe('2026-10-26');
  });
});

describe('placeholders', () => {
  it('fills all or none', () => {
    expect(M.fill('{a} and {b}', { a: 1, b: 'x' })).toBe('1 and x');
    expect(M.fill('{a} and {b}', { a: 1 })).toBeNull();
    expect(M.fill('{a}', { a: '' })).toBeNull();
    expect(M.fill('plain', {})).toBe('plain');
  });

  it('skips the phrase when data is missing, also {p}', () => {
    const f = phrases();
    const t = { priciest: { id: 'X-1', cost: '5.79' }, quota: null };
    const s = M.candidates('statistics', f, { numbers: t, now: at('12:00'), tz: TZ, history: [] });
    expect(s.map((x: any) => x.text)).toEqual(['X-1 has cost 5.79 dollars.']);
    // Without the priciest: nothing to say.
    expect(
      M.candidates('statistics', f, { numbers: {}, now: at('12:00'), tz: TZ, history: [] }),
    ).toEqual([]);
    // The quota event without a number is skipped; with a number it is filled.
    expect(
      M.choose({
        category: 'events',
        event: 'quota-90',
        phrases: f,
        numbers: {},
        now: at('12:00'),
        tz: TZ,
      }),
    ).toBeNull();
    expect(
      M.choose({
        category: 'events',
        event: 'quota-90',
        phrases: f,
        numbers: {},
        extra: { p: 93 },
        now: at('12:00'),
        tz: TZ,
      }).text,
    ).toBe('The weekly quota is 93 %.');
  });

  it('zero in a day count counts as missing ({done_today} = 0 says nothing)', () => {
    const f = phrases();
    const texts = (t: any) =>
      M.candidates('encouragement', f, { numbers: t, now: at('12:00'), tz: TZ, history: [] }).map(
        (x: any) => x.text,
      );
    expect(texts({ done_today: 0 })).toEqual(['E1']);
    expect(texts({ done_today: 4 })).toEqual(['E1', 'E2 4 today']);
  });

  it('{time} is the local clock', () => {
    const r = M.choose({ category: 'night', phrases: phrases(), numbers: {}, now: at('02:05'), tz: TZ });
    expect(r.text).toBe('The clock is 02:05.');
  });

  it('the source is chosen from the words, D+ before Review', () => {
    expect(M.sourceFor({ text: 'D+ takes {min} min. The reviewers …' })).toBe('dPlus');
    expect(M.sourceFor({ text: '{id} has been in Review for {hours} hours.' })).toBe('review');
    expect(M.sourceFor({ text: 'Free text', source: 'qa' })).toBe('qa');
  });
});

describe('drawing without repetition', () => {
  const many = M.readPhrases({
    encouragement: Array.from({ length: 12 }, (_, i) => ({ text: `F${i}` })),
  }).phrases;

  it('does not repeat the last 8 in a long series', () => {
    let s = M.newState();
    let rng = 0.13;
    const said: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      rng = ((rng * 9301 + 49297) % 233280) / 233280; // a simple deterministic series
      const r = M.choose({
        category: 'encouragement',
        phrases: many,
        numbers: {},
        now: 0,
        history: s.history,
        rng: () => rng,
      });
      expect(s.history).not.toContain(r.template);
      said.push(r.template);
      s = M.record(s, { now: i, category: 'encouragement', template: r.template });
      expect(s.history.length).toBeLessThanOrEqual(8);
    }
    for (let i = 8; i < said.length; i += 1) expect(said.slice(i - 8, i)).not.toContain(said[i]);
  });

  it('a short list does not go mute, but never repeats the last one', () => {
    const f = M.readPhrases({ encouragement: [{ text: 'A' }, { text: 'B' }] }).phrases;
    const r = M.choose({
      category: 'encouragement',
      phrases: f,
      numbers: {},
      now: 0,
      history: ['A', 'B'],
      rng: () => 0,
    });
    expect(r.template).toBe('A');
    const r2 = M.choose({
      category: 'encouragement',
      phrases: f,
      numbers: {},
      now: 0,
      history: ['B', 'A'],
      rng: () => 0,
    });
    expect(r2.template).toBe('B');
  });

  it('the weighted draw follows the weight', () => {
    const list = [
      { weight: 1, x: 'a' },
      { weight: 3, x: 'b' },
    ];
    expect(M.draw(list, () => 0.2).x).toBe('a');
    expect(M.draw(list, () => 0.3).x).toBe('b');
    expect(M.draw([], () => 0)).toBeNull();
  });

  it('the pot gives vibe a higher weight right after a D/D+ review', () => {
    const f = phrases();
    // Pots in order encouragement (4), statistics (empty here), vibe (1 or 6).
    const usual = M.choose({
      category: 'pot',
      phrases: f,
      numbers: {},
      now: at('12:00'),
      tz: TZ,
      rng: fixed(0.75, 0),
    });
    expect(usual.category).toBe('encouragement');
    const boost = M.choose({
      category: 'pot',
      phrases: f,
      numbers: {},
      now: at('12:00'),
      tz: TZ,
      vibe: true,
      rng: fixed(0.5, 0),
    });
    expect(boost.category).toBe('vibe');
  });

  it('click is strict: said recently gives a line from the pot', () => {
    const f = phrases();
    const r = M.choose({
      category: 'events',
      event: 'click',
      phrases: f,
      numbers: {},
      now: 0,
      history: ['Click.'],
      rng: () => 0,
    });
    expect(r.category).toBe('encouragement');
    // Other events may repeat.
    const m = M.choose({
      category: 'events',
      event: 'merged',
      phrases: f,
      numbers: {},
      extra: { id: 'A-1' },
      now: 0,
      history: ['Merged {id}!'],
    });
    expect(m.text).toBe('Merged A-1!');
  });
});

describe('the timing rules', () => {
  const s0 = M.newState();

  it('night on the first load and on an owner action, at most every 30 min, never on a pulse', () => {
    expect(M.decide({ s: s0, now: at('01:00'), tz: TZ, reason: 'load' })).toEqual({
      category: 'night',
    });
    expect(M.decide({ s: s0, now: at('12:00'), tz: TZ, reason: 'load' })).toBeNull();
    const s1 = M.record(s0, { now: at('01:00'), category: 'night', template: 'n' });
    expect(M.decide({ s: s1, now: at('01:29'), tz: TZ, reason: 'owner-action' })).toBeNull();
    expect(M.decide({ s: s1, now: at('01:30'), tz: TZ, reason: 'owner-action' })).toEqual({
      category: 'night',
    });
    expect(M.decide({ s: s1, now: at('02:30'), tz: TZ, reason: 'pulse', rng: () => 0 })).toEqual({
      category: 'pot',
    });
  });

  it('chat at most once per 10 min, and only when the chance hits', () => {
    const s1 = M.record(s0, { now: at('12:00'), category: 'encouragement', template: 'x' });
    expect(M.decide({ s: s1, now: at('12:09'), tz: TZ, reason: 'pulse', rng: () => 0 })).toBeNull();
    expect(M.decide({ s: s1, now: at('12:10'), tz: TZ, reason: 'pulse', rng: () => 0 })).toEqual({
      category: 'pot',
    });
    expect(
      M.decide({ s: s1, now: at('12:10'), tz: TZ, reason: 'pulse', rng: () => 0.99 }),
    ).toBeNull();
  });

  it('events go before the chat limit, but at most one per minute', () => {
    const h = [{ event: 'merged', extra: { id: 'A' } }];
    const s1 = M.record(s0, { now: at('12:00'), category: 'encouragement', template: 'x' });
    expect(
      M.decide({ s: s1, now: at('12:00') + 1000, tz: TZ, reason: 'poll', events: h }),
    ).toMatchObject({ category: 'events', event: 'merged' });
    const s2 = M.record(s1, { now: at('12:01'), category: 'events', template: 'f' });
    expect(
      M.decide({ s: s2, now: at('12:01') + 59_000, tz: TZ, reason: 'poll', events: h }),
    ).toBeNull();
    expect(M.decide({ s: s2, now: at('12:02'), tz: TZ, reason: 'poll', events: h })).not.toBeNull();
  });

  it('Events only skips chat and night; Off says nothing at all', () => {
    const h = [{ event: 'queue-empty', extra: {} }];
    expect(
      M.decide({ s: s0, mode: 'events', now: at('01:00'), tz: TZ, reason: 'load' }),
    ).toBeNull();
    expect(
      M.decide({ s: s0, mode: 'events', now: at('12:00'), tz: TZ, reason: 'poll', events: h }),
    ).not.toBeNull();
    for (const reason of ['load', 'owner-action', 'poll', 'pulse'])
      expect(
        M.decide({
          s: s0,
          mode: 'off',
          now: at('01:00'),
          tz: TZ,
          reason,
          events: h,
          rng: () => 0,
        }),
      ).toBeNull();
    // An unknown mode is treated as off, never as chatty.
    expect(
      M.decide({ s: s0, mode: 'loud', now: at('12:00'), tz: TZ, reason: 'poll', events: h }),
    ).toBeNull();
  });

  it('5 clicks within 10 s give click-5, and the counting starts over', () => {
    let s = s0;
    const answers: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = M.click(s, 1000 * i);
      s = r.s;
      answers.push(r.event);
    }
    expect(answers).toEqual(['click', 'click', 'click', 'click', 'click-5', 'click']);
    // Clicks more than 10 s apart do not count together.
    let t = s0;
    for (let i = 0; i < 5; i += 1) t = M.click(t, 11_000 * i).s;
    expect(M.click(t, 55_000).event).toBe('click');
  });
});

describe('events from two states', () => {
  const card = (id: string, over: Record<string, unknown> = {}) => ({ id, class: 'K', ...over });
  const state = (over: any = {}) => ({
    columns: {
      queue: [card('Q', { ready: true })],
      batch: [],
      inProgress: [card('P')],
      review: [],
      built: [],
      ...(over.columns ?? {}),
    },
    inbox: { question: over.question ?? [] },
    mascotNumbers: { high: [], quota: null, ...(over.mascotNumbers ?? {}) },
  });

  it('the first state gives nothing', () => {
    expect(M.detect(null, state())).toEqual({ events: [], vibe: false });
  });

  it('merged (from Review, D+ gives vibe), and the priority', () => {
    const before = state({
      columns: { review: [card('R', { class: 'D+' })] },
      question: [{ sp: 'S1' }],
    });
    const after = state({
      columns: {
        review: [],
        built: [card('R', { class: 'D+', done: '2026-10-27T10:00:00Z' })],
      },
      question: [{ sp: 'S1' }, { sp: 'S2' }],
      mascotNumbers: { high: ['R'] },
    });
    const r = M.detect(before, after);
    expect(r.events.map((h: any) => h.event)).toEqual(['high-finding', 'new-question', 'merged']);
    expect(r.events[2].extra).toEqual({ id: 'R' });
    expect(r.vibe).toBe(true);
  });

  it('a fix round (Review back to In progress) gives vibe', () => {
    const r = M.detect(
      state({ columns: { review: [card('R')], inProgress: [] } }),
      state({ columns: { review: [], inProgress: [card('R')] } }),
    );
    expect(r).toEqual({ events: [], vibe: true });
  });

  it('queue empty: nothing active and nothing ready, only at the transition', () => {
    const empty = state({ columns: { inProgress: [], queue: [card('Q', { ready: false })] } });
    expect(M.detect(state(), empty).events.map((h: any) => h.event)).toEqual(['queue-empty']);
    expect(M.detect(empty, empty).events).toEqual([]);
  });

  it('quota over 90 % at the transition', () => {
    const r = M.detect(
      state({ mascotNumbers: { quota: 85 } }),
      state({ mascotNumbers: { quota: 91 } }),
    );
    expect(r.events).toEqual([{ event: 'quota-90', extra: { p: 91 } }]);
    expect(
      M.detect(state({ mascotNumbers: { quota: 92 } }), state({ mascotNumbers: { quota: 95 } }))
        .events,
    ).toEqual([]);
  });
});

describe('the summary of the queue (numbers)', () => {
  const now = at('02:30');
  const iso = (ms: number) => new Date(ms).toISOString();
  const queue = {
    resolved: ['S-OLD'],
    question: {
      'S-NEW': { added_at: iso(now - 5 * HOUR) },
      'S-OLD': { added_at: iso(now - 50 * HOUR) },
    },
    resolutions: { 'S-OLD': { time: iso(at('01:00')) } },
    tasks: [
      {
        id: 'A',
        status: 'done',
        done: iso(at('00:30')),
        class: 'K',
        cost: { usd: 3.5, agents: [{ type: 'track' }] },
      },
      {
        id: 'B',
        status: 'done',
        done: iso(at('01:30')),
        class: 'D',
        qa_status: 'waiting',
        findings: { H: 1, M: 0, L: 0 },
        cost: {
          usd: 12.25,
          agents: [
            { type: 'track-d' },
            { type: 'track-d' },
            { type: 'track-d' },
            { type: 'reviewer-security' },
          ],
        },
      },
      { id: 'C', status: 'review', delivered: iso(now - 3 * HOUR - MIN) },
      { id: 'D', status: 'proposed' },
      { id: 'E', status: 'waiting' },
    ],
  };
  const events = [
    { time: iso(at('01:00')), usd: 2 },
    { time: iso(at('03:00') - 24 * HOUR), usd: 1 }, // last night
    { time: iso(at('12:00') - 24 * HOUR), usd: 3 }, // yesterday daytime
  ];

  it('computes the numbers the mascot uses', () => {
    const t = M.numbers(queue, { now, events, quotaPct: 91.6, tz: TZ });
    expect(t).toMatchObject({
      done_today: 2,
      done_week: 2,
      priciest: { id: 'B', cost: '12.25' },
      fix_rounds: { id: 'B', n: 2 },
      inbox_hours: 5,
      review: { id: 'C', hours: 3 },
      proposed: 1,
      qa: 1,
      night_answers: 1,
      high: ['B'],
      days_without_high: 0,
      night_cost: '2.00',
      night_share: 25,
      quota: 92,
      response_min: null,
      dplus_min: null,
    });
    expect(t.remaining.n).toBe(1);
    expect(typeof t.remaining.date).toBe('string');
  });

  it('an empty queue gives null where the basis is missing', () => {
    const t = M.numbers({}, { now, tz: TZ });
    expect(t).toMatchObject({
      priciest: null,
      fix_rounds: null,
      review: null,
      night_cost: null,
      quota: null,
      days_without_high: null,
    });
  });
});
