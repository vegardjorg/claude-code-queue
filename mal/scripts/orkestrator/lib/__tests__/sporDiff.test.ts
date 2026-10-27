// =============================================================
// sporDiff.test.ts: hvilke filer en flettet spor-gren endret (scripts/orkestrator/lib/sporDiff.js).
//
// Etter `ko.mjs flett` står gatene på basegrenen, der HEAD er lik base, så base...HEAD er tom. Testene beviser i et
// ekte (midlertidig) git-repo at:
//   - grenens egne filer er diffen skille...tupp når gatene får --spor-base/--spor-tupp;
//   - uten argumentene er lista bare `endrede` (tom etter flettingen);
//   - et annet spor flettet etter skillet regnes ikke som dette sporets;
//   - `endrede` (arbeidstreet) legges til, uten duplikater;
//   - en ukjent base gir null (gatene stopper i stedet for å gjette);
//   - sporArgs gir argumentene bare når både skille og tupp finnes.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const SD = require('../sporDiff') as {
  sporArgs: (k: { skille?: string | null; tupp?: string | null }) => string[];
  sporetsEndredeFiler: (k: {
    git: (...args: string[]) => string | null;
    sporBase?: string | null;
    sporTupp?: string | null;
    endrede: string[];
  }) => string[] | null;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ID = ['-c', 'user.name=ko-test', '-c', 'user.email=ko-test@example.invalid'];
const midlertidige: string[] = [];
afterAll(() => {
  for (const m of midlertidige) fs.rmSync(m, { recursive: true, force: true });
});

/**
 * Repo på `main` der grenen spor/a endrer src/a.txt og legger til src/ny.txt, og spor/b (flettet først) endrer
 * src/b.txt. Skillet og tuppen til spor/a huskes FØR flettingen, slik flettesteget gjør.
 */
function lagRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spordiff-'));
  midlertidige.push(repo);
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const skriv = (fil: string, tekst: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, fil)), { recursive: true });
    fs.writeFileSync(path.join(repo, fil), tekst);
    g('add', '--', fil);
  };
  g('init', '-q', '-b', 'main');
  skriv('src/a.txt', 'a\n');
  skriv('src/b.txt', 'b\n');
  g('commit', '-q', '-m', 'start');
  g('switch', '-q', '-c', 'spor/a');
  skriv('src/a.txt', 'a2\n');
  skriv('src/ny.txt', 'ny\n');
  g('commit', '-q', '-m', 'A');
  g('switch', '-q', 'main');
  g('switch', '-q', '-c', 'spor/b');
  skriv('src/b.txt', 'b2\n');
  g('commit', '-q', '-m', 'B');
  g('switch', '-q', 'main');
  g('merge', '-q', '--no-ff', '--no-edit', 'spor/b');
  // Det flettesteget husker FØR flettingen av spor/a:
  const skille = g('merge-base', 'main', 'spor/a');
  const tupp = g('rev-parse', 'spor/a');
  g('merge', '-q', '--no-ff', '--no-edit', 'spor/a');
  const gitFn = (...x: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...x], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  };
  // Det gatene ser på main etter flettingen: base...HEAD (tom) + arbeidstreet (rent).
  const endrede = (gitFn('diff', '--name-only', 'main...HEAD') ?? '')
    .split('\n')
    .filter(Boolean);
  return { skille, tupp, gitFn, endrede };
}

const sortert = (x: string[] | null) => [...(x ?? [])].sort();

describe('sporetsEndredeFiler etter fletting', () => {
  it('grenens egne filer er diffen skille...tupp', () => {
    const { skille, tupp, gitFn, endrede } = lagRepo();
    expect(endrede).toEqual([]);
    const filer = SD.sporetsEndredeFiler({ git: gitFn, sporBase: skille, sporTupp: tupp, endrede });
    expect(sortert(filer)).toEqual(['src/a.txt', 'src/ny.txt']);
  });

  it('uten spor-base er lista bare `endrede` (tom etter flettingen), som en kopi', () => {
    const { gitFn, endrede } = lagRepo();
    expect(SD.sporetsEndredeFiler({ git: gitFn, endrede })).toEqual([]);
    const inn = ['x.txt'];
    const ut = SD.sporetsEndredeFiler({ git: gitFn, endrede: inn });
    expect(ut).toEqual(['x.txt']);
    expect(ut).not.toBe(inn);
  });

  it('et annet spor flettet etter skillet regnes ikke som dette sporets', () => {
    const { skille, tupp, gitFn, endrede } = lagRepo();
    const filer = SD.sporetsEndredeFiler({ git: gitFn, sporBase: skille, sporTupp: tupp, endrede });
    expect(filer).not.toContain('src/b.txt');
    // Uten tupp brukes HEAD, og da kommer spor/b med (derfor sender flettesteget tuppen).
    expect(SD.sporetsEndredeFiler({ git: gitFn, sporBase: skille, endrede })).toContain(
      'src/b.txt',
    );
  });

  it('endrede filer i arbeidstreet legges til, uten duplikater', () => {
    const { skille, tupp, gitFn } = lagRepo();
    const filer = SD.sporetsEndredeFiler({
      git: gitFn,
      sporBase: skille,
      sporTupp: tupp,
      endrede: ['src/a.txt', 'lokal.txt'],
    });
    expect(sortert(filer)).toEqual(['lokal.txt', 'src/a.txt', 'src/ny.txt']);
  });

  it('ukjent spor-base gir null (gatene stopper i stedet for å gjette)', () => {
    const { gitFn } = lagRepo();
    expect(
      SD.sporetsEndredeFiler({
        git: gitFn,
        sporBase: 'finnes-ikke',
        sporTupp: 'HEAD',
        endrede: [],
      }),
    ).toBeNull();
  });
});

describe('sporArgs', () => {
  it('gir --spor-base og --spor-tupp når begge finnes', () => {
    expect(SD.sporArgs({ skille: 'abc', tupp: 'def' })).toEqual([
      '--spor-base',
      'abc',
      '--spor-tupp',
      'def',
    ]);
  });

  it('er tom når skille eller tupp mangler', () => {
    expect(SD.sporArgs({ skille: null, tupp: 'abc' })).toEqual([]);
    expect(SD.sporArgs({ skille: 'abc', tupp: null })).toEqual([]);
    expect(SD.sporArgs({})).toEqual([]);
  });
});
