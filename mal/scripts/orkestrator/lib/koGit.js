// =============================================================
// koGit.js: git-lesingen for arbeidskøen (arbeid utenfor køen).
//
// Svarer på tre spørsmål: hva på basegrenen kommer fra køen (flett av <grenPrefiks><id>), fra orkestratoren
// (traileren «Ko: orkestrator») og utenfor køen; hvilke grener og worktrees utenfor køens grenprefiks har commits
// som ikke er i basegrenen; og hvilke filer er ucommittet i hovedtreet.
//
// Basegrenen, remoten og grenprefikset kommer fra ko.config.json (koKonfig.js: baseGren, remote, grenPrefiks).
// Funksjonene tar dem som valgfrie parametre, så testene kan styre dem uten en konfigfil.
//
// Bare lesing, og alltid med --no-optional-locks: `git status` skal aldri ta index.lock fra en annen økt som
// committer i hovedtreet samtidig. Beslutningene (klassifisering, kollisjoner, kuttpunkt, samsvar) står i
// koLogikk.js. Brukes av ko.mjs, ko-overtak.mjs og push-sjekk.mjs. Testet mot et midlertidig repo i
// scripts/orkestrator/lib/__tests__/koEkstern.test.ts (aldri hovedrepoet).
// =============================================================
'use strict';

const { execFileSync } = require('node:child_process');
const L = require('./koLogikk.js');
const { konfig } = require('./koKonfig.js');

/** Integrasjonsgrenen fra konfigen (standard main). Leses ved kall, ikke ved lasting. */
const basisGren = () => konfig().baseGren || 'main';
/** Remoten fra konfigen (standard origin). */
const remoteNavn = () => konfig().remote || 'origin';
/** Grenprefikset for køoppgaver fra konfigen (standard ko/). */
const grenPrefiks = () => konfig().grenPrefiks || 'ko/';
/**
 * Grener som aldri regnes som «arbeid utenfor køen» i tillegg til basegrenen (typisk utgivelsesgrenen som følger
 * etter basegrenen). Fra konfigen (`utelatGrener`), standard main og master.
 */
const utelatteGrener = () => konfig().utelatGrener ?? ['main', 'master'];
/** Fjernreferansen til basegrenen, f.eks. origin/main. */
const fjernBasis = ({ basis = basisGren(), remote = remoteNavn() } = {}) => `${remote}/${basis}`;

// Felt- og postskille i `git log --format` (%x1f og %x1e). Laget med fromCharCode, ikke som escape i kildeteksten.
const US = String.fromCharCode(0x1f);
const RS = String.fromCharCode(0x1e);
const FORMAT = '%x1e%H%x1f%P%x1f%cI%x1f%s%x1f%B%x1f';

/**
 * git-kjører for et repo: (args) → stdout (utrimmet), eller null når git feiler. core.quotepath=off gir æøå i
 * filnavn som de er.
 */
function lagGit(cwd) {
  return (args) => {
    try {
      return execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
}

const linjer = (ut) =>
  String(ut ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/** Tolker `git log --format=FORMAT [--name-only]`: [{ sha, kort, foreldre, dato, emne, melding, filer }]. */
function tolkLogg(ut) {
  return String(ut ?? '')
    .split(RS)
    .filter((r) => r.includes(US))
    .map((r) => {
      const [sha, foreldre = '', dato = '', emne = '', melding = '', rest = ''] = r.split(US);
      const s = sha.trim();
      return {
        sha: s,
        kort: s.slice(0, 8),
        foreldre: foreldre.split(' ').filter(Boolean),
        dato: dato.trim(),
        emne: emne.trim(),
        melding: melding.trim(),
        filer: linjer(rest),
      };
    });
}

/**
 * Første-forelder-linja på `til` (standard basegrenen), NYESTE FØRST, med filene hver commit endret mot første
 * forelder (for en flett: alt den tok inn). Vinduet er `fra..til` (f.eks. origin/main..main) eller `--since=<siden>`.
 * null når git feiler (ukjent ref).
 * @param {(args: string[]) => string|null} git
 * @param {{ fra?: string, til?: string, siden?: string }} vindu
 */
function lesForsteForeldre(git, { fra, til = basisGren(), siden } = {}) {
  const args = [
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--name-only',
    `--format=${FORMAT}`,
  ];
  if (siden) args.push(`--since=${siden}`);
  args.push(fra ? `${fra}..${til}` : til, '--');
  const ut = git(args);
  return ut == null ? null : tolkLogg(ut);
}

/**
 * Klassifiserer første-forelder-commitene (koLogikk.klassifiserCommit). En flett som ikke er av en køgren, er ekstern
 * når den selv er det eller tar med minst én commit uten traileren; commitene den tar med (ikke nåbare fra første
 * forelder eller fra `fra`) står i `side`.
 */
function klassifiser(git, commits, { fra } = {}) {
  return (commits ?? []).map((c) => {
    const k = L.klassifiserCommit(c);
    if (c.foreldre.length < 2 || k.kilde === 'ko') return { ...c, ...k, side: [] };
    const [forste, ...andre] = c.foreldre;
    const args = ['log', `--format=${FORMAT}`, ...andre, `^${forste}`];
    if (fra) args.push(`^${fra}`);
    args.push('--');
    const side = tolkLogg(git(args)).map((s) => ({
      ...s,
      kilde: L.harOrkestratorTrailer(s.melding) ? 'orkestrator' : 'ekstern',
    }));
    const ekstern = k.kilde === 'ekstern' || side.some((s) => s.kilde === 'ekstern');
    return { ...c, kilde: ekstern ? 'ekstern' : 'orkestrator', side };
  });
}

/**
 * Ucommittede endringer (`git status --porcelain -z`): [{ xy, sti, usporet }]. Usporede mapper står som «mappe/»
 * (git slår dem sammen). Gitignorerte filer er ikke med. null når git feiler.
 */
function lesUcommittet(git) {
  const ut = git(['status', '--porcelain', '-z']);
  if (ut == null) return null;
  const deler = ut.split('\0');
  const res = [];
  for (let i = 0; i < deler.length; i++) {
    const d = deler[i];
    if (!d || d.length < 4) continue;
    const xy = d.slice(0, 2);
    res.push({ xy, sti: d.slice(3), usporet: xy === '??' });
    // Omdøpt eller kopiert: den gamle stien følger som eget felt.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return res;
}

/** `git worktree list --porcelain`: [{ sti, head, gren (uten refs/heads/) | null, frakoblet }]. */
function lesWorktrees(git) {
  const ut = [];
  let wt = null;
  for (const linje of String(git(['worktree', 'list', '--porcelain']) ?? '').split('\n')) {
    if (linje.startsWith('worktree ')) {
      wt = { sti: linje.slice(9).trim(), head: null, gren: null, frakoblet: false };
      ut.push(wt);
    } else if (wt && linje.startsWith('HEAD ')) wt.head = linje.slice(5).trim();
    else if (wt && linje.startsWith('branch refs/heads/')) wt.gren = linje.slice(18).trim();
    else if (wt && linje.trim() === 'detached') wt.frakoblet = true;
  }
  return ut;
}

/** Antall commits, endrede filer (mot merge-basen) og siste commit for en ref som ikke er flettet til `basis`. */
function refInfo(git, ref, basis) {
  return {
    antall: Number(String(git(['rev-list', '--count', `${basis}..${ref}`]) ?? '0').trim()) || 0,
    filer: linjer(git(['diff', '--name-only', `${basis}...${ref}`, '--'])),
    siste: String(git(['log', '-1', '--format=%cI', ref, '--']) ?? '').trim() || null,
  };
}

/**
 * Lokale grener utenfor køens grenprefiks (og ikke basegrenen eller `utelat`) med commits som ikke er i `basis`, pluss
 * frakoblede worktrees med slike commits (utenom dem som står på køens arbeid, f.eks. et DELVIS-spor etter
 * `git switch --detach`). [{ navn, antall, filer, siste, worktree }], eller null når git feiler.
 * @param {{ basis?: string, prefiks?: string, utelat?: string[] }} [valg] standard fra konfigen
 */
function lesAndreGrener(
  git,
  { basis = basisGren(), prefiks = grenPrefiks(), utelat = utelatteGrener() } = {},
) {
  const ut = git([
    'for-each-ref',
    `--no-merged=${basis}`,
    '--format=%(refname:short)',
    'refs/heads',
  ]);
  if (ut == null) return null;
  const wts = lesWorktrees(git);
  const wtPerGren = new Map(wts.filter((w) => w.gren).map((w) => [w.gren, w.sti]));
  const utelates = (n) => n.startsWith(prefiks) || n === basis || utelat.includes(n);
  const grener = [];
  for (const navn of linjer(ut)) {
    if (utelates(navn)) continue;
    const info = refInfo(git, navn, basis);
    if (info.antall > 0) grener.push({ navn, ...info, worktree: wtPerGren.get(navn) ?? null });
  }
  for (const w of wts.filter((x) => x.frakoblet && x.head)) {
    const info = refInfo(git, w.head, basis);
    if (!info.antall) continue;
    const paKo = linjer(
      git(['branch', '--list', `${prefiks}*`, '--contains', w.head, '--format=%(refname:short)']),
    );
    if (paKo.length) continue;
    grener.push({ navn: `(frakoblet ${w.head.slice(0, 8)})`, ...info, worktree: w.sti });
  }
  return grener;
}

/**
 * Kildene til arbeid utenfor køen i et vindu: klassifiserte første-forelder-commits, de eksterne, grener utenfor
 * køens grenprefiks og ucommittet i repoet `git` peker på (hovedtreet). `feil` lister det som ikke kunne leses.
 * @param {{ vindu?: object, basis?: string, prefiks?: string, utelat?: string[] }} [valg] standard fra konfigen
 */
function eksternKilder(git, { vindu = {}, basis = basisGren(), prefiks, utelat } = {}) {
  const feil = [];
  const raa = lesForsteForeldre(git, { til: basis, ...vindu });
  if (raa == null) feil.push(`kunne ikke lese ${vindu.fra ? `${vindu.fra}..` : ''}${basis}`);
  const commits = klassifiser(git, raa ?? [], { fra: vindu.fra });
  const grener = lesAndreGrener(git, { basis, prefiks, utelat });
  if (grener == null) feil.push('kunne ikke lese grenene');
  const ucommittet = lesUcommittet(git);
  if (ucommittet == null) feil.push('kunne ikke lese git status');
  return {
    commits,
    eksterne: commits.filter((c) => c.kilde === 'ekstern'),
    grener: grener ?? [],
    ucommittet: ucommittet ?? [],
    feil,
  };
}

/**
 * Hele bildet til `ko.mjs ekstern`: kildene, samsvar (eksterne commits som nevner en oppgave), kollisjoner med
 * eierfilene (koLogikk.eksternKollisjoner) og oppgaver uten prosjekt eller funksjon.
 */
function eksternBilde(git, ko, { vindu = {}, basis = basisGren(), prefiks, utelat } = {}) {
  const k = eksternKilder(git, { vindu, basis, prefiks, utelat });
  const oppgaver = ko.oppgaver ?? [];
  return {
    ...k,
    samsvar: L.samsvar(k.eksterne, oppgaver),
    kollisjoner: L.eksternKollisjoner(oppgaver, {
      commits: k.eksterne,
      grener: k.grener,
      ucommittet: k.ucommittet.map((u) => u.sti),
    }),
    registrert: oppgaver.filter((o) => L.erEksternRad(o) && o.status === 'ekstern'),
    mangler: L.manglerProsjekt(oppgaver, ko.prosjekter),
  };
}

/**
 * Per oppgave (til `start`, `plukk` og `sporfil`): kollisjonene siden oppgaven ble lagt inn, eksterne commits som
 * nevner id-en, og advarselsteksten til sporblokka. Map id → { kollisjoner, nevnt, advarsel }.
 */
function eksternForOppgaver(
  git,
  oppgaver,
  { basis = basisGren(), naa = Date.now(), prefiks, utelat } = {},
) {
  const liste = (oppgaver ?? []).filter(Boolean);
  const tider = liste.map((o) => Date.parse(o.lagt_til ?? '')).filter(Number.isFinite);
  // Uten lagt_til: de siste 30 dagene.
  const fraMs = tider.length ? Math.min(...tider) : naa - 30 * 86_400_000;
  const k = eksternKilder(git, {
    vindu: { siden: new Date(fraMs).toISOString() },
    basis,
    prefiks,
    utelat,
  });
  const svar = new Map();
  for (const o of liste) {
    const lagtTil = Date.parse(o.lagt_til ?? '');
    const etter = k.eksterne.filter(
      (c) => !Number.isFinite(lagtTil) || !c.dato || Date.parse(c.dato) > lagtTil,
    );
    const kollisjoner = L.eksternKollisjoner(
      [o],
      { commits: etter, grener: k.grener, ucommittet: k.ucommittet.map((u) => u.sti) },
      { statuser: [o.status] },
    );
    const nevnt = L.samsvar(etter, [o]).map((s) => ({ kort: s.kort, emne: s.emne }));
    svar.set(o.id, {
      kollisjoner,
      nevnt,
      advarsel: L.sporfilAdvarsel(o, kollisjoner, nevnt),
      feil: k.feil,
    });
  }
  return svar;
}

module.exports = {
  basisGren,
  remoteNavn,
  grenPrefiks,
  utelatteGrener,
  fjernBasis,
  lagGit,
  tolkLogg,
  lesForsteForeldre,
  klassifiser,
  lesUcommittet,
  lesWorktrees,
  lesAndreGrener,
  eksternKilder,
  eksternBilde,
  eksternForOppgaver,
};
