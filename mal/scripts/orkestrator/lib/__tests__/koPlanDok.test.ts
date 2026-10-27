// =============================================================
// koPlanDok.test.ts: Dokumenter og avtaler (se docs/plan-register.md). Registeret `dokumenter`
// i planer.json: validering, versjonsglipp, neste revisjon og tidslinjen, «Hva må gjøres», grensene for agenten ved
// prioritet, endringslogg og angre, og `ko.mjs plan dok …` mot en kopi i en midlertidig mappe (aldri den
// ekte køen eller det ekte registeret). Visningsreglene for fanen testes i koPlanVisning.test.ts.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Dok = Record<string, unknown> & { id: string };
type Reg = {
  endret?: string;
  poster: Record<string, unknown>[];
  arkiv: Record<string, unknown>;
  dokumenter: Dok[];
  endringslogg: { nr: number; endringer: { samling: string; id: string; felt: string }[] }[];
};
type Svar = { feil: string[]; advarsler: string[]; dok?: Dok; loft?: boolean };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../koPlan') as {
  DOK_GRUPPER: { id: string; tittel: string }[];
  DOK_STATUSER: string[];
  tomtRegister: (naa?: string) => Reg;
  normaliser: (r: unknown) => Reg;
  validerDok: (d: unknown, ctx?: object) => { feil: string[]; advarsler: string[] };
  nyDok: (reg: Reg, inn: object, ctx?: object) => Svar;
  endreDok: (reg: Reg, id: string, felt: object, ctx?: object) => Svar;
  reviderDok: (reg: Reg, id: string, valg: object, ctx?: object) => Svar;
  revisjonsIntervall: (s: unknown) => object | null;
  nesteRevisjon: (d: object, o?: object) => Record<string, unknown> | null;
  versjonsglipp: (d: object) => { type: string; tekst: string }[];
  dokGrunner: (d: object, o?: object) => { type: string }[];
  dokMaaGjores: (l: object[], o?: object) => { id: string; grunner: { type: string }[] }[];
  revisjonsTidslinje: (l: object[], o?: object) => { id: string; type: string; dato: string }[];
  dokKopierLinje: (d: object) => string;
  filtrerDok: (reg: Reg, f?: object, o?: object) => Dok[];
  hentDok: (reg: Reg, ko: object, id: string, o?: object) => Record<string, unknown>;
  planDiff: (a: object, b: object) => { samling: string; id: string; felt: string }[];
  loggEndring: (reg: Reg, o: object) => unknown;
  angre: (reg: Reg, o?: object) => { feil: string[] };
};

const NAA = new Date('2026-10-15T10:00:00.000Z');
const FINNES = new Set(['docs/avtaler/vilkar.md', 'docs/personvern.md']);
const ctx = (rolle = 'agent') => ({
  rolle,
  sporsmal: { 'SP-VILKAR-1': { tekst: 'Hvilken versjon?' } },
  finnesSti: (s: string) => FINNES.has(s),
  naa: '2026-10-15T10:00:00.000Z',
});
const dok = (id: string, extra: object = {}): Dok => ({
  id,
  tittel: `Dokument ${id}`,
  gruppe: 'kundeavtaler',
  malgruppe: 'kunde',
  status: 'utkast',
  kilde: 'docs/avtaler/vilkar.md',
  ...extra,
});
const register = (...dokumenter: Dok[]): Reg => {
  const reg = P.normaliser(P.tomtRegister('2026-10-14T09:00:00.000Z'));
  for (const d of dokumenter) {
    const r = P.nyDok(reg, d, ctx(d.prioritet_satt_av === 'eier' ? 'eier' : 'agent'));
    if (r.feil.length) throw new Error(r.feil.join('; '));
  }
  return reg;
};

describe('koPlan: validering av dokumenter', () => {
  it('godtar et fullt dokument med alle feltene', () => {
    const reg = register(
      dok('DOK-ERKLARING', { gruppe: 'personvern', kilde: 'docs/personvern.md' }),
    );
    const r = P.nyDok(
      reg,
      dok('DOK-VILKAR', {
        publisert: [
          { hvor: 'nettside', url: 'https://example.no/vilkar', versjon: '1.2' },
          { hvor: 'admin', sti: 'veiledning/vilkar', versjon: '1.1' },
        ],
        versjon: '1.3-utkast',
        gjeldende_versjon: '1.2',
        status: 'til-jurist',
        sist_revidert: '2026-09-20',
        revisjon_hver: '12 mnd',
        avhenger_av: ['DOK-ERKLARING'],
        problemer: [{ tekst: 'Nevner gammel leverandør', alvor: 'hoy', kilde: 'PL-BYTTE-1' }],
        prioritet: 'naa',
        naa_kategori: ['for-prod'],
        prioritet_grunn: 'Regel 3: Vilkår før første betalende kunde.',
        juridisk_punkter: ['J-VILKAR-3'],
        eierspm: ['SP-VILKAR-1'],
        frist: null,
      }),
      ctx(),
    );
    expect(r.feil).toEqual([]);
    expect(r.dok).toMatchObject({ prioritet_satt_av: 'agent', opprettet: ctx().naa });
    expect(reg.dokumenter.map((d) => d.id)).toEqual(['DOK-ERKLARING', 'DOK-VILKAR']);
  });

  it('avviser ukjente felt, feil id, gruppe, status, sti og nettadresse', () => {
    const v = P.validerDok(
      {
        ...dok('VILKAR'),
        gruppe: 'annet',
        status: 'ferdig',
        malgruppe: 'alle',
        kilde: '../hemmelig.md',
        publisert: [{ hvor: 'nettside', url: 'http://usikker.no' }],
        tullefelt: 1,
      },
      {},
    );
    const t = v.feil.join('\n');
    expect(t).toContain('ukjent felt tullefelt');
    expect(t).toContain('id må se ut som DOK-');
    expect(t).toContain('gruppe må være');
    expect(t).toContain('status må være');
    expect(t).toContain('malgruppe må være');
    expect(t).toContain('. og .. er ikke lov');
    expect(t).toContain('https-adresse');
  });

  it('kilden må finnes; et dokument som mangler, trenger ingen kilde', () => {
    const reg = register();
    expect(P.nyDok(reg, dok('DOK-X', { kilde: 'docs/borte.md' }), ctx()).feil.join()).toContain(
      'finnes ikke',
    );
    const r = P.nyDok(reg, dok('DOK-Y', { kilde: undefined, status: 'mangler' }), ctx());
    expect(r.feil).toEqual([]);
    expect(r.advarsler).toEqual([]);
  });

  it('id-er brukes aldri om igjen, avhenger_av og planposter må finnes', () => {
    const reg = register(dok('DOK-A'));
    expect(P.nyDok(reg, dok('DOK-A'), ctx()).feil.join()).toContain('brukt fra før');
    expect(P.nyDok(reg, dok('DOK-B', { avhenger_av: ['DOK-Z'] }), ctx()).feil.join()).toContain(
      'ukjent dokument DOK-Z',
    );
    expect(
      P.nyDok(reg, dok('DOK-C', { planposter: ['PL-FINNES-IKKE'] }), ctx()).feil.join(),
    ).toContain('ukjent planpost');
  });

  it('prioritet er valgfri, men følger prioritetsreglene når den er satt', () => {
    const reg = register();
    expect(P.nyDok(reg, dok('DOK-A'), ctx()).feil).toEqual([]);
    expect(
      P.nyDok(
        reg,
        dok('DOK-B', { prioritet: 'naa', naa_kategori: ['for-prod'] }),
        ctx(),
      ).feil.join(),
    ).toContain('prioritet_grunn');
    expect(
      P.nyDok(
        reg,
        dok('DOK-C', { prioritet: 'senere', prioritet_grunn: 'Regel 3: Vilkår før kunde.' }),
        ctx(),
      ).feil.join(),
    ).toContain('regel 3');
    expect(P.nyDok(reg, dok('DOK-D', { naa_kategori: ['viktig'] }), ctx()).feil.join()).toContain(
      'bare når prioritet er satt',
    );
  });
});

describe('koPlan: prioritet og grensene for agenten', () => {
  const eierDok = dok('DOK-E', {
    prioritet: 'senere',
    prioritet_grunn: 'Eieren: venter.',
    prioritet_satt_av: 'eier',
  });

  it('en agent endrer ikke en prioritet eieren har satt, men regel 1 kan løfte', () => {
    const reg = register(eierDok);
    const nei = P.endreDok(
      reg,
      'DOK-E',
      { prioritet: 'naa', naa_kategori: ['viktig'], prioritet_grunn: 'Regel 4: x' },
      ctx(),
    );
    expect(nei.feil.join()).toContain('satt av eieren');
    const ja = P.endreDok(
      reg,
      'DOK-E',
      {
        prioritet: 'naa',
        naa_kategori: ['sikkerhet'],
        prioritet_grunn: 'Regel 1: hemmelighet i teksten.',
      },
      ctx(),
    );
    expect(ja.feil).toEqual([]);
    expect(ja.loft).toBe(true);
    expect(ja.dok).toMatchObject({
      prioritet_satt_av: 'agent',
      agent_loft: { fra: { prioritet: 'senere' } },
    });
  });

  it('eieren kan sette og fjerne prioriteten; verktøyfelt kan ikke settes', () => {
    const reg = register(dok('DOK-A'));
    const r = P.endreDok(reg, 'DOK-A', { prioritet: 'eier' }, ctx('eier'));
    expect(r.feil).toEqual([]);
    expect(r.dok).toMatchObject({ prioritet: 'eier', prioritet_satt_av: 'eier' });
    const bort = P.endreDok(reg, 'DOK-A', { prioritet: null }, ctx('eier'));
    expect(bort.feil).toEqual([]);
    expect(bort.dok?.prioritet_satt_av).toBeUndefined();
    expect(P.endreDok(reg, 'DOK-A', { opprettet: 'x' }, ctx()).feil.join()).toContain(
      'settes av verktøyet',
    );
    expect(P.endreDok(reg, 'DOK-ZZ', { status: 'utkast' }, ctx()).feil.join()).toContain(
      'ukjent dokument',
    );
  });
});

describe('koPlan: revisjon, tidslinje og versjonsglipp', () => {
  it('tolker revisjon_hver', () => {
    expect(P.revisjonsIntervall('12 mnd')).toEqual({ mnd: 12 });
    expect(P.revisjonsIntervall('1 år')).toEqual({ mnd: 12 });
    expect(P.revisjonsIntervall('4 uker')).toEqual({ dager: 28 });
    expect(P.revisjonsIntervall('90 dager')).toEqual({ dager: 90 });
    expect(P.revisjonsIntervall('ved endring av underleverandør')).toEqual({
      hendelse: 'ved endring av underleverandør',
    });
    expect(P.revisjonsIntervall('av og til')).toBeNull();
  });

  it('neste revisjon: dato, forfalt, snart, hendelse; ingen for mangler', () => {
    expect(
      P.nesteRevisjon(
        { sist_revidert: '2025-09-20', revisjon_hver: '12 mnd', status: 'godkjent' },
        { naa: NAA },
      ),
    ).toMatchObject({
      dato: '2026-09-20',
      forfalt: true,
    });
    expect(
      P.nesteRevisjon(
        { sist_revidert: '2026-01-31', revisjon_hver: '1 mnd', status: 'godkjent' },
        { naa: NAA },
      ),
    ).toMatchObject({
      dato: '2026-02-28',
    });
    expect(
      P.nesteRevisjon(
        { sist_revidert: '2026-04-01', revisjon_hver: '7 mnd', status: 'godkjent' },
        { naa: NAA },
      ),
    ).toMatchObject({
      dato: '2026-11-01',
      forfalt: false,
      snart: true,
    });
    expect(
      P.nesteRevisjon({ revisjon_hver: 'ved endring', status: 'godkjent' }, { naa: NAA }),
    ).toEqual({
      hendelse: 'ved endring',
    });
    expect(
      P.nesteRevisjon(
        { sist_revidert: '2025-01-01', revisjon_hver: '1 mnd', status: 'mangler' },
        { naa: NAA },
      ),
    ).toBeNull();
  });

  it('versjonsglipp: publisert ulik gjeldende, steder ulike, kunder på eldre versjon', () => {
    const typer = (d: object) => P.versjonsglipp(d).map((g) => g.type);
    expect(
      typer({
        status: 'publisert',
        gjeldende_versjon: '1.2',
        versjon: '1.2',
        publisert: [
          { hvor: 'nettside', versjon: '1.2' },
          { hvor: 'admin', versjon: '1.1' },
        ],
      }),
    ).toEqual(['publisert-ulik', 'steder-ulike']);
    expect(
      typer({ status: 'godkjent', malgruppe: 'kunde', versjon: '1.3', gjeldende_versjon: '1.2' }),
    ).toEqual(['akseptert-eldre']);
    expect(
      typer({ status: 'godkjent', malgruppe: 'intern', versjon: '1.3', gjeldende_versjon: '1.2' }),
    ).toEqual(['ikke-utrullet']);
    // Et utkast er ikke godkjent ennå: ingen glipp.
    expect(
      typer({
        status: 'til-jurist',
        malgruppe: 'kunde',
        versjon: '1.3-utkast',
        gjeldende_versjon: '1.2',
      }),
    ).toEqual([]);
  });

  it('«Hva må gjøres» og tidslinjen', () => {
    const liste = [
      { id: 'DOK-A', status: 'mangler' },
      { id: 'DOK-B', status: 'godkjent', sist_revidert: '2025-01-01', revisjon_hver: '12 mnd' },
      { id: 'DOK-C', status: 'utkast', problemer: [{ tekst: 'x', alvor: 'hoy' }] },
      { id: 'DOK-D', status: 'utkast', prioritet: 'naa', naa_kategori: ['for-prod'] },
      { id: 'DOK-E', status: 'publisert', sist_revidert: '2026-06-01', revisjon_hver: '6 mnd' },
      {
        id: 'DOK-F',
        status: 'utkast',
        prioritet: 'dropp',
        problemer: [{ tekst: 'x', alvor: 'hoy' }],
      },
    ];
    const m = P.dokMaaGjores(liste, { naa: NAA });
    expect(m.map((x) => x.id)).toEqual(['DOK-A', 'DOK-C', 'DOK-B', 'DOK-D']);
    const t = P.revisjonsTidslinje(liste, { naa: NAA, dager: 90 });
    expect(t.map((x) => `${x.id} ${x.dato}`)).toEqual(['DOK-B 2026-01-01', 'DOK-E 2026-12-01']);
    expect(P.dokKopierLinje({ id: 'DOK-VILKAR' })).toBe('/planer dok DOK-VILKAR. Instruks:');
  });

  it('revider setter sist_revidert, versjon og historikken', () => {
    const reg = register(
      dok('DOK-A', { status: 'godkjent', versjon: '1.0', revisjon_hver: '12 mnd' }),
    );
    const r = P.reviderDok(
      reg,
      'DOK-A',
      { versjon: '1.1', dato: '2026-10-01', merknad: 'Ny leverandør', av: 'test' },
      ctx(),
    );
    expect(r.feil).toEqual([]);
    expect(r.dok).toMatchObject({
      sist_revidert: '2026-10-01',
      versjon: '1.1',
      revisjoner: [{ dato: '2026-10-01', versjon: '1.1', merknad: 'Ny leverandør', av: 'test' }],
    });
    expect(P.reviderDok(reg, 'DOK-A', { dato: '1. okt' }, ctx()).feil.join()).toContain(
      'YYYY-MM-DD',
    );
  });
});

describe('koPlan: filter, henting, endringslogg og angre', () => {
  it('filtrerer og henter med koblinger begge veier', () => {
    const reg = register(
      dok('DOK-LEVERANDOR', { gruppe: 'personvern', status: 'godkjent' }),
      dok('DOK-VILKAR', {
        avhenger_av: ['DOK-LEVERANDOR'],
        problemer: [{ tekst: 'Gammel leverandør', alvor: 'middels' }],
      }),
      dok('DOK-GAMMEL', {
        prioritet: 'dropp',
        dropp_grunn: 'Erstattet.',
        prioritet_grunn: 'Regel 7: erstattet.',
      }),
    );
    expect(P.filtrerDok(reg).map((d) => d.id)).toEqual(['DOK-LEVERANDOR', 'DOK-VILKAR']);
    expect(P.filtrerDok(reg, { alle: true })).toHaveLength(3);
    expect(P.filtrerDok(reg, { gruppe: ['personvern'] }).map((d) => d.id)).toEqual([
      'DOK-LEVERANDOR',
    ]);
    expect(P.filtrerDok(reg, { problemer: true }).map((d) => d.id)).toEqual(['DOK-VILKAR']);
    expect(P.filtrerDok(reg, { sok: 'gammel leverandør' }).map((d) => d.id)).toEqual(['DOK-VILKAR']);
    const h = P.hentDok(reg, { sporsmal: {} }, 'DOK-LEVERANDOR');
    expect(h.brukt_av).toEqual(['DOK-VILKAR']);
    expect(h.kopier).toBe('/planer dok DOK-LEVERANDOR. Instruks:');
    expect(P.hentDok(reg, {}, 'DOK-X').feil).toEqual(['ukjent dokument DOK-X']);
  });

  it('endringsloggen har samlingen dokumenter, og angre ruller tilbake', () => {
    const reg = register(dok('DOK-A'));
    const for_ = JSON.parse(JSON.stringify(reg));
    P.endreDok(reg, 'DOK-A', { status: 'til-jurist' }, ctx());
    const e = P.planDiff(for_, reg);
    expect(e).toEqual([
      expect.objectContaining({ samling: 'dokumenter', id: 'DOK-A', felt: 'status' }),
    ]);
    P.loggEndring(reg, { handling: 'plan dok endre', endringer: e });
    expect(P.angre(reg).feil).toEqual([]);
    expect(reg.dokumenter[0].status).toBe('utkast');
    // Et nytt dokument angres helt bort.
    const for2 = JSON.parse(JSON.stringify(reg));
    P.nyDok(reg, dok('DOK-B'), ctx());
    P.loggEndring(reg, { handling: 'plan dok ny', endringer: P.planDiff(for2, reg) });
    expect(P.angre(reg).feil).toEqual([]);
    expect(reg.dokumenter.map((d) => d.id)).toEqual(['DOK-A']);
  });
});

describe('ko.mjs plan dok …: mot en kopi i en midlertidig mappe', () => {
  const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');
  let mappe: string;
  let kilder: string;
  function kjor(args: string[]): { kode: number; ut: string; feil: string } {
    try {
      const ut = execFileSync(process.execPath, [KO_MJS, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: mappe,
          KO_GIT: mappe,
          KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
          KO_PLAN_KILDEROT: kilder,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { kode: 0, ut, feil: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { kode: x.status, ut: x.stdout ?? '', feil: x.stderr ?? '' };
    }
  }
  const lesReg = (): Reg => JSON.parse(readFileSync(join(mappe, 'planer.json'), 'utf8')) as Reg;
  const fil = (navn: string, innhold: unknown) => {
    const sti = join(mappe, navn);
    writeFileSync(sti, JSON.stringify(innhold));
    return sti;
  };

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-plandok-'));
    kilder = join(mappe, 'rot');
    mkdirSync(join(kilder, 'docs', 'avtaler'), { recursive: true });
    writeFileSync(join(kilder, 'docs', 'avtaler', 'vilkar.md'), '# Vilkår\n');
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({
        endret: '2026-10-14T08:00:00.000Z',
        oppgaver: [],
        prosjekter: {},
        omrader: {},
        sporsmal: {},
        avklart: [],
      }),
    );
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('ny, vis, hent, endre, revider og angre; køfila røres ikke', () => {
    const koFor = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const ny = kjor([
      'plan',
      'dok',
      'ny',
      '--fil',
      fil('ny.json', [
        dok('DOK-VILKAR', { status: 'godkjent', versjon: '1.3', gjeldende_versjon: '1.2' }),
        dok('DOK-SLA', { kilde: undefined, status: 'mangler' }),
      ]),
    ]);
    expect(ny.feil).toBe('');
    expect(ny.ut).toContain('2 nytt/nye dokument(er): DOK-VILKAR, DOK-SLA');
    expect(lesReg().dokumenter).toHaveLength(2);
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(koFor);

    const vis = kjor(['plan', 'dok', 'vis']);
    expect(vis.ut).toContain('Hva må gjøres:');
    expect(vis.ut).toContain('Kundeavtaler (2)');
    expect(vis.ut).toContain('GLIPP');

    const hent = kjor(['plan', 'dok', 'hent', 'DOK-VILKAR']);
    expect(hent.ut).toContain('Kopier: /planer dok DOK-VILKAR. Instruks:');
    expect(hent.ut).toContain('VERSJONSGLIPP');

    const endre = kjor([
      'plan',
      'dok',
      'endre',
      'DOK-SLA',
      '--felt',
      'status=utkast',
      'kilde=docs/avtaler/vilkar.md',
    ]);
    expect(endre.kode).toBe(0);
    expect(lesReg().dokumenter[1]).toMatchObject({ status: 'utkast' });

    const rev = kjor([
      'plan',
      'dok',
      'revider',
      'DOK-VILKAR',
      '--versjon',
      '1.4',
      '--dato',
      '2026-10-01',
    ]);
    expect(rev.kode).toBe(0);
    expect(lesReg().dokumenter[0]).toMatchObject({ sist_revidert: '2026-10-01', versjon: '1.4' });

    // En planpost-kommando etterpå ser ikke dokumentene som nye (snapshotet tar med dokumenter).
    const angre = kjor(['plan', 'angre', '--json']);
    expect(angre.kode).toBe(0);
    expect(lesReg().dokumenter[0]).toMatchObject({ versjon: '1.3' });
    expect(
      lesReg()
        .endringslogg.at(-1)
        ?.endringer.every((e) => e.samling === 'dokumenter'),
    ).toBe(true);
  });

  it('feil gir exit 1 og skriver ingenting; --torr og --forvent-endret virker', () => {
    const r = kjor([
      'plan',
      'dok',
      'ny',
      '--fil',
      fil('feil.json', dok('DOK-X', { gruppe: 'tull' })),
    ]);
    expect(r.kode).toBe(1);
    expect(r.feil).toContain('gruppe må være');
    const torr = kjor([
      'plan',
      'dok',
      'ny',
      '--fil',
      fil('ok.json', dok('DOK-X')),
      '--torr',
      '--json',
    ]);
    expect(JSON.parse(torr.ut)).toMatchObject({ ok: true, torr: true });
    kjor(['plan', 'dok', 'ny', '--fil', fil('ok.json', dok('DOK-X'))]);
    const utdatert = kjor([
      'plan',
      'dok',
      'endre',
      'DOK-X',
      '--felt',
      'status=til-jurist',
      '--forvent-endret',
      '2020-01-01T00:00:00.000Z',
    ]);
    expect(utdatert.kode).toBe(6);
    expect(lesReg().dokumenter[0].status).toBe('utkast');
  });
});
