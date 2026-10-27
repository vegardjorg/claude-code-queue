// =============================================================
// koFokus.test.ts: arbeidskøen (lib/koLogikk.js): områderegister og `prosjekt.omrade`,
// fokusperiode med trinn, «resten» (vent/fyll) og «dratt med» (transitive avhengigheter), `parkert` med valgfri
// til-dato, den felles rangeringen (velgNeste, plukkbare, tilstand, kortVisning) og kommandoene omrade, omrader,
// fokus, parker og fortsett i ko.mjs (mot en kopi i en midlertidig mappe, aldri den ekte køen).
// Uten fokus og uten parkerte skal resultatet
// være det samme som før (egen describe-blokk under).
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
  nytte?: number;
  innhold_min?: number;
  avhenger?: string[];
  venter_paa?: string[];
  eier_filer?: string[];
  prioritet_tillegg?: number;
  prosjekt?: string;
  funksjon?: string;
  plukket_av?: string;
  samles?: boolean;
  parkert?: Parkert;
};
type Prosjekt = {
  tittel: string;
  prefikser?: string[];
  pause?: boolean;
  prioritet_tillegg?: number;
  omrade?: string;
};
type Fokus = {
  navn?: string;
  fra?: string;
  til?: string | null;
  rekkefolge: string[];
  resten?: string;
  dra_med_avhengigheter?: boolean;
};
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  grenser?: Record<string, number | boolean | string | null>;
  prosjekter?: Record<string, Prosjekt>;
  omrader?: Record<string, { tittel: string; beskrivelse?: string }>;
  fokus?: Fokus;
  neste_migr?: number;
};
type Valgt = {
  id: string;
  score: number;
  steg?: number | null;
  dratt_av?: string | null;
};
type FokusStatus = {
  aktiv: boolean;
  utlopt: boolean;
  klare: number;
  i_fokus: number;
  pagar: number;
  dratt_med: number;
  varsel: string | null;
  eiersporsmal: { sp: string; oppgaver: number }[];
};
type Tilstand = {
  kanStarte: number;
  tom: boolean;
  blokkert: { id: string; hindringer: string[] }[];
  parkert?: number;
  fokus?: FokusStatus;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk') as {
  UTEN_OMRADE: string;
  velgNeste: (ko: Ko, naa?: number) => Valgt[];
  plukkbare: (
    ko: Ko,
    filter?: Record<string, unknown>,
    naa?: number,
  ) => { id: string; steg?: number | null; utenfor_fokus?: boolean; pauset: boolean }[];
  tilstand: (ko: Ko, dagsforbruk?: number, valg?: { naa?: number }) => Tilstand;
  kortVisning: (ko: Ko, valg?: { naa?: number }) => string[];
  hindringerMedPause: (o: Oppgave, ko: Ko) => string[];
  ucommittetHoppet: (ko: Ko, ucommittet: string[]) => { id: string }[];
  omradeFor: (o: Partial<Oppgave>, ko: Ko) => string;
  tolkTrinn: (raa: string, ko: Ko) => { trinn?: string; feil?: string };
  egetTrinn: (o: Oppgave, ko: Ko) => number | null;
  drattMed: (ko: Ko, naa?: number) => Map<string, { trinn: number; av: string }>;
  rangering: (o: Oppgave, ko: Ko) => { trinn: number; ut: boolean; score: number };
  parkertNaa: (o: Oppgave, naa?: number) => boolean;
  settFokus: (
    ko: Ko,
    inn: Record<string, unknown>,
    naa?: string,
  ) => { feil: string[]; advarsler: string[]; fokus?: Fokus };
  fjernFokus: (ko: Ko) => Fokus | null;
  fokusStatus: (ko: Ko, valg?: { naa?: number; kanStarte?: string[] }) => FokusStatus | null;
  settOmrade: (
    ko: Ko,
    oid: string,
    felt: Record<string, unknown>,
  ) => { feil: string[]; ny?: boolean; slettet?: boolean; flyttet?: string[] };
  omradeOversikt: (
    ko: Ko,
    naa?: number,
  ) => { oid: string; prosjekter: string[]; venter: number; klare: number; parkert: number }[];
  parker: (
    ko: Ko,
    ider: string[],
    valg?: { av?: string; grunn?: string | null; til?: string | null; naa?: string },
  ) => { feil: string[]; parkert?: string[]; advarsler?: string[] };
  fortsett: (
    ko: Ko,
    ider: string[],
  ) => { feil: string[]; fortsatt?: string[]; ikkeParkert?: string[] };
  plukk: (
    ko: Ko,
    id: string,
    valg?: { av?: string; tving?: boolean; naa?: string },
  ) => {
    feil?: string;
  };
  nyttRegister: (
    register: Record<string, Prosjekt> | undefined,
    endringer: unknown,
    omrader?: Record<string, unknown>,
  ) => { feil: string[] };
  valider: (o: unknown, eks?: Oppgave[], register?: Record<string, Prosjekt>) => string[];
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
const ider = (ko: Ko) => L.velgNeste(ko, NAA).map((v) => v.id);

// To områder (varer, ui) og ett prosjekt uten område (verktoy). Nytte styrer grunnscoren: ui-oppgavene har
// høyere score enn varer-oppgavene, så fast rekkefølge synes bare når fokus virker.
const REGISTER: Record<string, Prosjekt> = {
  lager: { tittel: 'Lager', prefikser: ['SB-'], omrade: 'varer' },
  kalender: { tittel: 'Kalender', prefikser: ['VP-'], omrade: 'ui' },
  rapport: { tittel: 'Rapport', prefikser: ['FR-'], omrade: 'ui' },
  sikkerhet: { tittel: 'Sikkerhet', prefikser: ['S-'], omrade: 'sikkerhet' },
  verktoy: { tittel: 'Verktøy', prefikser: ['VK-'] },
};
const OMRADER = {
  varer: { tittel: 'Varer' },
  ui: { tittel: 'Kalender og personal' },
  sikkerhet: { tittel: 'Sikkerhet og personvern' },
};
const grunnKo = (): Ko => ({
  prosjekter: klone(REGISTER),
  omrader: klone(OMRADER),
  grenser: { maksSamtidig: 10, maksDPluss: 4, maksPerDomene: 7, maksDb: 6 },
  oppgaver: [
    o('SB-1', { nytte: 2 }),
    o('SB-2', { nytte: 3 }),
    o('VP-1', { nytte: 9 }),
    o('VP-2', { nytte: 8 }),
    o('VK-1', { nytte: 10 }),
    o('S-1', { nytte: 7 }),
  ],
});

describe('uten fokus og uten parkerte: som før', () => {
  it('velgNeste: score og id, ingen nye felt i radene', () => {
    const ko = grunnKo();
    const v = L.velgNeste(ko, NAA);
    expect(v.map((x) => x.id)).toEqual(['VK-1', 'VP-1', 'VP-2', 'S-1', 'SB-2', 'SB-1']);
    for (const r of v) {
      expect('steg' in r).toBe(false);
      expect('dratt_av' in r).toBe(false);
    }
  });

  it('tilstand: ingen fokus- eller parkert-felt; hindringer uten fokustekst', () => {
    const ko = grunnKo();
    ko.prosjekter!.kalender.pause = true;
    const t = L.tilstand(ko, undefined, { naa: NAA });
    expect('fokus' in t).toBe(false);
    expect('parkert' in t).toBe(false);
    expect(t.blokkert.find((b) => b.id === 'VP-1')?.hindringer).toEqual([
      'prosjektet kalender er pauset',
    ]);
  });

  it('kortVisning har ingen FOKUS-linje', () => {
    expect(L.kortVisning(grunnKo(), { naa: NAA }).some((l) => l.startsWith('FOKUS'))).toBe(false);
  });

  it('ett trinn som dekker alt, med resten fyll, gir samme rekkefølge som uten fokus', () => {
    const uten = ider(grunnKo());
    const ko = grunnKo();
    ko.fokus = {
      rekkefolge: ['omrade:varer', 'omrade:ui', 'omrade:sikkerhet', 'prosjekt:verktoy'],
      resten: 'fyll',
    };
    // Fire trinn endrer rekkefølgen; ett trinn per alt (alle i samme område) gjør det ikke.
    const alle = grunnKo();
    for (const p of Object.values(alle.prosjekter!)) p.omrade = 'varer';
    alle.fokus = { rekkefolge: ['omrade:varer'], resten: 'fyll' };
    expect(ider(alle)).toEqual(uten);
    expect(ider(ko)).not.toEqual(uten);
  });

  it('fokus av gir samme resultat som før fokus ble satt', () => {
    const ko = grunnKo();
    const for_ = ider(ko);
    expect(L.settFokus(ko, { rekkefolge: ['varer'] }, ISO).feil).toEqual([]);
    expect(ider(ko)).not.toEqual(for_);
    L.fjernFokus(ko);
    expect(ider(ko)).toEqual(for_);
  });
});

describe('fokus: fast rekkefølge, resten og spesifisitet', () => {
  it('trinn 1 før trinn 2 uansett score; innen trinnet etter score', () => {
    const ko = grunnKo();
    ko.fokus = { rekkefolge: ['omrade:varer', 'omrade:ui'], resten: 'vent' };
    expect(ider(ko)).toEqual(['SB-2', 'SB-1', 'VP-1', 'VP-2']);
    const v = L.velgNeste(ko, NAA);
    expect(v[0].steg).toBe(0);
    expect(v[2].steg).toBe(1);
  });

  it('resten vent: utenfor fokus startes ikke, og hindringen sier hvorfor', () => {
    const ko = grunnKo();
    ko.fokus = { navn: 'Varer først', rekkefolge: ['omrade:varer'], resten: 'vent' };
    expect(ider(ko)).toEqual(['SB-2', 'SB-1']);
    const h = L.hindringerMedPause(
      ko.oppgaver.find((x) => x.id === 'VK-1')!,
      ko,
    );
    expect(h[0]).toMatch(/utenfor fokus «Varer først»/);
  });

  it('resten fyll: utenfor fokus kommer sist og fyller ledige plasser', () => {
    const ko = grunnKo();
    ko.fokus = { rekkefolge: ['omrade:varer'], resten: 'fyll' };
    expect(ider(ko)).toEqual(['SB-2', 'SB-1', 'VK-1', 'VP-1', 'VP-2', 'S-1']);
    const v = L.velgNeste(ko, NAA);
    expect(v[2].steg).toBeNull();
    ko.grenser!.maksSamtidig = 2;
    expect(ider(ko)).toEqual(['SB-2', 'SB-1']);
  });

  it('det mest spesifikke trinnet vinner (prosjekt over område, funksjon over prosjekt)', () => {
    const ko = grunnKo();
    ko.oppgaver.push(o('VP-3', { nytte: 1, funksjon: 'Oversikt' }));
    ko.fokus = {
      rekkefolge: ['funksjon:kalender/Oversikt', 'omrade:ui', 'prosjekt:kalender'],
      resten: 'vent',
    };
    const t = (id: string) =>
      L.egetTrinn(
        ko.oppgaver.find((x) => x.id === id)!,
        ko,
      );
    expect(t('VP-3')).toBe(0);
    expect(t('VP-1')).toBe(2);
    expect(ider(ko)[0]).toBe('VP-3');
    // Rapport er bare i område-trinnet, og kommer derfor før kalender (trinn 3).
    ko.oppgaver.push(o('FR-1', { nytte: 1 }));
    expect(ider(ko)).toEqual(['VP-3', 'FR-1', 'VP-1', 'VP-2']);
  });

  it('pause går foran fokus: et pauset prosjekt i trinn 1 startes ikke', () => {
    const ko = grunnKo();
    ko.prosjekter!.lager.pause = true;
    ko.fokus = { rekkefolge: ['omrade:varer', 'omrade:ui'], resten: 'vent' };
    expect(ider(ko)).toEqual(['VP-1', 'VP-2']);
  });

  it('utløpt fokus rangeres som uten fokus, med varsel', () => {
    const ko = grunnKo();
    ko.fokus = {
      navn: 'Uke 41',
      rekkefolge: ['omrade:varer'],
      resten: 'vent',
      til: '2026-10-01T00:00:00Z',
    };
    expect(ider(ko)).toEqual(ider(grunnKo()));
    const t = L.tilstand(ko, undefined, { naa: NAA });
    expect(t.fokus?.utlopt).toBe(true);
    expect(t.fokus?.varsel).toMatch(/Fokusperioden «Uke 41» er ute/);
  });

  it('fokus som ikke har startet ennå gjelder ikke', () => {
    const ko = grunnKo();
    ko.fokus = { rekkefolge: ['omrade:varer'], resten: 'vent', fra: '2026-12-01T00:00:00Z' };
    expect(ider(ko)).toEqual(ider(grunnKo()));
  });
});

describe('dratt med', () => {
  it('transitive avhengigheter utenfor fokus får trinnet til fokusoppgaven, med av', () => {
    const ko = grunnKo();
    ko.oppgaver = [
      o('VP-1', { nytte: 9, avhenger: ['FR-1'] }),
      o('FR-1', { nytte: 2, avhenger: ['S-1'] }),
      o('S-1', { nytte: 2 }),
      o('VK-1', { nytte: 10 }),
    ];
    ko.omrader!.rapport = { tittel: 'Rapport' };
    ko.prosjekter!.rapport.omrade = 'rapport';
    ko.fokus = { rekkefolge: ['prosjekt:kalender'], resten: 'vent' };
    const d = L.drattMed(ko, NAA);
    expect(d.get('FR-1')).toEqual({ trinn: 0, av: 'VP-1' });
    expect(d.get('S-1')).toEqual({ trinn: 0, av: 'VP-1' });
    expect(d.has('VK-1')).toBe(false);
    // S-1 er klar (ingen avhengigheter) og dratt med; VK-1 står utenfor fokus.
    expect(ider(ko)).toEqual(['S-1']);
    expect(L.velgNeste(ko, NAA)[0].dratt_av).toBe('VP-1');
  });

  it('den høyest prioriterte fokusoppgaven bestemmer trinnet', () => {
    const ko = grunnKo();
    ko.oppgaver = [
      o('SB-1', { avhenger: ['S-1'] }),
      o('VP-1', { avhenger: ['S-1'] }),
      o('S-1'),
    ];
    ko.fokus = { rekkefolge: ['omrade:ui', 'omrade:varer'], resten: 'vent' };
    expect(L.drattMed(ko, NAA).get('S-1')).toEqual({ trinn: 0, av: 'VP-1' });
  });

  it('en avhengighet med bedre eget trinn dras ikke ned; ferdige og parkerte røtter teller ikke', () => {
    const ko = grunnKo();
    ko.oppgaver = [
      o('VP-1', { avhenger: ['SB-1', 'S-1'] }),
      o('SB-1'),
      o('S-1', { status: 'ferdig' }),
      o('VP-2', { avhenger: ['VK-1'], parkert: { av: 'eier', at: ISO } }),
      o('VK-1'),
    ];
    ko.fokus = { rekkefolge: ['omrade:varer', 'omrade:ui'], resten: 'vent' };
    const d = L.drattMed(ko, NAA);
    expect(d.has('SB-1')).toBe(false);
    expect(d.has('S-1')).toBe(false);
    expect(d.has('VK-1')).toBe(false);
  });

  it('uten-avhengigheter slår det av', () => {
    const ko = grunnKo();
    ko.oppgaver = [o('VP-1', { avhenger: ['S-1'] }), o('S-1')];
    ko.fokus = { rekkefolge: ['omrade:ui'], resten: 'vent', dra_med_avhengigheter: false };
    expect(L.drattMed(ko, NAA).size).toBe(0);
    expect(ider(ko)).toEqual([]);
  });
});

describe('varsel når fokuset ikke har noe klart', () => {
  it('ingenting klart: varsel med eierspørsmålet som låser opp mest, og køen er tom', () => {
    const ko = grunnKo();
    ko.oppgaver = [
      o('SB-1', { venter_paa: ['Ø3'] }),
      o('SB-2', { venter_paa: ['Ø3'] }),
      o('VK-1'),
    ];
    ko.fokus = { navn: 'Varer', rekkefolge: ['omrade:varer'], resten: 'vent' };
    const t = L.tilstand(ko, undefined, { naa: NAA });
    expect(t.tom).toBe(true);
    expect(t.fokus?.klare).toBe(0);
    expect(t.fokus?.varsel).toMatch(/Ingenting klart i fokus «Varer»\. Svar på Ø3 låser opp 2/);
    expect(L.kortVisning(ko, { naa: NAA }).join('\n')).toMatch(/FOKUSVARSEL/);
  });

  it('alt i fokus ferdig: «fokuset er tomt»', () => {
    const ko = grunnKo();
    ko.oppgaver = [o('SB-1', { status: 'ferdig' }), o('VK-1')];
    ko.fokus = { rekkefolge: ['omrade:varer'], resten: 'vent' };
    expect(L.fokusStatus(ko, { naa: NAA })?.varsel).toMatch(/er tomt: ingenting igjen/);
  });

  it('klart arbeid i fokus: ingen varsel', () => {
    const ko = grunnKo();
    ko.fokus = { rekkefolge: ['omrade:varer'], resten: 'vent' };
    const s = L.fokusStatus(ko, { naa: NAA, kanStarte: ['SB-1', 'SB-2'] })!;
    expect(s.varsel).toBeNull();
    expect(s.klare).toBe(2);
  });
});

describe('parkert', () => {
  it('parkert hoppes over av velgNeste og plukkbare; til i fortiden = ikke parkert', () => {
    const ko = grunnKo();
    ko.oppgaver[0].parkert = { av: 'eier', at: ISO, grunn: 'vent på leverandør' };
    ko.oppgaver[1].parkert = { av: 'eier', at: ISO, til: '2026-10-01T00:00:00.000Z' };
    expect(ider(ko)).not.toContain('SB-1');
    expect(ider(ko)).toContain('SB-2');
    expect(L.plukkbare(ko, {}, NAA).map((p) => p.id)).not.toContain('SB-1');
    const t = L.tilstand(ko, undefined, { naa: NAA });
    expect(t.parkert).toBe(1);
    expect(t.blokkert.find((b) => b.id === 'SB-1')?.hindringer[0]).toMatch(
      /^parkert av eier: vent på leverandør/,
    );
  });

  it('parker/fortsett: alt eller ingenting, bare venter og forslag, dato i framtiden', () => {
    const ko = grunnKo();
    ko.oppgaver[2].status = 'kjorer';
    expect(L.parker(ko, ['SB-1', 'VP-1'], { av: 'eier', naa: ISO }).feil[0]).toMatch(
      /VP-1: status kjorer/,
    );
    expect(ko.oppgaver[0].parkert).toBeUndefined();
    expect(L.parker(ko, ['SB-1'], { til: '2026-10-01', naa: ISO }).feil[0]).toMatch(/passert/);
    expect(L.parker(ko, ['NEI'], { naa: ISO }).feil[0]).toMatch(/ukjent oppgave NEI/);
    const r = L.parker(ko, ['SB-1'], { av: 'eier', grunn: 'senere', til: '2026-11-01', naa: ISO });
    expect(r.feil).toEqual([]);
    expect(ko.oppgaver[0].parkert).toEqual({
      av: 'eier',
      at: ISO,
      grunn: 'senere',
      til: '2026-11-01T23:59:59.000Z',
    });
    expect(L.valider(ko.oppgaver[0], [], REGISTER)).toEqual([]);
    const f = L.fortsett(ko, ['SB-1', 'SB-2']);
    expect(f).toEqual({ feil: [], fortsatt: ['SB-1'], ikkeParkert: ['SB-2'] });
    expect(L.fortsett(ko, ['NEI']).feil).toEqual(['ukjent oppgave NEI']);
  });

  it('advarer når en parkert oppgave er dratt med av noe i fokus', () => {
    const ko = grunnKo();
    ko.oppgaver = [o('VP-1', { avhenger: ['S-1'] }), o('S-1')];
    ko.fokus = { rekkefolge: ['omrade:ui'], resten: 'vent' };
    const r = L.parker(ko, ['S-1'], { av: 'eier', naa: ISO });
    expect(r.advarsler?.[0]).toMatch(/S-1 er dratt med av VP-1/);
  });

  it('plukk nekter en parkert oppgave uten --tving', () => {
    const ko = grunnKo();
    ko.oppgaver[0].parkert = { av: 'eier', at: ISO };
    expect(L.plukk(ko, 'SB-1', { av: 'meg', naa: ISO }).feil).toMatch(/parkert av eier/);
    expect(L.plukk(ko, 'SB-1', { av: 'meg', tving: true, naa: ISO }).feil).toBeUndefined();
  });

  it('valider avviser et ugyldig parkert-felt', () => {
    expect(L.valider(o('X-1', { parkert: { av: '', at: ISO } }), [], {}).join()).toMatch(
      /parkert må være/,
    );
  });
});

describe('settFokus og tolkTrinn', () => {
  it('nakne navn tolkes som område eller prosjekt; tvetydig eller ukjent er feil', () => {
    const ko = grunnKo();
    expect(L.tolkTrinn('varer', ko)).toEqual({ trinn: 'omrade:varer' });
    expect(L.tolkTrinn('kalender', ko)).toEqual({ trinn: 'prosjekt:kalender' });
    expect(L.tolkTrinn('sikkerhet', ko).feil).toMatch(/både et område og et prosjekt/);
    expect(L.tolkTrinn('nei', ko).feil).toMatch(/ukjent trinn/);
    expect(L.tolkTrinn('funksjon:kalender', ko).feil).toMatch(/funksjon:<prosjekt>\/<navn>/);
    expect(L.tolkTrinn('funksjon:kalender/ Oversikt ', ko)).toEqual({
      trinn: 'funksjon:kalender/Oversikt',
    });
  });

  it('validerer alt før noe endres', () => {
    const ko = grunnKo();
    const r = L.settFokus(
      ko,
      { rekkefolge: ['varer', 'omrade:varer', 'nei'], resten: 'kanskje', til: '2020-01-01' },
      ISO,
    );
    expect(r.feil.join(' | ')).toMatch(
      /står flere ganger.*ukjent trinn nei.*resten må være.*passert/,
    );
    expect(ko.fokus).toBeUndefined();
    expect(L.settFokus(ko, { rekkefolge: [] }, ISO).feil[0]).toMatch(/minst ett trinn/);
  });

  it('standard er resten vent og dra med; advarer om pause, tomt trinn og null klare', () => {
    const ko = grunnKo();
    ko.prosjekter!.lager.pause = true;
    ko.omrader!.hjelp = { tittel: 'Hjelp' };
    const r = L.settFokus(ko, { rekkefolge: ['varer', 'omrade:hjelp'], navn: 'Test' }, ISO);
    expect(r.feil).toEqual([]);
    expect(ko.fokus).toMatchObject({
      navn: 'Test',
      fra: ISO,
      til: null,
      rekkefolge: ['omrade:varer', 'omrade:hjelp'],
      resten: 'vent',
      dra_med_avhengigheter: true,
    });
    expect(r.advarsler.join(' | ')).toMatch(/lager i trinn 1 er pauset/);
    expect(r.advarsler.join(' | ')).toMatch(/trinn 2 \(omrade:hjelp\) har ingen åpne oppgaver/);
    expect(r.advarsler.join(' | ')).toMatch(/ingen klare oppgaver/);
  });
});

describe('områder', () => {
  it('omradeFor følger prosjektet; uten område = uten-omrade', () => {
    const ko = grunnKo();
    expect(L.omradeFor(o('SB-9'), ko)).toBe('varer');
    expect(L.omradeFor(o('Z-9'), ko)).toBe(L.UTEN_OMRADE);
    expect(L.omradeFor(o('XX-9'), ko)).toBe(L.UTEN_OMRADE);
  });

  it('settOmrade oppretter, flytter prosjekter og nekter sletting i bruk; alt eller ingenting', () => {
    const ko = grunnKo();
    expect(L.settOmrade(ko, 'verktoy', { prosjekter: ['verktoy'] }).feil[0]).toMatch(
      /tittel mangler/,
    );
    expect(L.settOmrade(ko, 'verktoy', { tittel: 'Verktøy', prosjekter: ['nei'] }).feil).toEqual([
      'ukjent prosjekt nei',
    ]);
    expect(ko.omrader!.verktoy).toBeUndefined();
    const r = L.settOmrade(ko, 'verktoy', {
      tittel: 'Verktøy',
      prosjekter: ['verktoy', 'rapport'],
    });
    expect(r).toMatchObject({ feil: [], ny: true, flyttet: ['verktoy', 'rapport'] });
    expect(ko.prosjekter!.rapport.omrade).toBe('verktoy');
    expect(L.settOmrade(ko, 'verktoy', { slett: true }).feil[0]).toMatch(
      /brukes av rapport, verktoy/,
    );
    ko.fokus = { rekkefolge: ['omrade:sikkerhet'] };
    delete ko.prosjekter!.sikkerhet.omrade;
    expect(L.settOmrade(ko, 'sikkerhet', { slett: true }).feil[0]).toMatch(/står i fokus/);
    expect(L.settOmrade(ko, 'Ugyldig', { tittel: 'x' }).feil[0]).toMatch(/kebab-case/);
  });

  it('nyttRegister: omrade må finnes når endringen setter det', () => {
    expect(L.nyttRegister(REGISTER, { verktoy: { omrade: 'nei' } }, OMRADER).feil[0]).toMatch(
      /ukjent område nei/,
    );
    expect(L.nyttRegister(REGISTER, { verktoy: { omrade: 'varer' } }, OMRADER).feil).toEqual([]);
    // Andre endringer på et prosjekt som allerede har område, sjekker ikke området.
    expect(L.nyttRegister(REGISTER, { lager: { pause: true } }).feil).toEqual([]);
  });

  it('omradeOversikt: prosjekter, venter, klare og parkert per område', () => {
    const ko = grunnKo();
    ko.oppgaver.push(
      o('SB-3', { avhenger: ['SB-1'] }),
      o('SB-4', { parkert: { av: 'e', at: ISO } }),
    );
    const rader = L.omradeOversikt(ko, NAA);
    expect(rader.map((r) => r.oid)).toEqual(['varer', 'ui', 'sikkerhet', L.UTEN_OMRADE]);
    expect(rader[0]).toMatchObject({
      prosjekter: ['lager'],
      venter: 4,
      klare: 2,
      parkert: 1,
    });
    expect(rader[1].prosjekter).toEqual(['kalender', 'rapport']);
  });
});

describe('ko.mjs: omrade, omrader, fokus, parker, fortsett (mot en kopi)', () => {
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

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-fokus-'));
    const ko = grunnKo();
    delete ko.omrader;
    for (const p of Object.values(ko.prosjekter!)) delete p.omrade;
    writeFileSync(join(mappe, 'ko.json'), JSON.stringify({ ...ko, neste_migr: 1000 }, null, 2));
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('omrade + omrader + fokus sett/vis/av', () => {
    expect(
      kjor(['omrade', 'varer', '--tittel', 'Varer', '--prosjekter', 'lager']).kode,
    ).toBe(0);
    expect(lesKo().prosjekter!.lager.omrade).toBe('varer');
    expect(kjor(['prosjekt', 'kalender', '--omrade', 'nei']).kode).toBe(1);
    const om = kjor(['omrader']);
    expect(om.ut).toMatch(/varer +2 venter · 2 klare/);
    expect(om.ut).toMatch(/uten-omrade/);
    const s = kjor(['fokus', 'sett', 'varer', '--navn', 'Varer først']);
    expect(s.kode).toBe(0);
    expect(s.ut).toMatch(/Fokus satt: 1 Varer · resten venter/);
    expect(lesKo().fokus?.rekkefolge).toEqual(['omrade:varer']);
    const n = kjor(['neste']);
    expect(
      n.ut
        .trim()
        .split('\n')
        .map((l) => l.split(/\s+/)[0]),
    ).toEqual(['SB-2', 'SB-1']);
    expect(n.ut).toMatch(/T1/);
    const f = kjor(['fokus']);
    expect(f.ut).toMatch(/FOKUS «Varer først»/);
    expect(f.ut).toMatch(/NESTE OPP:/);
    expect(kjor(['vis', '--full']).ut).toMatch(/utenfor fokus «Varer først»/);
    expect(kjor(['start', 'VK-1']).feil).toMatch(/utenfor fokus/);
    expect(kjor(['fokus', 'sett', 'nei']).kode).toBe(1);
    expect(kjor(['fokus', 'av']).ut).toMatch(/Fokus fjernet/);
    expect(lesKo().fokus).toBeUndefined();
  });

  it('parker og fortsett', () => {
    const p = kjor(['parker', 'SB-1', 'VP-1', '--grunn', 'senere', '--av', 'eier']);
    expect(p.kode).toBe(0);
    expect(lesKo().oppgaver.find((x) => x.id === 'SB-1')?.parkert?.grunn).toBe('senere');
    expect(kjor(['neste']).ut).not.toMatch(/^SB-1/m);
    expect(kjor(['start', 'SB-1']).feil).toMatch(/parkert av eier/);
    expect(kjor(['parker', 'NEI']).kode).toBe(1);
    const f = kjor(['fortsett', 'SB-1', 'VP-1']);
    expect(f.ut).toMatch(/Av vent: SB-1, VP-1/);
    expect(lesKo().oppgaver.some((x) => x.parkert)).toBe(false);
  });
});
