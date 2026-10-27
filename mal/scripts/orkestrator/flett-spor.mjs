#!/usr/bin/env node
// =============================================================
// flett-spor.mjs: fletter én spor-gren inn i basegrenen (konfig().baseGren) og løser de vanligste konfliktene
// automatisk. Se docs/orchestration.md.
//
// HVORFOR: når flere spor jobber parallelt, legger de ofte til blokker sist i de samme filene (registre, lister,
// oversettelser, testlister). Git ser to innsettinger på samme sted som en konflikt, og deler ofte felles linjer (en
// avsluttende «}» eller «];») mellom sidene. Å løse dette for hånd per spor er tregt og feilutsatt: konfliktmarkører
// blir committet, eller et manglende komma slår sammen to strenger.
//
// SLIK: git merger først. For hver fil i konflikt gjør skriptet sin EGEN treveis-fletting fra base (:1:), HEAD (:2:)
// og grenen (:3:), i stedet for å klippe i git sine markører:
//   * tekstfiler: endringene fra hver side mot base (git diff -U0) legges på base.
//       - endringer på ulike steder: begge tas med
//       - innsettinger på samme sted: HEAD sine først, så grenens
//       - samme baselinjer endret likt på begge sider (for eksempel komma lagt til på forrige element): de endrede
//         linjene én gang, så resten fra HEAD, så resten fra grenen
//       - ellers: ekte konflikt, løses for hånd
//     I SQL og JS/TS settes et manglende komma inn der HEAD sin blokk slutter med listeverdier og grenens blokk
//     begynner med en ny.
//   * oversettelsesfiler (JSON under en locales/-mappe): HEAD-teksten, pluss toppnøkler grenen har lagt til, satt inn
//     ordrett. Kontrolleres treveis mot base.
//
// ETTERPÅ valideres de berørte filene: ingen konfliktmarkører, JSON parser, `node --check` på JS, og i SQL-filer som
// ble flettet automatisk: listeverdier eller tupler uten komma foran en ny. Er alt grønt, committes flettingen. Ellers
// står flettingen igjen (git merge --abort for å angre), og skriptet sier hva som må løses for hånd. Prosjektets egne
// gater (gater.mjs) kjøres av `ko.mjs flett` etter dette skriptet, ikke her.
//
// Med migrasjoner slått på (konfig().migrasjoner.mappe) rapporteres også SQL-funksjoner som grenen skriver om helt
// (create or replace) og som et annet spor i samme bølge også har skrevet om. Da vinner den med høyest
// migrasjonsnummer, og den andres endring forsvinner stille.
//
// ETTER en vellykket fletting ryddes sporets worktree (rydd-worktree.mjs: lenkene fjernes som lenker, så
// `git worktree remove` uten --force). Grenen beholdes. Ryddingen er best-effort: den gjør aldri en vellykket fletting
// til exit ≠ 0, og låste, skitne eller ikke-flettede worktrees står.
//
// BRUK:
//   node scripts/orkestrator/flett-spor.mjs <gren> [--bolge-base <sha>] [--uten-commit] [--behold-worktree]
//     --bolge-base <sha>  basegren-commit bølgen startet fra (for sjekken av funksjoner skrevet om av flere spor)
//     --uten-commit       løs og valider, men ikke commit (flettingen står igjen)
//     --behold-worktree   ikke rydd sporets worktree etter flettingen
// NB: bruk aldri String.replace med en erstatningstekst som kan inneholde «$» (mønstre som $& tolkes); bygg med slice.
// =============================================================

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { ryddWorktree } from './rydd-worktree.mjs';

const require = createRequire(import.meta.url);
const { konfig } = require('./lib/koKonfig.js');
const K = konfig();

const args = process.argv.slice(2);
const verdi = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const bolgeBase = verdi('--bolge-base');
const gren = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--bolge-base');
const UTEN_COMMIT = args.includes('--uten-commit');
const BEHOLD_WORKTREE = args.includes('--behold-worktree');
if (!gren) {
  console.error(
    'Bruk: node scripts/orkestrator/flett-spor.mjs <gren> [--bolge-base <sha>] [--uten-commit] [--behold-worktree]',
  );
  process.exit(2);
}

// Best-effort rydding av sporets worktree etter en vellykket fletting. Én logglinje; en feil her gjør ALDRI flettingen
// mislykket (exit forblir 0).
function ryddEtterFletting() {
  if (BEHOLD_WORKTREE) {
    console.log('Worktree: beholdt (--behold-worktree).');
    return;
  }
  try {
    const r = ryddWorktree(gren, { mot: 'HEAD' });
    console.log(`Worktree: ${r.status}: ${r.melding}`);
  } catch (e) {
    console.log(`Worktree: ryddingen feilet, flettingen står: ${e.message}`);
  }
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 << 20 });
const gitOk = (...a) => spawnSync('git', a, { encoding: 'utf8', maxBuffer: 256 << 20 });

// Identitetsvakt FØR fletting: flette-commits skal ha eierens ekte git-identitet. En testidentitet som er blitt
// liggende i repoets konfig (for eksempel fra en test av dette skriptet), ville ellers gått inn i alle flette-commits.
// Tester for dette skriptet skal bruke et midlertidig repo.
{
  const r = spawnSync('git', ['var', 'GIT_COMMITTER_IDENT'], { encoding: 'utf8' });
  const ident = (r.stdout || '').trim();
  if (r.status !== 0 || !ident || /@(example\.(com|org|net|invalid)|[^>\s]*\.invalid)>/i.test(ident)) {
    process.stderr.write(
      `Identitetsvakten stoppet flettingen: git-identiteten ser ut som en test eller mangler (${ident || 'ingen'}). ` +
        'Sett user.name og user.email først.\n',
    );
    process.exit(3);
  }
}

// Windows låser store filer et øyeblikk etter at git har skrevet dem (virusskanner eller filovervåker): skrivingen gir
// UNKNOWN/EBUSY/EPERM. Prøv igjen noen ganger med kort pause før vi gir opp.
function skrivMedNyForsok(fil, tekst) {
  for (let forsok = 1; ; forsok++) {
    try {
      fs.writeFileSync(fil, tekst);
      return;
    } catch (e) {
      if (forsok >= 10 || !['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * forsok);
    }
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flett-spor-'));

// ---- 1) Merge ------------------------------------------------------------------------
const naa = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
console.log(`Fletter ${gren} inn i ${naa} …`);
// Foreldet index etter `git commit -- <filer>` med pre-commit-hook: fila er lik HEAD i arbeidstreet, men
// indexen har en eldre versjon, og da nekter merge («local changes would be overwritten»). Rydd bare slike filer.
for (const f of git('diff', '--cached', '--name-only').split('\n').filter(Boolean)) {
  if (gitOk('diff', '--quiet', 'HEAD', '--', f).status === 0) {
    gitOk('reset', '-q', '--', f);
    console.log(`  ryddet foreldet index for ${f} (lik HEAD)`);
  }
}
const m = gitOk('merge', '--no-ff', '--no-edit', gren);
const konflikter = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
if (m.status !== 0 && !konflikter.length) {
  console.error(`git merge feilet uten konflikter:\n${m.stdout}${m.stderr}`);
  process.exit(1);
}
console.log(konflikter.length ? `Konflikter i ${konflikter.length} filer.` : 'Ingen konflikter.');

// ---- 2) Treveis-fletting per fil -------------------------------------------------------
const versjon = (n, fil) => {
  const r = gitOk('show', `:${n}:${fil}`);
  return r.status === 0 ? r.stdout : null;
};

// Endringer fra base til side som hunker: { a: startlinje (0-basert) i base, n: antall baselinjer, ny: [linjer] }.
function hunker(base, side, navn) {
  const fb = path.join(tmp, `${navn}.base`);
  const fside = path.join(tmp, `${navn}.side`);
  fs.writeFileSync(fb, base);
  fs.writeFileSync(fside, side);
  const r = spawnSync(
    'git',
    ['diff', '--no-index', '-U0', '--no-color', '--diff-algorithm=myers', fb, fside],
    {
      encoding: 'utf8',
      maxBuffer: 256 << 20,
    },
  );
  const ut = [];
  let cur = null;
  for (const l of r.stdout.split('\n')) {
    const h = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      const bStart = Number(h[1]);
      const bAnt = h[2] === undefined ? 1 : Number(h[2]);
      // Ved ren innsetting (bAnt = 0) peker bStart på linja FØR innsettingen.
      cur = { a: bAnt === 0 ? bStart : bStart - 1, n: bAnt, ny: [] };
      ut.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('+') && !l.startsWith('+++')) cur.ny.push(l.slice(1));
  }
  return ut;
}

// En linje som bare består av listeverdier ('a' eller 'a', 'b') og ikke slutter med komma.
const LIT = `('[^']*'|"[^"]*")`;
const LISTELINJE = new RegExp(`^\\s*${LIT}(\\s*,\\s*${LIT})*\\s*(--.*|//.*)?$`);
const SISTE_VERDI = new RegExp(`${LIT}(\\s*(--.*|//.*)?)$`);
const begynnerMedListeverdi = (l) => /^\s*['"]/.test(l);
// En tuppel-rad i en VALUES-liste: «('a', 'b')» uten komma til slutt (valgfri kommentar). Legger to spor til en rad
// sist i samme liste, kan flettingen ellers miste kommaet mellom tuplene.
// Kodedelen av linja: alt før en «--»/«//»-kommentar som står UTENFOR en streng. Da ser ikke en parentes i
// kommentaren («-- rad (2)») ut som slutten på en tuppel.
function kodeDel(l) {
  let iStreng = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (iStreng) {
      if (c === iStreng) iStreng = null;
    } else if (c === "'" || c === '"') iStreng = c;
    else if ((c === '-' || c === '/') && l[i + 1] === c) return l.slice(0, i);
  }
  return l;
}
const erTuppellinje = (l) => /^\s*\(.*\)\s*$/.test(kodeDel(l));
const begynnerMedTuppel = (l) => /^\s*\(/.test(l);

// Sett inn komma når blokk A slutter med listeverdier (eller en tuppel) uten komma og blokk B begynner med en ny.
function kommaMellom(a, b, fil) {
  if (!/\.(sql|js|mjs|ts|tsx)$/.test(fil)) return a;
  const erInnhold = (l) => l.trim() && !/^\s*(--|\/\/)/.test(l);
  let i = a.length - 1;
  while (i >= 0 && !erInnhold(a[i])) i--;
  const forsteB = b.find(erInnhold);
  if (i < 0 || forsteB === undefined) return a;
  const kopi = [...a];
  // Uten String.replace: bygg linja med slice, så «$» i innholdet aldri tolkes som et mønster.
  if (LISTELINJE.test(a[i]) && begynnerMedListeverdi(forsteB)) {
    const treff = kopi[i].match(SISTE_VERDI);
    const pos = treff.index + treff[1].length;
    kopi[i] = `${kopi[i].slice(0, pos)},${kopi[i].slice(pos)}`;
    return kopi;
  }
  if (erTuppellinje(a[i]) && begynnerMedTuppel(forsteB)) {
    const pos = kodeDel(kopi[i]).lastIndexOf(')') + 1;
    kopi[i] = `${kopi[i].slice(0, pos)},${kopi[i].slice(pos)}`;
    return kopi;
  }
  return a;
}

function flettTekst(fil, base, ours, theirs) {
  const bl = base.split('\n');
  const ho = hunker(base, ours, 'o');
  const ht = hunker(base, theirs, 't');
  const alle = [...ho.map((h) => ({ ...h, s: 'o' })), ...ht.map((h) => ({ ...h, s: 't' }))].sort(
    (x, y) => x.a - y.a || (x.s === 'o' ? -1 : 1),
  );
  const ut = [];
  let pos = 0;
  for (let i = 0; i < alle.length;) {
    const h = alle[i];
    const slutt = (x) => x.a + x.n;
    // Grupper hunker som overlapper (samme baseområde, eller innsetting på samme ankerpunkt).
    const gruppe = [h];
    let gSlutt = slutt(h);
    let j = i + 1;
    while (j < alle.length && (alle[j].a < gSlutt || (alle[j].a === h.a && alle[j].a === gSlutt))) {
      gruppe.push(alle[j]);
      gSlutt = Math.max(gSlutt, slutt(alle[j]));
      j++;
    }
    for (; pos < h.a; pos++) ut.push(bl[pos]);
    const fraO = gruppe.filter((x) => x.s === 'o');
    const fraT = gruppe.filter((x) => x.s === 't');
    if (!fraO.length || !fraT.length) {
      for (const x of gruppe) ut.push(...x.ny);
    } else if (
      fraO.length === 1 &&
      fraT.length === 1 &&
      fraO[0].a === fraT[0].a &&
      fraO[0].n === fraT[0].n
    ) {
      const o = fraO[0].ny;
      const t = fraT[0].ny;
      const n = fraO[0].n;
      if (o.join('\n') === t.join('\n')) ut.push(...o);
      else if (n === 0) {
        // Rene innsettinger på samme sted: HEAD sin blokk, så grenens. ALDRI felles prefiks her: begge kan begynne
        // med samme linje (for eksempel en avsluttende «}» som diffen har «rotert» inn i blokken), og den trengs to ganger.
        ut.push(...kommaMellom(o, t, fil), ...t);
      } else {
        // Samme baselinjer endret på begge sider: godtas bare når begge endret dem likt (for eksempel komma lagt til
        // på forrige element), og resten er innsettinger. Da tas de endrede linjene én gang, så resten fra hver side.
        if (o.slice(0, n).join('\n') !== t.slice(0, n).join('\n'))
          return { ok: false, grunn: `samme linjer endret ulikt (baselinje ${h.a + 1})` };
        const felles = o.slice(0, n);
        const oRest = o.slice(n);
        const tRest = t.slice(n);
        ut.push(...kommaMellom(felles.concat(oRest), tRest, fil), ...tRest);
      }
    } else {
      return { ok: false, grunn: `overlappende endringer rundt baselinje ${h.a + 1}` };
    }
    pos = gSlutt;
    i = j;
  }
  for (; pos < bl.length; pos++) ut.push(bl[pos]);
  return { ok: true, tekst: ut.join('\n') };
}

// Oversettelsesfiler: HEAD sin tekst (konfliktfri etter HEAD-siden), pluss toppnøkler grenen har lagt til, ordrett.
function flettI18n(base, ours, theirs, gjeldende) {
  const hoved = [];
  let modus = 'felles';
  for (const l of gjeldende.split('\n')) {
    if (/^<<<<<<< /.test(l)) {
      modus = 'ours';
      continue;
    }
    if (l === '=======' && modus === 'ours') {
      modus = 'theirs';
      continue;
    }
    if (/^>>>>>>> /.test(l)) {
      modus = 'felles';
      continue;
    }
    if (modus !== 'theirs') hoved.push(l);
  }
  let s = hoved.join('\n');
  let res;
  try {
    res = JSON.parse(s);
  } catch (e) {
    return { ok: false, grunn: `HEAD-siden parser ikke: ${e.message}` };
  }
  const B = JSON.parse(base);
  const O = JSON.parse(ours);
  const T = JSON.parse(theirs);
  const tl = theirs.split('\n');
  for (const k of Object.keys(T)) {
    if (k in res || k in B) continue;
    const start = tl.findIndex((l) => l.startsWith(`  ${JSON.stringify(k)}: `));
    if (start < 0) return { ok: false, grunn: `fant ikke toppnøkkel ${k} i grenen` };
    let slutt = start;
    if (tl[start].trim().endsWith('{')) {
      for (let i = start + 1; i < tl.length; i++)
        if (/^ {2}\},?$/.test(tl[i])) {
          slutt = i;
          break;
        }
    }
    let blokk = tl.slice(start, slutt + 1).join('\n');
    if (blokk.endsWith(',')) blokk = blokk.slice(0, -1);
    const siste = s.lastIndexOf('}');
    s = `${s.slice(0, siste).trimEnd()},\n${blokk}\n}\n`;
    res = JSON.parse(s);
  }
  // Treveis-kontroll: alt grenen la til, finnes; alt HEAD har, finnes med mindre grenen fjernet det fra basen.
  const mangler = [];
  const sjekkT = (a, b, bb, sti) => {
    for (const k of Object.keys(b)) {
      const ny = !bb || !(k in bb);
      if (!(k in a)) {
        if (ny) mangler.push(sti + k);
        continue;
      }
      if (b[k] && typeof b[k] === 'object') sjekkT(a[k], b[k], bb && bb[k], `${sti + k}.`);
    }
  };
  const sjekkO = (a, o, t, bb, sti) => {
    for (const k of Object.keys(o)) {
      const fjernet = bb && k in bb && !(t && k in t);
      if (!(k in a)) {
        if (!fjernet) mangler.push(sti + k);
        continue;
      }
      if (o[k] && typeof o[k] === 'object')
        sjekkO(a[k], o[k], t && t[k], bb && bb[k], `${sti + k}.`);
    }
  };
  sjekkT(res, T, B, '');
  sjekkO(res, O, T, B, '');
  if (mangler.length)
    return { ok: false, grunn: `nøkler mangler etter fletting: ${mangler.slice(0, 5).join(', ')}` };
  return { ok: true, tekst: s };
}

const loste = [];
const manuelle = [];
for (const fil of konflikter) {
  const base = versjon(1, fil);
  const ours = versjon(2, fil);
  const theirs = versjon(3, fil);
  if (base === null || ours === null || theirs === null) {
    manuelle.push(`${fil}: lagt til eller slettet på én side`);
    continue;
  }
  let r;
  if (/(^|\/)locales\/[A-Za-z_-]+\.json$/.test(fil))
    r = flettI18n(base, ours, theirs, fs.readFileSync(fil, 'utf8'));
  else if (fil.endsWith('.json')) r = { ok: false, grunn: 'JSON utenfor locales/ løses for hånd' };
  else r = flettTekst(fil, base, ours, theirs);
  if (!r.ok) {
    manuelle.push(`${fil}: ${r.grunn}`);
    continue;
  }
  skrivMedNyForsok(fil, r.tekst);
  loste.push(fil);
}

// ---- 3) Validering ---------------------------------------------------------------------
const feil = [];
const endrede = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
const sjekkes = [...new Set([...loste, ...endrede])].filter((f) => fs.existsSync(f));
// To identifikator-lignende listeverdier etter hverandre uten komma: SQL slår dem sammen til én streng, og
// begge forsvinner fra lista. Meldinger delt over flere linjer har mellomrom inne i strengen og er
// bevisste sammenslåinger; de flagges ikke.
const IDENT = `'[A-Za-z0-9_.:/-]+'`;
const identLinje = new RegExp(`^\\s*${IDENT}(\\s*,\\s*${IDENT})*\\s*(--.*)?$`);
const identStart = new RegExp(`^\\s*${IDENT}`);
for (const f of sjekkes) {
  const t = fs.readFileSync(f, 'utf8');
  if (/^(<<<<<<<|>>>>>>>) /m.test(t) || /^=======$/m.test(t)) feil.push(`${f}: konfliktmarkører`);
  if (f.endsWith('.json')) {
    try {
      JSON.parse(t);
    } catch (e) {
      feil.push(`${f}: JSON parser ikke (${e.message})`);
    }
  }
  if (/\.(js|mjs|cjs)$/.test(f)) {
    const r = spawnSync('node', ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) feil.push(`${f}: node --check feilet`);
  }
  if (loste.includes(f) && f.endsWith('.sql')) {
    const L = t.split('\n');
    for (let i = 0; i < L.length; i++) {
      if (!identLinje.test(L[i])) continue;
      let j = i + 1;
      while (j < L.length && /^\s*(--|$)/.test(L[j])) j++;
      if (j < L.length && identStart.test(L[j]))
        feil.push(`${f}:${i + 1}: listeverdi uten komma foran ny verdi på linje ${j + 1}`);
    }
    // Samme feil for tuppel-rader i en VALUES-liste («('a', 'b')» fulgt av en ny «(»-rad): gir syntaksfeil, og den
    // oppdages først når SQL-en faktisk kjøres.
    for (let i = 0; i < L.length; i++) {
      if (!erTuppellinje(L[i]) || !/^\s*\('/.test(L[i])) continue;
      let j = i + 1;
      while (j < L.length && /^\s*(--|$)/.test(L[j])) j++;
      if (j < L.length && /^\s*\('/.test(L[j]))
        feil.push(`${f}:${i + 1}: tuppel uten komma foran ny tuppel på linje ${j + 1}`);
    }
  }
}
// ---- 4) Funksjoner skrevet om av flere spor i bølgen ---------------------------------------
const overlapp = [];
const migMappe = K.migrasjoner?.mappe;
if (bolgeBase && migMappe) {
  const fnIFiler = (ref, filer) => {
    const navn = new Map();
    for (const f of filer) {
      const r = gitOk('show', `${ref}:${f}`);
      if (r.status !== 0) continue;
      for (const x of r.stdout.matchAll(
        /create\s+or\s+replace\s+function\s+(?:public\.)?([a-z_0-9]+)/gi,
      ))
        navn.set(x[1].toLowerCase(), f);
    }
    return navn;
  };
  const grenFiler = git(
    'diff',
    '--name-only',
    `${bolgeBase}...${gren}`,
    '--',
    migMappe,
  )
    .split('\n')
    .filter(Boolean);
  const andreFiler = git('diff', '--name-only', bolgeBase, 'HEAD', '--', migMappe)
    .split('\n')
    .filter((f) => f && !grenFiler.includes(f));
  const g = fnIFiler(gren, grenFiler);
  const a = fnIFiler('HEAD', andreFiler);
  for (const [fn, f] of g)
    if (a.has(fn)) overlapp.push(`${fn}: ${path.basename(f)} og ${path.basename(a.get(fn))}`);
}

// ---- 5) Resultat og commit --------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
if (loste.length) console.log(`Løst automatisk: ${loste.join(', ')}`);
if (overlapp.length) {
  console.log(
    'ADVARSEL: SQL-funksjoner skrevet om helt av flere spor i bølgen (den med høyest nummer vinner):',
  );
  for (const o of overlapp) console.log(`  ${o}`);
}
if (manuelle.length || feil.length) {
  console.log('\nMÅ LØSES FOR HÅND (flettingen står igjen; git merge --abort angrer):');
  for (const x of [...manuelle, ...feil]) console.log(`  ${x}`);
  process.exit(1);
}
if (UTEN_COMMIT) {
  console.log('\nAlt løst og validert. Ikke committet (--uten-commit).');
  process.exit(0);
}
if (loste.length) git('add', '--', ...loste);
// Uten konflikter har git merge allerede committet selv (ingen MERGE_HEAD). Da er det ingenting å committe.
const mergePagar = gitOk('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
if (!mergePagar) {
  console.log(`\nFlettet og committet av git merge: ${git('log', '--oneline', '-1').trim()}`);
  ryddEtterFletting();
  process.exit(0);
}
const c = gitOk('commit', '--no-edit');
if (c.status !== 0 && !/nothing to commit/.test(`${c.stdout}${c.stderr}`)) {
  console.error(`commit feilet:\n${c.stdout}${c.stderr}`);
  process.exit(1);
}
console.log(`\nFlettet og committet: ${git('log', '--oneline', '-1').trim()}`);
ryddEtterFletting();
process.exit(0);
