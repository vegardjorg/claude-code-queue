// =============================================================
// koPlanDokVisning.test.ts: visningsreglene for flaten «Dokumenter og avtaler» i Planer-rommet
// (lib/koPlanVisning.js): verdiene stemmer med koPlan.js,
// nettadressen (flate, filtre, søk, valgt dokument), fasettene med antall, tabellen per gruppe, tidslinjen per måned,
// stien og dataene /api/planer sender.
// =============================================================
import { describe, it, expect } from 'vitest';

type DokV = Record<string, unknown> & { id: string; varsel?: string[]; grunner?: unknown[] };
type Tilstand = {
  rom: string;
  flate: string;
  dfilter: Record<string, string[]>;
  dsok: string;
  dok: string | null;
  filter: Record<string, string[]>;
  post: string | null;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../koPlanVisning') as {
  DOK_GRUPPE: Record<string, string>;
  DOK_STATUS: Record<string, unknown>;
  DOK_MALGRUPPE: Record<string, string>;
  DOK_ALVOR: Record<string, string>;
  DOK_PUBLISERT: Record<string, string>;
  lesUrl: (s: string) => Tilstand;
  skrivUrl: (t: object) => string;
  tomtDokFilter: () => Record<string, string[]>;
  dokFiltrer: (l: DokV[], f?: object, s?: string) => DokV[];
  dokFasettTall: (
    l: DokV[],
    f: object,
    s: string,
  ) => { id: string; valg: { verdi: string; antall: number }[] }[];
  dokBrikker: (f: object) => { tekst: string }[];
  antallDokFiltre: (f: object) => number;
  dokGrupper: (
    l: DokV[],
  ) => { id: string; antall: number; maa: number; status: Record<string, number> }[];
  tidslinjeMaaneder: (l: object[]) => { noekkel: string; tittel: string; elementer: unknown[] }[];
  brodsmuler: (
    t: object,
    d: object,
  ) => { niva: string; tekst: string; kopier: string | null; tilstand?: object }[];
  rensEgenVisning: (x: unknown) => { sok: string } | null;
  planerData: (
    reg: object,
    ko: object,
    ctx?: object,
  ) => Record<string, unknown> & { dokumenter: DokV[] };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../koPlan') as {
  DOK_GRUPPER: { id: string }[];
  DOK_STATUSER: string[];
  DOK_MALGRUPPER: string[];
  DOK_ALVOR: string[];
  DOK_PUBLISERT_HVOR: string[];
};

const d = (id: string, extra: object = {}): DokV => ({
  id,
  tittel: `Dokument ${id}`,
  gruppe: 'kundeavtaler',
  malgruppe: 'kunde',
  status: 'utkast',
  prioritet: null,
  varsel: [],
  grunner: [],
  problemer: [],
  ...extra,
});

describe('koPlanVisning: verdiene og nettadressen', () => {
  it('verdiene er de samme som i koPlan.js (rekkefølgen også)', () => {
    expect(Object.keys(V.DOK_GRUPPE)).toEqual(P.DOK_GRUPPER.map((g) => g.id));
    expect(Object.keys(V.DOK_STATUS)).toEqual(P.DOK_STATUSER);
    expect(Object.keys(V.DOK_MALGRUPPE)).toEqual(P.DOK_MALGRUPPER);
    expect(Object.keys(V.DOK_ALVOR)).toEqual(P.DOK_ALVOR);
    expect(Object.keys(V.DOK_PUBLISERT)).toEqual(P.DOK_PUBLISERT_HVOR);
  });

  it('flate, filtre, søk og valgt dokument går fram og tilbake; ugyldig kastes', () => {
    const t = V.lesUrl(
      '?rom=planer&flate=dok&dgr=personvern&dst=til-jurist,tull&dq=vilkar&dok=DOK-VILKAR',
    );
    expect(t).toMatchObject({
      rom: 'planer',
      flate: 'dok',
      dsok: 'vilkar',
      dok: 'DOK-VILKAR',
      dfilter: { gruppe: ['personvern'], status: ['til-jurist'] },
    });
    expect(V.lesUrl(V.skrivUrl(t))).toEqual(t);
    const u = V.lesUrl('?rom=planer&flate=x&dok=<script>');
    expect(u.flate).toBe('poster');
    expect(u.dok).toBeNull();
    // Kø-rommet og en planpost-adresse er som før.
    expect(V.skrivUrl(V.lesUrl(''))).toBe('');
    expect(V.skrivUrl(V.lesUrl('?rom=planer&pri=naa'))).toBe('?rom=planer&pri=naa');
  });

  it('en lagret visning tar ikke med dokumenttilstanden', () => {
    expect(
      V.rensEgenVisning({ navn: 'X', sok: '?rom=planer&pri=naa&flate=dok&dok=DOK-A' })?.sok,
    ).toBe('?rom=planer&pri=naa');
  });
});

describe('koPlanVisning: fasetter, grupper og tidslinje', () => {
  const liste = [
    d('DOK-A', { status: 'til-jurist', varsel: ['problem-hoy', 'problem'], grunner: [{}] }),
    d('DOK-B', { gruppe: 'personvern', malgruppe: 'offentlig' }),
    d('DOK-C', { gruppe: 'styring', malgruppe: 'intern', status: 'godkjent', prioritet: 'naa' }),
    d('DOK-D', { prioritet: 'dropp' }),
  ];

  it('filtrerer, skjuler droppede og teller per verdi', () => {
    expect(V.dokFiltrer(liste).map((x) => x.id)).toEqual(['DOK-A', 'DOK-B', 'DOK-C']);
    expect(V.dokFiltrer(liste, { pri: ['dropp'] }).map((x) => x.id)).toEqual(['DOK-D']);
    expect(V.dokFiltrer(liste, { varsel: ['problem'] }).map((x) => x.id)).toEqual(['DOK-A']);
    expect(V.dokFiltrer(liste, { varsel: ['ingen'] }).map((x) => x.id)).toEqual(['DOK-B', 'DOK-C']);
    expect(V.dokFiltrer(liste, {}, 'dokument dok-b').map((x) => x.id)).toEqual(['DOK-B']);
    const f = { ...V.tomtDokFilter(), gruppe: ['kundeavtaler'] };
    const tall = V.dokFasettTall(liste, f, '');
    // Gruppe telles uten sitt eget valg; status med gruppe-filteret på.
    expect(tall.find((x) => x.id === 'gruppe')?.valg.map((v) => `${v.verdi}:${v.antall}`)).toEqual([
      'kundeavtaler:1',
      'personvern:1',
      'styring:1',
    ]);
    expect(tall.find((x) => x.id === 'status')?.valg.map((v) => `${v.verdi}:${v.antall}`)).toEqual([
      'til-jurist:1',
    ]);
    expect(V.dokBrikker(f).map((b) => b.tekst)).toEqual(['Gruppe: Kundeavtaler']);
    expect(V.antallDokFiltre(f)).toBe(1);
  });

  it('én tabell per gruppe i rekkefølgen fra planen', () => {
    const g = V.dokGrupper(V.dokFiltrer(liste));
    expect(g.map((x) => `${x.id}:${x.antall}:${x.maa}`)).toEqual([
      'kundeavtaler:1:1',
      'personvern:1:0',
      'styring:1:0',
    ]);
    expect(g[0].status).toEqual({ 'til-jurist': 1 });
  });

  it('tidslinjen: Forfalt først, så én kolonne per måned', () => {
    const k = V.tidslinjeMaaneder([
      { id: 'DOK-A', dato: '2026-09-01', forfalt: true },
      { id: 'DOK-B', dato: '2026-12-01', forfalt: false },
      { id: 'DOK-C', dato: '2026-11-03', forfalt: false },
      { id: 'DOK-D', dato: '2026-11-20', forfalt: false },
    ]);
    expect(k.map((x) => `${x.noekkel}:${x.elementer.length}`)).toEqual([
      'forfalt:1',
      '2026-11:2',
      '2026-12:1',
    ]);
    expect(k[1].tittel).toMatch(/^November 2026$/i);
  });
});

describe('koPlanVisning: stien og dataene fra serveren', () => {
  const reg = {
    poster: [{ id: 'PL-BYTTE-1', tittel: 'Bytt e-postleverandør', prosjekt: 'p', prioritet: 'naa' }],
    arkiv: {},
    endringslogg: [
      {
        nr: 1,
        at: '2026-10-14T10:00:00Z',
        av: 'test',
        handling: 'plan dok endre',
        endringer: [{ samling: 'dokumenter', id: 'DOK-VILKAR', felt: 'status' }],
      },
    ],
    dokumenter: [
      {
        id: 'DOK-LEVERANDOR',
        tittel: 'Underleverandører',
        gruppe: 'personvern',
        malgruppe: 'offentlig',
        status: 'godkjent',
      },
      {
        id: 'DOK-VILKAR',
        tittel: 'Vilkårsavtale',
        gruppe: 'kundeavtaler',
        malgruppe: 'kunde',
        status: 'godkjent',
        versjon: '1.3',
        gjeldende_versjon: '1.2',
        sist_revidert: '2025-09-20',
        revisjon_hver: '12 mnd',
        avhenger_av: ['DOK-LEVERANDOR'],
        planposter: ['PL-BYTTE-1'],
        problemer: [{ tekst: 'Nevner gammel leverandør', alvor: 'hoy' }],
        eierspm: ['SP-VILKAR-1'],
      },
    ],
  };
  const ko = {
    prosjekter: { p: { tittel: 'P', omrade: 'm' } },
    omrader: { m: { tittel: 'M' } },
    sporsmal: { 'SP-VILKAR-1': { tekst: 'Hvilken?' } },
    avklart: [],
  };
  const data = V.planerData(reg, ko, { naa: new Date('2026-10-15T10:00:00Z') });

  it('planerData har dokumentene med glipp, revisjon, varsler, koblinger og historikk', () => {
    const dpa = data.dokumenter.find((x) => x.id === 'DOK-VILKAR') as DokV & Record<string, unknown>;
    expect(dpa.varsel).toEqual(['problem-hoy', 'problem', 'glipp', 'forfalt']);
    expect(dpa.neste_revisjon).toMatchObject({ dato: '2026-09-20', forfalt: true });
    expect(dpa.avhenger_av).toEqual([
      { id: 'DOK-LEVERANDOR', tittel: 'Underleverandører', status: 'godkjent' },
    ]);
    expect(dpa.planposter).toEqual([{ id: 'PL-BYTTE-1', tittel: 'Bytt e-postleverandør' }]);
    expect(dpa.eierspm).toEqual([{ id: 'SP-VILKAR-1', tekst: 'Hvilken?', avklart: false }]);
    expect((dpa.historikk as { felt: string[] }[])[0].felt).toEqual(['status']);
    expect(
      (data.dokumenter.find((x) => x.id === 'DOK-LEVERANDOR') as Record<string, unknown>).brukt_av,
    ).toEqual(['DOK-VILKAR']);
    expect((data.dok_maa_gjores as { id: string }[]).map((x) => x.id)).toEqual(['DOK-VILKAR']);
    expect((data.dok_tidslinje as { id: string; type: string }[])[0]).toMatchObject({
      id: 'DOK-VILKAR',
      type: 'revisjon',
    });
  });

  it('stien: Planer › Dokumenter og avtaler › Gruppe › DOK-id med kopier-linje', () => {
    const sti = V.brodsmuler(V.lesUrl('?rom=planer&flate=dok&dok=DOK-VILKAR'), data);
    expect(sti.map((l) => l.tekst)).toEqual([
      'Planer',
      'Dokumenter og avtaler',
      'Kundeavtaler',
      'DOK-VILKAR',
    ]);
    expect(sti[3].kopier).toBe('/planer dok DOK-VILKAR. Instruks:');
    expect(sti[0].tilstand).toEqual({ flate: 'poster', dok: null });
    const bareGruppe = V.brodsmuler(V.lesUrl('?rom=planer&flate=dok&dgr=styring'), data);
    expect(bareGruppe.map((l) => l.niva)).toEqual(['rom', 'flate', 'gruppe']);
  });
});
