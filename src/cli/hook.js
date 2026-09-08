// Maps Claude Code / Codex lifecycle hook JSON (stdin) to Layover events. Deterministic; no model involved.
import crypto from 'node:crypto';
import { projectIdFromPath, projectNameFromPath } from '../main/paths.js';

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' };

function oneLine(s, max = 90) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** A short human title for a turn: no tags or markdown, first sentence, and a plain name for system-generated turns. */
export function turnTitle(prompt) {
  const raw = String(prompt || '').trim();
  if (!raw) return '';
  if (/^\s*<(task-notification|system-reminder|ci-monitor-event|command-name)/i.test(raw)) return 'Follow-up from a background task';
  let t = raw.replace(/<[^>]{1,80}>/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{12,80}?[.!?])(\s|$)/);
  if (m) t = m[1];
  return oneLine(t, 80);
}

/** Turn a hook payload into {events, context, open}. `context` is printed to stdout when allowed. */
export function mapHook(agent, input, { hookContext = true, host = null } = {}) {
  if (!['claude', 'codex'].includes(agent)) throw Error('agent must be claude or codex');
  if (!input || typeof input !== 'object') throw Error('hook input must be JSON');
  const name = input.hook_event_name;
  const cwd = input.cwd || process.cwd();
  const session = String(input.session_id || input.thread_id || '').trim();
  if (!session) return { events: [], context: '', open: null };
  const project = projectIdFromPath(cwd);
  const projectName = projectNameFromPath(cwd);
  const task = `${agent}:${session}`;
  const source = agent === 'claude'
    ? `Claude Code session ${session}\nResume in that folder with: claude --resume ${session}`
    : `Codex session ${session}\nResume with: codex resume ${session}`;
  const base = { project, task, agent, projectName, projectPath: cwd };
  const now = Date.now();
  const turn = input.prompt_id || input.turn_id || '';
  const run = turn ? `${task}:${turn}` : '';
  const events = [];
  let context = '';
  let open = null;

  switch (name) {
    case 'SessionStart':
      events.push({ ...base, id: `session:${task}:${now}`, type: 'session', name: `${AGENT_LABEL[agent]} · ${projectName}`, source, sessionId: session, ...(host ? { host } : {}) });
      break;
    case 'UserPromptSubmit': {
      const r = run || `${task}:${now}`;
      const title = turnTitle(input.prompt) || 'Working';
      events.push({ ...base, id: `start:${r}`, type: 'start', run: r, seq: 0, title, source, lifecycle: 'hooks', sessionId: session });
      open = { project, task, run, reason: 'run-start' };
      if (hookContext) context = `Layover is open for this workspace (run ${r}). When you make a consequential decision, need the user's input, or spot an opportunity worth saving, publish it: layover item --run ${r} --kind decision|question|opportunity|suggestion --text "..." (one short call per item; keep going unless you truly need an answer). Use --waiting when you will stop for it.`;
      break;
    }
    case 'Stop':
      if (run) events.push({ ...base, id: `end:${run}:completed`, type: 'end', run, seq: now, status: 'completed' });
      else events.push({ ...base, id: `end:${task}:${now}`, type: 'end', run: '__latest__', seq: now, status: 'completed' });
      break;
    case 'StopFailure':
      events.push({ ...base, id: `end:${run || task}:${now}:failed`, type: 'end', run: run || '__latest__', seq: now, status: 'failed', note: oneLine(input.error || input.message || 'API error', 300) });
      break;
    case 'Interrupt':
      events.push({ ...base, id: `end:${run || task}:${now}:cancelled`, type: 'end', run: run || '__latest__', seq: now, status: 'cancelled', note: 'Interrupted by the user.' });
      break;
    case 'SessionEnd':
      events.push({ ...base, id: `end:${task}:${now}:session`, type: 'end', run: '__latest__', seq: now, status: 'cancelled', note: `Session ended (${input.reason || 'closed'}) before this turn reported completion.` });
      break;
    case 'Notification': {
      const kind = String(input.notification_type || '');
      if (!/permission_prompt|idle_prompt|agent_needs_input|elicitation_dialog/.test(kind)) break;
      const r = run || '__latest__';
      const text = kind === 'permission_prompt' ? `${AGENT_LABEL[agent]} is waiting for permission: ${oneLine(input.message, 400)}`
        : kind === 'idle_prompt' ? `${AGENT_LABEL[agent]} is idle and waiting for your next message.`
        : `${AGENT_LABEL[agent]} needs your input: ${oneLine(input.message, 400)}`;
      events.push({ ...base, id: `notify:${task}:${now}`, type: 'item', run: r, seq: now, item: `notify-${now}`, kind: 'question', status: 'open', revision: 1, text, waiting: true, origin: 'notification' });
      break;
    }
    default:
      break;
  }
  return { events, context, open };
}

/** Resolve '__latest__' run placeholders against the app state (latest active run of the task). */
export function resolveLatest(events, state) {
  const out = [];
  for (const e of events) {
    if (e.run !== '__latest__') { out.push(e); continue; }
    const runs = (state?.runs || []).filter(r => r.task === e.task && r.status === 'active').sort((a, b) => b.startedAt - a.startedAt);
    if (!runs.length) continue; // nothing active: an end without a run is meaningless, so it is dropped
    out.push({ ...e, run: runs[0].id, id: e.id.replace('__latest__', runs[0].id) });
  }
  return out;
}

export function newId() { return crypto.randomUUID(); }
