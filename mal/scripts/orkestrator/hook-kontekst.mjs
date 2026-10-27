#!/usr/bin/env node
// =============================================================
// hook-kontekst.mjs: UserPromptSubmit-hook som varsler, setter orkestratoren i avvikling og til slutt stopper, når
// samtalen blir for lang. Se docs/orchestration.md.
//
// Hvorfor: hver tur leser hele konteksten på nytt. En melding over 500k koster nesten tre ganger så mye som ved
// 100-200k, og en pause over en time i en lang økt betaler hele samtalen på nytt (cachen går ut). Hard stopp midt i
// orkestreringen koster mer enn den sparer, så den aktive orkestratoren får et avviklingstrinn i stedet.
//
// Slik virker den (tersklene og reglene står i lib/kontekstVakt.js, med tester):
//   - Leser den siste assistent-meldingens `usage` i transkriptet (input + cache-lesing + cache-skriving), som
//     er størrelsen på konteksten modellen faktisk fikk forrige gang.
//   - Fra VARSEL (250k): viser en melding til eieren (systemMessage) og en kort påminnelse til modellen.
//   - Økter som ikke er den aktive orkestratoren: STOPP (400k) stopper meldingen (decision: block).
//   - Den aktive orkestratoren (markøren <datamappe>/orkestrator.json er bundet til denne økta, se under):
//     AVVIKLING (350k, nødbremsen) setter `avvikling` i markøren og ber modellen gjøre ferdig (mottak, review,
//     retterunder, fletting, sett ferdig) uten nye starter, oppdatere den løpende overleveringslappen
//     <datamappe>/overlevering-lopende.md og be eieren komprimere nå (ferdig /compact-linje). `ko.mjs
//     neste/start/fyll` nekter da (exit 6) til økta er komprimert. Hard stopp først ved STOPP_ORK (550k).
//   - KOMPAKT (280k): den aktive orkestratoren får et forslag om å komprimere (systemMessage med en ferdig
//     /compact-linje eieren limer inn; modellen kan ikke kjøre /compact selv) og en påminnelse om å oppdatere lappen
//     og fullføre steget den står i. Ingen avvikling, og ingen fast grense for antall komprimeringer: syklusen
//     starter på nytt etter hver komprimering. Ny økt er bare en nødløsning.
//     Hvorfor komprimering framfor ny økt: tokenkostnaden er omtrent lik (begge koster om lag én tur), mens rotasjon
//     koster eieren arbeid og venting, og bakgrunnsagentene tilhører økta som startet dem (varsler og retterunder går
//     tapt ved rotasjon). Alt viktig ligger i filer (ko.json, oppdrag, rapport.md, lappen), så en komprimert økt er i
//     praksis en ny økt med agentene i behold. Kvalitetsvernet: avgjørelser skrives til fil med en gang, fokus i
//     /compact-linja, og køtilstanden og en gjenopptaksinstruks legges inn igjen av hook-etter-kompakt.mjs
//     (SessionStart, matcher compact).
//   - Modus (grenser.autokompakt i ko.json, `ko.mjs kompakt auto|manuell`, vises i meldingene): manuell gir forslaget
//     over; auto sier at Claude Code komprimerer selv (eieren har satt /autocompact), med linja bare som reserve.
//   - «fortsett:» først i meldingen slipper alltid gjennom.
//   - Grensene kan overstyres med KONTEKST_VARSEL, KONTEKST_STOPP, KONTEKST_AVVIKLING, KONTEKST_STOPP_ORK og
//     KONTEKST_KOMPAKT (tokens).
//
// Systemmeldinger stoppes ALDRI: UserPromptSubmit fyrer også for meldinger Claude Code køer inn selv,
// <task-notification> (bakgrunnsagent ferdig) og <agent-message> (SubagentHandback-rapport). Stoppes de, med
// «UserPromptSubmit operation blocked by hook» i transkriptet, når leverte spor aldri modellen, og køen fryser.
// Slike meldinger får varsel/avvikling, aldri block.
//
// Hvem er orkestratoren? Den økta som SIST kjørte `ko.mjs orkestrator puls|start|fyll` (sett i sitt eget transkript)
// mens markøren er aktiv. Hooken binder markøren til økta med session_id (okt_id). Se kontekstVakt.orkestratorBinding.
//
// KOSTVAKT: i den aktive orkestratorøkta måler hooken (høyst hvert 10. min, KOSTVAKT_INTERVALL_MIN overstyrer)
// forbruket til oppgavene som kjører, på samme måte som `ko.mjs sett <id> ferdig` (usage fra agenttranskriptene,
// koLogikk.summerKost). Passerer et spor FAKTOR (3x) snittkosten for klassen (`ko.mjs kost --siden 7d`; klassen fra
// oppdragsfila), får eieren en systemMessage og orkestratoren en ferdig beskjed å sende sporet (rund av eller lever
// DELVIS). Ingen automatisk stopp. Hvert spor varsles én gang (<datamappe>/kostvakt.json), og hvert varsel logges i
// <datamappe>/kostvakt-logg.jsonl (les med kostvakt-statistikk.mjs). Tersklene og teksten står i lib/kostVakt.js,
// med tester. KOSTVAKT_AV=1 slår vakten av.
//
// Feiler ÅPENT: enhver intern feil gir ingen utskrift og exit 0, så hooken aldri hindrer vanlig arbeid.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Transkript-lesingen er felles med spor-hookene (hook-spor-kontekst.mjs): lib/sporVakt.js.
const require = createRequire(import.meta.url);
const { sisteKontekst, lesHale } = require('./lib/sporVakt.js');
export { sisteKontekst };
const KV = require('./lib/kontekstVakt.js');
const KOST = require('./lib/kostVakt.js');
const L = require('./lib/koLogikk.js');
const TK = require('./lib/tidKost.js');
const { konfig, dataMappe, tidslogg } = require('./lib/koKonfig.js');

// Hovedtreet (konfig().rot er alltid hovedtreet, også fra et worktree) og datamappa (KO_MAPPE overstyrer).
const HOVEDTRE = konfig().rot;
const KO_MAPPE = dataMappe();
const MARKOR = path.join(KO_MAPPE, 'orkestrator.json');
const KO_FIL = path.join(KO_MAPPE, 'ko.json');
const KOSTVAKT_FIL = path.join(KO_MAPPE, 'kostvakt.json');
// Statistikk: én linje per varsel, append-only. Les med scripts/orkestrator/kostvakt-statistikk.mjs.
const KOSTVAKT_LOGG = path.join(KO_MAPPE, 'kostvakt-logg.jsonl');
// Samme kilder som ko.mjs (tidsloggen og agenttranskriptene); miljøvariablene overstyrer i tester.
const TIDSLOGG = tidslogg();
// Claude Code lagrer transkriptene i ~/.claude/projects/<slug>, der slug er rotstien med alle tegn utenom A-Z, a-z
// og 0-9 byttet til «-». KO_TRANSKRIPTER overstyrer (tester).
const TRANSKRIPTER =
  process.env.KO_TRANSKRIPTER ??
  path.join(os.homedir(), '.claude', 'projects', HOVEDTRE.replace(/[^A-Za-z0-9]/g, '-'));
const MAKS_TRANSKRIPT = 300 * 1024 * 1024;

/** Les stdin (hook-input som JSON). */
async function lesInn() {
  let s = '';
  for await (const del of process.stdin) s += del;
  return JSON.parse(s || '{}');
}

/** Hele transkriptet (for å telle komprimeringer), eller tom tekst. */
function lesHelt(sti) {
  try {
    return fs.statSync(sti).size > MAKS_TRANSKRIPT ? '' : fs.readFileSync(sti, 'utf8');
  } catch {
    return '';
  }
}

function lesMarkor() {
  try {
    return JSON.parse(fs.readFileSync(MARKOR, 'utf8'));
  } catch {
    return null;
  }
}

/** Skriver markøren atomisk (tmp + rename), som ko.mjs. Feil svelges: hooken feiler åpent. */
function skrivMarkor(m) {
  try {
    const tmp = `${MARKOR}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
    fs.renameSync(tmp, MARKOR);
  } catch {
    // error-ignorert: hooken skal aldri hindre en melding; avviklingen settes ved neste melding
  }
}

function lesJson(sti) {
  try {
    return JSON.parse(fs.readFileSync(sti, 'utf8'));
  } catch {
    return null;
  }
}

/** Transkriptteksten til en agent (som ko.mjs finnTranskript/lesTranskript), eller null. */
function agentTranskript(agentId) {
  try {
    for (const d of fs.readdirSync(TRANSKRIPTER, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sti = path.join(TRANSKRIPTER, d.name, 'subagents', `agent-${agentId}.jsonl`);
      if (!fs.existsSync(sti)) continue;
      return fs.statSync(sti).size > MAKS_TRANSKRIPT ? null : fs.readFileSync(sti, 'utf8');
    }
  } catch {
    // error-ignorert: uten transkript brukes tidsloggens siste rad
  }
  return null;
}

/** Klassen fra oppdragsfila (stien i o.oppdrag, eller selve teksten), ellers o.klasse. */
function klasseFor(o) {
  const s = String(o.oppdrag ?? '');
  let tekst = s.includes('\n') ? s : null;
  if (!tekst && s) {
    for (const rot of [process.cwd(), HOVEDTRE]) {
      try {
        tekst = fs.readFileSync(path.resolve(rot, s), 'utf8');
        break;
      } catch {
        // finnes ikke her
      }
    }
  }
  return KOST.klasseFraOppdrag(tekst) ?? o.klasse ?? null;
}

/** Forbruket til en oppgave som kjører, målt som i ko.mjs (transkript, ellers siste ferdig-rad). */
function maalOppgave(o, rader) {
  const agenter = [];
  for (const a of KOST.liveAgenter(rader, o.id, { fra: o.startet ?? o.plukket_at ?? null })) {
    const tekst = agentTranskript(a.agent);
    if (!a.sikker && !(tekst && L.nevnerOppgave(L.forsteBrukermelding(tekst), o.id))) continue;
    if (tekst) {
      const t = TK.analyserTranskript(tekst);
      agenter.push({
        agent: a.agent,
        type: a.type,
        tokens: t.tokens,
        modell: t.modell,
        kilde: 'transkript',
      });
    } else if (a.rad) {
      agenter.push({ agent: a.agent, type: a.type, tokens: a.rad.tokens, modell: a.rad.modell });
    }
  }
  return L.summerKost(agenter).usd;
}

/** Kostvakten: hook-tekst når et spor har passert terskelen, ellers null. Bare i den aktive orkestratorøkta. */
function kostvakt(naa) {
  if (process.env.KOSTVAKT_AV === '1') return null;
  const tilstand = lesJson(KOSTVAKT_FIL) ?? {};
  const min = Number(process.env.KOSTVAKT_INTERVALL_MIN);
  const intervall = Number.isFinite(min) && min >= 0 ? min * 60_000 : KOST.INTERVALL_MS;
  if (!KOST.skalMaale(tilstand, naa, intervall)) return null;
  const ko = lesJson(KO_FIL);
  if (!ko) return null;
  const kjorer = (ko.oppgaver ?? []).filter((o) => o.status === 'kjorer');
  const snitt = KOST.snittPerKlasse(
    L.kostStatistikk(ko, { siden: new Date(naa - KOST.SIDEN_MS).toISOString() }),
  );
  let rader = [];
  if (kjorer.length) {
    try {
      rader = TK.lesRader(fs.readFileSync(TIDSLOGG, 'utf8'));
    } catch {
      rader = [];
    }
  }
  const maalinger = kjorer.map((o) => ({
    id: o.id,
    klasse: klasseFor(o),
    usd: maalOppgave(o, rader),
  }));
  const v = KOST.vurder({ maalinger, snitt, varslet: tilstand.varslet, naa });
  try {
    const tmp = `${KOSTVAKT_FIL}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ sist_maalt: new Date(naa).toISOString(), varslet: v.varslet }, null, 2) +
        '\n',
    );
    fs.renameSync(tmp, KOSTVAKT_FIL);
  } catch {
    // error-ignorert: uten lagret tilstand måles det igjen ved neste melding
  }
  try {
    // Én linje per varsel: id, klasse, forbruk ved varsel, snitt, grense og faktor. Sluttkosten hentes fra ko.json.
    for (const x of v.varsler) {
      fs.appendFileSync(
        KOSTVAKT_LOGG,
        JSON.stringify({ tid: new Date(naa).toISOString(), faktor: KOST.FAKTOR, ...x }) + '\n',
      );
    }
  } catch {
    // error-ignorert: statistikken er et hjelpemiddel; varselet skal komme selv om loggen ikke kan skrives
  }
  return KOST.hookTekst(v.varsler);
}

/** Legger kostvaktens tekst til kontekst-hookens utdata (en block får stå alene). */
function flett(ut, kost) {
  if (!kost) return ut;
  if (ut?.decision === 'block') return ut;
  const sys = [ut?.systemMessage, kost.systemMessage].filter(Boolean).join('\n');
  const ctx = [ut?.hookSpecificOutput?.additionalContext, kost.additionalContext]
    .filter(Boolean)
    .join('\n');
  return {
    ...(ut ?? {}),
    systemMessage: sys,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
  };
}

async function main() {
  const inn = await lesInn();
  if (!inn.transcript_path) return;
  const hale = lesHale(inn.transcript_path);
  const n = sisteKontekst(hale);
  const g = KV.grenser(process.env);
  const naa = Date.now();
  const sessionId = inn.session_id ?? null;
  // Bindingen sjekkes ved hver melding (også under varselgrensen): en ny orkestratorøkt med liten kontekst skal ta
  // markøren og nullstille forrige økts avvikling så snart den har kjørt et orkestratorkall.
  const bind = KV.orkestratorBinding({
    markor: lesMarkor(),
    sessionId,
    sisteKall: KV.sisteOrkestratorKall(hale),
    naa,
  });
  // Kostvakten måles bare i den aktive orkestratorøkta; en feil i den skal aldri ta med seg kontekstvakten.
  let kost = null;
  if (bind.orkestrator) {
    try {
      kost = kostvakt(naa);
    } catch {
      kost = null;
    }
  }
  if (n == null || n < Math.min(g.varsel, g.avvikling, g.kompakt)) {
    if (bind.endret) skrivMarkor(bind.markor);
    const ut = flett(null, kost);
    if (ut) process.stdout.write(JSON.stringify(ut));
    return;
  }
  let markor = bind.markor;
  // Komprimeringene telles i HELE transkriptet (halen holder ikke), og bare for orkestratoren over KOMPAKT. Antallet
  // vises bare i meldingen (ingen fast grense).
  const komprimeringer =
    bind.orkestrator && n >= Math.min(g.kompakt, g.avvikling)
      ? KV.tellKomprimeringer(lesHelt(inn.transcript_path))
      : 0;
  const modus = bind.orkestrator ? KV.kompaktModus(lesJson(KO_FIL)) : 'manuell';
  const b = KV.vurder({
    n,
    prompt: String(inn.prompt || ''),
    orkestrator: bind.orkestrator,
    iAvvikling: KV.iAvvikling(markor, sessionId),
    g,
  });
  if (b.settAvvikling) markor = KV.medAvvikling(markor, { sessionId, n, naa });
  if (bind.endret || b.settAvvikling) skrivMarkor(markor);

  const ut = flett(
    KV.hookUtdata(b, { n, orkestrator: bind.orkestrator, g, komprimeringer, modus }),
    kost,
  );
  if (ut) process.stdout.write(JSON.stringify(ut));
}

main().catch(() => process.exit(0));
