// =============================================================
// koLogikk.test.ts: arbeidskøen (lib/koLogikk.js): valg av neste oppgave, eierskapskonflikter,
// grenser (samtidige, D+, per domene), avhengigheter, eierspørsmål, prioritet og migrasjonsblokker.
// =============================================================
import { describe, it, expect } from 'vitest';

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
  prioritet_tillegg?: number;
  migr_tiere?: number;
};
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  grenser?: { maksSamtidig?: number; maksDPluss?: number; maksPerDomene?: number; maksDb?: number };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../koLogikk') as {
  STANDARD_GRENSER: {
    maksSamtidig: number;
    maksDPluss: number;
    maksPerDomene: number;
    maksDb: number;
  };
  anslag: (o: Oppgave) => number;
  valider: (o: unknown, eks?: Oppgave[]) => string[];
  filOverlapp: (a: string, b: string) => boolean;
  konflikt: (a: Oppgave, b: Oppgave) => string | null;
  hindringer: (o: Oppgave, alle: Oppgave[], avklart?: string[]) => string[];
  lasOppAntall: (id: string, alle: Oppgave[]) => number;
  score: (o: Oppgave, alle: Oppgave[], naa?: number) => number;
  velgNeste: (ko: Ko, naa?: number) => { id: string; score: number; anslag: number }[];
  tildelMigrBlokk: (
    neste: number,
    tiere: number,
  ) => { fra: number | null; til: number | null; nesteLedig: number };
  tilstand: (ko: Ko) => {
    aktive: number;
    venter: number;
    kanStarte: number;
    tom: boolean;
    blokkert: { id: string; hindringer: string[] }[];
    eiersporsmal: { sp: string; oppgaver: number }[];
  };
};

const NAA = Date.parse('2026-09-28T12:00:00Z');
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

describe('anslag og validering', () => {
  it('anslag = innhold × vekt', () => {
    expect(K.anslag(o('a', { innhold_min: 30, klasse: 'K' }))).toBe(30);
    expect(K.anslag(o('a', { innhold_min: 30, klasse: 'D+' }))).toBe(54);
    expect(K.anslag(o('a', { innhold_min: 30, klasse: 'U' }))).toBe(18);
  });
  it('valider fanger manglende felt, ugyldig klasse og duplikat-id', () => {
    expect(K.valider(o('a'))).toEqual([]);
    expect(K.valider({ id: 'a' })).toEqual(
      expect.arrayContaining([
        'tittel mangler',
        'domene mangler',
        'oppdrag mangler (sti til sporbeskrivelse eller tekst)',
      ]),
    );
    expect(K.valider(o('a', { klasse: 'X' as never })).join()).toMatch(/klasse/);
    expect(K.valider(o('a'), [o('a')]).join()).toMatch(/finnes fra før/);
    expect(K.valider(o('a b')).join()).toMatch(/id/);
  });
});

describe('eierskap', () => {
  it('mappe med / eier alt under, ellers eksakt sti; skråstreker normaliseres', () => {
    expect(K.filOverlapp('app/(app)/liste.tsx', 'app\\(app)\\liste.tsx')).toBe(true);
    expect(K.filOverlapp('components/liste/', 'components/liste/UkeMatrise.tsx')).toBe(
      true,
    );
    expect(K.filOverlapp('components/liste/UkeMatrise.tsx', 'components/liste/')).toBe(
      true,
    );
    expect(K.filOverlapp('components/ui/', 'components/liste/X.tsx')).toBe(false);
    expect(K.filOverlapp('a.ts', 'b.ts')).toBe(false);
  });
  it('konflikt på fil, DB-funksjon (uten hensyn til store bokstaver) og delt patch', () => {
    const aktiv = o('A', {
      status: 'kjorer',
      eier_filer: ['x.ts'],
      eier_db: ['claim_open_shift'],
      delt_patch: ['anonymize_user'],
    });
    expect(K.konflikt(o('b', { eier_filer: ['x.ts'] }), aktiv)).toMatch(/fil/);
    expect(K.konflikt(o('b', { eier_db: ['CLAIM_OPEN_SHIFT'] }), aktiv)).toMatch(/DB-funksjon/);
    expect(K.konflikt(o('b', { delt_patch: ['anonymize_user'] }), aktiv)).toMatch(/delt patch/);
    expect(K.konflikt(o('b', { eier_filer: ['y.ts'] }), aktiv)).toBeNull();
  });
});

describe('hindringer', () => {
  it('avhengighet som ikke er ferdig, og ukjent avhengighet', () => {
    const alle = [o('A', { status: 'kjorer' }), o('b', { avhenger: ['A', 'Z'] })];
    const h = K.hindringer(alle[1], alle);
    expect(h.join()).toMatch(/venter på A/);
    expect(h.join()).toMatch(/ukjent Z/);
  });
  it('eierspørsmål blokkerer til det er avklart', () => {
    const b = o('b', { venter_paa: ['Ø9'] });
    expect(K.hindringer(b, [b]).join()).toMatch(/Ø9/);
    expect(K.hindringer(b, [b], ['Ø9'])).toEqual([]);
  });
  it('en oppgave i review holder fortsatt eierskapet', () => {
    const alle = [
      o('A', { status: 'review', eier_filer: ['x.ts'] }),
      o('b', { eier_filer: ['x.ts'] }),
    ];
    expect(K.hindringer(alle[1], alle).join()).toMatch(/eies av A/);
  });
});

describe('standardgrenser', () => {
  // Standardgrensene: få samtidige agenter og D+-spor, for å spare tokens.
  it('er 5 samtidige og 2 D+ når ko.json ikke setter noe', () => {
    expect(K.STANDARD_GRENSER.maksSamtidig).toBe(5);
    expect(K.STANDARD_GRENSER.maksDPluss).toBe(2);
  });

  it('begrenser velgNeste til 5 når køen ikke har egne grenser', () => {
    const oppgaver = Array.from({ length: 8 }, (_, i) =>
      o(`S${i}`, { domene: `d${i}`, eier_filer: [`f${i}.ts`] }),
    );
    expect(ider({ oppgaver })).toHaveLength(5);
  });
});

describe('velgNeste', () => {
  it('fyller ledige plasser i prioritert rekkefølge', () => {
    const ko: Ko = {
      grenser: { maksSamtidig: 2 },
      oppgaver: [o('lav', { nytte: 2 }), o('hoy', { nytte: 9 }), o('mid', { nytte: 5 })],
    };
    expect(ider(ko)).toEqual(['hoy', 'mid']);
  });
  it('trekker fra plasser som er i bruk', () => {
    const ko: Ko = {
      grenser: { maksSamtidig: 2 },
      oppgaver: [o('A', { status: 'kjorer' }), o('b'), o('c')],
    };
    expect(ider(ko)).toHaveLength(1);
  });
  it('to kandidater som eier samme fil, startes ikke samtidig', () => {
    const ko: Ko = {
      oppgaver: [
        o('a', { nytte: 9, eier_filer: ['v.tsx'] }),
        o('b', { nytte: 8, eier_filer: ['v.tsx'] }),
        o('c'),
      ],
    };
    expect(ider(ko)).toEqual(expect.arrayContaining(['a', 'c']));
    expect(ider(ko)).not.toContain('b');
  });
  it('taket for D+ holdes, og andre klasser fyller resten', () => {
    const ko: Ko = {
      grenser: { maksDPluss: 1 },
      oppgaver: [
        o('A', { status: 'kjorer', klasse: 'D+' }),
        o('b', { klasse: 'D+', nytte: 10 }),
        o('c', { klasse: 'K' }),
      ],
    };
    expect(ider(ko)).toEqual(['c']);
  });
  it('taket for spor med migrasjoner holdes, klientspor fyller resten', () => {
    const ko: Ko = {
      grenser: { maksDb: 1 },
      oppgaver: [
        o('A', { status: 'kjorer', klasse: 'D', migr_tiere: 1 }),
        o('b', { klasse: 'D', nytte: 10, migr_tiere: 1 }),
        o('c', { klasse: 'K', migr_tiere: 0 }),
      ],
    };
    expect(ider(ko)).toEqual(['c']);
  });
  it('taket per domene holdes', () => {
    const ko: Ko = {
      grenser: { maksPerDomene: 1 },
      oppgaver: [
        o('a', { domene: 'ui', nytte: 9 }),
        o('b', { domene: 'ui' }),
        o('c', { domene: 'gamma' }),
      ],
    };
    expect(ider(ko)).toEqual(['a', 'c']);
  });
  it('blokkerte oppgaver velges ikke', () => {
    const ko: Ko = { oppgaver: [o('a', { venter_paa: ['E-V3'] }), o('b', { avhenger: ['a'] })] };
    expect(ider(ko)).toEqual([]);
  });
});

describe('prioritet', () => {
  it('en oppgave som låser opp andre, rangeres over en ellers lik oppgave', () => {
    const alle = [
      o('grunn'),
      o('annen'),
      o('b1', { avhenger: ['grunn'] }),
      o('b2', { avhenger: ['b1'] }),
    ];
    expect(K.lasOppAntall('grunn', alle)).toBe(2);
    expect(K.score(alle[0], alle, NAA)).toBeGreaterThan(K.score(alle[1], alle, NAA));
  });
  it('kortere anslag med samme nytte rangeres høyere; manuelt tillegg virker', () => {
    const kort = o('kort', { innhold_min: 20 });
    const lang = o('lang', { innhold_min: 40, klasse: 'D+' });
    expect(K.score(kort, [kort, lang], NAA)).toBeGreaterThan(K.score(lang, [kort, lang], NAA));
    const lang2 = { ...lang, prioritet_tillegg: 1000 };
    expect(K.score(lang2, [kort, lang2], NAA)).toBeGreaterThan(K.score(kort, [kort, lang2], NAA));
  });
  it('ferdige avhengige teller ikke som låst opp', () => {
    const alle = [o('grunn'), o('b1', { avhenger: ['grunn'], status: 'ferdig' })];
    expect(K.lasOppAntall('grunn', alle)).toBe(0);
  });
});

describe('migrasjonsblokker og tilstand', () => {
  it('blokker starter på hel tier og følger hverandre', () => {
    expect(K.tildelMigrBlokk(2840, 2)).toEqual({ fra: 2840, til: 2859, nesteLedig: 2860 });
    expect(K.tildelMigrBlokk(2861, 1)).toEqual({ fra: 2870, til: 2879, nesteLedig: 2880 });
    expect(K.tildelMigrBlokk(2861, 0)).toEqual({ fra: null, til: null, nesteLedig: 2861 });
  });
  it('tom = ingenting kjører og ingenting kan startes; eierspørsmål sorteres etter hvor mye de låser opp', () => {
    const ko: Ko = {
      oppgaver: [
        o('a', { venter_paa: ['Ø9'] }),
        o('b', { venter_paa: ['Ø9', 'E-V3'] }),
        o('c', { status: 'ferdig' }),
      ],
    };
    const t = K.tilstand(ko);
    expect(t.tom).toBe(true);
    expect(t.eiersporsmal[0]).toEqual({ sp: 'Ø9', oppgaver: 2 });
    expect(t.blokkert.map((b) => b.id)).toEqual(['a', 'b']);
    expect(K.tilstand({ oppgaver: [o('x', { status: 'kjorer' })] }).tom).toBe(false);
  });
});
