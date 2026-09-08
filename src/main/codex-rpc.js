// Minimal JSON-RPC client for a local Codex App Server (ws://127.0.0.1:PORT). Ported from phase one.
export function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Use a local ws://127.0.0.1:PORT Codex App Server endpoint.');
  return url.href;
}

export class CodexRPC {
  constructor(endpoint) { this.endpoint = validateEndpoint(endpoint); this.next = 1; this.pending = new Map(); this.listeners = new Set(); }
  async connect() {
    this.ws = new WebSocket(this.endpoint);
    this.ws.addEventListener('message', event => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
      else for (const fn of this.listeners) fn(msg);
    });
    this.ws.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex connection closed; delivery may be uncertain.')); } this.pending.clear(); });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.ws.close(); reject(Error('Codex connection timed out.')); }, 5000);
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(t); reject(Error('Cannot connect to the Codex App Server.')); }, { once: true });
    });
    await this.call('initialize', { clientInfo: { name: 'layover', title: 'Layover', version: '0.2.0' } });
    this.ws.send(JSON.stringify({ method: 'initialized' }));
    return this;
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Codex request timed out; delivery may be uncertain.')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws?.close(); }
}

export async function readTarget(endpoint, thread) {
  const rpc = await new CodexRPC(endpoint).connect();
  try {
    let response, historyAvailable = true;
    try { response = await rpc.call('thread/read', { threadId: thread, includeTurns: true }); }
    catch (e) { if (!/list_turns is not supported/.test(e.message)) throw e; historyAvailable = false; response = await rpc.call('thread/read', { threadId: thread, includeTurns: false }); }
    const t = response.thread, active = t.turns?.findLast(x => x.status === 'inProgress');
    return { thread: t.id, name: t.name || t.preview || t.id, status: t.status, activeTurnId: active?.id || null, historyAvailable };
  } finally { rpc.close(); }
}

export async function steerCodex(endpoint, thread, text, expectedTurnId) {
  if (typeof expectedTurnId !== 'string' || !expectedTurnId) throw Error('Refresh the target and select its active turn before sending guidance.');
  const rpc = await new CodexRPC(endpoint).connect();
  try {
    const reply = await rpc.call('turn/steer', { threadId: thread, expectedTurnId, input: [{ type: 'text', text }] });
    return { status: 'accepted', queueId: reply.turnId, detail: 'Codex accepted input for the active turn. Agent acknowledgment is pending.' };
  } finally { rpc.close(); }
}
