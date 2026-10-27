---
name: parallell-bolge
description: Default way of working for ALL parallel work in this project (several agents at once, tracks in worktrees, orchestration through the work queue). Use it every time work is to be split across several agents or tracks, also when the user just says "next wave", "run in parallel", "split across agents", "neste bølge", "kjør parallelt" or "fordel på agenter".
---

# Parallel work through the queue (default for all parallel work)

You are the **orchestrator**: you plan the tracks, start the agents, review, merge, run the gates and report. The
agents only do their own track. The binding protocol for tracks is `docs/ko/mission-template.md` (copied into the
project by the installer). Project settings (base branch, gates, optional migration flow, modules) are in
`ko.config.json` in the project root.

## Fixed rules

- **Agent model:** `subagent_type: spor` (class K and U, `effort: medium`) or `spor-d` (class D and D+,
  `effort: high`), both `isolation: worktree`, `run_in_background: true`. The worktree starts from the orchestrator's
  HEAD (`worktree.baseRef: head` in `.claude/settings.json`), so stand on the base branch when you start tracks.
  `ko.mjs fyll`/`start` print which agent type a task needs.
- **The orchestrator itself runs at medium effort.** `ko-overtak.mjs` shows the level (written by `hook-effort.mjs`).
  If it is not medium, ask the owner before the loop starts.
- **Push in batches only:** commit locally for every step; `git push` happens only when the owner says "push", and
  always after `node scripts/orkestrator/push-sjekk.mjs`. Never push per commit (every push triggers CI and costs).
- **Shared working tree:** always commit with `git commit -- <files>` (pathspec), never `git add -A`. Never touch files
  another session has uncommitted. The orchestrator's own commits on the base branch (not the merges) get the trailer
  `--trailer "Ko: orkestrator"` so `push-sjekk` can tell them from other sessions' commits.
- **No dev servers or previews from tracks.** Visual QA is the owner's; deliver a QA list.
- **Owner questions** are collected and presented with context, pros and cons, and a clear recommendation.

## The queue

Tool: `node scripts/orkestrator/ko.mjs …` (pure logic in `scripts/orkestrator/lib/`). The queue lives in
`scripts/.ko/ko.json` in the MAIN tree (gitignored) and survives compaction and new sessions. Read it with
`ko.mjs vis` (short by default). Main commands: `init`, `add --fil|--json`, `vis`, `neste`, `start <id>`,
`sett <id> <status>`, `endre <id>`, `avklar <question> [--svar "…"]`, `avklaringer`, `sporsmal`, `tilstand`
(exit 3 = empty), `fyll`, `motta`, `flett`, `kost`, `samle`, `prosjekter`, `plukk`, `lever`, `slipp`, `qa`, `ekstern`,
`orkestrator`, `plan …`. Full reference: `docs/ko/queue.md`.

**A task** has id, title, domain, class (K 1.0, D 1.3, D+ 1.8, U 0.6), `oppdrag` (path to a self-contained track
description or the text itself), `nytte` 1-10, `innhold_min`, `avhenger` (other tasks), `venter_paa` (registered
owner questions), `eier_filer` (paths, or folders ending in "/"), `eier_db`, `prosjekt`, `funksjon`, `etiketter`,
`plan` (plan entry). Priority = value per estimated minute, with a bonus for tasks that unlock others and a small age
bonus; `prioritet_tillegg` overrides.

**Classes and sizes:** K (client/UI/ordinary code) 90-120 min of content; D (database/RPC/contract changes) about 40;
D+ (new tables, retention, unauthenticated endpoints, shared-function patches) 25-30, never merged with other work;
U (investigation) about 60. Fixed overhead per track is large (see `docs/ko/orchestration.md`), so small tasks go in
the collection queue (`"samles": true`) and are packed into right-sized tracks with `ko.mjs samle pakk`.

**Limits:** `ko.mjs grense` shows and sets `maksSamtidig`, `maksDPluss`, `maksPerDomene`, `dagsbudsjett`,
`nattkjoring`, `nattvindu`, `parallellTerskel`. One owner per file and DB function. Change limits only on the owner's
word.

## The loop (event driven, never polling)

1. **Fill the slots**, ONE call: `ko.mjs fyll --scratchpad <scratch>` (next → start → track file → shared part →
   mission prompt; exit 4/5/6 = budget/night pause/wind-down). It ends with "Start disse i SAMME tur:" and one line per
   agent with `subagent_type` and the finished agent message (also in `<scratch>/ko-fyll.json`). Start ALL of them in
   the same turn with exactly that message. At loop start and each round without start/sett:
   `ko.mjs orkestrator puls --okt "<session>"`. Check `ko.mjs samle` when filling: a group marked
   "KLAR TIL PAKKING" is packed with `ko.mjs samle pakk --auto` (proposal) and `--auto --utfor`.
2. **When a track delivers:** `ko.mjs motta <id>` BEFORE merging (status review, the review package as plain files in
   `<scratch>/rev-<id>/`, the track's RESULTAT line from the transcript, one reviewer prompt per reviewer for the
   class, and the merge command). Read the long report only when RESULTAT says DELVIS, RØD or eierspm>0. Start the
   reviewers for D/D+ in the SAME turn. Fix round in a new agent on findings. When review is green:
   **`ko.mjs flett <id>`** from Bash with a long timeout (merge with `--bolge-base`, optional migration push if
   configured, `gater --rask`, `sett <id> ferdig` with cost and findings, `fyll`). It stops at the first error with
   the step and an excerpt; full log in `<scratch>/flett-<id>.log`. DELVIS = continuation in a new agent, not a merge.
3. **New work** from reviewers, planners or tracks goes in with `ko.mjs add` (agents' tasks get status `forslag` and
   start only after `ko.mjs godkjenn <id…>`). Investigations and ideas that are not concrete tasks become plan entries
   (`ko.mjs plan ny`, priority `eier`, maturity `ide`).
4. **Answers from the board:** `ko.mjs avklaringer --ulogget`; log them where the project keeps decisions, then
   `ko.mjs avklaringer --merk-logget <id…>`.
5. **Low parallelism:** when fewer agents run than `parallellTerskel` of `maksSamtidig`, `fyll`/`motta`/`puls` print a
   short diagnosis. "enkel" findings come with a ready command; "kompleks" ones go to the owner with a recommendation.
6. **Reprioritise** after every 5 finished tasks and when the owner answers: split tasks that are too large, adjust
   value.
7. **Stop** when `ko.mjs tilstand` gives exit 3 or the day budget is used: present the owner questions that unlock the
   rest (sorted by how many tasks each unlocks). `ko.mjs orkestrator stopp` when the loop stops.

## Review

- K and U: no review. D: one reviewer. D+: two. The reviewer types per class come from `ko.config.json`
  (`reviewere`, default `reviewer` and `reviewer-sikkerhet`).
- The review package is made by `ko.mjs motta` BEFORE merging (afterwards the diff is empty): `00-pakke.md`,
  `diff.patch`, `filer/` (changed files in full), `sporsvar.md`, `sporrapport.md`, `overlevering.md`.
- Fixed lines: a track's last answer starts with `RESULTAT status=… gren=… commits=… gater=… eierspm=…`, a reviewer's
  with `FUNN H=… M=… L=… utsettbare=…`. `motta` and `sett ferdig` read them.
- Fix rounds by severity: HIGH always gives a fix round. MEDIUM you fix yourself at merge when small and mechanical,
  otherwise a fix round. LOW never triggers a round alone; "safe to defer" becomes one follow-up task.

## Fix round and continuation (new agent, not SendMessage)

- `SendMessage` only to a track under about 150k context that has been idle under 5 min. Otherwise, and always on
  DELVIS: a NEW `spor` agent with a narrow mission: track block `=====<ID>-r<N>=====` with `GREN: ko/<ID>`, the
  findings with file:line, the paths to `rapport.md`/`overlevering.md` and the review files.
- The branch must be free (`git worktree list`; `git -C <old worktree> switch --detach`).
- The new agent starts with `klargjor-spor.mjs <ID>-r<N> --gren ko/<ID> --fortsett …`: takes the branch over with
  `git switch`, no reset. Never `klargjor-spor` without `--fortsett` for a fix round.

## Compact, do not rotate

The orchestrator session is compacted instead of rotated: the token cost is about the same, while rotation costs the
owner work, and running agents belong to the session that started them. At about 300k context `hook-kontekst.mjs`
offers a ready `/compact keep: …` line. Finish the current step first. After compaction `hook-etter-kompakt.mjs`
injects a resume instruction and the queue state; resume without waiting. Keep `scripts/.ko/overlevering-lopende.md`
updated after every merge and decision: decisions go to a file at once, that is the quality guard for compaction. At
about 350k the hook sets wind-down (no new starts, exit 6) until the owner compacts.

## Projects, picking and visual QA

- **Projects:** the register `prosjekter` in `ko.json` (`tittel`, `plan`, `prefikser`, `pause`, `prioritet_tillegg`,
  `omrade`). A task belongs to its explicit `prosjekt`, otherwise to the project with the longest matching id prefix.
  `ko.mjs prosjekter` reports per project. Pause and priority only on the owner's word.
- **Picked tasks** (skill `plukk`): a person or session does the task. It owns its files, is never started, merged or
  released by the orchestrator, and arrives as `review` after `ko.mjs lever <id>`.
- **Visual QA:** tasks with the label `visuell` get `qa_status: venter` when finished. `ko.mjs qa` lists them; only the
  owner decides (`qa ok`, `qa avvik <id> "<text>"`, which creates `<id>-QA<n>`).
- **The board:** `node scripts/orkestrator/ko-tavle.mjs` (local, 127.0.0.1, link with a key) shows the queue as
  kanban, statistics, dependencies, plans and "Waiting for you". It writes only through `ko.mjs`. See
  `docs/ko/board.md`.

## Work outside the queue and push check

- `ko.mjs ekstern` (read only): commits on the base branch that are not queue merges and lack the trailer, branches
  and worktrees outside `ko/*`, uncommitted files in the main tree, and collisions with owned files. Run it when
  reprioritising and before push. A match (an external commit mentions a waiting task) is a proposal:
  `ko.mjs ekstern godta <id> <sha>`, never automatic. Register outside work with
  `ko.mjs ekstern add --navn "<session>" --filer <…>`.
- `neste`/`start` skip tasks that own an uncommitted file in the main tree.
- **Push check** before every push: `node scripts/orkestrator/push-sjekk.mjs`. Exit 0: push (when the owner has said
  "push"). Exit 2: external commits: ask the owner (take everything / push only the queue's part when a safe cut point
  is printed / wait). History is never rewritten.

## Cloud sessions (optional)

Tasks of class K/U without migrations, DB ownership, open dependencies or owner questions can run in a cloud session
(`ko.mjs sky`, `sky-pakke`, `sky start|ferdig|avbryt`, `sky-start.mjs`). The cloud only sees what is pushed, so the
base branch must be pushed first. At most 3 cloud sessions at once.

## Known pitfalls

- `String.replace` with `$'` in the replacement duplicates text; build with `split`/`join`.
- Bash heredocs can halve backslashes, and backticks inside `node -e "..."` run as commands: write scripts with Write.
- Tests and scripts that need a git identity use a temporary repo (`git -C <tmp> …`), never the main repo.
