// =============================================================
// koPlanLes.test.ts: lesevisningen av dokumenter og Uregistrert-boksen i Planer-rommet (se docs/board.md).
//
// Render-tester virker ikke her, så reglene er rene funksjoner i lib/koPlanVisning.js (samme fil som
// nettleseren laster) og testes direkte: allowlisten og stivernet for /api/dok, lenkene i et dokument, markdown-
// blokkene (HTML blir tekst), ankrene, gruppene i boksen, forslaget til ny post og skjemaene. Stivernet på disk
// (koTavle.lesDokument) kjøres mot en midlertidig mappe med en junction/symlenke, en skjult fil og en for stor fil.
// Argumentene til `ko.mjs plan ny` og `plan endre --sett {kilder}` kjøres mot ko.mjs på en kopi (forhåndsvisning,
// skriving som eier med --forvent-endret, og utdatert versjon). Til slutt leses les.js, planer.js, index.html og
// ko-tavle.mjs som tekst for koblingene.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../koPlanVisning.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../koPlan.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../koTavle.js');

const KLIENT = join(__dirname, '..', '..', 'ko-tavle');
const KO_MJS = join(__dirname, '..', '..', 'ko.mjs');

describe('lesStiFeil: allowlisten for /api/dok', () => {
  afterEach(() => V.settLesMapper(null));

  it('slipper gjennom markdown under dokumentmappene (standard docs/)', () => {
    expect(V.LES_MAPPER).toEqual(['docs/']);
    for (const s of [
      'docs/plan-register.md',
      'docs/notater/tavle-plan-2026-10-10.md',
      'docs/a/b/c.md',
      'docs/README.MD',
    ])
      expect([s, V.lesStiFeil(s)]).toEqual([s, null]);
  });

  it('dokumentmappene kan settes (fra konfigurasjonen), og ugyldige mapper kastes', () => {
    expect(V.settLesMapper(['docs', 'styring/', '../ut', '.skjult', 'C:/x', 42])).toEqual([
      'docs/',
      'styring/',
    ]);
    expect(V.lesStiFeil('styring/a/b.md')).toBeNull();
    expect(V.lesStiFeil('annet/x.md')).toContain('docs/, styring/');
    // En tom liste gir standarden tilbake
    expect(V.settLesMapper([])).toEqual(['docs/']);
  });

  it('avviser .., skjulte filer, .env, andre filtyper, absolutte stier og mapper utenfor allowlisten', () => {
    for (const s of [
      '',
      '../docs/x.md',
      'docs/../.env',
      'docs/./x.md',
      'docs//x.md',
      '/docs/x.md',
      'C:/prosjekter/Alfa/docs/x.md',
      'docs\\x.md',
      '.env',
      'docs/.env',
      'docs/.skjult.md',
      'docs/.git/x.md',
      'docs/x.env',
      'docs/x.md.bak',
      'docs/x.txt',
      'docs/x.md:stream',
      'docs/x.md.',
      'docs/x.md ',
      'docs/PROGRA~1.md',
      'scripts/x.md',
      'db/CLAUDE.md',
      'admin/x.md',
      'docsx/y.md',
      'styring',
      'docs/x\u0000.md',
      'docs/linje\nskift.md',
      `docs/${'a'.repeat(400)}.md`,
    ])
      expect([s, V.lesStiFeil(s)]).not.toEqual([s, null]);
    expect(V.lesStiFeil(null)).toBe('mangler sti');
    expect(V.lesStiFeil(42)).toBe('mangler sti');
  });
});

describe('lenkeMaal: lenker i et dokument', () => {
  it('relative .md-lenker blir dokumenter (med anker), ellers tekst', () => {
    expect(V.lenkeMaal('docs/notater/a.md', '../b.md#3.4')).toEqual({
      type: 'dok',
      sti: 'docs/b.md',
      anker: '3.4',
    });
    expect(V.lenkeMaal('docs/a.md', 'notater/c.md')).toEqual({
      type: 'dok',
      sti: 'docs/notater/c.md',
      anker: null,
    });
    expect(V.lenkeMaal('docs/a.md', '/docs/x.md')).toEqual({
      type: 'dok',
      sti: 'docs/x.md',
      anker: null,
    });
    // Utenfor dokumentmappene er det ingen lesbar lenke
    expect(V.lenkeMaal('docs/a.md', '/styring/x.md').type).toBe('annen');
    expect(V.lenkeMaal('docs/a.md', '#seksjon')).toEqual({ type: 'anker', anker: 'seksjon' });
    expect(V.lenkeMaal('docs/a.md', 'https://lovdata.no/x')).toEqual({
      type: 'ekstern',
      url: 'https://lovdata.no/x',
    });
    for (const h of [
      'javascript:alert(1)',
      'data:text/html,x',
      'mailto:a@b.no',
      '../../../.env',
      '../../scripts/x.js',
      '../.git/config',
      'x.ts',
      '%zz.md',
      '',
    ])
      expect([h, V.lenkeMaal('docs/a.md', h).type]).toEqual([h, 'annen']);
  });
});

describe('markdownBlokker og inlineDeler', () => {
  it('overskrifter, avsnitt, lister med nivå, kode, sitat, tabell og skillelinje', () => {
    const b = V.markdownBlokker(
      [
        '---',
        'tittel: x',
        '---',
        '# Tittel',
        '',
        'Første linje',
        'fortsetter her.',
        '',
        '- a',
        '  - a1',
        '- b',
        '',
        '1. en',
        '2. to',
        '',
        '```js',
        'const x = "<b>";',
        '```',
        '> sitat',
        '',
        '| A | B |',
        '|---|---|',
        '| 1 | `x|y` |',
        '',
        '***',
        '## 3.4 Modenhet ##',
      ].join('\r\n'),
    );
    expect(b.map((x: { type: string }) => x.type)).toEqual([
      'kode',
      'overskrift',
      'avsnitt',
      'liste',
      'liste',
      'kode',
      'sitat',
      'tabell',
      'linje',
      'overskrift',
    ]);
    expect(b[1]).toEqual({ type: 'overskrift', niva: 1, tekst: 'Tittel' });
    expect(b[2].tekst).toBe('Første linje fortsetter her.');
    expect(b[3].punkter.map((p: { niva: number; tekst: string }) => [p.niva, p.tekst])).toEqual([
      [0, 'a'],
      [1, 'a1'],
      [0, 'b'],
    ]);
    expect(b[4].punkter.map((p: { ordnet: boolean; nr: number }) => [p.ordnet, p.nr])).toEqual([
      [true, 1],
      [true, 2],
    ]);
    expect(b[5]).toEqual({ type: 'kode', sprak: 'js', tekst: 'const x = "<b>";' });
    expect(b[7]).toEqual({ type: 'tabell', hode: ['A', 'B'], rader: [['1', '`x|y`']] });
    expect(b[9]).toEqual({ type: 'overskrift', niva: 2, tekst: '3.4 Modenhet' });
  });

  it('HTML blir stående som tekst, og uthevinger, kode og lenker deles opp', () => {
    expect(V.inlineDeler('<script>alert(1)</script>')).toEqual([
      { type: 'tekst', tekst: '<script>alert(1)</script>' },
    ]);
    const d = V.inlineDeler(
      'Se **fet `kode`** og *kursiv*, [plan](../a.md) og snake_case_navn \\*.',
    );
    expect(d.map((x: { type: string }) => x.type)).toEqual([
      'tekst',
      'fet',
      'tekst',
      'kursiv',
      'tekst',
      'lenke',
      'tekst',
    ]);
    expect(d[1].deler).toEqual([
      { type: 'tekst', tekst: 'fet ' },
      { type: 'kode', tekst: 'kode' },
    ]);
    expect(d[5]).toEqual({ type: 'lenke', tekst: 'plan', mal: '../a.md' });
    expect(d[6].tekst).toBe(' og snake_case_navn *.');
    expect(V.renTekst('![logo](x.png) <https://a.no>')).toBe('[bilde: logo] https://a.no');
  });

  it('ankerIndeks finner § 3.4, tekst i overskriften og #slug', () => {
    const b = V.markdownBlokker('# Plan\n\n## 3.4 Modenhet og bygget\n\n### Uregistrert boks');
    expect(V.ankerIndeks(b, '§ 3.4')).toBe(1);
    expect(V.ankerIndeks(b, 'modenhet')).toBe(1);
    expect(V.ankerIndeks(b, 'uregistrert-boks')).toBe(2);
    expect(V.ankerIndeks(b, 'finnes ikke')).toBe(-1);
    expect(V.ankerIndeks(b, '')).toBe(-1);
  });
});

describe('Uregistrert-boksen: grupper, forslag og skjemaene', () => {
  it('grupperer etter dokumentmappe (den lengste først), og tar bort tomme grupper', () => {
    const mapper = ['docs/', 'docs/notater/', 'styring/'];
    const g = V.uregistrertGrupper(
      ['docs/b.md', 'docs/notater/a.md', 'styring/analyse/c.md', 'docs/b.md', 'annet.md'],
      mapper,
    );
    expect(g.map((x: { id: string; stier: string[] }) => [x.id, x.stier])).toEqual([
      ['docs/notater', ['docs/notater/a.md']],
      ['styring', ['styring/analyse/c.md']],
      ['docs', ['docs/b.md']],
      ['annet', ['annet.md']],
    ]);
    expect(V.uregistrertGrupper([])).toEqual([]);
    // Standard: mappene lesevisningen bruker
    expect(V.uregistrertGrupper(['docs/x.md']).map((x: { id: string }) => x.id)).toEqual(['docs']);
  });

  it('foreslår ledig id og tittel fra filnavnet', () => {
    expect(V.postForslag('docs/notater/api-bytte-utkast-2026-10-10.md', new Set())).toEqual({
      id: 'PL-API-BYTTE-UTKAST-1',
      tittel: 'Api bytte utkast',
    });
    expect(V.postForslag('docs/eksport_tavle.md', ['PL-EKSPORT-TAVLE-1']).id).toBe(
      'PL-EKSPORT-TAVLE-2',
    );
    expect(P.validerPost).toBeDefined();
  });

  it('nyPostFraSkjema lager en gyldig post, og nekter tull', () => {
    const { post, feil } = V.nyPostFraSkjema(
      {
        id: 'PL-X-1',
        tittel: ' Tittel ',
        prosjekt: 'eksport',
        prioritet: 'naa',
        kategori: 'sikkerhet',
      },
      'docs/x.md',
    );
    expect(feil).toEqual([]);
    expect(post).toEqual({
      id: 'PL-X-1',
      tittel: 'Tittel',
      prosjekt: 'eksport',
      prioritet: 'naa',
      naa_kategori: ['sikkerhet'],
      modenhet: 'ide',
      kilder: [{ sti: 'docs/x.md' }],
    });
    const nei = V.nyPostFraSkjema(
      { id: 'x', tittel: '', prosjekt: '', prioritet: 'dropp' },
      '../.env',
    );
    expect(nei.post).toBeNull();
    expect(nei.feil.length).toBeGreaterThanOrEqual(5);
    expect(
      V.nyPostFraSkjema({ id: 'PL-X-1', tittel: 'T', prosjekt: 'a', prioritet: 'naa' }, 'docs/x.md')
        .feil,
    ).toEqual(['Nå trenger en kategori (sikkerhet, før prod eller viktig)']);
  });

  it('kildeTillegg beholder de gamle kildene og nekter samme kilde to ganger', () => {
    const p = { id: 'PL-A', kilder: [{ sti: 'docs/a.md', anker: '§ 1', rolle: 'plan' }] };
    expect(V.kildeTillegg(p, 'docs/b.md', ' § 2 ')).toEqual({
      kilder: [
        { sti: 'docs/a.md', anker: '§ 1', rolle: 'plan' },
        { sti: 'docs/b.md', anker: '§ 2' },
      ],
      feil: [],
    });
    expect(V.kildeTillegg(p, 'docs/a.md', '§ 1').feil).toEqual(['PL-A har alt denne kilden']);
    expect(V.kildeTillegg(p, 'scripts/x.js', '').feil.length).toBe(1);
    expect(V.kildeTillegg(null, 'docs/b.md').feil).toEqual(['ukjent planpost']);
  });

  it('argumentene: eierens valg, tavla som avsender, --torr eller --forvent-endret', () => {
    expect(V.nyPostArgs('/tmp/x.json', { torr: true })).toEqual([
      'plan',
      'ny',
      '--fil',
      '/tmp/x.json',
      '--json',
      '--satt-av',
      'eier',
      '--av',
      'tavla',
      '--torr',
    ]);
    expect(
      V.kildeArgs('PL-A', [{ sti: 'docs/a.md' }], { forvent: '2026-10-15T00:00:00.000Z' }),
    ).toEqual([
      'plan',
      'endre',
      'PL-A',
      '--sett',
      '{"kilder":[{"sti":"docs/a.md"}]}',
      '--json',
      '--satt-av',
      'eier',
      '--av',
      'tavla',
      '--forvent-endret',
      '2026-10-15T00:00:00.000Z',
    ]);
  });
});

describe('koTavle.lesDokument: stivernet på disk', () => {
  let rot: string;
  let ute: string;
  const io = { fs, path };
  beforeEach(() => {
    rot = mkdtempSync(join(tmpdir(), 'ko-les-'));
    ute = mkdtempSync(join(tmpdir(), 'ko-les-ute-'));
    mkdirSync(join(rot, 'docs', 'notater'), { recursive: true });
    writeFileSync(join(rot, 'docs', 'plan.md'), '# Plan\n\nTekst.');
    writeFileSync(join(rot, 'docs', 'notater', 'notat.md'), 'intern');
    writeFileSync(join(rot, '.env'), 'HEMMELIG=1');
    writeFileSync(join(ute, 'hemmelig.md'), 'utenfor rota');
    mkdirSync(join(rot, 'docs', 'mappe.md'));
    writeFileSync(join(rot, 'docs', 'stor.md'), 'x'.repeat(2048));
  });
  afterEach(() => {
    rmSync(rot, { recursive: true, force: true });
    rmSync(ute, { recursive: true, force: true });
  });

  it('leser markdown i allowlisten', () => {
    const r = T.lesDokument(rot, 'docs/plan.md', io);
    expect(r).toMatchObject({
      ok: true,
      sti: 'docs/plan.md',
      tekst: '# Plan\n\nTekst.',
      bytes: 14,
    });
    expect(T.lesDokument(rot, 'docs/notater/notat.md', io)).toMatchObject({
      ok: true,
      tekst: 'intern',
    });
  });

  it('nekter .env, .., mapper, filer som mangler og for store filer, uten å lekke innhold', () => {
    expect(T.lesDokument(rot, '.env', io)).toMatchObject({ ok: false, status: 400 });
    expect(T.lesDokument(rot, 'docs/../.env', io)).toMatchObject({ ok: false, status: 400 });
    expect(T.lesDokument(rot, 'docs/mangler.md', io)).toMatchObject({ ok: false, status: 404 });
    expect(T.lesDokument(rot, 'docs/mappe.md', io)).toMatchObject({ ok: false, status: 404 });
    expect(T.lesDokument(rot, 'docs/stor.md', io, { maks: 1024 })).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(JSON.stringify(T.lesDokument(rot, 'docs/../.env', io))).not.toContain('HEMMELIG');
  });

  it('nekter en symlenke eller junction ut av rota, også når målet er markdown', () => {
    // Junction virker uten ekstra rettigheter på Windows; på andre plattformer blir det en vanlig mappe-symlenke.
    symlinkSync(ute, join(rot, 'docs', 'lenke'), 'junction');
    const r = T.lesDokument(rot, 'docs/lenke/hemmelig.md', io);
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(JSON.stringify(r)).not.toContain('utenfor rota');
  });

  it('nekter når stien ikke er den ekte stien (feil store og små bokstaver gir ikke en annen fil)', () => {
    const r = T.lesDokument(rot, 'docs/PLAN.md', io);
    // Store/små bokstaver: Windows finner fila, men den ekte stien er en annen (403); Linux finner den ikke (404).
    expect(r.ok).toBe(false);
    expect([403, 404]).toContain(r.status);
  });
});

describe('ko.mjs plan ny og plan endre med argumentene fra boksen (kopi i en midlertidig mappe)', () => {
  let mappe: string;
  const kjor = (args: string[]) => {
    try {
      const ut = execFileSync(process.execPath, [KO_MJS, ...args], {
        env: {
          ...process.env,
          KO_MAPPE: mappe,
          KO_GIT: mappe,
          KO_TIDSLOGG: join(mappe, 'tider.jsonl'),
          KO_PLAN_KILDEROT: mappe,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { kode: 0, data: JSON.parse(ut.trim().split('\n').pop() ?? 'null') };
    } catch (e) {
      const x = e as { status: number; stdout: string };
      let data = null;
      try {
        data = JSON.parse(
          String(x.stdout ?? '')
            .trim()
            .split('\n')
            .pop() ?? 'null',
        );
      } catch {
        data = null;
      }
      return { kode: x.status, data };
    }
  };
  const lesReg = () => JSON.parse(readFileSync(join(mappe, 'planer.json'), 'utf8'));
  const prosjekter = { eksport: { tittel: 'Eksport', omrade: 'alfa' } };

  beforeEach(() => {
    mappe = mkdtempSync(join(tmpdir(), 'ko-les-ko-'));
    mkdirSync(join(mappe, 'docs'), { recursive: true });
    writeFileSync(join(mappe, 'docs', 'ny.md'), '# Ny');
    writeFileSync(join(mappe, 'docs', 'a.md'), '# A');
    writeFileSync(
      join(mappe, 'ko.json'),
      JSON.stringify({
        endret: '2026-10-14T08:00:00.000Z',
        oppgaver: [],
        prosjekter,
        omrader: { alfa: { tittel: 'Alfa' } },
        sporsmal: {},
        avklart: [],
      }),
    );
    const reg = P.tomtRegister('2026-10-14T09:00:00.000Z');
    const r = P.nyPost(
      reg,
      {
        id: 'PL-A',
        tittel: 'Tittel A',
        prosjekt: 'eksport',
        prioritet: 'senere',
        prioritet_grunn: 'Regel 8: uten frist.',
        modenhet: 'utredet',
        kilder: [{ sti: 'docs/a.md' }],
      },
      { rolle: 'agent', prosjekter, sporsmal: {}, finnesSti: () => true },
    );
    if (r.feil.length) throw new Error(r.feil.join('; '));
    writeFileSync(join(mappe, 'planer.json'), JSON.stringify(reg));
  });
  afterEach(() => rmSync(mappe, { recursive: true, force: true }));

  it('Ny post: forhåndsvisning skriver ingenting; lagring med versjonen lager posten som eier', () => {
    const { post, feil } = V.nyPostFraSkjema(
      { id: 'PL-NY-1', tittel: 'Ny plan', prosjekt: 'eksport', prioritet: 'eier' },
      'docs/ny.md',
    );
    expect(feil).toEqual([]);
    const fil = join(mappe, 'post.json');
    writeFileSync(fil, JSON.stringify(post));
    const for_ = readFileSync(join(mappe, 'planer.json'), 'utf8');
    const torr = kjor(V.nyPostArgs(fil, { torr: true }));
    expect(torr.kode).toBe(0);
    expect(torr.data.torr).toBe(true);
    expect(torr.data.endringer.length).toBeGreaterThan(0);
    expect(readFileSync(join(mappe, 'planer.json'), 'utf8')).toBe(for_);

    const r = kjor(V.nyPostArgs(fil, { forvent: torr.data.endret }));
    expect(r.kode).toBe(0);
    expect(lesReg().poster.find((p: { id: string }) => p.id === 'PL-NY-1')).toMatchObject({
      prioritet: 'eier',
      prioritet_satt_av: 'eier',
      modenhet: 'ide',
      kilder: [{ sti: 'docs/ny.md' }],
    });
    expect(lesReg().endringslogg.at(-1)).toMatchObject({ av: 'tavla', handling: 'plan ny' });
  });

  it('Legg til som kilde: hele lista skrives, og en utdatert versjon nekter med exit 6', () => {
    const reg = lesReg();
    const p = reg.poster.find((x: { id: string }) => x.id === 'PL-A');
    const { kilder } = V.kildeTillegg(p, 'docs/ny.md', '§ 1');
    const torr = kjor(V.kildeArgs('PL-A', kilder, { torr: true }));
    expect(torr.kode).toBe(0);
    expect(torr.data.endringer.map((e: { felt: string }) => e.felt)).toContain('kilder');

    const gammel = kjor(V.kildeArgs('PL-A', kilder, { forvent: '2026-01-01T00:00:00.000Z' }));
    expect(gammel.kode).toBe(6);
    expect(gammel.data.utdatert).toBe(true);

    const r = kjor(V.kildeArgs('PL-A', kilder, { forvent: torr.data.endret }));
    expect(r.kode).toBe(0);
    expect(lesReg().poster.find((x: { id: string }) => x.id === 'PL-A').kilder).toEqual([
      { sti: 'docs/a.md' },
      { sti: 'docs/ny.md', anker: '§ 1' },
    ]);
    // Prioriteten agenten satte er urørt (bare kildene endres).
    expect(lesReg().poster.find((x: { id: string }) => x.id === 'PL-A')).toMatchObject({
      prioritet: 'senere',
      prioritet_satt_av: 'agent',
    });
  });
});

describe('koblingene i tavla (lest som tekst)', () => {
  const les = (f: string) => readFileSync(join(KLIENT, f), 'utf8');
  it('les.js tegner bare med textContent og createElement, og bruker de rene funksjonene', () => {
    const js = les(join('planer', 'les.js'));
    expect(js).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|eval\(/);
    for (const f of [
      'markdownBlokker',
      'inlineDeler',
      'lenkeMaal',
      'ankerIndeks',
      'nyPostFraSkjema',
      'kildeTillegg',
    ])
      expect(js).toContain(`V.${f}`);
    expect(js).toContain('/api/dok?sti=');
    expect(js).toContain("'/api/plan-sjekk'");
    expect(js).toContain('window.KoPlanLes');
  });
  it('planer.js, index.html og ko-tavle.mjs kobler inn les.js og rutene', () => {
    expect(les(join('planer', 'planer.js'))).toContain('window.KoPlanLes.kildeFane(lesHjelp, p)');
    expect(les(join('planer', 'planer.js'))).toContain(
      'window.KoPlanLes.uregistrertBoks(lesHjelp, d)',
    );
    const html = les('index.html');
    expect(html.indexOf('/planer/les.js')).toBeGreaterThan(0);
    expect(html.indexOf('/planer/les.js')).toBeLessThan(html.indexOf('/planer/planer.js'));
    const mjs = readFileSync(join(KLIENT, '..', 'ko-tavle.mjs'), 'utf8');
    for (const r of [
      "'/api/dok'",
      "'/api/plan-sjekk'",
      "'/api/plan-ny'",
      "'/api/plan-kilde'",
      "'/planer/les.js'",
    ])
      expect(mjs).toContain(r);
    expect(mjs).toContain('T.lesDokument(KILDEROT');
  });
});
