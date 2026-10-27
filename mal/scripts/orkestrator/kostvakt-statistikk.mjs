#!/usr/bin/env node
// =============================================================
// kostvakt-statistikk.mjs: statistikk for kostvakten, så terskelen (FAKTOR i lib/kostVakt.js) kan kalibreres på data
// i stedet for magefølelse. Se docs/orchestration.md.
//
// Leser:
//   * <datamappe>/kostvakt-logg.jsonl: én linje per varsel (skrevet av hook-kontekst.mjs).
//   * <datamappe>/ko.json: sluttkosten (kost.usd) og status for hver oppgave.
//
// Skriver ut:
//   1. Varsler per klasse: antall, forbruk ved varsel, sluttkost og hvor mye sporet brukte ETTER varselet
//      (lite etter = sporet var nesten ferdig da det ble avrundet, altså et unødvendig varsel).
//   2. Hypotetisk treffrate for alle ferdige oppgaver: andel over 2x, 3x og 4x snittet for klassen.
//
// Bruk: node scripts/orkestrator/kostvakt-statistikk.mjs [--siden <YYYY-MM-DD>]
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Datamappa i hovedtreet (KO_MAPPE overstyrer).
const KO_MAPPE = require('./lib/koKonfig.js').dataMappe();
const LOGG = path.join(KO_MAPPE, 'kostvakt-logg.jsonl');
const KO = path.join(KO_MAPPE, 'ko.json');

const sidenArg = process.argv.indexOf('--siden');
const siden = sidenArg > 0 ? process.argv[sidenArg + 1] : null;

/** Leser jsonl tolerant: ødelagte linjer hoppes over. */
function lesLogg() {
  if (!fs.existsSync(LOGG)) return [];
  return fs
    .readFileSync(LOGG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    })
    .filter((r) => !siden || r.tid >= siden);
}

if (!fs.existsSync(KO)) {
  console.log(`Ingen kø ennå (${KO} finnes ikke); ingenting å regne på.`);
  process.exit(0);
}
const ko = JSON.parse(fs.readFileSync(KO, 'utf8'));
const oppgaver = ko.oppgaver ?? [];
const perId = new Map(oppgaver.map((o) => [o.id, o]));
const usd = (o) => Number(o?.kost?.usd ?? NaN);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : '-');

// 1. Varslene
const varsler = lesLogg();
console.log(`Kostvakt-varsler${siden ? ` siden ${siden}` : ''}: ${varsler.length}`);
const perKlasse = {};
for (const v of varsler) (perKlasse[v.klasse] ??= []).push(v);
for (const [klasse, liste] of Object.entries(perKlasse)) {
  const ferdige = liste.filter((v) => perId.get(v.id)?.status === 'ferdig');
  const etter = ferdige.map((v) => usd(perId.get(v.id)) - v.usd).filter(Number.isFinite);
  const snittEtter = etter.length ? etter.reduce((a, b) => a + b, 0) / etter.length : NaN;
  const smaa = etter.filter((e) => e < 0.25 * (liste[0]?.snitt ?? Infinity)).length;
  console.log(
    `  ${klasse}: ${liste.length} varsel, ${ferdige.length} ferdige; brukt etter varsel snitt $${r2(snittEtter)}` +
      `; ${smaa} brukte under 0,25x klassesnittet etter varselet (trolig nesten ferdige)`,
  );
}
for (const v of varsler.slice(-15)) {
  const o = perId.get(v.id);
  console.log(
    `    ${v.tid.slice(0, 16)} ${v.id.padEnd(14)} ${v.klasse.padEnd(3)} varsel $${v.usd} (${v.faktor}x $${v.snitt})` +
      ` -> slutt $${r2(usd(o))} ${o?.status ?? '?'}`,
  );
}

// 2. Hypotetisk treffrate på alle ferdige med målt kost (samme periode hvis --siden)
const ferdige = oppgaver.filter(
  (o) => o.status === 'ferdig' && Number.isFinite(usd(o)) && (!siden || (o.ferdig ?? '') >= siden),
);
const gruppe = {};
for (const o of ferdige) (gruppe[o.klasse] ??= []).push(usd(o));
console.log(`\nHypotetisk: andel ferdige over Nx klassesnittet (${ferdige.length} oppgaver)`);
for (const [klasse, v] of Object.entries(gruppe)) {
  const s = v.reduce((a, b) => a + b, 0) / v.length;
  const over = (f) => v.filter((x) => x > f * s).length;
  console.log(
    `  ${klasse.padEnd(3)} n=${v.length} snitt $${r2(s)}  >2x ${over(2)}  >3x ${over(3)}  >4x ${over(4)}  maks $${r2(Math.max(...v))}`,
  );
}
