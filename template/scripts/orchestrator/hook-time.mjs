#!/usr/bin/env node
// =============================================================
// hook-time.mjs: automatic time log for agents. See docs/orchestration.md.
//
// Called by Claude Code hooks in .claude/settings.json (SubagentStart and SubagentStop). Reads hook JSON from stdin and
// writes one line to the time log (config().timeLog in mainTree, default scripts/.queue/times.jsonl; QUEUE_TIME_LOG
// overrides) in the log-time.mjs format:
//   start:  { time, wave, track, event: "start", agent_id, agent_type }
//   done: { ..., event: "done", cumulative: true, duration_s, toolCall, modelTurns, model, cache_expiry,
//             cost_usd, tokens { input, output, cache_read, cache_written, cache_written_5m, cache_written_1h },
//             context {...}, first_change_s, call_for_first_change, remark }
// The numbers for "done" are computed from the agent's transcript (agent_transcript_path) in lib/timeCost.js.
//
// ALL AGENT_TYPES: the script logs any agent type it is called for (track, reviewer, general-purpose ...); agent_type
// is in the row. Which types are actually logged is controlled by `matcher` in .claude/settings.json (`"*"` or no
// matcher for all types).
//
// CUMULATIVE ROWS: an agent that is resumed (SendMessage) stops several times and gets a "done" row per stop, each
// with the WHOLE transcript. The rows must therefore never be summed raw: use `log-time.mjs --show/--cost`, which
// deduplicates per agent_id (lib/timeCost.js).
//
// Wave: first line in <dataFolder>/wave-active (the orchestrator can write a wave id there at wave start; the file is
// gitignored together with the data folder). If it is missing, the wave is "unknown".
// Track: taken from the mission in the transcript (`prompt-<ID>.md`, the reviewer's `rev-<ID>\reviewer-<type>.md` or
// "track <ID>"); otherwise the agent id. The start row gets the task id when the transcript already has the mission; then
// the first reviewer start gives `t_review` in the task (queue.mjs merge, timeCost.firstReviewStart).
//
// The hook must NEVER block or delay the agent: everything is wrapped in try/catch, it always exits with exit 0
// (exit 2 would stop the agent), and a guard exits after 20 s regardless.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('./lib/timeCost.js');
const { dataFolder, timeLog } = require('./lib/queueConfig.js');

const guard = setTimeout(() => process.exit(0), 20000);
guard.unref();

const MAX_TRANSCRIPT = 300 * 1024 * 1024; // skips statistics for huge transcripts

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    const t = setTimeout(done, 5000);
    t.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on('error', done);
  });
}

/** Computes usage from a transcript (JSONL). The logic lives in lib/timeCost.js (tested). */
export const analyser = T.analyzeTranscript;

async function main() {
  // Manual analysis of a transcript (for checking): node hook-time.mjs --analyser <file>
  const i = process.argv.indexOf('--analyser');
  if (i >= 0) {
    console.log(JSON.stringify(analyser(fs.readFileSync(process.argv[i + 1], 'utf8')), null, 1));
    return;
  }
  const input = JSON.parse((await readStdin()) || '{}');
  const event =
    input.hook_event_name === 'SubagentStart'
      ? 'start'
      : input.hook_event_name === 'SubagentStop'
        ? 'done'
        : null;
  if (!event) return;
  // QUEUE_TIME_LOG overrides the log file (tests), as in log-time.mjs and queue.mjs (timeLog() reads it).
  const log = timeLog();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  let wave = 'unknown';
  try {
    wave =
      fs
        .readFileSync(path.join(dataFolder(), 'wave-active'), 'utf8')
        .split(/\r?\n/)[0]
        .trim() || wave;
  } catch {
    // no active wave set
  }
  // On "done": use the wave the agent STARTED in (from the start row with the same agent_id). With a continuous queue
  // wave-active may have changed while the agent ran, and then the done row would end up in the wrong wave.
  if (event === 'done' && input.agent_id) {
    try {
      const rows = fs.readFileSync(log, 'utf8').split('\n');
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!rows[i].includes(input.agent_id)) continue;
        const r = JSON.parse(rows[i]);
        if (r.agent_id === input.agent_id && r.event === 'start' && r.wave) {
          wave = r.wave;
          break;
        }
      }
    } catch {
      // no log yet: keep wave-active
    }
  }
  let stat = null;
  const tp = input.agent_transcript_path;
  try {
    if (tp && fs.existsSync(tp) && fs.statSync(tp).size <= MAX_TRANSCRIPT) {
      stat = analyser(fs.readFileSync(tp, 'utf8'));
    }
  } catch {
    stat = null;
  }
  const summaryId = String(input.agent_id ?? '').slice(0, 12) || 'unknown';
  const row = {
    time: new Date().toISOString(),
    wave,
    track: stat?.track ?? summaryId,
    event,
    agent_id: input.agent_id ?? null,
    agent_type: input.agent_type ?? null,
  };
  if (event === 'done' && stat) {
    const { track: _track, ...counts } = stat;
    row.cumulative = true;
    Object.assign(row, counts);
    row.remark =
      `${counts.toolCall} calls, ${counts.modelTurns} turns, cache-read ${(counts.tokens.cache_read / 1e6).toFixed(1)}M, ` +
      `${counts.cache_expiry} cache-expiry, about $${counts.cost_usd} (cumulative)`;
  }
  fs.appendFileSync(log, JSON.stringify(row) + '\n');
}

main()
  .catch(() => undefined) // error-ignored: a time log hook must never stop or delay an agent
  .finally(() => process.exit(0));
