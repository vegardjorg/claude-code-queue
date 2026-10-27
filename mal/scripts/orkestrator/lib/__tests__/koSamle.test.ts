// =============================================================
// koSamle.test.ts: samlekøen i arbeidskøen.
//
// Små oppgaver som ikke blokkerer noe, legges inn med `samles: true` og pakkes til spor av riktig størrelse når en
// gruppe (prosjekt → klasse) er stor nok. Testene beviser reglene der de håndheves: de rene funksjonene i koLogikk.js
// (validering, gruppering og klar-terskel, pakking, at samlekø-oppgaver aldri er startbare), tavla og statistikken
// (koTavle.js, koStatistikk.js), og ko.mjs mot en kopi av køen i en midlertidig mappe (KO_MAPPE), aldri den ekte.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Oppgave = {
  id: string;
  tittel?: string;
  domene?: string;
  klasse?: 'K' | 'D' | 'D+' | 'U';
  status: string;
  oppdrag?: string;
  nytte?: number;
  innhold_min?: number;
  migr_tiere?: number;
  avhenger?: string[];
  venter_paa?: string[];
  eier_filer?: string[];
  eier_db?: string[];
  delt_patch?: string[];
  krever?: string[];
  etiketter?: string[];
  prosjekt?: string;
  funksjon?: string;
  kilde?: string;
  samles?: boolean;
  merknader?: string[];
  sammenslatt_fra?: string[];
  lagt_til?: string;
  lagt_til_av?: string;
};
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  prosjekter?: Record<string, { tittel: string; prefikser?: string[] }>;
  neste_migr?: number;
};
type Maal = { min: number; maal: number; maks: number };
type Gruppe = {
  pid: string;
  klasse: string;
  maal: Maal | null;
  sum: number;
  antall: number;
  klar: boolean;
  over: boolean;
  ugyldig: boolean;
  felles_filer: string[];
  funksjoner: { funksjon: string; sum: number; ider: string[] }[];
  oppgaver: { id: string; innhold_min: number; funksjon: string }[];
};
type Forslag = {
  id: string | null;
  pid: string;
  klasse: string;
  deler: string[];
  sum: number;
  ut: boolean;
};
type PakkSvar = {
  feil: string[];
  ny?: Oppgave;
  kansellert?: string[];
  omdirigert?: string[];
};

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../koLogikk') as {
  SAMLE_MAAL: Record<string, Maal>;
  SAMLES_HINDRING: string;
  erSamles: (o: Oppgave) => boolean;
  iSamlekoen: (o: Oppgave) => boolean;
  samlesFeil: (o: Oppgave, oppgaver: Oppgave[], avklart?: string[]) => string[];
  samleGrupper: (ko: Ko) => Gruppe[];
  samleForslag: (ko: Ko) => Forslag[];
  samlePakk: (
    ko: Ko,
    ider: string[],
    valg: { nyId: string; tittel?: string | null; oppdrag: string; av?: string; naa?: string },
  ) => PakkSvar;
  samleOppdragTekst: (
    ny: Oppgave,
    deler: Oppgave[],
    tekster: Map<string, { tekst: string; sti: string | null }>,
    naa?: string,
  ) => string;
  hindringer: (o: Oppgave, oppgaver: Oppgave[], avklart?: string[]) => string[];
  velgNeste: (ko: Ko, naa?: number) => { id: string }[];
  plukkbare: (ko: Ko) => { id: string }[];
  plukk: (
    ko: Ko,
    id: string,
    valg: { av: string; tving?: boolean },
  ) => { feil?: string; oppgave?: Oppgave };
  tilstand: (
    ko: Ko,
    forbruk?: number,
  ) => {
    venter: number;
    forslag: number;
    samles: number;
    kanStarte: number;
    blokkert: { id: string }[];
  };
};
const T = require('../koTavle') as {
  kolonneFor: (o: Oppgave) => string | null;
  tavle: (ko: Ko) => {
    kolonner: Record<string, { id: string; klar: boolean; samles: boolean }[]>;
    samlekoen: Gruppe[];
  };
};
const S = require('../koStatistikk') as {
  statistikk: (
    ko: Ko,
    rader: unknown[],
    valg?: { naa?: number },
  ) => {
    nokkeltall: { samlekoen: { antall: number; minutter: number; grupper: number; klare: number } };
  };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const T1 = '2026-10-06T10:00:00.000Z';

function opp(id: string, felt: Partial<Oppgave> = {}): Oppgave {
  return {
    id,
    tittel: `Oppgave ${id}`,
    domene: 'klient',
    klasse: 'K',
    status: 'venter',
    oppdrag: `Gjør ${id}.`,
    nytte: 5,
    innhold_min: 30,
    migr_tiere: 0,
    avhenger: [],
    venter_paa: [],
    eier_filer: [],
    eier_db: [],
    delt_patch: [],
    lagt_til: T1,
    ...felt,
  };
}

const REGISTER = {
  ui: { tittel: 'Kalender', prefikser: ['VA-'] },
  hjelp: { tittel: 'Hjelp', prefikser: ['KU-'] },
};

describe('samlesFeil (add/endre)', () => {
  it('godtar en liten, ikke-blokkerende K i samlekøen, og gammel oppgave uten feltet', () => {
    expect(L.samlesFeil(opp('A', { samles: true }), [])).toEqual([]);
    expect(L.samlesFeil(opp('A'), [])).toEqual([]);
    expect(L.samlesFeil(opp('A', { samles: false }), [])).toEqual([]);
  });

  it('avviser D+, ikke-boolsk verdi og oppgaver som ikke venter', () => {
    expect(L.samlesFeil(opp('A', { klasse: 'D+', samles: true }), []).join()).toMatch(
      /D\+ slås aldri sammen/,
    );
    expect(L.samlesFeil({ ...opp('A'), samles: 'ja' as unknown as boolean }, []).join()).toMatch(
      /samles må være true eller false/,
    );
    expect(L.samlesFeil(opp('A', { status: 'kjorer', samles: true }), []).join()).toMatch(
      /bare oppgaver som venter/,
    );
  });

  it('avviser en oppgave som en annen åpen oppgave avhenger av (ferdige og kansellerte teller ikke)', () => {
    const a = opp('A', { samles: true });
    const f = L.samlesFeil(a, [a, opp('B', { avhenger: ['A'] })]);
    expect(f.join()).toMatch(/B avhenger av A/);
    expect(
      L.samlesFeil(a, [
        a,
        opp('C', { avhenger: ['A'], status: 'ferdig' }),
        opp('D', { avhenger: ['A'], status: 'kansellert' }),
      ]),
    ).toEqual([]);
  });

  it('avviser åpne eierspørsmål, men godtar avklarte', () => {
    const a = opp('A', { samles: true, venter_paa: ['Ø9'] });
    expect(L.samlesFeil(a, [a]).join()).toMatch(/eierspørsmål som ikke er avklart \(Ø9\)/);
    expect(L.samlesFeil(a, [a], ['Ø9'])).toEqual([]);
  });

  it('avviser at en oppgave avhenger av en oppgave i samlekøen', () => {
    const s = opp('S', { samles: true });
    const b = opp('B', { avhenger: ['S'] });
    expect(L.samlesFeil(b, [s, b]).join()).toMatch(/avhenger av S, som ligger i samlekøen/);
  });
});

describe('samlekø-oppgaver er aldri startbare eller plukkbare', () => {
  const ko = (): Ko => ({
    oppgaver: [opp('A', { samles: true }), opp('B'), opp('C', { samles: true, status: 'forslag' })],
    neste_migr: 2840,
  });

  it('hindringen samles; velgNeste og plukkbare hopper over', () => {
    const k = ko();
    expect(L.hindringer(k.oppgaver[0], k.oppgaver)).toEqual([L.SAMLES_HINDRING]);
    expect(L.velgNeste(k).map((x) => x.id)).toEqual(['B']);
    expect(L.plukkbare(k).map((x) => x.id)).toEqual(['B']);
  });

  it('plukk nekter, også med --tving', () => {
    const k = ko();
    expect(L.plukk(k, 'A', { av: 'eier', tving: true }).feil).toMatch(/i samlekøen/);
    expect(k.oppgaver[0].status).toBe('venter');
  });

  it('tilstand teller samlekøen for seg (ikke som venter eller forslag, ikke blokkert)', () => {
    const t = L.tilstand(ko());
    expect(t.venter).toBe(1);
    expect(t.forslag).toBe(0);
    expect(t.samles).toBe(2);
    expect(t.kanStarte).toBe(1);
    expect(t.blokkert.map((b) => b.id)).toEqual([]);
  });

  it('kansellert eller ferdig med samles står ikke i samlekøen', () => {
    expect(L.iSamlekoen(opp('A', { samles: true, status: 'kansellert' }))).toBe(false);
    expect(L.iSamlekoen(opp('A', { samles: true, status: 'forslag' }))).toBe(true);
    expect(L.erSamles(opp('A'))).toBe(false);
  });
});

describe('samleGrupper og klar-terskelen', () => {
  it('grupperer prosjekt → klasse i registerets rekkefølge, K før D før U, oppgavene etter funksjon og id', () => {
    const ko: Ko = {
      prosjekter: REGISTER,
      oppgaver: [
        opp('KU-1', { samles: true, innhold_min: 20 }),
        opp('VA-3', { samles: true, klasse: 'D', innhold_min: 20, funksjon: 'B' }),
        opp('VA-2', { samles: true, innhold_min: 40, funksjon: 'B', eier_filer: ['a.ts'] }),
        opp('VA-1', {
          samles: true,
          innhold_min: 50,
          funksjon: 'A',
          eier_filer: ['./a.ts', 'b.ts'],
        }),
        opp('VA-4', { samles: true, klasse: 'U', innhold_min: 45 }),
        opp('VA-5', { innhold_min: 50 }), // ikke i samlekøen
      ],
    };
    const g = L.samleGrupper(ko);
    expect(g.map((x) => `${x.pid}/${x.klasse}`)).toEqual(['ui/K', 'ui/D', 'ui/U', 'hjelp/K']);
    expect(g[0].oppgaver.map((o) => o.id)).toEqual(['VA-1', 'VA-2']);
    expect(g[0].sum).toBe(90);
    expect(g[0].klar).toBe(true);
    expect(g[0].funksjoner).toEqual([
      { funksjon: 'A', sum: 50, ider: ['VA-1'] },
      { funksjon: 'B', sum: 40, ider: ['VA-2'] },
    ]);
    expect(g[0].felles_filer).toEqual(['a.ts']);
    expect(g[1]).toMatchObject({ klasse: 'D', sum: 20, klar: false });
    expect(g[2]).toMatchObject({ klasse: 'U', sum: 45, klar: true });
    expect(g[3]).toMatchObject({ pid: 'hjelp', sum: 20, klar: false });
  });

  it('klar fra nedre mål: K 90, D 30, U 45 (ett minutt under er ikke klar); over øvre mål merkes', () => {
    expect(L.SAMLE_MAAL.K).toMatchObject({ min: 90, maks: 120 });
    expect(L.SAMLE_MAAL.D).toMatchObject({ min: 30, maks: 50 });
    expect(L.SAMLE_MAAL.U).toMatchObject({ min: 45 });
    for (const [klasse, min] of [
      ['K', 90],
      ['D', 30],
      ['U', 45],
    ] as const) {
      const under = L.samleGrupper({
        oppgaver: [opp('A', { klasse, samles: true, innhold_min: min - 1 })],
      });
      const paa = L.samleGrupper({
        oppgaver: [opp('A', { klasse, samles: true, innhold_min: min })],
      });
      expect(under[0].klar).toBe(false);
      expect(paa[0].klar).toBe(true);
    }
    const over = L.samleGrupper({ oppgaver: [opp('A', { samles: true, innhold_min: 121 })] });
    expect(over[0].over).toBe(true);
  });

  it('en D+ med samles fra før (gammel data) vises som ugyldig og er aldri klar', () => {
    const g = L.samleGrupper({
      oppgaver: [opp('A', { klasse: 'D+', samles: true, innhold_min: 99 })],
    });
    expect(g[0]).toMatchObject({ ugyldig: true, klar: false, maal: null });
  });

  it('er deterministisk (samme svar uansett rekkefølgen i køfila)', () => {
    const o = [
      opp('VA-2', { samles: true, funksjon: 'X' }),
      opp('VA-1', { samles: true, funksjon: 'X' }),
      opp('KU-1', { samles: true }),
    ];
    const a = L.samleGrupper({ prosjekter: REGISTER, oppgaver: o });
    const b = L.samleGrupper({ prosjekter: REGISTER, oppgaver: [...o].reverse() });
    expect(b).toEqual(a);
  });
});

describe('samleForslag (--auto)', () => {
  it('fyller pakker opp mot øvre mål, lar en rest under nedre mål ligge, og gir ledige id-er', () => {
    const ko: Ko = {
      prosjekter: REGISTER,
      oppgaver: [
        opp('VA-S1', { status: 'ferdig' }), // id-en er brukt
        ...['a', 'b', 'c', 'd', 'e'].map((x) => opp(`VA-${x}`, { samles: true, innhold_min: 40 })),
        opp('VA-f', { samles: true, innhold_min: 20 }),
        opp('KU-1', { samles: true, innhold_min: 30 }), // ikke klar
      ],
    };
    const f = L.samleForslag(ko);
    expect(f).toEqual([
      {
        id: 'VA-S2',
        pid: 'ui',
        klasse: 'K',
        deler: ['VA-a', 'VA-b', 'VA-c'],
        sum: 120,
        ut: false,
      },
      {
        id: 'VA-S3',
        pid: 'ui',
        klasse: 'K',
        deler: ['VA-d', 'VA-e', 'VA-f'],
        sum: 100,
        ut: false,
      },
    ]);
  });

  it('én oppgave som alene har nådd målet, foreslås tatt ut av samlekøen', () => {
    const f = L.samleForslag({
      oppgaver: [opp('A', { klasse: 'D', samles: true }), opp('B', { klasse: 'D', samles: true })],
    });
    expect(f.map((x) => [x.deler, x.ut, x.id])).toEqual([
      [['A'], true, null],
      [['B'], true, null],
    ]);
  });

  it('endrer ingenting', () => {
    const ko: Ko = { oppgaver: [opp('A', { samles: true, innhold_min: 95 })] };
    const før = JSON.stringify(ko);
    L.samleForslag(ko);
    expect(JSON.stringify(ko)).toBe(før);
  });
});

describe('samlePakk', () => {
  const lagKo = (): Ko => ({
    prosjekter: REGISTER,
    avklart: ['Ø1'],
    oppgaver: [
      opp('VA-1', {
        samles: true,
        nytte: 4,
        innhold_min: 30,
        avhenger: ['X'],
        eier_filer: ['a.ts'],
        krever: ['db'],
        funksjon: 'Felles',
        kilde: 'plan § 1',
        venter_paa: ['Ø1'],
      }),
      opp('VA-2', {
        samles: true,
        nytte: 8,
        innhold_min: 40,
        migr_tiere: 1,
        avhenger: ['X', 'VA-1', 'Y'],
        eier_filer: ['a.ts', 'b.ts'],
        eier_db: ['f'],
        etiketter: ['visuell'],
        funksjon: 'Felles',
      }),
      opp('VA-3', { samles: true, innhold_min: 25, delt_patch: ['anonymize_user'] }),
      opp('X', { status: 'ferdig' }),
      opp('Y'),
      opp('Z', { avhenger: ['VA-2', 'VA-3', 'Y'] }),
      opp('Q', { avhenger: ['VA-1'], status: 'ferdig' }),
    ],
  });
  const NAA = '2026-10-06T12:00:00.000Z';

  it('slår sammen feltene, kansellerer originalene og peker om avhenger', () => {
    const ko = lagKo();
    const r = L.samlePakk(ko, ['VA-1', 'VA-2', 'VA-3'], {
      nyId: 'VA-S1',
      oppdrag: 'scripts/.ko/oppdrag/VA-S1.md',
      naa: NAA,
    });
    expect(r.feil).toEqual([]);
    expect(r.ny).toMatchObject({
      id: 'VA-S1',
      klasse: 'K',
      status: 'venter',
      prosjekt: 'ui',
      funksjon: 'Felles',
      domene: 'klient',
      nytte: 8,
      innhold_min: 95,
      migr_tiere: 1,
      avhenger: ['X', 'Y'],
      venter_paa: ['Ø1'],
      eier_filer: ['a.ts', 'b.ts'],
      eier_db: ['f'],
      delt_patch: ['anonymize_user'],
      krever: ['db'],
      etiketter: ['visuell'],
      kilde: 'VA-1: plan § 1',
      sammenslatt_fra: ['VA-1', 'VA-2', 'VA-3'],
      oppdrag: 'scripts/.ko/oppdrag/VA-S1.md',
      lagt_til: NAA,
    });
    expect(r.ny?.samles).toBeUndefined();
    expect(r.ny?.tittel).toBe('Samlet spor (3): Oppgave VA-1 + Oppgave VA-2 + Oppgave VA-3');
    for (const id of ['VA-1', 'VA-2', 'VA-3']) {
      const o = ko.oppgaver.find((x) => x.id === id);
      expect(o?.status).toBe('kansellert');
      expect(o?.merknader).toEqual([`${NAA} slått sammen i VA-S1`]);
    }
    expect(ko.oppgaver.find((x) => x.id === 'Z')?.avhenger).toEqual(['VA-S1', 'Y']);
    // En ferdig oppgave røres ikke.
    expect(ko.oppgaver.find((x) => x.id === 'Q')?.avhenger).toEqual(['VA-1']);
    expect(r.omdirigert).toEqual(['Z']);
    // Den nye er startbar når forgjengerne er ferdige (Y venter fortsatt).
    expect(L.hindringer(r.ny as Oppgave, ko.oppgaver, ko.avklart)).toEqual([
      'venter på Y (venter)',
    ]);
  });

  it('egen tittel; forslag blant delene gir status forslag', () => {
    const ko = lagKo();
    ko.oppgaver[2].status = 'forslag';
    const r = L.samlePakk(ko, ['VA-1', 'VA-3'], {
      nyId: 'VA-S1',
      tittel: 'Små vaktting',
      oppdrag: 'x.md',
    });
    expect(r.ny).toMatchObject({ tittel: 'Små vaktting', status: 'forslag' });
  });

  const avvist = (endre: (ko: Ko) => void, ider: string[], nyId: string, monster: RegExp) => {
    const ko = lagKo();
    endre(ko);
    const før = JSON.stringify(ko);
    const r = L.samlePakk(ko, ider, { nyId, oppdrag: 'x.md' });
    expect(r.feil.join('\n')).toMatch(monster);
    // Alt eller ingenting: køen er urørt.
    expect(JSON.stringify(ko)).toBe(før);
  };

  it('avviser ulike klasser (K og D blandes aldri)', () =>
    avvist((ko) => (ko.oppgaver[2].klasse = 'D'), ['VA-1', 'VA-3'], 'VA-S1', /ulike klasser/));
  it('avviser D+', () =>
    avvist(
      (ko) => {
        ko.oppgaver[0].klasse = 'D+';
        ko.oppgaver[2].klasse = 'D+';
      },
      ['VA-1', 'VA-3'],
      'VA-S1',
      /D\+ slås aldri sammen/,
    ));
  it('avviser ulike åpne eierspørsmål', () =>
    avvist(
      (ko) => (ko.oppgaver[2].venter_paa = ['Ø7']),
      ['VA-1', 'VA-3'],
      'VA-S1',
      /ulike åpne eierspørsmål/,
    ));
  it('avviser færre enn to, dobbel id, ukjent id og feil status', () => {
    avvist(() => undefined, ['VA-1'], 'VA-S1', /minst to oppgaver/);
    avvist(() => undefined, ['VA-1', 'VA-1'], 'VA-S1', /flere ganger/);
    avvist(() => undefined, ['VA-1', 'NEI'], 'VA-S1', /ukjent oppgave NEI/);
    avvist(() => undefined, ['VA-1', 'X'], 'VA-S1', /X har status ferdig/);
  });
  it('avviser en id som finnes og en ugyldig id', () => {
    avvist(() => undefined, ['VA-1', 'VA-3'], 'Y', /id Y finnes fra før/);
    avvist(() => undefined, ['VA-1', 'VA-3'], 'ny id', /ugyldige tegn/);
  });
  it('avviser en syklus (en ekstern forgjenger venter selv på en av delene)', () =>
    avvist((ko) => (ko.oppgaver[2].avhenger = ['Z']), ['VA-2', 'VA-3'], 'VA-S1', /syklus: Z/));

  it('oppdragsteksten har innledning, rekkefølge og hver dels oppdrag i sin helhet', () => {
    const ko = lagKo();
    const deler = [ko.oppgaver[0], ko.oppgaver[2]];
    const r = L.samlePakk(ko, ['VA-1', 'VA-3'], { nyId: 'VA-S1', oppdrag: 'x.md', naa: NAA });
    const tekst = L.samleOppdragTekst(
      r.ny as Oppgave,
      deler,
      new Map([
        [
          'VA-1',
          { tekst: '# VA-1\n\nHele oppdraget for VA-1.\n', sti: 'scripts/.ko/oppdrag/VA-1.md' },
        ],
        ['VA-3', { tekst: 'Gjør VA-3.', sti: null }],
      ]),
      NAA,
    );
    expect(tekst).toMatch(/^# VA-S1: sammenslått spor \(2 deler, K, ca\. 55 innholdsminutter\)/);
    expect(tekst).toContain('1. VA-1: Oppgave VA-1 (K, 30 min)');
    expect(tekst).toContain('2. VA-3: Oppgave VA-3 (K, 25 min)');
    expect(tekst).toContain('## Del VA-1: Oppgave VA-1');
    expect(tekst).toContain('(Opprinnelig oppdragsfil: `scripts/.ko/oppdrag/VA-1.md`)');
    expect(tekst).toContain('Hele oppdraget for VA-1.');
    expect(tekst).toContain('(Opprinnelig oppdrag sto som tekst i køfila.)');
    expect(tekst).toContain('Gjør VA-3.');
  });
});

describe('tavla og statistikken', () => {
  const ko = (): Ko => ({
    prosjekter: REGISTER,
    oppgaver: [
      opp('VA-1', { samles: true, innhold_min: 60 }),
      opp('VA-2', { samles: true, innhold_min: 35 }),
      opp('VA-3'),
      opp('KU-1', { samles: true, klasse: 'D', innhold_min: 20, status: 'forslag' }),
    ],
  });

  it('samlekø-kortene står i egen kolonne, ikke i I kø eller Forslag', () => {
    const t = T.tavle(ko());
    expect(T.kolonneFor(opp('A', { samles: true }))).toBe('samle');
    expect(t.kolonner.samle.map((k) => k.id)).toEqual(['VA-1', 'VA-2', 'KU-1']);
    expect(t.kolonner.ko.map((k) => k.id)).toEqual(['VA-3']);
    expect(t.kolonner.forslag).toEqual([]);
    expect(t.kolonner.samle.every((k) => k.samles && !k.klar)).toBe(true);
    expect(t.samlekoen.map((g) => [g.pid, g.klasse, g.sum, g.klar])).toEqual([
      ['ui', 'K', 95, true],
      ['hjelp', 'D', 20, false],
    ]);
  });

  it('statistikken teller samlekøen for seg', () => {
    const s = S.statistikk(ko(), [], { naa: Date.parse(T1) });
    expect(s.nokkeltall.samlekoen).toEqual({ antall: 3, minutter: 115, grupper: 2, klare: 1 });
  });
});

describe('ko.mjs samle (mot en kopi av køen)', () => {
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
      return { kode: x.status, ut: String(x.stdout ?? ''), feil: String(x.stderr ?? '') };
    }
  }
  const lesKo = (): Ko => JSON.parse(readFileSync(join(mappe, 'ko.json'), 'utf8'));
  const oppdragSti = (id: string) => join(mappe, 'oppdrag', `${id}.md`);

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-samle-'));
    mkdirSync(join(mappe, 'kilde'));
    for (const id of ['VA-1', 'VA-2'])
      writeFileSync(join(mappe, 'kilde', `${id}.md`), `# ${id}\n\nOppdraget for ${id}.\n`);
    const ko: Ko = {
      prosjekter: REGISTER,
      neste_migr: 2840,
      oppgaver: [
        opp('VA-1', { samles: true, innhold_min: 50, oppdrag: join(mappe, 'kilde', 'VA-1.md') }),
        opp('VA-2', { samles: true, innhold_min: 45, oppdrag: join(mappe, 'kilde', 'VA-2.md') }),
        opp('VA-3', { avhenger: ['VA-1'] }),
        opp('VA-4', { klasse: 'D' }),
      ],
    };
    // VA-3 avhenger av VA-1 fra før (gammel data); samle pakk skal peke den om.
    writeFileSync(join(mappe, 'ko.json'), JSON.stringify(ko));
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('samle lister gruppene med sum mot målet og KLAR TIL PAKKING', () => {
    const r = kjor(['samle']);
    expect(r.kode).toBe(0);
    expect(r.ut).toMatch(/SAMLEKØEN: 2 oppgave\(r\), 95 innholdsminutter/);
    expect(r.ut).toMatch(/K +95 \/ 90–120 min .*KLAR TIL PAKKING/);
    expect(r.ut).toContain('VA-1');
  });

  it('add avviser samles for D+ og for åpne eierspørsmål; hele fila avvises', () => {
    const fil = join(mappe, 'inn.json');
    writeFileSync(
      fil,
      JSON.stringify([
        opp('VA-9', { klasse: 'D+', samles: true }),
        opp('VA-8', { samles: true, venter_paa: ['Ø5'] }),
        opp('VA-7', { samles: true }),
      ]),
    );
    const r = kjor(['add', '--fil', fil]);
    expect(r.kode).toBe(1);
    expect(r.feil).toMatch(/VA-9: .*D\+ slås aldri sammen/);
    expect(r.feil).toMatch(/VA-8: .*Ø5/);
    expect(lesKo().oppgaver.map((o) => o.id)).not.toContain('VA-7');
  });

  it('add avviser samles på en oppgave som en annen i samme fil avhenger av', () => {
    const fil = join(mappe, 'inn.json');
    writeFileSync(
      fil,
      JSON.stringify([opp('VA-7', { samles: true }), opp('VA-6', { avhenger: ['VA-7'] })]),
    );
    const r = kjor(['add', '--fil', fil]);
    expect(r.kode).toBe(1);
    expect(r.feil).toMatch(/VA-6 avhenger av VA-7/);
  });

  it('endre: samles inn og ut; nekter samles på noe andre avhenger av', () => {
    expect(kjor(['endre', 'VA-4', '--json', '{"samles":true}']).kode).toBe(0);
    expect(lesKo().oppgaver.find((o) => o.id === 'VA-4')?.samles).toBe(true);
    expect(kjor(['endre', 'VA-4', '--json', '{"samles":false}']).kode).toBe(0);
    expect(lesKo().oppgaver.find((o) => o.id === 'VA-4')).not.toHaveProperty('samles');
    const r = kjor(['endre', 'VA-1', '--json', '{"nytte":9}']);
    expect(r.kode).toBe(1); // VA-3 avhenger av VA-1 i samlekøen (gammel data) og stoppes
    expect(r.feil).toMatch(/VA-3 avhenger av VA-1/);
  });

  it('start nekter en oppgave i samlekøen', () => {
    const r = kjor(['start', 'VA-2', '--tving']);
    expect(r.kode).toBe(1);
    expect(r.feil).toMatch(/i samlekøen/);
  });

  it('samle pakk skriver oppdragsfila, kansellerer delene og peker om avhenger', () => {
    const r = kjor(['samle', 'pakk', 'VA-1', 'VA-2', '--id', 'VA-S1', '--tittel', 'Små ui']);
    expect(r.feil).toBe('');
    expect(r.ut).toMatch(/Pakket VA-S1 \(K, 95 min, status venter\) av VA-1, VA-2/);
    const ko = lesKo();
    const ny = ko.oppgaver.find((o) => o.id === 'VA-S1');
    expect(ny).toMatchObject({ tittel: 'Små ui', sammenslatt_fra: ['VA-1', 'VA-2'] });
    expect(ko.oppgaver.find((o) => o.id === 'VA-1')?.status).toBe('kansellert');
    expect(ko.oppgaver.find((o) => o.id === 'VA-3')?.avhenger).toEqual(['VA-S1']);
    const tekst = readFileSync(oppdragSti('VA-S1'), 'utf8');
    expect(tekst).toContain('Oppdraget for VA-1.');
    expect(tekst).toContain('Oppdraget for VA-2.');
    expect(ny?.oppdrag?.replace(/\\/g, '/')).toBe(oppdragSti('VA-S1').replace(/\\/g, '/'));
  });

  it('samle pakk er alt eller ingenting: feil gir urørt køfil og ingen oppdragsfil', () => {
    const før = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const r = kjor(['samle', 'pakk', 'VA-1', 'VA-4', '--id', 'VA-S1']);
    expect(r.kode).toBe(1);
    expect(r.feil).toMatch(/ulike klasser/);
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(før);
    expect(existsSync(oppdragSti('VA-S1'))).toBe(false);
    // En oppdragsfil som finnes fra før, overskrives aldri.
    mkdirSync(join(mappe, 'oppdrag'), { recursive: true });
    writeFileSync(oppdragSti('VA-S1'), 'gammel');
    const r2 = kjor(['samle', 'pakk', 'VA-1', 'VA-2', '--id', 'VA-S1']);
    expect(r2.kode).toBe(1);
    expect(readFileSync(oppdragSti('VA-S1'), 'utf8')).toBe('gammel');
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(før);
  });

  it('samle pakk --auto foreslår uten å endre; --utfor pakker', () => {
    const før = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const r = kjor(['samle', 'pakk', '--auto']);
    expect(r.ut).toContain('ko.mjs samle pakk VA-1 VA-2 --id VA-S1');
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(før);
    const u = kjor(['samle', 'pakk', '--auto', '--utfor']);
    expect(u.feil).toBe('');
    expect(lesKo().oppgaver.find((o) => o.id === 'VA-S1')?.status).toBe('venter');
    expect(existsSync(oppdragSti('VA-S1'))).toBe(true);
  });

  it('vis teller samlekøen for seg og viser ikke kortene som ventende', () => {
    const r = kjor(['vis']);
    expect(r.ut).toMatch(/SAMLEKØEN \(2 oppgave\(r\) i 1 gruppe\(r\), 1 klar\(e\) til pakking/);
    expect(r.ut).toMatch(/2 i samlekøen \(ko\.mjs samle\)/);
    expect(r.ut).not.toMatch(/^VA-1 +venter/m);
  });
});
