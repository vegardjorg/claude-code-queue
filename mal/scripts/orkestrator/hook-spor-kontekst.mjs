#!/usr/bin/env node
// =============================================================
// hook-spor-kontekst.mjs: PostToolUse-hook, kontekstvakt for køens spor-agenter. Se docs/orchestration.md.
//
// Hvorfor: en stor del av sporkostnaden påløper når sporets kontekst er stor, og «lever DELVIS ved ca. 300k» var bare
// en regel i oppdraget. hook-kontekst.mjs (UserPromptSubmit) dekker bare hovedøktene; subagenter får ingen
// brukermeldinger, så vakten må sitte på verktøykallene.
//
// Slik virker den:
//   - Gjør bare noe når hook-input har `agent_type` lik `spor` eller `spor-d` (feltet finnes bare når hooken fyrer
//     inne i en subagent; i hovedøkta mangler det, og da avslutter hooken straks).
//   - Leser siste `usage` i SUBAGENTENS transkript (lib/sporVakt.js, samme lesing som hook-kontekst.mjs).
//   - Ved terskelen (280k, overstyr med SPOR_KONTEKST_VARSEL) legges én beskjed ved som additionalContext:
//     fullfør steget, commit, skriv overlevering.md og lever DELVIS. Én gang per terskel per agent: tilstanden
//     ligger i <Temp>/ko-spor-kontekstvakt/<agent_id>.json (overstyr mappa med SPOR_KONTEKST_TILSTAND).
//   - Hver utløsning logges som én linje i tidsloggen (konfig().tidslogg, hendelse «kontekstvakt»; KO_TIDSLOGG
//     overstyrer fila, som i hook-tid.mjs).
//   - Ved ca. 200k (SPOR_RAPPORT_VARSEL overstyrer) kommer én påminnelse om at det lange skal i rapport.md og svaret
//     under rapporttaket (lesehint.js, vurderRapportHint). Markøren «rapport» i samme tilstandsfil hindrer
//     gjentakelse; påminnelsen logges ikke i tidsloggen.
//   - Et Bash-/PowerShell-resultat over ca. 15 000 tegn (SPOR_BASH_VARSEL overstyrer) gir et mykt utskriftshint
//     (| head, grep -m, sed -n 'a,bp'; lesehint.js, vurderBashHint). Høyst BASH_HINT_MAKS per agent: hvert hint
//     legger markøren «bash» i tilstandsfila. Trenger ikke transkriptet. Effekten måles med kontekst-maal.mjs.
//   - En kost-terskel per klasse er IKKE med: klassen (K/U, D/D+) kan ikke leses av agenttypen uten gjetting
//     (spor = K eller U, spor-d = D eller D+).
// Feiler ÅPENT: enhver intern feil gir ingen utskrift og exit 0.
// Røyktest: echo '{"agent_type":"spor","agent_id":"x","transcript_path":"<fil>"}' | node scripts/orkestrator/hook-spor-kontekst.mjs
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('./lib/sporVakt.js');
const H = require('./lesehint.js');
const { dataMappe, tidslogg } = require('./lib/koKonfig.js');

const vakt = setTimeout(() => process.exit(0), 8000);
vakt.unref();

const TERSKEL = Number(process.env.SPOR_KONTEKST_VARSEL) || V.SPOR_TERSKEL;
const RAPPORT_TERSKEL = Number(process.env.SPOR_RAPPORT_VARSEL) || H.RAPPORT_TERSKEL;
const RAPPORT_NOKKEL = 'rapport'; // markøren i utlost-lista for rapportpåminnelsen
const BASH_TERSKEL = Number(process.env.SPOR_BASH_VARSEL) || H.BASH_TERSKEL;
const BASH_NOKKEL = 'bash'; // én markør per gitt utskriftshint
const TILSTAND =
  process.env.SPOR_KONTEKST_TILSTAND || path.join(os.tmpdir(), 'ko-spor-kontekstvakt');

async function lesInn() {
  let s = '';
  for await (const del of process.stdin) s += del;
  return JSON.parse(s || '{}');
}

const tilstandFil = (id) => path.join(TILSTAND, `${String(id).replace(/[^\w.-]/g, '_')}.json`);

function lesUtlost(id) {
  try {
    const o = JSON.parse(fs.readFileSync(tilstandFil(id), 'utf8'));
    return Array.isArray(o.utlost) ? o.utlost : [];
  } catch {
    return [];
  }
}

async function main() {
  const inn = await lesInn();
  const agentType = inn.agent_type;
  if (!agentType || !V.KONTEKST_TYPER.has(agentType) || !inn.agent_id) return; // hovedøkta: ingen effekt
  const utlost = lesUtlost(inn.agent_id);
  const rapportSagt = utlost.includes(RAPPORT_NOKKEL);
  // Utskriftshint for store Bash-/PowerShell-resultat (lesehint.js). Leser bare hook-input.
  const bashHint = H.vurderBashHint({
    agentType,
    verktoy: inn.tool_name,
    kommando: inn.tool_input?.command,
    lengde: H.utskriftLengde(inn.tool_response),
    gitt: utlost.filter((x) => x === BASH_NOKKEL).length,
    terskel: BASH_TERSKEL,
  });
  let svar = null;
  let rapportHint = null;
  let kontekst = null;
  let tp = null;
  // Alt om konteksten er sagt: spar transkript-lesingen.
  if (!(utlost.includes(TERSKEL) && rapportSagt)) {
    tp = V.subagentTranskript(inn);
    if (tp) {
      kontekst = V.sisteKontekst(V.lesHale(tp));
      svar = V.vurderKontekst({ agentType, kontekst, terskel: TERSKEL, utlost });
      // Én påminnelse om rapporttaket ved ca. 200k (lesehint.js), uavhengig av kontekstvakten.
      rapportHint = H.vurderRapportHint({
        agentType,
        kontekst,
        sagt: rapportSagt,
        terskel: RAPPORT_TERSKEL,
      });
    }
  }
  if (!svar && !rapportHint && !bashHint) return;

  // Husk utløsningen FØR beskjeden skrives, så en feil i loggingen aldri gir gjentatte beskjeder.
  const nyeUtlost = [...utlost];
  if (bashHint) nyeUtlost.push(BASH_NOKKEL);
  if (rapportHint) nyeUtlost.push(RAPPORT_NOKKEL);
  if (svar) nyeUtlost.push(svar.terskel);
  fs.mkdirSync(TILSTAND, { recursive: true });
  fs.writeFileSync(
    tilstandFil(inn.agent_id),
    JSON.stringify({ agent_id: inn.agent_id, utlost: nyeUtlost }),
  );
  const hint = [bashHint, rapportHint].filter(Boolean).join('\n');
  if (!svar) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hint },
      }),
    );
    return;
  }

  try {
    let bolge = 'ukjent';
    try {
      bolge =
        fs
          .readFileSync(path.join(dataMappe(), 'bolge-aktiv'), 'utf8')
          .split(/\r?\n/)[0]
          .trim() || bolge;
    } catch {
      // ingen aktiv bølge satt
    }
    let spor = null;
    try {
      spor = require('./lib/tidKost.js').sporFraTekst(V.lesHode(tp));
    } catch {
      spor = null;
    }
    const logg = tidslogg();
    fs.mkdirSync(path.dirname(logg), { recursive: true });
    fs.appendFileSync(
      logg,
      JSON.stringify({
        tid: new Date().toISOString(),
        bolge,
        spor: spor ?? String(inn.agent_id).slice(0, 12),
        hendelse: 'kontekstvakt',
        agent_id: inn.agent_id,
        agent_type: agentType,
        kontekst,
        terskel: svar.terskel,
        merknad: `kontekstvakt ved ca. ${Math.round(kontekst / 1000)}k (terskel ${Math.round(svar.terskel / 1000)}k)`,
      }) + '\n',
    );
  } catch {
    // error-ignorert: loggen er bare for måling; beskjeden til agenten er det viktige
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: hint ? `${hint}\n${svar.melding}` : svar.melding,
      },
    }),
  );
}

main()
  // Ingen process.exit her: stdout skal tømmes før prosessen avslutter (vakt-timeren er unref).
  .catch(() => undefined); // error-ignorert: vakten feiler åpent og skal aldri stoppe en agent
