// =============================================================
// koPlanStruktur.test.ts: trekartet og avhengighetene i Planer-rommet (se docs/board.md).
// Reglene er rene funksjoner i lib/koPlanVisning.js og lib/koGraf.js (samme filer som
// nettleseren laster), så de testes direkte: nivået og zoomen (filteret), feltene (areal = estimat, farge =
// prioritet, fyll = bygget), squarified-rutene, grafen for utvalget eller valgt post med naboene, blokkert og den
// kritiske veien. I tillegg leses struktur.js, planer.js, index.html og ko-tavle.mjs som tekst for koblingene.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../koPlanVisning.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../koPlan.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const G = require('../koGraf.js');

const KLIENT = join(__dirname, '..', '..', 'ko-tavle');

type Post = Record<string, unknown>;

function post(id: string, ekstra: Post = {}): Post {
  return {
    id,
    tittel: `Tittel ${id}`,
    prosjekt: 'eksport',
    modul: 'alfa',
    prioritet: 'senere',
    modenhet: 'ide',
    estimat: 'M',
    avhenger: [],
    ferdige: 0,
    totalt: 0,
    ...ekstra,
  };
}

const DATA = {
  moduler: [
    { oid: 'alfa', tittel: 'Alfa' },
    { oid: 'beta', tittel: 'Beta' },
  ],
  prosjekter: {
    eksport: { tittel: 'Eksport (risiko)', kort: 'Eksport', omrade: 'alfa' },
    import: { tittel: 'Import', kort: 'Import', omrade: 'alfa' },
    planlegging: { tittel: 'Planlegging', kort: 'Planlegging', omrade: 'beta' },
  },
};

describe('nettadressen: vis og avh', () => {
  it('trekart og avh leses og skrives; ukjent visning blir liste', () => {
    expect(V.lesUrl('?rom=planer&vis=trekart').vis).toBe('trekart');
    expect(V.lesUrl('?rom=planer&vis=avh&avh=post').avh).toBe('post');
    expect(V.lesUrl('?rom=planer&vis=tull').vis).toBe('liste');
    expect(V.lesUrl('?rom=planer&avh=tull').avh).toBe('utvalg');
    const t = V.lesUrl('?rom=planer&vis=avh&avh=post&modul=alfa');
    expect(V.skrivUrl(t)).toBe('?rom=planer&modul=alfa&vis=avh&avh=post');
    expect(V.skrivUrl({ ...t, vis: 'trekart' })).toBe('?rom=planer&modul=alfa&vis=trekart');
    expect(V.skrivUrl({ ...t, vis: 'liste' })).toBe('?rom=planer&modul=alfa');
  });
});

describe('trekartet: nivå, felter og zoom', () => {
  it('estimatvekten er den samme som kapasiteten bruker (koPlan.ESTIMAT_SPOR)', () => {
    expect(V.ESTIMAT_VEKT).toEqual(P.ESTIMAT_SPOR);
  });

  it('nivået følger filteret: ingen gir moduler, én modul gir prosjekter, ett prosjekt gir poster', () => {
    expect(V.trekartNiva(V.tomtFilter())).toBe('modul');
    expect(V.trekartNiva({ ...V.tomtFilter(), modul: ['alfa', 'beta'] })).toBe('modul');
    expect(V.trekartNiva({ ...V.tomtFilter(), modul: ['alfa'] })).toBe('prosjekt');
    expect(V.trekartNiva({ ...V.tomtFilter(), prosjekt: ['eksport'] })).toBe('post');
  });

  it('modulnivå: areal = sum av estimatene, farge = prioriteten med mest estimat, fyll = bygget vektet', () => {
    const treff = [
      post('PL-A', { estimat: 'L', prioritet: 'naa', modenhet: 'bygget' }),
      post('PL-B', { estimat: 'S', prioritet: 'senere' }),
      post('PL-C', { estimat: null, prioritet: 'senere' }),
      post('PL-D', { modul: 'beta', prosjekt: 'planlegging', estimat: 'XL', prioritet: 'eier' }),
    ];
    const tk = V.trekartFelter(treff, DATA, V.tomtFilter());
    expect(tk.niva).toBe('modul');
    expect(tk.felter.map((f: { id: string }) => f.id)).toEqual(['beta', 'alfa']);
    const alfa = tk.felter.find((f: { id: string }) => f.id === 'alfa');
    expect(alfa.vekt).toBe(7 + 1 + 1);
    expect(alfa.antall).toBe(3);
    expect(alfa.utenEstimat).toBe(1);
    expect(alfa.prioritet).toBe('naa');
    expect(alfa.bygget).toBeCloseTo(7 / 9, 3);
    expect(alfa.andeler).toEqual([
      { prioritet: 'naa', vekt: 7 },
      { prioritet: 'senere', vekt: 2 },
    ]);
    expect(alfa.zoom).toEqual({ modul: ['alfa'], prosjekt: [] });
    expect(tk.sum).toBe(24);
    expect(tk.utenEstimat).toBe(1);
  });

  it('ved lik vekt vinner prioriteten som står først (Nå før Eier før Senere)', () => {
    const tk = V.trekartFelter(
      [post('PL-A', { prioritet: 'senere' }), post('PL-B', { prioritet: 'naa' })],
      DATA,
      V.tomtFilter(),
    );
    expect(tk.felter[0].prioritet).toBe('naa');
  });

  it('prosjektnivå: kortnavn, «Uten prosjekt» for ukjente, og zoom til prosjektet med modulen beholdt', () => {
    const f = { ...V.tomtFilter(), modul: ['alfa'] };
    const tk = V.trekartFelter(
      [post('PL-A'), post('PL-B', { prosjekt: 'import' }), post('PL-C', { prosjekt: null })],
      DATA,
      f,
    );
    expect(tk.niva).toBe('prosjekt');
    const titler = tk.felter.map((x: { tittel: string }) => x.tittel).sort();
    expect(titler).toEqual(['Eksport', 'Import', 'Uten prosjekt']);
    const eksport = tk.felter.find((x: { id: string }) => x.id === 'eksport');
    expect(eksport.zoom).toEqual({ modul: ['alfa'], prosjekt: ['eksport'] });
    const uten = tk.felter.find((x: { tittel: string }) => x.tittel === 'Uten prosjekt');
    expect(uten.zoom).toEqual({ modul: ['alfa'], prosjekt: [uten.id] });
  });

  it('postnivå: ett felt per post, delvis bygget gir brøken, klikk åpner posten (ingen zoom)', () => {
    const tk = V.trekartFelter(
      [post('PL-A', { modenhet: 'delvis', ferdige: 1, totalt: 4 })],
      DATA,
      { ...V.tomtFilter(), prosjekt: ['eksport'] },
    );
    expect(tk.felter[0]).toMatchObject({ niva: 'post', post: 'PL-A', zoom: null, bygget: 0.25 });
    const tekst = V.trekartTekst(tk.felter[0]);
    expect(tekst.linjer).toEqual(['○ Senere', 'M (2 spor)', '25 % bygget']);
    expect(tekst.etikett).toMatch(/^PL-A: Tittel PL-A\. .*Åpne posten\.$/);
  });

  it('teksten bærer prioriteten med symbol og tekst også for samlede felt (farge er aldri eneste bærer)', () => {
    const tk = V.trekartFelter(
      [post('PL-A', { prioritet: 'naa' }), post('PL-B', { estimat: null })],
      DATA,
      V.tomtFilter(),
    );
    const t = V.trekartTekst(tk.felter[0]);
    expect(t.linjer).toContain('● Nå 2 spor, ○ Senere 1 spor');
    expect(t.linjer).toContain('1 uten estimat');
    expect(t.etikett).toMatch(/Zoom inn\.$/);
  });
});

describe('trekartet: squarified-rutene', () => {
  const flate = { bredde: 1000, hoyde: 600 };
  const areal = (r: { bredde: number; hoyde: number }) => r.bredde * r.hoyde;

  it('fyller flaten, arealet følger vekten og rutene overlapper ikke', () => {
    const felter = [6, 6, 4, 3, 2, 2, 1].map((vekt, i) => ({ id: `f${i}`, vekt }));
    const ruter = V.trekartRuter(felter, flate);
    expect(ruter).toHaveLength(7);
    const sum = ruter.reduce((s: number, r: { bredde: number; hoyde: number }) => s + areal(r), 0);
    expect(sum).toBeCloseTo(600000, -2);
    for (const r of ruter) {
      const vekt = felter.find((f) => f.id === r.id)!.vekt;
      expect(areal(r) / 600000).toBeCloseTo(vekt / 24, 2);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.bredde).toBeLessThanOrEqual(1000.05);
      expect(r.y + r.hoyde).toBeLessThanOrEqual(600.05);
    }
    for (let i = 0; i < ruter.length; i++)
      for (let j = i + 1; j < ruter.length; j++) {
        const a = ruter[i];
        const b = ruter[j];
        const dx = Math.min(a.x + a.bredde, b.x + b.bredde) - Math.max(a.x, b.x);
        const dy = Math.min(a.y + a.hoyde, b.y + b.hoyde) - Math.max(a.y, b.y);
        expect(dx > 0.05 && dy > 0.05).toBe(false);
      }
  });

  it('holder rutene nær kvadratiske (ingen tynne striper for like felt)', () => {
    const ruter = V.trekartRuter(
      Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, vekt: 1 })),
      flate,
    );
    for (const r of ruter) expect(Math.max(r.bredde / r.hoyde, r.hoyde / r.bredde)).toBeLessThan(3);
  });

  it('deterministisk, største først, og felt uten vekt hoppes over', () => {
    const felter = [
      { id: 'a', vekt: 1 },
      { id: 'b', vekt: 5 },
      { id: 'c', vekt: 0 },
    ];
    const r1 = V.trekartRuter(felter, flate);
    expect(r1.map((r: { id: string }) => r.id)).toEqual(['b', 'a']);
    expect(V.trekartRuter(felter, flate)).toEqual(r1);
    expect(V.trekartRuter([], flate)).toEqual([]);
  });

  it('ett felt fyller hele flaten', () => {
    expect(V.trekartRuter([{ id: 'x', vekt: 3 }], flate)).toEqual([
      { id: 'x', x: 0, y: 0, bredde: 1000, hoyde: 600 },
    ]);
  });
});

describe('koGraf.kritiskVei', () => {
  const n = (id: string, vekt: number, aapen = true) => ({ id, vekt, aapen });

  it('den tyngste stien etter vekt, ikke den lengste etter antall', () => {
    const noder = [n('A', 1), n('B', 1), n('C', 1), n('D', 15), n('E', 1)];
    const kanter = [
      { fra: 'A', til: 'B' },
      { fra: 'B', til: 'C' },
      { fra: 'D', til: 'E' },
    ];
    const v = G.kritiskVei(noder, kanter, { vekt: (x: { vekt: number }) => x.vekt });
    expect(v.sti).toEqual(['D', 'E']);
    expect(v.sum).toBe(16);
    expect(v.kanter).toEqual(['D>E']);
  });

  it('går aldri gjennom noder `med` utelukker (ferdige poster), og tåler sykler', () => {
    const noder = [n('A', 2), n('B', 7, false), n('C', 2), n('X', 1), n('Y', 1)];
    const kanter = [
      { fra: 'A', til: 'B' },
      { fra: 'B', til: 'C' },
      { fra: 'X', til: 'Y' },
      { fra: 'Y', til: 'X' },
    ];
    const v = G.kritiskVei(noder, kanter, {
      med: (x: { aapen: boolean }) => x.aapen,
      vekt: (x: { vekt: number }) => x.vekt,
    });
    expect(v.sti).not.toContain('B');
    expect(v.sum).toBe(2);
    expect(G.kritiskVei([], [], {})).toEqual({ sti: [], sum: 0, kanter: [] });
  });

  it('lik sum: flest ledd, så laveste id (deterministisk)', () => {
    const noder = [n('A', 2), n('B', 1), n('C', 1)];
    const v = G.kritiskVei(noder, [{ fra: 'B', til: 'C' }], {
      vekt: (x: { vekt: number }) => x.vekt,
    });
    expect(v.sti).toEqual(['B', 'C']);
  });
});

describe('avhengighetene: planGraf', () => {
  const poster = [
    post('PL-A', { estimat: 'L', prioritet: 'naa' }),
    post('PL-B', { avhenger: ['PL-A'], estimat: 'M' }),
    post('PL-C', { avhenger: ['PL-B'], estimat: 'S' }),
    post('PL-D', { avhenger: ['PL-A'], estimat: 'S', modenhet: 'bygget' }),
    post('PL-E', { estimat: 'XL' }),
    post('PL-F', { avhenger: ['PL-E', 'PL-UKJENT', 'PL-F'], prioritet: 'dropp' }),
  ];

  it('aldri hele registeret: uten filter og søk tegnes ingenting', () => {
    const g = V.planGraf(poster, {
      utvalg: poster.map((p) => p.id),
      heleRegisteret: true,
    });
    expect(g.grunn).toBe('hele-registeret');
    expect(g.noder).toEqual([]);
    expect(V.planGrafTekst(g)).toMatch(/bare for et utvalg/);
  });

  it('for stort utvalg tegnes ikke', () => {
    const g = V.planGraf(poster, { utvalg: ['PL-A', 'PL-B', 'PL-C'], maks: 2 });
    expect(g.grunn).toBe('for-stort');
    expect(V.planGrafTekst(g)).toMatch(/3 poster/);
  });

  it('utvalget: postene med avhengigheter er kjernen, naboene utenfor er små, de uten kanter telles', () => {
    const g = V.planGraf(poster, { utvalg: ['PL-B', 'PL-C', 'PL-E'] });
    expect(g.grunn).toBeNull();
    const roller = Object.fromEntries(
      g.noder.map((x: { id: string; rolle: string }) => [x.id, x.rolle]),
    );
    // PL-E har en etterfølger (PL-F) og kommer derfor med, PL-F som nabo.
    expect(roller).toEqual({
      'PL-A': 'nabo',
      'PL-B': 'kjerne',
      'PL-C': 'kjerne',
      'PL-E': 'kjerne',
      'PL-F': 'nabo',
    });
    expect(g.tall).toMatchObject({ poster: 3, naboer: 2, uten: 0, utvalg: 3 });
    const nabo = g.noder.find((x: { id: string }) => x.id === 'PL-A');
    expect(nabo.r).toBe(G.MAAL.rLiten);
  });

  it('ukjente og egne avhengigheter gir ingen kant; poster uten kanter i utvalget telles som uten', () => {
    const g = V.planGraf(poster, { utvalg: ['PL-F', 'PL-E'] });
    expect(g.kanter).toEqual([
      { fra: 'PL-E', til: 'PL-F', art: 'avh', dempet: false, kritisk: false },
    ]);
    const g2 = V.planGraf([post('PL-X'), post('PL-Y')], { utvalg: ['PL-X', 'PL-Y'] });
    expect(g2.grunn).toBe('ingen-kanter');
    expect(V.planGrafTekst(g2)).toBe('Ingen av de 2 postene i utvalget har avhengigheter.');
  });

  it('blokkert: en åpen post med en åpen forgjenger; bygget forgjenger blokkerer ikke', () => {
    const g = V.planGraf(poster, { modus: 'post', valgt: 'PL-A' });
    const per = Object.fromEntries(g.noder.map((x: { id: string }) => [x.id, x]));
    expect(per['PL-B'].blokkert).toBe(true);
    expect(per['PL-A'].blokkert).toBe(false);
    expect(per['PL-D'].blokkert).toBe(false);
    expect(per['PL-D'].aapen).toBe(false);
    const kantD = g.kanter.find((k: { til: string }) => k.til === 'PL-D');
    expect(kantD.dempet).toBe(false);
  });

  it('valgt post med naboer: posten, forgjengerne og etterfølgerne (ett ledd), posten merket', () => {
    const g = V.planGraf(poster, { modus: 'post', valgt: 'PL-B' });
    expect(g.noder.map((x: { id: string }) => x.id)).toEqual(['PL-A', 'PL-B', 'PL-C']);
    expect(g.noder.find((x: { id: string }) => x.id === 'PL-B').valgt).toBe(true);
    expect(V.planGraf(poster, { modus: 'post', valgt: null }).grunn).toBe('velg-post');
  });

  it('kritisk vei: tyngste kjede av åpne poster (estimatet som vekt), uthevet på noder og kanter', () => {
    const g = V.planGraf(poster, { utvalg: ['PL-A', 'PL-B', 'PL-C', 'PL-D'] });
    expect(g.kritisk.sti).toEqual(['PL-A', 'PL-B', 'PL-C']);
    expect(g.kritisk.sum).toBe(10);
    expect(
      g.noder.filter((x: { kritisk: boolean }) => x.kritisk).map((x: { id: string }) => x.id),
    ).toEqual(['PL-A', 'PL-B', 'PL-C']);
    expect(g.kanter.filter((k: { kritisk: boolean }) => k.kritisk)).toHaveLength(2);
    expect(V.kritiskVeiTekst(g)).toBe('Kritisk vei: PL-A → PL-B → PL-C (ca. 10 spor)');
    expect(V.planGrafTekst(g)).toBe('4 poster, 2 blokkert');
  });

  it('ingen kritisk vei med bare ett åpent ledd', () => {
    const g = V.planGraf(
      [post('PL-A'), post('PL-B', { avhenger: ['PL-A'], modenhet: 'verifisert' })],
      { utvalg: ['PL-A', 'PL-B'] },
    );
    expect(g.kritisk.sti).toEqual([]);
    expect(V.kritiskVeiTekst(g)).toBeNull();
  });

  it('oppsettet går gjennom koGraf.lagdel: venstre mot høyre etter avhengighetene', () => {
    const g = V.planGraf(poster, { utvalg: ['PL-A', 'PL-B', 'PL-C'] });
    const o = G.lagdel(g, { modus: 'samlet' });
    const x = Object.fromEntries(o.noder.map((n: { id: string; x: number }) => [n.id, n.x]));
    expect(x['PL-A']).toBeLessThan(x['PL-B']);
    expect(x['PL-B']).toBeLessThan(x['PL-C']);
  });

  it('nodeteksten har prioritet, modenhet og blokkert som tekst', () => {
    const g = V.planGraf(poster, { modus: 'post', valgt: 'PL-B' });
    const b = g.noder.find((x: { id: string }) => x.id === 'PL-B');
    expect(V.planNodeTekst(b)).toEqual([
      'PL-B: Tittel PL-B',
      '○ Senere, Idé, M',
      'Blokkert: venter på en åpen post',
      'På den kritiske veien',
    ]);
  });
});

describe('koblingene i tavla', () => {
  const struktur = readFileSync(join(KLIENT, 'planer', 'struktur.js'), 'utf8');
  const planer = readFileSync(join(KLIENT, 'planer', 'planer.js'), 'utf8');
  const index = readFileSync(join(KLIENT, 'index.html'), 'utf8');
  const server = readFileSync(join(KLIENT, '..', 'ko-tavle.mjs'), 'utf8');

  it('struktur.js lastes før planer.js og serveres', () => {
    expect(index.indexOf('/planer/struktur.js')).toBeGreaterThan(0);
    expect(index.indexOf('/planer/struktur.js')).toBeLessThan(index.indexOf('/planer/planer.js'));
    expect(index.indexOf('/koGraf.js')).toBeLessThan(index.indexOf('/planer/struktur.js'));
    expect(server).toContain("'/planer/struktur.js'");
  });

  it('struktur.js setter aldri HTML og skriver aldri', () => {
    expect(struktur).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(struktur).not.toMatch(/fetch\(|method:\s*'POST'/);
    expect(struktur).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('planer.js velger visningen og gir zoomen via filteret', () => {
    expect(planer).toContain("['trekart', 'Trekart']");
    expect(planer).toContain("['avh', 'Avhengigheter']");
    expect(planer).toMatch(/zoom: \(del\) => nyttFilter\(/);
  });
});
