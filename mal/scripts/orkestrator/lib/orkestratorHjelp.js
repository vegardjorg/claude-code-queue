// =============================================================
// orkestratorHjelp.js: rene hjelpefunksjoner for gate-runneren (gater.mjs), worktree-klargjøringen
// (klargjor-spor.mjs) og worktree-ryddingen (rydd-worktree.mjs).
//
// Alt her er rene funksjoner uten fs, git eller prosesser, så beslutningene kan enhetstestes
// (lib/__tests__/orkestratorHjelp.test.ts). Skriptene gjør I/O-en og kaller hit for å velge.
// Se docs/orchestration.md for hvordan sporene klargjøres og ryddes.
// =============================================================
'use strict';

/** Normaliserer stier fra git (Windows kan gi bakstrek). */
function normaliserSti(s) {
  return String(s).trim().split('\\').join('/');
}

/** Fjerner ANSI-fargekoder. */
function utenFarger(s) {
  return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

const kort = (s, maks = 200) => {
  const t = String(s).trim().replace(/\s+/g, ' ');
  return t.length > maks ? t.slice(0, maks - 1) + '…' : t;
};

/** Gjør en absolutt sti i en feillinje relativ til rota, så linja blir kort og lesbar. */
function relativ(linje, rot) {
  if (!rot) return linje;
  const r1 = normaliserSti(rot).replace(/\/$/, '') + '/';
  const r2 = r1.split('/').join('\\');
  return linje.split(r1).join('').split(r2).join('');
}

/**
 * Hvilken type verktøy en gate-kommando er, så forsteFeillinje vet hva den skal lete etter.
 * 'tsc', 'eslint', 'prettier', 'test' (vitest/jest/mocha/node --test) eller 'annet'.
 */
function gateType(kommando) {
  const k = String(kommando || '');
  if (/\btsc\b/.test(k)) return 'tsc';
  if (/\beslint\b/.test(k)) return 'eslint';
  if (/\bprettier\b/.test(k)) return 'prettier';
  if (/\b(vitest|jest|mocha)\b|--test\b|\bnpm (run )?test\b/.test(k)) return 'test';
  return 'annet';
}

/**
 * Plukker den første meningsfulle feillinja fra utdataene til en rød gate. `type` er 'tsc', 'eslint',
 * 'prettier', 'test' (eller 'jest') eller noe annet (generisk). Faller tilbake til siste ikke-tomme linje.
 */
function forsteFeillinje(type, tekst, rot) {
  const linjer = utenFarger(tekst)
    .split(/\r?\n/)
    .map((l) => relativ(l, rot));
  const ikkeTomme = linjer.filter((l) => l.trim());
  const finn = (re) => linjer.find((l) => re.test(l));

  if (type === 'tsc') {
    const l = finn(/error TS\d+:/);
    if (l) return kort(l);
  }
  if (type === 'eslint') {
    for (let i = 0; i < linjer.length; i++) {
      const m = linjer[i].match(/^\s+(\d+:\d+)\s+error\s+(.*)$/);
      if (!m) continue;
      let fil = '';
      for (let j = i - 1; j >= 0; j--) {
        if (linjer[j].trim() && !/^\s/.test(linjer[j])) {
          fil = linjer[j].trim();
          break;
        }
      }
      return kort(`${fil}:${m[1]} ${m[2]}`);
    }
    const l = finn(/(Error|Oops!|Cannot find)/);
    if (l) return kort(l);
  }
  if (type === 'prettier') {
    const l =
      finn(/^\[error\]/) ||
      linjer.find((x) => /^\[warn\]\s+\S/.test(x) && !/Code style issues|Run Prettier/i.test(x));
    if (l) return kort('ikke formatert: ' + l.replace(/^\[(warn|error)\]\s*/, ''));
  }
  if (type === 'test' || type === 'jest') {
    const l = linjer.find((x) => /^\s*(●|×|✗|FAIL) /.test(x) && !/● Console/.test(x));
    if (l) return kort(l);
  }
  const generisk = finn(
    /(✗|✖|❌|\bFEIL\b|\bfeil:|\bRØD\b|\bError\b|\bERROR\b|\bbrudd\b|\bmangler\b|\bfailed\b)/,
  );
  if (generisk) return kort(generisk);
  return kort(ikkeTomme[ikkeTomme.length - 1] || '(ingen utdata)');
}

/** Formaterer resultatlinja for én gate: `navn  GRØNN 12 s` / `navn  RØD 40 s: første feillinje`. */
function resultatLinje(r, bredde = 34) {
  const navn = r.navn.padEnd(bredde);
  const s = `${Math.round(r.sek)} s`;
  if (r.status === 'GRØNN') return `${navn} GRØNN ${s}`;
  return `${navn} RØD ${s}${r.forste ? `: ${r.forste}` : ''}`;
}

/**
 * Hva klargjor-spor.mjs skal gjøre med grenen.
 *  - 'behold': står allerede på ønsket gren.
 *  - 'switch': `git switch <gren>` uten -B. Målgrenen finnes fra før med commits som ikke er på basen (typisk
 *    etter `ko.mjs slipp`, som beholder grenen, eller et nytt worktree for en fortsettelse). En `checkout -B`
 *    ville nullstilt den, og commitene ville bare vært igjen i reflog.
 *  - 'checkout': ny `git checkout -B <gren> <base>` (worktreet er rent, har ingen egne commits, og målgrenen
 *    finnes ikke eller har ingen commits foran basen).
 *  - 'nekt': ville kastet arbeid (skittent tre, eller commits som ikke er på basen).
 *
 * `maalCommits` er antall commits på målgrenen som ikke er på basen (0 eller udefinert når grenen ikke finnes).
 * `base` er navnet på basen i tekstene (standard «basegrenen»).
 */
function grenBeslutning({ gjeldende, gren, skittent, egneCommits, maalCommits = 0, base = 'basegrenen' }) {
  if (gjeldende === gren) return { handling: 'behold' };
  if (skittent) {
    const grunn = `ucommittede endringer på ${gjeldende || '(løs HEAD)'}`;
    return {
      handling: 'nekt',
      grunn:
        maalCommits > 0
          ? `${grunn}; ${gren} finnes med ${maalCommits} commit(s) foran ${base} og kan bare tas over fra et rent worktree`
          : grunn,
    };
  }
  if (egneCommits > 0)
    return {
      handling: 'nekt',
      grunn: `${gjeldende || '(løs HEAD)'} har ${egneCommits} commit(s) som ikke er på ${base}`,
    };
  if (maalCommits > 0) return { handling: 'switch', maalCommits };
  return { handling: 'checkout' };
}

/**
 * Hva klargjor-spor.mjs skal gjøre med grenen under `--fortsett`: retterunde eller fortsettelse av et spor i en NY
 * agent og et nytt worktree. Grenen tas over som den er, aldri nullstilt (`checkout -B`), og egne commits telles
 * etterpå mot basen.
 *  - 'behold': står allerede på grenen.
 *  - 'switch': `git switch <gren>` uten reset.
 *  - 'nekt': grenen finnes ikke, er sjekket ut i et annet worktree, worktreet er skittent, eller løs HEAD har commits
 *    som ikke er på basen (de ville blitt hengende uten gren).
 *
 * `annetWorktree` er stien til et ANNET worktree som har grenen sjekket ut (se worktreeMedGren), ellers null.
 * En vanlig worktree-gren (worktree-agent-x) med egne commits hindrer ikke byttet: commitene blir værende på den.
 */
function fortsettBeslutning({
  gjeldende,
  gren,
  finnes,
  skittent,
  egneCommits = 0,
  annetWorktree,
  base = 'basegrenen',
}) {
  if (!finnes)
    return {
      handling: 'nekt',
      grunn: `${gren} finnes ikke; --fortsett tar bare over en eksisterende gren (nytt spor: kjør uten --fortsett)`,
    };
  if (gjeldende === gren) return { handling: 'behold' };
  if (annetWorktree)
    return {
      handling: 'nekt',
      grunn: `${gren} er sjekket ut i et annet worktree (${annetWorktree}); frigjør den med \`git -C "${annetWorktree}" switch --detach\` og kjør på nytt`,
    };
  if (skittent)
    return { handling: 'nekt', grunn: `ucommittede endringer på ${gjeldende || '(løs HEAD)'}` };
  if (!gjeldende && egneCommits > 0)
    return {
      handling: 'nekt',
      grunn: `løs HEAD har ${egneCommits} commit(s) som ikke er på ${base}; lag en gren for dem først`,
    };
  return { handling: 'switch' };
}

/**
 * Finner worktreet som har `gren` sjekket ut, fra utdata av `git worktree list --porcelain`.
 * Gir stien (som git skrev den) eller null. Sammenligner hele ref-navnet, så ko/X ikke treffer ko/X-r1.
 * @param {string} porcelain
 * @param {string} gren
 * @returns {string | null}
 */
function worktreeMedGren(porcelain, gren) {
  let sti = null;
  for (const raa of String(porcelain).split('\n')) {
    const linje = raa.replace(/\r$/, '');
    if (linje.startsWith('worktree ')) sti = linje.slice('worktree '.length);
    else if (linje === `branch refs/heads/${gren}`) return sti;
  }
  return null;
}

/**
 * Stiene (relativt til worktree-rota, med «/») som klargjor-spor.mjs lager som lenker (junction på Windows,
 * symlenke ellers) til HOVEDTREETS mapper, og som rydd-worktree.mjs må fjerne som LENKER (aldri rekursivt) før et
 * worktree slettes. Begge leser lista herfra, så de aldri driver fra hverandre: en lenke ryddingen ikke kjenner til,
 * kan følges av en rekursiv sletting og tømme mappa i hovedtreet.
 *
 * Kilden er konfig().delteLenker (standard ['node_modules']). Ugyldige stier (absolutte, med «..», tomme) tas ut.
 * @param {string[]} [delteLenker]
 * @returns {string[]}
 */
function sporLenker(delteLenker) {
  const liste = delteLenker ?? require('./koKonfig.js').konfig().delteLenker ?? [];
  const ut = [];
  for (const raa of Array.isArray(liste) ? liste : []) {
    const rel = normaliserSti(raa).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..'))
      continue;
    if (!ut.includes(rel)) ut.push(rel);
  }
  return ut;
}

module.exports = {
  forsteFeillinje,
  fortsettBeslutning,
  gateType,
  grenBeslutning,
  normaliserSti,
  resultatLinje,
  sporLenker,
  utenFarger,
  worktreeMedGren,
};
