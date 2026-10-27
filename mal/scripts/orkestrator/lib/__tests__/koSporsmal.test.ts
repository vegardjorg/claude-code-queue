// =============================================================
// koSporsmal.test.ts: eierspørsmål og avklaringer med tidsstempel i arbeidskøen.
//
// `sporsmal` er teksten bak id-ene i `venter_paa` (type, tekst, anbefaling, kilde), og `avklaringer` er svaret med
// tid og hvem. Begge er valgfrie: en gammel ko.json uten dem virker uendret, og id-en står fortsatt i `avklart` (den
// lista er det hindringene leser). Testene beviser reglene der de håndheves: de rene funksjonene i koLogikk.js, og
// ko.mjs mot en kopi av køen i en midlertidig mappe (KO_MAPPE), aldri den ekte.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Sporsmal = {
  type: string;
  tekst: string;
  anbefaling?: string;
  kilde?: string;
  lagt_til: string;
};
type Avklaring = { tid: string; svar: string | null; av: string | null; logget?: boolean };
type Oppgave = {
  id: string;
  tittel?: string;
  domene?: string;
  klasse?: 'K' | 'D' | 'D+' | 'U';
  status: string;
  oppdrag?: string;
  avhenger?: string[];
  venter_paa?: string[];
  eier_filer?: string[];
  eier_db?: string[];
  delt_patch?: string[];
  gren?: string;
  lagt_til?: string;
};
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  sporsmal?: Record<string, Sporsmal>;
  avklaringer?: Record<string, Avklaring>;
  grenser?: Record<string, unknown>;
  neste_migr?: number;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../koLogikk') as {
  SPORSMAL_TYPER: string[];
  settSporsmal: (ko: Ko, inn: unknown, naa?: string) => { satt: string[]; feil: string[] };
  avklar: (
    ko: Ko,
    ider: string[],
    valg?: { svar?: string | null; av?: string | null; naa?: string },
  ) => { avklart: string[]; feil: string[] };
  ulogget: (ko: Ko) => ({ sp: string } & Avklaring)[];
  merkLogget: (ko: Ko, ider: string[]) => { merket: string[]; feil: string[] };
  sporsmalOversikt: (ko: Ko) => {
    sp: string;
    type: string;
    tekst: string | null;
    avklart: boolean;
    svar: string | null;
    oppgaver: string[];
  }[];
  sporsmalUtenTekst: (oppgaver: Oppgave[], ko: Ko) => string[];
  svarBlokk: (o: Oppgave, ko: Ko) => string | null;
  hindringer: (o: Oppgave, oppgaver: Oppgave[], avklart?: string[]) => string[];
  velgNeste: (ko: Ko, naa?: number) => { id: string }[];
};

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T12:30:00.000Z';

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

describe('settSporsmal', () => {
  it('setter nye spørsmål med lagt_til; type er sporsmal når den ikke er gitt', () => {
    const ko: Ko = { oppgaver: [] };
    const r = L.settSporsmal(
      ko,
      {
        Ø8: { tekst: 'Hvilket regnskapssystem?', anbefaling: 'Svar når kjent.', kilde: 'plan § 2' },
        'BETINGET-X': { type: 'betingelse', tekst: 'Delta 58 er stabil.' },
      },
      T1,
    );
    expect(r).toEqual({ satt: ['Ø8', 'BETINGET-X'], feil: [] });
    expect(ko.sporsmal?.Ø8).toEqual({
      type: 'sporsmal',
      tekst: 'Hvilket regnskapssystem?',
      anbefaling: 'Svar når kjent.',
      kilde: 'plan § 2',
      lagt_til: T1,
    });
    expect(ko.sporsmal?.['BETINGET-X'].type).toBe('betingelse');
    expect(L.SPORSMAL_TYPER).toEqual(['sporsmal', 'betingelse', 'jurist', 'eier-oppgave']);
  });

  it('alt eller ingenting: ett ugyldig spørsmål, og ingenting endres', () => {
    const ko: Ko = { oppgaver: [] };
    const r = L.settSporsmal(ko, {
      A: { tekst: 'Gyldig' },
      B: { type: 'kanskje', tekst: 'Ugyldig type' },
      C: { tekst: '   ' },
      D: { tekst: 'x', ukjent: 1 },
      '-E': { tekst: 'id med bindestrek først' },
    });
    expect(r.satt).toEqual([]);
    expect(r.feil.join('\n')).toMatch(/B: type må være/);
    expect(r.feil.join('\n')).toMatch(/C: tekst mangler/);
    expect(r.feil.join('\n')).toMatch(/D: ukjente felt ukjent/);
    expect(r.feil.join('\n')).toMatch(/-E: ugyldig id/);
    expect(ko.sporsmal).toBeUndefined();
    expect(L.settSporsmal(ko, [{ tekst: 'liste' }]).feil[0]).toMatch(/må være et objekt/);
  });

  it('en oppdatering beholder feltene som ikke er med og lagt_til; null fjerner anbefalingen', () => {
    const ko: Ko = { oppgaver: [] };
    L.settSporsmal(ko, { A: { type: 'jurist', tekst: 'Første', anbefaling: 'Vent' } }, T1);
    L.settSporsmal(ko, { A: { tekst: 'Andre' } }, T2);
    expect(ko.sporsmal?.A).toEqual({
      type: 'jurist',
      tekst: 'Andre',
      anbefaling: 'Vent',
      lagt_til: T1,
    });
    L.settSporsmal(ko, { A: { anbefaling: null } }, T2);
    expect(ko.sporsmal?.A).toEqual({ type: 'jurist', tekst: 'Andre', lagt_til: T1 });
  });
});

describe('avklar: avklart som før, og avklaringer med tidsstempel', () => {
  it('med svar: id-en i avklart og i avklaringer med tid, svar, hvem og logget: false', () => {
    const ko: Ko = { oppgaver: [], avklart: ['GAMMEL'] };
    expect(L.avklar(ko, ['Ø8'], { svar: '  Tripletex  ', av: 'eier', naa: T1 })).toEqual({
      avklart: ['Ø8'],
      feil: [],
    });
    expect(ko.avklart).toEqual(['GAMMEL', 'Ø8']);
    expect(ko.avklaringer?.Ø8).toEqual({ tid: T1, svar: 'Tripletex', av: 'eier', logget: false });
  });

  it('uten svar (bakoverkompatibelt): tid, svar null; en tidligere avklaring beholdes uendret', () => {
    const ko: Ko = { oppgaver: [] };
    L.avklar(ko, ['A', 'B'], { naa: T1 });
    expect(ko.avklaringer?.A).toEqual({ tid: T1, svar: null, av: null });
    L.avklar(ko, ['C'], { svar: 'Ja', av: 'eier', naa: T1 });
    L.avklar(ko, ['C'], { naa: T2 });
    expect(ko.avklaringer?.C).toEqual({ tid: T1, svar: 'Ja', av: 'eier', logget: false });
  });

  it('et nytt svar erstatter det gamle og må føres i loggen på nytt', () => {
    const ko: Ko = { oppgaver: [] };
    L.avklar(ko, ['A'], { svar: 'Første', naa: T1 });
    L.merkLogget(ko, ['A']);
    L.avklar(ko, ['A'], { svar: 'Andre', av: 'eier', naa: T2 });
    expect(ko.avklaringer?.A).toEqual({ tid: T2, svar: 'Andre', av: 'eier', logget: false });
  });

  it('tomt svar (vaktregelen: tomt svar = stopp) avvises, og ingenting endres', () => {
    const ko: Ko = { oppgaver: [], avklart: [] };
    const r = L.avklar(ko, ['A'], { svar: '   ' });
    expect(r.avklart).toEqual([]);
    expect(r.feil[0]).toMatch(/svaret er tomt/);
    expect(ko.avklart).toEqual([]);
    expect(ko.avklaringer).toBeUndefined();
    expect(L.avklar(ko, []).feil[0]).toMatch(/minst én/);
  });
});

describe('ulogget og merkLogget', () => {
  it('ulogget = avklaringer med svar som ikke er ført; uten svar er det ingenting å føre', () => {
    const ko: Ko = { oppgaver: [] };
    L.avklar(ko, ['B'], { svar: 'Nei', naa: T2 });
    L.avklar(ko, ['A'], { svar: 'Ja', naa: T1 });
    L.avklar(ko, ['C'], { naa: T1 });
    expect(L.ulogget(ko).map((x) => x.sp)).toEqual(['A', 'B']);
    expect(L.merkLogget(ko, ['A'])).toEqual({ merket: ['A'], feil: [] });
    expect(L.ulogget(ko).map((x) => x.sp)).toEqual(['B']);
    expect(ko.avklaringer?.A.logget).toBe(true);
  });

  it('alt eller ingenting: ukjent id eller avklaring uten svar gir feil og merker ingenting', () => {
    const ko: Ko = { oppgaver: [] };
    L.avklar(ko, ['A'], { svar: 'Ja', naa: T1 });
    L.avklar(ko, ['C'], { naa: T1 });
    const r = L.merkLogget(ko, ['A', 'UKJENT', 'C']);
    expect(r.merket).toEqual([]);
    expect(r.feil.join('\n')).toMatch(/UKJENT er ikke avklart/);
    expect(r.feil.join('\n')).toMatch(/C har ikke noe svar/);
    expect(ko.avklaringer?.A.logget).toBe(false);
  });
});

describe('svarBlokk (sporfila tar med svaret)', () => {
  it('svaret for hver avklarte id i venter_paa, med spørsmålet og hvem og når', () => {
    const ko: Ko = { oppgaver: [] };
    L.settSporsmal(ko, {
      Ø8: { tekst: 'Hvilket regnskapssystem?' },
      'BETINGET-Delta': { type: 'betingelse', tekst: 'Delta 58 er stabil.' },
    });
    L.avklar(ko, ['Ø8'], { svar: 'Tripletex', av: 'eier', naa: T1 });
    L.avklar(ko, ['BETINGET-Delta'], { svar: 'Delta 58 er stabil fra 2.10', av: 'eier', naa: T2 });
    L.avklar(ko, ['R2'], { naa: T1 });
    const o = opp('X', { venter_paa: ['Ø8', 'BETINGET-Delta', 'R2', 'ÅPEN'] });
    const blokk = L.svarBlokk(o, ko) ?? '';
    expect(blokk).toContain('**Eierens svar på det oppgaven ventet på**');
    expect(blokk).toContain(
      '- Ø8 (sporsmal): «Hvilket regnskapssystem?» Svar: «Tripletex» (eier, 2026-10-01 10:00 UTC).',
    );
    expect(blokk).toContain('Oppfylt: «Delta 58 er stabil fra 2.10»');
    expect(blokk).toContain('- R2 Avklart 2026-10-01 10:00 UTC, men svaret står ikke i køen');
    expect(blokk).not.toContain('ÅPEN');
    expect(L.svarBlokk(opp('Y', { venter_paa: ['ÅPEN'] }), ko)).toBeNull();
  });
});

describe('sporsmalOversikt og sporsmalUtenTekst', () => {
  it('åpne først (flest ventende), så avklarte; spørsmål uten tekst er med', () => {
    const ko: Ko = {
      oppgaver: [
        opp('A', { venter_paa: ['S1', 'S2'] }),
        opp('B', { venter_paa: ['S2'] }),
        opp('C', { venter_paa: ['S3'], status: 'ferdig' }),
      ],
    };
    L.settSporsmal(ko, { S1: { tekst: 'En' }, S9: { tekst: 'Ingen venter' } });
    L.avklar(ko, ['S1'], { svar: 'Ja', naa: T1 });
    const r = L.sporsmalOversikt(ko);
    expect(r.map((x) => `${x.sp}:${x.oppgaver.length}:${x.avklart}`)).toEqual([
      'S2:2:false',
      'S9:0:false',
      'S1:1:true',
    ]);
    expect(r[0].tekst).toBeNull();
    expect(r[2].svar).toBe('Ja');
    expect(L.sporsmalUtenTekst(ko.oppgaver, ko)).toEqual(['S2', 'S3']);
  });
});

describe('gammel ko.json uten de nye feltene', () => {
  it('hindringer og velgNeste virker som før; avklart uten avklaringer låser opp', () => {
    const ko: Ko = {
      oppgaver: [opp('A', { venter_paa: ['S1'] }), opp('B', { venter_paa: ['S2'] })],
      avklart: ['S1'],
    };
    expect(L.hindringer(ko.oppgaver[0], ko.oppgaver, ko.avklart)).toEqual([]);
    expect(L.hindringer(ko.oppgaver[1], ko.oppgaver, ko.avklart)).toEqual(['venter på svar: S2']);
    expect(L.velgNeste(ko).map((v) => v.id)).toEqual(['A']);
    expect(L.ulogget(ko)).toEqual([]);
    expect(L.sporsmalOversikt(ko).map((x) => x.sp)).toEqual(['S2', 'S1']);
  });
});

// ---- ko.mjs mot en kopi av køen (aldri den ekte) ----
describe('ko.mjs: sporsmal, avklar --svar, avklaringer og add med { oppgaver, sporsmal }', () => {
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
    mappe = mkdtempSync(join(tmpdir(), 'ko-sporsmal-'));
    // En gammel ko.json: uten sporsmal og avklaringer.
    const ko: Ko = {
      oppgaver: [opp('A', { venter_paa: ['Ø8'] }), opp('B', { venter_paa: ['J2'] })],
      avklart: [],
      grenser: { maksSamtidig: 5, maksDPluss: 2, maksPerDomene: 7, maksDb: 6 },
      neste_migr: 100,
    };
    writeFileSync(join(mappe, 'ko.json'), JSON.stringify(ko));
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('sporsmal <id> --tekst … setter ett, og sporsmal lister (med dem som mangler tekst)', () => {
    const r = kjor([
      'sporsmal',
      'Ø8',
      '--tekst',
      'Hvilket regnskapssystem bruker pilotkunden?',
      '--type',
      'sporsmal',
      '--anbefaling',
      'Svar når kjent.',
      '--kilde',
      'plan § 2',
    ]);
    expect(r.kode).toBe(0);
    expect(r.ut).toContain('Spørsmål satt (1): Ø8');
    expect(lesKo().sporsmal?.Ø8).toMatchObject({
      type: 'sporsmal',
      tekst: 'Hvilket regnskapssystem bruker pilotkunden?',
      anbefaling: 'Svar når kjent.',
      kilde: 'plan § 2',
    });
    const liste = kjor(['sporsmal']);
    expect(liste.kode).toBe(0);
    expect(liste.ut).toContain('Ø8  [sporsmal; åpen, 1 oppgave venter]');
    expect(liste.ut).toContain('J2');
    expect(liste.ut).toContain('(mangler tekst');
    expect(kjor(['sporsmal', 'Ø8', '--type', 'kanskje']).kode).toBe(1);
    expect(kjor(['sporsmal', '--tekst', 'uten id']).kode).toBe(1);
  });

  it('sporsmal --fil: masseimport, alt eller ingenting', () => {
    const feil = kjor([
      'sporsmal',
      '--fil',
      skrivFil('feil.json', { Ø8: { tekst: 'Ok' }, J2: { type: 'ukjent', tekst: 'Nei' } }),
    ]);
    expect(feil.kode).toBe(1);
    expect(lesKo().sporsmal).toBeUndefined();
    const ok = kjor([
      'sporsmal',
      '--fil',
      skrivFil('ok.json', {
        Ø8: { type: 'sporsmal', tekst: 'Gammassystem?', kilde: 'k' },
        J2: { type: 'jurist', tekst: 'Offline-stempling?', anbefaling: 'Send brevet.' },
      }),
    ]);
    expect(ok.kode).toBe(0);
    expect(Object.keys(lesKo().sporsmal ?? {})).toEqual(['Ø8', 'J2']);
  });

  it('avklar <id> --svar … --av eier: avklart og avklaringer med tid; avklaringer --ulogget og --merk-logget', () => {
    const r = kjor(['avklar', 'Ø8', '--svar', 'Tripletex', '--av', 'eier']);
    expect(r.kode).toBe(0);
    const ko = lesKo();
    expect(ko.avklart).toEqual(['Ø8']);
    expect(ko.avklaringer?.Ø8).toMatchObject({ svar: 'Tripletex', av: 'eier', logget: false });
    expect(Date.parse(ko.avklaringer?.Ø8.tid ?? '')).toBeGreaterThan(0);

    const u = kjor(['avklaringer', '--ulogget']);
    expect(u.ut).toContain('Ø8');
    expect(u.ut).toContain('[IKKE LOGGET]');
    expect(u.ut).toContain('svar: Tripletex');
    expect(u.ut).toContain('--merk-logget Ø8');

    expect(kjor(['avklaringer', '--merk-logget', 'UKJENT']).kode).toBe(1);
    const m = kjor(['avklaringer', '--merk-logget', 'Ø8']);
    expect(m.kode).toBe(0);
    expect(lesKo().avklaringer?.Ø8.logget).toBe(true);
    expect(kjor(['avklaringer', '--ulogget']).ut).toContain('Ingen uloggede avklaringer.');
    expect(kjor(['avklaringer']).ut).toContain('[logget]');
  });

  it('avklar uten --svar virker som før (tidsstempel, svar null); --svar "" stopper og endrer ingenting', () => {
    expect(kjor(['avklar', 'J2']).kode).toBe(0);
    expect(lesKo().avklaringer?.J2).toMatchObject({ svar: null, av: null });
    const tom = kjor(['avklar', 'Ø8', '--svar', '']);
    expect(tom.kode).toBe(1);
    expect(tom.feil).toContain('svaret er tomt');
    expect(lesKo().avklart).toEqual(['J2']);
  });

  it('add med { oppgaver, sporsmal } legger inn begge i én skriving; en ren liste virker som før', () => {
    const r = kjor([
      'add',
      '--fil',
      skrivFil('ny.json', {
        oppgaver: [opp('C', { venter_paa: ['NY-1'] })],
        sporsmal: { 'NY-1': { type: 'betingelse', tekst: 'Når piloten er i gang.' } },
      }),
    ]);
    expect(r.kode).toBe(0);
    expect(r.ut).toContain('Lagt til: C');
    expect(r.ut).toContain('Spørsmålstekst satt: NY-1');
    expect(lesKo().sporsmal?.['NY-1'].type).toBe('betingelse');
    // En venter_paa-id uten tekst avvises (ikke bare advarsel); se koSvar.test.ts.

    const liste = kjor(['add', '--fil', skrivFil('liste.json', [opp('D')])]);
    expect(liste.kode).toBe(0);
    expect(liste.ut).toContain('Lagt til: D');
    const ett = kjor(['add', '--json', JSON.stringify(opp('E'))]);
    expect(ett.kode).toBe(0);
    expect(lesKo().oppgaver.map((o) => o.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('add er alt eller ingenting: et ugyldig spørsmål stopper oppgavene også', () => {
    const r = kjor([
      'add',
      '--fil',
      skrivFil('feil.json', {
        oppgaver: [opp('C')],
        sporsmal: { 'NY-1': { type: 'ukjent', tekst: 'x' } },
      }),
    ]);
    expect(r.kode).toBe(1);
    expect(r.feil).toContain('sporsmal NY-1: type må være');
    expect(lesKo().oppgaver.map((o) => o.id)).toEqual(['A', 'B']);
  });

  it('sporfil tar med eierens svar på det oppgaven ventet på', () => {
    kjor(['sporsmal', 'Ø8', '--tekst', 'Hvilket regnskapssystem?']);
    kjor(['avklar', 'Ø8', '--svar', 'Tripletex', '--av', 'eier']);
    expect(kjor(['start', 'A'])).toMatchObject({ kode: 0 });
    const ut = join(mappe, 'spor.md');
    expect(kjor(['sporfil', 'A', '--ut', ut]).kode).toBe(0);
    const tekst = readFileSync(ut, 'utf8');
    expect(tekst).toContain('**Eierens svar på det oppgaven ventet på**');
    expect(tekst).toContain('- Ø8 (sporsmal): «Hvilket regnskapssystem?» Svar: «Tripletex» (eier, ');
  });
});
