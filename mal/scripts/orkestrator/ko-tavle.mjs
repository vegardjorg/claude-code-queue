#!/usr/bin/env node
// =============================================================
// ko-tavle.mjs: lokal kanban-tavle for arbeidskøen (se docs/board.md).
//
// En liten Node-server (bare innebygde moduler) som viser køen som en tavle i nettleseren: I kø, Pågår, Review og
// Bygget. Eieren kan dra kort for å omprioritere, dra prosjektbaner, plukke, slippe, godkjenne QA og pause prosjekter.
//
//   node scripts/orkestrator/ko-tavle.mjs [--port <nr>]
//
// Porten er konfig().tavle.port (standard 2000) fra ko.config.json; --port overstyrer. Tittelen er
// konfig().tavle.tittel og konfig().prosjektNavn. Skriver en lenke med en tilfeldig nøkkel (ny for hver kjøring).
// Åpne den i nettleseren; Ctrl+C stopper tavla.
//
// Slik holdes tavla lik køen:
//   - LESING: ko.json + de rene reglene i lib/koLogikk.js (prioritet, prosjekt, hindringer, grenser) via
//     lib/koTavle.js. Ingen egen kopi av reglene.
//   - SKRIVING: bare via ko.mjs-kommandoene (endre, prosjekt, endre-mange, plukk, slipp, qa ok|avvik, samle pakk), så
//     låsen, den atomiske skrivingen og valideringen er de samme som ellers. Tavla skriver aldri ko.json selv.
//     Skrivingene kjøres én om gangen.
//   - FARGENE: den nøytrale paletten (lys og mørk) i lib/koTavle.js serveres som CSS-variabler (/tema.css).
//   - STATISTIKK: ko.json og tidsloggen (bare lesing) aggregeres av de rene funksjonene i lib/koStatistikk.js.
//     Tidsloggen leses på nytt bare når mtime eller størrelse er endret, og resultatet caches til ko.json, tidsloggen
//     eller datoen endres.
//   - INNSTILLINGER: grensene skrives med `ko.mjs grense <navn> <verdi>` (samme lås og validering); oppsettet
//     (migrasjoner når de er slått på, orkestrator, modell, hooks og skills) er bare lesing.
//   - VAKTREGLER: hvert skrivekall kjører koTavle.vurder først. stopp → 422, advarsel → 409 til kallet sender
//     `bekreft: true`, info → handlingen gjøres og tekstene sendes med svaret. ko.mjs nekter fortsatt selv.
//   - AVHENGIGHETER: grafen med sirkler og streker regnes i nettleseren av lib/koGraf.js (servert som /koGraf.js) fra
//     den samme tilstanden, én gang per versjon og filter, så søket og filtermenyen virker likt.
//   - VENTER PÅ DEG: tilstanden har `innboks` (eierspørsmål, QA, forslag, det som henger) og `neste` («Neste opp»).
//     Svar går via `ko.mjs avklar <id> --svar … --av eier`, QA ok og godkjenn for flere via `ko.mjs qa ok <id…>` og
//     `ko.mjs godkjenn <id…>`.
//   - SKY: kortene i kø og i skyøkter får koLogikk.skyEgnet (<remote>/<basegren> og lokale endringer leses med git,
//     høyst hvert minutt). «Kopier skypakke» henter /api/skypakke (= `ko.mjs sky-pakke <id>`), og «Startet i sky»,
//     «Fullført i sky» og «Avbryt sky» går via `ko.mjs sky start|ferdig|avbryt`.
//   - FLERVALG: POST /api/masse { handling, ider, verdi, torr, forvent, bekreft } oversettes av koTavle.massePlan til
//     `ko.mjs endre-mange`, `ranger` eller `samle pakk`. torr = forhåndsvisning (--torr, eller
//     koTavle.pakkForhandsvisning på en kopi), ellers skrives det med --forvent-endret (exit 6 → 409 utdatert).
//     POST /api/angre { vis? , nr? } = `ko.mjs angre [--vis] [--nr <n>] --json`.
//   - PLANER (se docs/plan-register.md): arbeidsrommet Planer (ko-tavle/planer/). GET /api/planer leser planer.json og
//     ko.json (bare lesing) og sender det koPlanVisning.planerData lager, med versjon så uendret data ikke sendes på
//     nytt. Samme svar har dokumentregisteret til flaten Dokumenter og avtaler. Prioritetskartet lagrer utkastet med
//     POST /api/plan-prioriter (torr = forhåndsvisning), som kjører ett `ko.mjs plan prioriter-mange --fil …
//     --satt-av eier` med --forvent-endret (én lagring er én endringslogg-post og én angre).
//     GET /api/dok?sti=… leser ett markdown-dokument til lesevisningen (allowlisten står i koPlanVisning.lesStiFeil,
//     stivernet mot .., skjulte filer, symlenker og andre filtyper i koTavle.lesDokument). GET /api/plan-sjekk gir de
//     uregistrerte dokumentene (ko.mjs plan sjekk), og POST /api/plan-ny og /api/plan-kilde kjører `ko.mjs plan ny`
//     og `plan endre <id> --sett {kilder}` med --satt-av eier, --torr og --forvent-endret.
//     Flatene Juridisk, Beslutninger og Lansering leser de samme dataene. Svar på et eierspørsmål går via
//     POST /api/handling { type: 'avklar' } (= `ko.mjs avklar`), og POST /api/juristpakke skriver et utkast lokalt
//     (torr = forhåndsvisning; sendes aldri).
//     POST /api/plan-masse kjører `ko.mjs plan prioriter|endre|slaa-sammen` (torr = forhåndsvisning, ellers
//     --forvent-endret, alt eller ingenting), POST /api/plan-angre angrer det tavla nettopp lagret (`plan angre --nr`),
//     og GET /api/planer?vent=1 venter til planer.json eller ko.json endres (live oppdatering, fs.watch).
//
// Sikkerhet (en annen nettside i samme nettleser skal ikke kunne lese eller endre køen):
//   - lytter bare på 127.0.0.1,
//   - hvert /api/-kall krever nøkkelen i headeren X-Ko-Nokkel (lenken bærer den i #-delen, som aldri sendes til
//     serveren eller lekker i Referer),
//   - Host må være 127.0.0.1:<port> eller localhost:<port> (stopper DNS-rebinding), og et skrivekall med Origin må
//     komme fra tavla selv og ha Content-Type application/json,
//   - streng Content-Security-Policy: bare egne filer, ingen CDN, ingen inline-skript.
//
// Miljø (som ko.mjs): KO_MAPPE (køens mappe, røyktest mot en kopi), KO_GIT (repoet grenene telles i, og der
// migrasjonsmappa og .claude/settings.json leses), KO_TIDSLOGG (tidsloggen), KO_PLAN_KILDEROT (rota dokumentene
// leses fra).
// =============================================================

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const require = createRequire(import.meta.url);
const T = require('./lib/koTavle.js');
const G = require('./lib/koGit.js');
const L = require('./lib/koLogikk.js');
const S = require('./lib/koStatistikk.js');
const TK = require('./lib/tidKost.js');
// Planer-rommet. Registeret leses med koPlan.js, og det tavla trenger lages av koPlanVisning.js (bare lesing).
const P = require('./lib/koPlan.js');
const PV = require('./lib/koPlanVisning.js');
const KK = require('./lib/koKonfig.js');

const KONFIG = KK.konfig();
const HER = path.dirname(fileURLToPath(import.meta.url));
// Prosjektrota (to mapper over scripts/orkestrator/). Køen bor i hovedtreet, som for ko.mjs: kjøres tavla fra et
// worktree, peker konfig().rot alt til hovedtreet.
const ROT = path.resolve(HER, '..', '..');
const HOVEDTRE = KONFIG.rot;
const MAPPE = KK.dataMappe();
const FIL = path.join(MAPPE, 'ko.json');
const MARKOR = path.join(MAPPE, 'orkestrator.json');
const PLANFIL = path.join(MAPPE, 'planer.json');
// Dokumentene i lesevisningen ligger i hovedtreet, som kildestiene i planregisteret (samme miljøvariabel som ko.mjs).
const KILDEROT = process.env.KO_PLAN_KILDEROT ?? HOVEDTRE;
const GIT_ROT = process.env.KO_GIT ?? HOVEDTRE;
const TIDSLOGG = KK.tidslogg();
const KO_MJS = path.join(HER, 'ko.mjs');
const KLIENT = path.join(HER, 'ko-tavle');
// Basegrenen (integrasjonsgrenen) og remoten, til «commits foran» og «endret siden push».
const BASE = String(KONFIG.baseGren ?? 'main');
const REMOTE = String(KONFIG.remote ?? 'origin');
// Tittelen i nettleseren og øverst på tavla.
const TITTEL = T.tavleTittel(KONFIG);

const a = process.argv.slice(2);
const verdi = (navn) => {
  const i = a.indexOf(navn);
  return i >= 0 ? a[i + 1] : undefined;
};
if (a.includes('--hjelp') || a.includes('-h')) {
  console.log(
    'Kanban-tavle for arbeidskøen.\n\n  node scripts/orkestrator/ko-tavle.mjs [--port <nr>]\n\n' +
      `Standardporten er tavle.port i ko.config.json (nå ${KONFIG.tavle?.port ?? 2000}).\n` +
      'Åpne lenken den skriver (nøkkelen er ny for hver kjøring). Ctrl+C stopper tavla.',
  );
  process.exit(0);
}
const PORT = Number(verdi('--port') ?? KONFIG.tavle?.port ?? 2000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('--port må være et heltall mellom 1 og 65535');
  process.exit(1);
}
const VERT = '127.0.0.1';
const NOKKEL = crypto.randomBytes(24).toString('base64url');
const LOVLIGE_VERTER = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const LOVLIGE_OPPHAV = new Set([...LOVLIGE_VERTER].map((v) => `http://${v}`));

// ---- Fargene (den nøytrale paletten i lib/koTavle.js) -------------------------------------------------------------
const TEMA_CSS = T.temaCss(T.PALETT);

// ---- Git (ucommittede filer i hovedtreet, grenene <grenPrefiks><id>) ---------------------------------------------
const gitLes = G.lagGit(GIT_ROT);
const GREN_MONSTER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;
const GREN_PREFIKS = String(KONFIG.grenPrefiks ?? 'ko/');
/** Grenen en oppgave bygges på: `gren` i køen, ellers <grenPrefiks><id>. */
const grenFor = (o) => o.gren ?? `${GREN_PREFIKS}${o.id}`;

/** Commits foran basegrenen på grenen og tidspunktet for den siste (samme spørsmål som ko.mjs stiller). */
function grenInfo(gren) {
  if (!GREN_MONSTER.test(gren)) return { finnes: false, commits: 0, sisteCommit: null };
  if (gitLes(['rev-parse', '-q', '--verify', `refs/heads/${gren}`]) == null)
    return { finnes: false, commits: 0, sisteCommit: null };
  const commits = Number(String(gitLes(['rev-list', '--count', `${BASE}..${gren}`]) ?? '0').trim());
  const siste = commits > 0 ? String(gitLes(['log', '-1', '--format=%cI', gren]) ?? '').trim() : '';
  return { finnes: true, commits: commits || 0, sisteCommit: siste || null };
}

// git status i et stort repo tar tid: les den på nytt høyst hvert minutt.
// Samtidig leses <remote>/<basegren> og stiene som er endret lokalt siden den (til «Egnet for sky»).
let gitStatus = { tid: 0, ucommittet: [], feil: false, pushetHead: null, sidenPush: [] };
function ucommittet() {
  if (Date.now() - gitStatus.tid > 60_000) {
    const u = G.lesUcommittet(gitLes);
    const pushetHead =
      String(gitLes(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`]) ?? '').trim() ||
      null;
    const sidenPush = pushetHead
      ? String(gitLes(['diff', '--name-only', `refs/remotes/${REMOTE}/${BASE}...${BASE}`]) ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    gitStatus = {
      tid: Date.now(),
      ucommittet: u ? u.map((x) => x.sti) : [],
      feil: u == null,
      pushetHead,
      sidenPush,
    };
  }
  return gitStatus;
}

// ---- Logoen -----------------------------------------------------------------------------------------------------
// Prosjektet kan legge sin egen logo i kømappa (logo.webp, logo.png eller logo.svg, samme mappe som ko.json, så
// KO_MAPPE gjelder). Finnes ingen der, vises bildet som følger med (ko-tavle/logo.webp). Bildet er en del av lisensen,
// så standardoppsettet viser det alltid.
const LOGO_TYPER = [
  ['logo.webp', 'image/webp'],
  ['logo.png', 'image/png'],
  ['logo.svg', 'image/svg+xml'],
];
const STANDARD_LOGO = { sti: path.join(KLIENT, 'logo.webp'), type: 'image/webp' };
/** Første logo-fil i kømappa, ellers den som følger med (null bare hvis den også mangler). */
function finnLogo() {
  for (const [fil, type] of LOGO_TYPER) {
    const sti = path.join(MAPPE, fil);
    try {
      if (fs.statSync(sti).isFile()) return { sti, type };
    } catch {
      /* finnes ikke */
    }
  }
  try {
    if (fs.statSync(STANDARD_LOGO.sti).isFile()) return STANDARD_LOGO;
  } catch {
    /* mangler i installasjonen */
  }
  return null;
}

// ---- Tilstanden (billig: bygges bare på nytt når ko.json, git status eller logoen er endret) ---------------------
// git status leses på nytt hvert minutt, så tilstanden (alder, nattpause, «Neste opp») regnes på nytt minst så ofte.
let hurtig = null;
function tilstand() {
  const mtime = fs.statSync(FIL).mtimeMs;
  const g = ucommittet();
  const logo = finnLogo() != null;
  // Med dagskvote trenger «Neste opp» dagens forbruk (tidsloggen, via den cachede statistikken).
  const stat = hurtig?.budsjett ? statistikk().versjon : null;
  if (
    hurtig &&
    hurtig.mtime === mtime &&
    hurtig.gitTid === g.tid &&
    hurtig.logo === logo &&
    hurtig.stat === stat
  )
    return hurtig;
  const ko = JSON.parse(fs.readFileSync(FIL, 'utf8'));
  const grener = {};
  for (const o of ko.oppgaver ?? []) {
    if (o.status !== 'plukket') continue;
    const gren = grenFor(o);
    grener[gren] = grenInfo(gren);
  }
  const budsjett = ko.grenser?.dagsbudsjett != null;
  const s = budsjett ? statistikk() : null;
  const data = {
    ...T.tavle(ko, {
      ucommittet: g.ucommittet,
      grener,
      grenPrefiks: GREN_PREFIKS,
      // Aldrende arbeid mot p85 for klassen (bare fra ko.json).
      aldersgrenser: S.aldersGrenser(ko),
      dagsforbruk: s?.data.nokkeltall.forbrukIdag,
      // Egnetheten med de samme reglene som ko.mjs sky-pakke (koLogikk.skyEgnet).
      sky: {
        pushetHead: g.pushetHead,
        endret: [...g.sidenPush, ...g.ucommittet],
        oppdrag: oppdragFor,
      },
    }),
    gitFeil: g.feil,
    logo,
    tittel: TITTEL,
    baseGren: BASE,
  };
  const versjon = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  hurtig = { mtime, gitTid: g.tid, logo, budsjett, stat: s?.versjon ?? null, versjon, data };
  return hurtig;
}

// ---- Statistikken: tidsloggen leses bare når den er endret, resultatet caches ------------------------
let loggCache = { nokkel: null, rader: [], feil: null };
function tidsloggRader() {
  let st;
  try {
    st = fs.statSync(TIDSLOGG);
  } catch (e) {
    return { nokkel: 'mangler', rader: [], feil: e?.code ?? 'finnes ikke' };
  }
  const nokkel = `${st.mtimeMs}:${st.size}`;
  if (loggCache.nokkel !== nokkel) {
    // Bare «ferdig»-radene trengs (forbruk og kontekst); gate-radene (de fleste) kastes med en gang.
    const rader = TK.lesRader(fs.readFileSync(TIDSLOGG, 'utf8')).filter(
      (r) => r?.hendelse === 'ferdig',
    );
    loggCache = { nokkel, rader, feil: null };
  }
  return loggCache;
}

let statCache = null;
function statistikk() {
  const logg = tidsloggRader();
  const nokkel = `${logg.nokkel}|${fs.statSync(FIL).mtimeMs}|${TK.dagFor(new Date().toISOString())}`;
  if (statCache?.nokkel === nokkel) return statCache;
  const ko = JSON.parse(fs.readFileSync(FIL, 'utf8'));
  const data = { ...S.statistikk(ko, logg.rader), tidsloggFeil: logg.feil };
  const versjon = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  statCache = { nokkel, versjon, data };
  return statCache;
}

// ---- Planregisteret: bare lesing, bygges på nytt når planer.json eller ko.json endres (eller hvert minutt,
// så «foreldet» og «Arbeider nå» går ut av seg selv). Skriving i registeret går aldri via tavla i dette sporet.
let planCache = null;
function planer() {
  const mt = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  const nokkel = `${mt(PLANFIL)}|${mt(FIL)}|${Math.floor(Date.now() / 60_000)}`;
  if (planCache?.nokkel === nokkel) return planCache;
  const reg = fs.existsSync(PLANFIL)
    ? P.normaliser(JSON.parse(fs.readFileSync(PLANFIL, 'utf8')))
    : P.tomtRegister();
  const ko = fs.existsSync(FIL) ? JSON.parse(fs.readFileSync(FIL, 'utf8')) : {};
  const naa = new Date();
  const fk = L.rangeringKontekst(ko, naa.getTime());
  // Kolonnen og fokustrinnet for en køoppgave (samme regler som kortene på tavla, koTavle.tavle).
  const koInfo = (o) => {
    const kolonne = o.id ? T.kolonneFor(o) : null;
    if (kolonne !== 'ko') return { kolonne, gjelder: fk.gjelder };
    const p = L.fokusPlass(o, fk);
    const trinn = p.steg != null ? ko.fokus?.rekkefolge?.[p.steg] : null;
    return {
      kolonne,
      gjelder: fk.gjelder,
      steg: p.steg,
      utenfor: fk.gjelder ? p.utenfor : false,
      trinn_tittel: trinn ? L.trinnTittel(trinn, ko) : null,
    };
  };
  // Tempoet til kapasitetstallet på oversikten (ferdige køoppgaver per uke, som `plan sjekk`).
  const vindu = P.KAPASITET_VINDU_DAGER ?? 28;
  const ferdigePerUke =
    S.ferdigeIVindu(ko, S.dagerBakover(naa.getTime(), vindu)).length / (vindu / 7);
  const data = {
    ...PV.planerData(reg, ko, { naa, koInfo, koPlan: P, ferdigePerUke }),
    finnes: fs.existsSync(PLANFIL),
  };
  const versjon = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  planCache = { nokkel, versjon, data };
  return planCache;
}

// ---- Live oppdatering. GET /api/planer?versjon=…&vent=1 venter (høyst VENT_MS) til planer.json
// eller ko.json endres, så endringer fra en Claude Code-økt vises uten at siden lastes på nytt. Mappa overvåkes med
// fs.watch (filene skrives atomisk med rename); virker ikke det, svarer kallet «uendret» etter ventetiden, og klienten
// spør igjen. Bare lesing.
const VENT_MS = 25_000;
const PLAN_VENTERE = new Set();
let planVakt = null;
function planVaktPaa() {
  if (planVakt !== null) return;
  try {
    let tid = null;
    planVakt = fs.watch(MAPPE, (_hendelse, navn) => {
      if (navn && !/^(planer|ko)\.json$/.test(String(navn))) return;
      clearTimeout(tid);
      // Kort pause: en skriving er tmp-fil + rename, og ko.mjs kan skrive begge filene etter hverandre.
      tid = setTimeout(() => {
        for (const v of [...PLAN_VENTERE]) v();
      }, 150);
    });
    planVakt.on('error', () => {
      planVakt?.close();
      planVakt = false;
    });
  } catch {
    planVakt = false; // fs.watch virker ikke her: kallene svarer etter ventetiden
  }
}
/**
 * Venter til registeret endres, klienten går, eller VENT_MS har gått. `res` (ikke req): req sender «close» alt når en
 * GET uten kropp er lest ferdig, res først når forbindelsen lukkes.
 */
function ventPaaPlaner(res) {
  planVaktPaa();
  return new Promise((ferdig) => {
    let tid = null;
    const v = () => {
      PLAN_VENTERE.delete(v);
      clearTimeout(tid);
      res.off('close', v);
      ferdig();
    };
    tid = setTimeout(v, VENT_MS);
    PLAN_VENTERE.add(v);
    res.on('close', v);
  });
}

/** JSON-fila, eller null når den mangler eller er ødelagt. */
function lesJson(sti) {
  try {
    return JSON.parse(fs.readFileSync(sti, 'utf8'));
  } catch {
    return null;
  }
}

/** Oppsettet i innstillingspanelet (bare lesing, fra de ekte kildene). */
function oppsett(ko, stat) {
  // Migrasjonene vises bare når prosjektet har slått på migrasjonsflyten (konfig().migrasjoner.mappe).
  const m = KONFIG.migrasjoner ?? {};
  let migrasjoner = null;
  if (m.mappe) {
    let filer = [];
    let feil = null;
    try {
      filer = fs.readdirSync(path.join(GIT_ROT, ...String(m.mappe).split('/')));
    } catch (e) {
      feil = e?.code ?? 'kunne ikke lese mappa';
    }
    migrasjoner = {
      mappe: m.mappe,
      feil,
      neste: ko.neste_migr ?? null,
      hoyeste: T.hoyesteMigrasjon(filer, m.filmonster),
    };
  }
  const markor = lesJson(MARKOR);
  const settings = lesJson(path.join(GIT_ROT, '.claude', 'settings.json'));
  return {
    baseGren: BASE,
    migrasjoner,
    orkestrator: { ...L.orkestratorStatus(markor), oppdatert: markor?.oppdatert ?? null },
    modeller: stat.modeller,
    hooks: settings ? T.hooksDekning(settings) : null,
    skills: T.skillsDekning((navn) =>
      fs.existsSync(path.join(GIT_ROT, '.claude', 'skills', navn, 'SKILL.md')),
    ),
    regler: T.SKILL_REGLER.map((r) => r.tekst),
    reglerKilde: T.SKILL_KILDE,
  };
}

/** Oppdragsteksten: fila `oppdrag` peker til (i worktreet eller hovedtreet, aldri utenfor), ellers selve teksten. */
function oppdragFor(o) {
  const s = String(o.oppdrag ?? '');
  if (s && !s.includes('\n')) {
    for (const rot of [ROT, HOVEDTRE]) {
      const sti = path.resolve(rot, s);
      if (!sti.startsWith(rot + path.sep)) continue;
      try {
        if (fs.statSync(sti).isFile())
          return { tekst: fs.readFileSync(sti, 'utf8').slice(0, 200_000), sti: s };
      } catch {
        /* finnes ikke her */
      }
    }
  }
  return { tekst: s, sti: null };
}

// ---- ko.mjs (all skriving) --------------------------------------------------------------------------------------
function koMjs(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [KO_MJS, ...args],
      { cwd: ROT, env: process.env, timeout: 30_000, windowsHide: true, maxBuffer: 4 << 20 },
      (err, ut, feil) => {
        resolve({
          ok: !err,
          // Exit-koden: 6 = køen er endret siden forhåndsvisningen (--forvent-endret).
          kode: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          ut: String(ut ?? '').trim(),
          feil: String(feil ?? '').trim(),
        });
      },
    );
  });
}

// Skrivingene kjøres én om gangen, så en flytting alltid regnes ut fra køen slik den er etter forrige skriving.
let kjede = Promise.resolve();
function enOmGangen(fn) {
  const p = kjede.then(fn);
  kjede = p.catch(() => undefined);
  return p;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const PID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idEllerNull = (x) => (x == null ? null : ID.test(String(x)) ? String(x) : undefined);
const pidEllerNull = (x) => (x == null ? null : PID.test(String(x)) ? String(x) : undefined);
// En tekst som starter med «-» ville ko.mjs lest som et flagg; kontrolltegn (unntatt linjeskift) fjernes.
const rensTekst = (x, maks) =>
  String(x ?? '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/^-+\s*/, '')
    .slice(0, maks);

/** Kjører endre-mange med innholdet i en midlertidig fil (alt eller ingenting), og rydder fila etterpå. */
async function endreMange(innhold, kjor, hva, ekstra = []) {
  const tmp = path.join(os.tmpdir(), `ko-tavle-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(innhold));
  try {
    return await kjor(['endre-mange', '--fil', tmp, ...ekstra], hva);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Kjører en ko.mjs-kommando som svarer med én JSON-linje (--json). `data` er den siste linja tolket, eller
 * null når svaret ikke var JSON (da står feilen i `feil`/`ut`).
 */
async function koJson(args) {
  const r = await koMjs(args);
  let data = null;
  try {
    data = JSON.parse(r.ut.split('\n').filter(Boolean).pop() ?? '');
  } catch {
    data = null;
  }
  return { ...r, data };
}

/** endre-mange med innholdet i en midlertidig fil og svaret som JSON (alt eller ingenting); fila ryddes etterpå. */
async function endreMangeJson(innhold, ekstra) {
  const tmp = path.join(os.tmpdir(), `ko-tavle-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(innhold));
  try {
    return await koJson(['endre-mange', '--fil', tmp, '--json', ...ekstra]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Argumentene til ko.mjs ranger for en plass fra koTavle.massePlan ({ topp } | { bunn } | { over: id } | …). */
function plassArgs(plass) {
  if (plass.topp) return ['--topp'];
  if (plass.bunn) return ['--bunn'];
  if (plass.over) return ['--over', plass.over];
  return ['--under', plass.under];
}

/** Feilteksten fra et mislykket ko.mjs-kall (JSON-feilene først, ellers stderr/stdout). */
const feilTekst = (r, standard) =>
  (Array.isArray(r.data?.feil) && r.data.feil.length ? r.data.feil.join('\n') : '') ||
  r.feil ||
  r.ut ||
  standard;

/**
 * Massehandlingen fra valglinja. Kroppen: { handling, ider[], verdi, torr, forvent, bekreft }.
 *   torr: true  → forhåndsvisning: hva som endres (ko.mjs endre-mange/ranger --torr, eller koTavle.pakkForhandsvisning
 *                 for «Pakk til spor»), forklaringen, vaktreglene og køens versjon `endret`. Skriver ingenting.
 *   ellers      → vaktreglene (stopp 422, advarsel 409 uten bekreft), så ko.mjs med --forvent-endret <forvent>, så
 *                 en orkestrator som har endret køen imens ikke blir overkjørt (409 med utdatert: true).
 * Id-lista er den eieren så; serveren evaluerer aldri et søk på nytt.
 */
async function masse(b, koNaa) {
  const nei = (melding) => ({ status: 400, svar: { ok: false, melding } });
  const handling = String(b.handling ?? '');
  if (!T.MASSE_HANDLINGER.includes(handling)) return nei(`ukjent massehandling ${handling}`);
  if (!Array.isArray(b.ider)) return nei('ugyldig id-liste');
  const ider = b.ider.map(idEllerNull);
  if (!ider.length || ider.length > T.MASSE_MAKS || ider.some((x) => !x))
    return nei('ugyldig id-liste');
  const forvent = b.forvent == null ? null : String(b.forvent);
  if (forvent != null && !Number.isFinite(Date.parse(forvent))) return nei('ugyldig forvent');
  const verdi = b.verdi && typeof b.verdi === 'object' && !Array.isArray(b.verdi) ? b.verdi : {};
  if (verdi.tittel != null) verdi.tittel = rensTekst(verdi.tittel, 200);
  const ko = koNaa();
  const plan = T.massePlan(ko, handling, ider, verdi);
  if (plan.feil.length) return nei(plan.feil.join('\n'));
  const vurdering = { type: 'masse', handling, ider, verdi };

  if (b.torr === true) {
    let endringer = [];
    let advarsler = [];
    let feil = [];
    let pakke = null;
    let endret = ko.endret ?? null;
    if (plan.kommando === 'samle-pakk') {
      const p = T.pakkForhandsvisning(ko, ider, { nyId: plan.nyId, tittel: plan.tittel });
      if (p.feil.length) feil = p.feil;
      else pakke = p;
    } else {
      const r =
        plan.kommando === 'ranger'
          ? await koJson(['ranger', ...ider, ...plassArgs(plan.plass), '--torr', '--json'])
          : await endreMangeJson(plan.innhold, ['--torr']);
      if (r.ok && r.data?.ok) {
        endringer = r.data.endringer ?? [];
        advarsler = r.data.advarsler ?? [];
        endret = r.data.endret ?? endret;
      } else feil = [feilTekst(r, 'ko.mjs feilet')];
    }
    const liste = T.vurder(ko, vurdering, { naa: Date.now() });
    return {
      status: 200,
      svar: {
        ok: true,
        torr: true,
        endret,
        oppsummering: T.masseOppsummering(ko, handling, ider, verdi, endringer),
        linjer: L.diffLinjer(endringer, { maks: 300 }),
        felt: endringer.length,
        advarsler,
        feil,
        pakke,
        vakt: liste,
        kan: !feil.length && !liste.some((v) => v.nivaa === 'stopp'),
      },
    };
  }

  const v = vakt(ko, vurdering, {}, b);
  if (v.stopp) return v.stopp;
  const fv = forvent ? ['--forvent-endret', forvent] : [];
  let r;
  if (plan.kommando === 'samle-pakk')
    r = await koJson([
      'samle',
      'pakk',
      ...ider,
      '--id',
      plan.nyId,
      ...(plan.tittel ? ['--tittel', plan.tittel] : []),
      ...fv,
    ]);
  else if (plan.kommando === 'ranger')
    r = await koJson([
      'ranger',
      ...ider,
      ...plassArgs(plan.plass),
      '--json',
      '--av',
      'tavla',
      ...fv,
    ]);
  else r = await endreMangeJson(plan.innhold, ['--av', 'tavla', ...fv]);
  hurtig = null;
  const klokke = new Date().toLocaleTimeString('nb-NO');
  const hva = `masse ${handling} ${ider.length === 1 ? ider[0] : `${ider.length} oppgaver`}`;
  console.log(`${klokke} ${hva}: ${r.ok ? 'ok' : `feilet (${feilTekst(r, '?')})`}`);
  if (!r.ok || (r.data && r.data.ok === false)) {
    const utdatert = r.kode === 6 || r.data?.utdatert === true;
    return {
      status: 409,
      svar: {
        ok: false,
        utdatert,
        melding: utdatert
          ? 'Køen er endret siden forhåndsvisningen. Se over endringen på nytt.'
          : feilTekst(r, 'ko.mjs feilet'),
      },
    };
  }
  return {
    status: 200,
    svar: {
      ok: true,
      melding: plan.kommando === 'samle-pakk' ? r.ut : `${r.data?.endret?.length ?? ider.length}`,
      info: v.info,
      // Posten i endringsloggen («Angre» sender den tilbake som --nr). Pakking logges ikke og angres ikke.
      logg: r.data?.logg ?? null,
      ny_id: plan.kommando === 'samle-pakk' ? plan.nyId : null,
    },
  };
}

/**
 * «Angre» (ko.mjs angre). { vis: true } viser den siste posten som kan angres og om det går nå;
 * ellers angres den, med { nr } når tavla vet hvilken post (etter en massehandling), så en annens endring aldri
 * angres i stedet.
 */
async function angre(b) {
  if (b.vis === true) {
    const r = await koJson(['angre', '--vis', '--json']);
    if (!r.data)
      return { status: 500, svar: { ok: false, melding: feilTekst(r, 'ko.mjs feilet') } };
    return {
      status: 200,
      svar: {
        ok: true,
        kan: r.data.ok === true,
        feil: r.data.feil ?? [],
        post: r.data.post ?? null,
        linjer: r.data.post ? L.diffLinjer(r.data.post.endringer ?? [], { maks: 300 }) : [],
      },
    };
  }
  const nr = b.nr == null ? null : Number(b.nr);
  if (nr != null && !(Number.isInteger(nr) && nr > 0))
    return { status: 400, svar: { ok: false, melding: 'ugyldig nr' } };
  const r = await koJson(['angre', '--json', '--av', 'tavla', ...(nr ? ['--nr', String(nr)] : [])]);
  hurtig = null;
  console.log(
    `${new Date().toLocaleTimeString('nb-NO')} angre${nr ? ` nr. ${nr}` : ''}: ${r.ok ? 'ok' : `feilet (${feilTekst(r, '?')})`}`,
  );
  if (!r.ok || r.data?.ok !== true)
    return { status: 409, svar: { ok: false, melding: feilTekst(r, 'ko.mjs angre feilet') } };
  const p = r.data.post;
  return {
    status: 200,
    svar: { ok: true, melding: `Angret ${p?.handling ?? 'endringen'} (nr. ${p?.nr ?? '?'})` },
  };
}

/** Et trinn fra planvisningen: omrade:<oid>, prosjekt:<pid> eller funksjon:<pid>/<navn> (ko.mjs validerer resten). */
const TRINN =
  /^(omrade|prosjekt):[a-z0-9]+(?:-[a-z0-9]+)*$|^funksjon:[a-z0-9]+(?:-[a-z0-9]+)*\/[^\u0000-\u001f\u007f]{1,80}$/;

/**
 * «Lagre fokus» fra planvisningen. Kroppen: { plan: { rekkefolge[], naa_antall?, resten?, til?, navn?,
 * dra_med_avhengigheter?, pause?[], fortsett?[] }, torr, forvent }.
 *   torr: true → forhåndsvisningen (koTavle.fokusForhandsvisning på en kopi: fokus før og etter, trinnene, resten,
 *                dratt med, pause-endringene og «Neste opp» etter lagring) og køens versjon `endret`. Skriver ingenting.
 *   ellers     → ko.mjs fokus lagre --forvent-endret <forvent> (alt eller ingenting); 409 med utdatert: true når køen
 *                er endret siden forhåndsvisningen.
 */
async function fokus(b, koNaa) {
  const nei = (melding) => ({ status: 400, svar: { ok: false, melding } });
  const p = b.plan && typeof b.plan === 'object' && !Array.isArray(b.plan) ? b.plan : null;
  if (!p) return nei('mangler plan');
  const liste = (x) => (Array.isArray(x) ? x.map(String) : x == null ? [] : null);
  const rekkefolge = liste(p.rekkefolge);
  const pause = liste(p.pause);
  const fortsett = liste(p.fortsett);
  if (
    !rekkefolge ||
    rekkefolge.length > L.FOKUS_PLAN_MAKS ||
    rekkefolge.some((x) => !TRINN.test(x))
  )
    return nei('ugyldige trinn');
  if (!pause || !fortsett || [...pause, ...fortsett].some((x) => !PID.test(x)))
    return nei('ugyldig prosjekt-id i pause/fortsett');
  if (p.resten != null && !L.FOKUS_RESTEN.includes(p.resten))
    return nei('resten må være vent eller fyll');
  const til = p.til == null || p.til === '' ? null : String(p.til).trim();
  if (til != null && !/^\d{4}-\d\d-\d\d$/.test(til))
    return nei('datoen må være på formen ÅÅÅÅ-MM-DD');
  const naaAntall = p.naa_antall == null ? null : Number(p.naa_antall);
  if (naaAntall != null && !Number.isInteger(naaAntall)) return nei('ugyldig naa_antall');
  const forvent = b.forvent == null ? null : String(b.forvent);
  if (forvent != null && !Number.isFinite(Date.parse(forvent))) return nei('ugyldig forvent');
  const navn = rensTekst(p.navn, 200);
  const inn = {
    rekkefolge,
    ...(naaAntall != null ? { naa_antall: naaAntall } : {}),
    resten: p.resten ?? 'vent',
    til,
    navn: navn || null,
    dra_med_avhengigheter: p.dra_med_avhengigheter !== false,
    pause,
    fortsett,
  };
  const ko = koNaa();
  if (b.torr === true) {
    const f = T.fokusForhandsvisning(ko, inn, {
      naa: Date.now(),
      ucommittet: ucommittet().ucommittet,
    });
    return {
      status: 200,
      svar: { ok: true, torr: true, endret: ko.endret ?? null, ...f, kan: !f.feil.length },
    };
  }
  const tmp = path.join(os.tmpdir(), `ko-tavle-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(inn));
  let r;
  try {
    r = await koJson([
      'fokus',
      'lagre',
      '--fil',
      tmp,
      '--json',
      '--av',
      'tavla',
      ...(forvent ? ['--forvent-endret', forvent] : []),
    ]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  hurtig = null;
  console.log(
    `${new Date().toLocaleTimeString('nb-NO')} fokus lagre: ${r.ok ? 'ok' : `feilet (${feilTekst(r, '?')})`}`,
  );
  if (!r.ok || r.data?.ok !== true) {
    const utdatert = r.kode === 6 || r.data?.utdatert === true;
    return {
      status: 409,
      svar: {
        ok: false,
        utdatert,
        melding: utdatert
          ? 'Køen er endret siden forhåndsvisningen. Se over fokuset på nytt.'
          : feilTekst(r, 'ko.mjs fokus lagre feilet'),
      },
    };
  }
  return {
    status: 200,
    svar: {
      ok: true,
      melding: rekkefolge.length ? 'Fokus lagret' : 'Fokus fjernet',
      info: r.data.advarsler ?? [],
    },
  };
}

/**
 * Områdene fra tavla. Kroppen: { handling: lagre|slett|flytt, oid, tittel?, beskrivelse?, pid?, torr,
 * forvent }. torr → forklaringen (koTavle.omradePlan prøver på en kopi); ellers ko.mjs omrade … --forvent-endret.
 */
async function omrade(b, koNaa) {
  const nei = (melding) => ({ status: 400, svar: { ok: false, melding } });
  const handling = String(b.handling ?? '');
  if (!T.OMRADE_HANDLINGER.includes(handling)) return nei(`ukjent handling ${handling}`);
  const oid = pidEllerNull(b.oid === '' ? null : b.oid);
  if (oid === undefined || (handling !== 'flytt' && !oid)) return nei('ugyldig område-id');
  const pid = handling === 'flytt' ? pidEllerNull(b.pid) : null;
  if (handling === 'flytt' && !pid) return nei('ugyldig prosjekt-id');
  const forvent = b.forvent == null ? null : String(b.forvent);
  if (forvent != null && !Number.isFinite(Date.parse(forvent))) return nei('ugyldig forvent');
  const ko = koNaa();
  const plan = T.omradePlan(ko, {
    handling,
    oid,
    pid,
    tittel: b.tittel == null ? null : rensTekst(b.tittel, 200),
    beskrivelse: b.beskrivelse == null ? null : rensTekst(b.beskrivelse, 500),
  });
  if (b.torr === true)
    return {
      status: 200,
      svar: {
        ok: true,
        torr: true,
        endret: ko.endret ?? null,
        feil: plan.feil,
        linjer: plan.linjer ?? [],
        kan: !plan.feil.length,
      },
    };
  if (plan.feil.length) return { status: 409, svar: { ok: false, melding: plan.feil.join('\n') } };
  const r = await koMjs([...plan.args, ...(forvent ? ['--forvent-endret', forvent] : [])]);
  hurtig = null;
  console.log(
    `${new Date().toLocaleTimeString('nb-NO')} ${plan.args.join(' ')}: ${r.ok ? 'ok' : `feilet (${r.feil || r.ut})`}`,
  );
  if (!r.ok)
    return {
      status: 409,
      svar: {
        ok: false,
        utdatert: r.kode === 6,
        melding:
          r.kode === 6
            ? 'Køen er endret siden forhåndsvisningen. Se over endringen på nytt.'
            : r.feil || r.ut || 'ko.mjs omrade feilet',
      },
    };
  return { status: 200, svar: { ok: true, melding: r.ut } };
}

/**
 * Gjør `ko.mjs plan prioriter`-kallene fra koPlanVisning.prioriterKall (som har sjekket og renset gruppene) om til
 * lista `plan prioriter-mange --fil` tar: [{ id, prioritet, kategori?, grunn? }]. Argumentene er
 * ['plan', 'prioriter', ...ider, prioritet, --kategori k, --grunn g, …flagg].
 */
function prioriterListe(kall) {
  const ut = [];
  for (const args of kall) {
    const forst = args.findIndex((x, i) => i >= 2 && String(x).startsWith('--'));
    const slutt = forst < 0 ? args.length : forst;
    const prioritet = args[slutt - 1];
    const etter = (flagg) => {
      const k = args.indexOf(flagg, slutt);
      return k < 0 ? null : args[k + 1];
    };
    const kategori = etter('--kategori');
    const grunn = etter('--grunn');
    for (const id of args.slice(2, slutt - 1))
      ut.push({
        id,
        prioritet,
        ...(kategori ? { kategori: [kategori] } : {}),
        ...(grunn ? { grunn } : {}),
      });
  }
  return ut;
}

/**
 * «Lagre prioritetene» fra prioritetskartet. Kroppen: { grupper: [{ prioritet, kategori[],
 * grunn, ider[] }], torr, forvent }. koPlanVisning.prioriterKall sjekker gruppene; hele utkastet går så i ETT
 * `ko.mjs plan prioriter-mange --fil`-kall (--satt-av eier: eieren sitter ved tavla), under én lås og med én
 * endringslogg-post, så én lagring er én angre. Alt eller ingenting gjøres av ko.mjs.
 *   torr: true → kallet med --torr (skriver ingenting): endringene, advarslene, feilene og planregisterets versjon
 *                `endret` (som forhåndsvisningen sender tilbake som `forvent`).
 *   ellers     → kallet med --forvent-endret <forvent>, så en annen økt som har endret registeret imens stopper
 *                lagringen (409 utdatert).
 */
async function planPrioriter(b) {
  const nei = (melding) => ({ status: 400, svar: { ok: false, melding } });
  const { feil, kall } = PV.prioriterKall(b.grupper);
  if (feil.length) return nei(feil.join('\n'));
  const forvent = b.forvent == null ? null : String(b.forvent);
  if (forvent != null && !Number.isFinite(Date.parse(forvent))) return nei('ugyldig forvent');
  const liste = prioriterListe(kall);
  const tmp = path.join(os.tmpdir(), `ko-tavle-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(liste));
  let r;
  try {
    r = await koJson([
      'plan',
      'prioriter-mange',
      '--fil',
      tmp,
      '--satt-av',
      'eier',
      '--av',
      'tavla',
      '--json',
      ...(b.torr === true ? ['--torr'] : forvent ? ['--forvent-endret', forvent] : []),
    ]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  if (b.torr === true) {
    const ok = r.data?.ok === true;
    return {
      status: 200,
      svar: {
        ok: true,
        torr: true,
        endret: ok ? (r.data.endret ?? null) : null,
        endringer: ok ? (r.data.endringer ?? []) : [],
        advarsler: ok ? (r.data.advarsler ?? []) : (r.data?.advarsler ?? []),
        feil: ok ? [] : [feilTekst(r, 'ko.mjs plan prioriter-mange feilet')],
        kan: ok,
      },
    };
  }

  const logg = (ok) =>
    console.log(`${new Date().toLocaleTimeString('nb-NO')} plan prioriter-mange (kartet): ${ok}`);
  if (!(r.ok && r.data?.ok === true)) {
    const utdatert = r.kode === 6 || r.data?.utdatert === true;
    logg('feilet');
    return {
      status: 409,
      svar: {
        ok: false,
        utdatert,
        melding: utdatert
          ? 'Planregisteret er endret siden forhåndsvisningen. Se over utkastet på nytt.'
          : feilTekst(r, 'ko.mjs plan prioriter-mange feilet'),
      },
    };
  }
  logg(`ok (${liste.length} poster)`);
  return {
    status: 200,
    svar: {
      ok: true,
      melding: 'Prioritetene er lagret (én endring i endringsloggen).',
      logg: r.data.logg != null ? [r.data.logg] : [],
    },
  };
}

// ---- Uregistrert-boksen ------------------------------------------------------------------------
// Begge skrivingene går via ko.mjs (samme lås, atomiske skriving, endringslogg og `plan angre`) med eierens valg
// (--satt-av eier, --av tavla). torr = forhåndsvisning (--torr); ellers --forvent-endret <forvent> fra
// forhåndsvisningen, så en økt som har endret registeret imens gir 409 med utdatert: true.
const forventGyldig = (x) => x == null || Number.isFinite(Date.parse(String(x)));
function planSkriveSvar(r, hva, okTekst) {
  const klokke = new Date().toLocaleTimeString('nb-NO');
  if (r.ok && r.data?.ok === true) {
    if (!r.data.torr) console.log(`${klokke} ${hva}: ok`);
    return {
      status: 200,
      svar: {
        ok: true,
        torr: r.data.torr === true,
        endringer: r.data.endringer ?? [],
        advarsler: r.data.advarsler ?? [],
        endret: r.data.endret ?? null,
        logg: r.data.logg ?? null,
        melding: r.data.torr ? null : okTekst,
      },
    };
  }
  const utdatert = r.kode === 6 || r.data?.utdatert === true;
  console.log(`${klokke} ${hva}: feilet`);
  return {
    status: utdatert ? 409 : 400,
    svar: {
      ok: false,
      utdatert,
      advarsler: r.data?.advarsler ?? [],
      melding: utdatert
        ? 'Planregisteret er endret siden forhåndsvisningen. Se over og forhåndsvis på nytt.'
        : feilTekst(r, `ko.mjs ${hva} feilet`),
    },
  };
}

async function planNy(b) {
  const nei = (melding) => ({ status: 400, svar: { ok: false, melding } });
  if (!forventGyldig(b.forvent)) return nei('ugyldig forvent');
  const { post, feil } = PV.nyPostFraSkjema(b.skjema, b.sti);
  if (feil.length) return nei(feil.join('\n'));
  const tmp = path.join(os.tmpdir(), `ko-tavle-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(post));
  try {
    const r = await koJson(PV.nyPostArgs(tmp, { torr: b.torr === true, forvent: b.forvent }));
    return planSkriveSvar(r, `plan ny ${post.id}`, `Ny planpost ${post.id} med kilden ${b.sti}.`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function planKilde(b) {
  const nei = (melding) => ({ status: 400, svar: { ok: false, melding } });
  if (!forventGyldig(b.forvent)) return nei('ugyldig forvent');
  const id = String(b.id ?? '');
  if (!/^PL-[A-Za-z0-9ÆØÅæøå-]{1,60}$/.test(id)) return nei('ugyldig planpost');
  // Kildene leses fra planer.json nå; ko.mjs nekter (exit 6) hvis registeret er endret etter forhåndsvisningen.
  const reg = fs.existsSync(PLANFIL)
    ? P.normaliser(JSON.parse(fs.readFileSync(PLANFIL, 'utf8')))
    : P.tomtRegister();
  const post = (reg.poster ?? []).find((p) => p.id === id);
  if (!post) return nei(`ukjent planpost ${id}`);
  const { kilder, feil } = PV.kildeTillegg(post, b.sti, b.anker);
  if (feil.length) return nei(feil.join('\n'));
  const r = await koJson(PV.kildeArgs(id, kilder, { torr: b.torr === true, forvent: b.forvent }));
  return planSkriveSvar(r, `plan endre ${id} (kilde)`, `${b.sti} er lagt til som kilde på ${id}.`);
}

// ---- Flervalg og endring i raden ---------------------------------------------------------------
// POST /api/plan-masse { handling, ider, prioritet?, kategori?, grunn?, prosjekt?, modenhet?, til?, torr, forvent }.
// Kallene lages og sjekkes av koPlanVisning.planMasseKall (alltid ko.mjs, med eierens valg og --av tavla). torr =
// forhåndsvisning (--torr på hvert kall). Ellers skrives kallene etter hverandre med --forvent-endret fra
// forhåndsvisningen (og deretter fra forrige kall); feiler ett, angres de skrevne nyeste først (`plan angre --nr`), så
// lagringen blir alt eller ingenting. Svaret har endringsloggnumrene (`logg`), som POST /api/plan-angre { nr } angrer.
async function planMasse(b) {
  const nei = (melding) => ({ status: 400, svar: { ok: false, melding } });
  const { feil, kall } = PV.planMasseKall(b);
  if (feil.length) return nei(feil.join('\n'));
  if (!forventGyldig(b.forvent)) return nei('ugyldig forvent');
  const hva = `plan ${b.handling} (tavla, ${kall.length} kall)`;
  const logg = (ok) => console.log(`${new Date().toLocaleTimeString('nb-NO')} ${hva}: ${ok}`);
  if (b.torr === true) {
    const endringer = [];
    const advarsler = [];
    const feilUt = [];
    let endret = null;
    for (const args of kall) {
      const r = await koJson([...args, '--torr']);
      if (r.data?.ok === true) {
        endringer.push(...(r.data.endringer ?? []));
        advarsler.push(...(r.data.advarsler ?? []));
        if (endret == null) endret = r.data.endret ?? null;
      } else feilUt.push(feilTekst(r, `ko.mjs ${args[1]} feilet`));
    }
    return {
      status: 200,
      svar: {
        ok: true,
        torr: true,
        endret,
        endringer,
        advarsler,
        feil: feilUt,
        kan: !feilUt.length,
      },
    };
  }
  const skrevet = [];
  let versjon = b.forvent == null ? null : String(b.forvent);
  for (const args of kall) {
    const r = await koJson([...args, ...(versjon ? ['--forvent-endret', versjon] : [])]);
    if (r.ok && r.data?.ok === true) {
      if (r.data.logg != null) skrevet.push(r.data.logg);
      versjon = r.data.endret ?? versjon;
      continue;
    }
    const utdatert = r.kode === 6 || r.data?.utdatert === true;
    const ikkeAngret = [];
    for (const nr of [...skrevet].reverse()) {
      const a = await koJson(['plan', 'angre', '--nr', String(nr), '--json', '--av', 'tavla']);
      if (!(a.ok && a.data?.ok === true)) {
        ikkeAngret.push(nr);
        break;
      }
    }
    logg(`feilet${skrevet.length ? `, angret ${skrevet.length - ikkeAngret.length}` : ''}`);
    const grunn = utdatert
      ? 'Planregisteret er endret siden forhåndsvisningen. Se over og forhåndsvis på nytt.'
      : feilTekst(r, `ko.mjs ${args[1]} feilet`);
    return {
      status: 409,
      svar: {
        ok: false,
        utdatert,
        melding: ikkeAngret.length
          ? `${grunn}\nNoe ble lagret og kunne ikke angres automatisk (endringslogg nr. ${skrevet.join(', ')}). Bruk ko.mjs plan angre.`
          : grunn,
      },
    };
  }
  logg('ok');
  return {
    status: 200,
    svar: {
      ok: true,
      logg: skrevet,
      melding: `Lagret: ${PV.masseTekst(b, { prosjekter: planCache?.data?.prosjekter ?? {} })}.`,
    },
  };
}

async function planAngre(b) {
  const { feil, kall } = PV.angreKall(b.nr);
  if (feil.length) return { status: 400, svar: { ok: false, melding: feil.join('\n') } };
  let angret = 0;
  for (const args of kall) {
    const r = await koJson(args);
    if (!(r.ok && r.data?.ok === true)) {
      console.log(
        `${new Date().toLocaleTimeString('nb-NO')} plan angre (tavla): feilet etter ${angret}`,
      );
      return {
        status: 409,
        svar: {
          ok: false,
          angret,
          melding: `${feilTekst(r, 'ko.mjs plan angre feilet')}${angret ? ` (${angret} av ${kall.length} er angret)` : ''}`,
        },
      };
    }
    angret += 1;
  }
  console.log(`${new Date().toLocaleTimeString('nb-NO')} plan angre (tavla): ${angret}`);
  return {
    status: 200,
    svar: {
      ok: true,
      angret,
      melding: `Angret (${angret === 1 ? 'én endring' : `${angret} endringer`}).`,
    },
  };
}

// Juristpakken. torr = forhåndsvisning (teksten, og om fila finnes fra før); ellers skrives utkastet
// atomisk til stien koPlan.juristpakke gir (relativt til hovedtreet). En fil som finnes med annet innhold,
// erstattes bare med `erstatt: true`. Fila er et utkast fra planregisteret: ingenting sendes noe sted, og
// planregisteret endres ikke (det skrives bare via ko.mjs).
function juristpakkeSkriv(b) {
  if (typeof P.juristpakke !== 'function')
    return { status: 404, svar: { ok: false, melding: 'Juristpakken finnes ikke i denne versjonen.' } };
  const reg = fs.existsSync(PLANFIL)
    ? P.normaliser(JSON.parse(fs.readFileSync(PLANFIL, 'utf8')))
    : P.tomtRegister();
  const ko = fs.existsSync(FIL) ? JSON.parse(fs.readFileSync(FIL, 'utf8')) : {};
  const pk = P.juristpakke(reg, ko, { naa: new Date() });
  const fil = path.join(KILDEROT, ...pk.sti.split('/'));
  const mappe = path.dirname(fil);
  // Stivern: stien må ligge inne i hovedtreet, og verken mappa eller fila kan være en symlenke (da kunne skrivingen
  // havnet et annet sted).
  if (!path.resolve(fil).startsWith(path.resolve(KILDEROT) + path.sep))
    return { status: 400, svar: { ok: false, melding: `${pk.sti}: utenfor prosjektet.` } };
  for (const x of [mappe, fil])
    if (fs.existsSync(x) && fs.lstatSync(x).isSymbolicLink())
      return {
        status: 400,
        svar: { ok: false, melding: `${pk.sti}: symlenker skrives ikke til.` },
      };
  const finnes = fs.existsSync(fil);
  const lik = finnes && fs.readFileSync(fil, 'utf8') === pk.tekst;
  if (b.torr === true)
    return {
      status: 200,
      svar: {
        ok: true,
        torr: true,
        sti: pk.sti,
        tekst: pk.tekst,
        punkter: pk.punkter,
        finnes,
        lik,
      },
    };
  if (finnes && !lik && b.erstatt !== true)
    return {
      status: 409,
      svar: {
        ok: false,
        bekreft: true,
        melding: `${pk.sti} finnes alt med annet innhold (kanskje redigert for hånd). Erstatte den?`,
      },
    };
  fs.mkdirSync(mappe, { recursive: true });
  const tmp = `${fil}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, pk.tekst);
  fs.renameSync(tmp, fil);
  const n = pk.punkter.length;
  console.log(`${new Date().toLocaleTimeString('nb-NO')} juristpakke ${pk.sti}: ${n} punkter`);
  return {
    status: 200,
    svar: {
      ok: true,
      sti: pk.sti,
      punkter: pk.punkter,
      melding: `Juristpakken er lagret i ${pk.sti} (${n} ${n === 1 ? 'punkt' : 'punkter'}). Den er ikke sendt.`,
    },
  };
}

// Uregistrerte dokumenter (= `ko.mjs plan sjekk --json`, bare lesing). Sjekken leser dokumenter og git, så svaret
// caches til planer.json endres eller det har gått to minutter.
let sjekkCache = null;
async function planSjekk() {
  let mt = 0;
  try {
    mt = fs.statSync(PLANFIL).mtimeMs;
  } catch {
    mt = 0;
  }
  const nokkel = `${mt}|${Math.floor(Date.now() / 120_000)}`;
  if (sjekkCache?.nokkel === nokkel) return sjekkCache.svar;
  const r = await koJson(['plan', 'sjekk', '--json']);
  if (!(r.ok && r.data?.ok === true))
    return { ok: false, melding: feilTekst(r, 'ko.mjs plan sjekk feilet') };
  const uregistrert = (r.data.uregistrert ?? []).filter((s) => typeof s === 'string');
  const svar = { ok: true, uregistrert, grupper: PV.uregistrertGrupper(uregistrert) };
  sjekkCache = { nokkel, svar };
  return svar;
}

/**
 * Vaktreglene (koTavle.vurder) før en skrivehandling. Returnerer { stopp: { status, svar } } når handlingen ikke skal
 * gjøres ennå (422 stopp, 409 advarsel uten `bekreft: true`), ellers { info: [tekst] } som sendes med svaret.
 */
function vakt(ko, handling, kontekst, b) {
  const liste = T.vurder(ko, handling, { naa: Date.now(), ...kontekst });
  const tekster = (nivaa) => liste.filter((v) => v.nivaa === nivaa).map((v) => v.tekst);
  if (tekster('stopp').length)
    return {
      stopp: {
        status: 422,
        svar: { ok: false, vakt: liste, melding: tekster('stopp').join('\n') },
      },
    };
  if (tekster('advarsel').length && b.bekreft !== true)
    return {
      stopp: {
        status: 409,
        svar: { ok: false, bekreft: true, vakt: liste, melding: tekster('advarsel').join('\n') },
      },
    };
  return { info: tekster('info') };
}

/** Gjør en skrivehandling. Returnerer { status, svar }. */
async function skriv(sti, b) {
  const koNaa = () => JSON.parse(fs.readFileSync(FIL, 'utf8'));
  let info = [];
  const kjor = async (args, hva) => {
    const r = await koMjs(args);
    hurtig = null;
    const klokke = new Date().toLocaleTimeString('nb-NO');
    console.log(`${klokke} ${hva}: ${r.ok ? 'ok' : `feilet (${r.feil || r.ut})`}`);
    return r.ok
      ? { status: 200, svar: { ok: true, melding: r.ut, info } }
      : { status: 409, svar: { ok: false, melding: r.feil || r.ut || 'ko.mjs feilet' } };
  };
  const nei = (melding) => ({ status: 400, svar: { ok: false, melding } });

  // Massehandlinger fra valglinja og «Angre».
  if (sti === '/api/masse') return masse(b, koNaa);
  if (sti === '/api/angre') return angre(b);
  // Planvisningen («Lagre fokus») og områdene.
  if (sti === '/api/fokus') return fokus(b, koNaa);
  if (sti === '/api/omrade') return omrade(b, koNaa);
  // Prioritetskartet i Planer-rommet («Lagre prioritetene»).
  if (sti === '/api/plan-prioriter') return planPrioriter(b);
  // Uregistrert-boksen («Ny post» og «Legg til som kilde»).
  if (sti === '/api/plan-ny') return planNy(b);
  if (sti === '/api/plan-kilde') return planKilde(b);
  // Flervalg og endring i raden, og angre det tavla nettopp lagret.
  if (sti === '/api/plan-masse') return planMasse(b);
  if (sti === '/api/plan-angre') return planAngre(b);
  // Juristpakken (lokalt utkast, sendes aldri).
  if (sti === '/api/juristpakke') return juristpakkeSkriv(b);

  if (sti === '/api/flytt') {
    const id = idEllerNull(b.id);
    const over = idEllerNull(b.over);
    const under = idEllerNull(b.under);
    if (!id || over === undefined || under === undefined) return nei('ugyldig id');
    const plass = { over, under, topp: b.topp === true };
    const ko = koNaa();
    const r = T.nyttTillegg(ko, id, plass);
    if (r.feil) return nei(r.feil);
    const v = vakt(ko, { type: 'flytt', id, ...plass }, {}, b);
    if (v.stopp) return v.stopp;
    info = v.info;
    // «Løft avhengighetene også»: kortet og de åpne avhengighetene flyttes i ett endre-mange-kall.
    if (b.loft === true) {
      const l = T.loftTillegg(ko, id, plass);
      if (l.feil) return nei(l.feil);
      const endringer = Object.entries(l.endringer);
      if (endringer.length > 1)
        return endreMange(
          { oppgaver: endringer.map(([oid, t]) => ({ id: oid, prioritet_tillegg: t })) },
          kjor,
          `flytt ${id} med avhengighetene (${endringer.map(([oid, t]) => `${oid} ${t}`).join(', ')})`,
        );
    }
    return kjor(
      ['endre', id, '--json', JSON.stringify({ prioritet_tillegg: r.tillegg })],
      `flytt ${id} (prioritet_tillegg ${r.tillegg})`,
    );
  }
  if (sti === '/api/grense') {
    const navn = String(b.navn ?? '');
    if (!L.GRENSE_NAVN.includes(navn)) return nei(`ukjent innstilling ${navn}`);
    // Verdien går uendret til ko.mjs (som posisjonelt argument, aldri gjennom et skall), så ko.mjs sin validering og
    // melding gjelder. Her stoppes bare det som aldri kan være en verdi.
    const verdi = String(b.verdi ?? '').trim();
    if (!verdi || verdi.length > 20 || /[\u0000-\u001f\u007f]/.test(verdi))
      return nei('skriv en verdi');
    const v = vakt(
      koNaa(),
      { type: 'grense', navn, verdi },
      { forbrukIdag: statistikk().data.nokkeltall.forbrukIdag },
      b,
    );
    if (v.stopp) return v.stopp;
    info = v.info;
    return kjor(['grense', navn, verdi], `grense ${navn} ${verdi}`);
  }
  if (sti === '/api/bane') {
    const pid = pidEllerNull(b.pid);
    const over = pidEllerNull(b.over);
    const under = pidEllerNull(b.under);
    if (!pid || over === undefined || under === undefined) return nei('ugyldig prosjekt-id');
    const baner = T.prosjektBaner(koNaa()).filter((x) => x.flyttbar);
    const r = T.baneTillegg(baner, pid, { over, under });
    if (r.feil) return nei(r.feil);
    const endringer = Object.entries(r.endringer);
    if (endringer.length === 1)
      return kjor(
        ['prosjekt', pid, '--prioritet', String(endringer[0][1])],
        `bane ${pid} (prioritet ${endringer[0][1]})`,
      );
    // Flere prosjekter på én gang: endre-mange er alt eller ingenting.
    const prosjekter = Object.fromEntries(endringer.map(([p, t]) => [p, { prioritet_tillegg: t }]));
    return endreMange(
      { prosjekter },
      kjor,
      `bane ${pid} (${endringer.map(([p, t]) => `${p} ${t}`).join(', ')})`,
    );
  }
  if (sti === '/api/handling') {
    const type = String(b.type ?? '');
    if (type === 'pause' || type === 'fortsett') {
      const pid = pidEllerNull(b.pid);
      if (!pid) return nei('ugyldig prosjekt-id');
      const v = vakt(koNaa(), { type, pid }, {}, b);
      if (v.stopp) return v.stopp;
      info = v.info;
      return kjor(['prosjekt', pid, `--${type}`], `${type} ${pid}`);
    }
    // Svar på et eierspørsmål («Venter på deg»). Svaret er påkrevd (vaktregel 15); id-en må finnes i
    // køen (en oppgave venter på den, eller den er registrert i `sporsmal`), så tavla aldri avklarer noe ukjent.
    if (type === 'avklar') {
      const ko = koNaa();
      const sp = String(b.sp ?? '');
      const kjent =
        L.gyldigSporsmalId(sp) &&
        (Object.hasOwn(ko.sporsmal ?? {}, sp) ||
          (ko.oppgaver ?? []).some((o) => (o.venter_paa ?? []).includes(sp)));
      if (!kjent) return nei('ukjent spørsmål');
      const svar = rensTekst(b.svar, 4000);
      const v = vakt(ko, { type, sp, tekst: svar }, {}, b);
      if (v.stopp) return v.stopp;
      info = v.info;
      return kjor(['avklar', sp, '--svar', svar, '--av', 'eier'], `avklar ${sp}`);
    }
    // QA ok og godkjenn for flere på en gang (ko.mjs tar lister; alt eller ingenting).
    if ((type === 'qa-ok' || type === 'godkjenn') && Array.isArray(b.ider)) {
      const ider = b.ider.map(idEllerNull);
      if (!ider.length || ider.length > 500 || ider.some((x) => !x)) return nei('ugyldig id-liste');
      const args = type === 'qa-ok' ? ['qa', 'ok', ...ider] : ['godkjenn', ...ider];
      return kjor(args, `${type} ${ider.length === 1 ? ider[0] : `${ider.length} oppgaver`}`);
    }
    // «Startet i sky» for en bunt (de valgte kortene) går i ett ko.mjs-kall (alt eller ingenting).
    if (type === 'sky-start' && Array.isArray(b.ider)) {
      const ider = b.ider.map(idEllerNull);
      if (!ider.length || ider.length > 10 || ider.some((x) => !x)) return nei('ugyldig id-liste');
      return kjor(['sky', 'start', ...ider], `sky start ${ider.join(' ')}`);
    }
    // Samlekøen fra panelet. «Legg i samlekøen» og «Ta ut av samlekøen» går via endre-mange (samme regler
    // som add/endre, koLogikk.samlesFeil; alt eller ingenting; endringsloggen gjør dem angrbare), «Pakk» via
    // ko.mjs samle pakk (samme klasse, aldri D+, like eierspørsmål). `forvent` = køens `endret` fra forhåndsvisningen:
    // ko.mjs nekter (409) når køen er endret siden.
    if ((type === 'samle-inn' || type === 'samle-ut') && Array.isArray(b.ider)) {
      const ider = b.ider.map(idEllerNull);
      if (!ider.length || ider.length > 500 || ider.some((x) => !x)) return nei('ugyldig id-liste');
      const forvent = b.forvent == null ? null : String(b.forvent);
      if (forvent != null && !Number.isFinite(Date.parse(forvent))) return nei('ugyldig forvent');
      return endreMange(
        { oppgaver: ider.map((x) => ({ id: x, samles: type === 'samle-inn' })) },
        kjor,
        `${type} ${ider.length === 1 ? ider[0] : `${ider.length} oppgaver`}`,
        ['--av', 'tavla', ...(forvent ? ['--forvent-endret', forvent] : [])],
      );
    }
    if (type === 'samle-pakk' && Array.isArray(b.ider)) {
      const ider = b.ider.map(idEllerNull);
      const nyId = idEllerNull(b.ny_id);
      if (ider.length < 2 || ider.length > 50 || ider.some((x) => !x))
        return nei('ugyldig id-liste');
      if (!nyId) return nei('ugyldig ny id');
      const tittel = rensTekst(b.tittel, 200);
      return kjor(
        ['samle', 'pakk', ...ider, '--id', nyId, ...(tittel ? ['--tittel', tittel] : [])],
        `samle pakk ${ider.join(' ')} → ${nyId}`,
      );
    }
    const id = idEllerNull(b.id);
    if (!id) return nei('ugyldig id');
    // «Startet i sky», «Fullført i sky» og «Avbryt sky» går via ko.mjs sky … (egnetheten, git-sjekken av
    // grenen og grensen på tre skyøkter er der).
    if (type === 'sky-start') {
      const kjoring = rensTekst(b.kjoring, 300);
      if (kjoring && /\s/.test(kjoring)) return nei('lenken eller økt-id-en kan ikke ha mellomrom');
      return kjor(
        ['sky', 'start', id, ...(kjoring ? ['--kjoring', kjoring] : [])],
        `sky start ${id}`,
      );
    }
    if (type === 'sky-ferdig') {
      const gren = rensTekst(b.gren, 100);
      if (gren && (!GREN_MONSTER.test(gren) || gren.includes('..'))) return nei('ugyldig grennavn');
      return kjor(['sky', 'ferdig', id, ...(gren ? ['--gren', gren] : [])], `sky ferdig ${id}`);
    }
    if (type === 'sky-avbryt') return kjor(['sky', 'avbryt', id], `sky avbryt ${id}`);
    // Konteksten vaktreglene trenger: orkestrator-markøren (plukk) og commits på grenen (slipp).
    const ko = koNaa();
    const o = (ko.oppgaver ?? []).find((x) => x.id === id);
    const kontekst = {};
    if (type === 'plukk') kontekst.orkestrator = L.orkestratorStatus(lesJson(MARKOR));
    if (type === 'slipp' && o) {
      const gren = grenFor(o);
      kontekst.grener = { [gren]: grenInfo(gren) };
      kontekst.grenPrefiks = GREN_PREFIKS;
    }
    const v = vakt(ko, { type, id, tekst: b.tekst }, kontekst, b);
    if (v.stopp) return v.stopp;
    info = v.info;
    if (type === 'plukk') {
      const av = rensTekst(b.av, 60);
      if (!av) return nei('skriv hvem som plukker');
      return kjor(['plukk', id, '--av', av], `plukk ${id}`);
    }
    if (type === 'slipp') return kjor(['slipp', id], `slipp ${id}`);
    if (type === 'qa-ok') return kjor(['qa', 'ok', id], `qa ok ${id}`);
    if (type === 'godkjenn') return kjor(['godkjenn', id], `godkjenn ${id}`);
    if (type === 'qa-avvik') {
      const tekst = rensTekst(b.tekst, 2000);
      if (!tekst) return nei('skriv hva som er galt, og hvor');
      return kjor(['qa', 'avvik', id, tekst], `qa avvik ${id}`);
    }
    return nei(`ukjent handling ${type}`);
  }
  return { status: 404, svar: { ok: false, melding: 'ukjent adresse' } };
}

// ---- HTTP -------------------------------------------------------------------------------------------------------
const SIKKERHET = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// JSON over 50 KB (/api/tilstand er flere hundre KB) komprimeres med brotli eller gzip når
// klienten sier at den støtter det (Accept-Encoding). Valget er den rene funksjonen i ko-tavle/ytelse.js (testet).
const Y = require('./ko-tavle/ytelse.js');
function send(res, status, type, kropp, ekstra = {}) {
  const hode = { ...SIKKERHET, 'Content-Type': type, ...ekstra };
  if (type.startsWith('application/json')) {
    const bytes = Buffer.isBuffer(kropp) ? kropp : Buffer.from(String(kropp ?? ''), 'utf8');
    const koding = Y.velgKoding(res.req?.headers['accept-encoding'], bytes.length);
    hode.Vary = 'Accept-Encoding';
    if (koding) {
      kropp =
        koding === 'br'
          ? zlib.brotliCompressSync(bytes, {
              params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }, // rask nok for hver henting
            })
          : zlib.gzipSync(bytes, { level: 6 });
      hode['Content-Encoding'] = koding;
    }
  }
  res.writeHead(status, hode);
  res.end(kropp);
}
const json = (res, status, obj) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), {
    'Cache-Control': 'no-store',
  });

const STATISK = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/tavle.js': ['tavle.js', 'text/javascript; charset=utf-8'],
  '/tavle.css': ['tavle.css', 'text/css; charset=utf-8'],
  // Visningen «Avhengigheter». Oppsettet er de rene funksjonene i lib/koGraf.js (samme fil som testene bruker),
  // servert uendret til nettleseren; graf.js tegner.
  '/graf.js': ['graf.js', 'text/javascript; charset=utf-8'],
  '/koGraf.js': [path.join('..', 'lib', 'koGraf.js'), 'text/javascript; charset=utf-8'],
  // Planvisningen (Nå, Neste, Senere, Venter) med utkast og «Lagre fokus», og hjelpen.
  '/plan.js': ['plan.js', 'text/javascript; charset=utf-8'],
  // Felles fokusfelle, toast-kø, faner og tegnforklaring (samme fil som testene bruker).
  '/uu.js': ['uu.js', 'text/javascript; charset=utf-8'],
  // Kortbufferen, tastaturet mellom kolonnene og komprimeringsvalget (samme fil som testene bruker).
  '/ytelse.js': ['ytelse.js', 'text/javascript; charset=utf-8'],
  // Planer-rommet (egne filer i planer/) og de rene reglene i lib/koPlanVisning.js (samme fil som testene bruker),
  // servert uendret til nettleseren.
  '/planer/planer.js': [path.join('planer', 'planer.js'), 'text/javascript; charset=utf-8'],
  '/planer/planer.css': [path.join('planer', 'planer.css'), 'text/css; charset=utf-8'],
  // Flaten Dokumenter og avtaler, tegnet med de rene reglene i koPlanVisning.js.
  '/planer/dokumenter.js': [path.join('planer', 'dokumenter.js'), 'text/javascript; charset=utf-8'],
  // Prioritetskartet og fristbåndet.
  '/planer/kart.js': [path.join('planer', 'kart.js'), 'text/javascript; charset=utf-8'],
  // Trekartet og avhengighetene for utvalget.
  '/planer/struktur.js': [path.join('planer', 'struktur.js'), 'text/javascript; charset=utf-8'],
  // Lesevisningen av dokumenter og Uregistrert-boksen.
  '/planer/les.js': [path.join('planer', 'les.js'), 'text/javascript; charset=utf-8'],
  // Flatene Juridisk, Beslutninger og Lansering.
  '/planer/juridisk.js': [path.join('planer', 'juridisk.js'), 'text/javascript; charset=utf-8'],
  // Oversikten, og tastaturet, Ctrl+K, flervalget og endringen i raden.
  '/planer/oversikt.js': [path.join('planer', 'oversikt.js'), 'text/javascript; charset=utf-8'],
  '/planer/arbeid.js': [path.join('planer', 'arbeid.js'), 'text/javascript; charset=utf-8'],
  '/koPlanVisning.js': [path.join('..', 'lib', 'koPlanVisning.js'), 'text/javascript; charset=utf-8'],
};

/** HTML-escaping for tittelen som settes inn i index.html. */
const escHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
/** index.html med tittelen fra ko.config.json satt inn ({{TITTEL}}). */
const lesIndex = () =>
  fs.readFileSync(path.join(KLIENT, 'index.html'), 'utf8').replaceAll('{{TITTEL}}', escHtml(TITTEL));

function riktigNokkel(req) {
  const inn = Buffer.from(String(req.headers['x-ko-nokkel'] ?? ''));
  const fasit = Buffer.from(NOKKEL);
  return inn.length === fasit.length && crypto.timingSafeEqual(inn, fasit);
}

function lesKropp(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const biter = [];
    req.on('data', (b) => {
      n += b.length;
      if (n > 16_384) {
        reject(new Error('for stor forespørsel'));
        req.destroy();
      } else biter.push(b);
    });
    req.on('end', () => resolve(Buffer.concat(biter).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding: en fremmed side som peker navnet sitt til 127.0.0.1, sender sin egen Host.
    if (!LOVLIGE_VERTER.has(String(req.headers.host ?? '')))
      return send(res, 421, 'text/plain; charset=utf-8', 'Feil vert.');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const sti = url.pathname;

    if (!sti.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(res, 405, 'text/plain; charset=utf-8', 'Bare GET.');
      if (sti === '/tema.css')
        return send(res, 200, 'text/css; charset=utf-8', TEMA_CSS, { 'Cache-Control': 'no-cache' });
      if (STATISK[sti]) {
        const [fil, type] = STATISK[sti];
        const kropp =
          fil === 'index.html' ? lesIndex() : fs.readFileSync(path.join(KLIENT, fil));
        return send(res, 200, type, kropp, { 'Cache-Control': 'no-cache' });
      }
      // Logoen: uten nøkkel (et <img> kan ikke sende headeren), men bare på lovlig Host (sjekket over). En SVG får
      // sin egen strenge CSP, så den aldri kan kjøre skript.
      if (sti === '/logo') {
        const logo = finnLogo();
        if (!logo) return send(res, 404, 'text/plain; charset=utf-8', 'Ingen logo.');
        return send(res, 200, logo.type, fs.readFileSync(logo.sti), {
          'Cache-Control': 'no-cache',
          ...(logo.type === 'image/svg+xml'
            ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }
            : {}),
        });
      }
      return send(res, 404, 'text/plain; charset=utf-8', 'Finnes ikke.');
    }

    if (!riktigNokkel(req))
      return json(res, 401, {
        ok: false,
        melding: 'Nøkkelen mangler eller er gammel. Åpne lenken ko-tavle skrev i terminalen.',
      });

    if (req.method === 'GET' && sti === '/api/tilstand') {
      try {
        const t = tilstand();
        if (url.searchParams.get('versjon') === t.versjon)
          return json(res, 200, { versjon: t.versjon, uendret: true });
        return json(res, 200, { versjon: t.versjon, data: t.data });
      } catch (e) {
        return json(res, 503, {
          ok: false,
          melding: `Kunne ikke lese køen (${e?.code ?? e?.message ?? 'ukjent feil'}).`,
        });
      }
    }
    if (req.method === 'GET' && sti === '/api/statistikk') {
      try {
        const s = statistikk();
        if (url.searchParams.get('versjon') === s.versjon)
          return json(res, 200, { versjon: s.versjon, uendret: true });
        return json(res, 200, { versjon: s.versjon, data: s.data });
      } catch (e) {
        return json(res, 503, {
          ok: false,
          melding: `Kunne ikke lage statistikken (${e?.code ?? e?.message ?? 'ukjent feil'}).`,
        });
      }
    }
    // Planer-rommet (bare lesing). «uendret» når ingenting er nytt siden versjonen klienten har.
    if (req.method === 'GET' && sti === '/api/planer') {
      try {
        let pl = planer();
        // Vent=1 holder svaret til noe er endret (live oppdatering).
        if (
          url.searchParams.get('vent') === '1' &&
          url.searchParams.get('versjon') === pl.versjon
        ) {
          await ventPaaPlaner(res);
          if (res.destroyed || res.writableEnded) return;
          pl = planer();
        }
        if (url.searchParams.get('versjon') === pl.versjon)
          return json(res, 200, { versjon: pl.versjon, uendret: true });
        return json(res, 200, { versjon: pl.versjon, data: pl.data });
      } catch (e) {
        return json(res, 503, {
          ok: false,
          melding: `Kunne ikke lese planregisteret (${e?.code ?? e?.message ?? 'ukjent feil'}).`,
        });
      }
    }
    // Ett markdown-dokument til lesevisningen (bare lesing; stivernet er koTavle.lesDokument).
    if (req.method === 'GET' && sti === '/api/dok') {
      const r = T.lesDokument(KILDEROT, url.searchParams.get('sti'), { fs, path });
      if (!r.ok) return json(res, r.status, { ok: false, melding: r.melding });
      return json(res, 200, r);
    }
    // Uregistrert-boksen (= ko.mjs plan sjekk --json, bare de uregistrerte dokumentene).
    if (req.method === 'GET' && sti === '/api/plan-sjekk') {
      const r = await planSjekk();
      return json(res, r.ok ? 200 : 503, r);
    }
    if (req.method === 'GET' && sti === '/api/innstillinger') {
      try {
        const ko = JSON.parse(fs.readFileSync(FIL, 'utf8'));
        const stat = statistikk().data;
        return json(res, 200, {
          ok: true,
          felt: T.innstillinger(ko),
          forbrukIdag: stat.nokkeltall.forbrukIdag,
          natt: L.nattVakt(ko),
          oppsett: oppsett(ko, stat),
        });
      } catch (e) {
        return json(res, 503, {
          ok: false,
          melding: `Kunne ikke lese innstillingene (${e?.code ?? e?.message ?? 'ukjent feil'}).`,
        });
      }
    }
    if (req.method === 'GET' && sti === '/api/oppgave') {
      const id = idEllerNull(url.searchParams.get('id'));
      if (!id) return json(res, 400, { ok: false, melding: 'ugyldig id' });
      const ko = JSON.parse(fs.readFileSync(FIL, 'utf8'));
      const o = (ko.oppgaver ?? []).find((x) => x.id === id);
      if (!o) return json(res, 404, { ok: false, melding: `ukjent oppgave ${id}` });
      const oppdrag = oppdragFor(o);
      const gren = grenFor(o);
      return json(res, 200, { ok: true, oppdrag, gren: { navn: gren, ...grenInfo(gren) } });
    }
    // Skypakka («Kopier skypakke»), laget av ko.mjs sky-pakke (som nekter når oppgaven ikke er egnet).
    // Flere id-er (?id=A&id=B) = en bunt i én skyøkt; taket (4 oppgaver, ca. 120 min) håndheves av ko.mjs.
    if (req.method === 'GET' && sti === '/api/skypakke') {
      const ider = url.searchParams.getAll('id').map(idEllerNull);
      if (!ider.length || ider.length > 10 || ider.some((x) => !x))
        return json(res, 400, { ok: false, melding: 'ugyldig id' });
      const r = await koMjs(['sky-pakke', ...ider]);
      if (!r.ok) return json(res, 409, { ok: false, melding: r.feil || 'ko.mjs sky-pakke feilet' });
      return json(res, 200, { ok: true, tekst: r.ut });
    }

    // Visningen «Sky»: forslag til bunter med ferdig sky-start-kommando (= `ko.mjs sky-bunter --json`).
    if (req.method === 'GET' && sti === '/api/sky-bunter') {
      const r = await koMjs(['sky-bunter', '--json']);
      if (!r.ok)
        return json(res, 500, { ok: false, melding: r.feil || 'ko.mjs sky-bunter feilet' });
      try {
        return json(res, 200, { ok: true, data: JSON.parse(r.ut) });
      } catch {
        return json(res, 500, { ok: false, melding: 'ugyldig svar fra ko.mjs sky-bunter' });
      }
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, melding: 'ukjent metode' });
    // Et skrivekall må komme fra tavla selv: Origin (når nettleseren sender den) og JSON-kropp.
    const opphav = req.headers.origin;
    if (opphav != null && !LOVLIGE_OPPHAV.has(String(opphav)))
      return json(res, 403, { ok: false, melding: 'fremmed opphav' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json'))
      return json(res, 415, { ok: false, melding: 'bare application/json' });
    let b;
    try {
      b = JSON.parse((await lesKropp(req)) || '{}');
    } catch {
      return json(res, 400, { ok: false, melding: 'ugyldig JSON' });
    }
    if (!b || typeof b !== 'object' || Array.isArray(b))
      return json(res, 400, { ok: false, melding: 'ugyldig kropp' });
    const r = await enOmGangen(() => skriv(sti, b));
    return json(res, r.status, r.svar);
  } catch (e) {
    return json(res, 500, { ok: false, melding: `intern feil (${e?.message ?? e})` });
  }
});

server.on('error', (e) => {
  console.error(
    e?.code === 'EADDRINUSE'
      ? `Port ${PORT} er i bruk. Velg en annen med --port <nr>.`
      : `Tavla stoppet: ${e?.message ?? e}`,
  );
  process.exit(1);
});

server.listen(PORT, VERT, () => {
  if (!fs.existsSync(FIL)) console.log(`ADVARSEL: fant ikke køen ${FIL}.`);
  console.log(`Kanban-tavla for arbeidskøen kjører (bare på denne maskinen).`);
  console.log(`Åpne: http://${VERT}:${PORT}/#nokkel=${NOKKEL}`);
  console.log(`Kø: ${FIL}. Ctrl+C stopper tavla.`);
});
