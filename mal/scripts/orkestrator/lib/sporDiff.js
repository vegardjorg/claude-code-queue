// =============================================================
// scripts/orkestrator/lib/sporDiff.js: hvilke filer en flettet spor-gren selv endret.
//
// HVORFOR: noen gater vil vite hvilke filer sporet har endret (f.eks. for å kjøre bare de berørte testene, eller for
// å skille en feil sporet har innført fra en feil som allerede fantes i basen). I et spor-worktree er det enkelt:
// base...HEAD pluss arbeidstreet. Men når `ko.mjs flett` kjører gatene på basegrenen ETTER flettingen, er HEAD lik
// base og lista tom, så gatene ville tro at sporet ikke endret noe.
//
// SLIK: flettesteget husker grenens skillepunkt (merge-base mot basegrenen FØR flettingen) og grenens tupp, og sender
// dem til gatene som `--spor-base <sha> --spor-tupp <sha>`. Grenens egne endringer er da diffen skille...tupp. Vi
// bruker tuppen og ikke HEAD, fordi skille..HEAD på basegrenen også tar med andre spor som er flettet etter skillet;
// de skal ikke regnes som dette sporets.
// =============================================================
'use strict';

/**
 * Argumentene flettesteget gir gatene. Tomt når noe mangler (da ser gatene bare på `endrede`, som før).
 * @param {{ skille?: string | null, tupp?: string | null }} k
 * @returns {string[]}
 */
function sporArgs({ skille, tupp }) {
  if (!skille || !tupp) return [];
  return ['--spor-base', skille, '--spor-tupp', tupp];
}

/**
 * Filene sporet har endret.
 * Uten `sporBase`: `endrede` (base...HEAD + arbeidstreet, slik gatene ser det i et spor-worktree).
 * Med `sporBase`: grenens egen diff sporBase...sporTupp (HEAD når tuppen mangler), pluss `endrede` (arbeidstreet hos
 * orkestratoren), uten duplikater.
 * @param {{ git: (...args: string[]) => string | null, sporBase?: string | null, sporTupp?: string | null,
 *   endrede: string[] }} k  `git` gir stdout, eller null når kommandoen feilet
 * @returns {string[] | null} null når diffen ikke kunne leses (kalleren stopper da i stedet for å gjette)
 */
function sporetsEndredeFiler({ git, sporBase, sporTupp, endrede }) {
  if (!sporBase) return [...endrede];
  const ut = git('diff', '--name-only', `${sporBase}...${sporTupp || 'HEAD'}`);
  if (ut == null) return null;
  const filer = ut
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...filer, ...endrede])];
}

module.exports = { sporArgs, sporetsEndredeFiler };
