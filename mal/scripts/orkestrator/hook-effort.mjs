#!/usr/bin/env node
// Hook (UserPromptSubmit): skriver øktas tenkenivå (effort) til <datamappe>/effort.json, slik at ko-overtak og ko.mjs
// kan advare når orkestratoren ikke kjører på medium (medium er standard; high/xhigh bare når eieren har bekreftet).
// Nivået kommer fra hook-inputen (`effort.level`) eller miljøvariabelen CLAUDE_EFFORT. Skriver bare når datamappa
// har en ko.json (køen er satt opp), og feiler aldri: en hook skal ikke stoppe en melding.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let inn = '';
try {
  inn = fs.readFileSync(0, 'utf8');
} catch {
  /* ingen stdin */
}
try {
  let data = {};
  try {
    data = JSON.parse(inn || '{}');
  } catch {
    /* ugyldig JSON: bruk miljøvariabelen */
  }
  const nivaa = data?.effort?.level ?? process.env.CLAUDE_EFFORT ?? null;
  // Datamappa i hovedtreet (konfig().rot er hovedtreet, også fra et worktree; KO_MAPPE overstyrer).
  const mappe = require('./lib/koKonfig.js').dataMappe();
  if (nivaa && fs.existsSync(path.join(mappe, 'ko.json'))) {
    const ut = { nivaa, tid: new Date().toISOString(), okt: data?.session_id ?? null };
    const tmp = path.join(mappe, `effort.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(ut, null, 2));
    fs.renameSync(tmp, path.join(mappe, 'effort.json'));
  }
} catch {
  /* aldri stopp meldingen */
}
process.exit(0);
