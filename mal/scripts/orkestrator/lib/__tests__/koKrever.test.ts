// Feltet `krever`: ressurser utover repoet på remoten avgjør om en oppgave kan gå i skyen.
import { describe, expect, test } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk.js');

const ko = (krever?: string[]) => ({
  oppgaver: [{ id: 'X-1', tittel: 'x', klasse: 'K', status: 'venter', krever }],
  avklart: [],
});
const vurder = (krever?: string[]) =>
  L.skyEgnet(ko(krever), 'X-1', { pushetHead: 'abc', endret: [], oppdragTekst: '', egenSti: null });

describe('krever og skyen', () => {
  test('uten krever er en enkel K-oppgave egnet', () => {
    expect(vurder().egnet).toBe(true);
  });

  test.each(['db', 'nett', 'kilder', 'lokale-filer', 'enhet'])(
    '%s holder oppgaven lokalt',
    (k: string) => {
      const v = vurder([k]);
      expect(v.egnet).toBe(false);
      expect(v.grunner.length).toBeGreaterThan(0);
    },
  );

  test('deploy stenger ikke (orkestratoren deployer etter flettingen)', () => {
    expect(vurder(['deploy']).egnet).toBe(true);
  });

  test('validerNyeFelt avviser ukjente verdier og godtar kjente', () => {
    expect(L.validerNyeFelt({ krever: ['tull'] }, {})).not.toEqual([]);
    expect(L.validerNyeFelt({ krever: 'db' }, {})).not.toEqual([]);
    expect(L.validerNyeFelt({ krever: ['db', 'deploy'] }, {})).toEqual([]);
  });
});
