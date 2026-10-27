// =============================================================
// koPlanKart.test.ts: prioritetskartet og fristbåndet i Planer-rommet (se docs/board.md).
//
// Render-tester virker ikke her, så reglene er rene funksjoner i lib/koPlanVisning.js (samme fil som
// nettleseren laster) og testes direkte: kolonnene, rutenettet med utkastet, flyttingen (mus og tastatur bruker de
// samme funksjonene), forhåndsvisningens endringer og feil, gruppene og argumentene til `ko.mjs plan prioriter`, og
// fristbåndet. Argumentene kjøres også mot ko.mjs på en kopi i en midlertidig mappe (forhåndsvisning, skriving med
// --forvent-endret, utdatert versjon og angre), så serverens oversettelse er bevist mot den ekte kommandoen.
// Til slutt leses kart.js, planer.js, index.html og ko-tavle.mjs som tekst for koblingene.
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

type Post = Record<string, unknown> & { id: string };

/** En post slik /api/planer sender den. */
function post(id: string, ekstra: Record<string, unknown> = {}): Post {
  return {
    id,
    tittel: `Tittel ${id}`,
    modul: 'alfa',
    prosjekt: 'eksport',
    prioritet: 'senere',
    naa_kategori: [],
    eierspm: [],
    frist: null,
    ...ekstra,
  };
}
const MODULER = [
  { oid: 'alfa', tittel: 'Alfa' },
  { oid: 'gamma', tittel: 'Gamma' },
];

describe('kolonnene og rutenettet', () => {
  it('Nå står under den første kategorien (sikkerhet, før prod, viktig); ellers prioriteten', () => {
    expect(
      V.kartKolonneFor(post('PL-A', { prioritet: 'naa', naa_kategori: ['viktig', 'for-prod'] })),
    ).toBe('naa-for-prod');
    expect(V.kartKolonneFor(post('PL-A', { prioritet: 'naa', naa_kategori: ['sikkerhet'] }))).toBe(
      'naa-sikkerhet',
    );
    expect(V.kartKolonneFor(post('PL-A', { prioritet: 'naa' }))).toBe('naa-viktig');
    expect(V.kartKolonneFor(post('PL-A', { prioritet: 'eier' }))).toBe('eier');
    expect(V.kartKolonneFor(post('PL-A', { prioritet: 'tull' }))).toBeNull();
    expect(V.KART_KOLONNER.map((k: { id: string }) => k.id)).toEqual([
      'naa-sikkerhet',
      'naa-for-prod',
      'naa-viktig',
      'eier',
      'senere',
      'dropp',
    ]);
    // Farge er aldri eneste bærer: hver kolonne har symbol og tekst.
    for (const k of V.KART_KOLONNER) expect(k.symbol && k.tekst).toBeTruthy();
    expect(V.kartKolonne('dropp').foldet).toBe(true);
  });

  it('reglene i prioritetsreglene (tabellen i koPlan.js) knyttes til kolonnene', () => {
    const nr = (id: string) =>
      V.kolonneRegler(P.PRIORITETSREGLER, id).map((r: { nr: number }) => r.nr);
    expect(nr('naa-sikkerhet')).toEqual([1]);
    expect(nr('naa-for-prod')).toEqual([2, 3]);
    expect(nr('naa-viktig')).toEqual([2, 4, 5]);
    expect(nr('eier')).toEqual([6]);
    expect(nr('dropp')).toEqual([7]);
    expect(nr('senere')).toEqual([8]);
  });

  it('rader per modul med treff, «Uten modul» sist, og utkastet flytter brikken', () => {
    const poster = [
      post('PL-A', { prioritet: 'naa', naa_kategori: ['sikkerhet'] }),
      post('PL-B'),
      post('PL-C', { modul: 'gamma', prioritet: 'eier' }),
      post('PL-D', { modul: null }),
      post('PL-E', { prioritet: 'ukjent' }),
    ];
    const n = V.kartRutenett(poster, MODULER, { 'PL-B': { til: 'naa-viktig' } });
    expect(n.rader.map((r: { oid: string }) => r.oid)).toEqual(['alfa', 'gamma', V.UTEN_MODUL]);
    const alfa = n.rader[0];
    expect(alfa.celler['naa-viktig'][0]).toMatchObject({ flyttet: true, fra: 'senere' });
    expect(alfa.celler.senere).toEqual([]);
    expect(alfa.antall).toBe(2);
    expect(n.kolonner.find((k: { id: string }) => k.id === 'naa-viktig').antall).toBe(1);
    expect(n.utenPrioritet.map((p: Post) => p.id)).toEqual(['PL-E']);
  });

  it('kartet har samme filtre som listen, pluss de droppede til den foldede kolonnen', () => {
    const poster = [
      post('PL-A'),
      post('PL-B', { prioritet: 'dropp' }),
      post('PL-C', { modul: 'gamma' }),
    ];
    const filter = { ...V.tomtFilter(), modul: ['alfa'] };
    expect(V.filtrer(poster, filter, '', { naa: NAA }).map((p: Post) => p.id)).toEqual(['PL-A']);
    expect(V.kartPoster(poster, filter, '', { naa: NAA }).map((p: Post) => p.id)).toEqual([
      'PL-A',
      'PL-B',
    ]);
    // Velger prioritetsfilteret selv, gjelder det som i listen.
    const bareNaa = { ...V.tomtFilter(), pri: ['senere'] };
    expect(V.kartPoster(poster, bareNaa, '', { naa: NAA }).map((p: Post) => p.id)).toEqual([
      'PL-A',
      'PL-C',
    ]);
  });
});

describe('utkastet', () => {
  const a = post('PL-A');
  const b = post('PL-B', { prioritet: 'naa', naa_kategori: ['viktig'] });

  it('flytting, tilbake til start fjerner flyttingen, og grunnen følger Dropp', () => {
    let u = V.flyttIUtkast({}, a, 'dropp');
    expect(u).toEqual({ 'PL-A': { til: 'dropp' } });
    u = V.settUtkastGrunn(u, 'PL-A', 'Erstattet av PL-B.');
    expect(u['PL-A'].grunn).toBe('Erstattet av PL-B.');
    expect(V.flyttIUtkast(u, a, 'dropp')['PL-A'].grunn).toBe('Erstattet av PL-B.');
    expect(V.flyttIUtkast(u, a, 'eier')).toEqual({ 'PL-A': { til: 'eier' } });
    expect(V.flyttIUtkast(u, a, 'senere')).toEqual({});
    // Grunn bare på Dropp; ukjent kolonne endrer ingenting.
    expect(V.settUtkastGrunn({ 'PL-A': { til: 'eier' } }, 'PL-A', 'x')).toEqual({
      'PL-A': { til: 'eier' },
    });
    expect(V.flyttIUtkast({}, a, 'tull')).toEqual({});
  });

  it('tastaturet flytter til nabokolonnen og stopper ved kanten', () => {
    expect(V.kolonneNabo('eier', -1)).toBe('naa-viktig');
    expect(V.kolonneNabo('eier', 1)).toBe('senere');
    expect(V.kolonneNabo('naa-sikkerhet', -1)).toBeNull();
    expect(V.kolonneNabo('dropp', 1)).toBeNull();
    expect(V.kolonneNabo('tull', 1)).toBeNull();
  });

  it('rensUtkast fjerner borte poster og det som alt står der (endret av en annen økt)', () => {
    const u = { 'PL-A': { til: 'eier' }, 'PL-B': { til: 'naa-viktig' }, 'PL-X': { til: 'senere' } };
    expect(V.rensUtkast(u, [a, b])).toEqual({ 'PL-A': { til: 'eier' } });
  });

  it('endringene til forhåndsvisningen, og Dropp uten grunn stopper lagringen', () => {
    const u = { 'PL-A': { til: 'dropp' }, 'PL-B': { til: 'naa-sikkerhet' } };
    const r = V.utkastEndringer(u, [b, a]);
    expect(
      r.endringer.map(
        (e: { id: string; fraTekst: string; tilTekst: string }) =>
          `${e.id}:${e.fraTekst}>${e.tilTekst}`,
      ),
    ).toEqual(['PL-B:Nå: viktig>Nå: sikkerhet', 'PL-A:Senere>Dropp']);
    expect(r.feil).toEqual(['PL-A: Dropp krever én setning som grunn.']);
    const ok = V.utkastEndringer({ 'PL-A': { til: 'dropp', grunn: '  Lav verdi. ' } }, [a]);
    expect(ok.feil).toEqual([]);
    expect(ok.endringer[0].grunn).toBe('Lav verdi.');
  });

  it('gruppene: én per prioritet og kategori, Dropp per grunn', () => {
    const poster = [
      post('PL-1'),
      post('PL-2'),
      post('PL-3'),
      post('PL-4'),
      post('PL-5', { prioritet: 'eier' }),
    ];
    const u = {
      'PL-1': { til: 'naa-for-prod' },
      'PL-2': { til: 'naa-for-prod' },
      'PL-3': { til: 'dropp', grunn: 'A.' },
      'PL-4': { til: 'dropp', grunn: 'B.' },
      'PL-5': { til: 'senere' },
    };
    const g = V.utkastGrupper(V.utkastEndringer(u, poster).endringer);
    expect(g).toEqual([
      { prioritet: 'naa', kategori: ['for-prod'], grunn: null, ider: ['PL-1', 'PL-2'] },
      { prioritet: 'dropp', kategori: [], grunn: 'A.', ider: ['PL-3'] },
      { prioritet: 'dropp', kategori: [], grunn: 'B.', ider: ['PL-4'] },
      { prioritet: 'senere', kategori: [], grunn: null, ider: ['PL-5'] },
    ]);
  });
});

describe('serverens sjekk: prioriterKall', () => {
  it('lager ett ko.mjs-kall per gruppe, som eier og fra tavla', () => {
    const r = V.prioriterKall([
      { prioritet: 'naa', kategori: ['sikkerhet'], ider: ['PL-A', 'PL-B'] },
      { prioritet: 'dropp', kategori: [], grunn: '--slett alt\u0007', ider: ['PL-C'] },
    ]);
    expect(r.feil).toEqual([]);
    expect(r.kall).toEqual([
      [
        'plan',
        'prioriter',
        'PL-A',
        'PL-B',
        'naa',
        '--kategori',
        'sikkerhet',
        '--satt-av',
        'eier',
        '--av',
        'tavla',
        '--json',
      ],
      // En grunn som starter med «-» ville blitt lest som et flagg; kontrolltegn fjernes.
      [
        'plan',
        'prioriter',
        'PL-C',
        'dropp',
        '--grunn',
        'slett alt',
        '--satt-av',
        'eier',
        '--av',
        'tavla',
        '--json',
      ],
    ]);
  });

  it('nekter alt når én gruppe er ugyldig', () => {
    const feil = (g: unknown) => V.prioriterKall(g).feil.join(' | ');
    expect(feil(null)).toContain('ingen endringer');
    expect(feil([{ prioritet: 'snart', ider: ['PL-A'] }])).toContain('ukjent prioritet');
    expect(feil([{ prioritet: 'naa', kategori: [], ider: ['PL-A'] }])).toContain(
      'nøyaktig én kategori',
    );
    expect(feil([{ prioritet: 'senere', kategori: ['viktig'], ider: ['PL-A'] }])).toContain(
      'bare Nå har kategori',
    );
    expect(feil([{ prioritet: 'naa', kategori: ['tull'], ider: ['PL-A'] }])).toContain(
      'ukjent Nå-kategori',
    );
    expect(feil([{ prioritet: 'eier', ider: ['--torr'] }])).toContain('ugyldige');
    expect(
      feil([
        { prioritet: 'eier', ider: ['PL-A'] },
        { prioritet: 'senere', ider: ['PL-A'] },
      ]),
    ).toContain('doble');
    expect(feil([{ prioritet: 'dropp', grunn: '  ', ider: ['PL-A'] }])).toContain('Dropp krever');
    const mange = Array.from({ length: V.UTKAST_MAKS + 1 }, (_, i) => `PL-N${i}`);
    expect(feil([{ prioritet: 'eier', ider: mange }])).toContain('for mange');
    const blandet = V.prioriterKall([
      { prioritet: 'eier', ider: ['PL-A'] },
      { prioritet: 'snart', ider: ['PL-B'] },
    ]);
    expect(blandet.kall).toEqual([]);
  });
});

describe('ko.mjs plan prioriter med argumentene fra kartet (kopi i en midlertidig mappe)', () => {
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

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-kart-'));
    const prosjekter = { eksport: { tittel: 'Eksport', omrade: 'alfa' } };
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

  it('forhåndsvisning skriver ingenting; lagring med versjonen skriver som eier; angre --nr tar det tilbake', () => {
    const poster = lesReg().poster.map((p: Post) => post(p.id, { prioritet: p.prioritet }));
    const u = {
      'PL-A': { til: 'naa-for-prod' },
      'PL-B': { til: 'dropp', grunn: 'Dekket av PL-A.' },
    };
    const { kall, feil } = V.prioriterKall(V.utkastGrupper(V.utkastEndringer(u, poster).endringer));
    expect(feil).toEqual([]);
    const for_ = readFileSync(join(mappe, 'planer.json'), 'utf8');

    const torr = kall.map((k: string[]) => kjor([...k, '--torr']));
    expect(torr.every((r: { kode: number }) => r.kode === 0)).toBe(true);
    expect(torr[0].data.endringer.map((e: { felt: string }) => e.felt)).toEqual(
      expect.arrayContaining(['prioritet', 'naa_kategori', 'prioritet_satt_av']),
    );
    expect(readFileSync(join(mappe, 'planer.json'), 'utf8')).toBe(for_);

    let versjon = torr[0].data.endret;
    const logg: number[] = [];
    for (const k of kall) {
      const r = kjor([...k, '--forvent-endret', versjon]);
      expect(r.kode).toBe(0);
      logg.push(r.data.logg);
      versjon = r.data.endret;
    }
    const etter = lesReg().poster;
    expect(etter.find((p: Post) => p.id === 'PL-A')).toMatchObject({
      prioritet: 'naa',
      naa_kategori: ['for-prod'],
      prioritet_satt_av: 'eier',
    });
    expect(etter.find((p: Post) => p.id === 'PL-B')).toMatchObject({
      prioritet: 'dropp',
      dropp_grunn: 'Dekket av PL-A.',
      prioritet_satt_av: 'eier',
    });

    // En gammel versjon (registeret er endret siden forhåndsvisningen) gir exit 6 og ingen skriving.
    const gammel = kjor([...kall[0], '--forvent-endret', torr[0].data.endret]);
    expect(gammel.kode).toBe(6);
    expect(gammel.data.utdatert).toBe(true);

    // Kompensasjonen serveren gjør når et senere kall feiler: angre de skrevne, nyeste først.
    for (const nr of [...logg].reverse())
      expect(kjor(['plan', 'angre', '--nr', String(nr), '--json', '--av', 'tavla']).kode).toBe(0);
    expect(lesReg().poster.map((p: Post) => p.prioritet)).toEqual(['senere', 'senere', 'senere']);
    // Et feil nummer angrer ingenting.
    expect(kjor(['plan', 'angre', '--nr', '999', '--json']).kode).not.toBe(0);
  });
});

describe('fristbåndet (90 dager)', () => {
  const poster = [
    post('PL-A', { frist: '2026-10-20' }),
    post('PL-B', { frist: '2026-10-01' }),
    post('PL-C', { frist: '2027-03-01' }),
    post('PL-D', { frist: '2026-11-01', prioritet: 'dropp' }),
    post('PL-E', {
      eierspm: [
        { id: 'SP-1', tekst: 'Velg leverandør', avklart: false, frist: '2026-11-15' },
        { id: 'SP-2', tekst: 'Avklart', avklart: true, frist: '2026-11-15' },
      ],
    }),
  ];
  const dokumenter = [
    {
      id: 'DOK-VILKAR',
      tittel: 'Vilkår',
      status: 'godkjent',
      frist: '2026-12-01',
      neste_revisjon: { dato: '2026-10-15', dager: 0 },
      planposter: [{ id: 'PL-A', tittel: 'x' }],
    },
    { id: 'DOK-X', tittel: 'X', status: 'utdatert', frist: '2026-10-30', planposter: [] },
  ];

  it('tar med poster, eierhandlinger og dokumenter innen 90 dager og det forfalte; aldri droppede', () => {
    const e = V.fristElementer(poster, dokumenter, { naa: NAA });
    expect(
      e.map((x: { type: string; id: string; dager: number }) => `${x.type}:${x.id}:${x.dager}`),
    ).toEqual([
      'post:PL-B:-14',
      'revisjon:DOK-VILKAR:0',
      'post:PL-A:5',
      'eier:SP-1:31',
      'dok:DOK-VILKAR:47',
    ]);
    expect(e[0]).toMatchObject({ forfalt: true, andel: 0 });
    expect(e[2].andel).toBeCloseTo(5 / 90);
    expect(e.find((x: { id: string }) => x.id === 'SP-1').post).toBe('PL-E');
  });

  it('med utvalg: bare postene i utvalget og dokumentene koblet til dem', () => {
    const e = V.fristElementer(poster, dokumenter, { naa: NAA, ider: ['PL-A'] });
    expect(e.map((x: { type: string; id: string }) => `${x.type}:${x.id}`)).toEqual([
      'revisjon:DOK-VILKAR',
      'post:PL-A',
      'dok:DOK-VILKAR',
    ]);
    expect(V.fristElementer(poster, dokumenter, { naa: NAA, ider: ['PL-C'] })).toEqual([]);
  });

  it('merkene fordeles i rader så de ikke ligger oppå hverandre, resten samles i +N', () => {
    const m = (andel: number) => ({ id: String(andel), andel });
    const r = V.fristRader([m(0), m(0.01), m(0.02), m(0.03), m(0.5)], {
      avstand: 0.05,
      maksRader: 3,
    });
    expect(r.rader.map((x: { id: string }[]) => x.map((y) => y.id))).toEqual([
      ['0', '0.5'],
      ['0.01'],
      ['0.02'],
    ]);
    expect(r.skjult.map((x: { id: string }) => x.id)).toEqual(['0.03']);
  });

  it('skalaen har i dag og hver 30. dag, og teksten sier hva og når', () => {
    const s = V.fristSkala(NAA, 90);
    expect(s.map((x: { dager: number; dato: string }) => `${x.dager}:${x.dato}`)).toEqual([
      '0:2026-10-15',
      '30:2026-11-14',
      '60:2026-12-14',
      '90:2027-01-13',
    ]);
    expect(s[0].tekst).toBe('I dag');
    expect(
      V.fristTekst({
        type: 'post',
        id: 'PL-B',
        tittel: 'B',
        dato: '2026-10-01',
        dager: -14,
        forfalt: true,
      }),
    ).toBe('Frist 2026-10-01 (forfalt for 14 dager siden): PL-B B');
    expect(
      V.fristTekst({
        type: 'eier',
        id: 'SP-1',
        tittel: 'Velg',
        dato: '2026-10-16',
        dager: 1,
        forfalt: false,
      }),
    ).toBe('Eierhandling 2026-10-16 (om 1 dag): SP-1 Velg');
  });
});

describe('nettadressen og /api/planer', () => {
  it('vis=kart står i nettadressen og tåler en tur fram og tilbake', () => {
    const t = V.lesUrl('?rom=planer&pri=naa&vis=kart');
    expect(t.vis).toBe('kart');
    expect(V.skrivUrl(t)).toBe('?rom=planer&pri=naa&vis=kart');
    expect(V.lesUrl(V.skrivUrl(t))).toEqual(t);
    expect(V.lesUrl('?rom=planer&vis=tull').vis).toBe('liste');
    expect(V.skrivUrl(V.lesUrl('?rom=planer'))).toBe('?rom=planer');
  });

  it('planerData sender reglene og fristen på eierspørsmål', () => {
    const reg = {
      ...P.tomtRegister('2026-10-01T00:00:00Z'),
      poster: [
        {
          id: 'PL-A',
          tittel: 'A',
          prosjekt: 'eksport',
          prioritet: 'eier',
          modenhet: 'ide',
          eierspm: ['SP-1', 'SP-2'],
        },
      ],
    };
    const ko = {
      omrader: { alfa: { tittel: 'Alfa' } },
      prosjekter: { eksport: { tittel: 'Eksport', omrade: 'alfa' } },
      oppgaver: [],
      sporsmal: { 'SP-1': { tekst: 'Hva?', frist: '2026-11-01' }, 'SP-2': { tekst: 'Og?' } },
      avklart: [],
    };
    const d = V.planerData(reg, ko, { naa: NAA });
    expect(d.regler.map((r: { nr: number }) => r.nr)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(d.poster[0].eierspm[0].frist).toBe('2026-11-01');
    expect('frist' in d.poster[0].eierspm[1]).toBe(false);
  });
});

describe('koblingene i tavla', () => {
  const html = readFileSync(join(KLIENT, 'index.html'), 'utf8');
  const kart = readFileSync(join(KLIENT, 'planer', 'kart.js'), 'utf8');
  const planer = readFileSync(join(KLIENT, 'planer', 'planer.js'), 'utf8');
  const server = readFileSync(join(KLIENT, '..', 'ko-tavle.mjs'), 'utf8');
  const kode = (s: string) => s.replace(/^\s*\/\/.*$/gm, '');

  it('kart.js lastes etter koPlanVisning.js og før planer.js, og serveren serverer den', () => {
    const i = (s: string) => html.indexOf(s);
    expect(i('/planer/kart.js')).toBeGreaterThan(i('/koPlanVisning.js'));
    expect(i('/planer/planer.js')).toBeGreaterThan(i('/planer/kart.js'));
    expect(server).toContain("'/planer/kart.js'");
  });

  it('kartet skriver bare via /api/plan-prioriter, og serveren oversetter med prioriterKall', () => {
    expect(kode(kart)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    const urler = [...kode(kart).matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(urler).toEqual(['/api/plan-prioriter']);
    expect(kart).toContain("'X-Ko-Nokkel'");
    expect(server).toContain("if (sti === '/api/plan-prioriter') return planPrioriter(b);");
    expect(server).toContain('PV.prioriterKall(b.grupper)');
    expect(server).toContain("'--forvent-endret'");
    // Rommet ellers skriver fortsatt ikke.
    expect(planer).not.toMatch(/method:\s*'POST'/);
  });

  it('planer.js bytter mellom Liste og Prioritetskart og viser fristbåndet over rutene', () => {
    expect(planer).toContain("['kart', 'Prioritetskart']");
    expect(planer).toContain('window.KoPlanKart.fristBand(');
    expect(planer).toContain('V.kartPoster(d.poster, t.filter, t.sok)');
  });
});
