// =============================================================
// koSparemodus.test.ts: sparemodus i arbeidskøen (lib/koLogikk.js). Budsjettvakten stopper nye oppgaver når
// dagens forbruk har nådd dagsbudsjettet, og forslag fra agenter startes aldri før de er godkjent.
// =============================================================
import { describe, it, expect } from 'vitest';

type Oppgave = {
  id: string;
  tittel?: string;
  domene: string;
  klasse: 'K' | 'D' | 'D+' | 'U';
  status: string;
  lagt_til_av?: string;
  avhenger?: string[];
  godkjent?: string;
};
type Ko = {
  oppgaver: Oppgave[];
  grenser?: Record<string, number | null>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../koLogikk') as {
  STANDARD_GRENSER: Record<string, number | null>;
  valider: (o: unknown, eks?: Oppgave[]) => string[];
  hindringer: (o: Oppgave, alle: Oppgave[], avklart?: string[]) => string[];
  velgNeste: (ko: Ko) => { id: string }[];
  tilstand: (
    ko: Ko,
    dagsforbruk?: number,
  ) => {
    tom: boolean;
    kanStarte: number;
    forslag: number;
    stopp?: string;
    budsjett?: string;
    blokkert: { id: string; hindringer: string[] }[];
  };
  budsjettVakt: (
    ko: Ko,
    dagsforbruk?: number,
  ) => { aktiv: boolean; stopp: boolean; melding?: string };
  tolkGrense: (navn: string, raa: string) => { verdi: number | null } | { feil: string };
  erAgentKilde: (lagtTilAv: string | undefined, oppgaver?: Oppgave[]) => boolean;
  statusVedAdd: (ny: Partial<Oppgave>, oppgaver?: Oppgave[], v?: { godkjent?: boolean }) => string;
  godkjenn: (ko: Ko, ider: string[], naa?: string) => { godkjent: string[]; feil: string[] };
};

const o = (id: string, ekstra: Partial<Oppgave> = {}): Oppgave => ({
  id,
  tittel: id,
  domene: 'eksempel',
  klasse: 'K',
  status: 'venter',
  ...ekstra,
});

describe('budsjettvakt', () => {
  it('standard er av: ingen grense før eieren har satt et tall', () => {
    expect(K.STANDARD_GRENSER.dagsbudsjett).toBeNull();
    expect(K.budsjettVakt({ oppgaver: [] }, 10_000)).toEqual({ aktiv: false, stopp: false });
    expect(K.budsjettVakt({ oppgaver: [], grenser: { dagsbudsjett: 0 } }, 10_000).aktiv).toBe(
      false,
    );
  });

  it('under grensen: aktiv, ikke stopp; på eller over: stopp med tydelig melding', () => {
    const ko = { oppgaver: [], grenser: { dagsbudsjett: 300 } };
    expect(K.budsjettVakt(ko, 299.99)).toMatchObject({ aktiv: true, stopp: false });
    const b = K.budsjettVakt(ko, 300);
    expect(b.stopp).toBe(true);
    expect(b.melding).toMatch(/DAGSBUDSJETTET ER BRUKT OPP: 300\.00 av 300\.00 USD/);
  });

  it('tilstand: over budsjettet kan ingenting startes, og en kø uten kjørende er «tom» (løkka stopper)', () => {
    const ko = { oppgaver: [o('a'), o('b')], grenser: { dagsbudsjett: 100 } };
    expect(K.tilstand(ko, 50)).toMatchObject({ kanStarte: 2, tom: false });
    const t = K.tilstand(ko, 150);
    expect(t).toMatchObject({ kanStarte: 0, tom: true, stopp: 'dagsbudsjett' });
    expect(t.budsjett).toMatch(/BRUKT OPP/);
    // Blokkert-lista sier hvorfor, i stedet for tomme hindringer.
    expect(t.blokkert).toEqual([
      { id: 'a', hindringer: ['dagsbudsjettet er brukt opp'] },
      { id: 'b', hindringer: ['dagsbudsjettet er brukt opp'] },
    ]);
    // Uten forbruk (budsjett av) som før.
    expect(K.tilstand({ oppgaver: [o('a')] }).kanStarte).toBe(1);
  });

  it('grenser tolkes strengt: dagsbudsjett i USD eller «av», maks* som heltall ≥ 0', () => {
    expect(K.tolkGrense('dagsbudsjett', '250,5')).toEqual({ verdi: 250.5 });
    expect(K.tolkGrense('dagsbudsjett', 'av')).toEqual({ verdi: null });
    expect(K.tolkGrense('dagsbudsjett', '-1')).toHaveProperty('feil');
    expect(K.tolkGrense('maksSamtidig', '5')).toEqual({ verdi: 5 });
    expect(K.tolkGrense('maksSamtidig', '-1')).toHaveProperty('feil');
    expect(K.tolkGrense('maksAlt', '5')).toHaveProperty('feil');
  });
});

describe('forslag fra agenter', () => {
  const ko: Oppgave[] = [o('SB-D2', { status: 'ferdig' }), o('B-4', { status: 'kjorer' })];

  it('et spor (oppgave-id i køen, også en retterunde), en reviewer eller en fold-agent er agentkilder', () => {
    expect(K.erAgentKilde('SB-D2', ko)).toBe(true);
    expect(K.erAgentKilde('B-4-r2', ko)).toBe(true);
    expect(K.erAgentKilde('rev-B-4', ko)).toBe(true);
    expect(K.erAgentKilde('fold-agent 2026-09-30 (9.241 DEL 7-10)', ko)).toBe(true);
  });

  it('eieren (legg-til-ko) og orkestratoren er ikke agentkilder', () => {
    expect(K.erAgentKilde('legg-til-ko 2026-09-30 (R2 sikkerhetssjekk)', ko)).toBe(false);
    expect(K.erAgentKilde('orkestrator', ko)).toBe(false);
    expect(K.erAgentKilde(undefined, ko)).toBe(false);
    expect(K.erAgentKilde('revisjon av plan', ko)).toBe(false);
  });

  it('add: agent gir forslag, ellers venter; --godkjent gir venter', () => {
    expect(K.statusVedAdd({ id: 'NY-1', lagt_til_av: 'SB-D2' }, ko)).toBe('forslag');
    expect(K.statusVedAdd({ id: 'NY-2', lagt_til_av: 'orkestrator' }, ko)).toBe('venter');
    expect(K.statusVedAdd({ id: 'NY-3', lagt_til_av: 'SB-D2' }, ko, { godkjent: true })).toBe(
      'venter',
    );
  });

  it('et forslag startes aldri, og hindringen sier hvordan det godkjennes', () => {
    const alle = [o('F1', { status: 'forslag', lagt_til_av: 'SB-D2' }), o('V1')];
    expect(K.velgNeste({ oppgaver: alle }).map((v) => v.id)).toEqual(['V1']);
    expect(K.hindringer(alle[0], alle)[0]).toMatch(/ko\.mjs godkjenn F1/);
    expect(K.tilstand({ oppgaver: alle }).forslag).toBe(1);
    expect(K.valider({ ...o('X', { status: 'forslag' }), oppdrag: 'tekst' })).toEqual([]);
  });

  it('godkjenn: forslag → venter med tidsstempel; alt annet er feil', () => {
    const k: Ko = { oppgaver: [o('F1', { status: 'forslag' }), o('V1')] };
    const r = K.godkjenn(k, ['F1', 'V1', 'Z'], '2026-09-30T12:00:00Z');
    expect(r.godkjent).toEqual(['F1']);
    expect(r.feil).toEqual(['V1 er ikke et forslag (status venter)', 'ukjent oppgave Z']);
    expect(k.oppgaver[0]).toMatchObject({ status: 'venter', godkjent: '2026-09-30T12:00:00Z' });
    expect(
      K.velgNeste(k)
        .map((v) => v.id)
        .sort(),
    ).toEqual(['F1', 'V1']);
  });
});
