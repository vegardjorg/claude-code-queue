#!/usr/bin/env node
// =============================================================
// gater.mjs: kjører prosjektets gater (konfig().gater.rask eller .full fra ko.config.json) i rekkefølge.
//
// HVORFOR: sporene og orkestratoren skal sjekke arbeidet på samme måte uansett prosjekt. Hvilke kommandoer som er
// gater (typesjekk, lint, tester, egne sjekker) er prosjektets sak og står i ko.config.json, ikke her.
//   --rask  det sporene kjører før levering (raske sjekker).
//   --full  det orkestratoren kjører etter fletting og før en batch-push (alt).
//
// Kjører i process.cwd() når den er prosjektrota eller et worktree av prosjektet (et spor sjekker sitt eget
// worktree), ellers i prosjektrota. Hver gate er en skallkommando; den er grønn når exit-koden er 0.
//
// Utdata: én linje per gate (GRØNN/RØD + varighet, og første feillinje for røde) og en sluttlinje.
// Exit 0 når alle er grønne (eller ingen gater er satt opp), 1 ellers.
//   --logg <fil>  skriver hele utdataene fra hver gate til fila (for feilsøking uten å fylle konteksten).
//
// Bruk: node scripts/orkestrator/gater.mjs --rask|--full [--logg <fil>]
// Se docs/orchestration.md.
// =============================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { konfig } = require('./lib/koKonfig.js');
const { forsteFeillinje, gateType, resultatLinje } = require('./lib/orkestratorHjelp.js');

const args = process.argv.slice(2);
const rask = args.includes('--rask');
const full = args.includes('--full');
if (rask === full) {
  console.error('bruk: gater.mjs --rask|--full [--logg <fil>]');
  process.exit(2);
}
const li = args.indexOf('--logg');
const loggFil = li >= 0 && args[li + 1] ? path.resolve(args[li + 1]) : null;

const K = konfig();
const modus = rask ? 'rask' : 'full';
const gater = (Array.isArray(K.gater?.[modus]) ? K.gater[modus] : []).filter(
  (g) => typeof g === 'string' && g.trim(),
);
if (gater.length === 0) {
  console.log('ingen gater satt opp i ko.config.json');
  process.exit(0);
}

/** Er `sti` prosjektrota eller et worktree av prosjektet (<rot>/.claude/worktrees/<navn>/...)? */
function iProsjektet(sti) {
  const rel = path.relative(K.rot, sti);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const cwd = iProsjektet(process.cwd()) ? process.cwd() : K.rot;

if (loggFil) fs.writeFileSync(loggFil, `gater --${modus} i ${cwd}\n`);
const bredde = Math.min(60, Math.max(...gater.map((g) => g.length)) + 2);
const start = Date.now();
let rode = 0;

for (const kommando of gater) {
  const t0 = Date.now();
  const r = spawnSync(kommando, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const sek = (Date.now() - t0) / 1000;
  const ut = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
  const gronn = r.status === 0;
  if (!gronn) rode++;
  console.log(
    resultatLinje(
      {
        navn: kommando,
        status: gronn ? 'GRØNN' : 'RØD',
        sek,
        forste: gronn ? '' : forsteFeillinje(gateType(kommando), ut, cwd),
      },
      bredde,
    ),
  );
  if (loggFil)
    fs.appendFileSync(loggFil, `\n===== ${kommando} (exit ${r.status ?? 'ukjent'}, ${Math.round(sek)} s) =====\n${ut}`);
}

const totalt = Math.round((Date.now() - start) / 1000);
console.log(
  rode === 0
    ? `ALLE GRØNNE: ${gater.length} gate(r) --${modus} på ${totalt} s`
    : `RØD: ${rode} av ${gater.length} gate(r) --${modus} feilet (${totalt} s)${loggFil ? `, full logg: ${loggFil}` : ''}`,
);
process.exit(rode === 0 ? 0 : 1);
