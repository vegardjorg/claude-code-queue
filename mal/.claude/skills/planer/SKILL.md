---
name: planer
description: Fetch and work with plans in the plan register (scripts/.ko/planer.json, ko.mjs plan). Fetches a plan entry, a project or a module, checks status against the code with read-only Explore agents, gives a short report and waits for the owner's instruction. Saves the plan work (document, plan entry, owner questions, verification). Never builds. Use when the user types "/planer …", pastes a copy line from the board, or wants to look at, prioritise or verify a plan.
---

# /planer: work with plans in the plan register

Argument: **$ARGUMENTS**. The form is `<id|project|module>`, optionally with an instruction after it, e.g.
`/planer PL-EKS-1 (Example › Login › Password reset). Instruction: …` (the copy line from the board).
`/planer jur <J-id>` and `/planer eier <Q-id>` go straight to a legal point or an owner question. Empty argument: run
`ko.mjs plan vis` and ask what the owner wants to work on.

Background: `docs/ko/plan-register.md`. The register lives in the main tree's `scripts/.ko/planer.json` and is written
ONLY through `node scripts/orkestrator/ko.mjs plan …` (same lock, atomic writes, change log and `plan angre` as the
queue). Never `node -e` or Write against `planer.json` or `ko.json`.

**You only do plan work.** Do not build, do not change code or tests, do not start tracks and do not run
`ko.mjs start`, `sett` or `fyll`. If something is to be built, the next step is `/legg-til-ko <plan entry>`.

## 1. Fetch

1. `node scripts/orkestrator/ko.mjs plan hent <argument>`: the entries, the sources (with "FINNES IKKE" for dead
   paths), the queue tasks with status, owner questions, legal points, dependencies and the copy line. Use `--json`
   when you need exact fields.
2. **Mark the entry as being worked on** (pulse marker on the board): `ko.mjs plan aktiv <entry-id>` once per entry.
   The marker expires after 2 hours without updates; `plan aktiv <entry-id> --slutt` when done.
3. Read the source documents, only the sections the entry points to (`anker`): `grep -n '^#'` first, then Read with
   `offset`/`limit`. Gitignored notes exist only in the main tree: use an absolute path.

## 2. Status against the code

Start 1 to 3 **Explore agents in the same turn** (read only). Give each a bounded part of the entry and ask for short
answers with file paths: what exists for this today, which queue tasks are finished and what they delivered
(`ko.mjs info <id>`), and whether `modenhet` and the document match what is actually built. A small entry needs only
one agent.

## 3. Short report to the owner

Plain text, at most about 20 lines, for a non-technical reader:
- **What the plan says**, in two or three sentences.
- **What is built**, and what is missing, with file paths where it helps.
- **Gaps and contradictions** between the plan, other plans and the code.
- **Blocking owner questions and legal points**, each in plain language with a recommendation.
- **Priority:** what the rules give (`ko.mjs plan regler`), and whether that differs from what is set.
- **Proposed next step** ("ready for the queue", "needs an owner answer first", "merge with PL-…", "drop: …").

## 4. Wait for instruction

Stop after the report, unless the argument already had an instruction: then carry it out (still only plan work).

## 5. Save the plan work

- **The document:** update the plan in `docs/` and commit with `git commit -- <files>`; push only when the owner says
  "push".
- **The entry:** `ko.mjs plan endre <id> --felt name=value …` or `--sett '{"field":…}'`; new entry with
  `plan ny --fil <json>`; priority with `plan prioriter <id…> <naa|eier|senere|dropp> --grunn "…"`; merge with
  `plan slaa-sammen <to> <from…>`. Use `--torr` first for bulk changes. The owner's own choices are saved with
  `--satt-av eier`.
- **Priority limits:** an agent never changes a priority the owner has set (`prioritet_satt_av: eier`), except that a
  new security finding may raise it to Now. Drop needs one sentence of reason.
- **Owner questions:** `ko.mjs sporsmal <id> --tekst "…" --type <sporsmal|betingelse|jurist|eier-oppgave>`, linked in
  `eierspm`. The owner's answer: `ko.mjs avklar <id> --svar "…"`.
- **Verification:** `ko.mjs plan verifiser <id> --funn "short finding" [--commit <sha>]` after checking against the
  code. It resets the stale warning.

## 6. End of session

- `plan aktiv <entry-id> --slutt` for the entries you marked.
- If a backup script is configured (`planBackup` in `ko.config.json`), offer `ko.mjs plan backup` when the register
  changed. Run it only when the owner says yes.
- Short closing line: what changed and the change-log number from `ko.mjs` (undo with `ko.mjs plan angre`).
