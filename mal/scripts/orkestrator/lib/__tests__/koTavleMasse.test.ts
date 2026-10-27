// =============================================================
// koTavleMasse.test.ts: kø-tavla: flervalg og massehandlinger (lib/koTavle.js: massePlan,
// masseOppsummering, pakkForhandsvisning, vurder med type 'masse', tavle: endret/angre/parkert), samlekøen i
// avhengighetsgrafen (lib/koGraf.js), og de nye flaggene i ko.mjs (ranger --json, angre --nr, samle pakk
// --forvent-endret) mot en kopi i en midlertidig mappe (aldri den ekte køen).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Oppgave = {
  id: string;
  tittel?: string;
  domene: string;
  klasse: 'K' | 'D' | 'D+' | 'U';
  status: string;
  oppdrag?: string;
  nytte?: number;
  innhold_min?: number;
  avhenger?: string[];
  venter_paa?: string[];
  eier_filer?: string[];
  etiketter?: string[];
  prosjekt?: string;
  funksjon?: string;
  samles?: boolean;
  parkert?: { av: string; at: string; grunn?: string; til?: string };
  prioritet_tillegg?: number;
};
type Prosjekt = { tittel: string; prefikser?: string[]; pause?: boolean };
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  prosjekter?: Record<string, Prosjekt>;
  fokus?: Record<string, unknown>;
  endringslogg?: { nr: number; handling: string; av: string; at: string; endringer: unknown[] }[];
  endret?: string;
  neste_migr?: number;
};
type Kalender = { nivaa: 'info' | 'advarsel' | 'stopp'; tekst: string };
type Plan = {
  feil: string[];
  kommando?: string;
  innhold?: { oppgaver: Record<string, unknown>[] };
  plass?: Record<string, unknown>;
  nyId?: string;
  tittel?: string | null;
};
type Kort = { id: string; parkert: { grunn: string | null; til: string | null } | null };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../koTavle') as {
  MASSE_MAKS: number;
  MASSE_BEKREFT: number;
  MASSE_HANDLINGER: string[];
  massePlan: (ko: Ko, handling: string, ider: string[], verdi?: Record<string, unknown>) => Plan;
  masseOppsummering: (
    ko: Ko,
    handling: string,
    ider: string[],
    verdi: Record<string, unknown>,
    endringer: { id?: string; felt: string; for: unknown; etter: unknown }[],
  ) => string;
  pakkForhandsvisning: (
    ko: Ko,
    ider: string[],
    v: { nyId: string; tittel?: string | null },
  ) => {
    feil: string[];
    ny?: { id: string; klasse: string; innhold_min: number; prosjekt: string; status: string };
    kansellert?: string[];
    omdirigert?: string[];
  };
  vurder: (ko: Ko, handling: Record<string, unknown>, kontekst?: { naa?: number }) => Kalender[];
  tavle: (
    ko: Ko,
    valg?: { naa?: number },
  ) => {
    endret: string | null;
    angre: { nr: number; handling: string; felt: number; oppgaver: number } | null;
    kolonner: Record<string, Kort[]>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const G = require('../koGraf') as {
  byggGraf: (
    data: unknown,
    valg?: { visFrittstaende?: boolean },
  ) => { noder: { id: string; tilstand: string }[] };
};

const NAA = Date.parse('2026-10-07T12:00:00Z');
const ISO = '2026-10-07T12:00:00.000Z';
const o = (id: string, ekstra: Partial<Oppgave> = {}): Oppgave => ({
  id,
  domene: id.toLowerCase(),
  klasse: 'K',
  status: 'venter',
  oppdrag: `Oppdraget til ${id}.`,
  tittel: id,
  nytte: 5,
  innhold_min: 30,
  ...ekstra,
});
const grunnKo = (): Ko => ({
  oppgaver: [
    o('SB-1'),
    o('SB-2', { avhenger: ['SB-1'] }),
    o('SB-3', { status: 'kjorer' }),
    o('SB-4', { etiketter: ['visuell'] }),
    o('V-1', { samles: true, innhold_min: 50, funksjon: 'Bemanning' }),
    o('V-2', { samles: true, innhold_min: 50, funksjon: 'Bemanning' }),
    o('V-3', { parkert: { av: 'eier', at: '2026-10-06T10:00:00.000Z', grunn: 'vent' } }),
  ],
  prosjekter: {
    varer: { tittel: 'Varer', prefikser: ['SB-'] },
    ui: { tittel: 'Kalender', prefikser: ['V-'] },
    pauset: { tittel: 'Pauset', prefikser: ['P-'], pause: true },
  },
  avklart: [],
});

describe('massePlan: handling → ko.mjs-kommando', () => {
  it('prosjekt, funksjon og samlekø blir endre-mange med én rad per id', () => {
    const ko = grunnKo();
    expect(T.massePlan(ko, 'prosjekt', ['SB-1', 'SB-4'], { pid: 'ui' })).toEqual({
      feil: [],
      kommando: 'endre-mange',
      innhold: {
        oppgaver: [
          { id: 'SB-1', prosjekt: 'ui' },
          { id: 'SB-4', prosjekt: 'ui' },
        ],
      },
    });
    expect(T.massePlan(ko, 'prosjekt', ['SB-1'], { pid: null }).innhold).toEqual({
      oppgaver: [{ id: 'SB-1', prosjekt: null }],
    });
    expect(T.massePlan(ko, 'funksjon', ['SB-1'], { navn: '  Datablad ' }).innhold).toEqual({
      oppgaver: [{ id: 'SB-1', funksjon: 'Datablad' }],
    });
    expect(T.massePlan(ko, 'samle-inn', ['SB-4']).innhold).toEqual({
      oppgaver: [{ id: 'SB-4', samles: true }],
    });
    expect(T.massePlan(ko, 'samle-ut', ['V-1']).innhold).toEqual({
      oppgaver: [{ id: 'V-1', samles: false }],
    });
  });

  it('parker: true uten grunn og dato, ellers { grunn, til }; dato må være ÅÅÅÅ-MM-DD', () => {
    const ko = grunnKo();
    expect(T.massePlan(ko, 'parker', ['SB-1']).innhold).toEqual({
      oppgaver: [{ id: 'SB-1', parkert: true }],
    });
    expect(
      T.massePlan(ko, 'parker', ['SB-1'], { grunn: 'venter', til: '2026-10-20' }).innhold,
    ).toEqual({ oppgaver: [{ id: 'SB-1', parkert: { grunn: 'venter', til: '2026-10-20' } }] });
    expect(T.massePlan(ko, 'parker', ['SB-1'], { til: '20.10.2026' }).feil[0]).toMatch(
      /ÅÅÅÅ-MM-DD/,
    );
  });

  it('fortsett tar bare de parkerte, og nekter når ingen er parkert', () => {
    const ko = grunnKo();
    expect(T.massePlan(ko, 'fortsett', ['SB-1', 'V-3']).innhold).toEqual({
      oppgaver: [{ id: 'V-3', parkert: null }],
    });
    expect(T.massePlan(ko, 'fortsett', ['SB-1']).feil[0]).toMatch(/ingen av de merkede/);
  });

  it('etikett legges til eller fjernes bare der det endrer noe; tom liste fjerner feltet', () => {
    const ko = grunnKo();
    expect(
      T.massePlan(ko, 'etikett-legg', ['SB-1', 'SB-4'], { etikett: 'Visuell' }).innhold,
    ).toEqual({ oppgaver: [{ id: 'SB-1', etiketter: ['visuell'] }] });
    expect(
      T.massePlan(ko, 'etikett-fjern', ['SB-1', 'SB-4'], { etikett: 'visuell' }).innhold,
    ).toEqual({ oppgaver: [{ id: 'SB-4', etiketter: null }] });
    expect(T.massePlan(ko, 'etikett-fjern', ['SB-1'], { etikett: 'visuell' }).feil[0]).toMatch(
      /ingen av de merkede har etiketten/,
    );
    expect(T.massePlan(ko, 'etikett-legg', ['SB-1'], { etikett: 'to ord' }).feil[0]).toMatch(
      /ett kort ord/,
    );
  });

  it('ranger: topp/bunn, eller over/under med en gyldig id', () => {
    const ko = grunnKo();
    expect(T.massePlan(ko, 'ranger', ['SB-1'], { plass: 'topp' })).toEqual({
      feil: [],
      kommando: 'ranger',
      plass: { topp: true },
    });
    expect(T.massePlan(ko, 'ranger', ['SB-1'], { plass: 'under', ref: 'SB-4' }).plass).toEqual({
      under: 'SB-4',
    });
    expect(T.massePlan(ko, 'ranger', ['SB-1'], { plass: 'over', ref: '-x' }).feil.length).toBe(1);
    expect(T.massePlan(ko, 'ranger', ['SB-1'], { plass: 'midt' }).feil.length).toBe(1);
  });

  it('samle-pakk foreslår en ledig id fra prosjektets prefiks når den mangler', () => {
    const ko = grunnKo();
    expect(T.massePlan(ko, 'samle-pakk', ['V-1', 'V-2'])).toMatchObject({
      feil: [],
      kommando: 'samle-pakk',
      nyId: 'V-S1',
      tittel: null,
    });
    expect(
      T.massePlan(ko, 'samle-pakk', ['V-1', 'V-2'], { ny_id: 'V-PAKKE', tittel: 'Pakke' }),
    ).toMatchObject({ nyId: 'V-PAKKE', tittel: 'Pakke' });
  });

  it('nekter ukjent handling, tom liste, ugyldige id-er, duplikater og over taket', () => {
    const ko = grunnKo();
    expect(T.massePlan(ko, 'slett', ['SB-1']).feil[0]).toMatch(/ukjent massehandling/);
    expect(T.massePlan(ko, 'parker', []).feil).toContain('ingen oppgaver er merket');
    expect(T.massePlan(ko, 'parker', ['a b']).feil).toContain('ugyldig id i lista');
    expect(T.massePlan(ko, 'parker', ['SB-1', 'SB-1']).feil).toContain(
      'samme id står flere ganger',
    );
    const mange = Array.from({ length: T.MASSE_MAKS + 1 }, (_, i) => `X-${i}`);
    expect(T.massePlan(ko, 'parker', mange).feil[0]).toMatch(/høyst 500/);
  });
});

describe('masseOppsummering: forklaringen i forhåndsvisningen', () => {
  const ko = grunnKo();
  it('flytting forteller hvor mange som flyttes, fra hvilke prosjekter, og hvor mange som er der', () => {
    const tekst = T.masseOppsummering(ko, 'prosjekt', ['SB-1', 'SB-4', 'V-1'], { pid: 'ui' }, [
      { id: 'SB-1', felt: 'prosjekt', for: null, etter: 'ui' },
      { id: 'SB-4', felt: 'prosjekt', for: null, etter: 'ui' },
    ]);
    expect(tekst).toBe(
      '3 oppgaver: 2 flyttes til prosjektet ui (2 fra varer). 1 er allerede slik.',
    );
  });
  it('vent, samlekø, blokk og pakking forklarer hva det betyr', () => {
    const e = [{ id: 'SB-1', felt: 'parkert', for: null, etter: {} }];
    expect(T.masseOppsummering(ko, 'parker', ['SB-1'], { til: '2026-10-20' }, e)).toMatch(
      /settes på vent til og med 2026-10-20\. De står i køen, men startes og plukkes ikke\./,
    );
    expect(T.masseOppsummering(ko, 'samle-inn', ['SB-1'], {}, e)).toMatch(/pakkes sammen/);
    expect(T.masseOppsummering(ko, 'ranger', ['SB-1'], { plass: 'over', ref: 'SB-4' }, e)).toMatch(
      /flyttes samlet rett over SB-4 og beholder rekkefølgen/,
    );
    expect(T.masseOppsummering(ko, 'samle-pakk', ['V-1', 'V-2'], {}, [])).toMatch(
      /kan ikke angres/,
    );
  });
  it('ingen em-dasher i tekstene', () => {
    for (const h of T.MASSE_HANDLINGER)
      expect(T.masseOppsummering(ko, h, ['SB-1'], { pid: 'ui', etikett: 'x' }, [])).not.toMatch(
        /—/,
      );
  });
});

describe('pakkForhandsvisning: «Pakk til spor» på en kopi', () => {
  it('viser det nye sporet og delene som kanselleres, uten å endre køen', () => {
    const ko = grunnKo();
    const for_ = JSON.stringify(ko);
    const p = T.pakkForhandsvisning(ko, ['V-1', 'V-2'], { nyId: 'V-S1', tittel: 'Samlet' });
    expect(p.feil).toEqual([]);
    expect(p.ny).toMatchObject({ id: 'V-S1', klasse: 'K', innhold_min: 100, prosjekt: 'ui' });
    expect(p.kansellert).toEqual(['V-1', 'V-2']);
    expect(JSON.stringify(ko)).toBe(for_);
  });
  it('samme regler som ko.mjs samle pakk (minst to, ledig id)', () => {
    const ko = grunnKo();
    expect(T.pakkForhandsvisning(ko, ['V-1'], { nyId: 'V-S1' }).feil.join(' ')).toMatch(/minst to/);
    expect(T.pakkForhandsvisning(ko, ['V-1', 'V-2'], { nyId: 'SB-1' }).feil.join(' ')).toMatch(
      /finnes fra før/,
    );
  });
});

describe('vurder: massehandlinger (vaktregel 16)', () => {
  const v = (ko: Ko, handling: string, ider: string[], verdi: Record<string, unknown> = {}) =>
    T.vurder(ko, { type: 'masse', handling, ider, verdi }, { naa: NAA });
  const niv = (liste: Kalender[], n: string) => liste.filter((x) => x.nivaa === n).map((x) => x.tekst);

  it('stopp: kjørende oppgaver og ukjente id-er kan ikke masseendres', () => {
    const ko = grunnKo();
    expect(niv(v(ko, 'parker', ['SB-1', 'SB-3']), 'stopp')[0]).toMatch(
      /Bare oppgaver som venter eller er forslag.*SB-3 \(kjorer\)/,
    );
    expect(niv(v(ko, 'parker', ['NEI-1']), 'stopp')[0]).toMatch(/Finnes ikke i køen: NEI-1/);
  });

  it('advarsel: mange på én gang, og flytting til et pauset prosjekt', () => {
    const ko = grunnKo();
    for (let i = 0; i < T.MASSE_BEKREFT + 1; i++) ko.oppgaver.push(o(`M-${i}`));
    const ider = ko.oppgaver.filter((x) => x.id.startsWith('M-')).map((x) => x.id);
    expect(niv(v(ko, 'etikett-legg', ider, { etikett: 'x' }), 'advarsel')[0]).toMatch(
      /Du endrer 51 oppgaver/,
    );
    expect(niv(v(grunnKo(), 'prosjekt', ['SB-1'], { pid: 'pauset' }), 'advarsel')[0]).toMatch(
      /står på pause/,
    );
    expect(niv(v(grunnKo(), 'prosjekt', ['SB-1'], { pid: 'finnes-ikke' }), 'stopp')[0]).toMatch(
      /finnes ikke/,
    );
  });

  it('parkering av en avhengighet: advarsel når noe i fokus venter på den, ellers info', () => {
    const ko = grunnKo();
    expect(niv(v(ko, 'parker', ['SB-1']), 'info')[0]).toMatch(/Andre oppgaver venter på SB-1/);
    expect(niv(v(ko, 'parker', ['SB-1']), 'advarsel')).toEqual([]);
    // Parkeres avhengigheten sammen med den som venter, varsles ingenting.
    expect(v(ko, 'parker', ['SB-1', 'SB-2'])).toEqual([]);
    const medFokus: Ko = {
      ...grunnKo(),
      fokus: { rekkefolge: ['prosjekt:varer'], resten: 'vent', fra: '2026-10-01T00:00:00Z' },
    };
    expect(niv(v(medFokus, 'parker', ['SB-1']), 'advarsel')[0]).toMatch(
      /Noe i fokus venter på SB-1 \(SB-2 venter på den\)/,
    );
  });

  it('stopp: samlekø-reglene (koLogikk.samlesFeil) mot køen slik den blir', () => {
    const ko = grunnKo();
    // SB-1 blokkerer SB-2, så den hører ikke i samlekøen.
    expect(niv(v(ko, 'samle-inn', ['SB-1']), 'stopp')[0]).toMatch(/SB-2 avhenger av SB-1/);
    ko.oppgaver.push(o('D-1', { klasse: 'D+' }));
    expect(niv(v(ko, 'samle-inn', ['D-1']), 'stopp')[0]).toMatch(/D\+ slås aldri sammen/);
    expect(v(grunnKo(), 'samle-inn', ['SB-4'])).toEqual([]);
  });

  it('samle-ut og samle-pakk: stopp når ingen ligger i samlekøen, eller pakkingen ikke går', () => {
    const ko = grunnKo();
    expect(niv(v(ko, 'samle-ut', ['SB-1']), 'stopp')[0]).toMatch(/Ingen av de merkede/);
    expect(niv(v(ko, 'samle-ut', ['SB-1', 'V-1']), 'info')[0]).toMatch(
      /Ligger ikke i samlekøen: SB-1/,
    );
    expect(v(ko, 'samle-pakk', ['V-1', 'V-2'])).toEqual([]);
    expect(niv(v(ko, 'samle-pakk', ['V-1']), 'stopp')[0]).toMatch(/Kan ikke pakkes/);
  });
});

describe('tavle: versjonen, «Angre siste» og «på vent» på kortet', () => {
  it('endret og angre kommer med i tilstanden; parkert vises på kortet', () => {
    const ko: Ko = {
      ...grunnKo(),
      endret: ISO,
      endringslogg: [
        {
          nr: 3,
          handling: 'endre-mange',
          av: 'tavla',
          at: ISO,
          endringer: [
            { id: 'SB-1', felt: 'prosjekt', for: null, etter: 'ui' },
            { id: 'SB-4', felt: 'prosjekt', for: null, etter: 'ui' },
          ],
        },
      ],
    };
    const t = T.tavle(ko, { naa: NAA });
    expect(t.endret).toBe(ISO);
    expect(t.angre).toMatchObject({ nr: 3, handling: 'endre-mange', felt: 2, oppgaver: 2 });
    const v3 = t.kolonner.ko.find((k) => k.id === 'V-3');
    expect(v3?.parkert).toMatchObject({ grunn: 'vent', til: null });
    expect(t.kolonner.ko.find((k) => k.id === 'SB-1')?.parkert).toBeNull();
    expect(T.tavle(grunnKo(), { naa: NAA }).angre).toBeNull();
  });
});

describe('koGraf: samlekøen er med i avhengighetsgrafen med egen tilstand', () => {
  it('en samlekø-oppgave i en kjede får tilstanden «samle»', () => {
    const ko = grunnKo();
    ko.oppgaver.push(o('V-4', { avhenger: ['V-9'] }), o('V-9', { status: 'kjorer' }));
    // V-1 i samlekøen avhenger av noe som kjører.
    ko.oppgaver.find((x) => x.id === 'V-1')!.avhenger = ['V-9'];
    const g = G.byggGraf(T.tavle(ko, { naa: NAA }));
    expect(g.noder.find((n) => n.id === 'V-1')?.tilstand).toBe('samle');
    expect(g.noder.find((n) => n.id === 'V-4')?.tilstand).toBe('blokkert');
  });
});

describe('ko.mjs: ranger --json, angre --nr og samle pakk --forvent-endret (mot en kopi)', () => {
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
      return { kode: x.status, ut: x.stdout ?? '', feil: x.stderr ?? '' };
    }
  }
  const lesKo = (): Ko => JSON.parse(readFileSync(join(mappe, 'ko.json'), 'utf8')) as Ko;

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-tavle5a-'));
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({ ...grunnKo(), endret: ISO, neste_migr: 1000 }, null, 2),
    );
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('ranger --torr --json skriver ingenting; ranger --json svarer med loggposten', () => {
    const for_ = readFileSync(join(mappe, 'ko.json'), 'utf8');
    const t = kjor(['ranger', 'SB-4', '--topp', '--torr', '--json']);
    expect(t.kode).toBe(0);
    const torr = JSON.parse(t.ut) as {
      ok: boolean;
      torr: boolean;
      endret: string;
      endringer: unknown[];
    };
    expect(torr).toMatchObject({ ok: true, torr: true, endret: ISO });
    expect(torr.endringer.length).toBe(1);
    expect(readFileSync(join(mappe, 'ko.json'), 'utf8')).toBe(for_);
    const r = kjor(['ranger', 'SB-4', '--topp', '--json', '--av', 'tavla']);
    expect(r.kode).toBe(0);
    expect(JSON.parse(r.ut)).toMatchObject({ ok: true, endret: ['SB-4'], logg: 1 });
    const feil = kjor(['ranger', 'SB-3', '--topp', '--json']);
    expect(feil.kode).toBe(1);
    expect((JSON.parse(feil.ut) as { feil: string[] }).feil[0]).toMatch(/bare venter og forslag/);
  });

  it('angre --nr angrer bare den posten tavla viste', () => {
    expect(kjor(['ranger', 'SB-4', '--topp', '--av', 'tavla']).kode).toBe(0);
    expect(kjor(['ranger', 'SB-1', '--topp', '--av', 'orkestrator']).kode).toBe(0);
    const nei = kjor(['angre', '--nr', '1', '--json']);
    expect(nei.kode).toBe(1);
    expect((JSON.parse(nei.ut) as { feil: string[] }).feil[0]).toMatch(
      /siste endringen som kan angres er nr\. 2.*ikke nr\. 1/,
    );
    expect(kjor(['angre', '--vis', '--nr', '1', '--json']).ut).toMatch(/"ok":false/);
    const ja = kjor(['angre', '--nr', '2', '--json']);
    expect(ja.kode).toBe(0);
    expect(lesKo().oppgaver.find((x) => x.id === 'SB-1')?.prioritet_tillegg).toBeUndefined();
  });

  it('samle pakk --forvent-endret nekter (exit 6) når køen er endret etter forhåndsvisningen', () => {
    const r = kjor([
      'samle',
      'pakk',
      'V-1',
      'V-2',
      '--id',
      'V-S1',
      '--forvent-endret',
      '2026-10-01T00:00:00.000Z',
    ]);
    expect(r.kode).toBe(6);
    expect(existsSync(join(mappe, 'oppdrag', 'V-S1.md'))).toBe(false);
    const ok = kjor(['samle', 'pakk', 'V-1', 'V-2', '--id', 'V-S1', '--forvent-endret', ISO]);
    expect(ok.kode).toBe(0);
    expect(lesKo().oppgaver.find((x) => x.id === 'V-S1')).toBeTruthy();
  });
});
