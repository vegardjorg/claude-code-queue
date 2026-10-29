# Install instructions (for Claude Code)

These instructions are written TO Claude Code. The user has downloaded this repository and asked you to install it
into their project. Follow the steps in order, and ask the user where a step says ASK. Do not push anything.

This is the vendored install: everything is copied into the project. The recommended way is the Claude Code plugin
(`/plugin marketplace add vegardjorg/claude-code-queue`, `/plugin install cq@claude-cowie-queue`, then `/cq:setup`).
If the user has not chosen, ASK which they want before you copy anything.

## 0. Check the prerequisites

- Node.js 20 or newer (`node --version`). The scripts use only Node built-ins; no npm packages are needed at run
  time. `vitest` and `jsdom` are dev dependencies of THIS repository, only for its own unit tests.
- The target project is a git repository with at least one commit. Note its main integration branch (often `main`,
  sometimes `develop` or `staging`).
- Note whether the target has a `.claude/settings.json`, `.claude/skills/` or `.claude/agents/` already. The
  installer never overwrites existing files without `--overwrite`; tell the user about any file it skipped.

## 1. Run the installer

From this repository's folder:

```
node scripts/install.mjs <path-to-target-project> --dry     # dry run: shows what would happen
node scripts/install.mjs <path-to-target-project>
```

It copies:

| From | To (in the target) |
|---|---|
| `plugin/scripts/orchestrator/` (without tests) | `scripts/orchestrator/` |
| `plugin/skills/*` (except setup) | `.claude/skills/` (queue, add-to-queue, parallel-wave, plans, pick, start) |
| `plugin/agents/*` | `.claude/agents/` (track, track-d, reviewer, reviewer-security) |
| `plugin/docs/*.md` | `docs/queue/` |
| `plugin/CLAUDE.queue.md` | `CLAUDE.queue.md` |
| `plugin/queue.config.example.json` | `queue.config.json` (only if missing) |

In the copied Markdown, `cq <...>` becomes `node scripts/orchestrator/cq.mjs <...>` (there is no `cq` on PATH without
the plugin). It merges `plugin/settings.queue.json` into `.claude/settings.json` (adds missing keys and hooks, keeps every
existing value), and adds `scripts/.queue/` and `.claude/worktrees/` to `.gitignore`.

If a skill or agent with the same name already exists in the target, ASK the user whether to keep theirs, rename one,
or rerun with `--overwrite`.

## 2. Configure

Open `queue.config.json` in the target and fill in, asking the user where you are not sure:

- `projectName`: a short name.
- `baseBranch`: the integration branch tracks branch from and merge into.
- `gates.quick` and `gates.full`: the project's real check commands (type check, lint, tests). Read `package.json`
  scripts (or the equivalent for the stack) and propose them; empty lists are allowed (gates then pass trivially).
- `migrations`: only if the project has database migrations (folder and file name pattern). Otherwise leave `folder`
  as `null`.
- `modules`: ASK the user which areas, projects or modules the product has (for example "auth", "billing",
  "mobile"). Use their answer for `modules` and `projectModuleSuggestion`.
- `reviewers`: reviewer agents per class. The default (`reviewer` for D, `reviewer` + `reviewer-security` for D+)
  is a good start.
- `board.port` and `board.title`: the board's port (default 2000) and title.

Keys starting with `_` or `$` are comments and are ignored.

## 3. Hook it into CLAUDE.md

Add this line to the target's `CLAUDE.md` (create the file if it does not exist):

```
@CLAUDE.queue.md
```

Tell the user that `CLAUDE.queue.md` contains the queue rules (batch push, pathspec commits, worktree rules) and that
they can edit it.

## 4. First run

In the target project:

```
node scripts/orchestrator/cq.mjs init
node scripts/orchestrator/cq.mjs show
node scripts/orchestrator/cq.mjs plan show
```

`init` creates the queue in `scripts/.queue/` (gitignored) with one example project `example` (prefix `EX-`); rename it
with `queue.mjs project`. The plan register file is created on the first `plan` write. Then run
`node scripts/orchestrator/cq.mjs plan modules` to create the modules from `queue.config.json`.

## 5. Smoke test

```
node scripts/orchestrator/cq.mjs add --json '{"id":"EX-1","title":"Demo task","domain":"demo","class":"U","project":"example","feature":"Demo","mission":"Write a one-paragraph note about the repository layout.","value":5,"content_min":60}'
node scripts/orchestrator/cq.mjs show
node scripts/orchestrator/cq.mjs next
node scripts/orchestrator/cq.mjs board
```

Open the board URL it prints (it contains an access key), check that EX-1 is shown, then stop the board (the pid it printed, or Ctrl+C in
its terminal; never kill node by name). Remove the demo task with
`node scripts/orchestrator/cq.mjs set EX-1 cancelled`.

## 6. Bring in the user's own work

ASK the user: "Do you want me to look through your own notes, TODOs and plans (for example `docs/`, `TODO.md`,
`ROADMAP.md`, code comments with TODO/FIXME, and GitHub issues if `gh` is available) and add them as plan entries or
queue tasks?"

If yes:
1. List what you found (file, short title) and propose for each: plan entry (`queue.mjs plan new`) for ideas and larger
   plans, queue task (`queue.mjs add`) for concrete, ready work. Show the proposal before writing anything.
2. Plan entries you create without the user's priority get `"priority": "owner"`, `"maturity": "idea"`,
   `"priority_set_by": "agent"` and a one-sentence `priority_reason`. Each entry needs an existing `project`
   (create projects first, from the user's answer about areas) and `sources` as `[{ "path": "<path>" }]`.
3. Queue tasks you add start as proposals; the user approves them with `queue.mjs approve <id>` or on the board.
4. Never copy document contents into the register; point to them with `sources`.

If no: leave the queue empty. The user can run `/add-to-queue` later.

## 7. Commit

The worktree agents only see committed files, so the installed scripts, skills, agents and docs must be committed
before the first parallel run. Commit with a pathspec, for example:

```
git add scripts/orchestrator .claude/skills .claude/agents .claude/settings.json docs/queue CLAUDE.queue.md queue.config.json .gitignore CLAUDE.md
git commit -m "chore: install claude-cowie-queue work queue" -- scripts/orchestrator .claude/skills .claude/agents .claude/settings.json docs/queue CLAUDE.queue.md queue.config.json .gitignore CLAUDE.md
```

Do not push unless the user asks.

## 8. Tell the user how to start

- `/start` for a short status at the start of a session.
- `/queue` to run this chat as the orchestrator.
- `/add-to-queue` to turn a request into queue tasks, `/plans` for plan work, `/pick` to do one task by hand.
- The board: `node scripts/orchestrator/cq.mjs board`.
