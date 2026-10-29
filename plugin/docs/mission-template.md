# Mission template for parallel tracks (worktree agents)

| | |
|---|---|
| Applies to | Every track started from the work queue (`queue.mjs`) or in a parallel wave (skill `parallel-wave`) |
| Status | Living template. Update it when a wave teaches you something new. |
| Used by | `scripts/orchestrator/make-queue-common.mjs` and `make-mission.mjs` (via `missionText.js`) |

The orchestrator fills in the placeholders `<TRACK>`, `<BRANCH>`, `<HEAD>`, `<OWNERSHIP>`, `<BLOCK>` and `<READ_ALSO>`
and appends the track's own block after the shared part. The agent gets a short instruction that points to the
finished file, so the template is read once per track, not once per turn.

**Class sections:** parts of the shared protocol sit between `<!-- class: D D+ -->` and `<!-- /class -->`.
`make-mission.mjs` only includes them when the track's class (`class X` in the `## TRACK` line, or a `CLASS:` line in the
track block) is in the list; with no known class everything is included. A rule that must apply to several classes
stands outside the markers or inside every section it applies to. Section pointers in a mission (`file.md § 3`,
`file.md#heading`) get the line range added when the mission is generated.

Track classes (set per task in the queue):
- **K**: ordinary code, no schema or data migration.
- **D**: database, migrations, server-side rules.
- **D+**: high-risk database or security work (shared functions, access control, personal data).
- **U**: investigation, documentation, analysis. No production code.

## Orchestrator protocol

Before starting tracks:
- **Track size:** weighted by risk class. Targets: K 90 to 120 min, D about 40, D+ 25 to 30, U about 60 including
  review. One domain family per track and at most one shared function. A task estimated at more than about 120 turns
  is split before it starts, never midway.
- **Start tracks together.** Staggered starts did not help in practice.
- **Ownership:** every task in the queue declares the files (`owned_files`) and DB objects (`owner_db`) it owns. `queue.mjs`
  refuses to start two tasks that own the same thing.

After tracks:
- The full gate run happens once, at the orchestrator, after merging: `cq gates --full`.
- Merging is done with `scripts/orchestrator/merge-track.mjs` (through `cq merge`).

## Fix round and continuation (new agent)

A track with review findings, or a track that delivered PARTIAL (partial), is continued by a NEW `track` agent, not by
SendMessage to the old one (it typically holds 300k to 900k of context, and its cache has expired). The mission is
made with `make-mission.mjs` as usual, with a track block `=====<ID>-r<N>=====`, `BRANCH: queue/<ID>` and the same `BLOCK:`,
and with this content:
- **First call:** `prepare-track <ID>-r<N> --branch queue/<ID> --continue …`. `--continue` requires the branch to exist,
  switches to it without reset and counts its own commits against the base branch. If the branch is checked out in
  another worktree it refuses and prints the path and `git -C <path> switch --detach`. Never use `prepare-track`
  without `--continue` here: it would reset the branch.
- `git diff --stat <base>...queue/<ID>` or the track's commit list, and the paths to the track's `report.md`,
  `handover.md` (for PARTIAL) and the review files.
- The findings with file:line and severity, and exactly which functions and files to touch. Only HIGH, and MEDIUM
  that is not small and mechanical, gives a fix round; LOW findings never trigger a round alone (they become a
  follow-up task or the orchestrator fixes them while merging). A fix round that has started takes along the LOW
  findings that touch the same files.
- The same gates as the track. The agent reads its own diff and excerpts, not whole files.

## Common protocol (copied into every mission)

**Setup (first call):** `cq prepare-track <TRACK> --branch <BRANCH> --scratchpad
"<scratchpad-root>"`, run from the worktree. It links shared folders (for example `node_modules`) from the main tree,
creates `<scratchpad>\<TRACK>\` (`<folder>` below) and sets the branch. Answer: `READY …` (ready) or `DENIES …`
(refused: stop and report).
- NEVER `npm install` or `npm ci` in the worktree (it writes into the main tree through the link), never `rm -rf` on
  the links, and do not commit them.
- Scratchpad: only `<folder>`. File lock errors: try again. Write scripts with Write, never with a Bash heredoc or
  `node -e "…"` containing backticks.

**Reading and context** (every turn re-reads the whole context, so cost is roughly turns times context):
- `CLAUDE.md` and memory files are loaded automatically: never read them.
- <READ_ALSO>
- Documents the mission points to: `grep -n '^#'` on the file first, then only the pointed sections with
  `offset`/`limit`. If `(line A–B)` follows the pointer, read exactly that range.
- Files over about 300 lines: `grep -n` first, then Read with `offset`/`limit`. Never read whole neighbouring files
  "for context", and never the same file in full twice.
- Keep Bash output short: `grep … | head`, `sed -n 'a,bp'`, never `cat` of large files. Read gate logs in excerpts.
- Make independent calls in the same turn. No sleep, poll or wait loops (the prompt cache expires after 5 minutes);
  if a call answers `IN_PROGRESS` (in progress), continue with the command it prints.
- **Context cap about 300k** (about 120 tool calls): commit what is done, write `<folder>\handover.md` (done,
  remaining, next command, open questions), run `git switch --detach` (frees the branch) and deliver PARTIAL.

**Git:** `prepare-track` runs `git checkout -B <BRANCH> <base>`; HEAD must be <HEAD> or newer.
- Commit only on your own branch with `git commit -- <files>` (new files: `git add` first), in strict `&&` chains,
  after searching for conflict markers.
- NEVER push, merge your branch into the base branch, deploy, run a dev server or open a preview.
- Stop only processes you started yourself, with the pid you got. NEVER kill by pattern (`taskkill /IM`, `pkill`,
  command line filters): other tracks run the same scripts.

**Ownership:**

<OWNERSHIP>

- Change only what you own. Files the project lists as hotspots (navigation, layouts, central registries) are never
  edited by a track: deliver the component and a wiring specification (file, anchor, exact line) instead.
<!-- class: K D D+ -->
- **Append-only shared files:** registries, factories, translation files and similar lists that many tracks touch get
  additions at the END only, one block per track, so merges stay trivial.
<!-- /class -->
<!-- class: D D+ -->

**Database:**
- Only your own migration block (<BLOCK>); migrations are idempotent.
- Functions are written in FULL from the live definition, with the same permissions. Shared functions are only changed
  in a way that composes with other tracks (patch form), and only when the task declares it (`shared_patch`).
- Access is checked with capabilities or permissions, never role names. Server-side rules are the source of truth; UI
  filtering is never the only guard.
- Test against a local or disposable database, never a shared environment. Red first: the new test is red without the
  migration and green with it.

**Self-review (D and D+):** answer OK / N/A / fixed with file:line in `report.md`:
1. Is access in new endpoints and exports equal to or narrower than on the parent data?
2. Does anything read other people's personal data without the access log the project requires?
3. Can a deadline, hold or limit go DOWN through an ordinary edit? It never should.
4. Do claims like "anonymised" or "same limit as the access rule" match the code?
5. Can a rate limit or global limit be used to lock everyone out (DoS)?
6. Are rows locked in the same order in every function that touches them?
7. Are internal helper functions closed to public callers?
<!-- /class -->
<!-- class: K D D+ -->

**Client code:** follow the project's architecture rules (see `CLAUDE.md` and `architectureRules` in `queue.config.json`).
Pure logic goes where it can be unit tested. No secrets or personal data in logs or error messages.
<!-- /class -->

**Gates** (`cq gates`; NEVER write your own check script; one line per gate and the full log in
the log folder, so read the log file of a red gate instead of running it again):
- While working: `cq gates --quick`.
<!-- class: K U -->
- Before delivery, K and U: `cq gates --quick --log "<folder>\gates"`. The orchestrator runs
  `--full` after merging.
<!-- /class -->
<!-- class: D D+ -->
- Before delivery, D and D+: `cq gates --full --log "<folder>\gates"` (must be green).
<!-- /class -->

**Report:** write the long version with Write to `<folder>\report.md`, NEVER in the answer. The answer STARTS with
one result line in a fixed format (the queue reads it with `cq receive` and `set done`), with no spaces inside
the values:
`RESULT status=DONE|PARTIAL branch=<branch> commits=<n> migr=<first-last|-> gates=OK|RED probe=<before→after|-> ownerQuestions=<n> edge=<functions|->`,
for example `RESULT status=DONE branch=queue/X commits=3 migr=- gates=OK probe=- ownerQuestions=0 edge=-`.
The same line goes at the top of `report.md`. (`DONE` = done, `PARTIAL` = partial, `RED` = red, `ownerQuestions` = questions
for the owner, `edge` = server functions that must be deployed.)
**Report cap: the answer to the orchestrator is at most about 1,500 characters**: the RESULT line, then at most 5
lines (owner questions with one sentence each, HIGH findings, what must be deployed, what the orchestrator must do
while merging), then the path to `<folder>\report.md`. In `report.md`: status, branch and commits, the gate summary
line, append-only files touched, deploy needs, **owner questions** in their own section, and the wiring specification
(file, anchor, exact line).
<!-- class: D D+ -->
For D and D+ also: migrations and contracts, tests (red before, green after) and the self-review.
<!-- /class -->
