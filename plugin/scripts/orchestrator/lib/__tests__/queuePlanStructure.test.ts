// =============================================================
// queuePlanStructure.test.ts: treeMap and dependencies in the Plans room (see docs/board.md).
// The rules are pure functions in lib/queuePlanView.js and lib/queueGraph.js (the same files the
// browser loads), so they are tested directly: the level and the zoom (the filter), the fields (surfaceArea = size, color =
// priority, fill = built), the squarified cells, the graph for a selection or a selected entry with its neighbors, blocked and the
// critical path. As a bonus, structure.js, plans.js, index.html and queue-board.mjs are read as text for the wiring.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const V = require('../queuePlanView.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const G = require('../queueGraph.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');

type Post = Record<string, unknown>;

function entry(id: string, extra: Post = {}): Post {
  return {
    id,
    title: `Title ${id}`,
    project: 'export',
    module: 'alpha',
    priority: 'later',
    maturity: 'idea',
    size: 'M',
    depends_on: [],
    finished: 0,
    total: 0,
    ...extra,
  };
}

const DATA = {
  modules: [
    { oid: 'alpha', title: 'Alpha' },
    { oid: 'beta', title: 'Beta' },
  ],
  projects: {
    export: { title: 'Export (risk)', summary: 'Export', area: 'alpha' },
    import: { title: 'Import', summary: 'Import', area: 'alpha' },
    planning: { title: 'Planning', summary: 'Planning', area: 'beta' },
  },
};

describe('url: show and dep', () => {
  it('treeMap and dep are read and written; an unknown view becomes list', () => {
    expect(V.readUrl('?room=plans&show=treeMap').show).toBe('treeMap');
    expect(V.readUrl('?room=plans&show=dep&dep=entry').dep).toBe('entry');
    expect(V.readUrl('?room=plans&show=junk').show).toBe('list');
    expect(V.readUrl('?room=plans&dep=junk').dep).toBe('selection');
    const t = V.readUrl('?room=plans&show=dep&dep=entry&module=alpha');
    expect(V.writeUrl(t)).toBe('?room=plans&module=alpha&show=dep&dep=entry');
    expect(V.writeUrl({ ...t, show: 'treeMap' })).toBe('?room=plans&module=alpha&show=treeMap');
    expect(V.writeUrl({ ...t, show: 'list' })).toBe('?room=plans&module=alpha');
  });
});

describe('treeMap: level, fields and zoom', () => {
  it('the estimate weight is the same as the capacity uses (queuePlan.SIZE_TRACK)', () => {
    expect(V.SIZE_WEIGHT).toEqual(P.SIZE_TRACK);
  });

  it('the level follows the filter: none gives modules, one module gives projects, one project gives entries', () => {
    expect(V.treeMapLevel(V.emptyFilter())).toBe('module');
    expect(V.treeMapLevel({ ...V.emptyFilter(), module: ['alpha', 'beta'] })).toBe('module');
    expect(V.treeMapLevel({ ...V.emptyFilter(), module: ['alpha'] })).toBe('project');
    expect(V.treeMapLevel({ ...V.emptyFilter(), project: ['export'] })).toBe('entry');
  });

  it('module level: surfaceArea = sum of the estimates, color = the priority with the most size, fill = built weighted', () => {
    const match = [
      entry('PL-A', { size: 'L', priority: 'now', maturity: 'built' }),
      entry('PL-B', { size: 'S', priority: 'later' }),
      entry('PL-C', { size: null, priority: 'later' }),
      entry('PL-D', { module: 'beta', project: 'planning', size: 'XL', priority: 'owner' }),
    ];
    const tk = V.treeMapFields(match, DATA, V.emptyFilter());
    expect(tk.level).toBe('module');
    expect(tk.fields.map((f: { id: string }) => f.id)).toEqual(['beta', 'alpha']);
    const alpha = tk.fields.find((f: { id: string }) => f.id === 'alpha');
    expect(alpha.weight).toBe(7 + 1 + 1);
    expect(alpha.count).toBe(3);
    expect(alpha.withoutSize).toBe(1);
    expect(alpha.priority).toBe('now');
    expect(alpha.built).toBeCloseTo(7 / 9, 3);
    expect(alpha.shares).toEqual([
      { priority: 'now', weight: 7 },
      { priority: 'later', weight: 2 },
    ]);
    expect(alpha.zoom).toEqual({ module: ['alpha'], project: [] });
    expect(tk.sum).toBe(24);
    expect(tk.withoutSize).toBe(1);
  });

  it('on equal weight the priority listed first wins (Now before Owner before Later)', () => {
    const tk = V.treeMapFields(
      [entry('PL-A', { priority: 'later' }), entry('PL-B', { priority: 'now' })],
      DATA,
      V.emptyFilter(),
    );
    expect(tk.fields[0].priority).toBe('now');
  });

  it('project level: short names, "Without project" for unknown, and zoom to the project with the module kept', () => {
    const f = { ...V.emptyFilter(), module: ['alpha'] };
    const tk = V.treeMapFields(
      [entry('PL-A'), entry('PL-B', { project: 'import' }), entry('PL-C', { project: null })],
      DATA,
      f,
    );
    expect(tk.level).toBe('project');
    const titles = tk.fields.map((x: { title: string }) => x.title).sort();
    expect(titles).toEqual(['Export', 'Import', 'Without project']);
    const exportData = tk.fields.find((x: { id: string }) => x.id === 'export');
    expect(exportData.zoom).toEqual({ module: ['alpha'], project: ['export'] });
    const without = tk.fields.find((x: { title: string }) => x.title === 'Without project');
    expect(without.zoom).toEqual({ module: ['alpha'], project: [without.id] });
  });

  it('entry level: one field per entry, partial built gives the fraction, a click opens the entry (no zoom)', () => {
    const tk = V.treeMapFields(
      [entry('PL-A', { maturity: 'partial', finished: 1, total: 4 })],
      DATA,
      { ...V.emptyFilter(), project: ['export'] },
    );
    expect(tk.fields[0]).toMatchObject({ level: 'entry', entry: 'PL-A', zoom: null, built: 0.25 });
    const text = V.treeMapText(tk.fields[0]);
    expect(text.lines).toEqual(['○ Later', 'M (2 tracks)', '25 % built']);
    expect(text.label).toMatch(/^PL-A: Title PL-A\. .*Open entry\.$/);
  });

  it('the text carries the priority with symbol and text also for combined fields (color is never the only carrier)', () => {
    const tk = V.treeMapFields(
      [entry('PL-A', { priority: 'now' }), entry('PL-B', { size: null })],
      DATA,
      V.emptyFilter(),
    );
    const t = V.treeMapText(tk.fields[0]);
    expect(t.lines).toContain('● Now 2 tracks, ○ Later 1 track');
    expect(t.lines).toContain('1 without size');
    expect(t.label).toMatch(/Zoom in\.$/);
  });
});

describe('treeMap: the squarified cells', () => {
  const surface = { width: 1000, height: 600 };
  const surfaceArea = (r: { width: number; height: number }) => r.width * r.height;

  it('fills the surface, the area follows the weight and the cells do not overlap', () => {
    const fields = [6, 6, 4, 3, 2, 2, 1].map((weight, i) => ({ id: `f${i}`, weight }));
    const cells = V.treeMapCells(fields, surface);
    expect(cells).toHaveLength(7);
    const sum = cells.reduce((s: number, r: { width: number; height: number }) => s + surfaceArea(r), 0);
    expect(sum).toBeCloseTo(600000, -2);
    for (const r of cells) {
      const weight = fields.find((f) => f.id === r.id)!.weight;
      expect(surfaceArea(r) / 600000).toBeCloseTo(weight / 24, 2);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(1000.05);
      expect(r.y + r.height).toBeLessThanOrEqual(600.05);
    }
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i];
        const b = cells[j];
        const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(dx > 0.05 && dy > 0.05).toBe(false);
      }
  });

  it('keeps the cells close to square (no thin strips for equal fields)', () => {
    const cells = V.treeMapCells(
      Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, weight: 1 })),
      surface,
    );
    for (const r of cells) expect(Math.max(r.width / r.height, r.height / r.width)).toBeLessThan(3);
  });

  it('deterministic, largest first, and fields without weight are skipped', () => {
    const fields = [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 5 },
      { id: 'c', weight: 0 },
    ];
    const r1 = V.treeMapCells(fields, surface);
    expect(r1.map((r: { id: string }) => r.id)).toEqual(['b', 'a']);
    expect(V.treeMapCells(fields, surface)).toEqual(r1);
    expect(V.treeMapCells([], surface)).toEqual([]);
  });

  it('one field fills the whole surface', () => {
    expect(V.treeMapCells([{ id: 'x', weight: 3 }], surface)).toEqual([
      { id: 'x', x: 0, y: 0, width: 1000, height: 600 },
    ]);
  });
});

describe('queueGraph.criticalPath', () => {
  const n = (id: string, weight: number, isOpen = true) => ({ id, weight, isOpen });

  it('the heaviest path by weight, not the longest by count', () => {
    const nodes = [n('A', 1), n('B', 1), n('C', 1), n('D', 15), n('E', 1)];
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'D', to: 'E' },
    ];
    const v = G.criticalPath(nodes, edges, { weight: (x: { weight: number }) => x.weight });
    expect(v.path).toEqual(['D', 'E']);
    expect(v.sum).toBe(16);
    expect(v.edges).toEqual(['D>E']);
  });

  it('never goes through nodes that `with` excludes (finished entries), and tolerates cycles', () => {
    const nodes = [n('A', 2), n('B', 7, false), n('C', 2), n('X', 1), n('Y', 1)];
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'X', to: 'Y' },
      { from: 'Y', to: 'X' },
    ];
    const v = G.criticalPath(nodes, edges, {
      with: (x: { isOpen: boolean }) => x.isOpen,
      weight: (x: { weight: number }) => x.weight,
    });
    expect(v.path).not.toContain('B');
    expect(v.sum).toBe(2);
    expect(G.criticalPath([], [], {})).toEqual({ path: [], sum: 0, edges: [] });
  });

  it('equal sum: most parts, then lowest id (deterministic)', () => {
    const nodes = [n('A', 2), n('B', 1), n('C', 1)];
    const v = G.criticalPath(nodes, [{ from: 'B', to: 'C' }], {
      weight: (x: { weight: number }) => x.weight,
    });
    expect(v.path).toEqual(['B', 'C']);
  });
});

describe('dependencies: planGraph', () => {
  const entries = [
    entry('PL-A', { size: 'L', priority: 'now' }),
    entry('PL-B', { depends_on: ['PL-A'], size: 'M' }),
    entry('PL-C', { depends_on: ['PL-B'], size: 'S' }),
    entry('PL-D', { depends_on: ['PL-A'], size: 'S', maturity: 'built' }),
    entry('PL-E', { size: 'XL' }),
    entry('PL-F', { depends_on: ['PL-E', 'PL-UNKNOWN', 'PL-F'], priority: 'drop' }),
  ];

  it('never the whole register: without filter and search nothing is drawn', () => {
    const g = V.planGraph(entries, {
      selection: entries.map((p) => p.id),
      wholeRegister: true,
    });
    expect(g.reason).toBe('whole-register');
    expect(g.nodes).toEqual([]);
    expect(V.planGraphText(g)).toMatch(/only shown for a selection/);
  });

  it('a too large selection is not drawn', () => {
    const g = V.planGraph(entries, { selection: ['PL-A', 'PL-B', 'PL-C'], max: 2 });
    expect(g.reason).toBe('for-large');
    expect(V.planGraphText(g)).toMatch(/3 entries/);
  });

  it('selection: entries with dependencies are the core, the neighbors outside are small, those without edges are counted', () => {
    const g = V.planGraph(entries, { selection: ['PL-B', 'PL-C', 'PL-E'] });
    expect(g.reason).toBeNull();
    const roles = Object.fromEntries(
      g.nodes.map((x: { id: string; role: string }) => [x.id, x.role]),
    );
    // PL-E has a successor (PL-F) and is therefore included, PL-F as a neighbor.
    expect(roles).toEqual({
      'PL-A': 'neighbor',
      'PL-B': 'core',
      'PL-C': 'core',
      'PL-E': 'core',
      'PL-F': 'neighbor',
    });
    expect(g.counts).toMatchObject({ entries: 3, neighbors: 2, without: 0, selection: 3 });
    const neighbor = g.nodes.find((x: { id: string }) => x.id === 'PL-A');
    expect(neighbor.r).toBe(G.MEASURE.rSmall);
  });

  it('unknown and self dependencies give no edge; entries without edges in the selection are counted as without', () => {
    const g = V.planGraph(entries, { selection: ['PL-F', 'PL-E'] });
    expect(g.edges).toEqual([
      { from: 'PL-E', to: 'PL-F', art: 'dep', muted: false, critical: false },
    ]);
    const g2 = V.planGraph([entry('PL-X'), entry('PL-Y')], { selection: ['PL-X', 'PL-Y'] });
    expect(g2.reason).toBe('none-edges');
    expect(V.planGraphText(g2)).toBe('None of the 2 entries in the selection have dependencies.');
  });

  it('blocked: an open entry with an open predecessor; a built predecessor does not block', () => {
    const g = V.planGraph(entries, { mode: 'entry', selected: 'PL-A' });
    const per = Object.fromEntries(g.nodes.map((x: { id: string }) => [x.id, x]));
    expect(per['PL-B'].blocked).toBe(true);
    expect(per['PL-A'].blocked).toBe(false);
    expect(per['PL-D'].blocked).toBe(false);
    expect(per['PL-D'].isOpen).toBe(false);
    const edgeD = g.edges.find((k: { to: string }) => k.to === 'PL-D');
    expect(edgeD.muted).toBe(false);
  });

  it('selected entry with neighbors: the entry, the predecessors and the successors (one step), the entry marked', () => {
    const g = V.planGraph(entries, { mode: 'entry', selected: 'PL-B' });
    expect(g.nodes.map((x: { id: string }) => x.id)).toEqual(['PL-A', 'PL-B', 'PL-C']);
    expect(g.nodes.find((x: { id: string }) => x.id === 'PL-B').selected).toBe(true);
    expect(V.planGraph(entries, { mode: 'entry', selected: null }).reason).toBe('select-entry');
  });

  it('critical path: the heaviest chain of open entries (the estimate as weight), highlighted on nodes and edges', () => {
    const g = V.planGraph(entries, { selection: ['PL-A', 'PL-B', 'PL-C', 'PL-D'] });
    expect(g.critical.path).toEqual(['PL-A', 'PL-B', 'PL-C']);
    expect(g.critical.sum).toBe(10);
    expect(
      g.nodes.filter((x: { critical: boolean }) => x.critical).map((x: { id: string }) => x.id),
    ).toEqual(['PL-A', 'PL-B', 'PL-C']);
    expect(g.edges.filter((k: { critical: boolean }) => k.critical)).toHaveLength(2);
    expect(V.criticalPathText(g)).toBe('Critical path: PL-A → PL-B → PL-C (about 10 tracks)');
    expect(V.planGraphText(g)).toBe('4 entries, 2 blocked');
  });

  it('no critical path with only one open part', () => {
    const g = V.planGraph(
      [entry('PL-A'), entry('PL-B', { depends_on: ['PL-A'], maturity: 'verified' })],
      { selection: ['PL-A', 'PL-B'] },
    );
    expect(g.critical.path).toEqual([]);
    expect(V.criticalPathText(g)).toBeNull();
  });

  it('the layout goes through queueGraph.layer: left to right by dependencies', () => {
    const g = V.planGraph(entries, { selection: ['PL-A', 'PL-B', 'PL-C'] });
    const o = G.layer(g, { mode: 'combined' });
    const x = Object.fromEntries(o.nodes.map((n: { id: string; x: number }) => [n.id, n.x]));
    expect(x['PL-A']).toBeLessThan(x['PL-B']);
    expect(x['PL-B']).toBeLessThan(x['PL-C']);
  });

  it('the node text has priority, maturity and blocked as text', () => {
    const g = V.planGraph(entries, { mode: 'entry', selected: 'PL-B' });
    const b = g.nodes.find((x: { id: string }) => x.id === 'PL-B');
    expect(V.planNodeText(b)).toEqual([
      'PL-B: Title PL-B',
      '○ Later, Idea, M',
      'Blocked: waiting on an open entry',
      'On the critical path',
    ]);
  });
});

describe('the wiring in the board', () => {
  const structure = readFileSync(join(CLIENT, 'plans', 'structure.js'), 'utf8');
  const plans = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
  const index = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  const server = readFileSync(join(CLIENT, '..', 'queue-board.mjs'), 'utf8');

  it('structure.js loads before plans.js and is served', () => {
    expect(index.indexOf('/plans/structure.js')).toBeGreaterThan(0);
    expect(index.indexOf('/plans/structure.js')).toBeLessThan(index.indexOf('/plans/plans.js'));
    expect(index.indexOf('/queueGraph.js')).toBeLessThan(index.indexOf('/plans/structure.js'));
    expect(server).toContain("'/plans/structure.js'");
  });

  it('structure.js never sets HTML and never writes', () => {
    expect(structure).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(structure).not.toMatch(/fetch\(|method:\s*'POST'/);
    expect(structure).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('plans.js picks the view and gives the zoom via the filter', () => {
    expect(plans).toContain("['treeMap', 'Tree map']");
    expect(plans).toContain("['dep', 'Dependencies']");
    expect(plans).toMatch(/zoom: \(part\) => newFilter\(/);
  });
});
