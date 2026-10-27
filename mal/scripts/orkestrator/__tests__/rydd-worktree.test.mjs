// Enhetstest for beslutningen i rydd-worktree.mjs (vitest; include-mønsteret tar med .test.mjs).
// Bare de rene funksjonene testes her; selve ryddingen er vist med en ekte fletting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import { erUnder, fingeravtrykk, skalRyddes } from '../rydd-worktree.mjs';

const ok = {
  underWorktreesMappe: true,
  laast: false,
  erGjeldendeKatalog: false,
  flettet: true,
  forNy: false,
  skitne: 0,
  ekteLenkemappe: null,
};

test('alt i orden: rydd', () => {
  expect(skalRyddes(ok)).toEqual({ rydd: true, grunn: 'flettet, rent og ulåst' });
});

test('låst worktree ryddes aldri', () => {
  const r = skalRyddes({ ...ok, laast: true });
  expect(r.rydd).toBe(false);
  expect(r.grunn).toBe('låst');
});

test('skittent worktree ryddes ikke (antall og boolean)', () => {
  expect(skalRyddes({ ...ok, skitne: 3 }).rydd).toBe(false);
  expect(skalRyddes({ ...ok, skitne: 3 }).grunn).toMatch(/ucommittede endringer \(3\)/);
  expect(skalRyddes({ ...ok, skitne: true }).rydd).toBe(false);
  expect(skalRyddes({ ...ok, skitne: false }).rydd).toBe(true);
});

test('ukjent git status (negativ eller mangler) regnes ikke som rent', () => {
  expect(skalRyddes({ ...ok, skitne: -1 }).rydd).toBe(false);
  expect(skalRyddes({ ...ok, skitne: undefined }).rydd).toBe(false);
});

test('ikke flettet: ryddes ikke', () => {
  const r = skalRyddes({ ...ok, flettet: false });
  expect(r.rydd).toBe(false);
  expect(r.grunn).toBe('ikke flettet');
});

test('gjeldende katalog ryddes ikke', () => {
  const r = skalRyddes({ ...ok, erGjeldendeKatalog: true });
  expect(r.rydd).toBe(false);
  expect(r.grunn).toBe('er gjeldende katalog');
});

test('ekte node_modules-mappe (ikke lenke) stopper ryddingen', () => {
  const r = skalRyddes({ ...ok, ekteLenkemappe: 'node_modules' });
  expect(r.rydd).toBe(false);
  expect(r.grunn).toBe('node_modules er ikke en lenke');
});

test('utenfor .claude/worktrees/ ryddes aldri, og det slår før alt annet', () => {
  const r = skalRyddes({ ...ok, underWorktreesMappe: false, laast: true });
  expect(r.rydd).toBe(false);
  expect(r.grunn).toBe('ligger ikke under .claude/worktrees/');
});

test('nylig endret (under minstealderen) ryddes ikke', () => {
  expect(skalRyddes({ ...ok, forNy: true }).rydd).toBe(false);
});

test('låst slår før skittent (billig grunn først)', () => {
  expect(skalRyddes({ ...ok, laast: true, skitne: 5 }).grunn).toBe('låst');
});

test('erUnder: bare stier INNE i rota, aldri rota selv eller en nabo med samme prefiks', () => {
  const rot = path.resolve('/x/eksempel/.claude/worktrees');
  expect(erUnder(path.join(rot, 'agent-a'), rot)).toBe(true);
  expect(erUnder(rot, rot)).toBe(false);
  expect(erUnder(path.resolve('/x/eksempel/.claude/worktrees-annen/agent-a'), rot)).toBe(false);
  expect(erUnder(path.resolve('/x/eksempel'), rot)).toBe(false);
});


test('fingeravtrykk teller oppføringene i hver delte mappe, -1 når den mangler', () => {
  const rot = fs.mkdtempSync(path.join(os.tmpdir(), 'rydd-fp-'));
  try {
    fs.mkdirSync(path.join(rot, 'node_modules', 'a'), { recursive: true });
    fs.mkdirSync(path.join(rot, 'node_modules', 'b'), { recursive: true });
    expect(fingeravtrykk(rot, ['node_modules', 'web/node_modules'])).toEqual({
      node_modules: 2,
      'web/node_modules': -1,
    });
  } finally {
    fs.rmSync(rot, { recursive: true, force: true });
  }
});
