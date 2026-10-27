// =============================================================
// koOrkestrator.test.ts: orkestratorens rutine som skript og kost per oppgave.
//
// Testene beviser reglene der de håndheves: de rene funksjonene i koLogikk.js (kort visning, RESULTAT- og FUNN-
// parserne, sporets siste svar, hvilke agenter som hører til en oppgave, kostsummen, review-pakkens innhold), og
// ko.mjs (vis, fyll, motta, sett ferdig, kost) mot en kopi av køen i en midlertidig mappe (KO_MAPPE), et
// midlertidig git-repo (KO_GIT), en egen tidslogg (KO_TIDSLOGG) og egne transkripter (KO_TRANSKRIPTER).
// Aldri hovedrepoet, aldri den ekte køen, og uten `git config` (identiteten gis med -c).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Oppgave = {
  id: string;
  tittel: string;
  domene: string;
  klasse: 'K' | 'D' | 'D+' | 'U';
  status: string;
  oppdrag?: string;
  nytte?: number;
  innhold_min?: number;
  migr_tiere?: number;
  avhenger?: string[];
  venter_paa?: string[];
  eier_filer?: string[];
  startet?: string;
  levert?: string;
  ferdig?: string;
  gren?: string;
  migr_blokk?: string | null;
  head_start?: string;
  scratchpad?: string;
  kost?: { usd: number; tokens: { sum: number }; agenter: { agent: string; type: string }[] };
  funn?: { H: number; M: number; L: number; utsettbare: string[]; rapporter: number };
  resultat?: { status: string | null; commits: number | null; linje: string };
  review_pakke?: string;
};
type Ko = { oppgaver: Oppgave[]; avklart?: string[]; grenser?: object; neste_migr?: number };
type Resultat = {
  linje: string;
  status: string | null;
  gren: string | null;
  commits: number | null;
  migr: string | null;
  gater: string | null;
  probe: string | null;
  eierspm: number | null;
  edge: string | null;
  ekstra: Record<string, string>;
};
type Funn = { linje: string; H: number; M: number; L: number; utsettbare: string[] };
type Rad = Record<string, unknown>;
type AgentValg = { agent: string; type: string; rad: Rad };

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../koLogikk') as {
  agentTypeFor: (k: string) => string;
  reviewereFor: (k: string) => string[];
  sporMelding: (id: string, sti: string) => string;
  kortVisning: (
    ko: Ko,
    valg?: { naa?: number; ucommittet?: string[]; dagsforbruk?: number },
  ) => string[];
  parseResultat: (t: string | null | undefined) => Resultat | null;
  parseFunn: (t: string | null | undefined) => Funn | null;
  samleFunn: (
    l: (Funn | null)[],
  ) => { H: number; M: number; L: number; utsettbare: string[]; rapporter: number } | null;
  sisteSvar: (t: string) => string | null;
  forsteBrukermelding: (t: string) => string | null;
  nevnerOppgave: (t: string, id: string) => boolean;
  agenterForOppgave: (
    rader: Rad[],
    id: string,
    valg?: { fra?: string | null; til?: string | null },
  ) => { sikre: AgentValg[]; usikre: AgentValg[] };
  summerKost: (
    a: {
      agent: string;
      type: string;
      tokens: Record<string, number>;
      modell?: string;
      turer?: number;
      kilde?: string;
    }[],
    naa?: string,
  ) => {
    usd: number;
    tokens: Record<string, number>;
    turer: number;
    agenter: { agent: string; usd: number }[];
  };
  kostStatistikk: (
    ko: Ko,
    valg?: { siden?: string | null },
  ) => {
    rader: { id: string; usd: number }[];
    perKlasse: {
      klasse: string;
      n: number;
      usd: number;
      median_usd: number | null;
      H: number;
      M: number;
      L: number;
    }[];
    total: { n: number; usd: number };
  };
  pakkeFiler: (
    ns: string,
    num: string,
  ) => { kopier: string[]; hoppet: { sti: string; grunn: string }[] };
  dbObjekterFraDiff: (d: string, m?: { mappe: string | null }) => string[];
  reviewPakkeIndeks: (x: object) => string;
  reviewerPrompt: (x: { o: Partial<Oppgave>; type: string; mappe: string }) => string;
};
const TK = require('../tidKost') as {
  sporFraTekst: (t: string) => string | null;
  kostUsd: (t: Record<string, number>, m?: string) => number;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ROT = path.resolve(__dirname, '..', '..', '..', '..');
const NAA = '2026-10-06T10:00:00.000Z';
const ID = ['-c', 'user.name=ko-test', '-c', 'user.email=ko-test@example.invalid'];
const midlertidige: string[] = [];
afterAll(() => {
  for (const m of midlertidige) fs.rmSync(m, { recursive: true, force: true });
});

function o(id: string, ekstra: Partial<Oppgave> = {}): Oppgave {
  return {
    id,
    tittel: `Oppgave ${id}`,
    domene: `dom-${id}`,
    klasse: 'K',
    status: 'venter',
    oppdrag: `Oppdraget for ${id}.`,
    nytte: 5,
    innhold_min: 60,
    migr_tiere: 0,
    avhenger: [],
    venter_paa: [],
    eier_filer: [`lib/${id}.ts`],
    ...ekstra,
  };
}

/** En transkriptlinje (JSONL) fra assistenten med usage og innhold. */
function assistent(
  mid: string,
  innhold: object[],
  usage = { input_tokens: 10, output_tokens: 100 },
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: NAA,
    message: { id: mid, model: 'claude-opus-5-5', usage, content: innhold },
  });
}
const bruker = (tekst: string) =>
  JSON.stringify({ type: 'user', timestamp: NAA, message: { content: tekst } });

describe('kort visning (vis)', () => {
  it('er under 3 000 tegn også med hundrevis av ventende, og viser aktive, startbare og tellinger', () => {
    const oppgaver: Oppgave[] = [
      o('AKT-1', { status: 'kjorer', startet: NAA, migr_blokk: '3500–3509' }),
      o('REV-1', { status: 'review', klasse: 'D', startet: NAA, levert: NAA }),
      o('FRI-1', { nytte: 9 }),
    ];
    // 300 ventende som venter på et eierspørsmål (hindret), med lange titler.
    for (let i = 0; i < 300; i++)
      oppgaver.push(
        o(`V-${i}`, { venter_paa: ['Ø9'], tittel: `En lang tittel ${'x'.repeat(120)}` }),
      );
    const linjer = L.kortVisning(
      { oppgaver, grenser: {}, avklart: [] },
      { naa: Date.parse(NAA) + 3_600_000 },
    );
    const tekst = linjer.join('\n');
    expect(tekst.length).toBeLessThan(3000);
    expect(tekst).toMatch(/^AKTIVE \(2\):/m);
    expect(tekst).toMatch(/^ {2}AKT-1 +kjorer/m);
    expect(tekst).toMatch(/^ {2}REV-1 +review/m);
    expect(tekst).toMatch(/STARTBARE NÅ \(1; ko\.mjs fyll starter dem\)/);
    expect(tekst).toMatch(/^ {2}FRI-1 /m);
    expect(tekst).toMatch(/2 aktive · 301 venter/);
    expect(tekst).toMatch(/Venter per klasse: K 301; 300 av dem er hindret nå/);
    expect(tekst).toMatch(/Eierspørsmål som låser opp flest: Ø9 \(300\)/);
    expect(tekst).not.toMatch(/V-17/);
  });
});

describe('agenttype, reviewere og agentmelding', () => {
  it('følger klassen', () => {
    expect(L.agentTypeFor('K')).toBe('spor');
    expect(L.agentTypeFor('U')).toBe('spor');
    expect(L.agentTypeFor('D')).toBe('spor-d');
    expect(L.agentTypeFor('D+')).toBe('spor-d');
    expect(L.reviewereFor('K')).toEqual([]);
    expect(L.reviewereFor('D')).toEqual(['reviewer']);
    expect(L.reviewereFor('D+')).toEqual(['reviewer', 'reviewer-sikkerhet']);
  });
  it('agentmeldingen og reviewer-prompten knytter kosten til oppgaven (tidKost.sporFraTekst)', () => {
    expect(TK.sporFraTekst(L.sporMelding('E-1b2', 'C:\\s\\prompt-E-1b2.md'))).toBe('E-1b2');
    const p = L.reviewerPrompt({
      o: { id: 'E-1b2', klasse: 'D+' },
      type: 'reviewer-sikkerhet',
      mappe: 'C:\\s\\rev-E-1b2',
    });
    expect(TK.sporFraTekst(p)).toBe('E-1b2');
    expect(p).toContain('C:\\s\\rev-E-1b2\\00-pakke.md');
    expect(p).toMatch(/FUNN H=<antall> M=<antall> L=<antall>/);
  });
});

describe('RESULTAT- og FUNN-linja', () => {
  it('parser sporets RESULTAT-linje, også med markdown rundt', () => {
    const r = L.parseResultat(
      'Innledning\n**RESULTAT** status=ferdig gren=ko/X commits=3 migr=3490-3492 gater=OK probe=rød→grønn(12/12) eierspm=0 edge=- ny=1\nresten',
    );
    expect(r).toMatchObject({
      status: 'FERDIG',
      gren: 'ko/X',
      commits: 3,
      migr: '3490-3492',
      gater: 'OK',
      probe: 'rød→grønn(12/12)',
      eierspm: 0,
      edge: '-',
      ekstra: { ny: '1' },
    });
    expect(L.parseResultat('`RESULTAT status=DELVIS`')?.status).toBe('DELVIS');
  });
  it('er tolerant: mangler linja, er svaret null (dagens oppførsel)', () => {
    expect(L.parseResultat('Status: FERDIG, ingen fast linje')).toBeNull();
    expect(L.parseResultat(null)).toBeNull();
    expect(L.parseFunn('Ingen HØY-funn.')).toBeNull();
    expect(L.parseFunn('FUNN se under')).toBeNull();
  });
  it('parser og summerer FUNN-linjer', () => {
    const a = L.parseFunn('FUNN H=0 M=1 L=3 utsettbare=L2,L3');
    expect(a).toMatchObject({ H: 0, M: 1, L: 3, utsettbare: ['L2', 'L3'] });
    const b = L.parseFunn('> FUNN: H=1 L=2 utsettbare=-');
    expect(b).toMatchObject({ H: 1, M: 0, L: 2, utsettbare: [] });
    expect(L.samleFunn([a, null, b])).toEqual({
      H: 1,
      M: 1,
      L: 5,
      utsettbare: ['L2', 'L3'],
      rapporter: 2,
    });
    expect(L.samleFunn([null])).toBeNull();
  });
});

describe('transkriptene: siste svar og oppdraget', () => {
  it('siste svar er siste tekst eller SubagentHandback-meldingen', () => {
    const t = [
      bruker('Du er spor X'),
      assistent('m1', [{ type: 'text', text: 'underveis' }]),
      assistent('m2', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'SubagentHandback',
          input: { message: 'RESULTAT status=FERDIG' },
        },
      ]),
      '{halv linje',
    ].join('\n');
    expect(L.sisteSvar(t)).toBe('RESULTAT status=FERDIG');
    expect(
      L.sisteSvar([bruker('x'), assistent('m1', [{ type: 'text', text: 'FUNN H=0' }])].join('\n')),
    ).toBe('FUNN H=0');
    expect(L.forsteBrukermelding(t)).toBe('Du er spor X');
  });
  it('nevnerOppgave krever id-en som eget ord', () => {
    expect(L.nevnerOppgave('review av ko/E-1b', 'E-1b')).toBe(true);
    expect(L.nevnerOppgave('retterunde E-1b-r2', 'E-1b')).toBe(true);
    expect(L.nevnerOppgave('E-1b2 er en annen', 'E-1b')).toBe(false);
    expect(L.nevnerOppgave('XE-1b', 'E-1b')).toBe(false);
  });
});

describe('kost per oppgave', () => {
  const tok = { input: 100, output: 1000, cache_lest: 1_000_000, cache_skrevet: 50_000 };
  const rader: Rad[] = [
    {
      tid: '2026-10-06T10:00:00Z',
      agent_id: 'aaa111',
      agent_type: 'spor',
      hendelse: 'start',
      spor: 'aaa111',
    },
    // Kumulative rader: bare den siste per agent teller.
    {
      tid: '2026-10-06T10:30:00Z',
      agent_id: 'aaa111',
      agent_type: 'spor',
      hendelse: 'ferdig',
      spor: 'X-1',
      tokens: { input: 1 },
    },
    {
      tid: '2026-10-06T11:00:00Z',
      agent_id: 'aaa111',
      agent_type: 'spor',
      hendelse: 'ferdig',
      spor: 'X-1',
      tokens: tok,
    },
    // Retterunde: hører til X-1.
    {
      tid: '2026-10-06T12:00:00Z',
      agent_id: 'bbb222',
      agent_type: 'spor',
      hendelse: 'ferdig',
      spor: 'X-1-r2',
      tokens: tok,
    },
    // Reviewer uten gjenkjent spor (etiketten er agent-id-en): usikker.
    {
      tid: '2026-10-06T11:30:00Z',
      agent_id: 'ccc333ddd',
      agent_type: 'reviewer',
      hendelse: 'ferdig',
      spor: 'ccc333',
      tokens: tok,
    },
    // Annen oppgave og en planlegger uten spor: ikke med.
    {
      tid: '2026-10-06T11:30:00Z',
      agent_id: 'eee444',
      agent_type: 'spor',
      hendelse: 'ferdig',
      spor: 'X-10',
      tokens: tok,
    },
    {
      tid: '2026-10-06T11:30:00Z',
      agent_id: 'fff555',
      agent_type: 'general-purpose',
      hendelse: 'ferdig',
      spor: 'fff555',
      tokens: tok,
    },
    // Usikker, men før oppgaven startet: ikke med.
    {
      tid: '2026-10-05T11:30:00Z',
      agent_id: 'ggg666',
      agent_type: 'reviewer-sikkerhet',
      hendelse: 'ferdig',
      spor: 'ggg666',
      tokens: tok,
    },
  ];
  it('agenterForOppgave: sikre via spor-etiketten (med retterunder), usikre i tidsvinduet', () => {
    const r = L.agenterForOppgave(rader, 'X-1', {
      fra: '2026-10-06T09:00:00Z',
      til: '2026-10-06T13:00:00Z',
    });
    expect(r.sikre.map((x) => x.agent).sort()).toEqual(['aaa111', 'bbb222']);
    expect(r.sikre.find((x) => x.agent === 'aaa111')?.rad.tokens).toEqual(tok);
    expect(r.usikre.map((x) => x.agent)).toEqual(['ccc333ddd']);
  });
  it('summerKost bruker tidKost-prisene og summerer tokens og turer', () => {
    const k = L.summerKost(
      [
        { agent: 'a', type: 'spor', tokens: tok, modell: 'claude-opus-5-5', turer: 10 },
        { agent: 'b', type: 'reviewer', tokens: tok, turer: 5, kilde: 'transkript' },
      ],
      NAA,
    );
    const en = TK.kostUsd(tok, 'claude-opus-5-5');
    expect(k.usd).toBeCloseTo(2 * en, 2);
    expect(k.tokens.sum).toBe(2 * (100 + 1000 + 1_000_000 + 50_000));
    expect(k.turer).toBe(15);
    expect(k.agenter.map((x) => x.agent)).toEqual(['a', 'b']);
  });
  it('kostStatistikk per klasse, med funn', () => {
    const ko: Ko = {
      oppgaver: [
        o('A', {
          status: 'ferdig',
          ferdig: NAA,
          kost: { usd: 4, tokens: { sum: 1 }, agenter: [] },
        }),
        o('B', {
          status: 'ferdig',
          ferdig: NAA,
          klasse: 'D',
          kost: { usd: 10, tokens: { sum: 1 }, agenter: [] },
          funn: { H: 0, M: 1, L: 2, utsettbare: [], rapporter: 1 },
        }),
        o('C', {
          status: 'ferdig',
          ferdig: NAA,
          kost: { usd: 6, tokens: { sum: 1 }, agenter: [] },
        }),
        o('D', {
          status: 'ferdig',
          ferdig: '2026-09-01T00:00:00Z',
          kost: { usd: 100, tokens: { sum: 1 }, agenter: [] },
        }),
        o('E', { status: 'venter' }),
      ],
    };
    const s = L.kostStatistikk(ko, { siden: '2026-10-01T00:00:00Z' });
    expect(s.total).toEqual({ n: 3, usd: 20 });
    expect(s.perKlasse.find((k) => k.klasse === 'K')).toMatchObject({
      n: 2,
      usd: 10,
      median_usd: 5,
    });
    expect(s.perKlasse.find((k) => k.klasse === 'D')).toMatchObject({ n: 1, H: 0, M: 1, L: 2 });
  });
});

describe('review-pakken', () => {
  it('pakkeFiler hopper over slettede og binære filer', () => {
    const r = L.pakkeFiler(
      'M\tscripts/a.js\nA\tdb/migrasjoner/1_x.sql\nD\tgammel.ts\nA\tbilde.png\n',
      '1\t2\tscripts/a.js\n5\t0\tdb/migrasjoner/1_x.sql\n0\t9\tgammel.ts\n-\t-\tbilde.png\n',
    );
    expect(r.kopier).toEqual(['scripts/a.js', 'db/migrasjoner/1_x.sql']);
    expect(r.hoppet).toEqual([
      { sti: 'gammel.ts', grunn: 'slettet' },
      { sti: 'bilde.png', grunn: 'binær' },
    ]);
  });
  it('dbObjekterFraDiff tar bare nye linjer i migrasjoner', () => {
    const diff = [
      'diff --git a/db/migrasjoner/1_x.sql b/db/migrasjoner/1_x.sql',
      '+++ b/db/migrasjoner/1_x.sql',
      '+create or replace function public.foo(p uuid)',
      '+CREATE TABLE IF NOT EXISTS public.bar (',
      '+create policy "les bar" on public.bar for select',
      '+create or replace trigger t_bar before insert on public.bar',
      '-create function public.gammel()',
      '+  -- create function i en kommentar midt i linja teller ikke',
      '+create function public.foo(p uuid)',
      '+++ b/lib/x.ts',
      '+create function ikke_sql()',
    ].join('\n');
    expect(L.dbObjekterFraDiff(diff, { mappe: null })).toEqual([]);
    expect(L.dbObjekterFraDiff(diff, { mappe: 'db/migrasjoner' })).toEqual([
      'create function public.foo',
      'create table public.bar',
      'create policy "les bar" on public.bar',
      'create trigger t_bar',
    ]);
  });
  it('indeksen lister filene og resultatlinja', () => {
    const t = L.reviewPakkeIndeks({
      o: { id: 'X', klasse: 'D', tittel: 'T', migr_blokk: '1–9' },
      gren: 'ko/X',
      stat: ' a | 1 +',
      dbObjekter: ['create function public.foo'],
      kopiert: ['a'],
      hoppet: [{ sti: 'b.png', grunn: 'binær' }],
      resultat: { linje: 'RESULTAT status=FERDIG' },
      filer: { sporsvar: true, rapport: true },
      base: 'main',
      migrMappe: 'db/migrasjoner',
    });
    expect(t).toContain('# Review-pakke X (D): T');
    expect(t).toContain('diff mot `main`');
    expect(t).toContain('Migrasjonsblokk: 1–9');
    expect(t).toContain('`RESULTAT status=FERDIG`');
    expect(t).toContain('`sporsvar.md`');
    expect(t).toContain('`sporrapport.md`');
    expect(t).toContain('`b.png` (binær)');
    expect(t).toContain('- create function public.foo');
  });
});

describe('ko.mjs vis, fyll, motta, sett ferdig og kost (mot kopier)', () => {
  it('hele rutinen fra fyll til ferdig med kost og funn', () => {
    const mappe = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-ork-'));
    midlertidige.push(mappe);
    const repo = path.join(mappe, 'repo');
    const scratch = path.join(mappe, 'scratch');
    const transkripter = path.join(mappe, 'transkripter');
    const logg = path.join(mappe, 'tider.jsonl');
    fs.mkdirSync(repo);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const skrivFil = (fil: string, tekst: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, fil)), { recursive: true });
      fs.writeFileSync(path.join(repo, fil), tekst);
      g(['add', '--', fil]);
    };
    g(['init', '-q', '-b', 'main']);
    skrivFil('README.md', 'start\n');
    g(['commit', '-q', '-m', 'start']);
    fs.writeFileSync(
      path.join(mappe, 'ko.json'),
      JSON.stringify({
        opprettet: NAA,
        grenser: {},
        neste_migr: 3600,
        avklart: [],
        oppgaver: [
          o('A', { klasse: 'D', migr_tiere: 1, nytte: 9 }),
          o('B', { venter_paa: ['Ø1'] }),
        ],
      }),
    );
    const konfigFil = path.join(mappe, 'ko.config.json');
    fs.writeFileSync(
      konfigFil,
      JSON.stringify({
        migrasjoner: {
          mappe: 'db/migrasjoner',
          blokkStorrelse: 10,
          pushKommando: 'node migr-push.js',
          miljoFil: '.miljo',
          tillatteMiljo: ['test'],
        },
      }),
    );
    // Oppdragsmalen (fyll bygger sporblokka fra felles-delen) leses fra rota: en kopi av repoets mal.
    fs.mkdirSync(path.join(mappe, 'docs'));
    fs.copyFileSync(
      path.join(ROT, '..', 'docs', 'mission-template.md'),
      path.join(mappe, 'docs', 'mission-template.md'),
    );
    const env = {
      ...process.env,
      KO_MAPPE: mappe,
      KO_KONFIG: konfigFil,
      KO_ROT: mappe,
      KO_GIT: repo,
      KO_TIDSLOGG: logg,
      KO_TRANSKRIPTER: transkripter,
    };
    const kjor = (...args: string[]) => {
      const r = spawnSync(
        process.execPath,
        [path.join(ROT, 'scripts', 'orkestrator', 'ko.mjs'), ...args],
        {
          encoding: 'utf8',
          env,
        },
      );
      return { kode: r.status, ut: r.stdout, feil: r.stderr };
    };
    const finn = (id: string) =>
      (JSON.parse(fs.readFileSync(path.join(mappe, 'ko.json'), 'utf8')) as Ko).oppgaver.find(
        (x) => x.id === id,
      )!;

    // vis: kort som standard, full bak --full.
    const v = kjor('vis');
    expect(v.kode).toBe(0);
    expect(v.ut).toMatch(/STARTBARE NÅ \(1;/);
    expect(v.ut).toContain('Full liste: ko.mjs vis --full');
    expect(kjor('vis', '--full').ut).toMatch(/Ø1/);

    // fyll: starter A (D, migrasjonsblokk), lager prompt-fila og JSON-en med agenttype og melding.
    expect(kjor('fyll').kode).toBe(1); // uten scratchpad
    const f = kjor('fyll', '--scratchpad', scratch);
    expect(f.feil).toBe('');
    expect(f.kode).toBe(0);
    expect(f.ut).toMatch(/A {2}subagent_type=spor-d/);
    const json = JSON.parse(fs.readFileSync(path.join(scratch, 'ko-fyll.json'), 'utf8')) as {
      head: string;
      spor: { id: string; subagent_type: string; prompt: string; melding: string }[];
    };
    expect(json.spor.map((s) => s.id)).toEqual(['A']);
    expect(json.spor[0].subagent_type).toBe('spor-d');
    const prompt = fs.readFileSync(json.spor[0].prompt, 'utf8');
    expect(prompt).toContain('Oppdraget for A.');
    expect(prompt).toContain('ko/A');
    expect(prompt).toContain('3600–3609');
    const a1 = finn('A');
    expect(a1).toMatchObject({
      status: 'kjorer',
      gren: 'ko/A',
      head_start: json.head,
      scratchpad: scratch,
    });
    // Ingenting mer kan startes (B venter på Ø1).
    expect(kjor('fyll', '--scratchpad', scratch).ut).toMatch(/Ingenting kan startes nå/);

    // Sporet arbeider på ko/A: en migrasjon, en endret fil og en slettet.
    g(['switch', '-q', '-c', 'ko/A']);
    skrivFil(
      'db/migrasjoner/3600_a.sql',
      'create or replace function public.a_fn() returns int as $$ select 1 $$;\n',
    );
    skrivFil('README.md', 'endret\n');
    g(['commit', '-q', '-m', 'A']);
    g(['switch', '-q', 'main']);
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'A', 'rapport.md'), '# Rapport A\nSelv-review OK.\n');

    // Transkriptene og tidsloggen: sporagenten (svarer med RESULTAT) og to reviewere (FUNN), den ene uten spor-etikett.
    const sesjon = path.join(transkripter, 'okt1', 'subagents');
    fs.mkdirSync(sesjon, { recursive: true });
    const usage = { input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 500_000 };
    fs.writeFileSync(
      path.join(sesjon, 'agent-sporA1.jsonl'),
      [
        bruker(json.spor[0].melding),
        assistent(
          's1',
          [
            {
              type: 'text',
              text: 'RESULTAT status=FERDIG gren=ko/A commits=1 migr=3600 gater=OK eierspm=0 edge=-\nresten',
            },
          ],
          usage,
        ),
      ].join('\n'),
    );
    const radA = (agent: string, type: string, spor: string, tid: string) =>
      JSON.stringify({
        tid,
        bolge: 'ko',
        spor,
        hendelse: 'ferdig',
        agent_id: agent,
        agent_type: type,
        tokens: { input: 1 },
        modell: 'claude-opus-5-5',
      });
    // Etter start (fyll) og før sett ferdig: tidsvinduet for agenter uten spor-etikett.
    const om = () => new Date().toISOString();
    fs.writeFileSync(logg, radA('sporA1', 'spor-d', 'A', om()) + '\n');

    // motta: review, pakken som vanlige filer, RESULTAT fra transkriptet, reviewer-prompt for D.
    const m = kjor('motta', 'A');
    expect(m.feil).toBe('');
    expect(m.kode).toBe(0);
    expect(m.ut).toMatch(/A: review · RESULTAT status=FERDIG/);
    expect(m.ut).toMatch(/subagent_type=reviewer/);
    expect(m.ut).not.toMatch(/reviewer-sikkerhet/);
    expect(m.ut).toContain(`--bolge-base ${json.head}`);
    const pakke = path.join(scratch, 'rev-A');
    expect(fs.readFileSync(path.join(pakke, 'filer', 'README.md'), 'utf8')).toBe('endret\n');
    expect(
      fs.existsSync(path.join(pakke, 'filer', 'db', 'migrasjoner', '3600_a.sql')),
    ).toBe(true);
    expect(fs.readFileSync(path.join(pakke, 'diff.patch'), 'utf8')).toContain('+endret');
    expect(fs.readFileSync(path.join(pakke, 'sporrapport.md'), 'utf8')).toContain(
      'Selv-review OK.',
    );
    expect(fs.readFileSync(path.join(pakke, 'sporsvar.md'), 'utf8')).toContain(
      'RESULTAT status=FERDIG',
    );
    const indeks = fs.readFileSync(path.join(pakke, '00-pakke.md'), 'utf8');
    expect(indeks).toContain('create function public.a_fn');
    const revPrompt = fs.readFileSync(path.join(pakke, 'reviewer-reviewer.md'), 'utf8');
    expect(revPrompt).toContain('spor A ');
    const a2 = finn('A');
    expect(a2.status).toBe('review');
    expect(a2.resultat).toMatchObject({ status: 'FERDIG', commits: 1 });
    expect(a2.review_pakke).toBe(pakke);

    // Reviewerne: én med spor-etikett, én uten (oppdraget nevner A), og en annen oppgaves reviewer (ikke med).
    fs.writeFileSync(
      path.join(sesjon, 'agent-revA1.jsonl'),
      [
        bruker(revPrompt),
        assistent(
          'r1',
          [{ type: 'text', text: 'FUNN H=0 M=1 L=2 utsettbare=L2\nDetaljer' }],
          usage,
        ),
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(sesjon, 'agent-revukjent.jsonl'),
      [
        bruker('Verifiser rettingen i ko/A'),
        assistent(
          'r2',
          [
            {
              type: 'tool_use',
              id: 'h',
              name: 'SubagentHandback',
              input: { message: '**FUNN** H=1 M=0 L=0' },
            },
          ],
          usage,
        ),
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(sesjon, 'agent-revannen.jsonl'),
      [
        bruker('Review av ko/B'),
        assistent('r3', [{ type: 'text', text: 'FUNN H=5 M=5 L=5' }], usage),
      ].join('\n'),
    );
    fs.appendFileSync(
      logg,
      [
        radA('revA1', 'reviewer', 'A', om()),
        radA('revukjent', 'reviewer', 'revukj', om()),
        radA('revannen', 'reviewer', 'revann', om()),
      ].join('\n') + '\n',
    );

    // sett ferdig: kost fra transkriptene (tre agenter), funn summert fra to FUNN-linjer.
    const s = kjor('sett', 'A', 'ferdig', '--merknad', 'review 1 runde');
    expect(s.feil).toBe('');
    expect(s.ut).toMatch(/Kost A: \$[\d.]+ \(3 agent\(er\)/);
    expect(s.ut).toMatch(/funn H=1 M=1 L=2 \(2 rapport\(er\)\)/);
    const a3 = finn('A');
    expect(a3.status).toBe('ferdig');
    expect(a3.kost?.agenter.map((x) => x.agent).sort()).toEqual(['revA1', 'revukjent', 'sporA1']);
    const enUsd = TK.kostUsd({ input: 100, output: 1000, cache_lest: 500_000 }, 'claude-opus-5-5');
    expect(a3.kost?.usd).toBeCloseTo(3 * enUsd, 2);
    expect(a3.funn).toEqual({ H: 1, M: 1, L: 2, utsettbare: ['L2'], rapporter: 2 });

    // kost: statistikken per klasse; kost maal med --funn overstyrer transkriptene.
    const k = kjor('kost');
    expect(k.ut).toMatch(/Kost per oppgave \(1 ferdige/);
    expect(k.ut).toMatch(/D {2}n=1/);
    expect(kjor('kost', 'maal', 'A', '--funn', 'FUNN H=0 M=0 L=1').ut).toMatch(/funn H=0 M=0 L=1/);
    expect(finn('A').funn).toMatchObject({ H: 0, M: 0, L: 1 });
  });
});

// =============================================================
// Færre orkestratorturer: flett i ett kall, faste oppslag, samtidige kall og rapporttak. Ingen ekte fletting,
// migrasjonspush eller gater: de rene funksjonene får en kjører, og ko.mjs flett får en injisert kjører
// (KO_FLETT_KJORER).
// =============================================================
type Steg = { steg: string };
type KjorSvar = { kode: number; ut: string };
type Plan = { steg: string[]; migrPush: boolean; migr: string[]; notater: string[] };
type Migr = {
  mappe: string | null;
  filmonster?: string;
  pushKommando?: string | null;
  miljoFil?: string | null;
  tillatteMiljo?: string[];
};
type FlettRes = {
  ok: boolean;
  linjer: string[];
  stopp: { steg: string; melding: string; utdrag: string[] } | null;
};
/* eslint-disable @typescript-eslint/no-require-imports */
const K2 = require('../koLogikk') as {
  RAPPORT_TAK: number;
  SAMME_TUR: string;
  miljoSjekk: (
    r: string | null | undefined,
    m?: Migr,
  ) => { ok: boolean; miljo: string; melding: string };
  flettPlan: (x: {
    o: Partial<Oppgave>;
    filer: string[] | null;
    utenMigrPush?: boolean;
    utenFyll?: boolean;
    base?: string;
    migrasjoner?: Migr;
  }) => Plan;
  feilUtdrag: (ut: string, n?: number) => string[];
  utforFlett: (x: {
    o: Partial<Oppgave>;
    plan: Plan;
    gren: string;
    gjeldendeGren: string | null;
    kjor: (s: Steg) => KjorSvar;
    lesMiljo?: () => string | null;
    vakt?: (miljo: string | null) => { beslutning: string; grunn: string } | null;
    base?: string;
    migrasjoner?: Migr;
  }) => FlettRes;
  samtidigBlokk: (
    a: { subagent_type: string; prompt: string; melding?: string | null }[],
  ) => string[];
  rapportTakVarsel: (t: string | null) => string | null;
  infoFelt: (o: object, f: string) => unknown;
  infoVisning: (o: object) => string[];
  leggTilTillegg: (o: Record<string, unknown>, t: string, naa: string) => string | null;
  sporBlokk: (o: object, ko: object, x: { tekst: string }) => string;
  aktiveLinjer: (ko: object, naa?: number) => string[];
  hoyesteBlokkNr: (ko: object) => number;
  nesteMigrVakt: (x: { naa: number; ny: number; hoyesteFil?: number; hoyesteBlokk?: number }) => {
    ok: boolean;
    feil: string | null;
  };
  sporMelding: (id: string, sti: string) => string;
};
const PV = require('../pushVakt') as {
  vurder: (k: string, x: object) => { beslutning: string; grunn: string } | null;
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** Migrasjonsoppsettet testene bruker: mappe, pushkommando og en miljøvakt med ett tillatt miljø. */
const MIGR: Migr = {
  mappe: 'db/migrasjoner',
  filmonster: '^(\\d+)_.*\\.sql$',
  pushKommando: 'node migr-push.js',
  miljoFil: '.miljo',
  tillatteMiljo: ['test'],
};
const UTEN_MIGR: Migr = { mappe: null };

describe('miljøsjekk og stegplan for flett', () => {
  it('bare et tillatt miljø slipper gjennom; ukjent og manglende fil stopper; uten miljøfil ingen vakt', () => {
    expect(K2.miljoSjekk('test\n', MIGR)).toMatchObject({ ok: true, miljo: 'test' });
    expect(K2.miljoSjekk('produksjon', MIGR)).toMatchObject({ ok: false, miljo: 'ukjent' });
    expect(K2.miljoSjekk('produksjon', MIGR).melding).toMatch(/tillatteMiljo \(test\)/);
    expect(K2.miljoSjekk(null, MIGR)).toMatchObject({ ok: false, miljo: 'mangler' });
    expect(K2.miljoSjekk('  ', MIGR)).toMatchObject({ ok: false, miljo: 'mangler' });
    expect(K2.miljoSjekk(null, { ...MIGR, miljoFil: null })).toMatchObject({
      ok: true,
      miljo: 'uten-vakt',
    });
  });

  it('migrasjonspush bare når grenen har migrasjonsfiler (blokka avgjør når diffen mangler)', () => {
    const m = K2.flettPlan({
      o: { id: 'M', migr_blokk: '3600–3609' },
      filer: ['lib/x.ts', 'db/migrasjoner/3600_m.sql'],
      migrasjoner: MIGR,
    });
    expect(m.steg).toEqual(['flett', 'migr-push', 'gater', 'ferdig', 'fyll']);
    expect(m.migr).toEqual(['db/migrasjoner/3600_m.sql']);
    // Blokk tildelt, men ingen migrasjonsfiler: ingen push, med notat.
    const b = K2.flettPlan({
      o: { id: 'B', migr_blokk: '3600–3609' },
      filer: ['lib/x.ts'],
      migrasjoner: MIGR,
    });
    expect(b.steg).toEqual(['flett', 'gater', 'ferdig', 'fyll']);
    expect(b.notater.join(' ')).toMatch(/ingen migrasjonsfiler/);
    // Diffen kunne ikke leses: blokka avgjør (heller én push for mye).
    expect(
      K2.flettPlan({ o: { id: 'X', migr_blokk: '3600–3609' }, filer: null, migrasjoner: MIGR })
        .migrPush,
    ).toBe(true);
    expect(K2.flettPlan({ o: { id: 'Y' }, filer: null, migrasjoner: MIGR }).migrPush).toBe(false);
    // Andre .sql utenfor mappa, i en undermappe eller utenfor filmønsteret teller ikke.
    for (const f of ['db/tester/x.sql', 'db/migrasjoner/gammel/1_x.sql', 'db/migrasjoner/x.sql'])
      expect(K2.flettPlan({ o: { id: 'P' }, filer: [f], migrasjoner: MIGR }).migrPush).toBe(false);
    // --uten-migr-push og --uten-fyll.
    const u = K2.flettPlan({
      o: { id: 'M' },
      filer: ['db/migrasjoner/1_a.sql'],
      utenMigrPush: true,
      utenFyll: true,
      migrasjoner: MIGR,
    });
    expect(u.steg).toEqual(['flett', 'gater', 'ferdig']);
    expect(u.notater.join(' ')).toMatch(/IKKE pushet/);
  });

  it('uten migrasjonsmappe er det aldri et push-steg; uten pushkommando bare et notat', () => {
    const filer = ['db/migrasjoner/3600_m.sql'];
    const a = K2.flettPlan({ o: { id: 'M', migr_blokk: '3600–3609' }, filer, migrasjoner: UTEN_MIGR });
    expect(a.steg).toEqual(['flett', 'gater', 'ferdig', 'fyll']);
    expect(a.migr).toEqual([]);
    expect(a.notater).toEqual([]);
    const b = K2.flettPlan({ o: { id: 'M' }, filer, migrasjoner: { ...MIGR, pushKommando: null } });
    expect(b.migrPush).toBe(false);
    expect(b.notater.join(' ')).toMatch(/pushKommando er ikke satt/);
  });

  it('feilutdraget er høyst 20 ikke-tomme linjer fra slutten', () => {
    const ut = Array.from({ length: 50 }, (_, i) => `linje ${i}`).join('\n\n');
    const u = K2.feilUtdrag(ut);
    expect(u).toHaveLength(20);
    expect(u[19]).toBe('linje 49');
  });
});

describe('utforFlett (rekkefølge og stopp-regler)', () => {
  const oM = { id: 'M', klasse: 'D' as const, migr_blokk: '3600–3609' };
  const planM = () =>
    K2.flettPlan({ o: oM, filer: ['db/migrasjoner/3600_m.sql'], migrasjoner: MIGR });
  /** Felles argumenter: basegren main, migrasjonsoppsettet over og miljøet «test». */
  const felles = { gren: 'ko/M', gjeldendeGren: 'main', base: 'main', migrasjoner: MIGR };
  /** Kjører med canned svar per steg og husker kallene. */
  const kjorer = (svar: Record<string, KjorSvar>) => {
    const kall: string[] = [];
    const kjor = (s: Steg) => {
      kall.push(s.steg);
      return svar[s.steg] ?? { kode: 0, ut: 'ok' };
    };
    return { kall, kjor };
  };
  const FYLL = {
    kode: 0,
    ut: 'FYLT 1 spor (head abc); detaljene i x.\nB  subagent_type=spor  migr -\nStart disse i SAMME tur:\n  subagent_type=spor · melding: Du er spor B',
  };

  it('hele løpet: flett → migrasjonspush → gater → ferdig → fyll', () => {
    const { kall, kjor } = kjorer({
      flett: { kode: 0, ut: 'Flettet og committet: abc1234 Merge\nWorktree: ryddet: ok' },
      'migr-push': { kode: 0, ut: 'Kjører 3600_m.sql\nKjører 3601_n.sql\nFerdig: 2 migrasjoner.' },
      gater: { kode: 0, ut: 'typesjekk OK\ngater: 14 OK, 0 RØD (3 min)' },
      ferdig: { kode: 0, ut: 'Kost M: $3.1 (2 agent(er))\nM: ferdig' },
      fyll: FYLL,
    });
    const r = K2.utforFlett({
      ...felles,
      o: oM,
      plan: planM(),
      kjor,
      lesMiljo: () => 'test',
      vakt: (miljo) =>
        PV.vurder(String(MIGR.pushKommando), {
          gren: 'main',
          miljo,
          baseGren: 'main',
          migrasjoner: MIGR,
        }),
    });
    expect(r.ok).toBe(true);
    expect(kall).toEqual(['flett', 'migr-push', 'gater', 'ferdig', 'fyll']);
    const t = r.linjer.join('\n');
    expect(t).toMatch(/flett: Flettet og committet: abc1234 Merge · Worktree: ryddet/);
    expect(t).toMatch(/migrasjonspush: OK \(miljø test\): Ferdig: 2 migrasjoner\./);
    expect(t).toMatch(/gater --rask: gater: 14 OK/);
    expect(t).toMatch(/ferdig: M: ferdig/);
    expect(t).toContain(K2.SAMME_TUR);
    expect(t).toContain('melding: Du er spor B');
    // Kort utdata: høyst ca. 15 linjer.
    expect(r.linjer.length).toBeLessThanOrEqual(15);
  });

  it('miljø utenfor tillatteMiljo: stopper før pushen, og ingenting etter kjøres', () => {
    const { kall, kjor } = kjorer({});
    const r = K2.utforFlett({ ...felles, o: oM, plan: planM(), kjor, lesMiljo: () => 'produksjon' });
    expect(r.ok).toBe(false);
    expect(r.stopp?.steg).toBe('migr-push');
    expect(r.stopp?.melding).toMatch(/produksjon/);
    expect(kall).toEqual(['flett']);
  });

  it('manglende miljøfil stopper også', () => {
    const { kall, kjor } = kjorer({});
    const r = K2.utforFlett({ ...felles, o: oM, plan: planM(), kjor, lesMiljo: () => null });
    expect(r.stopp?.steg).toBe('migr-push');
    expect(r.stopp?.melding).toMatch(/Fant ikke miljøfila \.miljo/);
    expect(kall).toEqual(['flett']);
  });

  it('push-vakta har siste ord: en mening fra den stopper pushen', () => {
    const { kall, kjor } = kjorer({});
    const r = K2.utforFlett({
      ...felles,
      o: oM,
      plan: planM(),
      kjor,
      lesMiljo: () => 'test',
      vakt: () => ({ beslutning: 'ask', grunn: 'test' }),
    });
    expect(r.stopp?.melding).toMatch(/push-vakta sier ask/);
    expect(kall).toEqual(['flett']);
  });

  it('miljøet endret under pushen: stopp etter pushen', () => {
    const miljoer = ['test', 'produksjon'];
    const { kall, kjor } = kjorer({});
    const r = K2.utforFlett({
      ...felles,
      o: oM,
      plan: planM(),
      kjor,
      lesMiljo: () => miljoer.shift() ?? null,
    });
    expect(r.stopp?.steg).toBe('migr-push');
    expect(r.stopp?.melding).toMatch(/endret under migrasjonspushen/);
    expect(kall).toEqual(['flett', 'migr-push']);
  });

  it('uten miljøfil i oppsettet kjøres pushen uten miljøvakt', () => {
    const migr = { ...MIGR, miljoFil: null };
    const { kall, kjor } = kjorer({ 'migr-push': { kode: 0, ut: 'ok' } });
    const r = K2.utforFlett({
      ...felles,
      migrasjoner: migr,
      o: oM,
      plan: K2.flettPlan({ o: oM, filer: ['db/migrasjoner/3600_m.sql'], migrasjoner: migr }),
      kjor,
    });
    expect(r.ok).toBe(true);
    expect(kall).toEqual(['flett', 'migr-push', 'gater', 'ferdig', 'fyll']);
    expect(r.linjer.join('\n')).toMatch(/migrasjonspush: OK: ok/);
  });

  it('hovedtreet er ikke på basegrenen: ingenting kjøres', () => {
    const { kall, kjor } = kjorer({});
    const r = K2.utforFlett({
      ...felles,
      gjeldendeGren: 'annen',
      o: oM,
      plan: planM(),
      kjor,
      lesMiljo: () => 'test',
    });
    expect(r.stopp?.steg).toBe('flett');
    expect(r.stopp?.melding).toMatch(/ikke main/);
    expect(kall).toEqual([]);
  });

  it('fletting eller migrasjonspush som feiler stopper med utdrag', () => {
    const a = kjorer({ flett: { kode: 1, ut: 'MÅ LØSES FOR HÅND\n  lib/x.ts' } });
    const r = K2.utforFlett({
      ...felles,
      o: oM,
      plan: planM(),
      kjor: a.kjor,
      lesMiljo: () => 'test',
    });
    expect(r.stopp).toMatchObject({ steg: 'flett', utdrag: ['MÅ LØSES FOR HÅND', '  lib/x.ts'] });
    expect(a.kall).toEqual(['flett']);
    const b = kjorer({ 'migr-push': { kode: 1, ut: 'connection refused' } });
    const r2 = K2.utforFlett({
      ...felles,
      o: oM,
      plan: planM(),
      kjor: b.kjor,
      lesMiljo: () => 'test',
    });
    expect(r2.stopp?.steg).toBe('migr-push');
    expect(r2.stopp?.utdrag).toEqual(['connection refused']);
    expect(b.kall).toEqual(['flett', 'migr-push']);
  });

  it('røde gater stopper før sett ferdig og fyll', () => {
    const { kall, kjor } = kjorer({ gater: { kode: 1, ut: 'typesjekk RØD\nse loggen' } });
    const plan = K2.flettPlan({ o: { id: 'K' }, filer: ['lib/k.ts'], migrasjoner: MIGR });
    const r = K2.utforFlett({ ...felles, o: { id: 'K' }, plan, gren: 'ko/K', kjor });
    expect(r.stopp?.steg).toBe('gater');
    expect(r.stopp?.melding).toMatch(/står i review/);
    // Uten migrasjonsfiler leses ikke miljøet, og pushen kjøres ikke.
    expect(kall).toEqual(['flett', 'gater']);
  });

  it('fyll som stopper på budsjett, natt eller avvikling er ikke en feil', () => {
    const { kjor } = kjorer({ fyll: { kode: 6, ut: 'Orkestratoren er i avvikling.' } });
    const plan = K2.flettPlan({ o: { id: 'K' }, filer: ['lib/k.ts'], migrasjoner: UTEN_MIGR });
    const r = K2.utforFlett({ ...felles, o: { id: 'K' }, plan, gren: 'ko/K', kjor });
    expect(r.ok).toBe(true);
    expect(r.linjer.join('\n')).toMatch(/fyll: ingen nye \(exit 6\)/);
  });
});

describe('samtidige kall, rapporttak, info, tillegg, aktive og neste-migr', () => {
  it('samtidigBlokk: én linje per agent etter overskriften', () => {
    expect(K2.samtidigBlokk([])).toEqual([]);
    const l = K2.samtidigBlokk([
      { subagent_type: 'spor-d', prompt: 'C:\\s\\prompt-A.md', melding: 'Du er spor A' },
      { subagent_type: 'reviewer', prompt: 'C:\\s\\rev-A\\reviewer-reviewer.md' },
    ]);
    expect(l[0]).toBe('Start disse i SAMME tur:');
    expect(l[1]).toMatch(/subagent_type=spor-d · melding: Du er spor A/);
    expect(l[2]).toMatch(
      /subagent_type=reviewer · melding: innholdet i .*reviewer-reviewer\.md/,
    );
  });

  it('rapporttaket: ca. 1 500 tegn, og agentmeldingen sier det', () => {
    expect(K2.RAPPORT_TAK).toBe(1500);
    expect(K2.rapportTakVarsel('RESULTAT status=FERDIG\nkort')).toBeNull();
    expect(K2.rapportTakVarsel(null)).toBeNull();
    expect(K2.rapportTakVarsel('x'.repeat(1501))).toMatch(/1501 tegn \(tak ca\. 1500\)/);
    expect(K2.sporMelding('A', 'C:\\s\\prompt-A.md')).toMatch(/høyst ca\. 1 500 tegn/);
  });

  it('info: ett felt (også med punktum) og kort visning', () => {
    const o = {
      id: 'A',
      tittel: 'T',
      status: 'review',
      klasse: 'D',
      head_start: 'abcdef1234567890',
      kost: { usd: 3.2, agenter: [], turer: 9 },
      oppdrag: 'x'.repeat(500),
      avhenger: [],
    };
    expect(K2.infoFelt(o, 'kost.usd')).toBe(3.2);
    expect(K2.infoFelt(o, 'finnes.ikke')).toBeUndefined();
    const v = K2.infoVisning(o).join('\n');
    expect(v).toMatch(/^id: A$/m);
    expect(v).toMatch(/head_start: abcdef123456$/m);
    expect(v).not.toMatch(/avhenger/);
    expect(v.length).toBeLessThan(700);
  });

  it('tillegg: med tidsstempel i tillegg og merknader, og i sporblokka', () => {
    const o: Record<string, unknown> = { id: 'A', tittel: 'T', klasse: 'K', merknader: ['gammel'] };
    expect(K2.leggTilTillegg(o, '  ', NAA)).toMatch(/tomt/);
    expect(K2.leggTilTillegg(o, 'Bruk RPC-en x_v2.', NAA)).toBeNull();
    expect(o.tillegg).toEqual([{ tid: NAA, tekst: 'Bruk RPC-en x_v2.' }]);
    expect(o.merknader).toEqual(['gammel', `${NAA} tillegg til oppdraget: Bruk RPC-en x_v2.`]);
    const blokk = K2.sporBlokk(o, { oppgaver: [o] }, { tekst: 'Oppdraget.' });
    expect(blokk).toMatch(/Oppdraget\.\n\n\*\*Tillegg fra orkestratoren/);
    expect(blokk).toContain(`- ${NAA}: Bruk RPC-en x_v2.`);
  });

  it('aktive: kjorer, plukket og review med gren, blokk, head og alder', () => {
    const naa = Date.parse(NAA);
    const ko = {
      oppgaver: [
        o('A', {
          status: 'kjorer',
          gren: 'ko/A',
          migr_blokk: '3600–3609',
          head_start: 'abcdef1234',
          startet: '2026-10-06T09:15:00.000Z',
        }),
        o('B', {
          status: 'review',
          gren: 'ko/B',
          startet: '2026-10-06T06:00:00.000Z',
          levert: '2026-10-06T09:50:00.000Z',
        }),
        o('C', { status: 'venter' }),
      ],
    };
    const l = K2.aktiveLinjer(ko, naa);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatch(
      /^A {2}kjorer {2}K {2}ko\/A {2}migr 3600–3609 {2}head abcdef12 {2}alder 45 min$/,
    );
    expect(l[1]).toMatch(/B {2}review .* alder 4 t 0 min, levert for 10 min siden/);
    expect(K2.aktiveLinjer({ oppgaver: [] })[0]).toMatch(/Ingen aktive/);
  });

  it('neste-migr: aldri bakover, aldri ned i et brukt nummer', () => {
    const ko = { oppgaver: [o('A', { migr_blokk: '3600–3619' }), o('B')] };
    expect(K2.hoyesteBlokkNr(ko)).toBe(3619);
    expect(K2.nesteMigrVakt({ naa: 3620, ny: 3700, hoyesteFil: 3605, hoyesteBlokk: 3619 })).toEqual(
      { ok: true, feil: null },
    );
    expect(
      K2.nesteMigrVakt({ naa: 3620, ny: 3610, hoyesteFil: 3605, hoyesteBlokk: 3619 }).feil,
    ).toMatch(/bakover/);
    // Like høy som neste_migr, men en fil over den er allerede brukt (manuell migrasjon utenfor køen).
    expect(K2.nesteMigrVakt({ naa: 3620, ny: 3620, hoyesteFil: 3650 }).feil).toMatch(
      /høyeste brukte nummer 3650/,
    );
    expect(K2.nesteMigrVakt({ naa: 3620, ny: 1.5 }).ok).toBe(false);
  });
});

describe('ko.mjs flett, info, aktive, endre --tillegg og neste-migr (mot kopier)', () => {
  it('flett med injisert kjører: push mot tillatt miljø, stopp ellers, ingen push uten migrasjoner', () => {
    const mappe = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-ork2-'));
    midlertidige.push(mappe);
    const repo = path.join(mappe, 'repo');
    const scratch = path.join(mappe, 'scratch');
    fs.mkdirSync(repo);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const skrivFil = (fil: string, tekst: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, fil)), { recursive: true });
      fs.writeFileSync(path.join(repo, fil), tekst);
      g(['add', '--', fil]);
    };
    g(['init', '-q', '-b', 'main']);
    skrivFil('README.md', 'start\n');
    g(['commit', '-q', '-m', 'start']);
    const head = g(['rev-parse', 'main']);
    g(['switch', '-q', '-c', 'ko/M']);
    skrivFil('db/migrasjoner/3600_m.sql', 'select 1;\n');
    g(['commit', '-q', '-m', 'M']);
    g(['switch', '-q', 'main']);
    g(['switch', '-q', '-c', 'ko/K']);
    skrivFil('lib/k.ts', 'export const k = 1;\n');
    g(['commit', '-q', '-m', 'K']);
    g(['switch', '-q', 'main']);
    const konfigFil = path.join(mappe, 'ko.config.json');
    fs.writeFileSync(
      konfigFil,
      JSON.stringify({
        migrasjoner: {
          mappe: 'db/migrasjoner',
          blokkStorrelse: 10,
          pushKommando: 'node migr-push.js',
          miljoFil: '.miljo',
          tillatteMiljo: ['test'],
        },
      }),
    );
    const settMiljo = (m: string) => fs.writeFileSync(path.join(repo, '.miljo'), m);
    fs.writeFileSync(
      path.join(mappe, 'ko.json'),
      JSON.stringify({
        opprettet: NAA,
        grenser: {},
        neste_migr: 3610,
        avklart: [],
        oppgaver: [
          o('M', {
            klasse: 'D',
            status: 'review',
            gren: 'ko/M',
            migr_blokk: '3600–3609',
            head_start: head,
            scratchpad: scratch,
            startet: NAA,
          }),
          o('K', {
            status: 'review',
            gren: 'ko/K',
            head_start: head,
            scratchpad: scratch,
            startet: NAA,
          }),
          o('V', { status: 'venter' }),
        ],
      }),
    );
    // Den injiserte kjøreren: husker kallene og svarer fra et scenario per steg.
    const kallFil = path.join(mappe, 'kall.jsonl');
    const scenarioFil = path.join(mappe, 'scenario.json');
    const kjorerFil = path.join(mappe, 'kjorer.mjs');
    fs.writeFileSync(
      kjorerFil,
      [
        "import fs from 'node:fs';",
        'export default function kjor(x) {',
        '  fs.appendFileSync(process.env.FLETT_TEST_KALL, JSON.stringify({ steg: x.steg, cmd: x.cmd, args: x.args }) + "\\n");',
        "  const sc = JSON.parse(fs.readFileSync(process.env.FLETT_TEST_SCENARIO, 'utf8'));",
        "  return sc[x.steg] ?? { kode: 0, ut: 'ok' };",
        '}',
      ].join('\n'),
    );
    const env = {
      ...process.env,
      KO_MAPPE: mappe,
      KO_KONFIG: konfigFil,
      KO_GIT: repo,
      KO_TIDSLOGG: path.join(mappe, 'tider.jsonl'),
      KO_TRANSKRIPTER: path.join(mappe, 'transkripter'),
      KO_FLETT_KJORER: kjorerFil,
      FLETT_TEST_KALL: kallFil,
      FLETT_TEST_SCENARIO: scenarioFil,
    };
    const kjor = (...args: string[]) => {
      const r = spawnSync(
        process.execPath,
        [path.join(ROT, 'scripts', 'orkestrator', 'ko.mjs'), ...args],
        {
          encoding: 'utf8',
          env,
        },
      );
      return { kode: r.status, ut: r.stdout, feil: r.stderr };
    };
    const kall = () => {
      const t = fs.existsSync(kallFil) ? fs.readFileSync(kallFil, 'utf8') : '';
      fs.rmSync(kallFil, { force: true });
      return t
        .split('\n')
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as { steg: string; cmd: string; args: string[] },
        );
    };
    fs.writeFileSync(
      scenarioFil,
      JSON.stringify({
        flett: { kode: 0, ut: 'Flettet og committet: abc M' },
        'migr-push': { kode: 0, ut: 'Kjører 3600_m.sql\nFerdig: 1 migrasjon.' },
        gater: { kode: 0, ut: 'gater: OK' },
        ferdig: { kode: 0, ut: 'M: ferdig' },
        fyll: { kode: 0, ut: 'Ingenting kan startes nå (se vis og tilstand).' },
      }),
    );

    // Miljø utenfor tillatteMiljo: STOPP før pushen, ingen push-kall, full logg skrevet.
    settMiljo('produksjon');
    const p = kjor('flett', 'M');
    expect(p.kode).toBe(1);
    expect(p.ut).toMatch(/STOPP i steget migr-push: .*produksjon/);
    expect(kall().map((x) => x.steg)).toEqual(['flett']);
    expect(fs.readFileSync(path.join(scratch, 'flett-M.log'), 'utf8')).toMatch(/===== flett: /);

    // Tillatt miljø: hele løpet, flett-spor med --bolge-base, pushkommandoen fra konfigen, sett ferdig og fyll.
    settMiljo('test');
    const s = kjor('flett', 'M');
    expect(s.feil).toBe('');
    expect(s.kode).toBe(0);
    expect(s.ut).toMatch(/FLETT M \(ko\/M\): flett → migr-push → gater → ferdig → fyll/);
    expect(s.ut).toMatch(/migrasjonspush: OK \(miljø test\): Ferdig: 1 migrasjon\./);
    expect(s.ut.split('\n').filter(Boolean).length).toBeLessThanOrEqual(15);
    const k1 = kall();
    expect(k1.map((x) => x.steg)).toEqual(['flett', 'migr-push', 'gater', 'ferdig', 'fyll']);
    expect(k1[0].args.slice(1)).toEqual(['ko/M', '--bolge-base', head]);
    expect(k1[1]).toMatchObject({ cmd: 'node migr-push.js', args: [] });
    // Gatene får grenens skillepunkt og tupp, så regel 1 i «kjent rød» virker etter flettingen.
    expect(k1[2].args.slice(1, 6)).toEqual([
      '--rask',
      '--spor-base',
      head,
      '--spor-tupp',
      g(['rev-parse', 'ko/M']),
    ]);
    expect(k1[3].args.slice(1, 4)).toEqual(['sett', 'M', 'ferdig']);
    expect(k1[4].args.slice(1)).toEqual(['fyll', '--scratchpad', scratch]);

    // Uten migrasjoner: ingen push, og miljøet spiller ingen rolle; --uten-fyll hopper over fyll.
    settMiljo('produksjon');
    const u = kjor('flett', 'K', '--uten-fyll');
    expect(u.kode).toBe(0);
    expect(kall().map((x) => x.steg)).toEqual(['flett', 'gater', 'ferdig']);

    // Feil status: venter kan ikke flettes.
    expect(kjor('flett', 'V').feil).toMatch(/flett gjelder review/);

    // info, aktive, endre --tillegg og neste-migr.
    expect(kjor('info', 'M', '--felt', 'gren').ut.trim()).toBe('ko/M');
    expect(kjor('info', 'M').ut).toMatch(/^migr_blokk: 3600–3609$/m);
    expect(kjor('info', 'M', '--felt', 'finnes').kode).toBe(1);
    expect(kjor('aktive').ut).toMatch(/^M {2}review {2}D {2}ko\/M/m);
    const t = kjor('endre', 'M', '--tillegg', 'Husk proben x.');
    expect(t.kode).toBe(0);
    expect(t.ut).toMatch(/M endret: tillegg, merknader/);
    expect(kjor('info', 'M', '--felt', 'tillegg').ut).toMatch(/Husk proben x\./);
    expect(kjor('endre', 'M', '--tillegg', ' ').kode).toBe(1);
    expect(kjor('neste-migr').ut).toMatch(/neste_migr 3610/);
    expect(kjor('neste-migr', '3605').feil).toMatch(/bakover/);
    expect(kjor('neste-migr', '3640').ut).toMatch(/neste_migr 3610 → 3640/);
  });
});
