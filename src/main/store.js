// Append-only event log + atomic user document. Plain Node, no native modules.
// Agent events are content, never commands. Every write is durable before it is acknowledged.
import fs from 'node:fs';
import path from 'node:path';
import { isId } from './paths.js';

export const AGENTS = new Set(['codex', 'claude', 'test']);
export const EVENT_TYPES = new Set(['session', 'start', 'heartbeat', 'item', 'end']);
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);
export const KINDS = new Set(['suggestion', 'decision', 'question', 'opportunity']);
export const ITEM_STATUS = new Set(['open', 'resolved', 'dismissed']);
export const LIFECYCLES = new Set(['voluntary', 'hooks', 'wrapper']);
export const COLORS = ['clay', 'gold', 'moss', 'teal', 'slate', 'plum'];

const VOLUNTARY_STALE_MS = 120_000;      // no heartbeat/item for 2 min -> status unknown
const HOOKS_STALE_MS = 6 * 3_600_000;    // a hook-driven run with no end for 6 h -> status unknown
const MAX_TEXT = 12_000;
const MAX_META = 1_000;

function text(v, max, name, optional = true) {
  if (v === undefined || v === null) { if (optional) return undefined; throw Error(`${name} is required`); }
  if (typeof v !== 'string' || v.length > max) throw Error(`Invalid ${name}`);
  return v;
}

function atomicWrite(file, body) {
  const tmp = file + '.tmp-' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function emptyUserProject() {
  return { color: '', name: '', hidden: false, prefix: '', notes: { body: '', revision: 0 }, tickets: [], ticketSeq: 0, responses: {}, dismissed: {}, place: {} };
}

export const TICKET_STATUS = ['backlog', 'todo', 'progress', 'done', 'cancelled'];
export const TICKET_PRIORITY = [0, 1, 2, 3, 4]; // none, low, medium, high, urgent

/** Ticket key prefix from a workspace name: "agent-companion-phase1" -> ACP, "layover" -> LAY. */
export function ticketPrefix(name) {
  const words = String(name || 'WS').split(/[^a-z0-9]+/i).filter(Boolean);
  const s = words.length >= 2 ? words.map(w => w[0]).join('').slice(0, 3) : words[0]?.slice(0, 3) || 'WS';
  return s.toUpperCase();
}

/** One-time migration of the phase-two "Next" entries into tickets. */
function migrateUserProject(u) {
  if (Array.isArray(u.tickets)) return u;
  const now = Date.now();
  u.tickets = (u.next || []).map((n, i) => ({
    id: n.id || 't_' + now.toString(36) + i, number: i + 1, title: n.title || '', description: n.kind === 'prompt' ? '' : n.body || '',
    prompt: n.kind === 'prompt' ? n.body || '' : '', status: n.status === 'done' ? 'done' : n.status === 'archived' ? 'cancelled' : 'backlog',
    priority: 0, fromItem: n.fromItem || null, createdAt: n.createdAt || now, updatedAt: n.updatedAt || now, completedAt: n.status === 'done' ? n.updatedAt || now : 0,
  }));
  u.ticketSeq = u.tickets.length;
  delete u.next;
  u.prefix ??= '';
  return u;
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.userFile = path.join(dir, 'user.json');
    this.ids = new Map();      // event id -> serialized body
    this.projects = new Map();
    this.tasks = new Map();
    this.runs = new Map();
    this.items = new Map();    // run:item -> item
    this.listeners = new Set();
    this.userDoc = { version: 1, projects: {}, manualProjects: {} };
    this.load();
  }

  // ---------- persistence ----------
  load() {
    if (fs.existsSync(this.userFile)) {
      try { this.userDoc = JSON.parse(fs.readFileSync(this.userFile, 'utf8')); } catch { /* keep default */ }
      if (!this.userDoc || typeof this.userDoc !== 'object' || !this.userDoc.projects) this.userDoc = { version: 1, projects: {}, manualProjects: {} };
      this.userDoc.manualProjects ??= {};
    }
    for (const [id, m] of Object.entries(this.userDoc.manualProjects)) {
      if (!this.projects.has(id)) this.projects.set(id, { id, name: m.name, path: m.path || '', createdAt: m.createdAt, lastActive: m.createdAt });
    }
    if (fs.existsSync(this.eventsFile)) {
      const lines = fs.readFileSync(this.eventsFile, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; } // a torn final line is ignored, never fatal
        if (!rec || !rec.e || !rec.t) continue;
        this.ids.set(rec.e.id, JSON.stringify(rec.e));
        this.apply(rec.e, rec.t);
      }
    }
    this.fd = fs.openSync(this.eventsFile, 'a');
  }

  append(e, received) {
    const line = JSON.stringify({ t: received, e }) + '\n';
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
  }

  saveUser() { atomicWrite(this.userFile, JSON.stringify(this.userDoc, null, 1)); }

  close() { try { fs.closeSync(this.fd); } catch { /* already closed */ } }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(change) { for (const fn of this.listeners) { try { fn(change); } catch { /* listener errors never break writes */ } } }

  // ---------- events ----------
  validate(e) {
    if (!e || typeof e !== 'object') throw Error('Event must be an object');
    if (!EVENT_TYPES.has(e.type)) throw Error('Invalid event type');
    if (!AGENTS.has(e.agent)) throw Error('Invalid agent');
    for (const k of ['id', 'project', 'task']) if (!isId(e[k])) throw Error(`Invalid ${k}`);
    if (e.type !== 'session' && !isId(e.run)) throw Error('Invalid run');
    if (e.type !== 'session' && (!Number.isSafeInteger(e.seq) || e.seq < 0)) throw Error('seq must be a nonnegative integer');
    for (const k of ['title', 'projectName', 'projectPath', 'source', 'name', 'sessionId', 'note']) text(e[k], MAX_META, k);
    if (e.type === 'start' && e.lifecycle !== undefined && !LIFECYCLES.has(e.lifecycle)) throw Error('Invalid lifecycle');
    if (e.type === 'end' && !TERMINAL.has(e.status)) throw Error('Invalid terminal status');
    if (e.type === 'item') {
      if (!isId(e.item)) throw Error('Invalid item id');
      if (!Number.isSafeInteger(e.revision) || e.revision < 1) throw Error('revision must be a positive integer');
      text(e.text, MAX_TEXT, 'text', false);
      text(e.title, 200, 'title');
      if (!KINDS.has(e.kind)) throw Error('Invalid item kind');
      if (!ITEM_STATUS.has(e.status)) throw Error('Invalid item status');
      if (e.waiting !== undefined && typeof e.waiting !== 'boolean') throw Error('waiting must be boolean');
      if (e.origin !== undefined && !['agent', 'notification'].includes(e.origin)) throw Error('Invalid origin');
    }
  }

  /** Validate, dedupe, apply, persist. Returns {accepted:true,...} or {duplicate:true}. Throws on rejection. */
  event(e, received = Date.now()) {
    this.validate(e);
    const body = JSON.stringify(e);
    const previous = this.ids.get(e.id);
    if (previous !== undefined) {
      if (previous !== body) throw Error('Event ID conflict: this id was already used with different content');
      return { duplicate: true };
    }
    const task = this.tasks.get(e.task);
    if (task && (task.project !== e.project || task.agent !== e.agent)) throw Error('Task identity cannot change');
    if (e.run) {
      const run = this.runs.get(e.run);
      if (run && (run.project !== e.project || run.task !== e.task || run.agent !== e.agent)) throw Error('Run identity cannot change');
      if (e.type === 'end' && run && run.seq === e.seq && run.status !== 'active' && run.status !== e.status) throw Error('Terminal sequence conflict');
      if (e.type === 'item') {
        const old = this.items.get(e.run + ':' + e.item);
        if (old && old.revision === e.revision && (old.text !== e.text || old.status !== e.status || old.kind !== e.kind)) throw Error('Item revision conflict');
      }
    }
    this.ids.set(e.id, body);
    const change = this.apply(e, received);
    this.append(e, received);
    this.emit({ type: e.type, event: e, ...change });
    return { accepted: true, ...change };
  }

  ensureProject(e, received) {
    let p = this.projects.get(e.project);
    if (!p) {
      p = { id: e.project, name: e.projectName || e.project, path: e.projectPath || '', createdAt: received, lastActive: received };
      this.projects.set(p.id, p);
      const u = this.userProject(e.project);
      if (!u.color) { u.color = COLORS[(this.projects.size - 1) % COLORS.length]; this.saveUser(); }
    } else {
      if (e.projectName && p.name === p.id) p.name = e.projectName;
      if (e.projectPath && !p.path) p.path = e.projectPath;
    }
    p.lastActive = Math.max(p.lastActive, received);
    return p;
  }

  ensureTask(e, received) {
    let t = this.tasks.get(e.task);
    if (!t) {
      t = { id: e.task, project: e.project, agent: e.agent, name: e.name || e.title || e.task, source: e.source || '', sessionId: e.sessionId || '', createdAt: received, lastSeen: received };
      this.tasks.set(t.id, t);
    } else {
      if (e.type === 'session') { if (e.name) t.name = e.name; if (e.source) t.source = e.source; if (e.sessionId) t.sessionId = e.sessionId; }
      else if (e.type === 'start' && t.name === t.id && e.title) t.name = e.title;
      if (e.source && !t.source) t.source = e.source;
    }
    t.lastSeen = Math.max(t.lastSeen, received);
    return t;
  }

  apply(e, received) {
    this.ensureProject(e, received);
    this.ensureTask(e, received);
    const change = { project: e.project };
    if (e.type === 'session') return change;
    let r = this.runs.get(e.run);
    if (!r) {
      r = { id: e.run, project: e.project, task: e.task, agent: e.agent, status: 'active', seq: -1, title: e.title || '', lifecycle: e.lifecycle || 'voluntary', source: e.source || '', startedAt: received, endedAt: 0, lastSeen: received, endNote: '' };
      this.runs.set(r.id, r);
      change.newRun = true;
    }
    r.lastSeen = Math.max(r.lastSeen, received);
    if (e.type === 'start') {
      if (e.title) r.title = e.title;
      if (e.source) r.source = e.source;
      if (e.lifecycle) r.lifecycle = e.lifecycle;
      change.started = r.id;
      // A new hook-driven turn on the same conversation means the previous turn ended without a signal.
      if (r.lifecycle === 'hooks') for (const other of this.runs.values()) {
        if (other.id !== r.id && other.task === r.task && other.status === 'active' && other.lifecycle === 'hooks') {
          other.status = 'cancelled'; other.endedAt = received; other.endNote = 'No completion signal before the next turn began.';
        }
      }
    }
    if (e.type === 'end' && e.seq > r.seq) {
      const wasActive = r.status === 'active';
      r.status = e.status; r.seq = e.seq; r.endedAt = received; r.endNote = e.note || '';
      if (wasActive) change.ended = { run: r.id, status: e.status };
    }
    if (e.type === 'item') {
      const key = e.run + ':' + e.item;
      const old = this.items.get(key);
      if (!old || e.revision > old.revision) {
        this.items.set(key, { key, run: e.run, task: e.task, project: e.project, agent: e.agent, item: e.item, kind: e.kind, status: e.status, revision: e.revision, text: e.text, title: e.title || '', waiting: !!e.waiting, origin: e.origin || 'agent', createdAt: old ? old.createdAt : received, updatedAt: received });
        change.item = key; change.newItem = !old;
      }
    }
    return change;
  }

  runStatus(r, now) {
    if (r.status !== 'active') return r.status;
    if (r.lifecycle === 'hooks') return now - r.lastSeen > HOOKS_STALE_MS ? 'disconnected' : 'active';
    return now - r.lastSeen > VOLUNTARY_STALE_MS ? 'disconnected' : 'active';
  }

  /** Snapshot for the UI and CLI. Statuses are computed against `now`. */
  state(now = Date.now()) {
    const runs = [...this.runs.values()].map(r => ({ ...r, status: this.runStatus(r, now) }));
    const runById = new Map(runs.map(r => [r.id, r]));
    const items = [...this.items.values()].map(i => {
      const run = runById.get(i.run);
      let status = i.status;
      // A "waiting for you" notification is moot once the turn that raised it has ended.
      if (i.origin === 'notification' && status === 'open' && run && run.status !== 'active') status = 'resolved';
      return { ...i, status, runStatus: run ? run.status : 'unknown' };
    });
    return {
      now,
      projects: [...this.projects.values()].map(p => ({ ...p, ...this.projectMeta(p.id) })),
      tasks: [...this.tasks.values()],
      runs,
      items,
    };
  }

  // ---------- user content (never sent anywhere by itself) ----------
  userProject(id) {
    if (!isId(id)) throw Error('Invalid project');
    return migrateUserProject(this.userDoc.projects[id] ??= emptyUserProject());
  }
  projectMeta(id) {
    const u = this.userDoc.projects[id] || {};
    const p = this.projects.get(id);
    return { color: u.color || 'teal', displayName: u.name || '', hidden: !!u.hidden, prefix: u.prefix || ticketPrefix(u.name || p?.name || id) };
  }
  user(id) { return structuredClone(this.userProject(id)); }

  /** Create a workspace by hand (no agent yet). */
  createProject({ id, name, path: projectPath }) {
    if (!isId(id)) throw Error('Invalid project id');
    if (this.projects.has(id)) return this.projects.get(id);
    const now = Date.now();
    const p = { id, name: text(name, MAX_META, 'name', false), path: projectPath || '', createdAt: now, lastActive: now };
    this.projects.set(id, p);
    const u = this.userProject(id);
    if (!u.color) u.color = COLORS[(this.projects.size - 1) % COLORS.length];
    this.userDoc.manualProjects ??= {};
    this.userDoc.manualProjects[id] = { name: p.name, path: p.path, createdAt: now };
    this.saveUser();
    this.emit({ type: 'project', project: id });
    return p;
  }

  setProjectMeta(id, { color, name, hidden, prefix }) {
    const u = this.userProject(id);
    if (color !== undefined) { if (!COLORS.includes(color)) throw Error('Invalid color'); u.color = color; }
    if (name !== undefined) u.name = text(name, 120, 'name');
    if (hidden !== undefined) u.hidden = !!hidden;
    if (prefix !== undefined) { if (typeof prefix !== 'string' || !/^[A-Z0-9]{0,4}$/.test(prefix)) throw Error('Prefix: up to 4 capital letters or digits'); u.prefix = prefix; }
    this.saveUser(); this.emit({ type: 'project', project: id });
    return this.projectMeta(id);
  }

  /** Optimistic notes save: the caller sends the revision it edited. Stale -> conflict, nothing overwritten. */
  setNotes(id, body, revision) {
    if (typeof body !== 'string' || body.length > 200_000) throw Error('Invalid notes');
    const u = this.userProject(id);
    if (revision !== u.notes.revision) return { conflict: true, revision: u.notes.revision, body: u.notes.body };
    u.notes = { body, revision: revision + 1, updatedAt: Date.now() };
    this.saveUser();
    return { revision: u.notes.revision };
  }

  /** Create or update a ticket. New tickets get the next number in this workspace. */
  upsertTicket(id, t) {
    const u = this.userProject(id);
    if (!t || typeof t !== 'object') throw Error('Invalid ticket');
    const now = Date.now();
    let e = t.id ? u.tickets.find(x => x.id === t.id) : null;
    if (!e) {
      e = { id: t.id && isId(t.id) ? t.id : 't_' + now.toString(36) + Math.random().toString(36).slice(2, 7), number: ++u.ticketSeq, title: '', description: '', prompt: '', status: 'todo', priority: 0, fromItem: t.fromItem || null, createdAt: now, updatedAt: now, completedAt: 0 };
      u.tickets.unshift(e);
    }
    if (t.title !== undefined) e.title = text(t.title, 300, 'title');
    if (t.description !== undefined) e.description = text(t.description, MAX_TEXT * 4, 'description');
    if (t.prompt !== undefined) e.prompt = text(t.prompt, MAX_TEXT * 4, 'prompt');
    if (t.status !== undefined) {
      if (!TICKET_STATUS.includes(t.status)) throw Error('Invalid status');
      if (t.status !== e.status) e.completedAt = t.status === 'done' || t.status === 'cancelled' ? now : 0;
      e.status = t.status;
    }
    if (t.priority !== undefined) { if (!TICKET_PRIORITY.includes(Number(t.priority))) throw Error('Invalid priority'); e.priority = Number(t.priority); }
    if (t.runs !== undefined) { if (!Array.isArray(t.runs)) throw Error('runs must be an array'); e.runs = [...new Set(t.runs.filter(isId))].slice(0, 50); }
    e.updatedAt = now;
    this.saveUser();
    return structuredClone(e);
  }
  deleteTicket(id, ticketId) {
    const u = this.userProject(id);
    u.tickets = u.tickets.filter(x => x.id !== ticketId);
    this.saveUser();
  }

  /** A local response to an agent item. Saved for the user; never delivered by itself. */
  respond(id, key, body) {
    const u = this.userProject(id);
    if (typeof key !== 'string' || key.length > 400) throw Error('Invalid key');
    if (typeof body !== 'string' || body.length > MAX_TEXT * 2) throw Error('Invalid response');
    if (body === '') delete u.responses[key]; else u.responses[key] = { body, updatedAt: Date.now() };
    this.saveUser();
    return u.responses[key] || null;
  }
  dismiss(id, key, dismissed = true) {
    const u = this.userProject(id);
    if (dismissed) u.dismissed[key] = Date.now(); else delete u.dismissed[key];
    this.saveUser();
  }
  setPlace(id, place) {
    const u = this.userProject(id);
    u.place = { ...u.place, ...place };
    this.saveUser();
  }
}
