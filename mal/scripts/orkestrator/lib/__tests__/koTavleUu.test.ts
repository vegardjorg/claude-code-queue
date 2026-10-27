// =============================================================
// koTavleUu.test.ts: den rene tilgjengelighetslogikken i køtavla (scripts/orkestrator/ko-tavle/uu.js).
//
// Testene beviser at:
//   - fokusfella går rundt i begge ender og tåler fokus utenfor lista og tom liste (én fella for alle dialogene),
//   - toast-køen aldri har samme melding to ganger, legger den nyeste nederst og aldri skyver ut «Angre»,
//   - det merkede kortet holder minst 4,5:1 i begge modi, regnet ut fra paletten (PALETT i lib/koTavle.js),
//   - fanene følger piltastene, Home og End,
//   - tegnforklaringen og WIP-teksten er lesbar tekst, nøkkelen leses fra #-delen av lenken, og temaet har tre valg.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PALETT } = require('../koTavle.js') as {
  PALETT: { lys: Record<string, string>; mork: Record<string, string> };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const U = require('../../ko-tavle/uu.js') as {
  nesteIFella: (antall: number, i: number, bakover: boolean) => number;
  toastLegg: (
    ko: string[],
    nokkel: string,
    valg?: { maks?: number; beholdes?: string[] },
  ) => string[];
  toastFjern: (ko: string[], nokkel: string) => string[];
  kontrast: (a: string, b: string) => number;
  faneMaal: (antall: number, i: number, tast: string) => number | null;
  KLASSER: { klasse: string; navn: string; forklaring: string }[];
  klasseEtikett: (k: string) => string;
  wipTekst: (w: {
    agenter: number;
    maks: number;
    dPluss: number;
    maksDPluss: number;
    plukket?: number;
  }) => string;
  nokkelFraLenke: (tekst: string) => string | null;
  temaFraLagret: (v: string | null) => string;
  nesteTema: (v: string | null) => string;
};

describe('fokusfella (nesteIFella)', () => {
  it('Tab går fram og rundt fra siste til første', () => {
    expect(U.nesteIFella(3, 0, false)).toBe(1);
    expect(U.nesteIFella(3, 2, false)).toBe(0);
  });
  it('Shift+Tab går bakover og rundt fra første til siste', () => {
    expect(U.nesteIFella(3, 2, true)).toBe(1);
    expect(U.nesteIFella(3, 0, true)).toBe(2);
  });
  it('fokus utenfor lista (-1) går til første med Tab og siste med Shift+Tab', () => {
    expect(U.nesteIFella(3, -1, false)).toBe(0);
    expect(U.nesteIFella(3, -1, true)).toBe(2);
  });
  it('tom dialog gir -1 (ingenting å fokusere)', () => {
    expect(U.nesteIFella(0, -1, false)).toBe(-1);
    expect(U.nesteIFella(0, 0, true)).toBe(-1);
  });
  it('ett element: fokus blir der', () => {
    expect(U.nesteIFella(1, 0, false)).toBe(0);
    expect(U.nesteIFella(1, 0, true)).toBe(0);
  });
});

describe('toast-køen (én stabel)', () => {
  it('legger nyeste nederst og har aldri samme nøkkel to ganger', () => {
    let ko: string[] = [];
    ko = U.toastLegg(ko, 'angre');
    ko = U.toastLegg(ko, 'melding');
    expect(ko).toEqual(['angre', 'melding']);
    ko = U.toastLegg(ko, 'angre');
    expect(ko).toEqual(['melding', 'angre']);
  });
  it('over maks faller den eldste ut, men aldri en som skal beholdes', () => {
    const ko = U.toastLegg(['angre', 'a', 'b'], 'c', { maks: 3, beholdes: ['angre'] });
    expect(ko).toEqual(['angre', 'b', 'c']);
  });
  it('fjern tar bare bort nøkkelen', () => {
    expect(U.toastFjern(['angre', 'melding'], 'melding')).toEqual(['angre']);
    expect(U.toastFjern(['angre'], 'melding')).toEqual(['angre']);
  });
});

describe('kontrast for det merkede kortet', () => {
  const { lys, mork } = PALETT;
  it('formelen gir kjente verdier', () => {
    expect(U.kontrast('#000000', '#ffffff')).toBe(21);
    expect(U.kontrast('#777777', '#777777')).toBe(1);
    expect(Number.isNaN(U.kontrast('rød', '#ffffff'))).toBe(true);
  });
  it.each([
    ['lys', lys],
    ['mørk', mork],
  ])('on-primary-container på primary-container er minst 4,5:1 i %s modus', (_navn, p) => {
    const k = U.kontrast(p['on-primary-container'], p['primary-container']);
    expect(k).toBeGreaterThanOrEqual(4.5);
  });
});

describe('fanene (piltaster)', () => {
  it('høyre og venstre går rundt, Home og End til endene, andre taster gir null', () => {
    expect(U.faneMaal(6, 5, 'ArrowRight')).toBe(0);
    expect(U.faneMaal(6, 0, 'ArrowLeft')).toBe(5);
    expect(U.faneMaal(6, 3, 'Home')).toBe(0);
    expect(U.faneMaal(6, 3, 'End')).toBe(5);
    expect(U.faneMaal(6, 3, 'a')).toBeNull();
    expect(U.faneMaal(0, 0, 'ArrowRight')).toBeNull();
  });
});

describe('tegnforklaringen og WIP', () => {
  it('har alle fire klassene', () => {
    expect(U.KLASSER.map((k) => k.klasse)).toEqual(['K', 'D', 'D+', 'U']);
  });
  it('klassemerket får en lesbar etikett', () => {
    expect(U.klasseEtikett('D+')).toBe('Risikoklasse D+: database med ny tabell eller personvern');
    expect(U.klasseEtikett('X')).toBe('Risikoklasse X');
  });
  it('WIP-chipen er vanlig tekst', () => {
    expect(U.wipTekst({ agenter: 3, maks: 4, dPluss: 1, maksDPluss: 2 })).toBe(
      'Agenter 3 av 4 · tunge 1 av 2',
    );
    expect(U.wipTekst({ agenter: 3, maks: 4, dPluss: 1, maksDPluss: 2, plukket: 2 })).toBe(
      'Agenter 3 av 4 · tunge 1 av 2 · 2 plukket',
    );
  });
});

describe('nøkkelen fra lenken', () => {
  it('leser nøkkelen fra #-delen', () => {
    expect(U.nokkelFraLenke('http://127.0.0.1:4310/#nokkel=abc_DEF-123')).toBe('abc_DEF-123');
    expect(U.nokkelFraLenke('  http://127.0.0.1:4310/?x=1#a=1&nokkel=xyz  ')).toBe('xyz');
  });
  it('godtar ikke nøkkel i spørringen (bare #-delen) eller tom tekst', () => {
    expect(U.nokkelFraLenke('http://127.0.0.1:4310/?nokkel=abc')).toBeNull();
    expect(U.nokkelFraLenke('')).toBeNull();
    expect(U.nokkelFraLenke('http://127.0.0.1:4310/#annet=1')).toBeNull();
  });
  it('godtar en ren nøkkel uten lenke', () => {
    expect(U.nokkelFraLenke('A1b2C3d4E5f6G7h8')).toBe('A1b2C3d4E5f6G7h8');
    expect(U.nokkelFraLenke('kort')).toBeNull();
  });
});

describe('temaet', () => {
  it('ukjent eller tomt lagret valg er System', () => {
    expect(U.temaFraLagret(null)).toBe('system');
    expect(U.temaFraLagret('blå')).toBe('system');
    expect(U.temaFraLagret('mork')).toBe('mork');
  });
  it('knappen går System → Lys → Mørk → System', () => {
    expect(U.nesteTema(null)).toBe('lys');
    expect(U.nesteTema('lys')).toBe('mork');
    expect(U.nesteTema('mork')).toBe('system');
  });
});
