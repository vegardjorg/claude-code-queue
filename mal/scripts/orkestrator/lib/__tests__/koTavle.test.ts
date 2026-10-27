// =============================================================
// koTavle.test.ts: de rene hjelperne bak kanban-tavla for arbeidskøen (lib/koTavle.js).
//
// Tavla (scripts/orkestrator/ko-tavle.mjs) viser det samme som `ko.mjs vis/neste/prosjekter` fordi den bruker
// reglene i koLogikk.js (prioritet, prosjektFor, hindringer, grenser). Testene her beviser at tavla:
//   - fordeler oppgavene i kolonnene I kø / Pågår / Review / Bygget (og forslag for seg),
//   - regner ut et nytt prioritet_tillegg som lander et kort MELLOM naboene (sjekket med koLogikk.score selv),
//   - ordner og flytter prosjektbaner uten å endre rekkefølgen mellom de andre prosjektene,
//   - teller agentplasser (WIP) med samme regel som køen (tellerSomAgent),
//   - har en egen, nøytral palett (lys og mørk) med de fargene tavla bruker, og lager CSS-variablene av den.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

type Oppgave = {
  id: string;
  tittel?: string;
  domene?: string;
  klasse?: 'K' | 'D' | 'D+' | 'U';
  status: string;
  nytte?: number;
  innhold_min?: number;
  avhenger?: string[];
  venter_paa?: string[];
  eier_filer?: string[];
  prioritet_tillegg?: number;
  prosjekt?: string;
  funksjon?: string;
  etiketter?: string[];
  plukket_av?: string;
  plukket_at?: string;
  startet?: string;
  levert?: string;
  ferdig?: string;
  qa_status?: string;
  lagt_til?: string;
  ekstern?: boolean;
  ekstern_navn?: string;
  migr_tiere?: number;
};
type Register = Record<
  string,
  { tittel: string; prefikser?: string[]; pause?: boolean; prioritet_tillegg?: number }
>;
type Ko = {
  oppgaver: Oppgave[];
  prosjekter?: Register;
  avklart?: string[];
  grenser?: Record<string, number>;
};
type Kort = {
  id: string;
  status: string;
  prosjekt: string;
  klar: boolean;
  hindringer: string[];
  score: number | null;
  visuell: boolean;
  gammel: boolean;
  nylig: boolean;
  qa_status: string | null;
  farge: string;
};
type Tavle = {
  wip: {
    agenter: number;
    maks: number;
    dPluss: number;
    maksDPluss: number;
    plukket: number;
    ekstern: number;
  };
  prosjekter: { pid: string; prioritet_tillegg: number; farge: string; flyttbar: boolean }[];
  kolonner: {
    ko: Kort[];
    forslag: Kort[];
    pagar: Kort[];
    review: Kort[];
    bygget: Kort[];
  };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../koTavle') as {
  STEG: number;
  PROSJEKT_FARGER: string[];
  kolonneFor: (o: Oppgave) => string | null;
  tavle: (
    ko: Ko,
    valg?: {
      naa?: number;
      ucommittet?: string[];
      grener?: Record<string, { commits: number; sisteCommit: string | null }>;
    },
  ) => Tavle;
  wip: (ko: Ko) => Tavle['wip'];
  prosjektBaner: (ko: Ko) => Tavle['prosjekter'];
  nyttTillegg: (
    ko: Ko,
    id: string,
    plass: { over?: string | null; under?: string | null; topp?: boolean },
    naa?: number,
  ) => { tillegg?: number; feil?: string };
  baneTillegg: (
    baner: { pid: string; prioritet_tillegg: number }[],
    pid: string,
    plass: { over?: string | null; under?: string | null },
  ) => { endringer?: Record<string, number>; feil?: string };
  UTEN_PROSJEKT_FARGE: string;
  PALETT: { lys: Record<string, string>; mork: Record<string, string> };
  temaCss: (p?: { lys: Record<string, string>; mork: Record<string, string> }) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk') as {
  score: (o: Oppgave, alle: Oppgave[], naa?: number, register?: Register) => number;
};

const NAA = Date.parse('2026-09-30T12:00:00Z');
const dagerSiden = (d: number) => new Date(NAA - d * 86_400_000).toISOString();
const timerSiden = (t: number) => new Date(NAA - t * 3_600_000).toISOString();

/** En oppgave med de vanlige standardfeltene (som `ko.mjs add` gir). */
function opp(id: string, felt: Partial<Oppgave> = {}): Oppgave {
  return {
    id,
    tittel: `Oppgave ${id}`,
    domene: 'klient',
    klasse: 'K',
    status: 'venter',
    nytte: 5,
    innhold_min: 30,
    avhenger: [],
    venter_paa: [],
    eier_filer: [],
    lagt_til: NAA_ISO,
    ...felt,
  };
}
const NAA_ISO = new Date(NAA).toISOString();

describe('kolonneFor', () => {
  it('fordeler statusene i de fire kolonnene, forslag for seg og kansellert utenfor', () => {
    expect(T.kolonneFor(opp('A', { status: 'venter' }))).toBe('ko');
    expect(T.kolonneFor(opp('A', { status: 'forslag' }))).toBe('forslag');
    expect(T.kolonneFor(opp('A', { status: 'kjorer' }))).toBe('pagar');
    expect(T.kolonneFor(opp('A', { status: 'plukket' }))).toBe('pagar');
    expect(T.kolonneFor(opp('A', { status: 'ekstern', ekstern: true }))).toBe('pagar');
    expect(T.kolonneFor(opp('A', { status: 'review' }))).toBe('review');
    expect(T.kolonneFor(opp('A', { status: 'ferdig' }))).toBe('bygget');
    expect(T.kolonneFor(opp('A', { status: 'kansellert' }))).toBeNull();
    // En avsluttet registrering utenfor køen er ikke arbeid og vises ikke.
    expect(T.kolonneFor(opp('A', { status: 'ferdig', ekstern: true }))).toBeNull();
  });
});

describe('tavle: kolonnefordeling', () => {
  const ko: Ko = {
    prosjekter: {
      alfa: { tittel: 'Alfa', prefikser: ['V-'] },
      pause: { tittel: 'Pauset', prefikser: ['P-'], pause: true },
    },
    avklart: [],
    oppgaver: [
      opp('V-1', { nytte: 9 }),
      opp('V-2', { nytte: 3 }),
      opp('V-3', { nytte: 8, avhenger: ['V-9'] }),
      opp('V-4', { nytte: 7, venter_paa: ['SP9'] }),
      opp('V-5', { nytte: 6, eier_filer: ['app/x.tsx'] }),
      opp('P-1', { nytte: 10 }),
      opp('V-9', { status: 'kjorer', startet: timerSiden(1), klasse: 'D+' }),
      opp('V-10', { status: 'plukket', plukket_av: 'eier', plukket_at: timerSiden(80) }),
      opp('X-1', {
        status: 'ekstern',
        ekstern: true,
        ekstern_navn: 'økt 2',
        lagt_til: timerSiden(2),
      }),
      opp('V-11', { status: 'review', levert: timerSiden(1) }),
      opp('V-12', {
        status: 'ferdig',
        ferdig: dagerSiden(1),
        etiketter: ['visuell'],
        qa_status: 'venter',
      }),
      opp('V-13', { status: 'ferdig', ferdig: dagerSiden(10) }),
      opp('V-14', {
        status: 'ferdig',
        ferdig: dagerSiden(20),
        etiketter: ['visuell'],
        qa_status: 'venter',
      }),
      opp('V-15', { status: 'forslag' }),
      opp('V-16', { status: 'kansellert' }),
    ],
  };
  const t = T.tavle(ko, { naa: NAA, ucommittet: ['app/x.tsx'] });
  const ider = (k: Kort[]) => k.map((x) => x.id);

  it('I kø: klare først etter prioritet, så blokkerte etter prioritet', () => {
    expect(ider(t.kolonner.ko)).toEqual(['V-1', 'V-2', 'P-1', 'V-3', 'V-4', 'V-5']);
    const klare = t.kolonner.ko.filter((k) => k.klar).map((k) => k.id);
    expect(klare).toEqual(['V-1', 'V-2']);
  });

  it('blokkerte kort sier hvorfor, med samme tekst som ko.mjs vis', () => {
    const h = Object.fromEntries(t.kolonner.ko.map((k) => [k.id, k.hindringer.join(' · ')]));
    expect(h['V-3']).toContain('venter på V-9 (kjorer)');
    expect(h['V-4']).toContain('venter på svar: SP9');
    expect(h['V-5']).toBe('fil app/x.tsx er ucommittet i hovedtreet');
    expect(h['P-1']).toContain('prosjektet pause er pauset');
    expect(h['V-1']).toBe('');
  });

  it('forslag står for seg, kansellert vises ikke', () => {
    expect(ider(t.kolonner.forslag)).toEqual(['V-15']);
    const alle = Object.values(t.kolonner)
      .flat()
      .map((k) => k.id);
    expect(alle).not.toContain('V-16');
  });

  it('Pågår har kjorer, plukket og ekstern; en plukket uten commits i over 72 t er gammel', () => {
    expect(ider(t.kolonner.pagar).sort()).toEqual(['V-10', 'V-9', 'X-1']);
    const gammel = t.kolonner.pagar.filter((k) => k.gammel).map((k) => k.id);
    expect(gammel).toEqual(['V-10']);
  });

  it('en plukket med ferske commits på grenen er ikke gammel', () => {
    const t2 = T.tavle(ko, {
      naa: NAA,
      grener: { 'ko/V-10': { commits: 2, sisteCommit: timerSiden(3) } },
    });
    expect(t2.kolonner.pagar.find((k) => k.id === 'V-10')?.gammel).toBe(false);
  });

  it('Bygget: nyeste først; nylig = siste 7 dager, og QA som venter vises uansett alder', () => {
    expect(ider(t.kolonner.bygget)).toEqual(['V-12', 'V-13', 'V-14']);
    const nylig = t.kolonner.bygget.filter((k) => k.nylig).map((k) => k.id);
    expect(nylig).toEqual(['V-12', 'V-14']);
    expect(t.kolonner.bygget[0]).toMatchObject({ visuell: true, qa_status: 'venter' });
  });

  it('Review har det som er levert', () => {
    expect(ider(t.kolonner.review)).toEqual(['V-11']);
  });

  it('score på kortet er køens egen prioritet (koLogikk.score med prosjektets tillegg)', () => {
    const k = t.kolonner.ko.find((x) => x.id === 'V-1');
    const o = ko.oppgaver.find((x) => x.id === 'V-1') as Oppgave;
    expect(k?.score).toBe(L.score(o, ko.oppgaver, NAA, ko.prosjekter));
  });
});

describe('wip', () => {
  it('teller agentplasser som køen (kjorer og review uten plukket_av), D+ for seg, plukket og ekstern ved siden av', () => {
    const ko: Ko = {
      grenser: { maksSamtidig: 5, maksDPluss: 2 },
      oppgaver: [
        opp('A', { status: 'kjorer', klasse: 'D+' }),
        opp('B', { status: 'kjorer' }),
        opp('C', { status: 'review' }),
        opp('D', { status: 'review', plukket_av: 'eier' }),
        opp('E', { status: 'plukket', plukket_av: 'eier' }),
        opp('F', { status: 'ekstern', ekstern: true }),
        opp('G', { status: 'venter' }),
      ],
    };
    expect(T.wip(ko)).toEqual({
      agenter: 3,
      maks: 5,
      dPluss: 1,
      maksDPluss: 2,
      plukket: 1,
      ekstern: 1,
    });
  });

  it('bruker standardgrensene når køen ikke har egne', () => {
    const w = T.wip({ oppgaver: [] });
    expect(w.maks).toBeGreaterThan(0);
    expect(w.maksDPluss).toBeGreaterThan(0);
  });
});

describe('nyttTillegg: kortet lander mellom naboene', () => {
  const ko: Ko = {
    oppgaver: [
      opp('A', { nytte: 9 }),
      opp('B', { nytte: 6 }),
      opp('C', { nytte: 3 }),
      opp('D', { nytte: 2, prioritet_tillegg: 40 }),
      opp('K', { status: 'kjorer' }),
    ],
  };
  const eff = (k: Ko, id: string) =>
    L.score(k.oppgaver.find((o) => o.id === id) as Oppgave, k.oppgaver, NAA, k.prosjekter);
  const medTillegg = (k: Ko, id: string, tillegg: number): Ko => ({
    ...k,
    oppgaver: k.oppgaver.map((o) => (o.id === id ? { ...o, prioritet_tillegg: tillegg } : o)),
  });

  it('mellom to naboer: ny prioritet ligger strengt mellom dem', () => {
    const r = T.nyttTillegg(ko, 'C', { over: 'A', under: 'B' }, NAA);
    expect(r.feil).toBeUndefined();
    const ny = medTillegg(ko, 'C', r.tillegg as number);
    expect(eff(ny, 'C')).toBeLessThan(eff(ny, 'A'));
    expect(eff(ny, 'C')).toBeGreaterThan(eff(ny, 'B'));
  });

  it('et kort med tillegg fra før flyttes ned: tillegget erstattes, ikke legges oppå', () => {
    const r = T.nyttTillegg(ko, 'D', { over: 'B', under: 'C' }, NAA);
    const ny = medTillegg(ko, 'D', r.tillegg as number);
    expect(eff(ny, 'D')).toBeLessThan(eff(ny, 'B'));
    expect(eff(ny, 'D')).toBeGreaterThan(eff(ny, 'C'));
  });

  it('øverst og nederst: ett steg forbi naboen', () => {
    const topp = T.nyttTillegg(ko, 'C', { under: 'A' }, NAA);
    expect(eff(medTillegg(ko, 'C', topp.tillegg as number), 'C')).toBeCloseTo(
      eff(ko, 'A') + T.STEG,
      1,
    );
    const bunn = T.nyttTillegg(ko, 'A', { over: 'C' }, NAA);
    expect(eff(medTillegg(ko, 'A', bunn.tillegg as number), 'A')).toBeCloseTo(
      eff(ko, 'C') - T.STEG,
      1,
    );
  });

  it('«til toppen av køen» havner over den høyeste i hele køen', () => {
    const r = T.nyttTillegg(ko, 'C', { topp: true }, NAA);
    const ny = medTillegg(ko, 'C', r.tillegg as number);
    for (const id of ['A', 'B', 'D']) expect(eff(ny, 'C')).toBeGreaterThan(eff(ny, id));
  });

  it('nekter kort som ikke er i kø, ukjente naboer og flytt uten naboer', () => {
    expect(T.nyttTillegg(ko, 'K', { over: 'A' }, NAA).feil).toMatch(/kø/);
    expect(T.nyttTillegg(ko, 'C', { over: 'ZZ' }, NAA).feil).toMatch(/ZZ/);
    expect(T.nyttTillegg(ko, 'C', { over: 'K' }, NAA).feil).toMatch(/K/);
    expect(T.nyttTillegg(ko, 'C', {}, NAA).feil).toBeTruthy();
    expect(T.nyttTillegg(ko, 'ukjent', { over: 'A' }, NAA).feil).toMatch(/ukjent/);
  });
});

describe('prosjektBaner og baneTillegg', () => {
  const ko: Ko = {
    prosjekter: {
      a: { tittel: 'A' },
      b: { tittel: 'B', prioritet_tillegg: 20 },
      c: { tittel: 'C' },
      d: { tittel: 'D' },
    },
    oppgaver: [opp('X-1'), opp('Y-1', { prosjekt: 'c' })],
  };

  it('prosjektrekkefølge: høyest tillegg først, så registerets rekkefølge, uten-prosjekt sist og ikke flyttbar', () => {
    const b = T.prosjektBaner(ko);
    expect(b.map((x) => x.pid)).toEqual(['b', 'a', 'c', 'd', 'uten-prosjekt']);
    expect(b.find((x) => x.pid === 'uten-prosjekt')?.flyttbar).toBe(false);
    expect(b.find((x) => x.pid === 'a')?.flyttbar).toBe(true);
  });

  it('prosjektfargen er stabil (registerets rekkefølge), uavhengig av prioriteten', () => {
    const f1 = Object.fromEntries(T.prosjektBaner(ko).map((x) => [x.pid, x.farge]));
    const ko2 = {
      ...ko,
      prosjekter: { ...ko.prosjekter, d: { tittel: 'D', prioritet_tillegg: 99 } },
    };
    const f2 = Object.fromEntries(T.prosjektBaner(ko2).map((x) => [x.pid, x.farge]));
    expect(f2).toEqual(f1);
    expect(new Set(['a', 'b', 'c', 'd'].map((p) => f1[p])).size).toBe(4);
  });

  /** Rekkefølgen etter at endringene er lagt inn i registeret. */
  function etter(endringer: Record<string, number>): string[] {
    const reg: Register = { ...(ko.prosjekter as Register) };
    for (const [pid, t] of Object.entries(endringer))
      reg[pid] = { ...reg[pid], prioritet_tillegg: t };
    return T.prosjektBaner({ ...ko, prosjekter: reg })
      .map((x) => x.pid)
      .filter((p) => p !== 'uten-prosjekt');
  }
  const baner = () => T.prosjektBaner(ko).filter((x) => x.flyttbar);

  it('mellom to naboer med rom: bare det flyttede prosjektet endres', () => {
    const r = T.baneTillegg(baner(), 'd', { over: 'b', under: 'a' });
    expect(Object.keys(r.endringer ?? {})).toEqual(['d']);
    expect(etter(r.endringer ?? {})).toEqual(['b', 'd', 'a', 'c']);
  });

  it('mellom to like naboer: den minste siden forskyves, og de andre beholder rekkefølgen seg imellom', () => {
    const r = T.baneTillegg(baner(), 'd', { over: 'a', under: 'c' });
    expect(etter(r.endringer ?? {})).toEqual(['b', 'a', 'd', 'c']);
    // c er alene under d (én bane), mens b og a er over (to): c flyttes ned, ikke b og a opp.
    expect(Object.keys(r.endringer ?? {}).sort()).toEqual(['c', 'd']);
  });

  it('øverst og nederst', () => {
    expect(etter(T.baneTillegg(baner(), 'c', { under: 'b' }).endringer ?? {})).toEqual([
      'c',
      'b',
      'a',
      'd',
    ]);
    expect(etter(T.baneTillegg(baner(), 'b', { over: 'd' }).endringer ?? {})).toEqual([
      'a',
      'c',
      'd',
      'b',
    ]);
  });

  it('nekter ukjente prosjekter', () => {
    expect(T.baneTillegg(baner(), 'zz', { over: 'a' }).feil).toMatch(/zz/);
    expect(T.baneTillegg(baner(), 'a', { over: 'zz' }).feil).toMatch(/zz/);
  });
});

describe('den nøytrale paletten (PALETT) og tema.css', () => {
  const p = T.PALETT;
  const KLIENT = join(__dirname, '..', '..', 'ko-tavle');

  /** Alle `var(--color-…)`-navnene og `color-${…}`-fargene klientfilene bruker. */
  function brukteTokens(): Set<string> {
    const filer: string[] = [];
    const samle = (mappe: string) => {
      for (const d of readdirSync(mappe, { withFileTypes: true })) {
        if (d.isDirectory()) samle(join(mappe, d.name));
        else if (/\.(css|js|html)$/.test(d.name)) filer.push(join(mappe, d.name));
      }
    };
    samle(KLIENT);
    const ut = new Set<string>();
    for (const f of filer)
      for (const m of readFileSync(f, 'utf8').matchAll(/--color-([a-z0-9-]+)/g)) ut.add(m[1]);
    return ut;
  }

  it('lys og mørk har de samme navnene, og alle er gyldige hex-farger', () => {
    expect(Object.keys(p.lys).sort()).toEqual(Object.keys(p.mork).sort());
    for (const v of [...Object.values(p.lys), ...Object.values(p.mork)])
      expect(v).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('hver farge klientfilene bruker (tavle.css, planer/ osv.), finnes i paletten', () => {
    const mangler = [...brukteTokens()].filter((t) => !p.lys[t]);
    expect(mangler).toEqual([]);
  });

  it('prosjektfargene og den nøytrale finnes i paletten', () => {
    for (const token of [...T.PROSJEKT_FARGER, T.UTEN_PROSJEKT_FARGE]) {
      expect(p.lys[token]).toBeDefined();
      expect(p.mork[token]).toBeDefined();
    }
  });

  /** Kontrastforholdet etter WCAG (relativ luminans). */
  function kontrast(a: string, b: string): number {
    const lum = (hex: string) => {
      const [r, g, bl] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  }

  it('teksten holder minst 4,5:1 mot flatene i begge modi', () => {
    for (const modus of [p.lys, p.mork]) {
      for (const flate of ['surface', 'surface-container-lowest', 'surface-container-low']) {
        expect(kontrast(modus['on-surface'], modus[flate])).toBeGreaterThanOrEqual(4.5);
        expect(kontrast(modus['on-surface-variant'], modus[flate])).toBeGreaterThanOrEqual(4.5);
      }
      expect(kontrast(modus['on-primary'], modus.primary)).toBeGreaterThanOrEqual(4.5);
      for (const [paa, flate] of [
        ['on-primary-container', 'primary-container'],
        ['on-secondary-container', 'secondary-container'],
        ['on-tertiary-container', 'tertiary-container'],
        ['on-error-container', 'error-container'],
        ['inverse-on-surface', 'inverse-surface'],
      ])
        expect(kontrast(modus[paa], modus[flate])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('prosjektfargene holder minst 3:1 mot flatene i begge modi (merker og kanter)', () => {
    for (const modus of [p.lys, p.mork])
      for (const token of [...T.PROSJEKT_FARGER, T.UTEN_PROSJEKT_FARGE])
        expect(kontrast(modus[token], modus.surface)).toBeGreaterThanOrEqual(3);
  });

  it('temaCss gir CSS-variabler for lys, mørk etter systemet og mørk med bryteren', () => {
    const css = T.temaCss(p);
    expect(css).toContain(`--color-primary: ${p.lys.primary};`);
    expect(css).toContain(`--color-primary: ${p.mork.primary};`);
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('[data-tema="mork"]');
    // Uten argument brukes paletten.
    expect(T.temaCss()).toBe(css);
  });

  it('temaCss slipper ikke gjennom navn eller verdier som ikke er rene farger', () => {
    const css = T.temaCss({ lys: { 'ok-navn': '#000000', 'x;}': '#ffffff', y: 'red' }, mork: {} });
    expect(css).toContain('--color-ok-navn: #000000;');
    expect(css).not.toContain('x;}');
    expect(css).not.toContain('--color-y');
  });
});

// =============================================================
// Vaktreglene, «Løft avhengighetene også», innstillingene og oppsettet.
// =============================================================
type Vakt = {
  nivaa: 'info' | 'advarsel' | 'stopp';
  tekst: string;
  forslag?: { tekst: string; felt: object };
};
type O2 = Oppgave & { migr_tiere?: number; gren?: string; eier_db?: string[] };
type Ko2 = Omit<Ko, 'oppgaver' | 'grenser'> & {
  oppgaver: O2[];
  grenser?: Record<string, number | boolean | string | null>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../koTavle') as {
  SPAREMODUS: Record<string, number>;
  vurder: (
    ko: Ko2,
    handling: Record<string, unknown>,
    kontekst?: Record<string, unknown>,
  ) => Vakt[];
  loftTillegg: (
    ko: Ko2,
    id: string,
    plass: { over?: string | null; under?: string | null; topp?: boolean },
    naa?: number,
  ) => { endringer?: Record<string, number>; feil?: string };
  INNSTILLINGER: { navn: string }[];
  innstillinger: (
    ko: Ko2,
  ) => { navn: string; verdi: string; standard: string; sparemodus: string | null }[];
  SKILL_REGLER: { tekst: string }[];
  KO_HOOKS: { fil: string; hendelser: string[]; alleMatchere?: boolean }[];
  hooksDekning: (settings: unknown) => {
    alle: boolean;
    mangler: string[];
    hooks: {
      fil: string;
      ok: boolean;
      hendelser: { hendelse: string; matchere: string[]; ok: boolean }[];
    }[];
  };
  KO_SKILLS: string[];
  skillsDekning: (
    finnes: (navn: string) => boolean,
    navn?: string[],
  ) => { alle: boolean; finnes: string[]; mangler: string[] };
  hoyesteMigrasjon: (
    filer: string[],
    filmonster?: string,
  ) => { versjon: string; fil: string; nummer: number } | null;
  tavleTittel: (konfig: unknown) => string;
  tavle: (
    ko: Ko2,
    valg?: { naa?: number; grenPrefiks?: string },
  ) => { natt: { aktiv: boolean; stopp: boolean }; kolonner: { ko: { id: string; gren: string }[] } };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L2 = require('../koLogikk') as {
  GRENSE_NAVN: string[];
  score: (o: O2, alle: O2[], naa?: number, register?: Register) => number;
  hindringer: (o: O2, alle: O2[], avklart?: string[]) => string[];
  hindringDeler: (o: O2, alle: O2[], avklart?: string[]) => { type: string; tekst: string }[];
  endreMange: (ko: Ko2, inn: unknown) => { feil: string[]; endret?: string[] };
};

describe('vurder: flytte et kort i køen', () => {
  const grunn = (): Ko2 => ({
    oppgaver: [
      opp('TOPP', { nytte: 9 }),
      opp('MIDT', { nytte: 6 }),
      opp('X', { nytte: 2 }),
      opp('BUNN', { nytte: 1 }),
    ],
  });
  const flytt = (ko: Ko2, id: string, plass: Record<string, unknown>, kontekst = {}) =>
    V.vurder(ko, { type: 'flytt', id, ...plass }, { naa: NAA, ...kontekst });
  const nivaaer = (v: Vakt[]) => v.map((x) => x.nivaa);

  it('en ren flytting uten hindring gir tom liste', () => {
    expect(flytt(grunn(), 'X', { over: 'TOPP', under: 'MIDT' })).toEqual([]);
    expect(flytt(grunn(), 'X', { topp: true })).toEqual([]);
  });

  it('flytting ned eller på samme plass varsler ingenting, heller ikke for et blokkert kort', () => {
    const ko = grunn();
    ko.oppgaver.push(opp('DEP', { status: 'venter', nytte: 1 }));
    ko.oppgaver[1].avhenger = ['DEP'];
    expect(flytt(ko, 'MIDT', { over: 'X', under: 'BUNN' })).toEqual([]);
  });

  it('1. avhengighet ikke ferdig: advarsel med forslaget «Løft avhengighetene også» når de står i kø', () => {
    const ko = grunn();
    ko.oppgaver.push(opp('A1', { nytte: 1 }), opp('B1', { nytte: 1 }));
    ko.oppgaver[2].avhenger = ['A1', 'B1'];
    const v = flytt(ko, 'X', { topp: true });
    expect(v).toEqual([
      {
        nivaa: 'advarsel',
        tekst: 'X kan ikke starte før A1 og B1 er ferdige.',
        forslag: { tekst: 'Løft avhengighetene også', felt: { loft: true } },
      },
    ]);
  });

  it('1. avhengighet som kjører: advarsel uten forslag (den kan ikke løftes)', () => {
    const ko = grunn();
    ko.oppgaver.push(opp('A1', { status: 'kjorer' }));
    ko.oppgaver[2].avhenger = ['A1'];
    const v = flytt(ko, 'X', { topp: true });
    expect(v).toEqual([{ nivaa: 'advarsel', tekst: 'X kan ikke starte før A1 er ferdig.' }]);
  });

  it('2. venter på eierspørsmål: advarsel; avklarte teller ikke', () => {
    const ko = grunn();
    ko.oppgaver[2].venter_paa = ['SP-9', 'SP-10'];
    ko.avklart = ['SP-10'];
    expect(flytt(ko, 'X', { topp: true })).toEqual([
      { nivaa: 'advarsel', tekst: 'X venter på svaret ditt på SP-9.' },
    ]);
  });

  it('3. eierfil deles med noe som kjører, er plukket eller ekstern: info', () => {
    const ko = grunn();
    ko.oppgaver[2].eier_filer = ['lib/a.ts'];
    ko.oppgaver.push(
      opp('K1', { status: 'kjorer', eier_filer: ['lib/'] }),
      opp('P1', { status: 'plukket', plukket_av: 'eier', eier_filer: ['lib/a.ts'] }),
    );
    const v = flytt(ko, 'X', { topp: true });
    expect(v).toEqual([
      { nivaa: 'info', tekst: 'X deler fila lib/a.ts med K1 og starter først når K1 er ferdig.' },
      { nivaa: 'info', tekst: 'X deler fila lib/a.ts med P1 og starter først når P1 er ferdig.' },
    ]);
  });

  it('4. prosjektet står på pause: info', () => {
    const ko = grunn();
    ko.prosjekter = { beta: { tittel: 'Beta', pause: true } };
    ko.oppgaver[2].prosjekt = 'beta';
    expect(flytt(ko, 'X', { topp: true })).toEqual([
      {
        nivaa: 'info',
        tekst: 'Prosjektet beta står på pause: flyttingen virker først når prosjektet fortsetter.',
      },
    ]);
  });

  it('5. grense nådd: D+-plassene fulle, og maksDb nådd for en oppgave med migrasjoner (info)', () => {
    const ko = grunn();
    ko.grenser = { maksDPluss: 1, maksDb: 1 };
    ko.oppgaver[2].klasse = 'D+';
    ko.oppgaver[2].migr_tiere = 1;
    ko.oppgaver.push(opp('K1', { status: 'kjorer', klasse: 'D+', migr_tiere: 1 }));
    const v = flytt(ko, 'X', { topp: true });
    expect(nivaaer(v)).toEqual(['info', 'info']);
    expect(v[0].tekst).toBe('D+-plassene er fulle (1 av 1): X starter når en plass blir ledig.');
    expect(v[1].tekst).toBe(
      'Grensen for spor med migrasjoner er nådd (1 av 1): X starter når en plass blir ledig.',
    );
  });

  it('hindringene kommer fra koLogikk: hindringDeler gir nøyaktig de samme tekstene som hindringer', () => {
    const ko = grunn();
    ko.oppgaver[2].avhenger = ['MIDT', 'FINNES-IKKE'];
    ko.oppgaver[2].venter_paa = ['SP-1'];
    ko.oppgaver[2].eier_filer = ['a.ts'];
    ko.oppgaver.push(opp('K1', { status: 'kjorer', eier_filer: ['a.ts'] }));
    const x = ko.oppgaver[2];
    expect(L2.hindringDeler(x, ko.oppgaver).map((h) => h.tekst)).toEqual(
      L2.hindringer(x, ko.oppgaver),
    );
    expect(L2.hindringer(x, ko.oppgaver)).toHaveLength(4);
  });
});

describe('loftTillegg: «Løft avhengighetene også»', () => {
  const ko: Ko2 = {
    oppgaver: [
      opp('TOPP', { nytte: 9 }),
      opp('MIDT', { nytte: 6 }),
      opp('X', { nytte: 2, avhenger: ['A1', 'B1', 'OVER', 'KJ'] }),
      opp('A1', { nytte: 1 }),
      opp('B1', { nytte: 1.5 }),
      opp('OVER', { nytte: 10 }), // står alt over: røres ikke
      opp('KJ', { status: 'kjorer' }), // kjører: kan ikke løftes
    ],
  };
  const eff = (k: Ko2, id: string) =>
    L2.score(k.oppgaver.find((o) => o.id === id) as O2, k.oppgaver, NAA, k.prosjekter);
  const bruk = (k: Ko2, endringer: Record<string, number>): Ko2 => ({
    ...k,
    oppgaver: k.oppgaver.map((o) =>
      o.id in endringer ? { ...o, prioritet_tillegg: endringer[o.id] } : o,
    ),
  });

  it('de åpne avhengighetene i kø legges rett over kortet, mellom kortet og naboen over, i sin rekkefølge', () => {
    const r = V.loftTillegg(ko, 'X', { over: 'TOPP', under: 'MIDT' }, NAA);
    // OVER står alt over kortet og røres ikke; KJ kjører og kan ikke løftes.
    expect(Object.keys(r.endringer ?? {}).sort()).toEqual(['A1', 'B1', 'X']);
    const ny = bruk(ko, r.endringer ?? {});
    expect(eff(ny, 'X')).toBeLessThan(eff(ny, 'TOPP'));
    expect(eff(ny, 'X')).toBeGreaterThan(eff(ny, 'MIDT'));
    for (const d of ['A1', 'B1']) {
      expect(eff(ny, d)).toBeGreaterThan(eff(ny, 'X'));
      expect(eff(ny, d)).toBeLessThan(eff(ny, 'TOPP'));
    }
    // B1 sto over A1 før, og gjør det fortsatt.
    expect(eff(ny, 'B1')).toBeGreaterThan(eff(ny, 'A1'));
  });

  it('øverst i køen: alle avhengighetene i kø havner over kortet, i sin rekkefølge (løft, aldri senk)', () => {
    const r = V.loftTillegg(ko, 'X', { topp: true }, NAA);
    const ny = bruk(ko, r.endringer ?? {});
    for (const d of ['A1', 'B1', 'OVER']) {
      expect(eff(ny, d)).toBeGreaterThan(eff(ny, 'X'));
      expect(eff(ny, d)).toBeGreaterThanOrEqual(eff(ko, d));
    }
    expect(eff(ny, 'OVER')).toBeGreaterThan(eff(ny, 'B1'));
    expect(r.endringer).not.toHaveProperty('KJ');
  });

  it('endre-mange tar prioritet_tillegg for flere oppgaver i ett kall (alt eller ingenting)', () => {
    const k = JSON.parse(JSON.stringify(ko)) as Ko2;
    const r = L2.endreMange(k, {
      oppgaver: [
        { id: 'X', prioritet_tillegg: 12.5 },
        { id: 'A1', prioritet_tillegg: 30 },
      ],
    });
    expect(r.feil).toEqual([]);
    expect(k.oppgaver.find((o) => o.id === 'A1')?.prioritet_tillegg).toBe(30);
    const for_ = JSON.stringify(k);
    const feil = L2.endreMange(k, {
      oppgaver: [
        { id: 'X', prioritet_tillegg: 1 },
        { id: 'A1', prioritet_tillegg: 'mye' },
      ],
    });
    expect(feil.feil.join('\n')).toContain('prioritet_tillegg må være et tall');
    expect(JSON.stringify(k)).toBe(for_);
  });
});

describe('vurder: handlinger', () => {
  it('6. pause et prosjekt med noe som pågår: advarsel; ingenting pågår: ingen', () => {
    const ko: Ko2 = {
      prosjekter: { beta: { tittel: 'Beta' } },
      oppgaver: [
        opp('L1', { prosjekt: 'beta', status: 'kjorer' }),
        opp('L2', { prosjekt: 'beta', status: 'plukket', plukket_av: 'eier' }),
        opp('L3', { prosjekt: 'beta' }),
      ],
    };
    expect(V.vurder(ko, { type: 'pause', pid: 'beta' })).toEqual([
      { nivaa: 'advarsel', tekst: '2 pågår i beta og kjører ferdig; pausen stopper bare nye.' },
    ]);
    expect(V.vurder(ko, { type: 'pause', pid: 'annet' })).toEqual([]);
    expect(V.vurder(ko, { type: 'fortsett', pid: 'beta' })).toEqual([]);
  });

  it('7. slipp med commits på grenen: advarsel; uten commits: ingen', () => {
    const ko: Ko2 = { oppgaver: [opp('P', { status: 'plukket', plukket_av: 'eier' })] };
    expect(
      V.vurder(ko, { type: 'slipp', id: 'P' }, { grener: { 'ko/P': { commits: 3 } } }),
    ).toEqual([{ nivaa: 'advarsel', tekst: 'Grenen ko/P har 3 commits som blir liggende.' }]);
    expect(
      V.vurder(ko, { type: 'slipp', id: 'P' }, { grener: { 'ko/P': { commits: 0 } } }),
    ).toEqual([]);
  });

  it('8. plukk: info når en orkestrator er aktiv og når oppgaven har migrasjoner', () => {
    const ko: Ko2 = { oppgaver: [opp('M', { migr_tiere: 2 }), opp('R')] };
    const v = V.vurder(ko, { type: 'plukk', id: 'M' }, { orkestrator: { aktiv: true } });
    expect(v.map((x) => x.nivaa)).toEqual(['info', 'info']);
    expect(v[0].tekst).toContain('lever når du er ferdig');
    expect(v[1].tekst).toBe(
      'M har migrasjoner og får en migrasjonsblokk (2 tiere) når den plukkes.',
    );
    expect(V.vurder(ko, { type: 'plukk', id: 'R' }, { orkestrator: { aktiv: false } })).toEqual([]);
  });

  it('9. QA-avvik uten tekst: stopp; med tekst: ingenting', () => {
    const ko: Ko2 = { oppgaver: [opp('Q', { status: 'ferdig', qa_status: 'venter' })] };
    expect(V.vurder(ko, { type: 'qa-avvik', id: 'Q', tekst: '  ' })).toEqual([
      { nivaa: 'stopp', tekst: 'Skriv hva som er galt, og hvor, før du melder QA-avvik.' },
    ]);
    expect(V.vurder(ko, { type: 'qa-avvik', id: 'Q', tekst: 'knappen er borte' })).toEqual([]);
  });
});

describe('vurder: innstillinger', () => {
  const ko: Ko2 = {
    grenser: { maksSamtidig: 5, maksDPluss: 2, maksDb: 3 },
    oppgaver: [opp('K1', { status: 'kjorer' }), opp('K2', { status: 'kjorer' })],
  };
  const grense = (navn: string, verdi: string, kontekst = {}) =>
    V.vurder(ko, { type: 'grense', navn, verdi }, kontekst);

  it('10. over sparemodus (5 samtidige, 2 D+): advarsel; innenfor: ingen', () => {
    expect(grense('maksSamtidig', '6')[0]?.nivaa).toBe('advarsel');
    expect(grense('maksSamtidig', '6')[0]?.tekst).toContain('kvoten brukes raskere');
    expect(grense('maksSamtidig', '5')).toEqual([]);
    // maksDPluss 3 er innenfor maksSamtidig (5), men over sparemodus.
    expect(grense('maksDPluss', '3')[0]?.nivaa).toBe('advarsel');
    expect(grense('maksDPluss', '2')).toEqual([]);
  });

  it('11. maksDb økes: advarsel om tilkoblingspoolen; senkes: ingen', () => {
    expect(grense('maksDb', '4')[0]?.tekst).toContain('tilkoblingspoolen');
    expect(grense('maksDb', '2')).toEqual([]);
  });

  it('12. maksSamtidig 0: advarsel om at køen stopper', () => {
    expect(grense('maksSamtidig', '0')).toEqual([
      { nivaa: 'advarsel', tekst: 'Med 0 samtidige stopper køen: ingen nye oppgaver startes.' },
    ]);
  });

  it('13. dagskvote under dagens forbruk: advarsel; over: ingen; «av»: ingen', () => {
    expect(grense('dagsbudsjett', '40', { forbrukIdag: 55.5 })[0]?.tekst).toBe(
      'Dagskvoten (40.00 USD) er alt brukt opp i dag (55.50 USD): køen stopper nye oppgaver med en gang.',
    );
    expect(grense('dagsbudsjett', '80', { forbrukIdag: 55.5 })).toEqual([]);
    expect(grense('dagsbudsjett', 'av', { forbrukIdag: 55.5 })).toEqual([]);
  });

  it('14. nattkjøring av mens noe kjører: info; på: ingen', () => {
    expect(grense('nattkjoring', 'av')).toEqual([
      { nivaa: 'info', tekst: '2 kjører og går ferdig; nattpausen stopper bare nye.' },
    ]);
    expect(grense('nattkjoring', 'på')).toEqual([]);
  });

  it('en ugyldig verdi varsles ikke her (ko.mjs nekter med sin egen melding)', () => {
    expect(grense('maksDPluss', '9')).toEqual([]);
    expect(grense('nattvindu', '2306')).toEqual([]);
  });
});

describe('innstillinger og oppsett', () => {
  it('panelet har alle grensene ko.mjs kan sette, med nåverdi, standard og sparemodus', () => {
    expect(V.INNSTILLINGER.map((f) => f.navn)).toEqual(L2.GRENSE_NAVN);
    const felt = V.innstillinger({
      oppgaver: [],
      grenser: { maksSamtidig: 5, nattkjoring: false },
    });
    const f = (navn: string) => felt.find((x) => x.navn === navn);
    expect(f('maksSamtidig')).toMatchObject({ verdi: '5', standard: '5', sparemodus: '5' });
    expect(f('maksDPluss')).toMatchObject({ verdi: '2', standard: '2', sparemodus: '2' });
    expect(f('maksPerDomene')?.sparemodus).toBeNull();
    expect(f('dagsbudsjett')).toMatchObject({ verdi: 'av', standard: 'av' });
    expect(f('nattkjoring')).toMatchObject({ verdi: 'av', standard: 'på' });
    expect(f('nattvindu')).toMatchObject({ verdi: '23-06', standard: '23-06' });
  });

  it('arbeidsreglene i panelet: sparemodus-teksten følger SPAREMODUS', () => {
    expect(V.SKILL_REGLER.length).toBeGreaterThan(0);
    expect(V.SKILL_REGLER[0].tekst).toContain(
      `høyst ${V.SPAREMODUS.maksSamtidig} samtidige spor og ${V.SPAREMODUS.maksDPluss} D+`,
    );
  });

  /** settings.json med alle køsystemets hooks, slik installasjonen setter dem opp. */
  function fullSettings() {
    const hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> = {};
    for (const h of V.KO_HOOKS)
      for (const hendelse of h.hendelser)
        (hooks[hendelse] ??= []).push({
          matcher: '*',
          hooks: [{ command: `node scripts/orkestrator/${h.fil}` }],
        });
    return { hooks };
  }

  it('hooks: alle køsystemets hooks på plass gir «alle»', () => {
    const r = V.hooksDekning(fullSettings());
    expect(r.alle).toBe(true);
    expect(r.mangler).toEqual([]);
    expect(r.hooks.map((h) => h.fil)).toEqual(V.KO_HOOKS.map((h) => h.fil));
  });

  it('hooks: hver hook i lista finnes som skript i scripts/orkestrator/', () => {
    const filer = readdirSync(join(__dirname, '..', '..'));
    for (const h of V.KO_HOOKS) expect(filer).toContain(h.fil);
  });

  it('hooks: en smal matcher på tidsloggen og en manglende hook blir meldt', () => {
    const s = fullSettings();
    s.hooks.SubagentStart = [
      { matcher: 'spor', hooks: [{ command: 'node scripts/orkestrator/hook-tid.mjs' }] },
    ];
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter(
      (e) => !e.hooks[0].command.includes('hook-lesevakt.mjs'),
    );
    const r = V.hooksDekning(s);
    expect(r.alle).toBe(false);
    expect(r.mangler).toEqual(['hook-tid.mjs (SubagentStart)', 'hook-lesevakt.mjs (PreToolUse)']);
    const tid = r.hooks.find((h) => h.fil === 'hook-tid.mjs');
    expect(tid?.hendelser[0]).toEqual({ hendelse: 'SubagentStart', matchere: ['spor'], ok: false });
    // En kommando med bakoverstreker (Windows) og uten matcher teller også.
    expect(
      V.hooksDekning({
        hooks: {
          ...fullSettings().hooks,
          SubagentStop: [{ hooks: [{ command: 'node scripts\\orkestrator\\hook-tid.mjs' }] }],
        },
      }).alle,
    ).toBe(true);
    expect(V.hooksDekning({}).alle).toBe(false);
    // Et annet prosjekts skript med samme filnavn et annet sted teller ikke.
    expect(
      V.hooksDekning({
        hooks: {
          ...fullSettings().hooks,
          UserPromptSubmit: [{ hooks: [{ command: 'node verktoy/hook-effort.mjs' }] }],
        },
      }).mangler,
    ).toEqual(['hook-effort.mjs (UserPromptSubmit)', 'hook-kontekst.mjs (UserPromptSubmit)']);
  });

  it('skills: køsystemets skills, og hvilke som mangler', () => {
    expect(V.KO_SKILLS).toEqual(['ko', 'legg-til-ko', 'parallell-bolge', 'planer', 'plukk', 'start']);
    expect(V.skillsDekning(() => true)).toEqual({ alle: true, finnes: V.KO_SKILLS, mangler: [] });
    expect(V.skillsDekning((n) => n !== 'plukk' && n !== 'start')).toMatchObject({
      alle: false,
      mangler: ['plukk', 'start'],
    });
    // En filsjekk som kaster, teller som «mangler».
    expect(
      V.skillsDekning(() => {
        throw new Error('nei');
      }).finnes,
    ).toEqual([]);
  });

  it('skills: hver skill i lista følger med i malen (mal/.claude/skills/<navn>/SKILL.md)', () => {
    const mappe = join(__dirname, '..', '..', '..', '..', '.claude', 'skills');
    const finnes = (n: string) => {
      try {
        return readFileSync(join(mappe, n, 'SKILL.md'), 'utf8').length > 0;
      } catch {
        return false;
      }
    };
    expect(V.skillsDekning(finnes).mangler).toEqual([]);
  });

  it('høyeste migrasjon blant filnavnene, med prosjektets filmønster', () => {
    expect(
      V.hoyesteMigrasjon([
        '20260926003449_b.sql',
        '20260926000900_a.sql',
        'README.md',
        '20260926003450_c.sql.bak',
      ]),
    ).toEqual({ versjon: '20260926003449', fil: '20260926003449_b.sql', nummer: 20260926003449 });
    expect(V.hoyesteMigrasjon([])).toBeNull();
    // Numrene sammenlignes som tall, ikke som tekst (9 < 10).
    expect(V.hoyesteMigrasjon(['9_a.sql', '10_b.sql'])?.fil).toBe('10_b.sql');
    // Eget mønster (V<nr>__navn.sql) og et ugyldig mønster.
    expect(
      V.hoyesteMigrasjon(['V2__a.sql', 'V11__b.sql', '12_c.sql'], '^V(\\d+)__.*\\.sql$'),
    ).toMatchObject({ nummer: 11, fil: 'V11__b.sql' });
    expect(V.hoyesteMigrasjon(['1_a.sql'], '([')).toBeNull();
  });

  it('tittelen: tavle.tittel, med prosjektnavnet når det er satt', () => {
    expect(V.tavleTittel({ tavle: { tittel: 'Køtavla' }, prosjektNavn: 'alfa' })).toBe(
      'Køtavla · alfa',
    );
    expect(V.tavleTittel({ tavle: { tittel: 'Køtavla' }, prosjektNavn: 'prosjektet' })).toBe(
      'Køtavla',
    );
    expect(V.tavleTittel({})).toBe('Køtavla');
  });

  it('grenen på kortet følger grenprefikset (standard ko/)', () => {
    const ko = { oppgaver: [{ id: 'A-1', status: 'venter' } as O2] };
    expect(V.tavle(ko).kolonner.ko[0].gren).toBe('ko/A-1');
    expect(V.tavle(ko, { grenPrefiks: 'arbeid/' }).kolonner.ko[0].gren).toBe('arbeid/A-1');
  });
  it('tavla sier om nattpausen stopper nye starter nå', () => {
    const natt = Date.parse('2026-09-30T21:30:00Z'); // 23:30 i Oslo
    expect(
      V.tavle({ oppgaver: [], grenser: { nattkjoring: false } }, { naa: natt }).natt,
    ).toMatchObject({
      aktiv: true,
      stopp: true,
    });
    expect(V.tavle({ oppgaver: [] }, { naa: natt }).natt).toEqual({ aktiv: false, stopp: false });
  });
});

// =============================================================
// «låser opp N», kjeden, «Neste opp», aldrende arbeid, «Venter på deg» og vaktregel 15.
// =============================================================
type O3 = O2 & { venter_paa?: string[] };
type Ko3 = Omit<Ko2, 'oppgaver'> & {
  oppgaver: O3[];
  sporsmal?: Record<
    string,
    { type: string; tekst: string; anbefaling?: string; lagt_til?: string }
  >;
  avklaringer?: Record<
    string,
    { tid: string; svar: string | null; av: string | null; logget?: boolean }
  >;
};
type Las = { antall: number; minutter: number; direkte: string[]; ider: string[] };
type Neste = {
  stopp: string | null;
  tekst: string | null;
  ledige: number;
  starter: { id: string; tittel: string }[];
  naarLedig: { id: string; tittel: string }[];
};
type Aldring = { maal: string; grense: number; alder: number } | null;
type Grenser = Record<string, { arbeid: number | null; syklus: number | null }>;
type Innboks = {
  antall: number;
  sporsmal: {
    sp: string;
    type: string;
    tekst: string | null;
    direkte: string[];
    antall: number;
    minutter: number;
  }[];
  qa: { pid: string; funksjoner: { funksjon: string; oppgaver: { id: string }[] }[] }[];
  qaAntall: number;
  forslag: { id: string }[];
  henger: { id: string; status: string; aldrende: Aldring }[];
  ulogget: { sp: string }[];
};
type Kort3 = Kort & {
  aldrende: Aldring;
  laaser_opp: { antall: number; minutter: number; direkte: string[] } | null;
  kjede: { for: string[]; etter: string[] } | null;
};
type Tavle3 = Omit<Tavle, 'kolonner'> & {
  kolonner: Record<'ko' | 'forslag' | 'pagar' | 'review' | 'bygget', Kort3[]>;
  neste: Neste;
  innboks: Innboks;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const K3 = require('../koTavle') as {
  NESTE_NAAR_FULL: number;
  laaserOpp: (ko: Ko3, id: string) => Las;
  kjede: (ko: Ko3, id: string) => { for: string[]; etter: string[] };
  aldrende: (o: O3, grenser: Grenser, naa?: number) => Aldring;
  nesteOpp: (
    ko: Ko3,
    valg?: { naa?: number; ucommittet?: string[]; dagsforbruk?: number },
  ) => Neste;
  tavle: (
    ko: Ko3,
    valg?: { naa?: number; aldersgrenser?: Grenser; dagsforbruk?: number },
  ) => Tavle3;
  vurder: (ko: Ko3, handling: Record<string, unknown>) => Vakt[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L3 = require('../koLogikk') as {
  velgNeste: (ko: Ko3, naa?: number, valg?: { ucommittet?: string[] }) => { id: string }[];
  lasOppAntall: (id: string, alle: O3[]) => number;
  anslag: (o: O3) => number;
};

describe('laaserOpp: «låser opp N»', () => {
  // A ← B ← C ← E(ferdig) ← F, og A ← D (D+). X ⇄ Y er en syklus. K er kansellert og venter på A.
  const ko = (): Ko3 => ({
    oppgaver: [
      opp('A'),
      opp('B', { avhenger: ['A'] }),
      opp('C', { avhenger: ['B'] }),
      opp('D', { avhenger: ['A'], klasse: 'D+' }),
      opp('E', { avhenger: ['C'], status: 'ferdig' }),
      opp('F', { avhenger: ['E'] }),
      opp('K', { avhenger: ['A'], status: 'kansellert' }),
      opp('X', { avhenger: ['Y'] }),
      opp('Y', { avhenger: ['X'] }),
    ],
  });

  it('direkte og transitive etterfølgere som ikke er ferdige, og summen av anslagene', () => {
    const r = K3.laaserOpp(ko(), 'A');
    // E er ferdig og teller ikke, men F bak den gjør det; K er kansellert.
    expect(r.ider).toEqual(['B', 'C', 'D', 'F']);
    expect(r.direkte).toEqual(['B', 'D']);
    expect(r.antall).toBe(4);
    expect(r.minutter).toBe(30 + 30 + L3.anslag(opp('D', { klasse: 'D+' })) + 30);
  });

  it('samme telling som bonusen i prioriteten (koLogikk.lasOppAntall)', () => {
    const k = ko();
    for (const o of k.oppgaver)
      expect(K3.laaserOpp(k, o.id).antall).toBe(L3.lasOppAntall(o.id, k.oppgaver));
  });

  it('sykluser tåles, og kortet selv er aldri med', () => {
    expect(K3.laaserOpp(ko(), 'X').ider).toEqual(['Y']);
    expect(K3.laaserOpp(ko(), 'Y').ider).toEqual(['X']);
    expect(K3.laaserOpp(ko(), 'F')).toEqual({ antall: 0, minutter: 0, direkte: [], ider: [] });
  });
});

describe('kjede: forgjengere og etterfølgere som fortsatt skal gjøres', () => {
  it('forgjengerne transitivt gjennom avhenger, etterfølgerne som laaserOpp', () => {
    const k: Ko3 = {
      oppgaver: [
        opp('A'),
        opp('B', { avhenger: ['A'] }),
        opp('C', { avhenger: ['B', 'UKJENT'] }),
        opp('D', { avhenger: ['C'] }),
        opp('E', { avhenger: ['D'] }),
      ],
    };
    expect(K3.kjede(k, 'C')).toEqual({ for: ['A', 'B'], etter: ['D', 'E'] });
    // En ferdig forgjenger hindrer ingenting og er ikke med, men letingen går gjennom den.
    k.oppgaver[1].status = 'ferdig';
    expect(K3.kjede(k, 'C')).toEqual({ for: ['A'], etter: ['D', 'E'] });
  });

  it('tavla gir kortene kjede og låser opp (null når de mangler)', () => {
    const t = K3.tavle(
      { oppgaver: [opp('A'), opp('B', { avhenger: ['A'] }), opp('Z')] },
      { naa: NAA },
    );
    const kort = (id: string) => t.kolonner.ko.find((x) => x.id === id);
    expect(kort('A')?.laaser_opp).toEqual({ antall: 1, minutter: 30, direkte: ['B'] });
    expect(kort('A')?.kjede).toEqual({ for: [], etter: ['B'] });
    expect(kort('B')?.kjede).toEqual({ for: ['A'], etter: [] });
    expect(kort('Z')?.kjede).toBeNull();
    expect(kort('Z')?.laaser_opp).toBeNull();
  });
});

describe('nesteOpp: «Neste opp» er koLogikk.velgNeste', () => {
  const ko = (): Ko3 => ({
    grenser: { maksSamtidig: 2, maksDPluss: 1 },
    oppgaver: [
      opp('H', { nytte: 9 }),
      opp('M', { nytte: 6 }),
      opp('L', { nytte: 3 }),
      opp('Q', { nytte: 2 }),
      opp('BLOKK', { nytte: 10, venter_paa: ['S1'] }),
    ],
  });

  it('ledige plasser: de velgNeste starter nå, høyst så mange som er ledige', () => {
    const k = ko();
    const n = K3.nesteOpp(k, { naa: NAA });
    expect(n.stopp).toBeNull();
    expect(n.ledige).toBe(2);
    expect(n.starter.map((v) => v.id)).toEqual(L3.velgNeste(k, NAA).map((v) => v.id));
    expect(n.starter.map((v) => v.id)).toEqual(['H', 'M']);
    expect(n.starter[0].tittel).toBe('Oppgave H');
    expect(n.naarLedig).toEqual([]);
  });

  it('fulle plasser: de neste når en plass blir ledig (velgNeste med flere plasser)', () => {
    const k = ko();
    k.oppgaver.push(opp('K1', { status: 'kjorer' }), opp('K2', { status: 'kjorer' }));
    const n = K3.nesteOpp(k, { naa: NAA });
    expect(n.ledige).toBe(0);
    expect(n.starter).toEqual([]);
    expect(n.naarLedig.map((v) => v.id)).toEqual(['H', 'M', 'L']);
    expect(K3.NESTE_NAAR_FULL).toBe(3);
  });

  it('en omprioritering gir en annen rekkefølge med en gang', () => {
    const k = ko();
    const q = k.oppgaver.find((o) => o.id === 'Q');
    if (q) q.prioritet_tillegg = 500;
    expect(K3.nesteOpp(k, { naa: NAA }).starter.map((v) => v.id)).toEqual(['Q', 'H']);
  });

  it('stopper køen, står grunnen der: nattpause, dagskvote, samtidige spor 0', () => {
    const natt = Date.parse('2026-09-30T21:30:00Z'); // 23:30 i Oslo
    const k = ko();
    k.grenser = { ...k.grenser, nattkjoring: false };
    const n = K3.nesteOpp(k, { naa: natt });
    expect(n.stopp).toBe('nattpause');
    expect(n.tekst).toBe('Nattpause til 06:00: ingen nye starter.');
    expect(n.starter).toEqual([]);

    const b = ko();
    b.grenser = { ...b.grenser, dagsbudsjett: 5 };
    expect(K3.nesteOpp(b, { naa: NAA, dagsforbruk: 6 }).stopp).toBe('dagsbudsjett');
    expect(K3.nesteOpp(b, { naa: NAA, dagsforbruk: 1 }).stopp).toBeNull();

    const stengt = ko();
    stengt.grenser = { maksSamtidig: 0 };
    expect(K3.nesteOpp(stengt, { naa: NAA })).toMatchObject({
      stopp: 'maksSamtidig',
      naarLedig: [],
    });
  });

  it('tavla har neste med samme svar', () => {
    const k = ko();
    expect(K3.tavle(k, { naa: NAA }).neste).toEqual(K3.nesteOpp(k, { naa: NAA }));
  });
});

describe('aldrende arbeid: over p85 for klassen', () => {
  const grenser: Grenser = {
    K: { arbeid: 40, syklus: 60 },
    D: { arbeid: null, syklus: null },
  };

  it('kjører: tiden siden start mot p85 av arbeidstiden; review: mot p85 av hele syklusen', () => {
    expect(
      K3.aldrende(opp('A', { status: 'kjorer', startet: timerSiden(1) }), grenser, NAA),
    ).toEqual({ maal: 'arbeid', grense: 40, alder: 60 });
    expect(
      K3.aldrende(opp('A', { status: 'kjorer', startet: timerSiden(0.5) }), grenser, NAA),
    ).toBeNull();
    expect(
      K3.aldrende(
        opp('R', { status: 'review', startet: timerSiden(1.5), levert: timerSiden(1) }),
        grenser,
        NAA,
      ),
    ).toEqual({ maal: 'syklus', grense: 60, alder: 90 });
  });

  it('uten grense (for få ferdige i klassen), eller i kø, markeres ingenting', () => {
    expect(
      K3.aldrende(
        opp('D1', { klasse: 'D', status: 'kjorer', startet: timerSiden(30) }),
        grenser,
        NAA,
      ),
    ).toBeNull();
    expect(K3.aldrende(opp('V', { startet: timerSiden(30) }), grenser, NAA)).toBeNull();
  });

  it('tavla: aldrende erstatter «3 × anslag» for kjørende; 72 t-regelen for plukkede står', () => {
    const t = K3.tavle(
      {
        oppgaver: [
          opp('GML', { status: 'kjorer', startet: timerSiden(10) }),
          opp('NY', { status: 'kjorer', startet: timerSiden(0.25) }),
          opp('PL', { status: 'plukket', plukket_av: 'eier', plukket_at: dagerSiden(4) }),
        ],
      },
      { naa: NAA, aldersgrenser: grenser },
    );
    const kort = (id: string) => t.kolonner.pagar.find((x) => x.id === id);
    expect(kort('GML')?.gammel).toBe(false);
    expect(kort('GML')?.aldrende).toEqual({ maal: 'arbeid', grense: 40, alder: 600 });
    expect(kort('NY')?.aldrende).toBeNull();
    expect(kort('PL')?.gammel).toBe(true);
    // Uten aldersgrenser markeres ingen kjørende, uansett alder.
    const uten = K3.tavle(
      { oppgaver: [opp('GML', { status: 'kjorer', startet: timerSiden(10) })] },
      { naa: NAA },
    );
    expect(uten.kolonner.pagar[0]).toMatchObject({ gammel: false, aldrende: null });
  });
});

describe('innboks: «Venter på deg»', () => {
  const ko = (): Ko3 => ({
    oppgaver: [
      opp('A', { venter_paa: ['S-STOR'] }),
      opp('B', { avhenger: ['A'] }),
      opp('C', { avhenger: ['B'] }),
      opp('D', { venter_paa: ['S-LITEN', 'S-STOR'] }),
      opp('E', { venter_paa: ['S-AVKLART'] }),
      opp('Q1', {
        status: 'ferdig',
        etiketter: ['visuell'],
        qa_status: 'venter',
        funksjon: 'liste',
      }),
      opp('Q2', { status: 'ferdig', etiketter: ['visuell'], qa_status: 'ok' }),
      opp('F1', { status: 'forslag' }),
      opp('K1', { status: 'kjorer', startet: timerSiden(5) }),
      opp('P1', { status: 'plukket', plukket_av: 'eier', plukket_at: dagerSiden(4) }),
    ],
    avklart: ['S-AVKLART'],
    sporsmal: {
      'S-LITEN': { type: 'jurist', tekst: 'Spør juristen.' },
      'S-REG': { type: 'betingelse', tekst: 'Ingen venter ennå.' },
    },
    avklaringer: {
      'S-AVKLART': { tid: NAA_ISO, svar: 'Ja', av: 'eier', logget: false },
    },
  });
  const grenser: Grenser = { K: { arbeid: 60, syklus: 90 } };

  it('spørsmål sortert etter hva svaret låser opp (oppgaver og minutter, transitivt)', () => {
    const i = K3.tavle(ko(), { naa: NAA, aldersgrenser: grenser }).innboks;
    expect(i.sporsmal.map((s) => `${s.sp}:${s.antall}:${s.minutter}`)).toEqual([
      'S-STOR:4:120', // A og D venter direkte, B og C via kjeden
      'S-LITEN:1:30',
      'S-REG:0:0', // registrert, men ingen venter ennå
    ]);
    expect(i.sporsmal[0]).toMatchObject({ type: 'sporsmal', tekst: null, direkte: ['A', 'D'] });
    expect(i.sporsmal[1]).toMatchObject({ type: 'jurist', tekst: 'Spør juristen.' });
    expect(i.sporsmal.some((s) => s.sp === 'S-AVKLART')).toBe(false);
  });

  it('QA (bare som venter), forslag, det som henger, uloggede avklaringer og antallet', () => {
    const i = K3.tavle(ko(), { naa: NAA, aldersgrenser: grenser }).innboks;
    expect(i.qa).toHaveLength(1);
    expect(i.qa[0].funksjoner).toEqual([
      { funksjon: 'liste', oppgaver: [expect.objectContaining({ id: 'Q1' })] },
    ]);
    expect(i.qaAntall).toBe(1);
    expect(i.forslag.map((f) => f.id)).toEqual(['F1']);
    // Eldste først (som Pågår-kolonnen).
    expect(i.henger.map((h) => `${h.id}:${h.status}`)).toEqual(['P1:plukket', 'K1:kjorer']);
    expect(i.henger[1].aldrende).toMatchObject({ maal: 'arbeid', grense: 60 });
    expect(i.ulogget.map((x) => x.sp)).toEqual(['S-AVKLART']);
    // Uloggede avklaringer er info til orkestratoren og telles ikke.
    expect(i.antall).toBe(3 + 1 + 1 + 2);
  });

  it('tom innboks: antall 0', () => {
    expect(K3.tavle({ oppgaver: [opp('A')] }, { naa: NAA }).innboks).toMatchObject({
      antall: 0,
      sporsmal: [],
      qa: [],
      forslag: [],
      henger: [],
      ulogget: [],
    });
  });
});

describe('vurder: 15. svar på et eierspørsmål', () => {
  const ko: Ko3 = {
    oppgaver: [],
    sporsmal: { BET: { type: 'betingelse', tekst: 'Biblioteket er stabilt.' } },
  };
  it('tomt svar stopper; betingelse og jurist får «oppfylt»-teksten', () => {
    expect(K3.vurder(ko, { type: 'avklar', sp: 'SP8', tekst: '  ' })).toEqual([
      {
        nivaa: 'stopp',
        tekst: 'Skriv svaret før du avklarer: sporene som venter, bygger på det.',
      },
    ]);
    expect(K3.vurder(ko, { type: 'avklar', sp: 'BET', tekst: '' })[0].tekst).toContain('oppfylt');
    expect(K3.vurder(ko, { type: 'avklar', sp: 'SP8', tekst: 'Avklart med leverandøren' })).toEqual([]);
  });
});
