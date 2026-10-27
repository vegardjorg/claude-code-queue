// =============================================================
// queueGraph.test.ts: the "Dependencies" view on the kanban board (lib/queueGraph.js).
//
// The tests prove that the graph:
//   - shows only tasks in a dependency (or waiting on an owner question), with standalone and finished as options,
//   - keeps the chain whole with gray neighbors when the filter hides a predecessor or successor,
//   - has owner questions as their own nodes with edges to the tasks waiting on them,
//   - layers from left to right (longest path), orders layers by barycenter and is deterministic,
//   - tolerates cycles (reported, no hang), and puts each project in its own lane per project,
//   - counts the summary correctly.
// Input is the shape queueBoard.board gives; a separate test builds the state with queueBoard.board from a small queue.
// =============================================================
import { describe, it, expect } from 'vitest';

type Node = {
  id: string;
  art: 'task' | 'question';
  role: 'core' | 'neighbor' | 'done' | 'free';
  state?: string;
  project: string | null;
  locks: number;
  r: number;
  x: number;
  y: number;
  make: number | null;
  type?: string;
};
type Edge = { from: string; to: string; art: 'dep' | 'sp'; muted: boolean; cycle?: boolean };
type Graph = { nodes: Node[]; edges: Edge[]; projects: { pid: string }[] };
type Setup = {
  nodes: Node[];
  edges: Edge[];
  lanes: { pid: string | null; title: string; y: number; height: number }[];
  components: Frame[];
  free: { y: number; count: number } | null;
  cycles: { from: string; to: string }[];
  countMake: number;
  readableScale: number;
  width: number;
  height: number;
};
type Frame = { x: number; y: number; width: number; height: number; count: number };
type Summary = {
  id: string;
  status?: string;
  ready?: boolean;
  depends_on?: string[];
  project?: string;
  estimate?: number;
  title?: string;
  qa_status?: string;
  unlocks?: { count: number } | null;
};

const G = require('../queueGraph') as {
  SP: string;
  MEASURE: { rMin: number; rMax: number; rSmall: number };
  radius: (m: number) => number;
  buildGraph: (
    data: unknown,
    option?: {
      visible?: (k: Summary, col: string) => boolean;
      showDone?: boolean;
      showStandalone?: boolean;
      neighbors?: boolean;
    },
  ) => Graph;
  layer: (
    g: Graph,
    option?: { mode?: 'combined' | 'project'; surface?: { width: number; height: number } },
  ) => Setup;
  graphNumber: (g: Graph | Setup) => {
    tasks: number;
    question: number;
    blockedByQuestion: number;
    longestChain: number;
    blocked: number;
  };
};

/** The state as queueBoard.board gives it: the cards in columns, the inbox and projects. */
function data(
  summary: (Summary & { col?: string })[],
  question: { sp: string; direct: string[]; count?: number; type?: string }[] = [],
  projects = ['a', 'b'],
) {
  const columns: Record<string, Summary[]> = {
    queue: [],
    proposed: [],
    inProgress: [],
    review: [],
    built: [],
  };
  for (const { col, ...k } of summary) {
    const status = k.status ?? 'waiting';
    const column =
      col ??
      (status === 'done'
        ? 'built'
        : status === 'waiting'
          ? 'queue'
          : status === 'review'
            ? 'review'
            : 'inProgress');
    columns[column].push({
      project: 'a',
      estimate: 40,
      title: `Title ${k.id}`,
      ready: !(k.depends_on ?? []).length,
      depends_on: [],
      ...k,
      status,
    });
  }
  return {
    columns,
    inbox: {
      question: question.map((s) => ({ type: 'question', count: s.direct.length, ...s })),
    },
    projects: projects.map((pid) => ({
      pid,
      title: `Project ${pid}`,
      color: 'category-teal',
    })),
  };
}

const ids = (g: { nodes: Node[] }) => g.nodes.map((n) => n.id).sort();
const node = (g: { nodes: Node[] }, id: string) => g.nodes.find((n) => n.id === id) as Node;

describe('buildGraph: which tasks are shown', () => {
  const d = data([
    { id: 'A' },
    { id: 'B', depends_on: ['A'] },
    { id: 'C', depends_on: ['B'] },
    { id: 'F' }, // standalone
    { id: 'D', status: 'done' },
    { id: 'E', depends_on: ['D'] },
    { id: 'Q' }, // waits on an owner question, otherwise standalone
  ]);
  d.inbox.question.push({ sp: 'SP-1', direct: ['Q'], count: 1, type: 'lawyer' });

  it('default: only tasks in a dependency or waiting on a question; finished and standalone hidden', () => {
    const g = G.buildGraph(d);
    expect(ids(g)).toEqual(['?SP-1', 'A', 'B', 'C', 'E', 'Q']);
    expect(g.edges.filter((k) => k.art === 'dep').map((k) => `${k.from}>${k.to}`)).toEqual([
      'A>B',
      'B>C',
    ]);
  });

  it('"Show finished": finished predecessors as small, muted circles with a muted edge', () => {
    const g = G.buildGraph(d, { showDone: true });
    const n = node(g, 'D');
    expect(n.role).toBe('done');
    expect(n.r).toBe(G.MEASURE.rSmall);
    expect(g.edges.find((k) => k.from === 'D')).toMatchObject({ to: 'E', muted: true });
  });

  it('"Show standalone": the rest is included with role free', () => {
    const g = G.buildGraph(d, { showStandalone: true });
    expect(node(g, 'F').role).toBe('free');
    expect(g.edges.some((k) => k.from === 'F' || k.to === 'F')).toBe(false);
  });

  it('question: own node with type and "unlocks N", dashed edge (art sp) to the waiting task', () => {
    const g = G.buildGraph(d);
    const s = node(g, '?SP-1');
    expect(s).toMatchObject({ art: 'question', type: 'lawyer', locks: 1 });
    expect(g.edges.filter((k) => k.art === 'sp')).toEqual([
      { from: '?SP-1', to: 'Q', art: 'sp', muted: false },
    ]);
  });

  it('unknown predecessors (cancelled or deleted) and its own id give no edge', () => {
    const g = G.buildGraph(data([{ id: 'X', depends_on: ['DOES-NOT-EXIST', 'X'] }, { id: 'Y' }]));
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it('status in the ring: ready, blocked, active (running/picked/review) and qa (done but waiting on QA)', () => {
    const g = G.buildGraph(
      data([
        { id: 'K1', status: 'running' },
        { id: 'K2', depends_on: ['K1'], ready: false },
        { id: 'K3', status: 'done', qa_status: 'waiting' },
        { id: 'K4', depends_on: ['K3'], ready: true },
        { id: 'K5', status: 'review', depends_on: ['K4'] },
      ]),
      { showDone: true },
    );
    expect(node(g, 'K1').state).toBe('active');
    expect(node(g, 'K2').state).toBe('blocked');
    expect(node(g, 'K3').state).toBe('qa');
    expect(node(g, 'K4').state).toBe('ready');
    expect(node(g, 'K5').state).toBe('active');
  });

  it('radius: the area follows the minutes, with a min and max limit', () => {
    expect(G.radius(0)).toBe(G.MEASURE.rMin);
    expect(G.radius(10_000)).toBe(G.MEASURE.rMax);
    expect(G.radius(40)).toBeGreaterThan(G.radius(20));
    // The area (r²) is proportional to the minutes within the limits.
    expect(G.radius(80) ** 2 / G.radius(20) ** 2).toBeCloseTo(4, 1);
  });
});

describe('buildGraph: neighbors outside the filter', () => {
  const d = data([
    { id: 'A', project: 'a' },
    { id: 'B', project: 'b', depends_on: ['A'] },
    { id: 'C', project: 'a', depends_on: ['B'] },
    { id: 'Z', project: 'b', depends_on: ['A'] },
  ]);
  const onlyA = (k: Summary) => k.project === 'a';

  it('a hidden predecessor or successor is shown as a small gray neighbor, so the chain is not broken', () => {
    const g = G.buildGraph(d, { visible: onlyA });
    expect(node(g, 'B')).toMatchObject({ role: 'neighbor', r: G.MEASURE.rSmall });
    expect(node(g, 'Z')).toMatchObject({ role: 'neighbor' });
    expect(g.edges.map((k) => `${k.from}>${k.to}`)).toEqual(['A>B', 'A>Z', 'B>C']);
  });

  it('neighbors can be turned off: then only what the filter shows is shown', () => {
    const g = G.buildGraph(d, { visible: onlyA, neighbors: false });
    expect(ids(g)).toEqual(['A', 'C']);
    expect(g.edges).toEqual([]);
  });

  it('only one edge away: the neighbor\'s neighbors are not included', () => {
    const g = G.buildGraph(
      data([
        { id: 'A', project: 'b' },
        { id: 'B', project: 'b', depends_on: ['A'] },
        { id: 'C', depends_on: ['B'] },
      ]),
      { visible: onlyA },
    );
    expect(ids(g)).toEqual(['B', 'C']);
  });
});

describe('layer: layer, order and determinism', () => {
  const chain = data([
    { id: 'A' },
    { id: 'B', depends_on: ['A'] },
    { id: 'C', depends_on: ['B'] },
    { id: 'D', depends_on: ['A', 'C'] }, // longest path: A-B-C-D, so D in layer 3
    { id: 'Q', depends_on: ['C'] },
  ]);
  chain.inbox.question.push({ sp: 'S', direct: ['Q'], count: 1, type: 'question' });

  it('layers come from the longest path; predecessors to the left of their successors', () => {
    const o = G.layer(G.buildGraph(chain));
    expect(['A', 'B', 'C', 'D'].map((id) => node(o, id).make)).toEqual([0, 1, 2, 3]);
    for (const k of o.edges) expect(node(o, k.from).x).toBeLessThan(node(o, k.to).x);
    expect(o.countMake).toBe(4);
  });

  it('a question sits right before the task that waits on it (the source is pulled right)', () => {
    const o = G.layer(G.buildGraph(chain));
    expect(node(o, '?S').make).toBe((node(o, 'Q').make as number) - 1);
  });

  it('the nodes in a layer do not overlap, and come in layer order (the keyboard focus order)', () => {
    const o = G.layer(G.buildGraph(chain));
    const makeValues = o.nodes.map((n) => n.make as number);
    expect(makeValues).toEqual([...makeValues].sort((a, b) => a - b));
    const perMake = new Map<number, Node[]>();
    for (const n of o.nodes)
      perMake.set(n.make as number, [...(perMake.get(n.make as number) ?? []), n]);
    for (const l of perMake.values())
      for (let i = 1; i < l.length; i++)
        expect(l[i].y - l[i - 1].y).toBeGreaterThanOrEqual(l[i].r + l[i - 1].r);
  });

  it('the barycenter gives fewer crossings: two chains starting in the "wrong" order are straightened out', () => {
    // Layer 0: A1 < B1 (id). Layer 1: A2 < B2, but A2 hangs on B1 and B2 on A1: the start order crosses.
    const d = data([
      { id: 'A1' },
      { id: 'B1' },
      { id: 'A2', depends_on: ['B1'] },
      { id: 'B2', depends_on: ['A1'] },
      { id: 'C', depends_on: ['A2', 'B2'] }, // one component, so both chains are laid out together
    ]);
    const o = G.layer(G.buildGraph(d));
    const y = (id: string) => node(o, id).y;
    // After the sweeps each successor is on the same side as its predecessor: no crossing.
    expect(Math.sign(y('A1') - y('B1'))).toBe(Math.sign(y('B2') - y('A2')));
  });

  it('deterministic: the same queue gives the same image, also with tasks in a different order', () => {
    const d1 = data([
      { id: 'A' },
      { id: 'B', depends_on: ['A'] },
      { id: 'C', depends_on: ['A'] },
      { id: 'D', depends_on: ['B', 'C'] },
      { id: 'E', depends_on: ['C'] },
    ]);
    const d2 = { ...d1, columns: { ...d1.columns, queue: [...d1.columns.queue].reverse() } };
    const a = G.layer(G.buildGraph(d1));
    const b = G.layer(G.buildGraph(d2));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(G.layer(G.buildGraph(d1)))).toBe(JSON.stringify(a));
  });

  it('cycles are tolerated: the layout does not hang, all nodes get a place, and the cycle edge is reported', () => {
    const d = data([
      { id: 'A', depends_on: ['C'] },
      { id: 'B', depends_on: ['A'] },
      { id: 'C', depends_on: ['B'] },
      { id: 'D', depends_on: ['C'] },
    ]);
    const o = G.layer(G.buildGraph(d));
    expect(ids(o)).toEqual(['A', 'B', 'C', 'D']);
    expect(o.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(o.cycles.length).toBe(1);
    expect(o.edges.filter((k) => k.cycle)).toHaveLength(1);
    // Without the cycle edge the rest is a chain from left to right.
    for (const k of o.edges.filter((x) => !x.cycle))
      expect(node(o, k.from).make).toBeLessThan(node(o, k.to).make as number);
    expect(G.graphNumber(o).longestChain).toBe(4);
  });

  it('an empty graph gives an empty layout', () => {
    const o = G.layer(G.buildGraph(data([{ id: 'A' }])));
    expect(o).toMatchObject({
      nodes: [],
      edges: [],
      countMake: 0,
      width: 0,
      height: 0,
      free: null,
    });
  });

  it('standalone tasks sit in a grid below the graph, last in the order', () => {
    const o = G.layer(
      G.buildGraph(data([{ id: 'A' }, { id: 'B', depends_on: ['A'] }, { id: 'F1' }, { id: 'F2' }]), {
        showStandalone: true,
      }),
    );
    expect(o.nodes.slice(-2).map((n) => n.id)).toEqual(['F1', 'F2']);
    expect(o.free).toMatchObject({ count: 2 });
    const graphBottom = Math.max(node(o, 'A').y, node(o, 'B').y);
    expect(node(o, 'F1').y).toBeGreaterThan(graphBottom);
    expect(node(o, 'F1').y).toBe(node(o, 'F2').y);
    expect(o.height).toBeGreaterThan(node(o, 'F1').y);
  });
});

describe('layer: per project', () => {
  // Two chains: A1 → A2 and A1 → B1 (two from a, one from b: the lane of a), and B2 → B3 (only b).
  const d = data(
    [
      { id: 'A1', project: 'a' },
      { id: 'A2', project: 'a', depends_on: ['A1'] },
      { id: 'B1', project: 'b', depends_on: ['A1'] },
      { id: 'B2', project: 'b' },
      { id: 'B3', project: 'b', depends_on: ['B2'] },
    ],
    [],
    ['b', 'a'], // the lane order on the board: b above a
  );
  const inside = (o: Setup, id: string, b: { y: number; height: number }) =>
    node(o, id).y > b.y && node(o, id).y < b.y + b.height;

  it('lanes in lane order without overlap; a chain stays together in the lane of the project with the most nodes', () => {
    const o = G.layer(G.buildGraph(d), { mode: 'project' });
    expect(o.lanes.map((b) => b.pid)).toEqual(['b', 'a']);
    const [bb, ba] = o.lanes;
    expect(bb.y + bb.height).toBeLessThanOrEqual(ba.y);
    expect(inside(o, 'B2', bb) && inside(o, 'B3', bb)).toBe(true);
    // B1 belongs to b, but the chain A1-A2-B1 has the most nodes from a and therefore sits whole in the lane of a.
    expect(inside(o, 'A1', ba) && inside(o, 'A2', ba) && inside(o, 'B1', ba)).toBe(true);
    expect(node(o, 'B1').make).toBe(1);
    // The frames sit inside their lane.
    for (const k of o.components)
      expect(o.lanes.some((b) => k.y >= b.y && k.y + k.height <= b.y + b.height)).toBe(true);
  });

  it('the edge between projects is kept', () => {
    const o = G.layer(G.buildGraph(d), { mode: 'project' });
    expect(o.edges.some((k) => k.from === 'A1' && k.to === 'B1')).toBe(true);
  });

  it('combined has no lanes', () => {
    expect(G.layer(G.buildGraph(d)).lanes).toEqual([]);
  });

  it('the project filter ("per category"): only one lane, and the gray neighbor sits in the chain\'s lane', () => {
    const o = G.layer(G.buildGraph(d, { visible: (k) => k.project === 'b' }), { mode: 'project' });
    expect(node(o, 'A1').role).toBe('neighbor');
    expect(o.lanes.map((b) => b.pid)).toEqual(['b']);
    expect(ids(o)).toEqual(['A1', 'B1', 'B2', 'B3']);
    expect(inside(o, 'A1', o.lanes[0])).toBe(true);
  });
});

/**
 * A large queue (around 430 nodes in over a hundred components, the largest with 127): one large chain with
 * branches, a few medium ones and many of two or three. Deterministic, no randomness.
 */
function realForm(projects: string[]) {
  const summary: Summary[] = [];
  let n = 0;
  const fresh = (project: string, depends_on: string[] = [], estimate = 40) => {
    const id = `K${String(++n).padStart(3, '0')}`;
    summary.push({ id, project, depends_on, estimate });
    return id;
  };
  // Large chain: 11 steps, each step branches (about 120 nodes).
  let previous = [fresh(projects[0])];
  for (let part = 1; part < 11; part++) {
    const next: string[] = [];
    for (let i = 0; i < Math.min(18, previous.length + 3); i++)
      next.push(fresh(projects[i % 3], [previous[i % previous.length]], 20 + ((i * 7) % 60)));
    previous = next;
  }
  // Medium: 8 chains of 6-20 nodes.
  for (let m = 0; m < 8; m++) {
    let f = fresh(projects[(m + 1) % projects.length]);
    for (let i = 1; i < 6 + m * 2; i++)
      f = fresh(projects[(m + 1) % projects.length], [i % 3 ? f : summary[summary.length - 2].id]);
  }
  // Many small: 80 chains of 2 or 3.
  for (let s = 0; s < 80; s++) {
    const p = projects[s % projects.length];
    const a = fresh(p);
    const b = fresh(p, [a]);
    if (s % 3 === 0) fresh(p, [b]);
  }
  return data(summary, [], projects);
}

describe('layer: the chains each on their own, packed in rows', () => {
  const overlaps = (a: Frame, b: Frame) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const frameFor = (o: Setup, n: Node) =>
    o.components.filter(
      (k) => n.x > k.x && n.x < k.x + k.width && n.y > k.y && n.y < k.y + k.height,
    );

  it('components: chains linked together (also via a question) sit in the same frame, others each on their own', () => {
    const d = data([
      { id: 'A' },
      { id: 'B', depends_on: ['A'] },
      { id: 'C' },
      { id: 'D', depends_on: ['C'] },
      { id: 'E' },
      { id: 'F' },
    ]);
    d.inbox.question.push({ sp: 'S', direct: ['B', 'E'], count: 2, type: 'question' });
    d.inbox.question.push({ sp: 'T', direct: ['F'], count: 1, type: 'question' });
    const o = G.layer(G.buildGraph(d));
    // {A, B, ?S, E} (weakly connected via S), {C, D}, {?T, F}.
    expect(o.components.map((k) => k.count)).toEqual([4, 2, 2]);
    const where = (id: string) => o.components.indexOf(frameFor(o, node(o, id))[0]);
    expect(new Set(['A', 'B', '?S', 'E'].map(where))).toEqual(new Set([0]));
    expect(where('C')).toBe(where('D'));
    expect(where('?T')).toBe(where('F'));
    expect(new Set([where('A'), where('C'), where('F')]).size).toBe(3);
    // Each component starts at its own layer 0, and the focus order goes component by component.
    expect(node(o, 'C').make).toBe(0);
    expect(o.nodes.slice(0, 4).map((n) => where(n.id))).toEqual([0, 0, 0, 0]);
  });

  it('the packing: largest first, no overlap, each node in exactly one frame, and a gap between the frames', () => {
    const o = G.layer(G.buildGraph(realForm(['a', 'b', 'c', 'd'])));
    const count = o.components.map((k) => k.count);
    expect(count[0]).toBe(Math.max(...count));
    expect(count).toEqual([...count].sort((a, b) => b - a));
    for (let i = 0; i < o.components.length; i++)
      for (let j = i + 1; j < o.components.length; j++)
        expect(overlaps(o.components[i], o.components[j])).toBe(false);
    for (const n of o.nodes) expect(frameFor(o, n)).toHaveLength(1);
    // The nodes in a frame do not overlap each other.
    for (let i = 0; i < o.nodes.length; i++)
      for (let j = i + 1; j < o.nodes.length; j++) {
        const a = o.nodes[i];
        const b = o.nodes[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r);
      }
  });

  it('a queue like the real one fills a 1600 × 800 surface: aspect ratio close to the surface\'s, and readable circles', () => {
    const o = G.layer(G.buildGraph(realForm(['a', 'b', 'c', 'd'])), {
      surface: { width: 1600, height: 800 },
    });
    // Before the packing: one column, aspect ratio about 0.2. Now roughly like the surface (2).
    expect(o.width / o.height).toBeGreaterThan(1);
    expect(o.width / o.height).toBeLessThan(4);
    // "Customize" with everything visible: most circles (90 % of the core) are at least 6 px.
    const scale = Math.min(1600 / (o.width + 20), 800 / (o.height + 20));
    expect(scale).toBeGreaterThanOrEqual(o.readableScale);
    const d = o.nodes.filter((n) => n.role === 'core').map((n) => 2 * n.r * scale);
    expect(d.filter((x) => x >= 6).length / d.length).toBeGreaterThanOrEqual(0.9);
  });

  it('a tall surface gives a narrower packing than a wide one', () => {
    const g = G.buildGraph(realForm(['a', 'b']));
    const wide = G.layer(g, { surface: { width: 1600, height: 800 } });
    const high = G.layer(g, { surface: { width: 800, height: 1600 } });
    expect(wide.width / wide.height).toBeGreaterThan(high.width / high.height);
  });

  it('deterministic: the same queue in a different order gives the same packing', () => {
    const d1 = realForm(['a', 'b', 'c']);
    const d2 = { ...d1, columns: { ...d1.columns, queue: [...d1.columns.queue].reverse() } };
    expect(JSON.stringify(G.layer(G.buildGraph(d2)))).toBe(JSON.stringify(G.layer(G.buildGraph(d1))));
  });

  it('per project: packing in each lane, the lanes stacked without overlap, all frames inside a lane', () => {
    const o = G.layer(G.buildGraph(realForm(['a', 'b', 'c', 'd'])), {
      mode: 'project',
      surface: { width: 1600, height: 800 },
    });
    expect(o.lanes.map((b) => b.pid)).toEqual(['a', 'b', 'c', 'd']);
    for (let i = 1; i < o.lanes.length; i++)
      expect(o.lanes[i - 1].y + o.lanes[i - 1].height).toBeLessThanOrEqual(o.lanes[i].y);
    for (const k of o.components) {
      expect(o.lanes.some((b) => k.y >= b.y && k.y + k.height <= b.y + b.height)).toBe(true);
      expect(k.x + k.width).toBeLessThanOrEqual(o.width);
    }
    for (let i = 0; i < o.components.length; i++)
      for (let j = i + 1; j < o.components.length; j++)
        expect(overlaps(o.components[i], o.components[j])).toBe(false);
    // The width is used: at least one lane has more than one component side by side.
    const rows = new Set(o.components.map((k) => k.y));
    expect(rows.size).toBeLessThan(o.components.length);
    // Either everything visible is readable, or "Customize" fills the width with readable circles (and you scroll).
    const inWidth = 1600 / (o.width + 20);
    expect(inWidth).toBeGreaterThanOrEqual(o.readableScale);
  });
});

describe('graphNumber', () => {
  it('tasks in chains, questions that block (via the chain), longest chain and blocked', () => {
    const d = data(
      [
        { id: 'A' },
        { id: 'B', depends_on: ['A'], ready: false },
        { id: 'C', depends_on: ['B'], ready: false },
        { id: 'Q', ready: false },
        { id: 'R', depends_on: ['Q'], ready: false },
        { id: 'F' },
      ],
      [
        { sp: 'S1', direct: ['Q'], count: 2 },
        { sp: 'S2', direct: ['B'], count: 2 },
      ],
    );
    const t = G.graphNumber(G.buildGraph(d, { showStandalone: true }));
    expect(t).toEqual({
      tasks: 5, // A, B, C, Q, R (F is standalone)
      question: 2,
      blockedByQuestion: 4, // Q, R (S1) and B, C (S2)
      longestChain: 3, // A-B-C
      blocked: 4,
    });
  });

  it('an empty layout gives only zeros', () => {
    expect(G.graphNumber({ nodes: [], edges: [], projects: [] })).toEqual({
      tasks: 0,
      question: 0,
      blockedByQuestion: 0,
      longestChain: 0,
      blocked: 0,
    });
  });
});

describe('with real state from queueBoard.board', () => {
  it('the cards from the board give the graph without rules of its own (ready, unlocks and question from queueBoard)', () => {
    const T = require('../queueBoard') as { board: (queue: unknown, option?: unknown) => unknown };
    const queue = {
      tasks: [
        { id: 'X1', title: 'x1', status: 'waiting', class: 'K', content_min: 30 },
        { id: 'X2', title: 'x2', status: 'waiting', class: 'K', depends_on: ['X1'] },
        { id: 'X3', title: 'x3', status: 'waiting', class: 'K', waiting_on: ['SP-X'] },
      ],
      resolved: [],
    };
    const state = T.board(queue, { now: Date.parse('2026-10-01T12:00:00Z') });
    const g = G.buildGraph(state);
    expect(ids(g)).toEqual(['?SP-X', 'X1', 'X2', 'X3']);
    expect(node(g, 'X1')).toMatchObject({ state: 'ready', locks: 1 });
    expect(node(g, 'X2').state).toBe('blocked');
    expect(node(g, 'X3').state).toBe('blocked');
    expect(G.graphNumber(g)).toMatchObject({
      tasks: 3,
      question: 1,
      blockedByQuestion: 1,
      longestChain: 2,
    });
  });
});
