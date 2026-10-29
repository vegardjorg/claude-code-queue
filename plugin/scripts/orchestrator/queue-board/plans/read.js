// =============================================================
// read.js: the document reader and the Unregistered box in the Plans room (see docs/board.md).
// Vanilla JS, no build step, no CDN.
//
//   - The Documents tab in the detail panel: the entry's sources, and the chosen source read in under the list. Links
//     to other documents that can be read open in the same view (with "Back"); web addresses are shown as text and
//     never opened from here.
//   - The Unregistered box above the list: documents `plan check` finds that no entry points to, grouped by folder
//     with count, and for each document "Read", "New entry" and "Add as source". Both writes have a preview
//     first and save with --expect-changed (POST /api/plan-new and /api/plan-source, which run queue.mjs).
//
// The document is fetched with GET /api/doc?path=… (only markdown under the document folders in queue.config.json,
// default docs/; the server has the path guard). Markdown is split into blocks by the pure functions in
// scripts/lib/queuePlanView.js (markdownBlocks, inlineParts, linkMeasure, anchorIndex; tested in jest) and drawn only
// with textContent and createElement, never innerHTML, so HTML in a document stays as text.
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;
  const KEY = 'queue-board-key'; // same as board.js (sessionStorage)
  const BOX_STORAGE = 'queue-board-plans-unregistered-open'; // localStorage: the box is open
  const CACHE_MAX = 20;

  const s = {
    // Documents that are fetched: path → { status: 'loading'|'ok'|'error', data?, blocks?, message?, el? }.
    doc: new Map(),
    // What is being read in each context (`entry:<id>` or `unreg`): { path, anchor, back: [{ path, anchor }] }.
    show: {},
    // The heading the reader should scroll to after the next drawing: { context, index }.
    scroll: null,
    unreg: {
      open: readFlag(BOX_STORAGE),
      data: null,
      error: null,
      fetching: false,
      version: undefined, // the register's `changed` when the list was last fetched
      form: null, // { path, type: 'new'|'source', field, preview, saves }
    },
  };

  function readFlag(key) {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }
  function setFlag(key, val) {
    try {
      if (val) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch {
      /* applies only to this session */
    }
  }
  const header = () => ({ 'X-Queue-Key': sessionStorage.getItem(KEY) ?? '' });

  async function readAnswer(res) {
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
    if (!res.ok) {
      const e = new Error(answer?.message ?? `HTTP ${res.status}`);
      e.answer = answer;
      throw e;
    }
    return answer;
  }

  // ---- Fetching ----
  async function getDoc(h, filePath) {
    if (s.doc.has(filePath)) return;
    s.doc.set(filePath, { status: 'loading' });
    while (s.doc.size > CACHE_MAX) s.doc.delete(s.doc.keys().next().value);
    try {
      const res = await fetch(`/api/doc?path=${encodeURIComponent(filePath)}`, { headers: header() });
      const answer = await readAnswer(res);
      s.doc.set(filePath, { status: 'ok', data: answer, blocks: V.markdownBlocks(answer.text) });
    } catch (e) {
      s.doc.set(filePath, { status: 'error', message: e.message });
    }
    h.draw();
  }

  async function getUnregistered(h, version) {
    const u = s.unreg;
    if (u.fetching) return;
    u.fetching = true;
    u.version = version;
    try {
      const res = await fetch('/api/plan-check', { headers: header() });
      u.data = await readAnswer(res);
      u.error = null;
    } catch (e) {
      u.error = e.message;
    } finally {
      u.fetching = false;
    }
    h.draw();
  }

  async function postJson(filePath, body) {
    const res = await fetch(filePath, {
      method: 'POST',
      headers: { ...header(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readAnswer(res);
  }

  // ---- The reader ----
  function openOnes(h, context, filePath, anchor, { back = true } = {}) {
    const now = s.show[context];
    const history =
      now?.path && back ? [...now.back, { path: now.path, anchor: now.anchor }] : [];
    s.show[context] = { path: filePath, anchor: anchor ?? null, back: history.slice(-20) };
    s.scroll = anchor ? { context, anchor } : null;
    h.draw({ focus: `read:${context}` });
  }

  /** The parts of a markdown line as DOM nodes (text, code, bold, italic and links). */
  function inline(h, text, ctx, parts = V.inlineParts(text)) {
    const out = [];
    for (const d of parts) {
      if (d.type === 'text') out.push(document.createTextNode(d.text));
      else if (d.type === 'code') out.push(h.el('code', { text: d.text }));
      else if (d.type === 'bold') out.push(h.el('strong', {}, ...inline(h, '', ctx, d.parts)));
      else if (d.type === 'italic') out.push(h.el('em', {}, ...inline(h, '', ctx, d.parts)));
      else if (d.type === 'link') {
        const m = V.linkMeasure(ctx.path, d.template);
        if (m.type === 'doc')
          out.push(
            h.el('button', {
              type: 'button',
              class: 'link-button read-link',
              text: d.text,
              title: `Read ${m.path}${m.anchor ? ` #${m.anchor}` : ''}`,
              onclick: () => openOnes(h, ctx.context, m.path, m.anchor),
            }),
          );
        else if (m.type === 'anchor')
          out.push(
            h.el('button', {
              type: 'button',
              class: 'link-button read-link',
              text: d.text,
              title: `Go to ${m.anchor}`,
              onclick: () => {
                s.scroll = { context: ctx.context, anchor: m.anchor };
                scrollTo(ctx.context);
              },
            }),
          );
        else if (m.type === 'external')
          // The url is shown as text (never opened from the board); copy it if you want to open it.
          out.push(
            h.el(
              'span',
              { class: 'read-external', title: m.url },
              d.text,
              d.text === m.url ? null : h.el('span', { class: 'read-url', text: ` (${m.url})` }),
            ),
          );
        else out.push(h.el('span', { class: 'read-external', title: d.template, text: d.text }));
      }
    }
    return out;
  }

  /** A list with levels: a point with a larger indent goes in a new list inside the point above. */
  function listEl(h, points, ctx) {
    const fresh = (p) => h.el(p.sorted ? 'ol' : 'ul', { class: 'read-list' });
    const root = fresh(points[0]);
    const stack = [{ level: points[0].level, list: root }];
    for (const p of points) {
      while (stack.length > 1 && p.level < stack[stack.length - 1].level) stack.pop();
      let top = stack[stack.length - 1];
      if (p.level > top.level && top.list.lastElementChild) {
        const under = fresh(p);
        top.list.lastElementChild.append(under);
        stack.push({ level: p.level, list: under });
        top = stack[stack.length - 1];
      }
      top.list.append(
        h.el(
          'li',
          { value: p.sorted && p.nr != null ? String(p.nr) : null },
          ...inline(h, p.text, ctx),
        ),
      );
    }
    return root;
  }

  function blockEl(h, b, i, ctx) {
    if (b.type === 'heading')
      return h.el(
        `h${Math.min(6, b.level + 2)}`,
        { class: `read-h read-h${b.level}`, 'data-block': String(i) },
        ...inline(h, b.text, ctx),
      );
    if (b.type === 'paragraph') return h.el('p', {}, ...inline(h, b.text, ctx));
    if (b.type === 'list') return listEl(h, b.points, ctx);
    if (b.type === 'code')
      return h.el(
        'pre',
        { class: 'read-code', tabindex: '0', 'aria-label': b.language ? `Code (${b.language})` : 'Code' },
        h.el('code', { text: b.text }),
      );
    if (b.type === 'quote')
      return h.el('blockquote', { class: 'read-quote' }, ...inline(h, b.text, ctx));
    if (b.type === 'line') return h.el('hr', { class: 'read-line' });
    if (b.type === 'table')
      return h.el(
        'div',
        { class: 'read-table', tabindex: '0', role: 'region', 'aria-label': 'Table' },
        h.el(
          'table',
          {},
          h.el(
            'thead',
            {},
            h.el(
              'tr',
              {},
              ...b.header.map((c) => h.el('th', { scope: 'col' }, ...inline(h, c, ctx))),
            ),
          ),
          h.el(
            'tbody',
            {},
            ...b.rows.map((r) =>
              h.el('tr', {}, ...r.map((c) => h.el('td', {}, ...inline(h, c, ctx)))),
            ),
          ),
        ),
      );
    return null;
  }

  function scrollTo(context) {
    const r = s.scroll;
    if (!r || r.context !== context) return;
    const entry = s.doc.get(s.show[context]?.path);
    if (entry?.status !== 'ok') return;
    s.scroll = null;
    const i = V.anchorIndex(entry.blocks, r.anchor);
    const art = document.querySelector(`[data-read="${CSS.escape(context)}"]`);
    if (!art) return;
    if (i < 0) {
      art.querySelector('.read-warning')?.remove();
      art.prepend(
        Object.assign(document.createElement('p'), {
          className: 'plans-help read-warning',
          textContent: `Did not find the anchor "${r.anchor}" in the document; showing the start.`,
        }),
      );
      return;
    }
    const template = art.querySelector(`[data-block="${i}"]`);
    if (template) art.scrollTop = template.offsetTop - art.offsetTop;
  }

  /** The document itself: the top with path, time and buttons, then the text in a cell that scrolls on its own. */
  function viewEl(h, context) {
    const v = s.show[context];
    if (!v?.path) return null;
    const ctx = { context, path: v.path };
    const d = s.doc.get(v.path);
    if (!d) getDoc(h, v.path);
    const top = h.el(
      'div',
      { class: 'read-top' },
      v.back.length
        ? h.el('button', {
            type: 'button',
            class: 'button-small button-outline',
            text: 'Back',
            title: `Back to ${v.back[v.back.length - 1].path}`,
            onclick: () => {
              const previous = v.back[v.back.length - 1];
              s.show[context] = { ...previous, back: v.back.slice(0, -1) };
              s.scroll = previous.anchor ? { context, anchor: previous.anchor } : null;
              h.draw({ focus: `read:${context}` });
            },
          })
        : null,
      h.el('code', { class: 'read-path', text: v.path }),
      v.anchor ? h.el('span', { class: 'badge', text: v.anchor }) : null,
      d?.status === 'ok'
        ? h.el('span', { class: 'plans-help', text: `changed ${h.date(d.data.changed)}` })
        : null,
      h.copyButton(v.path, `Copy path ${v.path}`),
      h.el('button', {
        type: 'button',
        class: 'button-small button-outline',
        text: 'Reload',
        'aria-label': `Reload ${v.path}`,
        onclick: () => {
          s.doc.delete(v.path);
          s.scroll = v.anchor ? { context, anchor: v.anchor } : null;
          getDoc(h, v.path);
          h.draw();
        },
      }),
      h.el('button', {
        type: 'button',
        class: 'button-small button-outline',
        text: 'Close',
        'aria-label': `Close the reader for ${v.path}`,
        onclick: () => {
          delete s.show[context];
          h.draw();
        },
      }),
    );
    let content;
    if (!d || d.status === 'loading')
      content = h.el('p', { class: 'empty', role: 'status', text: `Fetching ${v.path} …` });
    else if (d.status === 'error')
      content = h.el('p', { class: 'empty read-error', role: 'alert', text: d.message });
    else {
      // The blocks are built once per fetch (large documents become many nodes); the drawing only moves the element.
      if (!d.el || d.context !== context) {
        d.el = h.el(
          'div',
          { class: 'read-text' },
          ...d.blocks.map((b, i) => blockEl(h, b, i, ctx)),
        );
        d.context = context;
      }
      content = d.el;
      if (s.scroll?.context === context) requestAnimationFrame(() => scrollTo(context));
    }
    return h.el(
      'section',
      { class: 'read', 'aria-label': `Document ${v.path}` },
      top,
      h.el(
        'article',
        {
          class: 'read-doc',
          tabindex: '0',
          'data-read': context,
          'data-scroll': `read:${context}`,
          'data-focus': `read:${context}`,
          'aria-label': `The text of ${v.path}`,
        },
        content,
      ),
    );
  }

  /** The Documents tab in the detail panel: the sources with "Read", and the chosen source below. */
  function sourceTab(h, p) {
    const context = `entry:${p.id}`;
    const readable = p.sources.filter((k) => !V.readPathError(k.path));
    if (!s.show[context] && readable.length)
      s.show[context] = { path: readable[0].path, anchor: readable[0].anchor ?? null, back: [] };
    const selected = s.show[context];
    if (selected && !s.scroll && !s.doc.has(selected.path) && selected.anchor)
      s.scroll = { context, anchor: selected.anchor };
    return h.el(
      'div',
      {},
      h.list(
        p.sources.map((k) => {
          const error = V.readPathError(k.path);
          const isSel = selected?.path === k.path && (selected.anchor ?? null) === (k.anchor ?? null);
          return h.el(
            'li',
            { class: `plans-source${isSel ? ' read-selected' : ''}` },
            h.el('code', { text: k.path }),
            k.anchor ? h.el('span', { class: 'badge', text: k.anchor }) : null,
            k.role ? h.el('span', { class: 'badge', text: k.role }) : null,
            error
              ? h.el('span', { class: 'plans-help', text: `Not shown here: ${error}.` })
              : h.el('button', {
                  type: 'button',
                  class: 'button-small button-outline',
                  text: isSel ? 'Reading' : 'Read',
                  'aria-pressed': isSel ? 'true' : 'false',
                  'aria-label': `Read ${k.path}${k.anchor ? ` at ${k.anchor}` : ''}`,
                  onclick: () => {
                    s.show[context] = null;
                    openOnes(h, context, k.path, k.anchor, { back: false });
                  },
                }),
            h.copyButton(k.path, `Copy path ${k.path}`),
          );
        }),
        'The entry has no sources.',
      ),
      viewEl(h, context),
    );
  }

  // ---- The Unregistered box ----
  function newForm(h, d, filePath, type) {
    const u = s.unreg;
    if (u.form?.path === filePath && u.form.type === type) {
      u.form = null;
      h.draw({ focus: `unreg:${type}:${filePath}` });
      return;
    }
    const used = new Set(d.entries.map((p) => p.id));
    const proposed = V.entrySuggestion(filePath, used);
    u.form = {
      path: filePath,
      type,
      field:
        type === 'new'
          ? {
              id: proposed.id,
              title: proposed.title,
              project: '',
              priority: 'owner',
              category: '',
              reason: '',
            }
          : { entry: '', anchor: '' },
      preview: null,
      saves: false,
    };
    h.draw({ focus: `unregistered-field:${type === 'new' ? 'title' : 'entry'}` });
  }

  /** The local check before the preview (same rules as the server uses). */
  function localError(d, sk) {
    if (sk.type === 'new') return V.newEntryFromForm(sk.field, sk.path).error;
    const p = d.entries.find((x) => x.id === sk.field.entry.trim());
    if (!p) return ['select a plan entry that exists'];
    return V.sourceBonus(p, sk.path, sk.field.anchor).error;
  }

  function body(sk, extra) {
    return sk.type === 'new'
      ? { path: sk.path, form: sk.field, ...extra }
      : { path: sk.path, id: sk.field.entry.trim(), anchor: sk.field.anchor, ...extra };
  }
  const address = (sk) => (sk.type === 'new' ? '/api/plan-new' : '/api/plan-source');

  async function previewList(h, d) {
    const sk = s.unreg.form;
    if (!sk) return;
    const error = localError(d, sk);
    if (error.length) {
      sk.preview = { error, warnings: [], changes: [], can: false };
      h.draw({ focus: 'unregistered-preview' });
      return;
    }
    sk.preview = { loading: true };
    h.draw();
    try {
      const answer = await postJson(address(sk), body(sk, { dry: true }));
      sk.preview = { ...answer, error: [], can: true };
    } catch (e) {
      sk.preview = {
        error: [e.message],
        warnings: e.answer?.warnings ?? [],
        changes: [],
        can: false,
      };
    }
    h.draw({ focus: 'unregistered-preview' });
  }

  async function save(h) {
    const sk = s.unreg.form;
    if (!sk?.preview?.can || sk.saves) return;
    sk.saves = true;
    h.draw();
    let fresh = null;
    try {
      const answer = await postJson(address(sk), body(sk, { expect: sk.preview.changed ?? null }));
      h.message(answer?.message ?? 'Saved.');
      if (sk.type === 'new') fresh = sk.field.id;
      s.unreg.form = null;
      s.unreg.version = undefined; // the list is fetched again
    } catch (e) {
      // The form is kept. If the register changed meanwhile, the preview must be run again.
      sk.preview = { error: [e.message], warnings: [], changes: [], can: false };
      h.message(e.message, true);
    } finally {
      sk.saves = false;
    }
    await h.get(true);
    if (fresh) h.goToEntry(fresh);
    else h.draw();
  }

  function fieldEl(h, sk, name, label, input) {
    const id = `unregistered-${name}`;
    const edit = (e) => {
      sk.field[name] = e.target.value;
      if (sk.preview) {
        sk.preview = null;
        h.draw({ focus: `unregistered-field:${name}` });
      }
    };
    const control =
      input.tag === 'select'
        ? h.el(
            'select',
            {
              id,
              'data-focus': `unregistered-field:${name}`,
              onchange: (e) => {
                sk.field[name] = e.target.value;
                sk.preview = null;
                h.draw({ focus: `unregistered-field:${name}` });
              },
            },
            ...input.option.map(([v, t]) =>
              h.el('option', { value: v, selected: sk.field[name] === v ? true : null, text: t }),
            ),
          )
        : h.el('input', {
            id,
            type: 'text',
            value: sk.field[name],
            list: input.list ?? null,
            maxlength: input.max ? String(input.max) : null,
            placeholder: input.hint ?? null,
            autocomplete: 'off',
            'data-focus': `unregistered-field:${name}`,
            oninput: edit,
          });
    return h.el(
      'div',
      { class: 'unregistered-field' },
      h.el('label', { for: id, text: label }),
      control,
    );
  }

  function formEl(h, d, sk) {
    const keyPress = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        s.unreg.form = null;
        h.draw({ focus: `unreg:${sk.type}:${sk.path}` });
      }
    };
    const field =
      sk.type === 'new'
        ? [
            fieldEl(h, sk, 'title', 'Title', { max: 160 }),
            fieldEl(h, sk, 'id', 'Id', { max: 64, hint: 'PL-NAME-1' }),
            fieldEl(h, sk, 'project', 'Project', {
              tag: 'select',
              option: [
                ['', 'Select project'],
                ...Object.entries(d.projects ?? {})
                  .sort((a, b) => a[1].summary.localeCompare(b[1].summary, 'en'))
                  .map(([pid, p]) => [pid, `${p.summary} (${pid})`]),
              ],
            }),
            fieldEl(h, sk, 'priority', 'Priority', {
              tag: 'select',
              option: ['owner', 'later', 'now'].map((x) => [
                x,
                `${V.PRIORITY[x].symbol} ${V.PRIORITY[x].text}`,
              ]),
            }),
            sk.field.priority === 'now'
              ? fieldEl(h, sk, 'category', 'Category in Now', {
                  tag: 'select',
                  option: [['', 'Select category'], ...Object.entries(V.CATEGORY)],
                })
              : null,
            fieldEl(h, sk, 'reason', 'Reason (optional)', {
              max: 500,
              hint: 'Why this priority',
            }),
          ]
        : [
            fieldEl(h, sk, 'entry', 'Plan entry', { list: 'unregistered-poster', max: 64, hint: 'PL-…' }),
            h.el(
              'datalist',
              { id: 'unregistered-poster' },
              ...d.entries.map((p) => h.el('option', { value: p.id, label: p.title })),
            ),
            fieldEl(h, sk, 'anchor', 'Anchor (optional)', { max: 120, hint: 'Chapter 3' }),
          ];
    const f = sk.preview;
    return h.el(
      'div',
      {
        class: 'unregistered-form',
        role: 'group',
        'aria-label':
          sk.type === 'new' ? `New plan entry from ${sk.path}` : `Add ${sk.path} as source`,
        onkeydown: keyPress,
      },
      h.el('div', { class: 'unregistered-fields' }, ...field),
      h.el(
        'div',
        { class: 'unregistered-buttons' },
        h.el('button', {
          type: 'button',
          class: 'button button-muted',
          text: f?.loading ? 'Previewing …' : 'Preview',
          disabled: f?.loading || sk.saves ? true : null,
          onclick: () => previewList(h, d),
        }),
        h.el('button', {
          type: 'button',
          class: 'button button-filled',
          text: sk.saves ? 'Saving …' : 'Save',
          disabled: !f?.can || sk.saves ? true : null,
          title: f?.can ? null : 'Preview first',
          onclick: () => save(h),
        }),
        h.el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Cancel',
          onclick: () => {
            s.unreg.form = null;
            h.draw({ focus: `unreg:${sk.type}:${sk.path}` });
          },
        }),
      ),
      f && !f.loading
        ? h.el(
            'div',
            { class: 'unregistered-preview', tabindex: '-1', 'data-focus': 'unregistered-preview', role: 'status' },
            f.error.length
              ? h.el('ul', { class: 'unregistered-error' }, ...f.error.map((t) => h.el('li', { text: t })))
              : h.el('p', {
                  text: `Preview, nothing is saved yet: ${f.changes.length === 1 ? 'one change' : `${f.changes.length} changes`}.`,
                }),
            f.changes.length
              ? h.el(
                  'ul',
                  { class: 'plans-detail-list' },
                  ...f.changes.map((e) =>
                    h.el('li', {
                      text:
                        e.field === '*'
                          ? `${e.id}: new entry "${e.after?.title ?? ''}"`
                          : `${e.id}: ${e.field} changed`,
                    }),
                  ),
                )
              : null,
            (f.warnings ?? []).length
              ? h.el(
                  'ul',
                  { class: 'unregistered-warnings' },
                  ...f.warnings.map((t) => h.el('li', { text: `Warning: ${t}` })),
                )
              : null,
          )
        : null,
    );
  }

  function rowEl(h, d, filePath) {
    const sk = s.unreg.form?.path === filePath ? s.unreg.form : null;
    const isRead = s.show.unreg?.path === filePath;
    const button = (type, text, label) =>
      h.el('button', {
        type: 'button',
        class: 'button-small button-outline',
        text,
        'aria-label': label,
        'aria-expanded': sk?.type === type ? 'true' : 'false',
        'data-focus': `unreg:${type}:${filePath}`,
        onclick: () => newForm(h, d, filePath, type),
      });
    return h.el(
      'li',
      { class: `unregistered-row${sk || isRead ? ' read-selected' : ''}` },
      h.el(
        'div',
        { class: 'plans-source' },
        h.el('code', { text: filePath }),
        h.el('button', {
          type: 'button',
          class: 'button-small button-outline',
          text: isRead ? 'Reading' : 'Read',
          'aria-pressed': isRead ? 'true' : 'false',
          'aria-label': `Read ${filePath}`,
          'data-focus': `unreg:read:${filePath}`,
          onclick: () => {
            if (isRead) {
              delete s.show.unreg;
              h.draw({ focus: `unreg:read:${filePath}` });
            } else {
              s.show.unreg = null;
              openOnes(h, 'unreg', filePath, null, { back: false });
            }
          },
        }),
        button('new', 'New entry', `New plan entry with ${filePath} as source`),
        button('source', 'Add as source', `Add ${filePath} as source on a plan entry`),
        h.copyButton(filePath, `Copy path ${filePath}`),
      ),
      sk ? formEl(h, d, sk) : null,
      isRead ? viewEl(h, 'unreg') : null,
    );
  }

  /** The Unregistered box above the list (only on the Plan entries surface). Closed by default, with the count visible. */
  function unregisteredBox(h, d) {
    const u = s.unreg;
    if (u.version !== (d.changed ?? null) && !u.fetching) getUnregistered(h, d.changed ?? null);
    const list = u.data?.unregistered ?? [];
    const count = u.data ? list.length : null;
    const title =
      count == null
        ? u.error
          ? 'Unregistered: could not check'
          : 'Unregistered: checking …'
        : count === 0
          ? 'Unregistered: none, all documents have a plan entry'
          : `Unregistered: ${count} ${count === 1 ? 'document' : 'documents'} without a plan entry`;
    const open = u.open && count !== 0;
    return h.el(
      'section',
      { class: `unregistered${count ? ' has-unregistered' : ''}`, 'aria-label': 'Unregistered documents' },
      h.el(
        'h2',
        { class: 'unregistered-title' },
        h.el(
          'button',
          {
            type: 'button',
            class: 'unregistered-toggle',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': 'unregistered-content',
            disabled: count === 0 ? true : null,
            'data-focus': 'unregistered-toggle',
            onclick: () => {
              u.open = !u.open;
              setFlag(BOX_STORAGE, u.open);
              h.draw({ focus: 'unregistered-toggle' });
            },
          },
          h.el('span', { class: 'unregistered-arrow', 'aria-hidden': 'true', text: open ? '▾' : '▸' }),
          // The count is in the text (never only as color).
          h.el('span', { text: title }),
        ),
      ),
      open
        ? h.el(
            'div',
            { id: 'unregistered-content', class: 'unregistered-content' },
            h.el('p', {
              class: 'plans-help',
              text:
                'Documents in the document folders that no plan entry points to (cq plan check). Make a new entry, or add the document as source on an existing entry.',
            }),
            u.error ? h.el('p', { class: 'read-error', role: 'alert', text: u.error }) : null,
            ...(u.data?.groups ?? []).map((g) =>
              h.el(
                'div',
                { class: 'unregistered-group' },
                h.el('h3', {
                  class: 'plans-cell-title',
                  text: `${g.text} (${g.paths.length})`,
                }),
                h.el('ul', { class: 'unregistered-list' }, ...g.paths.map((filePath) => rowEl(h, d, filePath))),
              ),
            ),
          )
        : null,
    );
  }

  window.QueuePlanRead = { sourceTab, unregisteredBox };
})();
