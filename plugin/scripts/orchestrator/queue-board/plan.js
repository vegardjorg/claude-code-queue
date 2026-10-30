// =============================================================
// plan.js: the plan view on queue-board. Vanilla JS, no build step.
//
// Four columns: "Now" and "Next" are the focus period (the steps in order; Now = the first steps), "Later" is the rest
// (not started while the rest waits), and "Waiting" is projects on pause. Areas, projects and features are dragged between
// the columns with mouse or keyboard (Space lifts, the arrow keys move, Space drops, Esc cancels). The changes
// are collected in a draft; "Save focus" first shows what changes and what the queue starts next (POST /api/focus with dry),
// and saves only when the owner confirms (queue.mjs focus save, all or nothing, with the queue version from the
// preview). "Areas" creates and edits areas and moves projects between them (POST /api/area), also
// with an explanation before saving.
// The numbers (pending, ready, minutes, owner questions, dragged along) are computed on the server (queueBoard.planBasis);
// here there is only view and interaction. All text is set with textContent (via el), never innerHTML.
// =============================================================
'use strict';

(function () {
  const COLUMNS = [
    {
      key: 'now',
      name: 'Now',
      help:
        'The steps the queue takes first, in order from the top. Everything in a step starts before anything in the next step, regardless of score.',
    },
    {
      key: 'next',
      name: 'Next',
      help: 'The steps that come after Now, in order. They start when Now has nothing ready.',
    },
    {
      key: 'later',
      name: 'Later',
      help:
        'The rest of the queue. With "rest waits" nothing starts from here until the focus changes; with "fill free slots" ' +
        'only when the focus has nothing ready.',
    },
    {
      key: 'waiting',
      name: 'Waiting',
      help:
        'Projects on pause. They do not start, not even if something in focus waits on them. Drag a project here to ' +
        'pause it, or out of here to resume.',
    },
  ];
  const TYPE_NAME = { area: 'Area', project: 'Project', feature: 'Feature' };

  const s = {
    ctx: null,
    draft: null, // { now, next, pause: Set, rest, to, name, drag_with } (null = no unsaved changes)
    basis: null, // the server's plan (JSON) when the draft was started: changed meanwhile → remark
    openOnes: new Set(), // projects that show their features
    drag: null, // { key } while something is dragged with the mouse
    boosted: null, // { key, for } while something is lifted with the keyboard (for = draft before the lift, for Esc)
    dialog: null, // open dialog (preview or areas)
  };

  // ---- Helpers ----
  const el = (...a) => s.ctx.el(...a);
  const data = () => s.ctx.data;
  const typeFor = (key) => key.slice(0, key.indexOf(':'));
  const restFor = (key) => key.slice(key.indexOf(':') + 1);

  /** "49 h", "3 h 20 min", "45 min". */
  function time(min) {
    const m = Math.round(Number(min) || 0);
    if (m < 60) return `${m} min`;
    const t = Math.floor(m / 60);
    return t >= 10 || !(m % 60) ? `${t} h` : `${t} h ${m % 60} min`;
  }

  /** The plan as saved in the queue (focus and paused projects). */
  function serverPlan() {
    const f = data()?.focus;
    return {
      now: [...(f?.now ?? [])],
      next: [...(f?.next ?? [])],
      pause: new Set((data()?.plan?.projects ?? []).filter((p) => p.pause).map((p) => p.pid)),
      rest: f?.rest === 'fill' ? 'fill' : 'wait',
      to: f?.to ? String(f.to).slice(0, 10) : '',
      name: f?.name ?? '',
      drag_with: f ? f.drag_with !== false : true,
    };
  }
  const normal = (p) =>
    JSON.stringify({ ...p, pause: [...p.pause].sort(), now: p.now, next: p.next });
  const current = () => s.draft ?? serverPlan();
  const hasChanges = () => !!s.draft && normal(s.draft) !== normal(serverPlan());

  /** Starts a draft (first change) and remembers the server's plan, so the board can warn if the queue changes meanwhile. */
  function draft() {
    if (!s.draft) {
      s.draft = serverPlan();
      s.basis = normal(s.draft);
    }
    return s.draft;
  }
  function copy(p) {
    return { ...p, now: [...p.now], next: [...p.next], pause: new Set(p.pause) };
  }

  const projectRow = (pid) => data()?.plan?.projects.find((p) => p.pid === pid) ?? null;
  const areaRow = (oid) => data()?.plan?.areas.find((o) => o.oid === oid) ?? null;

  /** Title and numbers for an element (area, project or feature). */
  function info(key) {
    const type = typeFor(key);
    const rest = restFor(key);
    if (type === 'area') {
      const o = areaRow(rest);
      return { type, title: o?.title ?? rest, counts: o, exists: !!o?.in_register };
    }
    if (type === 'project') {
      const p = projectRow(rest);
      return { type, title: p?.title ?? rest, counts: p, exists: !!p };
    }
    const pid = rest.slice(0, rest.indexOf('/'));
    const name = rest.slice(rest.indexOf('/') + 1);
    const f = projectRow(pid)?.features.find((x) => x.name === name) ?? null;
    return { type, title: name, pid, counts: f, exists: !!f };
  }

  /** Where an element sits in the plan now: now, next, waiting (paused project) or later. */
  function columnFor(p, key) {
    if (p.now.includes(key)) return 'now';
    if (p.next.includes(key)) return 'next';
    if (typeFor(key) === 'project' && p.pause.has(restFor(key))) return 'waiting';
    return 'later';
  }

  // ---- Moving (shared by mouse and keyboard) ----
  /**
   * Moves an element to a column (at position `index` in Now/Next; otherwise last). Returns an error message when
   * the move makes no sense (an area or a feature cannot be paused).
   */
  function move(key, col, index = null) {
    const type = typeFor(key);
    if (col === 'waiting' && type !== 'project')
      return type === 'area'
        ? 'An area cannot be paused. Drag the projects in the area to Waiting, or leave the area in Later.'
        : 'A feature cannot be paused. Use "Put on hold" on the tasks, or leave the feature in Later.';
    const p = draft();
    p.now = p.now.filter((x) => x !== key);
    p.next = p.next.filter((x) => x !== key);
    if (type === 'project') p.pause.delete(restFor(key));
    if (col === 'now' || col === 'next') {
      const list = p[col];
      const i = index == null ? list.length : Math.max(0, Math.min(index, list.length));
      list.splice(i, 0, key);
    } else if (col === 'waiting') p.pause.add(restFor(key));
    return null;
  }

  // ---- Drawing ----
  function draw(ctx) {
    s.ctx = ctx;
    const d = data();
    const main = ctx.main;
    if (!d?.plan) {
      main.append(el('p', { class: 'empty', text: 'Fetching the queue …' }));
      return;
    }
    const p = current();
    const focus = document.activeElement?.closest?.('.plan-element')?.dataset.key ?? null;
    main.append(
      el(
        'div',
        { class: 'plan-view' },
        toolbar(p),
        el(
          'div',
          { class: 'plan-columns' },
          COLUMNS.map((k) => column(k, p)),
        ),
      ),
    );
    const template = s.boosted?.key ?? focus;
    if (template)
      main
        .querySelector(`.plan-element[data-key="${CSS.escape(template)}"]`)
        ?.focus({ preventScroll: !s.boosted });
  }

  function toolbar(p) {
    const changed = hasChanges();
    const serverChanged = s.draft && s.basis !== normal(serverPlan());
    const setField = (field, val) => {
      draft()[field] = val;
      s.ctx.drawOnNew();
    };
    const emptyNow = !p.now.length && p.next.length > 0;
    return el(
      'div',
      { class: 'plan-tool', role: 'toolbar', 'aria-label': 'Focus' },
      el(
        'label',
        {
          class: 'plan-field',
          title: 'A short name for the focus period, for example "Export first, then API". Optional.',
        },
        el('span', { text: 'Name' }),
        el('input', {
          type: 'text',
          maxlength: 200,
          value: p.name,
          placeholder: 'optional',
          'aria-label': 'Name of the focus period',
          onchange: (e) => setField('name', e.target.value.trim()),
        }),
      ),
      el(
        'label',
        {
          class: 'plan-field',
          title:
            'What happens to tasks outside Now and Next? "Wait fully" saves money: slots may stay empty. ' +
            '"Fill free slots" starts them only when the focus has nothing ready.',
        },
        el('span', { text: 'Rest' }),
        el(
          'select',
          {
            'aria-label': 'Rest of the queue',
            onchange: (e) => setField('rest', e.target.value),
          },
          el('option', { value: 'wait', text: 'waits fully', selected: p.rest === 'wait' }),
          el('option', {
            value: 'fill',
            text: 'fills free slots',
            selected: p.rest === 'fill',
          }),
        ),
      ),
      el(
        'label',
        {
          class: 'plan-field',
          title:
            'Optional end date (inclusive). Without a date the focus applies until you change it. When the period is over, ' +
            'you get a notice, and the queue goes by score again.',
        },
        el('span', { text: 'Until' }),
        el('input', {
          type: 'date',
          value: p.to,
          min: new Date().toISOString().slice(0, 10),
          'aria-label': 'Focus applies up to and including',
          onchange: (e) => setField('to', e.target.value || ''),
        }),
      ),
      el(
        'label',
        {
          class: 'plan-field plan-check-mark',
          title:
            'When something in focus waits on a task outside the steps (for example a data model another part builds on), ' +
            'that task gets the same step, so the focus does not stall. Recommended.',
        },
        el('input', {
          type: 'checkbox',
          checked: p.drag_with,
          onchange: (e) => setField('drag_with', e.target.checked),
        }),
        el('span', { text: 'Drag dependencies along' }),
      ),
      el('span', {
        class: `plan-draft${changed ? ' active' : ''}`,
        role: 'status',
        text: changed
          ? `Draft, not saved${serverChanged ? '. The queue has changed meanwhile; the preview checks against the new one.' : ''}`
          : 'No unsaved changes',
        title: changed
          ? 'The changes do not apply until you press "Save focus" and confirm.'
          : 'Drag areas, projects and features between the columns to edit the focus.',
      }),
      emptyNow
        ? el('span', {
            class: 'plan-remark',
            text: 'Now is empty: the first step in Next becomes Now when saved.',
          })
        : null,
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text: 'Areas …',
        title:
          'Create and name areas, and move projects between them. You see what changes before it ' +
          'is saved.',
        onclick: openAreas,
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text: 'Clear focus',
        disabled: !p.now.length && !p.next.length,
        title:
          'Moves all steps to Later in the draft. Saving without steps means no focus: the queue goes by score and ' +
          'projectBonus.',
        onclick: () => {
          const u = draft();
          u.now = [];
          u.next = [];
          s.ctx.drawOnNew();
        },
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text: 'Discard',
        disabled: !s.draft,
        title: 'Forget the draft and show the focus as saved in the queue. Nothing in the queue changes.',
        onclick: () => {
          s.draft = null;
          s.basis = null;
          s.ctx.drawOnNew();
        },
      }),
      el('button', {
        type: 'button',
        class: 'button button-filled button-small',
        text: 'Save focus',
        disabled: !changed,
        title:
          'First shows what changes and what the queue starts next. Nothing is saved until you confirm, and everything ' +
          'is saved together or not at all.',
        onclick: previewList,
      }),
    );
  }

  /** The elements in a column, in order. Later: areas, and projects without an area that are not elsewhere. */
  function elementsIn(col, p) {
    if (col === 'now' || col === 'next') return p[col];
    const d = data();
    if (col === 'waiting') return [...p.pause].sort().map((pid) => `project:${pid}`);
    const out = [];
    for (const o of d.plan.areas) {
      if (o.oid === 'without-area' || !o.in_register) continue;
      const key = `area:${o.oid}`;
      if (columnFor(p, key) === 'later') out.push(key);
    }
    // Projects without a (known) area, and features that have been in a step, sit on their own in Later.
    for (const pr of d.plan.projects) {
      const hasArea = d.plan.areas.some(
        (o) => o.in_register && o.oid !== 'without-area' && o.oid === pr.area,
      );
      const key = `project:${pr.pid}`;
      if (!hasArea && visibleProject(pr, p) && columnFor(p, key) === 'later')
        out.push(key);
    }
    return out;
  }

  /** Projects with something to do (pending or active), or that are in a step or on pause. */
  function visibleProject(pr, p) {
    const key = `project:${pr.pid}`;
    return (
      pr.waiting > 0 ||
      pr.activeOnes > 0 ||
      p.now.includes(key) ||
      p.next.includes(key) ||
      p.pause.has(pr.pid)
    );
  }

  function column(k, p) {
    const elements = elementsIn(k.key, p);
    const sorted = k.key === 'now' || k.key === 'next';
    const shift = k.key === 'next' ? p.now.length : 0;
    const sum = elements.reduce(
      (acc, n) => {
        const t = info(n).counts;
        return { waiting: acc.waiting + (t?.waiting ?? 0), min: acc.min + (t?.min_left ?? 0) };
      },
      { waiting: 0, min: 0 },
    );
    const list = el(
      'ol',
      {
        class: 'plan-list',
        'data-col': k.key,
        'aria-label': `${k.name}: ${elements.length} ${elements.length === 1 ? 'element' : 'elements'}`,
        ondragover: (e) => dragOver(e),
        ondragleave: (e) => {
          if (!e.currentTarget.contains(e.relatedTarget))
            e.currentTarget.classList.remove('release-her');
        },
        ondrop: (e) => release(e, k.key),
      },
      elements.length
        ? elements.map((n, i) => element(n, p, sorted ? shift + i + 1 : null))
        : el('li', {
            class: 'plan-empty',
            text:
              k.key === 'waiting'
                ? 'No projects on pause.'
                : k.key === 'later'
                  ? 'Everything is in focus.'
                  : 'Drag an area, project or feature here.',
          }),
    );
    return el(
      'section',
      { class: `plan-column plan-${k.key}`, 'aria-label': k.name },
      el(
        'header',
        { class: 'col-header', title: k.help },
        el('h2', { text: k.name }),
        el('span', {
          class: 'counter',
          text: `${sum.waiting} · ${time(sum.min)}`,
          title: `${sum.waiting} pending tasks, ${time(sum.min)} estimated left in the column`,
        }),
      ),
      el('p', { class: 'plan-col-help', text: k.help }),
      list,
    );
  }

  /** The number row for an area, project or feature (each number has an explanation in its title). */
  function counts(t, { pause = false } = {}) {
    if (!t) return el('span', { class: 'plan-tall', text: 'no open tasks' });
    const parts = [
      el('span', {
        text: `${t.waiting} waiting`,
        title: 'Pending tasks (excluding the batch queue and proposed)',
      }),
      el('span', {
        text: `${t.readyOnes} ready`,
        title:
          'No blockers apart from focus and pause: they can start as soon as they are in focus and a slot is free.',
      }),
      el('span', { text: time(t.min_left), title: 'Estimated time left for the pending ones' }),
    ];
    if (t.activeOnes)
      parts.push(
        el('span', { text: `${t.activeOnes} in progress`, title: 'Running, picked or in review' }),
      );
    if (t.parked)
      parts.push(
        el('span', { text: `${t.parked} on hold`, title: 'Parked tasks (Put on hold)' }),
      );
    if (t.question)
      parts.push(
        el('span', {
          class: 'plan-sp',
          text: `${t.question} question`,
          title: 'Open owner questions that tasks here are waiting on (see Waiting on you)',
        }),
      );
    if (t.dragged)
      parts.push(
        el('span', {
          class: 'plan-dragged',
          text: `↳ ${t.dragged} dragged along`,
          title:
            'Tasks here that something in focus waits on. They get the focus task\'s step, even if they sit outside the steps.',
        }),
      );
    if (pause) parts.push(el('span', { class: 'badge old', text: 'paused' }));
    return el('span', { class: 'plan-tall' }, parts);
  }

  /** One element (card) in a column: area with projects, project with its features, or feature. */
  function element(key, p, stepNr) {
    const i = info(key);
    const col = columnFor(p, key);
    const name = TYPE_NAME[i.type];
    const header = el(
      'div',
      { class: 'plan-header' },
      s.ctx.icon('handle'),
      stepNr
        ? el('span', {
            class: 'plan-step',
            text: `T${stepNr}`,
            title: `Step ${stepNr}: everything here starts before anything in step ${stepNr + 1}`,
          })
        : null,
      el('span', { class: `badge plan-type plan-type-${i.type}`, text: name }),
      el('span', {
        class: 'plan-name',
        text: i.type === 'feature' ? `${i.pid} › ${i.title}` : i.title,
      }),
      !i.exists
        ? el('span', {
            class: 'badge old',
            text: 'does not exist',
            title: 'The step points to something that no longer exists in the queue. Drag it to Later.',
          })
        : null,
    );
    const children = [];
    if (i.type === 'area') {
      // Projects in the area that are not in a step of their own or on pause (those are shown there).
      const mine = (i.counts?.projects ?? [])
        .map((pid) => projectRow(pid))
        .filter((pr) => pr && visibleProject(pr, p))
        .filter((pr) => columnFor(p, `project:${pr.pid}`) === 'later');
      const others = (i.counts?.projects ?? []).filter(
        (pid) => columnFor(p, `project:${pid}`) !== 'later',
      );
      if (mine.length)
        children.push(
          el(
            'ul',
            { class: 'plan-under' },
            mine.map((pr) => underElement(`project:${pr.pid}`, p)),
          ),
        );
      if (others.length)
        children.push(
          el('p', {
            class: 'plan-remark',
            text: `On their own: ${others.join(', ')}`,
            title:
              'Projects in the area that have a step of their own or are on pause. Their own step takes precedence over the area\'s step.',
          }),
        );
    }
    if (i.type === 'project') children.push(...featureList(restFor(key), p));
    return el(
      'li',
      {
        class: `plan-element plan-${i.type}${s.boosted?.key === key ? ' boosted' : ''}`,
        'data-key': key,
        tabindex: 0,
        draggable: 'true',
        'aria-label':
          `${name} ${i.title}, in ${COLUMNS.find((k) => k.key === col).name}` +
          `${stepNr ? `, step ${stepNr}` : ''}. Space lifts, the arrow keys move.`,
        title: `${name} ${i.title}. Drag to another column, or lift with Space and move with the arrow keys.`,
        ondragstart: (e) => dragStart(e, key),
        ondragend: dragEnd,
        onkeydown: (e) => keyPress(e, key),
      },
      header,
      counts(i.counts, { pause: i.type === 'project' && p.pause.has(restFor(key)) }),
      children,
    );
  }

  /** A project inside an area (can be dragged out to a step of its own or to Waiting). */
  function underElement(key, p) {
    const i = info(key);
    return el(
      'li',
      {
        class: `plan-element plan-child-element${s.boosted?.key === key ? ' boosted' : ''}`,
        'data-key': key,
        tabindex: 0,
        draggable: 'true',
        'aria-label': `Project ${i.title} in the area. Drag it out to give it a step of its own. Space lifts.`,
        title: `Project ${i.title}. Drag it out of the area to give it a step of its own (for example "Widgets now, the rest of Platform later"), or to Waiting to pause it.`,
        ondragstart: (e) => dragStart(e, key),
        ondragend: dragEnd,
        onkeydown: (e) => keyPress(e, key),
      },
      el(
        'div',
        { class: 'plan-header' },
        s.ctx.icon('handle'),
        el('span', { class: 'plan-name', text: i.title }),
        el('span', { class: 'pid', text: restFor(key) }),
      ),
      counts(i.counts),
      ...featureList(restFor(key), p),
    );
  }

  /** "▸ Features (6)" and, when open, the features (can be dragged to Now/Next as a step of their own). */
  function featureList(pid, p) {
    const pr = projectRow(pid);
    const features = (pr?.features ?? []).filter(
      (f) => f.waiting > 0 && columnFor(p, f.stage) === 'later',
    );
    if (!features.length) return [];
    const open = s.openOnes.has(pid);
    // The arrow is decoration (aria-hidden); the state is read from aria-expanded, the name from the text.
    const button = el(
      'button',
      {
        type: 'button',
        class: 'link-button plan-expand',
        'aria-expanded': open ? 'true' : 'false',
        title:
          'Show the features in the project. A feature can be dragged to Now or Next as a step of its own.',
        onclick: (e) => {
          e.stopPropagation();
          if (open) s.openOnes.delete(pid);
          else s.openOnes.add(pid);
          s.ctx.drawOnNew();
        },
      },
      el('span', { 'aria-hidden': 'true', text: open ? '▾ ' : '▸ ' }),
      `Features (${features.length})`,
    );
    if (!open) return [button];
    return [
      button,
      el(
        'ul',
        { class: 'plan-under plan-features' },
        features.map((f) =>
          el(
            'li',
            {
              class: `plan-element plan-feature-row${s.boosted?.key === f.stage ? ' boosted' : ''}`,
              'data-key': f.stage,
              tabindex: 0,
              draggable: 'true',
              'aria-label': `Feature ${f.name}. Drag to Now or Next to give it a step of its own. Space lifts.`,
              title: `Feature ${f.name}: drag to Now or Next to give it a step of its own.`,
              ondragstart: (e) => dragStart(e, f.stage),
              ondragend: dragEnd,
              onkeydown: (e) => keyPress(e, f.stage),
            },
            el(
              'div',
              { class: 'plan-header' },
              s.ctx.icon('handle'),
              el('span', { class: 'plan-name', text: f.name }),
            ),
            counts(f),
          ),
        ),
      ),
    ];
  }

  // ---- Drag with the mouse ----
  function dragStart(e, key) {
    e.stopPropagation();
    s.drag = { key };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
    e.currentTarget.classList.add('dragged');
  }
  function dragEnd(e) {
    e.currentTarget.classList.remove('dragged');
    for (const x of document.querySelectorAll('.plan-list.release-her'))
      x.classList.remove('release-her');
    s.drag = null;
    if (s.ctx.pending()) s.ctx.drawOnNew();
  }
  function dragOver(e) {
    if (!s.drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('release-her');
  }
  /** The position in the list where the element is dropped: before the first element whose middle is below the mouse. */
  function releaseIndex(list, y) {
    const elements = [...list.querySelectorAll(':scope > .plan-element')].filter(
      (x) => x.dataset.key !== s.drag?.key,
    );
    const i = elements.findIndex((x) => {
      const r = x.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return i < 0 ? elements.length : i;
  }
  function release(e, col) {
    if (!s.drag) return;
    e.preventDefault();
    const key = s.drag.key;
    const index = releaseIndex(e.currentTarget, e.clientY);
    s.drag = null;
    const error = move(key, col, index);
    if (error) s.ctx.message(error, true);
    s.ctx.drawOnNew();
  }

  // ---- Keyboard: Space lifts, arrows move, Space drops, Esc cancels ----
  function keyPress(e, key) {
    if (e.target !== e.currentTarget) return;
    const p = current();
    if (!s.boosted) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        s.boosted = { key, before: copy(p), hasDraft: !!s.draft };
        s.ctx.status(
          `${info(key).title} is lifted. The arrow keys move it (left and right between the columns), Space drops, Esc cancels.`,
        );
        s.ctx.drawOnNew();
      }
      return;
    }
    if (s.boosted.key !== key) return;
    const col = columnFor(p, key);
    const sequence = COLUMNS.map((k) => k.key);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      let j = sequence.indexOf(col) + (e.key === 'ArrowLeft' ? -1 : 1);
      // An area or a feature cannot be in Waiting: skip that column.
      if (sequence[j] === 'waiting' && typeFor(key) !== 'project') j = -1;
      if (j < 0 || j >= sequence.length) return;
      move(key, sequence[j]);
      s.ctx.status(`In ${COLUMNS[j].name}. Space drops, Esc cancels.`);
      s.ctx.drawOnNew();
    } else if (
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      (col === 'now' || col === 'next')
    ) {
      e.preventDefault();
      e.stopPropagation();
      const u = draft();
      const list = u[col];
      const i = list.indexOf(key);
      const j = i + (e.key === 'ArrowUp' ? -1 : 1);
      // Above the top of Next goes to the bottom of Now, and below the bottom of Now to the top of Next.
      if (j < 0 && col === 'next') move(key, 'now');
      else if (j >= list.length && col === 'now') move(key, 'next', 0);
      else if (j >= 0 && j < list.length) {
        list.splice(i, 1);
        list.splice(j, 0, key);
      } else return;
      const fresh = current();
      const newCol = columnFor(fresh, key);
      const space = fresh[newCol].indexOf(key) + 1;
      s.ctx.status(`Position ${space} of ${fresh[newCol].length} in ${newCol === 'now' ? 'Now' : 'Next'}.`);
      s.ctx.drawOnNew();
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      s.boosted = null;
      s.ctx.status('Dropped. The change is in the draft until you press "Save focus".');
      s.ctx.drawOnNew();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const l = s.boosted;
      s.boosted = null;
      s.draft = l.hasDraft ? l.before : null;
      if (!l.hasDraft) s.basis = null;
      s.ctx.status('Cancelled.');
      s.ctx.drawOnNew();
    }
  }

  // ---- The dialog (focus preview, areas) ----
  function makeDialog() {
    let background = document.getElementById('plan-dialog-background');
    if (!background) {
      background = el(
        'div',
        { id: 'plan-dialog-background', class: 'guard-background', hidden: true },
        el('div', {
          id: 'plan-dialog',
          class: 'guard bulk plan-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'plan-dialog-title',
        }),
      );
      background.addEventListener('click', (e) => {
        if (e.target === background) closeDialog();
      });
      background.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeDialog();
        } else {
          // Focus stays in the dialog (the shared trap in a11y.js).
          window.QueueA11y.trapKey(e, document.getElementById('plan-dialog'));
        }
      });
      document.body.append(background);
    }
    return background;
  }
  function showDialog(content, focusSelector) {
    const background = makeDialog();
    const box = document.getElementById('plan-dialog');
    if (!s.dialog) s.dialog = { from: document.activeElement };
    box.replaceChildren(...content);
    background.hidden = false;
    const template =
      (focusSelector ? box.querySelector(focusSelector) : null) ?? box.querySelector('button');
    template?.focus();
  }
  function closeDialog() {
    const background = document.getElementById('plan-dialog-background');
    if (background) background.hidden = true;
    const from = s.dialog?.from;
    s.dialog = null;
    if (from?.isConnected) from.focus();
    s.ctx?.drawOnNew();
  }
  const open = () => !!s.dialog;

  /** The plan sent to the server (Now empty and Next not: the first in Next becomes Now). */
  function planForServer(p) {
    const order = [...p.now, ...p.next];
    const serverPause = serverPlan().pause;
    return {
      order,
      ...(order.length ? { now_count: Math.max(p.now.length, 1) } : {}),
      rest: p.rest,
      to: p.to || null,
      name: p.name || null,
      drag_with_dependencies: p.drag_with,
      pause: [...p.pause].filter((pid) => !serverPause.has(pid)),
      continue: [...serverPause].filter((pid) => !p.pause.has(pid)),
    };
  }

  async function previewList() {
    const plan = planForServer(current());
    showDialog([
      el('h2', { id: 'plan-dialog-title', text: 'Save focus' }),
      el('p', { class: 'bulk-loading', text: 'Working out what changes …' }),
    ]);
    let answer;
    try {
      answer = await s.ctx.api('/api/focus', { plan, dry: true });
    } catch (e) {
      return showDialog([
        el('h2', { id: 'plan-dialog-title', text: 'Save focus' }),
        el('p', { class: 'bulk-error', text: e.message }),
        buttons([['Close', closeDialog, 'button-outline']]),
      ]);
    }
    const content = [
      el('h2', { id: 'plan-dialog-title', text: 'Save focus' }),
      el('p', {
        class: 'bulk-explanation',
        text:
          'The focus decides the order in which the queue starts work: everything in step 1 before step 2, regardless of score. ' +
          'Review what changes before you save. Nothing is saved yet.',
      }),
      el(
        'dl',
        { class: 'facts' },
        el('dt', { text: 'Before' }),
        el('dd', { text: answer.before_text }),
        el('dt', { text: 'After' }),
        el('dd', { text: answer.after_text }),
      ),
    ];
    if (answer.error?.length)
      content.push(
        el(
          'ul',
          { class: 'guard-list bulk-error' },
          answer.error.map((x) => el('li', { text: x })),
        ),
      );
    if (answer.lines?.length)
      content.push(
        el(
          'ul',
          { class: 'plan-lines' },
          answer.lines.map((x) => el('li', { text: x })),
        ),
      );
    if (answer.warnings?.length)
      content.push(
        el('h3', { class: 'setting-title', text: 'Warnings' }),
        el(
          'ul',
          { class: 'guard-list' },
          answer.warnings.map((x) => el('li', { text: x })),
        ),
      );
    if (answer.next_text)
      content.push(
        el('h3', { class: 'setting-title', text: 'Next up after saving' }),
        el('p', { class: 'sp-meta', text: answer.next_text }),
        answer.next?.length
          ? el(
              'ul',
              { class: 'plan-lines' },
              answer.next.map((v) => el('li', null, el('code', { text: v.id }), ` ${v.title}`)),
            )
          : null,
      );
    content.push(
      buttons([
        ['Cancel', closeDialog, 'button-outline'],
        answer.can ? ['Save focus', () => save(plan, answer.changed), 'button-filled'] : null,
      ]),
    );
    showDialog(content, '.button-filled');
  }

  async function save(plan, expectValue) {
    try {
      const answer = await s.ctx.api('/api/focus', { plan, expect: expectValue });
      s.draft = null;
      s.basis = null;
      closeDialog();
      s.ctx.messageWithInfo(answer.message ?? 'Focus saved', answer);
      await s.ctx.update(true);
    } catch (e) {
      if (e.answer?.outdated) {
        s.ctx.message('The queue has changed since the preview. Here is the new one.', true);
        await s.ctx.update(true);
        return previewList();
      }
      s.ctx.message(e.message, true);
    }
  }

  function buttons(list) {
    return el(
      'div',
      { class: 'guard-buttons' },
      list
        .filter(Boolean)
        .map(([text, fn, cls]) =>
          el('button', { type: 'button', class: `button ${cls}`, text, onclick: fn }),
        ),
    );
  }

  // ---- Areas (POST /api/area): explanation before saving ----
  function openAreas() {
    const d = data();
    const areas = d.plan.areas.filter((o) => o.in_register && o.oid !== 'without-area');
    const newId = el('input', {
      id: 'area-new-id',
      type: 'text',
      maxlength: 40,
      placeholder: 'e.g. export',
      autocomplete: 'off',
    });
    const newTitle = el('input', {
      id: 'area-new-title',
      type: 'text',
      maxlength: 200,
      placeholder: 'e.g. Export',
      autocomplete: 'off',
    });
    const content = [
      el('h2', { id: 'plan-dialog-title', text: 'Areas' }),
      el('p', {
        class: 'bulk-explanation',
        text:
          'An area groups projects that belong together, so you prioritize a few areas instead ' +
          'of many projects. A project belongs to one area. Every change is shown before it is saved.',
      }),
      el('h3', { class: 'setting-title', text: 'The areas' }),
      areas.length
        ? el(
            'ul',
            { class: 'plan-area-list' },
            areas.map((o) => {
              const title = el('input', {
                type: 'text',
                maxlength: 200,
                value: o.title ?? '',
                'aria-label': `Title of the area ${o.oid}`,
              });
              return el(
                'li',
                { class: 'plan-area-row' },
                el('code', { text: o.oid }),
                title,
                el('button', {
                  type: 'button',
                  class: 'button button-outline button-small',
                  text: 'Save title',
                  title: 'Give the area a new title. You see the change before it is saved.',
                  onclick: () =>
                    areaAction({ action: 'save', oid: o.oid, title: title.value.trim() }),
                }),
                el('button', {
                  type: 'button',
                  class: 'button button-outline button-small',
                  text: 'Delete',
                  disabled: o.projects.length > 0,
                  title: o.projects.length
                    ? `Move the projects out first (${o.projects.join(', ')}).`
                    : 'Delete the area. Refused while the focus uses it.',
                  onclick: () => areaAction({ action: 'delete', oid: o.oid }),
                }),
              );
            }),
          )
        : el('p', { class: 'empty', text: 'No areas yet. Create the first one below.' }),
      el('h3', { class: 'setting-title', text: 'New area' }),
      el(
        'div',
        { class: 'plan-area-new' },
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'area-new-id', text: 'Id (short, lowercase letters and hyphens)' }),
          newId,
        ),
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'area-new-title', text: 'Title' }),
          newTitle,
        ),
        el('button', {
          type: 'button',
          class: 'button button-muted button-small',
          text: 'Create area',
          title: 'Creates the area. You see the change before it is saved.',
          onclick: () =>
            areaAction({
              action: 'save',
              oid: newId.value.trim(),
              title: newTitle.value.trim(),
            }),
        }),
      ),
      el('h3', { class: 'setting-title', text: 'Projects' }),
      el(
        'ul',
        { class: 'plan-area-list' },
        d.plan.projects
          .filter((pr) => pr.movable)
          .map((pr) =>
            el(
              'li',
              { class: 'plan-area-row' },
              el('span', { class: 'plan-name', text: pr.title ?? pr.pid }),
              el('code', { text: pr.pid }),
              el(
                'select',
                {
                  'aria-label': `Area for ${pr.pid}`,
                  title: 'Move the project to another area. You see the change before it is saved.',
                  onchange: (e) =>
                    areaAction({ action: 'move', pid: pr.pid, oid: e.target.value || null }),
                },
                el('option', {
                  value: '',
                  text: 'No area',
                  selected: !areas.some((o) => o.oid === pr.area),
                }),
                areas.map((o) =>
                  el('option', {
                    value: o.oid,
                    text: o.title ?? o.oid,
                    selected: o.oid === pr.area,
                  }),
                ),
              ),
            ),
          ),
      ),
      buttons([['Close', closeDialog, 'button-outline']]),
    ];
    showDialog(content);
  }

  async function areaAction(b) {
    let answer;
    try {
      answer = await s.ctx.api('/api/area', { ...b, dry: true });
    } catch (e) {
      return s.ctx.message(e.message, true);
    }
    if (!answer.can) {
      s.ctx.message(answer.error.join('\n'), true);
      return openAreas();
    }
    showDialog(
      [
        el('h2', { id: 'plan-dialog-title', text: 'Edit area' }),
        el(
          'ul',
          { class: 'plan-lines' },
          answer.lines.map((x) => el('li', { text: x })),
        ),
        buttons([
          ['Cancel', openAreas, 'button-outline'],
          [
            'Save',
            async () => {
              try {
                const r = await s.ctx.api('/api/area', { ...b, expect: answer.changed });
                s.ctx.message(r.message || 'Saved');
                await s.ctx.update(true);
              } catch (e) {
                s.ctx.message(e.message, true);
                if (e.answer?.outdated) await s.ctx.update(true);
              }
              openAreas();
            },
            'button-filled',
          ],
        ]),
      ],
      '.button-filled',
    );
  }

  window.QueuePlan = {
    draw,
    /** Should the board hold off redrawing (something is dragged or lifted, or a dialog is open)? */
    busy: () => !!s.drag || !!s.boosted || open(),
    /** Does the plan have an unsaved draft (the focus line says so)? */
    hasDraft: hasChanges,
    openAreas: (ctx) => {
      s.ctx = ctx;
      openAreas();
    },
  };
})();
