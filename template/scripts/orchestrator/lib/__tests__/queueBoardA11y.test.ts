// =============================================================
// queueBoardA11y.test.ts: the pure accessibility logic in queueBoard (scripts/orchestrator/queue-board/a11y.js).
//
// The tests prove that:
//   - the focus trap wraps around at both ends and tolerates focus outside the list and an empty list (one trap for all dialogs),
//   - the toast queue never has the same message twice, puts the newest at the bottom and never pushes out "Undo",
//   - the marked card holds at least 4.5:1 in both modes, computed from the palette (PALETTE in lib/queueBoard.js),
//   - the tabs follow the arrow keys, Home and End,
//   - the legend and the WIP text are readable text, the key is read from the # part of the link, and theme has three options.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PALETTE } = require('../queueBoard.js') as {
  PALETTE: { light: Record<string, string>; dark: Record<string, string> };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const U = require('../../queue-board/a11y.js') as {
  nextInTrap: (count: number, i: number, backward: boolean) => number;
  toastAdd: (
    queue: string[],
    key: string,
    option?: { max?: number; kept?: string[] },
  ) => string[];
  toastRemove: (queue: string[], key: string) => string[];
  contrast: (a: string, b: string) => number;
  tabMeasure: (count: number, i: number, keyPress: string) => number | null;
  CLASSES: { class: string; name: string; explanation: string }[];
  classLabel: (k: string) => string;
  wipText: (w: {
    agents: number;
    max: number;
    dPlus: number;
    maxDPlus: number;
    picked?: number;
  }) => string;
  keyFromLink: (text: string) => string | null;
  themeFromSaved: (v: string | null) => string;
  nextTheme: (v: string | null) => string;
};

describe('the focus trap (nextInTrap)', () => {
  it('Tab moves ahead and wraps from last to first', () => {
    expect(U.nextInTrap(3, 0, false)).toBe(1);
    expect(U.nextInTrap(3, 2, false)).toBe(0);
  });
  it('Shift+Tab moves backward and wraps from first to last', () => {
    expect(U.nextInTrap(3, 2, true)).toBe(1);
    expect(U.nextInTrap(3, 0, true)).toBe(2);
  });
  it('focus outside the list (-1) goes to the first with Tab and the last with Shift+Tab', () => {
    expect(U.nextInTrap(3, -1, false)).toBe(0);
    expect(U.nextInTrap(3, -1, true)).toBe(2);
  });
  it('an empty dialog gives -1 (nothing to focus)', () => {
    expect(U.nextInTrap(0, -1, false)).toBe(-1);
    expect(U.nextInTrap(0, 0, true)).toBe(-1);
  });
  it('one element: focus stays there', () => {
    expect(U.nextInTrap(1, 0, false)).toBe(0);
    expect(U.nextInTrap(1, 0, true)).toBe(0);
  });
});

describe('toast queue (one stack)', () => {
  it('puts the newest at the bottom and never has the same key twice', () => {
    let queue: string[] = [];
    queue = U.toastAdd(queue, 'undo');
    queue = U.toastAdd(queue, 'message');
    expect(queue).toEqual(['undo', 'message']);
    queue = U.toastAdd(queue, 'undo');
    expect(queue).toEqual(['message', 'undo']);
  });
  it('over max the oldest drops out, but never one that is to be kept', () => {
    const queue = U.toastAdd(['undo', 'a', 'b'], 'c', { max: 3, kept: ['undo'] });
    expect(queue).toEqual(['undo', 'b', 'c']);
  });
  it('remove takes away only the key', () => {
    expect(U.toastRemove(['undo', 'message'], 'message')).toEqual(['undo']);
    expect(U.toastRemove(['undo'], 'message')).toEqual(['undo']);
  });
});

describe('contrast for the marked card', () => {
  const { light, dark } = PALETTE;
  it('the formula gives known values', () => {
    expect(U.contrast('#000000', '#ffffff')).toBe(21);
    expect(U.contrast('#777777', '#777777')).toBe(1);
    expect(Number.isNaN(U.contrast('red', '#ffffff'))).toBe(true);
  });
  it.each([
    ['light', light],
    ['dark', dark],
  ])('on-primary-container on primary-container is at least 4.5:1 in %s mode', (_name, p) => {
    const k = U.contrast(p['on-primary-container'], p['primary-container']);
    expect(k).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the tabs (arrow keys)', () => {
  it('right and left wrap around, Home and End go to the ends, other keys give null', () => {
    expect(U.tabMeasure(6, 5, 'ArrowRight')).toBe(0);
    expect(U.tabMeasure(6, 0, 'ArrowLeft')).toBe(5);
    expect(U.tabMeasure(6, 3, 'Home')).toBe(0);
    expect(U.tabMeasure(6, 3, 'End')).toBe(5);
    expect(U.tabMeasure(6, 3, 'a')).toBeNull();
    expect(U.tabMeasure(0, 0, 'ArrowRight')).toBeNull();
  });
});

describe('the legend and WIP', () => {
  it('has all four classes', () => {
    expect(U.CLASSES.map((k) => k.class)).toEqual(['K', 'D', 'D+', 'U']);
  });
  it('the class badge gets a readable label', () => {
    expect(U.classLabel('D+')).toBe('Risk class D+: database with new table or privacy');
    expect(U.classLabel('X')).toBe('Risk class X');
  });
  it('the WIP chip is plain text', () => {
    expect(U.wipText({ agents: 3, max: 4, dPlus: 1, maxDPlus: 2 })).toBe(
      'Agents 3 of 4 · heavy 1 of 2',
    );
    expect(U.wipText({ agents: 3, max: 4, dPlus: 1, maxDPlus: 2, picked: 2 })).toBe(
      'Agents 3 of 4 · heavy 1 of 2 · 2 picked',
    );
  });
});

describe('the key from a link', () => {
  it('reads the key from the # part', () => {
    expect(U.keyFromLink('http://127.0.0.1:4310/#key=abc_DEF-123')).toBe('abc_DEF-123');
    expect(U.keyFromLink('  http://127.0.0.1:4310/?x=1#a=1&key=xyz  ')).toBe('xyz');
  });
  it('does not accept a key in the query (only the # part) or empty text', () => {
    expect(U.keyFromLink('http://127.0.0.1:4310/?key=abc')).toBeNull();
    expect(U.keyFromLink('')).toBeNull();
    expect(U.keyFromLink('http://127.0.0.1:4310/#other=1')).toBeNull();
  });
  it('accepts a bare key without a link', () => {
    expect(U.keyFromLink('A1b2C3d4E5f6G7h8')).toBe('A1b2C3d4E5f6G7h8');
    expect(U.keyFromLink('summary')).toBeNull();
  });
});

describe('theme', () => {
  it('an unknown or empty saved option is System', () => {
    expect(U.themeFromSaved(null)).toBe('system');
    expect(U.themeFromSaved('blue')).toBe('system');
    expect(U.themeFromSaved('dark')).toBe('dark');
  });
  it('the button goes System → Light → Dark → System', () => {
    expect(U.nextTheme(null)).toBe('light');
    expect(U.nextTheme('light')).toBe('dark');
    expect(U.nextTheme('dark')).toBe('system');
  });
});
