// =============================================================
// koSmaa.test.ts: småoppgavevakten i arbeidskøen.
//
// En liten oppgave skal ikke bli et eget spor: <= 10 min tilbys eieren som «fiks nå» eller samlekøen, en større men
// fortsatt liten oppgave med lav prioritet går i samlekøen, og uten nytte (usikker prioritet) spørres eieren. Testene
// asserterer den rene funksjonen i koLogikk.js som `ko.mjs add` kaller.
// =============================================================
import { describe, it, expect } from 'vitest';

type Oppgave = Record<string, unknown> & { id: string };
/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../koLogikk') as {
  smaaoppgaveFeil: (o: Oppgave, oppgaver?: Oppgave[], avklart?: string[]) => string[];
};
/* eslint-enable @typescript-eslint/no-require-imports */

const opp = (felt: Record<string, unknown> = {}): Oppgave => ({
  id: 'A',
  klasse: 'K',
  status: 'venter',
  nytte: 4,
  innhold_min: 5,
  avhenger: [],
  venter_paa: [],
  ...felt,
});

describe('smaaoppgaveFeil', () => {
  it('<= 10 min: ikke i køen, eieren velger fiks nå eller samlekøen', () => {
    expect(L.smaaoppgaveFeil(opp()).join()).toMatch(/fiks nå \(anbefalt\) eller samlekøen/);
    expect(L.smaaoppgaveFeil(opp({ innhold_min: 10 })).join()).toMatch(/fiks nå/);
    expect(L.smaaoppgaveFeil(opp({ samles: true }))).toEqual([]);
  });

  it('over 10 min, under klassens nedre mål og lav prioritet: samlekøen', () => {
    expect(L.smaaoppgaveFeil(opp({ innhold_min: 30 })).join()).toMatch(
      /samlekøen med "samles": true/,
    );
    expect(L.smaaoppgaveFeil(opp({ innhold_min: 30, samles: true }))).toEqual([]);
    expect(L.smaaoppgaveFeil(opp({ klasse: 'D', innhold_min: 20 })).join()).toMatch(/samlekøen/);
  });

  it('høy prioritet over 10 min kan være eget spor', () => {
    expect(L.smaaoppgaveFeil(opp({ innhold_min: 30, nytte: 8 }))).toEqual([]);
  });

  it('usikker prioritet (uten nytte): spør eieren', () => {
    expect(L.smaaoppgaveFeil(opp({ nytte: undefined })).join()).toMatch(/Spør eieren/);
    expect(L.smaaoppgaveFeil(opp({ innhold_min: 30, nytte: undefined })).join()).toMatch(
      /prioriteten er usikker/,
    );
  });

  it('slår ikke inn ved riktig størrelse, uten innhold_min, for D+, eget_spor, eierspørsmål eller blokkerende', () => {
    expect(L.smaaoppgaveFeil(opp({ innhold_min: 90 }))).toEqual([]);
    expect(L.smaaoppgaveFeil(opp({ klasse: 'D', innhold_min: 40 }))).toEqual([]);
    expect(L.smaaoppgaveFeil(opp({ innhold_min: undefined }))).toEqual([]);
    expect(L.smaaoppgaveFeil(opp({ klasse: 'D+' }))).toEqual([]);
    expect(L.smaaoppgaveFeil(opp({ eget_spor: 'eieren ba om det' }))).toEqual([]);
    expect(L.smaaoppgaveFeil(opp({ venter_paa: ['Ø1'] }))).toEqual([]);
    expect(L.smaaoppgaveFeil(opp({ venter_paa: ['Ø1'] }), [], ['Ø1']).join()).toMatch(/fiks nå/);
    const b = { id: 'B', status: 'venter', avhenger: ['A'] };
    expect(L.smaaoppgaveFeil(opp(), [b])).toEqual([]);
  });

  it('eget_spor må være en grunn', () => {
    expect(L.smaaoppgaveFeil(opp({ eget_spor: '' })).join()).toMatch(/eget_spor må være/);
    expect(L.smaaoppgaveFeil(opp({ eget_spor: true })).join()).toMatch(/eget_spor må være/);
  });
});
