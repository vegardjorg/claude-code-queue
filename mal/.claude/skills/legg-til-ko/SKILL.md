---
name: legg-til-ko
description: Add saved-up or new work to the work queue (scripts/.ko, ko.mjs) as tracks of the right size (K 90-120 min, D about 40, D+ 25-30, U about 60; small non-blocking tasks in the collection queue), with risk class, project and feature, ownership, dependencies and owner questions. Also takes a plan entry from the plan register (`/legg-til-ko PL-…`) and sets the plan field. Use when the user says "add to the queue", "legg til i køen", "/legg-til-ko …", or wants to send work to the continuous queue. Builds nothing itself.
---

# Add to the work queue

What goes in: **$ARGUMENTS** (if empty, ask what to add, or use the tasks the user described in the conversation).

You only ADD work. Do not build, do not start agents, do not run `ko.mjs start`/`sett`; the orchestrator does that.
Background: `.claude/skills/parallell-bolge/SKILL.md` and `docs/ko/queue.md`.

0. **Plan entry as input.** If the argument is a plan entry (`PL-…`), or the work belongs to one
   (`ko.mjs plan vis --sok "…"`), fetch it with `node scripts/orkestrator/ko.mjs plan hent <id> --json` and check:
   maturity `klar` (otherwise say what is missing and suggest `/planer <id>` first), no open blocking owner questions
   (otherwise tasks that must wait get them in `venter_paa`), and that content only found in gitignored notes is lifted
   into the mission (worktree agents cannot see gitignored files). Every task gets `"plan": "<entry-id>"` and `prosjekt`
   from the entry. `add` refuses an unknown entry, and the entry becomes `i-ko` by itself.
1. **Split into tracks of the right size per class** (fixed overhead is a large share of a small track):
   - **K** (client/UI/ordinary code), weight 1.0: **90-120 min of content**. No K under about 30 min alone; pack it
     with related K work in the same project/feature. Split only if the track would pass about 250k context.
   - **D** (database/RPC/contract changes), weight 1.3: **about 40 min** (30-50), at most 3 migrations.
   - **D+** (new tables, retention/anonymisation, unauthenticated endpoints, patching a shared function), weight 1.8:
     **25-30 min**, one function family. Never merged with other work.
   - **U** (investigation), weight 0.6: about 60 min.
   - Keep apart: K and D; tasks with different owner questions; unrelated hotspot files. Parallelism before cohesion.
   - **Small-task guard (`add` enforces it):** 10 min or less: not in the queue; ask the owner "fix now
     (recommended) or collection queue?". Over 10 min but under the lower target for the class and value 7 or less:
     collection queue (`"samles": true`). Unsure value: ask with a recommended value. Deliberate own track:
     `"eget_spor": "<reason>"`. Not for D+, for tasks others depend on, or for tasks with open owner questions.
   `innhold_min` = the time the content would take as a K track (estimate = innhold_min × weight).
2. **Write one self-contained track description per track** to `scripts/.ko/oppdrag/<id>.md`: what and why, "Read
   also" (paths), numbered content, tests (red first), review needs and "Do NOT touch".
3. **Map ownership with Grep/Glob, do not guess:** `eier_filer` (exact paths, or folders ending in "/"), `eier_db`
   (functions created or redefined), `delt_patch` (shared functions patched), `migr_tiere` (0 without migrations).
4. **Project and feature (REQUIRED):** every task gets `prosjekt` (from `ko.mjs prosjekter`) and `funksjon` (a short
   name the owner recognises). Tasks with visible UI get `"etiketter": ["visuell"]`. Unsure of the project:
   `ko.mjs klassifiser --fil <in.json>`. No fitting project: create one first:
   `ko.mjs prosjekt <pid> --tittel "<clear title>" --prefiks <PREFIX>- [--plan docs/<plan>.md] [--omrade <oid>]`.
4b. **Cloud or local:** set `krever` (list) when the task needs something a cloud session lacks: `db`, `nett`,
   `lokale-filer`, `enhet`. Class D/D+ and DB ownership keep a task local anyway.
5. **Make one JSON file** (e.g. `scripts/.ko/oppdrag/<prefix>-inn.json`):
   ```json
   { "oppgaver": [{ "id": "EKS-1a", "tittel": "short title", "domene": "web",
       "prosjekt": "eksempel", "funksjon": "Login page", "etiketter": ["visuell"],
       "klasse": "K", "oppdrag": "scripts/.ko/oppdrag/EKS-1a.md", "nytte": 7, "innhold_min": 90,
       "migr_tiere": 0, "avhenger": [], "venter_paa": ["Q-EKS-1"], "eier_filer": ["src/login/"],
       "eier_db": [], "delt_patch": [], "krever": [], "plan": "PL-EKS-1", "kilde": "docs/plan.md § 3",
       "lagt_til_av": "<session>" }],
     "sporsmal": { "Q-EKS-1": { "type": "sporsmal", "tekst": "The question, clear for the owner",
       "anbefaling": "…", "kilde": "docs/plan.md § 3" } } }
   ```
   `id`: unique, letters/digits/"."/"_"/"-". `venter_paa` takes ONLY registered question ids (with text and type,
   from before or in the same file); `add` and `endre` refuse anything else, and the whole file stops. Types:
   `sporsmal`, `betingelse`, `jurist`, `eier-oppgave`. When the owner answers (`ko.mjs avklar <id> --svar "…"`), every
   waiting task gets the answer appended to its mission.
6. **Add and check:** `node scripts/orkestrator/ko.mjs add --fil <file.json>` and `ko.mjs vis --prosjekt <pid>`.
   `add` rejects the whole file on error: fix and retry.
7. **Report briefly:** the ids added, project and feature, dependencies, and owner questions (with recommendation).
   No commit needed: `scripts/.ko/` is gitignored.
8. **Investigations and proposals become plan entries:** if it is an idea or proposal not ready to build, register it
   with `ko.mjs plan ny --fil <json>` (`"prioritet": "eier"`, `"modenhet": "ide"`, `"prioritet_satt_av": "agent"`, a
   reason, and a linked owner question). Mention the entry id in the report.
