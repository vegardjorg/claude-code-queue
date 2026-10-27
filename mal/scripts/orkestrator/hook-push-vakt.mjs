#!/usr/bin/env node
// =============================================================
// hook-push-vakt.mjs: PreToolUse-hook (Bash/PowerShell) som stopper de dyre og irreversible kommandoene før
// de kjører: tvungen push, push av andre grener enn basegrenen, og migrasjonspush mot et miljø som ikke er
// tillatt (se lib/pushVakt.js for reglene og begrunnelsen, og docs/orchestration.md).
//
// Hva den gjør: leser hook-payloaden fra stdin, finner gjeldende gren og (når migrasjoner.miljoFil er satt)
// innholdet i miljøfila, og spør lib/pushVakt.js. Svaret er «ask» (Claude Code viser en bekreftelsesdialog),
// «deny» (blokkert, med grunn) eller ingenting (vanlig flyt).
//
// Feiler ÅPENT: en intern feil (ugyldig payload, git mangler) gir exit 0 uten mening og en linje på stderr.
// Vakta skal aldri stoppe vanlig arbeid på grunn av en bug i seg selv. Mangler node på PATH, får hooken exit 127,
// som Claude Code behandler som ikke-blokkerende.
//
// Test: lib/__tests__/pushVakt.test.ts (logikken). Røyktest av selve hooken:
//   echo '{"tool_input":{"command":"git push --force origin main"},"cwd":"."}' | node scripts/orkestrator/hook-push-vakt.mjs
// =============================================================

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { vurder, lesMiljo } = require('./lib/pushVakt.js');
const { konfig } = require('./lib/koKonfig.js');

function les(stdin) {
  try {
    return JSON.parse(stdin || '{}');
  } catch {
    return null;
  }
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Hovedtreet for et agent-worktree (<rot>/.claude/worktrees/<navn>), ellers stien selv. */
function hovedtre(topp) {
  return String(topp).split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0];
}

/** Bare kommandoer som kan treffe: git eller første ord i migrasjonskommandoen. Sparer git-kall ellers. */
function kanTreffe(kommando, k) {
  if (/\bgit\b/.test(kommando)) return true;
  const ord = String(k.migrasjoner?.pushKommando || '')
    .split(/\s+/)
    .filter((x) => x && !x.startsWith('-') && !['npx', 'npm', 'pnpm', 'yarn', 'exec'].includes(x));
  return ord.length > 0 && kommando.includes(ord[0]);
}

let inn = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (inn += d));
process.stdin.on('end', () => {
  try {
    const p = les(inn);
    const kommando = p?.tool_input?.command;
    if (!p || typeof kommando !== 'string') process.exit(0);
    const k = konfig();
    if (!kanTreffe(kommando, k)) process.exit(0);

    const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
    const gren = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const topp = git(cwd, ['rev-parse', '--show-toplevel']);
    const miljo = lesMiljo([topp, topp && hovedtre(topp), k.rot], k.migrasjoner?.miljoFil);
    const svar = vurder(kommando, {
      gren: gren === 'HEAD' ? null : gren,
      miljo,
      baseGren: k.baseGren,
      migrasjoner: k.migrasjoner,
    });
    if (!svar) process.exit(0);

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: svar.beslutning,
          permissionDecisionReason: `push-vakt: ${svar.grunn}`,
        },
      }),
    );
    process.exit(0);
  } catch (e) {
    process.stderr.write(
      `push-vakt: intern feil, slipper kommandoen gjennom (${e?.message ?? e})\n`,
    );
    process.exit(0);
  }
});
