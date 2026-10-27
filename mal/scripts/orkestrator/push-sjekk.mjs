#!/usr/bin/env node
// =============================================================
// push-sjekk.mjs: hva blir med i neste `git push <remote> <basegren>`? Se docs/orchestration.md.
//
// Klassifiserer <remote>/<basegren>..<basegren> (første-forelder-linja) som kø (flett av <grenPrefiks><id>),
// orkestrator (traileren «Ko: orkestrator») eller ekstern (andre økter, eieren, hurtigrettinger). Push skal aldri ta
// med noe uten at eieren vet det: orkestratoren kjører denne FØR hver batch-push og spør eieren ved exit 2.
// Basegren og remote kommer fra ko.config.json (konfig().baseGren, konfig().remote).
//
// Bare lesing: den pusher aldri, henter ikke (fetch) og skriver ikke om historikk.
//
// Bruk: node scripts/orkestrator/push-sjekk.mjs [--fra <remote>/<basegren>] [--til <basegren>] [--json]
// Exit: 0 = ingen eksterne commits (eller ingenting å pushe); 2 = eksterne commits (lista, og trygt kuttpunkt når det
// finnes); 1 = feil (f.eks. ukjent ref).
// KO_GIT overstyrer repoet (røyktest mot et midlertidig repo), som i ko.mjs.
// =============================================================

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('./lib/koLogikk.js');
const G = require('./lib/koGit.js');
const { konfig } = require('./lib/koKonfig.js');

const K = konfig();
// Hovedtreet (konfig().rot): basegrenen og de ucommittede filene som betyr noe, er der (også når skriptet kjøres fra
// et worktree).
const git = G.lagGit(process.env.KO_GIT ?? K.rot);
const a = process.argv.slice(2);
const verdi = (navn) => {
  const i = a.indexOf(navn);
  return i >= 0 ? a[i + 1] : undefined;
};
const FRA = verdi('--fra') ?? `${K.remote}/${K.baseGren}`;
const TIL = verdi('--til') ?? K.baseGren;
const SOM_JSON = a.includes('--json');

const sha = (ref) =>
  String(git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]) ?? '').trim() || null;

const fraSha = sha(FRA);
const tilSha = sha(TIL);
if (!fraSha || !tilSha) {
  console.error(
    `push-sjekk: fant ikke ${!fraSha ? FRA : TIL} (git rev-parse). Ingenting er sjekket.`,
  );
  process.exit(1);
}

// Eldst først, som pushPlan vil ha dem.
const raa = G.lesForsteForeldre(git, { fra: FRA, til: TIL });
if (raa == null) {
  console.error(`push-sjekk: kunne ikke lese ${FRA}..${TIL}.`);
  process.exit(1);
}
const commits = G.klassifiser(git, raa, { fra: FRA }).reverse();
const plan = L.pushPlan(commits);
const ucommittet = G.lesUcommittet(git) ?? [];
const sporet = ucommittet.filter((u) => !u.usporet);
const usporet = ucommittet.filter((u) => u.usporet);
// Commits som ikke er på første-forelder-linja, men som en flett tar med (køgrenenes commits og det en ekstern flett
// tar inn), telles for å vise hele omfanget.
const iAlt = Number(String(git(['rev-list', '--count', `${FRA}..${TIL}`]) ?? '0').trim()) || 0;
// Har remote-grenen commits som ikke er i den lokale (lokal ref etter fetch), blir pushen avvist: si det.
const bak = Number(String(git(['rev-list', '--count', `${TIL}..${FRA}`]) ?? '0').trim()) || 0;

const kort = (s) => String(s).slice(0, 8);
const filtekst = (filer, maks = 6) =>
  filer.length
    ? `${filer.slice(0, maks).join(', ')}${filer.length > maks ? ` (+${filer.length - maks})` : ''}`
    : '(ingen filer)';

if (SOM_JSON) {
  console.log(
    JSON.stringify(
      {
        fra: FRA,
        fra_sha: fraSha,
        til: TIL,
        til_sha: tilSha,
        commits_i_alt: iAlt,
        bak_origin: bak,
        forste_forelder: plan.totalt,
        ko: plan.ko,
        orkestrator: plan.orkestrator,
        eksterne: plan.eksterne.map((c) => ({
          sha: c.sha,
          emne: c.emne,
          dato: c.dato,
          filer: c.filer,
          side: c.side.map((s) => ({ sha: s.sha, emne: s.emne, kilde: s.kilde })),
        })),
        kuttpunkt: plan.kuttpunkt,
        sammenflettet: plan.sammenflettet,
        ucommittet: sporet.map((u) => `${u.xy} ${u.sti}`),
        usporet: usporet.length,
      },
      null,
      2,
    ),
  );
} else {
  console.log(tekstRapport().join('\n'));
}
// exitCode (ikke process.exit), så utskriften i et rør alltid blir skrevet ferdig.
process.exitCode = plan.eksterne.length ? 2 : 0;

function tekstRapport() {
  const ut = [];
  ut.push(
    `Push-sjekk ${FRA} (${kort(fraSha)})..${TIL} (${kort(tilSha)}): ${plan.totalt} commit(s) på første-forelder-linja ` +
      `(${iAlt} i alt): ${plan.ko} fra køen, ${plan.orkestrator} fra orkestratoren, ${plan.eksterne.length} eksterne.`,
  );
  if (bak)
    ut.push(
      `NB: ${FRA} har ${bak} commit(s) som ikke er i ${TIL}; pushen blir avvist til de er flettet inn (ikke omskriv).`,
    );
  if (!plan.totalt) ut.push('Ingenting å pushe.');
  else if (!plan.eksterne.length)
    ut.push(
      'Ingen eksterne commits: alt er køens og orkestratorens. Push bare når eieren har sagt «push».',
    );
  else {
    ut.push('');
    ut.push('EKSTERNE COMMITS (ikke fra køen og uten traileren «Ko: orkestrator»), eldst først:');
    for (const c of plan.eksterne) {
      ut.push(`  ${kort(c.sha)}  ${c.dato.slice(0, 16).replace('T', ' ')}  ${c.emne}`);
      ut.push(`            filer: ${filtekst(c.filer)}`);
      const side = c.side.filter((s) => s.kilde === 'ekstern');
      if (side.length)
        ut.push(
          `            flett som tar med ${side.length} commit(s): ${side
            .slice(0, 3)
            .map((s) => `${kort(s.sha)} «${s.emne.slice(0, 50)}»`)
            .join(', ')}${side.length > 3 ? ' …' : ''}`,
        );
    }
    ut.push('');
    if (plan.kuttpunkt) {
      ut.push(`trygt kuttpunkt: ${kort(plan.kuttpunkt)} (${plan.kuttpunkt})`);
      ut.push(
        `  Alle eksterne ligger etter kuttpunktet. Køens del (${plan.egneForKutt} commit(s) på første-forelder-linja) kan ` +
          `pushes alene med: git push ${K.remote} ${plan.kuttpunkt}:${K.baseGren}`,
      );
    } else if (plan.sammenflettet) {
      ut.push(
        'Ingen trygt kuttpunkt: eksterne commits er flettet inn mellom køens, og kan ikke holdes tilbake uten omskriving.',
      );
      ut.push('  Historikken skrives aldri om. Valgene er å ta med alt eller vente.');
    } else {
      ut.push(
        'Ingen trygt kuttpunkt: alt som ikke er pushet, er eksternt (køen har ingenting å pushe alene).',
      );
    }
    ut.push('');
    ut.push(
      'Spør eieren før push (AskUserQuestion): «Ta med alt» / «Push bare køens del» (bare med kuttpunkt) / «Vent».',
    );
  }
  if (sporet.length || usporet.length) {
    ut.push('');
    ut.push(
      `Info: ucommittet i ${TIL === K.baseGren ? 'hovedtreet' : 'repoet'} (pushes ikke): ${sporet.length} endret, ${usporet.length} usporet.`,
    );
    for (const u of sporet.slice(0, 10)) ut.push(`  ${u.xy} ${u.sti}`);
    if (sporet.length > 10) ut.push(`  … og ${sporet.length - 10} til`);
  }
  return ut;
}
