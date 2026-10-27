// =============================================================
// orkestratorHjelp.test.ts: rene beslutninger i gate-runneren (gater.mjs), worktree-klargjøringen
// (klargjor-spor.mjs) og lenkelista som deles med rydd-worktree.mjs.
// =============================================================
import { describe, expect, it } from 'vitest';

import {
  forsteFeillinje,
  fortsettBeslutning,
  gateType,
  grenBeslutning,
  resultatLinje,
  sporLenker,
  worktreeMedGren,
} from '../orkestratorHjelp';

describe('gatetype', () => {
  it('kjenner igjen vanlige verktøy', () => {
    expect(gateType('npx tsc --noEmit')).toBe('tsc');
    expect(gateType('npx eslint .')).toBe('eslint');
    expect(gateType('npx prettier --check .')).toBe('prettier');
    expect(gateType('npx vitest run')).toBe('test');
    expect(gateType('npm test')).toBe('test');
    expect(gateType('node --test')).toBe('test');
    expect(gateType('make sjekk')).toBe('annet');
  });
});

describe('første feillinje', () => {
  const rot = 'C:\\repo';

  it('tsc', () => {
    const tekst =
      'noe\nlib/a.ts(3,5): error TS2322: Type string is not assignable to type number.\nmer';
    expect(forsteFeillinje('tsc', tekst, rot)).toBe(
      'lib/a.ts(3,5): error TS2322: Type string is not assignable to type number.',
    );
  });

  it('eslint: kombinerer filstien med første error (ikke warning), relativ til rota', () => {
    const tekst = [
      '',
      'C:\\repo\\lib\\a.ts',
      '  2:1  warning  Unused  no-unused-vars',
      '  4:9  error    x is not defined  no-undef',
      '',
      '✖ 2 problems',
    ].join('\n');
    expect(forsteFeillinje('eslint', tekst, rot)).toBe('lib\\a.ts:4:9 x is not defined no-undef');
  });

  it('prettier: første fil som ikke er formatert', () => {
    const tekst =
      'Checking formatting...\n[warn] lib/a.ts\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.';
    expect(forsteFeillinje('prettier', tekst, rot)).toBe('ikke formatert: lib/a.ts');
  });

  it('test: første feilende test, ikke console-blokker', () => {
    const tekst = '  ● Console\n\n    console.log x\n\n  ● dato › offset i juli er -120\n';
    expect(forsteFeillinje('test', tekst, rot)).toBe('● dato › offset i juli er -120');
    expect(forsteFeillinje('test', 'ok\n FAIL  lib/a.test.ts\n', rot)).toBe('FAIL lib/a.test.ts');
  });

  it('generisk: fjerner farger, finner FEIL-linja, ellers siste linje', () => {
    expect(forsteFeillinje('annet', '\u001b[31mok\nFEIL: 2 nye brudd\nslutt', rot)).toBe(
      'FEIL: 2 nye brudd',
    );
    expect(forsteFeillinje('annet', 'linje 1\nsiste linje\n\n', rot)).toBe('siste linje');
  });
});

describe('resultatlinja', () => {
  it('GRØNN og RØD', () => {
    expect(resultatLinje({ navn: 'tsc', status: 'GRØNN', sek: 12.4 }, 5)).toBe('tsc   GRØNN 12 s');
    expect(resultatLinje({ navn: 'test', status: 'RØD', sek: 40, forste: 'x' }, 5)).toBe(
      'test  RØD 40 s: x',
    );
    expect(resultatLinje({ navn: 'test', status: 'RØD', sek: 1 }, 5)).toBe('test  RØD 1 s');
  });
});

describe('klargjøring: grenvalg', () => {
  it('beholder riktig gren', () => {
    expect(
      grenBeslutning({ gjeldende: 'ko/A-1', gren: 'ko/A-1', skittent: true, egneCommits: 3 }),
    ).toEqual({ handling: 'behold' });
  });
  it('sjekker ut en ren, ny worktree-gren', () => {
    expect(
      grenBeslutning({
        gjeldende: 'worktree-agent-x',
        gren: 'ko/A-1',
        skittent: false,
        egneCommits: 0,
      }),
    ).toEqual({ handling: 'checkout' });
  });
  it('nekter når arbeid ville gått tapt', () => {
    expect(
      grenBeslutning({ gjeldende: 'annen', gren: 'ko/A-1', skittent: true, egneCommits: 0 })
        .handling,
    ).toBe('nekt');
    expect(
      grenBeslutning({ gjeldende: 'annen', gren: 'ko/A-1', skittent: false, egneCommits: 2 })
        .handling,
    ).toBe('nekt');
  });
  // En eksisterende ko/<id> med commits foran basen (etter slipp) skal aldri nullstilles med -B.
  it('bytter til en eksisterende gren med commits foran basen i stedet for å nullstille den', () => {
    expect(
      grenBeslutning({
        gjeldende: 'worktree-agent-x',
        gren: 'ko/X',
        skittent: false,
        egneCommits: 0,
        maalCommits: 3,
      }),
    ).toEqual({ handling: 'switch', maalCommits: 3 });
  });
  it('nekter å ta over en eksisterende gren med commits fra et skittent worktree', () => {
    const b = grenBeslutning({
      gjeldende: 'worktree-agent-x',
      gren: 'ko/X',
      skittent: true,
      egneCommits: 0,
      maalCommits: 2,
      base: 'main',
    });
    expect(b.handling).toBe('nekt');
    expect(b.grunn).toContain('ko/X finnes med 2 commit(s) foran main');
  });
  it('nekter fortsatt når worktreets egen gren har commits, selv om målgrenen også har det', () => {
    expect(
      grenBeslutning({
        gjeldende: 'annen',
        gren: 'ko/X',
        skittent: false,
        egneCommits: 1,
        maalCommits: 2,
      }).handling,
    ).toBe('nekt');
  });
  it('nullstiller en eksisterende gren uten commits foran basen (ingenting går tapt)', () => {
    expect(
      grenBeslutning({
        gjeldende: 'worktree-agent-x',
        gren: 'ko/X',
        skittent: false,
        egneCommits: 0,
        maalCommits: 0,
      }),
    ).toEqual({ handling: 'checkout' });
  });
});

// --fortsett tar over en eksisterende gren (retterunde eller fortsettelse i ny agent) uten reset.
describe('klargjøring: --fortsett', () => {
  const grunnlag = {
    gjeldende: 'worktree-agent-x',
    gren: 'ko/X',
    finnes: true,
    skittent: false,
    egneCommits: 0,
    annetWorktree: null,
  };
  it('bytter til grenen uten reset når den finnes og er ledig', () => {
    expect(fortsettBeslutning(grunnlag)).toEqual({ handling: 'switch' });
  });
  it('beholder grenen når worktreet allerede står på den', () => {
    expect(fortsettBeslutning({ ...grunnlag, gjeldende: 'ko/X', skittent: true })).toEqual({
      handling: 'behold',
    });
  });
  it('nekter når grenen ikke finnes (ingenting å fortsette)', () => {
    const b = fortsettBeslutning({ ...grunnlag, finnes: false });
    expect(b.handling).toBe('nekt');
    expect(b.grunn).toContain('ko/X finnes ikke');
  });
  it('nekter med sti og detach-kommando når grenen er sjekket ut i et annet worktree', () => {
    const b = fortsettBeslutning({ ...grunnlag, annetWorktree: 'C:/wt/gammel' });
    expect(b.handling).toBe('nekt');
    expect(b.grunn).toContain('C:/wt/gammel');
    expect(b.grunn).toContain('git -C "C:/wt/gammel" switch --detach');
  });
  it('nekter fra et skittent worktree', () => {
    expect(fortsettBeslutning({ ...grunnlag, skittent: true }).handling).toBe('nekt');
  });
  it('nekter fra løs HEAD med commits som ikke er på basen (de ville blitt hengende)', () => {
    const b = fortsettBeslutning({ ...grunnlag, gjeldende: '', egneCommits: 2 });
    expect(b.handling).toBe('nekt');
    expect(b.grunn).toContain('2 commit(s)');
  });
  it('bytter fra en worktree-gren med egne commits (de blir værende på den grenen)', () => {
    expect(fortsettBeslutning({ ...grunnlag, egneCommits: 2 })).toEqual({ handling: 'switch' });
  });
});

describe('klargjøring: worktreeMedGren', () => {
  const porcelain = [
    'worktree C:/repo/eksempel',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree C:/repo/eksempel/.claude/worktrees/agent-1',
    'HEAD bbb',
    'branch refs/heads/ko/X',
    '',
    'worktree C:/repo/eksempel/.claude/worktrees/agent-2',
    'HEAD ccc',
    'detached',
    '',
  ].join('\n');
  it('finner worktreet grenen er sjekket ut i', () => {
    expect(worktreeMedGren(porcelain, 'ko/X')).toBe('C:/repo/eksempel/.claude/worktrees/agent-1');
  });
  it('gir null når grenen ikke er sjekket ut noe sted', () => {
    expect(worktreeMedGren(porcelain, 'ko/Y')).toBeNull();
  });
  it('blander ikke ko/X med ko/X-r1', () => {
    expect(worktreeMedGren(porcelain.replace('ko/X', 'ko/X-r1'), 'ko/X')).toBeNull();
  });
  it('tåler CRLF fra git på Windows', () => {
    expect(worktreeMedGren(porcelain.split('\n').join('\r\n'), 'main')).toBe('C:/repo/eksempel');
  });
});

describe('lenkelista (delteLenker)', () => {
  it('normaliserer og fjerner ugyldige og doble stier', () => {
    expect(
      sporLenker(['node_modules', 'web\\node_modules/', './node_modules', '../ut', '/abs', 'C:/x', '']),
    ).toEqual(['node_modules', 'web/node_modules']);
  });
  it('tåler tom og ugyldig liste', () => {
    expect(sporLenker([])).toEqual([]);
    expect(sporLenker('node_modules' as unknown as string[])).toEqual([]);
  });
});
