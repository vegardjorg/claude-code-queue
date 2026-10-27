// =============================================================
// koProsjektPlukk.test.ts: arbeidskøen (lib/koLogikk.js): prosjekt og funksjon (prefiks-regelen,
// pause og prioritetstillegg per prosjekt), plukking (plukk/lever/slipp/plukkbare, status plukket som eier filer
// men ikke tar agentplass), visuell QA (sett ferdig → qa venter, qa ok, qa avvik → <id>-QA<n>) og endre-mange
// (alt eller ingenting). Kommandoene er beskrevet i docs/queue.md; de eldre reglene står i koLogikk.test.ts.
// =============================================================
import { describe, it, expect } from 'vitest';

type Prosjekt = {
  tittel?: string;
  plan?: string;
  prefikser?: string[];
  pause?: boolean;
  prioritet_tillegg?: number;
};
type Register = Record<string, Prosjekt>;
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
  eier_db?: string[];
  delt_patch?: string[];
  lagt_til?: string;
  lagt_til_av?: string;
  prioritet_tillegg?: number;
  migr_tiere?: number;
  migr_blokk?: string | null;
  gren?: string;
  prosjekt?: string;
  funksjon?: string;
  etiketter?: string[];
  plukket_av?: string;
  plukket_at?: string;
  qa_status?: string;
  qa_notat?: string;
  qa_original?: string;
  merknader?: string[];
  levert?: string;
  ferdig?: string;
};
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  grenser?: { maksSamtidig?: number; maksDPluss?: number; maksPerDomene?: number; maksDb?: number };
  prosjekter?: Register;
  neste_migr?: number;
};
type Valgt = { id: string; score: number; anslag: number; prosjekt: string };
type Gruppe = {
  pid: string;
  tittel: string | null;
  pause: boolean;
  funksjoner: { funksjon: string; oppgaver: Oppgave[] }[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../koLogikk') as {
  UTEN_PROSJEKT: string;
  UTEN_FUNKSJON: string;
  valider: (o: unknown, eks?: Oppgave[], register?: Register) => string[];
  hindringer: (o: Oppgave, alle: Oppgave[], avklart?: string[]) => string[];
  score: (o: Oppgave, alle: Oppgave[], naa?: number, register?: Register) => number;
  velgNeste: (ko: Ko, naa?: number) => Valgt[];
  tilstand: (ko: Ko) => { aktive: number; plukket: number; qa: number; tom: boolean };
  prosjektFor: (o: Partial<Oppgave>, register?: Register) => string;
  grupper: (oppgaver: Oppgave[], register?: Register) => Gruppe[];
  prosjektOversikt: (ko: Ko) => {
    pid: string;
    totalt: number;
    ferdig: number;
    min_igjen: number;
    aktive: number;
    plukket: number;
    pause: boolean;
    eiersporsmal: { sp: string; oppgaver: number }[];
  }[];
  nyttRegister: (
    register: Register | undefined,
    endringer: unknown,
  ) => { register: Register; feil: string[] };
  endreMange: (
    ko: Ko,
    inn: unknown,
  ) => { feil: string[]; endret?: string[]; prosjekter?: string[] };
  plukkbare: (
    ko: Ko,
    filter?: { etikett?: string; prosjekt?: string; maksMin?: number },
    naa?: number,
  ) => { id: string; prosjekt: string; pauset: boolean }[];
  plukk: (
    ko: Ko,
    id: string,
    opt?: { av?: string; tving?: boolean; naa?: string },
  ) => { feil?: string; hindringer?: string[]; oppgave?: Oppgave; overstyrt?: string[] };
  lever: (ko: Ko, id: string, naa?: string) => { feil?: string; oppgave?: Oppgave };
  slipp: (
    ko: Ko,
    id: string,
    opt?: { commits?: number; naa?: string },
  ) => { feil?: string; oppgave?: Oppgave; av?: string; advarsel?: string | null };
  erGammelPlukk: (
    o: Oppgave,
    git?: { commits?: number; sisteCommit?: string | null },
    naa?: number,
  ) => boolean;
  settStatus: (o: Oppgave, status: string, naa?: string) => { feil?: string; qa?: boolean };
  qaListe: (ko: Ko) => Gruppe[];
  qaOk: (ko: Ko, ider: string[], naa?: string) => { ok: string[]; feil: string[] };
  qaAvvik: (
    ko: Ko,
    id: string,
    tekst: string,
    naa?: string,
  ) => { feil?: string; oppgave?: Oppgave; retting?: Oppgave };
};

const NAA = Date.parse('2026-09-30T12:00:00Z');
const ISO = '2026-09-30T12:00:00.000Z';
const o = (id: string, ekstra: Partial<Oppgave> = {}): Oppgave => ({
  id,
  domene: 'ui',
  klasse: 'K',
  status: 'venter',
  oppdrag: 'x',
  tittel: id,
  ...ekstra,
});
const ider = (ko: Ko) => K.velgNeste(ko, NAA).map((v) => v.id);
const klone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('prosjekt for en oppgave', () => {
  const register: Register = {
    'alfa': { tittel: 'Alfa', prefikser: ['A-', 'AJ-'] },
    lager: { tittel: 'Lager', prefikser: ['SB-'] },
    // Overlapper med lager: det første prosjektet i registeret vinner.
    katalog: { tittel: 'Katalog', prefikser: ['SB-', 'K-'] },
  };

  it('følger prefiks-regelen fra registeret, og det første prosjektet vinner', () => {
    expect(K.prosjektFor(o('A-T1a'), register)).toBe('alfa');
    expect(K.prosjektFor(o('AJ-1a'), register)).toBe('alfa');
    expect(K.prosjektFor(o('SB-P5d'), register)).toBe('lager');
    expect(K.prosjektFor(o('K-1a1'), register)).toBe('katalog');
  });

  it('eksplisitt prosjekt vinner over prefikset', () => {
    expect(K.prosjektFor(o('A-T1a', { prosjekt: 'lager' }), register)).toBe(
      'lager',
    );
  });

  it('uten treff (og uten register) er det uten-prosjekt; prefikset må stå først i id-en', () => {
    expect(K.prosjektFor(o('G-I4K'), register)).toBe(K.UTEN_PROSJEKT);
    expect(K.prosjektFor(o('XA-1'), register)).toBe(K.UTEN_PROSJEKT);
    expect(K.prosjektFor(o('A-T1a'))).toBe(K.UTEN_PROSJEKT);
    expect(K.UTEN_PROSJEKT).toBe('uten-prosjekt');
  });

  it('grupperer prosjekt → funksjon i registerets rekkefølge, uten-prosjekt og uten funksjon sist', () => {
    const g = K.grupper(
      [
        o('G-1'),
        o('SB-2', { funksjon: 'Ingredienser' }),
        o('A-1', { funksjon: 'Oversikt' }),
        o('A-2'),
        o('A-3', { funksjon: 'Oversikt' }),
      ],
      register,
    );
    expect(g.map((p) => p.pid)).toEqual(['alfa', 'lager', K.UTEN_PROSJEKT]);
    expect(g[0].funksjoner.map((f) => f.funksjon)).toEqual(['Oversikt', K.UTEN_FUNKSJON]);
    expect(g[0].funksjoner[0].oppgaver.map((x) => x.id)).toEqual(['A-1', 'A-3']);
  });
});

describe('pause og prioritetstillegg per prosjekt i neste', () => {
  it('pause holder et prosjekt ute av neste, uten å stoppe resten', () => {
    const ko: Ko = {
      prosjekter: { gamma: { tittel: 'Gamma', prefikser: ['G-'], pause: true } },
      oppgaver: [o('G-1', { nytte: 10, domene: 'gamma' }), o('A-1', { nytte: 2 })],
    };
    expect(ider(ko)).toEqual(['A-1']);
    // Fortsetter prosjektet, kommer oppgaven tilbake (og høyest, med nytte 10).
    ko.prosjekter!.gamma.pause = false;
    expect(ider(ko)).toEqual(['G-1', 'A-1']);
  });

  it('prosjektets prioritet_tillegg legges til oppgavens prioritet', () => {
    const ko: Ko = {
      grenser: { maksSamtidig: 1 },
      prosjekter: { delta: { tittel: 'Delta', prefikser: ['D-'], prioritet_tillegg: 100 } },
      oppgaver: [o('A', { nytte: 9 }), o('D-1', { nytte: 3 })],
    };
    expect(ider(ko)).toEqual(['D-1']);
    const utenTillegg = K.score(ko.oppgaver[1], ko.oppgaver, NAA);
    expect(K.score(ko.oppgaver[1], ko.oppgaver, NAA, ko.prosjekter)).toBe(utenTillegg + 100);
    expect(K.velgNeste(ko, NAA)[0].prosjekt).toBe('delta');
  });
});

describe('status plukket', () => {
  it('blokkerer en kolliderende oppgave, men teller ikke mot maksSamtidig eller maksDPluss', () => {
    const ko: Ko = {
      grenser: { maksSamtidig: 1, maksDPluss: 1 },
      oppgaver: [
        o('P', {
          status: 'plukket',
          plukket_av: 'Kari',
          klasse: 'D+',
          eier_filer: ['app/x.tsx'],
        }),
        o('KOLL', { nytte: 10, eier_filer: ['app/x.tsx'] }),
        o('FRI', { nytte: 1, klasse: 'D+' }),
      ],
    };
    expect(K.hindringer(ko.oppgaver[1], ko.oppgaver)).toEqual(['fil app/x.tsx eies av P']);
    // Plassen (maksSamtidig 1) og D+-taket (1) er ledige, fordi P er plukket, ikke en køagent.
    expect(ider(ko)).toEqual(['FRI']);
  });

  it('en levert plukket oppgave (review) tar heller ingen agentplass, men holder eierskapet', () => {
    const ko: Ko = {
      grenser: { maksSamtidig: 1 },
      oppgaver: [
        o('P', { status: 'review', plukket_av: 'økt-2', eier_filer: ['a.ts'] }),
        o('KOLL', { eier_filer: ['a.ts'] }),
        o('FRI'),
      ],
    };
    expect(ider(ko)).toEqual(['FRI']);
    // En vanlig review (køagent) tar plassen.
    delete ko.oppgaver[0].plukket_av;
    expect(ider(ko)).toEqual([]);
  });

  it('tilstand: plukkede holder ikke løkka i gang, men telles for seg', () => {
    const t = K.tilstand({ oppgaver: [o('P', { status: 'plukket', plukket_av: 'x' })] });
    expect(t.aktive).toBe(0);
    expect(t.plukket).toBe(1);
    expect(t.tom).toBe(true);
  });
});

describe('plukk, lever og slipp', () => {
  const basis = (): Ko => ({
    neste_migr: 3450,
    avklart: [],
    oppgaver: [
      o('FERDIG', { status: 'ferdig' }),
      o('AAPEN', { status: 'venter' }),
      o('KJ', { status: 'kjorer', eier_filer: ['app/felles.tsx'] }),
      o('DEP', { avhenger: ['AAPEN'] }),
      o('SP', { venter_paa: ['EIER-1'] }),
      o('KOLL', { eier_filer: ['app/felles.tsx'] }),
      o('MIGR', { migr_tiere: 2, avhenger: ['FERDIG'] }),
      o('FORSLAG', { status: 'forslag' }),
    ],
  });

  it('nekter ved åpen avhengighet, eierspørsmål og eierkollisjon', () => {
    const ko = basis();
    for (const [id, grunn] of [
      ['DEP', 'venter på AAPEN'],
      ['SP', 'venter på svar: EIER-1'],
      ['KOLL', 'fil app/felles.tsx eies av KJ'],
    ]) {
      const r = K.plukk(ko, id, { av: 'Kari', naa: ISO });
      expect(r.feil).toContain(grunn);
      expect(ko.oppgaver.find((x) => x.id === id)!.status).toBe('venter');
    }
  });

  it('--tving overstyrer hindringene (med merknad), men aldri statusen', () => {
    const ko = basis();
    const r = K.plukk(ko, 'KOLL', { av: 'Kari', tving: true, naa: ISO });
    expect(r.feil).toBeUndefined();
    expect(r.overstyrt).toEqual(['fil app/felles.tsx eies av KJ']);
    expect(r.oppgave!.status).toBe('plukket');
    expect(r.oppgave!.merknader![0]).toContain('--tving');
    expect(K.plukk(ko, 'FORSLAG', { av: 'Kari', tving: true }).feil).toContain('forslag');
    expect(K.plukk(ko, 'KJ', { av: 'Kari', tving: true }).feil).toContain('status kjorer');
    expect(K.plukk(ko, 'KOLL', { av: 'Annen', tving: true }).feil).toContain(
      'allerede plukket av Kari',
    );
  });

  // Prosjektet har migrasjonsflyt (konfig().migrasjoner.mappe satt); uten den får ingen oppgave blokk.
  const MIGR_PAA = { mappe: 'db/migrasjoner', blokkStorrelse: 10 };

  it('krever --av, og tildeler gren og migrasjonsblokk som start', () => {
    const ko = basis();
    expect(K.plukk(ko, 'MIGR', { av: '  ' }).feil).toContain('--av');
    const r = K.plukk(ko, 'MIGR', { av: 'økt-7', naa: ISO, migrasjoner: MIGR_PAA });
    expect(r.oppgave).toMatchObject({
      status: 'plukket',
      plukket_av: 'økt-7',
      plukket_at: ISO,
      gren: 'ko/MIGR',
      migr_blokk: '3450–3469',
    });
    expect(ko.neste_migr).toBe(3470);
    // Uten migrasjoner: ingen blokk, og neste_migr står.
    const r2 = K.plukk(ko, 'AAPEN', { av: 'økt-7', naa: ISO });
    expect(r2.oppgave!.migr_blokk).toBeNull();
    expect(ko.neste_migr).toBe(3470);
    // Uten migrasjonsflyt i prosjektet: ingen blokk selv med migr_tiere, og neste_migr står.
    const ko0 = basis();
    const r0 = K.plukk(ko0, 'MIGR', { av: 'økt-7', naa: ISO, migrasjoner: { mappe: null } });
    expect(r0.oppgave!.migr_blokk).toBeNull();
    expect(ko0.neste_migr).toBe(3450);
  });

  it('lever: plukket → review (plukket_av blir stående); lever på noe annet nektes', () => {
    const ko = basis();
    K.plukk(ko, 'AAPEN', { av: 'Kari', naa: ISO });
    const r = K.lever(ko, 'AAPEN', ISO);
    expect(r.oppgave).toMatchObject({ status: 'review', levert: ISO, plukket_av: 'Kari' });
    expect(K.lever(ko, 'AAPEN').feil).toContain('ikke plukket');
    expect(K.lever(ko, 'FINNESIKKE').feil).toContain('ukjent');
  });

  it('slipp: plukket → venter, fjerner plukk-feltene, beholder gren og blokk, og advarer ved commits', () => {
    const ko = basis();
    K.plukk(ko, 'MIGR', { av: 'Kari', naa: ISO, migrasjoner: MIGR_PAA });
    const uten = K.slipp(klone(ko), 'MIGR', { commits: 0, naa: ISO });
    expect(uten.advarsel).toBeNull();
    expect(uten.oppgave!.merknader).toBeUndefined();

    const r = K.slipp(ko, 'MIGR', { commits: 3, naa: ISO });
    expect(r.av).toBe('Kari');
    expect(r.oppgave!.status).toBe('venter');
    expect(r.oppgave!.plukket_av).toBeUndefined();
    expect(r.oppgave!.plukket_at).toBeUndefined();
    expect(r.oppgave!.gren).toBe('ko/MIGR');
    expect(r.advarsel).toContain('3 commit(s)');
    expect(r.advarsel).toContain('beholdes');
    const merknader = r.oppgave!.merknader!;
    expect(merknader[merknader.length - 1]).toContain('sluppet av Kari');
    // Plukkes den igjen, gjenbrukes blokken (numrene på den beholdte grenen er fortsatt dens egne).
    const igjen = K.plukk(ko, 'MIGR', { av: 'Annen', naa: ISO, migrasjoner: MIGR_PAA });
    expect(igjen.oppgave!.migr_blokk).toBe('3450–3469');
    expect(ko.neste_migr).toBe(3470);
    expect(K.slipp(ko, 'AAPEN').feil).toContain('ikke plukket');
  });

  it('plukkbare: bare det som kan plukkes nå, filtrert og sortert; pause stopper ikke plukking', () => {
    const ko: Ko = {
      prosjekter: { gamma: { tittel: 'Gamma', prefikser: ['G-'], pause: true } },
      oppgaver: [
        o('KJ', { status: 'kjorer', eier_filer: ['a.ts'] }),
        o('KOLL', { eier_filer: ['a.ts'] }),
        o('VIS', { etiketter: ['visuell'], nytte: 9 }),
        o('LANG', { innhold_min: 120 }),
        o('G-1', { nytte: 2 }),
      ],
    };
    const alle = K.plukkbare(ko, {}, NAA);
    expect(alle.map((p) => p.id)).toEqual(['VIS', 'G-1', 'LANG']);
    expect(alle.find((p) => p.id === 'G-1')!.pauset).toBe(true);
    expect(K.plukkbare(ko, { etikett: 'visuell' }, NAA).map((p) => p.id)).toEqual(['VIS']);
    expect(K.plukkbare(ko, { prosjekt: 'gamma' }, NAA).map((p) => p.id)).toEqual(['G-1']);
    expect(K.plukkbare(ko, { maksMin: 60 }, NAA).map((p) => p.id)).toEqual(['VIS', 'G-1']);
  });

  it('«gammel»: plukket over 72 t uten commits de siste 72 t', () => {
    const plukket = o('P', {
      status: 'plukket',
      plukket_av: 'x',
      plukket_at: '2026-09-26T12:00:00Z',
    });
    expect(K.erGammelPlukk(plukket, { commits: 0 }, NAA)).toBe(true);
    expect(K.erGammelPlukk(plukket, { commits: 2, sisteCommit: '2026-09-30T08:00:00Z' }, NAA)).toBe(
      false,
    );
    expect(K.erGammelPlukk(plukket, { commits: 2, sisteCommit: '2026-09-26T13:00:00Z' }, NAA)).toBe(
      true,
    );
    const fersk = { ...plukket, plukket_at: '2026-09-29T12:00:00Z' };
    expect(K.erGammelPlukk(fersk, { commits: 0 }, NAA)).toBe(false);
    expect(K.erGammelPlukk({ ...plukket, status: 'venter' }, { commits: 0 }, NAA)).toBe(false);
  });
});

describe('visuell QA', () => {
  const basis = (): Ko => ({
    prosjekter: { 'alfa': { tittel: 'Alfa', prefikser: ['A-'] } },
    oppgaver: [
      o('A-1', {
        status: 'review',
        etiketter: ['visuell'],
        funksjon: 'Oversikt',
        tittel: 'Kortet viser feil per kort',
        oppdrag: 'scripts/.ko/oppdrag/A-1.md',
        eier_filer: ['components/ui/Kort.tsx'],
        nytte: 8,
      }),
      o('A-2', { status: 'review' }),
    ],
  });

  it('sett ferdig på en visuell oppgave gir qa_status venter; ellers ingen QA', () => {
    const ko = basis();
    const r = K.settStatus(ko.oppgaver[0], 'ferdig', ISO);
    expect(r.qa).toBe(true);
    expect(ko.oppgaver[0]).toMatchObject({ status: 'ferdig', ferdig: ISO, qa_status: 'venter' });
    expect(K.settStatus(ko.oppgaver[1], 'ferdig', ISO).qa).toBe(false);
    expect(ko.oppgaver[1].qa_status).toBeUndefined();
    // QA-lista: prosjekt → funksjon → oppgave, og tilstand teller den.
    const liste = K.qaListe(ko);
    expect(liste).toHaveLength(1);
    expect(liste[0].pid).toBe('alfa');
    expect(liste[0].funksjoner[0].funksjon).toBe('Oversikt');
    expect(liste[0].funksjoner[0].oppgaver.map((x) => x.id)).toEqual(['A-1']);
    expect(K.tilstand(ko).qa).toBe(1);
  });

  it('sett plukket nektes (bruk plukk), og settes en plukket oppgave til venter, fjernes plukk-feltene', () => {
    const p = o('P', { status: 'plukket', plukket_av: 'x', plukket_at: ISO });
    expect(K.settStatus(p, 'plukket').feil).toContain('plukk');
    expect(K.settStatus(p, 'tull').feil).toContain('ukjent status');
    K.settStatus(p, 'venter', ISO);
    expect(p.status).toBe('venter');
    expect(p.plukket_av).toBeUndefined();
  });

  it('qa avvik lager <id>-QA1 og så -QA2, med samme prosjekt og funksjon', () => {
    const ko = basis();
    K.settStatus(ko.oppgaver[0], 'ferdig', ISO);
    const r1 = K.qaAvvik(ko, 'A-1', 'Knappen er under 44 px på mobil', ISO);
    expect(r1.feil).toBeUndefined();
    expect(ko.oppgaver[0]).toMatchObject({
      qa_status: 'avvik',
      qa_notat: 'Knappen er under 44 px på mobil',
    });
    expect(r1.retting).toMatchObject({
      id: 'A-1-QA1',
      klasse: 'K',
      domene: 'ui',
      prosjekt: 'alfa',
      funksjon: 'Oversikt',
      etiketter: ['visuell'],
      lagt_til_av: 'eier',
      status: 'venter',
      qa_original: 'A-1',
      eier_filer: ['components/ui/Kort.tsx'],
      nytte: 8,
    });
    expect(r1.retting!.oppdrag).toContain('Knappen er under 44 px på mobil');
    expect(r1.retting!.oppdrag).toContain('A-1');
    expect(r1.retting!.oppdrag).toContain('scripts/.ko/oppdrag/A-1.md');

    const r2 = K.qaAvvik(ko, 'A-1', 'Fortsatt feil farge i mørk modus', ISO);
    expect(r2.retting!.id).toBe('A-1-QA2');

    // Avvik på en rettingsoppgave nummererer videre fra originalen.
    const qa1 = ko.oppgaver.find((x) => x.id === 'A-1-QA1')!;
    K.settStatus(qa1, 'ferdig', ISO);
    expect(qa1.qa_status).toBe('venter');
    expect(K.qaAvvik(ko, 'A-1-QA1', 'Nesten, men teksten kuttes', ISO).retting!.id).toBe(
      'A-1-QA3',
    );

    expect(K.qaAvvik(ko, 'A-2', '', ISO).feil).toBeDefined();
    expect(K.qaAvvik(ko, 'A-1-QA2', 'x', ISO).feil).toContain('ikke ferdig');
  });

  it('qa ok er alt eller ingenting, og godtar venter og avvik', () => {
    const ko = basis();
    K.settStatus(ko.oppgaver[0], 'ferdig', ISO);
    const feil = K.qaOk(ko, ['A-1', 'A-2'], ISO);
    expect(feil.ok).toEqual([]);
    expect(feil.feil[0]).toContain('A-2');
    expect(ko.oppgaver[0].qa_status).toBe('venter');
    expect(K.qaOk(ko, ['A-1'], ISO).ok).toEqual(['A-1']);
    expect(ko.oppgaver[0].qa_status).toBe('ok');
    expect(K.qaListe(ko)).toEqual([]);
  });
});

describe('endre-mange og registeret', () => {
  const basis = (): Ko => ({
    prosjekter: { gamma: { tittel: 'Gamma', prefikser: ['G-'] } },
    oppgaver: [o('A'), o('B'), o('G-1')],
  });

  it('er alt eller ingenting: én feil, og ingenting endres (heller ikke registeret)', () => {
    const ko = basis();
    const for_ = klone(ko);
    const r = K.endreMange(ko, {
      prosjekter: { delta: { tittel: 'Delta', prefikser: ['D-'] } },
      oppgaver: [
        { id: 'A', prosjekt: 'delta', funksjon: 'Oppgradering' },
        { id: 'B', prosjekt: 'finnes-ikke' },
        { id: 'UKJENT', funksjon: 'x' },
        { id: 'G-1', status: 'ferdig' },
      ],
    });
    expect(r.feil.length).toBe(3);
    expect(r.feil.join('\n')).toContain('ukjent prosjekt finnes-ikke');
    expect(r.feil.join('\n')).toContain('UKJENT: ukjent oppgave');
    expect(r.feil.join('\n')).toContain('ukjente felt status');
    expect(ko).toEqual(for_);
  });

  it('anvender alt når alt er gyldig; null fjerner et felt', () => {
    const ko = basis();
    ko.oppgaver[2].funksjon = 'Import';
    const r = K.endreMange(ko, {
      prosjekter: { delta: { tittel: 'Delta', prefikser: ['D-'], prioritet_tillegg: 20 } },
      oppgaver: [
        { id: 'A', prosjekt: 'delta', funksjon: 'Oppgradering', etiketter: ['visuell'] },
        { id: 'G-1', funksjon: null },
      ],
    });
    expect(r.feil).toEqual([]);
    expect(r.endret).toEqual(['A', 'G-1']);
    expect(r.prosjekter).toEqual(['delta']);
    expect(ko.prosjekter!.delta.prioritet_tillegg).toBe(20);
    expect(ko.oppgaver[0]).toMatchObject({
      prosjekt: 'delta',
      funksjon: 'Oppgradering',
      etiketter: ['visuell'],
    });
    expect(ko.oppgaver[2].funksjon).toBeUndefined();
    // En ren liste (uten prosjekter) virker også.
    expect(K.endreMange(ko, [{ id: 'B', prosjekt: 'gamma' }]).feil).toEqual([]);
    expect(ko.oppgaver[1].prosjekt).toBe('gamma');
  });

  it('registeret: nytt prosjekt krever tittel, id-en er kebab-case, feltene har riktig type', () => {
    expect(K.nyttRegister({}, { gamma: { prefikser: ['G-'] } }).feil[0]).toContain(
      'tittel mangler',
    );
    expect(K.nyttRegister({}, { Gamma: { tittel: 'x' } }).feil[0]).toContain('kebab-case');
    expect(K.nyttRegister({}, { 'uten-prosjekt': { tittel: 'x' } }).feil[0]).toContain(
      'kebab-case',
    );
    const typer = K.nyttRegister(
      {},
      {
        a: {
          tittel: 'A',
          pause: 'ja',
          prioritet_tillegg: 'mye',
          prefikser: ['TF -'],
          farge: 'rød',
        },
      },
    ).feil.join('\n');
    for (const del of ['pause', 'prioritet_tillegg', 'prefikser', 'ukjente felt farge'])
      expect(typer).toContain(del);
    // Endring av et eksisterende prosjekt beholder resten; null fjerner (pause av).
    const r = K.nyttRegister({ gamma: { tittel: 'Gamma', pause: true } }, { gamma: { pause: null } });
    expect(r.feil).toEqual([]);
    expect(r.register.gamma).toEqual({ tittel: 'Gamma' });
  });

  it('prosjektoversikt: ferdig/totalt, minutter igjen, aktive, plukkede og blokkerende eierspørsmål', () => {
    const ko: Ko = {
      prosjekter: { gamma: { tittel: 'Gamma', prefikser: ['G-'], pause: true } },
      avklart: ['EIER-2'],
      oppgaver: [
        o('G-1', { status: 'ferdig' }),
        o('G-2', { status: 'kjorer', innhold_min: 20 }),
        o('G-3', { status: 'plukket', plukket_av: 'x', innhold_min: 10 }),
        o('G-4', { venter_paa: ['EIER-1', 'EIER-2'], innhold_min: 30 }),
        o('G-5', { venter_paa: ['EIER-1'], innhold_min: 30 }),
        o('G-6', { status: 'kansellert' }),
        o('ANNET'),
      ],
    };
    const [gamma, uten] = K.prosjektOversikt(ko);
    expect(gamma).toMatchObject({
      pid: 'gamma',
      totalt: 5,
      ferdig: 1,
      min_igjen: 90,
      aktive: 1,
      plukket: 1,
      pause: true,
      eiersporsmal: [{ sp: 'EIER-1', oppgaver: 2 }],
    });
    expect(uten.pid).toBe(K.UTEN_PROSJEKT);
  });
});

describe('bakoverkompatibel: gammel ko.json uten nye felt', () => {
  const gammel = (): Ko => ({
    grenser: { maksSamtidig: 2 },
    avklart: [],
    oppgaver: [
      o('A', { nytte: 9 }),
      o('B', { nytte: 5, eier_filer: ['x.ts'] }),
      o('C', { status: 'kjorer', eier_filer: ['x.ts'] }),
      o('D', { nytte: 3 }),
    ],
  });

  it('neste, prioritet, validering og tilstand er som før', () => {
    const ko = gammel();
    expect(ider(ko)).toEqual(['A']);
    const s = K.score(ko.oppgaver[0], ko.oppgaver, NAA);
    expect(K.score(ko.oppgaver[0], ko.oppgaver, NAA, ko.prosjekter)).toBe(s);
    expect(K.valider(o('NY'), ko.oppgaver)).toEqual([]);
    // Uten register valideres ikke prosjektnavnet mot registeret (det finnes ikke ennå).
    expect(K.valider(o('NY', { prosjekt: 'gamma' }), ko.oppgaver, ko.prosjekter)).toEqual([]);
    expect(
      K.valider(o('NY', { etiketter: 'visuell' as unknown as string[] }), ko.oppgaver)[0],
    ).toContain('etiketter');
    const t = K.tilstand(ko);
    expect(t).toMatchObject({ aktive: 1, plukket: 0, qa: 0, tom: false });
    expect(K.prosjektOversikt(ko).map((r) => r.pid)).toEqual([K.UTEN_PROSJEKT]);
  });

  it('med et register må et eksplisitt prosjekt finnes i det', () => {
    const reg: Register = { gamma: { tittel: 'Gamma' } };
    expect(K.valider(o('NY', { prosjekt: 'gamma' }), [], reg)).toEqual([]);
    expect(K.valider(o('NY', { prosjekt: 'lnon' }), [], reg)[0]).toContain('ukjent prosjekt lnon');
  });
});
