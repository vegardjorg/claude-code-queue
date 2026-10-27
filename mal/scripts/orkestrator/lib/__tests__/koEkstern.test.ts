// =============================================================
// koEkstern.test.ts: arbeidskøen, arbeid utenfor køen og push-sjekk.
//
// - Klassifisering av commits på main: flett av ko/<id> = kø, traileren «Ko: orkestrator» = orkestrator, resten
//   ekstern; id-samsvar i meldingen; kuttpunkt for push-sjekken (finnes / finnes ikke).
// - Kollisjoner mellom eierfilene og eksterne commits (bare etter lagt_til), grener utenfor ko/* og ucommittede filer.
// - `ekstern add`/`ferdig` (rad med status ekstern som eier filer som en plukket oppgave), `ekstern godta`.
// - `neste` hopper over oppgaver som kolliderer med ucommittede filer i hovedtreet.
// - Orkestrator-markøren (aktiv / utløpt etter 2 t).
//
// Git-delene kjører mot et MIDLERTIDIG repo (`git -C <tmp>` i os.tmpdir()), aldri hovedrepoet, og uten `git config`:
// identiteten gis med `-c` per kommando.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Oppgave = {
  id: string;
  tittel?: string;
  domene: string;
  klasse: 'K' | 'D' | 'D+' | 'U';
  status: string;
  oppdrag?: string;
  eier_filer?: string[];
  eier_db?: string[];
  delt_patch?: string[];
  avhenger?: string[];
  venter_paa?: string[];
  lagt_til?: string;
  plukket_av?: string;
  etiketter?: string[];
  prosjekt?: string;
  funksjon?: string;
  ekstern?: boolean;
  ekstern_navn?: string;
  gren?: string;
  merknader?: string[];
  qa_status?: string;
  gjort_utenfor_koen?: string;
};
type Ko = {
  oppgaver: Oppgave[];
  avklart?: string[];
  grenser?: Record<string, number>;
  prosjekter?: Record<string, { tittel: string; prefikser?: string[] }>;
  neste_migr?: number;
};
type Commit = {
  sha: string;
  kort: string;
  foreldre: string[];
  dato: string;
  emne: string;
  melding: string;
  filer: string[];
  kilde?: string;
  ko_id?: string;
  side?: Commit[];
};
type Kollisjon = {
  id: string;
  status: string;
  fil: string;
  eier: string;
  kilde: string;
  sha?: string;
  gren?: string;
};
type Plan = {
  totalt: number;
  ko: number;
  orkestrator: number;
  eksterne: { sha: string }[];
  kuttpunkt: string | null;
  sammenflettet: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const K = require('../koLogikk') as {
  klassifiserCommit: (c: Partial<Commit>) => { kilde: string; ko_id?: string };
  nevnteIder: (tekst: string, ider: string[]) => string[];
  samsvar: (
    eksterne: Partial<Commit>[],
    oppgaver: Oppgave[],
  ) => { id: string; status: string; forslag: string | null }[];
  pushPlan: (c: { sha: string; kilde: string }[]) => Plan;
  eksternKollisjoner: (
    oppgaver: Oppgave[],
    kilder: {
      commits?: Partial<Commit>[];
      grener?: { navn: string; filer: string[] }[];
      ucommittet?: string[];
    },
  ) => Kollisjon[];
  ucommittetKollisjon: (o: Oppgave, filer: string[]) => { fil: string; sti: string } | null;
  ucommittetHoppet: (ko: Ko, filer: string[]) => { id: string; sti: string }[];
  velgNeste: (ko: Ko, naa?: number, opt?: { ucommittet?: string[] }) => { id: string }[];
  tilstand: (
    ko: Ko,
    forbruk?: number,
    opt?: { ucommittet?: string[] },
  ) => { ekstern: number; blokkert: { id: string; hindringer: string[] }[] };
  hindringer: (o: Oppgave, alle: Oppgave[], avklart?: string[]) => string[];
  plukk: (ko: Ko, id: string, opt?: { av?: string }) => { feil?: string };
  settStatus: (o: Oppgave, status: string) => { feil?: string };
  prosjektOversikt: (ko: Ko) => { pid: string; totalt: number }[];
  eksternAdd: (
    ko: Ko,
    opt: { navn?: string; filer?: string[]; db?: string[]; gren?: string | null; naa?: string },
  ) => { feil?: string; rad?: Oppgave; ny?: boolean; advarsler?: string[] };
  eksternFerdig: (ko: Ko, navn: string) => { feil?: string; rad?: Oppgave };
  eksternGodta: (
    ko: Ko,
    id: string,
    sha: string,
    opt?: { nevnt?: boolean },
  ) => { feil?: string; oppgave?: Oppgave; qa?: boolean };
  orkestratorStatus: (
    m: unknown,
    naa?: number,
  ) => { aktiv: boolean; okt: string | null; grunn: string | null };
  nyMarkor: (
    forrige: unknown,
    opt: { okt?: string; hendelse?: string; naa?: string },
  ) => { okt: string };
  manglerProsjekt: (
    oppgaver: Oppgave[],
    register: Ko['prosjekter'],
  ) => { utenProsjekt: string[]; utenFunksjon: string[] };
  sporfilAdvarsel: (
    o: Oppgave,
    k: Kollisjon[],
    nevnt?: { kort: string; emne: string }[],
  ) => string | null;
  ORKESTRATOR_UTLOP_MS: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const G = require('../koGit') as {
  lagGit: (cwd: string) => (args: string[]) => string | null;
  lesForsteForeldre: (
    git: (args: string[]) => string | null,
    vindu: { fra?: string; til?: string; siden?: string },
  ) => Commit[] | null;
  klassifiser: (
    git: (args: string[]) => string | null,
    c: Commit[],
    opt?: { fra?: string },
  ) => Commit[];
  lesUcommittet: (
    git: (args: string[]) => string | null,
  ) => { xy: string; sti: string; usporet: boolean }[];
  lesAndreGrener: (
    git: (args: string[]) => string | null,
  ) => { navn: string; antall: number; filer: string[] }[];
  eksternBilde: (
    git: (args: string[]) => string | null,
    ko: Ko,
    opt: { vindu: { fra?: string; siden?: string } },
  ) => {
    eksterne: Commit[];
    samsvar: { id: string; forslag: string | null }[];
    kollisjoner: Kollisjon[];
    grener: { navn: string }[];
  };
  eksternForOppgaver: (
    git: (args: string[]) => string | null,
    oppgaver: Oppgave[],
  ) => Map<
    string,
    { kollisjoner: Kollisjon[]; nevnt: { kort: string }[]; advarsel: string | null }
  >;
};

const ROT = path.resolve(__dirname, '..', '..', '..', '..');
const o = (id: string, ekstra: Partial<Oppgave> = {}): Oppgave => ({
  id,
  tittel: `Oppgave ${id}`,
  domene: 'ui',
  klasse: 'K',
  status: 'venter',
  oppdrag: 'tekst',
  avhenger: [],
  venter_paa: [],
  eier_filer: [],
  eier_db: [],
  delt_patch: [],
  ...ekstra,
});
const LENGE_SIDEN = '2000-01-01T00:00:00.000Z';
const LANGT_FRAM = '2999-01-01T00:00:00.000Z';

// ---- Midlertidig git-repo (aldri hovedrepoet, aldri git config) --------------------------------------------------
const ID = ['-c', 'user.name=ko-test', '-c', 'user.email=ko-test@example.invalid'];
const repoer: string[] = [];
afterAll(() => {
  for (const r of repoer) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* Windows kan holde en fil et øyeblikk; os.tmpdir ryddes uansett */
    }
  }
});

function lagRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-ekstern-'));
  repoer.push(dir);
  let n = 0;
  const g = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', ['-C', dir, ...ID, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  // Faste, stigende tidspunkter (september 2026), så «etter lagt_til» er entydig.
  const tid = () => {
    n += 1;
    const d = new Date(Date.parse('2026-09-01T10:00:00Z') + n * 60_000).toISOString();
    return { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d };
  };
  const skriv = (fil: string, innhold: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, fil)), { recursive: true });
    fs.writeFileSync(path.join(dir, fil), innhold);
  };
  const commit = (fil: string, ...meldinger: string[]) => {
    skriv(fil, `${fil} ${n}\n`);
    g(['add', '--', fil]);
    g(['commit', '-q', ...meldinger.flatMap((m) => ['-m', m])], tid());
    return g(['rev-parse', 'HEAD']);
  };
  /** En kø-flett slik flett-spor.mjs lager den: ny gren ko/<id>, én commit, `merge --no-ff --no-edit`. */
  const koFlett = (id: string, fil: string) => {
    g(['checkout', '-q', '-b', `ko/${id}`]);
    commit(fil, `feat: ${id}`);
    g(['checkout', '-q', 'main']);
    g(['merge', '-q', '--no-ff', '--no-edit', `ko/${id}`], tid());
    return g(['rev-parse', 'HEAD']);
  };
  g(['init', '-q', '-b', 'main']);
  const base = commit('README.md', 'start');
  // origin/main uten remote: en ref er nok for push-sjekken.
  g(['update-ref', 'refs/remotes/origin/main', base]);
  return { dir, g, commit, koFlett, skriv, base, git: G.lagGit(dir) };
}

/** Første-forelder-linja i origin/main..main, klassifisert og eldst først (som push-sjekk.mjs). */
function plan(r: ReturnType<typeof lagRepo>) {
  const raa = G.lesForsteForeldre(r.git, { fra: 'origin/main' }) ?? [];
  return K.pushPlan(
    G.klassifiser(r.git, raa, { fra: 'origin/main' }).reverse() as {
      sha: string;
      kilde: string;
    }[],
  );
}

function kjor(skript: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(
    process.execPath,
    [path.join(ROT, 'scripts', 'orkestrator', skript), ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
  return { kode: r.status, ut: `${r.stdout}${r.stderr}` };
}

// ---- Rene funksjoner ----------------------------------------------------------------------------------------------
describe('klassifisering av commits på main', () => {
  it('kø-flett, orkestrator-trailer, ekstern, og flett av en annen gren er ekstern', () => {
    expect(
      K.klassifiserCommit({ foreldre: ['a', 'b'], emne: "Merge branch 'ko/A-T8c' into main" }),
    ).toEqual({
      kilde: 'ko',
      ko_id: 'A-T8c',
    });
    expect(
      K.klassifiserCommit({
        foreldre: ['a'],
        emne: 'chore(db): regenerer',
        melding: 'chore\n\nKo: orkestrator',
      }),
    ).toEqual({ kilde: 'orkestrator' });
    expect(
      K.klassifiserCommit({ foreldre: ['a'], emne: 'docs: plan', melding: 'docs: plan' }).kilde,
    ).toBe('ekstern');
    expect(
      K.klassifiserCommit({ foreldre: ['a', 'b'], emne: "Merge branch 'hotfix/x' into main" })
        .kilde,
    ).toBe('ekstern');
    // En ko/-emne uten flett (to foreldre) er ikke en kø-flett.
    expect(K.klassifiserCommit({ foreldre: ['a'], emne: "Merge branch 'ko/X'" }).kilde).toBe(
      'ekstern',
    );
  });

  it('id-samsvar: (A-T8c) og A-T8c: treffer, men ikke A-T8c2, A-T8c-QA1 eller XA-T8c', () => {
    const ider = ['A-T8c', 'A-T8'];
    expect(K.nevnteIder('fix: noe (A-T8c)', ider)).toEqual(['A-T8c']);
    expect(K.nevnteIder('A-T8c: ferdig', ider)).toEqual(['A-T8c']);
    expect(K.nevnteIder('A-T8c2 og A-T8c-QA1 og XA-T8c', ider)).toEqual([]);
    const s = K.samsvar(
      [{ sha: 'abcdef1234', emne: 'fix: gjort (A-T8c)', melding: '' }],
      [o('A-T8c'), o('A-T8', { status: 'ferdig' })],
    );
    expect(s).toEqual([
      expect.objectContaining({
        id: 'A-T8c',
        status: 'venter',
        forslag: 'ko.mjs ekstern godta A-T8c abcdef12',
      }),
    ]);
  });

  it('kuttpunkt: finnes når alle eksterne ligger etter køens, ellers ikke', () => {
    expect(
      K.pushPlan([
        { sha: 'k1', kilde: 'ko' },
        { sha: 'o1', kilde: 'orkestrator' },
      ]).eksterne,
    ).toEqual([]);
    const etter = K.pushPlan([
      { sha: 'k1', kilde: 'ko' },
      { sha: 'o1', kilde: 'orkestrator' },
      { sha: 'e1', kilde: 'ekstern' },
      { sha: 'e2', kilde: 'ekstern' },
    ]);
    expect(etter).toMatchObject({ kuttpunkt: 'o1', sammenflettet: false });
    const mellom = K.pushPlan([
      { sha: 'k1', kilde: 'ko' },
      { sha: 'e1', kilde: 'ekstern' },
      { sha: 'k2', kilde: 'ko' },
    ]);
    expect(mellom).toMatchObject({ kuttpunkt: null, sammenflettet: true });
    // Bare eksterne: ingenting fra køen å pushe alene.
    expect(K.pushPlan([{ sha: 'e1', kilde: 'ekstern' }])).toMatchObject({
      kuttpunkt: null,
      sammenflettet: false,
    });
  });
});

describe('kollisjoner med eierfilene', () => {
  const commit = {
    sha: 'c0ffee1234',
    emne: 'docs: endret plan',
    filer: ['docs/plan.md'],
    dato: '2026-09-30T10:00:00Z',
  };
  it('en ekstern commit teller bare for oppgaver lagt inn før den landet', () => {
    const k = K.eksternKollisjoner(
      [
        o('FØR', { eier_filer: ['docs/plan.md'], lagt_til: LENGE_SIDEN }),
        o('ETTER', { eier_filer: ['docs/plan.md'], lagt_til: LANGT_FRAM }),
        o('FERDIG', { eier_filer: ['docs/plan.md'], lagt_til: LENGE_SIDEN, status: 'ferdig' }),
      ],
      { commits: [commit] },
    );
    expect(k.map((x) => x.id)).toEqual(['FØR']);
    expect(k[0]).toMatchObject({ kilde: 'commit', fil: 'docs/plan.md', sha: 'c0ffee1234' });
  });

  it('grener, ucommittede filer og mapper (eier «mappe/», usporet «ny/»)', () => {
    const k = K.eksternKollisjoner(
      [
        o('KJ', { status: 'kjorer', eier_filer: ['src/lib/'], lagt_til: LANGT_FRAM }),
        o('V', { eier_filer: ['ny/fil.md', 'annet.md'], lagt_til: LANGT_FRAM }),
      ],
      { grener: [{ navn: 'hotfix/x', filer: ['src/lib/a.js'] }], ucommittet: ['ny/'] },
    );
    expect(k).toEqual([
      expect.objectContaining({
        id: 'KJ',
        kilde: 'gren',
        gren: 'hotfix/x',
        fil: 'src/lib/a.js',
        eier: 'src/lib/',
      }),
      expect.objectContaining({ id: 'V', kilde: 'ucommittet', fil: 'ny/', eier: 'ny/fil.md' }),
    ]);
    const tekst = K.sporfilAdvarsel(o('KJ'), [k[0]]);
    expect(tekst).toContain('git diff main...hotfix/x -- src/lib/a.js');
    expect(K.sporfilAdvarsel(o('X'), [])).toBeNull();
  });
});

describe('ekstern add / ferdig / godta', () => {
  it('en registrering eier filene som en plukket oppgave, til ekstern ferdig', () => {
    const ko: Ko = {
      oppgaver: [o('A', { eier_filer: ['docs/plan.md'] }), o('B', { eier_filer: ['b.md'] })],
      neste_migr: 2840,
    };
    const r = K.eksternAdd(ko, {
      navn: 'eier-økt 30.09',
      filer: ['docs/plan.md'],
      gren: 'hotfix/y',
    });
    expect(r.feil).toBeUndefined();
    expect(r.rad).toMatchObject({
      id: 'ekstern-eier-okt-30-09',
      status: 'ekstern',
      ekstern: true,
      gren: 'hotfix/y',
    });
    expect(r.advarsler?.join(' ')).toContain('A');
    expect(K.hindringer(ko.oppgaver[0], ko.oppgaver).join(' ')).toContain(
      'arbeid utenfor køen: eier-økt 30.09',
    );
    expect(K.velgNeste(ko).map((v) => v.id)).toEqual(['B']);
    expect(K.plukk(ko, 'A', { av: 'meg' }).feil).toContain('kan ikke plukkes');
    // Registreringen er ikke arbeid: den teller ikke i prosjektene og kan ikke settes til venter.
    expect(K.prosjektOversikt(ko).reduce((n, p) => n + p.totalt, 0)).toBe(2);
    expect(K.tilstand(ko).ekstern).toBe(1);
    expect(K.settStatus(r.rad as Oppgave, 'venter').feil).toContain('registrering utenfor køen');
    expect(K.settStatus(ko.oppgaver[1], 'ekstern').feil).toContain('ekstern add');
    // Samme navn igjen: filene legges til.
    const r2 = K.eksternAdd(ko, { navn: 'eier-økt 30.09', filer: ['b.md'] });
    expect(r2.ny).toBe(false);
    expect(r2.rad?.eier_filer).toEqual(['docs/plan.md', 'b.md']);
    expect(K.velgNeste(ko)).toEqual([]);
    // Ferdig: filene er fri.
    expect(K.eksternFerdig(ko, 'eier-økt 30.09').rad?.status).toBe('ferdig');
    expect(
      K.velgNeste(ko)
        .map((v) => v.id)
        .sort(),
    ).toEqual(['A', 'B']);
    expect(K.eksternFerdig(ko, 'eier-økt 30.09').feil).toContain('ingen aktiv registrering');
    expect(K.eksternAdd(ko, { navn: 'x' }).feil).toContain('--filer');
    expect(K.eksternAdd(ko, { filer: ['a'] }).feil).toContain('--navn');
  });

  it('godta: ventende → ferdig med merknad (visuell → QA); plukket og ukjent nektes', () => {
    const ko: Ko = {
      oppgaver: [
        o('V1', { etiketter: ['visuell'] }),
        o('P1', { status: 'plukket', plukket_av: 'meg' }),
      ],
    };
    const r = K.eksternGodta(ko, 'V1', 'abcdef1234567890', { nevnt: false });
    expect(r.oppgave).toMatchObject({
      status: 'ferdig',
      qa_status: 'venter',
      gjort_utenfor_koen: 'abcdef1234567890',
    });
    expect(r.oppgave?.merknader?.[0]).toMatch(
      /gjort utenfor køen i abcdef12 \(commit-meldingen nevner ikke id-en\)$/,
    );
    expect(K.eksternGodta(ko, 'P1', 'abc').feil).toContain('plukket av meg');
    expect(K.eksternGodta(ko, 'NEI', 'abc').feil).toContain('ukjent');
  });

  it('oppgaver uten prosjekt eller funksjon synes (LK-familien 30.09)', () => {
    const m = K.manglerProsjekt(
      [
        o('LK-1a', { funksjon: 'Lovkrav' }),
        o('A-1', { funksjon: 'x' }),
        o('A-2'),
        o('GML', { status: 'ferdig' }),
      ],
      { tf: { tittel: 'TF', prefikser: ['A-'] } },
    );
    expect(m).toEqual({ utenProsjekt: ['LK-1a'], utenFunksjon: ['A-2'] });
  });
});

describe('neste hopper over ucommittede eierfiler', () => {
  it('velgNeste, ucommittetHoppet og tilstand sier hvorfor', () => {
    const ko: Ko = {
      oppgaver: [o('A', { eier_filer: ['docs/plan.md'] }), o('B', { eier_filer: ['b.md'] })],
    };
    expect(K.velgNeste(ko, Date.now(), { ucommittet: ['docs/plan.md'] }).map((v) => v.id)).toEqual([
      'B',
    ]);
    expect(K.ucommittetHoppet(ko, ['docs/plan.md'])).toEqual([
      { id: 'A', fil: 'docs/plan.md', sti: 'docs/plan.md' },
    ]);
    const t = K.tilstand(ko, undefined, { ucommittet: ['docs/'] });
    expect(t.blokkert).toEqual([{ id: 'A', hindringer: ['fil docs/ er ucommittet i hovedtreet'] }]);
    expect(K.ucommittetKollisjon(ko.oppgaver[1], ['docs/'])).toBeNull();
  });
});

describe('orkestrator-markøren', () => {
  it('aktiv til 2 t uten oppdatering, så utløpt; nyMarkor beholder økt-navnet', () => {
    const naa = Date.parse('2026-09-30T12:00:00Z');
    const m = K.nyMarkor(null, {
      okt: 'ko-økt 30.09',
      hendelse: 'start X',
      naa: '2026-09-30T11:00:00Z',
    });
    expect(K.orkestratorStatus(m, naa)).toMatchObject({ aktiv: true, okt: 'ko-økt 30.09' });
    expect(K.orkestratorStatus(m, naa + K.ORKESTRATOR_UTLOP_MS)).toMatchObject({ aktiv: false });
    expect(K.orkestratorStatus(null, naa)).toMatchObject({ aktiv: false, grunn: 'ingen markør' });
    expect(K.nyMarkor(m, { hendelse: 'puls' }).okt).toBe('ko-økt 30.09');
    expect(K.nyMarkor(null, {}).okt).toBe('orkestrator');
  });
});

// ---- Mot et midlertidig git-repo ------------------------------------------------------------------------------------
describe('mot et midlertidig git-repo', () => {
  it('kø-flett + orkestrator-trailer: ingen eksterne, push-sjekk exit 0', () => {
    const r = lagRepo();
    r.koFlett('A-1', 'a.txt');
    r.commit('org.json', 'chore(db): regenerer org-tables', 'Ko: orkestrator');
    const p = plan(r);
    expect(p).toMatchObject({ totalt: 2, ko: 1, orkestrator: 1, eksterne: [] });
    const cli = kjor('push-sjekk.mjs', [], { KO_GIT: r.dir });
    expect(cli.kode).toBe(0);
    expect(cli.ut).toContain('0 eksterne');
  }, 60_000);

  it('ekstern commit ETTER køens: trygt kuttpunkt (exit 2, git push origin <sha>:main)', () => {
    const r = lagRepo();
    const flett = r.koFlett('A-1', 'a.txt');
    r.commit('docs/plan.md', 'docs: plan fra en annen økt');
    const p = plan(r);
    expect(p).toMatchObject({ kuttpunkt: flett, sammenflettet: false });
    expect(p.eksterne).toHaveLength(1);
    const cli = kjor('push-sjekk.mjs', [], { KO_GIT: r.dir });
    expect(cli.kode).toBe(2);
    expect(cli.ut).toContain(`trygt kuttpunkt: ${flett.slice(0, 8)}`);
    expect(cli.ut).toContain(`git push origin ${flett}:main`);
    expect(cli.ut).toContain('docs/plan.md');
  }, 60_000);

  it('ekstern commit FØR køens: ikke noe kuttpunkt, og historikken skrives aldri om', () => {
    const r = lagRepo();
    r.commit('docs/plan.md', 'docs: plan fra en annen økt');
    r.koFlett('A-1', 'a.txt');
    expect(plan(r)).toMatchObject({ kuttpunkt: null, sammenflettet: true });
    const cli = kjor('push-sjekk.mjs', ['--json'], { KO_GIT: r.dir });
    expect(cli.kode).toBe(2);
    expect(JSON.parse(cli.ut)).toMatchObject({ kuttpunkt: null, sammenflettet: true, ko: 1 });
  }, 60_000);

  it('flett av en hotfix-gren er ekstern og tar med commitene sine', () => {
    const r = lagRepo();
    r.g(['checkout', '-q', '-b', 'hotfix/x']);
    r.commit('fix.txt', 'fix: hastefiks (A-T8c)');
    r.g(['checkout', '-q', 'main']);
    r.g(['merge', '-q', '--no-ff', '--no-edit', 'hotfix/x']);
    const [c] = G.klassifiser(r.git, G.lesForsteForeldre(r.git, { fra: 'origin/main' }) ?? [], {
      fra: 'origin/main',
    });
    expect(c.kilde).toBe('ekstern');
    expect(c.filer).toEqual(['fix.txt']);
    expect(c.side?.map((s) => s.emne)).toEqual(['fix: hastefiks (A-T8c)']);
  }, 60_000);

  it('ekstern-bildet: id-samsvar, kollisjoner (commit, gren, ucommittet) og advarselen til sporfila', () => {
    const r = lagRepo();
    r.koFlett('A-1', 'a.txt');
    const ekstern = r.commit('docs/plan.md', 'docs: A-T8c: planen er skrevet');
    // En gren utenfor ko/* som ikke er flettet, og en ucommittet fil i treet.
    r.g(['checkout', '-q', '-b', 'hotfix/z']);
    r.commit('hot.md', 'fix: hot');
    r.g(['checkout', '-q', 'main']);
    r.skriv('README.md', 'endret, ikke committet\n');
    const ko: Ko = {
      oppgaver: [
        o('A-T8c', { eier_filer: ['docs/plan.md'], lagt_til: LENGE_SIDEN }),
        o('NY', { eier_filer: ['docs/plan.md'], lagt_til: LANGT_FRAM }),
        o('HOT', { status: 'kjorer', eier_filer: ['hot.md', 'README.md'], lagt_til: LANGT_FRAM }),
        o('A-1', { status: 'ferdig', eier_filer: ['a.txt'] }),
      ],
    };
    const b = G.eksternBilde(r.git, ko, { vindu: { fra: 'origin/main' } });
    expect(b.eksterne.map((c) => c.sha)).toEqual([ekstern]);
    expect(b.samsvar).toEqual([
      expect.objectContaining({
        id: 'A-T8c',
        forslag: `ko.mjs ekstern godta A-T8c ${ekstern.slice(0, 8)}`,
      }),
    ]);
    expect(b.grener.map((g) => g.navn)).toEqual(['hotfix/z']);
    const kort = b.kollisjoner.map((k) => `${k.id}:${k.kilde}:${k.fil}`).sort();
    expect(kort).toEqual([
      'A-T8c:commit:docs/plan.md',
      'HOT:gren:hot.md',
      'HOT:ucommittet:README.md',
    ]);
    // start/plukk/sporfil: advarselen for den kjørende oppgaven.
    const v = G.eksternForOppgaver(r.git, [ko.oppgaver[2]]).get('HOT');
    expect(v?.advarsel).toContain('hotfix/z');
    expect(v?.advarsel).toContain('README.md');
  }, 60_000);

  it('ko.mjs: neste hopper over ucommittet kollisjon; ekstern add/ferdig; orkestrator-markøren', () => {
    const r = lagRepo();
    r.commit('docs/plan.md', 'docs: plan');
    r.skriv('docs/plan.md', 'ucommittet endring\n');
    const mappe = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-mappe-'));
    repoer.push(mappe);
    const oppgave = (id: string, fil: string) => ({
      ...o(id, { eier_filer: [fil] }),
      nytte: 5,
      innhold_min: 30,
      migr_tiere: 0,
    });
    fs.writeFileSync(
      path.join(mappe, 'ko.json'),
      JSON.stringify({
        opprettet: LENGE_SIDEN,
        grenser: {},
        neste_migr: 2840,
        avklart: [],
        oppgaver: [oppgave('A', 'docs/plan.md'), oppgave('B', 'b.md')],
      }),
    );
    const env = { KO_MAPPE: mappe, KO_GIT: r.dir };
    const neste = kjor('ko.mjs', ['neste'], env);
    expect(neste.kode).toBe(0);
    expect(neste.ut).toMatch(/^B\s/m);
    expect(neste.ut).toContain('Hoppet over 1');
    expect(neste.ut).toMatch(/A\s+fil docs\/plan\.md/);
    expect(kjor('ko.mjs', ['start', 'A'], env).ut).toContain('ucommittet i hovedtreet');

    const add = kjor('ko.mjs', ['ekstern', 'add', '--navn', 'eier-økt', '--filer', 'b.md'], env);
    expect(add.ut).toContain('Registrert ekstern-eier-okt');
    expect(kjor('ko.mjs', ['neste'], env).ut).toContain('Ingenting kan startes nå');
    expect(kjor('ko.mjs', ['ekstern', 'ferdig', 'eier-økt'], env).ut).toContain('ferdig');
    expect(kjor('ko.mjs', ['neste'], env).ut).toMatch(/^B\s/m);

    expect(kjor('ko.mjs', ['orkestrator'], env).ut).toContain('INGEN AKTIV ORKESTRATOR');
    expect(kjor('ko.mjs', ['orkestrator', 'puls', '--okt', 'test-økt'], env).kode).toBe(0);
    expect(kjor('ko.mjs', ['orkestrator'], env).ut).toContain('AKTIV ORKESTRATOR: «test-økt»');
    kjor('ko.mjs', ['orkestrator', 'stopp'], env);
    expect(kjor('ko.mjs', ['orkestrator'], env).ut).toContain('INGEN AKTIV ORKESTRATOR');
  }, 120_000);
});
