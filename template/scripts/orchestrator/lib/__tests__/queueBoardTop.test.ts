// =============================================================
// queueBoardTop.test.ts: the top of queueBoard (scripts/orchestrator/queue-board/).
//
// Render tests do not work here, so the tests read index.html, board.css and board.js as text and prove that:
//   - the top is a grid in two rows with the mascot zone in the left corner over both, and that swapping sides is one line,
//   - help ("?") and theme are moved out of the top and into the gear, and board.js no longer looks up those buttons
//     (a `$('theme')` against an element that does not exist would crash the whole board on load),
//   - the speech bubble is an empty, hidden `<p role="note">` and the test text is off,
//   - no element in the top gets a fixed width over the viewport at 375 px (the CSS cascade is computed with a simple model:
//     rules that apply at 375 px, in source order, last wins), and the tabs scroll in their own row on a phone.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const folder = join(__dirname, '..', '..', 'queue-board');
const html = readFileSync(join(folder, 'index.html'), 'utf8');
const css = readFileSync(join(folder, 'board.css'), 'utf8');
const js = readFileSync(join(folder, 'board.js'), 'utf8');

const VIEWPORT = 375;

// ---- A small CSS reader: rules at the top level and inside @media (one level), without comments ---------------------

type Rule = { media: string | null; selectors: string[]; decl: Record<string, string> };

function readRules(text: string): Rule[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let i = 0;
  const block = (from: number): [string, number] => {
    // Returns the content between { at `from` and its matching }, and the position after }.
    let depth = 0;
    for (let j = from; j < clean.length; j++) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') {
        depth--;
        if (depth === 0) return [clean.slice(from + 1, j), j + 1];
      }
    }
    throw new Error('The CSS has an open block');
  };
  const readSurface = (content: string, media: string | null) => {
    let k = 0;
    while (k < content.length) {
      const start = content.indexOf('{', k);
      if (start < 0) break;
      const header = content.slice(k, start).trim();
      let depth = 0;
      let end = start;
      for (; end < content.length; end++) {
        if (content[end] === '{') depth++;
        else if (content[end] === '}' && --depth === 0) break;
      }
      const body = content.slice(start + 1, end);
      if (!header.startsWith('@')) {
        const decl: Record<string, string> = {};
        for (const d of body.split(';')) {
          const colon = d.indexOf(':');
          if (colon > 0) decl[d.slice(0, colon).trim()] = d.slice(colon + 1).trim();
        }
        rules.push({ media, selectors: header.split(',').map((s) => s.trim()), decl });
      }
      k = end + 1;
    }
  };
  while (i < clean.length) {
    const start = clean.indexOf('{', i);
    if (start < 0) break;
    const header = clean.slice(i, start).trim();
    const [content, after] = block(start);
    if (header.startsWith('@media')) readSurface(content, header);
    else if (!header.startsWith('@')) readSurface(`${header}{${content}}`, null);
    i = after;
  }
  return rules;
}

/** Does the media query apply at 375 px width? Width queries are computed; others (hover, motion) do not count. */
function appliesAt375(media: string | null): boolean {
  if (media === null) return true;
  const max = /max-width:\s*(\d+)px/.exec(media);
  const min = /min-width:\s*(\d+)px/.exec(media);
  if (!max && !min) return false;
  if (max && VIEWPORT > Number(max[1])) return false;
  if (min && VIEWPORT < Number(min[1])) return false;
  return true;
}

const rules = readRules(css);
const root: Record<string, string> = Object.assign(
  {},
  ...rules.filter((r) => r.selectors.includes(':root')).map((r) => r.decl),
);

/**
 * Computes a length in px at a 375 px viewport. Percent and keywords (auto, none) are relative to the parent and give
 * null, that is "not a fixed width". Supports numbers with px/vw, var(), calc(), min(), max() and + - * /.
 */
function px(val: string): number | null {
  const expression = val.replace(/var\((--[\w-]+)\)/g, (_, name: string) => root[name] ?? '0px');
  if (/%|auto|none|fit-content/.test(expression)) return null;
  if (/max-content|min-content/.test(expression)) return Infinity; // content width: can be anything
  const tokens = expression.match(/\d*\.?\d+(px|vw)?|[a-z]+\(|[()+\-*/,]/g) ?? [];
  let p = 0;
  const counts = (): number => {
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
      const values = [sum()];
      while (tokens[p] === ',') {
        p++;
        values.push(sum());
      }
      p++;
      return t === 'min(' ? Math.min(...values) : Math.max(...values);
    }
    if (t === '-') return -counts();
    if (t.endsWith('vw')) return (parseFloat(t) * VIEWPORT) / 100;
    return parseFloat(t);
  };
  const product = (): number => {
    let v = counts();
    while (tokens[p] === '*' || tokens[p] === '/')
      v = tokens[p++] === '*' ? v * counts() : v / counts();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[p] === '+' || tokens[p] === '-')
      v = tokens[p++] === '+' ? v + product() : v - product();
    return v;
  };
  return sum();
}

/** The classes and ids of the elements in <header class="top">. */
function topClasses(): string[] {
  const top = html.slice(html.indexOf('<header class="top">'), html.indexOf('</header>'));
  const classes = new Set<string>();
  for (const m of top.matchAll(/class="([^"]+)"/g))
    for (const k of m[1].split(/\s+/)) classes.add(k);
  return [...classes];
}

/** The last value for a property on an element with the class, at 375 px (last rule wins, as in board.css). */
function valueAt375(cls: string, property: string): string | null {
  let val: string | null = null;
  const match = new RegExp(`\\.${cls}(?![\\w-])[^\\s>+~]*$`);
  for (const r of rules) {
    if (!appliesAt375(r.media)) continue;
    if (!r.selectors.some((s) => match.test(s) && !/:(hover|focus|active|before|after)/.test(s)))
      continue;
    if (r.decl[property] !== undefined) val = r.decl[property];
  }
  return val;
}

describe('the top: the markup in the top', () => {
  const top = html.slice(html.indexOf('<header class="top">'), html.indexOf('</header>'));

  it('the mascot zone comes first, before the two rows, and is empty as a placeholder', () => {
    const inMascot = top.indexOf('class="mascot');
    expect(inMascot).toBeGreaterThan(0);
    expect(inMascot).toBeLessThan(top.indexOf('top-row1'));
    expect(top.indexOf('top-row1')).toBeLessThan(top.indexOf('top-row2'));
    expect(top).toMatch(/<div id="mascot" class="mascot empty"><\/div>/);
  });

  it('row 1 has title, status, "Waiting on you" and the gear; row 2 has the tabs, the search and the grouping', () => {
    const row1 = top.slice(top.indexOf('top-row1'), top.indexOf('top-row2'));
    const row2 = top.slice(top.indexOf('top-row2'));
    for (const id of ['status', 'inbox', 'settings']) expect(row1).toContain(`id="${id}"`);
    expect(row1).toContain('class="title"');
    for (const id of ['tabs', 'search', 'filter-button', 'views', 'grouping'])
      expect(row2).toContain(`id="${id}"`);
  });

  it('help and theme are out of the top, and board.js does not look up the buttons that are gone', () => {
    expect(html).not.toMatch(/id="(help|theme)"/);
    expect(js).not.toMatch(/\$\('(help|theme)'\)/);
    // They live in the gear now: the help button and the theme choice sit in the settings panel.
    expect(js).toMatch(/helpSection\(\),\s*themeSection\(\)/);
  });

  it('the speech bubble is an empty, hidden note, and the test text is off', () => {
    expect(top).toMatch(/<p id="bubble" class="bubble" role="note" hidden><\/p>/);
    expect(js).toMatch(/const BUBBLE_TEST_TEXT = false;/);
  });
});

describe('the top: grid and phone', () => {
  it('the top is a grid with the mascot over both rows, in one line that switches sides', () => {
    const top = rules.find((r) => r.media === null && r.selectors.includes('.top'));
    expect(top?.decl.display).toBe('grid');
    expect(top?.decl['grid-template']).toMatch(
      /'mascot row1' auto\s+'mascot row2' auto \/ auto minmax\(0, 1fr\)/,
    );
  });

  it('the mascot is 52 × 104 on a wide screen and 56 px high on a phone', () => {
    const wide = rules.find((r) => r.media === null && r.selectors.includes('.mascot'));
    expect(wide?.decl.width).toBe('52px');
    expect(wide?.decl.height).toBe('104px');
    expect(valueAt375('mascot', 'height')).toBe('56px');
  });

  it('the tabs scroll in their own row on a phone (overflow-x on the row, not on the page)', () => {
    const tabs = rules.find(
      (r) => r.media?.includes('max-width: 720px') && r.selectors.includes('.top .toggles'),
    );
    expect(tabs?.decl['overflow-x']).toBe('auto');
    expect(tabs?.decl['min-width']).toBe('0');
  });

  it('no element in the top has a fixed width over the viewport at 375 px', () => {
    const forWide: string[] = [];
    for (const k of topClasses()) {
      const max = px(valueAt375(k, 'max-width') ?? 'none');
      for (const property of ['width', 'min-width', 'flex-base']) {
        const v = valueAt375(k, property);
        if (v === null) continue;
        const b = px(v);
        if (b === null) continue; // relative to the parent
        const limit = property === 'min-width' || max === null ? b : Math.min(b, max);
        if (limit > VIEWPORT) forWide.push(`.${k} ${property}: ${v}`);
      }
    }
    expect(forWide).toEqual([]);
  });

  it('the arithmetic in the test works (guard against the check above becoming empty)', () => {
    expect(px('min(360px, calc(100vw - 32px))')).toBe(343);
    expect(px('calc(var(--distance-lg) + 52px + 12px)')).toBe(88);
    expect(px('100%')).toBeNull();
    expect(px('420px')).toBe(420);
    expect(topClasses()).toEqual(
      expect.arrayContaining(['mascot', 'search', 'toggles', 'grouping']),
    );
    expect(valueAt375('search', 'width')).toBe('100%'); // the phone rule overrides 260 px
  });
});
