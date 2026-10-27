// =============================================================
// koTavleSkala.test.ts: skrift- og avstandsskalaen i køtavla og de rene reglene for tomtilstanden og foreldede data
// (scripts/orkestrator/ko-tavle/).
//
// Render-tester virker ikke her, så testene leser tavle.css som tekst og beviser at:
//   - skalaen finnes som tokener (--tekst-xs … --tekst-xl, --avstand-xs … --avstand-lg),
//   - antallet rå px-verdier i skrift og avstand ikke glir tilbake (terskelen er tallet etter oppryddingen;
//     senk den når flere blir tokener, hev den aldri),
//   - ingen skrift er under gulvet på 12 px, og ingen vekt er 700 (bare 400 og 600 brukes),
//   - redusert bevegelse, tvungne farger og trykkflatene på berøringsskjerm har sine regler, og kjeden demper
//     med flaten, ikke med opacity på teksten.
// uu.js testes direkte: tomGrunn og foreldet/foreldetTekst.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const css = readFileSync(
  join(__dirname, '..', '..', 'ko-tavle', 'tavle.css'),
  'utf8',
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const U = require('../../ko-tavle/uu.js') as {
  tomGrunn: (a: {
    tekst: string;
    sokSkjuler?: boolean;
    sok?: string;
    filtre?: number;
    utvalg?: string | null;
  }) => { tekst: string; handling: 'sok' | 'filter' | 'utvalg' | null; etikett: string | null };
  FORELDET_MS: number;
  foreldet: (hentetMs: number, naaMs: number, grense?: number) => boolean;
  foreldetTekst: (hentet: Date) => string;
};

/** Deklarasjonene i fila (egenskap og verdi), uten kommentarer. */
function deklarasjoner(): { prop: string; verdi: string }[] {
  const uten = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ut: { prop: string; verdi: string }[] = [];
  for (const m of uten.matchAll(/(?:^|[{;\s])([a-z-]+)\s*:\s*([^;{}]+);/g))
    ut.push({ prop: m[1], verdi: m[2].trim() });
  return ut;
}

/** Rå px i skrift (font-size) og i avstand (padding, margin, gap). */
function raaPx() {
  let skrift = 0;
  let avstand = 0;
  for (const { prop, verdi } of deklarasjoner()) {
    const px = (verdi.match(/\b\d+px\b/g) ?? []).length;
    if (prop === 'font-size') skrift += px;
    if (/^(padding|margin|gap|row-gap|column-gap)/.test(prop)) avstand += px;
  }
  return { skrift, avstand };
}

// Etter Én rå skrift (snakkeboblen i toppen, maskoten eier den) og 21 rå avstander
// (hårstreker på 1 og 2 px, toppens grid og maskot, den negative margen på .merk-boks og plassen under valglinja).
// Før: 80 rå skriftverdier og 140 rå avstander.
const TERSKEL = { skrift: 1, avstand: 21 };

describe('skalaen', () => {
  it('tokenene finnes med de vedtatte verdiene', () => {
    const forvent: Record<string, string> = {
      '--tekst-xs': '12px',
      '--tekst-sm': '14px',
      '--tekst-md': '16px',
      '--tekst-lg': '20px',
      '--tekst-xl': '28px',
      '--avstand-xs': '4px',
      '--avstand-sm': '8px',
      '--avstand-md': '16px',
      '--avstand-lg': '24px',
    };
    for (const [navn, verdi] of Object.entries(forvent))
      expect(css).toMatch(new RegExp(`${navn}:\\s*${verdi};`));
  });

  it('rå px i skrift og avstand glir ikke tilbake', () => {
    const n = raaPx();
    expect(n.skrift).toBeLessThanOrEqual(TERSKEL.skrift);
    expect(n.avstand).toBeLessThanOrEqual(TERSKEL.avstand);
  });

  it('ingen skrift under gulvet på 12 px', () => {
    for (const { prop, verdi } of deklarasjoner())
      if (prop === 'font-size' && /^\d+px$/.test(verdi))
        expect(parseInt(verdi, 10)).toBeGreaterThanOrEqual(12);
  });

  it('bare vekt 400 og 600 (de to snittene som lastes)', () => {
    for (const { prop, verdi } of deklarasjoner())
      if (prop === 'font-weight') expect(['400', '600', 'inherit', 'normal']).toContain(verdi);
  });
});

describe('bevegelse, tvungne farger og trykkflater', () => {
  it('redusert bevegelse slår av glidende rulling, overganger og animasjoner', () => {
    const blokk = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^}]*)\}/,
    );
    expect(blokk).not.toBeNull();
    expect(blokk![1]).toMatch(/scroll-behavior: auto !important/);
    expect(blokk![1]).toMatch(/transition: none !important/);
    expect(blokk![1]).toMatch(/animation: none !important/);
  });

  it('tvungne farger gir merket, valgt og aktiv fane et synlig omriss', () => {
    const i = css.indexOf('@media (forced-colors: active)');
    expect(i).toBeGreaterThan(-1);
    const blokk = css.slice(i, css.indexOf('@media (pointer: coarse)', i));
    for (const sel of ['.kort.merket', '.kort.kjede-valgt', ".veksler-knapp[aria-selected='true']"])
      expect(blokk).toContain(sel);
    expect(blokk).toMatch(/outline: \d+px solid Highlight/);
  });

  it('berøringsskjerm: seksjonshoder, veksler, søk og klikkbare merker er minst 44 px', () => {
    const i = css.indexOf('@media (pointer: coarse)');
    expect(i).toBeGreaterThan(-1);
    const blokk = css.slice(i, css.indexOf('}', css.indexOf('min-height', i)) + 1);
    for (const sel of ['.seksjon > summary', '.veksler-knapp', '.sok', 'button.merke'])
      expect(blokk).toContain(sel);
    expect(blokk).toContain('min-height: 44px');
  });

  it('kjeden demper med flaten, ikke med opacity på teksten', () => {
    const m = css.match(
      /\.tavle\.kjede-aktiv \.kort:not\(\.kjede-valgt\):not\(\.kjede-for\):not\(\.kjede-etter\) \{([^}]*)\}/,
    );
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/opacity/);
    expect(m![1]).toMatch(/background: var\(--color-/);
  });
});

describe('tomtilstanden', () => {
  it('søket som skjuler alt: grunnen er søket, handlingen tømmer det', () => {
    expect(
      U.tomGrunn({ tekst: 'Ingenting her.', sokSkjuler: true, sok: 'rls', filtre: 2 }),
    ).toEqual({
      tekst: 'Ingen treff på «rls».',
      handling: 'sok',
      etikett: 'Tøm søket',
    });
  });

  it('filteret er på: «Fjern filter», med antallet', () => {
    const g = U.tomGrunn({ tekst: 'Ingenting her.', filtre: 3, utvalg: 'Mine' });
    expect(g.handling).toBe('filter');
    expect(g.etikett).toBe('Fjern filter');
    expect(g.tekst).toBe('Ingenting her. Filteret er på (3 valgt).');
  });

  it('bare et utvalg: «Vis alle»', () => {
    const g = U.tomGrunn({ tekst: 'Ingenting her.', utvalg: 'Klare D' });
    expect(g).toEqual({
      tekst: 'Ingenting her. Utvalget «Klare D» er i bruk.',
      handling: 'utvalg',
      etikett: 'Vis alle',
    });
  });

  it('ingenting skjuler kortene: bare grunnteksten, ingen handling', () => {
    expect(U.tomGrunn({ tekst: 'Ingenting er klart nå.' })).toEqual({
      tekst: 'Ingenting er klart nå.',
      handling: null,
      etikett: null,
    });
    // Søket teller ikke når lista var tom fra før (søket skjuler ingenting).
    expect(U.tomGrunn({ tekst: 'Ingenting her.', sok: 'x' }).handling).toBeNull();
  });
});

describe('foreldede data', () => {
  const t0 = Date.UTC(2026, 9, 15, 12, 0, 0);
  it('over ett minutt siden siste henting er foreldet, akkurat ett minutt er ikke', () => {
    expect(U.FORELDET_MS).toBe(60_000);
    expect(U.foreldet(t0, t0 + 60_000)).toBe(false);
    expect(U.foreldet(t0, t0 + 60_001)).toBe(true);
  });
  it('uten henting er ingenting foreldet', () => {
    expect(U.foreldet(NaN, t0)).toBe(false);
  });
  it('teksten er «Ikke oppdatert siden HH:MM» i lokal tid', () => {
    expect(U.foreldetTekst(new Date(2026, 9, 15, 9, 5, 30))).toBe('Ikke oppdatert siden 09:05');
  });
});
