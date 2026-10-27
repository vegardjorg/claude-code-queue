#!/usr/bin/env node
// =============================================================
// rydd-worktree.mjs: rydder et spors worktree etter vellykket fletting (kalt fra flett-spor.mjs),
// og etterslepet under .claude/worktrees/ med --alle. Se docs/orchestration.md.
//
// HVORFOR: worktreene hoper seg opp (ett per spor), og filovervåkere og verktøy blir trege eller gir opp. De må ryddes
// løpende. To feller gjør ryddingen farlig:
//   * klargjor-spor.mjs lager lenker (junction på Windows, symlenke ellers) for konfig().delteLenker (standard
//     node_modules) til HOVEDTREETS mapper. En sletting som følger en slik lenke, tømmer mappa i hovedtreet, og da
//     stopper både eierens utviklingsserver og alle andre spor.
//   * `git worktree remove` feiler ofte med «Directory not empty»/«Permission denied» på mapper med symlenker og harde
//     lenker. Git har da ALLEREDE avregistrert worktreet, men mappa står igjen.
//
// SLIK (ryddWorktree): kriteriene i skalRyddes → fingeravtrykk av hovedtreet → hver sti i delteLenker fjernes som LENKE
// (`cmd /c rmdir` UTEN /s på Windows, unlink ellers: fjerner lenken og aldri målet; en ekte mappe der stopper alt) →
// nytt fingeravtrykk → `git worktree remove` UTEN --force (git nekter selv ved endringer eller lås) → står mappa igjen
// og git har avregistrert den, og ingen mappe-lenke inne i den peker UT av worktreet: `cmd /c rmdir /s /q` på Windows,
// fs.rmSync ellers (ingen av dem følger lenker) → siste fingeravtrykk. Grenen slettes ALDRI (commitene skal bestå).
//
// ALDRI: --force på git worktree remove, røre låste worktrees, PowerShell Remove-Item -Recurse (PS 5.1 kan følge junctions)
// eller en rekursiv sletting før lenkene er fjernet, eller rydde noe utenfor .claude/worktrees/.
//
// BRUK:
//   node scripts/orkestrator/rydd-worktree.mjs --alle [--utfor] [--min-alder-timer 3]
//       Tørrkjøring er standard: lister hva som ville blitt fjernet og hvorfor resten står. Flettet = inne i basegrenen
//       (konfig().baseGren). Mapper under .claude/worktrees/ som git ikke kjenner (rester etter en tidligere rydding)
//       tas også.
//   node scripts/orkestrator/rydd-worktree.mjs <gren> [--utfor] [--mot <ref>]     (én gren, standard mot basegrenen)
//   import { ryddWorktree } from './rydd-worktree.mjs'                            (flett-spor.mjs, mot HEAD)
// Test: npx vitest run scripts/orkestrator/__tests__/rydd-worktree.test.mjs
// =============================================================

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { sporLenker } = require('./lib/orkestratorHjelp.js');
const { konfig } = require('./lib/koKonfig.js');

/** Lenkene sporene får (konfig().delteLenker), normalisert. Leses ved bruk, så testen kan importere uten konfig. */
const lenker = () => sporLenker(konfig().delteLenker);

const WIN = process.platform === 'win32';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
  return { ok: r.status === 0, ut: (r.stdout || '').trim(), feil: (r.stderr || '').trim() };
}

/** true når `sti` ligger INNE i `rot` (ikke lik rot). path.win32.relative sammenligner uten store/små bokstaver. */
export function erUnder(sti, rot) {
  const rel = path.relative(path.resolve(rot), path.resolve(sti));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
const samme = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';

/**
 * Ren beslutning: skal worktreet ryddes? Første grunn som slår til, vinner. Rekkefølgen går fra billig til dyr, så
 * kalleren kan la være å regne ut `skitne` (git status) og `ekteLenkemappe` når en tidligere grunn allerede stopper.
 *  - underWorktreesMappe: ligger under <hovedtre>/.claude/worktrees/
 *  - laast:               porcelain-linja «locked»
 *  - erGjeldendeKatalog:  process.cwd() ligger i worktreet
 *  - flettet:             grenens commit er forfar til HEAD (flett-spor) eller basegrenen (--alle)
 *  - forNy:               endret innenfor minstealderen (--alle), så nyklargjorte spor ikke rammes
 *  - skitne:              antall linjer i `git status --porcelain` (boolean godtas; negativ/ukjent = ikke rydd)
 *  - ekteLenkemappe:      relativ sti i delteLenker som er en EKTE mappe (npm install i worktreet?), ellers null
 */
export function skalRyddes({
  underWorktreesMappe,
  laast,
  erGjeldendeKatalog,
  flettet,
  forNy = false,
  skitne,
  ekteLenkemappe = null,
}) {
  if (!underWorktreesMappe) return { rydd: false, grunn: 'ligger ikke under .claude/worktrees/' };
  if (laast) return { rydd: false, grunn: 'låst' };
  if (erGjeldendeKatalog) return { rydd: false, grunn: 'er gjeldende katalog' };
  if (!flettet) return { rydd: false, grunn: 'ikke flettet' };
  if (forNy) return { rydd: false, grunn: 'endret nylig (under minstealderen)' };
  const antall = typeof skitne === 'boolean' ? (skitne ? 1 : 0) : skitne;
  if (typeof antall !== 'number' || Number.isNaN(antall) || antall < 0)
    return { rydd: false, grunn: 'ukjent status (git status feilet)' };
  if (antall > 0) return { rydd: false, grunn: `ucommittede endringer (${antall})` };
  if (ekteLenkemappe) return { rydd: false, grunn: `${ekteLenkemappe} er ikke en lenke` };
  return { rydd: true, grunn: 'flettet, rent og ulåst' };
}

export function hovedtre(cwd = process.cwd()) {
  const r = git(['rev-parse', '--git-common-dir'], cwd);
  if (!r.ok) throw new Error(`ikke i et git-tre: ${r.feil}`);
  return path.dirname(path.resolve(cwd, r.ut));
}

/** `git worktree list --porcelain` som objekter: { sti, head, gren, laast, detached, prunable }. */
export function worktreeListe(hoved) {
  const r = git(['worktree', 'list', '--porcelain'], hoved);
  if (!r.ok) throw new Error(`git worktree list feilet: ${r.feil}`);
  const ut = [];
  let cur = null;
  for (const l of r.ut.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) {
      cur = {
        sti: path.resolve(l.slice(9)),
        head: null,
        gren: null,
        laast: false,
        detached: false,
        prunable: false,
      };
      ut.push(cur);
    } else if (!cur) continue;
    else if (l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (l.startsWith('branch ')) cur.gren = l.slice(7).replace(/^refs\/heads\//, '');
    else if (l === 'detached') cur.detached = true;
    else if (l === 'locked' || l.startsWith('locked ')) cur.laast = true;
    else if (l === 'prunable' || l.startsWith('prunable ')) cur.prunable = true;
  }
  return ut;
}

/**
 * Fingeravtrykket av hovedtreets delte mapper (delteLenker): antall oppføringer i hver. Det skal være uendret før og
 * etter hvert trinn; endrer det seg, har noe fulgt en lenke inn i hovedtreet, og ryddingen stopper.
 */
export function fingeravtrykk(hoved, liste = lenker()) {
  const ut = {};
  for (const rel of liste) {
    try {
      ut[rel] = fs.readdirSync(path.join(hoved, ...rel.split('/'))).length;
    } catch {
      ut[rel] = -1;
    }
  }
  return ut;
}
const likeAvtrykk = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function alarm(etikett, foer, etter) {
  const melding =
    `${etikett}: FINGERAVTRYKKET AV HOVEDTREETS DELTE MAPPER ENDRET SEG. Stoppet. ` +
    `Før ${JSON.stringify(foer)}, etter ${JSON.stringify(etter)}. Sjekk ${Object.keys(foer).join(', ') || 'de delte mappene'} i hovedtreet nå.`;
  console.error(`\n!!! ${melding}\n`);
  return { status: 'feil', melding };
}

function lenkeType(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 'mangler';
  }
  if (st.isSymbolicLink()) return 'lenke'; // Node melder NTFS-junctions som symbolske lenker
  return st.isDirectory() ? 'mappe' : 'annet';
}

const winSti = (p) => path.resolve(p).split('/').join('\\');

/** Fjerner BARE lenken (rmdir uten /s), aldri målet. */
function fjernLenke(p) {
  if (WIN) execFileSync('cmd', ['/c', 'rmdir', winSti(p)], { stdio: 'pipe' });
  else fs.unlinkSync(p);
  if (lenkeType(p) !== 'mangler') throw new Error(`lenken ${p} står fortsatt`);
}

/** Mappe-lenker inne i `rot` som peker UT av rot. Følger aldri lenker. Uleselige mapper rapporteres (ukjent = utrygt). */
export function finnUtLenker(rot) {
  const ut = [];
  const uleselige = [];
  const stakk = [rot];
  while (stakk.length) {
    const dir = stakk.pop();
    let oppf;
    try {
      oppf = fs.readdirSync(dir);
    } catch (e) {
      uleselige.push(`${dir} (${e.code})`);
      continue;
    }
    for (const navn of oppf) {
      const p = path.join(dir, navn);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let maal = null;
        let erMappe = false;
        try {
          maal = fs.realpathSync(p);
          erMappe = fs.statSync(p).isDirectory();
        } catch {
          // Dinglende lenke: slettingen fjerner bare lenken selv.
        }
        if (erMappe && !erUnder(maal, rot) && !samme(maal, rot)) ut.push(`${p} -> ${maal}`);
        continue;
      }
      if (st.isDirectory()) stakk.push(p);
    }
  }
  return { ut, uleselige };
}

function gitdirFor(wt) {
  try {
    const m = fs.readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(wt, m[1].trim()) : null;
  } catch {
    return null;
  }
}
/**
 * Siste aktivitet: rota i worktreet (endres når klargjor-spor lager lenkene) og HEAD/logs/HEAD (endres ved checkout og
 * commit). IKKE index eller selve git-mappa: en ren `git status` (også vår egen tørrkjøring og ko-overtak.mjs) skriver dem
 * på nytt, og da ville alle worktrees sett nye ut i tre timer etter hver tørrkjøring. Pågående, ucommittet arbeid stoppes
 * uansett av sjekken for skitne worktrees.
 */
function sistEndretMs(wt) {
  const gd = gitdirFor(wt);
  const kandidater = [wt, ...(gd ? [path.join(gd, 'HEAD'), path.join(gd, 'logs', 'HEAD')] : [])];
  let maks = 0;
  for (const k of kandidater) {
    try {
      maks = Math.max(maks, fs.statSync(k).mtimeMs);
    } catch {
      // finnes ikke
    }
  }
  return maks;
}
const forNyTid = (wt, minAlderTimer) =>
  minAlderTimer > 0 && Date.now() - sistEndretMs(wt) < minAlderTimer * 3600e3;

function ekteLenkemappeI(wt) {
  for (const rel of lenker()) {
    const t = lenkeType(path.join(wt, ...rel.split('/')));
    if (t === 'mappe' || t === 'annet') return rel;
  }
  return null;
}

const etikett = (w) => `${path.basename(w.sti)}${w.gren ? ` (${w.gren})` : ''}`;

/** Regner ut kriteriene for et registrert worktree, billigst først, og returnerer skalRyddes-svaret. */
export function vurder(w, { mot = 'HEAD', minAlderTimer = 0, hoved }) {
  const inn = {
    underWorktreesMappe: erUnder(w.sti, path.join(hoved, '.claude', 'worktrees')),
    laast: w.laast,
    erGjeldendeKatalog: erUnder(process.cwd(), w.sti) || samme(process.cwd(), w.sti),
  };
  const forlop = skalRyddes({ ...inn, flettet: true, skitne: 0 });
  if (!forlop.rydd) return forlop;
  if (w.prunable || !fs.existsSync(w.sti))
    return { rydd: false, grunn: 'mappa finnes ikke (git worktree prune)' };
  inn.flettet = !!w.head && git(['merge-base', '--is-ancestor', w.head, mot], hoved).ok;
  if (!inn.flettet) return skalRyddes(inn);
  inn.forNy = forNyTid(w.sti, minAlderTimer);
  if (inn.forNy) return skalRyddes(inn);
  const s = git(['-C', w.sti, 'status', '--porcelain'], hoved);
  inn.skitne = s.ok ? s.ut.split('\n').filter(Boolean).length : -1;
  inn.ekteLenkemappe = ekteLenkemappeI(w.sti);
  return skalRyddes(inn);
}

/** Trinn 5: mappa står igjen etter at git har avregistrert den. */
function slettRest(sti, hoved, foer, navn) {
  const { ut, uleselige } = finnUtLenker(sti);
  if (ut.length)
    return {
      status: 'rester',
      melding: `${navn}: mappe-lenke peker ut av worktreet, lar stå: ${ut.slice(0, 3).join('; ')}`,
    };
  if (uleselige.length)
    return {
      status: 'rester',
      melding: `${navn}: kunne ikke lese ${uleselige.slice(0, 3).join('; ')}, lar stå`,
    };
  if (WIN) {
    try {
      execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', winSti(sti)], { stdio: 'pipe' });
    } catch {
      // rmdir gir feilkode når noe holdes åpent; resultatet sjekkes under.
    }
  } else {
    try {
      // fs.rmSync følger ikke symlenker (de fjernes som lenker), og ingen lenke peker ut (sjekket over).
      fs.rmSync(sti, { recursive: true, force: true });
    } catch {
      // resultatet sjekkes under
    }
  }
  const etter = fingeravtrykk(hoved);
  if (!likeAvtrykk(foer, etter)) return alarm(navn, foer, etter);
  if (fs.existsSync(sti))
    return {
      status: 'rester',
      melding: `${navn}: mappa står igjen (holdes åpen av en prosess?), --alle tar den senere: ${sti}`,
    };
  return {
    status: 'fjernet',
    melding: `${navn}: fjernet (restene etter git worktree remove slettet)`,
  };
}

/** Fjerner lenkene (delteLenker) som lenker. Returnerer null når alt gikk bra, ellers et resultat som stopper ryddingen. */
function fjernSporLenker(sti, hoved, foer, navn) {
  for (const rel of lenker()) {
    const p = path.join(sti, ...rel.split('/'));
    const t = lenkeType(p);
    if (t === 'mangler') continue;
    if (t !== 'lenke')
      return { status: 'hoppet over', melding: `${navn}: ${rel} er ikke en lenke` };
    try {
      fjernLenke(p);
    } catch (e) {
      return {
        status: 'hoppet over',
        melding: `${navn}: kunne ikke fjerne lenken ${rel}: ${e.message}`,
      };
    }
  }
  const etter = fingeravtrykk(hoved);
  if (!likeAvtrykk(foer, etter)) return alarm(navn, foer, etter);
  return null;
}

function ryddRegistrert(w, { mot, minAlderTimer, hoved }) {
  const navn = etikett(w);
  const v = vurder(w, { mot, minAlderTimer, hoved });
  if (!v.rydd) return { status: 'hoppet over', melding: `${navn}: ${v.grunn}` };
  const foer = fingeravtrykk(hoved);
  const stopp = fjernSporLenker(w.sti, hoved, foer, navn);
  if (stopp) return stopp;
  const r = git(['worktree', 'remove', w.sti], hoved);
  if (!fs.existsSync(w.sti)) {
    const etter = fingeravtrykk(hoved);
    if (!likeAvtrykk(foer, etter)) return alarm(navn, foer, etter);
    return { status: 'fjernet', melding: `${navn}: fjernet` };
  }
  if (worktreeListe(hoved).some((x) => samme(x.sti, w.sti)))
    return {
      status: 'hoppet over',
      melding: `${navn}: git worktree remove nektet (${r.feil || 'ukjent grunn'}); lenkene er fjernet, kjør klargjor-spor.mjs for å lage dem igjen`,
    };
  return slettRest(w.sti, hoved, foer, navn);
}

/**
 * Rydder worktreet som har `gren` sjekket ut. Kalles av flett-spor.mjs etter vellykket fletting (mot = 'HEAD').
 * Returnerer { status: 'fjernet' | 'hoppet over' | 'rester' | 'feil', melding }. Kaster bare ved uventede feil.
 */
export function ryddWorktree(gren, { mot = 'HEAD', minAlderTimer = 0, hoved = hovedtre() } = {}) {
  const w = worktreeListe(hoved).find((x) => x.gren === gren);
  if (!w) return { status: 'hoppet over', melding: `ingen worktree for ${gren}` };
  return ryddRegistrert(w, { mot, minAlderTimer, hoved });
}

/** Mapper under .claude/worktrees/ som git ikke kjenner: rester etter en tidligere rydding. */
function ryddUregistrert(sti, { minAlderTimer, hoved, utfor }) {
  const navn = `${path.basename(sti)} (ikke registrert)`;
  if (erUnder(process.cwd(), sti) || samme(process.cwd(), sti))
    return { status: 'hoppet over', melding: `${navn}: er gjeldende katalog` };
  if (forNyTid(sti, minAlderTimer))
    return { status: 'hoppet over', melding: `${navn}: endret nylig (under minstealderen)` };
  const ekte = ekteLenkemappeI(sti);
  if (ekte) return { status: 'hoppet over', melding: `${navn}: ${ekte} er ikke en lenke` };
  if (!utfor)
    return { status: 'ville fjernet', melding: `${navn}: rester etter tidligere rydding` };
  const foer = fingeravtrykk(hoved);
  const stopp = fjernSporLenker(sti, hoved, foer, navn);
  if (stopp) return stopp;
  return slettRest(sti, hoved, foer, navn);
}

function hovedprogram() {
  const args = process.argv.slice(2);
  const verdi = (n, s) => (args.includes(n) ? args[args.indexOf(n) + 1] : s);
  const utfor = args.includes('--utfor');
  const baseGren = konfig().baseGren;
  const hoved = hovedtre();
  const rot = path.join(hoved, '.claude', 'worktrees');
  const resultater = [];

  if (args.includes('--alle')) {
    const minAlderTimer = Number(verdi('--min-alder-timer', '3'));
    const liste = worktreeListe(hoved);
    for (const w of liste) {
      if (!erUnder(w.sti, rot)) continue; // hovedtreet og alt utenfor .claude/worktrees/ røres aldri
      let r;
      if (utfor) r = ryddRegistrert(w, { mot: baseGren, minAlderTimer, hoved });
      else {
        const v = vurder(w, { mot: baseGren, minAlderTimer, hoved });
        r = v.rydd
          ? { status: 'ville fjernet', melding: `${etikett(w)}: ${v.grunn}` }
          : { status: 'hoppet over', melding: `${etikett(w)}: ${v.grunn}` };
      }
      resultater.push(r);
      if (r.status === 'feil') break;
    }
    const kjente = new Set(liste.map((w) => path.resolve(w.sti).toLowerCase()));
    let mapper = [];
    try {
      mapper = fs.readdirSync(rot).map((n) => path.join(rot, n));
    } catch {
      // ingen worktrees-mappe
    }
    for (const sti of mapper) {
      if (resultater.some((r) => r.status === 'feil')) break;
      if (kjente.has(path.resolve(sti).toLowerCase())) continue;
      if (lenkeType(sti) !== 'mappe') continue;
      resultater.push(ryddUregistrert(sti, { minAlderTimer, hoved, utfor }));
    }
  } else {
    const gren = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--mot');
    if (!gren) {
      console.error(
        'bruk: rydd-worktree.mjs --alle [--utfor] [--min-alder-timer 3] | <gren> [--utfor] [--mot <ref>]',
      );
      process.exit(2);
    }
    const mot = verdi('--mot', baseGren);
    const w = worktreeListe(hoved).find((x) => x.gren === gren);
    if (!w) resultater.push({ status: 'hoppet over', melding: `ingen worktree for ${gren}` });
    else if (utfor) resultater.push(ryddRegistrert(w, { mot, minAlderTimer: 0, hoved }));
    else {
      const v = vurder(w, { mot, minAlderTimer: 0, hoved });
      resultater.push({
        status: v.rydd ? 'ville fjernet' : 'hoppet over',
        melding: `${etikett(w)}: ${v.grunn}`,
      });
    }
  }

  for (const r of resultater) console.log(`${r.status.padEnd(13)} ${r.melding}`);
  const perStatus = {};
  for (const r of resultater) perStatus[r.status] = (perStatus[r.status] || 0) + 1;
  const perGrunn = {};
  for (const r of resultater.filter((x) => x.status === 'hoppet over')) {
    const g = r.melding.slice(r.melding.indexOf(': ') + 2).replace(/\(\d+\)/, '(n)');
    perGrunn[g] = (perGrunn[g] || 0) + 1;
  }
  console.log(
    `\n${utfor ? 'UTFØRT' : 'TØRRKJØRING (legg til --utfor for å rydde)'}: ${JSON.stringify(perStatus)}`,
  );
  for (const [g, n] of Object.entries(perGrunn).sort((a, b) => b[1] - a[1]))
    console.log(`  står: ${n} × ${g}`);
  const fp = fingeravtrykk(hoved);
  console.log(`Fingeravtrykk hovedtreet: ${JSON.stringify(fp)}`);
  process.exit(resultater.some((r) => r.status === 'feil') ? 1 : 0);
}

// Kjør CLI bare når fila startes direkte (ikke ved import fra flett-spor.mjs eller testen). Store/små bokstaver i
// stasjonsbokstaven kan variere på Windows, så sammenligningen er uten hensyn til dem der.
const startet = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
const lik = WIN
  ? startet.toLowerCase() === import.meta.url.toLowerCase()
  : startet === import.meta.url;
if (lik) hovedprogram();
