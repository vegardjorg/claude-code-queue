---
name: board
description: Start the local queue board (kanban, plans, dependencies, statistics, "Waiting on you") for the current project and give the user the link. Use when the user types "/cq:board", "start the board", "open the board", "show me the queue board", or asks how to see the board.
---

# Start the board

The board is a small local web server (`cq board`). It keeps running until it is stopped, so it must never run in
the foreground: that would block this chat until the command times out.

1. Check that the project has the queue: `queue.config.json` in the project root. If not, offer `/cq:setup` and stop.
2. Start it with the Bash tool **in the background** (`run_in_background: true`):

   ```
   cq board
   ```

   Add `--port <n>` only if the user asks for another port (default: `board.port` in `queue.config.json`, else 2000).
3. Read the command's output until it prints the link, `http://127.0.0.1:<port>/#key=…`. Give the user the whole
   link. The key is part of it and changes on every start; a tab with an old key says "The key is old".
4. Tell the user in two short lines:
   - the board runs while this Claude Code session runs; ask again, or run `/cq:board`, to restart it;
   - to run it from their own terminal instead (it then keeps running after Claude Code closes), from the project
     folder: `node "<plugin root>/scripts/orchestrator/cq.mjs" board`. Find `<plugin root>` with
     `dirname "$(dirname "$(command -v cq)")"` in the Bash tool and give them the full command, not the placeholder.

If the port is taken, say so and offer to start on another port with `--port`. Do not stop a process you did not
start.
