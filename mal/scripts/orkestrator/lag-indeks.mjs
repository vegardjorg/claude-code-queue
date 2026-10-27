#!/usr/bin/env node
// =============================================================
// lag-indeks.mjs: ordner den valgfrie dokumentindeksen etter planregisteret (se docs/plan-register.md).
//
// Indeksfila står i ko.config.json (`indeksFil`, standard docs/INDEKS.md; null slår funksjonen av). Finnes ikke fila,
// gjør skriptet ingenting (exit 0): lag en fil med en innledning først, så fyller skriptet inn resten.
//
//   node scripts/orkestrator/lag-indeks.mjs            skriver INDEKS på nytt (bare når den er endret)
//   node scripts/orkestrator/lag-indeks.mjs --torr     viser hva som ville blitt endret, skriver ingenting
//   node scripts/orkestrator/lag-indeks.mjs --sjekk    drift-sjekk: exit 1 når INDEKS ikke stemmer med registeret
//
// Seksjonene (modulene), planpost-linjene og nye dokumenter kommer fra registeret; beskrivelsene beholdes ordrett.
// Logikken er ren og ligger i lib/koIndeks.js. Registeret og køen LESES bare (aldri skrevet, så ingen lås):
// ko.mjs skriver dem atomisk, så en lesing ser alltid en hel fil.
//
// Registeret er gitignorert og bor i hovedtreet. Kjøres verktøyet fra et worktree, leses det derfra (samme regel som
// ko.mjs); INDEKS skrives i treet skriptet ligger i. Uten registeret (CI, ren klone) hopper --sjekk over med exit 0.
// Dokumenter git ignorerer, får aldri en oppføring automatisk (indeksen er sporet, de er det ikke).
// KO_MAPPE overstyrer mappa med registeret, KO_INDEKS_FIL fila som skrives og KO_DOKROT prosjektrota stiene er
// relative til (tester).
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const I = require('./lib/koIndeks.js');
const { dataMappe } = require('./lib/koKonfig.js');

// Treet skriptet ligger i (to mapper over scripts/orkestrator/); indeksen skrives her, også i et worktree.
const ROT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAPPE = dataMappe();
const indeksRel = I.indeksFil();
if (!process.env.KO_INDEKS_FIL && !indeksRel) {
  console.log('lag-indeks: indeksen er slått av (indeksFil: null i ko.config.json); hopper over.');
  process.exit(0);
}
const INDEKS = process.env.KO_INDEKS_FIL ?? path.join(ROT, ...indeksRel.split('/'));
// Kildestiene er relative til prosjektrota.
const DOKROT = process.env.KO_DOKROT ?? ROT;

const arg = new Set(process.argv.slice(2));
const ukjent = [...arg].filter((a) => !['--sjekk', '--torr'].includes(a));
if (ukjent.length) {
  console.error(`Ukjent valg: ${ukjent.join(' ')}. Bruk: lag-indeks.mjs [--torr | --sjekk]`);
  process.exit(2);
}
const sjekk = arg.has('--sjekk');
const torr = arg.has('--torr');

const planfil = path.join(MAPPE, 'planer.json');
if (!fs.existsSync(planfil)) {
  console.log(`lag-indeks: planregisteret finnes ikke (${planfil}); hopper over.`);
  process.exit(0);
}
const lesJson = (fil) => JSON.parse(fs.readFileSync(fil, 'utf8'));
const reg = lesJson(planfil);
const kofil = path.join(MAPPE, 'ko.json');
const ko = fs.existsSync(kofil) ? lesJson(kofil) : {};

if (!fs.existsSync(INDEKS)) {
  console.log(`lag-indeks: indeksfila finnes ikke (${INDEKS}); hopper over.`);
  process.exit(0);
}

/** Ignorerer git stien? (Uten git, eller utenfor et repo: nei.) */
function gitIgnorerer(sti) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', sti], { cwd: DOKROT, stdio: 'ignore' });
    return true; // exit 0: ignorert
  } catch {
    return false; // exit 1 (ikke ignorert) eller git mangler
  }
}

const gammel = fs.readFileSync(INDEKS, 'utf8');
const r = I.lagIndeks(gammel, reg, ko, {
  finnes: (sti) => fs.existsSync(path.join(DOKROT, sti)) && !gitIgnorerer(sti),
  indeks: path.relative(DOKROT, INDEKS).split(path.sep).join('/'),
});

if (r.feil.length) {
  console.error(
    'lag-indeks: INDEKS kan ikke leses uten å miste tekst. Rett linjene og kjør på nytt:',
  );
  for (const f of r.feil) console.error(`  ${f}`);
  process.exit(2);
}

const seksjoner = Object.entries(r.antall)
  .map(([oid, n]) => `${oid} ${n}`)
  .join(', ');
const forskjell = I.forsteForskjell(gammel, r.tekst);

if (!forskjell) {
  console.log(`lag-indeks: OK, INDEKS stemmer med registeret (${seksjoner}).`);
  process.exit(0);
}

const nyeTekst = r.nye.length ? ` Nye dokumenter fra registeret: ${r.nye.join(', ')}.` : '';
if (sjekk || torr) {
  console.log(
    `lag-indeks: DRIFT, INDEKS stemmer ikke med registeret (første ulike linje ${forskjell.linje}).${nyeTekst}`,
  );
  console.log(`  nå:  ${forskjell.naa ?? '(slutt)'}`);
  console.log(`  ny:  ${forskjell.ny ?? '(slutt)'}`);
  console.log('  Rett: node scripts/orkestrator/lag-indeks.mjs');
  process.exit(sjekk ? 1 : 0);
}

// Atomisk skriving: midlertidig fil i samme mappe, så rename.
const tmp = `${INDEKS}.${process.pid}.tmp`;
fs.writeFileSync(tmp, r.tekst, 'utf8');
fs.renameSync(tmp, INDEKS);
console.log(`lag-indeks: skrev ${path.relative(DOKROT, INDEKS)} (${seksjoner}).${nyeTekst}`);
