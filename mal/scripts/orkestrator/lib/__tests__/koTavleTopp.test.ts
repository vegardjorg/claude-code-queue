// =============================================================
// koTavleTopp.test.ts: toppen i køtavla (scripts/orkestrator/ko-tavle/).
//
// Render-tester virker ikke her, så testene leser index.html, tavle.css og tavle.js som tekst og beviser at:
//   - toppen er et grid i to rader med maskot-sonen i venstre hjørne over begge, og at det å bytte side er én linje,
//   - hjelp («?») og tema er flyttet ut av toppen og inn i tannhjulet, og tavle.js ikke lenger slår opp de knappene
//     (et `$('tema')` mot et element som ikke finnes, ville krasjet hele tavla ved lasting),
//   - snakkeboblen er en tom, skjult `<p role="note">` og test-teksten står av,
//   - ingen element i toppen får fast bredde over viewport ved 375 px (CSS-kaskaden regnes ut med en enkel modell:
//     regler som gjelder ved 375 px, i kilderekkefølge, siste vinner), og fanene ruller i sin egen rad på telefon.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const mappe = join(__dirname, '..', '..', 'ko-tavle');
const html = readFileSync(join(mappe, 'index.html'), 'utf8');
const css = readFileSync(join(mappe, 'tavle.css'), 'utf8');
const js = readFileSync(join(mappe, 'tavle.js'), 'utf8');

const VIEWPORT = 375;

// ---- En liten CSS-leser: regler på toppnivå og inni @media (ett nivå), uten kommentarer ----------------------------

type Regel = { media: string | null; selektorer: string[]; dekl: Record<string, string> };

function lesRegler(tekst: string): Regel[] {
  const ren = tekst.replace(/\/\*[\s\S]*?\*\//g, '');
  const regler: Regel[] = [];
  let i = 0;
  const blokk = (fra: number): [string, number] => {
    // Returnerer innholdet mellom { ved `fra` og den tilhørende }, og posisjonen etter }.
    let dybde = 0;
    for (let j = fra; j < ren.length; j++) {
      if (ren[j] === '{') dybde++;
      else if (ren[j] === '}') {
        dybde--;
        if (dybde === 0) return [ren.slice(fra + 1, j), j + 1];
      }
    }
    throw new Error('CSS-en har en åpen blokk');
  };
  const lesFlate = (innhold: string, media: string | null) => {
    let k = 0;
    while (k < innhold.length) {
      const start = innhold.indexOf('{', k);
      if (start < 0) break;
      const hode = innhold.slice(k, start).trim();
      let dybde = 0;
      let slutt = start;
      for (; slutt < innhold.length; slutt++) {
        if (innhold[slutt] === '{') dybde++;
        else if (innhold[slutt] === '}' && --dybde === 0) break;
      }
      const kropp = innhold.slice(start + 1, slutt);
      if (!hode.startsWith('@')) {
        const dekl: Record<string, string> = {};
        for (const d of kropp.split(';')) {
          const kolon = d.indexOf(':');
          if (kolon > 0) dekl[d.slice(0, kolon).trim()] = d.slice(kolon + 1).trim();
        }
        regler.push({ media, selektorer: hode.split(',').map((s) => s.trim()), dekl });
      }
      k = slutt + 1;
    }
  };
  while (i < ren.length) {
    const start = ren.indexOf('{', i);
    if (start < 0) break;
    const hode = ren.slice(i, start).trim();
    const [innhold, etter] = blokk(start);
    if (hode.startsWith('@media')) lesFlate(innhold, hode);
    else if (!hode.startsWith('@')) lesFlate(`${hode}{${innhold}}`, null);
    i = etter;
  }
  return regler;
}

/** Gjelder media-spørringen ved 375 px bredde? Bredde-spørringer regnes ut; andre (hover, bevegelse) telles ikke. */
function gjelderVed375(media: string | null): boolean {
  if (media === null) return true;
  const maks = /max-width:\s*(\d+)px/.exec(media);
  const min = /min-width:\s*(\d+)px/.exec(media);
  if (!maks && !min) return false;
  if (maks && VIEWPORT > Number(maks[1])) return false;
  if (min && VIEWPORT < Number(min[1])) return false;
  return true;
}

const regler = lesRegler(css);
const rot: Record<string, string> = Object.assign(
  {},
  ...regler.filter((r) => r.selektorer.includes(':root')).map((r) => r.dekl),
);

/**
 * Regner ut en lengde i px ved 375 px viewport. Prosent og nøkkelord (auto, none) er relative til forelderen og gir
 * null, altså «ikke en fast bredde». Støtter tall med px/vw, var(), calc(), min(), max() og + - * /.
 */
function px(verdi: string): number | null {
  const uttrykk = verdi.replace(/var\((--[\w-]+)\)/g, (_, navn: string) => rot[navn] ?? '0px');
  if (/%|auto|none|fit-content/.test(uttrykk)) return null;
  if (/max-content|min-content/.test(uttrykk)) return Infinity; // innholdsbredde: kan bli hva som helst
  const tokens = uttrykk.match(/\d*\.?\d+(px|vw)?|[a-z]+\(|[()+\-*/,]/g) ?? [];
  let p = 0;
  const tall = (): number => {
    const t = tokens[p++];
    if (t === '(') {
      const v = sum();
      p++; // )
      return v;
    }
    if (t === 'calc(') {
      const v = sum();
      p++;
      return v;
    }
    if (t === 'min(' || t === 'max(') {
      const verdier = [sum()];
      while (tokens[p] === ',') {
        p++;
        verdier.push(sum());
      }
      p++;
      return t === 'min(' ? Math.min(...verdier) : Math.max(...verdier);
    }
    if (t === '-') return -tall();
    if (t.endsWith('vw')) return (parseFloat(t) * VIEWPORT) / 100;
    return parseFloat(t);
  };
  const produkt = (): number => {
    let v = tall();
    while (tokens[p] === '*' || tokens[p] === '/')
      v = tokens[p++] === '*' ? v * tall() : v / tall();
    return v;
  };
  const sum = (): number => {
    let v = produkt();
    while (tokens[p] === '+' || tokens[p] === '-')
      v = tokens[p++] === '+' ? v + produkt() : v - produkt();
    return v;
  };
  return sum();
}

/** Klassene og id-ene på elementene i <header class="topp">. */
function toppensKlasser(): string[] {
  const topp = html.slice(html.indexOf('<header class="topp">'), html.indexOf('</header>'));
  const klasser = new Set<string>();
  for (const m of topp.matchAll(/class="([^"]+)"/g))
    for (const k of m[1].split(/\s+/)) klasser.add(k);
  return [...klasser];
}

/** Siste verdi for en egenskap på et element med klassen, ved 375 px (siste regel vinner, som i tavle.css). */
function verdiVed375(klasse: string, egenskap: string): string | null {
  let verdi: string | null = null;
  const treff = new RegExp(`\\.${klasse}(?![\\w-])[^\\s>+~]*$`);
  for (const r of regler) {
    if (!gjelderVed375(r.media)) continue;
    if (!r.selektorer.some((s) => treff.test(s) && !/:(hover|focus|active|before|after)/.test(s)))
      continue;
    if (r.dekl[egenskap] !== undefined) verdi = r.dekl[egenskap];
  }
  return verdi;
}

describe('toppen: markupen i toppen', () => {
  const topp = html.slice(html.indexOf('<header class="topp">'), html.indexOf('</header>'));

  it('maskot-sonen står først, før de to radene, og er tom som plassholder', () => {
    const iMaskot = topp.indexOf('class="maskot');
    expect(iMaskot).toBeGreaterThan(0);
    expect(iMaskot).toBeLessThan(topp.indexOf('topp-rad1'));
    expect(topp.indexOf('topp-rad1')).toBeLessThan(topp.indexOf('topp-rad2'));
    expect(topp).toMatch(/<div id="maskot" class="maskot tom"><\/div>/);
  });

  it('rad 1 har tittel, status, «Venter på deg» og tannhjulet; rad 2 har fanene, søket og grupperingen', () => {
    const rad1 = topp.slice(topp.indexOf('topp-rad1'), topp.indexOf('topp-rad2'));
    const rad2 = topp.slice(topp.indexOf('topp-rad2'));
    for (const id of ['status', 'innboks', 'innstillinger']) expect(rad1).toContain(`id="${id}"`);
    expect(rad1).toContain('class="tittel"');
    for (const id of ['faner', 'sok', 'filter-knapp', 'visninger', 'gruppering'])
      expect(rad2).toContain(`id="${id}"`);
  });

  it('hjelp og tema er ute av toppen, og tavle.js slår ikke opp knappene som er borte', () => {
    expect(html).not.toMatch(/id="(hjelp|tema)"/);
    expect(js).not.toMatch(/\$\('(hjelp|tema)'\)/);
    // De bor i tannhjulet nå: hjelpeknappen og temavalget står i innstillingspanelet.
    expect(js).toMatch(/hjelpSeksjon\(\),\s*temaSeksjon\(\)/);
  });

  it('snakkeboblen er en tom, skjult note, og testteksten står av', () => {
    expect(topp).toMatch(/<p id="boble" class="boble" role="note" hidden><\/p>/);
    expect(js).toMatch(/const BOBLE_TESTTEKST = false;/);
  });
});

describe('toppen: grid og telefon', () => {
  it('toppen er et grid med maskoten over begge radene, i én linje som bytter side', () => {
    const topp = regler.find((r) => r.media === null && r.selektorer.includes('.topp'));
    expect(topp?.dekl.display).toBe('grid');
    expect(topp?.dekl['grid-template']).toMatch(
      /'maskot rad1' auto\s+'maskot rad2' auto \/ auto minmax\(0, 1fr\)/,
    );
  });

  it('maskoten er 52 × 104 på bred skjerm og 56 px høy på telefon', () => {
    const bred = regler.find((r) => r.media === null && r.selektorer.includes('.maskot'));
    expect(bred?.dekl.width).toBe('52px');
    expect(bred?.dekl.height).toBe('104px');
    expect(verdiVed375('maskot', 'height')).toBe('56px');
  });

  it('fanene ruller i sin egen rad på telefon (overflow-x på raden, ikke på siden)', () => {
    const faner = regler.find(
      (r) => r.media?.includes('max-width: 720px') && r.selektorer.includes('.topp .veksler'),
    );
    expect(faner?.dekl['overflow-x']).toBe('auto');
    expect(faner?.dekl['min-width']).toBe('0');
  });

  it('ingen element i toppen har fast bredde over viewport ved 375 px', () => {
    const forBrede: string[] = [];
    for (const k of toppensKlasser()) {
      const maks = px(verdiVed375(k, 'max-width') ?? 'none');
      for (const egenskap of ['width', 'min-width', 'flex-basis']) {
        const v = verdiVed375(k, egenskap);
        if (v === null) continue;
        const b = px(v);
        if (b === null) continue; // relativ til forelderen
        const grense = egenskap === 'min-width' || maks === null ? b : Math.min(b, maks);
        if (grense > VIEWPORT) forBrede.push(`.${k} ${egenskap}: ${v}`);
      }
    }
    expect(forBrede).toEqual([]);
  });

  it('regnestykket i testen virker (vakt mot at sjekken over blir tom)', () => {
    expect(px('min(360px, calc(100vw - 32px))')).toBe(343);
    expect(px('calc(var(--avstand-lg) + 52px + 12px)')).toBe(88);
    expect(px('100%')).toBeNull();
    expect(px('420px')).toBe(420);
    expect(toppensKlasser()).toEqual(
      expect.arrayContaining(['maskot', 'sok', 'veksler', 'gruppering']),
    );
    expect(verdiVed375('sok', 'width')).toBe('100%'); // telefonregelen overstyrer 260 px
  });
});
