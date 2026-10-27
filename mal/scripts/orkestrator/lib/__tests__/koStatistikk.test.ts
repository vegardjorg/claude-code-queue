// =============================================================
// koStatistikk.test.ts: statistikken på kanban-tavla for arbeidskøen (scripts/orkestrator/lib/koStatistikk.js).
//
// Beviser at tallene regnes fra køen og tidsloggen uten egne kopier av reglene: anslaget er koLogikk.anslag
// (innhold × klassevekt), forbruket er tidKost.forbruksHendelser (kumulative rader per agent), nattandelen følger
// nattvinduet, og datoene er lokal dato (Europe/Oslo i testene). Median er hovedtallet; oppgaver uten starttid eller med umulige tider telles
// ikke i tidene, og antallet som er utelatt, står i svaret.
// =============================================================
import { describe, it, expect } from 'vitest';

type Oppgave = {
  id: string;
  klasse: 'K' | 'D' | 'D+' | 'U';
  status: string;
  innhold_min?: number;
  startet?: string;
  levert?: string;
  ferdig?: string;
  ekstern?: boolean;
};
type Rad = Record<string, unknown>;
type Stat = {
  vinduDager: number;
  nokkeltall: {
    ferdige: number;
    syklusMedian: number | null;
    syklusAntall: number;
    treffsikkerhet: number | null;
    forbrukIdag: number;
    dagsbudsjett: number | null;
  };
  ferdigePerDag: { dag: string; K: number; D: number; 'D+': number; U: number; sum: number }[];
  perKlasse: {
    klasse: string;
    antall: number;
    arbeid: { median: number | null; snitt: number | null };
    review: { median: number | null; snitt: number | null };
    anslagSnitt: number | null;
  }[];
  kostPerDag: { dag: string; usd: number; natt: number }[];
  kontekst: { antall: number; median: number | null; maks: number | null; tak: number };
  utelatt: { syklus: number; klasse: number; kontekst: number };
  modeller: { modell: string; antall: number }[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../koStatistikk') as {
  VINDU_DAGER: number;
  KONTEKST_TAK: number;
  median: (xs: number[]) => number | null;
  snitt: (xs: number[]) => number | null;
  dagerBakover: (naa: number, n: number) => string[];
  statistikk: (
    ko: { oppgaver: Oppgave[]; grenser?: Record<string, unknown> },
    rader: Rad[],
    valg?: { naa?: number },
  ) => Stat;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TK = require('../tidKost') as {
  kostUsd: (tokens: Record<string, number>, modell?: string) => number;
};

// Nå: 30.09.2026 kl. 12:00 i Oslo (sommertid, UTC+2).
const NAA = Date.parse('2026-09-30T10:00:00Z');
const kl = (iso: string) => new Date(Date.parse(iso)).toISOString();

describe('hjelperne', () => {
  it('median og snitt', () => {
    expect(S.median([])).toBeNull();
    expect(S.median([5, 1, 3])).toBe(3);
    expect(S.median([4, 1, 3, 2])).toBe(2.5);
    expect(S.snitt([1, 2, 6])).toBe(3);
  });

  it('dagerBakover: norske datoer, i dag sist, ingen dag hoppet over ved sommertid', () => {
    const d = S.dagerBakover(NAA, 3);
    expect(d).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
    // 26.10.2026 kl. 00:30 norsk tid (normaltid); sommertiden sluttet natt til 25.10.
    const etter = S.dagerBakover(Date.parse('2026-10-25T23:30:00Z'), 3);
    expect(etter).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    // Sen kveld UTC er neste dag i Oslo.
    expect(S.dagerBakover(Date.parse('2026-09-30T22:30:00Z'), 1)).toEqual(['2026-10-01']);
  });
});

describe('statistikk: oppgavene', () => {
  const ko = {
    grenser: { dagsbudsjett: 50 },
    oppgaver: [
      // K: anslag 30 min. 60 min arbeid + 30 min review = 90 min syklus (3,0 × anslaget).
      {
        id: 'K1',
        klasse: 'K',
        status: 'ferdig',
        innhold_min: 30,
        startet: kl('2026-09-30T06:00:00Z'),
        levert: kl('2026-09-30T07:00:00Z'),
        ferdig: kl('2026-09-30T07:30:00Z'),
      },
      // K: 20 + 10 = 30 min (1,0 ×).
      {
        id: 'K2',
        klasse: 'K',
        status: 'ferdig',
        innhold_min: 30,
        startet: kl('2026-09-29T06:00:00Z'),
        levert: kl('2026-09-29T06:20:00Z'),
        ferdig: kl('2026-09-29T06:30:00Z'),
      },
      // D: anslag 30 × 1,3 = 39 min. Ferdig 23:30 UTC 28.09 = 29.09 norsk dato. 78 min (2,0 ×).
      {
        id: 'D1',
        klasse: 'D',
        status: 'ferdig',
        innhold_min: 30,
        startet: kl('2026-09-28T22:12:00Z'),
        levert: kl('2026-09-28T23:00:00Z'),
        ferdig: kl('2026-09-28T23:30:00Z'),
      },
      // Uten levert: med i syklustiden, utelatt i tiden per klasse.
      {
        id: 'U1',
        klasse: 'U',
        status: 'ferdig',
        innhold_min: 50,
        startet: kl('2026-09-27T10:00:00Z'),
        ferdig: kl('2026-09-27T10:30:00Z'),
      },
      // Gjort utenfor køen (ingen startet): telles som ferdig, utelatt i tidene.
      { id: 'X1', klasse: 'K', status: 'ferdig', ferdig: kl('2026-09-30T08:00:00Z') },
      // Umulig tid (ferdig før startet): utelatt.
      {
        id: 'X2',
        klasse: 'K',
        status: 'ferdig',
        startet: kl('2026-09-30T08:00:00Z'),
        ferdig: kl('2026-09-30T07:00:00Z'),
      },
      // Eldre enn 7 dager: ikke i «ferdige siste 7 dager», men i 14-dagersvinduet.
      {
        id: 'G1',
        klasse: 'K',
        status: 'ferdig',
        innhold_min: 30,
        startet: kl('2026-09-20T06:00:00Z'),
        levert: kl('2026-09-20T06:30:00Z'),
        ferdig: kl('2026-09-20T06:30:00Z'),
      },
      // Utenfor 14-dagersvinduet: ikke med i det hele tatt.
      {
        id: 'G2',
        klasse: 'K',
        status: 'ferdig',
        startet: kl('2026-09-01T06:00:00Z'),
        ferdig: kl('2026-09-01T09:00:00Z'),
      },
      // Ikke ferdig, og en registrering utenfor køen: aldri med.
      { id: 'V1', klasse: 'K', status: 'venter' },
      {
        id: 'E1',
        klasse: 'K',
        status: 'ferdig',
        ekstern: true,
        startet: kl('2026-09-30T06:00:00Z'),
        ferdig: kl('2026-09-30T09:00:00Z'),
      },
    ] as Oppgave[],
  };
  const s = S.statistikk(ko, [], { naa: NAA });

  it('ferdige siste 7 dager (norsk dato), uten registreringer utenfor køen', () => {
    // K1, K2, D1, U1, X1, X2 (G1 er 10 dager gammel, G2 utenfor vinduet, E1 er en registrering).
    expect(s.nokkeltall.ferdige).toBe(6);
  });

  it('median syklustid og treffsikkerhet; uten starttid og umulige tider er utelatt', () => {
    // Sykluser: K1 90, K2 30, D1 78, U1 30, G1 30 → median 30.
    expect(s.nokkeltall.syklusMedian).toBe(30);
    expect(s.nokkeltall.syklusAntall).toBe(5);
    expect(s.utelatt.syklus).toBe(2); // X1, X2
    // Faktisk / anslått: K1 3,0, K2 1,0, D1 2,0, U1 30/30 = 1,0, G1 1,0 → median 1,0.
    expect(s.nokkeltall.treffsikkerhet).toBe(1);
  });

  it('ferdige per dag, stablet per klasse, på norsk dato', () => {
    expect(s.ferdigePerDag).toHaveLength(S.VINDU_DAGER);
    const dag = (d: string) => s.ferdigePerDag.find((r) => r.dag === d);
    expect(dag('2026-09-30')).toMatchObject({ K: 3, sum: 3 }); // K1, X1, X2
    expect(dag('2026-09-29')).toMatchObject({ K: 1, D: 1, sum: 2 }); // K2, D1 (23:30 UTC 28.09)
    expect(dag('2026-09-28')?.sum).toBe(0);
  });

  it('tid per klasse: arbeid og review, median og snitt, og anslått snitt fra koLogikk.anslag', () => {
    const k = s.perKlasse.find((x) => x.klasse === 'K');
    // K1 (60/30), K2 (20/10), G1 (30/0).
    expect(k).toMatchObject({
      antall: 3,
      arbeid: { median: 30, snitt: 37 },
      review: { median: 10, snitt: 13 },
      anslagSnitt: 30,
    });
    const d = s.perKlasse.find((x) => x.klasse === 'D');
    expect(d).toMatchObject({
      antall: 1,
      arbeid: { median: 48 },
      review: { median: 30 },
      anslagSnitt: 39,
    });
    expect(s.perKlasse.find((x) => x.klasse === 'U')?.antall).toBe(0); // U1 mangler levert
    expect(s.utelatt.klasse).toBe(3); // X1, X2, U1
  });

  it('dagskvoten følger med når den er satt', () => {
    expect(s.nokkeltall.dagsbudsjett).toBe(50);
    expect(S.statistikk({ oppgaver: [] }, [], { naa: NAA }).nokkeltall.dagsbudsjett).toBeNull();
  });
});

describe('statistikk: tidsloggen', () => {
  const tok = (output: number) => ({
    input: 0,
    output,
    cache_lest: 0,
    cache_skrevet: 0,
    cache_skrevet_5m: 0,
    cache_skrevet_1t: 0,
  });
  const usd = (output: number) => TK.kostUsd(tok(output), 'claude-opus-5-5');
  const rader: Rad[] = [
    // Agent a1 (spor): to kumulative rader; tilveksten i natt (00:30 norsk tid) og om dagen (11:00).
    {
      tid: '2026-09-29T22:30:00Z',
      hendelse: 'ferdig',
      agent_id: 'a1',
      agent_type: 'spor',
      spor: 'K1',
      tokens: tok(100_000),
      modell: 'claude-opus-5-5',
      kontekst: { start: 1, median: 2, slutt: 100_000 },
    },
    {
      tid: '2026-09-30T09:00:00Z',
      hendelse: 'ferdig',
      agent_id: 'a1',
      agent_type: 'spor',
      spor: 'K1',
      tokens: tok(300_000),
      modell: 'claude-opus-5-5',
      kontekst: { start: 1, median: 2, slutt: 250_000 },
    },
    // Agent a2 (spor) i går om dagen, stor kontekst.
    {
      tid: '2026-09-29T10:00:00Z',
      hendelse: 'ferdig',
      agent_id: 'a2',
      agent_type: 'spor',
      spor: 'D1',
      tokens: tok(50_000),
      modell: 'claude-opus-5-5',
      kontekst: { start: 1, median: 2, slutt: 400_000 },
    },
    // Reviewer: med i kosten, ikke i konteksten til spor-agentene.
    {
      tid: '2026-09-30T08:00:00Z',
      hendelse: 'ferdig',
      agent_id: 'r1',
      agent_type: 'reviewer',
      tokens: tok(10_000),
      kontekst: { start: 1, median: 2, slutt: 900_000 },
    },
    // Spor uten kontekst: utelatt i konteksten.
    { tid: '2026-09-30T08:30:00Z', hendelse: 'ferdig', agent_id: 'a3', agent_type: 'spor' },
    // Andre hendelser teller ikke.
    { tid: '2026-09-30T08:00:00Z', hendelse: 'gate', agent_id: 'x', tokens: tok(999_999) },
  ];
  const s = S.statistikk({ oppgaver: [] }, rader, { naa: NAA });

  it('kost per dag med nattandelen (standardvinduet 23-06), deduplisert per agent', () => {
    const idag = s.kostPerDag.find((r) => r.dag === '2026-09-30');
    const igar = s.kostPerDag.find((r) => r.dag === '2026-09-29');
    const r2 = (x: number) => Math.round(x * 100) / 100;
    // 30.09: a1 første rad (00:30, natt) + a1 tilvekst (11:00) + r1 (10:00).
    expect(idag?.usd).toBe(r2(usd(300_000) + usd(10_000)));
    expect(idag?.natt).toBe(r2(usd(100_000)));
    expect(igar).toEqual({ dag: '2026-09-29', usd: r2(usd(50_000)), natt: 0 });
    expect(s.nokkeltall.forbrukIdag).toBe(idag?.usd);
  });

  it('et annet nattvindu gir en annen nattandel', () => {
    const s2 = S.statistikk({ oppgaver: [], grenser: { nattvindu: '01-05' } }, rader, { naa: NAA });
    expect(s2.kostPerDag.find((r) => r.dag === '2026-09-30')?.natt).toBe(0);
  });

  it('kontekst: siste rad per spor-agent, median og maks mot taket; spor uten kontekst er utelatt', () => {
    expect(s.kontekst).toEqual({
      antall: 2,
      median: 325_000,
      maks: 400_000,
      tak: S.KONTEKST_TAK,
    });
    expect(s.utelatt.kontekst).toBe(1);
  });

  it('modellen i de siste sporene', () => {
    expect(s.modeller).toEqual([{ modell: 'claude-opus-5-5', antall: 2 }]);
  });

  it('spor-d (D og D+) er byggeagent og teller i kontekst og modell; reviewer gjør det ikke', () => {
    const medD: Rad[] = [
      ...rader,
      {
        tid: '2026-09-30T07:00:00Z',
        hendelse: 'ferdig',
        agent_id: 'd1',
        agent_type: 'spor-d',
        spor: 'D2',
        tokens: tok(20_000),
        modell: 'claude-opus-5-5',
        kontekst: { start: 1, median: 2, slutt: 600_000 },
      },
    ];
    const sd = S.statistikk({ oppgaver: [] }, medD, { naa: NAA });
    expect(sd.kontekst).toEqual({
      antall: 3,
      median: 400_000,
      maks: 600_000,
      tak: S.KONTEKST_TAK,
    });
    expect(sd.modeller).toEqual([{ modell: 'claude-opus-5-5', antall: 3 }]);
  });
});

// =============================================================
// Inn mot ut, median tid fra spørsmål til svar, og aldersgrensene (p85) for aldrende arbeid.
// =============================================================
type O3 = Oppgave & { lagt_til?: string; venter_paa?: string[] };
type Ko3 = {
  oppgaver: O3[];
  sporsmal?: Record<string, { type: string; tekst: string; lagt_til?: string }>;
  avklaringer?: Record<string, { tid: string; svar: string | null; av: string | null }>;
};
type Stat3 = Stat & {
  nokkeltall: Stat['nokkeltall'] & {
    innUt: { inn: number; ut: number; netto: number };
    svartid: { median: number; antall: number } | null;
  };
  innUtPerDag: { dag: string; inn: number; ut: number }[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S3 = require('../koStatistikk') as {
  ALDER_MIN_ANTALL: number;
  SVARTID_MIN_ANTALL: number;
  persentil: (xs: number[], p: number) => number | null;
  aldersGrenser: (
    ko: Ko3,
    valg?: { naa?: number },
  ) => Record<string, { arbeid: number | null; syklus: number | null; antall: number }>;
  statistikk: (ko: Ko3, rader: Rad[], valg?: { naa?: number }) => Stat3;
};

describe('persentil og aldersGrenser (aldrende arbeid over p85)', () => {
  it('persentil med nærmeste rang', () => {
    expect(S3.persentil([], 85)).toBeNull();
    expect(S3.persentil([10, 20, 30, 40, 50], 85)).toBe(50);
    expect(S3.persentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 85)).toBe(9);
    expect(S3.persentil([7], 85)).toBe(7);
  });

  it('per klasse p85 av arbeid (start–levert) og syklus (start–ferdig); for få ferdige gir ingen grense', () => {
    // Fem K-er i vinduet: arbeid 10, 20, 30, 40, 100 min; review 10 min hver.
    const k = [10, 20, 30, 40, 100].map((min, i) => ({
      id: `K${i}`,
      klasse: 'K' as const,
      status: 'ferdig',
      startet: kl('2026-09-29T06:00:00Z'),
      levert: new Date(Date.parse('2026-09-29T06:00:00Z') + min * 60_000).toISOString(),
      ferdig: new Date(Date.parse('2026-09-29T06:10:00Z') + min * 60_000).toISOString(),
    }));
    // Fire D-er: under minstekravet.
    const d = [1, 2, 3, 4].map((i) => ({ ...k[0], id: `D${i}`, klasse: 'D' as const }));
    // En K utenfor vinduet (20 dager siden) teller ikke.
    const gammel = {
      ...k[0],
      id: 'GML',
      startet: kl('2026-09-10T06:00:00Z'),
      levert: kl('2026-09-10T20:00:00Z'),
      ferdig: kl('2026-09-10T21:00:00Z'),
    };
    const g = S3.aldersGrenser({ oppgaver: [...k, ...d, gammel] }, { naa: NAA });
    expect(g.K).toEqual({ arbeid: 100, syklus: 110, antall: 5 });
    expect(g.D).toEqual({ arbeid: null, syklus: null, antall: 4 });
    expect(g['D+']).toEqual({ arbeid: null, syklus: null, antall: 0 });
    expect(S3.ALDER_MIN_ANTALL).toBe(5);
  });
});

describe('inn mot ut og tid fra spørsmål til svar', () => {
  const dag = (d: string, t = '08:00') => kl(`${d}T${t}:00Z`);
  const ferdig = (id: string, d: string): O3 => ({
    id,
    klasse: 'K',
    status: 'ferdig',
    startet: dag(d, '06:00'),
    ferdig: dag(d),
    lagt_til: dag(d, '05:00'),
  });
  const venter = (id: string, d: string, felt: Partial<O3> = {}): O3 => ({
    id,
    klasse: 'K',
    status: 'venter',
    lagt_til: dag(d),
    ...felt,
  });

  it('lagt til og ferdige per dag i 14 dager; nøkkeltallet er snittet per dag de siste 7, netto > 0 = køen vokser', () => {
    const ko: Ko3 = {
      oppgaver: [
        ferdig('F1', '2026-09-30'),
        ferdig('F2', '2026-09-29'),
        venter('V1', '2026-09-30'),
        venter('V2', '2026-09-30'),
        venter('V3', '2026-09-24'),
        venter('V4', '2026-09-20'), // lagt til i vinduet på 14 dager, men før de siste 7
        { ...venter('EKST', '2026-09-30'), ekstern: true }, // registrering utenfor køen teller ikke
      ],
    };
    const s = S3.statistikk(ko, [], { naa: NAA });
    expect(s.innUtPerDag).toHaveLength(14);
    expect(s.innUtPerDag.at(-1)).toEqual({ dag: '2026-09-30', inn: 3, ut: 1 });
    expect(s.innUtPerDag.at(-2)).toEqual({ dag: '2026-09-29', inn: 1, ut: 1 });
    expect(s.innUtPerDag.find((r) => r.dag === '2026-09-20')?.inn).toBe(1);
    // Siste 7 dager: 5 lagt til (F1, F2, V1, V2, V3) og 2 ferdige.
    expect(s.nokkeltall.innUt).toEqual({ inn: 0.7, ut: 0.3, netto: 0.4 });
  });

  it('median tid fra spørsmål til svar bare med nok avklaringer; fra det spørsmålet fantes', () => {
    const oppgaver: O3[] = [];
    const avklaringer: Ko3['avklaringer'] = {};
    // Fire avklaringer: for få, tallet utelates.
    for (let i = 1; i <= 4; i++) {
      oppgaver.push(venter(`V${i}`, '2026-09-28', { venter_paa: [`S${i}`] }));
      avklaringer[`S${i}`] = {
        tid: dag('2026-09-28', `${String(8 + i).padStart(2, '0')}:00`),
        svar: 'Ja',
        av: 'eier',
      };
    }
    expect(
      S3.statistikk({ oppgaver, avklaringer }, [], { naa: NAA }).nokkeltall.svartid,
    ).toBeNull();
    // Den femte: spørsmålet var registrert tidligere (sporsmal.lagt_til) enn oppgaven kom inn.
    oppgaver.push(venter('V5', '2026-09-29', { venter_paa: ['S5'] }));
    avklaringer.S5 = { tid: dag('2026-09-29', '10:00'), svar: 'Ja', av: 'eier' };
    const sporsmal = { S5: { type: 'sporsmal', tekst: '?', lagt_til: dag('2026-09-28') } };
    const s = S3.statistikk({ oppgaver, avklaringer, sporsmal }, [], { naa: NAA });
    // Svartidene: 60, 120, 180, 240 og 26 t (1560) min; medianen er 180.
    expect(s.nokkeltall.svartid).toEqual({ median: 180, antall: 5 });
    expect(S3.SVARTID_MIN_ANTALL).toBe(5);
  });

  it('en gammel ko.json uten de nye feltene gir tall uten feil', () => {
    const s = S3.statistikk({ oppgaver: [ferdig('F1', '2026-09-30')] }, [], { naa: NAA });
    expect(s.nokkeltall.svartid).toBeNull();
    expect(s.nokkeltall.innUt.ut).toBe(0.1);
  });
});
