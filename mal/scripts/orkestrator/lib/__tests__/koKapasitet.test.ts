// =============================================================
// koKapasitet.test.ts: ukekvotemodellen i arbeidskøen (scripts/orkestrator/lib/koKapasitet.js).
//
// Beviser: nullstillingen følger standarden (tirsdag kl. 19.00 Europe/Oslo) også over overgangen til vintertid, og
// dag, klokkeslett, tidssone og plannavn kan settes i konfigen; forbruket regnes fra tidsloggens kumulative rader
// (tilvekst per agent, tidKost.forbruksHendelser); prosent og «tom»-tid følger konstanten; kalibreringen retter
// konstanten fra prosenten Claude viser; og kvotetaket i fyll er mykt (varsel endrer ingenting, tak begrenser, av slår
// det av). Pluss den kalibrerte veggtid- og kostmodellen i koLogikk.
// =============================================================
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';

// Ingen konfigfil: standardverdiene gjelder, uansett hva som ligger i prosjektrota.
process.env.KO_KONFIG = path.join(os.tmpdir(), 'ko-kapasitet-test-finnes-ikke.json');

type Nullstilling = { ukedag: number; time: number; minutt: number; tz: string; plannavn: string | null };

type Hendelse = { agent: string; tid: string; usd: number; tokens?: Record<string, number> };
type Prognose = {
  fra: number;
  til: number;
  naa: number;
  usd: number;
  pct: number;
  tempoSnitt: number;
  tomSnitt: number | null;
  holder: boolean;
  sporTimer: number;
  parallellSnitt: number;
  forslagSpor: number | null;
  modus: string;
  tokens: Record<string, number>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KAP = require('../koKapasitet') as {
  sisteNullstilling: (naa: number, n?: Nullstilling) => number;
  nesteNullstilling: (naa: number, n?: Nullstilling) => number;
  nullstillingFra: (kap?: object) => Nullstilling;
  nullstilling: () => Nullstilling;
  prognose: (inn: {
    ko: object;
    hendelser: Hendelse[];
    naa?: number;
    nullstilling?: Nullstilling;
  }) => Prognose;
  kalibrer: (
    ko: object,
    inn: { prosent: unknown; hendelser: Hendelse[]; naa?: number },
  ) => {
    feil?: string;
    forrige?: number;
    kapasitet?: { usd_per_100: number; kalibreringer: unknown[] };
  };
  kvoteTak: (p: Prognose, aktive: number) => { grense: number | null; melding: string | null };
  linjer: (p: Prognose) => string[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TK = require('../tidKost') as {
  forbruksHendelser: (r: object[]) => Hendelse[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk') as {
  anslag: (o: object) => number;
  anslagVegg: (o: object) => number;
  anslagKost: (o: object) => number;
};

const iso = (s: string) => new Date(s).toISOString();
const ms = (s: string) => Date.parse(s);

describe('nullstillingen (standard: tirsdag kl. 19.00 Europe/Oslo)', () => {
  it('uten konfig gjelder standarden, uten plannavn', () => {
    expect(KAP.nullstilling()).toEqual({
      ukedag: 2,
      time: 19,
      minutt: 0,
      tz: 'Europe/Oslo',
      plannavn: null,
    });
  });
  it('finner forrige tirsdag 19.00 i sommertid (17.00 UTC)', () => {
    expect(iso(new Date(KAP.sisteNullstilling(ms('2026-10-23T08:35:00Z'))).toISOString())).toBe(
      '2026-10-20T17:00:00.000Z',
    );
  });
  it('neste nullstilling etter overgangen til vintertid er 19.00 CET (18.00 UTC)', () => {
    expect(new Date(KAP.nesteNullstilling(ms('2026-10-23T08:35:00Z'))).toISOString()).toBe(
      '2026-10-27T18:00:00.000Z',
    );
  });
  it('akkurat ved nullstillingen er den nye uka i gang; ett minutt før gjelder den forrige', () => {
    expect(KAP.sisteNullstilling(ms('2026-10-20T17:00:00Z'))).toBe(ms('2026-10-20T17:00:00Z'));
    expect(KAP.sisteNullstilling(ms('2026-10-20T16:59:00Z'))).toBe(ms('2026-10-13T17:00:00Z'));
  });
});

// To agenter med kumulative rader: a1 har $4 før nullstillingen og $204 etter, a2 $400 etter.
const rader = [
  {
    hendelse: 'ferdig',
    agent_id: 'a1',
    tid: '2026-10-20T16:00:00Z',
    tokens: { output: 0, cache_lest: 20_000_000 },
  },
  {
    hendelse: 'ferdig',
    agent_id: 'a1',
    tid: '2026-10-21T10:00:00Z',
    tokens: { output: 0, cache_lest: 1_020_000_000 },
  },
  {
    hendelse: 'ferdig',
    agent_id: 'a2',
    tid: '2026-10-22T10:00:00Z',
    tokens: { output: 20_000_000, cache_lest: 0 },
  },
];
const NAA = ms('2026-10-23T05:00:00Z'); // 60 t etter nullstillingen
const ko = (ekstra: object = {}) => ({
  kapasitet: { usd_per_100: 1000, ...ekstra },
  oppgaver: [
    // 30 sportimer i uka: 20 t ferdig (delvis før nullstillingen telles ikke) + 10 t som kjører nå.
    {
      id: 'A',
      klasse: 'K',
      status: 'ferdig',
      startet: '2026-10-20T07:00:00Z',
      levert: '2026-10-21T13:00:00Z',
    },
    { id: 'B', klasse: 'D', status: 'kjorer', startet: '2026-10-22T19:00:00Z', innhold_min: 40 },
    {
      id: 'S',
      klasse: 'K',
      status: 'ferdig',
      sky: true,
      startet: '2026-10-21T00:00:00Z',
      levert: '2026-10-22T00:00:00Z',
    },
  ],
});

describe('nullstillingen fra konfigen', () => {
  it('dag, klokkeslett, tidssone og plannavn kan settes; ugyldige verdier gir standarden', () => {
    expect(
      KAP.nullstillingFra({
        nullstillDag: 1,
        nullstillKlokke: '08:30',
        tidssone: 'UTC',
        plannavn: 'Eksempelplan',
      }),
    ).toEqual({ ukedag: 1, time: 8, minutt: 30, tz: 'UTC', plannavn: 'Eksempelplan' });
    expect(
      KAP.nullstillingFra({ nullstillDag: 9, nullstillKlokke: '25:00', tidssone: 'Ingen/Sone' }),
    ).toEqual(KAP.nullstillingFra({}));
  });
  it('mandag 08.30 UTC: siste og neste nullstilling', () => {
    const n = KAP.nullstillingFra({ nullstillDag: 1, nullstillKlokke: '08:30', tidssone: 'UTC' });
    // Fredag 23.10.2026: siste mandag var 19.10, neste 26.10.
    expect(new Date(KAP.sisteNullstilling(ms('2026-10-23T08:35:00Z'), n)).toISOString()).toBe(
      '2026-10-19T08:30:00.000Z',
    );
    expect(new Date(KAP.nesteNullstilling(ms('2026-10-23T08:35:00Z'), n)).toISOString()).toBe(
      '2026-10-26T08:30:00.000Z',
    );
  });
});

describe('prognosen', () => {
  const h = TK.forbruksHendelser(rader);
  it('teller bare tilveksten etter nullstillingen og regner prosent fra konstanten', () => {
    const p = KAP.prognose({ ko: ko(), hendelser: h, naa: NAA });
    expect(p.usd).toBeCloseTo(600, 5); // a1: (1 020M − 20M) × $0,2/M = 200; a2: 20M output × $20/M = 400
    expect(p.pct).toBeCloseTo(60, 5);
    expect(p.tokens.cache_lest).toBe(1_000_000_000);
  });
  it('tempoet er snittet siden nullstillingen, og kvoten er tom når resten er brukt med det tempoet', () => {
    const p = KAP.prognose({ ko: ko(), hendelser: h, naa: NAA });
    expect(p.tempoSnitt).toBeCloseTo(1, 5); // 60 % på 60 t
    expect(p.tomSnitt).toBe(NAA + 40 * 3_600_000);
    expect(p.holder).toBe(false);
  });
  it('sportimer: overlapp med uka, uten skyspor; kjørende teller til nå', () => {
    const p = KAP.prognose({ ko: ko(), hendelser: h, naa: NAA });
    expect(p.sporTimer).toBeCloseTo(20 + 10, 5);
    expect(p.parallellSnitt).toBeCloseTo(0.5, 5);
    // 2 % per sportime; resten 40 % over (til − nå) timer.
    const igjen = (p.til - NAA) / 3_600_000;
    expect(p.forslagSpor).toBe(Math.floor(40 / igjen / 2));
  });
});

describe('kalibrering', () => {
  const h = TK.forbruksHendelser(rader);
  it('setter usd_per_100 fra prosenten Claude viser, og lagrer punktet', () => {
    const r = KAP.kalibrer(ko(), { prosent: 30, hendelser: h, naa: NAA });
    expect(r.forrige).toBe(1000);
    expect(r.kapasitet?.usd_per_100).toBe(2000);
    expect(r.kapasitet?.kalibreringer).toHaveLength(1);
  });
  it('avviser en ugyldig prosent', () => {
    expect(KAP.kalibrer(ko(), { prosent: 'x', hendelser: h, naa: NAA }).feil).toBeTruthy();
    expect(KAP.kalibrer(ko(), { prosent: 0, hendelser: h, naa: NAA }).feil).toBeTruthy();
  });
});

describe('kvotetaket i fyll er mykt', () => {
  const h = TK.forbruksHendelser(rader);
  it('varsel (standard): melding, ingen grense', () => {
    const p = KAP.prognose({ ko: ko(), hendelser: h, naa: NAA });
    const t = KAP.kvoteTak(p, 5);
    expect(t.grense).toBeNull();
    expect(t.melding).toMatch(/Bare varsel/);
  });
  it('tak: høyst forslaget minus de som kjører, men minst 1 når ingenting kjører', () => {
    const p = KAP.prognose({ ko: ko({ modus: 'tak' }), hendelser: h, naa: NAA });
    expect(KAP.kvoteTak(p, 5).grense).toBe(Math.max(0, (p.forslagSpor ?? 0) - 5));
    expect(KAP.kvoteTak(p, 0).grense).toBeGreaterThanOrEqual(1);
  });
  it('av: ingenting', () => {
    const p = KAP.prognose({ ko: ko({ modus: 'av' }), hendelser: h, naa: NAA });
    expect(KAP.kvoteTak(p, 5)).toEqual({ grense: null, melding: null });
  });
  it('linjene nevner prosent, tom-tid og forslaget', () => {
    const p = KAP.prognose({
      ko: ko({ skykreditt: { igjen_usd: 47, total_usd: 250 } }),
      hendelser: h,
      naa: NAA,
    });
    const t = KAP.linjer(p).join('\n');
    expect(t).toMatch(/Brukt: 60 %/);
    expect(t).toMatch(/Tom \(100 %\)/);
    expect(t).toMatch(/Skykreditt.*47 av 250/);
    // Generisk tekst: «Ukekvoten» uten plannavn, dagen fra nullstillingen.
    expect(t).toMatch(/^Ukekvoten: nullstilt/);
    expect(t).toMatch(/nullstilles hver tirsdag/);
  });
  it('plannavn og en annen nullstillingsdag vises i teksten', () => {
    const n = KAP.nullstillingFra({ nullstillDag: 4, plannavn: 'Eksempelplan' });
    const p = KAP.prognose({ ko: ko(), hendelser: h, naa: NAA, nullstilling: n });
    const t = KAP.linjer(p).join('\n');
    expect(t).toMatch(/^Ukekvoten \(Eksempelplan\): nullstilt torsdag/);
    expect(t).toMatch(/nullstilles hver torsdag/);
    expect(t).not.toMatch(/tirsdag/);
  });
});

describe('kalibrert veggtid og kost (koLogikk)', () => {
  it('anslag (prioriteten) er uendret', () => {
    expect(L.anslag({ klasse: 'K', innhold_min: 30 })).toBe(30);
    expect(L.anslag({ klasse: 'D+', innhold_min: 30 })).toBe(54);
  });
  it('veggtid: K er kortere enn anslaget, D og D+ lengre', () => {
    expect(L.anslagVegg({ klasse: 'K', innhold_min: 120 })).toBe(33);
    expect(L.anslagVegg({ klasse: 'D', innhold_min: 40 })).toBe(72);
    expect(L.anslagVegg({ klasse: 'D+', innhold_min: 30 })).toBe(98);
    expect(L.anslagKost({ klasse: 'D', innhold_min: 40 })).toBe(5.2);
  });
});
