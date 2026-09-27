// Claude occasionally omits lifecycle hooks for an Agent running in an isolated worktree.
// Its local transcript and metadata still identify the child, so reconcile those while
// the parent conversation is active. Read only a bounded tail; no transcript text is kept.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './paths.js';

const TAIL_BYTES = 128 * 1024;
const RECENT_MS = 5 * 60_000;

function transcriptFor(session, root) {
  if (!/^[\w-]{1,100}$/.test(session || '')) return '';
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return ''; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, `${session}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return '';
}

function transcriptFinished(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return false; }
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
        if (entry.type === 'assistant') last = entry.message?.stop_reason === 'end_turn' ? 'done' : 'working';
        else if (entry.type === 'user') last = 'working';
      } catch { /* a line may still be in flight */ }
    }
    return last === 'done';
  } finally { fs.closeSync(fd); }
}

export function scanClaudeSubagents(transcript, now = Date.now()) {
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
      if (now - stat.mtimeMs > RECENT_MS) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!meta.toolUseId || typeof meta.agentType !== 'string') continue; // internal agents are not Agent tool children
      children.push({ id, type: meta.agentType || 'Subagent', status: transcriptFinished(file) ? 'completed' : 'active', startedAt: Math.floor(stat.birthtimeMs), updatedAt: Math.floor(stat.mtimeMs) });
    } catch { /* a child may be creating its files right now */ }
  }
  return children;
}

export function reconcileClaudeSubagents(store, now = Date.now(), root = path.join(homeDir(), '.claude', 'projects')) {
  for (const task of store.tasks.values()) {
    if (task.agent !== 'claude' || !task.sessionId) continue;
    const hasActiveChild = [...store.subagents.values()].some(c => c.task === task.id && c.status === 'active');
    if (now - task.lastSeen > 3_600_000 && !hasActiveChild) continue;
    const transcript = transcriptFor(task.sessionId, root);
    if (!transcript) continue;
    for (const child of scanClaudeSubagents(transcript, now)) {
      const old = store.subagents.get(`${task.id}:${child.id}`);
      if (old && (old.status !== 'active' || old.status === child.status && now - old.lastSeen < 3_600_000)) continue;
      if (old && child.updatedAt < old.seq) continue;
      const project = store.projects.get(task.project);
      try { store.event({ id: `subagent:transcript:${task.id}:${child.id}:${child.status}:${now}`, type: 'session', project: task.project, task: task.id, agent: 'claude', projectName: project?.name, projectPath: project?.path,
        seq: Math.max(child.updatedAt, (old?.seq || 0) + 1), subagentId: child.id, subagentType: child.type, subagentStatus: child.status, subagentStartedAt: child.startedAt }, now); }
      catch { /* reconciliation is best effort; normal hooks continue to work */ }
    }
  }
}
