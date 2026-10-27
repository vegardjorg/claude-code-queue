// =============================================================
// koMasse.test.ts: arbeidskøen (lib/koLogikk.js): endre-mange med parkert/samles/registerfelt,
// tørrkjøring (torr) og optimistisk samtidighet (forventSjekk), endringslogg og angre, blokkflytting (rangerBlokk),
// lengste prefiks, forslag til prosjekt (foreslaProsjekt, klassifiserKo, addProsjektAdvarsler) og prefiks-advarsler,
// pluss kommandoene i ko.mjs mot en kopi i en midlertidig mappe (aldri den ekte køen).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Parkert = { av: string; at: string; grunn?: string; til?: string };
type Oppgave = {
  id: string;
  tittel?: string;
  domene: string;
  klasse: 'K' | 'D' | 'D+' | 'U';
  status: string;
  oppdrag?: string;
  kilde?: string;
  nytte?: number;
  innhold_min?: number;
  avhenger?: string[];
  venter_paa?: string[];
  eier_filer?: string[];
  prioritet_tillegg?: number;
  prosjekt?: string;
  funksjon?: string;
  samles?: boolean;
  parkert?: Parkert;
};
type Prosjekt = {
  tittel: string;
  prefikser?: string[];
  pause?: boolean;
  plan?: string;
  filrot?: string[];
  funksjoner?: string[];
  prioritet_tillegg?: number;
  omrade?: string;
};
type Endring = { id?: string; pid?: string; felt: string; for: unknown; etter: unknown };
type Post = {
  nr: number;
  at: string;
  av: string;
  handling: string;
  endringer: Endring[];
  angret?: { at: string; av: string };
};
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  prosjekter?: Record<string, Prosjekt>;
  omrader?: Record<string, { tittel: string }>;
  fokus?: Record<string, unknown>;
  grenser?: Record<string, number | boolean | string | null>;
  endringslogg?: Post[];
  endret?: string;
  neste_migr?: number;
};
type Forslag = {
  pid: string | null;
  signal: string | null;
  sikker: boolean;
  uenig: boolean;
  motforslag: string | null;
  grunn: string;
};
type Rad = { id: string; naa: string; forslag: string | null; type: string };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk') as {
  UTEN_PROSJEKT: string;
  ENDRINGSLOGG_MAKS: number;
  prosjektFor: (o: Partial<Oppgave>, register?: Record<string, Prosjekt>) => string;
  lengstePrefiks: (
    id: string,
    register: Record<string, Prosjekt>,
  ) => { pid: string; prefiks: string; ogsaa: string[] } | null;
  endreMange: (
    ko: Ko,
    inn: unknown,
    valg?: { av?: string; naa?: string; torr?: boolean },
  ) => {
    feil: string[];
    endret?: string[];
    prosjekter?: string[];
    endringer?: Endring[];
    advarsler?: string[];
  };
  masseDiff: (forKo: Partial<Ko>, etterKo: Partial<Ko>) => Endring[];
  diffLinjer: (e: Endring[]) => string[];
  loggEndring: (
    ko: Ko,
    v: { av?: string; handling: string; endringer: Endring[]; naa?: string },
  ) => Post | null;
  angrePost: (
    ko: Ko,
    v?: { av?: string; naa?: string; vis?: boolean },
  ) => { feil: string[]; post?: Post; vis?: boolean };
  forventSjekk: (ko: Partial<Ko>, forvent: string | null) => string | null;
  rangerBlokk: (
    ko: Ko,
    ider: string[],
    plass: { topp?: boolean; bunn?: boolean; over?: string; under?: string },
    naa?: number,
  ) => { feil: string[]; endringer?: Record<string, number | null>; advarsler?: string[] };
  velgNeste: (ko: Ko, naa?: number) => { id: string; score: number }[];
  score: (
    o: Oppgave,
    oppgaver: Oppgave[],
    naa?: number,
    register?: Record<string, Prosjekt>,
  ) => number;
  foreslaProsjekt: (o: Partial<Oppgave>, register: Record<string, Prosjekt>) => Forslag;
  klassifiserKo: (
    ko: Ko,
    filter?: { utenProsjekt?: boolean; uenige?: boolean },
  ) => { flytt: Rad[]; sorter: Rad[] };
  prefiksAdvarsler: (register: Record<string, Prosjekt>, v?: { pid?: string }) => string[];
  addProsjektAdvarsler: (nye: Partial<Oppgave>[], register: Record<string, Prosjekt>) => string[];
  nyttRegister: (
    register: Record<string, Prosjekt> | undefined,
    endringer: unknown,
    omrader?: Record<string, unknown>,
  ) => { feil: string[] };
};

const NAA = Date.parse('2026-10-07T12:00:00Z');
const ISO = '2026-10-07T12:00:00.000Z';
const o = (id: string, ekstra: Partial<Oppgave> = {}): Oppgave => ({
  id,
  domene: id.toLowerCase(),
  klasse: 'K',
  status: 'venter',
  oppdrag: 'x',
  tittel: id,
  ...ekstra,
});
const klone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const REGISTER: Record<string, Prosjekt> = {
  lager: {
    tittel: 'Lager',
    prefikser: ['SB-'],
    plan: 'docs/lager-kravmotor-plan.md',
    filrot: ['components/varer/', 'lib/data/'],
  },
  katalog: {
    tittel: 'Katalog',
    prefikser: ['K-'],
    plan: 'docs/katalog-plan.md',
  },
  ui: {
    tittel: 'Kalender',
    prefikser: ['V-'],
    filrot: ['components/liste/', 'lib/liste'],
    funksjoner: ['Oversikt', 'Bytte'],
  },
  rapport: { tittel: 'Rapport', plan: 'docs/rapport-plan.md' },
};
const grunnKo = (): Ko => ({
  prosjekter: klone(REGISTER),
  grenser: { maksSamtidig: 10, maksDPluss: 4, maksPerDomene: 7, maksDb: 6 },
  oppgaver: [
    o('SB-1', { nytte: 2 }),
    o('SB-2', { nytte: 3 }),
    o('SB-3', { nytte: 9 }),
    o('V-1', { nytte: 8 }),
    o('V-2', { nytte: 4, avhenger: ['V-1'] }),
    o('X-1', { nytte: 5 }),
  ],
});

describe('lengste prefiks', () => {
  const register: Record<string, Prosjekt> = {
    bred: { tittel: 'Bred', prefikser: ['4'] },
    smal: { tittel: 'Smal', prefikser: ['4F-'] },
    a: { tittel: 'A', prefikser: ['SB-'] },
    b: { tittel: 'B', prefikser: ['SB-'] },
  };
  it('den lengste prefiksen vinner uansett rekkefølge i registeret', () => {
    expect(L.prosjektFor(o('4F-1'), register)).toBe('smal');
    expect(L.prosjektFor(o('4A-1'), register)).toBe('bred');
    const snudd = { smal: register.smal, bred: register.bred };
    expect(L.prosjektFor(o('4F-1'), snudd)).toBe('smal');
  });
  it('lik lengde: det første i registeret vinner, og de andre meldes', () => {
    expect(L.prosjektFor(o('SB-1'), register)).toBe('a');
    expect(L.lengstePrefiks('SB-1', register)).toEqual({ pid: 'a', prefiks: 'SB-', ogsaa: ['b'] });
  });
  it('eksplisitt prosjekt vinner; ingen treff gir uten-prosjekt', () => {
    expect(L.prosjektFor(o('4F-1', { prosjekt: 'a' }), register)).toBe('a');
    expect(L.prosjektFor(o('Z-1'), register)).toBe(L.UTEN_PROSJEKT);
  });
  it('prefiksAdvarsler: ett tegn, starten på et annet prosjekts prefiks, og samme prefiks to steder', () => {
    const adv = L.prefiksAdvarsler(register).join('\n');
    expect(adv).toContain('prefikset 4 i bred er bare ett tegn');
    expect(adv).toContain('prefikset 4 i bred er starten på 4F- i smal');
    expect(adv).toContain('prefikset SB- står i både a og b');
    // pid begrenser til advarsler om det prosjektet.
    expect(L.prefiksAdvarsler(register, { pid: 'a' }).join('\n')).not.toContain('bred');
    // Et prefiks med skilletegn (S-) er ikke «ett tegn».
    expect(L.prefiksAdvarsler({ s: { tittel: 'S', prefikser: ['S-'] } })).toEqual([]);
  });
});

describe('registeret: filrot og funksjoner', () => {
  it('godtar lister med stier og navn, avviser jokertegn og tomme verdier', () => {
    expect(
      L.nyttRegister({}, { p: { tittel: 'P', filrot: ['lib/x/'], funksjoner: ['Datablad'] } }).feil,
    ).toEqual([]);
    expect(L.nyttRegister({}, { p: { tittel: 'P', filrot: ['lib/*.ts'] } }).feil.join()).toContain(
      'filrot',
    );
    expect(L.nyttRegister({}, { p: { tittel: 'P', funksjoner: [''] } }).feil.join()).toContain(
      'funksjoner',
    );
  });
});

describe('endreMange: parkert, samles, torr og endringer', () => {
  it('parkert: true, { grunn, til } og null; av/at settes av verktøyet', () => {
    const ko = grunnKo();
    const r = L.endreMange(
      ko,
      [
        { id: 'SB-1', parkert: true },
        { id: 'SB-2', parkert: { grunn: 'venter på leverandør', til: '2026-12-01' } },
      ],
      { av: 'eier', naa: ISO },
    );
    expect(r.feil).toEqual([]);
    expect(ko.oppgaver[0].parkert).toEqual({ av: 'eier', at: ISO });
    expect(ko.oppgaver[1].parkert).toEqual({
      av: 'eier',
      at: ISO,
      grunn: 'venter på leverandør',
      til: '2026-12-01T23:59:59.000Z',
    });
    expect(L.endreMange(ko, [{ id: 'SB-1', parkert: null }], { naa: ISO }).feil).toEqual([]);
    expect(ko.oppgaver[0].parkert).toBeUndefined();
  });

  it('parkert: true på en som allerede er parkert, endrer ingenting', () => {
    const ko = grunnKo();
    ko.oppgaver[0].parkert = { av: 'x', at: '2026-10-01T00:00:00.000Z' };
    const r = L.endreMange(ko, [{ id: 'SB-1', parkert: true }], { naa: ISO });
    expect(r.endringer).toEqual([]);
    expect(ko.oppgaver[0].parkert!.at).toBe('2026-10-01T00:00:00.000Z');
  });

  it('parkert: bare venter og forslag, gyldig og framtidig dato, kjente felt; alt eller ingenting', () => {
    const ko = grunnKo();
    ko.oppgaver[2].status = 'kjorer';
    const for_ = klone(ko);
    const r = L.endreMange(
      ko,
      [
        { id: 'SB-1', prosjekt: 'ui' },
        { id: 'SB-3', parkert: true },
        { id: 'SB-2', parkert: { til: '2020-01-01' } },
        { id: 'V-1', parkert: { hvorfor: 'x' } },
        { id: 'X-1', parkert: 'ja' },
      ],
      { naa: ISO },
    );
    const f = r.feil.join('\n');
    expect(f).toContain('SB-3: status kjorer (bare venter og forslag kan parkeres)');
    expect(f).toContain('datoen 2020-01-01 er passert');
    expect(f).toContain('ukjente felt hvorfor');
    expect(f).toContain('X-1: parkert må være true, null eller');
    expect(ko).toEqual(for_);
  });

  it('samles: samme regler som add/endre (D+, noe avhenger av den, åpne eierspørsmål); false fjerner feltet', () => {
    const ko = grunnKo();
    ko.oppgaver[0].klasse = 'D+';
    ko.oppgaver[2].venter_paa = ['Ø1'];
    const for_ = klone(ko);
    const r = L.endreMange(ko, [
      { id: 'SB-1', samles: true },
      { id: 'V-1', samles: true },
      { id: 'SB-3', samles: true },
    ]);
    const f = r.feil.join('\n');
    expect(f).toContain('SB-1: samles: D+');
    expect(f).toContain('V-1: samles: V-2 avhenger av V-1');
    expect(f).toContain('SB-3: samles: SB-3 venter på eierspørsmål');
    expect(ko).toEqual(for_);

    expect(L.endreMange(ko, [{ id: 'SB-2', samles: true }]).feil).toEqual([]);
    expect(ko.oppgaver[1].samles).toBe(true);
    expect(L.endreMange(ko, [{ id: 'SB-2', samles: false }]).feil).toEqual([]);
    expect('samles' in ko.oppgaver[1]).toBe(false);
  });

  it('samles regnes mot køen slik den blir etter hele fila', () => {
    const ko = grunnKo();
    // V-2 (som avhenger av V-1) kanselleres ikke, men V-1 kan ikke i samlekøen så lenge V-2 er åpen.
    expect(L.endreMange(ko, [{ id: 'V-1', samles: true }]).feil.join()).toContain('V-2 avhenger');
    ko.oppgaver[4].status = 'ferdig';
    expect(L.endreMange(ko, [{ id: 'V-1', samles: true }]).feil).toEqual([]);
  });

  it('torr: endrer ingenting, men gir de samme endringene og advarslene', () => {
    const ko = grunnKo();
    ko.prosjekter!.ui.pause = true;
    const for_ = klone(ko);
    const inn = [
      { id: 'SB-1', prosjekt: 'ui' },
      { id: 'SB-2', funksjon: 'Datablad' },
      { id: 'SB-3', prioritet_tillegg: 5 },
    ];
    const t = L.endreMange(ko, inn, { naa: ISO, torr: true });
    expect(ko).toEqual(for_);
    expect(t.feil).toEqual([]);
    expect(t.endringer).toEqual([
      { id: 'SB-1', felt: 'prosjekt', for: null, etter: 'ui' },
      { id: 'SB-2', felt: 'funksjon', for: null, etter: 'Datablad' },
      { id: 'SB-3', felt: 'prioritet_tillegg', for: null, etter: 5 },
    ]);
    expect(t.advarsler!.join()).toContain('SB-1 flyttes til ui, som er pauset');
    const r = L.endreMange(ko, inn, { naa: ISO });
    expect(r.endringer).toEqual(t.endringer);
    expect(r.advarsler).toEqual(t.advarsler);
    // Det som allerede er slik, gir ingen endring.
    expect(L.endreMange(ko, inn, { naa: ISO, torr: true }).endringer).toEqual([]);
  });

  it('registerfeltene omrade, filrot og funksjoner går via prosjekter, og vises i endringene', () => {
    const ko = grunnKo();
    ko.omrader = { varer: { tittel: 'Varer' } };
    const r = L.endreMange(ko, {
      prosjekter: {
        katalog: { omrade: 'varer', filrot: ['lib/katalog/'], funksjoner: ['Import'] },
      },
    });
    expect(r.feil).toEqual([]);
    expect(r.endringer).toEqual([
      { pid: 'katalog', felt: 'filrot', for: null, etter: ['lib/katalog/'] },
      { pid: 'katalog', felt: 'funksjoner', for: null, etter: ['Import'] },
      { pid: 'katalog', felt: 'omrade', for: null, etter: 'varer' },
    ]);
    expect(
      L.endreMange(ko, { prosjekter: { katalog: { omrade: 'finnes-ikke' } } }).feil.join(),
    ).toContain('ukjent område');
  });

  it('advarer når en oppgave fokuset har dratt med, parkeres', () => {
    const ko = grunnKo();
    ko.fokus = { rekkefolge: ['prosjekt:lager'], resten: 'vent' };
    ko.oppgaver[0].avhenger = ['X-1'];
    const r = L.endreMange(ko, [{ id: 'X-1', parkert: true }], { naa: ISO });
    expect(r.feil).toEqual([]);
    expect(r.advarsler!.join()).toContain('X-1 er dratt med av SB-1');
  });
});

describe('forventSjekk (optimistisk samtidighet)', () => {
  it('ok når køen ikke er endret etter tidspunktet, nekter når den er det', () => {
    expect(L.forventSjekk({ endret: ISO }, null)).toBeNull();
    expect(L.forventSjekk({ endret: ISO }, ISO)).toBeNull();
    expect(L.forventSjekk({ endret: ISO }, '2026-10-07T13:00:00Z')).toBeNull();
    expect(L.forventSjekk({ endret: ISO }, '2026-10-07T11:59:59Z')).toContain('køen er endret');
    expect(L.forventSjekk({}, ISO)).toBeNull();
    expect(L.forventSjekk({ endret: ISO }, 'i går')).toContain('ugyldig');
  });
});

describe('endringslogg og angre', () => {
  const gjor = (ko: Ko, inn: unknown, handling = 'endre-mange') => {
    const forKo = klone({ oppgaver: ko.oppgaver, prosjekter: ko.prosjekter });
    const r = L.endreMange(ko, inn, { av: 'eier', naa: ISO });
    expect(r.feil).toEqual([]);
    return L.loggEndring(ko, {
      av: 'eier',
      handling,
      endringer: L.masseDiff(forKo, ko),
      naa: ISO,
    });
  };

  it('masseDiff gir bare felt som faktisk endres; ingen post når ingenting endres', () => {
    const ko = grunnKo();
    expect(gjor(ko, [{ id: 'SB-1', prosjekt: 'lager' }])!.endringer).toEqual([
      { id: 'SB-1', felt: 'prosjekt', for: null, etter: 'lager' },
    ]);
    expect(gjor(ko, [{ id: 'SB-1', prosjekt: 'lager' }])).toBeNull();
    expect(ko.endringslogg!.map((p) => p.nr)).toEqual([1]);
  });

  it('angre ruller tilbake, og neste angre tar posten før', () => {
    const ko = grunnKo();
    const start = klone(ko.oppgaver);
    gjor(ko, [{ id: 'SB-1', prosjekt: 'ui', funksjon: 'Bytte' }]);
    gjor(ko, [
      { id: 'SB-1', prioritet_tillegg: 30 },
      { id: 'SB-2', parkert: true },
    ]);
    const vis = L.angrePost(ko, { vis: true });
    expect(vis.feil).toEqual([]);
    expect(vis.post!.nr).toBe(2);
    expect(ko.oppgaver[0].prioritet_tillegg).toBe(30); // vis endrer ingenting
    expect(L.angrePost(ko, { av: 'eier', naa: ISO }).post!.nr).toBe(2);
    expect(ko.oppgaver[0].prioritet_tillegg).toBeUndefined();
    expect(ko.oppgaver[1].parkert).toBeUndefined();
    expect(L.angrePost(ko, { av: 'eier', naa: ISO }).post!.nr).toBe(1);
    expect(ko.oppgaver).toEqual(start);
    expect(L.angrePost(ko).feil.join()).toContain('ingenting å angre');
    // Postene blir stående, merket angret.
    expect(ko.endringslogg!.every((p) => p.angret?.av === 'eier')).toBe(true);
  });

  it('nekter (og endrer ingenting) når et felt er endret siden', () => {
    const ko = grunnKo();
    gjor(ko, [{ id: 'SB-1', prosjekt: 'ui' }]);
    ko.oppgaver[0].prosjekt = 'rapport'; // noen andre endret det
    const for_ = klone(ko);
    const r = L.angrePost(ko, { naa: ISO });
    expect(r.feil.join()).toContain('SB-1 prosjekt er endret siden');
    expect(ko).toEqual(for_);
  });

  it('nekter når resultatet bryter reglene (parkert på en som kjører nå)', () => {
    const ko = grunnKo();
    gjor(ko, [{ id: 'SB-1', parkert: true }]);
    gjor(ko, [{ id: 'SB-1', parkert: null }]);
    ko.oppgaver[0].status = 'kjorer';
    expect(L.angrePost(ko, { naa: ISO }).feil.join()).toContain(
      'bare venter og forslag kan være parkert',
    );
  });

  it('et prosjekt som posten opprettet, forsvinner igjen; nekter når en oppgave bruker det', () => {
    const ko = grunnKo();
    gjor(ko, { prosjekter: { nytt: { tittel: 'Nytt' } } });
    expect(ko.prosjekter!.nytt).toBeDefined();
    expect(L.angrePost(ko, { naa: ISO }).feil).toEqual([]);
    expect(ko.prosjekter!.nytt).toBeUndefined();

    gjor(ko, { prosjekter: { nytt: { tittel: 'Nytt' } } });
    ko.oppgaver[5].prosjekt = 'nytt';
    expect(L.angrePost(ko, { naa: ISO }).feil.join()).toContain('X-1 bruker prosjektet nytt');
  });

  it('beholder de siste ENDRINGSLOGG_MAKS postene', () => {
    const ko = grunnKo();
    for (let i = 1; i <= L.ENDRINGSLOGG_MAKS + 5; i += 1)
      gjor(ko, [{ id: 'SB-1', prioritet_tillegg: i }]);
    expect(ko.endringslogg!.length).toBe(L.ENDRINGSLOGG_MAKS);
    expect(ko.endringslogg![0].nr).toBe(6);
    expect(ko.endringslogg!.at(-1)!.nr).toBe(L.ENDRINGSLOGG_MAKS + 5);
  });

  it('diffLinjer: kort tekst per felt', () => {
    expect(L.diffLinjer([{ id: 'A', felt: 'prosjekt', for: null, etter: 'ui' }])).toEqual([
      'A prosjekt: (ingen) → ui',
    ]);
  });
});

describe('rangerBlokk', () => {
  const rekkefolge = (ko: Ko) => L.velgNeste(ko, NAA).map((v) => v.id);
  const anvend = (ko: Ko, e: Record<string, number | null>) =>
    expect(
      L.endreMange(
        ko,
        Object.entries(e).map(([id, t]) => ({ id, prioritet_tillegg: t })),
      ).feil,
    ).toEqual([]);

  it('topp: blokken øverst, i samme innbyrdes rekkefølge som før', () => {
    const ko = grunnKo();
    expect(rekkefolge(ko)).toEqual(['V-1', 'SB-3', 'X-1', 'SB-2', 'SB-1']);
    const r = L.rangerBlokk(ko, ['SB-1', 'SB-2'], { topp: true }, NAA);
    expect(r.feil).toEqual([]);
    anvend(ko, r.endringer!);
    expect(rekkefolge(ko)).toEqual(['SB-2', 'SB-1', 'V-1', 'SB-3', 'X-1']);
  });

  it('bunn, over og under', () => {
    let ko = grunnKo();
    anvend(ko, L.rangerBlokk(ko, ['SB-3', 'V-1'], { bunn: true }, NAA).endringer!);
    expect(rekkefolge(ko)).toEqual(['X-1', 'SB-2', 'SB-1', 'V-1', 'SB-3']);

    ko = grunnKo();
    // V-1 står øverst: «over» uten nabo over legger blokken ett steg over den.
    anvend(ko, L.rangerBlokk(ko, ['SB-1', 'SB-2'], { over: 'V-1' }, NAA).endringer!);
    expect(rekkefolge(ko)).toEqual(['SB-2', 'SB-1', 'V-1', 'SB-3', 'X-1']);

    ko = grunnKo();
    anvend(ko, L.rangerBlokk(ko, ['SB-1', 'SB-3'], { under: 'X-1' }, NAA).endringer!);
    expect(rekkefolge(ko)).toEqual(['V-1', 'X-1', 'SB-3', 'SB-1', 'SB-2']);
  });

  it('nekter ved ukjent, kjørende, referansen i blokken, og uten nøyaktig én plass', () => {
    const ko = grunnKo();
    ko.oppgaver[3].status = 'kjorer';
    expect(L.rangerBlokk(ko, ['V-1'], { topp: true }, NAA).feil.join()).toContain('status kjorer');
    expect(L.rangerBlokk(ko, ['NEI'], { topp: true }, NAA).feil.join()).toContain(
      'ukjent oppgave NEI',
    );
    expect(L.rangerBlokk(ko, ['SB-1'], { over: 'SB-1' }, NAA).feil.join()).toContain(
      'i blokken selv',
    );
    expect(L.rangerBlokk(ko, ['SB-1'], {}, NAA).feil.join()).toContain('velg én av');
    expect(L.rangerBlokk(ko, ['SB-1'], { topp: true, bunn: true }, NAA).feil.join()).toContain(
      'velg én av',
    );
  });

  it('med fokus: flytter bare innen trinnet; over/under krever samme trinn', () => {
    const ko = grunnKo();
    ko.fokus = { rekkefolge: ['prosjekt:ui', 'prosjekt:lager'], resten: 'fyll' };
    expect(L.rangerBlokk(ko, ['SB-1'], { over: 'V-1' }, NAA).feil.join()).toContain(
      'annet trinn enn V-1',
    );
    // topp flytter SB-1 øverst i varer-trinnet, men aldri foran ui-trinnet.
    anvend(ko, L.rangerBlokk(ko, ['SB-1'], { topp: true }, NAA).endringer!);
    const r = rekkefolge(ko);
    expect(r.indexOf('SB-1')).toBeLessThan(r.indexOf('SB-3'));
    expect(r.indexOf('V-1')).toBeLessThan(r.indexOf('SB-1'));
  });
});

describe('foreslaProsjekt', () => {
  it('prefiks (sikker) når ingen sterke signaler strider mot den', () => {
    const f = L.foreslaProsjekt(o('SB-9', { eier_filer: ['components/varer/A.tsx'] }), REGISTER);
    expect(f).toMatchObject({
      pid: 'lager',
      signal: 'prefiks',
      sikker: true,
      uenig: false,
    });
  });

  it('planen i kilden når prefiks mangler', () => {
    const f = L.foreslaProsjekt(o('Y-1', { kilde: 'docs/rapport-plan.md § 3' }), REGISTER);
    expect(f).toMatchObject({ pid: 'rapport', signal: 'plan', sikker: true });
    // Bakoverstreker og bare filnavnet virker også.
    expect(
      L.foreslaProsjekt(o('Y-2', { kilde: 'se katalog-plan.md del 4' }), REGISTER).pid,
    ).toBe('katalog');
  });

  it('filrot: flest eierfiler vinner; likt er tvetydig (Sorter)', () => {
    expect(
      L.foreslaProsjekt(
        o('Y-1', { eier_filer: ['lib/liste/a.ts', 'lib/liste/b.ts', 'lib/data/x.ts'] }),
        REGISTER,
      ),
    ).toMatchObject({ pid: 'ui', signal: 'filrot' });
    const t = L.foreslaProsjekt(
      o('Y-1', { eier_filer: ['lib/liste/a.ts', 'lib/data/x.ts'] }),
      REGISTER,
    );
    expect(t).toMatchObject({ pid: null, sikker: false });
    expect(t.grunn).toContain('like mange eierfiler');
    // «lib/liste» uten skråstrek er fil eller mappe, men ikke «lib/listeX».
    expect(
      L.foreslaProsjekt(o('Y-1', { eier_filer: ['lib/listeX.ts'] }), REGISTER).pid,
    ).toBeNull();
  });

  it('eksplisitt prosjekt mot sterke signaler gir uenig med motforslag', () => {
    const f = L.foreslaProsjekt(
      o('Y-1', { prosjekt: 'rapport', eier_filer: ['components/varer/A.tsx', 'lib/data/b.ts'] }),
      REGISTER,
    );
    expect(f).toMatchObject({
      pid: 'rapport',
      signal: 'eksplisitt',
      uenig: true,
      motforslag: 'lager',
    });
    // Et prefiks som strider mot et eksplisitt prosjekt, er bevisst (ikke uenig).
    expect(L.foreslaProsjekt(o('SB-1', { prosjekt: 'ui' }), REGISTER).uenig).toBe(false);
  });

  it('prefiks mot et sterkt signal: usikker, med motforslag', () => {
    const f = L.foreslaProsjekt(o('SB-1', { kilde: 'docs/rapport-plan.md' }), REGISTER);
    expect(f).toMatchObject({
      pid: 'lager',
      sikker: false,
      uenig: true,
      motforslag: 'rapport',
    });
  });

  it('ingen signaler: Sorter', () => {
    expect(L.foreslaProsjekt(o('Y-1'), REGISTER)).toMatchObject({
      pid: null,
      signal: null,
      sikker: false,
    });
  });
});

describe('klassifiserKo og add-advarslene', () => {
  const ko = (): Ko => ({
    prosjekter: klone(REGISTER),
    oppgaver: [
      o('SB-1'),
      o('Y-1', { kilde: 'docs/rapport-plan.md' }),
      o('Y-2'),
      o('Y-3', { prosjekt: 'ui', eier_filer: ['components/varer/a.tsx'] }),
      o('Y-4', { kilde: 'docs/rapport-plan.md', status: 'ferdig' }),
    ],
  });

  it('flytt (sikre, uten prosjekt), sorter og uenig; ferdige hoppes over', () => {
    const k = L.klassifiserKo(ko());
    expect(k.flytt.map((r) => [r.id, r.forslag])).toEqual([['Y-1', 'rapport']]);
    expect(k.sorter.map((r) => [r.id, r.type, r.forslag])).toEqual([
      ['Y-2', 'sorter', null],
      ['Y-3', 'uenig', 'lager'],
    ]);
  });

  it('filtrene --uten-prosjekt og --uenige', () => {
    expect(L.klassifiserKo(ko(), { utenProsjekt: true }).sorter.map((r) => r.id)).toEqual(['Y-2']);
    const u = L.klassifiserKo(ko(), { uenige: true });
    expect(u.flytt).toEqual([]);
    expect(u.sorter.map((r) => r.id)).toEqual(['Y-3']);
  });

  it('add: forslag når prosjekt mangler, Sorter uten signal, uenig, og ny funksjon', () => {
    const adv = L.addProsjektAdvarsler(
      [
        o('Y-1', { kilde: 'docs/rapport-plan.md' }),
        o('Y-2'),
        o('Y-3', { prosjekt: 'ui', eier_filer: ['components/varer/a.tsx'] }),
        o('V-9', { funksjon: 'Ny ting' }),
        o('V-8', { funksjon: 'oversikt' }),
        o('V-7', { funksjon: 'Bytte' }),
      ],
      REGISTER,
    ).join('\n');
    expect(adv).toContain('Y-1 har ikke prosjekt; forslag rapport');
    expect(adv).toContain('Y-2 har ikke prosjekt og havner i «Sorter»');
    expect(adv).toContain('Y-3: satt til ui, men');
    expect(adv).toContain('V-9: ny funksjon «Ny ting» i ui');
    expect(adv).toContain('V-8: funksjonen «oversikt» heter «Oversikt»');
    expect(adv).not.toContain('V-7');
    expect(L.addProsjektAdvarsler([o('Y-2')], {})).toEqual([]);
  });
});

describe('ko.mjs: endre-mange --torr/--forvent-endret, ranger, angre, klassifiser (mot en kopi)', () => {
  const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');
  let mappe: string;
  function kjor(args: string[]): { kode: number; ut: string; feil: string } {
    try {
      const ut = execFileSync(process.execPath, [KO_MJS, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: mappe,
          KO_GIT: mappe,
          KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
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
  const lesKo = (): Ko => JSON.parse(readFileSync(join(mappe, 'ko.json'), 'utf8')) as Ko;
  const fil = (navn: string, innhold: unknown) => {
    const sti = join(mappe, navn);
    writeFileSync(sti, JSON.stringify(innhold));
    return sti;
  };

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-masse-'));
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({ ...grunnKo(), endret: ISO, neste_migr: 1000 }, null, 2),
    );
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('--torr skriver ingenting; --json gir endringene og versjonen', () => {
    const f = fil('m.json', [{ id: 'SB-1', parkert: { grunn: 'test' } }]);
    const for_ = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const r = kjor(['endre-mange', '--fil', f, '--torr', '--json']);
    expect(r.kode).toBe(0);
    const svar = JSON.parse(r.ut) as { ok: boolean; endret: string; endringer: Endring[] };
    expect(svar.ok).toBe(true);
    expect(svar.endret).toBe(ISO);
    expect(svar.endringer.map((e) => [e.id, e.felt])).toEqual([['SB-1', 'parkert']]);
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(for_);
  });

  it('--forvent-endret: exit 6 når køen er endret siden; ok med riktig versjon', () => {
    const f = fil('m.json', [{ id: 'SB-1', prosjekt: 'ui' }]);
    const gammel = kjor(['endre-mange', '--fil', f, '--forvent-endret', '2026-10-07T11:00:00Z']);
    expect(gammel.kode).toBe(6);
    expect(gammel.feil).toContain('køen er endret');
    expect(lesKo().oppgaver[0].prosjekt).toBeUndefined();
    const ok = kjor(['endre-mange', '--fil', f, '--forvent-endret', ISO, '--av', 'tavla']);
    expect(ok.kode).toBe(0);
    expect(ok.ut).toContain('angre: ko.mjs angre');
    const ko = lesKo();
    expect(ko.oppgaver[0].prosjekt).toBe('ui');
    expect(ko.endringslogg!.at(-1)).toMatchObject({ nr: 1, av: 'tavla', handling: 'endre-mange' });
  });

  it('feil i fila: ingenting endres, og ingen post i endringsloggen', () => {
    const f = fil('m.json', [
      { id: 'SB-1', prosjekt: 'ui' },
      { id: 'SB-2', samles: 'ja' },
    ]);
    const r = kjor(['endre-mange', '--fil', f]);
    expect(r.kode).toBe(1);
    expect(lesKo().oppgaver[0].prosjekt).toBeUndefined();
    expect(lesKo().endringslogg).toBeUndefined();
  });

  it('ranger + parker + angre: hver skriving kan rulles tilbake i omvendt rekkefølge', () => {
    const start = lesKo().oppgaver;
    expect(kjor(['ranger', 'SB-1', 'SB-2', '--topp']).kode).toBe(0);
    expect(kjor(['parker', 'X-1', '--grunn', 'vent', '--av', 'eier']).kode).toBe(0);
    expect(lesKo().endringslogg!.map((p) => p.handling)).toEqual(['ranger', 'parker']);
    const vis = kjor(['angre', '--vis']);
    expect(vis.ut).toContain('nr. 2 parker');
    expect(kjor(['angre']).kode).toBe(0);
    expect(lesKo().oppgaver[5].parkert).toBeUndefined();
    expect(kjor(['angre']).kode).toBe(0);
    expect(lesKo().oppgaver).toEqual(start);
    const tom = kjor(['angre']);
    expect(tom.kode).toBe(1);
    expect(tom.feil).toContain('ingenting å angre');
  });

  it('klassifiser --utfor setter bare de sikre forslagene; add advarer når prosjekt mangler', () => {
    const add = kjor([
      'add',
      '--json',
      JSON.stringify([
        {
          id: 'Y-1',
          tittel: 'Y',
          domene: 'y',
          klasse: 'K',
          oppdrag: 'x',
          kilde: 'docs/rapport-plan.md',
        },
        { id: 'Y-2', tittel: 'Y', domene: 'y', klasse: 'K', oppdrag: 'x' },
      ]),
    ]);
    expect(add.kode).toBe(0);
    expect(add.ut).toContain('Y-1 har ikke prosjekt; forslag rapport');
    expect(add.ut).toContain('Y-2 har ikke prosjekt og havner i «Sorter»');
    const vis = kjor(['klassifiser']);
    expect(vis.ut).toContain('Y-1');
    expect(lesKo().oppgaver.find((x) => x.id === 'Y-1')!.prosjekt).toBeUndefined();
    expect(kjor(['klassifiser', '--utfor']).kode).toBe(0);
    const ko = lesKo();
    expect(ko.oppgaver.find((x) => x.id === 'Y-1')!.prosjekt).toBe('rapport');
    expect(ko.oppgaver.find((x) => x.id === 'Y-2')!.prosjekt).toBeUndefined();
    expect(ko.endringslogg!.at(-1)!.handling).toBe('klassifiser');
  });

  it('prosjekt --filrot og prefiks-advarsel', () => {
    const r = kjor([
      'prosjekt',
      'bred',
      '--tittel',
      'Bred',
      '--prefiks',
      'S',
      '--filrot',
      'lib/x/',
    ]);
    expect(r.kode).toBe(0);
    expect(r.ut).toContain('prefikset S i bred er bare ett tegn');
    expect(r.ut).toContain('prefikset S i bred er starten på SB-');
    expect(lesKo().prosjekter!.bred.filrot).toEqual(['lib/x/']);
  });
});
