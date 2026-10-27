// =============================================================
// koTavlePlan.test.ts: kø-tavla: fokus fra planvisningen (koLogikk.lagreFokusPlan, alt eller ingenting),
// poengene i «Plassering» (scoreDeler = score), kortenes plass og sortering med fokus (koTavle.tavle), «Venter på deg»
// sortert etter det svaret låser opp i fokus, «Sorter»-lista og massehandlingen godta-forslag, forhåndsvisningen av
// «Lagre fokus» og områdene fra tavla (omradePlan), og ko.mjs fokus lagre / omrade med --forvent-endret mot en kopi i
// en midlertidig mappe (aldri den ekte køen).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
  lagt_til?: string;
  prioritet_tillegg?: number;
};
type Prosjekt = {
  tittel: string;
  prefikser?: string[];
  pause?: boolean;
  omrade?: string;
  filrot?: string[];
  prioritet_tillegg?: number;
};
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  prosjekter?: Record<string, Prosjekt>;
  omrader?: Record<string, { tittel: string; beskrivelse?: string | null }>;
  sporsmal?: Record<string, { tekst: string }>;
  fokus?: Record<string, unknown>;
  endret?: string;
  neste_migr?: number;
};
type Plass = {
  steg: number | null;
  utenfor: boolean;
  ut: boolean;
  grunn: string | null;
  nr?: number;
  av?: number;
};
type Kort = { id: string; klar: boolean; omrade: string; plass: Plass | null };
type Sporsmal = {
  sp: string;
  antall: number;
  fokus: { antall: number; minutter: number; per_trinn: number[] } | null;
};
type LagreSvar = {
  feil: string[];
  advarsler: string[];
  fokus?: Record<string, unknown> | null;
  fjernet?: boolean;
  pauset?: string[];
  fortsatt?: string[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk') as {
  FOKUS_PLAN_MAKS: number;
  lagreFokusPlan: (ko: Ko, inn: Record<string, unknown>, naa?: string) => LagreSvar;
  scoreDeler: (
    o: Oppgave,
    oppgaver: Oppgave[],
    naa: number,
    register: Record<string, Prosjekt>,
  ) => { score: number; nytte: number; minutter: number; laaser_opp: number };
  score: (
    o: Oppgave,
    oppgaver: Oppgave[],
    naa: number,
    register: Record<string, Prosjekt>,
  ) => number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../koTavle') as {
  tavle: (
    ko: Ko,
    valg?: { naa?: number },
  ) => {
    kolonner: Record<string, Kort[]>;
    fokus: { aktiv: boolean; naa_antall: number; trinn: { tittel: string }[] } | null;
    omrader: { oid: string; tittel: string; prosjekter: string[] }[];
    innboks: {
      antall: number;
      fokus_sortert: boolean;
      sporsmal: Sporsmal[];
      sorter: { id: string; type: string; forslag: string | null }[];
    };
  };
  sorterListe: (ko: Ko) => { id: string; type: string; forslag: string | null }[];
  massePlan: (
    ko: Ko,
    handling: string,
    ider: string[],
  ) => { feil: string[]; kommando?: string; innhold?: { oppgaver: Record<string, unknown>[] } };
  fokusForhandsvisning: (
    ko: Ko,
    inn: Record<string, unknown>,
    valg?: { naa?: number },
  ) => {
    feil: string[];
    linjer: string[];
    for_tekst: string;
    etter_tekst: string;
    neste: { id: string }[];
  };
  OMRADE_HANDLINGER: string[];
  omradePlan: (
    ko: Ko,
    b: Record<string, unknown>,
  ) => { feil: string[]; args?: string[]; linjer?: string[] };
};

const NAA = Date.parse('2026-10-07T12:00:00Z');
const ISO = '2026-10-07T12:00:00.000Z';
const o = (id: string, ekstra: Partial<Oppgave> = {}): Oppgave => ({
  id,
  domene: id.toLowerCase(),
  klasse: 'K',
  status: 'venter',
  oppdrag: `Oppdraget til ${id}.`,
  tittel: id,
  nytte: 5,
  innhold_min: 30,
  ...ekstra,
});
/**
 * Varer (område Kjerne) og Kalender (uten område), et pauset prosjekt, to eierspørsmål og to oppgaver uten prosjekt
 * (X-1 har filer under Vakts filrot, altså et forslag; X-2 har ingenting).
 */
const grunnKo = (): Ko => ({
  oppgaver: [
    o('SB-1', { nytte: 8 }),
    o('SB-2', { avhenger: ['SB-1'] }),
    o('SB-3', { venter_paa: ['Ø-2'] }),
    o('SB-4', { avhenger: ['SB-3'] }),
    o('V-1', { lagt_til: '2026-10-01T00:00:00.000Z', prioritet_tillegg: 2 }),
    o('V-2', { venter_paa: ['Ø-1'] }),
    o('P-1'),
    o('X-1', { eier_filer: ['app/ui/liste.tsx'] }),
    o('X-2'),
  ],
  prosjekter: {
    varer: { tittel: 'Varer', prefikser: ['SB-'], omrade: 'kjerne' },
    ui: { tittel: 'Kalender', prefikser: ['V-'], filrot: ['app/ui/'], prioritet_tillegg: 1 },
    pauset: { tittel: 'Pauset', prefikser: ['P-'], pause: true },
  },
  omrader: { kjerne: { tittel: 'Kjerne' } },
  sporsmal: { 'Ø-1': { tekst: 'Spørsmål om ui' }, 'Ø-2': { tekst: 'Spørsmål om varer' } },
  avklart: [],
  endret: ISO,
});

describe('lagreFokusPlan: fokus og pause fra planvisningen i én endring', () => {
  it('setter fokus, pauser og fortsetter i samme endring', () => {
    const ko = grunnKo();
    const r = L.lagreFokusPlan(
      ko,
      {
        rekkefolge: ['prosjekt:ui', 'omrade:kjerne'],
        naa_antall: 1,
        pause: [],
        fortsett: ['pauset'],
      },
      ISO,
    );
    expect(r.feil).toEqual([]);
    expect(r.fortsatt).toEqual(['pauset']);
    expect(ko.fokus).toMatchObject({
      rekkefolge: ['prosjekt:ui', 'omrade:kjerne'],
      naa_antall: 1,
    });
    expect(ko.prosjekter?.pauset.pause).toBeUndefined();
  });

  it('alt eller ingenting: én feil, og køen er urørt', () => {
    const ko = grunnKo();
    const for_ = JSON.stringify(ko);
    expect(
      L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:ui'], pause: ['finnes-ikke'] }).feil[0],
    ).toMatch(/ukjent prosjekt finnes-ikke/);
    expect(
      L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:ui'], pause: ['ui'], fortsett: ['ui'] })
        .feil[0],
    ).toMatch(/både i pause og fortsett/);
    expect(
      L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:finnes-ikke'], pause: ['varer'] }).feil.length,
    ).toBeGreaterThan(0);
    expect(L.lagreFokusPlan(ko, { rekkefolge: 'prosjekt:ui' }).feil[0]).toMatch(
      /må være en liste/,
    );
    expect(JSON.stringify(ko)).toBe(for_);
  });

  it('naa_antall må ligge mellom 1 og antall trinn', () => {
    const ko = grunnKo();
    expect(L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:ui'], naa_antall: 2 }).feil[0]).toMatch(
      /naa_antall/,
    );
    expect(L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:ui'], naa_antall: 0 }).feil[0]).toMatch(
      /naa_antall/,
    );
    expect(L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:ui'], naa_antall: 1 }).feil).toEqual([]);
  });

  it('tom rekkefølge fjerner fokuset', () => {
    const ko = grunnKo();
    L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:ui'] }, ISO);
    const r = L.lagreFokusPlan(ko, { rekkefolge: [] }, ISO);
    expect(r).toMatchObject({ feil: [], fjernet: true, fokus: null });
    expect(ko.fokus).toBeUndefined();
  });

  it('for mange trinn nektes', () => {
    const ko = grunnKo();
    const mange = Array.from({ length: L.FOKUS_PLAN_MAKS + 1 }, (_, i) => `prosjekt:p${i}`);
    expect(L.lagreFokusPlan(ko, { rekkefolge: mange }).feil[0]).toMatch(/høyst/);
  });
});

describe('scoreDeler: poengene i «Plassering» er de samme som køen bruker', () => {
  it('score fra delene er lik score() for alle ventende', () => {
    const ko = grunnKo();
    const register = ko.prosjekter ?? {};
    for (const x of ko.oppgaver) {
      const d = L.scoreDeler(x, ko.oppgaver, NAA, register);
      expect(d.score).toBe(L.score(x, ko.oppgaver, NAA, register));
    }
    const sk1 = L.scoreDeler(ko.oppgaver[0], ko.oppgaver, NAA, register);
    expect(sk1).toMatchObject({ nytte: 8, minutter: 30, laaser_opp: 1 });
  });
});

describe('tavle(): plass, område og sortering med fokus', () => {
  it('uten fokus: ingen trinn, områdene fra registeret', () => {
    const t = T.tavle(grunnKo(), { naa: NAA });
    expect(t.fokus).toBeNull();
    const sk1 = t.kolonner.ko.find((k) => k.id === 'SB-1');
    expect(sk1?.plass?.steg).toBeNull();
    expect(sk1?.omrade).toBe('kjerne');
    expect(t.kolonner.ko.find((k) => k.id === 'V-1')?.omrade).toBe('uten-omrade');
    expect(t.omrader.find((x) => x.oid === 'kjerne')).toMatchObject({
      tittel: 'Kjerne',
      prosjekter: ['varer'],
    });
  });

  it('med fokus på Kalender (resten venter): Kalender først med nr/av, Varer utenfor med grunn', () => {
    const ko = grunnKo();
    L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:ui'] }, '2026-10-07T11:00:00.000Z');
    const t = T.tavle(ko, { naa: NAA });
    expect(t.fokus).toMatchObject({ aktiv: true, naa_antall: 1 });
    const ider = t.kolonner.ko.map((k) => k.id);
    const v1 = t.kolonner.ko.find((k) => k.id === 'V-1');
    const sk1 = t.kolonner.ko.find((k) => k.id === 'SB-1');
    expect(v1?.plass).toMatchObject({ steg: 0, utenfor: false, nr: 1, av: 1 });
    expect(v1?.klar).toBe(true);
    expect(sk1?.plass).toMatchObject({ steg: null, utenfor: true, ut: true });
    expect(sk1?.plass?.grunn).toMatch(/utenfor fokus/);
    expect(sk1?.klar).toBe(false);
    expect(ider.indexOf('V-1')).toBeLessThan(ider.indexOf('SB-1'));
  });
});

describe('«Venter på deg»: spørsmål sortert etter det svaret låser opp i fokus', () => {
  it('uten fokus: flest oppgaver først (Ø-2 låser opp to)', () => {
    const i = T.tavle(grunnKo(), { naa: NAA }).innboks;
    expect(i.fokus_sortert).toBe(false);
    expect(i.sporsmal.map((s) => s.sp)).toEqual(['Ø-2', 'Ø-1']);
    expect(i.sporsmal[0].fokus).toBeNull();
  });

  it('med fokus på Kalender: Ø-1 først, med minuttene per trinn', () => {
    const ko = grunnKo();
    L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:ui'] }, '2026-10-07T11:00:00.000Z');
    const i = T.tavle(ko, { naa: NAA }).innboks;
    expect(i.fokus_sortert).toBe(true);
    expect(i.sporsmal.map((s) => s.sp)).toEqual(['Ø-1', 'Ø-2']);
    expect(i.sporsmal[0].fokus).toEqual({ per_trinn: [30], antall: 1, minutter: 30 });
    expect(i.sporsmal[1].fokus?.antall).toBe(0);
  });
});

describe('«Sorter» og godta-forslag', () => {
  it('oppgaver uten prosjekt står i lista, med forslag der signalene peker ett sted', () => {
    const ko = grunnKo();
    const rader = T.sorterListe(ko);
    expect(rader.find((r) => r.id === 'X-1')).toMatchObject({ type: 'flytt', forslag: 'ui' });
    expect(rader.find((r) => r.id === 'X-2')).toMatchObject({ type: 'sorter', forslag: null });
    // Sorter er rydding: den telles ikke i antallet på «Venter på deg».
    const i = T.tavle(ko, { naa: NAA }).innboks;
    expect(i.sorter.map((r) => r.id)).toEqual(expect.arrayContaining(['X-1', 'X-2']));
    expect(i.antall).toBe(i.sporsmal.length);
  });

  it('godta-forslag blir endre-mange med det foreslåtte prosjektet, og nekter uten forslag', () => {
    const ko = grunnKo();
    expect(T.massePlan(ko, 'godta-forslag', ['X-1', 'X-2'])).toEqual({
      feil: [],
      kommando: 'endre-mange',
      innhold: { oppgaver: [{ id: 'X-1', prosjekt: 'ui' }] },
    });
    expect(T.massePlan(ko, 'godta-forslag', ['X-2']).feil[0]).toMatch(
      /ingen av de merkede har et forslag/,
    );
  });
});

describe('fokusForhandsvisning: «Lagre fokus» forklart før det lagres', () => {
  it('trinnene, resten, dra med og perioden, uten å endre køen', () => {
    const ko = grunnKo();
    const for_ = JSON.stringify(ko);
    const f = T.fokusForhandsvisning(
      ko,
      { rekkefolge: ['prosjekt:ui', 'omrade:kjerne'] },
      { naa: NAA },
    );
    expect(f.feil).toEqual([]);
    expect(f.for_tekst).toBe('ingen fokus');
    expect(f.linjer[0]).toMatch(/^Nå, trinn 1: Kalender/);
    expect(f.linjer[1]).toMatch(/^Neste, trinn 2: Kjerne/);
    expect(f.linjer.some((x) => /venter helt/.test(x))).toBe(true);
    expect(f.linjer.some((x) => /gjelder til du endrer det/.test(x))).toBe(true);
    expect(f.neste.map((n) => n.id)).toContain('V-1');
    expect(JSON.stringify(ko)).toBe(for_);
  });

  it('feil gir ingen linjer, og tom rekkefølge forklarer at fokuset fjernes', () => {
    const ko = grunnKo();
    expect(
      T.fokusForhandsvisning(ko, { rekkefolge: ['prosjekt:nei'] }, { naa: NAA }).feil.length,
    ).toBeGreaterThan(0);
    L.lagreFokusPlan(ko, { rekkefolge: ['prosjekt:ui'] }, '2026-10-07T11:00:00.000Z');
    const f = T.fokusForhandsvisning(ko, { rekkefolge: [] }, { naa: NAA });
    expect(f.linjer[0]).toMatch(/Fokuset fjernes/);
    expect(f.etter_tekst).toBe('ingen fokus');
  });
});

describe('omradePlan: områdene fra tavla', () => {
  it('lagre, slett og flytt blir ko.mjs omrade-argumenter med forklaring', () => {
    const ko = grunnKo();
    expect(T.OMRADE_HANDLINGER).toEqual(['lagre', 'slett', 'flytt']);
    expect(T.omradePlan(ko, { handling: 'lagre', oid: 'drift', tittel: 'Drift' })).toMatchObject({
      feil: [],
      args: ['omrade', 'drift', '--tittel', 'Drift'],
    });
    const flytt = T.omradePlan(ko, { handling: 'flytt', pid: 'ui', oid: 'kjerne' });
    expect(flytt.args).toEqual(['omrade', 'kjerne', '--prosjekter', 'ui']);
    expect(flytt.linjer?.[0]).toMatch(/fra uten område til kjerne/);
    expect(T.omradePlan(ko, { handling: 'flytt', pid: 'varer', oid: null }).args).toEqual([
      'omrade',
      'kjerne',
      '--fjern',
      'varer',
    ]);
    // Kjerne brukes av Varer: slett nektes.
    expect(T.omradePlan(ko, { handling: 'slett', oid: 'kjerne' }).feil.length).toBeGreaterThan(0);
    expect(T.omradePlan(ko, { handling: 'gjett' }).feil[0]).toMatch(/ukjent handling/);
    expect(T.omradePlan(ko, { handling: 'flytt', pid: 'varer', oid: 'kjerne' }).feil[0]).toMatch(
      /allerede/,
    );
  });
});

describe('ko.mjs: fokus lagre og omrade med --forvent-endret (mot en kopi)', () => {
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
  const plan = (inn: Record<string, unknown>): string => {
    const fil = join(mappe, 'plan.json');
    writeFileSync(fil, JSON.stringify(inn));
    return fil;
  };

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-tavle5b-'));
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({ ...grunnKo(), neste_migr: 1000 }, null, 2),
    );
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('fokus lagre --torr --json skriver ingenting; uten --torr lagres fokus og pause i én endring', () => {
    const for_ = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const fil = plan({ rekkefolge: ['prosjekt:ui'], fortsett: ['pauset'] });
    const t = kjor(['fokus', 'lagre', '--fil', fil, '--torr', '--json']);
    expect(t.kode).toBe(0);
    expect(JSON.parse(t.ut)).toMatchObject({
      ok: true,
      torr: true,
      endret: ISO,
      fortsatt: ['pauset'],
    });
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(for_);

    const r = kjor([
      'fokus',
      'lagre',
      '--fil',
      fil,
      '--json',
      '--forvent-endret',
      ISO,
      '--av',
      'tavla',
    ]);
    expect(r.kode).toBe(0);
    expect(JSON.parse(r.ut)).toMatchObject({ ok: true, torr: false, fortsatt: ['pauset'] });
    const ko = lesKo();
    expect(ko.fokus).toMatchObject({ rekkefolge: ['prosjekt:ui'], satt_av: 'tavla' });
    expect(ko.prosjekter?.pauset.pause).toBeUndefined();
  });

  it('fokus lagre: utdatert forhåndsvisning gir exit 6, feil gir exit 1, og ingenting skrives', () => {
    const for_ = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const gammel = kjor([
      'fokus',
      'lagre',
      '--fil',
      plan({ rekkefolge: ['prosjekt:ui'] }),
      '--json',
      '--forvent-endret',
      '2026-10-01T00:00:00.000Z',
    ]);
    expect(gammel.kode).toBe(6);
    expect(JSON.parse(gammel.ut)).toMatchObject({ ok: false, utdatert: true });
    const feil = kjor([
      'fokus',
      'lagre',
      '--fil',
      plan({ rekkefolge: ['prosjekt:ui'], pause: ['nei'] }),
      '--json',
    ]);
    expect(feil.kode).toBe(1);
    expect((JSON.parse(feil.ut) as { feil: string[] }).feil[0]).toMatch(/ukjent prosjekt nei/);
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(for_);
  });

  it('omrade --forvent-endret: utdatert gir exit 6, gjeldende versjon lagrer', () => {
    const for_ = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const gammel = kjor([
      'omrade',
      'drift',
      '--tittel',
      'Drift',
      '--forvent-endret',
      '2026-10-01T00:00:00.000Z',
    ]);
    expect(gammel.kode).toBe(6);
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(for_);
    const ok = kjor([
      'omrade',
      'drift',
      '--tittel',
      'Drift',
      '--prosjekter',
      'ui',
      '--forvent-endret',
      ISO,
    ]);
    expect(ok.kode).toBe(0);
    const ko = lesKo();
    expect(ko.omrader?.drift).toMatchObject({ tittel: 'Drift' });
    expect(ko.prosjekter?.ui.omrade).toBe('drift');
  });
});
