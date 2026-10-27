// =============================================================
// tidKost.test.ts: riktig måling av agentforbruk (lib/tidKost.js). Kumulative
// «ferdig»-rader skal ikke dobbelttelles, forbruket fordeles på lokalt døgn, cache-skriving prises etter type, spor-id-er
// med bindestrek gjenkjennes, og cache-utløp telles fra transkriptet.
// =============================================================
import { describe, it, expect } from 'vitest';

type Tokens = {
  input?: number;
  output?: number;
  cache_lest?: number;
  cache_skrevet?: number;
  cache_skrevet_5m?: number;
  cache_skrevet_1t?: number;
};
type Rad = {
  tid: string;
  hendelse: string;
  spor?: string;
  agent_id?: string | null;
  agent_type?: string | null;
  tokens?: Tokens;
  modell?: string;
  modellturer?: number;
  cache_utlop?: number;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../tidKost') as {
  kostUsd: (t: Tokens, modell?: string) => number;
  sporFraTekst: (t: string) => string | null;
  analyserTranskript: (t: string) => {
    tokens: Required<Tokens>;
    modellturer: number;
    verktoykall: number;
    modell: string | null;
    cache_utlop: number;
    kost_usd: number;
    spor: string | null;
    forste_endring_s: number | null;
  };
  dagFor: (iso: string, tz?: string) => string | null;
  lesRader: (t: string) => Rad[];
  forbruksHendelser: (r: Rad[]) => { agent: string; dag: string; usd: number }[];
  dagsforbruk: (r: Rad[], dag: string) => number;
  oppsummerKost: (
    r: Rad[],
    v?: { dag?: string | null; klasseFor?: (s: string) => string | null },
  ) => {
    total: number;
    perType: { type: string; usd: number; agenter: number; andel: number }[];
    perSpor: { spor: string; usd: number }[];
    perKlasse: { klasse: string; usd: number }[];
  };
  dedupliserFerdig: (r: Rad[]) => Rad[];
  oppgaveIdFor: (spor: string, finnes: (x: string) => boolean) => string | null;
};

const MILL = 1_000_000;

describe('pris (API-ekvivalent, listepriser fra utredningen)', () => {
  it('Opus 5.5: input 4, output 20, cache-lesing 0,20, skriving 5 min 5 og 1 t 8 USD per MTok', () => {
    expect(T.kostUsd({ input: MILL })).toBeCloseTo(4);
    expect(T.kostUsd({ output: MILL })).toBeCloseTo(20);
    expect(T.kostUsd({ cache_lest: MILL })).toBeCloseTo(0.2);
    expect(
      T.kostUsd({ cache_skrevet: MILL, cache_skrevet_5m: MILL, cache_skrevet_1t: 0 }),
    ).toBeCloseTo(5);
    expect(
      T.kostUsd({ cache_skrevet: MILL, cache_skrevet_5m: 0, cache_skrevet_1t: MILL }),
    ).toBeCloseTo(8);
  });

  it('eldre rader med bare summen prises som 5 min (subagenter har 5 minutters cache)', () => {
    expect(T.kostUsd({ cache_skrevet: 2 * MILL })).toBeCloseTo(10);
  });
});

describe('spor-id fra oppdraget', () => {
  it('prompt-fila med bindestrek og bokstav først (den gamle regexen tok bare [A-Za-z0-9]+)', () => {
    expect(
      T.sporFraTekst('Oppdraget står i C:\\x\\scratchpad\\prompt-A-1b.md og er bindende'),
    ).toBe('A-1b');
    expect(T.sporFraTekst('prompt-B4-r2.md')).toBe('B4-r2');
  });

  it('«spor <ID>» og «SPOR <ID>», men ikke vanlige ord etter «spor»', () => {
    expect(T.sporFraTekst('Du er spor D-2b i den kontinuerlige køen.')).toBe('D-2b');
    expect(T.sporFraTekst('## SPOR C-E3a (tittel)')).toBe('C-E3a');
    expect(T.sporFraTekst('Du er ett spor i en parallell bølge')).toBeNull();
  });

  it('retterunder hører til oppgaven i køen', () => {
    const ko = new Set(['B4', 'A-1b']);
    expect(T.oppgaveIdFor('B4-r2', (x) => ko.has(x))).toBe('B4');
    expect(T.oppgaveIdFor('A-1b', (x) => ko.has(x))).toBe('A-1b');
    expect(T.oppgaveIdFor('ukjent-r1', (x) => ko.has(x))).toBeNull();
  });
});

describe('transkriptanalyse', () => {
  const linje = (o: object) => JSON.stringify(o);
  const tur = (id: string, ts: string, usage: object, innhold: object[] = []) =>
    linje({
      type: 'assistant',
      timestamp: ts,
      message: { id, model: 'claude-opus-5-5', usage, content: innhold },
    });
  const transkript = [
    linje({
      type: 'user',
      timestamp: '2026-09-30T10:00:00Z',
      message: { content: 'Du er spor A-1b. Oppdraget står i prompt-A-1b.md' },
    }),
    tur(
      'm1',
      '2026-09-30T10:00:05Z',
      {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 50_000,
        cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 0 },
      },
      [{ type: 'tool_use', id: 't1', name: 'Read' }],
    ),
    // Samme melding strømmet over to linjer: telles én gang.
    tur('m1', '2026-09-30T10:00:06Z', {
      input_tokens: 10,
      output_tokens: 120,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 50_000,
      cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 0 },
    }),
    tur(
      'm2',
      '2026-09-30T10:01:00Z',
      {
        input_tokens: 5,
        output_tokens: 50,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 1_000,
      },
      [{ type: 'tool_use', id: 't2', name: 'Edit' }],
    ),
    // 8 minutters pause: cachen (5 min) gikk ut, hele konteksten skrives på nytt.
    tur('m3', '2026-09-30T10:09:00Z', {
      input_tokens: 5,
      output_tokens: 50,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 31_000,
      cache_creation: { ephemeral_5m_input_tokens: 31_000, ephemeral_1h_input_tokens: 0 },
    }),
  ].join('\n');

  it('tokens per type, turer deduplisert per message.id, spor fra oppdraget', () => {
    const a = T.analyserTranskript(transkript);
    expect(a.modellturer).toBe(3);
    expect(a.tokens.output).toBe(120 + 50 + 50);
    expect(a.tokens.cache_skrevet).toBe(82_000);
    expect(a.tokens.cache_skrevet_5m).toBe(82_000); // m2 uten fordeling regnes som 5 min
    expect(a.tokens.cache_skrevet_1t).toBe(0);
    expect(a.spor).toBe('A-1b');
    expect(a.modell).toBe('claude-opus-5-5');
    expect(a.verktoykall).toBe(2);
    expect(a.forste_endring_s).toBe(60);
  });

  it('cache-utløp: pause over 5 min før en tur som skriver mer enn den leser', () => {
    expect(T.analyserTranskript(transkript).cache_utlop).toBe(1);
  });

  it('kost_usd stemmer med prisene', () => {
    const a = T.analyserTranskript(transkript);
    expect(a.kost_usd).toBeCloseTo(Math.round(T.kostUsd(a.tokens, 'claude-opus-5-5') * 100) / 100);
  });
});

describe('dedupliserte forbruksrader', () => {
  // Agent A stoppet to ganger (kumulative rader), over midnatt norsk tid; agent B én gang.
  const rader: Rad[] = [
    { tid: '2026-09-29T21:00:00Z', hendelse: 'start', spor: 'A1', agent_id: 'a' },
    {
      tid: '2026-09-29T21:30:00Z',
      hendelse: 'ferdig',
      spor: 'A1',
      agent_id: 'a',
      agent_type: 'spor',
      tokens: { output: MILL }, // 20 USD kumulativt
    },
    {
      tid: '2026-09-29T23:00:00Z', // 01:00 norsk tid 30.09
      hendelse: 'ferdig',
      spor: 'A1',
      agent_id: 'a',
      agent_type: 'spor',
      tokens: { output: 1.5 * MILL }, // 30 USD kumulativt: 10 USD ny i dag
    },
    {
      tid: '2026-09-30T10:00:00Z',
      hendelse: 'ferdig',
      spor: 'A1',
      agent_id: 'r',
      agent_type: 'reviewer',
      tokens: { input: MILL }, // 4 USD
    },
    { tid: '2026-09-30T11:00:00Z', hendelse: 'gate', spor: 'A1' },
  ];

  it('summen er siste rad per agent, aldri summen av kumulative rader', () => {
    const o = T.oppsummerKost(rader);
    expect(o.total).toBeCloseTo(34);
    expect(o.perType.find((t) => t.type === 'spor')).toMatchObject({ usd: 30, agenter: 1 });
    expect(o.perType.find((t) => t.type === 'reviewer')).toMatchObject({ usd: 4, agenter: 1 });
  });

  it('forbruket fordeles på lokalt døgn (tilveksten havner på dagen den skjedde)', () => {
    expect(T.dagFor('2026-09-29T23:00:00Z')).toBe('2026-09-30');
    expect(T.dagsforbruk(rader, '2026-09-29')).toBeCloseTo(20);
    expect(T.dagsforbruk(rader, '2026-09-30')).toBeCloseTo(14);
    expect(T.oppsummerKost(rader, { dag: '2026-09-30' }).total).toBeCloseTo(14);
  });

  it('per klasse og per spor (reviewen telles på sporet den gjaldt)', () => {
    const o = T.oppsummerKost(rader, { klasseFor: (s) => (s === 'A1' ? 'D' : null) });
    expect(o.perKlasse).toEqual([{ klasse: 'D', usd: 34 }]);
    expect(o.perSpor[0]).toMatchObject({ spor: 'A1', usd: 34 });
  });

  it('--vis viser bare siste «ferdig»-rad per agent, alt annet uendret', () => {
    const vist = T.dedupliserFerdig(rader);
    expect(vist.filter((r) => r.hendelse === 'ferdig' && r.agent_id === 'a')).toHaveLength(1);
    expect(vist.find((r) => r.agent_id === 'a' && r.hendelse === 'ferdig')?.tid).toBe(
      '2026-09-29T23:00:00Z',
    );
    expect(vist).toHaveLength(rader.length - 1);
  });

  it('ødelagte linjer (samtidige skrivere) hoppes over', () => {
    expect(T.lesRader('{"a":1}\n{"halv\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
