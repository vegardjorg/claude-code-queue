// =============================================================
// koPlan.test.ts: planregisteret (lib/koPlan.js): validering (prosjekt finnes, kilder finnes, dropp krever grunn),
// grensene for agenten ved prioritet, prioritetsreglene som data, avledet modenhet, filter og henting, sammenslåing,
// endringslogg og angre, dokumentsjekkene, pluss `ko.mjs plan …` mot en kopi i en midlertidig mappe (aldri den ekte
// køen eller det ekte registeret). Se docs/plan-register.md.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Testmodulene står i en midlertidig ko.config.json (KO_KONFIG). Den settes før koPlan leser konfigurasjonen, og
// arves av ko.mjs i underprosessene, så begge ser de samme modulene.
const KONFIG_MAPPE = mkdtempSync(join(tmpdir(), 'ko-plan-konfig-'));
process.env.KO_KONFIG = join(KONFIG_MAPPE, 'ko.config.json');
writeFileSync(
  process.env.KO_KONFIG,
  JSON.stringify({
    moduler: [
      { oid: 'alfa', tittel: 'Alfa', beskrivelse: 'Testmodul' },
      { oid: 'beta', tittel: 'Beta', beskrivelse: 'Testmodul' },
      { oid: 'gamma', tittel: 'Gamma', beskrivelse: 'Testmodul' },
      { oid: 'eksempel', tittel: 'Eksempel', beskrivelse: 'Testmodul' },
      { oid: 'uten-modul', tittel: 'Uten fast modul', beskrivelse: 'Prosjekter uten modul' },
    ],
    prosjektModulForslag: { notater: 'uten-modul', oppsett: 'eksempel' },
  }),
);

type Post = Record<string, unknown> & {
  id: string;
  prioritet?: string;
  prioritet_satt_av?: string;
};
type Reg = {
  versjon: number;
  endret?: string;
  poster: Post[];
  arkiv: Record<string, Post & { sammenslatt_til?: string }>;
  endringslogg: { nr: number; handling: string; angret?: unknown; endringer: unknown[] }[];
};
type Svar = {
  feil: string[];
  advarsler: string[];
  post?: Post;
  endret?: string[];
  loft?: boolean | string[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../koPlan') as {
  PRIORITETSREGLER: { nr: number; prioritet: string; kategorier: string[]; maaling?: object }[];
  PRIORITETER: string[];
  tomtRegister: (naa?: string) => Reg;
  normaliser: (r: unknown) => Reg;
  validerPost: (p: unknown, ctx?: object) => { feil: string[]; advarsler: string[] };
  kildestiFeil: (s: unknown) => string | null;
  regelNrFraGrunn: (g: unknown) => number | null;
  maaltRegel: (
    p: Post,
    poster: Post[],
    o?: { naa?: Date },
  ) => { nr: number; prioritet: string } | null;
  nyPost: (reg: Reg, inn: unknown, ctx?: object) => Svar;
  endrePost: (reg: Reg, id: string, felt: object, ctx?: object) => Svar;
  prioriter: (
    reg: Reg,
    ider: string[],
    valg: { prioritet: string; kategori?: string[]; grunn?: string | null },
    ctx?: object,
  ) => Svar & { endret: string[]; uendret: string[]; loft: string[] };
  prioriterMange: (
    reg: Reg,
    liste: unknown,
    ctx?: object,
  ) => Svar & { endret: string[]; uendret: string[]; loft: string[] };
  verifiser: (reg: Reg, id: string, o: object) => Svar;
  slaaSammen: (reg: Reg, til: string, fra: string[]) => Svar & { arkivert?: string[] };
  avledetModenhet: (
    p: Post,
    oppgaver: object[],
    o?: { naa?: Date },
  ) => {
    modenhet: string;
    brok: string | null;
    ferdige: number;
    totalt: number;
    foreldet: boolean;
  };
  sorterPoster: (p: Post[]) => Post[];
  filtrerPoster: (reg: Reg, ko: object, f?: object) => (Post & { modul: string | null })[];
  hent: (
    reg: Reg,
    ko: object,
    n: string,
    ctx?: object,
  ) => {
    feil: string[];
    type?: string;
    poster?: (Post & { ko: { id: string }[] })[];
    kopier?: string;
  };
  planDiff: (a: object, b: object) => { samling: string; id: string; felt: string }[];
  loggEndring: (reg: Reg, o: object) => { nr: number } | null;
  angre: (reg: Reg, o?: object) => { feil: string[]; post?: { nr: number } };
  forventSjekk: (reg: object, f: unknown) => string | null;
  tolkFeltArg: (l: string[]) => { felt: Record<string, unknown>; feil: string[] };
};

const PROSJEKTER = {
  eksport: { tittel: 'Eksport', omrade: 'alfa' },
  import: { tittel: 'Import', omrade: 'gamma' },
  loest: { tittel: 'Uten modul' },
};
const OMRADER = { alfa: { tittel: 'Alfa' }, gamma: { tittel: 'Gamma' } };
const FINNES = new Set(['docs/eksport-plan.md', 'docs/gamma.md', 'docs/notater/utredning.md']);
const ctx = (rolle = 'agent') => ({
  rolle,
  prosjekter: PROSJEKTER,
  sporsmal: { 'SP-EKSPORT-1': { tekst: 'Hvilken leverandør?' } },
  finnesSti: (s: string) => FINNES.has(s),
  naa: '2026-10-14T10:00:00.000Z',
});
const post = (id: string, extra: object = {}): Post => ({
  id,
  tittel: `Tittel ${id}`,
  prosjekt: 'eksport',
  prioritet: 'senere',
  prioritet_grunn: 'Regel 8: utvidelse uten frist.',
  modenhet: 'utredet',
  ...extra,
});
const register = (...poster: Post[]): Reg => {
  const reg = P.tomtRegister('2026-10-14T09:00:00.000Z');
  for (const p of poster) {
    const r = P.nyPost(reg, p, ctx(p.prioritet_satt_av === 'eier' ? 'eier' : 'agent'));
    if (r.feil.length) throw new Error(r.feil.join('; '));
  }
  return reg;
};

describe('koPlan: validering', () => {
  it('godtar en gyldig post og setter prioritet_satt_av og opprettet', () => {
    const reg = P.tomtRegister();
    const r = P.nyPost(
      reg,
      post('PL-EKSPORT-1', {
        kilder: [{ sti: 'docs/eksport-plan.md', anker: '§ 3', rolle: 'plan' }],
      }),
      ctx(),
    );
    expect(r.feil).toEqual([]);
    expect(r.post?.prioritet_satt_av).toBe('agent');
    expect(r.post?.opprettet).toBe('2026-10-14T10:00:00.000Z');
    expect(reg.poster).toHaveLength(1);
  });

  it('nekter ukjent prosjekt, ukjent kilde og ukjent felt, og muterer ikke registeret', () => {
    const reg = P.tomtRegister();
    const r = P.nyPost(
      reg,
      post('PL-X-1', {
        prosjekt: 'finnes-ikke',
        kilder: [{ sti: 'docs/borte.md' }],
        tittle: 'skrivefeil',
      }),
      ctx(),
    );
    const f = r.feil.join('\n');
    expect(f).toContain('ukjent prosjekt finnes-ikke');
    expect(f).toContain('kilde docs/borte.md finnes ikke');
    expect(f).toContain('ukjent felt tittle');
    expect(reg.poster).toHaveLength(0);
  });

  it('dropp krever grunn; naa_kategori bare ved naa; avledet modenhet kan ikke settes', () => {
    const reg = P.tomtRegister();
    expect(
      P.nyPost(
        reg,
        post('PL-D-1', { prioritet: 'dropp', prioritet_grunn: 'Regel 7: erstattet.' }),
        ctx(),
      ).feil.join(),
    ).toContain('dropp krever én setning som grunn');
    expect(
      P.nyPost(reg, post('PL-D-2', { naa_kategori: ['viktig'] }), ctx()).feil.join(),
    ).toContain('naa_kategori brukes bare når prioritet er naa');
    expect(P.nyPost(reg, post('PL-D-3', { modenhet: 'bygget' }), ctx()).feil.join()).toContain(
      'regnes ut fra køen',
    );
    expect(
      P.nyPost(
        reg,
        post('PL-D-4', {
          prioritet: 'dropp',
          prioritet_grunn: 'Regel 7: erstattet.',
          dropp_grunn: 'Erstattet av PL-X.',
        }),
        ctx(),
      ).feil,
    ).toEqual([]);
  });

  it('agenten må gi prioritet_grunn, og grunnen må stemme med regelen den viser til', () => {
    const reg = P.tomtRegister();
    expect(
      P.nyPost(reg, post('PL-G-1', { prioritet_grunn: undefined }), ctx()).feil.join(),
    ).toContain('en agent må gi prioritet_grunn');
    expect(
      P.nyPost(
        reg,
        post('PL-G-2', { prioritet: 'senere', prioritet_grunn: 'Regel 1: tilgangshull.' }),
        ctx(),
      ).feil.join(),
    ).toContain('regel 1 (Sikkerhet), som gir naa, ikke senere');
    // Eieren trenger ingen grunn.
    expect(P.nyPost(reg, post('PL-G-3', { prioritet_grunn: undefined }), ctx('eier')).feil).toEqual(
      [],
    );
    // Feil kategori er en advarsel.
    const r = P.nyPost(
      reg,
      post('PL-G-4', {
        prioritet: 'naa',
        naa_kategori: ['viktig'],
        prioritet_grunn: 'Regel 3: Vilkår før første kunde.',
      }),
      ctx(),
    );
    expect(r.feil).toEqual([]);
    expect(r.advarsler.join()).toContain(
      'regel 3 (Før lansering) gir Nå med kategori for-prod',
    );
  });

  it('id-er brukes aldri om igjen, heller ikke fra arkivet', () => {
    const reg = register(post('PL-A-1'), post('PL-A-2'));
    P.slaaSammen(reg, 'PL-A-1', ['PL-A-2']);
    expect(P.nyPost(reg, post('PL-A-2'), ctx()).feil.join()).toContain('id-en er brukt fra før');
    expect(P.nyPost(reg, post('feil-id'), ctx()).feil.join()).toContain(
      'id må se ut som PL-NAVN-1',
    );
  });

  it('kildestier: relative, med skråstrek, uten .. og uten absolutt sti', () => {
    expect(P.kildestiFeil('docs/a.md')).toBeNull();
    expect(P.kildestiFeil('../hemmelig.md')).toContain('. og .. er ikke lov');
    expect(P.kildestiFeil('docs/../../x')).toContain('. og .. er ikke lov');
    expect(P.kildestiFeil('C:/x.md')).toContain('relativ');
    expect(P.kildestiFeil('/etc/passwd')).toContain('relativ');
    expect(P.kildestiFeil('docs\\a.md')).toContain('skråstrek');
  });

  it('avhenger må peke til en kjent post; eierspm som ikke finnes i køen gir advarsel', () => {
    const reg = register(post('PL-B-1'));
    expect(
      P.nyPost(reg, post('PL-B-2', { avhenger: ['PL-UKJENT-1'] }), ctx()).feil.join(),
    ).toContain('avhenger av ukjent planpost PL-UKJENT-1');
    const r = P.nyPost(
      reg,
      post('PL-B-3', { avhenger: ['PL-B-1'], eierspm: ['SP-UKJENT-9'] }),
      ctx(),
    );
    expect(r.feil).toEqual([]);
    expect(r.advarsler.join()).toContain('SP-UKJENT-9 står ikke i køen');
  });
});

describe('koPlan: prioritet og grensene for agenten', () => {
  it('reglene er data: åtte regler, regel 1 gir alltid naa/sikkerhet', () => {
    expect(P.PRIORITETSREGLER.map((r) => r.nr)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(P.PRIORITETSREGLER[0]).toMatchObject({ prioritet: 'naa', kategorier: ['sikkerhet'] });
    expect(P.PRIORITETSREGLER[7].prioritet).toBe('senere');
    expect(P.regelNrFraGrunn('Regel 3: Vilkår.')).toBe(3);
    expect(P.regelNrFraGrunn('ingen regel nevnt')).toBeNull();
  });

  it('en agent endrer ikke en prioritet eieren har satt', () => {
    const reg = register(
      post('PL-E-1', { prioritet_satt_av: 'eier', prioritet: 'senere', prioritet_grunn: 'Eier.' }),
    );
    const r = P.endrePost(
      reg,
      'PL-E-1',
      { prioritet: 'dropp', dropp_grunn: 'Lav verdi.', prioritet_grunn: 'Regel 7.' },
      ctx(),
    );
    expect(r.feil.join()).toContain('er satt av eieren, og en agent endrer den ikke');
    expect(reg.poster[0].prioritet).toBe('senere');
    // Heller ikke grunnen til eierens prioritet.
    expect(
      P.endrePost(reg, 'PL-E-1', { prioritet_grunn: 'Annen grunn.' }, ctx()).feil.join(),
    ).toContain('prioritet_grunn hører til eierens prioritet');
    // Andre felt går greit.
    expect(P.endrePost(reg, 'PL-E-1', { merknad: 'notat' }, ctx()).feil).toEqual([]);
  });

  it('unntaket: et sikkerhetsfunn løfter en eier-satt post til naa/sikkerhet og merkes agent_loft', () => {
    const reg = register(
      post('PL-E-2', { prioritet_satt_av: 'eier', prioritet: 'senere', prioritet_grunn: 'Eier.' }),
    );
    const r = P.endrePost(
      reg,
      'PL-E-2',
      {
        prioritet: 'naa',
        naa_kategori: ['sikkerhet'],
        prioritet_grunn: 'Regel 1: tilgangshull funnet.',
      },
      { ...ctx(), av: 'SPOR-1' },
    );
    expect(r.feil).toEqual([]);
    expect(r.loft).toBe(true);
    expect(reg.poster[0]).toMatchObject({
      prioritet: 'naa',
      prioritet_satt_av: 'agent',
      agent_loft: { av: 'SPOR-1', fra: { prioritet: 'senere', naa_kategori: null } },
    });
    // Eieren setter prioriteten igjen: løftet er sett og forsvinner.
    expect(P.endrePost(reg, 'PL-E-2', { prioritet: 'senere' }, ctx('eier')).feil).toEqual([]);
    expect(reg.poster[0].agent_loft).toBeUndefined();
    expect(reg.poster[0].prioritet_satt_av).toBe('eier');
  });

  it('en agent kan ikke opprette en eier-satt prioritet; ny prioritet fra agent krever ny grunn', () => {
    const reg = P.tomtRegister();
    expect(
      P.nyPost(reg, post('PL-F-1', { prioritet_satt_av: 'eier' }), ctx()).feil.join(),
    ).toContain('en agent kan ikke sette prioritet_satt_av eier');
    const reg2 = register(post('PL-F-2'));
    expect(P.endrePost(reg2, 'PL-F-2', { prioritet: 'eier' }, ctx()).feil.join()).toContain(
      'ny prioritet krever prioritet_grunn',
    );
  });

  it('prioriter er alt eller ingenting, og kategori og droppgrunn følger prioriteten', () => {
    const reg = register(
      post('PL-M-1'),
      post('PL-M-2'),
      post('PL-M-3', { prioritet_satt_av: 'eier', prioritet_grunn: 'Eier.' }),
    );
    const feil = P.prioriter(
      reg,
      ['PL-M-1', 'PL-M-3'],
      { prioritet: 'eier', grunn: 'Regel 6: pris.' },
      ctx(),
    );
    expect(feil.feil.join()).toContain('PL-M-3');
    expect(reg.poster.map((p) => p.prioritet)).toEqual(['senere', 'senere', 'senere']);

    const ok = P.prioriter(
      reg,
      ['PL-M-1', 'PL-M-2'],
      { prioritet: 'naa', kategori: ['for-prod'], grunn: 'Regel 3: Vilkår.' },
      ctx(),
    );
    expect(ok.feil).toEqual([]);
    expect(ok.endret).toEqual(['PL-M-1', 'PL-M-2']);
    expect(reg.poster[0]).toMatchObject({ prioritet: 'naa', naa_kategori: ['for-prod'] });

    expect(
      P.prioriter(reg, ['PL-M-1'], { prioritet: 'dropp', grunn: null }, ctx()).feil.join(),
    ).toContain('dropp krever én setning som grunn');
    const d = P.prioriter(
      reg,
      ['PL-M-1'],
      { prioritet: 'dropp', grunn: 'Regel 7: dekket av PL-M-2.' },
      ctx(),
    );
    expect(d.feil).toEqual([]);
    expect(reg.poster[0]).toMatchObject({
      prioritet: 'dropp',
      dropp_grunn: 'Regel 7: dekket av PL-M-2.',
    });
    expect(reg.poster[0].naa_kategori).toBeUndefined();
    // Tilbake fra dropp: droppgrunnen forsvinner.
    P.prioriter(reg, ['PL-M-1'], { prioritet: 'senere', grunn: 'Regel 8: angret dropp.' }, ctx());
    expect(reg.poster[0].dropp_grunn).toBeUndefined();
  });

  it('målt regel: frist innen 60 dager (regel 2) og blokkering av to poster (regel 4)', () => {
    const naa = new Date('2026-10-14T10:00:00Z');
    const a = post('PL-R-1', { frist: '2026-11-20' });
    expect(P.maaltRegel(a, [a], { naa })).toMatchObject({ nr: 2, prioritet: 'naa' });
    const b = post('PL-R-2', { frist: '2027-06-01' });
    const c = post('PL-R-3', { avhenger: ['PL-R-2'] });
    const d = post('PL-R-4', { avhenger: ['PL-R-2'] });
    expect(P.maaltRegel(b, [b, c, d], { naa })).toMatchObject({ nr: 4 });
    expect(P.maaltRegel(b, [b, c], { naa })).toBeNull();
  });
});

describe('koPlan: avledet modenhet', () => {
  const p = post('PL-K-1', { modenhet: 'klar' });
  const o = (id: string, status: string, plan = 'PL-K-1', ferdig?: string) => ({
    id,
    status,
    plan,
    ferdig,
  });
  const naa = new Date('2026-10-14T10:00:00Z');

  it('ingen oppgaver: modenheten fra planarbeidet', () => {
    expect(P.avledetModenhet(p, [o('X-1', 'venter', 'PL-ANNEN-1')], { naa }).modenhet).toBe('klar');
  });
  it('åpne oppgaver: i-ko; noen ferdige: delvis med brøk; alle ferdige: bygget', () => {
    expect(P.avledetModenhet(p, [o('A', 'venter'), o('B', 'kjorer')], { naa }).modenhet).toBe(
      'i-ko',
    );
    const d = P.avledetModenhet(p, [o('A', 'ferdig'), o('B', 'venter'), o('C', 'venter')], { naa });
    expect(d).toMatchObject({ modenhet: 'delvis', brok: '1/3' });
    expect(P.avledetModenhet(p, [o('A', 'ferdig'), o('B', 'kansellert')], { naa }).modenhet).toBe(
      'bygget',
    );
  });
  it('verifisert når verifiseringen er etter siste ferdige oppgave og ikke foreldet', () => {
    const v = { ...p, verifisert: { dato: '2026-10-10', av: 'agent', funn: 'ok' } };
    expect(
      P.avledetModenhet(v, [o('A', 'ferdig', 'PL-K-1', '2026-10-09T12:00:00Z')], { naa }).modenhet,
    ).toBe('verifisert');
    expect(
      P.avledetModenhet(v, [o('A', 'ferdig', 'PL-K-1', '2026-10-12T12:00:00Z')], { naa }).modenhet,
    ).toBe('bygget');
    const gammel = { ...p, verifisert: { dato: '2026-08-01', av: 'agent', funn: 'ok' } };
    const r = P.avledetModenhet(gammel, [o('A', 'ferdig', 'PL-K-1', '2026-07-01T12:00:00Z')], {
      naa,
    });
    expect(r).toMatchObject({ modenhet: 'bygget', foreldet: true });
  });
  it('oppgaver koblet til en sammenslått post teller i målet', () => {
    const m = { ...p, sammenslatt_fra: ['PL-K-2'] };
    expect(P.avledetModenhet(m, [o('A', 'ferdig'), o('B', 'venter', 'PL-K-2')], { naa }).brok).toBe(
      '1/2',
    );
  });
});

describe('koPlan: sortering, filter, henting og sammenslåing', () => {
  it('sorterer på prioritet, frist, blokkering og størrelse', () => {
    const poster = [
      post('PL-S-1', { prioritet: 'senere', estimat: 'S' }),
      post('PL-S-2', { prioritet: 'naa', estimat: 'L' }),
      post('PL-S-3', { prioritet: 'naa', estimat: 'S' }),
      post('PL-S-4', { prioritet: 'naa', frist: '2026-12-01', estimat: 'XL' }),
      post('PL-S-5', { prioritet: 'eier' }),
    ];
    expect(P.sorterPoster(poster).map((p) => p.id)).toEqual([
      'PL-S-4',
      'PL-S-3',
      'PL-S-2',
      'PL-S-5',
      'PL-S-1',
    ]);
  });

  it('filter: dropp skjules som standard; modul via prosjektet; søk', () => {
    const reg = register(
      post('PL-V-1'),
      post('PL-V-2', { prosjekt: 'import', tittel: 'Import med QR' }),
      post('PL-V-3', {
        prioritet: 'dropp',
        prioritet_grunn: 'Regel 7.',
        dropp_grunn: 'Erstattet.',
      }),
    );
    const ko = { prosjekter: PROSJEKTER, omrader: OMRADER, oppgaver: [] };
    expect(P.filtrerPoster(reg, ko).map((p) => p.id)).toEqual(['PL-V-1', 'PL-V-2']);
    expect(P.filtrerPoster(reg, ko, { alle: true })).toHaveLength(3);
    expect(P.filtrerPoster(reg, ko, { prioritet: ['dropp'] }).map((p) => p.id)).toEqual(['PL-V-3']);
    expect(P.filtrerPoster(reg, ko, { modul: 'gamma' }).map((p) => p.id)).toEqual(['PL-V-2']);
    expect(P.filtrerPoster(reg, ko, { sok: 'qr' }).map((p) => p.id)).toEqual(['PL-V-2']);
  });

  it('hent: post, prosjekt eller modul, med køstatus, eierspørsmål og en kopier-linje uten innhold', () => {
    const reg = register(
      post('PL-H-1', {
        eierspm: ['SP-EKSPORT-1'],
        kilder: [{ sti: 'docs/notater/utredning.md', rolle: 'utredning' }],
        kort: 'HEMMELIG',
      }),
      post('PL-H-2', { prosjekt: 'import' }),
    );
    const ko = {
      prosjekter: PROSJEKTER,
      omrader: OMRADER,
      oppgaver: [{ id: 'EKSPORT-1a', tittel: 'Første', status: 'ferdig', plan: 'PL-H-1' }],
      sporsmal: { 'SP-EKSPORT-1': { tekst: 'Hvilken leverandør?' } },
      avklart: ['SP-EKSPORT-1'],
    };
    const r = P.hent(reg, ko, 'PL-H-1', { finnesSti: (s: string) => FINNES.has(s) });
    expect(r.type).toBe('post');
    expect(r.poster?.[0].ko).toEqual([{ id: 'EKSPORT-1a', tittel: 'Første', status: 'ferdig' }]);
    expect(r.poster?.[0]).toMatchObject({
      eiersporsmal: [{ id: 'SP-EKSPORT-1', avklart: true }],
      kilder: [{ sti: 'docs/notater/utredning.md', finnes: true }],
    });
    expect(r.kopier).toContain('PL-H-1');
    expect(r.kopier).not.toContain('HEMMELIG');
    expect(P.hent(reg, ko, 'import').poster?.map((p) => p.id)).toEqual(['PL-H-2']);
    expect(P.hent(reg, ko, 'alfa').type).toBe('modul');
    expect(P.hent(reg, ko, 'ukjent').feil.join()).toContain('fant ingen');
  });

  it('slaa-sammen: målet får kilder og ankre, de andre går til arkivet, avhengigheter peker om', () => {
    const reg = register(
      post('PL-J-1', { roadmap: ['9.1'], kilder: [{ sti: 'docs/gamma.md' }] }),
      post('PL-J-2', {
        roadmap: ['9.2'],
        kilder: [{ sti: 'docs/gamma.md' }, { sti: 'docs/eksport-plan.md' }],
      }),
      post('PL-J-3', { avhenger: ['PL-J-2'] }),
    );
    const r = P.slaaSammen(reg, 'PL-J-1', ['PL-J-2']);
    expect(r.feil).toEqual([]);
    expect(reg.poster.map((p) => p.id)).toEqual(['PL-J-1', 'PL-J-3']);
    expect(reg.poster[0]).toMatchObject({
      roadmap: ['9.1', '9.2'],
      sammenslatt_fra: ['PL-J-2'],
      kilder: [{ sti: 'docs/gamma.md' }, { sti: 'docs/eksport-plan.md' }],
    });
    expect(reg.poster[1].avhenger).toEqual(['PL-J-1']);
    expect(reg.arkiv['PL-J-2'].sammenslatt_til).toBe('PL-J-1');
    expect(P.endrePost(reg, 'PL-J-2', { merknad: 'x' }, ctx()).feil.join()).toContain(
      'slått sammen inn i PL-J-1',
    );
  });
});

describe('koPlan: endringslogg, angre og samtidighet', () => {
  it('angre ruller tilbake en endring, en ny post og en sammenslåing', () => {
    const reg = register(post('PL-U-1'), post('PL-U-2'));
    const logg = (handling: string, fn: () => void) => {
      const for_ = JSON.parse(JSON.stringify({ poster: reg.poster, arkiv: reg.arkiv }));
      fn();
      P.loggEndring(reg, { av: 'test', handling, endringer: P.planDiff(for_, reg) });
    };
    logg('endre', () => P.endrePost(reg, 'PL-U-1', { merknad: 'ny' }, ctx()));
    logg('ny', () => P.nyPost(reg, post('PL-U-3'), ctx()));
    logg('slaa', () => P.slaaSammen(reg, 'PL-U-1', ['PL-U-2']));
    expect(reg.endringslogg.map((p) => p.handling)).toEqual(['endre', 'ny', 'slaa']);

    expect(P.angre(reg, { av: 'test' }).feil).toEqual([]);
    expect(reg.poster.map((p) => p.id).sort()).toEqual(['PL-U-1', 'PL-U-2', 'PL-U-3']);
    expect(reg.arkiv).toEqual({});
    expect(reg.poster.find((p) => p.id === 'PL-U-1')?.sammenslatt_fra).toBeUndefined();
    expect(P.angre(reg).feil).toEqual([]);
    expect(reg.poster.map((p) => p.id).sort()).toEqual(['PL-U-1', 'PL-U-2']);
    expect(P.angre(reg).feil).toEqual([]);
    expect(reg.poster[0].merknad).toBeUndefined();
    expect(P.angre(reg).feil.join()).toContain('ingenting å angre');
  });

  it('angre nekter når feltet er endret siden', () => {
    const reg = register(post('PL-W-1'));
    const for_ = JSON.parse(JSON.stringify({ poster: reg.poster, arkiv: reg.arkiv }));
    P.endrePost(reg, 'PL-W-1', { merknad: 'a' }, ctx());
    P.loggEndring(reg, { handling: 'endre', endringer: P.planDiff(for_, reg) });
    reg.poster[0].merknad = 'endret utenfor loggen';
    expect(P.angre(reg).feil.join()).toContain('PL-W-1 merknad er endret siden');
    expect(reg.poster[0].merknad).toBe('endret utenfor loggen');
  });

  it('forventSjekk og --felt-tolking', () => {
    expect(P.forventSjekk({ endret: '2026-10-14T10:00:00Z' }, '2026-10-14T09:00:00Z')).toContain(
      'er endret',
    );
    expect(P.forventSjekk({ endret: '2026-10-14T10:00:00Z' }, '2026-10-14T11:00:00Z')).toBeNull();
    expect(P.forventSjekk({}, 'tull')).toContain('ugyldig');
    expect(P.tolkFeltArg(['estimat=M', 'roadmap=["9.1"]', 'merknad=', 'frist=null'])).toEqual({
      felt: { estimat: 'M', roadmap: ['9.1'], merknad: null, frist: null },
      feil: [],
    });
    expect(P.tolkFeltArg(['uten']).feil.join()).toContain('navn=verdi');
  });
});

describe('ko.mjs plan …: mot en kopi i en midlertidig mappe', () => {
  const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');
  let mappe: string;
  let kilder: string;
  function kjor(args: string[]): { kode: number; ut: string; feil: string } {
    try {
      const ut = execFileSync(process.execPath, [KO_MJS, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: mappe,
          KO_GIT: mappe,
          KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
          KO_PLAN_KILDEROT: kilder,
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
  const lesReg = (): Reg => JSON.parse(readFileSync(join(mappe, 'planer.json'), 'utf8')) as Reg;
  const fil = (navn: string, innhold: unknown) => {
    const sti = join(mappe, navn);
    writeFileSync(sti, JSON.stringify(innhold));
    return sti;
  };
  const KO = {
    endret: '2026-10-14T08:00:00.000Z',
    oppgaver: [
      {
        id: 'EKSPORT-1a',
        tittel: 'Første',
        domene: 'alfa',
        klasse: 'K',
        status: 'venter',
        plan: 'PL-EKSPORT-1',
      },
    ],
    prosjekter: PROSJEKTER,
    omrader: OMRADER,
    sporsmal: {},
    avklart: [],
  };

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-plan-'));
    kilder = join(mappe, 'rot');
    mkdirSync(join(kilder, 'docs'), { recursive: true });
    writeFileSync(join(kilder, 'docs', 'eksport-plan.md'), '# plan\n');
    writeFileSync(join(mappe, 'ko.json'), JSON.stringify(KO, null, 2));
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('ny, vis, hent og endre; køfila røres ikke', () => {
    const koFor = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const ny = kjor([
      'plan',
      'ny',
      '--fil',
      fil('ny.json', [
        post('PL-EKSPORT-1', { kilder: [{ sti: 'docs/eksport-plan.md' }] }),
        post('PL-EKSPORT-2'),
      ]),
    ]);
    expect(ny.feil).toBe('');
    expect(ny.ut).toContain('2 ny(e) planpost(er): PL-EKSPORT-1, PL-EKSPORT-2');
    expect(ny.ut).toContain('Endringslogg nr. 1');
    expect(lesReg().poster).toHaveLength(2);
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(koFor);

    const vis = kjor(['plan', 'vis', '--json']);
    const v = JSON.parse(vis.ut) as { poster: (Post & { avledet: { modenhet: string } })[] };
    expect(v.poster.find((p) => p.id === 'PL-EKSPORT-1')?.avledet.modenhet).toBe('i-ko');

    const hent = kjor(['plan', 'hent', 'PL-EKSPORT-1']);
    expect(hent.ut).toContain('kø: EKSPORT-1a venter');
    expect(hent.ut).toContain('Kopier: /planer PL-EKSPORT-1');

    const endre = kjor(['plan', 'endre', 'PL-EKSPORT-2', '--felt', 'estimat=M', 'merknad=notat']);
    expect(endre.kode).toBe(0);
    expect(lesReg().poster[1]).toMatchObject({ estimat: 'M', merknad: 'notat' });
  });

  it('validering gir exit 1 og skriver ingenting; --torr skriver ingenting', () => {
    const r = kjor([
      'plan',
      'ny',
      '--fil',
      fil('feil.json', post('PL-X-1', { prosjekt: 'borte' })),
      '--json',
    ]);
    expect(r.kode).toBe(1);
    expect((JSON.parse(r.ut) as { feil: string[] }).feil.join()).toContain('ukjent prosjekt borte');
    expect(existsSync(join(mappe, 'planer.json'))).toBe(false);

    const t = kjor(['plan', 'ny', '--fil', fil('ok.json', post('PL-X-2')), '--torr']);
    expect(t.ut).toContain('Forhåndsvisning (ingenting skrevet)');
    expect(existsSync(join(mappe, 'planer.json'))).toBe(false);
  });

  it('prioriter med eier-grensen, --forvent-endret og angre', () => {
    kjor(['plan', 'ny', '--fil', fil('a.json', post('PL-P-1')), '--satt-av', 'eier']);
    const nekt = kjor(['plan', 'prioriter', 'PL-P-1', 'dropp', '--grunn', 'Regel 7: lav verdi.']);
    expect(nekt.kode).toBe(1);
    expect(nekt.feil).toContain('satt av eieren');

    const versjon = lesReg().endret as string;
    const ok = kjor([
      'plan',
      'prioriter',
      'PL-P-1',
      'naa',
      '--kategori',
      'sikkerhet',
      '--grunn',
      'Regel 1: tilgangshull.',
      '--forvent-endret',
      versjon,
      '--json',
    ]);
    expect(ok.kode).toBe(0);
    expect(JSON.parse(ok.ut)).toMatchObject({ ok: true, loft: ['PL-P-1'] });
    expect(lesReg().poster[0]).toMatchObject({ prioritet: 'naa', naa_kategori: ['sikkerhet'] });

    // Forhåndsvisningen bygget på en eldre versjon: exit 6.
    const gammel = kjor([
      'plan',
      'endre',
      'PL-P-1',
      '--felt',
      'merknad=x',
      '--forvent-endret',
      '2026-01-01T00:00:00Z',
    ]);
    expect(gammel.kode).toBe(6);

    expect(kjor(['plan', 'angre']).ut).toContain('Angret nr. 2 plan prioriter');
    expect(lesReg().poster[0].prioritet).toBe('senere');
    expect(lesReg().poster[0].agent_loft).toBeUndefined();
  });

  it('prioriter-mange: alle flyttingene i én skriving, én endringslogg-post og én angre', () => {
    kjor([
      'plan',
      'ny',
      '--fil',
      fil('a.json', [post('PL-PM-1'), post('PL-PM-2'), post('PL-PM-3')]),
    ]);
    const liste = [
      {
        id: 'PL-PM-1',
        prioritet: 'naa',
        kategori: ['viktig'],
        grunn: 'Regel 5: feil hos brukere.',
      },
      { id: 'PL-PM-2', prioritet: 'dropp', grunn: 'Regel 7: dekket av annet.' },
      { id: 'PL-PM-3', prioritet: 'senere' },
    ];
    // Forhåndsvisning skriver ingenting.
    const versjon = lesReg().endret as string;
    const torr = kjor([
      'plan',
      'prioriter-mange',
      '--fil',
      fil('m.json', liste),
      '--torr',
      '--json',
    ]);
    expect(torr.kode).toBe(0);
    expect(JSON.parse(torr.ut)).toMatchObject({ ok: true, torr: true, logg: null });
    expect(lesReg().endret).toBe(versjon);

    // Ett ugyldig element: ingenting skrives (alt eller ingenting).
    const halv = kjor([
      'plan',
      'prioriter-mange',
      '--fil',
      fil('h.json', [...liste.slice(0, 1), { id: 'PL-PM-2', prioritet: 'dropp' }]),
      '--json',
    ]);
    expect(halv.kode).toBe(1);
    expect(lesReg().poster.map((p) => p.prioritet)).toEqual(['senere', 'senere', 'senere']);

    // Utdatert forhåndsvisning: exit 6.
    const gammel = kjor([
      'plan',
      'prioriter-mange',
      '--fil',
      fil('m.json', liste),
      '--forvent-endret',
      '2026-01-01T00:00:00Z',
    ]);
    expect(gammel.kode).toBe(6);

    const ok = kjor([
      'plan',
      'prioriter-mange',
      '--fil',
      fil('m.json', liste),
      '--forvent-endret',
      versjon,
      '--satt-av',
      'eier',
      '--json',
    ]);
    expect(ok.kode).toBe(0);
    const svar = JSON.parse(ok.ut) as { logg: number };
    const reg = lesReg();
    expect(reg.poster.map((p) => p.prioritet)).toEqual(['naa', 'dropp', 'senere']);
    // PL-PM-3 sto alt som senere: uendret, så den beholder hvem som satte den.
    expect(reg.poster.map((p) => p.prioritet_satt_av)).toEqual(['eier', 'eier', 'agent']);
    expect(reg.poster[1].dropp_grunn).toBe('Regel 7: dekket av annet.');
    const logg = (reg as unknown as { endringslogg: { nr: number; handling: string }[] })
      .endringslogg;
    expect(logg.filter((l) => l.handling === 'plan prioriter-mange')).toHaveLength(1);
    expect(logg[logg.length - 1].nr).toBe(svar.logg);

    // Én angre ruller hele lagringen tilbake.
    expect(kjor(['plan', 'angre']).ut).toContain('plan prioriter-mange');
    expect(lesReg().poster.map((p) => p.prioritet)).toEqual(['senere', 'senere', 'senere']);
  });

  it('slaa-sammen og verifiser', () => {
    kjor(['plan', 'ny', '--fil', fil('a.json', [post('PL-Q-1'), post('PL-Q-2')])]);
    expect(kjor(['plan', 'slaa-sammen', 'PL-Q-1', 'PL-Q-2']).kode).toBe(0);
    expect(Object.keys(lesReg().arkiv)).toEqual(['PL-Q-2']);
    const v = kjor([
      'plan',
      'verifiser',
      'PL-Q-1',
      '--funn',
      'Sjekket mot koden.',
      '--commit',
      'abc1234',
    ]);
    expect(v.kode).toBe(0);
    expect(lesReg().poster[0].verifisert).toMatchObject({
      av: 'agent',
      funn: 'Sjekket mot koden.',
      commit: 'abc1234',
    });
    expect(kjor(['plan', 'regler']).ut).toContain('1. Sikkerhet');
  });
});

// =============================================================
//: kobling til køen (add --plan), fase plan, modulene, plan sjekk og plan backup.
// =============================================================

type Funn = { id?: string; oppgave?: string; prosjekt?: string; grunn: string; ider?: string[] };
type SjekkSvar = {
  uregistrert: string[];
  dode_stier: { id: string; sti: string }[];
  foreldet: Funn[];
  ikke_verifisert: string[];
  statusavvik: Funn[];
  regelavvik: Funn[];
  hull: Funn[];
  duplikater: Funn[];
  kapasitet: {
    poster: number;
    spor: number;
    uten_estimat: string[];
    uker: number | null;
    tekst: string;
  };
  referanser: { id: string; sti: string; rolle: string }[];
  antall: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P2 = require('../koPlan') as {
  MODULER: { oid: string; tittel: string }[];
  PROSJEKT_MODUL_FORSLAG: Record<string, string>;
  modulPlan: (
    ko: object,
    o?: { koble?: boolean },
  ) => {
    nye: { oid: string }[];
    finnes: { oid: string; tittel: string | null }[];
    koble: { pid: string; oid: string }[];
  };
  fasePlanAvsluttes: (prosjekter: object, nye: object[]) => string[];
  planKoblingFeil: (reg: Reg, id: unknown) => string | null;
  koblePlan: (
    reg: Reg,
    nye: object[],
    planId?: string | null,
  ) => { feil: string[]; advarsler: string[]; oppgaver: Record<string, unknown>[] };
  dokStatus: (tekst: unknown, anker?: string | null) => string | null;
  duplikater: (poster: Post[]) => Funn[];
  kapasitet: (reg: Reg, ko: object, o?: object) => SjekkSvar['kapasitet'];
  sjekk: (reg: Reg, ko: object, ctx?: object) => SjekkSvar;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk') as {
  valider: (o: object, eks?: object[], reg?: object) => string[];
  nyttRegister: (
    r: object,
    e: object,
    o?: object,
  ) => { feil: string[]; register: Record<string, object> };
};

describe('koPlan: kobling køoppgave → planpost', () => {
  it('planKoblingFeil: ukjent, sammenslått og ugyldig id nektes; en kjent post godtas', () => {
    const reg = register(post('PL-K-1'), post('PL-K-2'));
    P.slaaSammen(reg, 'PL-K-1', ['PL-K-2']);
    expect(P2.planKoblingFeil(reg, 'PL-K-1')).toBeNull();
    expect(P2.planKoblingFeil(reg, 'PL-K-2')).toContain('slått sammen inn i PL-K-1');
    expect(P2.planKoblingFeil(reg, 'PL-BORTE-1')).toContain('ukjent planpost PL-BORTE-1');
    expect(P2.planKoblingFeil(reg, 'ikke-en-id')).toContain('må være en planpost-id');
  });

  it('koblePlan setter plan og prosjekt, advarer om ikke klar, annet prosjekt og dropp, og muterer ikke inn', () => {
    const reg = register(
      post('PL-K-1', { modenhet: 'klar' }),
      post('PL-K-2'),
      post('PL-K-3', {
        prioritet: 'dropp',
        dropp_grunn: 'Dekket.',
        prioritet_grunn: 'Regel 7: dekket.',
      }),
    );
    const inn = [{ id: 'A' }, { id: 'B', prosjekt: 'import' }, { id: 'C', plan: 'PL-K-2' }];
    const r = P2.koblePlan(reg, inn, 'PL-K-1');
    expect(r.feil).toEqual([]);
    expect(r.oppgaver[0]).toMatchObject({ plan: 'PL-K-1', prosjekt: 'eksport' });
    expect(r.oppgaver[1]).toMatchObject({ plan: 'PL-K-1', prosjekt: 'import' });
    expect(r.oppgaver[2]).toMatchObject({ plan: 'PL-K-2', prosjekt: 'eksport' });
    expect(inn[0]).toEqual({ id: 'A' });
    expect(r.advarsler.join('\n')).toContain('B: prosjekt import, men planposten PL-K-1');
    expect(r.advarsler.join('\n')).toContain('PL-K-2 er utredet, ikke klar');
    expect(P2.koblePlan(reg, [{ id: 'D' }], 'PL-K-3').advarsler.join()).toContain('er droppet');
    const nekt = P2.koblePlan(reg, [{ id: 'E' }, { id: 'F', plan: 'PL-NEI-1' }], 'PL-K-1');
    expect(nekt.feil).toEqual([expect.stringContaining('F: ukjent planpost PL-NEI-1')]);
  });

  it('feltet plan i køen: formatet sjekkes i koLogikk, og fase må være plan', () => {
    const o = { id: 'X', tittel: 't', domene: 'd', klasse: 'K', oppdrag: 'o' };
    expect(L.valider({ ...o, plan: 'PL-A-1' })).toEqual([]);
    expect(L.valider({ ...o, plan: 'feil' }).join()).toContain('plan må være en planpost-id');
    expect(L.nyttRegister({}, { p: { tittel: 'P', fase: 'plan' } }).feil).toEqual([]);
    expect(L.nyttRegister({}, { p: { tittel: 'P', fase: 'bygg' } }).feil.join()).toContain(
      'fase må være plan',
    );
  });

  it('fasePlanAvsluttes: bare prosjekter i fase plan som får oppgaver', () => {
    const pr = { a: { tittel: 'A', fase: 'plan' }, b: { tittel: 'B' } };
    expect(
      P2.fasePlanAvsluttes(pr, [{ prosjekt: 'a' }, { prosjekt: 'b' }, { prosjekt: 'a' }]),
    ).toEqual(['a']);
  });
});

describe('koPlan: modulene fra konfigurasjonen', () => {
  it('modulene fra ko.config.json; de som finnes endres ikke; --koble bare for prosjekter uten modul', () => {
    expect(P2.MODULER.map((m) => m.tittel)).toEqual([
      'Alfa',
      'Beta',
      'Gamma',
      'Eksempel',
      'Uten fast modul',
    ]);
    expect(P2.PROSJEKT_MODUL_FORSLAG.notater).toBe('uten-modul');
    expect(P2.PROSJEKT_MODUL_FORSLAG.oppsett).toBe('eksempel');
    const ko = {
      omrader: { alfa: { tittel: 'Alfa-området' } },
      prosjekter: {
        oppsett: { tittel: 'O' },
        import: { tittel: 'K', omrade: 'alfa' },
        ukjent: { tittel: 'U' },
      },
    };
    const r = P2.modulPlan(ko, { koble: true });
    expect(r.nye).toHaveLength(4);
    expect(r.finnes).toEqual([{ oid: 'alfa', tittel: 'Alfa-området' }]);
    expect(r.koble).toEqual([{ pid: 'oppsett', oid: 'eksempel' }]);
    expect(P2.modulPlan(ko).koble).toEqual([]);
  });
});

describe('koPlan: plan sjekk', () => {
  it('dokStatus: seksjonen under ankeret, tabellrader, avkrysning, og blandet gir null', () => {
    const dok = [
      '# Plan',
      '## 3. Datamodell',
      '### 3.4 Modenhet',
      'Status: ferdig',
      '## 4. Kommandoer',
      'Status: ikke startet',
      '## 5. Liste',
      '- [ ] a',
      '- [ ] b',
      '## 6. Ferdig liste',
      '- [x] a',
      '## 7. Blandet',
      '- [x] a',
      '- [ ] b',
      '## 8. Bolker',
      '| STEG-2 | Ikke startet | K |',
    ].join('\n');
    expect(P2.dokStatus(dok, '§ 3.4')).toBe('ferdig');
    expect(P2.dokStatus(dok, '§ 4')).toBe('ikke-startet');
    expect(P2.dokStatus(dok, '5. Liste')).toBe('ikke-startet');
    expect(P2.dokStatus(dok, '§ 6')).toBe('ferdig');
    expect(P2.dokStatus(dok, '§ 7')).toBeNull();
    expect(P2.dokStatus(dok, 'STEG-2')).toBe('ikke-startet');
    expect(P2.dokStatus(dok, 'finnes-ikke')).toBeNull();
    expect(P2.dokStatus('# X\nStatus: levert\n')).toBe('ferdig');
    expect(P2.dokStatus(null)).toBeNull();
  });

  it('duplikater: nesten like titler og samme kilde med samme anker', () => {
    const d = P2.duplikater([
      post('PL-D-1', { tittel: 'Eksport risikovurdering innsjekk varsling' }),
      post('PL-D-2', { tittel: 'Eksport: risikovurdering, innsjekk og varsling' }),
      post('PL-D-3', {
        tittel: 'Noe helt annet her',
        kilder: [{ sti: 'docs/a.md', anker: '§ 2' }],
      }),
      post('PL-D-4', { tittel: 'Og enda noe annet', kilder: [{ sti: 'docs/a.md', anker: '§ 2' }] }),
      post('PL-D-5', { tittel: 'Tredje ting her', kilder: [{ sti: 'docs/a.md', anker: '§ 3' }] }),
    ]);
    expect(d).toEqual([
      { ider: ['PL-D-1', 'PL-D-2'], grunn: 'nesten like titler' },
      { ider: ['PL-D-3', 'PL-D-4'], grunn: 'samme kilde docs/a.md § 2' },
    ]);
  });

  it('kapasitet: estimatene i Nå minus ferdige køoppgaver, mot ferdige per uke', () => {
    const naa = (id: string, extra: object) =>
      post(id, {
        prioritet: 'naa',
        naa_kategori: ['viktig'],
        prioritet_grunn: 'Regel 5: feil.',
        ...extra,
      });
    const reg = register(
      naa('PL-C-1', { estimat: 'L' }),
      naa('PL-C-2', { estimat: 'M' }),
      naa('PL-C-3', {}),
      post('PL-C-4', { estimat: 'XL' }),
    );
    const ko = {
      oppgaver: [
        { id: 'c1', plan: 'PL-C-1', status: 'ferdig' },
        { id: 'c2', plan: 'PL-C-1', status: 'ferdig' },
        { id: 'c3', plan: 'PL-C-1', status: 'venter' },
      ],
    };
    const k = P2.kapasitet(reg, ko, { ferdigePerUke: 3 });
    expect(k).toMatchObject({ poster: 3, spor: 7, uten_estimat: ['PL-C-3'], uker: 2.3 });
    expect(k.tekst).toContain('Nå er ca. 2,3 uker med dagens tempo');
    expect(P2.kapasitet(reg, ko).tekst).toContain('tempoet er ukjent');
  });

  it('sjekk finner uregistrerte, døde stier, foreldet, statusavvik, regelavvik og hull', () => {
    const naa = new Date('2026-10-14T10:00:00Z');
    const reg = register(
      post('PL-S-1', {
        kilder: [{ sti: 'docs/eksport-plan.md', anker: '§ 2' }],
        verifisert: { dato: '2026-08-01', av: 'agent', funn: 'ok' },
      }),
      post('PL-S-2', {
        kilder: [{ sti: 'docs/gamma.md' }],
        verifisert: { dato: '2026-10-10', av: 'agent', funn: 'ok', commit: 'abc1234' },
      }),
      post('PL-S-3', {
        prioritet: 'eier',
        prioritet_grunn: 'Regel 6: valg.',
        eierspm: ['SP-EKSPORT-1'],
      }),
      post('PL-S-4', { prosjekt: 'loest', frist: '2026-11-01', estimat: 'S' }),
    );
    // En kilde som er flyttet etter at posten ble lagt inn.
    reg.poster[3].kilder = [{ sti: 'docs/flyttet.md' }];
    const ko = {
      prosjekter: { ...PROSJEKTER, tom: { tittel: 'Tom', fase: 'plan' } },
      avklart: ['SP-EKSPORT-1'],
      oppgaver: [
        { id: 's1', plan: 'PL-S-1', status: 'ferdig', ferdig: '2026-07-01T10:00:00Z' },
        {
          id: 's2',
          plan: 'PL-S-2',
          status: 'ferdig',
          ferdig: '2026-10-01T10:00:00Z',
          eier_filer: ['lib/a.ts', 'lib/b.ts'],
        },
        { id: 's3', plan: 'PL-BORTE-1', status: 'venter' },
        { id: 's4', prosjekt: 'tom', status: 'venter' },
      ],
    };
    const tekster: Record<string, string> = {
      'docs/eksport-plan.md': '# Plan\n## 2. Del\nStatus: ikke startet\n',
      'docs/gamma.md': '# Gamma\n',
    };
    const kall: { filer: string[]; fra: object }[] = [];
    const r = P2.sjekk(reg, ko, {
      naa,
      dokumenter: [
        'docs/eksport-plan.md',
        'docs/annet.md',
        'docs/INDEKS.md',
        'docs/notater/x.md',
      ],
      finnesSti: (s: string) => s in tekster,
      lesDok: (s: string) => tekster[s] ?? null,
      endredeFiler: (filer: string[], fra: object) => {
        kall.push({ filer, fra });
        return ['lib/a.ts'];
      },
      ferdigePerUke: 2,
    });
    expect(r.uregistrert).toEqual(['docs/annet.md', 'docs/notater/x.md']);
    expect(r.dode_stier).toEqual([{ id: 'PL-S-4', sti: 'docs/flyttet.md' }]);
    expect(r.foreldet.map((f) => f.id)).toEqual(['PL-S-1', 'PL-S-2']);
    expect(r.foreldet[0].grunn).toContain('over 30 dager');
    expect(r.foreldet[1].grunn).toContain('lib/a.ts');
    expect(kall).toEqual([
      { filer: ['lib/a.ts', 'lib/b.ts'], fra: { dato: '2026-10-10', commit: 'abc1234' } },
    ]);
    const statusFunn = r.statusavvik.map((s) => s.grunn).join('\n');
    expect(statusFunn).toContain(
      'køen sier bygget (1/1), men docs/eksport-plan.md § 2 sier ikke startet',
    );
    expect(statusFunn).toContain('s3 peker til ukjent planpost PL-BORTE-1');
    expect(statusFunn).toContain('prosjektet tom har fase plan, men 1 køoppgave(r)');
    expect(r.regelavvik).toEqual([
      expect.objectContaining({
        id: 'PL-S-4',
        regel: 2,
        grunn: expect.stringContaining('står senere'),
      }),
    ]);
    const hull = r.hull.map((h) => `${h.id}: ${h.grunn}`).join('\n');
    expect(hull).toContain('PL-S-3: alle eierspørsmålene er avklart');
    expect(hull).toContain('PL-S-4: prosjektet loest har ingen modul');
    expect(r.antall).toBeGreaterThan(8);
  });
});

describe('koPlan: prioriterMange', () => {
  it('validerer hele lista, er alt eller ingenting, og følger tilgangsreglene til prioriter', () => {
    const reg = register(post('PL-PM-1'), post('PL-PM-2'));
    const form = P.prioriterMange(
      reg,
      [
        { id: 'PL-PM-1', prioritet: 'ukjent' },
        { id: 'PL-PM-1', prioritet: 'senere' },
        { prioritet: 'senere', ekstra: 1 },
        'tekst',
      ],
      ctx(),
    );
    expect(form.feil.join('\n')).toMatch(/prioritet må være en av/);
    expect(form.feil.join('\n')).toContain('PL-PM-1: står flere ganger i lista');
    expect(form.feil.join('\n')).toContain('element 3: ukjent felt ekstra');
    expect(form.feil.join('\n')).toContain('element 4: må være');
    expect(P.prioriterMange(reg, [], ctx()).feil).toHaveLength(1);
    expect(P.prioriterMange(reg, null, ctx()).feil).toHaveLength(1);

    // Kategori utenfor naa og dropp uten grunn: ingenting endres.
    const feil = P.prioriterMange(
      reg,
      [
        { id: 'PL-PM-1', prioritet: 'naa', kategori: ['viktig'], grunn: 'Regel 5: feil.' },
        { id: 'PL-PM-2', prioritet: 'senere', kategori: ['viktig'] },
      ],
      ctx(),
    );
    expect(feil.feil).toEqual(['PL-PM-2: kategori brukes bare med naa']);
    expect(reg.poster.map((p) => p.prioritet)).toEqual(['senere', 'senere']);
    expect(
      P.prioriterMange(reg, [{ id: 'PL-PM-2', prioritet: 'dropp' }], ctx()).feil.join(),
    ).toContain('dropp krever');
    expect(
      P.prioriterMange(reg, [{ id: 'PL-BORTE-1', prioritet: 'senere' }], ctx()).feil,
    ).not.toEqual([]);

    const ok = P.prioriterMange(
      reg,
      [
        { id: 'PL-PM-1', prioritet: 'naa', kategori: ['viktig'], grunn: 'Regel 5: feil.' },
        { id: 'PL-PM-2', prioritet: 'senere' },
      ],
      ctx('eier'),
    );
    expect(ok).toMatchObject({ feil: [], endret: ['PL-PM-1'], uendret: ['PL-PM-2'] });
    expect(reg.poster[0]).toMatchObject({
      prioritet: 'naa',
      naa_kategori: ['viktig'],
      prioritet_satt_av: 'eier',
    });
    // En agent endrer ikke en eier-satt prioritet, heller ikke i en samlet lagring.
    expect(
      P.prioriterMange(
        reg,
        [{ id: 'PL-PM-1', prioritet: 'senere', grunn: 'Regel 8: x.' }],
        ctx(),
      ).feil.join(),
    ).toContain('satt av eieren');
  });

  it('tavla lagrer prioritetskartet med ett prioriter-mange-kall, uten angre-løkke', () => {
    const tavle = readFileSync(join(__dirname, '..', '..', 'ko-tavle.mjs'), 'utf8');
    const kropp = tavle.slice(tavle.indexOf('async function planPrioriter'));
    const fn = kropp.slice(0, kropp.indexOf('\n}\n'));
    expect(fn).toContain("'prioriter-mange'");
    expect(fn).not.toContain("'angre'");
    expect(fn.match(/await koJson\(/g)).toHaveLength(1);
  });
});

describe('koPlan: statusavvik uten falske treff', () => {
  it('dokStatus: et nummer-anker treffer ikke et lengre nummer (9.10 er ikke 9.108)', () => {
    const dok = [
      '# R',
      '### 9.108 Snapshot',
      'Status: ferdig',
      '### 9.10 Annet',
      'Status: utkast',
    ].join('\n');
    expect(P2.dokStatus(dok, '9.10')).toBe('ikke-startet');
    expect(P2.dokStatus(dok, '9.108')).toBe('ferdig');
  });

  it('dokStatus: underavsnitt og en hake i løpende tekst leses ikke som postens status', () => {
    const dok = [
      '### 9.108 Snapshot-motor',
      'Status (verifisert mot skjema): mangler hendelseslogg.',
      '- Logg daglig ved lansering for «✅»-metrikkene.',
      '#### F1 Eldre del',
      'Status: ferdig',
      '### 9.109 Neste',
    ].join('\n');
    expect(P2.dokStatus(dok, '9.108')).toBeNull();
    // En hake først i et listepunkt eller i en tabellcelle er fortsatt et statusmerke.
    expect(P2.dokStatus('## 2. Del\n- ✅ levert\n', '§ 2')).toBe('ferdig');
    expect(P2.dokStatus('## 2. Del\n| a | ✅ |\n', '§ 2')).toBe('ferdig');
  });

  it('dokStatus: i et stort avsnitt leses bare toppen', () => {
    const fyll = Array.from({ length: 40 }, (_, i) => `Linje ${i} om noe annet.`);
    const sent = ['### 9.50 Stor', ...fyll, 'Status: ferdig'].join('\n');
    expect(P2.dokStatus(sent, '9.50')).toBeNull();
    const tidlig = ['### 9.50 Stor', 'Status: ikke startet', ...fyll].join('\n');
    expect(P2.dokStatus(tidlig, '9.50')).toBe('ikke-startet');
  });

  it('sjekk: dropp-poster og kilder med rolle historikk eller referanse gir ikke statusavvik', () => {
    const reg = register(
      post('PL-H-1', {
        prioritet: 'dropp',
        dropp_grunn: 'Historikk.',
        prioritet_grunn: 'Regel 7: dekket.',
        kilder: [{ sti: 'docs/eksport-plan.md' }],
      }),
      post('PL-H-2', {
        kilder: [
          { sti: 'docs/eksport-plan.md', rolle: 'historikk' },
          { sti: 'docs/gamma.md', rolle: 'referanse' },
        ],
      }),
      post('PL-H-3', { kilder: [{ sti: 'docs/eksport-plan.md', rolle: 'plan' }] }),
    );
    const tekster: Record<string, string> = {
      'docs/eksport-plan.md': '# Gammel plan\nStatus: ferdig\n',
      'docs/gamma.md': '# Ref\nStatus: levert\n',
    };
    const r = P2.sjekk(
      reg,
      { prosjekter: PROSJEKTER, oppgaver: [] },
      {
        dokumenter: ['docs/eksport-plan.md', 'docs/gamma.md'],
        finnesSti: (s: string) => s in tekster,
        lesDok: (s: string) => tekster[s] ?? null,
      },
    );
    expect(r.statusavvik.map((x) => x.id)).toEqual(['PL-H-3']);
    expect(r.uregistrert).toEqual([]);
    expect(r.referanser).toEqual([
      { id: 'PL-H-2', sti: 'docs/eksport-plan.md', rolle: 'historikk' },
      { id: 'PL-H-2', sti: 'docs/gamma.md', rolle: 'referanse' },
    ]);
  });
});

describe('ko.mjs: add --plan, endre-mange, prosjekt --fase, plan sjekk, moduler og backup', () => {
  const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');
  let mappe: string;
  let kilder: string;
  function kjor(args: string[], env: Record<string, string> = {}) {
    try {
      const ut = execFileSync(process.execPath, [KO_MJS, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: mappe,
          KO_GIT: mappe,
          KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
          KO_PLAN_KILDEROT: kilder,
          KO_PLAN_BACKUP: join(mappe, 'synk.mjs'),
          ...env,
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
  type Ko = {
    oppgaver: Record<string, unknown>[];
    prosjekter: Record<string, Record<string, unknown>>;
    omrader?: Record<string, { tittel: string }>;
  };
  const lesKo = (): Ko => JSON.parse(readFileSync(join(mappe, 'ko.json'), 'utf8')) as Ko;
  const fil = (navn: string, innhold: unknown) => {
    const sti = join(mappe, navn);
    writeFileSync(sti, JSON.stringify(innhold));
    return sti;
  };
  const oppg = (id: string, extra: object = {}) => ({
    id,
    tittel: `Oppgave ${id}`,
    domene: 'alfa',
    klasse: 'K',
    oppdrag: 'tekst',
    ...extra,
  });

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-plan2-'));
    kilder = join(mappe, 'rot');
    mkdirSync(join(kilder, 'docs'), { recursive: true });
    writeFileSync(join(kilder, 'docs', 'eksport-plan.md'), '# plan\n');
    writeFileSync(join(kilder, 'docs', 'uregistrert.md'), '# annet\n');
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({
        endret: '2026-10-14T08:00:00.000Z',
        oppgaver: [oppg('GAMMEL-1', { prosjekt: 'import', status: 'venter' })],
        prosjekter: { ...PROSJEKTER, nytt: { tittel: 'Nytt', fase: 'plan' } },
        omrader: OMRADER,
        sporsmal: {},
        avklart: [],
      }),
    );
    expect(
      kjor([
        'plan',
        'ny',
        '--fil',
        fil('p.json', [
          post('PL-A-1', { modenhet: 'klar', kilder: [{ sti: 'docs/eksport-plan.md' }] }),
          post('PL-N-1', { prosjekt: 'nytt' }),
        ]),
      ]).kode,
    ).toBe(0);
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('add --plan nekter en ukjent planpost og skriver ingenting', () => {
    const r = kjor(['add', '--fil', fil('a.json', [oppg('A-1')]), '--plan', 'PL-BORTE-1']);
    expect(r.kode).toBe(1);
    expect(r.feil).toContain('A-1: ukjent planpost PL-BORTE-1');
    expect(lesKo().oppgaver).toHaveLength(1);
  });

  it('add --plan kobler, henter prosjektet fra posten, og tar bort fase plan', () => {
    const r = kjor([
      'add',
      '--fil',
      fil('a.json', [oppg('A-1'), oppg('N-1', { plan: 'PL-N-1' })]),
      '--plan',
      'PL-A-1',
    ]);
    expect(r.feil).toBe('');
    expect(r.ut).toContain('Koblet til planpost: PL-A-1, PL-N-1');
    expect(r.ut).toContain('Fase plan tatt bort (har køoppgaver nå): nytt');
    expect(r.ut).toContain('ADVARSEL: planposten PL-N-1 er utredet, ikke klar');
    const ko = lesKo();
    expect(ko.oppgaver.find((o) => o.id === 'A-1')).toMatchObject({
      plan: 'PL-A-1',
      prosjekt: 'eksport',
    });
    expect(ko.prosjekter.nytt.fase).toBeUndefined();
    const vis = JSON.parse(kjor(['plan', 'vis', '--json']).ut) as {
      poster: (Post & { avledet: { modenhet: string } })[];
    };
    expect(vis.poster.find((p) => p.id === 'PL-A-1')?.avledet.modenhet).toBe('i-ko');
  });

  it('endre-mange setter plan på en eksisterende oppgave og nekter en ukjent', () => {
    expect(
      kjor(['endre-mange', '--fil', fil('e.json', [{ id: 'GAMMEL-1', plan: 'PL-NEI-1' }])]).kode,
    ).toBe(1);
    expect(lesKo().oppgaver[0].plan).toBeUndefined();
    expect(
      kjor(['endre-mange', '--fil', fil('e.json', [{ id: 'GAMMEL-1', plan: 'PL-A-1' }])]).kode,
    ).toBe(0);
    expect(lesKo().oppgaver[0].plan).toBe('PL-A-1');
  });

  it('prosjekt --fase plan nektes når prosjektet har køoppgaver, og settes ellers', () => {
    const nekt = kjor(['prosjekt', 'import', '--fase', 'plan']);
    expect(nekt.kode).toBe(1);
    expect(nekt.feil).toContain('fase plan gjelder bare prosjekter uten køoppgaver');
    expect(kjor(['prosjekt', 'eksport', '--fase', 'plan']).kode).toBe(0);
    expect(lesKo().prosjekter.eksport.fase).toBe('plan');
    expect(kjor(['prosjekt', 'eksport', '--fase', 'ingen']).kode).toBe(0);
    expect(lesKo().prosjekter.eksport.fase).toBeUndefined();
  });

  it('plan sjekk --json leser bare og finner uregistrerte dokumenter og hull', () => {
    const koFor = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const r = kjor(['plan', 'sjekk', '--json']);
    expect(r.kode).toBe(0);
    const s = JSON.parse(r.ut) as SjekkSvar & { ok: boolean };
    expect(s.ok).toBe(true);
    expect(s.uregistrert).toEqual(['docs/uregistrert.md']);
    expect(s.hull).toEqual([{ id: 'PL-N-1', grunn: 'prosjektet nytt har ingen modul' }]);
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(koFor);
    expect(kjor(['plan', 'sjekk']).ut).toContain(
      'Uregistrert (ingen post peker til dokumentet) (1)',
    );
  });

  it('plan moduler oppretter de som mangler, rører ikke de som finnes, og --torr skriver ingenting', () => {
    const t = kjor(['plan', 'moduler', '--torr']);
    expect(t.ut).toContain('Forhåndsvisning (ingenting skrevet)');
    expect(Object.keys(lesKo().omrader ?? {})).toEqual(['alfa', 'gamma']);
    expect(kjor(['plan', 'moduler']).kode).toBe(0);
    const omr = lesKo().omrader ?? {};
    expect(Object.keys(omr)).toHaveLength(5);
    expect(omr.alfa.tittel).toBe('Alfa');
    expect(kjor(['plan', 'moduler']).ut).toContain('alle modulene finnes');
  });

  it('plan backup kjører synk.mjs med --push, og en feil i synk gir exit og ingen «ferdig»', () => {
    writeFileSync(
      join(mappe, 'synk.mjs'),
      "import fs from 'node:fs';\nfs.writeFileSync(new URL('./argv.json', import.meta.url), JSON.stringify({ argv: process.argv.slice(2), rot: process.env.KO_ROT }));\n",
    );
    const r = kjor(['plan', 'backup', '--push']);
    expect(r.kode).toBe(0);
    expect(r.ut).toContain('Backup ferdig og pushet.');
    const kalt = JSON.parse(readFileSync(join(mappe, 'argv.json'), 'utf8')) as {
      argv: string[];
      rot: string;
    };
    expect(kalt.argv).toEqual(['--push']);
    expect(kalt.rot).toBeTruthy();
    expect(kjor(['plan', 'backup', '--torr']).ut).toContain('Forhåndsvisning (ingenting kjørt)');
    writeFileSync(join(mappe, 'synk.mjs'), 'process.exit(1);\n');
    const feil = kjor(['plan', 'backup']);
    expect(feil.kode).toBe(1);
    expect(feil.feil).toContain('synk.mjs stoppet (exit 1)');
    expect(kjor(['plan', 'backup'], { KO_PLAN_BACKUP: join(mappe, 'borte.mjs') }).feil).toContain(
      'Fant ikke',
    );
  });
});

// ----: «Arbeider nå» --------------------------------------------------------------------------

type Markor = { post: string; at: string; av: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const A = require('../koPlan') as {
  AKTIV_OKT_TIMER: number;
  erAktivOkt: (m: unknown, o?: { naa?: Date | string }) => boolean;
  aktivePoster: (
    reg: unknown,
    o?: { naa?: Date | string },
  ) => Record<string, { at: string; av: string }>;
  settAktivOkt: (
    reg: Reg & { aktiv_okt?: Markor[] },
    id: string,
    o?: { av?: string | null; naa?: Date | string; slutt?: boolean },
  ) => { feil: string[]; endret: boolean; markor: Markor | null };
};

describe('koPlan: aktiv_okt', () => {
  const NAA = '2026-10-14T12:00:00.000Z';

  it('en markør lever under 2 timer etter siste puls, og dør etter', () => {
    expect(A.AKTIV_OKT_TIMER).toBe(2);
    expect(A.erAktivOkt({ at: '2026-10-14T10:00:01.000Z' }, { naa: NAA })).toBe(true);
    expect(A.erAktivOkt({ at: '2026-10-14T10:00:00.000Z' }, { naa: NAA })).toBe(false);
    expect(A.erAktivOkt({ at: '2026-10-14T12:04:00.000Z' }, { naa: NAA })).toBe(true);
    expect(A.erAktivOkt({ at: '2026-10-14T12:30:00.000Z' }, { naa: NAA })).toBe(false);
    expect(A.erAktivOkt({ at: 'tull' }, { naa: NAA })).toBe(false);
    expect(A.erAktivOkt(null, { naa: NAA })).toBe(false);
  });

  it('setter, bytter ut og fjerner markøren uten å røre poster eller endringslogg', () => {
    const reg = register(post('PL-EKSPORT-1'), post('PL-EKSPORT-2')) as Reg & { aktiv_okt?: Markor[] };
    const postFor = JSON.stringify(reg.poster);
    const loggFor = JSON.stringify(reg.endringslogg);
    const endretFor = reg.endret;

    const s1 = A.settAktivOkt(reg, 'PL-EKSPORT-1', { av: 'økt-a', naa: '2026-10-14T11:00:00.000Z' });
    expect(s1).toMatchObject({ feil: [], endret: true });
    expect(reg.aktiv_okt).toEqual([
      { post: 'PL-EKSPORT-1', at: '2026-10-14T11:00:00.000Z', av: 'økt-a' },
    ]);
    // Ny puls på samme post: én markør, siste vinner.
    A.settAktivOkt(reg, 'PL-EKSPORT-1', { av: 'økt-b', naa: NAA });
    A.settAktivOkt(reg, 'PL-EKSPORT-2', { av: 'økt-a', naa: NAA });
    expect(reg.aktiv_okt).toHaveLength(2);
    expect(A.aktivePoster(reg, { naa: NAA })).toEqual({
      'PL-EKSPORT-1': { at: NAA, av: 'økt-b' },
      'PL-EKSPORT-2': { at: NAA, av: 'økt-a' },
    });

    const s2 = A.settAktivOkt(reg, 'PL-EKSPORT-1', { slutt: true, naa: NAA });
    expect(s2).toMatchObject({ feil: [], endret: true, markor: null });
    expect(Object.keys(A.aktivePoster(reg, { naa: NAA }))).toEqual(['PL-EKSPORT-2']);
    // --slutt uten markør er ingen feil, bare ingen endring.
    expect(A.settAktivOkt(reg, 'PL-EKSPORT-1', { slutt: true, naa: NAA }).endret).toBe(false);

    expect(JSON.stringify(reg.poster)).toBe(postFor);
    expect(JSON.stringify(reg.endringslogg)).toBe(loggFor);
    expect(reg.endret).toBe(endretFor);
  });

  it('døde markører forsvinner fra aktivePoster og ryddes ved neste skriving', () => {
    const reg = register(post('PL-EKSPORT-1'), post('PL-EKSPORT-2')) as Reg & { aktiv_okt?: Markor[] };
    reg.aktiv_okt = [
      { post: 'PL-EKSPORT-1', at: '2026-10-14T08:00:00.000Z', av: 'gammel' },
      { post: 'PL-BORTE-1', at: NAA, av: 'ukjent post' },
    ];
    expect(A.aktivePoster(reg, { naa: NAA })).toEqual({});
    A.settAktivOkt(reg, 'PL-EKSPORT-2', { av: 'ny', naa: NAA });
    expect(reg.aktiv_okt.map((m) => m.post)).toEqual(['PL-BORTE-1', 'PL-EKSPORT-2']);
    expect(Object.keys(A.aktivePoster(reg, { naa: NAA }))).toEqual(['PL-EKSPORT-2']);
  });

  it('nekter ukjent og sammenslått post, og manglende id', () => {
    const reg = register(post('PL-EKSPORT-1'), post('PL-EKSPORT-2'));
    P.slaaSammen(reg, 'PL-EKSPORT-1', ['PL-EKSPORT-2']);
    expect(A.settAktivOkt(reg, 'PL-EKSPORT-9').feil[0]).toContain('finnes ikke');
    expect(A.settAktivOkt(reg, 'PL-EKSPORT-2').feil[0]).toContain('slått sammen inn i PL-EKSPORT-1');
    expect(A.settAktivOkt(reg, '').feil[0]).toContain('mangler post-id');
    expect((reg as { aktiv_okt?: unknown }).aktiv_okt).toBeUndefined();
  });
});

describe('ko.mjs plan aktiv', () => {
  const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');
  let mappe: string;
  function kjor(args: string[]) {
    try {
      const ut = execFileSync(process.execPath, [KO_MJS, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: mappe,
          KO_GIT: mappe,
          KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
          KO_PLAN_KILDEROT: mappe,
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
  const lesReg = () =>
    JSON.parse(readFileSync(join(mappe, 'planer.json'), 'utf8')) as Reg & {
      aktiv_okt?: Markor[];
    };

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-plan-aktiv-'));
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({ endret: '2026-10-14T08:00:00.000Z', oppgaver: [], prosjekter: PROSJEKTER }),
    );
    writeFileSync(join(mappe, 'ny.json'), JSON.stringify([post('PL-EKSPORT-1')]));
    expect(kjor(['plan', 'ny', '--fil', join(mappe, 'ny.json')]).kode).toBe(0);
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('setter og fjerner markøren uten endringslogg og uten å bumpe endret', () => {
    const for_ = lesReg();
    const sett = kjor(['plan', 'aktiv', 'PL-EKSPORT-1', '--av', 'planer-økt', '--json']);
    expect(sett.kode).toBe(0);
    expect(JSON.parse(sett.ut)).toMatchObject({
      ok: true,
      endret: true,
      markor: { av: 'planer-økt' },
    });
    const etter = lesReg();
    expect(etter.aktiv_okt).toEqual([
      expect.objectContaining({ post: 'PL-EKSPORT-1', av: 'planer-økt' }),
    ]);
    expect(etter.endret).toBe(for_.endret);
    expect(etter.endringslogg).toEqual(for_.endringslogg);

    const liste = JSON.parse(kjor(['plan', 'aktiv', '--json']).ut) as { aktive: object };
    expect(Object.keys(liste.aktive)).toEqual(['PL-EKSPORT-1']);
    const vis = JSON.parse(kjor(['plan', 'vis', '--json']).ut) as { aktive: object };
    expect(Object.keys(vis.aktive)).toEqual(['PL-EKSPORT-1']);

    expect(kjor(['plan', 'aktiv', 'PL-EKSPORT-1', '--slutt']).ut).toContain('markøren er fjernet');
    expect(lesReg().aktiv_okt).toEqual([]);
    expect(kjor(['plan', 'aktiv']).ut).toContain('Ingen planposter er under arbeid nå');
  });

  it('nekter en ukjent post og skriver ingenting', () => {
    const for_ = readFileSync(join(mappe, 'planer.json'), 'utf8');
    const r = kjor(['plan', 'aktiv', 'PL-BORTE-1']);
    expect(r.kode).toBe(1);
    expect(r.feil).toContain('finnes ikke');
    expect(readFileSync(join(mappe, 'planer.json'), 'utf8')).toBe(for_);
  });
});

// ----: konsistenssjekkene for Dokumenter og avtaler ----------------------------------------------
type DokFunn = { dok: string | null; sjekk: string; alvor: string; tekst: string };
type DokReg = Reg & { dokumenter: Record<string, unknown>[] };
type Leverandor = { id: string; navn?: string; ord?: string[]; dokumenter?: unknown[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../koPlan') as {
  DOK_SJEKKER: string[];
  leverandorerITekst: (
    t: string,
    o?: { bareTabell?: boolean; leverandorer?: Leverandor[] },
  ) => string[];
  seksjonITekst: (t: string, overskrift: RegExp) => string | null;
  sjekkLeverandorer: (reg: object, ko: object, ctx: object) => DokFunn[];
  sjekkRevisjoner: (reg: object, o?: { naa?: Date }) => DokFunn[];
  vurderNettsvar: (dok: object, pub: object, svar: object) => DokFunn[];
  nettAdresser: (reg: object) => { dok: { id: string }; pub: { url: string } }[];
  dokKonsistens: (reg: object, ko: object, ctx?: object) => { funn: DokFunn[]; kjorte: string[] };
  synkKonsistens: (
    reg: object,
    funn: DokFunn[],
    kjorte: string[],
    ctx?: object,
  ) => { feil: string[]; advarsler: string[]; endret: string[] };
  validerDok: (d: object, ctx?: object) => { feil: string[]; advarsler: string[] };
  sjekk: (reg: object, ko: object, ctx?: object) => { antall: number; dok_konsistens?: DokFunn[] };
  tomtRegister: (naa?: string) => DokReg;
};

// Leverandørlista i testene (i et prosjekt står den i ko.config.json under dokumenter.leverandorer). Navnene er
// oppdiktet.
const LEVERANDORER: Leverandor[] = [
  { id: 'nordlager', navn: 'Nordlager', dokumenter: ['DOK-LEVERANDOR'] },
  { id: 'postbud', navn: 'Postbud', dokumenter: ['DOK-LEVERANDOR'] },
  { id: 'brevdue', navn: 'Brevdue', dokumenter: ['DOK-LEVERANDOR'] },
  { id: 'taleverk', navn: 'Taleverk', dokumenter: ['DOK-LEVERANDOR'] },
  {
    id: 'faktura',
    navn: 'Fakturaservice',
    dokumenter: [
      {
        dok: 'DOK-ERKLARING',
        seksjon: '^Hvem vi deler med',
        hvor: 'DOK-ERKLARING (Hvem vi deler med)',
      },
    ],
  },
];
const BYTTER = [{ ut: 'postbud', inn: 'brevdue', planpost: 'PL-BYTTE-1' }];

describe('koPlan: leverandører, revisjon og nett', () => {
  const UL = [
    '| Leverandør | Tjeneste |',
    '|---|---|',
    '| **Nordlager AS** | Database |',
    '| **Postbud Inc.** | E-post, nevner Taleverk i teksten |',
  ].join('\n');
  const MANIFEST = 'NORDLAGER_URL, POSTBUD_API_KEY, BREVDUE_API_KEY og FAKTURASERVICE_TOKEN';
  const PV = [
    '### Hvilke opplysninger vi behandler',
    'Fakturering via Fakturaservice.',
    '### Hvem vi deler med',
    'Nordlager (lagring).',
    '### Dine rettigheter',
  ].join('\n');
  const regMed = (dokumenter: object[], poster: object[] = []) => ({ dokumenter, poster });
  const ul = {
    id: 'DOK-LEVERANDOR',
    status: 'utkast',
    kilde: 'ul.md',
    gruppe: 'personvern',
    malgruppe: 'kunde',
  };
  const pv = {
    id: 'DOK-ERKLARING',
    status: 'utkast',
    kilde: 'pv.md',
    gruppe: 'personvern',
    malgruppe: 'offentlig',
  };
  const avtale = {
    id: 'DOK-AVTALE',
    status: 'utkast',
    kilde: 'avtale.md',
    gruppe: 'kundeavtaler',
    malgruppe: 'kunde',
  };
  const intern = { ...avtale, id: 'DOK-INTERN', gruppe: 'styring', malgruppe: 'intern' };
  const kjor = (
    tekster: Record<string, string>,
    dokumenter: object[] = [ul, pv, avtale, intern],
    ekstra: object = {},
  ) =>
    K.sjekkLeverandorer(regMed(dokumenter), {}, {
      lesDok: (s: string) => tekster[s] ?? null,
      leverandorer: LEVERANDORER,
      secretsManifest: 'docs/secrets-manifest.md',
      leverandorBytter: BYTTER,
      ...ekstra,
    });

  it('leverandorerITekst ser bare første celle i tabellmodus, og ord inne i andre ord teller ikke', () => {
    const o = { leverandorer: LEVERANDORER };
    expect(K.leverandorerITekst(UL, { ...o, bareTabell: true }).sort()).toEqual([
      'nordlager',
      'postbud',
    ]);
    expect(K.leverandorerITekst('POSTBUD_API_KEY og postbudet', o)).toEqual(['postbud']);
    // Uten liste i konfigurasjonen finnes ingen leverandører
    expect(K.leverandorerITekst(UL)).toEqual([]);
  });

  it('seksjonITekst gir teksten under overskriften fram til neste på samme nivå, ellers null', () => {
    expect(K.seksjonITekst(PV, /^Hvem vi deler med/)).toBe('Nordlager (lagring).');
    expect(K.seksjonITekst('# A\n## B\ntekst\n### C\nunder\n## D', /^B$/)).toBe(
      'tekst\n### C\nunder',
    );
    expect(K.seksjonITekst(PV, /^Finnes ikke/)).toBeNull();
  });

  it('melder leverandør i manifestet som mangler i dokumentet, en i dokumentet som ikke er i bruk, og byttet', () => {
    const funn = kjor({
      'docs/secrets-manifest.md': MANIFEST,
      'ul.md': UL,
      'pv.md': PV,
      'avtale.md': 'E-post sendes via Postbud.',
    });
    // Brevdue står i manifestet, men ikke i lista: høyt funn
    expect(funn).toContainEqual(
      expect.objectContaining({
        dok: 'DOK-LEVERANDOR',
        sjekk: 'leverandor',
        alvor: 'hoy',
        tekst: expect.stringContaining('Brevdue er i bruk'),
      }),
    );
    // Taleverk står i lista, men ikke i manifestet: lavt funn (fortsatt i bruk?)
    expect(funn).toContainEqual(
      expect.objectContaining({
        dok: 'DOK-LEVERANDOR',
        alvor: 'lav',
        tekst: expect.stringContaining('Taleverk står i DOK-LEVERANDOR'),
      }),
    );
    // Fakturaservice står bare under feil overskrift i erklæringen: høyt funn
    expect(funn).toContainEqual(
      expect.objectContaining({
        dok: 'DOK-ERKLARING',
        alvor: 'hoy',
        tekst: expect.stringContaining('DOK-ERKLARING (Hvem vi deler med)'),
      }),
    );
    // Postbud er på vei ut; planposten finnes ikke, så byttet er planlagt (middels)
    expect(funn).toContainEqual(
      expect.objectContaining({
        dok: 'DOK-AVTALE',
        alvor: 'middels',
        tekst: expect.stringContaining('Nevner Postbud; skal byttes til Brevdue (PL-BYTTE-1, planlagt)'),
      }),
    );
    // Postbud regnes ikke som manglende noe sted, og interne dokumenter sjekkes ikke for bytter
    expect(funn.some((f) => /^Postbud er i bruk/.test(f.tekst))).toBe(false);
    expect(funn.some((f) => f.dok === 'DOK-INTERN')).toBe(false);
  });

  it('er stille når alt står riktig', () => {
    const ulRiktig = `${UL}\n| **Brevdue** | E-post |`.replace(
      '| **Postbud Inc.** | E-post, nevner Taleverk i teksten |',
      '| **Postbud Inc.** | E-post |',
    );
    const pvRiktig = PV.replace('Nordlager (lagring).', 'Nordlager (lagring) og Fakturaservice.');
    const funn = kjor(
      { 'docs/secrets-manifest.md': MANIFEST, 'ul.md': ulRiktig, 'pv.md': pvRiktig },
      [ul, pv],
      { leverandorBytter: [] },
    );
    expect(funn).toEqual([]);
  });

  it('uten manifest regnes alle i lista som i bruk; dokument som mangler eller ikke kan leses gir middels funn', () => {
    const utenManifest = kjor({ 'ul.md': UL, 'pv.md': PV }, [ul, pv], {
      secretsManifest: null,
      leverandorBytter: [],
    });
    expect(utenManifest.map((f) => f.tekst.split(' ')[0]).sort()).toEqual([
      'Brevdue',
      'Fakturaservice',
    ]);
    expect(utenManifest.some((f) => f.alvor === 'lav')).toBe(false);

    const utenDok = kjor({ 'ul.md': UL }, [ul], { secretsManifest: null, leverandorBytter: [] });
    expect(utenDok).toContainEqual(
      expect.objectContaining({
        dok: null,
        alvor: 'middels',
        tekst: expect.stringContaining('DOK-ERKLARING står ikke i dokumentregisteret'),
      }),
    );
    const utenKilde = kjor({ 'ul.md': UL }, [ul, pv], {
      secretsManifest: null,
      leverandorBytter: [],
    });
    expect(utenKilde).toContainEqual(
      expect.objectContaining({
        dok: 'DOK-ERKLARING',
        alvor: 'middels',
        tekst: expect.stringContaining('pv.md'),
      }),
    );
    // Manifestet som ikke finnes, gir et lavt funn uten dokument
    const borte = kjor({ 'ul.md': UL, 'pv.md': PV }, [ul, pv], { leverandorBytter: [] });
    expect(borte).toContainEqual(
      expect.objectContaining({ dok: null, alvor: 'lav', tekst: expect.stringContaining('Fant ikke') }),
    );
  });

  it('forfalte revisjoner og nettsjekken', () => {
    const d = {
      id: 'DOK-X',
      status: 'utkast',
      sist_revidert: '2025-01-01',
      revisjon_hver: '12 mnd',
    };
    expect(K.sjekkRevisjoner(regMed([d]), { naa: new Date('2026-10-15T10:00:00Z') })).toEqual([
      expect.objectContaining({ dok: 'DOK-X', sjekk: 'revisjon' }),
    ]);
    const dok = { id: 'DOK-P', malgruppe: 'offentlig', gruppe: 'personvern' };
    const pub = { hvor: 'nettside', url: 'https://eksempel.no/p', versjon: '1.2' };
    expect(K.vurderNettsvar(dok, pub, { status: 200, tekst: 'Versjon 1.2 (gjeldende)' })).toEqual(
      [],
    );
    expect(K.vurderNettsvar(dok, pub, { status: 200, tekst: 'Versjon 1.21' })[0].tekst).toContain(
      'viser ikke versjon 1.2',
    );
    expect(K.vurderNettsvar(dok, pub, { status: 404, tekst: '' })[0]).toMatchObject({
      alvor: 'hoy',
    });
    expect(K.vurderNettsvar(dok, pub, { feil: 'tidsavbrudd' })[0].tekst).toContain('svarer ikke');
    const reg = regMed([
      { ...dok, status: 'utkast', publisert: [pub, { hvor: 'admin', sti: 'x' }] },
    ]);
    expect(K.nettAdresser(reg).map((x) => x.pub.url)).toEqual(['https://eksempel.no/p']);
  });
});

describe('koPlan: dokKonsistens, synk til problemer, moduler og plan sjekk', () => {
  const NAA = '2026-10-15T10:00:00.000Z';
  const ny = (felt: Record<string, unknown>) => ({
    gruppe: 'personvern',
    malgruppe: 'intern',
    status: 'utkast',
    tittel: 'Tittel',
    opprettet: NAA,
    ...felt,
  });

  it('validerDok godtar kjente moduler og avviser ukjente', () => {
    expect(K.validerDok(ny({ id: 'DOK-VURDERING', moduler: ['alfa', 'beta'] })).feil).toEqual([]);
    expect(K.validerDok(ny({ id: 'DOK-VURDERING', moduler: ['tull'] })).feil.join()).toContain(
      'ukjent modul tull',
    );
    expect(K.validerDok(ny({ id: 'DOK-VURDERING', moduler: 'alfa' })).feil.join()).toContain(
      'moduler må være en liste',
    );
  });

  it('synkKonsistens erstatter bare problemene fra sjekkene som kjørte, og rører ikke andres', () => {
    const reg = K.tomtRegister(NAA);
    reg.dokumenter = [
      ny({
        id: 'DOK-A',
        problemer: [
          { tekst: 'Skrevet av eieren', alvor: 'lav' },
          { tekst: 'Gammelt funn', alvor: 'middels', kilde: 'sjekk:leverandor' },
          { tekst: 'Nettfunn', alvor: 'middels', kilde: 'sjekk:nett' },
        ],
      }),
      ny({ id: 'DOK-B' }),
    ];
    const funn: DokFunn[] = [
      { dok: 'DOK-A', sjekk: 'leverandor', alvor: 'hoy', tekst: 'Nytt funn' },
      { dok: 'DOK-B', sjekk: 'revisjon', alvor: 'middels', tekst: 'Forfalt' },
      { dok: null, sjekk: 'leverandor', alvor: 'lav', tekst: 'Uten dokument' },
    ];
    const s = K.synkKonsistens(reg, funn, ['leverandor', 'revisjon'], { naa: NAA });
    expect(s.feil).toEqual([]);
    expect(s.endret).toEqual(['DOK-A']);
    expect(reg.dokumenter[0].problemer).toEqual([
      { tekst: 'Skrevet av eieren', alvor: 'lav' },
      { tekst: 'Nettfunn', alvor: 'middels', kilde: 'sjekk:nett' },
      { tekst: 'Nytt funn', alvor: 'hoy', kilde: 'sjekk:leverandor' },
    ]);
    // Revisjoner føres aldri som problem
    expect(reg.dokumenter[1].problemer).toBeUndefined();
    // Samme funn en gang til: ingenting endres
    expect(K.synkKonsistens(reg, funn, ['leverandor'], { naa: NAA }).endret).toEqual([]);
  });

  it('dokKonsistens er tom uten dokumenter, leverandørsjekken kjører bare med en liste, og plan sjekk teller funnene', () => {
    expect(K.DOK_SJEKKER).toEqual(['leverandor', 'revisjon', 'nett']);
    const tom = K.tomtRegister(NAA);
    expect(K.dokKonsistens(tom, {})).toEqual({ funn: [], kjorte: [] });
    expect(K.sjekk(tom, {}, { naa: new Date(NAA) }).dok_konsistens).toBeUndefined();
    const reg = K.tomtRegister(NAA);
    reg.dokumenter = [ny({ id: 'DOK-X', sist_revidert: '2025-01-01', revisjon_hver: '12 mnd' })];
    // Uten leverandørliste i konfigurasjonen kjører bare revisjonssjekken
    const r = K.dokKonsistens(reg, {}, { naa: new Date(NAA), lesDok: () => null });
    expect(r.kjorte).toEqual(['revisjon']);
    const medListe = K.dokKonsistens(reg, {}, {
      naa: new Date(NAA),
      lesDok: () => null,
      leverandorer: LEVERANDORER,
      secretsManifest: null,
    });
    expect(medListe.kjorte).toEqual(['leverandor', 'revisjon']);
    const s = K.sjekk(reg, {}, { naa: new Date(NAA) });
    expect(s.dok_konsistens).toHaveLength(1);
    expect(s.antall).toBeGreaterThanOrEqual(1);
  });
});

describe('ko.mjs plan dok sjekk, mot en kopi i en midlertidig mappe', () => {
  const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');
  let mappe: string;
  let rot: string;
  const kjor = (args: string[]) => {
    try {
      const ut = execFileSync(process.execPath, [KO_MJS, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: mappe,
          KO_GIT: mappe,
          KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
          KO_PLAN_KILDEROT: rot,
          // Egen konfigurasjon med leverandørlista, manifestet og byttet.
          KO_KONFIG: join(mappe, 'ko.config.json'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { kode: 0, ut, feil: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { kode: x.status, ut: x.stdout ?? '', feil: x.stderr ?? '' };
    }
  };
  const lesReg = () => JSON.parse(readFileSync(join(mappe, 'planer.json'), 'utf8')) as DokReg;

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-plan-dok-'));
    rot = join(mappe, 'rot');
    mkdirSync(join(rot, 'docs'), { recursive: true });
    writeFileSync(
      join(mappe, 'ko.config.json'),
      JSON.stringify({
        moduler: [{ oid: 'alfa', tittel: 'Alfa' }],
        dokumenter: {
          leverandorer: LEVERANDORER.slice(0, 3),
          secretsManifest: 'docs/secrets-manifest.md',
          leverandorBytter: BYTTER,
        },
      }),
    );
    writeFileSync(join(rot, 'docs', 'secrets-manifest.md'), 'NORDLAGER og BREVDUE_API_KEY\n');
    writeFileSync(
      join(rot, 'docs', 'leverandorer.md'),
      '| **Nordlager** | db |\n| **Postbud** | e-post |\n',
    );
    writeFileSync(join(rot, 'docs', 'avtale.md'), 'E-post sendes via Postbud.\n');
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({
        oppgaver: [],
        prosjekter: PROSJEKTER,
        omrader: OMRADER,
        sporsmal: {},
        avklart: [],
      }),
    );
    const dok = [
      {
        gruppe: 'personvern',
        status: 'utkast',
        id: 'DOK-LEVERANDOR',
        tittel: 'Leverandører',
        malgruppe: 'intern',
        kilde: 'docs/leverandorer.md',
      },
      {
        gruppe: 'kundeavtaler',
        status: 'utkast',
        id: 'DOK-AVTALE',
        tittel: 'Kundeavtale',
        malgruppe: 'kunde',
        kilde: 'docs/avtale.md',
      },
    ];
    writeFileSync(join(mappe, 'dok.json'), JSON.stringify(dok));
    expect(kjor(['plan', 'dok', 'ny', '--fil', join(mappe, 'dok.json')]).kode).toBe(0);
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('viser funnene, skriver dem som problemer med --skriv, og angre fjerner dem', () => {
    const vis = kjor(['plan', 'dok', 'sjekk', '--json']);
    expect(vis.kode).toBe(0);
    const v = JSON.parse(vis.ut) as { kjorte: string[]; funn: DokFunn[] };
    expect(v.kjorte).toEqual(['leverandor', 'revisjon']);
    expect(v.funn).toContainEqual(
      expect.objectContaining({
        dok: 'DOK-LEVERANDOR',
        sjekk: 'leverandor',
        alvor: 'hoy',
        tekst: expect.stringContaining('Brevdue er i bruk'),
      }),
    );
    expect(v.funn).toContainEqual(
      expect.objectContaining({
        dok: 'DOK-AVTALE',
        alvor: 'middels',
        tekst: expect.stringContaining('Nevner Postbud'),
      }),
    );
    // Uten --skriv endres ingenting
    expect(lesReg().dokumenter.every((d) => !d.problemer)).toBe(true);

    const torr = kjor(['plan', 'dok', 'sjekk', '--skriv', '--torr']);
    expect(torr.ut).toContain('Forhåndsvisning (ingenting skrevet)');
    expect(lesReg().dokumenter.every((d) => !d.problemer)).toBe(true);

    const skriv = kjor(['plan', 'dok', 'sjekk', '--skriv']);
    expect(skriv.kode).toBe(0);
    expect(skriv.ut).toContain('Problemer oppdatert i 2 dokument(er)');
    const lev = lesReg().dokumenter.find((d) => d.id === 'DOK-LEVERANDOR') as {
      problemer: { kilde: string }[];
    };
    expect(lev.problemer[0].kilde).toBe('sjekk:leverandor');

    // plan sjekk viser dem i egen del
    expect(kjor(['plan', 'sjekk']).ut).toContain('Dokumenter og avtaler');

    expect(kjor(['plan', 'angre']).kode).toBe(0);
    expect(lesReg().dokumenter.every((d) => !d.problemer)).toBe(true);
  });
});
