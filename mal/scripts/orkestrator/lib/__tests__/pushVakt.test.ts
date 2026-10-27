// =============================================================
// pushVakt.test.ts: beslutningene til PreToolUse-hooken hook-push-vakt.mjs.
//
// Låser at de dyre/irreversible kommandoene stoppes (tvungen push, push av andre grener enn basegrenen,
// migrasjonspush mot et miljø som ikke er tillatt), og at vanlig arbeid går fritt. Se lib/pushVakt.js.
// =============================================================
import { describe, expect, it } from 'vitest';

import { erKommando, lesMiljo, vurder } from '../pushVakt';

const MIG = {
  pushKommando: 'npx dbverktoy migrate push --yes',
  miljoFil: '.miljo',
  tillatteMiljo: ['test'],
};
const STD = { baseGren: 'main', migrasjoner: MIG };
const beslutning = (k: string, kontekst = {}) => vurder(k, { ...STD, ...kontekst })?.beslutning ?? null;

describe('git push', () => {
  it('slipper push til basegrenen, uansett form', () => {
    expect(beslutning('git push origin main')).toBeNull();
    expect(beslutning('git push -u origin main')).toBeNull();
    expect(beslutning('git push origin HEAD:refs/heads/main')).toBeNull();
    expect(beslutning('git -C /repo push origin main')).toBeNull();
    expect(beslutning('git push', { gren: 'main' })).toBeNull();
    expect(beslutning('git push origin HEAD', { gren: 'main' })).toBeNull();
  });
  it('følger konfigurert basegren', () => {
    expect(beslutning('git push origin utvikling', { baseGren: 'utvikling' })).toBeNull();
    expect(beslutning('git push origin main', { baseGren: 'utvikling' })).toBe('deny');
  });
  it('blokkerer push av andre grener', () => {
    expect(beslutning('git push -u origin ko/A-1')).toBe('deny');
    expect(beslutning('git push', { gren: 'ko/A-1' })).toBe('deny');
    expect(beslutning('git push origin main ko/A-1')).toBe('deny');
    expect(vurder('git push origin ko/A-1', STD)?.grunn).toMatch(/basegrenen \(main\)/);
  });
  it('blokkerer tvungen push, også til egne grener', () => {
    expect(beslutning('git push --force origin main')).toBe('deny');
    expect(beslutning('git push -f origin ko/A-1')).toBe('deny');
    expect(beslutning('git push origin +main')).toBe('deny');
    expect(beslutning('git push --force-with-lease origin main')).toBe('deny');
    expect(beslutning('git push -uf origin main')).toBe('deny');
    expect(beslutning('git push --all origin')).toBe('deny');
  });
  it('spør når grenen ikke kan avgjøres', () => {
    expect(beslutning('git push')).toBe('ask');
  });
  it('slipper andre git-kommandoer og tekst som bare nevner push', () => {
    expect(beslutning('git status && git log --oneline -3')).toBeNull();
    expect(beslutning('echo "git push origin ko/A-1" > notat.txt')).toBeNull();
  });
});

describe('migrasjonspush', () => {
  it('slipper når miljøet er tillatt eller fila mangler', () => {
    expect(beslutning('npx dbverktoy migrate push --yes', { miljo: 'test' })).toBeNull();
    expect(beslutning('npx dbverktoy migrate push --yes', { miljo: null })).toBeNull();
  });
  it('blokkerer når miljøet ikke er tillatt, også med andre valg og uten npx', () => {
    expect(beslutning('npx dbverktoy migrate push --yes', { miljo: 'drift' })).toBe('deny');
    expect(beslutning('dbverktoy migrate push', { miljo: 'drift' })).toBe('deny');
    expect(beslutning('dbverktoy.exe migrate push --debug', { miljo: 'drift' })).toBe('deny');
  });
  it('tom liste over tillatte miljø blokkerer alt når fila finnes', () => {
    expect(
      beslutning('dbverktoy migrate push', {
        miljo: 'test',
        migrasjoner: { ...MIG, tillatteMiljo: [] },
      }),
    ).toBe('deny');
  });
  it('er av uten pushKommando eller miljoFil', () => {
    expect(
      beslutning('dbverktoy migrate push', { miljo: 'drift', migrasjoner: { ...MIG, miljoFil: null } }),
    ).toBeNull();
    expect(
      beslutning('dbverktoy migrate push', { miljo: 'drift', migrasjoner: { ...MIG, pushKommando: null } }),
    ).toBeNull();
  });
  it('andre underkommandoer er frie', () => {
    expect(beslutning('dbverktoy migrate list', { miljo: 'drift' })).toBeNull();
  });
  it('erKommando sammenligner kjerneordene', () => {
    expect(erKommando(['npm', 'exec', 'dbverktoy', 'migrate', 'push'], MIG.pushKommando)).toBe(true);
    expect(erKommando(['dbverktoy', 'migrate'], MIG.pushKommando)).toBe(false);
  });
  it('lesMiljo gir null uten fil', () => {
    expect(lesMiljo(['/finnes/ikke'], '.miljo')).toBeNull();
    expect(lesMiljo(['/finnes/ikke'], null)).toBeNull();
  });
});

describe('flere kommandoer', () => {
  it('den strengeste vinner', () => {
    expect(beslutning('git push; git push -f origin main')).toBe('deny');
  });
});
