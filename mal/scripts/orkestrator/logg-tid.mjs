#!/usr/bin/env node
// =============================================================
// logg-tid.mjs: tidslogg for parallelle bølger og køen (benchmark av arbeidsmåter), og forbruksmåling.
//
// Skriver én JSON-linje per hendelse til tidsloggen i HOVEDTREET (konfig().tidslogg, standard scripts/.ko/tider.jsonl,
// gitignorert), også når det kjøres fra et worktree (samme regel som ko.mjs og gater.mjs). KO_TIDSLOGG overstyrer
// fila (tester).
//
// Bruk:
//   node scripts/orkestrator/logg-tid.mjs <bølge> <spor|orkestrator> <hendelse> [--varighet-s N] [--merknad "..."]
//   hendelser: start, ferdig, flettet, migrasjon, gater, push (fritt, men hold deg til disse)
//   node scripts/orkestrator/logg-tid.mjs --vis [bølge]
//       tabell over hendelsene. «ferdig»-radene fra hook-tid er kumulative per agent (én per stopp); bare den SISTE
//       per agent_id vises, ellers ville en gjenopptatt agent telt flere ganger.
//   node scripts/orkestrator/logg-tid.mjs --kost [--dag YYYY-MM-DD | --dag i-dag] [--spor-topp N] [--json]
//       forbruk i API-ekvivalente USD (listeprisene i lib/tidKost.js: Opus 5.5 input $4, output $20, cache-lesing
//       $0,20, cache-skriving 5 min $5 / 1 t $8 per MTok), deduplisert per agent: totalt, per agenttype, per
//       risikoklasse (fra køen) og de dyreste sporene med antall cache-utløp. Dag = lokal dato. Uten --dag: alt.
//       Orkestratorøkta selv er ikke med (hooken gjelder bare subagenter).
//
// Eksempel:
//   node scripts/orkestrator/logg-tid.mjs b1 A-1 ferdig --varighet-s 938 --merknad "eksempel"
//   node scripts/orkestrator/logg-tid.mjs --kost --dag i-dag
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('./lib/tidKost.js');
const { dataMappe, tidslogg } = require('./lib/koKonfig.js');

// Tidsloggen og køfila i hovedtreet, også fra et worktree (konfig().rot er alltid hovedtreet). KO_TIDSLOGG og
// KO_MAPPE overstyrer.
const LOGG = tidslogg();
const KO_FIL = path.join(dataMappe(), 'ko.json');

const a = process.argv.slice(2);

const verdi = (navn) => {
  const i = a.indexOf(navn);
  return i >= 0 ? a[i + 1] : undefined;
};
const lesLogg = () => (fs.existsSync(LOGG) ? T.lesRader(fs.readFileSync(LOGG, 'utf8')) : []);

if (a[0] === '--vis') {
  const filter = a[1];
  const rader = T.dedupliserFerdig(lesLogg());
  for (const r of rader.filter((r) => !filter || r.bolge === filter)) {
    const v = r.varighet_s != null ? `${Math.round(r.varighet_s / 60)} min` : '';
    console.log([r.tid, r.bolge, r.spor, r.hendelse, v, r.merknad ?? ''].join('\t'));
  }
  process.exit(0);
}

if (a[0] === '--kost') {
  let dag = verdi('--dag') ?? null;
  if (dag === 'i-dag' || dag === 'idag') dag = T.dagFor(new Date().toISOString());
  if (dag && !/^\d{4}-\d{2}-\d{2}$/.test(dag)) {
    console.error('--dag krever YYYY-MM-DD (eller i-dag).');
    process.exit(2);
  }
  // Risikoklasse per spor fra køen (retterunder som «A-1-r2» hører til A-1). Mangler køen: klasse «ukjent».
  let klasser = new Map();
  try {
    const ko = JSON.parse(fs.readFileSync(KO_FIL, 'utf8'));
    klasser = new Map((ko.oppgaver ?? []).map((o) => [o.id, o.klasse]));
  } catch {
    // ingen kø: ingen klasser
  }
  const klasseFor = (spor) => {
    const id = T.oppgaveIdFor(spor, (x) => klasser.has(x));
    return id ? klasser.get(id) : null;
  };
  const o = T.oppsummerKost(lesLogg(), { dag, klasseFor });
  if (a.includes('--json')) {
    console.log(JSON.stringify(o, null, 1));
    process.exit(0);
  }
  const usd = (x) => `$${x.toFixed(2)}`.padStart(10);
  console.log(
    `Forbruk ${dag ? `${dag} (norsk dato)` : 'hele loggen'}: ${usd(o.total).trim()} API-ekvivalent, deduplisert per agent` +
      `${o.antatt ? ' (noen modeller uten egen pris: priset som Opus 5.5)' : ''}.`,
  );
  console.log('\nPer agenttype:');
  for (const t of o.perType)
    console.log(
      `  ${t.type.padEnd(20)} ${usd(t.usd)} ${`${t.andel} %`.padStart(7)}  ${String(t.agenter).padStart(4)} agenter  ${t.cache_utlop} cache-utløp`,
    );
  if (o.perKlasse.some((k) => k.klasse !== 'ukjent')) {
    console.log('\nPer risikoklasse (fra køen):');
    for (const k of o.perKlasse) console.log(`  ${k.klasse.padEnd(20)} ${usd(k.usd)}`);
  }
  const topp = Number(verdi('--spor-topp') ?? 15);
  if (o.perSpor.length && topp > 0) {
    console.log(
      `\nDyreste spor (topp ${Math.min(topp, o.perSpor.length)} av ${o.perSpor.length}):`,
    );
    for (const s of o.perSpor.slice(0, topp))
      console.log(
        `  ${s.spor.padEnd(20)} ${usd(s.usd)}  ${String(s.turer).padStart(4)} turer  ${String(s.cache_utlop).padStart(3)} cache-utløp  ${s.typer.join(', ')}`,
      );
  }
  process.exit(0);
}

const [bolge, spor, hendelse] = a;
if (!bolge || !spor || !hendelse) {
  console.error('bruk: logg-tid.mjs <bølge> <spor> <hendelse> [--varighet-s N] [--merknad "..."]');
  process.exit(2);
}
const rad = { tid: new Date().toISOString(), bolge, spor, hendelse };
const v = verdi('--varighet-s');
if (v) rad.varighet_s = Number(v);
const m = verdi('--merknad');
if (m) rad.merknad = m;
fs.appendFileSync(LOGG, JSON.stringify(rad) + '\n');
console.log('logget', JSON.stringify(rad));
