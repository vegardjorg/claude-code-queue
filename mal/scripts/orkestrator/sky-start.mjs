#!/usr/bin/env node
// Start køoppgaver i en skyøkt med `claude --cloud`, slik at økta trekker fra «Cloud session credits» (rutiner gjør det
// ikke). `--cloud` krever en ekte terminal, så eieren kjører dette selv i en terminal:
//
//   node scripts/orkestrator/sky-start.mjs <id> [<id> …] [--tving]
//
// Skriptet lager skypakka med `ko.mjs sky-pakke`, markerer oppgavene som startet i sky (`ko.mjs sky start`) og åpner så
// `claude --cloud <pakke>` i denne terminalen. Når skyøkta melder SKY-FERDIG, henter og fletter orkestratoren som før
// (`ko.mjs sky ferdig <id>`). Krever at basegrenen (konfig().baseGren) er pushet til remote (konfig().remote), fordi
// skyøkta starter fra den. Se docs/queue.md.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { konfig } = require('./lib/koKonfig.js');
const K = konfig();
const ROT = K.rot;
const KO = path.join(ROT, 'scripts', 'orkestrator', 'ko.mjs');
const args = process.argv.slice(2);
const tving = args.includes('--tving');
const ider = args.filter((a) => !a.startsWith('--'));
if (!ider.length) {
  console.error('Bruk: node scripts/orkestrator/sky-start.mjs <id> [<id> …] [--tving]');
  process.exit(1);
}
if (!process.stdout.isTTY) {
  console.error('claude --cloud krever en ekte terminal. Kjør kommandoen selv i et terminalvindu.');
  process.exit(1);
}

// Skyøkta starter fra <remote>/<basegren>: har basegrenen commits som ikke er pushet, ser skyen dem ikke.
{
  const r = spawnSync('git', ['rev-list', '--count', `${K.remote}/${K.baseGren}..${K.baseGren}`], {
    cwd: ROT,
    encoding: 'utf8',
  });
  const upushet = Number((r.stdout || '').trim());
  if (r.status !== 0) {
    console.error(`Fant ikke ${K.remote}/${K.baseGren}. Basegrenen må være pushet før en skyøkt kan starte.`);
    process.exit(1);
  }
  if (upushet > 0 && !tving) {
    console.error(
      `${K.baseGren} har ${upushet} commit(s) som ikke er pushet til ${K.remote}. Skyøkta ville startet uten dem. ` +
        'Push basegrenen først (når eieren sier «push»), eller bruk --tving.',
    );
    process.exit(1);
  }
}

const fil = path.join(os.tmpdir(), `sky-pakke-${Date.now()}.md`);
const ko = (...a) =>
  execFileSync(process.execPath, [KO, ...a], {
    cwd: ROT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
try {
  process.stdout.write(ko('sky-pakke', ...ider, '--ut', fil, ...(tving ? ['--tving'] : [])));
} catch {
  console.error(
    'Fikk ikke laget skypakka (se over). Legg til --tving hvis du vil sende den likevel.',
  );
  process.exit(1);
}
const pakke = fs.readFileSync(fil, 'utf8');
process.stdout.write(ko('sky', 'start', ...ider, '--tving'));
console.log(`\nStarter skyøkt for ${ider.join(', ')} … (trekker fra Cloud session credits)\n`);
const r = spawnSync('claude', ['--cloud', pakke], { cwd: ROT, stdio: 'inherit' });
fs.rmSync(fil, { force: true });
process.exit(r.status ?? 0);
