// =============================================================
// koSky.test.ts: køoppgaver i skyøkter.
//
// Skyøkta på claude.ai ser bare det som er pushet og har ingen database. Reglene bevises der de håndheves:
//   - de rene funksjonene i lib/koLogikk.js (skyEgnet, skyPakke/skyBuntPakke, skyBunter, skyStart/Ferdig/Avbryt),
//   - ko.mjs (sky-pakke, sky start/ferdig/avbryt) mot en kopi av køen i en midlertidig mappe (KO_MAPPE), et
//     midlertidig git-repo med en falsk origin (KO_GIT, en bare-mappe i os.tmpdir()) og en midlertidig tidslogg
//     (KO_TIDSLOGG). Aldri hovedrepoet, aldri den ekte køen, og uten `git config` (identiteten gis med -c).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Oppgave = {
  id: string;
  tittel?: string;
  domene?: string;
  klasse: 'K' | 'D' | 'D+' | 'U';
  status: string;
  oppdrag?: string;
  nytte?: number;
  innhold_min?: number;
  migr_tiere?: number;
  avhenger?: string[];
  venter_paa?: string[];
  eier_filer?: string[];
  eier_db?: string[];
  delt_patch?: string[];
  prosjekt?: string;
  funksjon?: string;
  gren?: string;
  plukket_av?: string;
  plukket_at?: string;
  levert?: string;
  merknader?: string[];
  sky?: {
    startet: string;
    kjoring?: string;
    bunt?: string;
    ferdig?: string;
    gren?: string;
    sha?: string;
  };
};
type Ko = { oppgaver: Oppgave[]; avklart?: string[]; neste_migr?: number; prosjekter?: object };
type Egnet = { egnet: boolean; grunner: string[] };
type Del = { o: Oppgave; tekst: string; egenSti?: string | null };

// Konfigen testene kjører med: standardverdiene (basegren main, remote origin, grenprefiks ko/) pluss mapper skyen
// ikke ser. Settes før koLogikk leser konfigen første gang.
const KONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-sky-konfig-'));
const KONFIG_FIL = path.join(KONFIG_DIR, 'ko.config.json');
fs.writeFileSync(KONFIG_FIL, JSON.stringify({ skyUsynlig: ['docs/privat', 'notater'] }));
process.env.KO_KONFIG = KONFIG_FIL;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../koLogikk') as {
  nullstillKonfig: () => void;
  SKY_MAKS: number;
  SKY_BUNT_MAKS: number;
  SKY_BUNT_MIN: number;
  erSky: (o: Oppgave) => boolean;
  skyReferanser: (
    tekst: string,
    v?: { id?: string; egenSti?: string | null },
  ) => { sti: string; omrade: string; loftet: boolean }[];
  skyEgnet: (
    ko: Ko,
    id: string,
    v?: {
      pushetHead?: string | null;
      endret?: string[];
      oppdragTekst?: string;
      egenSti?: string | null;
    },
  ) => Egnet;
  skyPakke: (o: Oppgave, ko: Ko, v: { tekst: string; egenSti?: string | null }) => string;
  skyBuntPakke: (deler: Del[], ko: Ko) => string;
  skyBuntTak: (o: Oppgave[], v?: { maks?: number; maksMin?: number }) => string[];
  skyBunter: (
    k: { id: string; prosjekt: string; funksjon?: string | null; anslag: number; score: number }[],
    v?: { maks?: number; maksMin?: number },
  ) => { ider: string[]; minutter: number; omrader: string[] }[];
  skyOkter: (ko: Ko) => number;
  skyStart: (
    ko: Ko,
    ider: string | string[],
    v?: {
      egnethet?: Record<string, Egnet>;
      kjoring?: string | null;
      tving?: boolean;
      naa?: string;
    },
  ) => { feil?: string; nye?: string[]; igjen?: string[]; overstyrt?: string[] };
  skyFerdig: (
    ko: Ko,
    id: string,
    v?: { gren?: string; sha?: string | null; naa?: string },
  ) => {
    feil?: string;
  };
  skyAvbryt: (
    ko: Ko,
    id: string,
    v?: { commits?: number },
  ) => { feil?: string; advarsel?: string | null };
  slipp: (ko: Ko, id: string) => { feil?: string };
};

const NAA = '2026-10-01T10:00:00.000Z';
const HEAD = 'a'.repeat(40);

/** En ventende K-oppgave uten migrasjoner og DB: egnet for sky når ingenting annet er sagt. */
function o(id: string, ekstra: Partial<Oppgave> = {}): Oppgave {
  return {
    id,
    tittel: `Oppgave ${id}`,
    domene: 'verktoy',
    klasse: 'K',
    status: 'venter',
    nytte: 5,
    innhold_min: 30,
    migr_tiere: 0,
    avhenger: [],
    venter_paa: [],
    eier_filer: [`lib/${id}.ts`],
    eier_db: [],
    delt_patch: [],
    oppdrag: `# ${id}\nGjør ${id}.\nmer tekst`,
    ...ekstra,
  };
}
const ko = (...oppgaver: Oppgave[]): Ko => ({ oppgaver, avklart: [], neste_migr: 2840 });
const egnet = (k: Ko, id: string, v: Parameters<typeof K.skyEgnet>[2] = {}) =>
  K.skyEgnet(k, id, { pushetHead: HEAD, endret: [], ...v });

// ---- Egnethet ---------------------------------------------------------------------------------------------------
describe('skyEgnet', () => {
  it('en ventende K-oppgave uten migrasjoner, DB og hindringer er egnet; U også', () => {
    expect(egnet(ko(o('A')), 'A')).toEqual({ egnet: true, grunner: [] });
    expect(egnet(ko(o('A', { klasse: 'U' })), 'A').egnet).toBe(true);
  });

  it('D, D+, migrasjoner, eier_db og delt_patch gir hver sin grunn', () => {
    const r = egnet(
      ko(o('A', { klasse: 'D', migr_tiere: 1, eier_db: ['fn_x'], delt_patch: ['anonymize_user'] })),
      'A',
    );
    expect(r.egnet).toBe(false);
    expect(r.grunner).toHaveLength(4);
    expect(r.grunner.join('\n')).toMatch(/klasse D/);
    expect(r.grunner.join('\n')).toMatch(/migrasjoner/);
    expect(r.grunner.join('\n')).toMatch(/fn_x/);
    expect(r.grunner.join('\n')).toMatch(/anonymize_user/);
    expect(egnet(ko(o('A', { klasse: 'D+' })), 'A').egnet).toBe(false);
  });

  it('åpne avhengigheter og eierspørsmål stopper; avklart og ferdig gjør det ikke', () => {
    const k = ko(o('A', { avhenger: ['B'], venter_paa: ['Ø1'] }), o('B'));
    const r = egnet(k, 'A');
    expect(r.grunner.some((g) => g.includes('åpen avhengighet') && g.includes('B'))).toBe(true);
    expect(r.grunner.some((g) => g.includes('åpent eierspørsmål: Ø1'))).toBe(true);
    k.oppgaver[1].status = 'ferdig';
    k.avklart = ['Ø1'];
    expect(egnet(k, 'A').egnet).toBe(true);
  });

  it('henvisninger til mapper i konfig().skyUsynlig stopper', () => {
    K.nullstillKonfig();
    for (const sti of ['docs/privat/notat.md', 'C:\\prosjekt\\notater\\x.md', 'notater/y.ts']) {
      const r = egnet(ko(o('A')), 'A', { oppdragTekst: `Les \`${sti}\` først.` });
      expect(r.egnet).toBe(false);
      expect(r.grunner.join(' ')).toMatch(/filer skyen ikke ser/);
    }
  });

  it('egen oppdragsfil og en kildelinje der det bindende er «løftet inn» stopper ikke', () => {
    const tekst = [
      'Kilde: `C:\\prosjekt\\docs\\privat\\plan.md` (GITIGNORERT; alt bindende er løftet inn her)',
      'Se også scripts/.ko/oppdrag/A.md (denne fila).',
    ].join('\n');
    expect(egnet(ko(o('A')), 'A', { oppdragTekst: tekst }).egnet).toBe(true);
    expect(
      egnet(ko(o('A')), 'A', {
        oppdragTekst: 'Les scripts/.ko/oppdrag/eget.md',
        egenSti: 'scripts/.ko/oppdrag/eget.md',
      }).egnet,
    ).toBe(true);
    // En annen oppgaves oppdrag er kontekst: pakken forklarer at fila ikke finnes, og den stenger
    // ikke.
    expect(egnet(ko(o('A')), 'A', { oppdragTekst: 'Se scripts/.ko/oppdrag/B.md' }).egnet).toBe(
      true,
    );
  });

  it('eierfiler endret lokalt siden origin/main («push først»), også under en eid mappe', () => {
    const r = egnet(ko(o('A', { eier_filer: ['lib/a/', 'lib/b.ts'] })), 'A', {
      endret: ['lib/a/x.ts', 'annet.ts'],
    });
    expect(r.egnet).toBe(false);
    expect(r.grunner.join(' ')).toMatch(/lib\/a\/x\.ts.*push main først/);
    expect(egnet(ko(o('A')), 'A', { endret: ['annet.ts'] }).egnet).toBe(true);
  });

  it('uten origin/main kan det ikke sjekkes: ikke egnet', () => {
    const r = K.skyEgnet(ko(o('A')), 'A', { pushetHead: null });
    expect(r.egnet).toBe(false);
    expect(r.grunner.join(' ')).toMatch(/origin\/main/);
  });

  it('kjørende og plukkede er ikke egnet; en oppgave i sky er det fortsatt (pakka kan kopieres igjen)', () => {
    expect(egnet(ko(o('A', { status: 'kjorer' })), 'A').grunner).toEqual(['status kjorer']);
    expect(egnet(ko(o('A', { status: 'plukket', plukket_av: 'eier' })), 'A').egnet).toBe(false);
    const sky = o('A', { status: 'plukket', plukket_av: 'sky', sky: { startet: NAA } });
    expect(egnet(ko(sky), 'A').egnet).toBe(true);
  });
});

// ---- Pakka -----------------------------------------------------------------------------------------------------
describe('skyPakke og skyBuntPakke', () => {
  it('én oppgave: oppdraget i sin helhet med sporblokka, grenregelen, lock-regelen og rapportlinja', () => {
    const a = o('A', { kilde: 'plan § 1' } as Partial<Oppgave>);
    const tekst =
      '# A\nHele oppdraget.\nAndre linje.\nLes docs/privat/x.md (alt bindende er løftet inn).';
    const p = K.skyPakke(a, ko(a), { tekst });
    expect(p).toMatch(/^# SKYSPOR A \(klasse K, ca\. 30 min\)/);
    expect(p).toContain('git checkout -b ko/A origin/main');
    expect(p).toContain('Push bare grenen ko/A');
    expect(p).toMatch(/Aldri main, aldri PR/);
    expect(p).toContain('package-lock.json');
    expect(p).toContain('«SKY-FERDIG A <sha>» eller «SKY-STOPP A <grunn>»');
    expect(p).toContain('## SPOR A (Oppgave A; kilde: plan § 1; klasse K, anslag 30 min)');
    expect(p).toContain('**Eierskap i køen:** filer lib/A.ts; DB ingen; delt patch ingen.');
    expect(p).toContain('stopp med SKY-STOPP');
    expect(p).not.toContain('SendMessage');
    expect(p).toContain('Hele oppdraget.\nAndre linje.');
    // Henvisningen skyen ikke kan følge, forklares.
    expect(p).toMatch(/Filer skyen ikke ser.*docs\/privat\/x\.md/);
  });

  it('bunt: rekkefølgen holdes, egen gren per oppgave fra origin/main, rapportlinje per oppgave og samlelinja', () => {
    const [a, b, c] = [o('A'), o('B'), o('C')];
    const k = ko(a, b, c);
    const p = K.skyBuntPakke(
      [
        { o: c, tekst: 'Oppdrag C' },
        { o: a, tekst: 'Oppdrag A' },
        { o: b, tekst: 'Oppdrag B' },
      ],
      k,
    );
    expect(p).toMatch(/^# SKYBUNT C, A, B \(3 oppgaver, ca\. 90 min\)/);
    expect(p).toContain('C → A → B');
    expect(p).toContain('git checkout -b ko/<id> origin/main');
    expect(p).toMatch(/aldri fra forrige\s+oppgaves gren/);
    expect(p).toContain('«SKY-FERDIG <id> <sha>»');
    expect(p).toContain('«SKY-STOPP <id> <grunn>»');
    expect(p).toContain('En stopp hindrer ikke de neste');
    expect(p).toContain('«SKY-BUNT-FERDIG <antall SKY-FERDIG>/3»');
    expect(p).toContain('package-lock.json');
    const i = (s: string) => p.indexOf(s);
    expect(i('# Oppgave 1 av 3: C (gren ko/C)')).toBeGreaterThan(0);
    expect(i('# Oppgave 1 av 3: C')).toBeLessThan(i('# Oppgave 2 av 3: A'));
    expect(i('# Oppgave 2 av 3: A')).toBeLessThan(i('# Oppgave 3 av 3: B'));
    expect(i('Oppdrag C')).toBeLessThan(i('Oppdrag A'));
  });

  it('bunt med én oppgave er vanlig skypakke', () => {
    const a = o('A');
    expect(K.skyBuntPakke([{ o: a, tekst: 'x' }], ko(a))).toBe(
      K.skyPakke(a, ko(a), { tekst: 'x' }),
    );
  });

  it('taket: høyst 4 oppgaver, ca. 120 min og ingen id to ganger', () => {
    expect(K.SKY_BUNT_MAKS).toBe(4);
    expect(K.SKY_BUNT_MIN).toBe(120);
    expect(K.skyBuntTak([o('A'), o('B'), o('C'), o('D')])).toEqual([]);
    expect(K.skyBuntTak([o('A'), o('B'), o('C'), o('D'), o('E')]).join(' ')).toMatch(/5 oppgaver/);
    expect(
      K.skyBuntTak([o('A', { innhold_min: 70 }), o('B', { innhold_min: 60 })]).join(' '),
    ).toMatch(/130 min/);
    expect(K.skyBuntTak([o('A'), o('A')]).join(' ')).toMatch(/to ganger/);
  });

  it('forslag til bunter: samme område etter hverandre, beste prioritet først, taket holdes', () => {
    const k = (id: string, prosjekt: string, score: number, anslag = 30) => ({
      id,
      prosjekt,
      funksjon: null,
      anslag,
      score,
    });
    const b = K.skyBunter([
      k('X1', 'x', 50),
      k('Y1', 'y', 90),
      k('X2', 'x', 40),
      k('Y2', 'y', 10),
      k('Z1', 'z', 5, 200),
    ]);
    expect(b.map((x) => x.ider)).toEqual([['Y1', 'Y2', 'X1', 'X2'], ['Z1']]);
    expect(b[0].minutter).toBe(120);
    expect(b[0].omrader).toEqual(['y', 'x']);
    expect(K.skyBunter([k('A', 'p', 1), k('B', 'p', 2)], { maks: 1 }).map((x) => x.ider)).toEqual([
      ['B'],
      ['A'],
    ]);
  });
});

// ---- Status ----------------------------------------------------------------------------------------------------
describe('skyStart, skyFerdig og skyAvbryt', () => {
  it('start plukker for «sky» med gren ko/<id> og sky.startet/kjoring; ferdig gir review; avbryt gir venter', () => {
    const k = ko(o('A'));
    const r = K.skyStart(k, 'A', { kjoring: 'cse_1', naa: NAA });
    expect(r.feil).toBeUndefined();
    const a = k.oppgaver[0];
    expect(a).toMatchObject({ status: 'plukket', plukket_av: 'sky', gren: 'ko/A' });
    expect(a.sky).toEqual({ startet: NAA, kjoring: 'cse_1' });
    expect(K.erSky(a)).toBe(true);

    expect(
      K.skyFerdig(k, 'A', { gren: 'claude/x', sha: 'abc1234', naa: NAA }).feil,
    ).toBeUndefined();
    expect(a.status).toBe('review');
    expect(a.levert).toBe(NAA);
    expect(a.sky).toMatchObject({ ferdig: NAA, gren: 'claude/x', sha: 'abc1234' });
    expect(K.skyFerdig(k, 'A').feil).toMatch(/står ikke i en skyøkt/);

    const k2 = ko(o('B'));
    K.skyStart(k2, 'B', { naa: NAA });
    expect(K.skyAvbryt(k2, 'B').feil).toBeUndefined();
    expect(k2.oppgaver[0].status).toBe('venter');
    expect(k2.oppgaver[0].sky).toBeUndefined();
    expect(k2.oppgaver[0].plukket_av).toBeUndefined();
    expect(k2.oppgaver[0].merknader?.join(' ')).toMatch(/skyøkt avbrutt/);
  });

  it('ikke egnet, over taket og fire skyøkter nekter; --tving overstyrer', () => {
    const k = ko(o('A'));
    const ikke = { A: { egnet: false, grunner: ['klasse D'] } };
    expect(K.skyStart(k, 'A', { egnethet: ikke }).feil).toMatch(/ikke egnet.*klasse D.*--tving/);
    expect(k.oppgaver[0].status).toBe('venter');
    expect(K.skyStart(k, 'A', { egnethet: ikke, tving: true }).overstyrt).toContain(
      'A er ikke egnet for sky: klasse D',
    );

    const fem = ko(o('A'), o('B'), o('C'), o('D'), o('E'));
    expect(K.skyStart(fem, ['A', 'B', 'C', 'D', 'E']).feil).toMatch(/over taket/);

    const mange = ko(o('A'), o('B'), o('C'), o('D'));
    for (const id of ['A', 'B', 'C']) expect(K.skyStart(mange, id).feil).toBeUndefined();
    expect(K.skyOkter(mange)).toBe(3);
    expect(K.skyStart(mange, 'D').feil).toMatch(/3 skyøkter går allerede/);
    expect(K.skyStart(mange, 'D', { tving: true }).feil).toBeUndefined();
  });

  it('en bunt er én skyøkt; samme id igjen setter bare kjøringen', () => {
    const k = ko(o('A'), o('B'), o('C'));
    const r = K.skyStart(k, ['A', 'B', 'C'], { naa: NAA });
    expect(r.nye).toEqual(['A', 'B', 'C']);
    expect(K.skyOkter(k)).toBe(1);
    expect(k.oppgaver[0].sky?.bunt).toBe('A,B,C');
    const igjen = K.skyStart(k, ['A', 'B', 'C'], { kjoring: 'cse_9' });
    expect(igjen.igjen).toEqual(['A', 'B', 'C']);
    expect(k.oppgaver.every((x) => x.sky?.kjoring === 'cse_9')).toBe(true);
    expect(K.skyOkter(k)).toBe(1);
  });

  it('en vanlig slipp fjerner også sky-feltet', () => {
    const k = ko(o('A'));
    K.skyStart(k, 'A');
    K.slipp(k, 'A');
    expect(k.oppgaver[0].sky).toBeUndefined();
  });
});

// ---- ko.mjs mot en kopi og en falsk origin ------------------------------------------------------------------------
const ROT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=ko-test', '-c', 'user.email=ko-test@example.invalid'];
const rydd: string[] = [];
afterAll(() => {
  for (const r of [...rydd, KONFIG_DIR]) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* Windows kan holde en fil et øyeblikk; os.tmpdir ryddes uansett */
    }
  }
});

function tmp(prefiks: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefiks));
  rydd.push(d);
  return d;
}

describe('ko.mjs sky-pakke og sky start/ferdig/avbryt (kopi av køen, falsk origin)', () => {
  it('pakke, bunt, start, ferdig fra en annen gren, avbryt og tidsloggen', () => {
    const origin = tmp('ko-sky-origin-');
    const repo = tmp('ko-sky-repo-');
    const mappe = tmp('ko-sky-mappe-');
    const logg = path.join(mappe, 'tider.jsonl');
    const g = (args: string[], cwd = repo) =>
      execFileSync('git', ['-C', cwd, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const commit = (fil: string, tekst: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, fil)), { recursive: true });
      fs.writeFileSync(path.join(repo, fil), tekst);
      g(['add', '--', fil]);
      g(['commit', '-q', '-m', `endre ${fil}`]);
    };
    g(['init', '-q', '--bare'], origin);
    g(['init', '-q', '-b', 'main']);
    commit('README.md', 'start\n');
    g(['remote', 'add', 'origin', origin]);
    g(['push', '-q', 'origin', 'main']);
    g(['fetch', '-q', 'origin']);
    // Lokalt endret og ikke pushet: eierfila til C.
    commit('lib/C.ts', 'lokal\n');

    const oppdragA = path.join(mappe, 'A.md');
    fs.writeFileSync(oppdragA, '# A\nHele oppdraget for A.\n');
    fs.writeFileSync(
      path.join(mappe, 'ko.json'),
      JSON.stringify({
        opprettet: NAA,
        grenser: {},
        neste_migr: 2840,
        avklart: [],
        oppgaver: [o('A', { oppdrag: oppdragA }), o('B'), o('C'), o('D', { klasse: 'D' })],
      }),
    );
    const env = { ...process.env, KO_MAPPE: mappe, KO_GIT: repo, KO_TIDSLOGG: logg };
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
    const les = (): Ko => JSON.parse(fs.readFileSync(path.join(mappe, 'ko.json'), 'utf8'));
    const finn = (id: string) => les().oppgaver.find((x) => x.id === id)!;

    // sky-pakke: oppdraget fra fila, grenregelen og rapportlinja; nekter for D og for lokalt endret eierfil.
    const p = kjor('sky-pakke', 'A');
    expect(p.kode).toBe(0);
    expect(p.ut).toContain('Hele oppdraget for A.');
    expect(p.ut).toContain('git checkout -b ko/A origin/main');
    expect(p.ut).toContain('«SKY-FERDIG A <sha>»');
    const d = kjor('sky-pakke', 'D');
    expect(d.kode).toBe(1);
    expect(d.feil).toMatch(/klasse D/);
    const c = kjor('sky-pakke', 'C');
    expect(c.kode).toBe(1);
    expect(c.feil).toMatch(/lib\/C\.ts.*push main først/);
    expect(kjor('sky-pakke', 'D', '--tving').kode).toBe(0);
    // Bunt til fil.
    const ut = path.join(mappe, 'bunt.md');
    expect(kjor('sky-pakke', 'A', 'B', '--ut', ut).kode).toBe(0);
    const bunt = fs.readFileSync(ut, 'utf8');
    expect(bunt).toMatch(/^# SKYBUNT A, B/);
    expect(bunt).toContain('SKY-BUNT-FERDIG <antall SKY-FERDIG>/2');

    // sky start (bunt) med kjøring; D nektes.
    expect(kjor('sky', 'start', 'D').kode).toBe(1);
    const s = kjor('sky', 'start', 'A', 'B', '--kjoring', 'cse_test');
    expect(s.kode).toBe(0);
    expect(finn('A')).toMatchObject({ status: 'plukket', plukket_av: 'sky', gren: 'ko/A' });
    expect(finn('A').sky).toMatchObject({ kjoring: 'cse_test', bunt: 'A,B' });

    // sky ferdig: grenen finnes ikke på origin → nekter og står i sky.
    const mangler = kjor('sky', 'ferdig', 'A');
    expect(mangler.kode).toBe(1);
    expect(finn('A').status).toBe('plukket');

    // Skyen pushet til claude/jolly-x (ikke ko/A): én commit over origin/main.
    g(['checkout', '-q', '-b', 'sky-arbeid', 'origin/main']);
    commit('lib/A.ts', 'fra skyen\n');
    g(['push', '-q', 'origin', 'sky-arbeid:claude/jolly-x']);
    const sha = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    g(['branch', '-q', '-D', 'sky-arbeid']);

    const f = kjor('sky', 'ferdig', 'A', '--gren', 'claude/jolly-x', '--sha', sha.slice(0, 10));
    expect(f.kode).toBe(0);
    expect(f.ut).toContain('flett-spor.mjs ko/A');
    expect(f.ut).toContain('git push origin --delete claude/jolly-x');
    expect(finn('A').status).toBe('review');
    expect(finn('A').sky).toMatchObject({ gren: 'claude/jolly-x', sha: sha.slice(0, 10) });
    // Lokal ko/A står på skyens commit, så flett-spor og «Merge branch 'ko/A'» virker som for et lokalt spor.
    expect(g(['rev-parse', 'ko/A'])).toBe(sha);

    // Feil sha nekter (B står fortsatt i sky).
    g(['push', '-q', 'origin', `${sha}:refs/heads/ko/B`]);
    expect(kjor('sky', 'ferdig', 'B', '--sha', 'deadbee').kode).toBe(1);
    // avbryt = slipp.
    expect(kjor('sky', 'avbryt', 'B').kode).toBe(0);
    expect(finn('B').status).toBe('venter');
    expect(finn('B').sky).toBeUndefined();

    const hendelser = fs
      .readFileSync(logg, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((r) => `${r.spor} ${r.hendelse}`);
    expect(hendelser).toEqual(
      expect.arrayContaining(['A sky-start', 'B sky-start', 'A sky-ferdig', 'B sky-avbrutt']),
    );
  }, 120_000);
});
