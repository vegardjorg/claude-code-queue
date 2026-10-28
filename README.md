<p align="center"><img src="assets/logo.webp" alt="claude-cowie-queue logo" width="160"></p>

# claude-cowie-queue

A work queue, a plan register and a local board for running **Claude Code as an orchestrator** with parallel
subagents. One chat plans and coordinates; each task runs as a track agent in its own git worktree, on its own
branch, with a small self-contained mission. Results are reviewed, merged and pushed in batches. Sessions stay
small, so the token bill stays small.

I built it so I can remote control from my phone, and control a large project. I check the queue dashbord daily. Its kanban inspired.
Claude code works on all the tasks I have queued, often hundreds, and I leave it on overnight. It also tracks all my plans. 
In the morning I answer any questions an make decisions. 
I optimized it, with context window and task size, and from my not ideal earlier working style, it cut spend by a lot. 
This runs for 5 days, until my max(x20) is out of tokens. Mileage may vary on smaller projects with smaller budgets. 


By Vegard Cowie Jørgensen.

## What you get

- **Work queue** (`scripts/orchestrator/queue.mjs`): tasks with class, estimate, value, dependencies, owner questions
  and exclusive file ownership. Limits for parallel tracks, per domain and per day. Survives compaction and restarts
  because it lives on disk, not in the chat.
- **Plan register** (`queue.mjs plan …`): ideas, plans and investigations with priority and maturity, pointing to your
  documents. Plans become queue tasks when they are ready.
- **Board** (`scripts/orchestrator/queue-board.mjs`): a local web board for the queue, projects, plans, dependencies
  and measured cost.
- **Track tooling**: worktree setup (`prepare-track.mjs`), mission generation from a template (`make-mission.mjs`),
  review packages (`queue.mjs receive`), merging (`merge-track.mjs`), safe worktree cleanup (`cleanup-worktree.mjs`) and a
  pre-push check (`push-check.mjs`).
- **Hooks** for Claude Code: context guards for the orchestrator and for tracks, a reading guard, a push guard,
  re-injection of queue state after compaction, and a time and cost log for subagents.
- **Skills**: `/queue`, `/parallel-wave`, `/add-to-queue`, `/plans`, `/pick`, `/start`.
- **Agents**: `track` (code and investigation tracks), `track-d` (database and security tracks), `reviewer` and
  `reviewer-security`.

## Install

Clone or download this repository, open Claude Code in YOUR project and say:

> Install claude-cowie-queue from `<path-to-this-repo>`; follow its INSTALL.md.

Claude Code then runs `node scripts/install.mjs <your-project>`, merges the hooks and settings into your
`.claude/settings.json` without overwriting anything, configures `queue.config.json` with you, runs
`queue.mjs init` and a smoke test, and asks whether it should turn your own notes, TODOs and issues into plan entries
and queue tasks. See [INSTALL.md](INSTALL.md).

Requirements: Node.js 20 or newer, git, Claude Code. No runtime npm dependencies.

## How it works

```
 owner ──> orchestrator chat (/queue) ──> queue.mjs fill ──> track agents in worktrees (queue/<ID> branches)
                 ^                                            │
                 │                                   RESULT line + report.md
                 │                                            v
        owner questions <── review (reviewer agents) <── queue.mjs receive
                 │
                 └──> queue.mjs merge ──> base branch ──> batch push when the owner says "push"
```

1. Plans go into the plan register. Ready work goes into the queue as tasks with a class: **K** (code),
   **D** (database), **D+** (high-risk database or security) or **U** (investigation).
2. The orchestrator fills the queue up to the limits. Each task gets a mission file: the shared protocol from
   `docs/queue/mission-template.md`, filtered for its class, plus the task's own block.
3. Each track works in its own worktree, commits only on its own branch, and answers with one machine-readable
   result line. The long report goes to a file, not into the orchestrator's context.
4. The orchestrator builds a review package, runs the reviewer agents for the class, starts a fresh fix-round agent
   when needed, merges, and asks the owner the questions that need a human.
5. Pushes happen in batches, never per commit.

Details: [docs/orchestration.md](docs/orchestration.md), [docs/queue.md](docs/queue.md),
[docs/plan-register.md](docs/plan-register.md), [docs/board.md](docs/board.md),
[docs/mission-template.md](docs/mission-template.md).

## Key commands

```
node scripts/orchestrator/queue.mjs init                     # once per project
node scripts/orchestrator/queue.mjs show                      # short queue view
node scripts/orchestrator/queue.mjs add --file task.json      # add tasks
node scripts/orchestrator/queue.mjs fill --scratchpad <dir>  # start what the limits allow
node scripts/orchestrator/queue.mjs receive <ID>               # receive a finished track
node scripts/orchestrator/queue.mjs merge <ID>               # merge it
node scripts/orchestrator/queue.mjs cost                     # measured cost per class
node scripts/orchestrator/queue.mjs plan show                 # plan register
node scripts/orchestrator/queue-board.mjs                    # board on http://localhost:2000
```

## What it costs in tokens

Every turn in Claude Code re-sends the whole conversation (mostly served from the prompt cache). The cost of a turn
therefore grows with the size of the context, and the cost of a session grows roughly with **turns times context**.
That is the single fact this system is built around.

The numbers below are aggregated from one real project that used this system for a few months, about 1,200
measured tasks. Costs are API-equivalent USD computed from token counts (on a subscription you pay a flat fee; the
numbers show relative consumption). Where a number is an estimate, it says so.

**1. Before: one long chat.** Everything happens in one conversation that grows past several hundred thousand
tokens. Each new message pays for the whole history again. In the measured project, one message at over 500k
context cost close to three times as much as the same message at 100k to 200k, and a long orchestrator session once
reached about 966k context before it stalled. Per task this is the most expensive way to work (estimate: several
times the cost of the approaches below, growing with session length), and quality drops as the context fills.

**2. Many small chats.** Starting a fresh chat per task keeps the context small, but each chat pays a fixed
start-up cost (reading the project, finding the right files, running checks), and coordination happens in your head:
no shared queue, no exclusive ownership, no review step, merge conflicts when chats overlap. Cheaper per turn than
one long chat, but the fixed cost is paid again and again (estimate; not measured separately).

**3. This system: orchestrator + queue + self-contained missions + tracks in worktrees + compaction + handover.**
Measured median cost per finished task, including its review:

| Class | Median USD (API-equivalent) | Average | Median tokens (mostly cache reads) | Median turns |
|---|---|---|---|---|
| K (code) | about 2.5 | about 3.1 | about 10M | about 60 |
| D (database) | about 5.1 | about 5.7 | about 25M | about 105 |
| D+ (high-risk) | about 7.5 | about 8.8 | about 36M | about 137 |
| U (investigation) | about 1.8 | about 2.1 | about 6.5M | about 42 |

On top of that the orchestrator spent about 18 turns and about 0.75 USD per task before its own turn count was
reduced (the target is 10 turns or fewer).

What the measurements taught, and what the hooks and rules now enforce:
- Turns taken while a track's context was above about 300k accounted for about 61% of track cost. Hence the
  context cap: at about 300k a track commits, writes a handover note and stops; a fresh agent continues.
- Prompt cache expiry while waiting accounted for about 23% of all usage. Hence no sleep or poll loops, and a
  1-hour cache TTL for subagents.
- Fix rounds sent to an agent that already held 400k to 900k context cost 35 to 38% of track cost. Hence fix
  rounds always start a NEW agent with a short, targeted mission.
- Fixed overhead per track (setup, reading, gates, report) was about 60% of a small K track, 30 to 35% of a D track
  and about 40% of a D+ track. Hence tracks are sized by class (K 90 to 120 min, D about 40, D+ 25 to 30, U about
  60) and similar small tasks can be bundled.

The exact numbers will differ in your project. `queue.mjs cost` measures your own sessions so you can see where the
tokens go.

## The talking mascot

The mascot in the board's top-left corner comments in a speech bubble on the night, the queue's numbers and events
(merged, queue empty, new owner question). To turn it off:
- per browser: the gear menu, **Mascot**: Chatty, Events only or Off;
- for everyone: `"board": { "mascot": "off" }` in `queue.config.json`, or `queue-board.mjs --mascot off`.

Your own phrases go in the gitignored `<dataFolder>/mascot-phrases.json`. See [docs/board.md](docs/board.md#the-mascot).

## Not included

This repository is the queue system only. It deliberately leaves out:
- **CI/CD**: no GitHub workflows, no CI gates and no CI scripts. The gates the tracks run are whatever you put in
  `queue.config.json` (`gates.quick`, `gates.full`). The unit tests in this repository run locally (`npm test`).
- **Screenshot and visual check tooling**: tasks can carry the label `visual` and land on a manual QA list
  (`queue.mjs qa`), but there is no screenshot capture.
- **Project-specific database tooling** (local database pools, probe runners, migration dry runs). Migration block
  numbering is optional and configured in `queue.config.json`.

## Development

```
npm install
npm test        # vitest, runs the unit tests under template/scripts/orchestrator
```

## License

MIT. See [LICENSE](LICENSE).

## About the logo

The logo is a self-roast of the author in the style of Leisure Suit Larry, one of his first computer games (played
in the same era as Commander Keen and Chuck Yeager's flight trainer). It is an original drawing and is not affiliated
with or endorsed by the owners of those games.

Keeping the logo in the top-left corner of the board is a friendly request, not a license condition. You are welcome
to restyle it.

Ken sent me.
