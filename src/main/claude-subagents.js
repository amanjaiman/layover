// Claude occasionally omits lifecycle hooks for an Agent running in an isolated worktree.
// Its local transcript and metadata still identify the child, so reconcile those while
// the parent conversation is active. Read only a bounded tail; no transcript text is kept.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './paths.js';

const TAIL_BYTES = 128 * 1024;
const RECENT_MS = 5 * 60_000;
const STALE_MS = 6 * 3_600_000;
const MISS_MS = 30_000;
const transcripts = new Map(); // root + session -> { file, at }

function transcriptFor(session, root, now) {
  if (!/^[\w-]{1,100}$/.test(session || '')) return '';
  const key = `${root}\0${session}`;
  const cached = transcripts.get(key);
  if (cached?.file && fs.existsSync(cached.file)) return cached.file;
  if (cached && !cached.file && now - cached.at < MISS_MS) return '';
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { dirs = []; }
  let found = '';
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, `${session}.jsonl`);
    if (fs.existsSync(file)) { found = file; break; }
  }
  transcripts.set(key, { file: found, at: now });
  return found;
}

// 'done' when the last turn finished, 'tool' while a tool call is outstanding, 'waiting' after a user line, '' if unknown.
function transcriptState(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return ''; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start) lines.shift();
    let last = '';
    for (const line of lines) {
      if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant') {
          const reason = entry.message?.stop_reason;
          last = reason === 'tool_use' ? 'tool' : reason ? 'done' : 'waiting';
        } else if (entry.type === 'user') last = 'waiting';
      } catch { /* a line may still be in flight */ }
    }
    return last;
  } finally { fs.closeSync(fd); }
}

/** Children with recent transcript activity, plus idle ones `track(id)` still considers active. */
export function scanClaudeSubagents(transcript, now = Date.now(), track = () => false) {
  const dir = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
  let files;
  try { files = fs.readdirSync(dir).filter(f => /^agent-[\w-]+\.meta\.json$/.test(f)).slice(0, 200); }
  catch { return []; }
  const children = [];
  for (const name of files) {
    const id = name.slice(6, -10);
    const file = path.join(dir, `agent-${id}.jsonl`);
    try {
      const stat = fs.statSync(file);
      const idle = now - stat.mtimeMs > RECENT_MS;
      if (idle && !track(id)) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!meta.toolUseId || typeof meta.agentType !== 'string') continue; // internal agents are not Agent tool children
      const state = transcriptState(file);
      const finished = state === 'done' || idle && state === 'waiting';
      const updatedAt = Math.floor(stat.mtimeMs);
      const startedAt = stat.birthtimeMs > 0 ? Math.floor(stat.birthtimeMs) : updatedAt;
      children.push({ id, type: meta.agentType || 'Subagent', status: finished ? 'completed' : 'active', startedAt: startedAt > 0 ? startedAt : undefined, updatedAt });
    } catch { /* a child may be creating its files right now */ }
  }
  return children;
}

export function reconcileClaudeSubagents(store, now = Date.now(), root = path.join(homeDir(), '.claude', 'projects')) {
  const activeTasks = new Set();
  for (const c of store.subagents.values()) if (c.status === 'active' && now - c.lastSeen < STALE_MS) activeTasks.add(c.task);
  for (const task of store.tasks.values()) {
    if (task.agent !== 'claude' || !task.sessionId) continue;
    const hasActiveChild = activeTasks.has(task.id);
    if (now - task.lastSeen > 3_600_000 && !hasActiveChild) continue;
    const transcript = transcriptFor(task.sessionId, root, now);
    if (!transcript) continue;
    const track = id => { const c = hasActiveChild && store.subagents.get(`${task.id}:${id}`); return c?.status === 'active' && !c.hooked; };
    for (const child of scanClaudeSubagents(transcript, now, track)) {
      const old = store.subagents.get(`${task.id}:${child.id}`);
      if (old && (old.status !== 'active' || old.status === child.status && now - old.lastSeen < 3_600_000)) continue;
      if (old && child.updatedAt < old.seq) continue;
      if (!old && child.status === 'active' && child.updatedAt <= (task.childrenCancelledAt || 0)) continue;
      const project = store.projects.get(task.project);
      try { store.event({ id: `subagent:transcript:${task.id}:${child.id}:${child.status}:${now}`, type: 'session', project: task.project, task: task.id, agent: 'claude', projectName: project?.name, projectPath: project?.path,
        seq: Math.max(child.updatedAt, (old?.seq || 0) + 1), subagentId: child.id, subagentType: child.type, subagentStatus: child.status, subagentStartedAt: child.startedAt }, now); }
      catch { /* reconciliation is best effort; normal hooks continue to work */ }
    }
  }
}
