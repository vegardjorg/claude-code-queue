// =============================================================
// kontekstVakt.test.ts: avviklingstrinnet og komprimeringen i kontekstvakta.
//
// Reglene håndheves i lib/kontekstVakt.js (hook-kontekst.mjs) og koLogikk.avviklingVakt/startVakt (ko.mjs).
// Testene beviser dem der: de rene funksjonene, hooken kjørt som prosess med et falskt transkript, og ko.mjs mot en
// kopi av køen i en midlertidig mappe (KO_MAPPE), aldri den ekte.
//   - Ikke-orkestrator: varsel fra 250k, stopp ved 400k.
//   - Orkestrator: avvikling ved 350k (flagg i markøren), stopp først ved 550k.
//   - <task-notification> og <agent-message> stoppes aldri (ellers fryser køen).
//   - `start`/`neste`/`fyll` nekter under avvikling (exit 6); ny økt (nytt --okt-navn eller ny binding) nullstiller.
//   - Komprimering er standard. KOMPAKT ved 280k etter hver komprimering (ingen fast
//     grense som utløser rotasjon), AVVIKLING ber om komprimering, ikke rotasjon, og modusen (manuell eller automatisk
//     komprimering, `ko.mjs kompakt auto|manuell`) står i hook-meldingene og på tavla.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Markor = {
  okt: string;
  oppdatert: string;
  hendelse?: string | null;
  okt_id?: string;
  okt_id_tid?: number;
  avvikling?: { fra: string; kontekst: number | null; okt_id: string };
};
type Beslutning = { handling: string; settAvvikling: boolean; grense?: number };
type G = {
  varsel: number;
  stopp: number;
  avvikling: number;
  stoppOrk: number;
  kompakt: number;
};
type Modus = 'auto' | 'manuell';
type Sporsmal = { sp: string; tekst?: string | null; anbefaling?: string | null };

/* eslint-disable @typescript-eslint/no-require-imports */
const KV = require('../kontekstVakt') as {
  STANDARD: G;
  grenser: (env?: Record<string, string | undefined>) => G;
  erSystemmelding: (p: string) => boolean;
  sisteOrkestratorKall: (tekst: string) => number | null;
  orkestratorBinding: (inn: {
    markor: Markor | null;
    sessionId: string | null;
    sisteKall: number | null;
    naa?: number;
  }) => { orkestrator: boolean; markor: Markor | null; endret: boolean };
  iAvvikling: (m: Markor | null, s: string) => boolean;
  vurder: (inn: {
    n: number | null;
    prompt: string;
    orkestrator: boolean;
    iAvvikling?: boolean;
    komprimeringer?: number;
    g?: G;
  }) => Beslutning;
  KOMPAKT_KOMMANDO: string;
  OVERLEVERING_LAPP: string;
  kompaktModus: (ko: unknown) => Modus;
  forKompaktInstruks: () => string;
  tellKomprimeringer: (tekst: string) => number;
  etterKompaktBundet: (inn: { markor: Markor | null; sessionId: string | null }) => boolean;
  utenAvvikling: (m: Markor | null, s: string) => { markor: Markor | null; endret: boolean };
  etterKompaktTekst: (inn: {
    vis: string;
    sporsmal: Sporsmal[];
    upushet: number | null;
    komprimeringer: number;
    avviklingOpphevet?: boolean;
    modus?: Modus;
    g?: G;
    maksTegn?: number;
  }) => string;
  medAvvikling: (m: Markor, inn: { sessionId: string; n: number; naa?: number }) => Markor;
  hookUtdata: (
    b: Beslutning,
    inn: {
      n: number;
      orkestrator: boolean;
      g?: G;
      naa?: number;
      komprimeringer?: number;
      modus?: Modus;
    },
  ) => Record<string, unknown> | null;
};
const L = require('../koLogikk') as {
  avviklingVakt: (m: Markor | null, naa?: number) => { aktiv: boolean; stopp: boolean };
  startVakt: (
    ko: unknown,
    forbruk?: number,
    valg?: { naa?: number; tving?: boolean; markor?: Markor | null },
  ) => { kode: number; stopp: string } | null;
  tilstand: (
    ko: unknown,
    forbruk?: number,
    valg?: { naa?: number; markor?: Markor | null },
  ) => { kanStarte: number; stopp?: string };
  nyMarkor: (
    forrige: Markor | null,
    valg: { okt?: string; hendelse?: string; naa?: string },
  ) => Markor;
  GRENSE_NAVN: string[];
  tolkGrense: (navn: string, raa: string) => { verdi?: unknown; feil?: string };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const NAA = Date.parse('2026-10-07T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const markor = (felt: Partial<Markor> = {}): Markor => ({
  okt: 'ko A',
  oppdatert: iso(NAA - 5 * MIN),
  hendelse: 'puls',
  ...felt,
});
const g = KV.STANDARD;

describe('vurder: tersklene', () => {
  const v = (n: number, orkestrator: boolean, prompt = 'hei', iAvvikling = false) =>
    KV.vurder({ n, prompt, orkestrator, iAvvikling, g });

  it('ikke-orkestrator: ingenting under 250k, varsel fra 250k, stopp ved 400k', () => {
    expect(v(249_999, false).handling).toBe('ingen');
    expect(v(250_000, false).handling).toBe('varsel');
    expect(v(399_999, false).handling).toBe('varsel');
    expect(v(400_000, false)).toMatchObject({ handling: 'stopp', grense: 400_000 });
    expect(v(600_000, false).settAvvikling).toBe(false);
  });

  it('orkestrator: varsel fra 250k, avvikling (flagg settes én gang) ved 350k, stopp først ved 550k', () => {
    expect(v(279_999, true).handling).toBe('varsel');
    expect(v(300_000, true).handling).toBe('kompakt');
    expect(v(350_000, true)).toEqual({ handling: 'avvikling', settAvvikling: true });
    expect(v(450_000, true, 'hei', true)).toEqual({ handling: 'avvikling', settAvvikling: false });
    expect(v(549_999, true, 'hei', true).handling).toBe('avvikling');
    expect(v(550_000, true, 'hei', true)).toMatchObject({ handling: 'stopp', grense: 550_000 });
    // Hopper konteksten rett over 550k, settes flagget likevel.
    expect(v(560_000, true).settAvvikling).toBe(true);
  });

  it('task-notification og agent-message stoppes aldri, heller ikke over den harde grensen', () => {
    const tn = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>';
    const am = '<agent-message from="a28a2efcb1203133e"> [Subagent hand-back] …';
    expect(KV.erSystemmelding(tn)).toBe(true);
    expect(KV.erSystemmelding(am)).toBe(true);
    expect(KV.erSystemmelding('hei <task-notification>')).toBe(false);
    expect(v(900_000, false, tn).handling).toBe('varsel');
    expect(v(900_000, false, am).handling).toBe('varsel');
    expect(v(900_000, true, tn, true).handling).toBe('avvikling');
    expect(v(900_000, true, am).settAvvikling).toBe(true);
  });

  it('«fortsett:» slipper gjennom', () => {
    expect(v(450_000, false, 'fortsett: skriv lappen').handling).toBe('varsel');
    expect(v(600_000, true, '  Fortsett: lapp').handling).toBe('avvikling');
  });

  it('grensene kan overstyres med miljøvariabler; ugyldige gir standard', () => {
    expect(
      KV.grenser({
        KONTEKST_AVVIKLING: '300000',
        KONTEKST_STOPP_ORK: '500000',
        KONTEKST_STOPP: 'x',
      }),
    ).toEqual({
      varsel: 250_000,
      stopp: 400_000,
      avvikling: 300_000,
      stoppOrk: 500_000,
      kompakt: 280_000,
    });
    expect(KV.grenser({ KONTEKST_KOMPAKT: '260000' })).toMatchObject({ kompakt: 260_000 });
    // Ingen fast grense for antall komprimeringer lenger.
    expect(KV.grenser({ KONTEKST_MAKS_KOMPAKT: '0' })).not.toHaveProperty('maksKompakt');
  });

  it('hookUtdata: block bare ved stopp; avvikling gir instruks med lappens sti', () => {
    expect(
      KV.hookUtdata({ handling: 'ingen', settAvvikling: false }, { n: 1, orkestrator: false }),
    ).toBeNull();
    const stopp = KV.hookUtdata(v(400_000, false), { n: 400_000, orkestrator: false, g });
    expect(stopp).toMatchObject({ decision: 'block' });
    const av = KV.hookUtdata(v(360_000, true), { n: 360_000, orkestrator: true, g, naa: NAA });
    expect(av).not.toHaveProperty('decision');
    const ctx = (av as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(ctx).toContain(KV.OVERLEVERING_LAPP);
    expect(KV.OVERLEVERING_LAPP).toMatch(/\/overlevering-lopende\.md$/);
    expect(ctx).toMatch(/start INGEN nye oppgaver/);
  });
});

describe('KOMPAKT: /compact med fokus før avvikling', () => {
  const grense = JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'x' });
  const v = (n: number, komprimeringer: number, prompt = 'hei', iAvvikling = false) =>
    KV.vurder({ n, prompt, orkestrator: true, iAvvikling, komprimeringer, g });

  it('tellKomprimeringer teller bare ekte compact_boundary-rader', () => {
    expect(KV.tellKomprimeringer('')).toBe(0);
    const sitat = JSON.stringify({
      type: 'user',
      message: { content: 'tell "subtype":"compact_boundary"-rader' },
    });
    const kompaktSpaced = '{"type": "system", "subtype": "compact_boundary"}';
    const tekst = [
      '{"type":"user"}',
      grense,
      sitat,
      'ødelagt {"subtype":"compact_boundary"',
      grense,
    ];
    expect(KV.tellKomprimeringer(tekst.join('\n'))).toBe(2);
    expect(KV.tellKomprimeringer(`${grense}\n${kompaktSpaced}\n`)).toBe(2);
  });

  it('orkestrator: kompakt fra 280k etter hver komprimering, avvikling først ved 350k', () => {
    expect(v(279_999, 0).handling).toBe('varsel');
    expect(v(280_000, 0)).toEqual({ handling: 'kompakt', settAvvikling: false });
    expect(v(349_999, 1)).toEqual({ handling: 'kompakt', settAvvikling: false });
    // Ingen fast grense for antall komprimeringer: syklusen starter på nytt hver gang.
    expect(v(280_000, 2)).toEqual({ handling: 'kompakt', settAvvikling: false });
    expect(v(300_000, 7)).toEqual({ handling: 'kompakt', settAvvikling: false });
    // Nødbremsen: eieren har ikke komprimert, så avviklingen kommer ved 350k uansett antall.
    expect(v(350_000, 1)).toEqual({ handling: 'avvikling', settAvvikling: true });
    expect(v(350_000, 5)).toEqual({ handling: 'avvikling', settAvvikling: true });
    expect(v(360_000, 3, 'hei', true)).toEqual({ handling: 'avvikling', settAvvikling: false });
    expect(v(550_000, 0, 'hei', true)).toMatchObject({ handling: 'stopp', grense: 550_000 });
  });

  it('ikke-orkestrator er uendret av komprimeringer', () => {
    const w = (n: number, k: number) =>
      KV.vurder({ n, prompt: 'hei', orkestrator: false, komprimeringer: k, g }).handling;
    expect(w(300_000, 0)).toBe('varsel');
    expect(w(300_000, 5)).toBe('varsel');
    expect(w(400_000, 0)).toBe('stopp');
  });

  it('systemmeldinger stoppes aldri, heller ikke i KOMPAKT-trinnet', () => {
    const tn = '<task-notification><task-id>a1</task-id>';
    const am = '<agent-message from="a1"> [Subagent hand-back]';
    expect(v(300_000, 0, tn).handling).toBe('kompakt');
    expect(v(300_000, 2, am).handling).toBe('kompakt');
    expect(v(900_000, 0, am).handling).toBe('avvikling');
    expect(v(900_000, 2, tn, true).handling).toBe('avvikling');
  });

  type Ut = {
    systemMessage: string;
    reason?: string;
    hookSpecificOutput: { additionalContext: string };
  };
  const ut = (n: number, komprimeringer: number, modus: 'auto' | 'manuell' = 'manuell') =>
    KV.hookUtdata(v(n, komprimeringer), {
      n,
      orkestrator: true,
      g,
      naa: NAA,
      komprimeringer,
      modus,
    }) as Ut;

  it('hookUtdata for kompakt (manuell): ferdig /compact-linje, lappen, ingen rotasjon, ingen block', () => {
    const u = ut(300_000, 1);
    expect(u).not.toHaveProperty('decision');
    expect(KV.KOMPAKT_KOMMANDO).toMatch(/^\/compact behold: /);
    expect(KV.KOMPAKT_KOMMANDO).toContain(KV.OVERLEVERING_LAPP);
    expect(u.systemMessage).toContain(KV.KOMPAKT_KOMMANDO);
    expect(u.systemMessage).toMatch(/komprimering nr\. 2/);
    expect(u.systemMessage).toMatch(/manuell/);
    expect(u.systemMessage).not.toMatch(/roter|nytt vindu/i);
    expect(u.systemMessage).not.toContain('—');
    const ctx = u.hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/fullfør/i);
    expect(ctx).toMatch(/kan ikke kjøre \/compact selv/);
    expect(ctx).toContain(KV.OVERLEVERING_LAPP);
    // Etter mange komprimeringer: samme beskjed, aldri rotasjon.
    expect(ut(300_000, 6).systemMessage).toContain(KV.KOMPAKT_KOMMANDO);
  });

  it('hookUtdata for kompakt (auto): komprimeringen kommer av seg selv, linja er reserve', () => {
    const u = ut(300_000, 0, 'auto');
    expect(u.systemMessage).toMatch(/automatisk/i);
    expect(u.systemMessage).toContain(KV.KOMPAKT_KOMMANDO);
    expect(u.hookSpecificOutput.additionalContext).toContain(KV.OVERLEVERING_LAPP);
    expect(u.hookSpecificOutput.additionalContext).toMatch(/automatisk/i);
  });

  it('hookUtdata for avvikling: «komprimer nå» med ferdig linje; ny økt bare som nødløsning', () => {
    for (const k of [0, 2, 5]) {
      const u = ut(360_000, k);
      expect(u.systemMessage).toContain(KV.KOMPAKT_KOMMANDO);
      expect(u.systemMessage).toMatch(/komprimer nå/i);
      expect(u.systemMessage).toMatch(/nødløsning/);
      expect(u.systemMessage).not.toMatch(/Roter økta/);
      expect(u.hookSpecificOutput.additionalContext).toMatch(/oppheves/);
    }
    expect(ut(360_000, 0, 'auto').systemMessage).toMatch(/automatisk/i);
  });

  it('hookUtdata for stopp: orkestratoren bes komprimere, andre økter får ny økt', () => {
    const ork = KV.hookUtdata(v(560_000, 0), { n: 560_000, orkestrator: true, g }) as Ut;
    expect(ork.reason).toContain(KV.KOMPAKT_KOMMANDO);
    expect(ork.reason).toMatch(/nødløsning/);
    const andre = KV.hookUtdata(KV.vurder({ n: 410_000, prompt: 'hei', orkestrator: false, g }), {
      n: 410_000,
      orkestrator: false,
      g,
    }) as Ut;
    expect(andre.reason).toMatch(/ny økt/i);
    expect(andre.reason).not.toContain('/compact behold');
  });

  it('kompaktModus: grenser.autokompakt i køfila, standard manuell', () => {
    expect(KV.kompaktModus(null)).toBe('manuell');
    expect(KV.kompaktModus({})).toBe('manuell');
    expect(KV.kompaktModus({ grenser: { autokompakt: false } })).toBe('manuell');
    expect(KV.kompaktModus({ grenser: { autokompakt: true } })).toBe('auto');
    expect(L.GRENSE_NAVN).toContain('autokompakt');
    expect(L.tolkGrense('autokompakt', 'på')).toEqual({ verdi: true });
    expect(L.tolkGrense('autokompakt', 'auto')).toEqual({ verdi: true });
    expect(L.tolkGrense('autokompakt', 'manuell')).toEqual({ verdi: false });
    expect(L.tolkGrense('autokompakt', 'kanskje')).toHaveProperty('feil');
  });

  it('forKompaktInstruks: fokus for oppsummeringen (PreCompact), med lappen', () => {
    const t = KV.forKompaktInstruks();
    expect(t).toContain(KV.OVERLEVERING_LAPP);
    expect(t).toMatch(/aktive spor/);
    expect(t).toMatch(/eierspørsmål/);
  });

  it('etterKompaktBundet: bare økta markøren er bundet til', () => {
    expect(KV.etterKompaktBundet({ markor: markor({ okt_id: 's1' }), sessionId: 's1' })).toBe(true);
    expect(KV.etterKompaktBundet({ markor: markor({ okt_id: 's1' }), sessionId: 's2' })).toBe(
      false,
    );
    expect(KV.etterKompaktBundet({ markor: markor(), sessionId: 's1' })).toBe(false);
    expect(KV.etterKompaktBundet({ markor: null, sessionId: 's1' })).toBe(false);
    expect(KV.etterKompaktBundet({ markor: markor({ okt_id: 's1' }), sessionId: null })).toBe(
      false,
    );
  });

  it('utenAvvikling: fjerner bare økta sin egen avvikling', () => {
    const av = { fra: iso(NAA), kontekst: 360_000, okt_id: 's1' };
    const m = markor({ okt_id: 's1', avvikling: av });
    expect(KV.utenAvvikling(m, 's1')).toEqual({ markor: markor({ okt_id: 's1' }), endret: true });
    expect(KV.utenAvvikling(m, 's2')).toEqual({ markor: m, endret: false });
    expect(KV.utenAvvikling(markor({ okt_id: 's1' }), 's1').endret).toBe(false);
  });

  it('etterKompaktTekst: køtilstand, åpne spørsmål og upushede commits, innenfor taket', () => {
    const t = KV.etterKompaktTekst({
      vis: 'AKTIVE (1):\n  X  kjorer  ko/X',
      sporsmal: [{ sp: 'Ø1', tekst: 'Skal vi?', anbefaling: 'ja' }],
      upushet: 4,
      base: 'main',
      komprimeringer: 1,
      avviklingOpphevet: true,
      g,
    });
    expect(t).toMatch(/^\[hook-etter-kompakt\]/);
    expect(t).toContain('AKTIVE (1):');
    expect(t).toContain('Ø1: Skal vi? (anbefaling: ja)');
    expect(t).toContain('Upushede commits på main: 4');
    expect(t).toMatch(/komprimering nr\. 1/);
    expect(t).toMatch(/avvikling.*opphevet/i);
    expect(t).toMatch(/manuell/);
    // Gjenopptaksinstruksen: lappen, puls, motta, fyll, uten å vente på eieren.
    expect(t).toMatch(/GJENOPPTA/);
    expect(t).toContain(KV.OVERLEVERING_LAPP);
    expect(t).toContain('ko.mjs orkestrator puls');
    expect(t).toContain('ko.mjs motta');
    expect(t).toContain('ko.mjs fyll');
    expect(t).toMatch(/uten å vente på eieren/);
    const lang = KV.etterKompaktTekst({
      vis: 'x'.repeat(50_000),
      sporsmal: [],
      upushet: null,
      komprimeringer: 5,
      modus: 'auto',
      g,
    });
    expect(lang.length).toBeLessThanOrEqual(12_000);
    expect(lang).toContain('Upushede commits på basegrenen: ukjent');
    // Ingen fast grense: heller ikke etter 5 komprimeringer er rotasjon neste steg.
    expect(lang).not.toMatch(/roter|nytt vindu/i);
    expect(lang).toMatch(/automatisk/i);
    expect(lang).toMatch(/GJENOPPTA/);
    expect(lang).toContain('Ingen åpne eierspørsmål');
  });
});

describe('orkestratorBinding: hvem er orkestratoren', () => {
  it('ingen markør, utløpt markør eller ingen session_id: ikke orkestrator', () => {
    expect(
      KV.orkestratorBinding({ markor: null, sessionId: 's1', sisteKall: NAA, naa: NAA })
        .orkestrator,
    ).toBe(false);
    const utlopt = markor({ oppdatert: iso(NAA - 3 * 60 * MIN) });
    expect(
      KV.orkestratorBinding({ markor: utlopt, sessionId: 's1', sisteKall: NAA, naa: NAA })
        .orkestrator,
    ).toBe(false);
    expect(
      KV.orkestratorBinding({ markor: markor(), sessionId: null, sisteKall: NAA, naa: NAA })
        .orkestrator,
    ).toBe(false);
  });

  it('økt uten orkestratorkall blir ikke orkestrator', () => {
    const r = KV.orkestratorBinding({
      markor: markor(),
      sessionId: 's1',
      sisteKall: null,
      naa: NAA,
    });
    expect(r).toMatchObject({ orkestrator: false, endret: false });
  });

  it('første økt med ferskt kall binder markøren', () => {
    const r = KV.orkestratorBinding({
      markor: markor(),
      sessionId: 's1',
      sisteKall: NAA - MIN,
      naa: NAA,
    });
    expect(r).toMatchObject({ orkestrator: true, endret: true });
    expect(r.markor).toMatchObject({ okt_id: 's1', okt_id_tid: NAA - MIN });
  });

  it('bundet økt forblir orkestrator; en eldre økt med eldre kall tar den ikke', () => {
    const m = markor({ okt_id: 's2', okt_id_tid: NAA - 2 * MIN });
    expect(
      KV.orkestratorBinding({ markor: m, sessionId: 's2', sisteKall: null, naa: NAA }).orkestrator,
    ).toBe(true);
    expect(
      KV.orkestratorBinding({ markor: m, sessionId: 's1', sisteKall: NAA - 30 * MIN, naa: NAA })
        .orkestrator,
    ).toBe(false);
  });

  it('ny økt med nyere kall tar over og nullstiller forrige økts avvikling', () => {
    const m = KV.medAvvikling(markor({ okt_id: 's1', okt_id_tid: NAA - 30 * MIN }), {
      sessionId: 's1',
      n: 360_000,
      naa: NAA - 20 * MIN,
    });
    expect(L.avviklingVakt(m, NAA).stopp).toBe(true);
    const r = KV.orkestratorBinding({ markor: m, sessionId: 's2', sisteKall: NAA - MIN, naa: NAA });
    expect(r).toMatchObject({ orkestrator: true, endret: true });
    expect(r.markor?.okt_id).toBe('s2');
    expect(r.markor?.avvikling).toBeUndefined();
    expect(L.avviklingVakt(r.markor, NAA).stopp).toBe(false);
    expect(KV.iAvvikling(m, 's1')).toBe(true);
    expect(KV.iAvvikling(m, 's2')).toBe(false);
  });

  it('sisteOrkestratorKall: finner siste puls/start/fyll i transkriptet, ikke sett eller sky start', () => {
    const linje = (ts: string, cmd: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] },
      });
    const t = [
      'kuttet {"type":"assist',
      linje('2026-10-07T10:00:00Z', 'node scripts/orkestrator/ko.mjs orkestrator puls --okt "x"'),
      linje('2026-10-07T10:05:00Z', 'node scripts/orkestrator/ko.mjs fyll --scratchpad s'),
      linje('2026-10-07T10:10:00Z', 'node scripts/orkestrator/ko.mjs sett A ferdig'),
      linje('2026-10-07T10:11:00Z', 'node scripts/orkestrator/ko.mjs sky start B'),
    ].join('\n');
    expect(KV.sisteOrkestratorKall(t)).toBe(Date.parse('2026-10-07T10:05:00Z'));
    expect(KV.sisteOrkestratorKall(linje('2026-10-07T10:00:00Z', 'ko.mjs vis'))).toBeNull();
  });
});

describe('koLogikk: avviklingsvakt og markør', () => {
  const ko = {
    oppgaver: [
      { id: 'A', tittel: 'A', domene: 'klient', klasse: 'K', status: 'venter', oppdrag: 'x' },
    ],
  };
  const iAvv = KV.medAvvikling(markor({ okt_id: 's1' }), { sessionId: 's1', n: 360_000, naa: NAA });

  it('start/neste nekter med exit 6 under avvikling; --tving overstyrer; utløpt markør teller ikke', () => {
    expect(L.startVakt(ko, 0, { naa: NAA, markor: iAvv })).toMatchObject({
      kode: 6,
      stopp: 'avvikling',
    });
    expect(L.startVakt(ko, 0, { naa: NAA, markor: iAvv, tving: true })).toBeNull();
    expect(L.startVakt(ko, 0, { naa: NAA + 3 * 60 * MIN, markor: iAvv })).toBeNull();
    expect(L.startVakt(ko, 0, { naa: NAA, markor: markor() })).toBeNull();
    const t = L.tilstand(ko, 0, { naa: NAA, markor: iAvv });
    expect(t).toMatchObject({ kanStarte: 0, stopp: 'avvikling' });
  });

  it('nyMarkor: samme økt beholder binding og avvikling; nytt navn (ny økt) nullstiller', () => {
    const naa = iso(NAA + MIN);
    const samme = L.nyMarkor(iAvv, { hendelse: 'sett A ferdig', naa });
    expect(samme.avvikling).toEqual(iAvv.avvikling);
    expect(samme.okt_id).toBe('s1');
    const ny = L.nyMarkor(iAvv, { okt: 'ko B', hendelse: 'puls', naa });
    expect(ny.avvikling).toBeUndefined();
    expect(ny.okt_id).toBeUndefined();
    expect(ny.okt_id_tid).toBe(NAA + MIN);
    // Etter overtakelsen kan ikke den gamle økta binde seg med et eldre kall.
    expect(
      KV.orkestratorBinding({
        markor: ny,
        sessionId: 's1',
        sisteKall: NAA - MIN,
        naa: NAA + 2 * MIN,
      }).orkestrator,
    ).toBe(false);
  });
});

// ---- Prosesser: hooken og ko.mjs mot en midlertidig kø (aldri den ekte) ----
describe('hook-kontekst.mjs og ko.mjs: avviklingstrinnet ende til ende', () => {
  const ORK = join(__dirname, '..', '..');
  let mappe: string;

  const env = () => ({
    ...process.env,
    KO_MAPPE: mappe,
    KO_GIT: mappe,
    KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
    KONTEKST_VARSEL: '',
    KONTEKST_STOPP: '',
    KONTEKST_AVVIKLING: '',
    KONTEKST_STOPP_ORK: '',
    KONTEKST_KOMPAKT: '',
    KOSTVAKT_AV: '1',
  });
  function kjor(fil: string, args: string[], input?: string) {
    try {
      const ut = execFileSync(process.execPath, [join(ORK, fil), ...args], {
        env: env(),
        encoding: 'utf8',
        input,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      return { kode: 0, ut, feil: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { kode: x.status, ut: String(x.stdout ?? ''), feil: String(x.stderr ?? '') };
    }
  }
  /** Transkript: et orkestratorkall nå og en brukstelling på `n` tokens. */
  function transkript(n: number, medKall = true, komprimeringer = 0) {
    const naa = new Date().toISOString();
    const linjer = [
      ...Array.from({ length: komprimeringer }, () =>
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: naa }),
      ),
      medKall
        ? JSON.stringify({
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
          })
        : '{}',
      JSON.stringify({
        type: 'assistant',
        timestamp: naa,
        message: {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, cache_read_input_tokens: n - 1 },
        },
      }),
    ];
    const sti = join(mappe, `t-${n}-${medKall}-${komprimeringer}.jsonl`);
    writeFileSync(sti, linjer.join('\n') + '\n');
    return sti;
  }
  const hook = (
    sessionId: string,
    n: number,
    prompt: string,
    medKall = true,
    komprimeringer = 0,
  ) => {
    const r = kjor(
      'hook-kontekst.mjs',
      [],
      JSON.stringify({
        session_id: sessionId,
        transcript_path: transkript(n, medKall, komprimeringer),
        prompt,
      }),
    );
    return r.ut ? JSON.parse(r.ut) : null;
  };
  const lesMarkor = (): Markor => JSON.parse(readFileSync(join(mappe, 'orkestrator.json'), 'utf8'));

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-avvikling-'));
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({
        oppgaver: [
          { id: 'A', tittel: 'A', domene: 'klient', klasse: 'K', status: 'venter', oppdrag: 'x' },
        ],
        grenser: { maksSamtidig: 5, maksDPluss: 2, maksPerDomene: 7, maksDb: 5 },
        neste_migr: 100,
      }),
    );
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('ikke-orkestrator stoppes ved 400k; task-notification slipper gjennom', () => {
    expect(hook('s9', 410_000, 'hei', false)).toMatchObject({ decision: 'block' });
    expect(
      hook('s9', 410_000, '<task-notification><task-id>x</task-id>', false),
    ).not.toHaveProperty('decision');
    expect(existsSync(join(mappe, 'orkestrator.json'))).toBe(false);
  });

  it('orkestrator: 360k setter avvikling, start/neste/fyll nekter (exit 6), ny økt nullstiller', () => {
    expect(kjor('ko.mjs', ['orkestrator', 'puls', '--okt', 'ko A']).kode).toBe(0);
    // Under grensen: ingen utskrift, men markøren bindes til økta.
    expect(hook('s1', 100_000, 'hei')).toBeNull();
    expect(lesMarkor().okt_id).toBe('s1');
    const ut = hook('s1', 360_000, 'hei');
    expect(ut).not.toHaveProperty('decision');
    expect(ut.hookSpecificOutput.additionalContext).toMatch(/AVVIKLING/);
    expect(lesMarkor().avvikling).toMatchObject({ okt_id: 's1', kontekst: 360_000 });
    // 450k: orkestratoren stoppes ikke før 550k.
    expect(hook('s1', 450_000, 'hei')).not.toHaveProperty('decision');
    expect(hook('s1', 560_000, 'hei')).toMatchObject({ decision: 'block' });

    const neste = kjor('ko.mjs', ['neste']);
    expect(neste.kode).toBe(6);
    expect(neste.feil).toMatch(/AVVIKLING/);
    expect(kjor('ko.mjs', ['start', 'A']).kode).toBe(6);
    expect(kjor('ko.mjs', ['fyll', '--scratchpad', join(mappe, 's')]).kode).toBe(6);
    // sett påvirkes ikke, og samme økt beholder avviklingen (puls uten nytt navn).
    expect(kjor('ko.mjs', ['orkestrator', 'puls']).kode).toBe(0);
    expect(lesMarkor().avvikling).toBeDefined();

    // Ny økt tar markøren med nytt navn: avviklingen er borte, og start går.
    expect(kjor('ko.mjs', ['orkestrator', 'puls', '--okt', 'ko B']).kode).toBe(0);
    expect(lesMarkor().avvikling).toBeUndefined();
    expect(kjor('ko.mjs', ['neste']).kode).toBe(0);
  });

  it('KOMPAKT: 300k gir /compact-forslag uten avvikling, også etter mange komprimeringer', () => {
    expect(kjor('ko.mjs', ['orkestrator', 'puls', '--okt', 'ko A']).kode).toBe(0);
    const ut = hook('s1', 300_000, 'hei');
    expect(ut).not.toHaveProperty('decision');
    expect(ut.systemMessage).toContain('/compact behold:');
    expect(lesMarkor().avvikling).toBeUndefined();
    expect(kjor('ko.mjs', ['neste']).kode).toBe(0);
    // Ikke-orkestrator ved 300k: bare varsel, aldri kompakt-forslag.
    expect(hook('s9', 300_000, 'hei', false).systemMessage).not.toContain('/compact');
    // Samme økt etter tre komprimeringer: fortsatt bare et kompakt-forslag, ingen avvikling.
    const igjen = hook('s1', 300_000, 'hei', true, 3);
    expect(igjen.systemMessage).toContain('/compact behold:');
    expect(igjen.hookSpecificOutput.additionalContext).not.toMatch(/AVVIKLING/);
    expect(lesMarkor().avvikling).toBeUndefined();
    expect(kjor('ko.mjs', ['neste']).kode).toBe(0);
  });

  it('ko.mjs kompakt auto|manuell: modusen lagres i køfila og vises i hook-meldingen', () => {
    expect(kjor('ko.mjs', ['orkestrator', 'puls', '--okt', 'ko A']).kode).toBe(0);
    const vis = kjor('ko.mjs', ['kompakt']);
    expect(vis.kode).toBe(0);
    expect(vis.ut).toMatch(/manuell/);
    const auto = kjor('ko.mjs', ['kompakt', 'auto']);
    expect(auto.kode).toBe(0);
    expect(auto.ut).toContain('/autocompact');
    const lesKo = () => JSON.parse(readFileSync(join(mappe, 'ko.json'), 'utf8'));
    expect(lesKo().grenser.autokompakt).toBe(true);
    expect(hook('s1', 300_000, 'hei').systemMessage).toMatch(/automatisk/i);
    expect(kjor('ko.mjs', ['kompakt', 'manuell']).kode).toBe(0);
    expect(lesKo().grenser.autokompakt).toBe(false);
    expect(hook('s1', 300_000, 'hei').systemMessage).toMatch(/manuell/);
    expect(kjor('ko.mjs', ['kompakt', 'kanskje']).kode).toBe(1);
  });

  it('hook-etter-kompakt: køtilstand bare for den bundne økta, opphever avviklingen', () => {
    const etter = (sessionId: string, source = 'compact', komprimeringer = 1) => {
      const r = kjor(
        'hook-etter-kompakt.mjs',
        [],
        JSON.stringify({
          session_id: sessionId,
          source,
          transcript_path: transkript(120_000, true, komprimeringer),
        }),
      );
      expect(r.kode).toBe(0);
      return r.ut ? JSON.parse(r.ut) : null;
    };
    expect(etter('s1')).toBeNull(); // ingen markør
    expect(kjor('ko.mjs', ['orkestrator', 'puls', '--okt', 'ko A']).kode).toBe(0);
    hook('s1', 360_000, 'hei');
    expect(lesMarkor().avvikling).toBeDefined();
    expect(etter('s2')).toBeNull(); // annen økt
    expect(etter('s1', 'startup')).toBeNull(); // ikke en komprimering
    const ut = etter('s1');
    expect(ut.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = ut.hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^\[hook-etter-kompakt\]/);
    expect(ctx).toContain('AKTIVE');
    expect(ctx).toMatch(/Upushede commits på \S+: ukjent/);
    expect(ctx).toMatch(/GJENOPPTA/);
    expect(ctx.length).toBeLessThanOrEqual(12_000);
    expect(lesMarkor().avvikling).toBeUndefined();
    expect(kjor('ko.mjs', ['neste']).kode).toBe(0);
  });

  it('hook-etter-kompakt som PreCompact: fokus på stdout bare for den bundne økta', () => {
    const forKompakt = (sessionId: string) =>
      kjor(
        'hook-etter-kompakt.mjs',
        [],
        JSON.stringify({ session_id: sessionId, hook_event_name: 'PreCompact', trigger: 'auto' }),
      );
    expect(forKompakt('s1').ut).toBe('');
    expect(kjor('ko.mjs', ['orkestrator', 'puls', '--okt', 'ko A']).kode).toBe(0);
    hook('s1', 100_000, 'hei');
    const r = forKompakt('s1');
    expect(r.kode).toBe(0);
    expect(r.ut).toContain('overlevering-lopende.md');
    expect(forKompakt('s2').ut).toBe('');
  });

  it('orkestrator stopp fjerner markøren og dermed avviklingen', () => {
    expect(kjor('ko.mjs', ['orkestrator', 'puls', '--okt', 'ko A']).kode).toBe(0);
    hook('s1', 360_000, 'hei');
    expect(kjor('ko.mjs', ['start', 'A']).kode).toBe(6);
    expect(kjor('ko.mjs', ['orkestrator', 'stopp']).kode).toBe(0);
    expect(kjor('ko.mjs', ['start', 'A']).kode).toBe(0);
  });
});
