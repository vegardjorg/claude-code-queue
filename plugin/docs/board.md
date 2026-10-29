# The board (`queue-board.mjs`)

A local web board for the queue and the plan register. It reads the same JSON files as `cq` and writes through
the same functions (same lock, same validation, same undo), so the board and the chat never disagree.

```
cq board            # prints the link, e.g. http://127.0.0.1:2000/#key=… (port: board.port)
```

How to start it:
- **In Claude Code:** `/cq:board`, or ask Claude to start the board. It runs `cq board` in the background (never in
  the foreground: it is a server and would block the chat) and gives you the link. It stops with the session.
- **From your own terminal** (keeps running on its own): in the project folder,
  `node "<plugin folder>/scripts/orchestrator/cq.mjs" board`. `cq` itself is only on the PATH inside Claude Code;
  `/cq:board` prints the full path. In a vendored install: `node scripts/orchestrator/cq.mjs board`.

It listens on 127.0.0.1 only. There is no user login, but every request needs the key in the printed link,
and the key changes on every restart (an old tab then says "The key is old": open the new link). Do not expose
the port.

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

## The mascot

The mascot in the upper-left corner now and then says something in a speech bubble: a night line when you work
between 00:00 and 05:00, encouragement, a statistic from the queue (the priciest task today, the oldest card in
Review, proposals waiting, and so on), and events between two polls (merged, queue empty, new owner question, high
finding, weekly quota over 90 %). Click the mascot for a line; five clicks within ten seconds gives another one.

Timing rules: a night line at most every 30 minutes, random chat at most every 10 minutes, events at most one per
minute. A line is never repeated within the last 8. The bubble stays 10 seconds (longer while the mouse is over it)
and closes on click. The text is always set as plain text.

**Modes.** The gear menu has a **Mascot** choice: **Chatty** (everything), **Events only** (only events and clicks)
or **Off** (no bubbles at all). The choice is remembered in this browser, like the theme. The default for every
browser comes from `queue.config.json`:

```json
"board": { "port": 2000, "title": "Queue board", "mascot": "chatty" }
```

`cq board --mascot off` overrides it for one run. With `"off"` from the config or
the flag, the mascot is off for every viewer: no bubbles, no click, nothing is computed on the server, and the choice
in the gear is locked.

**Hiding the picture.** Off keeps the picture. To remove the mascot completely in one browser, type the password in
**Hide the mascot completely** in the gear (the hint is there; case, spaces and punctuation do not matter).
**Show the mascot again** in the same place brings it back.

**Your own phrases.** The board ships the mascot's full built-in repertoire (night owl jabs, encouragement, stats roasts, events and vibe-coding jokes) in `lib/queueMascot.js`. To use your own, put
`mascot-phrases.json` in the queue's data folder (`<dataFolder>`, default `scripts/.queue/`, which the installer adds
to `.gitignore`, so your phrases never end up in git). Categories you leave out keep the built-in phrases; an
invalid file falls back to the built-in set and prints one line in the board's terminal.

```json
{
  "version": 1,
  "night": [{ "text": "It is {time}. Go to bed." }],
  "encouragement": [{ "text": "{done_today} done today.", "weight": 2 }],
  "statistics": [{ "text": "{id} cost ${cost} today.", "source": "priciest" }],
  "events": [{ "text": "Merged {id}!", "event": "merged" }],
  "vibe": [{ "text": "Another round. Onward." }]
}
```

- `weight` (optional, up to 10) makes a phrase more likely within its category.
- Placeholders that every phrase can use: `{time}`, `{done_today}`, `{done_week}`, `{days}` (days without a high
  finding), `{night_cost}`, `{n}` (answers after midnight) and `{p}` (weekly quota in percent, only with a calibrated
  quota). A phrase whose placeholder has no value right now is skipped.
- Statistics phrases take their values from a `source`: `priciest` ({id}, {cost}), `fixRounds` ({id}, {n}), `inbox`
  ({hours}), `review` ({id}, {hours}), `nightShare` ({share}), `proposed` ({n}), `qa` ({n}), `record` ({n}),
  `responseTime` ({min}), `remaining` ({n}, {date}) and `dPlus` ({min}). Without `source` it is guessed from the words
  in the text.
- Events: `merged` ({id}), `queue-empty`, `new-question`, `high-finding` ({id}), `quota-90` ({p}), `click` and
  `click-5`.
- Vibe phrases get a higher chance for 15 minutes after a D/D+ review is merged or a fix round starts.
