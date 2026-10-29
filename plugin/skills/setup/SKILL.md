---
name: setup
description: Set up the current project for the work queue (claude-code-queue plugin): queue.config.json, docs, CLAUDE.queue.md, .gitignore, recommended settings, the empty queue, a smoke test, and optionally the user's own TODOs and plans as queue entries. Use when the user types "/cq:setup", "set up the queue", "install the queue in this project", or when a queue command says there is no queue.config.json.
disable-model-invocation: true
---

# /cq:setup: set up this project for the work queue

You set up the CURRENT project. Ask the user where a step says ASK. Do not push anything.
Extra instructions from the user: **$ARGUMENTS** (empty = none).

## 0. Check

- `node --version` is 20 or newer, and the project is a git repository with at least one commit. Note the main
  integration branch (often `main`, sometimes `develop` or `staging`).
- `cq help` works. If `cq` is not found, the plugin's `bin/` folder is not on PATH in this shell: use
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator/cq.mjs"` instead of `cq` in every step below.
- If `queue.config.json` already exists, the project is set up: say so, run `cq show`, and stop unless the user asks
  for more.

## 1. Write the project files

Show the plan first: `cq setup --dry`. Then ASK the user two things in one question:
- may it add the line `@CLAUDE.queue.md` to `CLAUDE.md` (the queue's rules for Claude: batch push, pathspec commits,
  worktree rules)?
- may it add the recommended settings to `.claude/settings.json` (it lists them: a 1 hour prompt cache for subagents,
  compaction at 300k context, worktrees from HEAD)? A plugin cannot set these itself. They matter for cost, but they
  apply to the whole project, so it is the user's call.

Then run `cq setup` with `--claude-md` and/or `--settings` for what the user said yes to. Nothing existing is replaced.

## 2. Configure `queue.config.json`

Fill in, asking the user where you are not sure:
- `projectName`: a short name. `baseBranch`: the integration branch tracks branch from and merge into.
- `gates.quick` and `gates.full`: the project's real check commands (type check, lint, tests). Read `package.json`
  scripts (or the equivalent for the stack) and propose them; empty lists are allowed (gates then pass trivially).
- `migrations`: only if the project has numbered database migrations. Otherwise leave `folder` as `null`.
- `modules`: ASK which areas the product has (for example "auth", "billing", "mobile"); use the answer for `modules`
  and `projectModuleSuggestion`.
- `reviewers`, `board.port`, `board.title`: the defaults are fine to start with.

Keys starting with `_` or `$` are comments.

## 3. Create the queue and smoke test it

```
cq init
cq plan modules
cq add --json '{"id":"EX-1","title":"Demo task","domain":"demo","class":"U","project":"example","feature":"Demo","mission":"Write a one-paragraph note about the repository layout.","value":5,"content_min":60}'
cq show
cq next
cq set EX-1 cancelled
```

`init` creates the queue in `scripts/.queue/` (gitignored) with one example project `example` (prefix `EX-`); offer to
rename it with `cq project`. Then tell the user they can open the board with `/cq:board` (Claude starts it in the background
and gives a URL with an access key; never stop it by killing node by name).

## 4. Bring in the user's own work

ASK: "Do you want me to look through your own notes, TODOs and plans (for example `docs/`, `TODO.md`, `ROADMAP.md`,
TODO/FIXME comments, and GitHub issues if `gh` is available) and add them as plan entries or queue tasks?"

If yes:
1. List what you found (file, short title) and propose for each: plan entry (`cq plan new`) for ideas and larger
   plans, queue task (`cq add`) for concrete, ready work. Show the proposal before writing anything.
2. Plan entries without the user's priority get `"priority": "owner"`, `"maturity": "idea"`,
   `"priority_set_by": "agent"` and a one-sentence `priority_reason`. Each entry needs an existing `project` (create
   projects first, from the user's answer about areas) and `sources` as `[{ "path": "<path>" }]`.
3. Queue tasks you add start as proposals; the user approves them with `cq approve <id>` or on the board.
4. Never copy document contents into the register; point to them with `sources`.

## 5. Commit

The track agents work in git worktrees and only see committed files, so commit the project files before the first
parallel run, with a pathspec:

```
git add queue.config.json docs/queue CLAUDE.queue.md .gitignore
git commit -m "chore: set up the claude-code-queue work queue" -- queue.config.json docs/queue CLAUDE.queue.md .gitignore
```

Add `CLAUDE.md` and `.claude/settings.json` to both lists when step 1 changed them. Do not push unless the user asks.

## 6. Tell the user how to start

- `/cq:queue` runs this chat as the orchestrator; `/cq:add-to-queue` turns a request into queue tasks; `/cq:plans`
  is plan work; `/cq:pick` does one task by hand.
- `/cq:board` starts the board and gives the link; `cq help` lists every command.
