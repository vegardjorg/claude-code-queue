// =============================================================
// koSvar.test.ts: eiersvar kan ikke gå tapt i arbeidskøen .
//
// En oppgave kan stå blokkert selv om eieren har svart: `venter_paa` hadde fritekst i stedet for en registrert
// spørsmåls-id. Tre tiltak, bevist der de håndheves (de rene funksjonene i koLogikk.js og ko.mjs mot en kopi av køen
// i en midlertidig mappe, aldri den ekte):
//   1. add og endre avviser en ny venter_paa-id som ikke er registrert (fritekst og uregistrert), alt eller ingenting;
//      registrering i samme add ({ oppgaver, sporsmal }) godtas.
//   2. Løse ventinger (fritekst, uregistrert, besvart men blokkerer) rapporteres av fyll, vis og tilstand.
//   3. avklar --svar legger «EIERSVAR <id> (<dato>): <svar>» i oppdraget til hver oppgave som venter, én gang.
// Rød først: uten disse reglene finnes ikke venterPaaFeil/loseVentinger/eiersvarTillegg, og add med fritekst gir exit 0.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Tillegg = { tid: string; tekst: string };
type Oppgave = {
  id: string;
  tittel?: string;
  domene?: string;
  klasse?: string;
  status: string;
  oppdrag?: string;
  avhenger?: string[];
  venter_paa?: string[];
  eier_filer?: string[];
  eier_db?: string[];
  delt_patch?: string[];
  tillegg?: Tillegg[];
  merknader?: string[];
  lagt_til?: string;
  lagt_til_av?: string;
};
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  sporsmal?: Record<string, { type: string; tekst: string; lagt_til?: string }>;
  avklaringer?: Record<string, { tid: string; svar: string | null; av: string | null }>;
  grenser?: Record<string, unknown>;
  neste_migr?: number;
};
type Los = { id: string; status: string; sp: string; grunn: string };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk') as {
  SPORSMAL_ID_MONSTER: RegExp;
  venterPaaFeil: (o: Oppgave, ko: Ko, valg?: { tidligere?: string[] }) => string[];
  loseVentinger: (ko: Ko) => Los[];
  loseVentingerLinjer: (liste: Los[], valg?: { maks?: number }) => string[];
  eiersvarTillegg: (
    ko: Ko,
    ider: string[],
    svar: string | null,
    naa?: string,
  ) => { id: string; sp: string }[];
  settSporsmal: (ko: Ko, inn: unknown, naa?: string) => { satt: string[]; feil: string[] };
  sporBlokk: (o: Oppgave, ko: Ko) => string;
};

const T1 = '2026-10-10T10:00:00.000Z';
const T2 = '2026-10-11T08:00:00.000Z';
const FRITEKST = 'eier: (a) river deactivate_user og bygger ny';

function opp(id: string, felt: Partial<Oppgave> = {}): Oppgave {
  return {
    id,
    tittel: `Oppgave ${id}`,
    domene: 'klient',
    klasse: 'K',
    status: 'venter',
    oppdrag: `Gjør ${id}.`,
    avhenger: [],
    venter_paa: [],
    eier_filer: [],
    eier_db: [],
    delt_patch: [],
    lagt_til: T1,
    ...felt,
  };
}

const registrert = (): Ko['sporsmal'] => ({
  'SP-M8d': { type: 'sporsmal', tekst: 'River vi deactivate_user?', lagt_til: T1 },
});

describe('venterPaaFeil (sperren i add og endre)', () => {
  it('fritekst-id avvises, også når den er registrert med tekst (mønsteret er strengt)', () => {
    const ko: Ko = { oppgaver: [], sporsmal: registrert() };
    const f = L.venterPaaFeil(opp('X', { venter_paa: [FRITEKST] }), ko);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/er ikke en spørsmål-id/);
    expect(L.SPORSMAL_ID_MONSTER.test('SP-M8d')).toBe(true);
    expect(L.SPORSMAL_ID_MONSTER.test('a'.repeat(41))).toBe(false);
    expect(L.SPORSMAL_ID_MONSTER.test('Ø 9')).toBe(false);
  });

  it('uregistrert id avvises; registrert id (tekst og type) godtas', () => {
    const ko: Ko = { oppgaver: [], sporsmal: registrert() };
    expect(L.venterPaaFeil(opp('X', { venter_paa: ['SP-UKJENT'] }), ko)[0]).toMatch(
      /SP-UKJENT er ikke registrert/,
    );
    expect(L.venterPaaFeil(opp('X', { venter_paa: ['SP-M8d'] }), ko)).toEqual([]);
  });

  it('ventinger som stod der fra før (endre), avvises ikke; nye gjør det', () => {
    const ko: Ko = { oppgaver: [], sporsmal: registrert() };
    const o = opp('X', { venter_paa: ['GAMMEL', 'NY'] });
    const f = L.venterPaaFeil(o, ko, { tidligere: ['GAMMEL'] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/NY er ikke registrert/);
  });

  it('settSporsmal: et nytt spørsmål med fritekst-id avvises', () => {
    const ko: Ko = { oppgaver: [] };
    expect(L.settSporsmal(ko, { [FRITEKST]: { tekst: 'x' } }).feil[0]).toMatch(/ugyldig id/);
    expect(ko.sporsmal).toBeUndefined();
  });
});

describe('loseVentinger (kontroll ved fyll, vis og tilstand)', () => {
  it('fritekst, uregistrert og besvart-men-blokkerer; avklart uten tekst og ferdige oppgaver er ikke med', () => {
    const ko: Ko = {
      oppgaver: [
        opp('A', { venter_paa: [FRITEKST] }),
        opp('B', { status: 'forslag', venter_paa: ['SP-UREG'] }),
        opp('C', { venter_paa: ['SP-SVART'] }),
        opp('D', { venter_paa: ['SP-M8d', 'SP-AVKLART'] }),
        opp('E', { status: 'ferdig', venter_paa: [FRITEKST] }),
      ],
      sporsmal: registrert(),
      avklart: ['SP-AVKLART'],
      avklaringer: { 'SP-SVART': { tid: T1, svar: 'Ja', av: 'eier' } },
    };
    expect(L.loseVentinger(ko)).toEqual([
      { id: 'A', status: 'venter', sp: FRITEKST, grunn: 'fritekst' },
      { id: 'B', status: 'forslag', sp: 'SP-UREG', grunn: 'uregistrert' },
      { id: 'C', status: 'venter', sp: 'SP-SVART', grunn: 'avklart-blokkerer' },
    ]);
    const linjer = L.loseVentingerLinjer(L.loseVentinger(ko), { maks: 2 });
    expect(linjer[0]).toMatch(/^VARSEL: 3 løs\(e\) venting\(er\) i 3 oppgave\(r\)/);
    expect(linjer).toHaveLength(4);
    expect(linjer[3]).toMatch(/\+1 til/);
    expect(L.loseVentingerLinjer([])).toEqual([]);
  });
});

describe('eiersvarTillegg (svaret inn i oppdraget)', () => {
  it('legger tillegget på hver oppgave som venter, én gang; nytt svar gir ny linje; ferdig hoppes over', () => {
    const ko: Ko = {
      oppgaver: [
        opp('A', { venter_paa: ['SP-M8d'] }),
        opp('B', { status: 'forslag', venter_paa: ['SP-M8d', 'ANNET'] }),
        opp('C', { status: 'ferdig', venter_paa: ['SP-M8d'] }),
        opp('D'),
      ],
    };
    expect(L.eiersvarTillegg(ko, ['SP-M8d'], ' (a) river ', T1)).toEqual([
      { id: 'A', sp: 'SP-M8d' },
      { id: 'B', sp: 'SP-M8d' },
    ]);
    expect(ko.oppgaver[0].tillegg).toEqual([
      { tid: T1, tekst: 'EIERSVAR SP-M8d (2026-10-10): (a) river' },
    ]);
    // Idempotent, også en annen dag.
    expect(L.eiersvarTillegg(ko, ['SP-M8d'], '(a) river', T2)).toEqual([]);
    expect(ko.oppgaver[0].tillegg).toHaveLength(1);
    expect(ko.oppgaver[2].tillegg).toBeUndefined();
    expect(ko.oppgaver[3].tillegg).toBeUndefined();
    // Et endret svar er ny informasjon og legges til.
    expect(L.eiersvarTillegg(ko, ['SP-M8d'], '(b) behold', T2)).toHaveLength(2);
    expect(ko.oppgaver[0].tillegg?.[1].tekst).toBe('EIERSVAR SP-M8d (2026-10-11): (b) behold');
    // Uten svar: ingenting.
    expect(L.eiersvarTillegg(ko, ['SP-M8d'], null, T2)).toEqual([]);
  });

  it('sporblokka (og dermed prompten) viser EIERSVAR-tillegget', () => {
    const ko: Ko = { oppgaver: [opp('A', { venter_paa: ['SP-M8d'] })], sporsmal: registrert() };
    L.eiersvarTillegg(ko, ['SP-M8d'], 'river', T1);
    expect(L.sporBlokk(ko.oppgaver[0], ko)).toContain('EIERSVAR SP-M8d (2026-10-10): river');
  });
});

// ---- ko.mjs mot en kopi av køen (aldri den ekte) ----
describe('ko.mjs: add/endre avviser, tilstand/vis varsler, avklar skriver svaret inn', () => {
  const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');
  let mappe: string;

  function kjor(args: string[]): { kode: number; ut: string; feil: string } {
    try {
      const ut = execFileSync(process.execPath, [KO_MJS, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: mappe,
          KO_GIT: mappe,
          KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { kode: 0, ut, feil: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { kode: x.status, ut: String(x.stdout ?? ''), feil: String(x.stderr ?? '') };
    }
  }
  const lesKo = (): Ko => JSON.parse(readFileSync(join(mappe, 'ko.json'), 'utf8'));
  const skrivFil = (navn: string, innhold: unknown) => {
    const sti = join(mappe, navn);
    writeFileSync(sti, JSON.stringify(innhold));
    return sti;
  };

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-svar-'));
    const ko: Ko = {
      oppgaver: [
        opp('A', { venter_paa: ['SP-M8d'] }),
        // Gammel data: fritekst fra før sperren.
        opp('B', { status: 'forslag', venter_paa: [FRITEKST], lagt_til_av: 'X-9' }),
      ],
      avklart: [],
      sporsmal: registrert(),
      grenser: { maksSamtidig: 5, maksDPluss: 2, maksPerDomene: 7, maksDb: 6 },
      neste_migr: 100,
    };
    writeFileSync(join(mappe, 'ko.json'), JSON.stringify(ko));
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('add: fritekst og uregistrert id avvises (alt eller ingenting); registrering i samme fil godtas', () => {
    const fri = kjor(['add', '--json', JSON.stringify(opp('C', { venter_paa: [FRITEKST] }))]);
    expect(fri.kode).toBe(1);
    expect(fri.feil).toMatch(/C: .*er ikke en spørsmål-id/);
    const ureg = kjor([
      'add',
      '--fil',
      skrivFil('ureg.json', [opp('D'), opp('E', { venter_paa: ['SP-NY'] })]),
    ]);
    expect(ureg.kode).toBe(1);
    expect(ureg.feil).toMatch(/E: venter_paa SP-NY er ikke registrert/);
    expect(lesKo().oppgaver.map((o) => o.id)).toEqual(['A', 'B']);

    const ok = kjor([
      'add',
      '--fil',
      skrivFil('ok.json', {
        oppgaver: [opp('E', { venter_paa: ['SP-NY', 'SP-M8d'] })],
        sporsmal: { 'SP-NY': { type: 'betingelse', tekst: 'Når piloten er i gang.' } },
      }),
    ]);
    expect(ok.kode).toBe(0);
    expect(lesKo().oppgaver.map((o) => o.id)).toEqual(['A', 'B', 'E']);
  });

  it('endre: ny fritekst/uregistrert venter_paa avvises; gammel fritekst stopper ikke andre endringer', () => {
    const r = kjor(['endre', 'A', '--json', JSON.stringify({ venter_paa: ['SP-M8d', FRITEKST] })]);
    expect(r.kode).toBe(1);
    expect(r.feil).toMatch(/er ikke en spørsmål-id/);
    expect(kjor(['endre', 'A', '--json', '{"venter_paa":["SP-UREG"]}']).kode).toBe(1);
    expect(lesKo().oppgaver[0].venter_paa).toEqual(['SP-M8d']);
    expect(kjor(['endre', 'B', '--json', '{"nytte":8}']).kode).toBe(0);
  });

  it('endre-mange kan ikke endre venter_paa', () => {
    const r = kjor([
      'endre-mange',
      '--fil',
      skrivFil('m.json', [{ id: 'A', venter_paa: [FRITEKST] }]),
    ]);
    expect(r.kode).toBe(1);
    expect(r.feil).toMatch(/ukjente felt venter_paa/);
  });

  it('tilstand har feltet loseVentinger; vis har VARSEL-linja', () => {
    const t = JSON.parse(kjor(['tilstand']).ut || '{}') as { loseVentinger?: Los[] };
    expect(t.loseVentinger).toEqual([
      { id: 'B', status: 'forslag', sp: FRITEKST, grunn: 'fritekst' },
    ]);
    const v = kjor(['vis']);
    expect(v.ut).toMatch(/VARSEL: 1 løs\(e\) venting\(er\)/);
    expect(v.ut).toContain('B (forslag) venter på');
  });

  it('avklar --svar legger EIERSVAR i oppdraget én gang', () => {
    expect(kjor(['avklar', 'SP-M8d', '--svar', '(a) river', '--av', 'eier']).kode).toBe(0);
    const r2 = kjor(['avklar', 'SP-M8d', '--svar', '(a) river', '--av', 'eier']);
    expect(r2.kode).toBe(0);
    const t = lesKo().oppgaver[0].tillegg ?? [];
    expect(t).toHaveLength(1);
    expect(t[0].tekst).toMatch(/^EIERSVAR SP-M8d \(\d{4}-\d\d-\d\d\): \(a\) river$/);
    expect(lesKo().avklart).toEqual(['SP-M8d']);
  });
});
