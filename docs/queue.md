# The work queue (`ko.mjs`)

The queue is a JSON file (`scripts/.ko/ko.json`, gitignored) with tasks, owner questions, projects, limits and cost
data. It survives when the orchestrator's chat is compacted or restarted, because nothing important lives only in
the chat. Every command is `node scripts/orkestrator/ko.mjs <command>`; the full usage list is the comment at the
top of `ko.mjs`. Command names and most output are in Norwegian; the table below translates the important ones.

Writes happen under a file lock (atomic `mkdir`) and via temp file plus rename, so two writers (the orchestrator and
a track adding a proposal) cannot corrupt the file. `ko.mjs angre` undoes the last change.

## A task

```json
{
  "id": "AUTH-3",
  "tittel": "Rate limit on the login endpoint",
  "domene": "auth",
  "klasse": "K",
  "oppdrag": "Self-contained description of what to do and how to verify it.",
  "nytte": 7,
  "innhold_min": 60,
  "avhenger": ["AUTH-2"],
  "venter_paa": [],
  "eier_filer": ["src/auth/rateLimit.ts", "src/auth/__tests__/rateLimit.test.ts"],
  "eier_db": [],
  "delt_patch": [],
  "prosjekt": "auth",
  "funksjon": "Login",
  "kilde": "docs/auth-plan.md § 2"
}
```

| Field | Meaning |
|---|---|
| `id`, `tittel` | Unique id and title |
| `domene` | Domain; limits how many tracks run in the same domain (`maksPerDomene`) |
| `klasse` | `K` code, `D` database, `D+` high-risk database or security, `U` investigation (no production code) |
| `oppdrag` | The mission text. Must be self-contained: the track agent knows nothing else |
| `nytte` | Value 1 to 10, used for ranking |
| `innhold_min` | Estimated minutes |
| `avhenger` | Task ids that must be done first |
| `venter_paa` | Registered owner question ids that block the task until answered |
| `eier_filer`, `eier_db` | Files and DB objects the task owns exclusively while it runs |
| `delt_patch` | Shared functions the task changes in patch form |
| `prosjekt`, `funksjon`, `kilde` | Project id (must exist), feature name, and the plan section the task comes from |
| `samles` | `true` for small low-value tasks: they go to the bundle queue (`ko.mjs samle`) instead of their own track |

Status flow: `forslag` (proposal) → `venter` (waiting, approved) → `kjorer` (running) → `review` → `ferdig` (done),
or `kansellert` (cancelled). Tasks added by an agent start as `forslag` and need `godkjenn` (approve).

## Everyday commands

| Command | What it does |
|---|---|
| `init` | Creates an empty queue (run once per project) |
| `add --fil task.json` / `add --json '{…}'` | Adds one task or a list |
| `godkjenn <id>` | Approves a proposal |
| `vis` / `vis --full` | Short view (under about 3,000 characters) / full table |
| `neste` | What can start now, without changing anything |
| `fyll --scratchpad <dir>` | Starts as many tasks as the limits allow and writes the mission prompts |
| `motta <id>` | Receives a finished track: reads the RESULTAT line, builds the review package |
| `flett <id>` | Merges the track branch into the base branch (after review) |
| `sett <id> <status>` | Sets status by hand |
| `endre <id> --json '{…}'` | Changes fields |
| `info <id>` | Short view of one task |
| `sporsmal` / `avklar <q> --svar "…"` | Owner questions / answer one (waiting tasks get the answer in their mission) |
| `grense [<name> <value>]` | Limits: `maksSamtidig`, `maksDPluss`, `maksPerDomene`, `dagsbudsjett`, night window |
| `kost` | Cost statistics per class (median, average) from the measured track sessions |
| `prosjekter`, `prosjekt <pid> …` | Projects: progress, pause, prefixes |
| `fokus sett <steps>` | Focus period: only these steps are started |
| `parker <id>` / `fortsett <id>` | Park / unpark |
| `plukk <id> --av "<who>"` / `lever <id>` | A person or a separate chat takes a task by hand / delivers it |
| `diagnose` | Why the queue runs fewer tracks than it could (with suggested fixes) |
| `tilstand` | Machine-readable state (exit 3 when there is nothing to do) |
| `angre` | Undo the last write |

## Limits and safety

- `maksSamtidig` (parallel tracks), `maksDPluss`, `maksPerDomene` and `maksDb` stop the queue from starting more than
  the codebase and your plan can take.
- Two tasks that own the same file or DB object never run at the same time.
- `dagsbudsjett <usd>` stops new starts when the day's measured spend (API-equivalent) is used up. The night window
  (`nattkjoring`, `nattvindu`) can pause starts at night.
- Agents may only ADD proposals. Approval, merging and pushing belong to the orchestrator and the owner.

## Configuration

Project-specific values live in `ko.config.json` at the project root (see `ko.config.example.json`): base branch,
branch prefix, gate commands, migration folder (optional), modules for the plan register, board port and title,
reviewer agents per class. Missing values fall back to safe defaults.

| Key | Default | Used for |
|---|---|---|
| `baseGren`, `remote`, `grenPrefiks` | `main`, `origin`, `ko/` | Integration branch, push remote, track branch names |
| `gater.rask`, `gater.full` | `[]` | Commands `gater.mjs` runs (empty = green) |
| `migrasjoner.mappe` | `null` | Optional numbered migrations; `null` turns block numbering and migration push off |
| `migrasjoner.pushKommando`, `miljoFil`, `tillatteMiljo` | `null`, `null`, `[]` | `flett` runs the push command after merging (skip with `--uten-migr-push`), but only when the environment file names an allowed environment |
| `reviewere` | D: `reviewer`, D+: `reviewer` + `reviewer-sikkerhet` | Reviewer agents per class after `motta` |
| `arkitekturRegler` | `[]` | Short rules copied into every mission |
| `delteLenker` | `["node_modules"]` | Folders linked into each worktree instead of reinstalled |
| `lesevakt` | built-in lists | Extra agent types, auto-loaded files and large-file globs for the reading guard |
| `skyUsynlig` | `[]` | Paths a cloud session cannot see (missions pointing there are stopped) |
| `kapasitet` | Tuesday 19:00 Europe/Oslo | Weekly quota reset for `ko.mjs kapasitet` |
| `utelatGrener` | `["main","master"]` | Branches never treated as external work |
| `moduler`, `prosjektModulForslag`, `prioritetsregler`, `dokumentMapper`, `indeksFil`, `dokumenter`, `planBackup` | see `ko.config.example.json` | Plan register (see `plan-register.md`) |
| `tavle.port`, `tavle.tittel` | `2000`, `Køtavla` | Board |
