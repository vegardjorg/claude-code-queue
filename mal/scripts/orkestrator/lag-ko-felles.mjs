#!/usr/bin/env node
// =============================================================
// lag-ko-felles.mjs: lager felles protokoll for spor som startes fra arbeidskøen (ko.mjs). Se docs/orchestration.md.
//
// Kilden er felles-delen av oppdragsmalen i prosjektet: docs/ko/mission-template.md (reserve:
// docs/mission-template.md). Eierskapet står i hver sporblokk («Eierskap i køen»), og hva andre kjørende oppgaver
// eier, viser `ko.mjs vis`. Plassholderne __GREN__ __HEAD__ __SPOR__ __BLOKK__ fylles av lag-oppdrag.mjs.
// Klasse-seksjonene (<!-- klasse: … -->) beholdes her; lag-oppdrag.mjs velger dem per spor.
// Prosjektnavn, basegren, gater og arkitekturregler hentes fra ko.config.json (konfig()).
// Selve teksten bygges i oppdragTekst.js (lagKoFelles), som testen også bruker.
//
// Bruk: node scripts/orkestrator/lag-ko-felles.mjs --ut <scratchpad>/ko-felles.md [--scratchpad <mappe>]
// Kjør på nytt når oppdragsmalen eller konfigen endres.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const O = require('./oppdragTekst.js');
const { konfig } = require('./lib/koKonfig.js');

const K = konfig();
/** Oppdragsmalen: docs/ko/mission-template.md, ellers docs/mission-template.md (begge relativt til rota). */
const MALER = [
  path.join(K.rot, 'docs', 'ko', 'mission-template.md'),
  path.join(K.rot, 'docs', 'mission-template.md'),
];
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const ut = arg('--ut');
if (!ut) {
  console.error('bruk: lag-ko-felles.mjs --ut <fil> [--scratchpad <mappe>]');
  process.exit(2);
}
const scratch = arg('--scratchpad') ?? path.dirname(path.resolve(ut));

const malFil = MALER.find((m) => fs.existsSync(m));
if (!malFil) {
  console.error(`fant ikke oppdragsmalen (${MALER.join(' eller ')})`);
  process.exit(1);
}
const mal = fs.readFileSync(malFil, 'utf8');
const s = O.lagKoFelles(mal, scratch, K);
const rest = s.match(/<[A-ZÆØÅ_]+>/g);
if (rest) console.log('ADVARSEL, ufylte plassholdere:', [...new Set(rest)].join(', '));
fs.writeFileSync(ut, s);
const perKlasse = O.KLASSER.map((k) => `${k} ${O.filtrerKlasse(s, k).length}`).join(', ');
console.log(`skrev ${ut} (${s.length} tegn; per klasse: ${perKlasse})`);
