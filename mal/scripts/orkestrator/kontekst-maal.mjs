#!/usr/bin/env node
// =============================================================
// kontekst-maal.mjs: grunnlinje og etter-måling for kontekst per tur i køsporene. Se docs/orchestration.md.
//
// Leser tidsloggen (konfig().tidslogg i hovedtreet; KO_TIDSLOGG overstyrer), tar den SISTE «ferdig»-raden per agent i
// tidsvinduet og skriver per agenttype og risikoklasse (fra køen, <datamappe>/ko.json; KO_MAPPE overstyrer):
// antall, median start-kontekst, median og p90 kontekst (agentens median-kontekst), median slutt-kontekst, median
// kall før første endring, median turer, sum og snitt kostnad. Beregningen står i kontekstMaal.js (testet).
//
// Bruk:
//   node scripts/orkestrator/kontekst-maal.mjs [--dager N | --fra <iso>] [--til <iso>] [--json]
//   Standard: --dager 14. Etter-måling: --fra <flettetidspunktet for tiltaket>.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('./kontekstMaal.js');
const T = require('./lib/tidKost.js');
const { dataMappe, tidslogg } = require('./lib/koKonfig.js');

// Tidsloggen og køfila i hovedtreet, også fra et worktree (konfig().rot er alltid hovedtreet). KO_TIDSLOGG og
// KO_MAPPE overstyrer.
const LOGG = tidslogg();
const KO_FIL = path.join(dataMappe(), 'ko.json');

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dø = (m) => {
  console.error(m);
  process.exit(2);
};

let fra = null;
if (arg('--fra') != null) {
  fra = Date.parse(arg('--fra'));
  if (!Number.isFinite(fra)) dø(`ugyldig --fra: ${arg('--fra')}`);
} else {
  const dager = arg('--dager') != null ? Number(arg('--dager')) : 14;
  if (!(dager > 0)) dø('--dager må være et tall over 0');
  fra = Date.now() - dager * 86_400_000;
}
let til = null;
if (arg('--til') != null) {
  til = Date.parse(arg('--til'));
  if (!Number.isFinite(til)) dø(`ugyldig --til: ${arg('--til')}`);
}

let tekst = '';
try {
  tekst = fs.readFileSync(LOGG, 'utf8');
} catch {
  dø(`fant ikke tidsloggen ${LOGG}`);
}
let ko = { oppgaver: [] };
try {
  ko = JSON.parse(fs.readFileSync(KO_FIL, 'utf8'));
} catch {
  // ingen kø: alle klasser blir «ukjent»
}

const maaling = M.maalKontekst(T.lesRader(tekst), { fra, til, klasseFor: M.klasseOppslag(ko) });
if (process.argv.includes('--json')) console.log(JSON.stringify(maaling, null, 2));
else console.log(M.formaterTabell(maaling));
