// =============================================================
// koNatt.test.ts: nattpausen i arbeidskøen (lib/koLogikk.js og ko.mjs).
//
// Med `grenser.nattkjoring` = false startes ingen nye oppgaver inne i nattvinduet (`grenser.nattvindu`, standard
// «23-06», norsk tid): `ko.mjs neste` foreslår ingenting og `start` nekter, begge med exit 5 og «Nattpause til 06:00»
// (samme mønster som budsjettvakta, exit 4). `start --tving` overstyrer. Standard (på) gir uendret oppførsel.
// Testene beviser reglene der de håndheves: de rene funksjonene i koLogikk, og ko.mjs mot en kopi av køen i en
// midlertidig mappe (KO_MAPPE), med et nattvindu som alltid dekker klokka nå.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Oppgave = {
  id: string;
  tittel?: string;
  domene: string;
  klasse: 'K' | 'D' | 'D+' | 'U';
  status: string;
  oppdrag?: string;
  avhenger?: string[];
  startet?: string;
};
type Ko = {
  oppgaver: Oppgave[];
  grenser?: Record<string, number | boolean | string | null>;
  neste_migr?: number;
};
type Vindu = { fra: number; til: number };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk') as {
  STANDARD_GRENSER: Record<string, unknown>;
  GRENSE_NAVN: string[];
  tolkNattvindu: (s: string) => Vindu | null;
  iNattvindu: (v: Vindu | null, naa: number) => boolean;
  nattVakt: (
    ko: Ko,
    naa?: number,
  ) => { aktiv: boolean; stopp: boolean; til?: string; melding?: string };
  startVakt: (
    ko: Ko,
    dagsforbruk?: number,
    valg?: { naa?: number; tving?: boolean },
  ) => { kode: number; stopp: string; melding: string } | null;
  tilstand: (
    ko: Ko,
    dagsforbruk?: number,
    valg?: { naa?: number },
  ) => {
    tom: boolean;
    kanStarte: number;
    stopp?: string;
    natt?: string;
    blokkert: { id: string; hindringer: string[] }[];
  };
  tolkGrense: (
    navn: string,
    raa: string,
    gjeldende?: Record<string, unknown>,
  ) => { verdi: unknown } | { feil: string };
  grenseTekst: (navn: string, v: unknown) => string;
};

// 30.09.2026 er sommertid (UTC+2); 01.12.2026 er normaltid (UTC+1).
const oslo = (iso: string) => Date.parse(iso);
const NATT_SOMMER = oslo('2026-09-30T21:30:00Z'); // 23:30 i Oslo
const KVELD_SOMMER = oslo('2026-09-30T20:30:00Z'); // 22:30 i Oslo
const MORGEN_INNE = oslo('2026-10-01T03:59:00Z'); // 05:59 i Oslo
const MORGEN_UTE = oslo('2026-10-01T04:00:00Z'); // 06:00 i Oslo
const NATT_VINTER = oslo('2026-12-01T22:00:00Z'); // 23:00 i Oslo (normaltid)
const KVELD_VINTER = oslo('2026-12-01T21:59:00Z'); // 22:59 i Oslo

const opp = (id: string, felt: Partial<Oppgave> = {}): Oppgave => ({
  id,
  tittel: id,
  domene: 'klient',
  klasse: 'K',
  status: 'venter',
  oppdrag: 'x',
  ...felt,
});

describe('nattvinduet (norsk tid)', () => {
  const standard = L.tolkNattvindu('23-06');

  it('inne og ute av vinduet «23-06», med sommertid og normaltid', () => {
    expect(L.iNattvindu(standard, NATT_SOMMER)).toBe(true);
    expect(L.iNattvindu(standard, KVELD_SOMMER)).toBe(false);
    expect(L.iNattvindu(standard, NATT_VINTER)).toBe(true);
    expect(L.iNattvindu(standard, KVELD_VINTER)).toBe(false);
  });

  it('vindu over midnatt: gjelder til kl. 06, ikke fra kl. 06', () => {
    expect(L.iNattvindu(standard, MORGEN_INNE)).toBe(true);
    expect(L.iNattvindu(standard, MORGEN_UTE)).toBe(false);
  });

  it('vindu innen samme døgn («01-05»)', () => {
    const v = L.tolkNattvindu('01-05');
    expect(L.iNattvindu(v, oslo('2026-09-30T00:00:00Z'))).toBe(true); // 02:00
    expect(L.iNattvindu(v, oslo('2026-09-30T03:00:00Z'))).toBe(false); // 05:00
    expect(L.iNattvindu(v, oslo('2026-09-29T22:30:00Z'))).toBe(false); // 00:30
  });
});

describe('nattVakt og startVakt', () => {
  const ko = (grenser: Ko['grenser'] = {}): Ko => ({ oppgaver: [opp('A')], grenser });

  it('standard (nattkjøring på) gir uendret oppførsel, også midt på natta', () => {
    expect(L.STANDARD_GRENSER.nattkjoring).toBe(true);
    expect(L.STANDARD_GRENSER.nattvindu).toBe('23-06');
    expect(L.nattVakt(ko(), NATT_SOMMER)).toEqual({ aktiv: false, stopp: false });
    expect(L.startVakt(ko(), 0, { naa: NATT_SOMMER })).toBeNull();
    const t = L.tilstand(ko(), 0, { naa: NATT_SOMMER });
    expect(t.kanStarte).toBe(1);
    expect(t.stopp).toBeUndefined();
  });

  it('nattkjøring av: stopper inne i vinduet med exit 5 og «Nattpause til 06:00», ikke ute av det', () => {
    const k = ko({ nattkjoring: false });
    const inne = L.startVakt(k, 0, { naa: NATT_SOMMER });
    expect(inne?.kode).toBe(5);
    expect(inne?.stopp).toBe('nattpause');
    expect(inne?.melding).toMatch(/^Nattpause til 06:00/);
    expect(L.startVakt(k, 0, { naa: KVELD_SOMMER })).toBeNull();
    expect(L.nattVakt(k, KVELD_SOMMER)).toMatchObject({ aktiv: true, stopp: false });
  });

  it('--tving (eierens ord) overstyrer nattpausen', () => {
    expect(
      L.startVakt(ko({ nattkjoring: false }), 0, { naa: NATT_SOMMER, tving: true }),
    ).toBeNull();
  });

  it('budsjettvakta går først (exit 4) når begge stopper', () => {
    const k = ko({ nattkjoring: false, dagsbudsjett: 10 });
    expect(L.startVakt(k, 20, { naa: NATT_SOMMER })?.kode).toBe(4);
  });

  it('tilstand: ingenting kan startes, stopp nattpause, og den ventende får nattpausen som hindring', () => {
    const t = L.tilstand(ko({ nattkjoring: false }), 0, { naa: NATT_SOMMER });
    expect(t.kanStarte).toBe(0);
    expect(t.stopp).toBe('nattpause');
    expect(t.natt).toMatch(/^Nattpause til 06:00/);
    expect(t.blokkert).toEqual([{ id: 'A', hindringer: ['nattpause til 06:00'] }]);
  });

  it('et eget vindu styrer klokkeslettet i meldingen', () => {
    const k = ko({ nattkjoring: false, nattvindu: '22-07' });
    expect(L.startVakt(k, 0, { naa: KVELD_SOMMER })?.melding).toMatch(/^Nattpause til 07:00/);
  });
});

describe('grense: validering', () => {
  it('nattkjoring og nattvindu er grenser', () => {
    expect(L.GRENSE_NAVN).toEqual(expect.arrayContaining(['nattkjoring', 'nattvindu']));
  });

  it('nattvindu avviser feil format', () => {
    for (const feil of ['2306', '23-6', '24-06', '23-23', '', 'ab-cd', '23 - 06', '-1-06'])
      expect(L.tolkGrense('nattvindu', feil)).toHaveProperty('feil');
    expect(L.tolkGrense('nattvindu', '23-06')).toEqual({ verdi: '23-06' });
    expect(L.tolkGrense('nattvindu', ' 00-05 ')).toEqual({ verdi: '00-05' });
  });

  it('nattkjoring: på eller av', () => {
    expect(L.tolkGrense('nattkjoring', 'på')).toEqual({ verdi: true });
    expect(L.tolkGrense('nattkjoring', 'PA')).toEqual({ verdi: true });
    expect(L.tolkGrense('nattkjoring', 'av')).toEqual({ verdi: false });
    expect(L.tolkGrense('nattkjoring', 'kanskje')).toHaveProperty('feil');
    expect(L.grenseTekst('nattkjoring', false)).toBe('av');
    expect(L.grenseTekst('nattkjoring', true)).toBe('på');
  });

  it('maks*: heltall ≥ 0; maksDPluss høyst maksSamtidig, maksDb kan være større', () => {
    expect(L.tolkGrense('maksSamtidig', '0')).toEqual({ verdi: 0 });
    for (const feil of ['-1', '1.5', '', 'fem'])
      expect(L.tolkGrense('maksSamtidig', feil)).toHaveProperty('feil');
    const g = { maksSamtidig: 5 };
    expect(L.tolkGrense('maksDPluss', '9', g)).toEqual({
      feil: 'maksDPluss kan ikke være større enn maksSamtidig (5)',
    });
    // Plukkede oppgaver teller i maksDb, men ikke i maksSamtidig: 6 og 5 er meningsfulle sammen.
    expect(L.tolkGrense('maksDb', '6', g)).toEqual({ verdi: 6 });
    expect(L.tolkGrense('maksDb', '5', g)).toEqual({ verdi: 5 });
    // maksSamtidig selv kan settes lavere (0 stopper køen).
    expect(L.tolkGrense('maksSamtidig', '0', { maksSamtidig: 5, maksDb: 6 })).toEqual({ verdi: 0 });
  });
});

// ---- ko.mjs mot en kopi av køen (aldri den ekte) ----
describe('ko.mjs: nattpause og grense', () => {
  const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');
  let mappe: string;

  // Et vindu på to timer fra timen nå (norsk tid) dekker alltid klokka mens testen kjører.
  const timeNaa = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Oslo',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  const pad = (x: number) => String(x % 24).padStart(2, '0');
  const vinduNaa = `${pad(timeNaa)}-${pad(timeNaa + 2)}`;

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

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-natt-'));
    const ko: Ko = {
      oppgaver: [opp('A')],
      grenser: { maksSamtidig: 5, maksDPluss: 2, maksPerDomene: 7, maksDb: 5 },
      neste_migr: 100,
    };
    writeFileSync(join(mappe, 'ko.json'), JSON.stringify(ko));
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('standard: neste foreslår som før', () => {
    const r = kjor(['neste']);
    expect(r.kode).toBe(0);
    expect(r.ut).toContain('A');
  });

  it('nattkjoring av inne i vinduet: neste og start gir exit 5, start --tving starter', () => {
    expect(kjor(['grense', 'nattvindu', vinduNaa]).kode).toBe(0);
    const av = kjor(['grense', 'nattkjoring', 'av']);
    expect(av.kode).toBe(0);
    expect(av.ut).toContain('nattkjoring = av');
    const neste = kjor(['neste']);
    expect(neste.kode).toBe(5);
    expect(neste.feil).toMatch(/Nattpause til \d\d:00/);
    expect(kjor(['start', 'A']).kode).toBe(5);
    expect(lesKo().oppgaver[0].status).toBe('venter');
    const tving = kjor(['start', 'A', '--tving']);
    expect(tving.kode).toBe(0);
    expect(lesKo().oppgaver[0].status).toBe('kjorer');
  });

  it('grense avviser feil nattvindu og maksDPluss over maksSamtidig, uten å endre køen', () => {
    const vindu = kjor(['grense', 'nattvindu', '2306']);
    expect(vindu.kode).toBe(1);
    expect(vindu.feil).toContain('HH-HH');
    const dpluss = kjor(['grense', 'maksDPluss', '9']);
    expect(dpluss.kode).toBe(1);
    expect(dpluss.feil).toContain('kan ikke være større enn maksSamtidig (5)');
    expect(lesKo().grenser).toEqual({
      maksSamtidig: 5,
      maksDPluss: 2,
      maksPerDomene: 7,
      maksDb: 5,
    });
  });

  it('grense godtar maksDb over maksSamtidig (plukkede teller bare i maksDb)', () => {
    const r = kjor(['grense', 'maksDb', '6']);
    expect(r.kode).toBe(0);
    expect(lesKo().grenser?.maksDb).toBe(6);
  });
});
