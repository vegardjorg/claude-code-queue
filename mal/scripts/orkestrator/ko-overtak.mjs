#!/usr/bin/env node
// =============================================================
// ko-overtak.mjs: statusbilde for en ny orkestrator-økt som tar over arbeidskøen (skillen /ko).
// Se docs/orchestration.md.
//
// Skriver ingenting. Samler det en ny orkestrator må vite før den starter løkka:
//   0. Øverst: avviklingsflagget i orkestrator-markøren (forrige økt passerte ca. 350k kontekst og skal roteres) og
//      den nyeste overleveringslappen (<datamappe>/overlevering-*.md) med de første linjene.
//   1. Lever forrige orkestrator fortsatt? (når ko.json sist ble endret)
//   2. Git-tilstand i hovedtreet (gren, HEAD, foran/bak <remote>/<basegren>, etterlatt index.lock) og, når
//      konfig().migrasjoner.miljoFil er satt, hvilket miljø migrasjonene er koblet til.
//   3. Hver aktiv oppgave (kjorer/review): commits på grenen foran basegrenen, alder på siste commit, ucommittet i
//      worktreet, og en klassifisering: LEVERT (klar for mottak), TOM (ingenting gjort) eller USIKKER.
//   4. Hvor mange plasser som kan fylles nå, og eierspørsmålene som låser opp flest oppgaver.
//   5. Plukkede oppgaver (en person eller økt gjør dem): hvem, alder, commits på grenen, og «GAMMEL» når den har vært
//      plukket over 72 t uten commits (slippes aldri automatisk; spør eieren). Og antallet i QA-lista.
//   6. Orkestrator-markøren (<datamappe>/orkestrator.json): hvem som sist var orkestrator og når; utløpt etter 2 t
//      uten oppdatering.
//   7. Arbeid utenfor køen (kortversjonen av `ko.mjs ekstern`): eksterne commits som ikke er pushet, grener
//      utenfor køens grenprefiks, ucommittet i hovedtreet, registreringer (ekstern add), samsvar og kollisjoner.
//
// Bruk: node scripts/orkestrator/ko-overtak.mjs [--json]
// KO_MAPPE (mappa med ko.json) og KO_GIT (repoet grenene telles i) overstyrer, som i ko.mjs (røyktester).
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const L = require('./lib/koLogikk.js');
const G = require('./lib/koGit.js');
const { konfig, dataMappe } = require('./lib/koKonfig.js');

const K = konfig();
const BASE = K.baseGren;
const FJERN = `${K.remote}/${BASE}`;
// Hovedtreet (konfig().rot er alltid hovedtreet, også når skriptet kjøres fra et worktree).
const HOVEDTRE = K.rot;
const KO_MAPPE = dataMappe();
const KO_FIL = path.join(KO_MAPPE, 'ko.json');
const GIT_ROT = process.env.KO_GIT ?? HOVEDTRE;
const SOM_JSON = process.argv.includes('--json');
const NAA = Date.now();

// Kjører git i hovedtreet (eller et gitt worktree) og returnerer trimmet stdout, eller null ved feil.
// --no-optional-locks: `git status` i et spors worktree skal ikke ta index.lock mens sporet committer.
function git(args, cwd = GIT_ROT) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// «3 t 12 min» / «14 min» fra millisekunder (felles med ko.mjs).
const alder = L.alderTekst;

// worktree-sti per gren, fra `git worktree list --porcelain`.
function worktreePerGren() {
  const ut = git(['worktree', 'list', '--porcelain']) ?? '';
  const kart = new Map();
  let sti = null;
  for (const linje of ut.split('\n')) {
    if (linje.startsWith('worktree ')) sti = linje.slice(9);
    else if (linje.startsWith('branch refs/heads/') && sti) kart.set(linje.slice(18), sti);
  }
  return kart;
}

const ko = JSON.parse(fs.readFileSync(KO_FIL, 'utf8'));
const oppgaver = ko.oppgaver ?? [];

// ---- 1. Forrige orkestrator ----
const koEndretMs = ko.endret ? NAA - Date.parse(ko.endret) : null;
// Under 15 min siden sist endring: en annen orkestrator er sannsynligvis i live. To orkestratorer samtidig gir
// dobbel start og dobbel fletting, så skillen stopper da og spør eieren.
const muligLevende = koEndretMs != null && koEndretMs < 15 * 60_000;

// ---- 2. Git og (valgfritt) migrasjonsmiljøet ----
const gren = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = git(['rev-parse', '--short', 'HEAD']);
const foranBak = git(['rev-list', '--left-right', '--count', `${FJERN}...${BASE}`]);
const [bak, foran] = (foranBak ?? '? ?').split(/\s+/);
const lasSti = path.join(HOVEDTRE, '.git', 'index.lock');
const indexLock = fs.existsSync(lasSti) ? alder(NAA - fs.statSync(lasSti).mtimeMs) : null;
// Miljøfila (konfig().migrasjoner.miljoFil) sier hvilket miljø migrasjonene pushes mot; push-vakta sjekker den mot
// migrasjoner.tillatteMiljo. null = ikke satt opp eller fila finnes ikke.
const miljoFil = K.migrasjoner?.miljoFil ?? null;
let miljo = null;
if (miljoFil) {
  try {
    miljo = fs.readFileSync(path.resolve(HOVEDTRE, miljoFil), 'utf8').trim();
  } catch {
    /* ikke koblet */
  }
}
const tillatteMiljo = Array.isArray(K.migrasjoner?.tillatteMiljo) ? K.migrasjoner.tillatteMiljo : [];

// ---- 3. Aktive oppgaver ----
const wt = worktreePerGren();
const aktive = oppgaver
  .filter((o) => ['kjorer', 'review'].includes(o.status))
  .map((o) => {
    const g = o.gren ?? `${K.grenPrefiks}${o.id}`;
    const finnes = git(['rev-parse', '-q', '--verify', g]) != null;
    const commits = finnes ? Number(git(['rev-list', '--count', `${BASE}..${g}`]) ?? 0) : 0;
    const sisteIso = finnes ? git(['log', '-1', '--format=%cI', g]) : null;
    const sisteMs = sisteIso ? NAA - Date.parse(sisteIso) : null;
    const wtSti = wt.get(g);
    const ucommittet = wtSti
      ? (git(['status', '--porcelain'], wtSti) ?? '').split('\n').filter(Boolean).length
      : null;
    const startetMs = o.startet ? NAA - Date.parse(o.startet) : null;
    // LEVERT: commits foran basegrenen, rent worktree, og ingen ny commit på 20 min (agenten har gitt seg).
    // TOM: ingen commits og startet for over en time siden (agenten døde før den gjorde noe).
    let vurdering = 'USIKKER';
    if (o.status === 'review')
      vurdering = commits > 0 ? 'LEVERT (review)' : 'USIKKER (review uten commits)';
    else if (commits > 0 && (ucommittet ?? 0) === 0 && (sisteMs ?? 0) > 20 * 60_000)
      vurdering = 'LEVERT';
    else if (commits === 0 && (startetMs ?? 0) > 60 * 60_000) {
      // Arbeidet kan ligge på en annen gren (f.eks. hotfix/<id>): let etter commits som nevner id-en.
      const annen = git([
        'log',
        '--all',
        '-1',
        '--format=%h %D',
        `--grep=${o.id}\\b`,
        '--extended-regexp',
      ]);
      vurdering = annen
        ? `USIKKER (commit ${annen.split(' ')[0]} nevner ${o.id} på annen gren)`
        : 'TOM';
    } else if ((ucommittet ?? 0) > 0) vurdering = 'USIKKER (ucommittet i worktree)';
    return {
      id: o.id,
      status: o.status,
      klasse: o.klasse,
      migr: Number(o.migr_tiere ?? 0) > 0,
      gren: g,
      commits,
      siste_commit: alder(sisteMs),
      startet: alder(startetMs),
      ucommittet,
      worktree: wtSti ?? null,
      vurdering,
    };
  });

// ---- 4. Hva kan startes, og hva blokkerer (som `neste`: ucommittede eierfiler i hovedtreet hoppes over) ----
const gitLes = G.lagGit(GIT_ROT);
const ucommittet = (G.lesUcommittet(gitLes) ?? []).map((u) => u.sti);
const t = L.tilstand(ko, undefined, { ucommittet });
const kanStarte = L.velgNeste(ko, NAA, { ucommittet }).map((o) => o.id);

// ---- 5. Plukkede oppgaver ----
const plukket = oppgaver
  .filter((o) => o.status === 'plukket')
  .map((o) => {
    const g = o.gren ?? `${K.grenPrefiks}${o.id}`;
    const finnes = git(['rev-parse', '-q', '--verify', `refs/heads/${g}`]) != null;
    const commits = finnes ? Number(git(['rev-list', '--count', `${BASE}..${g}`]) ?? 0) || 0 : 0;
    const sisteCommit = commits > 0 ? git(['log', '-1', '--format=%cI', g]) : null;
    return {
      id: o.id,
      klasse: o.klasse,
      av: o.plukket_av ?? null,
      plukket: alder(o.plukket_at ? NAA - Date.parse(o.plukket_at) : null),
      gren: g,
      commits,
      siste_commit: sisteCommit ? alder(NAA - Date.parse(sisteCommit)) : null,
      migr_blokk: o.migr_blokk ?? null,
      gammel: L.erGammelPlukk(o, { commits, sisteCommit }, NAA),
    };
  });

// ---- 6. Orkestrator-markøren ----
let markor = null;
try {
  markor = JSON.parse(fs.readFileSync(path.join(KO_MAPPE, 'orkestrator.json'), 'utf8'));
} catch {
  /* ingen markør */
}
const orkestrator = L.orkestratorStatus(markor, NAA);
// Avviklingsflagget (hook-kontekst ved ca. 350k) og den nyeste overleveringslappen vises øverst.
const avvikling = L.avviklingVakt(markor, NAA);

// ---- 6c. Overleveringslappen (<datamappe>/overlevering-<tid>.md, skrevet av forrige orkestrator) ----
let lapp = null;
try {
  const filer = fs
    .readdirSync(KO_MAPPE)
    .filter((f) => /^overlevering-.*\.md$/.test(f))
    .map((f) => ({ f, ms: fs.statSync(path.join(KO_MAPPE, f)).mtimeMs }))
    .sort((a, b) => b.ms - a.ms);
  if (filer.length) {
    const sti = path.join(KO_MAPPE, filer[0].f);
    lapp = {
      sti,
      alder: alder(NAA - filer[0].ms),
      // Første linjer: overskrift og status. Hele lappen leses med Read.
      utdrag: fs.readFileSync(sti, 'utf8').split('\n').slice(0, 12).join('\n'),
    };
  }
} catch {
  /* ingen lapp */
}

// ---- 6b. Øktas tenkenivå (hook-effort.mjs): medium er standard for orkestratoren ----
let effort = null;
try {
  effort = JSON.parse(fs.readFileSync(path.join(KO_MAPPE, 'effort.json'), 'utf8'));
} catch {
  /* ingen markør ennå (skrives ved neste melding) */
}

// ---- 7. Arbeid utenfor køen (detaljer: ko.mjs ekstern) ----
const harOrigin = git(['rev-parse', '-q', '--verify', `refs/remotes/${FJERN}`]) != null;
const eb = G.eksternBilde(gitLes, ko, {
  vindu: harOrigin
    ? { fra: FJERN }
    : { siden: new Date(NAA - 86_400_000).toISOString() },
});
const utenfor = {
  vindu: harOrigin ? 'ikke pushet' : 'siste 24 t',
  eksterne_commits: eb.eksterne.map((c) => `${c.kort} ${c.emne}`),
  grener: eb.grener.map((g) => `${g.navn} (${g.antall})`),
  ucommittet_endret: eb.ucommittet.filter((u) => !u.usporet).length,
  ucommittet_usporet: eb.ucommittet.filter((u) => u.usporet).length,
  registrert: eb.registrert.map((o) => `${o.id} «${o.ekstern_navn}»`),
  samsvar: eb.samsvar.filter((s) => s.forslag).map((s) => s.forslag),
  kollisjoner_aktive: eb.kollisjoner
    .filter((k) => k.status !== 'venter')
    .map((k) => L.kollisjonTekst(k)),
  kollisjoner_ventende: eb.kollisjoner.filter((k) => k.status === 'venter').length,
  feil: eb.feil,
};

const rapport = {
  avvikling: avvikling.stopp ? { ...markor.avvikling, melding: avvikling.melding } : null,
  overleveringslapp: lapp ? { sti: lapp.sti, alder: lapp.alder } : null,
  ko_sist_endret: alder(koEndretMs),
  mulig_levende_orkestrator: muligLevende,
  orkestrator_markor: {
    aktiv: orkestrator.aktiv,
    okt: orkestrator.okt,
    oppdatert_for: alder(orkestrator.alder_ms),
    hendelse: orkestrator.hendelse ?? null,
  },
  utenfor_koen: utenfor,
  git: { gren, head, foran_origin: foran, bak_origin: bak, index_lock_alder: indexLock },
  migrasjonsmiljo: miljoFil ? { fil: miljoFil, miljo, tillatt: miljo != null && tillatteMiljo.includes(miljo) } : null,
  aktive,
  plukket,
  qa_lista: t.qa,
  venter: t.venter,
  kan_starte_na: kanStarte,
  eiersporsmal: t.eiersporsmal.slice(0, 8),
  grenser: ko.grenser,
};

if (SOM_JSON) {
  console.log(JSON.stringify(rapport, null, 2));
} else {
  const ut = [];
  if (avvikling.stopp) {
    ut.push(`⚠ ${avvikling.melding}`);
    ut.push(
      '  Tar du over som ny orkestrator: `ko.mjs orkestrator puls --okt "<nytt navn>"` nullstiller avviklingen.',
    );
    ut.push('');
  }
  if (lapp) {
    ut.push(`Overleveringslapp (${lapp.alder} gammel, les hele): ${lapp.sti}`);
    for (const l of lapp.utdrag.split('\n')) ut.push(`  | ${l}`);
    ut.push('');
  }
  ut.push(
    `Køen sist endret: ${rapport.ko_sist_endret} siden${muligLevende ? '  ⚠ en annen orkestrator kan være i live' : ''}`,
  );
  ut.push(
    orkestrator.okt
      ? `Orkestrator-markør: «${orkestrator.okt}», oppdatert for ${alder(orkestrator.alder_ms)} siden` +
          `${orkestrator.hendelse ? ` (${orkestrator.hendelse})` : ''} → ${orkestrator.aktiv ? 'AKTIV' : 'utløpt (over 2 t)'}`
      : 'Orkestrator-markør: ingen (ingen orkestrator har meldt seg med ko.mjs orkestrator puls)',
  );
  ut.push(
    `Git: ${gren} @ ${head}, ${foran} foran / ${bak} bak ${FJERN}` +
      (indexLock ? `, ⚠ .git/index.lock ${indexLock} gammel` : ''),
  );
  if (miljoFil)
    ut.push(
      `Migrasjonsmiljø (${miljoFil}): ${miljo ?? 'ikke koblet'}` +
        (miljo != null && !tillatteMiljo.includes(miljo) ? '  ⚠ ikke i migrasjoner.tillatteMiljo' : ''),
    );
  ut.push(
    effort?.nivaa
      ? `Tenkenivå (orkestratoren): ${effort.nivaa}` +
          (effort.nivaa === 'medium'
            ? ''
            : '  ⚠ ikke medium: be eieren bekrefte nivået før løkka starter')
      : 'Tenkenivå (orkestratoren): ukjent (markøren skrives ved neste melding)',
  );
  ut.push('');
  ut.push('Aktive oppgaver:');
  for (const a of aktive) {
    ut.push(
      `  ${a.id.padEnd(12)} ${a.status.padEnd(7)} ${String(a.klasse).padEnd(3)} ${a.migr ? 'migr' : '    '} ` +
        `${String(a.commits).padStart(2)} commits, siste ${a.siste_commit}, startet ${a.startet}, ` +
        `ucommittet ${a.ucommittet ?? '-'}  → ${a.vurdering}`,
    );
  }
  if (!aktive.length) ut.push('  (ingen)');
  ut.push('');
  // Plukkede tar ingen agentplass, men eier filene sine; en «gammel» slippes aldri automatisk (spør eieren).
  ut.push('Plukket (person/økt gjør dem; ingen agentplass):');
  for (const p of plukket) {
    ut.push(
      `  ${p.id.padEnd(12)} ${String(p.klasse).padEnd(3)} av ${p.av ?? '?'}, plukket for ${p.plukket} siden, ` +
        `${p.commits} commit(s)${p.siste_commit ? `, siste ${p.siste_commit}` : ''}` +
        (p.gammel ? '  → GAMMEL (over 72 t uten commits; slippes aldri automatisk)' : ''),
    );
  }
  if (!plukket.length) ut.push('  (ingen)');
  ut.push(`QA-lista: ${t.qa} ferdig(e) oppgave(r) venter på eieren (ko.mjs qa).`);
  ut.push('');
  ut.push(
    `Venter: ${t.venter}. Kan startes nå (${kanStarte.length}): ${kanStarte.join(', ') || '-'}`,
  );
  ut.push('Eierspørsmål som låser opp flest:');
  for (const e of rapport.eiersporsmal) ut.push(`  ${e.sp}: ${e.oppgaver} oppgave(r)`);
  if (!rapport.eiersporsmal.length) ut.push('  (ingen)');
  ut.push('');
  ut.push(`Arbeid utenfor køen (${utenfor.vindu}; detaljer: ko.mjs ekstern):`);
  for (const f of utenfor.feil) ut.push(`  ⚠ ${f}`);
  ut.push(
    `  ${utenfor.eksterne_commits.length} eksterne commit(s) på ${BASE}, ${utenfor.grener.length} gren(er) utenfor ${K.grenPrefiks}*, ` +
      `${utenfor.ucommittet_endret} ucommittet endret (+${utenfor.ucommittet_usporet} usporet) i hovedtreet, ` +
      `${utenfor.registrert.length} registrert (ekstern add)`,
  );
  for (const c of utenfor.eksterne_commits.slice(0, 5)) ut.push(`    ${c.slice(0, 100)}`);
  if (utenfor.grener.length) ut.push(`    grener: ${utenfor.grener.join(', ')}`);
  for (const r of utenfor.registrert) ut.push(`    registrert: ${r}`);
  for (const s of utenfor.samsvar) ut.push(`    samsvar: ${s}`);
  for (const k of utenfor.kollisjoner_aktive.slice(0, 5))
    ut.push(`    kollisjon: ${k.slice(0, 110)}`);
  if (utenfor.kollisjoner_ventende)
    ut.push(
      `    ${utenfor.kollisjoner_ventende} kollisjon(er) med ventende oppgaver (ko.mjs ekstern)`,
    );
  ut.push('  Push: kjør push-sjekk.mjs først; eksterne commits pushes aldri uten eierens svar.');
  console.log(ut.join('\n'));
}
