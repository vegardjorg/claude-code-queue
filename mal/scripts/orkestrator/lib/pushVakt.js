// =============================================================
// pushVakt.js: ren logikk for PreToolUse-hooken hook-push-vakt.mjs.
//
// HVORFOR: noen få kommandoer er dyre eller irreversible (push som skriver om delt historikk, push til feil gren,
// migrasjoner mot feil miljø). En hook ser kommandoen FØR den kjører og kan stoppe den med en grunn, i stedet for
// at regelen bare står som tekst agentene kan glemme. Vanlig arbeid blokkeres ikke.
//
// Beslutninger (Claude Code PreToolUse: allow | ask | deny):
//   deny  tvungen push (--force, -f, --force-with-lease, +ref), uansett gren: historikk skrives aldri om.
//   deny  `git push` til en annen gren enn basegrenen (konfig().baseGren), og --all/--mirror. Sporene fletter
//         lokalt; bare basegrenen pushes (i batch).
//   ask   `git push` der grenen ikke kan avgjøres (løs HEAD).
//   deny  migrasjonskommandoen (konfig().migrasjoner.pushKommando) når miljøfila (migrasjoner.miljoFil) finnes og
//         innholdet ikke står i migrasjoner.tillatteMiljo. Mangler fila, har vakta ingen mening.
// Push til basegrenen slippes gjennom. Regelen om å pushe i batcher (ikke per commit) er dokumentasjon
// (docs/orchestration.md), ikke en blokk.
//
// vurder() er ren: tar kommandoen og konteksten (gjeldende gren, innholdet i miljøfila) og gjør ingen I/O.
// Basegren og migrasjonsoppsett hentes fra konfig() bare når konteksten ikke gir dem.
// =============================================================

const fs = require('node:fs');
const path = require('node:path');

/** Del en skallkommando i deler på ; && || | og linjeskift (godt nok for vakt; ikke en full parser). */
function deler(kommando) {
  return String(kommando || '')
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((d) => d.trim())
    .filter(Boolean);
}

/** Enkle tokens: mellomrom-splitt, fjern omsluttende anførselstegn. */
function tokens(del) {
  return (del.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^(["'])(.*)\1$/, '$2'));
}

/**
 * Finn git-underkommandoen i en tokenliste, hopp over globale valg (-C <sti>, -c k=v, --no-pager …).
 * Returnerer { sub, args } eller null.
 */
function gitKall(t) {
  // Tillat prefiks som env-variabler (FOO=bar git push) og «command»/«exec».
  let i = 0;
  while (
    i < t.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]) || ['command', 'exec', 'env'].includes(t[i]))
  )
    i++;
  if (!/(^|[\\/])git(\.exe)?$/.test(t[i] || '')) return null;
  i++;
  while (i < t.length && t[i].startsWith('-')) {
    if (t[i] === '-C' || t[i] === '-c' || t[i] === '--git-dir' || t[i] === '--work-tree') i += 2;
    else i++;
  }
  if (i >= t.length) return null;
  return { sub: t[i], args: t.slice(i + 1) };
}

/**
 * Hvilke grener treffer en `git push` med disse argumentene?
 * Returnerer { mal: [gren], tvang, alle } (alle = --all/--mirror, altså alle grener).
 */
function pushMal(args, gjeldendeGren) {
  let tvang = false;
  let alle = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (
      a === '--force' ||
      a === '-f' ||
      a.startsWith('--force-with-lease') ||
      a === '--force-if-includes'
    )
      tvang = true;
    else if (a === '--all' || a === '--mirror') alle = true;
    else if (a === '-o' || a === '--push-option' || a === '--repo' || a === '--receive-pack') i++;
    else if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))
      tvang = true; // f.eks. -uf
    else if (!a.startsWith('-')) pos.push(a);
  }
  const refspecs = pos.slice(1); // første posisjonelle er remote
  if (alle) return { mal: [], tvang, alle };
  if (refspecs.length === 0)
    return { mal: gjeldendeGren ? [gjeldendeGren] : ['<ukjent>'], tvang, alle };
  const mal = refspecs.map((r) => {
    let x = r;
    if (x.startsWith('+')) {
      tvang = true;
      x = x.slice(1);
    }
    const dst = x.includes(':') ? x.split(':').pop() : x;
    const navn = dst.replace(/^refs\/heads\//, '');
    return navn === 'HEAD' || navn === '' ? gjeldendeGren || '<ukjent>' : navn;
  });
  return { mal, tvang, alle };
}

/** Programmer som bare starter et annet program (npx foo, npm exec foo): hoppes over når kommandoer sammenlignes. */
const STARTERE = new Set(['npx', 'pnpx', 'bunx', 'exec', 'env', 'command', 'npm', 'pnpm', 'yarn']);

/**
 * Kjernen i en kommando: ordene som ikke er valg, uten startere og env-prefiks foran.
 * «npx dbverktoy migrate push --yes» gir ['dbverktoy', 'migrate', 'push'].
 */
function kjerne(t) {
  const ut = [];
  for (const x of t) {
    if (x.startsWith('-')) continue;
    if (ut.length === 0 && (STARTERE.has(x) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(x))) continue;
    ut.push(x.replace(/\.(exe|cmd)$/i, '').replace(/^.*[\\/]/, ''));
  }
  return ut;
}

/** Er `kandidat` (tokenliste) en kjøring av `kommando` (tekst)? Kjerneordene må stå sammenhengende. */
function erKommando(kandidat, kommando) {
  const k = kjerne(tokens(String(kommando || '')));
  if (k.length === 0) return false;
  const c = kjerne(kandidat);
  for (let i = 0; i + k.length <= c.length; i++) {
    if (k.every((ord, j) => c[i + j] === ord)) return true;
  }
  return false;
}

/** Konfigverdiene vakta trenger, fra konteksten eller (som standard) fra konfig(). */
function verdier(kontekst) {
  let k = null;
  const hent = () => {
    if (!k) k = require('./koKonfig.js').konfig();
    return k;
  };
  const baseGren = kontekst.baseGren ?? hent().baseGren;
  const migrasjoner = kontekst.migrasjoner ?? hent().migrasjoner ?? {};
  return { baseGren, migrasjoner };
}

/**
 * Vurder én kommando.
 * kontekst: {
 *   gren: string|null            gjeldende gren,
 *   miljo: string|null           innholdet i migrasjoner.miljoFil (trimmet), null når fila ikke finnes,
 *   baseGren?: string            standard konfig().baseGren,
 *   migrasjoner?: { pushKommando, miljoFil, tillatteMiljo }   standard konfig().migrasjoner,
 * }
 * Returnerer null (ingen mening) eller { beslutning: 'ask'|'deny', grunn }.
 * Ved flere treff vinner den strengeste (deny over ask).
 */
function vurder(kommando, kontekst = {}) {
  const { baseGren, migrasjoner } = verdier(kontekst);
  const funn = [];
  for (const del of deler(kommando)) {
    const t = tokens(del);

    const g = gitKall(t);
    if (g && g.sub === 'push') {
      const { mal, tvang, alle } = pushMal(g.args, kontekst.gren || null);
      if (tvang) {
        funn.push({
          beslutning: 'deny',
          grunn:
            'Tvungen push er forbudt: delt historikk skrives aldri om. Flett i stedet, og push vanlig.',
        });
      } else if (alle) {
        funn.push({
          beslutning: 'deny',
          grunn: `\`git push --all/--mirror\` pusher alle grener. Bare basegrenen (${baseGren}) pushes.`,
        });
      } else {
        const andre = mal.filter((m) => m !== baseGren && m !== '<ukjent>');
        if (andre.length > 0) {
          funn.push({
            beslutning: 'deny',
            grunn: `Push av ${andre.join(', ')} er blokkert: bare basegrenen (${baseGren}) pushes, og den i batch. Sporgrener flettes lokalt.`,
          });
        } else if (mal.includes('<ukjent>')) {
          funn.push({
            beslutning: 'ask',
            grunn: `Kunne ikke avgjøre hvilken gren som pushes. Bekreft at det er basegrenen (${baseGren}).`,
          });
        }
      }
    }

    if (
      migrasjoner.pushKommando &&
      migrasjoner.miljoFil &&
      erKommando(t, migrasjoner.pushKommando)
    ) {
      const miljo = kontekst.miljo;
      const tillatte = Array.isArray(migrasjoner.tillatteMiljo) ? migrasjoner.tillatteMiljo : [];
      if (miljo !== null && miljo !== undefined && !tillatte.includes(miljo)) {
        funn.push({
          beslutning: 'deny',
          grunn:
            `Migrasjonspush mot «${miljo}» er blokkert: ${migrasjoner.miljoFil} peker på et miljø som ikke står i ` +
            `migrasjoner.tillatteMiljo (${tillatte.length ? tillatte.join(', ') : 'tom liste'}). Koble til riktig miljø først.`,
        });
      }
    }
  }
  if (funn.length === 0) return null;
  return funn.find((f) => f.beslutning === 'deny') || funn[0];
}

/**
 * Leser miljøfila (migrasjoner.miljoFil, relativt til rota). Prøver `roter` i rekkefølge (worktreet først,
 * så hovedtreet, siden fila ofte er gitignorert og bare ligger i hovedtreet). Gir trimmet innhold eller null.
 * @param {string[]} roter
 * @param {string|null} miljoFil
 */
function lesMiljo(roter, miljoFil) {
  if (!miljoFil) return null;
  for (const rot of roter.filter(Boolean)) {
    try {
      return fs.readFileSync(path.resolve(rot, miljoFil), 'utf8').trim();
    } catch {
      // finnes ikke her; prøv neste
    }
  }
  return null;
}

module.exports = { vurder, lesMiljo, erKommando };
