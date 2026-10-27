#!/usr/bin/env node
// =============================================================
// klargjor-spor.mjs: gjør et agent-worktree klart for et spor i ett kall. Se docs/orchestration.md og
// docs/mission-template.md (sporets protokoll).
//
// HVORFOR: uten dette bruker hvert spor flere kall på lenker, kopiering og grenbytte før første kodeendring.
// Avhengighetsmappene (konfig().delteLenker, standard node_modules) lenkes til hovedtreet i stedet for å
// installeres på nytt. Regelen er derfor: lenke, ALDRI `npm install` i worktreet (det ville skrevet rett inn i
// hovedtreets mappe, som eieren og de andre sporene bruker).
//
// Hva skriptet gjør (idempotent; kjør det gjerne på nytt):
//   1. Nekter å kjøre i hovedtreet (bare i et worktree).
//   2. Lager lenker for hver sti i konfig().delteLenker til hovedtreet hvis de mangler: junction på Windows
//      (PowerShell New-Item -ItemType Junction), symlenke ellers. Advarer hvis en av dem er en ekte mappe.
//      Mangler mappa i hovedtreet, hoppes den over med en advarsel.
//   3. Er konfig().migrasjoner.miljoFil satt og fila finnes i hovedtreet men ikke i worktreet, kopieres den (den er
//      ofte gitignorert, og push-vakta trenger den for å se hvilket miljø som er koblet til).
//   4. Lager scratchpad-undermappa <scratchpad>/<SPOR>/.
//   5. `git checkout -B <gren> <base>` hvis worktreet ikke alt står på grenen. Nekter hvis det ville kastet
//      ucommittede endringer eller commits som ikke er på basen. Finnes grenen fra før med commits foran basen
//      (etter `ko.mjs slipp` eller en fortsettelse), blir det `git switch <gren>` uten -B.
//      Med --fortsett (retterunde eller fortsettelse i ny agent): grenen MÅ finnes, og det blir alltid
//      `git switch <gren>` uten reset. Nekter (med sti og `git -C <sti> switch --detach`) når grenen er sjekket ut i et
//      annet worktree. Egne commits telles på grenen mot basen, så det spiller ingen rolle at basen er foran grenen.
//   6. Skriver én statuslinje (KLAR / NEKTER).
//
// Bruk:
//   node scripts/orkestrator/klargjor-spor.mjs <SPOR> [--gren <navn>] [--scratchpad <rotmappe>] [--base <ref>]
//        [--fortsett]
//   Standard: --gren <grenPrefiks><SPOR> (konfig().grenPrefiks, standard ko/), --base konfig().baseGren,
//   --scratchpad <os.tmpdir()>/ko-spor.
//   Retterunde: node scripts/orkestrator/klargjor-spor.mjs X-r1 --gren ko/X --fortsett --scratchpad "…"
// =============================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  fortsettBeslutning,
  grenBeslutning,
  worktreeMedGren,
  sporLenker,
} = require('./lib/orkestratorHjelp.js');
const { konfig } = require('./lib/koKonfig.js');
const K = konfig();

const a = process.argv.slice(2);
const verdi = (navn, standard) => {
  const i = a.indexOf(navn);
  return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : standard;
};
const SPOR = a[0] && !a[0].startsWith('--') ? a[0] : undefined;
if (!SPOR) {
  console.error(
    'bruk: klargjor-spor.mjs <SPOR> [--gren <navn>] [--scratchpad <rotmappe>] [--base <ref>] [--fortsett]',
  );
  process.exit(2);
}
const GREN = verdi('--gren', `${K.grenPrefiks}${SPOR}`);
const BASE = verdi('--base', K.baseGren);
const FORTSETT = a.includes('--fortsett');
const SCRATCH = path.resolve(verdi('--scratchpad', path.join(os.tmpdir(), 'ko-spor')), SPOR);

const nekt = (grunn) => {
  console.log(`NEKTER ${SPOR}: ${grunn}`);
  process.exit(1);
};

// Arbeider i worktreet vi står i (cwd), ikke i der skriptet ligger: skriptet kan kjøres fra hovedtreet med
// cwd i worktreet, og da er det worktreet som skal klargjøres.
function git(...args) {
  const r = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
  return { ok: r.status === 0, ut: (r.stdout || '').trim(), feil: (r.stderr || '').trim() };
}

const topp = git('rev-parse', '--show-toplevel');
if (!topp.ok) nekt('ikke i et git-tre');
const WT = path.resolve(topp.ut);
const felles = path.resolve(WT, git('rev-parse', '--git-common-dir').ut);
const egen = path.resolve(WT, git('rev-parse', '--git-dir').ut);
if (felles === egen) nekt(`${WT} er hovedtreet, ikke et worktree`);
const HOVED = path.dirname(felles);

const status = [];

// ---------- 2. lenker ----------
function erLenke(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink(); // Node melder NTFS-junctions som symbolske lenker
  } catch {
    return null; // finnes ikke
  }
}
const ps = (s) => `'${s.split("'").join("''")}'`;

/** Lager en mappe-lenke: junction på Windows (krever ikke adminrettigheter), symlenke ellers. */
function lagLenke(sti, maal) {
  fs.mkdirSync(path.dirname(sti), { recursive: true });
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `New-Item -ItemType Junction -Path ${ps(sti)} -Target ${ps(maal)} | Out-Null`,
      ],
      { encoding: 'utf8' },
    );
    return (r.stderr || '').trim();
  }
  try {
    fs.symlinkSync(maal, sti, 'dir');
    return '';
  } catch (e) {
    return e?.message ?? String(e);
  }
}

let laget = 0;
// Lista er delt med rydd-worktree.mjs (begge leser konfig().delteLenker via sporLenker), så ryddingen alltid
// kjenner hver lenke vi lager her.
for (const rel of sporLenker(K.delteLenker)) {
  const sti = path.join(WT, ...rel.split('/'));
  const maal = path.join(HOVED, ...rel.split('/'));
  const lenke = erLenke(sti);
  if (lenke === true) continue;
  if (lenke === false) {
    status.push(`ADVARSEL ${rel} er en ekte mappe (npm install i worktreet?), ikke lenke`);
    continue;
  }
  if (!fs.existsSync(maal)) {
    status.push(`ADVARSEL hovedtreet mangler ${rel}, ingen lenke`);
    continue;
  }
  const feil = lagLenke(sti, maal);
  if (erLenke(sti) !== true) nekt(`kunne ikke lage lenke ${rel}: ${feil}`);
  laget++;
}
status.push(`lenker ok${laget ? ` (laget ${laget})` : ''}`);

// ---------- 3. miljøfil (valgfri) ----------
const miljoFil = K.migrasjoner?.miljoFil;
if (miljoFil) {
  const her = path.resolve(WT, miljoFil);
  const kilde = path.resolve(HOVED, miljoFil);
  if (!fs.existsSync(her) && fs.existsSync(kilde)) {
    fs.mkdirSync(path.dirname(her), { recursive: true });
    fs.copyFileSync(kilde, her);
    status.push(`${miljoFil} kopiert`);
  }
}

// ---------- 4. scratchpad ----------
fs.mkdirSync(SCRATCH, { recursive: true });
status.push(`scratchpad ${SCRATCH}`);

// ---------- 5. gren ----------
if (!git('rev-parse', '--verify', '--quiet', BASE).ok) nekt(`finner ikke ${BASE}`);
const gjeldende = git('branch', '--show-current').ut;
const skittent = git('status', '--porcelain', '--untracked-files=no').ut.length > 0;
const egneCommits = Number(git('rev-list', '--count', `${BASE}..HEAD`).ut) || 0;
// Finnes målgrenen allerede med commits foran basen (etter `ko.mjs slipp`, eller en fortsettelse i et nytt worktree),
// skal vi bytte til den, aldri nullstille den med -B: da ville commitene bare vært igjen i reflog.
const maalFinnes = git('rev-parse', '--verify', '--quiet', `refs/heads/${GREN}`).ok;
const maalCommits = maalFinnes
  ? Number(git('rev-list', '--count', `${BASE}..refs/heads/${GREN}`).ut) || 0
  : 0;
// --fortsett: ta over en eksisterende gren uten reset, og nekt tydelig når et annet worktree holder den.
const annetWorktree = (() => {
  if (!FORTSETT) return null;
  const sti = worktreeMedGren(git('worktree', 'list', '--porcelain').ut, GREN);
  return sti && path.resolve(sti) !== WT ? sti : null;
})();
const b = FORTSETT
  ? fortsettBeslutning({
      gjeldende,
      gren: GREN,
      finnes: maalFinnes,
      skittent,
      egneCommits,
      annetWorktree,
      base: BASE,
    })
  : grenBeslutning({ gjeldende, gren: GREN, skittent, egneCommits, maalCommits, base: BASE });
if (b.handling === 'nekt') nekt(`vil ikke bytte til ${GREN}: ${b.grunn}`);
if (b.handling === 'switch') {
  const r = git('switch', GREN);
  if (!r.ok)
    nekt(
      `git switch ${GREN} feilet (grenen har ${maalCommits} commit(s) foran ${BASE} og nullstilles ikke): ${r.feil}`,
    );
}
if (b.handling === 'checkout') {
  const r = git('checkout', '-B', GREN, BASE);
  if (!r.ok) nekt(`git checkout -B ${GREN} ${BASE} feilet: ${r.feil}`);
}
const sha = git('rev-parse', '--short', 'HEAD').ut;
const baseSha = git('rev-parse', '--short', BASE).ut;

// Egne commits på grenen vi nå står på, mot basen: for --fortsett er det sporets arbeid så langt.
const naaCommits = Number(git('rev-list', '--count', `${BASE}..HEAD`).ut) || 0;
const grenTekst = FORTSETT
  ? ` (fortsetter, ${naaCommits} egne commit(s) foran ${BASE} ${baseSha})`
  : b.handling === 'checkout'
    ? ` (ny fra ${BASE} ${baseSha})`
    : b.handling === 'switch'
      ? ` (eksisterende gren tatt over, ${maalCommits} commit(s) foran ${BASE} ${baseSha})`
      : ` (base ${BASE} ${baseSha})`;
console.log(`KLAR ${SPOR}: gren ${GREN} @ ${sha}${grenTekst}, ${status.join(', ')}`);
