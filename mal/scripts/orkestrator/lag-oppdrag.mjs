#!/usr/bin/env node
// =============================================================
// lag-oppdrag.mjs: lager ett oppdrag per spor (køen eller en parallell bølge). Se docs/orchestration.md.
//
// Inndata:
//   --felles <fil>  felles protokoll (laget av lag-ko-felles.mjs fra docs/ko/mission-template.md).
//                   Plassholdere: __GREN__ __HEAD__ __SPOR__ __BLOKK__
//   --spor <fil>    sporblokkene, hver på formen:
//                     =====A-1=====
//                     TITTEL: SPOR A-1 (kort navn)
//                     GREN: ko/A-1   (valgfri; ellers <grenPrefiks><id> fra ko.config.json)
//                     BLOKK: 0040–0049 (valgfri migrasjonsblokk; fritekst etter er lov)
//                     KLASSE: D+   (valgfri; ellers «klasse X» i ## SPOR-linja)
//                     <tom linje eller hva som helst>
//                     ## SPOR A-1 ... (sporets innhold)
//   --head <sha>    commit sporene skal starte fra (eller nyere)
//   --ut <mappe>    hvor prompt-<SPOR>.md skrives (standard: samme mappe som --spor)
//
// Teksten lages i oppdragTekst.js:
//   - Klasse-seksjonene i felles protokoll (<!-- klasse: D D+ --> … <!-- /klasse -->) tas bare med når sporets
//     klasse står i lista. Ukjent klasse gir hele protokollen.
//   - Seksjonspekere i sporets innhold («docs/x.md § 3», «docs/x.md#overskrift») får «(linje A–B)» påført, beregnet
//     nå. Relative stier slås opp fra dette treet og så hovedtreet (gitignorerte dokumenter finnes bare der).
//
// Eksempel:
//   node scripts/orkestrator/lag-oppdrag.mjs --felles scratch/ko-felles.md --spor scratch/ko-spor.md --head 849a5773
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const O = require('./oppdragTekst.js');
const { konfig } = require('./lib/koKonfig.js');

const K = konfig();
// Dette treet (kan være et worktree) og hovedtreet (konfig().rot er alltid hovedtreet).
const ROT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOVEDTRE = K.rot;

/** Leser et pekt dokument: absolutt sti, ellers relativt til dette treet og så hovedtreet. Null når det mangler. */
function lesDokument(fil) {
  const kandidater = path.isAbsolute(fil) ? [fil] : [path.join(ROT, fil), path.join(HOVEDTRE, fil)];
  for (const k of kandidater) {
    try {
      return fs.readFileSync(k, 'utf8');
    } catch {
      // prøv neste kandidat
    }
  }
  return null;
}

const arg = (navn) => {
  const i = process.argv.indexOf(navn);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const fellesFil = arg('--felles');
const sporFil = arg('--spor');
const head = arg('--head');
if (!fellesFil || !sporFil || !head) {
  console.error('bruk: lag-oppdrag.mjs --felles <fil> --spor <fil> --head <sha> [--ut <mappe>]');
  process.exit(2);
}
const ut = arg('--ut') ?? path.dirname(sporFil);
const felles = fs.readFileSync(fellesFil, 'utf8');
const spor = fs.readFileSync(sporFil, 'utf8');

// Bytter plassholdere med split/join, aldri String.replace (en erstatning med «$'» dupliserer tekst).
const bytt = (s, fra, til) => s.split(fra).join(til);

// Id-er kan ha bindestrek og punktum (for eksempel A-1a), ikke bare \w.
const deler = spor.split(/^=====([A-Za-z0-9._-]+)=====\r?\n/m).slice(1);
if (deler.length === 0) {
  console.error('fant ingen sporblokker (=====ID=====)');
  process.exit(1);
}
for (let i = 0; i < deler.length; i += 2) {
  const id = deler[i];
  const linjer = deler[i + 1].split(/\r?\n/);
  const tittel = (linjer.find((l) => l.startsWith('TITTEL:')) ?? `TITTEL: SPOR ${id}`)
    .slice(7)
    .trim();
  const blokk = (linjer.find((l) => l.startsWith('BLOKK:')) ?? 'BLOKK: (ingen)').slice(6).trim();
  // Valgfri GREN:-linje; ellers <grenPrefiks><id> (standard ko/<id>).
  const gren = (linjer.find((l) => l.startsWith('GREN:')) ?? `GREN: ${K.grenPrefiks}${id}`).slice(5).trim();
  const start = linjer.findIndex((l) => l.startsWith('## '));
  const kropp = O.seksjonsPekere(
    linjer
      .slice(start >= 0 ? start : 0)
      .join('\n')
      .trim(),
    lesDokument,
  );
  const klasse = O.klasseFraBlokk(deler[i + 1]);
  let tekst = O.filtrerKlasse(felles, klasse);
  tekst = bytt(tekst, '__GREN__', gren);
  tekst = bytt(tekst, '__HEAD__', head);
  tekst = bytt(tekst, '__SPOR__', id);
  tekst = bytt(tekst, '__BLOKK__', blokk);
  const fil = path.join(ut, `prompt-${id}.md`);
  const blokkLinje = blokk === '(ingen)' ? '' : `Migrasjonsblokk: ${blokk}\n\n`;
  fs.writeFileSync(fil, `# ${tittel}\n\n${blokkLinje}${tekst}\n\n${kropp}\n`);
  console.log(
    `skrev ${fil} (klasse ${klasse ?? 'ukjent, hele protokollen'}, felles ${tekst.length} tegn)`,
  );
}
