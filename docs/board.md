# The board (`queue-board.mjs`)

A local web board for the queue and the plan register. It reads the same JSON files as `queue.mjs` and writes through
the same functions (same lock, same validation, same undo), so the board and the chat never disagree.

```
node scripts/orchestrator/queue-board.mjs            # http://localhost:2000 (port from queue.config.json board.port)
```

It listens on localhost only. There is no login; do not expose the port.

## What it shows

- **Queue:** columns per status (proposal, waiting, running, review, done), with class, estimate, value, blockers and
  owner questions. Cards can be approved, parked, edited and reordered.
- **Projects and areas:** progress, remaining minutes, focus period.
- **Plans:** the plan register by module and priority, with sources and the "working now" marker.
- **Graph:** dependencies between tasks.
- **Cost:** measured cost per class and per task (API-equivalent USD and tokens), and the capacity estimate.
- **QA list:** done tasks with the label `visual` that wait for the owner's manual check (`qa ok` / `qa deviation`).

## Logo

The picture in the upper-left corner is loaded from `<dataFolder>/logo.webp` if it exists, otherwise from
`scripts/orchestrator/queue-board/logo.webp`. Keeping the picture there is a friendly request, not a license
condition (see "About the logo" in the README).
