// =============================================================
// queueBoardScale.test.ts: the font and spacing scale in queueBoard and the pure rules for emptyState and stale data
// (scripts/orchestrator/queue-board/).
//
// Render tests do not work here, so the tests read board.css as text and prove that:
//   - the scale exists as tokens (--text-xs … --text-xl, --distance-xs … --distance-lg),
//   - the number of raw px values in font and spacing does not slide back (the threshold is the count after the cleanup;
//     lower it when more become tokens, never raise it),
//   - no font is below the floor of 12 px, and no weight is 700 (only 400 and 600 are used),
//   - reduced motion, forced colors and the touch targets on touch screens have their rules, and the chain dims
//     with the surface, not with opacity on the text.
// a11y.js is tested directly: emptyReason and stale/staleText.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const css = readFileSync(
  join(__dirname, '..', '..', 'queue-board', 'board.css'),
  'utf8',
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const U = require('../../queue-board/a11y.js') as {
  emptyReason: (a: {
    text: string;
    searchHides?: boolean;
    search?: string;
    filters?: number;
    selection?: string | null;
  }) => { text: string; action: 'search' | 'filter' | 'selection' | null; label: string | null };
  STALE_MS: number;
  stale: (fetchedMs: number, nowMs: number, limit?: number) => boolean;
  staleText: (fetched: Date) => string;
};

/** The declarations in the file (property and val), without comments. */
function declarations(): { prop: string; val: string }[] {
  const without = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { prop: string; val: string }[] = [];
  for (const m of without.matchAll(/(?:^|[{;\s])([a-z-]+)\s*:\s*([^;{}]+);/g))
    out.push({ prop: m[1], val: m[2].trim() });
  return out;
}

/** Raw px in font (font-size) and in spacing (padding, margin, gap). */
function rawPx() {
  let font = 0;
  let distance = 0;
  for (const { prop, val } of declarations()) {
    const px = (val.match(/\b\d+px\b/g) ?? []).length;
    if (prop === 'font-size') font += px;
    if (/^(padding|margin|gap|row-gap|column-gap)/.test(prop)) distance += px;
  }
  return { font, distance };
}

// After: one raw font (the speech bubble at the top, the mascot owns it) and 21 raw spacings
// (hairlines of 1 and 2 px, top grid and mascot, the negative margin on .mark-box and the space under the selection line).
// Before: 80 raw font values and 140 raw spacings.
const THRESHOLD = { font: 1, distance: 21 };

describe('scale', () => {
  it('the tokens exist with the agreed values', () => {
    const expectValue: Record<string, string> = {
      '--text-xs': '12px',
      '--text-sm': '14px',
      '--text-md': '16px',
      '--text-lg': '20px',
      '--text-xl': '28px',
      '--distance-xs': '4px',
      '--distance-sm': '8px',
      '--distance-md': '16px',
      '--distance-lg': '24px',
    };
    for (const [name, val] of Object.entries(expectValue))
      expect(css).toMatch(new RegExp(`${name}:\\s*${val};`));
  });

  it('raw px in font and spacing does not slide back', () => {
    const n = rawPx();
    expect(n.font).toBeLessThanOrEqual(THRESHOLD.font);
    expect(n.distance).toBeLessThanOrEqual(THRESHOLD.distance);
  });

  it('no font below the floor of 12 px', () => {
    for (const { prop, val } of declarations())
      if (prop === 'font-size' && /^\d+px$/.test(val))
        expect(parseInt(val, 10)).toBeGreaterThanOrEqual(12);
  });

  it('only weight 400 and 600 (the two weights that are loaded)', () => {
    for (const { prop, val } of declarations())
      if (prop === 'font-weight') expect(['400', '600', 'inherit', 'normal']).toContain(val);
  });
});

describe('motion, forced colors and touch targets', () => {
  it('reduced motion turns off smooth scrolling, transitions and animations', () => {
    const block = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^}]*)\}/,
    );
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/scroll-behavior: auto !important/);
    expect(block![1]).toMatch(/transition: none !important/);
    expect(block![1]).toMatch(/animation: none !important/);
  });

  it('forced colors give marked, selected and the active tab a visible outline', () => {
    const i = css.indexOf('@media (forced-colors: active)');
    expect(i).toBeGreaterThan(-1);
    const block = css.slice(i, css.indexOf('@media (pointer: coarse)', i));
    for (const sel of ['.summary.marked', '.summary.chain-selected', ".toggles-button[aria-selected='true']"])
      expect(block).toContain(sel);
    expect(block).toMatch(/outline: \d+px solid Highlight/);
  });

  it('touch screen: section headers, toggles, search and clickable badges are at least 44 px', () => {
    const i = css.indexOf('@media (pointer: coarse)');
    expect(i).toBeGreaterThan(-1);
    const block = css.slice(i, css.indexOf('}', css.indexOf('min-height', i)) + 1);
    for (const sel of ['.section > summary', '.toggles-button', '.search', 'button.badge'])
      expect(block).toContain(sel);
    expect(block).toContain('min-height: 44px');
  });

  it('the chain dims with the surface, not with opacity on the text', () => {
    const m = css.match(
      /\.board\.chain-active \.summary:not\(\.chain-selected\):not\(\.chain-for\):not\(\.chain-after\) \{([^}]*)\}/,
    );
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/opacity/);
    expect(m![1]).toMatch(/background: var\(--color-/);
  });
});

describe('emptyState', () => {
  it('a search that hides everything: the reason is the search, the action clears it', () => {
    expect(
      U.emptyReason({ text: 'Nothing here.', searchHides: true, search: 'rls', filters: 2 }),
    ).toEqual({
      text: 'Nothing matches "rls".',
      action: 'search',
      label: 'Clear search',
    });
  });

  it('the filter is on: "Remove filter", with the count', () => {
    const g = U.emptyReason({ text: 'Nothing here.', filters: 3, selection: 'Mine' });
    expect(g.action).toBe('filter');
    expect(g.label).toBe('Remove filter');
    expect(g.text).toBe('Nothing here. The filter is on (3 selected).');
  });

  it('only a selection: "Show all"', () => {
    const g = U.emptyReason({ text: 'Nothing here.', selection: 'Ready D' });
    expect(g).toEqual({
      text: 'Nothing here. Selection "Ready D" is in use.',
      action: 'selection',
      label: 'Show all',
    });
  });

  it('nothing hides the cards: only the base text, no action', () => {
    expect(U.emptyReason({ text: 'Nothing is ready now.' })).toEqual({
      text: 'Nothing is ready now.',
      action: null,
      label: null,
    });
    // The search does not count when the list was already empty (the search hides nothing).
    expect(U.emptyReason({ text: 'Nothing here.', search: 'x' }).action).toBeNull();
  });
});

describe('stale data', () => {
  const t0 = Date.UTC(2026, 9, 15, 12, 0, 0);
  it('over one minute since the last fetch is stale, exactly one minute is not', () => {
    expect(U.STALE_MS).toBe(60_000);
    expect(U.stale(t0, t0 + 60_000)).toBe(false);
    expect(U.stale(t0, t0 + 60_001)).toBe(true);
  });
  it('without a fetch nothing is stale', () => {
    expect(U.stale(NaN, t0)).toBe(false);
  });
  it('the text is "Not updated since HH:MM" in local time', () => {
    expect(U.staleText(new Date(2026, 9, 15, 9, 5, 30))).toBe('Not updated since 09:05');
  });
});
