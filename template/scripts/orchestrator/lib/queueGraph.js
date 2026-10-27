// =============================================================
// queueGraph.js: pure logic for the "Dependencies" view on the kanban board.
//
// Draws the queue as circles (tasks) and rounded squares (owner questions) with strokes from predecessor to
// successor. Only the graph and the layout live here, no queue rules:
//   - buildGraph: which nodes and edges are shown. Input is the state from queueBoard.board (the cards already have
//     `ready`, `blockers`, `unlocks` and `chain` from queueLogic/queueBoard, and the inbox has the owner questions with
//     "unlocks N"), so no rule is copied here.
//   - layer: layered layout from left to right. Layers come from the longest path, the order in each layer from a few
//     barycenter sweeps (fewer crossings). Deterministic: the same graph gives the same image. Cycles are broken and reported.
//   - graphNumber: the summary at the top (tasks in chains, owner questions that block, longest chain).
//
// The file is both a CommonJS module (jest, scripts/lib/__tests__/queueGraph.test.ts) and a script in the browser
// (queue-board.mjs serves it as /queueGraph.js and it sets window.QueueGraph), so the client uses exactly the same code.
// The client computes the layout once per queue change and filter (cached on the version), never per drawing.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueGraph = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * The board columns whose tasks are part of the graph (proposed is not approved yet and stays outside).
   * The batch queue is included, with its own state ("batch") and its own badge, so the owner sees what in a chain is waiting on packing.
   */
  const COLUMNS = ['queue', 'batch', 'inProgress', 'review', 'built'];
  /** The id of a question node: "?" + the question's id (a task id can never start with "?"). */
  const SP = '?';

  /** Layout measures (pixels in the graph's own coordinates, before zoom). */
  const MEASURE = {
    makeDistance: 170, // between layers (x)
    gap: 20, // between two nodes in the same layer (y), with room for the label below
    margin: 40,
    laneTop: 30, // room for the lane title
    laneGap: 16, // between two lanes
    rMin: 7,
    rMax: 22,
    rSmall: 5, // finished predecessors and neighbors outside the filter
    rFree: 12, // largest circle in the grid of standalone tasks
    freeCell: 34,
    spSide: 26, // side of the question node
    compactPage: 30, // from the component's frame to the first and last layer (x), with room for the id below
    compactTop: 22, // above the top node in the component (the question's id sits above the square)
    compactBottom: 24, // below the bottom node (the id or "unlocks N")
    compactGap: 24, // between two components in the packing
    readablePx: 6, // smallest on-screen circle diameter (pixels) that counts as readable for "Customize"
  };

  /** Radius from estimated minutes: the area follows the minutes, with a min and max limit. */
  function radius(minutes) {
    const m = Number(minutes);
    const r = Math.sqrt(Number.isFinite(m) && m > 0 ? m : 0) * 2.2;
    return Math.round(Math.min(MEASURE.rMax, Math.max(MEASURE.rMin, r)) * 10) / 10;
  }

  /**
   * The state the ring shows: ready (solid), blocked (dashed), active (thick accent), qa (small dot), done, or
   * batch (in the batch queue: dotted ring and marked "S").
   */
  function stateFor(k, col) {
    if (k.status === 'done') return k.qa_status === 'waiting' ? 'qa' : 'done';
    if (col === 'batch') return 'batch';
    if (col === 'queue') return k.ready ? 'ready' : 'blocked';
    return 'active'; // running, picked, review, outside queue
  }

  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const edgeKey = (from, to) => `${from}\u0000${to}`;

  /**
   * The nodes and edges to show.
   * @param {object} data the state from queueBoard.board ({ columns, inbox, projects })
   * @param {{ visible?: (card: object, col: string) => boolean, showDone?: boolean, showStandalone?: boolean,
   *   neighbors?: boolean }} option
   *   `visible`: the search and filter menu on the board (the project filter is "per category"). `showDone`: finished predecessors
   *   as small, muted circles. `showStandalone`: tasks without dependencies as a grid at the end. `neighbors`:
   *   a predecessor or successor that the filter hides is shown as a small gray neighbor so the chain is not broken.
   * @returns {{ nodes: object[], edges: object[], projects: object[] }}
   *   Node: { id, art: 'task'|'question', role: 'core'|'neighbor'|'done'|'free', ... }.
   *   Edge: { from, to, art: 'dep'|'sp', muted }.
   */
  function buildGraph(
    data,
    { visible = () => true, showDone = false, showStandalone = false, neighbors = true } = {},
  ) {
    const perId = new Map();
    for (const col of COLUMNS)
      for (const k of data?.columns?.[col] ?? []) perId.set(k.id, { k, col });
    const isOpen = (x) => !!x && x.k.status !== 'done';

    // Edges into open tasks: predecessor → successor (unknown and cancelled predecessors are left out).
    const dep = [];
    const inChain = new Set();
    for (const [id, x] of perId) {
      if (!isOpen(x)) continue;
      for (const f of new Set(x.k.depends_on ?? [])) {
        if (f === id || !perId.has(f)) continue;
        dep.push({ from: f, to: id });
        inChain.add(f);
        inChain.add(id);
      }
    }
    // The owner questions from the inbox (open, with "unlocks N"), with edges to tasks that wait on them directly.
    const question = [];
    for (const s of data?.inbox?.question ?? []) {
      const to = [...new Set(s.direct ?? [])].filter((id) => isOpen(perId.get(id))).sort();
      if (!to.length) continue;
      question.push({ s, to });
      for (const id of to) inChain.add(id);
    }

    // The core: open tasks in a chain that the filter shows.
    const role = new Map();
    for (const [id, x] of perId)
      if (isOpen(x) && inChain.has(id) && visible(x.k, x.col)) role.set(id, 'core');
    // Neighbors (open, hidden by the filter) and finished predecessors, one edge away from the core.
    for (const { from, to } of dep) {
      const f = perId.get(from);
      if (role.get(to) === 'core' && !role.has(from)) {
        if (!isOpen(f)) {
          if (showDone) role.set(from, 'done');
        } else if (neighbors) role.set(from, 'neighbor');
      } else if (role.get(from) === 'core' && !role.has(to) && neighbors) role.set(to, 'neighbor');
    }
    if (showStandalone)
      for (const [id, x] of perId)
        if (isOpen(x) && !inChain.has(id) && visible(x.k, x.col)) role.set(id, 'free');

    const nodes = [];
    for (const [id, r] of role) {
      const { k, col } = perId.get(id);
      const small = r === 'neighbor' || r === 'done';
      nodes.push({
        id,
        art: 'task',
        role: r,
        state: stateFor(k, col),
        status: k.status,
        title: k.title ?? '',
        project: k.project ?? null,
        color: k.color ?? null,
        estimate: Number(k.estimate) || 0,
        locks: k.unlocks?.count ?? 0,
        r: small
          ? MEASURE.rSmall
          : r === 'free'
            ? Math.min(MEASURE.rFree, radius(k.estimate))
            : radius(k.estimate),
      });
    }
    const edges = [];
    for (const { from, to } of dep)
      if (role.has(from) && role.has(to))
        edges.push({ from, to, art: 'dep', muted: role.get(from) === 'done' });
    // A question is shown when at least one task in the core waits on it.
    for (const { s, to } of question) {
      if (!to.some((id) => role.get(id) === 'core')) continue;
      const id = SP + s.sp;
      nodes.push({
        id,
        art: 'question',
        role: 'core',
        sp: s.sp,
        type: s.type ?? 'question',
        text: s.text ?? null,
        title: s.text ?? s.sp,
        project: (s.projects ?? [])[0] ?? null,
        locks: Number(s.count) || 0,
        r: MEASURE.spSide / 2,
      });
      for (const t of to)
        if (role.has(t)) edges.push({ from: id, to: t, art: 'sp', muted: false });
    }
    nodes.sort((a, b) => compare(a.id, b.id));
    edges.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
    const projects = (data?.projects ?? []).map((p) => ({
      pid: p.pid,
      title: p.title ?? p.pid,
      color: p.color ?? null,
    }));
    return { nodes, edges, projects };
  }

  /**
   * Layers: topological order (Kahn) where a cycle is broken at the node with the fewest remaining in-edges (then lowest
   * id), and the longest path from the sources. A source without predecessors is pulled as far right as its successors allow
   * (a question sits right before the task that waits on it, not all the way to the left).
   * @returns {{ make: Map<string, number>, broken: Set<string> }}
   */
  function makeFor(ids, edges) {
    const input = new Map(ids.map((id) => [id, []]));
    const out = new Map(ids.map((id) => [id, []]));
    for (const { from, to } of edges) {
      if (!input.has(from) || !input.has(to)) continue;
      out.get(from).push(to);
      input.get(to).push(from);
    }
    const degree = new Map(ids.map((id) => [id, input.get(id).length]));
    const broken = new Set();
    const done = new Set();
    const sequence = [];
    let readyOnes = ids.filter((id) => degree.get(id) === 0);
    while (sequence.length < ids.length) {
      if (!readyOnes.length) {
        // Cycle: break the in-edges from the unprocessed nodes to one node, and continue from there.
        const rest = ids.filter((id) => !done.has(id));
        rest.sort((a, b) => degree.get(a) - degree.get(b) || compare(a, b));
        const v = rest[0];
        for (const f of input.get(v)) if (!done.has(f)) broken.add(edgeKey(f, v));
        degree.set(v, 0);
        readyOnes = [v];
      }
      const v = readyOnes.shift();
      if (done.has(v)) continue;
      done.add(v);
      sequence.push(v);
      for (const w of out.get(v)) {
        if (broken.has(edgeKey(v, w)) || done.has(w)) continue;
        degree.set(w, degree.get(w) - 1);
        if (degree.get(w) === 0) readyOnes.push(w);
      }
      readyOnes.sort(compare);
    }
    const make = new Map();
    for (const v of sequence) {
      let l = 0;
      for (const f of input.get(v)) if (!broken.has(edgeKey(f, v))) l = Math.max(l, make.get(f) + 1);
      make.set(v, l);
    }
    for (let i = sequence.length - 1; i >= 0; i--) {
      const v = sequence[i];
      const pred = input.get(v).filter((f) => !broken.has(edgeKey(f, v)));
      const after = out.get(v).filter((w) => !broken.has(edgeKey(v, w)));
      if (!pred.length && after.length) make.set(v, Math.min(...after.map((w) => make.get(w))) - 1);
    }
    return { make, broken };
  }

  /**
   * The coordinates. The graph is split into connected components (a chain: nodes linked by edges, regardless of
   * direction), and each component gets its own layered layout from left to right. The components are then packed in rows
   * ("shelf" packing), largest first, with a row width chosen so the whole image fits the view surface best
   * (`surface`: { width, height } in pixels, default 1600 × 800). Without the packing all sources stood in one tall column.
   * `mode`: 'combined' (everything in one) or 'project' (one lane per project in the board's lane order, stacked at full
   * width, with the same packing inside each lane). A component with several projects goes in the lane of the project with
   * the most nodes (gray neighbors do not count); the edges to the other projects' nodes then sit inside that lane.
   * @returns {{ nodes: object[], edges: object[], lanes: object[], components: object[],
   *   free: { y: number, count: number } | null, cycles: { from: string, to: string }[], countMake: number,
   *   width: number, height: number }}
   *   `readableScale`: smallest scale where most circles (90 % of the core) are at least MEASURE.readablePx; "Customize" fills
   *   the width and lets the rest scroll when the whole image cannot be shown that large.
   *   `nodes` are listed component by component (packing order), within each component in layer order (layer, then top down), and
   *   standalone last: the keyboard focus order. `make` is the layer within the component. `components` are the frames
   *   ({ x, y, width, height, count }) drawn as a discreet background.
   */
  function layer(graph, { mode = 'combined', surface = null } = {}) {
    const perLane = mode === 'project';
    const all = graph?.nodes ?? [];
    const inGraph = all.filter((n) => n.role !== 'free');
    const freeOnes = all.filter((n) => n.role === 'free');
    const perId = new Map(all.map((n) => [n.id, n]));
    const ids = inGraph.map((n) => n.id).sort(compare);
    const { make, broken } = makeFor(ids, graph?.edges ?? []);

    const laneSequence = new Map((graph?.projects ?? []).map((p, i) => [p.pid, i]));
    const laneFor = (id) => {
      const i = laneSequence.get(perId.get(id)?.project);
      return i == null ? laneSequence.size : i;
    };

    // The neighbors in both directions (broken cycle edges do not count for the order, but hold the component together), and
    // the components (union-find; the root is always the lowest id, so the split is deterministic).
    const pred = new Map(ids.map((id) => [id, []]));
    const after = new Map(ids.map((id) => [id, []]));
    const root = new Map(ids.map((id) => [id, id]));
    const find = (id) => {
      let r = id;
      while (root.get(r) !== r) r = root.get(r);
      root.set(id, r);
      return r;
    };
    for (const { from, to } of graph?.edges ?? []) {
      if (!pred.has(from) || !pred.has(to)) continue;
      const a = find(from);
      const b = find(to);
      if (a !== b) root.set(a < b ? b : a, a < b ? a : b);
      if (broken.has(edgeKey(from, to))) continue;
      after.get(from).push(to);
      pred.get(to).push(from);
    }
    const groups = new Map();
    for (const id of ids) {
      const r = find(id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(id);
    }

    // y: the nodes are stacked in the layer (radius + gap + radius).
    const stable = (ids) => {
      const ys = [];
      let y = 0;
      ids.forEach((id, i) => {
        const r = perId.get(id).r;
        if (i > 0) y += perId.get(ids[i - 1]).r + MEASURE.gap + r;
        ys.push(y);
      });
      const top = ids.length ? perId.get(ids[0]).r : 0;
      const bottom = ids.length ? ys[ys.length - 1] + perId.get(ids[ids.length - 1]).r : 0;
      return { ys, top, height: top + bottom };
    };

    // One component: layers (longest path, shifted so the component starts at layer 0), start order by project
    // (lane order) and id, four barycenter sweeps down (by predecessors) and up (by successors), and layers
    // centered vertically. The coordinates are local; the packing shifts them.
    const local = new Map();
    const addOut = (ids) => {
      const first = Math.min(...ids.map((id) => make.get(id)));
      const countMake = Math.max(...ids.map((id) => make.get(id))) - first + 1;
      const layers = Array.from({ length: countMake }, () => []);
      for (const id of ids) layers[make.get(id) - first].push(id);
      for (const l of layers) l.sort((a, b) => laneFor(a) - laneFor(b) || compare(a, b));
      const space = new Map();
      const updateSpace = (l) => l.forEach((id, i) => space.set(id, i - (l.length - 1) / 2));
      layers.forEach(updateSpace);
      // Equal values keep the previous order (stable sort).
      const swipe = (l, neighbors) => {
        const val = new Map();
        for (const id of l) {
          const n = neighbors.get(id);
          val.set(
            id,
            n.length ? n.reduce((s, x) => s + space.get(x), 0) / n.length : space.get(id),
          );
        }
        const previous = new Map(l.map((id, i) => [id, i]));
        l.sort((a, b) => val.get(a) - val.get(b) || previous.get(a) - previous.get(b));
        updateSpace(l);
      };
      for (let round = 0; round < 4; round++) {
        for (let i = 1; i < countMake; i++) swipe(layers[i], pred);
        for (let i = countMake - 2; i >= 0; i--) swipe(layers[i], after);
      }
      const stacks = layers.map(stable);
      const highest = Math.max(0, ...stacks.map((s) => s.height));
      layers.forEach((l, i) => {
        const s = stacks[i];
        const start = MEASURE.compactTop + (highest - s.height) / 2 + s.top;
        l.forEach((id, j) =>
          local.set(id, { x: MEASURE.compactPage + i * MEASURE.makeDistance, y: start + s.ys[j], make: i }),
        );
      });
      // The lane per project: the project with the most nodes (gray neighbors count only when there are no others).
      const tally = new Map();
      const countOf = (list) => {
        for (const id of list) tally.set(laneFor(id), (tally.get(laneFor(id)) ?? 0) + 1);
      };
      countOf(ids.filter((id) => perId.get(id).role !== 'neighbor'));
      if (!tally.size) countOf(ids);
      let lane = Infinity;
      for (const [b, n] of tally)
        if (lane === Infinity || n > tally.get(lane) || (n === tally.get(lane) && b < lane))
          lane = b;
      return {
        ids,
        countMake,
        lane: perLane ? lane : 0,
        width: 2 * MEASURE.compactPage + (countMake - 1) * MEASURE.makeDistance,
        height: MEASURE.compactTop + highest + MEASURE.compactBottom,
      };
    };
    // Largest first (nodes, then height), then lowest id: small chains end up last, in compact rows.
    const comps = [...groups.values()]
      .map(addOut)
      .sort(
        (a, b) =>
          b.ids.length - a.ids.length || b.height - a.height || compare(a.ids[0], b.ids[0]),
      );
    const used = [...new Set(comps.map((k) => k.lane))].sort((a, b) => a - b);
    const perGroup = used.map((b) => comps.filter((k) => k.lane === b));

    // Shelf packing with row width W: from left to right, a new row when the next one does not fit.
    const pack = (list, W) => {
      const space = [];
      let x = 0;
      let y = 0;
      let row = 0;
      let widest = 0;
      for (const k of list) {
        if (x > 0 && x + k.width > W) {
          y += row + MEASURE.compactGap;
          x = 0;
          row = 0;
        }
        space.push({ x, y });
        widest = Math.max(widest, x + k.width);
        x += k.width + MEASURE.compactGap;
        row = Math.max(row, k.height);
      }
      return { space, width: widest, height: list.length ? y + row : 0 };
    };
    const measure = (W) => {
      const packages = perGroup.map((g) => pack(g, W));
      const width = MEASURE.margin * 2 + Math.max(0, ...packages.map((p) => p.width));
      const height = perLane
        ? MEASURE.margin +
          packages.reduce((s, p) => s + MEASURE.laneTop + p.height + 2 * MEASURE.laneGap, 0) -
          MEASURE.laneGap
        : MEASURE.margin * 2 + (packages[0]?.height ?? 0);
      return { W, packages, width, height };
    };
    // The row width. The candidates grow geometrically from the widest component. The first choice is the one giving the largest
    // scale when the whole image is fitted to the surface (equal scale: narrowest). If the circles then become unreadable (scale
    // below `readableScale`), the lowest packing that still fills the width at a readable scale is chosen instead: "Customize"
    // then fills the width, and you scroll vertically.
    const fb = surface?.width > 0 ? surface.width : 1600;
    const fh = surface?.height > 0 ? surface.height : 800;
    const diameters = inGraph
      .filter((n) => n.role === 'core')
      .map((n) => 2 * n.r)
      .sort((a, b) => a - b);
    const readableScale =
      MEASURE.readablePx / (diameters[Math.floor(diameters.length * 0.1)] ?? 2 * MEASURE.rMin);
    let selected = null;
    if (comps.length) {
      const from = Math.max(...comps.map((k) => k.width));
      const to = Math.max(
        from,
        ...perGroup.map((g) => g.reduce((s, k) => s + k.width + MEASURE.compactGap, 0)),
      );
      const candidates = [];
      for (let W = from; ; W = Math.min(to, W * 1.08)) {
        candidates.push(measure(W));
        if (W >= to) break;
      }
      const inWidth = (m) => fb / (m.width + 20);
      const scale = (m) => Math.min(inWidth(m), fh / (m.height + 20));
      for (const m of candidates) if (!selected || scale(m) > scale(selected) * (1 + 1e-9)) selected = m;
      if (scale(selected) < readableScale) {
        const readable = candidates.filter((m) => inWidth(m) >= readableScale);
        selected = readable.length
          ? readable.reduce((a, m) => (m.height < a.height - 1e-9 ? m : a))
          : candidates[0];
      }
    }

    // Shift each component to its place (per project: inside the lane, lane below lane).
    const pos = new Map();
    const components = [];
    const lanes = [];
    const sequence = [];
    const width = selected ? selected.width : 0;
    const place = (k, ox, oy) => {
      components.push({ x: ox, y: oy, width: k.width, height: k.height, count: k.ids.length });
      const ids = [...k.ids].sort(
        (a, b) =>
          local.get(a).make - local.get(b).make ||
          local.get(a).y - local.get(b).y ||
          compare(a, b),
      );
      for (const id of ids) {
        const p = local.get(id);
        pos.set(id, { x: ox + p.x, y: oy + p.y, make: p.make });
        sequence.push(id);
      }
    };
    let height = 0;
    if (selected && !perLane) {
      perGroup[0].forEach((k, i) =>
        place(k, MEASURE.margin + selected.packages[0].space[i].x, MEASURE.margin + selected.packages[0].space[i].y),
      );
      height = selected.height;
    } else if (selected) {
      let y = MEASURE.margin / 2;
      used.forEach((b, gi) => {
        const pk = selected.packages[gi];
        perGroup[gi].forEach((k, i) =>
          place(k, MEASURE.margin + pk.space[i].x, y + MEASURE.laneTop + pk.space[i].y),
        );
        const p = (graph?.projects ?? [])[b];
        const h = MEASURE.laneTop + pk.height + MEASURE.laneGap;
        lanes.push({
          pid: p?.pid ?? null,
          title: p ? p.title : 'No known project',
          color: p?.color ?? null,
          y,
          height: h,
        });
        y += h + MEASURE.laneGap;
      });
      height = y + MEASURE.margin / 2;
    }

    // Standalone: a compact grid below the graph, sorted by project (lane order) and id.
    let free = null;
    const freeSequence = [...freeOnes].sort(
      (a, b) => laneFor(a.id) - laneFor(b.id) || compare(a.id, b.id),
    );
    let freeWidth = 0;
    if (freeSequence.length) {
      const columns = Math.max(12, Math.floor(Math.max(width, 600) / MEASURE.freeCell));
      const top = height + MEASURE.laneTop;
      freeSequence.forEach((n, i) => {
        pos.set(n.id, {
          x: MEASURE.margin + (i % columns) * MEASURE.freeCell,
          y: top + MEASURE.freeCell / 2 + Math.floor(i / columns) * MEASURE.freeCell,
          make: null,
        });
      });
      const rows = Math.ceil(freeSequence.length / columns);
      free = { y: height, count: freeSequence.length };
      freeWidth = MEASURE.margin * 2 + Math.min(columns, freeSequence.length) * MEASURE.freeCell;
      height = top + rows * MEASURE.freeCell + MEASURE.margin;
    }

    const nodes = sequence
      .map((id) => ({ ...perId.get(id), ...pos.get(id) }))
      .concat(freeSequence.map((n) => ({ ...n, ...pos.get(n.id) })));
    const edges = (graph?.edges ?? [])
      .filter((k) => pos.has(k.from) && pos.has(k.to))
      .map((k) => ({ ...k, cycle: broken.has(edgeKey(k.from, k.to)) }));
    const cycles = edges.filter((k) => k.cycle).map((k) => ({ from: k.from, to: k.to }));
    return {
      nodes,
      edges,
      lanes,
      components,
      free,
      cycles,
      countMake: Math.max(0, ...comps.map((k) => k.countMake)),
      readableScale,
      width: Math.max(width, freeWidth),
      height,
    };
  }

  /**
   * The summary at the top: "N tasks in chains · M owner questions block K tasks · longest chain L steps".
   *   - tasks: tasks in the core (in a chain, shown by the filter),
   *   - question / blockedByQuestion: the question nodes and the core tasks they hold back, directly or via
   *     the chain,
   *   - longestChain: the most open tasks in a row along dependencies (cycles are tolerated),
   *   - blocked: core tasks that are not ready now.
   */
  function graphNumber(graph) {
    const nodes = graph?.nodes ?? [];
    const edges = graph?.edges ?? [];
    const perId = new Map(nodes.map((n) => [n.id, n]));
    const openTask = (n) =>
      n?.art === 'task' && (n.role === 'core' || n.role === 'neighbor');
    const out = new Map();
    for (const k of edges) {
      if (!out.has(k.from)) out.set(k.from, []);
      out.get(k.from).push(k.to);
    }
    // What the questions hold back: everything reachable from them along the edges (open tasks).
    const held = new Set();
    const stack = nodes.filter((n) => n.art === 'question').map((n) => n.id);
    while (stack.length) {
      const v = stack.pop();
      for (const w of out.get(v) ?? []) {
        if (held.has(w) || !openTask(perId.get(w))) continue;
        held.add(w);
        stack.push(w);
      }
    }
    // Longest chain: depth-first with memoization; an edge back to a node on the path (cycle) is skipped.
    const length = new Map();
    const onPath = new Set();
    const longest = (v) => {
      if (length.has(v)) return length.get(v);
      onPath.add(v);
      let best = 0;
      for (const w of out.get(v) ?? [])
        if (!onPath.has(w) && openTask(perId.get(w))) best = Math.max(best, longest(w));
      onPath.delete(v);
      length.set(v, best + 1);
      return best + 1;
    };
    let longestChain = 0;
    for (const n of [...nodes].sort((a, b) => compare(a.id, b.id)))
      if (openTask(n)) longestChain = Math.max(longestChain, longest(n.id));
    const core = nodes.filter((n) => n.art === 'task' && n.role === 'core');
    return {
      tasks: core.length,
      question: nodes.filter((n) => n.art === 'question').length,
      blockedByQuestion: [...held].filter((id) => perId.get(id)?.role === 'core').length,
      longestChain,
      blocked: core.filter((n) => n.state === 'blocked').length,
    };
  }

  /**
   * The critical path, i.e. the heaviest path along the edges (predecessor → successor) measured as the sum of
   * the nodes' weights. Used by the dependency view in the Plans room (plan entries with size as weight), but is general.
   *   - `with(n)`: whether the node may be on the path (e.g. only open entries). Other nodes cut it off: the path never goes
   *     through them.
   *   - `weight(n)`: the node's weight (number ≥ 0).
   * Cycles are tolerated: an edge back to a node on the path is skipped (like `longestChain` in graphNumber). Deterministic:
   * on an equal sum the path with the most nodes wins, then the lowest id (nodes and successors are walked in id order).
   * @returns {{ path: string[], sum: number, edges: string[] }} `edges` is "from>to" for the edges on the path.
   */
  function criticalPath(nodes, edges, { with: withId = () => true, weight = () => 1 } = {}) {
    const perId = new Map((nodes ?? []).map((n) => [n.id, n]));
    const ok = (id) => perId.has(id) && withId(perId.get(id));
    const out = new Map();
    for (const k of edges ?? []) {
      if (!ok(k.from) || !ok(k.to) || k.from === k.to) continue;
      if (!out.has(k.from)) out.set(k.from, new Set());
      out.get(k.from).add(k.to);
    }
    const v = (id) => {
      const x = Number(weight(perId.get(id)));
      return Number.isFinite(x) && x > 0 ? x : 0;
    };
    // Best path from each node: { sum, ids }. Depth-first with memoization; nodes on the path are skipped (cycles).
    const memory = new Map();
    const onPath = new Set();
    const better = (a, b) =>
      !b ||
      a.sum > b.sum + 1e-9 ||
      (Math.abs(a.sum - b.sum) <= 1e-9 &&
        (a.ids.length > b.ids.length ||
          (a.ids.length === b.ids.length && a.ids.join('\u0000') < b.ids.join('\u0000'))));
    const bestOne = (id) => {
      if (memory.has(id)) return memory.get(id);
      onPath.add(id);
      let best = null;
      for (const w of [...(out.get(id) ?? [])].sort(compare)) {
        if (onPath.has(w)) continue;
        const b = bestOne(w);
        if (better(b, best)) best = b;
      }
      onPath.delete(id);
      const answer = { sum: v(id) + (best?.sum ?? 0), ids: [id, ...(best?.ids ?? [])] };
      memory.set(id, answer);
      return answer;
    };
    let winner = null;
    for (const id of [...perId.keys()].filter(ok).sort(compare)) {
      const b = bestOne(id);
      if (better(b, winner)) winner = b;
    }
    if (!winner) return { path: [], sum: 0, edges: [] };
    const filePath = winner.ids;
    return {
      path: filePath,
      sum: Math.round(winner.sum * 100) / 100,
      edges: filePath.slice(1).map((to, i) => `${filePath[i]}>${to}`),
    };
  }

  return { COLUMNS, SP, MEASURE, radius, buildGraph, layer, graphNumber, criticalPath };
});
