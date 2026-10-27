// =============================================================
// koGraf.test.ts: visningen «Avhengigheter» på kanban-tavla (lib/koGraf.js).
//
// Testene beviser at grafen:
//   - viser bare oppgaver i en avhengighet (eller som venter på et eierspørsmål), med frittstående og ferdige som valg,
//   - holder kjeden hel med grå naboer når filteret skjuler en forgjenger eller etterfølger,
//   - har eierspørsmål som egne noder med kanter til oppgavene som venter på dem,
//   - lagdeler fra venstre mot høyre (lengste sti), ordner lagene med barysenter og er deterministisk,
//   - tåler sykler (meldes, ingen heng), og legger hvert prosjekt i sitt eget bånd per prosjekt,
//   - teller oppsummeringen riktig.
// Inndata er formen koTavle.tavle gir; en egen test bygger tilstanden med koTavle.tavle fra en liten kø.
// =============================================================
import { describe, it, expect } from 'vitest';

type Node = {
  id: string;
  art: 'oppgave' | 'sporsmal';
  rolle: 'kjerne' | 'nabo' | 'ferdig' | 'fri';
  tilstand?: string;
  prosjekt: string | null;
  laaser: number;
  r: number;
  x: number;
  y: number;
  lag: number | null;
  type?: string;
};
type Kant = { fra: string; til: string; art: 'avh' | 'sp'; dempet: boolean; sykel?: boolean };
type Graf = { noder: Node[]; kanter: Kant[]; prosjekter: { pid: string }[] };
type Oppsett = {
  noder: Node[];
  kanter: Kant[];
  baner: { pid: string | null; tittel: string; y: number; hoyde: number }[];
  komponenter: Ramme[];
  fri: { y: number; antall: number } | null;
  sykler: { fra: string; til: string }[];
  antallLag: number;
  lesbarSkala: number;
  bredde: number;
  hoyde: number;
};
type Ramme = { x: number; y: number; bredde: number; hoyde: number; antall: number };
type Kort = {
  id: string;
  status?: string;
  klar?: boolean;
  avhenger?: string[];
  prosjekt?: string;
  anslag?: number;
  tittel?: string;
  qa_status?: string;
  laaser_opp?: { antall: number } | null;
};

const G = require('../koGraf') as {
  SP: string;
  MAAL: { rMin: number; rMaks: number; rLiten: number };
  radius: (m: number) => number;
  byggGraf: (
    data: unknown,
    valg?: {
      synlig?: (k: Kort, kol: string) => boolean;
      visFerdige?: boolean;
      visFrittstaende?: boolean;
      naboer?: boolean;
    },
  ) => Graf;
  lagdel: (
    g: Graf,
    valg?: { modus?: 'samlet' | 'prosjekt'; flate?: { bredde: number; hoyde: number } },
  ) => Oppsett;
  grafTall: (g: Graf | Oppsett) => {
    oppgaver: number;
    sporsmal: number;
    blokkertAvSporsmal: number;
    lengsteKjede: number;
    blokkert: number;
  };
};

/** Tilstanden slik koTavle.tavle gir den: kortene i kolonner, innboksen og prosjektene. */
function data(
  kort: (Kort & { kol?: string })[],
  sporsmal: { sp: string; direkte: string[]; antall?: number; type?: string }[] = [],
  prosjekter = ['a', 'b'],
) {
  const kolonner: Record<string, Kort[]> = {
    ko: [],
    forslag: [],
    pagar: [],
    review: [],
    bygget: [],
  };
  for (const { kol, ...k } of kort) {
    const status = k.status ?? 'venter';
    const kolonne =
      kol ??
      (status === 'ferdig'
        ? 'bygget'
        : status === 'venter'
          ? 'ko'
          : status === 'review'
            ? 'review'
            : 'pagar');
    kolonner[kolonne].push({
      prosjekt: 'a',
      anslag: 40,
      tittel: `Tittel ${k.id}`,
      klar: !(k.avhenger ?? []).length,
      avhenger: [],
      ...k,
      status,
    });
  }
  return {
    kolonner,
    innboks: {
      sporsmal: sporsmal.map((s) => ({ type: 'sporsmal', antall: s.direkte.length, ...s })),
    },
    prosjekter: prosjekter.map((pid) => ({
      pid,
      tittel: `Prosjekt ${pid}`,
      farge: 'kategori-teal',
    })),
  };
}

const ider = (g: { noder: Node[] }) => g.noder.map((n) => n.id).sort();
const node = (g: { noder: Node[] }, id: string) => g.noder.find((n) => n.id === id) as Node;

describe('byggGraf: hvilke oppgaver som vises', () => {
  const d = data([
    { id: 'A' },
    { id: 'B', avhenger: ['A'] },
    { id: 'C', avhenger: ['B'] },
    { id: 'F' }, // frittstående
    { id: 'D', status: 'ferdig' },
    { id: 'E', avhenger: ['D'] },
    { id: 'Q' }, // venter på et eierspørsmål, ellers frittstående
  ]);
  d.innboks.sporsmal.push({ sp: 'SP-1', direkte: ['Q'], antall: 1, type: 'jurist' });

  it('standard: bare oppgaver i en avhengighet eller som venter på et spørsmål; ferdige og frittstående skjult', () => {
    const g = G.byggGraf(d);
    expect(ider(g)).toEqual(['?SP-1', 'A', 'B', 'C', 'E', 'Q']);
    expect(g.kanter.filter((k) => k.art === 'avh').map((k) => `${k.fra}>${k.til}`)).toEqual([
      'A>B',
      'B>C',
    ]);
  });

  it('«Vis ferdige»: ferdige forgjengere som små, dempede sirkler med dempet kant', () => {
    const g = G.byggGraf(d, { visFerdige: true });
    const n = node(g, 'D');
    expect(n.rolle).toBe('ferdig');
    expect(n.r).toBe(G.MAAL.rLiten);
    expect(g.kanter.find((k) => k.fra === 'D')).toMatchObject({ til: 'E', dempet: true });
  });

  it('«Vis frittstående»: resten kommer med som rolle fri', () => {
    const g = G.byggGraf(d, { visFrittstaende: true });
    expect(node(g, 'F').rolle).toBe('fri');
    expect(g.kanter.some((k) => k.fra === 'F' || k.til === 'F')).toBe(false);
  });

  it('spørsmål: egen node med type og «låser opp N», stiplet kant (art sp) til oppgaven som venter', () => {
    const g = G.byggGraf(d);
    const s = node(g, '?SP-1');
    expect(s).toMatchObject({ art: 'sporsmal', type: 'jurist', laaser: 1 });
    expect(g.kanter.filter((k) => k.art === 'sp')).toEqual([
      { fra: '?SP-1', til: 'Q', art: 'sp', dempet: false },
    ]);
  });

  it('ukjente forgjengere (kansellert eller slettet) og egen id gir ingen kant', () => {
    const g = G.byggGraf(data([{ id: 'X', avhenger: ['FINNES-IKKE', 'X'] }, { id: 'Y' }]));
    expect(g.noder).toEqual([]);
    expect(g.kanter).toEqual([]);
  });

  it('status i ringen: klar, blokkert, aktiv (kjører/plukket/review) og qa (ferdig som venter på QA)', () => {
    const g = G.byggGraf(
      data([
        { id: 'K1', status: 'kjorer' },
        { id: 'K2', avhenger: ['K1'], klar: false },
        { id: 'K3', status: 'ferdig', qa_status: 'venter' },
        { id: 'K4', avhenger: ['K3'], klar: true },
        { id: 'K5', status: 'review', avhenger: ['K4'] },
      ]),
      { visFerdige: true },
    );
    expect(node(g, 'K1').tilstand).toBe('aktiv');
    expect(node(g, 'K2').tilstand).toBe('blokkert');
    expect(node(g, 'K3').tilstand).toBe('qa');
    expect(node(g, 'K4').tilstand).toBe('klar');
    expect(node(g, 'K5').tilstand).toBe('aktiv');
  });

  it('radius: arealet følger minuttene, med min- og maksgrense', () => {
    expect(G.radius(0)).toBe(G.MAAL.rMin);
    expect(G.radius(10_000)).toBe(G.MAAL.rMaks);
    expect(G.radius(40)).toBeGreaterThan(G.radius(20));
    // Arealet (r²) er proporsjonalt med minuttene innenfor grensene.
    expect(G.radius(80) ** 2 / G.radius(20) ** 2).toBeCloseTo(4, 1);
  });
});

describe('byggGraf: naboer utenfor filteret', () => {
  const d = data([
    { id: 'A', prosjekt: 'a' },
    { id: 'B', prosjekt: 'b', avhenger: ['A'] },
    { id: 'C', prosjekt: 'a', avhenger: ['B'] },
    { id: 'Z', prosjekt: 'b', avhenger: ['A'] },
  ]);
  const baraA = (k: Kort) => k.prosjekt === 'a';

  it('en skjult forgjenger eller etterfølger vises som en liten grå nabo, så kjeden ikke brytes', () => {
    const g = G.byggGraf(d, { synlig: baraA });
    expect(node(g, 'B')).toMatchObject({ rolle: 'nabo', r: G.MAAL.rLiten });
    expect(node(g, 'Z')).toMatchObject({ rolle: 'nabo' });
    expect(g.kanter.map((k) => `${k.fra}>${k.til}`)).toEqual(['A>B', 'A>Z', 'B>C']);
  });

  it('naboer kan skrus av: da vises bare det filteret viser', () => {
    const g = G.byggGraf(d, { synlig: baraA, naboer: false });
    expect(ider(g)).toEqual(['A', 'C']);
    expect(g.kanter).toEqual([]);
  });

  it('bare én kant unna: naboens naboer tas ikke med', () => {
    const g = G.byggGraf(
      data([
        { id: 'A', prosjekt: 'b' },
        { id: 'B', prosjekt: 'b', avhenger: ['A'] },
        { id: 'C', avhenger: ['B'] },
      ]),
      { synlig: baraA },
    );
    expect(ider(g)).toEqual(['B', 'C']);
  });
});

describe('lagdel: lag, rekkefølge og determinisme', () => {
  const kjede = data([
    { id: 'A' },
    { id: 'B', avhenger: ['A'] },
    { id: 'C', avhenger: ['B'] },
    { id: 'D', avhenger: ['A', 'C'] }, // lengste sti: A-B-C-D, så D i lag 3
    { id: 'Q', avhenger: ['C'] },
  ]);
  kjede.innboks.sporsmal.push({ sp: 'S', direkte: ['Q'], antall: 1, type: 'sporsmal' });

  it('lagene gis av lengste sti; forgjengere til venstre for etterfølgerne', () => {
    const o = G.lagdel(G.byggGraf(kjede));
    expect(['A', 'B', 'C', 'D'].map((id) => node(o, id).lag)).toEqual([0, 1, 2, 3]);
    for (const k of o.kanter) expect(node(o, k.fra).x).toBeLessThan(node(o, k.til).x);
    expect(o.antallLag).toBe(4);
  });

  it('et spørsmål står rett før oppgaven som venter på det (kilden trekkes mot høyre)', () => {
    const o = G.lagdel(G.byggGraf(kjede));
    expect(node(o, '?S').lag).toBe((node(o, 'Q').lag as number) - 1);
  });

  it('nodene i et lag overlapper ikke, og kommer i lag-rekkefølge (tastaturets fokusrekkefølge)', () => {
    const o = G.lagdel(G.byggGraf(kjede));
    const lagVerdier = o.noder.map((n) => n.lag as number);
    expect(lagVerdier).toEqual([...lagVerdier].sort((a, b) => a - b));
    const perLag = new Map<number, Node[]>();
    for (const n of o.noder)
      perLag.set(n.lag as number, [...(perLag.get(n.lag as number) ?? []), n]);
    for (const l of perLag.values())
      for (let i = 1; i < l.length; i++)
        expect(l[i].y - l[i - 1].y).toBeGreaterThanOrEqual(l[i].r + l[i - 1].r);
  });

  it('barysenteret gir færre kryssinger: to kjeder som starter i «feil» rekkefølge rettes opp', () => {
    // Lag 0: A1 < B1 (id). Lag 1: A2 < B2, men A2 henger på B1 og B2 på A1: startrekkefølgen krysser.
    const d = data([
      { id: 'A1' },
      { id: 'B1' },
      { id: 'A2', avhenger: ['B1'] },
      { id: 'B2', avhenger: ['A1'] },
      { id: 'C', avhenger: ['A2', 'B2'] }, // én komponent, så begge kjedene legges ut sammen
    ]);
    const o = G.lagdel(G.byggGraf(d));
    const y = (id: string) => node(o, id).y;
    // Etter sveipene står hver etterfølger på samme side som forgjengeren sin: ingen kryssing.
    expect(Math.sign(y('A1') - y('B1'))).toBe(Math.sign(y('B2') - y('A2')));
  });

  it('deterministisk: samme kø gir samme bilde, også med oppgavene i en annen rekkefølge', () => {
    const d1 = data([
      { id: 'A' },
      { id: 'B', avhenger: ['A'] },
      { id: 'C', avhenger: ['A'] },
      { id: 'D', avhenger: ['B', 'C'] },
      { id: 'E', avhenger: ['C'] },
    ]);
    const d2 = { ...d1, kolonner: { ...d1.kolonner, ko: [...d1.kolonner.ko].reverse() } };
    const a = G.lagdel(G.byggGraf(d1));
    const b = G.lagdel(G.byggGraf(d2));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(G.lagdel(G.byggGraf(d1)))).toBe(JSON.stringify(a));
  });

  it('sykler tåles: oppsettet henger ikke, alle noder får plass, og sykelkanten meldes', () => {
    const d = data([
      { id: 'A', avhenger: ['C'] },
      { id: 'B', avhenger: ['A'] },
      { id: 'C', avhenger: ['B'] },
      { id: 'D', avhenger: ['C'] },
    ]);
    const o = G.lagdel(G.byggGraf(d));
    expect(ider(o)).toEqual(['A', 'B', 'C', 'D']);
    expect(o.noder.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(o.sykler.length).toBe(1);
    expect(o.kanter.filter((k) => k.sykel)).toHaveLength(1);
    // Uten sykelkanten er resten en kjede fra venstre mot høyre.
    for (const k of o.kanter.filter((x) => !x.sykel))
      expect(node(o, k.fra).lag).toBeLessThan(node(o, k.til).lag as number);
    expect(G.grafTall(o).lengsteKjede).toBe(4);
  });

  it('tom graf gir et tomt oppsett', () => {
    const o = G.lagdel(G.byggGraf(data([{ id: 'A' }])));
    expect(o).toMatchObject({
      noder: [],
      kanter: [],
      antallLag: 0,
      bredde: 0,
      hoyde: 0,
      fri: null,
    });
  });

  it('frittstående står i et rutenett under grafen, sist i rekkefølgen', () => {
    const o = G.lagdel(
      G.byggGraf(data([{ id: 'A' }, { id: 'B', avhenger: ['A'] }, { id: 'F1' }, { id: 'F2' }]), {
        visFrittstaende: true,
      }),
    );
    expect(o.noder.slice(-2).map((n) => n.id)).toEqual(['F1', 'F2']);
    expect(o.fri).toMatchObject({ antall: 2 });
    const grafBunn = Math.max(node(o, 'A').y, node(o, 'B').y);
    expect(node(o, 'F1').y).toBeGreaterThan(grafBunn);
    expect(node(o, 'F1').y).toBe(node(o, 'F2').y);
    expect(o.hoyde).toBeGreaterThan(node(o, 'F1').y);
  });
});

describe('lagdel: per prosjekt', () => {
  // To kjeder: A1 → A2 og A1 → B1 (to fra a, én fra b: båndet til a), og B2 → B3 (bare b).
  const d = data(
    [
      { id: 'A1', prosjekt: 'a' },
      { id: 'A2', prosjekt: 'a', avhenger: ['A1'] },
      { id: 'B1', prosjekt: 'b', avhenger: ['A1'] },
      { id: 'B2', prosjekt: 'b' },
      { id: 'B3', prosjekt: 'b', avhenger: ['B2'] },
    ],
    [],
    ['b', 'a'], // baneordningen på tavla: b over a
  );
  const inni = (o: Oppsett, id: string, b: { y: number; hoyde: number }) =>
    node(o, id).y > b.y && node(o, id).y < b.y + b.hoyde;

  it('bånd i baneordningen uten overlapp; en kjede står samlet i båndet til prosjektet med flest noder', () => {
    const o = G.lagdel(G.byggGraf(d), { modus: 'prosjekt' });
    expect(o.baner.map((b) => b.pid)).toEqual(['b', 'a']);
    const [bb, ba] = o.baner;
    expect(bb.y + bb.hoyde).toBeLessThanOrEqual(ba.y);
    expect(inni(o, 'B2', bb) && inni(o, 'B3', bb)).toBe(true);
    // B1 hører til b, men kjeden A1-A2-B1 har flest noder fra a og står derfor hel i båndet til a.
    expect(inni(o, 'A1', ba) && inni(o, 'A2', ba) && inni(o, 'B1', ba)).toBe(true);
    expect(node(o, 'B1').lag).toBe(1);
    // Rammene står inne i båndet sitt.
    for (const k of o.komponenter)
      expect(o.baner.some((b) => k.y >= b.y && k.y + k.hoyde <= b.y + b.hoyde)).toBe(true);
  });

  it('kanten mellom prosjekter beholdes', () => {
    const o = G.lagdel(G.byggGraf(d), { modus: 'prosjekt' });
    expect(o.kanter.some((k) => k.fra === 'A1' && k.til === 'B1')).toBe(true);
  });

  it('samlet har ingen bånd', () => {
    expect(G.lagdel(G.byggGraf(d)).baner).toEqual([]);
  });

  it('prosjektfilteret («per kategori»): bare ett bånd, og den grå naboen står i kjedens bånd', () => {
    const o = G.lagdel(G.byggGraf(d, { synlig: (k) => k.prosjekt === 'b' }), { modus: 'prosjekt' });
    expect(node(o, 'A1').rolle).toBe('nabo');
    expect(o.baner.map((b) => b.pid)).toEqual(['b']);
    expect(ider(o)).toEqual(['A1', 'B1', 'B2', 'B3']);
    expect(inni(o, 'A1', o.baner[0])).toBe(true);
  });
});

/**
 * En stor kø (rundt 430 noder i over hundre komponenter, den største på 127): én stor kjede med
 * forgreninger, noen mellomstore og mange på to eller tre. Deterministisk, ingen tilfeldighet.
 */
function ekteForm(prosjekter: string[]) {
  const kort: Kort[] = [];
  let n = 0;
  const ny = (prosjekt: string, avhenger: string[] = [], anslag = 40) => {
    const id = `K${String(++n).padStart(3, '0')}`;
    kort.push({ id, prosjekt, avhenger, anslag });
    return id;
  };
  // Stor kjede: 11 ledd, hvert ledd forgrener seg (ca. 120 noder).
  let forrige = [ny(prosjekter[0])];
  for (let ledd = 1; ledd < 11; ledd++) {
    const neste: string[] = [];
    for (let i = 0; i < Math.min(18, forrige.length + 3); i++)
      neste.push(ny(prosjekter[i % 3], [forrige[i % forrige.length]], 20 + ((i * 7) % 60)));
    forrige = neste;
  }
  // Mellomstore: 8 kjeder på 6-20 noder.
  for (let m = 0; m < 8; m++) {
    let f = ny(prosjekter[(m + 1) % prosjekter.length]);
    for (let i = 1; i < 6 + m * 2; i++)
      f = ny(prosjekter[(m + 1) % prosjekter.length], [i % 3 ? f : kort[kort.length - 2].id]);
  }
  // Mange små: 80 kjeder på 2 eller 3.
  for (let s = 0; s < 80; s++) {
    const p = prosjekter[s % prosjekter.length];
    const a = ny(p);
    const b = ny(p, [a]);
    if (s % 3 === 0) ny(p, [b]);
  }
  return data(kort, [], prosjekter);
}

describe('lagdel: kjedene hver for seg, pakket i rader', () => {
  const overlapper = (a: Ramme, b: Ramme) =>
    a.x < b.x + b.bredde && b.x < a.x + a.bredde && a.y < b.y + b.hoyde && b.y < a.y + a.hoyde;
  const rammeFor = (o: Oppsett, n: Node) =>
    o.komponenter.filter(
      (k) => n.x > k.x && n.x < k.x + k.bredde && n.y > k.y && n.y < k.y + k.hoyde,
    );

  it('komponentene: kjeder som henger sammen (også via et spørsmål) står i samme ramme, andre hver for seg', () => {
    const d = data([
      { id: 'A' },
      { id: 'B', avhenger: ['A'] },
      { id: 'C' },
      { id: 'D', avhenger: ['C'] },
      { id: 'E' },
      { id: 'F' },
    ]);
    d.innboks.sporsmal.push({ sp: 'S', direkte: ['B', 'E'], antall: 2, type: 'sporsmal' });
    d.innboks.sporsmal.push({ sp: 'T', direkte: ['F'], antall: 1, type: 'sporsmal' });
    const o = G.lagdel(G.byggGraf(d));
    // {A, B, ?S, E} (svakt sammenhengende via S), {C, D}, {?T, F}.
    expect(o.komponenter.map((k) => k.antall)).toEqual([4, 2, 2]);
    const hvor = (id: string) => o.komponenter.indexOf(rammeFor(o, node(o, id))[0]);
    expect(new Set(['A', 'B', '?S', 'E'].map(hvor))).toEqual(new Set([0]));
    expect(hvor('C')).toBe(hvor('D'));
    expect(hvor('?T')).toBe(hvor('F'));
    expect(new Set([hvor('A'), hvor('C'), hvor('F')]).size).toBe(3);
    // Hver komponent starter i sitt eget lag 0, og fokusrekkefølgen går komponent for komponent.
    expect(node(o, 'C').lag).toBe(0);
    expect(o.noder.slice(0, 4).map((n) => hvor(n.id))).toEqual([0, 0, 0, 0]);
  });

  it('pakkingen: største først, ingen overlapp, hver node i nøyaktig én ramme, og luft mellom rammene', () => {
    const o = G.lagdel(G.byggGraf(ekteForm(['a', 'b', 'c', 'd'])));
    const antall = o.komponenter.map((k) => k.antall);
    expect(antall[0]).toBe(Math.max(...antall));
    expect(antall).toEqual([...antall].sort((a, b) => b - a));
    for (let i = 0; i < o.komponenter.length; i++)
      for (let j = i + 1; j < o.komponenter.length; j++)
        expect(overlapper(o.komponenter[i], o.komponenter[j])).toBe(false);
    for (const n of o.noder) expect(rammeFor(o, n)).toHaveLength(1);
    // Nodene i en ramme overlapper ikke hverandre.
    for (let i = 0; i < o.noder.length; i++)
      for (let j = i + 1; j < o.noder.length; j++) {
        const a = o.noder[i];
        const b = o.noder[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r);
      }
  });

  it('en kø som den ekte fyller en flate på 1600 × 800: sideforholdet i nærheten av flatens, og lesbare sirkler', () => {
    const o = G.lagdel(G.byggGraf(ekteForm(['a', 'b', 'c', 'd'])), {
      flate: { bredde: 1600, hoyde: 800 },
    });
    // Før pakkingen: én søyle, sideforhold ca. 0,2. Nå omtrent som flaten (2).
    expect(o.bredde / o.hoyde).toBeGreaterThan(1);
    expect(o.bredde / o.hoyde).toBeLessThan(4);
    // «Tilpass» med alt synlig: de fleste sirklene (90 % av kjernen) er minst 6 px.
    const skala = Math.min(1600 / (o.bredde + 20), 800 / (o.hoyde + 20));
    expect(skala).toBeGreaterThanOrEqual(o.lesbarSkala);
    const d = o.noder.filter((n) => n.rolle === 'kjerne').map((n) => 2 * n.r * skala);
    expect(d.filter((x) => x >= 6).length / d.length).toBeGreaterThanOrEqual(0.9);
  });

  it('en høy flate gir en smalere pakking enn en bred', () => {
    const g = G.byggGraf(ekteForm(['a', 'b']));
    const bred = G.lagdel(g, { flate: { bredde: 1600, hoyde: 800 } });
    const hoy = G.lagdel(g, { flate: { bredde: 800, hoyde: 1600 } });
    expect(bred.bredde / bred.hoyde).toBeGreaterThan(hoy.bredde / hoy.hoyde);
  });

  it('deterministisk: samme kø i en annen rekkefølge gir samme pakking', () => {
    const d1 = ekteForm(['a', 'b', 'c']);
    const d2 = { ...d1, kolonner: { ...d1.kolonner, ko: [...d1.kolonner.ko].reverse() } };
    expect(JSON.stringify(G.lagdel(G.byggGraf(d2)))).toBe(JSON.stringify(G.lagdel(G.byggGraf(d1))));
  });

  it('per prosjekt: pakking i hvert bånd, båndene stablet uten overlapp, alle rammer inne i et bånd', () => {
    const o = G.lagdel(G.byggGraf(ekteForm(['a', 'b', 'c', 'd'])), {
      modus: 'prosjekt',
      flate: { bredde: 1600, hoyde: 800 },
    });
    expect(o.baner.map((b) => b.pid)).toEqual(['a', 'b', 'c', 'd']);
    for (let i = 1; i < o.baner.length; i++)
      expect(o.baner[i - 1].y + o.baner[i - 1].hoyde).toBeLessThanOrEqual(o.baner[i].y);
    for (const k of o.komponenter) {
      expect(o.baner.some((b) => k.y >= b.y && k.y + k.hoyde <= b.y + b.hoyde)).toBe(true);
      expect(k.x + k.bredde).toBeLessThanOrEqual(o.bredde);
    }
    for (let i = 0; i < o.komponenter.length; i++)
      for (let j = i + 1; j < o.komponenter.length; j++)
        expect(overlapper(o.komponenter[i], o.komponenter[j])).toBe(false);
    // Bredden brukes: minst ett bånd har mer enn én komponent side om side.
    const rader = new Set(o.komponenter.map((k) => k.y));
    expect(rader.size).toBeLessThan(o.komponenter.length);
    // Enten er alt synlig lesbart, eller så fyller «Tilpass» bredden med lesbare sirkler (og man ruller).
    const iBredden = 1600 / (o.bredde + 20);
    expect(iBredden).toBeGreaterThanOrEqual(o.lesbarSkala);
  });
});

describe('grafTall', () => {
  it('oppgaver i kjeder, spørsmål som blokkerer (via kjeden), lengste kjede og blokkerte', () => {
    const d = data(
      [
        { id: 'A' },
        { id: 'B', avhenger: ['A'], klar: false },
        { id: 'C', avhenger: ['B'], klar: false },
        { id: 'Q', klar: false },
        { id: 'R', avhenger: ['Q'], klar: false },
        { id: 'F' },
      ],
      [
        { sp: 'S1', direkte: ['Q'], antall: 2 },
        { sp: 'S2', direkte: ['B'], antall: 2 },
      ],
    );
    const t = G.grafTall(G.byggGraf(d, { visFrittstaende: true }));
    expect(t).toEqual({
      oppgaver: 5, // A, B, C, Q, R (F er frittstående)
      sporsmal: 2,
      blokkertAvSporsmal: 4, // Q, R (S1) og B, C (S2)
      lengsteKjede: 3, // A-B-C
      blokkert: 4,
    });
  });

  it('et tomt oppsett gir bare nuller', () => {
    expect(G.grafTall({ noder: [], kanter: [], prosjekter: [] })).toEqual({
      oppgaver: 0,
      sporsmal: 0,
      blokkertAvSporsmal: 0,
      lengsteKjede: 0,
      blokkert: 0,
    });
  });
});

describe('med ekte tilstand fra koTavle.tavle', () => {
  it('kortene fra tavla gir grafen uten egne regler (klar, låser opp og spørsmål fra koTavle)', () => {
    const T = require('../koTavle') as { tavle: (ko: unknown, valg?: unknown) => unknown };
    const ko = {
      oppgaver: [
        { id: 'X1', tittel: 'x1', status: 'venter', klasse: 'K', innhold_min: 30 },
        { id: 'X2', tittel: 'x2', status: 'venter', klasse: 'K', avhenger: ['X1'] },
        { id: 'X3', tittel: 'x3', status: 'venter', klasse: 'K', venter_paa: ['SP-X'] },
      ],
      avklart: [],
    };
    const tilstand = T.tavle(ko, { naa: Date.parse('2026-10-01T12:00:00Z') });
    const g = G.byggGraf(tilstand);
    expect(ider(g)).toEqual(['?SP-X', 'X1', 'X2', 'X3']);
    expect(node(g, 'X1')).toMatchObject({ tilstand: 'klar', laaser: 1 });
    expect(node(g, 'X2').tilstand).toBe('blokkert');
    expect(node(g, 'X3').tilstand).toBe('blokkert');
    expect(G.grafTall(g)).toMatchObject({
      oppgaver: 3,
      sporsmal: 1,
      blokkertAvSporsmal: 1,
      lengsteKjede: 2,
    });
  });
});
