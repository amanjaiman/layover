/* Layover renderer. Vanilla JS. The room stays still: nothing re-renders under a cursor. */
(() => {
  'use strict';
  const api = window.layover;
  const $ = (sel, root = document) => root.querySelector(sel);
  const AGENT = { claude: 'Claude Code', codex: 'Codex', test: 'Test agent' };
  const KIND_LABEL = { suggestion: 'Think ahead', decision: 'Decision made', question: 'Input requested', opportunity: 'Opportunity' };
  const KIND_ORDER = { question: 0, decision: 1, suggestion: 2, opportunity: 3 };
  const VIEWS = [['now', 'Now'], ['next', 'Next'], ['notes', 'Notes'], ['break', 'Break']];
  const STRETCHES = [
    ['Shoulders', 'Roll your shoulders back five times, slowly. Let your arms hang.'],
    ['Eyes', 'Look at something at least six metres away for twenty seconds. Blink a few times.'],
    ['Neck', 'Tilt your right ear toward your right shoulder. Breathe. Switch sides.'],
    ['Wrists', 'Extend one arm, palm up. Gently pull the fingers back with the other hand. Switch.'],
    ['Stand', 'Stand up. Reach both hands toward the ceiling, then fold forward and let your head hang.'],
    ['Breathe', 'In for four, hold for four, out for six. Three rounds.'],
    ['Water', 'Get a glass of water. Drink it somewhere that is not your desk.'],
    ['Hips', 'Sit tall, cross one ankle over the other knee, and lean forward a little. Switch.'],
  ];

  const S = {
    state: null, settings: null, project: null, view: 'now', mode: 'expanded', users: {},
    viewKey: '', pendingRefresh: false, acked: {}, offers: new Map(), theme: 'system',
    breakTimer: null, breakLeft: 0, breakTotal: 300, lastBreak: Date.now(), reminderShown: 0, stretchIndex: 0,
    lastInteraction: 0, popover: null, notesConflict: null,
  };

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v; // only ever static markup from this file
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const svg = (d, size = 14) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('fill', 'none'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<path d="${d}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`; return s; };
  const ICON = { check: 'M3 8.5l3 3 7-7', copy: 'M6 6h7v7H6zM3 10V3h7', x: 'M4 4l8 8M12 4l-8 8', arrow: 'M3 8h10M9 4l4 4-4 4', plus: 'M8 3v10M3 8h10', trash: 'M3 4h10M6 4V2.5h4V4M5 4l.6 9h4.8L11 4' };
  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`;
  }
  function dur(ms) { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; }
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; return d; };
  async function call(p) { const r = await p; if (!r.ok) throw Error(r.error); return r.value; }
  function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
  function initials(name) { const w = String(name || '?').replace(/[_-]+/g, ' ').trim().split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase(); }
  function projectName(p) { return p?.displayName || p?.name || 'Workspace'; }
  function isEngaged() { const a = document.activeElement; const editing = a && $('#view')?.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT'); return (editing && Date.now() - S.lastInteraction < 15000) || Date.now() - S.lastInteraction < 5000; }

  // ---------- derived ----------
  function project() { return S.state?.projects.find(p => p.id === S.project) || null; }
  function user(id = S.project) { return S.users[id] || null; }
  function runsOf(id) { return (S.state?.runs || []).filter(r => r.project === id).sort((a, b) => b.startedAt - a.startedAt); }
  function tasksOf(id) { return (S.state?.tasks || []).filter(t => t.project === id); }
  function activeRuns(id) { return runsOf(id).filter(r => r.status === 'active'); }
  function latestRun(id) { return runsOf(id)[0] || null; }
  function itemsOf(id) {
    const u = user(id) || { dismissed: {} };
    return (S.state?.items || []).filter(i => i.project === id).map(i => ({ ...i, userDismissed: !!u.dismissed[i.key] }));
  }
  function openItems(id) {
    return itemsOf(id).filter(i => i.status === 'open' && !i.userDismissed).sort((a, b) => (b.waiting - a.waiting) || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (b.updatedAt - a.updatedAt));
  }
  function projectStatus(id) {
    const active = activeRuns(id);
    if (active.length) return { cls: 'working', label: `${AGENT[active[0].agent] || active[0].agent} working${active.length > 1 ? ` · ${active.length} runs` : ''}`, run: active[0] };
    const waiting = openItems(id).find(i => i.waiting);
    const last = latestRun(id);
    if (waiting && last && last.status === 'active') return { cls: 'attention', label: 'Waiting on you', run: last };
    if (last && !S.acked[last.id] && Date.now() - last.endedAt < 12 * 3600000) {
      if (last.status === 'completed') return { cls: 'done', label: 'Ready when you are', run: last };
      if (last.status === 'failed') return { cls: 'attention', label: 'Stopped with an error', run: last };
      if (last.status === 'cancelled') return { cls: 'attention', label: 'Interrupted', run: last };
      if (last.status === 'disconnected') return { cls: 'attention', label: 'No recent signal', run: last };
    }
    return { cls: 'quiet', label: last ? `Quiet · last run ${ago(last.endedAt || last.startedAt)}` : 'Quiet', run: last };
  }

  // ---------- boot ----------
  async function boot() {
    S.settings = await call(api.getSettings());
    S.state = await call(api.getState());
    S.mode = S.settings.window?.mode || 'expanded';
    document.body.classList.toggle('compact', S.mode === 'compact');
    applyTheme({ theme: S.settings.theme, dark: matchMedia('(prefers-color-scheme: dark)').matches });
    const visible = visibleProjects();
    S.project = visible.find(p => p.id === S.settings.window?.lastProject)?.id || visible[0]?.id || null;
    if (S.project) await loadUser(S.project);
    restorePlace();
    render(true);
    if (!S.settings.onboarded) openSettings({ onboarding: true });
    api.on('state', st => { S.state = st; onState(); });
    api.on('open-request', onOpenRequest);
    api.on('theme', applyTheme);
    api.on('settings', s => { S.settings = { ...S.settings, ...s }; });
    api.on('window-mode', m => { S.mode = m; document.body.classList.toggle('compact', m === 'compact'); render(true); });
    api.on('run-ended', onRunEnded);
    setInterval(tick, 30000);
    document.addEventListener('keydown', onKey);
    ['keydown', 'pointerdown', 'input'].forEach(evn => document.addEventListener(evn, () => { S.lastInteraction = Date.now(); api.engaged(true); }, { passive: true }));
    document.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRefresh && !isEngaged()) { S.pendingRefresh = false; render(); } api.engaged(isEngaged()); }, 400));
    $('#add-ws').addEventListener('click', addWorkspace);
    $('#btn-settings').addEventListener('click', () => openSettings({}));
    $('#btn-compact').addEventListener('click', () => api.setWindowMode('compact'));
    $('#btn-expand').addEventListener('click', () => api.setWindowMode('expanded'));
    $('#compact-ws').addEventListener('change', e => switchProject(e.target.value));
  }
  function visibleProjects() { return (S.state?.projects || []).filter(p => !p.hidden).sort((a, b) => b.lastActive - a.lastActive); }
  async function loadUser(id) { S.users[id] = await call(api.getUser(id)); return S.users[id]; }
  function applyTheme({ theme, dark }) {
    S.theme = theme;
    if (theme === 'dark' || (theme === 'system' && dark)) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }
  function restorePlace() { const u = user(); if (u?.place?.view && VIEWS.some(v => v[0] === u.place.view)) S.view = u.place.view; else S.view = 'now'; }
  function savePlace(extra = {}) { if (S.project) api.setPlace(S.project, { view: S.view, ...extra }); api.setSettings({ window: {} }); }

  async function switchProject(id, { view } = {}) {
    if (!id || id === S.project) { if (view) setView(view); return; }
    flushAll();
    S.project = id;
    if (!user(id)) await loadUser(id);
    restorePlace();
    if (view) S.view = view;
    S.settings.window.lastProject = id;
    api.setSettings({ window: {} }); // touch; lastProject is kept in memory only
    render(true);
  }
  function setView(v) { if (S.view === v) return; flushAll(); S.view = v; savePlace(); render(true); }
  function flushAll() { for (const f of Object.values(S.flushers || {})) { try { f(); } catch { /* best effort */ } } S.flushers = {}; }
  function registerFlush(key, fn) { (S.flushers ??= {})[key] = fn; }

  // ---------- pushes ----------
  function onState() {
    if (!S.project || !S.state.projects.some(p => p.id === S.project)) S.project = visibleProjects()[0]?.id || null;
    if (S.project && !user(S.project)) loadUser(S.project).then(() => render());
    renderRail(); renderHead(); renderBanners(); renderCompactNav();
    if (isEngaged()) { S.pendingRefresh = true; return; }
    renderView();
  }
  function onOpenRequest(req) {
    if (!S.state) return;
    if (!S.state.projects.some(p => p.id === req.project)) return;
    if (req.project === S.project) { if (req.reason === 'notification') setView('now'); return; }
    const engaged = req.engaged || isEngaged();
    const p = S.state.projects.find(x => x.id === req.project);
    const task = S.state.tasks.find(t => t.id === req.task);
    const who = task ? AGENT[task.agent] || task.agent : 'An agent';
    if (!engaged && (req.explicit || req.wasVisible === false || req.reason === 'notification')) { switchProject(req.project, { view: 'now' }); return; }
    if (S.offers.has(req.project)) return;
    const t = toast({ cls: 'gold', text: [el('b', { text: who }), ` is working in `, el('b', { text: projectName(p) }), '.'], ttl: 0, actions: [
      { label: 'Switch', primary: true, fn: () => { S.offers.delete(req.project); switchProject(req.project, { view: 'now' }); } },
      { label: 'Stay here', fn: () => S.offers.delete(req.project) },
    ] });
    S.offers.set(req.project, t);
  }
  function onRunEnded({ run, status, project: pid }) {
    if (pid === S.project) return; // the banner handles it
    const r = S.state.runs.find(x => x.id === run); const p = S.state.projects.find(x => x.id === pid);
    if (!r || !p) return;
    const label = status === 'completed' ? 'finished' : status === 'failed' ? 'stopped with an error' : status === 'cancelled' ? 'was interrupted' : 'went quiet';
    toast({ text: [el('b', { text: AGENT[r.agent] || r.agent }), ` ${label} in `, el('b', { text: projectName(p) }), '.'], ttl: 9000, actions: [{ label: 'Go there', fn: () => switchProject(pid, { view: 'now' }) }] });
  }
  function tick() {
    if (!isEngaged() && S.pendingRefresh) { S.pendingRefresh = false; render(); }
    else { renderRail(); renderHead(); }
    const br = S.settings.breakReminder;
    if (br?.enabled && S.view !== 'break' && Date.now() - S.lastBreak > br.minutes * 60000 && Date.now() - S.reminderShown > br.minutes * 60000) {
      S.reminderShown = Date.now();
      if (br.mode === 'auto') { const go = () => { if (isEngaged()) setTimeout(go, 10000); else { setView('break'); toast({ text: 'Break time. Your place is kept.', ttl: 6000 }); } }; go(); }
      else toast({ text: `You've been at it for ${br.minutes} minutes. Take a short break?`, ttl: 0, actions: [{ label: 'Take a break', primary: true, fn: () => setView('break') }, { label: 'Later', fn: () => {} }] });
    }
  }
  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { closeOverlay(); closePopover(); return; }
    if (!mod) return;
    if (e.key >= '1' && e.key <= '4') { e.preventDefault(); setView(VIEWS[Number(e.key) - 1][0]); }
    else if (e.key === ',') { e.preventDefault(); openSettings({}); }
    else if (e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); if (S.view !== 'next') setView('next'); newNext(); }
    else if (e.key.toLowerCase() === 'c' && e.shiftKey) { e.preventDefault(); api.setWindowMode(S.mode === 'compact' ? 'expanded' : 'compact'); }
  }

  // ---------- render ----------
  function render(force = false) { renderRail(); renderHead(); renderBanners(); renderCompactNav(); renderView(force); }

  function renderRail() {
    const list = $('#ws-list'); list.textContent = '';
    const ps = visibleProjects();
    if (!ps.length) list.append(el('p', { class: 't-small', style: 'padding:8px 10px' }, 'No workspaces yet. An agent will create one when it starts, or add one yourself.'));
    for (const p of ps) {
      const st = projectStatus(p.id);
      const waiting = openItems(p.id).some(i => i.waiting);
      list.append(el('button', { class: 'ws', role: 'listitem', 'aria-current': p.id === S.project ? 'true' : 'false', onclick: () => switchProject(p.id), title: p.path || '' },
        el('span', { class: 'ws-tok', style: `background:var(--ws-${p.color})` }, initials(projectName(p))),
        el('span', { style: 'display:grid;min-width:0' }, el('span', { class: 'ws-name', text: projectName(p) }), el('span', { class: 'ws-sub', text: st.label })),
        el('span', { class: 'dot ' + (waiting && st.cls !== 'working' ? 'attention' : st.cls) })));
    }
    const sel = $('#compact-ws'); sel.textContent = '';
    for (const p of ps) sel.append(el('option', { value: p.id, text: projectName(p), selected: p.id === S.project }));
    $('#compact-ws').hidden = S.mode !== 'compact'; $('#compact-mark').hidden = S.mode !== 'compact'; $('#btn-expand').hidden = S.mode !== 'compact';
  }

  function renderHead() {
    const h = $('#head'); h.textContent = '';
    const p = project();
    if (!p) { h.append(el('h1', { text: 'Layover' })); return; }
    const st = projectStatus(p.id);
    const row = el('div', { class: 'head-row' }, el('h1', { text: projectName(p) }), el('button', { class: 'status ' + st.cls, onclick: (e) => runsPopover(e.currentTarget) }, el('span', { class: 'dot ' + st.cls }), st.label));
    const open = openItems(p.id).length, next = (user(p.id)?.next || []).filter(n => n.status === 'open').length;
    const tabs = el('div', { class: 'tabs', role: 'tablist' });
    for (const [id, label] of VIEWS) {
      const count = id === 'now' ? open : id === 'next' ? next : 0;
      tabs.append(el('button', { class: 'tab', role: 'tab', 'aria-selected': S.view === id ? 'true' : 'false', onclick: () => setView(id) }, label, count ? el('span', { class: 'count' + (id === 'now' && openItems(p.id).some(i => i.waiting) ? ' hot' : ''), text: String(count) }) : null));
    }
    if (S.mode !== 'compact') h.append(row, tabs); else h.append(row);
  }

  function renderCompactNav() {
    const n = $('#cnav'); n.textContent = '';
    if (S.mode !== 'compact' || !S.project) return;
    const open = openItems(S.project).length, next = (user()?.next || []).filter(x => x.status === 'open').length;
    for (const [id, label] of VIEWS) n.append(el('button', { 'aria-selected': S.view === id ? 'true' : 'false', onclick: () => setView(id) }, label, el('span', { class: 'count', text: id === 'now' && open ? String(open) : id === 'next' && next ? String(next) : ' ' })));
  }

  function renderBanners() {
    const b = $('#banners'); b.textContent = '';
    const p = project(); if (!p) return;
    const u = user(p.id);
    for (const r of runsOf(p.id).slice(0, 6)) {
      if (r.status === 'active' || S.acked[r.id] || u?.place?.acked?.[r.id] || Date.now() - r.endedAt > 12 * 3600000) continue;
      const who = AGENT[r.agent] || r.agent;
      const cls = r.status === 'completed' ? 'done' : r.status === 'disconnected' ? 'warn' : r.status === 'failed' ? 'danger' : 'warn';
      const msg = r.status === 'completed' ? [el('b', { text: 'Ready when you are.' }), ` ${who} finished${r.title ? ' “' + r.title + '”' : ''}.`]
        : r.status === 'failed' ? [el('b', { text: `${who} stopped with an error.` }), r.endNote ? ' ' + r.endNote : '']
        : r.status === 'cancelled' ? [el('b', { text: `${who} was interrupted.` }), r.endNote ? ' ' + r.endNote : '']
        : [el('b', { text: `No recent signal from ${who}.` }), ' It may still be thinking, or the session may have closed.'];
      b.append(el('div', { class: 'banner ' + cls }, el('span', { class: 'txt' }, ...msg),
        el('button', { class: 'btn small primary', onclick: () => returnSheet(r) }, `Return to ${who}`, svg(ICON.arrow, 13)),
        el('button', { class: 'btn small ghost', onclick: () => ack(r.id) }, 'Stay here')));
    }
    if (S.notesConflict && S.view === 'notes') b.append(el('div', { class: 'banner warn' }, el('span', { class: 'txt' }, el('b', { text: 'These notes changed elsewhere.' }), ' Your text is kept here until you choose.'),
      el('button', { class: 'btn small', onclick: () => { api.copy(S.notesConflict.mine); toast({ text: 'Your version is on the clipboard.', ttl: 4000 }); } }, 'Copy mine'),
      el('button', { class: 'btn small primary', onclick: async () => { S.notesConflict = null; await loadUser(S.project); render(true); } }, 'Load the saved version')));
  }
  function ack(runId) { S.acked[runId] = true; const u = user(); if (u) { u.place.acked = { ...(u.place.acked || {}), [runId]: Date.now() }; api.setPlace(S.project, { acked: u.place.acked }); } renderBanners(); renderHead(); renderRail(); }

  function renderView(force = false) {
    const key = `${S.project}|${S.view}|${S.mode}`;
    const v = $('#view');
    if (!force && key === S.viewKey && S.view !== 'now') return;
    if (S.view === 'now' && !force && key === S.viewKey && isEngaged()) { S.pendingRefresh = true; return; }
    S.viewKey = key; S.pendingRefresh = false;
    v.textContent = '';
    if (!S.project) { v.append(el('div', { class: 'empty' }, el('p', {}, el('b', { text: 'Nothing here yet.' }), ' Layover fills in when Claude Code or Codex starts working in a folder. Connect them in Settings, or add a workspace by hand.'), el('p', { style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: () => openSettings({}) }, 'Open Settings')))); return; }
    const wrap = el('div', { class: 'view-in' });
    ({ now: renderNow, next: renderNext, notes: renderNotes, break: renderBreak })[S.view](wrap);
    v.append(wrap);
  }

  // ---------- Now / For you ----------
  function renderNow(wrap) {
    const pid = S.project, items = openItems(pid), u = user(pid);
    const st = projectStatus(pid);
    wrap.append(el('div', { class: 'section-h' }, el('span', { class: 't-eyebrow', text: 'For you' }), items.length ? el('span', { class: 't-small', text: `${items.length} open` }) : null));
    if (!items.length) {
      const last = latestRun(pid);
      wrap.append(el('div', { class: 'empty' }, el('p', {}, el('b', { text: st.cls === 'working' ? 'Nothing needs you right now.' : 'Nothing waiting.' }), st.cls === 'working' ? ' The agent will leave a note here if it makes a decision worth a look or needs your input. Draft the next prompt, or take a break.' : last ? ' Items the agent leaves during a run collect here, and move to history when the run ends.' : ' When an agent starts in this workspace, its decisions, questions and opportunities will appear here.')));
    } else {
      const [hero, ...rest] = items;
      wrap.append(itemCard(hero, u, true));
      if (rest.length) {
        const more = el('details', { class: 'more', open: S.mode !== 'compact' && rest.length <= 3 ? '' : null }, el('summary', { text: `${rest.length} more` }));
        const st2 = el('div', { class: 'stack' }); for (const i of rest) st2.append(itemCard(i, u, false)); more.append(st2); wrap.append(more);
      }
    }
    const history = itemsOf(pid).filter(i => !(i.status === 'open' && !i.userDismissed)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
    if (history.length) {
      const d = el('details', { class: 'more' }, el('summary', { text: `Earlier · ${history.length}` }));
      const st3 = el('div', { class: 'stack' });
      for (const i of history) st3.append(el('div', { class: 'card compact-row', onclick: (e) => { if (!e.target.closest('button')) expandHistory(i, u, e.currentTarget); } },
        el('div', { class: 'card-top', style: 'margin:0' }, el('span', { class: 'kind ' + i.kind }, el('i'), KIND_LABEL[i.kind]), el('span', { class: 'chip', text: i.userDismissed ? 'dismissed' : i.status }), el('span', { class: 'spacer' }), el('span', { class: 'card-src', text: ago(i.updatedAt) })),
        el('div', { class: 'card-text', text: i.title ? i.title + ' — ' + i.text : i.text })));
      d.append(st3); wrap.append(d);
    }
  }
  function expandHistory(i, u, node) { node.replaceWith(itemCard(i, u, false, true)); }
  function itemCard(i, u, hero, history = false) {
    const run = S.state.runs.find(r => r.id === i.run); const task = S.state.tasks.find(t => t.id === i.task);
    const who = AGENT[i.agent] || i.agent;
    const resp = u?.responses?.[i.key];
    const card = el('div', { class: 'card' + (hero ? ' hero' : ''), dataset: { key: i.key } });
    const chip = i.waiting && i.runStatus === 'active' ? el('span', { class: 'chip warn', text: 'Waiting on you' })
      : i.kind === 'decision' && i.runStatus === 'active' ? el('span', { class: 'chip', text: 'Assumption · continuing' })
      : i.kind === 'question' && i.runStatus === 'active' ? el('span', { class: 'chip', text: 'Not blocked · continuing' }) : null;
    card.append(el('div', { class: 'card-top' }, el('span', { class: 'kind ' + i.kind }, el('i'), KIND_LABEL[i.kind]), chip, el('span', { class: 'spacer' }), el('span', { class: 'card-src', text: `${who}${run?.title ? ' · ' + run.title : ''} · ${ago(i.updatedAt)}` })));
    if (i.title) card.append(el('div', { class: 't-h3', style: 'margin-bottom:6px', text: i.title }));
    card.append(el('div', { class: 'card-text', text: i.text }));
    const actions = el('div', { class: 'card-actions' });
    const respBox = el('div', { class: 'resp' });
    let editing = !!resp;
    const drawResp = () => {
      respBox.textContent = '';
      if (!editing) return;
      const ta = el('textarea', { class: 'input', placeholder: i.kind === 'question' ? 'Your answer, for when you return to the agent…' : 'A thought, a concern, a reply…', 'aria-label': 'Your response' });
      ta.value = resp?.body || '';
      const meta = el('div', { class: 'resp-meta' }, el('span', { text: resp ? `Saved ${ago(resp.updatedAt)}` : 'Saved locally as you type' }), el('span', { class: 'faint', text: '· Not sent to the agent' }));
      const save = debounce(() => api.respond(S.project, i.key, ta.value).then(() => { const uu = user(); if (uu) uu.responses[i.key] = ta.value ? { body: ta.value, updatedAt: Date.now() } : undefined; meta.firstChild.textContent = ta.value ? 'Saved just now' : 'Saved locally as you type'; }), 400);
      ta.addEventListener('input', () => { autoGrow(ta); save(); });
      registerFlush('resp:' + i.key, () => save.flush());
      respBox.append(ta, meta);
      queueMicrotask(() => { autoGrow(ta); if (!resp) ta.focus(); });
    };
    if (!history) {
      actions.append(el('button', { class: 'btn small' + (i.kind === 'question' ? ' primary' : ''), onclick: () => { editing = true; drawResp(); } }, i.kind === 'question' ? 'Write an answer' : 'Write a thought'));
      actions.append(el('button', { class: 'btn small', onclick: () => saveToNext(i) }, 'Save to Next'));
      actions.append(el('button', { class: 'btn small ghost', onclick: () => copyItem(i, u) }, svg(ICON.copy, 12), 'Copy for agent'));
      actions.append(el('span', { style: 'flex:1' }));
      actions.append(el('button', { class: 'btn small ghost', title: 'Dismiss', onclick: async () => { await api.dismiss(S.project, i.key, true); const uu = user(); if (uu) uu.dismissed[i.key] = Date.now(); render(true); } }, 'Dismiss'));
    } else {
      actions.append(el('button', { class: 'btn small ghost', onclick: () => copyItem(i, u) }, svg(ICON.copy, 12), 'Copy'));
      if (i.userDismissed) actions.append(el('button', { class: 'btn small ghost', onclick: async () => { await api.dismiss(S.project, i.key, false); const uu = user(); if (uu) delete uu.dismissed[i.key]; render(true); } }, 'Restore'));
      if (run) actions.append(el('button', { class: 'btn small ghost', onclick: () => returnSheet(run) }, `Return to ${who}`));
    }
    card.append(actions, respBox);
    if (resp) drawResp();
    if (task?.source && hero) card.append(el('div', { class: 'card-src', style: 'margin-top:10px', text: task.source.split('\n')[0] }));
    return card;
  }
  function copyItem(i, u) {
    const r = u?.responses?.[i.key]?.body;
    api.copy(r ? `Regarding your ${i.kind}: "${i.text}"\n\nMy response: ${r}` : `Regarding your ${i.kind}: "${i.text}"`);
    toast({ text: r ? 'Item and your response copied. Paste it into the agent.' : 'Item copied.', ttl: 4000 });
  }
  async function saveToNext(i) {
    const u = user();
    const title = (i.title || i.text).split('\n')[0].slice(0, 100);
    const body = `${i.text}\n\n— from ${AGENT[i.agent] || i.agent}, ${KIND_LABEL[i.kind].toLowerCase()}`;
    const e = await call(api.upsertNext(S.project, { kind: i.kind === 'question' ? 'prompt' : 'idea', title, body, fromItem: i.key }));
    if (u) u.next.unshift(e);
    toast({ text: 'Saved to Next.', ttl: 3500, actions: [{ label: 'Open Next', fn: () => setView('next') }] });
    renderHead(); renderCompactNav();
  }

  // ---------- Next ----------
  function renderNext(wrap) {
    const u = user(); if (!u) return;
    const open = u.next.filter(n => n.status === 'open'), done = u.next.filter(n => n.status !== 'open');
    wrap.append(el('div', { class: 'section-h' }, el('span', { class: 't-eyebrow', text: 'Next' }), el('span', { class: 't-small', text: 'Prompts to send later, ideas, things you chose to do' }), el('span', { class: 'spacer' }),
      el('button', { class: 'btn small', onclick: () => newNext('prompt') }, svg(ICON.plus, 12), 'Draft a prompt'), el('button', { class: 'btn small ghost', onclick: () => newNext('idea') }, 'Idea')));
    const list = el('div', { class: 'stack', id: 'next-list' });
    if (!open.length) list.append(el('div', { class: 'empty' }, el('p', {}, el('b', { text: 'Your list is empty.' }), ' Draft tomorrow’s prompt while the agent works, or save something it suggested. Nothing here is sent anywhere by itself.')));
    for (const n of open) list.append(nextCard(n));
    wrap.append(list);
    if (done.length) { const d = el('details', { class: 'more' }, el('summary', { text: `Done and archived · ${done.length}` })); const s = el('div', { class: 'stack' }); for (const n of done) s.append(nextCard(n)); d.append(s); wrap.append(d); }
  }
  async function newNext(kind = 'prompt') {
    const u = user(); if (!u) return;
    const e = await call(api.upsertNext(S.project, { kind, title: '', body: '' }));
    u.next.unshift(e);
    const list = $('#next-list'); if (list) { list.querySelector('.empty')?.remove(); list.prepend(nextCard(e)); list.firstChild.querySelector('input')?.focus(); } else render(true);
    renderHead(); renderCompactNav();
  }
  function nextCard(n) {
    const card = el('div', { class: 'card entry' + (n.status !== 'open' ? ' done' : ''), dataset: { id: n.id } });
    const title = el('input', { class: 'title', placeholder: n.kind === 'prompt' ? 'Prompt for the agent…' : 'What to remember…', 'aria-label': 'Title' }); title.value = n.title;
    const body = el('textarea', { placeholder: n.kind === 'prompt' ? 'Write the prompt you will send when the agent is free.' : 'Details, links, why it matters.', 'aria-label': 'Body' }); body.value = n.body;
    const check = el('button', { class: 'check', role: 'checkbox', 'aria-checked': n.status === 'done' ? 'true' : 'false', title: 'Done', onclick: async () => { n.status = n.status === 'done' ? 'open' : 'done'; await api.upsertNext(S.project, { id: n.id, status: n.status }); render(true); } }, svg(ICON.check, 11));
    const save = debounce(async () => { n.title = title.value; n.body = body.value; await api.upsertNext(S.project, { id: n.id, title: n.title, body: n.body }); meta.textContent = 'Saved'; }, 400);
    registerFlush('next:' + n.id, () => save.flush());
    title.addEventListener('input', () => { meta.textContent = 'Saving…'; save(); });
    body.addEventListener('input', () => { autoGrow(body); meta.textContent = 'Saving…'; save(); });
    const meta = el('span', { text: `${n.kind} · ${ago(n.updatedAt)}` });
    const foot = el('div', { class: 'entry-foot' }, meta, n.fromItem ? el('span', { class: 'chip accent', text: 'from agent' }) : null, el('span', { class: 'spacer' }),
      el('button', { class: 'btn small ghost', onclick: () => { api.copy(title.value + (body.value ? '\n\n' + body.value : '')); toast({ text: 'Copied. Paste it into the agent when you are ready.', ttl: 4000 }); } }, svg(ICON.copy, 12), 'Copy'),
      n.status !== 'archived' ? el('button', { class: 'btn small ghost', onclick: async () => { await api.upsertNext(S.project, { id: n.id, status: 'archived' }); n.status = 'archived'; render(true); } }, 'Archive') : el('button', { class: 'btn small ghost', onclick: async () => { await api.upsertNext(S.project, { id: n.id, status: 'open' }); n.status = 'open'; render(true); } }, 'Reopen'),
      el('button', { class: 'btn small ghost danger', title: 'Delete', onclick: async () => { await api.deleteNext(S.project, n.id); const u = user(); if (u) u.next = u.next.filter(x => x.id !== n.id); render(true); } }, svg(ICON.trash, 12)));
    card.append(el('div', { class: 'row' }, check, title), body, foot);
    queueMicrotask(() => autoGrow(body));
    return card;
  }

  // ---------- Notes ----------
  function renderNotes(wrap) {
    const u = user(); if (!u) return;
    wrap.append(el('div', { class: 'section-h' }, el('span', { class: 't-eyebrow', text: 'Notes' }), el('span', { class: 't-small', text: 'Decisions, context, the thread of this project. Saved as you type.' })));
    const ta = el('textarea', { class: 'notes', placeholder: 'Start with what this project is for, and what you decided last time…', 'aria-label': 'Project notes', spellcheck: 'true' });
    ta.value = u.notes.body;
    let revision = u.notes.revision;
    const meta = el('div', { class: 'notes-meta' }, el('span', { text: u.notes.updatedAt ? `Saved ${ago(u.notes.updatedAt)}` : 'Not written yet' }), el('span', { class: 'faint', text: '· Only on this computer' }));
    const save = debounce(async () => {
      const body = ta.value;
      const r = await call(api.setNotes(S.project, body, revision));
      if (r.conflict) { S.notesConflict = { mine: body, theirs: r.body }; revision = r.revision; renderBanners(); return; }
      revision = r.revision; u.notes = { body, revision, updatedAt: Date.now() }; meta.firstChild.textContent = 'Saved just now';
    }, 500);
    registerFlush('notes', () => save.flush());
    ta.addEventListener('input', () => { meta.firstChild.textContent = 'Saving…'; save(); });
    wrap.append(el('div', { class: 'notes-wrap' }, el('div', { class: 'spine' }, ta), meta));
  }

  // ---------- Break ----------
  function renderBreak(wrap) {
    const [name, text] = STRETCHES[S.stretchIndex % STRETCHES.length];
    const box = el('div', { class: 'break' });
    const p = project(); const st = projectStatus(p.id);
    box.append(el('div', { class: 'section-h' }, el('span', { class: 't-eyebrow', text: 'Break' }), el('span', { class: 't-small', text: st.cls === 'working' ? `${st.label}. You will see it here when it finishes.` : 'Your place in this workspace is kept.' })));
    const ring = el('div', { class: 'ring' + (S.breakTimer ? '' : ' breathing') });
    const C = 2 * Math.PI * 84;
    ring.innerHTML = `<svg viewBox="0 0 180 180"><circle class="track" cx="90" cy="90" r="84"/><circle class="prog" cx="90" cy="90" r="84" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg>`;
    const time = el('div', { class: 'time' }); ring.append(time);
    const setTime = () => { const s = S.breakTimer ? S.breakLeft : S.breakTotal; time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; ring.querySelector('.prog').style.strokeDashoffset = S.breakTimer ? String(C * (1 - S.breakLeft / S.breakTotal)) : '0'; };
    setTime();
    const row = el('div', { class: 'timer-row' });
    const startBtn = el('button', { class: 'btn primary', onclick: () => { if (S.breakTimer) stopBreak(); else startBreak(setTime, startBtn); startBtn.textContent = S.breakTimer ? 'Stop' : 'Start'; } }, S.breakTimer ? 'Stop' : 'Start');
    row.append(startBtn);
    for (const m of [3, 5, 10]) row.append(el('button', { class: 'btn ghost small', onclick: () => { if (S.breakTimer) stopBreak(); S.breakTotal = m * 60; S.breakLeft = S.breakTotal; setTime(); startBtn.textContent = 'Start'; } }, `${m} min`));
    box.append(ring, row);
    box.append(el('div', { class: 'card sunk stretch' }, el('span', { class: 't-eyebrow', text: name }), el('p', { text }), el('div', { class: 'card-actions' }, el('button', { class: 'btn small ghost', onclick: () => { S.stretchIndex++; render(true); } }, 'Another one'))));
    const br = S.settings.breakReminder;
    box.append(el('div', { class: 'card', style: 'padding-top:6px;padding-bottom:6px' },
      switchRow('Remind me to take breaks', 'A quiet nudge, never a takeover unless you ask for it.', br.enabled, v => saveBreak({ enabled: v })),
      el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: 'Every' })), el('select', { class: 'input', style: 'width:auto', onchange: e => saveBreak({ minutes: Number(e.target.value) }) }, ...[15, 30, 45, 60, 90].map(m => el('option', { value: m, selected: br.minutes === m, text: `${m} minutes` })))),
      el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: 'When it is time' }), el('span', { text: 'Automatic entry waits until you have stopped typing.' })), seg([['suggest', 'Suggest'], ['auto', 'Enter break']], br.mode, v => saveBreak({ mode: v })))));
    wrap.append(box);
    S.lastBreak = Date.now();
  }
  function startBreak(setTime, btn) { S.breakLeft = S.breakLeft || S.breakTotal; S.lastBreak = Date.now(); S.breakTimer = setInterval(() => { S.breakLeft--; setTime(); if (S.breakLeft <= 0) { stopBreak(); btn.textContent = 'Start'; toast({ text: 'Break’s over, whenever you are.', ttl: 8000 }); setTime(); } }, 1000); $('.ring')?.classList.remove('breathing'); }
  function stopBreak() { clearInterval(S.breakTimer); S.breakTimer = null; S.breakLeft = S.breakTotal; S.lastBreak = Date.now(); $('.ring')?.classList.add('breathing'); }
  function saveBreak(patch) { S.settings.breakReminder = { ...S.settings.breakReminder, ...patch }; api.setSettings({ breakReminder: patch }); }

  // ---------- runs popover ----------
  function runsPopover(anchor) {
    closePopover();
    const p = project(); const runs = runsOf(p.id).slice(0, 12); const tasks = tasksOf(p.id);
    const pop = el('div', { class: 'pop', role: 'dialog', 'aria-label': 'Runs' });
    pop.append(el('div', { class: 'section-h', style: 'margin:0 0 6px' }, el('span', { class: 't-eyebrow', text: 'Runs' }), el('span', { class: 'spacer' }), el('span', { class: 't-small', text: `${tasks.length} conversation${tasks.length === 1 ? '' : 's'}` })));
    if (!runs.length) pop.append(el('p', { class: 't-small', text: 'No runs yet in this workspace.' }));
    for (const r of runs) {
      const t = tasks.find(x => x.id === r.task);
      const label = r.status === 'active' ? 'working' : r.status;
      pop.append(el('div', { class: 'run-row' },
        el('div', { class: 'l1' }, el('span', { class: 'dot ' + (r.status === 'active' ? 'working' : r.status === 'completed' ? 'done' : r.status === 'failed' ? 'failed' : 'attention') }), el('span', { text: `${AGENT[r.agent] || r.agent} · ${r.title || 'Working'}` }), el('span', { class: 'spacer', style: 'flex:1' }), el('span', { class: 'chip', text: label })),
        el('div', { class: 'l2', text: `${r.status === 'active' ? 'started ' + ago(r.startedAt) : (r.endedAt ? 'ended ' + ago(r.endedAt) + ' · ran ' + dur(r.endedAt - r.startedAt) : '')}${r.lifecycle === 'hooks' ? ' · lifecycle via hooks' : r.lifecycle === 'voluntary' ? ' · reported by the agent' : ''}` }),
        el('div', { class: 'l2' }, el('button', { class: 'btn small ghost', onclick: () => returnSheet(r) }, 'How to return'), r.agent === 'codex' ? el('button', { class: 'btn small ghost', onclick: () => sendSheet(r) }, 'Send to Codex…') : null)));
    }
    if (p.path) pop.append(el('div', { class: 'run-row' }, el('div', { class: 'l2' }, 'Folder: ', el('code', { class: 'path', text: p.path }), ' ', el('button', { class: 'btn small ghost', onclick: () => api.openPath(p.path) }, 'Open'))));
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.min(rect.left, window.innerWidth - 480) + 'px'; pop.style.top = rect.bottom + 8 + 'px';
    document.body.append(pop); S.popover = pop;
    setTimeout(() => document.addEventListener('pointerdown', onDocDown), 0);
  }
  function onDocDown(e) { if (S.popover && !S.popover.contains(e.target)) closePopover(); }
  function closePopover() { if (S.popover) { S.popover.remove(); S.popover = null; document.removeEventListener('pointerdown', onDocDown); } }

  // ---------- sheets ----------
  function sheet(content) { closeOverlay(); const scrim = el('div', { class: 'scrim', onclick: e => { if (e.target === scrim) closeOverlay(); } }, el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, ...content)); $('#overlay').append(scrim); return scrim; }
  function closeOverlay() { $('#overlay').textContent = ''; }

  function returnSheet(r) {
    const t = S.state.tasks.find(x => x.id === r.task); const who = AGENT[r.agent] || r.agent; const p = project();
    const responses = Object.entries(user()?.responses || {}).filter(([k]) => k.startsWith(r.id + ':')).map(([, v]) => v.body).filter(Boolean);
    const source = r.source || t?.source || `Return to the ${who} window where this work started.`;
    const resume = source.match(/(claude --resume \S+|codex resume \S+)/)?.[1];
    sheet([
      el('h2', { text: `Back to ${who}` }),
      el('p', { class: 't-body' }, 'Layover cannot bring another window to the front for you. Switch to the ', el('b', { text: who }), ' session below with ', el('kbd', { text: 'Alt' }), ' + ', el('kbd', { text: 'Tab' }), ', or resume it from a terminal in the project folder.'),
      el('pre', { class: 'src', text: source }),
      el('div', { class: 'card-actions', style: 'margin-top:0' },
        resume ? el('button', { class: 'btn', onclick: () => { api.copy(resume); toast({ text: 'Resume command copied.', ttl: 3500 }); } }, svg(ICON.copy, 12), 'Copy resume command') : null,
        responses.length ? el('button', { class: 'btn primary', onclick: () => { api.copy(responses.join('\n\n')); toast({ text: 'Your replies are on the clipboard.', ttl: 3500 }); } }, svg(ICON.copy, 12), `Copy my repl${responses.length === 1 ? 'y' : 'ies'}`) : null,
        p?.path ? el('button', { class: 'btn ghost', onclick: () => api.openPath(p.path) }, 'Open folder') : null),
      el('div', { class: 'card-actions', style: 'justify-content:flex-end' }, el('button', { class: 'btn ghost', onclick: closeOverlay }, 'Close'), el('button', { class: 'btn primary', onclick: () => { ack(r.id); closeOverlay(); } }, 'Got it')),
    ]);
  }

  async function sendSheet(r) {
    const status = el('p', { class: 't-small', text: 'Checking the linked Codex thread…' });
    const ta = el('textarea', { class: 'input', placeholder: 'Guidance for the running Codex turn…' });
    const send = el('button', { class: 'btn primary', disabled: true }, 'Send to active turn');
    let target = null;
    sheet([el('h2', { text: 'Send to Codex' }), el('p', { class: 't-body', text: 'Only works when this run was linked to a Codex thread on a local App Server (see docs/CAPABILITIES.md). Sending uses Codex quota and is always your explicit action.' }), status, ta,
      el('div', { class: 'card-actions', style: 'justify-content:flex-end' }, el('button', { class: 'btn ghost', onclick: closeOverlay }, 'Cancel'), send)]);
    try { target = await call(api.bridgeTarget(r.id)); status.textContent = target.activeTurnId ? `Linked to “${target.name}” · active turn ${target.activeTurnId}` : `Linked to “${target.name || target.thread}” · no active turn (queue only)`; send.disabled = false; }
    catch (e) { status.textContent = e.message; return; }
    send.addEventListener('click', async () => {
      send.disabled = true;
      try { const m = await call(api.bridgeSend({ id: crypto.randomUUID(), run: r.id, thread: target.thread, text: ta.value, expectedTurnId: target.activeTurnId })); status.textContent = `${m.status}: ${m.detail}`; if (['accepted', 'queued', 'acknowledged'].includes(m.status)) { toast({ text: `Codex ${m.status}. Acknowledgment ≠ completion.`, ttl: 6000 }); } }
      catch (e) { status.textContent = e.message; send.disabled = false; }
    });
  }

  async function addWorkspace() {
    const name = el('input', { class: 'input', placeholder: 'Name' }); const folder = el('input', { class: 'input', placeholder: 'Folder (optional, lets agents find it)' });
    sheet([el('h2', { text: 'New workspace' }), el('p', { class: 't-body', text: 'Workspaces are created automatically when an agent starts in a folder. Add one by hand to keep notes before that happens.' }),
      el('div', { class: 'field' }, el('label', { text: 'Name' }), name),
      el('div', { class: 'field' }, el('label', { text: 'Folder' }), el('div', { style: 'display:flex;gap:8px' }, folder, el('button', { class: 'btn', onclick: async () => { const f = await call(api.pickFolder()); if (f) { folder.value = f; if (!name.value) name.value = f.split(/[\\/]/).filter(Boolean).pop(); } } }, 'Choose…'))),
      el('div', { class: 'card-actions', style: 'justify-content:flex-end' }, el('button', { class: 'btn ghost', onclick: closeOverlay }, 'Cancel'), el('button', { class: 'btn primary', onclick: async () => { if (!name.value.trim() && !folder.value.trim()) return; const p = await call(api.createProject(name.value.trim(), folder.value.trim())); closeOverlay(); S.state = await call(api.getState()); await switchProject(p.id); } }, 'Create'))]);
    name.focus();
  }

  function switchRow(title, sub, value, onChange) {
    const t = el('button', { class: 'toggle', role: 'switch', 'aria-checked': value ? 'true' : 'false', onclick: () => { const v = t.getAttribute('aria-checked') !== 'true'; t.setAttribute('aria-checked', v ? 'true' : 'false'); onChange(v); } });
    return el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: title }), sub ? el('span', { text: sub }) : null), t);
  }
  function seg(options, value, onChange) {
    const s = el('div', { class: 'seg', role: 'radiogroup' });
    for (const [v, label] of options) s.append(el('button', { role: 'radio', 'aria-checked': v === value ? 'true' : 'false', onclick: () => { s.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', 'false')); s.querySelector(`[data-v="${v}"]`).setAttribute('aria-checked', 'true'); onChange(v); }, dataset: { v } }, label));
    return s;
  }

  async function openSettings({ onboarding }) {
    const st = await call(api.setupStatus());
    const s = S.settings;
    const agentRow = (id, label, info) => {
      const row = el('div', { class: 'agent-row' });
      const draw = () => {
        row.textContent = '';
        const connected = info.connected; const stale = connected && !(info.skillCurrent && info.hooksCurrent);
        row.append(...[el('span', { class: 'dot ' + (connected ? 'done' : 'quiet'), style: connected ? '' : 'background:var(--border-strong)' }),
          el('div', { class: 'l' }, el('b', { text: label }), el('span', { text: connected ? (stale ? 'Connected · update available' : 'Connected: skill and lifecycle hooks installed') : 'Not connected. One click installs the skill and hooks in your user settings.' }),
            id === 'codex' && connected ? el('span', { text: 'Codex asks you to trust hooks once: type /hooks in Codex and approve the Layover entries.' }) : null, info.hooksError ? el('span', { style: 'color:var(--danger)', text: 'Hooks file could not be read: ' + info.hooksError }) : null),
          connected ? el('button', { class: 'btn small ghost', onclick: async () => { await call(api.setupRemove(id)); info = (await call(api.setupStatus()))[id]; draw(); } }, 'Disconnect') : null,
          el('button', { class: 'btn small' + (connected && !stale ? '' : ' primary'), onclick: async () => { try { const r = await call(api.setupInstall(id, {})); info = (await call(api.setupStatus()))[id]; draw(); toast({ text: `${label} connected.${r.notes?.length ? ' ' + r.notes[0] : ''}`, ttl: 8000 }); } catch (e) { toast({ text: e.message, ttl: 8000, cls: 'gold' }); } } }, connected ? (stale ? 'Update' : 'Reinstall') : 'Connect')].filter(Boolean));
      };
      draw(); return row;
    };
    const content = [
      el('h2', { text: onboarding ? 'Welcome to Layover' : 'Settings' }),
      onboarding ? el('p', { class: 't-body', text: 'Layover is the room you wait in while an agent works: a notebook for the project, a place for what the agent wants you to know, and a break when you want one. Connect your agents so they can open it for you.' }) : null,
      el('div', { class: 'sheet-sec' }, el('h3', { text: 'Agents' }), agentRow('claude', 'Claude Code', st.claude), agentRow('codex', 'Codex', st.codex),
        el('p', { class: 't-small' }, 'Command agents use: ', el('code', { class: 'path', text: st.cli }), ' ', el('button', { class: 'btn small ghost', onclick: () => api.copy(st.cli) }, 'Copy'), st.cliExists ? null : el('span', { style: 'color:var(--danger)', text: ' (missing)' }))),
    ];
    if (!onboarding) content.push(
      el('div', { class: 'sheet-sec' }, el('h3', { text: 'When an agent starts a run' }),
        seg([['open', 'Open Layover'], ['reveal', 'Only if already open'], ['never', 'Stay quiet']], s.openOnRunStart, v => { s.openOnRunStart = v; api.setSettings({ openOnRunStart: v }); }),
        el('p', { class: 't-small', text: 'Layover never takes focus from what you are doing. It appears behind your work, and offers to switch workspaces only when you are not typing.' }),
        switchRow('Windows notification when a run finishes', 'Silent toast; only when Layover is not in front.', s.notifyOnComplete, v => api.setSettings({ notifyOnComplete: v })),
        switchRow('Keep running in the tray when the window is closed', 'Needed so agents can reach it.', s.closeToTray, v => api.setSettings({ closeToTray: v })),
        switchRow('Tell the agent its run id', 'One short line per prompt so it can publish items without guessing. Off saves a few tokens.', s.hookContext, v => api.setSettings({ hookContext: v }))),
      el('div', { class: 'sheet-sec' }, el('h3', { text: 'Appearance' }), seg([['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']], s.theme, v => { s.theme = v; api.setSettings({ theme: v }); })),
      el('div', { class: 'sheet-sec' }, el('h3', { text: 'About' }), el('p', { class: 't-small' }, `Layover ${s.version} · data in `, el('code', { class: 'path', text: s.dataDir }), ' ', el('button', { class: 'btn small ghost', onclick: () => api.openPath(s.dataDir) }, 'Open'), ' · local service on 127.0.0.1:' + s.port + '. Layover makes no model calls.'),
        el('p', { class: 't-small' }, 'Shortcuts: ', el('kbd', { text: 'Ctrl' }), '+', el('kbd', { text: '1–4' }), ' views · ', el('kbd', { text: 'Ctrl' }), '+', el('kbd', { text: 'N' }), ' new draft · ', el('kbd', { text: 'Ctrl' }), '+', el('kbd', { text: 'Shift' }), '+', el('kbd', { text: 'C' }), ' compact')));
    content.push(el('div', { class: 'card-actions', style: 'justify-content:flex-end' }, el('button', { class: 'btn primary', onclick: async () => { if (onboarding) { S.settings.onboarded = true; await api.setSettings({ onboarded: true }); } closeOverlay(); } }, onboarding ? 'Done' : 'Close')));
    sheet(content);
  }

  // ---------- toasts ----------
  function toast({ text, actions = [], ttl = 5000, cls = '' }) {
    const t = el('div', { class: 'toast ' + cls, role: 'status' }, el('div', { class: 't' }, ...(Array.isArray(text) ? text : [text])));
    if (actions.length) t.append(el('div', { class: 'a' }, ...actions.map(a => el('button', { class: 'btn small' + (a.primary ? ' primary' : ' ghost'), onclick: () => { t.remove(); a.fn(); } }, a.label))));
    $('#toasts').append(t);
    if (ttl) setTimeout(() => t.remove(), ttl);
    return t;
  }

  boot().catch(e => { document.body.append(el('pre', { text: 'Layover failed to start: ' + e.message })); });
})();
