// =============================================================
// koPlanArbeid.test.ts: arbeidsflyten i Planer-rommet (lib/koPlanVisning.js, se docs/board.md):
// oversiktssiden (modulkortene, «Venter på deg», kapasiteten i Nå med vekstvarsel, nylig endret og
// registrert, «Arbeider nå»), «endret av økt», tastene (j, k, Enter, /, 1 til 4, c, x, Esc og Ctrl+K), kommandolinja
// (treff med brødsmulesti, nylig brukte øverst), flervalget og endringen i raden (kallene til ko.mjs og angringen),
// og at kallene virker mot ko.mjs på en kopi i en midlertidig mappe (aldri det ekte registeret). Til slutt koblingene
// i index.html, ko-tavle.mjs og de nye filene (ingen innerHTML).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../koPlanVisning.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../koPlan.js');

const KLIENT = join(__dirname, '..', '..', 'ko-tavle');
const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');
const NAA = new Date('2026-10-15T10:00:00Z');

type Post = Record<string, unknown>;

/** En post slik /api/planer sender den, med standardverdier. */
function post(id: string, ekstra: Post = {}): Post {
  return {
    id,
    tittel: `Tittel ${id}`,
    prosjekt: 'eksport',
    modul: 'alfa',
    prioritet: 'senere',
    naa_kategori: [],
    modenhet: 'ide',
    modenhet_plan: 'ide',
    estimat: 'M',
    eierspm: [],
    jur_apne: 0,
    foreldet: false,
    blokkerer: [],
    aktiv: null,
    historikk: [],
    ...ekstra,
  };
}

const DATA = {
  moduler: [
    { oid: 'alfa', tittel: 'Alfa' },
    { oid: 'beta', tittel: 'Beta' },
    { oid: 'gamma', tittel: 'Gamma' },
  ],
  prosjekter: {
    eksport: { tittel: 'Eksport', kort: 'Eksport', omrade: 'alfa' },
    api: { tittel: 'API', kort: 'API', omrade: 'beta' },
    tom: { tittel: 'Uten poster', kort: 'Uten poster', omrade: 'gamma' },
  },
  poster: [
    post('PL-A', {
      prioritet: 'naa',
      naa_kategori: ['sikkerhet'],
      modenhet: 'bygget',
      eierspm: [
        { id: 'SP-1', avklart: false },
        { id: 'SP-2', avklart: true },
      ],
      jur_apne: 2,
      blokkerer: ['PL-B', 'PL-C'],
    }),
    post('PL-B', {
      prioritet: 'eier',
      modenhet: 'klar',
      eierspm: [{ id: 'SP-1', avklart: false }],
      foreldet: true,
      aktiv: { at: '2026-10-15T09:30:00Z', av: 'planøkt' },
    }),
    post('PL-C', { prioritet: 'dropp', modenhet: 'ide' }),
    post('PL-D', {
      prosjekt: 'api',
      modul: 'beta',
      modenhet: 'delvis',
      ferdige: 1,
      totalt: 2,
      aktiv: { at: '2026-10-15T09:50:00Z', av: 'annen' },
    }),
    post('PL-E', { prosjekt: null, modul: null }),
  ],
  beslutninger: {
    apne: [
      {
        id: 'SP-1',
        tekst: 'Velg leverandør',
        blokkerte_poster: ['PL-A', 'PL-B'],
        oppgaver: [],
        haster: false,
        frist: null,
        poster: ['PL-A'],
      },
      {
        id: 'SP-3',
        tekst: 'Haster',
        blokkerte_poster: [],
        oppgaver: ['X'],
        haster: true,
        frist: '2026-10-20',
        poster: [],
      },
      {
        id: 'SP-4',
        tekst: 'Lite',
        blokkerte_poster: [],
        oppgaver: [],
        haster: false,
        frist: null,
        poster: [],
      },
    ],
  },
  jur_punkter: [
    {
      id: 'J-1',
      sporsmal: 'Trengs en vurdering?',
      status: 'apen',
      apen: true,
      blokkerer: 'prod',
      post: 'PL-A',
      frist_dager: null,
      frist: null,
    },
    {
      id: 'J-2',
      sporsmal: 'Lukket',
      status: 'avklart',
      apen: false,
      blokkerer: 'prod',
      post: 'PL-A',
    },
    {
      id: 'J-3',
      sporsmal: 'På droppet post',
      status: 'apen',
      apen: true,
      blokkerer: 'ingenting',
      post: 'PL-C',
    },
  ],
};

describe('oversikten', () => {
  it('modulkortene: alle moduler, droppede for seg, stolper, bygget og tre varseltall', () => {
    const k = V.modulKort(DATA);
    expect(k.map((x: Post) => x.oid)).toEqual(['alfa', 'beta', 'gamma', '(uten-modul)']);
    const alfa = k[0];
    expect(alfa).toMatchObject({
      tittel: 'Alfa',
      antall: 2,
      droppet: 1,
      bygget: 1,
      eierspm: 1,
      juridisk: 2,
      foreldet: 1,
      aktiv: 1,
    });
    expect(alfa.prioritet.map((x: Post) => [x.id, x.antall])).toEqual([
      ['naa', 1],
      ['eier', 1],
      ['senere', 0],
    ]);
    expect(alfa.modenhet.find((x: Post) => x.id === 'planlagt').antall).toBe(1);
    expect(alfa.modenhet.find((x: Post) => x.id === 'bygget').antall).toBe(1);
    expect(k[2]).toMatchObject({ oid: 'gamma', antall: 0, andel: 0 });
    expect(k[1].andel).toBeCloseTo(0.5);
  });

  it('«Venter på deg»: hastende først, så det som blokkerer mest, høyst fem, og aldri droppede poster', () => {
    const v = V.venterPaaDeg(DATA);
    expect(v.punkter.map((x: Post) => x.id)).toEqual(['SP-3', 'J-1', 'SP-1', 'SP-4']);
    expect(v.totalt).toBe(4);
    expect(v.punkter[1]).toMatchObject({
      type: 'jur',
      blokkerer: 3,
      hindrer: 'prod',
      post: 'PL-A',
    });
    expect(V.venterPaaDeg(DATA, { maks: 2 }).punkter).toHaveLength(2);
    expect(V.flateAntall(DATA).oversikt).toBe(4);
  });

  it('«Arbeider nå»: postene med levende markør, nyeste puls først', () => {
    expect(V.arbeiderNaa(DATA).map((x: Post) => x.id)).toEqual(['PL-D', 'PL-B']);
  });

  it('kapasiteten: vekst i Nå fra nye poster og endringsloggen, med varsel når Nå vokser raskere enn køen tømmes', () => {
    const reg = {
      poster: [
        { id: 'PL-A', prioritet: 'naa', estimat: 'L', opprettet: '2026-10-10T00:00:00Z' },
        { id: 'PL-B', prioritet: 'naa', estimat: 'M', opprettet: '2026-01-01T00:00:00Z' },
        { id: 'PL-C', prioritet: 'naa', estimat: 'S', opprettet: '2026-01-01T00:00:00Z' },
        { id: 'PL-D', prioritet: 'senere', estimat: 'XL', opprettet: '2026-10-10T00:00:00Z' },
      ],
      endringslogg: [
        {
          nr: 1,
          at: '2026-10-12T00:00:00Z',
          endringer: [
            { samling: 'poster', id: 'PL-B', felt: 'prioritet', for: 'senere', etter: 'naa' },
          ],
        },
        {
          nr: 2,
          at: '2026-08-01T00:00:00Z',
          endringer: [
            { samling: 'poster', id: 'PL-C', felt: 'prioritet', for: 'senere', etter: 'naa' },
          ],
        },
      ],
    };
    const t = V.naaTilgang(reg, { naa: NAA, dager: 28, estimatSpor: P.ESTIMAT_SPOR });
    expect(t.ider.sort()).toEqual(['PL-A', 'PL-B']);
    expect(t.spor).toBe(P.ESTIMAT_SPOR.L + P.ESTIMAT_SPOR.M);
    expect(t.per_uke).toBeCloseTo(t.spor / 4, 1);
    expect(V.kapasitetVarsel({ per_uke: 1 }, t).varsel).toBe(true);
    expect(V.kapasitetVarsel({ per_uke: 1 }, t).varsel_tekst).toMatch(
      /vokser raskere enn køen tømmes/,
    );
    expect(V.kapasitetVarsel({ per_uke: 50 }, t).varsel).toBe(false);
    expect(V.kapasitetVarsel({ per_uke: null }, { spor: 0, per_uke: 0, poster: 0 }).varsel).toBe(
      false,
    );
  });

  it('nylig endret og nylig registrert, nyeste først', () => {
    const reg = {
      poster: [
        { id: 'PL-A', tittel: 'A', opprettet: '2026-10-01T00:00:00Z' },
        { id: 'PL-B', tittel: 'B', opprettet: '2026-10-14T00:00:00Z' },
        { id: 'PL-C', tittel: 'C' },
      ],
      endringslogg: [
        {
          nr: 1,
          at: 'x',
          av: 'agent',
          handling: 'plan ny',
          endringer: [{ id: 'PL-A' }, { id: 'PL-A' }],
        },
        {
          nr: 2,
          at: 'y',
          av: 'tavla',
          handling: 'plan prioriter',
          angret: true,
          endringer: [{ id: 'PL-B' }],
        },
      ],
    };
    expect(V.nyligEndret(reg)).toEqual([
      { nr: 2, at: 'y', av: 'tavla', handling: 'plan prioriter', angret: true, ider: ['PL-B'] },
      { nr: 1, at: 'x', av: 'agent', handling: 'plan ny', angret: false, ider: ['PL-A'] },
    ]);
    expect(V.nyligRegistrert(reg).map((x: Post) => x.id)).toEqual(['PL-B', 'PL-A']);
  });

  it('planerData har kapasitet, nylig og opprettet; oversikten er egen flate med egen sti', () => {
    const reg = P.tomtRegister('2026-10-14T09:00:00.000Z');
    const prosjekter = { eksport: { tittel: 'Eksport', omrade: 'alfa' } };
    const r = P.nyPost(
      reg,
      {
        id: 'PL-X',
        tittel: 'X',
        prosjekt: 'eksport',
        prioritet: 'naa',
        naa_kategori: ['viktig'],
        prioritet_grunn: 'Regel 4: blokkerer.',
        modenhet: 'klar',
        estimat: 'M',
      },
      {
        rolle: 'agent',
        prosjekter,
        sporsmal: {},
        finnesSti: () => true,
        naa: '2026-10-14T09:00:00.000Z',
      },
    );
    expect(r.feil).toEqual([]);
    const d = V.planerData(
      reg,
      { prosjekter, omrader: { alfa: { tittel: 'Alfa' } } },
      { naa: NAA, ferdigePerUke: 0.25 },
    );
    expect(d.kapasitet).toMatchObject({ poster: 1, spor: P.ESTIMAT_SPOR.M });
    expect(d.kapasitet.tilgang.ider).toEqual(['PL-X']);
    expect(d.kapasitet.varsel).toBe(true);
    expect(d.nylig.registrert[0].id).toBe('PL-X');
    expect(d.poster[0].opprettet).toBe('2026-10-14T09:00:00.000Z');

    const t = V.lesUrl('?rom=planer&flate=oversikt');
    expect(t.flate).toBe('oversikt');
    expect(V.skrivUrl(t)).toBe('?rom=planer&flate=oversikt');
    expect(V.lesUrl('?rom=planer').flate).toBe('poster'); // gamle lenker og lagrede visninger er uendret
    const sti = V.brodsmuler(t, d);
    expect(sti.map((l: Post) => l.tekst)).toEqual(['Planer', 'Oversikt']);
    expect(sti[0].tilstand).toEqual({ flate: 'poster' });
  });
});

describe('live oppdatering: «endret av økt»', () => {
  const med = (nr: number, av: string) => [{ nr, av, at: 'x', handling: 'h', felt: ['tittel'] }];
  it('nye poster og nyere endringslogg markeres, men ikke det tavla selv skrev, og ikke første henting', () => {
    const gammel = {
      poster: [
        post('PL-A', { historikk: med(3, 'agent') }),
        post('PL-B', { historikk: med(4, 'agent') }),
      ],
    };
    const ny = {
      poster: [
        post('PL-A', { historikk: med(5, 'økt-1') }),
        post('PL-B', { historikk: med(6, 'tavla') }),
        post('PL-C', { historikk: med(7, 'økt-1') }),
      ],
    };
    expect(V.endredePoster(gammel, ny)).toEqual([
      { id: 'PL-A', av: 'økt-1', ny: false },
      { id: 'PL-C', av: 'økt-1', ny: true },
    ]);
    expect(V.endredePoster(null, ny)).toEqual([]);
    expect(V.endredePoster(ny, ny)).toEqual([]);
  });
});

describe('tastene', () => {
  const t = (key: string, ekstra: Post = {}, ctx: Post = {}) =>
    V.tastHandling({ key, ...ekstra }, ctx);
  it('j, k, Enter, /, 1 til 4, c, x og Esc; Ctrl+K og Cmd+K overalt', () => {
    expect(t('j')).toEqual({ type: 'flytt', retning: 1 });
    expect(t('k')).toEqual({ type: 'flytt', retning: -1 });
    expect(t('Enter')).toEqual({ type: 'aapne' });
    expect(t('/')).toEqual({ type: 'sok' });
    expect(['1', '2', '3', '4'].map((k) => t(k).verdi)).toEqual(['naa', 'senere', 'eier', 'dropp']);
    expect(t('c')).toEqual({ type: 'kopier' });
    expect(t('x')).toEqual({ type: 'merk' });
    expect(t('Escape')).toEqual({ type: 'avbryt' });
    expect(t('k', { ctrlKey: true })).toEqual({ type: 'palett' });
    expect(t('K', { metaKey: true }, { skrivefelt: true })).toEqual({ type: 'palett' });
  });
  it('i skrivefelt, med Ctrl, Alt eller Cmd, og mens noe er åpent, styrer bokstavene ingenting', () => {
    expect(t('j', {}, { skrivefelt: true })).toBeNull();
    expect(t('c', { ctrlKey: true })).toBeNull();
    expect(t('x', { altKey: true })).toBeNull();
    expect(t('1', {}, { opptatt: true })).toBeNull();
    expect(t('k', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(t('J')).toBeNull();
    expect(t('5')).toBeNull();
  });
  it('naboPost stopper i endene og starter i riktig ende', () => {
    const l = ['PL-A', 'PL-B', 'PL-C'];
    expect(V.naboPost(l, 'PL-B', 1)).toBe('PL-C');
    expect(V.naboPost(l, 'PL-C', 1)).toBe('PL-C');
    expect(V.naboPost(l, 'PL-A', -1)).toBe('PL-A');
    expect(V.naboPost(l, null, 1)).toBe('PL-A');
    expect(V.naboPost(l, 'PL-X', -1)).toBe('PL-C');
    expect(V.naboPost([], 'PL-A', 1)).toBeNull();
  });
  it('1 til 4: Senere og Eier lagres rett, Nå spør om kategori og Dropp om grunn, samme gir uendret', () => {
    const p = post('PL-A', { prioritet: 'senere' });
    expect(V.prioritetFraTast(p, 'eier')).toEqual({
      gruppe: { ider: ['PL-A'], prioritet: 'eier', kategori: [] },
    });
    expect(V.prioritetFraTast(p, 'senere')).toEqual({ uendret: true });
    expect(V.prioritetFraTast(p, 'naa')).toEqual({ meny: 'naa' });
    expect(V.prioritetFraTast(p, 'dropp')).toEqual({ meny: 'dropp' });
    expect(V.prioritetFraTast(post('PL-B', { prioritet: 'naa' }), 'naa')).toEqual({
      uendret: true,
    });
    expect(V.prioritetFraTast(null, 'naa')).toEqual({ uendret: true });
  });
});

describe('kommandolinja (Ctrl+K)', () => {
  const k = V.palettKandidater(DATA);
  it('kandidatene: handlinger, moduler, prosjekter med poster og alle poster med brødsmulesti', () => {
    expect(k.filter((x: Post) => x.type === 'prosjekt').map((x: Post) => x.id)).toEqual([
      'eksport',
      'api',
    ]);
    const pd = k.find((x: Post) => x.noekkel === 'post:PL-D');
    expect(pd.sti).toBe('Planer › Beta › API');
    expect(k.find((x: Post) => x.noekkel === 'post:PL-C').dropp).toBe(true);
    expect(k.find((x: Post) => x.noekkel === 'prosjekt:api').sti).toBe('Planer › Beta');
    expect(k.some((x: Post) => x.noekkel === 'handling:kopier-valgte')).toBe(true);
    expect(k.some((x: Post) => x.noekkel === 'handling:klargjor')).toBe(true);
  });
  it('tomt søk: nylig brukte først (de som finnes), så handlingene og modulene', () => {
    const r = V.palettTreff(k, '', ['post:PL-B', 'post:PL-BORTE', 'modul:beta']);
    expect(r.slice(0, 2).map((x: Post) => [x.noekkel, x.nylig])).toEqual([
      ['post:PL-B', true],
      ['modul:beta', true],
    ]);
    expect(r.filter((x: Post) => x.noekkel === 'modul:beta')).toHaveLength(1);
    expect(r.some((x: Post) => x.type === 'post' && !x.nylig)).toBe(false);
  });
  it('søk: alle ord må treffe; eksakt id først, nylig brukte over det igjen, droppede bak', () => {
    expect(V.palettTreff(k, 'pl-d')[0].noekkel).toBe('post:PL-D');
    expect(V.palettTreff(k, 'beta tittel').map((x: Post) => x.noekkel)).toEqual(['post:PL-D']);
    const tittel = V.palettTreff(k, 'tittel', ['post:PL-E']);
    expect(tittel[0]).toMatchObject({ noekkel: 'post:PL-E', nylig: true });
    expect(tittel[tittel.length - 1].noekkel).toBe('post:PL-C');
    expect(V.palettTreff(k, 'finnesikke')).toEqual([]);
    expect(V.palettTreff(k, '(')).toEqual(expect.any(Array)); // spesialtegn knekker ikke
  });
  it('leggTilNylig: først, uten dubletter, høyst åtte, og bare gyldige nøkler', () => {
    let l: string[] = [];
    for (let i = 0; i < 10; i += 1) l = V.leggTilNylig(l, `post:PL-${i}`);
    expect(l).toHaveLength(8);
    expect(l[0]).toBe('post:PL-9');
    expect(V.leggTilNylig(l, 'post:PL-5')[0]).toBe('post:PL-5');
    expect(V.leggTilNylig(l, 'post:PL-5').filter((x: string) => x === 'post:PL-5')).toHaveLength(1);
    expect(V.leggTilNylig(['tull', 'post:PL-1'], 'javascript:x')).toEqual(['post:PL-1']);
  });
  it('startlinjene for flere poster, én per linje', () => {
    expect(V.startlinjer(['PL-A', 'PL-BORTE', 'PL-D'], DATA).split('\n')).toEqual([
      '/planer PL-A (Alfa › Eksport › Tittel PL-A). Instruks:',
      '/planer PL-D (Beta › API › Tittel PL-D). Instruks:',
    ]);
  });
});

describe('flervalg og endring i raden: kallene', () => {
  it('prioritet går via plan prioriter som eier; Nå krever kategori og Dropp grunn', () => {
    const r = V.planMasseKall({
      handling: 'prioritet',
      ider: ['PL-A', 'PL-B'],
      prioritet: 'naa',
      kategori: 'for-prod',
    });
    expect(r.feil).toEqual([]);
    expect(r.kall).toEqual([
      [
        'plan',
        'prioriter',
        'PL-A',
        'PL-B',
        'naa',
        '--kategori',
        'for-prod',
        '--satt-av',
        'eier',
        '--av',
        'tavla',
        '--json',
      ],
    ]);
    expect(
      V.planMasseKall({ handling: 'prioritet', ider: ['PL-A'], prioritet: 'naa' }).feil.length,
    ).toBe(1);
    expect(
      V.planMasseKall({ handling: 'prioritet', ider: ['PL-A'], prioritet: 'dropp' }).feil[0],
    ).toMatch(/grunn/);
  });
  it('prosjekt og modenhet: plan endre per post med --sett; bare modenhetene eieren setter', () => {
    expect(
      V.planMasseKall({ handling: 'prosjekt', ider: ['PL-A'], prosjekt: 'api' }).kall,
    ).toEqual([
      [
        'plan',
        'endre',
        'PL-A',
        '--sett',
        '{"prosjekt":"api"}',
        '--satt-av',
        'eier',
        '--av',
        'tavla',
        '--json',
      ],
    ]);
    expect(V.planMasseKall({ handling: 'prosjekt', ider: ['PL-A'], prosjekt: '' }).kall[0][4]).toBe(
      '{"prosjekt":null}',
    );
    expect(
      V.planMasseKall({ handling: 'prosjekt', ider: ['PL-A'], prosjekt: '--slett' }).feil,
    ).toEqual(['ugyldig prosjekt']);
    expect(
      V.planMasseKall({ handling: 'modenhet', ider: ['PL-A', 'PL-B'], modenhet: 'klar' }).kall,
    ).toHaveLength(2);
    expect(
      V.planMasseKall({ handling: 'modenhet', ider: ['PL-A'], modenhet: 'bygget' }).feil[0],
    ).toMatch(/regnes ut/);
    expect(V.MODENHET_MANUELL).toEqual(P.MODENHET_MANUELL);
  });
  it('sammenslåing: inn i en av de valgte, minst to poster', () => {
    expect(
      V.planMasseKall({ handling: 'slaa-sammen', ider: ['PL-A', 'PL-B', 'PL-C'], til: 'PL-B' })
        .kall,
    ).toEqual([['plan', 'slaa-sammen', 'PL-B', 'PL-A', 'PL-C', '--av', 'tavla', '--json']]);
    expect(
      V.planMasseKall({ handling: 'slaa-sammen', ider: ['PL-A', 'PL-B'], til: 'PL-X' }).feil.length,
    ).toBe(1);
    expect(
      V.planMasseKall({ handling: 'slaa-sammen', ider: ['PL-A'], til: 'PL-A' }).feil.length,
    ).toBe(1);
  });
  it('alt ugyldig nektes før noe kjøres', () => {
    expect(V.planMasseKall(null).kall).toEqual([]);
    expect(V.planMasseKall({ handling: 'slett', ider: ['PL-A'] }).feil[0]).toMatch(
      /ukjent handling/,
    );
    expect(V.planMasseKall({ handling: 'modenhet', ider: [], modenhet: 'klar' }).feil).toEqual([
      'ingen poster valgt',
    ]);
    expect(
      V.planMasseKall({ handling: 'modenhet', ider: ['PL-A', 'PL-A'], modenhet: 'klar' }).feil
        .length,
    ).toBe(1);
    expect(
      V.planMasseKall({ handling: 'modenhet', ider: ['--torr'], modenhet: 'klar' }).feil.length,
    ).toBe(1);
    const mange = Array.from({ length: V.MASSE_MAKS + 1 }, (_, i) => `PL-${i}`);
    expect(
      V.planMasseKall({ handling: 'modenhet', ider: mange, modenhet: 'klar' }).feil[0],
    ).toMatch(/for mange/);
  });
  it('angre: nyeste først, bare hele tall', () => {
    expect(V.angreKall([3, 5, 4]).kall.map((k: string[]) => k[3])).toEqual(['5', '4', '3']);
    expect(V.angreKall([]).feil.length).toBe(1);
    expect(V.angreKall(['5']).feil.length).toBe(1);
    expect(V.angreKall([0]).feil.length).toBe(1);
  });
  it('teksten for bekreftelsen', () => {
    expect(
      V.masseTekst({
        handling: 'prioritet',
        ider: ['PL-A'],
        prioritet: 'naa',
        kategori: 'for-prod',
      }),
    ).toBe('PL-A: prioritet Nå (før prod)');
    expect(
      V.masseTekst(
        { handling: 'prosjekt', ider: ['PL-A', 'PL-B'], prosjekt: 'eksport' },
        { prosjekter: DATA.prosjekter },
      ),
    ).toBe('2 poster: prosjekt Eksport');
  });
});

describe('ko.mjs med kallene fra flervalget (kopi i en midlertidig mappe)', () => {
  let mappe: string;
  const kjor = (args: string[]) => {
    try {
      const ut = execFileSync(process.execPath, [KO_MJS, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: mappe,
          KO_GIT: mappe,
          KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
          KO_PLAN_KILDEROT: mappe,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { kode: 0, data: JSON.parse(ut.trim().split('\n').pop() ?? 'null') };
    } catch (e) {
      const x = e as { status: number; stdout: string };
      let data = null;
      try {
        data = JSON.parse(
          String(x.stdout ?? '')
            .trim()
            .split('\n')
            .pop() ?? 'null',
        );
      } catch {
        data = null;
      }
      return { kode: x.status, data };
    }
  };
  const lesReg = () => JSON.parse(readFileSync(join(mappe, 'planer.json'), 'utf8'));
  const finn = (id: string) => lesReg().poster.find((p: Post) => p.id === id);

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-arbeid-'));
    const prosjekter = {
      eksport: { tittel: 'Eksport', omrade: 'alfa' },
      annet: { tittel: 'Annet', omrade: 'alfa' },
    };
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({
        endret: '2026-10-14T08:00:00.000Z',
        oppgaver: [],
        prosjekter,
        omrader: { alfa: { tittel: 'Alfa' } },
        sporsmal: {},
        avklart: [],
      }),
    );
    const reg = P.tomtRegister('2026-10-14T09:00:00.000Z');
    for (const id of ['PL-A', 'PL-B', 'PL-C']) {
      const r = P.nyPost(
        reg,
        {
          id,
          tittel: `Tittel ${id}`,
          prosjekt: 'eksport',
          prioritet: 'senere',
          prioritet_grunn: 'Regel 8: uten frist.',
          modenhet: 'utredet',
        },
        { rolle: 'agent', prosjekter, sporsmal: {}, finnesSti: () => true },
      );
      if (r.feil.length) throw new Error(r.feil.join('; '));
    }
    writeFileSync(join(mappe, 'planer.json'), JSON.stringify(reg));
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  /** Som serveren: forhåndsvis (--torr), lagre med --forvent-endret i kjede, returner endringsloggnumrene. */
  const lagre = (b: Post) => {
    const { feil, kall } = V.planMasseKall(b);
    expect(feil).toEqual([]);
    const for_ = readFileSync(join(mappe, 'planer.json'), 'utf8');
    const torr = kall.map((k: string[]) => kjor([...k, '--torr']));
    expect(
      torr.every((r: { kode: number; data: Post }) => r.kode === 0 && r.data?.ok === true),
    ).toBe(true);
    expect(readFileSync(join(mappe, 'planer.json'), 'utf8')).toBe(for_);
    let versjon = torr[0].data.endret;
    const logg: number[] = [];
    for (const k of kall) {
      const r = kjor([...k, '--forvent-endret', versjon]);
      expect(r.kode).toBe(0);
      logg.push(r.data.logg);
      versjon = r.data.endret;
    }
    return logg;
  };

  it('prosjekt og modenhet for flere poster lagres, og angre tar alt tilbake nyeste først', () => {
    const l1 = lagre({ handling: 'prosjekt', ider: ['PL-A', 'PL-B'], prosjekt: 'annet' });
    expect([finn('PL-A').prosjekt, finn('PL-B').prosjekt, finn('PL-C').prosjekt]).toEqual([
      'annet',
      'annet',
      'eksport',
    ]);
    const l2 = lagre({ handling: 'modenhet', ider: ['PL-C'], modenhet: 'klar' });
    expect(finn('PL-C').modenhet).toBe('klar');
    for (const k of V.angreKall([...l1, ...l2]).kall) expect(kjor(k).kode).toBe(0);
    expect([finn('PL-A').prosjekt, finn('PL-B').prosjekt, finn('PL-C').modenhet]).toEqual([
      'eksport',
      'eksport',
      'utredet',
    ]);
  });

  it('prioritet fra raden lagres som eier; sammenslåing flytter de andre til arkivet og kan angres', () => {
    lagre({ handling: 'prioritet', ider: ['PL-A'], prioritet: 'naa', kategori: 'viktig' });
    expect(finn('PL-A')).toMatchObject({
      prioritet: 'naa',
      naa_kategori: ['viktig'],
      prioritet_satt_av: 'eier',
    });
    const l = lagre({ handling: 'slaa-sammen', ider: ['PL-A', 'PL-B'], til: 'PL-A' });
    expect(finn('PL-B')).toBeUndefined();
    expect(lesReg().arkiv['PL-B']).toBeTruthy();
    for (const k of V.angreKall(l).kall) expect(kjor(k).kode).toBe(0);
    expect(finn('PL-B')).toBeTruthy();
  });

  it('utdatert forvent gir exit 6 og ingen skriving', () => {
    const { kall } = V.planMasseKall({ handling: 'modenhet', ider: ['PL-A'], modenhet: 'klar' });
    const for_ = readFileSync(join(mappe, 'planer.json'), 'utf8');
    const r = kjor([...kall[0], '--forvent-endret', '2020-01-01T00:00:00.000Z']);
    expect(r.kode).toBe(6);
    expect(readFileSync(join(mappe, 'planer.json'), 'utf8')).toBe(for_);
  });
});

describe('koblingene (index.html, ko-tavle.mjs og de nye filene)', () => {
  const html = readFileSync(join(KLIENT, 'index.html'), 'utf8');
  const server = readFileSync(join(KLIENT, '..', 'ko-tavle.mjs'), 'utf8');
  const planer = readFileSync(join(KLIENT, 'planer', 'planer.js'), 'utf8');
  const oversikt = readFileSync(join(KLIENT, 'planer', 'oversikt.js'), 'utf8');
  const arbeid = readFileSync(join(KLIENT, 'planer', 'arbeid.js'), 'utf8');
  const css = readFileSync(join(KLIENT, 'planer', 'planer.css'), 'utf8');
  /** Koden uten kommentarer (så en kommentar som nevner innerHTML ikke teller). */
  const kode = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('de nye filene lastes før planer.js og serveres av tavla', () => {
    const i = (s: string) => html.indexOf(s);
    expect(i('/planer/oversikt.js')).toBeGreaterThan(0);
    expect(i('/planer/arbeid.js')).toBeGreaterThan(i('/planer/oversikt.js'));
    expect(i('/planer/planer.js')).toBeGreaterThan(i('/planer/arbeid.js'));
    expect(server).toMatch(/'\/planer\/oversikt\.js'/);
    expect(server).toMatch(/'\/planer\/arbeid\.js'/);
  });
  it('skriveruter og live oppdatering i serveren, og all skriving går via ko.mjs', () => {
    expect(server).toMatch(/sti === '\/api\/plan-masse'\) return planMasse\(b\)/);
    expect(server).toMatch(/sti === '\/api\/plan-angre'\) return planAngre\(b\)/);
    expect(server).toMatch(/searchParams\.get\('vent'\) === '1'/);
    expect(server).toMatch(/fs\.watch\(MAPPE/);
    const masse = server.slice(
      server.indexOf('async function planMasse'),
      server.indexOf('async function planAngre'),
    );
    expect(masse).toMatch(/PV\.planMasseKall/);
    expect(masse).not.toMatch(/writeFileSync|renameSync/);
  });
  it('ingen innerHTML, all tekst via textContent; planer.js kobler inn oversikten og flervalget', () => {
    for (const f of [oversikt, arbeid])
      expect(kode(f)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
    expect(planer).toMatch(/window\.KoPlanOversikt\.side\(arbeidHjelp, d\)/);
    expect(planer).toMatch(/window\.KoPlanArbeid\.valglinje\(arbeidHjelp, d\)/);
    expect(planer).toMatch(/V\.lesUrl\('\?rom=planer&flate=oversikt'\)/);
    expect(planer).toMatch(/vent: true/);
  });
  it('CSS: ingen hex, og pulsen står stille ved redusert bevegelse', () => {
    expect(kode(css)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.puls/);
  });
});
