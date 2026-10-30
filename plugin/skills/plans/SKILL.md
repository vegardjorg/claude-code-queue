---
name: plans
description: Fetch and work with plans in the plan register (scripts/.queue/plans.json, cq plan). Fetches a plan entry, a project or an area, checks status against the code with read-only Explore agents, gives a short report and waits for the owner's instruction. Saves the plan work (document, plan entry, owner questions, verification). Never builds. Use when the user types "/plans …", pastes a copy line from the board, or wants to look at, prioritise or verify a plan.
---

# /plans: work with plans in the plan register

Argument: **$ARGUMENTS**. The form is `<id|project|module>`, optionally with an instruction after it, e.g.
`/plans PL-EX-1 (Example › Login › Password reset). Instruction: …` (the copy line from the board).
`/plans jur <J-id>` and `/plans owner <Q-id>` go straight to a legal point or an owner question. Empty argument: run
`cq plan show` and ask what the owner wants to work on.

Background: `docs/queue/plan-register.md`. The register lives in the main tree's `scripts/.queue/plans.json` and is written
ONLY through `cq plan …` (same lock, atomic writes, change log and `plan undo` as the
queue). Never `node -e` or Write against `plans.json` or `queue.json`.

**You only do plan work.** Do not build, do not change code or tests, do not start tracks and do not run
`cq start`, `set` or `fill`. If something is to be built, the next step is `/add-to-queue <plan entry>`.

## 1. Fetch

1. `cq plan get <argument>`: the entries, the sources (with "DOES NOT EXIST" for dead
   paths), the queue tasks with status, owner questions, legal points, dependencies and the copy line. Use `--json`
   when you need exact fields.
2. **Mark the entry as being worked on** (pulse marker on the board): `cq plan active <entry-id>` once per entry.
   The marker expires after 2 hours without updates; `plan active <entry-id> --end` when done.
3. Read the source documents, only the sections the entry points to (`anchor`): `grep -n '^#'` first, then Read with
   `offset`/`limit`. Gitignored notes exist only in the main tree: use an absolute path.

## 2. Status against the code

Start 1 to 3 **Explore agents in the same turn** (read only). Give each a bounded part of the entry and ask for short
answers with file paths: what exists for this today, which queue tasks are finished and what they delivered
(`cq info <id>`), and whether `maturity` and the document match what is actually built. A small entry needs only
one agent.

## 3. Short report to the owner

Plain text, at most about 20 lines, for a non-technical reader:
- **What the plan says**, in two or three sentences.
- **What is built**, and what is missing, with file paths where it helps.
- **Gaps and contradictions** between the plan, other plans and the code.
- **Blocking owner questions and legal points**, each in plain language with a recommendation.
- **Priority:** what the rules give (`cq plan rules`), and whether that differs from what is set.
- **Proposed next step** ("ready for the queue", "needs an owner answer first", "merge with PL-…", "drop: …").

## 4. Wait for instruction

Stop after the report, unless the argument already had an instruction: then carry it out (still only plan work).

## 5. Save the plan work

- **The document:** update the plan in `docs/` and commit with `git commit -- <files>`; push only when the owner says
  "push".
- **The entry:** `cq plan edit <id> --field name=value …` or `--set '{"field":…}'`; new entry with
  `plan new --file <json>`; priority with `plan prioritize <id…> <now|owner|later|drop> --reason "…"`; merge with
  `plan combine <to> <from…>`. Use `--dry` first for bulk changes. The owner's own choices are saved with
  `--set-by owner`.
- **Priority limits:** an agent never changes a priority the owner has set (`priority_set_by: owner`), except that a
  new security finding may raise it to Now. Drop needs one sentence of reason.
- **Owner questions:** `cq question <id> --text "…" --type <question|condition|lawyer|owner-task>`, linked in
  `ownerQuestions`. The owner's answer: `cq resolve <id> --answer "…"`.
- **Verification:** `cq plan verify <id> --findings "short finding" [--commit <sha>]` after checking against the
  code. It resets the stale warning.

## 6. End of session

- `plan active <entry-id> --end` for the entries you marked.
- If a backup script is configured (`planBackup` in `queue.config.json`), offer `cq plan backup` when the register
  changed. Run it only when the owner says yes.
- Short closing line: what changed and the change-log number from `cq` (undo with `cq plan undo`).
