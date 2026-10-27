#!/usr/bin/env node
// =============================================================
// install.mjs: installerer køsystemet (claude-cowie-qeue) i et eksisterende prosjekt.
//
// Bruk:
//   node scripts/install.mjs <målprosjekt> [--overskriv] [--med-tester] [--torr]
//
// Hva den gjør (alt er «legg til», ingenting slettes):
//   1. Kopierer mal/scripts/orkestrator/ → <mål>/scripts/orkestrator/ (uten __tests__ med mindre --med-tester).
//      Finnes en fil fra før, hoppes den over (med --overskriv erstattes den).
//   2. Kopierer skills (mal/.claude/skills/*) og agenter (mal/.claude/agents/*) på samme måte.
//   3. Kopierer docs/*.md → <mål>/docs/ko/, CLAUDE.ko.md → <mål>/CLAUDE.ko.md og
//      ko.config.example.json → <mål>/ko.config.json (bare når de mangler).
//   4. Fletter mal/.claude/settings.ko.json inn i <mål>/.claude/settings.json: nøkler som mangler legges til,
//      eksisterende verdier beholdes alltid, og hooks legges til bare når samme kommando ikke finnes fra før.
//   5. Legger linjene for køens datamappe og worktrees til i <mål>/.gitignore når de mangler.
// --torr viser hva som ville skjedd, uten å skrive noe.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HER = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HER, '..');
const MAL = path.join(REPO, 'mal');

const args = process.argv.slice(2);
const flagg = new Set(args.filter((a) => a.startsWith('--')));
const malArg = args.find((a) => !a.startsWith('--'));
if (!malArg) {
  console.error('bruk: node scripts/install.mjs <målprosjekt> [--overskriv] [--med-tester] [--torr]');
  process.exit(2);
}
const MAL_ROT = path.resolve(malArg);
const OVERSKRIV = flagg.has('--overskriv');
const MED_TESTER = flagg.has('--med-tester');
const TORR = flagg.has('--torr');

if (!fs.existsSync(MAL_ROT) || !fs.statSync(MAL_ROT).isDirectory()) {
  console.error(`Fant ikke målmappa: ${MAL_ROT}`);
  process.exit(2);
}
if (path.resolve(MAL_ROT) === REPO) {
  console.error('Målet kan ikke være selve claude-cowie-qeue-repoet.');
  process.exit(2);
}

// Tellere for oppsummeringen til slutt.
const logg = { kopiert: [], hoppetOver: [], erstattet: [] };

/** Lager mappa (rekursivt) når vi ikke kjører tørt. */
function lagMappe(dir) {
  if (!TORR) fs.mkdirSync(dir, { recursive: true });
}

/** Kopierer én fil, men respekterer eksisterende filer med mindre --overskriv. */
function kopierFil(fra, til) {
  const rel = path.relative(MAL_ROT, til);
  if (fs.existsSync(til)) {
    if (!OVERSKRIV) {
      logg.hoppetOver.push(rel);
      return;
    }
    logg.erstattet.push(rel);
  } else {
    logg.kopiert.push(rel);
  }
  if (TORR) return;
  lagMappe(path.dirname(til));
  fs.copyFileSync(fra, til);
}

/** Kopierer en mappe rekursivt. `hopp(navn)` kan utelate mapper (f.eks. __tests__). */
function kopierMappe(fra, til, hopp = () => false) {
  for (const e of fs.readdirSync(fra, { withFileTypes: true })) {
    if (hopp(e.name)) continue;
    const f = path.join(fra, e.name);
    const t = path.join(til, e.name);
    if (e.isDirectory()) kopierMappe(f, t, hopp);
    else kopierFil(f, t);
  }
}

// ---- 1-3: filer ----
kopierMappe(
  path.join(MAL, 'scripts', 'orkestrator'),
  path.join(MAL_ROT, 'scripts', 'orkestrator'),
  (navn) => !MED_TESTER && navn === '__tests__',
);
// Bibliotekene er CommonJS (.js med require). En package.json med "type": "commonjs" i mappa gjør at de virker
// også når målprosjektet selv har "type": "module".
{
  const pj = path.join(MAL_ROT, 'scripts', 'orkestrator', 'package.json');
  if (!fs.existsSync(pj)) {
    logg.kopiert.push(path.relative(MAL_ROT, pj));
    if (!TORR) {
      lagMappe(path.dirname(pj));
      fs.writeFileSync(pj, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
    }
  }
}
kopierMappe(path.join(MAL, '.claude', 'skills'), path.join(MAL_ROT, '.claude', 'skills'));
kopierMappe(path.join(MAL, '.claude', 'agents'), path.join(MAL_ROT, '.claude', 'agents'));
for (const f of fs.readdirSync(path.join(REPO, 'docs'))) {
  if (f.endsWith('.md')) kopierFil(path.join(REPO, 'docs', f), path.join(MAL_ROT, 'docs', 'ko', f));
}
kopierFil(path.join(REPO, 'CLAUDE.ko.md'), path.join(MAL_ROT, 'CLAUDE.ko.md'));
// ko.config.json overskrives aldri, heller ikke med --overskriv (den er prosjektets egne valg).
{
  const til = path.join(MAL_ROT, 'ko.config.json');
  if (fs.existsSync(til)) logg.hoppetOver.push('ko.config.json');
  else {
    logg.kopiert.push('ko.config.json');
    if (!TORR) fs.copyFileSync(path.join(REPO, 'ko.config.example.json'), til);
  }
}

// ---- 4: settings ----
/** Alle kommandoene i en hook-liste (for å se om en hook finnes fra før). */
function kommandoer(grupper) {
  const ut = new Set();
  for (const g of grupper ?? []) for (const h of g.hooks ?? []) if (h.command) ut.add(h.command);
  return ut;
}

const settingsSti = path.join(MAL_ROT, '.claude', 'settings.json');
const ny = JSON.parse(fs.readFileSync(path.join(MAL, '.claude', 'settings.ko.json'), 'utf8'));
let eksisterende = {};
if (fs.existsSync(settingsSti)) {
  try {
    eksisterende = JSON.parse(fs.readFileSync(settingsSti, 'utf8'));
  } catch (e) {
    console.error(`Kunne ikke lese ${settingsSti} som JSON (${e.message}). Rett fila og kjør på nytt.`);
    process.exit(1);
  }
}
const endringer = [];
for (const [nokkel, verdi] of Object.entries(ny)) {
  if (nokkel.startsWith('_') || nokkel.startsWith('$')) continue; // kommentarer
  if (nokkel === 'hooks') continue;
  if (eksisterende[nokkel] === undefined) {
    eksisterende[nokkel] = verdi;
    endringer.push(`la til ${nokkel}`);
  } else if (typeof verdi === 'object' && !Array.isArray(verdi) && typeof eksisterende[nokkel] === 'object') {
    for (const [k, v] of Object.entries(verdi)) {
      if (eksisterende[nokkel][k] === undefined) {
        eksisterende[nokkel][k] = v;
        endringer.push(`la til ${nokkel}.${k}`);
      }
    }
  } else {
    endringer.push(`beholdt eksisterende ${nokkel}`);
  }
}
eksisterende.hooks = eksisterende.hooks ?? {};
for (const [hendelse, grupper] of Object.entries(ny.hooks ?? {})) {
  const liste = (eksisterende.hooks[hendelse] = eksisterende.hooks[hendelse] ?? []);
  const finnes = kommandoer(liste);
  for (const g of grupper) {
    const nyeHooks = (g.hooks ?? []).filter((h) => !finnes.has(h.command));
    if (nyeHooks.length === 0) continue;
    liste.push({ ...g, hooks: nyeHooks });
    endringer.push(`hook ${hendelse}: ${nyeHooks.map((h) => h.command.split('/').pop()).join(', ')}`);
  }
}
if (!TORR) {
  lagMappe(path.dirname(settingsSti));
  fs.writeFileSync(settingsSti, JSON.stringify(eksisterende, null, 2) + '\n');
}

// ---- 5: .gitignore ----
const gitignoreSti = path.join(MAL_ROT, '.gitignore');
const gitignore = fs.existsSync(gitignoreSti) ? fs.readFileSync(gitignoreSti, 'utf8') : '';
const harLinje = (l) => gitignore.split(/\r?\n/).some((x) => x.trim() === l);
const nyeLinjer = ['scripts/.ko/', '.claude/worktrees/'].filter((l) => !harLinje(l));
if (nyeLinjer.length && !TORR) {
  const pre = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gitignoreSti, `${pre}\n# claude-cowie-qeue (køens data og agentenes worktrees)\n${nyeLinjer.join('\n')}\n`);
}

// ---- Oppsummering ----
console.log(`${TORR ? '[TØRR] ' : ''}Installerte claude-cowie-qeue i ${MAL_ROT}`);
console.log(`  kopiert: ${logg.kopiert.length}, erstattet: ${logg.erstattet.length}, hoppet over (fantes): ${logg.hoppetOver.length}`);
if (logg.hoppetOver.length) console.log(`  hoppet over: ${logg.hoppetOver.slice(0, 15).join(', ')}${logg.hoppetOver.length > 15 ? ' …' : ''}`);
console.log(`  .claude/settings.json: ${endringer.length ? endringer.join('; ') : 'ingen endringer'}`);
console.log(`  .gitignore: ${nyeLinjer.length ? 'la til ' + nyeLinjer.join(' ') : 'uendret'}`);
console.log('');
console.log('Neste steg:');
console.log('  1. Rediger ko.config.json (baseGren, gater, moduler).');
console.log('  2. Legg linja @CLAUDE.ko.md i prosjektets CLAUDE.md.');
console.log('  3. node scripts/orkestrator/ko.mjs init');
console.log('  4. node scripts/orkestrator/ko.mjs vis');
