/* Layover renderer. Vanilla JS. The room stays still: nothing re-renders under a cursor. */
(() => {
  'use strict';
  const api = window.layover;
  const $ = (sel, root = document) => root.querySelector(sel);
  const AGENT = { claude: 'Claude Code', codex: 'Codex', test: 'Test agent' };
  const AGENT_SHORT = { claude: 'Claude', codex: 'Codex', test: 'Test' };
  const KIND_LABEL = { suggestion: 'Think ahead', decision: 'Decision', question: 'Input requested', opportunity: 'Opportunity' };
  const VIEWS = [['now', 'Now'], ['tickets', 'Next'], ['notes', 'Notes'], ['break', 'Break']];
  const STATUS = { progress: 'In progress', todo: 'Up next', backlog: 'Someday', done: 'Done', cancelled: 'Dropped' };
  const STATUS_ORDER = ['progress', 'todo', 'backlog', 'done', 'cancelled'];
  const PRIORITY = ['No priority', 'Low', 'Medium', 'High', 'Urgent'];
  const FILTERS = { active: ['progress', 'todo', 'backlog'], done: ['done', 'cancelled'], all: STATUS_ORDER };
  const RECENT_MS = 30 * 60000;   // a quiet conversation stays in Now for 30 minutes, then moves to Archive on its own
  const STRETCHES = [
    ['Shoulders', 'Roll your shoulders back five times, slowly. Let your arms hang.'],
    ['Eyes', 'Look at something at least six metres away for twenty seconds. Blink a few times.'],
    ['Neck', 'Tilt your right ear toward your right shoulder. Breathe. Switch sides.'],
    ['Wrists', 'Extend one arm, palm up. Gently pull the fingers back with the other hand. Switch.'],
    ['Stand', 'Stand up. Reach both hands toward the ceiling, then fold forward and let your head hang.'],
    ['Breathe', 'In for four, hold for four, out for six. Three rounds.'],
    ['Water', 'Get a glass of water. Drink it somewhere that is not your desk.'],
    ['Hips', 'Sit tall, cross one ankle over the other knee, and lean forward a little. Switch.'],
    ['Chest', 'Clasp your hands behind your back, lift them a little, and open your chest.'],
    ['Jaw', 'Unclench your jaw. Let your tongue rest. Drop your shoulders a centimetre.'],
    ['Calves', 'Stand on the edge of a step or just on your toes. Rise and lower ten times.'],
    ['Spine', 'Sit tall and twist gently to the right, hand on the back of the chair. Switch.'],
    ['Hands', 'Spread your fingers wide, then make a fist. Ten times. Shake them out.'],
    ['Window', 'Walk to a window. Notice three things outside that are moving.'],
    ['Forearms', 'Arm straight, palm down, fingers pointing at the floor. Press gently. Switch.'],
    ['Walk', 'Take a lap of the room, or the hallway. Come back slower than you left.'],
    ['Ankles', 'Lift one foot and draw a circle with your toes, both directions. Switch.'],
    ['Upper back', 'Hug yourself, then reach around further. Round your upper back and breathe into it.'],
  ];

  const S = {
    state: null, settings: null, project: null, view: 'now', mode: 'expanded', users: {},
    viewKey: '', pendingRefresh: false, acked: {}, offers: new Map(), theme: 'system',
    brk: { timer: null, left: 300, total: 300, stretch: 0, lastStretchAt: 0 }, lastBreak: Date.now(), reminderShown: 0, reminderToast: null,
    lastInteraction: 0, popover: null, notesConflict: null, ticket: null, ticketFilter: 'active', expandedThreads: new Set(), flushers: {}, promptOpen: new Set(), editingTitle: null,
  };

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const svg = (d, size = 14, extra = '') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('fill', 'none'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<path d="${d}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`; return s; };
  const ICON = { check: 'M3 8.5l3 3 7-7', copy: 'M6 6h7v7H6zM3 10V3h7', x: 'M4 4l8 8M12 4l-8 8', arrow: 'M3 8h10M9 4l4 4-4 4', plus: 'M8 3v10M3 8h10', trash: 'M3 4h10M6 4V2.5h4V4M5 4l.6 9h4.8L11 4', back: 'M13 8H3M7 4L3 8l4 4', reply: 'M6 4L2 8l4 4M2 8h7a5 5 0 0 1 5 5' };
  /** Long label in the expanded window, short label in the compact companion. */
  /** Circular agent mark: an eight-ray asterisk for Claude, a six-petal knot for Codex. Names stay in the tooltip. */
  function agentIcon(agent, size = 26) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
    if (agent === 'claude') s.innerHTML = '<path d="M8 1.6v12.8M1.6 8h12.8M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>';
    else if (agent === 'codex') s.innerHTML = [0, 60, 120].map(a => '<rect x="6.6" y="1.6" width="2.8" height="12.8" rx="1.4" fill="currentColor" transform="rotate(' + a + ' 8 8)"/>').join('') + '<circle cx="8" cy="8" r="2.1" fill="var(--agent-bg)"/>';
    else s.innerHTML = '<circle cx="8" cy="8" r="3" fill="currentColor"/>';
    return el('span', { class: 'agent-ic ' + agent + (size <= 18 ? ' sm' : ''), title: AGENT[agent] || agent, role: 'img', 'aria-label': AGENT[agent] || agent }, s);
  }
  const lbl = (long, short) => [el('span', { class: 'l', text: long }), el('span', { class: 's', text: short })];
  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`;
  }
  function clock(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function dur(ms) { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; }
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; return d; };
  async function call(p) { const r = await p; if (!r.ok) throw Error(r.error); return r.value; }
  function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
  function initials(name) { const w = String(name || '?').replace(/[_-]+/g, ' ').trim().split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase(); }
  function projectName(p) { return p?.displayName || p?.name || 'Workspace'; }
  /** Engaged means typing in a field in the last ten seconds. Clicking around never blocks updates. */
  function isEngaged() { const a = document.activeElement; const editing = a && $('#view')?.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT'); return !!editing && Date.now() - S.lastInteraction < 10000; }
  let refreshTimer = null;
  function deferRefresh() {
    S.pendingRefresh = true;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (!S.pendingRefresh) return; if (isEngaged()) deferRefresh(); else { S.pendingRefresh = false; render(); } }, 1500);
  }
  function ticketKey(t) { return `${project()?.prefix || 'WS'}-${t.number}`; }
  /** Mirror of the hook's turnTitle, so turns recorded before v0.3.1 read cleanly too. */
  function cleanTitle(raw) {
    raw = String(raw || '').trim();
    if (!raw) return '';
    if (/^\s*<(task-notification|system-reminder|ci-monitor-event|command-name)/i.test(raw)) return 'Follow-up from a background task';
    let t = raw.replace(/<[^>]{1,80}>/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    const m = t.match(/^(.{12,80}?[.!?])(\s|$)/);
    if (m) t = m[1];
    return t.length > 80 ? t.slice(0, 79) + '…' : t;
  }
  function typing() { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); }

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
  function openItems(id) { return itemsOf(id).filter(i => i.status === 'open' && !i.userDismissed); }
  function isAcked(runId) { return !!(S.acked[runId] || user()?.place?.acked?.[runId]); }
  function projectStatus(id) {
    const active = activeRuns(id);
    const waiting = openItems(id).find(i => i.waiting && i.runStatus === 'active');
    if (waiting) return { cls: 'attention', label: 'Waiting on you', run: active[0] };
    if (active.length) return { cls: 'working', label: `Working${active.length > 1 ? ` · ${active.length} runs` : ''}`, run: active[0], agent: active[0].agent };
    const last = latestRun(id);
    if (last && !isAcked(last.id) && Date.now() - (last.endedAt || last.lastSeen) < 12 * 3600000) {
      if (last.status === 'completed') return { cls: 'done', label: 'Ready when you are', run: last };
      if (last.status === 'failed') return { cls: 'attention', label: 'Stopped with an error', run: last };
      if (last.status === 'cancelled') return { cls: 'attention', label: 'Interrupted', run: last };
      if (last.status === 'disconnected') return { cls: 'attention', label: 'No recent signal', run: last };
    }
    return { cls: 'quiet', label: last ? `Quiet · last run ${ago(last.endedAt || last.startedAt)}` : 'Quiet', run: last };
  }
  /** One thread per agent conversation: its runs (turns), its items, and a derived status. */
  function threadsOf(id) {
    const items = itemsOf(id), runs = runsOf(id);
    return tasksOf(id).map(t => {
      const tr = runs.filter(r => r.task === t.id).sort((a, b) => a.startedAt - b.startedAt);
      const ti = items.filter(i => i.task === t.id);
      const latest = tr[tr.length - 1] || null;
      const waiting = ti.some(i => i.waiting && i.status === 'open' && !i.userDismissed && i.runStatus === 'active');
      const lastActivity = Math.max(t.lastSeen || 0, ...tr.map(r => Math.max(r.lastSeen, r.endedAt)), ...ti.map(i => i.updatedAt));
      const status = !latest ? 'idle' : latest.status === 'active' ? (waiting ? 'attention' : 'working') : latest.status;
      const archivedAt = user(id)?.place?.archived?.[t.id] || 0;
      const archived = archivedAt > 0 && archivedAt >= lastActivity; // new activity un-archives on its own
      const live = status === 'working' || status === 'attention';
      const recent = live || (!archived && Date.now() - lastActivity < RECENT_MS);
      const ticket = latest ? ticketForRun(latest, id) : null;
      return { task: t, runs: tr, items: ti, latest, waiting, lastActivity, status, archived, recent, ticket, open: ti.filter(i => i.status === 'open' && !i.userDismissed).length };
    }).sort((a, b) => (b.status === 'working' || b.status === 'attention') - (a.status === 'working' || a.status === 'attention') || b.lastActivity - a.lastActivity);
  }
  /** A turn whose prompt carries a key like LAY-12 is linked to that ticket. Copy prompt puts the key there. */
  function ticketForRun(run, pid = S.project) {
    const u = user(pid); const p = S.state?.projects.find(x => x.id === pid);
    if (!u || !p || !run?.title) return null;
    const m = run.title.match(new RegExp(`\\b${p.prefix}-(\\d+)\\b`, 'i'));
    if (!m) return null;
    return u.tickets.find(t => t.number === Number(m[1])) || null;
  }
  /** Runs that mention a ticket move it to In progress once, and remember the run on the ticket. */
  async function linkRuns() {
    for (const p of S.state?.projects || []) await linkRunsFor(p.id).catch(() => {});
  }
  async function linkRunsFor(pid) {
    if (!runsOf(pid).some(r => Date.now() - r.startedAt < 24 * 3600000)) return;
    const u = user(pid) || await loadUser(pid); if (!u) return;
    for (const r of runsOf(pid)) {
      if (Date.now() - r.startedAt > 24 * 3600000) continue;
      const t = ticketForRun(r, pid);
      if (!t || (t.runs || []).includes(r.id) || r.startedAt < t.createdAt) continue;
      const patch = { id: t.id, runs: [...(t.runs || []), r.id] };
      if (t.status === 'backlog' || t.status === 'todo') patch.status = 'progress';
      const saved = await call(api.upsertTicket(pid, patch));
      const i = u.tickets.findIndex(x => x.id === t.id); if (i >= 0) u.tickets[i] = saved;
    }
  }
  async function setArchived(taskId, on) {
    const u = user(); if (!u) return;
    u.place.archived = { ...(u.place.archived || {}) };
    if (on) u.place.archived[taskId] = Date.now(); else delete u.place.archived[taskId];
    await api.setPlace(S.project, { archived: u.place.archived });
    render(true);
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
    await linkRuns().catch(() => {});
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
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.pendingRefresh && !isEngaged()) { S.pendingRefresh = false; render(); } });
    $('#add-ws').addEventListener('click', addWorkspace);
    $('#btn-settings').addEventListener('click', () => openSettings({}));
    $('#btn-compact').addEventListener('click', () => api.setWindowMode('compact'));
    $('#btn-expand').addEventListener('click', () => api.setWindowMode('expanded'));
    $('#compact-ws').addEventListener('click', e => workspaceMenu(e.currentTarget));
    $('#btn-rail').addEventListener('click', () => toggleRail());
    if (S.settings.window?.railCollapsed) toggleRail(true);
  }
  function shortcutSheet() {
    const K = (k) => el('kbd', { text: k });
    const rows = [['n', 'New in Next'], ['p', 'Open the prompt of the selected entry'], ['r', 'Reply to the latest item (Now)'], ['j', 'k', 'Move through Next'], ['e', 'Edit the selected entry'], ['Esc', 'Close a sheet, menu, or entry'], ['[', 'Collapse or expand the sidebar'], ['?', 'This list'], ['Ctrl+1…4', 'Now · Next · Notes · Break'], ['Ctrl+N', 'New in Next from anywhere'], ['Ctrl+Shift+C', 'Compact companion'], ['Ctrl+,', 'Settings']];
    const grid = el('div', { class: 'keys' });
    for (const r of rows) { const label = r.pop(); grid.append(el('span', {}, ...r.flatMap((k, i) => [i ? ' / ' : null, K(k)]).filter(Boolean)), el('span', { text: label })); }
    sheet([el('h2', { text: 'Shortcuts' }), el('p', { class: 't-small', text: 'Single keys work when you are not typing in a field.' }), grid, el('div', { class: 'card-actions', style: 'justify-content:flex-end' }, el('button', { class: 'btn primary', onclick: closeOverlay }, 'Close'))]);
  }
  function visibleProjects() { return (S.state?.projects || []).filter(p => !p.hidden).sort((a, b) => b.lastActive - a.lastActive); }
  async function loadUser(id) { S.users[id] = await call(api.getUser(id)); return S.users[id]; }
  const ACCENTS = [['teal', 'Teal', '#2E9A92'], ['ink', 'Ink', '#6470C4'], ['mulberry', 'Mulberry', '#B45C8A'], ['ember', 'Ember', '#BE5C2E'], ['oxblood', 'Oxblood', '#A03B50'], ['umber', 'Umber', '#8A6A44']];
  function applyTheme({ theme, dark }) {
    S.theme = theme;
    if (theme === 'dark' || (theme === 'system' && dark)) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    applyAccent(S.settings?.accent || 'teal');
  }
  function applyAccent(name) {
    if (!name || name === 'teal') document.documentElement.removeAttribute('data-accent');
    else document.documentElement.setAttribute('data-accent', name);
  }
  function restorePlace() { const u = user(); S.view = u?.place?.view && VIEWS.some(v => v[0] === u.place.view) ? u.place.view : 'now'; S.ticket = u?.place?.ticket || null; S.ticketFilter = u?.place?.ticketFilter || 'active'; }
  function savePlace(extra = {}) { if (S.project) api.setPlace(S.project, { view: S.view, ticket: S.ticket, ticketFilter: S.ticketFilter, ...extra }); }

  async function switchProject(id, { view } = {}) {
    if (!id || id === S.project) { if (view) setView(view); return; }
    flushAll();
    S.project = id;
    const offer = S.offers.get(id); if (offer) { offer.remove(); S.offers.delete(id); }
    if (!user(id)) await loadUser(id);
    restorePlace();
    if (view) S.view = view;
    S.settings.window.lastProject = id;
    render(true);
  }
  function setView(v) { if (S.view === v) return; flushAll(); S.view = v; savePlace(); render(true); }
  function flushAll() { for (const f of Object.values(S.flushers)) { try { f(); } catch { /* best effort */ } } S.flushers = {}; }
  function registerFlush(key, fn) { S.flushers[key] = fn; }

  // ---------- pushes ----------
  function onState() {
    if (!S.project || !S.state.projects.some(p => p.id === S.project)) S.project = visibleProjects()[0]?.id || null;
    if (S.project && !user(S.project)) loadUser(S.project).then(() => render());
    linkRuns().catch(() => {});
    renderRail(); renderHead(); renderCompactNav();
    if (isEngaged()) { deferRefresh(); return; }
    renderView();
  }
  function onOpenRequest(req) {
    if (!S.state) return;
    if (!S.state.projects.some(p => p.id === req.project)) return;
    if (req.project === S.project) { if (req.reason === 'notification' || req.explicit) setView('now'); return; }
    const engaged = req.engaged || isEngaged();
    const p = S.state.projects.find(x => x.id === req.project);
    const task = S.state.tasks.find(t => t.id === req.task);
    const who = task ? AGENT[task.agent] || task.agent : 'An agent';
    if (!engaged && (req.explicit || req.wasVisible === false || req.reason === 'notification')) { switchProject(req.project, { view: 'now' }); return; }
    if (S.offers.has(req.project)) return;
    const t = toast({ cls: 'gold', text: [el('b', { text: who }), ` started in `, el('b', { text: projectName(p) }), '.'], ttl: 0, actions: [
      { label: 'Switch', primary: true, fn: () => { S.offers.delete(req.project); switchProject(req.project, { view: 'now' }); } },
      { label: 'Stay here', fn: () => S.offers.delete(req.project) },
    ] });
    S.offers.set(req.project, t);
  }
  function onRunEnded({ run, status, project: pid }) {
    if (pid === S.project) return; // the thread shows it
    const r = S.state.runs.find(x => x.id === run); const p = S.state.projects.find(x => x.id === pid);
    if (!r || !p) return;
    const label = status === 'completed' ? 'finished' : status === 'failed' ? 'stopped with an error' : status === 'cancelled' ? 'was interrupted' : 'went quiet';
    toast({ text: [el('b', { text: AGENT[r.agent] || r.agent }), ` ${label} in `, el('b', { text: projectName(p) }), '.'], ttl: 9000, actions: [{ label: 'Go there', fn: () => switchProject(pid, { view: 'now' }) }] });
  }
  function tick() {
    if (!isEngaged() && S.pendingRefresh) { S.pendingRefresh = false; render(); }
    else { renderRail(); renderHead(); refreshElapsed(); }
    const br = S.settings.breakReminder;
    const toastAlive = S.reminderToast && S.reminderToast.isConnected;
    if (br?.enabled && S.view !== 'break' && !S.brk.timer && !toastAlive && Date.now() - S.lastBreak > br.minutes * 60000 && Date.now() - S.reminderShown > br.minutes * 60000) {
      S.reminderShown = Date.now();
      if (br.mode === 'auto') { const go = () => { if (isEngaged()) setTimeout(go, 10000); else { setView('break'); startBreak(); } }; go(); }
      else S.reminderToast = toast({ text: 'It has been ' + br.minutes + ' minutes. Take a break?', ttl: 0, actions: [{ label: 'Take a break', primary: true, fn: () => { setView('break'); startBreak(); } }, { label: 'Later', fn: () => {} }] });
    }
  }
  /** Update the "Working · 3 min" chips in place so threads breathe without re-rendering. */
  function refreshElapsed() {
    if (S.view !== 'now' || !S.project) return;
    for (const card of document.querySelectorAll('.thread.working')) {
      const t = threadsOf(S.project).find(x => x.task.id === card.dataset.task); if (!t?.latest) continue;
      const l = card.querySelector('.status .l'), s = card.querySelector('.status .s');
      if (l) l.textContent = `Working · ${dur(Date.now() - t.latest.startedAt)}`; if (s) s.textContent = dur(Date.now() - t.latest.startedAt);
    }
  }
  function toggleRail(force) {
    const on = force === undefined ? !document.body.classList.contains('rail-collapsed') : !!force;
    document.body.classList.toggle('rail-collapsed', on);
    S.settings.window.railCollapsed = on; api.setSettings({ window: { railCollapsed: on } });
    const b = $('#btn-rail'); if (b) b.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
  }
  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if ($('#overlay').firstChild || S.popover) { closeOverlay(); closePopover(); return; }
      if (S.view === 'tickets' && S.ticket) { S.ticket = null; savePlace(); render(true); return; }
      if (typing()) document.activeElement.blur();
      return;
    }
    if (!mod && !e.altKey && !typing() && !$('#overlay').firstChild) {
      // Page shortcuts: single keys, only when nothing is being edited.
      if (e.key === '?') { e.preventDefault(); shortcutSheet(); return; }
      if (e.key === '[') { e.preventDefault(); toggleRail(); return; }
      if (e.key === 'n' && S.project) { e.preventDefault(); if (S.view !== 'tickets') setView('tickets'); newTicket(); return; }
      if (e.key === 'r' && S.view === 'now') { e.preventDefault(); const b = $('.tl-item.hot .tl-actions .btn') || $('.tl-item .tl-actions .btn'); if (b) b.click(); return; }
      if (S.view === 'tickets' && (e.key === 'j' || e.key === 'k')) {
        e.preventDefault();
        const rows = [...document.querySelectorAll('.tk-row')]; if (!rows.length) return;
        const i = rows.findIndex(r => r.classList.contains('selected'));
        const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (e.key === 'j' ? 1 : -1)))];
        next.click(); next.scrollIntoView({ block: 'nearest' }); return;
      }
      if (e.key === 'e' && S.view === 'tickets' && S.ticket) { e.preventDefault(); $('.tk-detail .tk-title-in')?.focus(); return; }
      if (e.key === 'p' && S.view === 'tickets') { e.preventDefault(); const item = $('.tk-row.selected')?.closest('.tk-item') || $('.tk-item'); if (item) { const id = item.dataset.id; const tk = user()?.tickets.find(x => x.id === id); if (tk) togglePrompt(tk, item); } return; }
      return;
    }
    if (!mod) return;
    if (e.key >= '1' && e.key <= '4') { e.preventDefault(); setView(VIEWS[Number(e.key) - 1][0]); }
    else if (e.key === ',') { e.preventDefault(); openSettings({}); }
    else if (e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); if (S.view !== 'tickets') setView('tickets'); newTicket(); }
    else if (e.key.toLowerCase() === 'c' && e.shiftKey) { e.preventDefault(); api.setWindowMode(S.mode === 'compact' ? 'expanded' : 'compact'); }
  }

  // ---------- render ----------
  function render(force = false) { renderRail(); renderHead(); renderCompactNav(); renderView(force); }

  function renderRail() {
    const list = $('#ws-list'); list.textContent = '';
    const ps = visibleProjects();
    if (!ps.length) list.append(el('p', { class: 't-small', style: 'padding:8px 10px' }, 'No workspaces yet. An agent will create one when it starts, or add one yourself.'));
    for (const p of ps) {
      const st = projectStatus(p.id);
      list.append(el('button', { class: 'ws', role: 'listitem', 'aria-current': p.id === S.project ? 'true' : 'false', onclick: () => switchProject(p.id), title: p.path || '' },
        el('span', { class: 'ws-tok', style: `background:var(--ws-${p.color})` }, initials(projectName(p))),
        el('span', { style: 'display:grid;min-width:0' }, el('span', { class: 'ws-name', text: projectName(p) }), el('span', { class: 'ws-sub' }, st.agent ? agentIcon(st.agent, 14) : null, st.label)),
        el('span', { class: 'dot ' + st.cls })));
    }
    const sel = $('#compact-ws'); sel.textContent = '';
    const cur = project();
    if (cur) sel.append(el('span', { class: 'ws-tok', style: `background:var(--ws-${cur.color})` }, initials(projectName(cur))), el('span', { class: 'wsbtn-name', text: projectName(cur) }), svg('M4 6l4 4 4-4', 12));
    $('#compact-ws').hidden = S.mode !== 'compact'; $('#compact-mark').hidden = S.mode !== 'compact'; $('#btn-expand').hidden = S.mode !== 'compact';
  }

  function renderHead() {
    const h = $('#head'); h.textContent = '';
    const p = project();
    if (!p) { h.append(el('h1', { text: 'Layover' })); return; }
    const st = projectStatus(p.id);
    const row = el('div', { class: 'head-row' }, S.mode === 'compact' ? null : el('h1', { text: projectName(p) }), el('button', { class: 'status ' + st.cls, onclick: (e) => runsPopover(e.currentTarget) }, st.agent ? agentIcon(st.agent, 16) : el('span', { class: 'dot ' + st.cls }), st.label),
      S.brk.timer && S.view !== 'break' ? el('button', { class: 'status brk', title: 'Back to the break', onclick: () => setView('break') }, svg('M8 4.5V8l2.5 1.5M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11Z', 13), el('span', { class: 'brk-chip', text: fmt(S.brk.left) })) : null);
    const open = openItems(p.id).length, active = (user(p.id)?.tickets || []).filter(t => FILTERS.active.includes(t.status)).length;
    const tabs = el('div', { class: 'tabs', role: 'tablist' });
    for (const [id, label] of VIEWS) {
      const count = id === 'now' ? open : id === 'tickets' ? active : 0;
      const tip = id === 'now' ? 'Open items from agents' : id === 'tickets' ? 'Up next and in progress' : '';
      tabs.append(el('button', { class: 'tab', role: 'tab', title: tip || null, 'aria-selected': S.view === id ? 'true' : 'false', onclick: () => setView(id) }, label, count ? el('span', { class: 'count' + (id === 'now' && st.cls === 'attention' ? ' hot' : ''), text: String(count) }) : null));
    }
    if (S.mode !== 'compact') h.append(row, tabs); else h.append(row);
  }

  function renderCompactNav() {
    const n = $('#cnav'); n.textContent = '';
    if (S.mode !== 'compact' || !S.project) return;
    const open = openItems(S.project).length, active = (user()?.tickets || []).filter(t => FILTERS.active.includes(t.status)).length;
    for (const [id, label] of VIEWS) n.append(el('button', { 'aria-selected': S.view === id ? 'true' : 'false', onclick: () => setView(id) }, label, id === 'now' && open ? el('span', { class: 'count', text: String(open) }) : id === 'tickets' && active ? el('span', { class: 'count', text: String(active) }) : id === 'break' && S.brk.timer ? el('span', { class: 'count brk-chip', text: fmt(S.brk.left) }) : null));
  }

  function ack(runId) { S.acked[runId] = true; const u = user(); if (u) { u.place.acked = { ...(u.place.acked || {}), [runId]: Date.now() }; api.setPlace(S.project, { acked: u.place.acked }); } renderHead(); renderRail(); }

  function renderView(force = false) {
    const key = `${S.project}|${S.view}|${S.mode}`;
    const v = $('#view');
    if (!force && key === S.viewKey && S.view !== 'now') return;
    if (S.view === 'now' && !force && key === S.viewKey && isEngaged()) { deferRefresh(); return; }
    const keepScroll = key === S.viewKey ? v.scrollTop : 0;
    S.viewKey = key; S.pendingRefresh = false;
    v.textContent = '';
    v.className = 'view view-' + S.view;
    if (!S.project) { v.append(el('div', { class: 'empty' }, el('p', {}, el('b', { text: 'Nothing here yet.' }), ' Layover fills in when Claude Code or Codex starts working in a folder. Connect them in Settings, or add a workspace by hand.'), el('p', { style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: () => openSettings({}) }, 'Open Settings')))); return; }
    const wrap = el('div', { class: 'view-in' });
    ({ now: renderNow, tickets: renderTickets, notes: renderNotes, break: renderBreak })[S.view](wrap);
    if (!keepScroll) wrap.classList.add('enter'); // a new page settles in; an in-place refresh stays still
    v.append(wrap);
    if (keepScroll) v.scrollTop = keepScroll;
  }

  // ---------- Now: threads ----------
  function renderNow(wrap) {
    const pid = S.project, u = user(pid);
    const threads = threadsOf(pid);
    const recent = threads.filter(t => t.recent);
    const archive = threads.filter(t => !t.recent);
    if (!threads.length) {
      wrap.append(el('div', { class: 'empty' }, el('p', {}, el('b', { text: 'No agent has started here yet.' }), ' Threads appear when Claude Code or Codex works in this folder.')));
      return;
    }
    const list = el('div', { class: 'threads' });
    if (!recent.length) list.append(el('div', { class: 'empty' }, el('p', {}, el('b', { text: 'All quiet.' }))));
    for (const t of recent) list.append(threadCard(t, u));
    wrap.append(list);
    if (archive.length) {
      const d = el('details', { class: 'more', open: S.archiveOpen ? '' : null, ontoggle: e => { S.archiveOpen = e.target.open; } }, el('summary', { text: `Archive · ${archive.length}` }));
      const l2 = el('div', { class: 'threads' }); for (const t of archive) l2.append(threadCard(t, u, true)); d.append(l2); wrap.append(d);
    }
  }
  function workspaceMenu(anchor) {
    closePopover();
    const pop = el('div', { class: 'pop menu', role: 'menu' });
    for (const p of visibleProjects()) {
      const st = projectStatus(p.id);
      pop.append(el('button', { class: 'menu-item' + (p.id === S.project ? ' on' : ''), role: 'menuitem', onclick: () => { closePopover(); switchProject(p.id); } },
        el('span', { class: 'ws-tok', style: `background:var(--ws-${p.color});width:22px;height:22px;font-size:10px` }, initials(projectName(p))), el('span', { class: 'menu-grow', text: projectName(p) }), el('span', { class: 'dot ' + st.cls })));
    }
    pop.append(el('button', { class: 'menu-item', role: 'menuitem', onclick: () => { closePopover(); addWorkspace(); } }, svg(ICON.plus, 13), 'New workspace'));
    place(pop, anchor);
  }
  function threadMenu(anchor, t, who) {
    closePopover();
    const pop = el('div', { class: 'pop menu', role: 'menu' });
    const item = (label, fn, icon) => el('button', { class: 'menu-item', role: 'menuitem', onclick: () => { closePopover(); fn(); } }, icon ? svg(icon, 13) : null, label);
    pop.append(item(`How to return to ${who}`, () => returnSheet(t.latest || { agent: t.task.agent, task: t.task.id, id: '', source: t.task.source }), ICON.arrow));
    if (t.ticket) pop.append(item(`Open ${ticketKey(t.ticket)}`, () => { S.ticket = t.ticket.id; S.ticketFilter = 'all'; setView('tickets'); }, ICON.plus));
    pop.append(item(t.archived || !t.recent ? 'Restore to Now' : 'Archive', () => setArchived(t.task.id, !(t.archived || !t.recent)), ICON.x));
    if (t.task.sessionId) pop.append(item('Copy session id', () => { api.copy(t.task.sessionId); toast({ text: 'Session id copied.', ttl: 3000 }); }, ICON.copy));
    if (t.task.agent === 'codex' && t.latest) pop.append(item('Send to Codex…', () => sendSheet(t.latest)));
    place(pop, anchor);
  }

  function threadCard(t, u, quiet = false) {
    const agent = t.task.agent, who = AGENT[agent] || agent, short = AGENT_SHORT[agent] || agent;
    const latest = t.latest;
    const collapsed = !!user()?.place?.collapsed?.[t.task.id];
    const card = el('section', { class: 'thread ' + t.status + (collapsed ? ' collapsed' : ''), dataset: { task: t.task.id } });
    // Collapse animates in place; the state is persisted without re-rendering the whole view.
    const toggle = async () => {
      const u = user(); u.place.collapsed = { ...(u.place.collapsed || {}) };
      const now = !card.classList.contains('collapsed');
      if (now) u.place.collapsed[t.task.id] = true; else delete u.place.collapsed[t.task.id];
      card.classList.toggle('collapsed', now);
      const chev = card.querySelector('.chev'); if (chev) { chev.setAttribute('aria-expanded', now ? 'false' : 'true'); chev.setAttribute('aria-label', now ? 'Expand' : 'Collapse'); }
      const badge = card.querySelector('.open-badge'); if (badge) badge.hidden = !now;
      await api.setPlace(S.project, { collapsed: u.place.collapsed });
    };
    // header
    const title = cleanTitle(latest?.title) || (t.task.name && !/^(claude|codex):/.test(t.task.name) ? t.task.name : 'Conversation');
    const statusChip = t.status === 'working' ? el('span', { class: 'status working' }, el('span', { class: 'dot working' }), ...lbl(`Working · ${dur(Date.now() - latest.startedAt)}`, dur(Date.now() - latest.startedAt)))
      : t.status === 'attention' ? el('span', { class: 'status attention' }, el('span', { class: 'dot attention' }), ...lbl('Waiting on you', 'Waiting'))
      : t.status === 'completed' ? el('span', { class: 'status done' }, el('span', { class: 'dot done' }), ...lbl(`Finished ${ago(latest.endedAt)}`, 'Done'))
      : t.status === 'failed' ? el('span', { class: 'status attention' }, el('span', { class: 'dot failed' }), 'Error')
      : t.status === 'cancelled' ? el('span', { class: 'status attention' }, el('span', { class: 'dot attention' }), 'Interrupted')
      : t.status === 'disconnected' ? el('span', { class: 'status attention' }, el('span', { class: 'dot attention' }), ...lbl('No recent signal', 'No signal'))
      : el('span', { class: 'status' }, el('span', { class: 'dot quiet' }), 'Idle');
    card.append(el('div', { class: 'thread-h', onclick: e => { if (!e.target.closest('button')) toggle(); } },
      el('button', { class: 'icon-btn chev', 'aria-label': collapsed ? 'Expand' : 'Collapse', 'aria-expanded': collapsed ? 'false' : 'true', onclick: toggle }, svg('M6 4l4 4-4 4', 14)),
      agentIcon(agent, 26),
      el('div', { class: 'thread-t' }, el('div', { class: 'thread-title' }, el('b', { text: title }), t.ticket ? el('button', { class: 'chip accent link', title: t.ticket.title, onclick: () => { S.ticket = t.ticket.id; S.ticketFilter = 'all'; setView('tickets'); } }, ticketKey(t.ticket)) : null, t.open ? el('span', { class: 'chip open-badge' + (t.waiting ? ' warn' : ''), text: `${t.open} open`, hidden: !collapsed }) : null), el('span', { text: `${t.runs.length} turn${t.runs.length === 1 ? '' : 's'} · started ${clock(t.runs[0]?.startedAt || t.task.createdAt)}` })),
      statusChip,
      el('button', { class: 'btn small ghost l', title: t.task.host ? `Bring ${t.task.host.name} forward` : `How to return to ${who}`, onclick: () => returnTo(latest || { agent, task: t.task.id, id: '', source: t.task.source }) }, 'Return', svg(ICON.arrow, 13)),
      el('button', { class: 'icon-btn', title: 'More', 'aria-label': 'Conversation menu', onclick: e => threadMenu(e.currentTarget, t, who) }, svg('M3 8h.01M8 8h.01M13 8h.01', 16, 'stroke-width="2.4"'))));
    // timeline entries in time order
    const entries = [];
    for (const r of t.runs) {
      if (t.runs.length > 1) entries.push({ at: r.startedAt, kind: 'turn', run: r }); // a single turn is already the thread title
      if (r.status !== 'active') entries.push({ at: r.endedAt || r.lastSeen, kind: 'end', run: r });
    }
    for (const i of t.items) if (!i.userDismissed) entries.push({ at: i.createdAt, kind: 'item', item: i });
    for (const m of (S.state.outbox || [])) if (m.task === t.task.id && m.status !== 'cancelled' && !m.itemKey) entries.push({ at: m.createdAt, kind: 'msg', m });
    entries.sort((a, b) => a.at - b.at);
    const limit = S.mode === 'compact' ? 4 : 10;
    const expanded = S.expandedThreads.has(t.task.id);
    const shown = expanded || entries.length <= limit ? entries : entries.slice(-limit);
    const tl = el('div', { class: 'tl' });
    if (shown.length < entries.length) tl.append(el('button', { class: 'btn small ghost tl-more', onclick: () => { S.expandedThreads.add(t.task.id); render(true); } }, `Show ${entries.length - shown.length} earlier`));
    const openLatest = [...t.items].reverse().find(i => i.status === 'open' && !i.userDismissed);
    for (const e of shown) {
      if (e.kind === 'turn') tl.append(el('div', { class: 'tl-turn' }, el('i'), el('span', { text: cleanTitle(e.run.title) || `Turn ${t.runs.indexOf(e.run) + 1}` }), el('span', { class: 'tl-time', text: clock(e.at) })));
      else if (e.kind === 'item') tl.append(itemEntry(e.item, u, openLatest && e.item.key === openLatest.key && t.status !== 'completed', t));
      else if (e.kind === 'msg') tl.append(msgEntry(e.m, t));
      // Only the latest turn's ending deserves the prominent row; older completions read as quiet history.
      else tl.append(endEntry(e.run, who, quiet || e.run.id !== latest?.id, e.run.id === latest?.id ? t.ticket : null));
    }
    if (t.status === 'working' && !shown.some(e => e.kind === 'item' && e.item.runStatus === 'active')) tl.append(el('div', { class: 'tl-quiet', text: 'Working quietly.' }));
    if (!quiet && t.latest?.status === 'active') tl.append(composer(t, who));
    card.append(el('div', { class: 'tl-wrap' }, tl));
    return card;
  }

  function itemEntry(i, u, hot, thread = null) {
    const resp = u?.responses?.[i.key];
    const who = AGENT[i.agent] || i.agent;
    const sent = (S.state.outbox || []).filter(m => m.itemKey === i.key && m.status !== 'cancelled').sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    const live = thread?.latest?.status === 'active';
    const row = el('div', { class: 'tl-item ' + i.kind + (hot ? ' hot' : ''), dataset: { key: i.key } });
    const chip = i.waiting && i.runStatus === 'active' ? el('span', { class: 'chip warn', text: 'Waiting on you' })
      : i.kind === 'decision' && i.runStatus === 'active' ? el('span', { class: 'chip' }, ...lbl('Assumption · continuing', 'Assumption')) : null;
    row.append(el('div', { class: 'tl-meta' }, el('span', { class: 'kind ' + i.kind }, el('i'), KIND_LABEL[i.kind]), chip, el('span', { class: 'spacer' }), el('span', { class: 'tl-time', text: clock(i.updatedAt) })));
    if (i.title) row.append(el('div', { class: 't-h3', text: i.title }));
    row.append(el('div', { class: 'tl-text', text: i.text }));
    const respBox = el('div', { class: 'resp' });
    let editing = false;
    const drawResp = () => {
      respBox.textContent = '';
      const copyReply = (body) => { api.copy(`Regarding your ${i.kind}: "${i.text}"\n\n${body}`); toast({ text: 'Reply copied with the item it answers. Paste it into the agent.', ttl: 4000 }); };
      if (!editing) { if (resp?.body) respBox.append(el('div', { class: 'bubble' + (sent ? ' sent' : '') }, el('div', { class: 'bubble-top' }, el('span', { class: 'bubble-who', text: sent && sent.text === resp.body ? 'You · ' + msgStatus(sent, thread) : live ? 'You · saved here, not sent' : 'You · saved here · bring it when you return' }), el('span', { class: 'spacer' }), sent && sent.status === 'queued' && sent.text === resp.body ? el('button', { class: 'btn small ghost', onclick: async () => { await api.cancelMessage(sent.id); } }, 'Unsend') : live ? el('button', { class: 'btn small primary', onclick: () => sendToAgent({ task: i.task, run: i.run, itemKey: i.key, text: resp.body }) }, svg(ICON.arrow, 12), ...lbl(`Send to ${who}`, 'Send')) : null, el('button', { class: 'btn small ghost', onclick: () => copyReply(resp.body) }, svg(ICON.copy, 12), el('span', { class: 'l', text: 'Copy' })), el('button', { class: 'btn small ghost', onclick: () => { editing = true; drawResp(); } }, 'Edit')), el('div', { class: 'tl-text', text: resp.body }))); return; }
      const ta = el('textarea', { class: 'input', placeholder: i.kind === 'question' ? 'Your answer, for when you return to the agent…' : 'A thought, a concern, a reply…', 'aria-label': 'Your reply' });
      ta.value = resp?.body || '';
      const meta = el('div', { class: 'resp-meta' }, el('span', { text: resp ? `Saved ${ago(resp.updatedAt)}` : 'Saved as you type' }), el('span', { class: 'spacer' }), el('button', { class: 'btn small ghost', onclick: () => { if (ta.value.trim()) copyReply(ta.value); } }, svg(ICON.copy, 12), el('span', { class: 'l', text: 'Copy' })), live ? el('button', { class: 'btn small primary', onclick: async () => { if (!ta.value.trim()) return; save.flush(); await sendToAgent({ task: i.task, run: i.run, itemKey: i.key, text: ta.value }); editing = false; } }, svg(ICON.arrow, 12), ...lbl(`Send to ${who}`, 'Send')) : null);
      const save = debounce(() => api.respond(S.project, i.key, ta.value).then(() => { const uu = user(); if (uu) { if (ta.value) uu.responses[i.key] = { body: ta.value, updatedAt: Date.now() }; else delete uu.responses[i.key]; } meta.firstChild.textContent = ta.value ? 'Saved just now' : 'Saved as you type'; }), 400);
      ta.addEventListener('input', () => { autoGrow(ta); save(); });
      registerFlush('resp:' + i.key, () => save.flush());
      respBox.append(ta, meta);
      queueMicrotask(() => { autoGrow(ta); ta.focus(); });
    };
    const actions = el('div', { class: 'tl-actions' },
      el('button', { class: 'btn small' + (i.kind === 'question' && i.status === 'open' ? ' primary' : ' ghost'), onclick: () => { editing = true; drawResp(); } }, svg(ICON.reply, 12), ...lbl(i.kind === 'question' ? 'Answer' : 'Reply', i.kind === 'question' ? 'Answer' : 'Reply')),
      // Only proposals can be promoted into Next; a decision or a question is not something to do later.
      i.kind === 'opportunity' || i.kind === 'suggestion' ? el('button', { class: 'btn small ghost', onclick: () => ticketFromItem(i) }, svg(ICON.plus, 12), ...lbl('Add to Next', 'Next')) : null,
      el('span', { class: 'spacer' }),
      i.status === 'open' ? el('button', { class: 'btn small ghost', title: 'Dismiss', onclick: async () => { await api.dismiss(S.project, i.key, true); const uu = user(); if (uu) uu.dismissed[i.key] = Date.now(); render(true); } }, svg(ICON.x, 12), el('span', { class: 'l', text: 'Dismiss' })) : el('span', { class: 'chip', text: i.status }));
    row.append(actions, respBox);
    drawResp();
    return row;
  }

  function endEntry(r, who, quiet, ticket = null) {
    const acked = isAcked(r.id) || quiet;
    const cls = r.status === 'completed' ? 'done' : r.status === 'failed' ? 'failed' : 'attention';
    const text = r.status === 'completed' ? `Finished · ran ${dur((r.endedAt || r.lastSeen) - r.startedAt)}`
      : r.status === 'failed' ? `Stopped with an error${r.endNote ? ' · ' + r.endNote : ''}`
      : r.status === 'cancelled' ? `Interrupted${r.endNote ? ' · ' + r.endNote : ''}`
      : 'No recent signal. It may still be thinking, or the session may have closed.';
    const row = el('div', { class: 'tl-end ' + cls + (acked ? ' acked' : '') }, agentIcon(r.agent, 16), el('span', { class: 'tl-end-text' }, acked ? text : [el('b', { text: r.status === 'completed' ? 'Ready when you are. ' : '' }), text]), el('span', { class: 'tl-time', text: clock(r.endedAt || r.lastSeen) }));
    if (!acked) row.append(el('span', { class: 'tl-end-actions' }, el('button', { class: 'btn small primary', title: `Return to ${who}`, onclick: () => returnTo(r) }, 'Return', svg(ICON.arrow, 12)),
      ticket && ticket.status !== 'done' && r.status === 'completed' ? el('button', { class: 'btn small', onclick: () => setTicket(ticket, { status: 'done' }) }, svg(ICON.check, 12), ...lbl(`Mark ${ticketKey(ticket)} done`, 'Done')) : null,
      el('button', { class: 'btn small ghost', onclick: () => { ack(r.id); render(true); } }, ...lbl('Got it', 'OK'))));
    return row;
  }

  /** Honest delivery status for a queued or delivered message. */
  function msgStatus(m, thread) {
    const who = thread ? (AGENT[thread.task.agent] || thread.task.agent) : 'the agent';
    if (m.status === 'queued') return thread && (thread.status === 'working' || thread.status === 'attention') ? 'sent · ' + who + ' sees it at its next pause' : 'sent · goes with your next message to ' + who;
    if (m.status === 'delivered') return 'delivered ' + clock(m.deliveredAt) + (m.moment === 'mid-turn' ? ' · while it worked' : m.moment === 'turn-end' ? ' · as it finished, so it kept going' : ' · with your next message');
    return m.status;
  }
  async function sendToAgent({ task, run, itemKey, text }) {
    try {
      await call(api.sendMessage({ project: S.project, task, run: run || null, itemKey: itemKey || null, text }));
      toast({ text: 'Sent. It reaches the agent at its next pause.', ttl: 4000 });
    } catch (e) { toast({ text: e.message, ttl: 6000 }); }
  }
  function composer(t, who) {
    const box = el('div', { class: 'composer' });
    const ta = el('textarea', { class: 'input', placeholder: 'Message ' + who + '…', 'aria-label': 'Message ' + who, rows: '1' });
    const send = async () => { const v = ta.value.trim(); if (!v) return; ta.value = ''; autoGrow(ta); await sendToAgent({ task: t.task.id, run: t.latest?.id, itemKey: null, text: v }); };
    ta.addEventListener('input', () => autoGrow(ta));
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    box.append(ta, el('button', { class: 'btn small primary', onclick: send, title: 'Ctrl+Enter' }, svg(ICON.arrow, 12), ...lbl('Send', 'Send')));
    return box;
  }
  function msgEntry(m, t) {
    return el('div', { class: 'tl-msg ' + m.status }, el('div', { class: 'tl-meta' }, el('span', { class: 'bubble-who', text: 'You · ' + msgStatus(m, t) }), el('span', { class: 'spacer' }), m.status === 'queued' ? el('button', { class: 'btn small ghost', onclick: () => api.cancelMessage(m.id) }, 'Unsend') : null, el('span', { class: 'tl-time', text: clock(m.createdAt) })), el('div', { class: 'tl-text', text: m.text }));
  }
  function copyItem(i, u) {
    const r = u?.responses?.[i.key]?.body;
    api.copy(r ? `Regarding your ${i.kind}: "${i.text}"\n\nMy response: ${r}` : `Regarding your ${i.kind}: "${i.text}"`);
    toast({ text: r ? 'Item and your reply copied. Paste it into the agent.' : 'Item copied.', ttl: 4000 });
  }
  async function ticketFromItem(i) {
    const u = user();
    const title = (i.title || i.text).split('\n')[0].slice(0, 100);
    const description = `${i.text}\n\n— ${AGENT[i.agent] || i.agent}, ${KIND_LABEL[i.kind].toLowerCase()}`;
    const t = await call(api.upsertTicket(S.project, { title, description, status: 'backlog', fromItem: i.key }));
    if (u) u.tickets.unshift(t);
    toast({ text: `Added to Next as ${ticketKey(t)}, under Someday.`, ttl: 4000, actions: [{ label: 'Open', fn: () => { S.ticket = t.id; S.ticketFilter = 'backlog'; setView('tickets'); } }] });
    renderHead(); renderCompactNav();
  }

  // ---------- Tickets ----------
  const STATUS_ICON = {
    backlog: () => svg('M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11Z', 15, 'stroke-dasharray="2.2 2.2"'),
    todo: () => svg('M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11Z', 15),
    progress: () => { const s = svg('M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11Z', 15); s.innerHTML += '<path d="M8 4.5a3.5 3.5 0 0 1 0 7Z" fill="currentColor"/>'; return s; },
    done: () => { const s = svg('', 15); s.innerHTML = '<circle cx="8" cy="8" r="5.5" fill="currentColor"/><path d="M5.5 8.2l1.8 1.8 3.4-3.6" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'; return s; },
    cancelled: () => { const s = svg('M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11Z', 15); s.innerHTML += '<path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'; return s; },
  };
  function priorityGlyph(p) {
    const g = el('span', { class: 'prio p' + p, title: PRIORITY[p] });
    if (p === 4) { g.textContent = '!'; return g; }
    for (let i = 1; i <= 3; i++) g.append(el('i', { class: i <= p ? 'on' : '' }));
    return g;
  }

  function renderTickets(wrap) {
    const u = user(); if (!u) return;
    const all = u.tickets;
    if (!FILTERS[S.ticketFilter] || S.ticketFilter === 'backlog' || S.ticketFilter === 'all') S.ticketFilter = 'active';
    const visible = all.filter(t => FILTERS[S.ticketFilter].includes(t.status));
    const bar = el('div', { class: 'tk-bar' },
      el('button', { class: 'btn primary', onclick: () => newTicket() }, svg(ICON.plus, 12), 'New'),
      seg([['active', 'Active'], ['done', 'Done']], S.ticketFilter, v => { S.ticketFilter = v; savePlace(); render(true); }),
      el('span', { class: 'spacer' }),
      el('span', { class: 't-small l', text: visible.length + ' of ' + all.length }));
    const split = el('div', { class: 'tk-split' + (S.ticket ? ' has-detail' : '') });
    const list = el('div', { class: 'tk-list' });
    if (!visible.length) list.append(el('div', { class: 'empty' }, el('p', {}, el('b', { text: all.length ? 'Nothing in this view.' : 'Nothing lined up yet.' }), all.length ? '' : ' Press n to add something.')));
    for (const st of STATUS_ORDER) {
      const rows = visible.filter(x => x.status === st).sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);
      if (!rows.length) continue;
      list.append(el('div', { class: 'tk-group' }, el('span', { text: STATUS[st] }), el('span', { class: 'faint', text: String(rows.length) })));
      for (const x of rows) list.append(ticketRow(x));
    }
    split.append(list);
    const sel = S.ticket ? all.find(x => x.id === S.ticket) : null;
    if (sel) split.append(ticketDetail(sel)); else S.ticket = null;
    wrap.append(bar, split);
  }
  /** One entry: the row, plus a prompt editor that folds open underneath it. */
  function ticketRow(t) {
    const open = S.promptOpen.has(t.id);
    const item = el('div', { class: 'tk-item' + (open ? ' open' : ''), dataset: { id: t.id } });
    const select = () => { S.ticket = t.id; savePlace(); render(true); };
    const row = el('div', { class: 'tk-row' + (t.id === S.ticket ? ' selected' : '') + (t.status === 'done' || t.status === 'cancelled' ? ' closed' : ''), role: 'button', tabindex: '0',
      onclick: e => { if (!e.target.closest('button, input, textarea')) select(); }, onkeydown: e => { if (e.key === 'Enter' && e.target === row) select(); } });
    const editing = S.editingTitle === t.id;
    const title = editing
      ? (() => {
          let done = false;
          const commit = async (cancel) => {
            if (done) return; done = true; S.editingTitle = null;
            const v = cancel ? '' : input.value.trim();
            if (!v && !t.description && !t.prompt) { await api.deleteTicket(S.project, t.id); const uu = user(); uu.tickets = uu.tickets.filter(x => x.id !== t.id); }
            else if (v && v !== t.title) { const saved = await call(api.upsertTicket(S.project, { id: t.id, title: v })); Object.assign(t, saved); }
            render(true);
          };
          const input = el('input', { class: 'tk-title-row', placeholder: 'What needs doing?', 'aria-label': 'Title', value: t.title,
            onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); commit(false); } else if (e.key === 'Escape') { e.stopPropagation(); commit(true); } },
            onblur: () => commit(false) });
          return input;
        })()
      : el('span', { class: 'tk-title', text: t.title || 'Untitled' });
    row.append(...[
      el('button', { class: 'tk-status ' + t.status, title: STATUS[t.status], onclick: e => { e.stopPropagation(); statusMenu(e.currentTarget, t); } }, STATUS_ICON[t.status]()),
      el('span', { class: 'tk-key', text: ticketKey(t) }),
      title,
      el('button', { class: 'btn small ghost tk-prompt-btn' + (t.prompt ? ' has' : ''), title: t.prompt ? 'Edit the prompt' : 'Draft a prompt for the agent', 'aria-expanded': open ? 'true' : 'false', onclick: e => { e.stopPropagation(); togglePrompt(t, item); } }, svg('M3 13l1-4 7-7 3 3-7 7-4 1z', 12), ...lbl('Prompt', 'P')),
      priorityGlyph(t.priority),
      el('span', { class: 'tk-time l', text: ago(t.updatedAt) })].filter(Boolean));
    item.append(row, promptPanel(t));
    if (editing) queueMicrotask(() => { title.focus(); title.select(); });
    return item;
  }
  function togglePrompt(t, item) {
    const open = !item.classList.contains('open');
    if (open) S.promptOpen.add(t.id); else S.promptOpen.delete(t.id);
    item.classList.toggle('open', open);
    const btn = item.querySelector('.tk-prompt-btn'); if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) setTimeout(() => item.querySelector('textarea')?.focus(), 240);
  }
  function promptPanel(t) {
    const ta = el('textarea', { class: 'input grow', placeholder: 'Prompt for the agent…', 'aria-label': 'Prompt' }); ta.value = t.prompt;
    const meta = el('span', { class: 't-small', text: t.prompt ? 'Saved' : '' });
    const save = debounce(async () => { const saved = await call(api.upsertTicket(S.project, { id: t.id, prompt: ta.value })); Object.assign(t, saved); meta.textContent = 'Saved'; const btn = document.querySelector('.tk-item[data-id="' + t.id + '"] .tk-prompt-btn'); if (btn) btn.classList.toggle('has', !!t.prompt); }, 400);
    registerFlush('prompt:' + t.id, () => save.flush());
    ta.addEventListener('input', () => { autoGrow(ta); meta.textContent = 'Saving…'; save(); });
    const copy = () => { const parts = [(t.title || 'Untitled') + ' (' + ticketKey(t) + ')', t.description.trim(), ta.value.trim()].filter(Boolean); api.copy(parts.join('\n\n')); toast({ text: 'Prompt copied.', ttl: 3000 }); };
    const panel = el('div', { class: 'tk-prompt-wrap' }, el('div', { class: 'tk-prompt' }, el('div', { class: 'tk-prompt-in' }, ta,
      el('div', { class: 'tk-prompt-f' }, el('button', { class: 'btn primary small', onclick: copy }, svg(ICON.copy, 12), ...lbl('Copy prompt', 'Copy')), meta))));
    queueMicrotask(() => autoGrow(ta));
    return panel;
  }
  function statusMenu(anchor, t) {
    closePopover();
    const pop = el('div', { class: 'pop menu', role: 'menu' });
    for (const st of STATUS_ORDER) pop.append(el('button', { class: 'menu-item' + (st === t.status ? ' on' : ''), role: 'menuitem', onclick: async () => { closePopover(); await setTicket(t, { status: st }); } }, el('span', { class: 'tk-status ' + st }, STATUS_ICON[st]()), STATUS[st]));
    place(pop, anchor);
  }
  /** A pill that opens a menu: the app's replacement for native <select>. options: [value, label, iconNode?] */
  function pick({ options, value, onPick, label, small = true }) {
    const cur = options.find(o => o[0] === value) || options[0];
    const btn = el('button', { class: 'btn' + (small ? ' small' : '') + ' pick', 'aria-haspopup': 'menu', 'aria-label': label });
    const draw = (o) => { btn.textContent = ''; btn.append(...[o[2] ? o[2]() : null, el('span', { text: o[1] }), svg('M4 6l4 4 4-4', 12)].filter(Boolean)); };
    draw(cur);
    btn.addEventListener('click', () => {
      closePopover();
      const pop = el('div', { class: 'pop menu', role: 'menu' });
      for (const o of options) pop.append(el('button', { class: 'menu-item' + (String(o[0]) === String(btn.dataset.value ?? value) ? ' on' : ''), role: 'menuitem', onclick: () => { closePopover(); btn.dataset.value = o[0]; draw(o); onPick(o[0]); } }, o[2] ? o[2]() : null, o[1]));
      place(pop, btn);
    });
    btn.dataset.value = cur[0];
    return btn;
  }
  async function setTicket(t, patch) {
    const saved = await call(api.upsertTicket(S.project, { id: t.id, ...patch }));
    const u = user(); const idx = u.tickets.findIndex(x => x.id === t.id); if (idx >= 0) u.tickets[idx] = saved;
    render(true);
    return saved;
  }
  /** New entry: an inline title on a fresh row. Enter keeps it, Escape drops it. */
  async function newTicket() {
    const u = user(); if (!u) return;
    if (S.ticketFilter !== 'active') { S.ticketFilter = 'active'; savePlace(); }
    const t = await call(api.upsertTicket(S.project, { title: '', status: 'todo' }));
    u.tickets.unshift(t); S.editingTitle = t.id;
    render(true);
  }
  function ticketDetail(t) {
    const d = el('div', { class: 'tk-detail card' });
    const u = user();
    const title = el('input', { class: 'tk-title-in', placeholder: 'Title', 'aria-label': 'Title' }); title.value = t.title;
    const desc = el('textarea', { class: 'input grow', placeholder: 'Description', 'aria-label': 'Description' }); desc.value = t.description;
    const meta = el('span', { class: 't-small', text: 'Updated ' + ago(t.updatedAt) });
    const save = debounce(async () => { const saved = await call(api.upsertTicket(S.project, { id: t.id, title: title.value, description: desc.value })); Object.assign(t, saved); meta.textContent = 'Saved'; const row = document.querySelector('.tk-row.selected .tk-title'); if (row) row.textContent = t.title || 'Untitled'; }, 400);
    registerFlush('ticket:' + t.id, () => save.flush());
    for (const f of [title, desc]) f.addEventListener('input', () => { meta.textContent = 'Saving…'; if (f.tagName === 'TEXTAREA') autoGrow(f); save(); });
    const statusSel = pick({ label: 'Status', value: t.status, options: STATUS_ORDER.map(s => [s, STATUS[s], () => el('span', { class: 'tk-status ' + s }, STATUS_ICON[s]())]), onPick: v => setTicket(t, { status: v }) });
    const prioSel = pick({ label: 'Priority', value: t.priority, options: PRIORITY.map((p, i) => [i, p, () => priorityGlyph(i)]), onPick: v => setTicket(t, { priority: Number(v) }) });
    const linked = (t.runs || []).map(id => S.state.runs.find(r => r.id === id)).filter(Boolean);
    d.append(...[
      el('div', { class: 'tk-detail-h' }, S.mode === 'compact' ? el('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => { S.ticket = null; savePlace(); render(true); } }, svg(ICON.back, 14)) : null, el('span', { class: 'tk-key', text: ticketKey(t) }), el('span', { class: 'spacer' }),
        el('button', { class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete', onclick: async () => { await api.deleteTicket(S.project, t.id); u.tickets = u.tickets.filter(x => x.id !== t.id); S.ticket = null; render(true); } }, svg(ICON.trash, 14)),
        S.mode !== 'compact' ? el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => { S.ticket = null; savePlace(); render(true); } }, svg(ICON.x, 14)) : null),
      el('div', { class: 'tk-detail-c' }, statusSel, prioSel),
      title,
      el('div', { class: 'field' }, el('label', { text: 'Description' }), desc),
      el('div', { class: 'tk-detail-f' },
        el('button', { class: 'btn small', onclick: () => { const item = document.querySelector('.tk-item[data-id="' + t.id + '"]'); if (item && !item.classList.contains('open')) togglePrompt(t, item); item?.querySelector('textarea')?.focus(); if (S.mode === 'compact') { S.ticket = null; S.promptOpen.add(t.id); render(true); } } }, svg('M3 13l1-4 7-7 3 3-7 7-4 1z', 12), ...lbl(t.prompt ? 'Edit prompt' : 'Draft prompt', 'Prompt')),
        t.status !== 'done' ? el('button', { class: 'btn small', onclick: () => setTicket(t, { status: 'done' }) }, svg(ICON.check, 12), ...lbl('Mark done', 'Done')) : el('button', { class: 'btn small', onclick: () => setTicket(t, { status: 'todo' }) }, 'Reopen'),
        el('span', { class: 'spacer' }), meta),
      linked.length ? el('p', { class: 't-small' }, 'Worked on by ' + [...new Set(linked.map(r => AGENT[r.agent] || r.agent))].join(' and ') + ' · ' + linked.length + ' turn' + (linked.length === 1 ? '' : 's'), ' ', el('button', { class: 'btn small ghost', onclick: () => { setView('now'); } }, 'See in Now')) : null,
      t.fromItem ? el('p', { class: 't-small', text: 'From an agent item.' }) : null].filter(Boolean));
    queueMicrotask(() => { autoGrow(desc); });
    return d;
  }

  // ---------- Notes ----------
  function renderNotes(wrap) {
    const u = user(); if (!u) return;
    if (S.notesConflict) wrap.append(el('div', { class: 'banner warn' }, el('span', { class: 'txt' }, el('b', { text: 'These notes changed elsewhere.' }), ' Your text is kept until you choose.'),
      el('button', { class: 'btn small', onclick: () => { api.copy(S.notesConflict.mine); toast({ text: 'Your version is on the clipboard.', ttl: 4000 }); } }, 'Copy mine'),
      el('button', { class: 'btn small primary', onclick: async () => { S.notesConflict = null; await loadUser(S.project); render(true); } }, 'Load the saved version')));
    wrap.append(el('div', { class: 'section-h' }, el('span', { class: 't-eyebrow', text: 'Notes' }), el('span', { class: 't-small l', text: 'Saved as you type.' })));
    const ta = el('textarea', { class: 'notes', placeholder: 'Notes for this project…', 'aria-label': 'Project notes', spellcheck: 'true' });
    ta.value = u.notes.body;
    let revision = u.notes.revision;
    const meta = el('div', { class: 'notes-meta' }, el('span', { text: u.notes.updatedAt ? `Saved ${ago(u.notes.updatedAt)}` : 'Not written yet' }), el('span', { class: 'faint l', text: '· Only on this computer' }));
    const save = debounce(async () => {
      const body = ta.value;
      const r = await call(api.setNotes(S.project, body, revision));
      if (r.conflict) { S.notesConflict = { mine: body, theirs: r.body }; revision = r.revision; render(true); return; }
      revision = r.revision; u.notes = { body, revision, updatedAt: Date.now() }; meta.firstChild.textContent = 'Saved just now';
    }, 500);
    registerFlush('notes', () => save.flush());
    ta.addEventListener('input', () => { meta.firstChild.textContent = 'Saving…'; save(); });
    wrap.append(el('div', { class: 'notes-wrap' }, el('div', { class: 'spine' }, ta), meta));
  }

  // ---------- Break ----------
  const C_RING = 2 * Math.PI * 84;
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  function renderBreak(wrap) {
    const box = el('div', { class: 'break' });
    box.append(el('div', { class: 'section-h' }, el('span', { class: 't-eyebrow', text: 'Break' })));
    const ring = el('div', { class: 'ring' + (S.brk.timer ? '' : ' breathing'), id: 'brk-ring' });
    ring.innerHTML = `<svg viewBox="0 0 180 180"><circle class="track" cx="90" cy="90" r="84"/><circle class="prog" id="brk-prog" cx="90" cy="90" r="84" stroke-dasharray="${C_RING}" stroke-dashoffset="0"/></svg>`;
    ring.append(el('div', { class: 'time', id: 'brk-time' }));
    const row = el('div', { class: 'timer-row' }, el('button', { class: 'btn primary', id: 'brk-start', onclick: () => { if (S.brk.timer) stopBreak(); else startBreak(); } }, 'Start'));
    for (const m of [3, 5, 10]) row.append(el('button', { class: 'btn ghost small', onclick: () => { stopBreak(); S.brk.total = m * 60; S.brk.left = S.brk.total; paintBreak(); } }, `${m} min`));
    const br = S.settings.breakReminder;
    const timer = el('div', { class: 'break-timer' }, ring, row);
    const side = el('div', { class: 'break-side' },
      el('div', { class: 'card sunk stretch', id: 'brk-stretch' }),
      el('div', { class: 'card', style: 'padding-top:6px;padding-bottom:6px' },
        switchRow('Remind me to take breaks', 'One quiet nudge; never more than one at a time.', br.enabled, v => saveBreak({ enabled: v })),
        el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: 'Every' })), pick({ label: 'Interval', value: br.minutes, small: false, options: [15, 30, 45, 60, 90].map(m => [m, `${m} minutes`]), onPick: v => saveBreak({ minutes: Number(v) }) })),
        el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: 'When it is time' }), el('span', { text: 'Automatic entry waits until you have stopped typing.' })), seg([['suggest', 'Suggest'], ['auto', 'Start it']], br.mode, v => saveBreak({ mode: v })))));
    box.append(el('div', { class: 'break-grid' }, timer, side));
    wrap.append(box);
    queueMicrotask(paintBreak); // the view is attached to the document right after this returns
    if (!S.brk.timer) S.lastBreak = Date.now();
  }
  /** Paint the timer wherever it is shown: the Break page (if open) and the header chip. Safe to call any time. */
  function paintBreak() {
    const b = S.brk;
    const time = $('#brk-time'), prog = $('#brk-prog'), start = $('#brk-start'), ring = $('#brk-ring');
    if (time) time.textContent = fmt(b.timer ? b.left : b.total);
    if (prog) prog.style.strokeDashoffset = b.timer ? String(C_RING * (1 - b.left / b.total)) : '0';
    if (start) start.textContent = b.timer ? 'Stop' : 'Start';
    if (ring) ring.classList.toggle('breathing', !b.timer);
    const st = $('#brk-stretch');
    if (st) {
      const [name, text] = STRETCHES[b.stretch % STRETCHES.length];
      st.textContent = '';
      st.append(el('span', { class: 't-eyebrow', text: name }), el('p', { text }), el('div', { class: 'card-actions' }, el('button', { class: 'btn small ghost', onclick: () => { b.stretch++; b.lastStretchAt = Date.now(); paintBreak(); } }, 'Another one')));
    }
    for (const chip of document.querySelectorAll('.brk-chip')) chip.textContent = fmt(b.left);
  }
  function startBreak() {
    const b = S.brk;
    if (b.timer) return;
    b.left = b.left > 0 && b.left < b.total ? b.left : b.total;
    b.lastStretchAt = Date.now(); S.lastBreak = Date.now();
    if (S.reminderToast) { S.reminderToast.remove(); S.reminderToast = null; }
    b.timer = setInterval(() => {
      b.left--;
      if (Date.now() - b.lastStretchAt >= 30000) { b.stretch++; b.lastStretchAt = Date.now(); }
      if (b.left <= 0) { stopBreak(); toast({ text: 'Break’s over.', ttl: 8000 }); return; }
      paintBreak();
    }, 1000);
    renderHead(); renderCompactNav(); paintBreak();
  }
  function stopBreak() {
    const b = S.brk;
    if (b.timer) clearInterval(b.timer);
    b.timer = null; b.left = b.total; S.lastBreak = Date.now();
    renderHead(); renderCompactNav(); paintBreak();
  }
  function saveBreak(patch) { S.settings.breakReminder = { ...S.settings.breakReminder, ...patch }; api.setSettings({ breakReminder: patch }); }

  // ---------- popovers ----------
  function place(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    document.body.append(pop); S.popover = pop;
    const w = pop.offsetWidth || 300;
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)) + 'px'; pop.style.top = Math.min(rect.bottom + 8, window.innerHeight - pop.offsetHeight - 8) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', onDocDown), 0);
  }
  /** The status chip opens a small workspace card: folder, conversations, prefix. Runs live in the threads. */
  function runsPopover(anchor) {
    closePopover();
    const p = project(); const tasks = tasksOf(p.id); const active = activeRuns(p.id);
    const pop = el('div', { class: 'pop', role: 'dialog', 'aria-label': 'Workspace' });
    pop.append(el('div', { class: 'section-h', style: 'margin:0 0 6px' }, el('span', { class: 't-eyebrow', text: 'Workspace' }), el('span', { class: 'spacer' }), el('span', { class: 'chip', text: p.prefix })));
    pop.append(el('div', { class: 'run-row' }, el('div', { class: 'l1' }, el('b', { text: projectName(p) })), el('div', { class: 'l2', text: `${tasks.length} conversation${tasks.length === 1 ? '' : 's'}${active.length ? ` · ${active.length} working now` : ''}` })));
    if (p.path) pop.append(el('div', { class: 'run-row' }, el('div', { class: 'l2' }, el('code', { class: 'path', text: p.path })), el('div', { class: 'l2' }, el('button', { class: 'btn small ghost', onclick: () => api.openPath(p.path) }, 'Open folder'), el('button', { class: 'btn small ghost', onclick: () => { api.copy(p.path); toast({ text: 'Path copied.', ttl: 3000 }); } }, 'Copy path'))));
    const codexRun = runsOf(p.id).find(r => r.agent === 'codex');
    pop.append(el('div', { class: 'run-row' }, el('div', { class: 'l2' }, el('button', { class: 'btn small ghost', onclick: () => { closePopover(); openSettings({}); } }, 'Workspace settings'), codexRun ? el('button', { class: 'btn small ghost', onclick: () => { closePopover(); sendSheet(codexRun); } }, 'Send to Codex…') : null)));
    place(pop, anchor);
  }
  function onDocDown(e) { if (S.popover && !S.popover.contains(e.target)) closePopover(); }
  function closePopover() { if (S.popover) { S.popover.remove(); S.popover = null; document.removeEventListener('pointerdown', onDocDown); } }

  // ---------- sheets ----------
  function sheet(content) { closeOverlay(); const scrim = el('div', { class: 'scrim', onclick: e => { if (e.target === scrim) closeOverlay(); } }, el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, ...content)); $('#overlay').append(scrim); return scrim; }
  function closeOverlay() { $('#overlay').textContent = ''; }

  /** Return to the agent: bring its window forward if we know it; otherwise explain how. */
  async function returnTo(r) {
    const t = S.state.tasks.find(x => x.id === r.task);
    if (t?.host?.hwnd) {
      try {
        const res = await call(api.returnFocus(t.id));
        if (res.ok) { if (r.id) ack(r.id); return; }
        if (res.reason === 'gone') toast({ text: `That ${t.host.name} window is closed.`, ttl: 5000 });
      } catch { /* fall through to the sheet */ }
    }
    returnSheet(r);
  }
  function returnSheet(r) {
    const t = S.state.tasks.find(x => x.id === r.task); const who = AGENT[r.agent] || r.agent; const p = project();
    const host = t?.host || null;
    const responses = Object.entries(user()?.responses || {}).filter(([k]) => k.startsWith((r.id || '§') + ':')).map(([, v]) => v.body).filter(Boolean);
    const source = r.source || t?.source || `Return to the ${who} window where this work started.`;
    const resume = source.match(/(claude --resume \S+|codex resume \S+)/)?.[1];
    sheet([
      el('h2', { text: `Back to ${who}` }),
      host ? el('p', { class: 't-body' }, 'This session lives in ', el('b', { text: host.title || host.name }), ' (', host.name, '). ', el('button', { class: 'btn small', onclick: async () => { const res = await call(api.returnFocus(t.id)); if (res.ok) closeOverlay(); else toast({ text: res.reason === 'gone' ? 'That window is closed.' : 'Windows would not hand it focus. Alt+Tab to it.', ttl: 5000 }); } }, 'Bring it forward'))
        : el('p', { class: 't-body' }, 'Layover did not see which window this session started in. Switch to the ', el('b', { text: who }), ' session below with ', el('kbd', { text: 'Alt' }), ' + ', el('kbd', { text: 'Tab' }), ', or resume it from a terminal in the project folder.'),
      el('pre', { class: 'src', text: source }),
      el('div', { class: 'card-actions', style: 'margin-top:0' },
        resume ? el('button', { class: 'btn', onclick: () => { api.copy(resume); toast({ text: 'Resume command copied.', ttl: 3500 }); } }, svg(ICON.copy, 12), 'Copy resume command') : null,
        responses.length ? el('button', { class: 'btn primary', onclick: () => { api.copy(responses.join('\n\n')); toast({ text: 'Your replies are on the clipboard.', ttl: 3500 }); } }, svg(ICON.copy, 12), `Copy my repl${responses.length === 1 ? 'y' : 'ies'}`) : null,
        p?.path ? el('button', { class: 'btn ghost', onclick: () => api.openPath(p.path) }, 'Open folder') : null),
      el('div', { class: 'card-actions', style: 'justify-content:flex-end' }, el('button', { class: 'btn ghost', onclick: closeOverlay }, 'Close'), r.id ? el('button', { class: 'btn primary', onclick: () => { ack(r.id); closeOverlay(); render(true); } }, 'Got it') : null),
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
      try { const m = await call(api.bridgeSend({ id: crypto.randomUUID(), run: r.id, thread: target.thread, text: ta.value, expectedTurnId: target.activeTurnId })); status.textContent = `${m.status}: ${m.detail}`; if (['accepted', 'queued', 'acknowledged'].includes(m.status)) toast({ text: `Codex ${m.status}. Acknowledgment ≠ completion.`, ttl: 6000 }); }
      catch (e) { status.textContent = e.message; send.disabled = false; }
    });
  }

  async function addWorkspace() {
    const name = el('input', { class: 'input', placeholder: 'Name' }); const folder = el('input', { class: 'input', placeholder: 'Folder (optional, lets agents find it)' });
    sheet([el('h2', { text: 'New workspace' }), el('p', { class: 't-body', text: 'Workspaces are created automatically when an agent starts in a folder. Add one by hand to keep notes and tickets before that happens.' }),
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

  async function openSettings({ onboarding, tab } = {}) {
    const st = await call(api.setupStatus());
    const s = S.settings;
    const agentRow = (id, label, info) => {
      const row = el('div', { class: 'agent-row' });
      const draw = () => {
        row.textContent = '';
        const connected = info.connected; const stale = connected && !(info.skillCurrent && info.hooksCurrent);
        row.append(...[
          agentIcon(id, 26), el('span', { class: 'dot ' + (connected ? 'done' : 'quiet'), style: connected ? '' : 'background:var(--border-strong)', title: connected ? 'Connected' : 'Not connected' }),
          el('div', { class: 'l' }, el('b', { text: label }), el('span', { text: connected ? (stale ? 'Connected · update available' : 'Connected: skill and lifecycle hooks installed') : 'Not connected. One click installs the skill and hooks in your user settings.' }),
            id === 'codex' && connected ? el('span', { text: 'Codex asks you to trust hooks once: type /hooks in Codex and approve the Layover entries.' }) : null, info.hooksError ? el('span', { style: 'color:var(--danger)', text: 'Hooks file could not be read: ' + info.hooksError }) : null),
          connected ? el('button', { class: 'btn small ghost', onclick: async () => { await call(api.setupRemove(id)); info = (await call(api.setupStatus()))[id]; draw(); } }, 'Disconnect') : null,
          el('button', { class: 'btn small' + (connected && !stale ? '' : ' primary'), onclick: async () => { try { const r = await call(api.setupInstall(id, {})); info = (await call(api.setupStatus()))[id]; draw(); toast({ text: label + ' connected.' + (r.notes?.length ? ' ' + r.notes[0] : ''), ttl: 8000 }); } catch (e) { toast({ text: e.message, ttl: 8000, cls: 'gold' }); } } }, connected ? (stale ? 'Update' : 'Reinstall') : 'Connect')].filter(Boolean));
      };
      draw(); return row;
    };
    const p = project();
    const panes = {
      agents: () => [el('div', { class: 'sheet-sec' }, agentRow('claude', 'Claude Code', st.claude), agentRow('codex', 'Codex', st.codex),
        el('p', { class: 't-small' }, 'Command agents use: ', el('code', { class: 'path', text: st.cli }), ' ', el('button', { class: 'btn small ghost', onclick: () => api.copy(st.cli) }, 'Copy'), st.cliExists ? null : el('span', { style: 'color:var(--danger)', text: ' (missing)' })))],
      workspace: () => [p ? el('div', { class: 'sheet-sec' },
        el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: 'Name' }), el('span', { text: 'Shown in the sidebar; the folder name otherwise.' })), el('input', { class: 'input', style: 'width:220px', value: p.displayName, placeholder: p.name, onchange: e => api.setProjectMeta(p.id, { name: e.target.value }) })),
        el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: 'Colour' })), el('div', { class: 'row' }, ...['clay', 'gold', 'moss', 'teal', 'slate', 'plum'].map(c => el('button', { class: 'ws-tok', style: 'background:var(--ws-' + c + ');width:26px;height:26px;border:' + (c === p.color ? '2px solid var(--text)' : 'none') + ';cursor:pointer', title: c, onclick: () => api.setProjectMeta(p.id, { color: c }) })))),
        el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: 'Key prefix' }), el('span', { text: 'Next entries are numbered like ' + p.prefix + '-1. Up to 4 capital letters or digits.' })), el('input', { class: 'input', style: 'width:90px', maxlength: '4', value: p.prefix, onchange: async e => { try { await call(api.setProjectMeta(p.id, { prefix: e.target.value.toUpperCase() })); } catch (err) { toast({ text: err.message, ttl: 5000 }); } } })),
        el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: 'Folder' }), el('span', {}, el('code', { class: 'path', text: p.path || 'No folder yet' }))), p.path ? el('button', { class: 'btn small ghost', onclick: () => api.openPath(p.path) }, 'Open') : null),
        el('div', { class: 'switch' }, el('div', { class: 'l' }, el('b', { text: 'Hide this workspace' }), el('span', { text: 'Keeps its notes and history; it comes back when an agent works here again.' })), el('button', { class: 'btn small ghost danger', onclick: async () => { await api.setProjectMeta(p.id, { hidden: true }); closeOverlay(); S.state = await call(api.getState()); S.project = null; onState(); } }, 'Hide'))) : el('p', { class: 't-small', text: 'No workspace selected.' })],
      preferences: () => [
        el('div', { class: 'sheet-sec' }, el('h3', { text: 'When an agent starts a turn' }),
          seg([['focus', 'Bring forward'], ['open', 'Behind my work'], ['reveal', 'Only if open'], ['never', 'Stay quiet']], s.openOnRunStart, v => { s.openOnRunStart = v; api.setSettings({ openOnRunStart: v }); }),
          el('p', { class: 't-small', text: 'Only the start of a turn can bring Layover forward; items and completions never move the window.' }),
          switchRow('Windows notification when a turn finishes', 'Silent toast; only when Layover is not in front.', s.notifyOnComplete, v => api.setSettings({ notifyOnComplete: v })),
          switchRow('Keep running in the tray when the window is closed', 'Needed so agents can reach it.', s.closeToTray, v => api.setSettings({ closeToTray: v })),
          switchRow('Tell the agent its run id', 'One short line per prompt so it can publish items without guessing.', s.hookContext, v => api.setSettings({ hookContext: v }))),
        el('div', { class: 'sheet-sec' }, el('h3', { text: 'Appearance' }), el('div', { class: 'appearance' },
          (() => {
            const icons = { light: 'M8 4.9a3.1 3.1 0 1 0 0 6.2a3.1 3.1 0 0 0 0-6.2ZM8 1.1v1.7M8 13.2v1.7M1.1 8h1.7M13.2 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2', system: 'M2.4 3.4h11.2a.8.8 0 0 1 .8.8v7.2a.8.8 0 0 1-.8.8H2.4a.8.8 0 0 1-.8-.8V4.2a.8.8 0 0 1 .8-.8ZM5.6 14h4.8', dark: 'M13.4 9.9A5.8 5.8 0 0 1 6.1 2.6a5.8 5.8 0 1 0 7.3 7.3Z' };
            const g = el('div', { class: 'seg theme-seg', role: 'radiogroup', 'aria-label': 'Theme' });
            for (const [id, label] of [['light', 'Light'], ['system', 'Match system'], ['dark', 'Dark']]) g.append(el('button', { role: 'radio', 'aria-checked': s.theme === id ? 'true' : 'false', title: label, 'aria-label': label, onclick: () => { g.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', 'false')); g.querySelector('[title="' + label + '"]').setAttribute('aria-checked', 'true'); s.theme = id; api.setSettings({ theme: id }); } }, svg(icons[id], 16)));
            return g;
          })(),
          (() => { const g = el('div', { class: 'seg accent-seg', role: 'radiogroup', 'aria-label': 'Accent' }); for (const [id, label, sw] of ACCENTS) g.append(el('button', { role: 'radio', 'aria-checked': (s.accent || 'teal') === id ? 'true' : 'false', title: label, 'aria-label': label + ' accent', onclick: () => { g.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', 'false')); g.querySelector('[title="' + label + '"]').setAttribute('aria-checked', 'true'); s.accent = id; applyAccent(id); api.setSettings({ accent: id }); } }, el('span', { class: 'acc-dot', style: 'background:' + sw }))); return g; })())),
        el('div', { class: 'sheet-sec' }, el('p', { class: 't-small' }, 'Layover ' + s.version + ' · data in ', el('code', { class: 'path', text: s.dataDir }), ' ', el('button', { class: 'btn small ghost', onclick: () => api.openPath(s.dataDir) }, 'Open'), ' · local service on 127.0.0.1:' + s.port + '. Layover makes no model calls.'),
          el('p', { class: 't-small' }, 'Press ', el('kbd', { text: '?' }), ' anywhere for keyboard shortcuts.'))],
    };
    if (onboarding) {
      sheet([el('h2', { text: 'Welcome to Layover' }),
        el('p', { class: 't-body', text: 'Threads of what each agent decides and asks, a place for what comes next, notes, and a break. Connect your agents so they can open Layover for you.' }),
        ...panes.agents(),
        el('div', { class: 'card-actions', style: 'justify-content:flex-end' }, el('button', { class: 'btn primary', onclick: async () => { S.settings.onboarded = true; await api.setSettings({ onboarded: true }); closeOverlay(); } }, 'Done'))]);
      return;
    }
    let current = tab || S.settingsTab || 'workspace';
    const body = el('div', { class: 'sheet-body' });
    const tabs = seg([['workspace', 'Workspace'], ['agents', 'Agents'], ['preferences', 'Preferences']], current, v => { current = v; S.settingsTab = v; body.textContent = ''; body.append(...panes[v]()); });
    body.append(...panes[current]());
    sheet([el('div', { class: 'sheet-h' }, el('h2', { text: 'Settings' }), el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeOverlay }, svg(ICON.x, 14))), tabs, body]);
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
