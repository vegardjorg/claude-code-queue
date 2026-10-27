#!/usr/bin/env node
// =============================================================
// hook-lesevakt.mjs: PreToolUse-hook (matcher Read), lesevakt for spor- og review-agentene.
// Se docs/orchestration.md.
//
// Hvorfor: filer som lastes automatisk (CLAUDE.md, minnet) blir likevel lest med Read, og store filer leses hele i
// stedet for i utdrag. Lesehygienen står i oppdraget, men en hook er deterministisk.
//
// Slik virker den (reglene står i lib/sporVakt.js, vurderLesing; prosjektet utvider dem med konfig().lesevakt):
//   - Bare for agenttypene i lesevakta (spor, spor-d, reviewer, reviewer-sikkerhet + lesevakt.agentTyper). Feltet
//     agent_type mangler i hovedøkta: ingen effekt der.
//   - Avviser Read uten offset/limit av filer som lastes automatisk (CLAUDE.md, MEMORY.md + lesevakt.autoLastet).
//   - Avviser Read uten limit av en fil i lesevakt.storeFiler (og migrasjoner.mappe/*.sql) over 300 linjer (overstyr
//     med LESEVAKT_MAKS_LINJER eller lesevakt.maksLinjer), og av enhver tekstfil over lesevakt.blokkLinjer (2000).
//     Avvisningen forteller agenten hva den skal gjøre i stedet (Grep, så offset og limit).
//   - For spor og spor-d gir en Read som slippes gjennom et MYKT lesehint (additionalContext, aldri blokk) når en fil
//     over ca. 300 linjer leses hel (LESEHINT_MAKS_LINJER), eller samme fil leses hel for andre gang. Logikken står i
//     lesehint.js; tilstanden i <Temp>/ko-lesehint/<agent_id>.json (LESEHINT_TILSTAND overstyrer).
// Feiler ÅPENT: enhver intern feil gir ingen utskrift og exit 0.
// Røyktest: echo '{"agent_type":"spor","tool_input":{"file_path":"CLAUDE.md"}}' | node scripts/orkestrator/hook-lesevakt.mjs
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('./lib/sporVakt.js');
const H = require('./lesehint.js');

const vakt = setTimeout(() => process.exit(0), 5000);
vakt.unref();

const MAKS = Number(process.env.LESEVAKT_MAKS_LINJER) || undefined;
const HINT_LINJER = Number(process.env.LESEHINT_MAKS_LINJER) || H.HINT_LINJER;
const HINT_TILSTAND = process.env.LESEHINT_TILSTAND || path.join(os.tmpdir(), 'ko-lesehint');
/** Filer større enn dette telles ikke (vakten slipper dem gjennom; Read kutter dem uansett). */
const MAKS_BYTES_TELLING = 50 * 1024 * 1024;

async function lesInn() {
  let s = '';
  for await (const del of process.stdin) s += del;
  return JSON.parse(s || '{}');
}

/** Antall linjer i fila, eller null når den ikke kan leses (da slipper vakten lesingen gjennom). */
function tellLinjer(fil) {
  try {
    if (fs.statSync(fil).size > MAKS_BYTES_TELLING) return null;
    const t = fs.readFileSync(fil, 'utf8');
    let n = 1;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
    return n;
  } catch {
    return null;
  }
}

const hintFil = (id) => path.join(HINT_TILSTAND, `${String(id).replace(/[^\w.-]/g, '_')}.json`);

/**
 * Mykt lesehint (aldri blokk) for en Read som slippes gjennom: hel fil over ca. 300 linjer, eller samme fil hel for
 * andre gang. Filene agenten har lest hele, huskes i <Temp>/ko-lesehint/<agent_id>.json.
 */
function lesehint(inn, agentType, abs, ti, antallLinjer) {
  if (!inn.agent_id || !H.SPOR_TYPER.has(agentType)) return;
  let lestHele = [];
  try {
    const o = JSON.parse(fs.readFileSync(hintFil(inn.agent_id), 'utf8'));
    if (Array.isArray(o.lestHele)) lestHele = o.lestHele;
  } catch {
    // ingen tilstand ennå
  }
  const r = H.vurderLeseHint({
    agentType,
    filsti: abs,
    offset: ti.offset,
    limit: ti.limit,
    antallLinjer,
    lestHele,
    maksLinjer: HINT_LINJER,
  });
  if (!r) return;
  if (r.nokkel) {
    fs.mkdirSync(HINT_TILSTAND, { recursive: true });
    fs.writeFileSync(
      hintFil(inn.agent_id),
      JSON.stringify({ agent_id: inn.agent_id, lestHele: [...lestHele, r.nokkel] }),
    );
  }
  if (!r.hint) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: r.hint },
    }),
  );
}

async function main() {
  const inn = await lesInn();
  const agentType = inn.agent_type;
  if (!agentType) return; // hovedøkta: ingen effekt
  const regler = V.lesRegler();
  if (!regler.typer.has(agentType)) return;
  const ti = inn.tool_input || {};
  const filsti = typeof ti.file_path === 'string' ? ti.file_path : '';
  if (!filsti) return;
  const abs = path.isAbsolute(filsti) ? filsti : path.resolve(inn.cwd || process.cwd(), filsti);
  // Linjetallet trengs når limit mangler (store filer, blokkgrensen og lesehintet).
  const antallLinjer = ti.limit == null ? tellLinjer(abs) : null;
  const svar = V.vurderLesing({
    agentType,
    filsti: abs,
    offset: ti.offset,
    limit: ti.limit,
    antallLinjer,
    maksLinjer: MAKS,
    regler,
  });
  if (!svar) {
    lesehint(inn, agentType, abs, ti, antallLinjer);
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: svar.grunn,
      },
    }),
  );
}

main()
  // Ingen process.exit her: stdout skal tømmes før prosessen avslutter (vakt-timeren er unref).
  .catch(() => undefined); // error-ignorert: vakten feiler åpent og skal aldri stoppe en agent
