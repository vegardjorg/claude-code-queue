# Mission template for parallel tracks (worktree agents)

| | |
|---|---|
| Applies to | Every track started from the work queue (`ko.mjs`) or in a parallel wave (skill `parallell-bolge`) |
| Status | Living template. Update it when a wave teaches you something new. |
| Used by | `scripts/orkestrator/lag-ko-felles.mjs` and `lag-oppdrag.mjs` (via `oppdragTekst.js`) |

The orchestrator fills in the placeholders `<SPOR>`, `<GREN>`, `<HEAD>`, `<EIERSKAP>`, `<BLOKK>` and `<LES_OGSAA>`
and appends the track's own block after the shared part. The agent gets a short instruction that points to the
finished file, so the template is read once per track, not once per turn.

**Class sections:** parts of the shared protocol sit between `<!-- klasse: D D+ -->` and `<!-- /klasse -->`.
`lag-oppdrag.mjs` only includes them when the track's class (`klasse X` in the `## SPOR` line, or a `KLASSE:` line in the
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
- **Ownership:** every task in the queue declares the files (`eier_filer`) and DB objects (`eier_db`) it owns. `ko.mjs`
  refuses to start two tasks that own the same thing.

After tracks:
- The full gate run happens once, at the orchestrator, after merging: `node scripts/orkestrator/gater.mjs --full`.
- Merging is done with `scripts/orkestrator/flett-spor.mjs` (through `ko.mjs flett`).

## Fix round and continuation (new agent)

A track with review findings, or a track that delivered DELVIS (partial), is continued by a NEW `spor` agent, not by
SendMessage to the old one (it typically holds 300k to 900k of context, and its cache has expired). The mission is
made with `lag-oppdrag.mjs` as usual, with a track block `=====<ID>-r<N>=====`, `GREN: ko/<ID>` and the same `BLOKK:`,
and with this content:
- **First call:** `klargjor-spor <ID>-r<N> --gren ko/<ID> --fortsett …`. `--fortsett` requires the branch to exist,
  switches to it without reset and counts its own commits against the base branch. If the branch is checked out in
  another worktree it refuses and prints the path and `git -C <path> switch --detach`. Never use `klargjor-spor`
  without `--fortsett` here: it would reset the branch.
- `git diff --stat <base>...ko/<ID>` or the track's commit list, and the paths to the track's `rapport.md`,
  `overlevering.md` (for DELVIS) and the review files.
- The findings with file:line and severity, and exactly which functions and files to touch. Only HIGH, and MEDIUM
  that is not small and mechanical, gives a fix round; LOW findings never trigger a round alone (they become a
  follow-up task or the orchestrator fixes them while merging). A fix round that has started takes along the LOW
  findings that touch the same files.
- The same gates as the track. The agent reads its own diff and excerpts, not whole files.

## Felles protokoll (shared protocol, copied into every mission)

**Setup (first call):** `node scripts/orkestrator/klargjor-spor.mjs <SPOR> --gren <GREN> --scratchpad
"<scratchpad-rot>"`, run from the worktree. It links shared folders (for example `node_modules`) from the main tree,
creates `<scratchpad>\<SPOR>\` (`<mappe>` below) and sets the branch. Answer: `KLAR …` (ready) or `NEKTER …`
(refused: stop and report).
- NEVER `npm install` or `npm ci` in the worktree (it writes into the main tree through the link), never `rm -rf` on
  the links, and do not commit them.
- Scratchpad: only `<mappe>`. File lock errors: try again. Write scripts with Write, never with a Bash heredoc or
  `node -e "…"` containing backticks.

**Reading and context** (every turn re-reads the whole context, so cost is roughly turns times context):
- `CLAUDE.md` and memory files are loaded automatically: never read them.
- <LES_OGSAA>
- Documents the mission points to: `grep -n '^#'` on the file first, then only the pointed sections with
  `offset`/`limit`. If `(line A–B)` follows the pointer, read exactly that range.
- Files over about 300 lines: `grep -n` first, then Read with `offset`/`limit`. Never read whole neighbouring files
  "for context", and never the same file in full twice.
- Keep Bash output short: `grep … | head`, `sed -n 'a,bp'`, never `cat` of large files. Read gate logs in excerpts.
- Make independent calls in the same turn. No sleep, poll or wait loops (the prompt cache expires after 5 minutes);
  if a call answers `PÅGÅR` (in progress), continue with the command it prints.
- **Context cap about 300k** (about 120 tool calls): commit what is done, write `<mappe>\overlevering.md` (done,
  remaining, next command, open questions), run `git switch --detach` (frees the branch) and deliver DELVIS.

**Git:** `klargjor-spor` runs `git checkout -B <GREN> <base>`; HEAD must be <HEAD> or newer.
- Commit only on your own branch with `git commit -- <files>` (new files: `git add` first), in strict `&&` chains,
  after searching for conflict markers.
- NEVER push, merge your branch into the base branch, deploy, run a dev server or open a preview.
- Stop only processes you started yourself, with the pid you got. NEVER kill by pattern (`taskkill /IM`, `pkill`,
  command line filters): other tracks run the same scripts.

**Ownership:**

<EIERSKAP>

- Change only what you own. Files the project lists as hotspots (navigation, layouts, central registries) are never
  edited by a track: deliver the component and a wiring specification (file, anchor, exact line) instead.
<!-- klasse: K D D+ -->
- **Append-only shared files:** registries, factories, translation files and similar lists that many tracks touch get
  additions at the END only, one block per track, so merges stay trivial.
<!-- /klasse -->
<!-- klasse: D D+ -->

**Database:**
- Only your own migration block (<BLOKK>); migrations are idempotent.
- Functions are written in FULL from the live definition, with the same permissions. Shared functions are only changed
  in a way that composes with other tracks (patch form), and only when the task declares it (`delt_patch`).
- Access is checked with capabilities or permissions, never role names. Server-side rules are the source of truth; UI
  filtering is never the only guard.
- Test against a local or disposable database, never a shared environment. Red first: the new test is red without the
  migration and green with it.

**Self-review (D and D+):** answer OK / N/A / fixed with file:line in `rapport.md`:
1. Is access in new endpoints and exports equal to or narrower than on the parent data?
2. Does anything read other people's personal data without the access log the project requires?
3. Can a deadline, hold or limit go DOWN through an ordinary edit? It never should.
4. Do claims like "anonymised" or "same limit as the access rule" match the code?
5. Can a rate limit or global limit be used to lock everyone out (DoS)?
6. Are rows locked in the same order in every function that touches them?
7. Are internal helper functions closed to public callers?
<!-- /klasse -->
<!-- klasse: K D D+ -->

**Client code:** follow the project's architecture rules (see `CLAUDE.md` and `arkitekturRegler` in `ko.config.json`).
Pure logic goes where it can be unit tested. No secrets or personal data in logs or error messages.
<!-- /klasse -->

**Gates** (`node scripts/orkestrator/gater.mjs`; NEVER write your own check script; one line per gate and the full log in
the log folder, so read the log file of a red gate instead of running it again):
- While working: `node scripts/orkestrator/gater.mjs --rask`.
<!-- klasse: K U -->
- Before delivery, K and U: `node scripts/orkestrator/gater.mjs --rask --logg "<mappe>\gater"`. The orchestrator runs
  `--full` after merging.
<!-- /klasse -->
<!-- klasse: D D+ -->
- Before delivery, D and D+: `node scripts/orkestrator/gater.mjs --full --logg "<mappe>\gater"` (must be green).
<!-- /klasse -->

**Report:** write the long version with Write to `<mappe>\rapport.md`, NEVER in the answer. The answer STARTS with
one result line in a fixed format (the queue reads it with `ko.mjs motta` and `sett ferdig`), with no spaces inside
the values:
`RESULTAT status=FERDIG|DELVIS gren=<branch> commits=<n> migr=<first-last|-> gater=OK|RØD probe=<before→after|-> eierspm=<n> edge=<functions|->`,
for example `RESULTAT status=FERDIG gren=ko/X commits=3 migr=- gater=OK probe=- eierspm=0 edge=-`.
The same line goes at the top of `rapport.md`. (`FERDIG` = done, `DELVIS` = partial, `RØD` = red, `eierspm` = questions
for the owner, `edge` = server functions that must be deployed.)
**Report cap: the answer to the orchestrator is at most about 1,500 characters**: the RESULTAT line, then at most 5
lines (owner questions with one sentence each, HIGH findings, what must be deployed, what the orchestrator must do
while merging), then the path to `<mappe>\rapport.md`. In `rapport.md`: status, branch and commits, the gate summary
line, append-only files touched, deploy needs, **owner questions** in their own section, and the wiring specification
(file, anchor, exact line).
<!-- klasse: D D+ -->
For D and D+ also: migrations and contracts, tests (red before, green after) and the self-review.
<!-- /klasse -->
