#!/usr/bin/env node
// =============================================================
// hook-tid.mjs: automatisk tidslogg for agenter. Se docs/orchestration.md.
//
// Kalles av Claude Code-hooks i .claude/settings.json (SubagentStart og SubagentStop). Leser hook-JSON fra stdin og
// skriver én linje til tidsloggen (konfig().tidslogg i hovedtreet, standard scripts/.ko/tider.jsonl; KO_TIDSLOGG
// overstyrer) i logg-tid.mjs-formatet:
//   start:  { tid, bolge, spor, hendelse: "start", agent_id, agent_type }
//   ferdig: { ..., hendelse: "ferdig", kumulativ: true, varighet_s, verktoykall, modellturer, modell, cache_utlop,
//             kost_usd, tokens { input, output, cache_lest, cache_skrevet, cache_skrevet_5m, cache_skrevet_1t },
//             kontekst {...}, forste_endring_s, kall_for_forste_endring, merknad }
// Tallene for «ferdig» regnes ut fra agentens transkript (agent_transcript_path) i lib/tidKost.js.
//
// ALLE AGENTTYPER: skriptet logger enhver agenttype det kalles for (spor, reviewer, general-purpose …); agent_type
// står i raden. Hvilke typer som faktisk logges, styres av `matcher` i .claude/settings.json (`"*"` eller uten
// matcher for alle typer).
//
// KUMULATIVE RADER: en agent som gjenopptas (SendMessage), stopper flere ganger og får en «ferdig»-rad per stopp, hver
// med HELE transkriptet. Radene skal derfor aldri summeres rått: bruk `logg-tid.mjs --vis/--kost`, som dedupliserer
// per agent_id (lib/tidKost.js).
//
// Bølge: første linje i <datamappe>/bolge-aktiv (orkestratoren kan skrive en bølge-id dit ved bølgestart; fila er
// gitignorert sammen med datamappa). Mangler den, blir bølgen «ukjent».
// Spor: hentes fra oppdraget i transkriptet (`prompt-<ID>.md`, reviewerens `rev-<ID>\reviewer-<type>.md` eller
// «spor <ID>»); ellers agent-id-en. Start-raden får oppgave-id-en når transkriptet alt har oppdraget; da gir den første
// reviewer-starten `t_review` i oppgaven (ko.mjs flett, tidKost.forsteReviewStart).
//
// Hooken skal ALDRI blokkere eller forsinke agenten: alt er pakket i try/catch, den avslutter alltid med exit 0
// (exit 2 ville stoppet agenten), og en vakt avslutter etter 20 s uansett.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('./lib/tidKost.js');
const { dataMappe, tidslogg } = require('./lib/koKonfig.js');

const vakt = setTimeout(() => process.exit(0), 20000);
vakt.unref();

const MAKS_TRANSKRIPT = 300 * 1024 * 1024; // hopper over statistikk for enorme transkript

function lesStdin() {
  return new Promise((resolve) => {
    let data = '';
    const ferdig = () => resolve(data);
    const t = setTimeout(ferdig, 5000);
    t.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      ferdig();
    });
    process.stdin.on('error', ferdig);
  });
}

/** Regner ut forbruk fra et transkript (JSONL). Logikken ligger i lib/tidKost.js (testet). */
export const analyser = T.analyserTranskript;

async function main() {
  // Manuell analyse av et transkript (for kontroll): node hook-tid.mjs --analyser <fil>
  const i = process.argv.indexOf('--analyser');
  if (i >= 0) {
    console.log(JSON.stringify(analyser(fs.readFileSync(process.argv[i + 1], 'utf8')), null, 1));
    return;
  }
  const inn = JSON.parse((await lesStdin()) || '{}');
  const hendelse =
    inn.hook_event_name === 'SubagentStart'
      ? 'start'
      : inn.hook_event_name === 'SubagentStop'
        ? 'ferdig'
        : null;
  if (!hendelse) return;
  // KO_TIDSLOGG overstyrer loggfila (tester), som i logg-tid.mjs og ko.mjs (tidslogg() leser den).
  const logg = tidslogg();
  fs.mkdirSync(path.dirname(logg), { recursive: true });
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
  // Ved «ferdig»: bruk bølgen agenten STARTET i (fra start-raden med samme agent_id). Med kontinuerlig kø kan
  // bolge-aktiv ha skiftet mens agenten kjørte, og da ville ferdig-raden havnet i feil bølge.
  if (hendelse === 'ferdig' && inn.agent_id) {
    try {
      const rader = fs.readFileSync(logg, 'utf8').split('\n');
      for (let i = rader.length - 1; i >= 0; i--) {
        if (!rader[i].includes(inn.agent_id)) continue;
        const r = JSON.parse(rader[i]);
        if (r.agent_id === inn.agent_id && r.hendelse === 'start' && r.bolge) {
          bolge = r.bolge;
          break;
        }
      }
    } catch {
      // ingen logg ennå: behold bolge-aktiv
    }
  }
  let stat = null;
  const tp = inn.agent_transcript_path;
  try {
    if (tp && fs.existsSync(tp) && fs.statSync(tp).size <= MAKS_TRANSKRIPT) {
      stat = analyser(fs.readFileSync(tp, 'utf8'));
    }
  } catch {
    stat = null;
  }
  const kortId = String(inn.agent_id ?? '').slice(0, 12) || 'ukjent';
  const rad = {
    tid: new Date().toISOString(),
    bolge,
    spor: stat?.spor ?? kortId,
    hendelse,
    agent_id: inn.agent_id ?? null,
    agent_type: inn.agent_type ?? null,
  };
  if (hendelse === 'ferdig' && stat) {
    const { spor: _spor, ...tall } = stat;
    rad.kumulativ = true;
    Object.assign(rad, tall);
    rad.merknad =
      `${tall.verktoykall} kall, ${tall.modellturer} turer, cache-lest ${(tall.tokens.cache_lest / 1e6).toFixed(1)} mill., ` +
      `${tall.cache_utlop} cache-utløp, ca. $${tall.kost_usd} (kumulativt)`;
  }
  fs.appendFileSync(logg, JSON.stringify(rad) + '\n');
}

main()
  .catch(() => undefined) // error-ignorert: en tidslogg-hook skal aldri stoppe eller forsinke en agent
  .finally(() => process.exit(0));
