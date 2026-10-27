// =============================================================
// kostVakt.test.ts: kostvakten.
//
// Regelen håndheves i lib/kostVakt.js og kjøres av hook-kontekst.mjs i den aktive orkestratorøkta. Testene
// beviser terskellogikken som rene funksjoner, og hooken ende til ende som prosess mot en midlertidig kø
// (KO_MAPPE, KO_TIDSLOGG, KO_TRANSKRIPTER), aldri den ekte.
//   - Varsel når et spor passerer FAKTOR (3) x snittkosten for klassen (ferdige siste 7 dager, minst 3), én gang per spor.
//   - Klassen fra oppdragsfila, ellers køens klasse.
//   - Ingen automatisk stopp: utdata er aldri decision: block.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Varsel = { id: string; klasse: string; usd: number; snitt: number; grense: number; n: number };
type Kandidat = { agent: string; type: string; sikker: boolean; rad: { tid: string } | null };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../kostVakt') as {
  FAKTOR: number;
  MIN_N: number;
  INTERVALL_MS: number;
  klasseFraOppdrag: (t: string | null) => string | null;
  snittPerKlasse: (s: unknown) => Record<string, { snitt: number; n: number }>;
  liveAgenter: (rader: unknown[], id: string, o?: { fra?: string | null }) => Kandidat[];
  skalMaale: (t: unknown, naa: number, intervall?: number) => boolean;
  vurder: (a: {
    maalinger: { id: string; klasse: string | null; usd: number }[];
    snitt: Record<string, { snitt: number; n: number }>;
    varslet?: Record<string, { usd: number; tid: string }>;
    faktor?: number;
    minN?: number;
    naa?: number;
  }) => { varsler: Varsel[]; varslet: Record<string, { usd: number; tid: string }> };
  sporBeskjed: (v: Varsel) => string;
  hookTekst: (v: Varsel[]) => { systemMessage: string; additionalContext: string } | null;
};

const NAA = Date.parse('2026-10-07T12:00:00Z');
const SNITT = { K: { snitt: 10, n: 4 }, D: { snitt: 5, n: 2 } };

describe('klasseFraOppdrag', () => {
  it('leser tabellraden i oppdragsfila', () => {
    expect(
      K.klasseFraOppdrag('# X\n\n| | |\n|---|---|\n| Klasse | K (vekt 1,0), anslag ca. 30 min |\n'),
    ).toBe('K');
    expect(K.klasseFraOppdrag('| Klasse | D+ (vekt 2,0) |')).toBe('D+');
  });
  it('faller tilbake til «klasse X» i tittelen, og gir null uten treff', () => {
    expect(K.klasseFraOppdrag('## SPOR A (Noe; kilde: x; klasse D, anslag 40 min)')).toBe('D');
    expect(K.klasseFraOppdrag('ingen klasse her')).toBeNull();
    expect(K.klasseFraOppdrag(null)).toBeNull();
  });
});

describe('snittPerKlasse', () => {
  it('er sum / n per klasse fra kostStatistikk', () => {
    expect(
      K.snittPerKlasse({
        perKlasse: [
          { klasse: 'K', n: 3, usd: 31 },
          { klasse: 'D', n: 0, usd: 0 },
        ],
      }),
    ).toEqual({ K: { snitt: 10.33, n: 3 } });
  });
});

describe('vurder (terskelen)', () => {
  it('varsler over 3x snittet (FAKTOR), ikke på eller under', () => {
    const r = K.vurder({
      maalinger: [
        { id: 'A', klasse: 'K', usd: 30.01 },
        { id: 'B', klasse: 'K', usd: 30 },
        { id: 'C', klasse: 'K', usd: 3 },
      ],
      snitt: SNITT,
      naa: NAA,
    });
    expect(r.varsler).toEqual([{ id: 'A', klasse: 'K', usd: 30.01, snitt: 10, grense: 30, n: 4 }]);
    expect(Object.keys(r.varslet)).toEqual(['A']);
  });

  it('varsler ikke når klassen har for få ferdige oppgaver eller ukjent klasse', () => {
    const r = K.vurder({
      maalinger: [
        { id: 'D1', klasse: 'D', usd: 100 },
        { id: 'U1', klasse: 'U', usd: 100 },
        { id: 'X', klasse: null, usd: 100 },
      ],
      snitt: SNITT,
    });
    expect(r.varsler).toEqual([]);
  });

  it('varsler hvert spor én gang, og glemmer spor som ikke lenger kjører', () => {
    const forste = K.vurder({
      maalinger: [{ id: 'A', klasse: 'K', usd: 35 }],
      snitt: SNITT,
      naa: NAA,
    });
    const andre = K.vurder({
      maalinger: [{ id: 'A', klasse: 'K', usd: 40 }],
      snitt: SNITT,
      varslet: forste.varslet,
    });
    expect(andre.varsler).toEqual([]);
    const ferdig = K.vurder({ maalinger: [], snitt: SNITT, varslet: andre.varslet });
    expect(ferdig.varslet).toEqual({});
  });

  it('hookteksten varsler orkestratoren og har en beskjed til sporet, aldri block', () => {
    const v = K.vurder({ maalinger: [{ id: 'A', klasse: 'K', usd: 45 }], snitt: SNITT }).varsler;
    const t = K.hookTekst(v);
    expect(t?.systemMessage).toMatch(/Kostvakt: A \(K\) \$45 > 3x snitt \$10/);
    expect(t?.additionalContext).toMatch(/SendMessage/);
    expect(K.sporBeskjed(v[0])).toMatch(/DELVIS/);
    expect(t).not.toHaveProperty('decision');
    expect(K.hookTekst([])).toBeNull();
  });
});

describe('skalMaale', () => {
  it('måler første gang og når intervallet er gått', () => {
    expect(K.skalMaale({}, NAA)).toBe(true);
    const t = { sist_maalt: new Date(NAA - 60_000).toISOString() };
    expect(K.skalMaale(t, NAA)).toBe(false);
    expect(K.skalMaale(t, NAA + K.INTERVALL_MS)).toBe(true);
    expect(K.skalMaale(t, NAA, 0)).toBe(true);
  });
});

describe('liveAgenter', () => {
  const rader = [
    {
      tid: '2026-10-07T10:00:00Z',
      spor: 'a1b2c3',
      hendelse: 'start',
      agent_id: 'a1b2c3d4',
      agent_type: 'spor',
    },
    {
      tid: '2026-10-07T10:30:00Z',
      spor: 'A',
      hendelse: 'ferdig',
      agent_id: 'a1b2c3d4',
      tokens: { output: 1 },
    },
    {
      tid: '2026-10-07T10:40:00Z',
      spor: 'e5f6',
      hendelse: 'start',
      agent_id: 'e5f6g7',
      agent_type: 'spor',
    },
    {
      tid: '2026-10-07T10:41:00Z',
      spor: 'B',
      hendelse: 'ferdig',
      agent_id: 'b9',
      tokens: { output: 1 },
    },
    {
      tid: '2026-10-07T10:42:00Z',
      spor: 'g',
      hendelse: 'start',
      agent_id: 'gx',
      agent_type: 'general-purpose',
    },
    {
      tid: '2026-09-01T10:00:00Z',
      spor: 'old',
      hendelse: 'start',
      agent_id: 'old1',
      agent_type: 'spor',
    },
    {
      tid: '2026-10-07T11:00:00Z',
      spor: 'A-r2',
      hendelse: 'ferdig',
      agent_id: 'r2',
      tokens: { output: 1 },
    },
  ];
  it('tar med sikre (etikett, også retterunde) og løpende spor-kandidater etter start', () => {
    const r = K.liveAgenter(rader, 'A', { fra: '2026-10-07T09:00:00Z' });
    const kort = r.map((x) => [x.agent, x.sikker]);
    expect(kort).toEqual([
      ['a1b2c3d4', true],
      ['e5f6g7', false],
      ['r2', true],
    ]);
    expect(r[0].rad?.tid).toBe('2026-10-07T10:30:00Z');
  });
});

// ---- Prosess: hooken mot en midlertidig kø (aldri den ekte) ----
describe('hook-kontekst.mjs: kostvakten ende til ende', () => {
  const ORK = join(__dirname, '..', '..');
  let mappe: string;

  const env = () => ({
    ...process.env,
    KO_MAPPE: mappe,
    KO_GIT: mappe,
    KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
    KO_TRANSKRIPTER: join(mappe, 'transkripter'),
    KOSTVAKT_INTERVALL_MIN: '0',
    KOSTVAKT_AV: '',
    KONTEKST_VARSEL: '',
    KONTEKST_STOPP: '',
    KONTEKST_AVVIKLING: '',
    KONTEKST_STOPP_ORK: '',
  });
  function kjor(fil: string, args: string[], input?: string) {
    try {
      return execFileSync(process.execPath, [join(ORK, fil), ...args], {
        env: env(),
        encoding: 'utf8',
        input,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return String((e as { stdout?: string }).stdout ?? '');
    }
  }
  /** Orkestratorens transkript: et orkestratorkall nå og liten kontekst (under alle kontekstgrenser). */
  function transkript() {
    const naa = new Date().toISOString();
    const sti = join(mappe, 'ork.jsonl');
    writeFileSync(
      sti,
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: naa,
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'node scripts/orkestrator/ko.mjs orkestrator puls' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: naa,
          message: {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, cache_read_input_tokens: 999 },
          },
        }),
      ].join('\n') + '\n',
    );
    return sti;
  }
  const hook = (sessionId: string) => {
    const ut = kjor(
      'hook-kontekst.mjs',
      [],
      JSON.stringify({ session_id: sessionId, transcript_path: transkript(), prompt: 'hei' }),
    );
    return ut ? JSON.parse(ut) : null;
  };

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-kostvakt-'));
    mkdirSync(join(mappe, 'transkripter'));
    const oppdrag = join(mappe, 'X.md');
    writeFileSync(oppdrag, '# X\n\n| | |\n|---|---|\n| Klasse | K (vekt 1,0) |\n');
    const ferdig = new Date(Date.now() - 86_400_000).toISOString();
    const ferdigK = (id: string) => ({
      id,
      tittel: id,
      domene: 'klient',
      klasse: 'K',
      status: 'ferdig',
      ferdig,
      oppdrag: 'x',
      kost: { usd: 10, tokens: { sum: 1 }, agenter: [], maalt: ferdig },
    });
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({
        oppgaver: [
          ferdigK('F1'),
          ferdigK('F2'),
          ferdigK('F3'),
          {
            id: 'X',
            tittel: 'X',
            domene: 'klient',
            // Køen sier D, oppdragsfila sier K: fila vinner.
            klasse: 'D',
            status: 'kjorer',
            startet: new Date(Date.now() - 3_600_000).toISOString(),
            oppdrag,
          },
        ],
        grenser: { maksSamtidig: 5, maksDPluss: 2, maksPerDomene: 7, maksDb: 5 },
        neste_migr: 100,
      }),
    );
    // Ti millioner output-tokens: langt over $20 med enhver modellpris.
    writeFileSync(
      join(mappe, 'tider.jsonl'),
      JSON.stringify({
        tid: new Date().toISOString(),
        bolge: 'ko',
        spor: 'X',
        hendelse: 'ferdig',
        agent_id: 'agentX',
        agent_type: 'spor',
        tokens: { output: 10_000_000 },
      }) + '\n',
    );
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('varsler orkestratoren én gang når sporet passerer FAKTOR x snittet; andre økter får ingenting', () => {
    kjor('ko.mjs', ['orkestrator', 'puls', '--okt', 'ko A']);
    const ut = hook('s1');
    expect(ut).not.toHaveProperty('decision');
    expect(ut.systemMessage).toMatch(/Kostvakt: X \(K\)/);
    expect(ut.hookSpecificOutput.additionalContext).toMatch(/KOSTVAKT X/);
    const tilstand = JSON.parse(readFileSync(join(mappe, 'kostvakt.json'), 'utf8'));
    expect(Object.keys(tilstand.varslet)).toEqual(['X']);
    // Andre gang: allerede varslet.
    expect(hook('s1')).toBeNull();
  });

  it('gjør ingenting uten aktiv orkestrator', () => {
    expect(hook('s2')).toBeNull();
  });
});
