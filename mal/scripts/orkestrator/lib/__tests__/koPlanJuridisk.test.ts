// =============================================================
// koPlanJuridisk.test.ts: juridisk panel, eierbeslutninger, lanseringsoversikten og juristpakken (se docs/plan-register.md).
//
// Reglene håndheves i de rene funksjonene i lib/koPlan.js (validering av juridisk-feltet, punktene,
// beslutningene og sorteringen deres, lanseringsoversikten og juristpakken) og lib/koPlanVisning.js (fasettene,
// nettadressen, gruppene, stien og kopier-linjene på tavla). Render-tester virker ikke her, så koblingene i
// juridisk.js, planer.js, index.html og ko-tavle.mjs leses som tekst til slutt.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../koPlan.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../koPlanVisning.js');

const KLIENT = join(__dirname, '..', '..', 'ko-tavle');
const TAVLE = join(__dirname, '..', '..', 'ko-tavle.mjs');
const NAA = new Date('2026-10-15T10:00:00Z');

type Obj = Record<string, unknown>;

function punkt(id: string, ekstra: Obj = {}): Obj {
  return { id, sporsmal: `Spørsmål ${id}?`, status: 'apen', blokkerer: 'pakking', ...ekstra };
}

function post(id: string, ekstra: Obj = {}): Obj {
  return {
    id,
    tittel: `Tittel ${id}`,
    prosjekt: 'eksport',
    prioritet: 'senere',
    prioritet_satt_av: 'eier',
    modenhet: 'utredet',
    ...ekstra,
  };
}

const KO = {
  omrader: { alfa: { tittel: 'Alfa' }, beta: { tittel: 'Beta' } },
  prosjekter: {
    eksport: { tittel: 'Eksport', omrade: 'alfa' },
    planlegging: { tittel: 'Planlegging', omrade: 'beta' },
  },
  sporsmal: {
    'SP-A': {
      type: 'sporsmal',
      tekst: 'Velg A eller B?',
      anbefaling: 'A',
      lagt_til: '2026-10-01T08:00:00Z',
    },
    'SP-B': { type: 'sporsmal', tekst: 'Pris?', lagt_til: '2026-10-10T08:00:00Z' },
    'EIER-SIGN': { type: 'eier-oppgave', tekst: 'Signer vilkårsavtalen', lagt_til: '2026-09-01T08:00:00Z' },
    'SP-SVART': { type: 'sporsmal', tekst: 'Gammelt', lagt_til: '2026-09-01T08:00:00Z' },
  },
  avklart: ['SP-SVART'],
  avklaringer: { 'SP-SVART': { svar: 'Ja', tid: '2026-09-02T08:00:00Z', av: 'eier' } },
  oppgaver: [
    { id: 'T-1', status: 'venter', venter_paa: ['SP-B'], innhold_min: 90, prosjekt: 'planlegging' },
    { id: 'T-2', status: 'venter', venter_paa: ['SP-B'] },
    { id: 'T-3', status: 'ferdig', venter_paa: ['SP-A'] },
  ],
};

function register(): Obj {
  return P.normaliser({
    versjon: 1,
    poster: [
      post('PL-A', {
        prioritet: 'naa',
        naa_kategori: ['for-prod'],
        eierspm: ['SP-A'],
        kilder: [{ sti: 'docs/a.md', anker: '§ 2' }],
        juridisk: {
          berorer: ['avtaleloven § 36'],
          personvern: { art9: true, dpia: 'trengs', dpa_endring: false },
          punkter: [
            punkt('J-A-1', { status: 'til-jurist', blokkerer: 'prod', ki_vurdering: 'Trolig ok.' }),
            punkt('J-A-2', { status: 'avklart', ki_vurdering: 'Avklart av KI.' }),
          ],
        },
      }),
      post('PL-B', {
        avhenger: ['PL-A'],
        eierspm: ['SP-A', 'EIER-SIGN'],
        juridisk: { punkter: [punkt('J-B-1', { frist: '2026-10-20' })] },
      }),
      post('PL-C', { prosjekt: 'planlegging', avhenger: ['PL-A'] }),
      post('PL-D', {
        prioritet: 'dropp',
        dropp_grunn: 'Erstattet.',
        juridisk: { punkter: [punkt('J-D-1', { status: 'til-jurist' })] },
      }),
    ],
  });
}

describe('validerJuridisk', () => {
  it('godtar et gyldig felt og eldre korte punkt-id-er', () => {
    const r = P.validerJuridisk({
      berorer: ['GDPR art. 28'],
      personvern: { art9: true, dpia: 'finnes', dpa_endring: true },
      punkter: [
        punkt('J7b'),
        punkt('E1', { status: 'avklart', jurist: { svar: 'Ok', dato: '2026-10-01' } }),
      ],
    });
    expect(r.feil).toEqual([]);
    expect(r.advarsler).toEqual([]);
  });

  it('avviser ukjente felt, feil verdier og doble id-er', () => {
    const r = P.validerJuridisk({
      ukjent: 1,
      personvern: { art9: 'ja', dpia: 'kanskje', mer: true },
      punkter: [
        punkt('J-1', { status: 'ferdig', blokkerer: 'alt', frist: '15.10.2026', ekstra: 1 }),
        punkt('J-1'),
        { id: 'har mellomrom', sporsmal: '', status: 'apen', blokkerer: 'prod' },
        punkt('J-2', { jurist: { svar: '', dato: 'i går', hvem: 'x' } }),
      ],
    });
    const alt = r.feil.join('\n');
    for (const t of [
      'ukjent felt ukjent',
      'personvern: ukjent felt mer',
      'personvern.art9 må være true eller false',
      'personvern.dpia må være',
      'punkt J-1: status må være',
      'punkt J-1: blokkerer må være',
      'punkt J-1: frist må være',
      'punkt J-1: ukjent felt ekstra',
      'punkt J-1: id-en står to ganger',
      'punkt har mellomrom: id må være',
      'punkt har mellomrom: sporsmal mangler',
      'punkt J-2: jurist.svar mangler',
      'punkt J-2: jurist.dato',
      'punkt J-2: jurist: ukjent felt hvem',
    ])
      expect(alt).toContain(t);
  });

  it('advarer om art. 9 uten DPIA, ki-vurdert uten vurdering og svar på et åpent punkt', () => {
    const r = P.validerJuridisk({
      personvern: { art9: true },
      punkter: [
        punkt('J-1', { status: 'ki-vurdert' }),
        punkt('J-2', { status: 'avklart' }),
        punkt('J-3', { status: 'til-jurist', jurist: { svar: 'Ok', dato: '2026-10-01' } }),
      ],
    });
    expect(r.feil).toEqual([]);
    const adv = r.advarsler.join('\n');
    expect(adv).toContain('uten DPIA-vurdering');
    expect(adv).toContain('punkt J-1: ki-vurdert uten ki_vurdering');
    expect(adv).toContain('punkt J-2: avklart uten');
    expect(adv).toContain('punkt J-3: juristen har svart');
  });

  it('validerPost avviser en punkt-id som er brukt i en annen post, men ikke i posten selv', () => {
    const reg = register();
    const poster = reg.poster as Obj[];
    const ny = post('PL-NY', { juridisk: { punkter: [punkt('J-A-1')] } });
    const r = P.validerPost(ny, { prosjekter: KO.prosjekter, poster });
    expect(r.feil.join('\n')).toContain('J-A-1: id-en er brukt i PL-A');
    const egen = P.validerPost(poster[0], { prosjekter: KO.prosjekter, poster });
    expect(egen.feil).toEqual([]);
  });

  it('plan endre (endrePost) nekter et ugyldig juridisk-felt og endrer ingenting', () => {
    const reg = register();
    const r = P.endrePost(
      reg,
      'PL-C',
      { juridisk: { punkter: [punkt('J-X', { status: 'tull' })] } },
      {
        rolle: 'eier',
        prosjekter: KO.prosjekter,
      },
    );
    expect(r.feil.join('\n')).toContain('status må være');
    expect(((reg.poster as Obj[])[2] as Obj).juridisk).toBeUndefined();
  });
});

describe('juridiskePunkter og personvernPerModul', () => {
  it('flater ut punktene med post og modul, åpne først etter arbeidsrekkefølgen og blokkering', () => {
    const pk = P.juridiskePunkter(register(), KO, { naa: NAA });
    expect(pk.map((x: Obj) => x.id)).toEqual(['J-B-1', 'J-A-1', 'J-D-1', 'J-A-2']);
    const b1 = pk[0];
    expect(b1).toMatchObject({ post: 'PL-B', modul: 'alfa', apen: true, frist_dager: 5 });
    const a1 = pk.find((x: Obj) => x.id === 'J-A-1');
    expect(a1).toMatchObject({
      berorer: ['avtaleloven § 36'],
      kilder: [{ sti: 'docs/a.md', anker: '§ 2' }],
    });
  });

  it('personvern per modul teller art. 9 og DPIA, men ikke droppede poster', () => {
    const reg = register();
    (reg.poster as Obj[])[2].juridisk = { personvern: { art9: true, dpa_endring: true } };
    const pv = P.personvernPerModul(reg, KO);
    expect(pv.map((r: Obj) => r.modul)).toEqual(['alfa', 'beta']);
    expect(pv[0]).toMatchObject({ art9: ['PL-A'], dpia: { trengs: ['PL-A'] } });
    expect(pv[1]).toMatchObject({
      art9: ['PL-C'],
      dpia: { uvurdert: ['PL-C'] },
      dpa_endring: ['PL-C'],
    });
  });
});

describe('eierBeslutninger', () => {
  it('kobler spørsmålene til poster (også via avhenger), køoppgaver og minutter', () => {
    const b = P.eierBeslutninger(register(), KO, { naa: NAA });
    const a = b.apne.find((x: Obj) => x.id === 'SP-A');
    expect(a).toMatchObject({
      poster: ['PL-A', 'PL-B'],
      oppgaver: [],
      minutter: 0,
      moduler: ['alfa'],
    });
    expect(a.blokkerte_poster).toEqual(['PL-A', 'PL-B', 'PL-C']);
    const bb = b.apne.find((x: Obj) => x.id === 'SP-B');
    expect(bb).toMatchObject({
      oppgaver: ['T-1', 'T-2'],
      minutter: 120,
      moduler: ['beta'],
      dager_apen: 5,
    });
    const sign = b.apne.find((x: Obj) => x.id === 'EIER-SIGN');
    expect(sign).toMatchObject({ handling: true, frist: null });
  });

  it('sorterer: haster (frist innen 14 dager) først, så flest blokkerte poster, så minutter', () => {
    const reg = register();
    (reg.poster as Obj[])[1].frist = '2026-10-25'; // PL-B: SP-A og EIER-SIGN får frist om 10 dager
    const b = P.eierBeslutninger(reg, KO, { naa: NAA });
    expect(b.apne.map((x: Obj) => x.id)).toEqual(['SP-A', 'EIER-SIGN', 'SP-B']);
    expect(b.apne[0].haster).toBe(true);
    const uten = P.eierBeslutninger(register(), KO, { naa: NAA });
    expect(uten.apne.map((x: Obj) => x.id)).toEqual(['SP-A', 'EIER-SIGN', 'SP-B']);
    expect(uten.apne[1].blokkerte_poster.length).toBeGreaterThan(0);
  });

  it('besvarte står i historikken med svaret', () => {
    const b = P.eierBeslutninger(register(), KO, { naa: NAA });
    expect(b.besvarte).toHaveLength(1);
    expect(b.besvarte[0]).toMatchObject({
      id: 'SP-SVART',
      avklart: true,
      svar: 'Ja',
      svar_av: 'eier',
    });
  });
});

describe('lanseringsoversikt', () => {
  it('samler for-prod-poster, prod-blokkerende punkter, eierhandlinger og spørsmål på for-prod-poster', () => {
    const l = P.lanseringsoversikt(register(), KO, { naa: NAA });
    expect(l.poster.map((p: Obj) => p.id)).toEqual(['PL-A']);
    expect(l.juridisk.map((x: Obj) => x.id)).toEqual(['J-A-1']);
    expect(l.handlinger.map((x: Obj) => x.id)).toEqual(['EIER-SIGN']);
    expect(l.beslutninger.map((x: Obj) => x.id)).toEqual(['SP-A']);
    expect(l.gjenstaar).toBe(4);
  });

  it('tar med dokumenter merket Nå før prod som har noe som må gjøres', () => {
    const reg = register();
    reg.dokumenter = [
      {
        id: 'DOK-VILKAR',
        tittel: 'Vilkår',
        status: 'mangler',
        prioritet: 'naa',
        naa_kategori: ['for-prod'],
      },
      { id: 'DOK-X', tittel: 'X', status: 'mangler', prioritet: 'senere' },
    ];
    const l = P.lanseringsoversikt(reg, KO, { naa: NAA });
    expect(l.dokumenter.map((d: Obj) => d.id)).toEqual(['DOK-VILKAR']);
  });
});

describe('juristpakke', () => {
  it('samler bare til-jurist-punkter fra poster som ikke er droppet, med kontekst og lenker', () => {
    const pk = P.juristpakke(register(), KO, { naa: NAA });
    expect(pk.sti).toBe('scripts/.ko/juristpakker/juristpakke-2026-10-15.md');
    expect(pk.punkter).toEqual(['J-A-1']);
    expect(pk.tekst).toContain('## J-A-1: Spørsmål J-A-1?');
    expect(pk.tekst).toContain('Lovhenvisninger: avtaleloven § 36');
    expect(pk.tekst).toContain('KI-vurdering: Trolig ok.');
    expect(pk.tekst).toContain('Plan-lenker: docs/a.md');
    expect(pk.tekst).toContain('ikke sendt');
    expect(pk.tekst).not.toMatch(/[–—]/);
  });

  it('fritekst kan ikke lage nye overskrifter, og en tom pakke sier det', () => {
    const reg = register();
    const pkt = ((reg.poster as Obj[])[0].juridisk as Obj).punkter as Obj[];
    pkt[0].sporsmal = 'Første linje\n## Falsk overskrift';
    const pk = P.juristpakke(reg, KO, { naa: NAA });
    expect(pk.tekst).not.toContain('\n## Falsk');
    expect(
      P.juristpakke(P.normaliser({ versjon: 1, poster: [] }), KO, { dato: '2026-11-01' }),
    ).toMatchObject({
      sti: 'scripts/.ko/juristpakker/juristpakke-2026-11-01.md',
      punkter: [],
    });
    expect(() => P.juristpakkeSti('../x')).toThrow();
  });

  it('juristpakkene ligger i datamappa, utenfor dokumentmappene, så de blir aldri uregistrerte dokumenter', () => {
    const sti = P.juristpakkeSti('2026-10-15');
    expect(P.DOKUMENT_MAPPER.some((m: string) => sti.startsWith(`${m}/`))).toBe(false);
    expect(P.juristpakkeSti('2026-10-15', { mappe: 'data/' })).toBe(
      'data/juristpakker/juristpakke-2026-10-15.md',
    );
  });
});

describe('flatene på tavla (koPlanVisning)', () => {
  const data = () => {
    const reg = register();
    return {
      moduler: [
        { oid: 'alfa', tittel: 'Alfa' },
        { oid: 'beta', tittel: 'Beta' },
      ],
      prosjekter: { eksport: { kort: 'Eksport' } },
      poster: [{ id: 'PL-A', tittel: 'Tittel PL-A', modul: 'alfa', prosjekt: 'eksport' }],
      dokumenter: [],
      ...V.jbData(reg, KO, { naa: NAA, P }),
    };
  };

  it('nettadressen bærer flate, filtre, søk og valg begge veier, og kaster ugyldige verdier', () => {
    const t = V.lesUrl(
      '?rom=planer&flate=jur&jst=til-jurist,tull&jbl=prod&jmod=alfa&jq=vilkar&jur=J-A-1',
    );
    expect(t.flate).toBe('jur');
    expect(t.jfilter).toEqual({ status: ['til-jurist'], blokk: ['prod'], modul: ['alfa'] });
    expect(t).toMatchObject({ jsok: 'vilkar', jur: 'J-A-1' });
    expect(V.lesUrl(V.skrivUrl(t))).toEqual(t);
    const b = V.lesUrl(
      '?rom=planer&flate=beslutn&bst=besvart&bty=eier-oppgave&bfr=30&bbl=mange&sp=SP-A',
    );
    expect(b.bfilter).toMatchObject({
      status: ['besvart'],
      type: ['eier-oppgave'],
      frist: ['30'],
      blokk: ['mange'],
    });
    expect(b.sp).toBe('SP-A');
    expect(V.lesUrl(V.skrivUrl(b))).toEqual(b);
    expect(V.lesUrl('?flate=hemmelig').flate).toBe('poster');
    expect(V.lesUrl('?jur=..%2Fx').jur).toBeNull();
  });

  it('lukkede punkter og besvarte spørsmål skjules til statusfilteret tar dem med', () => {
    const d = data();
    const jur = V.jbListe('jur', d);
    expect(V.jbFiltrer('jur', jur, V.tomtJbFilter('jur'), '').map((x: Obj) => x.id)).toEqual([
      'J-B-1',
      'J-A-1',
      'J-D-1',
    ]);
    const medAvklart = { ...V.tomtJbFilter('jur'), status: ['avklart'] };
    expect(V.jbFiltrer('jur', jur, medAvklart, '').map((x: Obj) => x.id)).toEqual(['J-A-2']);
    const besl = V.jbListe('beslutn', d);
    expect(
      V.jbFiltrer('beslutn', besl, V.tomtJbFilter('beslutn'), '').some((x: Obj) => x.avklart),
    ).toBe(false);
    const hist = V.jbFiltrer(
      'beslutn',
      besl,
      { ...V.tomtJbFilter('beslutn'), status: ['besvart'] },
      'ja',
    );
    expect(hist.map((x: Obj) => x.id)).toEqual(['SP-SVART']);
  });

  it('fasett-tallene teller med de andre filtrene på, og statusfasetten viser også de lukkede', () => {
    const d = data();
    const f = V.jbFasettTall(
      'jur',
      V.jbListe('jur', d),
      { ...V.tomtJbFilter('jur'), blokk: ['prod'] },
      '',
      {
        moduler: d.moduler,
      },
    );
    const status = f.find((x: Obj) => x.id === 'status');
    expect(status.valg.map((v: Obj) => [v.verdi, v.antall])).toEqual([['til-jurist', 1]]);
    const blokk = f.find((x: Obj) => x.id === 'blokk');
    expect(blokk.valg.map((v: Obj) => [v.verdi, v.antall, v.symbol])).toEqual([
      ['prod', 1, '■'],
      ['pakking', 2, '▲'],
    ]);
    const modul = f.find((x: Obj) => x.id === 'modul');
    expect(modul.valg[0]).toMatchObject({ verdi: 'alfa', tekst: 'Alfa' });
  });

  it('gruppene: status i arbeidsrekkefølgen, og «Svar på dette først» for de fem øverste', () => {
    const d = data();
    const g = V.jbGrupper('jur', V.jbListe('jur', d));
    expect(g.map((x: Obj) => x.id)).toEqual(['apen', 'til-jurist', 'avklart']);
    const mange = Array.from({ length: 7 }, (_, i) => ({ id: `S-${i}`, avklart: false }));
    const bg = V.jbGrupper('beslutn', [...mange, { id: 'S-x', avklart: true }]);
    expect(bg.map((x: Obj) => [x.id, (x.elementer as Obj[]).length])).toEqual([
      ['forst', 5],
      ['apne', 2],
      ['besvart', 1],
    ]);
  });

  it('stien, kopier-linjene (bare id og titler) og antallene i flatevalget', () => {
    const d = data();
    const sti = V.brodsmuler({ flate: 'jur', jur: 'J-A-1', jfilter: V.tomtJbFilter('jur') }, d);
    expect(sti.map((l: Obj) => l.tekst)).toEqual(['Planer', 'Juridisk', 'Til jurist', 'J-A-1']);
    expect(sti[3].kopier).toBe('/planer jur J-A-1 (Alfa › Eksport › PL-A). Instruks:');
    const bs = V.brodsmuler({ flate: 'beslutn', sp: 'SP-A', bfilter: V.tomtJbFilter('beslutn') }, d);
    expect(bs.map((l: Obj) => l.tekst)).toEqual(['Planer', 'Beslutninger', 'SP-A']);
    expect(bs[2].kopier).toBe('/planer eier SP-A (Alfa › Eksport › PL-A). Instruks:');
    expect(V.brodsmuler({ flate: 'lansering' }, d).map((l: Obj) => l.tekst)).toEqual([
      'Planer',
      'Lansering',
    ]);
    expect(V.flateAntall(d)).toMatchObject({ jur: 3, beslutn: 3, lansering: 4 });
  });

  it('svaret til avklar: påkrevd tekst, høyst 4000 tegn, bekreft bare når den er gitt', () => {
    expect(V.avklarKropp('SP-A', '  ').feil).toBeTruthy();
    expect(V.avklarKropp('SP-A', 'x'.repeat(4001)).feil).toBeTruthy();
    expect(V.avklarKropp('SP-A', ' Ja ').kropp).toEqual({ type: 'avklar', sp: 'SP-A', svar: 'Ja' });
    expect(V.avklarKropp('SP-A', 'Ja', { bekreft: true }).kropp.bekreft).toBe(true);
  });
});

describe('koblingene i tavla (lest som tekst)', () => {
  const jur = readFileSync(join(KLIENT, 'planer', 'juridisk.js'), 'utf8');
  const planer = readFileSync(join(KLIENT, 'planer', 'planer.js'), 'utf8');
  const html = readFileSync(join(KLIENT, 'index.html'), 'utf8');
  const tavle = readFileSync(TAVLE, 'utf8');

  it('juridisk.js lastes før planer.js og serveres som egen fil', () => {
    expect(html.indexOf('/planer/juridisk.js')).toBeGreaterThan(0);
    expect(html.indexOf('/planer/juridisk.js')).toBeLessThan(html.indexOf('/planer/planer.js'));
    expect(tavle).toContain("'/planer/juridisk.js': [path.join('planer', 'juridisk.js')");
    expect(planer).toContain('window.KoPlanJur.ruter(jurHjelp, d)');
  });

  it('svar går via avklar-ruten, juristpakken via /api/juristpakke, og ingen tekst settes som HTML', () => {
    expect(jur).toContain("post('/api/handling', r0.kropp)");
    expect(jur).toContain("post('/api/juristpakke'");
    expect(tavle).toContain("if (sti === '/api/juristpakke') return juristpakkeSkriv(b);");
    expect(tavle).toMatch(/isSymbolicLink\(\)/);
    expect(jur).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(jur).not.toMatch(/https?:\/\//);
  });
});
