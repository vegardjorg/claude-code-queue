// =============================================================
// koIndeks.test.ts: dokumentindeksen ordnet etter planregisteret (lib/koIndeks.js, en valgfri funksjon): lesing av
// INDEKS (innledning, oppføringer, genererte linjer kastes, ukjent linje er feil), seksjon per modul, tverrgående og
// ukoblet, planpost-linja, nye plandokumenter fra registeret, idempotens, pluss lag-indeks.mjs (--sjekk, --torr,
// skriving, uten register) mot en kopi i en midlertidig mappe (aldri den ekte INDEKS eller det ekte registeret).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Testmodulene står i en midlertidig ko.config.json (KO_KONFIG), satt før koIndeks/koPlan leser konfigurasjonen;
// lag-indeks.mjs i underprosessen arver den.
const KONFIG_MAPPE = mkdtempSync(join(tmpdir(), 'ko-indeks-konfig-'));
process.env.KO_KONFIG = join(KONFIG_MAPPE, 'ko.config.json');
writeFileSync(
  process.env.KO_KONFIG,
  JSON.stringify({
    moduler: [
      { oid: 'alfa', tittel: 'Alfa' },
      { oid: 'beta', tittel: 'Beta' },
      { oid: 'gamma', tittel: 'Gamma' },
    ],
  }),
);

type Kilde = { sti: string; anker?: string; rolle?: string };
type Post = { id: string; tittel: string; prosjekt: string; kilder?: Kilde[] };
type Oppforing = { stier: string[]; linjer: string[] };

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS-modul (som koPlan.js)
const I = require('../koIndeks') as {
  PLANPOSTER_PREFIKS: string;
  MAKS_POSTER_PAA_LINJA: number;
  stierIOppforing: (linje: string) => string[];
  lesIndeks: (t: string) => { innledning: string[]; oppforinger: Oppforing[]; feil: string[] };
  stiTreffer: (a: string, b: string) => boolean;
  seksjonFor: (poster: Post[], prosjekter: Record<string, { omrade?: string }>) => string;
  lagIndeks: (
    t: string,
    reg: { poster: Post[] },
    ko: { prosjekter?: Record<string, { omrade?: string }> },
    ctx?: { finnes?: (sti: string) => boolean; mapper?: string[]; indeks?: string | null },
  ) => { tekst: string; feil: string[]; nye: string[]; antall: Record<string, number> };
  forsteForskjell: (a: string, b: string) => { linje: number } | null;
  INDEKS_STANDARD: string;
  indeksFil: () => string | null;
};

const INNLEDNING = '# Dokumentindeks\n\n> Merknad.\n\nDisse ligger i `docs/`.\n';
const INDEKS = `${INNLEDNING}- \`docs/a-plan.md\` — plan A
  med fortsettelse
- \`docs/b-plan.md\`: plan B
- \`docs/c.md\` · \`docs/d.md\` — to dokumenter
- \`arkiv/\` — mappe
`;
const KO = {
  prosjekter: {
    eksport: { omrade: 'alfa' },
    beta: { omrade: 'beta' },
    gamma: { omrade: 'gamma' },
    orfan: {},
  },
};
const post = (id: string, prosjekt: string, kilder: Kilde[], tittel = `Tittel ${id}`): Post => ({
  id,
  tittel,
  prosjekt,
  kilder,
});

describe('lesIndeks', () => {
  it('skiller innledning og oppføringer, og tar alle stiene først på linja', () => {
    const r = I.lesIndeks(INDEKS);
    expect(r.feil).toEqual([]);
    expect(r.innledning.join('\n')).toBe(INNLEDNING.trimEnd());
    expect(r.oppforinger.map((o) => o.stier)).toEqual([
      ['docs/a-plan.md'],
      ['docs/b-plan.md'],
      ['docs/c.md', 'docs/d.md'],
      ['arkiv/'],
    ]);
    expect(r.oppforinger[0].linjer).toEqual(['- `docs/a-plan.md` — plan A', '  med fortsettelse']);
  });

  it('kaster seksjonsoverskrifter, tomme linjer og planpost-linjer (de lages på nytt)', () => {
    const t = `${INNLEDNING}## Alfa\n\n- \`docs/a.md\`: a\n${I.PLANPOSTER_PREFIKS}\`PL-X-1\`.\n\n## Beta\n`;
    const r = I.lesIndeks(t);
    expect(r.oppforinger).toEqual([{ stier: ['docs/a.md'], linjer: ['- `docs/a.md`: a'] }]);
  });

  it('melder en ukjent linje i brødteksten i stedet for å miste den', () => {
    const r = I.lesIndeks(`${INDEKS}Løs tekst\n`);
    expect(r.feil).toHaveLength(1);
    expect(r.feil[0]).toMatch(/ukjent linje/);
  });

  it('melder en oppføring uten sti i backticks', () => {
    expect(I.lesIndeks(`${INNLEDNING}- uten sti\n`).feil[0]).toMatch(/backticks/);
  });

  it('godtar CRLF', () => {
    expect(I.lesIndeks(INDEKS.replace(/\n/g, '\r\n')).oppforinger).toHaveLength(4);
  });
});

describe('stiTreffer og seksjonFor', () => {
  it('mappe-oppføring treffer filer under mappa, fil-oppføring bare seg selv', () => {
    expect(I.stiTreffer('arkiv/', 'arkiv/01.md')).toBe(true);
    expect(I.stiTreffer('docs/a.md', 'docs/a.md')).toBe(true);
    expect(I.stiTreffer('docs/a.md', 'docs/a.md.bak')).toBe(false);
  });

  it('ingen poster gir ukoblet; flest i én modul vinner; likt gir modulrekkefølgen fra konfigurasjonen', () => {
    expect(I.seksjonFor([], KO.prosjekter)).toBe('ukoblet');
    expect(
      I.seksjonFor(
        [post('PL-A', 'beta', []), post('PL-B', 'beta', []), post('PL-C', 'eksport', [])],
        KO.prosjekter,
      ),
    ).toBe('beta');
    expect(I.seksjonFor([post('PL-A', 'beta', []), post('PL-B', 'eksport', [])], KO.prosjekter)).toBe(
      'alfa',
    );
  });

  it('poster i tre moduler gir tverrgående; prosjekt uten modul telles som uten-modul', () => {
    expect(
      I.seksjonFor(
        [post('PL-A', 'beta', []), post('PL-B', 'eksport', []), post('PL-C', 'gamma', [])],
        KO.prosjekter,
      ),
    ).toBe('tverrgaaende');
    expect(I.seksjonFor([post('PL-A', 'orfan', [])], KO.prosjekter)).toBe('uten-modul');
    expect(I.seksjonFor([post('PL-A', 'finnes-ikke', [])], KO.prosjekter)).toBe('uten-modul');
  });
});

describe('lagIndeks', () => {
  const REG = {
    poster: [
      post('PL-B', 'beta', [{ sti: 'docs/b-plan.md', rolle: 'plan' }]),
      post('PL-A', 'eksport', [{ sti: 'docs/a-plan.md', rolle: 'plan' }]),
      post('PL-D', 'gamma', [{ sti: 'docs/d.md', rolle: 'historikk' }]),
      post('PL-L', 'eksport', [{ sti: 'arkiv/05.md', rolle: 'referanse' }]),
    ],
  };

  it('ordner etter modul, beholder beskrivelsene og legger til planpost-linja', () => {
    const r = I.lagIndeks(INDEKS, REG, KO);
    expect(r.feil).toEqual([]);
    expect(r.tekst).toBe(
      `${INNLEDNING}
## Alfa

- \`arkiv/\` — mappe
  Planposter: \`PL-L\`.
- \`docs/a-plan.md\` — plan A
  med fortsettelse
  Planposter: \`PL-A\`.

## Beta

- \`docs/b-plan.md\`: plan B
  Planposter: \`PL-B\`.

## Gamma

- \`docs/c.md\` · \`docs/d.md\` — to dokumenter
  Planposter: \`PL-D\`.
`,
    );
    expect(r.antall).toEqual({ alfa: 2, beta: 1, gamma: 1 });
  });

  it('er idempotent: andre kjøring gir samme tekst', () => {
    const en = I.lagIndeks(INDEKS, REG, KO).tekst;
    expect(I.lagIndeks(en, REG, KO).tekst).toBe(en);
    expect(I.forsteForskjell(en, I.lagIndeks(en, REG, KO).tekst)).toBeNull();
  });

  it('dokument uten post havner under «Ikke koblet til en planpost», uten planpost-linje', () => {
    const r = I.lagIndeks(INDEKS, { poster: [] }, KO);
    expect(r.antall).toEqual({ ukoblet: 4 });
    expect(r.tekst).toContain('## Ikke koblet til en planpost');
    expect(r.tekst).not.toContain('Planposter:');
  });

  it('nytt sporet plandokument fra registeret får en oppføring med tittelen fra første post', () => {
    const reg = {
      poster: [
        post('PL-Z', 'beta', [{ sti: 'docs/ny-plan.md', rolle: 'plan' }], 'Senere tittel'),
        post('PL-Y', 'beta', [{ sti: 'docs/ny-plan.md', rolle: 'plan' }], 'Første tittel'),
      ],
    };
    const r = I.lagIndeks(INDEKS, reg, KO);
    expect(r.nye).toEqual(['docs/ny-plan.md']);
    expect(r.tekst).toContain(
      '- `docs/ny-plan.md`: Første tittel (beskrivelsen er hentet fra planposten',
    );
    expect(r.tekst).toContain('  Planposter: `PL-Y`, `PL-Z`.');
    // Den nye linja beholdes ordrett ved neste kjøring.
    expect(I.lagIndeks(r.tekst, reg, KO).tekst).toBe(r.tekst);
  });

  it('nye oppføringer bare for plan og referanse under dokumentmappene, ikke INDEKS, ikke døde eller ignorerte stier', () => {
    const reg = {
      poster: [
        post('PL-1', 'beta', [
          { sti: 'docs/historikk.md', rolle: 'historikk' },
          { sti: 'docs/utredning.md', rolle: 'utredning' },
          { sti: 'docs/notater/hemmelig.md', rolle: 'plan' },
          { sti: 'styring/x.md', rolle: 'plan' },
          { sti: 'docs/INDEKS.md', rolle: 'plan' },
          { sti: 'docs/borte.md', rolle: 'plan' },
          { sti: 'docs/runbook.md', rolle: 'referanse' },
          { sti: 'docs/uten-rolle.md' },
        ]),
      ],
    };
    // finnes: lag-indeks.mjs sier nei til filer som mangler og filer git ignorerer (her docs/notater/).
    const finnes = (s: string) => s !== 'docs/borte.md' && !s.startsWith('docs/notater/');
    const r = I.lagIndeks(INDEKS, reg, KO, { finnes });
    expect(r.nye).toEqual(['docs/runbook.md', 'docs/uten-rolle.md']);
    // Med flere dokumentmapper teller også de andre
    const flere = I.lagIndeks(INDEKS, reg, KO, { finnes, mapper: ['docs', 'styring'] });
    expect(flere.nye).toEqual(['docs/runbook.md', 'docs/uten-rolle.md', 'styring/x.md']);
  });

  it('indeksfila: standard docs/INDEKS.md når konfigurasjonen ikke sier noe', () => {
    expect(I.INDEKS_STANDARD).toBe('docs/INDEKS.md');
    expect(I.indeksFil()).toBe('docs/INDEKS.md');
  });

  it('mange poster vises som antall med søkekommando', () => {
    const mange = Array.from({ length: I.MAKS_POSTER_PAA_LINJA + 1 }, (_, i) =>
      post(`PL-M${i}`, 'beta', [{ sti: 'docs/b-plan.md', rolle: 'plan' }]),
    );
    const r = I.lagIndeks(INDEKS, { poster: mange }, KO);
    expect(r.tekst).toContain(
      `  Planposter: ${mange.length} poster, se \`node scripts/orkestrator/ko.mjs plan vis --sok docs/b-plan.md\`.`,
    );
  });
});

describe('lag-indeks.mjs', () => {
  const SKRIPT = join(__dirname, '..', '..', 'lag-indeks.mjs');
  let mappe: string;
  let ko: string;
  let indeks: string;

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'lag-indeks-'));
    ko = join(mappe, 'ko');
    mkdirSync(ko);
    mkdirSync(join(mappe, 'rot', 'docs'), { recursive: true });
    indeks = join(mappe, 'rot', 'docs', 'INDEKS.md');
    writeFileSync(indeks, INDEKS);
    writeFileSync(join(mappe, 'rot', 'docs', 'ny-plan.md'), '# Ny\n');
    writeFileSync(join(ko, 'ko.json'), JSON.stringify(KO));
    writeFileSync(
      join(ko, 'planer.json'),
      JSON.stringify({
        poster: [
          post('PL-A', 'eksport', [{ sti: 'docs/a-plan.md', rolle: 'plan' }]),
          post('PL-N', 'beta', [{ sti: 'docs/ny-plan.md', rolle: 'plan' }]),
        ],
      }),
    );
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  function kjor(args: string[], koMappe = ko): { kode: number; ut: string } {
    try {
      const ut = execFileSync(process.execPath, [SKRIPT, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: koMappe,
          KO_INDEKS_FIL: indeks,
          KO_DOKROT: join(mappe, 'rot'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { kode: 0, ut };
    } catch (e) {
      const f = e as { status: number; stdout: string; stderr: string };
      return { kode: f.status, ut: `${f.stdout}${f.stderr}` };
    }
  }

  it('--sjekk melder drift med exit 1 og skriver ingenting; --torr gir exit 0', () => {
    const s = kjor(['--sjekk']);
    expect(s.kode).toBe(1);
    expect(s.ut).toMatch(/DRIFT/);
    expect(s.ut).toMatch(/docs\/ny-plan\.md/);
    expect(kjor(['--torr']).kode).toBe(0);
    expect(readFileSync(indeks, 'utf8')).toBe(INDEKS);
  });

  it('skriver INDEKS, og deretter er --sjekk grønn', () => {
    const w = kjor([]);
    expect(w.kode).toBe(0);
    expect(w.ut).toMatch(/skrev/);
    const ny = readFileSync(indeks, 'utf8');
    expect(ny).toContain('## Beta');
    expect(ny).toContain('- `docs/ny-plan.md`: Tittel PL-N');
    const s = kjor(['--sjekk']);
    expect(s.kode).toBe(0);
    expect(s.ut).toMatch(/OK/);
  });

  it('uten registeret hopper --sjekk over med exit 0 (CI, ren klone)', () => {
    const s = kjor(['--sjekk'], join(mappe, 'finnes-ikke'));
    expect(s.kode).toBe(0);
    expect(s.ut).toMatch(/hopper over/);
  });

  it('ukjent linje i brødteksten stopper med exit 2 og lar fila være', () => {
    writeFileSync(indeks, `${INDEKS}Løs tekst\n`);
    expect(kjor([]).kode).toBe(2);
    expect(readFileSync(indeks, 'utf8')).toBe(`${INDEKS}Løs tekst\n`);
  });

  it('ukjent valg gir exit 2', () => {
    expect(kjor(['--feil']).kode).toBe(2);
  });
});
