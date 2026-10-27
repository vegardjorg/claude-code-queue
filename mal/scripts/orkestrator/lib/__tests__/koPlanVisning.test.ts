// =============================================================
// koPlanVisning.test.ts: de rene reglene for Planer-rommet på køtavla (lib/koPlanVisning.js, se docs/board.md).
//
// Render-tester virker ikke her, så reglene er rene funksjoner (samme fil som nettleseren laster) og testes direkte:
// nettadressen, fasettene med antall, treet med opprullet fremdrift, brødsmulestien og kopier-linjene (bare id og
// titler), «Klargjør for kø», køstatusen med fokustrinn og dataene fra /api/planer. I tillegg leses
// index.html, planer.js, planer.css og ko-tavle.mjs som tekst for koblingene (rom-valget, Fokus-navnet, ruten som bare
// leser, ingen innerHTML, ingen hex og skrift via tokenene).
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../koPlanVisning.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../koPlan.js');

const KLIENT = join(__dirname, '..', '..', 'ko-tavle');
const NAA = new Date('2026-10-15T10:00:00Z');

type Post = Record<string, unknown>;

/** En post slik /api/planer sender den, med standardverdier. */
function post(id: string, ekstra: Post = {}): Post {
  return {
    id,
    tittel: `Tittel ${id}`,
    kort: null,
    prosjekt: 'eksport',
    modul: 'alfa',
    prioritet: 'senere',
    naa_kategori: [],
    prioritet_satt_av: 'agent',
    modenhet: 'ide',
    estimat: 'M',
    frist: null,
    kilder: [],
    roadmap: [],
    eierspm: [],
    juridisk: null,
    jur_apne: 0,
    foreldet: false,
    ferdige: 0,
    totalt: 0,
    ko: [],
    ...ekstra,
  };
}

const DATA = {
  moduler: [
    { oid: 'alfa', tittel: 'Alfa' },
    { oid: 'beta', tittel: 'Beta' },
  ],
  prosjekter: {
    eksport: { tittel: 'Eksport (risiko og varsling)', kort: 'Eksport', omrade: 'alfa' },
    turnus: { tittel: 'Turnus', kort: 'Turnus', omrade: 'beta' },
  },
  poster: [] as Post[],
};

describe('nettadressen', () => {
  it('leser og skriver rom, filtre, søk, post og fane, og tåler å gå fram og tilbake', () => {
    const t = V.lesUrl('?rom=planer&pri=naa,eier&kat=for-prod&q=eksport&post=PL-EKSPORT-1&fane=ko');
    expect(t.rom).toBe('planer');
    expect(t.filter.pri).toEqual(['naa', 'eier']);
    expect(t.filter.kat).toEqual(['for-prod']);
    expect(t.sok).toBe('eksport');
    expect(t.post).toBe('PL-EKSPORT-1');
    expect(t.fane).toBe('ko');
    expect(V.lesUrl(V.skrivUrl(t))).toEqual(t);
  });

  it('kaster ugyldige verdier stille, og Kø er standard uten søkedel', () => {
    const t = V.lesUrl('?rom=noe&pri=naa,tull,naa&post=<script>&fane=x&modul=Alfa!');
    expect(t.rom).toBe('ko');
    expect(t.filter.pri).toEqual(['naa']);
    expect(t.filter.modul).toEqual([]);
    expect(t.post).toBeNull();
    expect(t.fane).toBe('sammendrag');
    expect(V.skrivUrl(V.lesUrl(''))).toBe('');
  });

  it('skriver ikke fanen når ingen post er valgt, og ikke standardfanen', () => {
    const t = V.lesUrl('?rom=planer&fane=ko');
    expect(V.skrivUrl(t)).toBe('?rom=planer');
    expect(V.skrivUrl({ ...t, post: 'PL-A', fane: 'sammendrag' })).toBe('?rom=planer&post=PL-A');
  });

  it('de ferdige visningene er gyldige søkedeler i Planer', () => {
    for (const v of V.FERDIGE_VISNINGER) {
      const t = V.lesUrl(v.sok);
      expect(t.rom).toBe('planer');
      expect(V.antallFiltre(t.filter)).toBeGreaterThan(0);
    }
    expect(
      V.sammeVisning('?rom=planer&pri=dropp&satt=agent', '?satt=agent&pri=dropp&rom=planer'),
    ).toBe(true);
    expect(V.sammeVisning('?rom=planer&pri=naa', '?rom=planer&pri=naa&q=x')).toBe(false);
  });

  it('en egen visning renses (navn uten kontrolltegn, søkedel uten post)', () => {
    expect(
      V.rensEgenVisning({ navn: '  Mine\u0007 ', sok: '?rom=planer&pri=naa&post=PL-A' }),
    ).toEqual({
      navn: 'Mine',
      sok: '?rom=planer&pri=naa',
    });
    expect(V.rensEgenVisning({ navn: '', sok: '?pri=naa' })).toBeNull();
    expect(V.rensEgenVisning(null)).toBeNull();
  });
});

describe('filtrene og fasettene', () => {
  const poster = [
    post('PL-A', { prioritet: 'naa', naa_kategori: ['sikkerhet'] }),
    post('PL-B', {
      prioritet: 'naa',
      naa_kategori: ['for-prod'],
      eierspm: [{ id: 'SP-1', avklart: false }],
    }),
    post('PL-C', { prioritet: 'eier', prosjekt: 'turnus', modul: 'beta' }),
    post('PL-D', { prioritet: 'dropp', prioritet_satt_av: 'agent' }),
    post('PL-E', {
      prioritet: 'senere',
      prosjekt: null,
      modul: null,
      frist: '2026-10-20',
      jur_apne: 1,
    }),
  ];

  it('dropp skjules til prioritetsfilteret tar det med (SP-8)', () => {
    expect(V.filtrer(poster, V.tomtFilter(), '').map((p: Post) => p.id)).toEqual([
      'PL-A',
      'PL-B',
      'PL-C',
      'PL-E',
    ]);
    const f = { ...V.tomtFilter(), pri: ['dropp'], satt: ['agent'] };
    expect(V.filtrer(poster, f, '').map((p: Post) => p.id)).toEqual(['PL-D']);
  });

  it('eller innen en fasett, og mellom fasettene; søket i id og tittel', () => {
    const f = { ...V.tomtFilter(), pri: ['naa', 'eier'], modul: ['alfa'] };
    expect(V.filtrer(poster, f, '').map((p: Post) => p.id)).toEqual(['PL-A', 'PL-B']);
    expect(V.filtrer(poster, V.tomtFilter(), 'tittel pl-c').map((p: Post) => p.id)).toEqual([
      'PL-C',
    ]);
  });

  it('venter på: eieren ved prioritet eier eller åpent eierspørsmål, jurist ved åpne punkter', () => {
    expect(V.venterPaa(poster[1])).toEqual(['eier']);
    expect(V.venterPaa(poster[2])).toEqual(['eier']);
    expect(V.venterPaa(poster[4])).toEqual(['jurist']);
    expect(V.venterPaa(poster[0])).toEqual(['ingen']);
  });

  it('fristbåndene regnes fra dagens dato i Oslo', () => {
    expect(V.fristBand('2026-10-14', NAA)).toBe('forfalt');
    expect(V.fristBand('2026-10-20', NAA)).toBe('30');
    expect(V.fristBand('2026-12-01', NAA)).toBe('90');
    expect(V.fristBand('2027-06-01', NAA)).toBe('senere');
    expect(V.fristBand(null, NAA)).toBe('ingen');
  });

  it('antallet per verdi teller med de andre filtrene, ikke sin egen fasett; tomme verdier skjules', () => {
    const f = { ...V.tomtFilter(), pri: ['naa'] };
    const tall = V.fasettTall(poster, f, '', { ...DATA, naa: NAA });
    const pri = tall.find((x: { id: string }) => x.id === 'pri');
    // Prioritetsfasetten ser bort fra sitt eget valg: alle fem, også Dropp (som da kan krysses av).
    expect(pri.valg.map((v: { verdi: string; antall: number }) => [v.verdi, v.antall])).toEqual([
      ['naa', 2],
      ['eier', 1],
      ['senere', 1],
      ['dropp', 1],
    ]);
    expect(pri.valg[0]).toMatchObject({ tekst: 'Nå', valgt: true });
    const modul = tall.find((x: { id: string }) => x.id === 'modul');
    expect(modul.valg.map((v: { verdi: string }) => v.verdi)).toEqual(['alfa']);
    const kat = tall.find((x: { id: string }) => x.id === 'kat');
    expect(
      kat.valg.map((v: { tekst: string; antall: number }) => `${v.tekst} ${v.antall}`),
    ).toEqual(['sikkerhet 1', 'før prod 1']);
  });

  it('et valgt filter står selv uten treff, så det kan fjernes', () => {
    const f = { ...V.tomtFilter(), modul: ['gamma'] };
    const modul = V.fasettTall(poster, f, '', DATA).find((x: { id: string }) => x.id === 'modul');
    expect(modul.valg.find((v: { verdi: string }) => v.verdi === 'gamma')).toMatchObject({
      antall: 0,
      valgt: true,
    });
  });

  it('brikkene har fasettens navn og verdiens tekst', () => {
    const f = { ...V.tomtFilter(), modul: ['alfa'], pri: ['naa'] };
    expect(V.brikker(f, DATA).map((b: { tekst: string }) => b.tekst)).toEqual([
      'Modul: Alfa',
      'Prioritet: Nå',
    ]);
  });
});

describe('treet og fremdriften', () => {
  it('modul › prosjekt › post i modulenes rekkefølge, «Uten prosjekt» sist og «Uten modul» til slutt', () => {
    const poster = [
      post('PL-V', { prosjekt: 'turnus', modul: 'beta', modenhet: 'bygget' }),
      post('PL-A', { modenhet: 'delvis', ferdige: 1, totalt: 4 }),
      post('PL-X', { prosjekt: 'finnes-ikke' }),
      post('PL-U', { prosjekt: null, modul: null }),
    ];
    const tre = V.tre(poster, DATA);
    expect(tre.map((m: { oid: string }) => m.oid)).toEqual(['alfa', 'beta', V.UTEN_MODUL]);
    expect(tre[0].prosjekter.map((p: { tittel: string }) => p.tittel)).toEqual([
      'Eksport',
      'Uten prosjekt',
    ]);
    expect(tre[0].fremdrift).toEqual({ bygget: 0, n: 2, andel: 0.125 });
    expect(tre[1].fremdrift).toEqual({ bygget: 1, n: 1, andel: 1 });
  });
});

describe('brødsmulestien og kopier-linjene', () => {
  const d = {
    ...DATA,
    poster: [post('PL-EKSPORT-1', { tittel: 'Risikovurdering, innsjekk og varsling' })],
  };

  it('stien bygges fra valgt post, med kopier-linje per nivå', () => {
    const sti = V.brodsmuler({ post: 'PL-EKSPORT-1', filter: V.tomtFilter() }, d);
    expect(sti.map((l: { tekst: string }) => l.tekst)).toEqual([
      'Planer',
      'Alfa',
      'Eksport',
      'PL-EKSPORT-1',
    ]);
    expect(sti.map((l: { kopier: string | null }) => l.kopier)).toEqual([
      null,
      '/planer alfa (Alfa). Instruks:',
      '/planer eksport (Alfa › Eksport). Instruks:',
      '/planer PL-EKSPORT-1 (Alfa › Eksport › Risikovurdering, innsjekk og varsling). Instruks:',
    ]);
    expect(sti[2].filter).toMatchObject({ modul: ['alfa'], prosjekt: ['eksport'] });
  });

  it('uten post: stien følger filteret på én modul og ett prosjekt', () => {
    const f = { ...V.tomtFilter(), prosjekt: ['turnus'] };
    const sti = V.brodsmuler({ post: null, filter: f }, d);
    expect(sti.map((l: { niva: string }) => l.niva)).toEqual(['rom', 'modul', 'prosjekt']);
    expect(sti[1].tekst).toBe('Beta');
  });

  it('kopier-linjene for eierspørsmål og juridiske punkter har prefiks', () => {
    expect(V.kopierLinje('eier', 'SP-EKSPORT-1', ['Alfa', 'Eksport', 'PL-EKSPORT-1'])).toBe(
      '/planer eier SP-EKSPORT-1 (Alfa › Eksport › PL-EKSPORT-1). Instruks:',
    );
    expect(V.kopierLinje('jur', 'J-2', [])).toBe('/planer jur J-2. Instruks:');
  });

  it('linjene inneholder bare id og titler, aldri kort-teksten eller kildene', () => {
    const p = post('PL-HEMMELIG', {
      kort: 'INTERNT INNHOLD',
      kilder: [{ sti: 'docs/notater/x.md' }],
    });
    const linjer = [V.postLinje(p, d), V.klargjor(p, d).linje];
    for (const l of linjer) {
      expect(l).not.toContain('INTERNT');
      expect(l).not.toContain('docs/notater');
    }
  });

  it('kortnavnet for et prosjekt er tittelen fram til parentes eller kolon', () => {
    expect(V.kortNavn('Eksport, import og rapporter (runde 4)', 'x')).toBe(
      'Eksport, import og rapporter',
    );
    expect(V.kortNavn('Juridisk ansvar: tekster', 'x')).toBe('Juridisk ansvar');
    expect(V.kortNavn('', 'pid')).toBe('pid');
  });
});

describe('«Klargjør for kø»', () => {
  it('linja til /legg-til-ko og kontrollene før pakking', () => {
    const p = post('PL-A', {
      modenhet: 'utredet',
      eierspm: [
        { id: 'SP-1', avklart: false },
        { id: 'SP-2', avklart: true },
      ],
      juridisk: {
        punkter: [
          { id: 'J-1', status: 'til-jurist', blokkerer: 'prod' },
          { id: 'J-2', status: 'avklart', blokkerer: 'prod' },
        ],
      },
      kilder: [{ sti: 'docs/notater/utredning.md' }],
    });
    const k = V.klargjor(p, DATA);
    expect(k.linje).toBe('/legg-til-ko PL-A (Alfa › Eksport › Tittel PL-A)');
    expect(k.advarsler).toEqual([
      'Posten er utredet, ikke klar.',
      '1 åpent eierspørsmål: SP-1.',
      '1 åpent juridisk punkt som blokkerer: J-1.',
    ]);
    expect(V.klargjor(post('PL-K', { modenhet: 'klar' }), DATA).advarsler).toEqual([]);
  });
});

describe('køstatusen med fokustrinn', () => {
  it('skiller fokustrinnet fra prioriteten og sier når en oppgave ikke startes', () => {
    expect(V.koStatusTekst({ kolonne: 'ko', gjelder: true, steg: 1, trinn_tittel: 'Alfa' })).toBe(
      'I kø, trinn 2 i fokus (Alfa)',
    );
    expect(V.koStatusTekst({ kolonne: 'ko', gjelder: true, steg: null, utenfor: true })).toBe(
      'I kø, utenfor fokus: startes ikke',
    );
    expect(V.koStatusTekst({ kolonne: 'ko', gjelder: false })).toBe('I kø');
    expect(V.koStatusTekst({ kolonne: 'bygget' })).toBe('Ferdig');
    expect(V.koStatusTekst({ kolonne: null, status: 'kansellert' })).toBe('Kansellert');
  });
});

describe('dataene fra /api/planer', () => {
  const reg = {
    ...P.tomtRegister('2026-10-01T00:00:00Z'),
    poster: [
      {
        id: 'PL-A',
        tittel: 'A',
        prosjekt: 'eksport',
        prioritet: 'senere',
        modenhet: 'planlagt',
        eierspm: ['SP-1'],
      },
      {
        id: 'PL-B',
        tittel: 'B',
        prosjekt: 'eksport',
        prioritet: 'naa',
        naa_kategori: ['viktig'],
        modenhet: 'klar',
        avhenger: ['PL-A'],
      },
    ],
    endringslogg: [
      {
        nr: 1,
        at: '2026-10-02T00:00:00Z',
        av: 'ko.mjs',
        handling: 'plan endre',
        endringer: [
          { samling: 'poster', id: 'PL-A', felt: 'prioritet', for: 'naa', etter: 'senere' },
        ],
      },
    ],
    aktiv_okt: [{ post: 'PL-B', at: '2026-10-15T09:30:00Z', av: 'planer' }],
  };
  const ko = {
    omrader: { beta: { tittel: 'Beta' }, alfa: { tittel: 'Alfa' } },
    prosjekter: { eksport: { tittel: 'Eksport (risiko)', omrade: 'alfa' } },
    oppgaver: [
      {
        id: 'A-1',
        tittel: 'Første',
        status: 'ferdig',
        plan: 'PL-A',
        ferdig: '2026-10-03T00:00:00Z',
      },
      { id: 'A-2', tittel: 'Andre', status: 'venter', plan: 'PL-A' },
      { id: 'A-3', tittel: 'Kansellert', status: 'kansellert', plan: 'PL-A' },
    ],
    sporsmal: { 'SP-1': { tekst: 'Hva velger vi?' } },
    avklart: [],
  };

  it('sorterer etter prioritetsreglene, avleder modenhet og tar med køstatus, spørsmål, aktiv økt og historikk', () => {
    // Modulene i konfigurasjonens rekkefølge først (her sendt inn), så de andre i køens rekkefølge.
    const koPlan = { ...P, MODULER: [{ oid: 'alfa', tittel: 'Alfa' }] };
    const d = V.planerData(reg, ko, {
      naa: NAA,
      koPlan,
      koInfo: (o: { status: string }) => ({ kolonne: o.status === 'venter' ? 'ko' : 'bygget' }),
    });
    expect(d.moduler.map((m: { oid: string }) => m.oid)).toEqual(['alfa', 'beta']);
    expect(d.les_mapper).toEqual(['docs/']);
    expect(d.prosjekter.eksport.kort).toBe('Eksport');
    expect(d.poster.map((p: Post) => p.id)).toEqual(['PL-B', 'PL-A']);
    const a = d.poster[1];
    expect(a).toMatchObject({
      modul: 'alfa',
      modenhet: 'delvis',
      brok: '1/2',
      ferdige: 1,
      totalt: 2,
      modenhet_plan: 'planlagt',
    });
    expect(a.ko.map((o: { id: string; kolonne: string }) => `${o.id}:${o.kolonne}`)).toEqual([
      'A-1:bygget',
      'A-2:ko',
    ]);
    expect(a.eierspm).toEqual([{ id: 'SP-1', tekst: 'Hva velger vi?', avklart: false, svar: null }]);
    expect(a.blokkerer).toEqual(['PL-B']);
    expect(a.historikk).toEqual([
      {
        nr: 1,
        at: '2026-10-02T00:00:00Z',
        av: 'ko.mjs',
        handling: 'plan endre',
        felt: ['prioritet'],
      },
    ]);
    expect(d.poster[0].aktiv).toEqual({ at: '2026-10-15T09:30:00Z', av: 'planer' });
    // Historikken har bare feltnavn, aldri verdiene før og etter.
    expect(JSON.stringify(a.historikk)).not.toContain('senere');
    expect(V.planForOppgave(d.poster)).toEqual({ 'A-1': 'PL-A', 'A-2': 'PL-A' });
  });
});

describe('koblingene i tavla', () => {
  const html = readFileSync(join(KLIENT, 'index.html'), 'utf8');
  const js = readFileSync(join(KLIENT, 'planer', 'planer.js'), 'utf8');
  const css = readFileSync(join(KLIENT, 'planer', 'planer.css'), 'utf8');
  const tavle = readFileSync(join(KLIENT, 'tavle.js'), 'utf8');
  const server = readFileSync(join(KLIENT, '..', 'ko-tavle.mjs'), 'utf8');

  it('toppen har rom-valget Planer | Kø, og visningen «plan» heter Fokus', () => {
    expect(html).toMatch(/id="rom-valg"[^>]*role="tablist"/);
    expect(html).toMatch(/id="rom-planer"[\s\S]*?Planer\s*<\/button>/);
    expect(html).toMatch(/id="rom-ko"[\s\S]*?Kø\s*<\/button>/);
    expect(html).toMatch(/id="vis-plan"[\s\S]*?>\s*Fokus\s*<\/button>/);
    expect(html).toContain('id="planer-rom"');
  });

  it('planer.js lastes etter tavle.js og koPlanVisning.js, og serveren serverer dem', () => {
    const i = (s: string) => html.indexOf(s);
    expect(i('/tavle.js')).toBeGreaterThan(0);
    expect(i('/koPlanVisning.js')).toBeGreaterThan(i('/tavle.js'));
    expect(i('/planer/planer.js')).toBeGreaterThan(i('/koPlanVisning.js'));
    expect(server).toContain("'/planer/planer.js'");
    expect(server).toContain("'/planer/planer.css'");
    expect(server).toContain("'/koPlanVisning.js'");
  });

  it('/api/planer er bare lesing (GET), og rommet skriver aldri', () => {
    expect(server).toMatch(/req\.method === 'GET' && sti === '\/api\/planer'/);
    expect(js).not.toMatch(/method:\s*'POST'/);
    const kode = js.replace(/^\s*\/\/.*$/gm, '');
    expect(kode).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it('køkortet har merket for planposten, og detaljpanelet en lenke dit', () => {
    expect(tavle).toContain("class: 'merke planpost-merke'");
    expect(tavle).toContain("'Planpost',");
    expect(tavle).toContain('window.KoPlaner?.aapnePost(k.plan)');
    expect(tavle).toContain('window.KoTavle = {');
  });

  it('planer.css bruker tokenene: ingen hex, skrift via --tekst-*, vekt 400 eller 600', () => {
    const uten = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(uten).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const m of uten.matchAll(/font-size:\s*([^;]+);/g))
      expect(m[1]).toMatch(/^var\(--tekst-(xs|sm|md|lg|xl)\)$/);
    for (const m of uten.matchAll(/font-weight:\s*([^;]+);/g))
      expect(['400', '600']).toContain(m[1].trim());
  });
});
