#!/usr/bin/env node
// =============================================================
// hook-etter-kompakt.mjs: SessionStart-hook (matcher `compact`) som legger køtilstanden og en gjenopptaksinstruks
// inn igjen etter at orkestratorøkta er komprimert. Se docs/orchestration.md.
//
// Hvorfor: komprimering er standard for orkestratorøkta (hook-kontekst.mjs foreslår /compact med fokus ved ca. 280k,
// hver gang; ny økt er bare en nødløsning). Oppsummeringen mister detaljer og driver mer for hver komprimering. Denne
// hooken legger derfor de mest skjøre delene inn igjen som additionalContext, lest fra kilden og ikke fra
// oppsummeringen:
//   - gjenopptaksinstruksen: les den løpende overleveringslappen, `ko.mjs orkestrator puls`, ta imot leverte spor,
//     `ko.mjs fyll` og start det den lister, uten å vente på eieren,
//   - køvisningen fra `ko.mjs vis` (kort visning: aktive, startbare og tellinger),
//   - åpne eierspørsmål (koLogikk.sporsmalOversikt, de som ikke er avklart),
//   - antall upushede commits: `git rev-list --count <remote>/<basegren>..<basegren>` i hovedtreet,
//   - hvor mange komprimeringer økta har bak seg, og modusen (grenser.autokompakt, `ko.mjs kompakt auto|manuell`).
// Teksten bygges og kuttes (ca. 3k tokens) i lib/kontekstVakt.js (etterKompaktTekst), med tester.
//
// Automatisk gjenopptak: en automatisk komprimering
// midt i en tur fortsetter turen av seg selv, så instruksen virker med en gang. En SessionStart-hook kan IKKE starte
// en ny tur etter en manuell /compact (initialUserMessage leses bare ved oppstart), så da gjelder instruksen svaret på
// første melding.
//
// PreCompact (samme fil, hook_event_name = PreCompact): skriver fokuset for oppsummeringen
// (kontekstVakt.forKompaktInstruks) på stdout for den bundne orkestratorøkta. Claude Code legger stdout fra en
// PreCompact-hook til komprimeringsinstruksen, også ved automatisk komprimering. Hooken blokkerer ALDRI en
// komprimering (exit 2 ville gjort det, og med et lite autokomprimeringsvindu kan økta da låse seg). Krever at
// PreCompact er registrert i .claude/settings.json.
//
// Bare den aktive orkestratoren: markøren <datamappe>/orkestrator.json må være bundet til denne økta (okt_id =
// session_id, se kontekstVakt.orkestratorBinding). Alle andre økter (spor, reviewere, eierens egne) får ingenting.
// Hadde orkestratoren gått i avvikling (nødbremsen ved 350k), oppheves den for økta uansett antall komprimeringer:
// komprimering er normalveien ut av avviklingen, og ko.mjs neste/start/fyll skal da virke igjen.
//
// Feiler ÅPENT: enhver intern feil gir ingen utskrift og exit 0.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const KV = require('./lib/kontekstVakt.js');
const L = require('./lib/koLogikk.js');
const { konfig, dataMappe } = require('./lib/koKonfig.js');

const HER = path.dirname(fileURLToPath(import.meta.url));
const K = konfig();
// Hovedtreet (konfig().rot er alltid hovedtreet, også fra et worktree) og datamappa (KO_MAPPE overstyrer).
const HOVEDTRE = K.rot;
const KO_MAPPE = dataMappe();
const MARKOR = path.join(KO_MAPPE, 'orkestrator.json');
const KO_FIL = path.join(KO_MAPPE, 'ko.json');
// Samme overstyring som ko.mjs (KO_GIT) for git-roten, så testene aldri leser det ekte repoet.
const GIT_ROT = process.env.KO_GIT ?? HOVEDTRE;
const MAKS_TRANSKRIPT = 300 * 1024 * 1024;

async function lesInn() {
  let s = '';
  for await (const del of process.stdin) s += del;
  return JSON.parse(s || '{}');
}

function lesJson(sti) {
  try {
    return JSON.parse(fs.readFileSync(sti, 'utf8'));
  } catch {
    return null;
  }
}

/** Utdata fra `ko.mjs vis` (kort visning er standard), eller en kort feiltekst. */
function koVis() {
  try {
    return execFileSync(process.execPath, [path.join(HER, 'ko.mjs'), 'vis'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, COLUMNS: '110' },
    });
  } catch {
    return '(ko.mjs vis feilet; kjør den selv)';
  }
}

/** Antall commits på basegrenen som ikke er pushet, eller null hvis git ikke svarer. */
function upushet() {
  try {
    const ut = execFileSync(
      'git',
      ['-C', GIT_ROT, 'rev-list', '--count', `${K.remote}/${K.baseGren}..${K.baseGren}`],
      {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const n = Number(ut.trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function komprimeringer(sti) {
  try {
    if (!sti || fs.statSync(sti).size > MAKS_TRANSKRIPT) return 0;
    return KV.tellKomprimeringer(fs.readFileSync(sti, 'utf8'));
  } catch {
    return 0;
  }
}

async function main() {
  const inn = await lesInn();
  const sessionId = inn.session_id ?? null;
  if (inn.hook_event_name === 'PreCompact') {
    // Fokus for oppsummeringen, bare for den bundne orkestratorøkta. Aldri blokkering (exit 0 alltid).
    if (KV.etterKompaktBundet({ markor: lesJson(MARKOR), sessionId }))
      process.stdout.write(KV.forKompaktInstruks());
    return;
  }
  // Matcheren i settings.json er `compact`; sjekken her gjør hooken trygg også uten matcher.
  if (inn.source !== 'compact') return;
  const markor = lesJson(MARKOR);
  if (!KV.etterKompaktBundet({ markor, sessionId })) return;

  const opphev = KV.utenAvvikling(markor, sessionId);
  if (opphev.endret) {
    try {
      const tmp = `${MARKOR}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(opphev.markor, null, 2) + '\n');
      fs.renameSync(tmp, MARKOR);
    } catch {
      // error-ignorert: avviklingen står da igjen; ko.mjs orkestrator puls --okt nullstiller den
    }
  }

  const ko = lesJson(KO_FIL);
  const sporsmal = ko ? L.sporsmalOversikt(ko).filter((r) => !r.avklart) : [];
  const tekst = KV.etterKompaktTekst({
    vis: koVis(),
    sporsmal,
    upushet: upushet(),
    base: K.baseGren,
    komprimeringer: komprimeringer(inn.transcript_path),
    avviklingOpphevet: opphev.endret,
    modus: KV.kompaktModus(ko),
    g: KV.grenser(process.env),
  });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: tekst },
    }),
  );
}

main().catch(() => process.exit(0));
