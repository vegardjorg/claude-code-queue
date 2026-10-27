// =============================================================
// performance.js: the pure parts of queueBoard not rebuilding the whole board every time.
//
// The file is both a CommonJS module (vitest, lib/__tests__/queueBoardPerformance.test.ts, and queue-board.mjs via require)
// and a browser script (queue-board.mjs serves it as /performance.js, and it sets window.QueuePerformance), so the board uses
// exactly the code the tests check. No DOM here.
//
//   - The diff: old list (key → signature) and new list give the operations reuse, build and remove.
//   - The card buffer: the board asks for the node of a card by key and signature; the same signature as last time gives
//     the same node (reuse), otherwise it is built. After a round, cards that were not used are cleaned up (the diff's "remove").
//   - The keyboard (roving tabindex): where arrow up/down, left/right, Home and End go between cards and columns.
//   - Compression: whether a response is sent with brotli, gzip or uncompressed (the server, queue-board.mjs send()).
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueuePerformance = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- The diff ----

  /**
   * Old and new list give the operations. `oldOnes` is a Map key → signature (what is built now), `newOnes` is
   * [key, signature] pairs in the order the board needs them. A key with the same signature is reused; a new or
   * changed key is built; an old key no longer present is removed. If a key appears twice in the new
   * list, the second occurrence is built (one DOM node can only be in one place).
   */
  function plan(oldOnes, newOnes) {
    const reuse = [];
    const build = [];
    const set = new Set();
    for (const [key, signature] of newOnes) {
      if (set.has(key)) {
        build.push(key);
        continue;
      }
      set.add(key);
      if (oldOnes.has(key) && oldOnes.get(key) === signature) reuse.push(key);
      else build.push(key);
    }
    const remove = [];
    for (const key of oldOnes.keys()) if (!set.has(key)) remove.push(key);
    return { reuse, build, remove };
  }

  // ---- The card buffer ----

  /**
   * The buffer the board fetches card nodes from. One round per render: `start()`, then `node(key, signature, build)` per
   * card, then `end()`. `node` returns the saved node when the signature is the same as last time (and the key is not
   * already used in the round), otherwise a new one is built with `build()`. `end()` removes the nodes that were not used
   * (the diff's "remove") and returns the counters. A card built after `end()` (a section being opened) counts toward the
   * round that just ended, so it stays until the next render.
   */
  function makeSummaryBuffer() {
    const lager = new Map(); // key → { signature, node }
    let round = [];
    let used = new Set();
    let reused = 0;
    let built = 0;
    return {
      start() {
        round = [];
        used = new Set();
        reused = 0;
        built = 0;
      },
      node(key, signature, build) {
        round.push([key, signature]);
        const saved = lager.get(key);
        if (!used.has(key) && saved && saved.signature === signature) {
          used.add(key);
          reused++;
          return saved.node;
        }
        const node = build();
        built++;
        // A key already used in the round sits somewhere else: the new node does not overwrite the saved one.
        if (!used.has(key)) lager.set(key, { signature, node });
        used.add(key);
        return node;
      },
      end() {
        const oldOnes = new Map([...lager].map(([n, x]) => [n, x.signature]));
        const { remove } = plan(oldOnes, round);
        for (const n of remove) lager.delete(n);
        return { reused, built, removed: remove.length };
      },
      size: () => lager.size,
    };
  }

  // ---- The keyboard (roving tabindex) ----

  /**
   * Where focus goes when `keyPress` is pressed on card no. `i` in column (or cell) no. `o`. `count` is the number of
   * visible cards per column, in order from the left. Arrow up and down move within the column and stop at the ends; Home
   * and End go to the first and last card; arrow left and right go to the nearest column with cards and keep the position
   * as far as that column reaches. Returns { o, i }, or null when the key does not move focus.
   */
  function rovingMeasure(count, o, i, keyPress) {
    const n = count[o] ?? 0;
    if (!n) return null;
    if (keyPress === 'ArrowDown') return i + 1 < n ? { o, i: i + 1 } : null;
    if (keyPress === 'ArrowUp') return i > 0 ? { o, i: i - 1 } : null;
    if (keyPress === 'Home') return { o, i: 0 };
    if (keyPress === 'End') return { o, i: n - 1 };
    if (keyPress === 'ArrowRight' || keyPress === 'ArrowLeft') {
      const step = keyPress === 'ArrowRight' ? 1 : -1;
      for (let j = o + step; j >= 0 && j < count.length; j += step)
        if (count[j] > 0) return { o: j, i: Math.min(i, count[j] - 1) };
      return null;
    }
    return null;
  }

  // ---- Compression (the server) ----

  /** Responses below this size are sent uncompressed (compression costs more than it saves). */
  const COMPRESS_FROM = 50 * 1024;

  /**
   * The encoding for a response of `bytes` bytes when the client sent Accept-Encoding `acceptEncoding`: 'br' when brotli is
   * accepted, otherwise 'gzip', otherwise null (uncompressed). q=0 means "not accepted"; "*" accepts gzip.
   */
  function selectEncoding(acceptEncoding, bytes) {
    if (!(bytes > COMPRESS_FROM) || !acceptEncoding) return null;
    const q = new Map();
    for (const chunk of String(acceptEncoding).toLowerCase().split(',')) {
      const [name, ...param] = chunk.trim().split(';');
      if (!name) continue;
      const qp = param.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const val = qp ? Number(qp.slice(2)) : 1;
      q.set(name.trim(), Number.isFinite(val) ? val : 0);
    }
    const accepts = (name) => (q.has(name) ? q.get(name) > 0 : q.has('*') && q.get('*') > 0);
    if (q.has('br') && q.get('br') > 0) return 'br';
    if (accepts('gzip')) return 'gzip';
    return null;
  }

  return { plan, makeSummaryBuffer, rovingMeasure, COMPRESS_FROM, selectEncoding };
});
