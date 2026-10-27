// =============================================================
// koDiagnose.test.ts: vakten for lav parallellitet i arbeidskøen (scripts/orkestrator/lib/koDiagnose.js).
//
// Fiksturene dekker feiltypene som kan stenge fokus uten at noe varsler:
//   1. en oppgave avhenger av en kansellert oppgave som er slått sammen i en annen;
//   2. en oppgave avhenger av en revisjon som ikke finnes, mens en senere revisjon er levert;
//   3. en oppgave dras med av en fokusoppgave, men prosjektet den hører til er pauset;
//   4. klare oppgaver i fokus holdes igjen av en kapasitetsgrense.
// Pluss løse ventinger, besvarte spørsmål i venter_paa, flaskehalser og «ingen utskrift over terskelen».
// Hvert funn er «enkel» (ferdig kommando) eller «kompleks» (valg med anbefaling).
// =============================================================
import { describe, it, expect } from 'vitest';

type Oppgave = {
  id: string;
  status: string;
  tittel?: string;
  domene?: string;
  klasse?: string;
  prosjekt?: string;
  avhenger?: string[];
  venter_paa?: string[];
  merknader?: string[];
  sammenslatt_fra?: string[];
  eier_filer?: string[];
  plukket_av?: string;
};
type Ko = {
  oppgaver: Oppgave[];
  grenser?: Record<string, unknown>;
  prosjekter?: Record<string, { prefikser?: string[]; pause?: boolean }>;
  fokus?: Record<string, unknown> | null;
  avklart?: string[];
  avklaringer?: Record<string, { tid: string; svar: string | null; av: string | null }>;
  sporsmal?: Record<string, { type: string; tekst: string }>;
};
type Funn = {
  type: string;
  id: string;
  bak: number;
  klasse: 'enkel' | 'kompleks';
  tekst: string;
  kommando?: string;
  valg?: { tekst: string; kommando?: string }[];
  anbefaling?: string;
  dep?: string;
};
type Diagnose = {
  aktive: number;
  maks: number;
  terskel: number;
  andel: number;
  lav: boolean;
  funn: Funn[];
};

/* eslint-disable @typescript-eslint/no-require-imports */
const D = require('../koDiagnose') as {
  STANDARD_TERSKEL: number;
  parallellDiagnose: (ko: Ko, valg?: { naa?: number }) => Diagnose;
  diagnoseLinjer: (d: Diagnose, valg?: { maks?: number }) => string[];
  diagnoseFull: (d: Diagnose) => string[];
  tolkTerskel: (raa: string) => { verdi?: number; feil?: string };
  terskelFor: (ko: Ko) => number;
};
const L = require('../koLogikk') as {
  tolkGrense: (navn: string, raa: string, g?: object) => { verdi?: unknown; feil?: string };
  GRENSE_NAVN: string[];
};
/* eslint-enable @typescript-eslint/no-require-imports */

const NAA = Date.parse('2026-10-10T12:00:00.000Z');

function opp(id: string, felt: Partial<Oppgave> = {}): Oppgave {
  return { id, status: 'venter', tittel: id, domene: id.split('-')[0], klasse: 'K', ...felt };
}

/** Kjørende agenter (teller mot maksSamtidig), hver i sitt domene og uten filer, så de ikke hindrer noe. */
const kjorende = (n: number): Oppgave[] =>
  Array.from({ length: n }, (_, i) => opp(`AKT-${i}`, { status: 'kjorer', domene: `akt${i}` }));

const PROSJEKTER: Ko['prosjekter'] = {
  alfa: { prefikser: ['A-'] },
  beta: { prefikser: ['B-'], pause: true },
  gamma: { prefikser: ['AKT-', 'X-'] },
};
const FOKUS = {
  navn: 'Alfa',
  rekkefolge: ['prosjekt:alfa'],
  resten: 'vent',
  dra_med_avhengigheter: true,
};

function ko(oppgaver: Oppgave[], ekstra: Partial<Ko> = {}): Ko {
  return {
    oppgaver: [...kjorende(2), ...oppgaver],
    grenser: { maksSamtidig: 6 },
    prosjekter: PROSJEKTER,
    fokus: FOKUS,
    avklart: [],
    ...ekstra,
  };
}

const finn = (d: Diagnose, type: string, id: string) =>
  d.funn.find((f) => f.type === type && f.id === id);

describe('avhenger-kansellert (tilfelle 1: A-10 → A-6, slått sammen i A-8)', () => {
  const k = () =>
    ko([
      opp('A-6', {
        status: 'kansellert',
        merknader: ['2026-10-06T18:45:21.753Z slått sammen i A-8'],
      }),
      opp('A-8', { status: 'ferdig' }),
      opp('A-10', { avhenger: ['A-6', 'A-5'] }),
      opp('A-5', { status: 'ferdig' }),
      opp('A-11', { avhenger: ['A-10'] }),
      opp('A-12', { avhenger: ['A-11'] }),
    ]);

  it('enkel: erstatteren fra merknaden, med ferdig endre-kommando og kjeden bak i fokus', () => {
    const f = finn(D.parallellDiagnose(k(), { naa: NAA }), 'avhenger-kansellert', 'A-10');
    expect(f).toBeDefined();
    expect(f?.klasse).toBe('enkel');
    expect(f?.dep).toBe('A-6');
    expect(f?.bak).toBe(3);
    expect(f?.kommando).toBe(
      `node scripts/orkestrator/ko.mjs endre A-10 --json '{"avhenger":["A-8","A-5"]}'`,
    );
  });

  it('erstatteren kan også komme fra sammenslatt_fra, og kjeden følges', () => {
    const kk = ko([
      opp('A-A', { status: 'kansellert' }),
      opp('A-B', {
        status: 'kansellert',
        sammenslatt_fra: ['A-A'],
        merknader: ['t slått sammen i A-C'],
      }),
      opp('A-C', { status: 'ferdig' }),
      opp('A-D', { avhenger: ['A-A'] }),
    ]);
    const f = finn(D.parallellDiagnose(kk, { naa: NAA }), 'avhenger-kansellert', 'A-D');
    expect(f?.klasse).toBe('enkel');
    expect(f?.kommando).toContain('{"avhenger":["A-C"]}');
  });

  it('kompleks: uten kjent erstatter gir valg (fjern) og anbefaling', () => {
    const kk = ko([opp('A-A', { status: 'kansellert' }), opp('A-D', { avhenger: ['A-A'] })]);
    const f = finn(D.parallellDiagnose(kk, { naa: NAA }), 'avhenger-kansellert', 'A-D');
    expect(f?.klasse).toBe('kompleks');
    expect(f?.kommando).toBeUndefined();
    expect(f?.valg?.[0]?.kommando).toContain('{"avhenger":[]}');
    expect(f?.anbefaling).toMatch(/fjern avhengigheten/);
  });
});

describe('avhenger-ukjent (tilfelle 2: A-7-X → A-7-r2, mens r3 er levert)', () => {
  it('enkel: høyeste ferdige revisjon av samme stamme (ikke grunnoppgaven)', () => {
    const kk = ko([
      opp('A-7', { status: 'ferdig' }),
      opp('A-7-r3', { status: 'ferdig' }),
      opp('A-7-X', { avhenger: ['A-7-r2'] }),
    ]);
    const f = finn(D.parallellDiagnose(kk, { naa: NAA }), 'avhenger-ukjent', 'A-7-X');
    expect(f?.klasse).toBe('enkel');
    expect(f?.kommando).toContain('{"avhenger":["A-7-r3"]}');
  });

  it('kompleks: flere mulige (uten revisjon) eller ingen nær id', () => {
    const kk = ko([
      opp('A-Q', { avhenger: ['A-ZZZ'] }),
      opp('A-M-r1', { status: 'ferdig' }),
      opp('A-M-r2', { status: 'ferdig' }),
      opp('A-R', { avhenger: ['A-M'] }),
    ]);
    const d = D.parallellDiagnose(kk, { naa: NAA });
    const ingen = finn(d, 'avhenger-ukjent', 'A-Q');
    expect(ingen?.klasse).toBe('kompleks');
    expect(ingen?.tekst).toMatch(/ingen nær id/);
    const flere = finn(d, 'avhenger-ukjent', 'A-R');
    expect(flere?.klasse).toBe('kompleks');
    expect(flere?.valg?.map((v) => v.tekst)).toEqual([
      'pek om til A-M-r1',
      'pek om til A-M-r2',
      'fjern avhengigheten',
    ]);
  });
});

describe('dratt-med-pauset (tilfelle 3: B-1 i det pausede prosjektet beta)', () => {
  it('enkel: flytt til fokusprosjektet som drar den', () => {
    const kk = ko([
      opp('B-1'),
      opp('B-2', { avhenger: ['B-1'] }),
      opp('A-NY', { avhenger: ['B-2'] }),
    ]);
    const d = D.parallellDiagnose(kk, { naa: NAA });
    const f = finn(d, 'dratt-med-pauset', 'B-1');
    expect(f?.klasse).toBe('enkel');
    expect(f?.kommando).toBe(
      `node scripts/orkestrator/ko.mjs endre B-1 --json '{"prosjekt":"alfa"}'`,
    );
    // B-1 står bak seg selv og to i fokus (B-2 dratt med, A-NY).
    expect(f?.bak).toBe(3);
    expect(finn(d, 'dratt-med-pauset', 'B-2')?.klasse).toBe('enkel');
  });

  it('uten pause: ingen funn', () => {
    const kk = ko([opp('B-1'), opp('A-NY', { avhenger: ['B-1'] })], {
      prosjekter: { ...PROSJEKTER, beta: { prefikser: ['B-'] } },
    });
    expect(
      D.parallellDiagnose(kk, { naa: NAA }).funn.filter((f) => f.type === 'dratt-med-pauset'),
    ).toEqual([]);
  });
});

describe('løse ventinger og besvarte spørsmål', () => {
  it('besvart men ikke i avklart: enkel avklar; uregistrert: kompleks (eieren ser det ikke)', () => {
    const kk = ko([opp('A-1', { venter_paa: ['SP-1'] }), opp('A-2', { venter_paa: ['SP-UREG'] })], {
      avklaringer: { 'SP-1': { tid: '2026-10-10T10:00:00Z', svar: 'ja', av: 'eier' } },
    });
    const d = D.parallellDiagnose(kk, { naa: NAA });
    expect(finn(d, 'lose-venting', 'A-1')?.kommando).toBe(
      'node scripts/orkestrator/ko.mjs avklar SP-1',
    );
    const u = finn(d, 'lose-venting', 'A-2');
    expect(u?.klasse).toBe('kompleks');
    expect(u?.anbefaling).toMatch(/registrer spørsmålet/);
  });

  it('venter-paa-avklart: rydding, ikke i det korte avsnittet', () => {
    const kk = ko([opp('A-1', { venter_paa: ['SP-1', 'SP-2'] })], {
      avklart: ['SP-1'],
      sporsmal: { 'SP-2': { type: 'sporsmal', tekst: 'Spørsmål to?' } },
    });
    const d = D.parallellDiagnose(kk, { naa: NAA });
    const f = finn(d, 'venter-paa-avklart', 'A-1');
    expect(f?.klasse).toBe('enkel');
    expect(f?.kommando).toContain(`{"venter_paa":["SP-2"]}`);
    expect(D.diagnoseLinjer(d).join('\n')).not.toContain('venter-paa-avklart');
    expect(D.diagnoseFull(d).join('\n')).toContain('RYDDING (1)');
  });
});

describe('flaskehals', () => {
  it('kompleks, bare informasjon: den ikke-startbare som flest fokusoppgaver venter på, med egen grunn', () => {
    const kk = ko([
      opp('A-REV', { status: 'review' }),
      opp('A-A', { avhenger: ['A-REV'] }),
      opp('A-B', { avhenger: ['A-A'] }),
      opp('A-C', { avhenger: ['A-REV'] }),
      opp('A-SP', { venter_paa: ['SP-9'] }),
      opp('A-E', { avhenger: ['A-SP'] }),
    ]);
    const d = D.parallellDiagnose(kk, { naa: NAA });
    const fl = d.funn.filter((f) => f.type === 'flaskehals');
    expect(fl.map((f) => f.id)).toEqual(['A-REV', 'A-A', 'A-SP']);
    expect(fl[0]).toMatchObject({ klasse: 'kompleks', bak: 3 });
    expect(fl[0].tekst).toMatch(/i review/);
    expect(fl[0].anbefaling).toMatch(/review og fletting av A-REV/);
    expect(fl[2].anbefaling).toMatch(/SP-9/);
    expect(fl.every((f) => f.kommando === undefined)).toBe(true);
  });
});

// Fyll finner ingenting å starte, og hindringene er tomme for klare D+-oppgaver i fokus, fordi maksDPluss = 2 er
// brukt opp av to aktive D+-spor. Diagnosen skal si det.
describe('kapasitet (tilfelle 4: klare D+ i fokus holdes igjen av maksDPluss)', () => {
  const kk = () =>
    ko(
      [
        opp('A-DP1', { status: 'kjorer', klasse: 'D+', domene: 'dp1' }),
        opp('A-DP2', { status: 'review', klasse: 'D+', domene: 'dp2' }),
        opp('A-KLAR1', { klasse: 'D+', domene: 'k1' }),
        opp('A-KLAR2', { klasse: 'D+', domene: 'k2' }),
      ],
      { grenser: { maksSamtidig: 6, maksDPluss: 2 } },
    );

  it('kompleks: grensen, oppgavene den holder igjen og sporene som har plassene, med grense-kommandoen som valg', () => {
    const d = D.parallellDiagnose(kk(), { naa: NAA });
    const f = finn(d, 'kapasitet', 'maksDPluss');
    expect(f).toBeDefined();
    expect(f).toMatchObject({ klasse: 'kompleks', bak: 2 });
    expect(f!.tekst).toMatch(/maksDPluss \(2\)/);
    expect(f!.tekst).toMatch(/A-KLAR1, A-KLAR2/);
    expect(f!.tekst).toMatch(/A-DP1, A-DP2/);
    expect(f!.anbefaling).toMatch(/grense maksDPluss 3/);
  });

  it('kapasitet står foran flaskehalsene og vises i det korte avsnittet', () => {
    const d = D.parallellDiagnose(kk(), { naa: NAA });
    const iKapasitet = d.funn.findIndex((x) => x.type === 'kapasitet');
    const iFlask = d.funn.findIndex((x) => x.type === 'flaskehals');
    if (iFlask >= 0) expect(iKapasitet).toBeLessThan(iFlask);
    expect(D.diagnoseLinjer(d).some((l) => l.includes('[kompleks] kapasitet maksDPluss'))).toBe(
      true,
    );
  });

  it('ingen kapasitetsfunn når grensen ikke er nådd', () => {
    const k2 = kk();
    k2.grenser = { maksSamtidig: 6, maksDPluss: 4 };
    expect(D.parallellDiagnose(k2, { naa: NAA }).funn.some((x) => x.type === 'kapasitet')).toBe(
      false,
    );
  });
});

describe('terskelen og utskriften', () => {
  it('lav: 2 av 6 (33 %) gir overskrift, enkle før komplekse, høyst 12 linjer', () => {
    const mange = Array.from({ length: 20 }, (_, i) =>
      opp(`A-K${i}`, { avhenger: [`A-BORTE-${i}`] }),
    );
    const d = D.parallellDiagnose(ko(mange), { naa: NAA });
    expect(d).toMatchObject({ aktive: 2, maks: 6, lav: true });
    const linjer = D.diagnoseLinjer(d);
    expect(linjer[0]).toBe('LAV PARALLELLITET: 2 av 6 spor (33 %, terskel 70 %). Rask diagnose:');
    expect(linjer.length).toBeLessThanOrEqual(12);
    expect(linjer.join('\n')).toMatch(/\+\d+ funn til \(ko\.mjs diagnose\)/);
  });

  it('ingen utskrift når andelen er over terskelen (5 av 6), men diagnose viser alt', () => {
    const kk = ko([opp('A-D', { avhenger: ['A-BORTE'] })], {
      oppgaver: [...kjorende(5), opp('A-D', { avhenger: ['A-BORTE'] })],
    });
    const d = D.parallellDiagnose(kk, { naa: NAA });
    expect(d.lav).toBe(false);
    expect(D.diagnoseLinjer(d)).toEqual([]);
    expect(D.diagnoseFull(d).join('\n')).toContain('avhenger-ukjent A-D');
  });

  it('akkurat på terskelen er ikke lav; plukkede teller ikke som agenter', () => {
    const terskel = { grenser: { maksSamtidig: 10, parallellTerskel: 0.5 } };
    expect(D.parallellDiagnose({ ...ko([]), oppgaver: kjorende(5), ...terskel }).lav).toBe(false);
    const plukket = opp('A-P', { status: 'kjorer', plukket_av: 'eier' });
    expect(
      D.parallellDiagnose({ ...ko([]), oppgaver: [...kjorende(4), plukket], ...terskel }).lav,
    ).toBe(true);
  });

  it('parallellTerskel: tolkes av grense (0–1 eller prosent), 0 slår vakten av, ugyldig avvises', () => {
    expect(D.STANDARD_TERSKEL).toBe(0.7);
    expect(D.tolkTerskel('70 %')).toEqual({ verdi: 0.7 });
    expect(D.tolkTerskel('0,5')).toEqual({ verdi: 0.5 });
    expect(D.tolkTerskel('1.5').feil).toBeDefined();
    expect(L.tolkGrense('parallellTerskel', '0.6')).toEqual({ verdi: 0.6 });
    expect(L.tolkGrense('parallellTerskel', 'mye').feil).toMatch(/fra 0 til 1/);
    // Ikke en plassgrense: innstillingspanelet på tavla (GRENSE_NAVN) er uendret.
    expect(L.GRENSE_NAVN).not.toContain('parallellTerskel');
    const av = { ...ko([]), grenser: { maksSamtidig: 6, parallellTerskel: 0 } };
    expect(D.terskelFor(av)).toBe(0);
    expect(D.parallellDiagnose(av).lav).toBe(false);
  });

  it('rører aldri køen', () => {
    const kk = ko([
      opp('A-6', { status: 'kansellert', merknader: ['t slått sammen i A-8'] }),
      opp('A-8', { status: 'ferdig' }),
      opp('A-10', { avhenger: ['A-6'] }),
      opp('B-1'),
      opp('A-NY', { avhenger: ['B-1'] }),
    ]);
    const foer = JSON.stringify(kk);
    D.diagnoseFull(D.parallellDiagnose(kk, { naa: NAA }));
    expect(JSON.stringify(kk)).toBe(foer);
  });
});
