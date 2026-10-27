# Install instructions (for Claude Code)

These instructions are written TO Claude Code. The user has downloaded this repository and asked you to install it
into their project. Follow the steps in order, and ask the user where a step says ASK. Do not push anything.

## 0. Check the prerequisites

- Node.js 20 or newer (`node --version`). The scripts use only Node built-ins; no npm packages are needed at run
  time. `vitest` and `jsdom` are dev dependencies of THIS repository, only for its own unit tests.
- The target project is a git repository with at least one commit. Note its main integration branch (often `main`,
  sometimes `develop` or `staging`).
- Note whether the target has a `.claude/settings.json`, `.claude/skills/` or `.claude/agents/` already. The
  installer never overwrites existing files without `--overskriv`; tell the user about any file it skipped.

## 1. Run the installer

From this repository's folder:

```
node scripts/install.mjs <path-to-target-project> --torr     # dry run: shows what would happen
node scripts/install.mjs <path-to-target-project>
```

It copies:

| From | To (in the target) |
|---|---|
| `mal/scripts/orkestrator/` (without tests) | `scripts/orkestrator/` |
| `mal/.claude/skills/*` | `.claude/skills/` (ko, legg-til-ko, parallell-bolge, planer, plukk, start) |
| `mal/.claude/agents/*` | `.claude/agents/` (spor, spor-d, reviewer, reviewer-sikkerhet) |
| `docs/*.md` | `docs/ko/` |
| `CLAUDE.ko.md` | `CLAUDE.ko.md` |
| `ko.config.example.json` | `ko.config.json` (only if missing) |

It merges `mal/.claude/settings.ko.json` into `.claude/settings.json` (adds missing keys and hooks, keeps every
existing value), and adds `scripts/.ko/` and `.claude/worktrees/` to `.gitignore`.

If a skill or agent with the same name already exists in the target, ASK the user whether to keep theirs, rename one,
or rerun with `--overskriv`.

## 2. Configure

Open `ko.config.json` in the target and fill in, asking the user where you are not sure:

- `prosjektNavn`: a short name.
- `baseGren`: the integration branch tracks branch from and merge into.
- `gater.rask` and `gater.full`: the project's real check commands (type check, lint, tests). Read `package.json`
  scripts (or the equivalent for the stack) and propose them; empty lists are allowed (gates then pass trivially).
- `migrasjoner`: only if the project has database migrations (folder and file name pattern). Otherwise leave `mappe`
  as `null`.
- `moduler`: ASK the user which areas, projects or modules the product has (for example "auth", "billing",
  "mobile"). Use their answer for `moduler` and `prosjektModulForslag`.
- `reviewere`: reviewer agents per class. The default (`reviewer` for D, `reviewer` + `reviewer-sikkerhet` for D+)
  is a good start.
- `tavle.port` and `tavle.tittel`: the board's port (default 2000) and title.

Keys starting with `_` or `$` are comments and are ignored.

## 3. Hook it into CLAUDE.md

Add this line to the target's `CLAUDE.md` (create the file if it does not exist):

```
@CLAUDE.ko.md
```

Tell the user that `CLAUDE.ko.md` contains the queue rules (batch push, pathspec commits, worktree rules) and that
they can edit it.

## 4. First run

In the target project:

```
node scripts/orkestrator/ko.mjs init
node scripts/orkestrator/ko.mjs vis
node scripts/orkestrator/ko.mjs plan vis
```

`init` creates the queue in `scripts/.ko/` (gitignored) with one example project `eksempel` (prefix `EKS-`); rename it
with `ko.mjs prosjekt`. The plan register file is created on the first `plan` write. Then run
`node scripts/orkestrator/ko.mjs plan moduler` to create the modules from `ko.config.json`.

## 5. Smoke test

```
node scripts/orkestrator/ko.mjs add --json '{"id":"EKS-1","tittel":"Demo task","domene":"demo","klasse":"U","prosjekt":"eksempel","funksjon":"Demo","oppdrag":"Write a one-paragraph note about the repository layout.","nytte":5,"innhold_min":60}'
node scripts/orkestrator/ko.mjs vis
node scripts/orkestrator/ko.mjs neste
node scripts/orkestrator/ko-tavle.mjs
```

Open the board URL it prints (it contains an access key), check that EKS-1 is shown, then stop the board (the pid it printed, or Ctrl+C in
its terminal; never kill node by name). Remove the demo task with
`node scripts/orkestrator/ko.mjs sett EKS-1 kansellert`.

## 6. Bring in the user's own work

ASK the user: "Do you want me to look through your own notes, TODOs and plans (for example `docs/`, `TODO.md`,
`ROADMAP.md`, code comments with TODO/FIXME, and GitHub issues if `gh` is available) and add them as plan entries or
queue tasks?"

If yes:
1. List what you found (file, short title) and propose for each: plan entry (`ko.mjs plan ny`) for ideas and larger
   plans, queue task (`ko.mjs add`) for concrete, ready work. Show the proposal before writing anything.
2. Plan entries you create without the user's priority get `"prioritet": "eier"`, `"modenhet": "ide"`,
   `"prioritet_satt_av": "agent"` and a one-sentence `prioritet_grunn`. Each entry needs an existing `prosjekt`
   (create projects first, from the user's answer about areas) and `kilder` as `[{ "sti": "<path>" }]`.
3. Queue tasks you add start as proposals; the user approves them with `ko.mjs godkjenn <id>` or on the board.
4. Never copy document contents into the register; point to them with `kilder`.

If no: leave the queue empty. The user can run `/legg-til-ko` later.

## 7. Commit

The worktree agents only see committed files, so the installed scripts, skills, agents and docs must be committed
before the first parallel run. Commit with a pathspec, for example:

```
git add scripts/orkestrator .claude/skills .claude/agents .claude/settings.json docs/ko CLAUDE.ko.md ko.config.json .gitignore CLAUDE.md
git commit -m "chore: install claude-cowie-qeue work queue" -- scripts/orkestrator .claude/skills .claude/agents .claude/settings.json docs/ko CLAUDE.ko.md ko.config.json .gitignore CLAUDE.md
```

Do not push unless the user asks.

## 8. Tell the user how to start

- `/start` for a short status at the start of a session.
- `/ko` to run this chat as the orchestrator.
- `/legg-til-ko` to turn a request into queue tasks, `/planer` for plan work, `/plukk` to do one task by hand.
- The board: `node scripts/orkestrator/ko-tavle.mjs`.
