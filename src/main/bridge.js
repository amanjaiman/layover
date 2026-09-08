// Optional Codex write-back (ported from phase one). Only used when a run is explicitly bound to a
// native Codex thread. Sending is always a user action; saved drafts are never delivered by themselves.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readTarget, steerCodex, validateEndpoint } from './codex-rpc.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function queueCodex(thread, text) {
  return new Promise(resolve => {
    const p = spawn(process.platform === 'win32' ? 'codex.exe' : 'codex', ['queue', '--thread', thread, '--message', text], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, 15000);
    p.stdout.on('data', b => { stdout = (stdout + b).slice(-16000); });
    p.stderr.on('data', b => { stderr = (stderr + b).slice(-16000); });
    p.on('error', e => { clearTimeout(timer); resolve({ status: 'failed', detail: e.message }); });
    p.on('close', code => {
      clearTimeout(timer);
      const match = stdout.match(/Queued message ([0-9a-f-]+) for thread ([0-9a-f-]+)/i);
      resolve(timedOut ? { status: 'unknown', detail: 'Queue command timed out. Delivery is uncertain; do not resend automatically.' }
        : code === 0 && match && match[2] === thread ? { status: 'queued', queueId: match[1], detail: 'Codex accepted the queue entry. Agent receipt is not confirmed.' }
        : { status: code === 0 ? 'unknown' : 'failed', detail: (stderr || stdout || 'Queue command failed').slice(0, 2000) });
    });
  });
}

function atomicWrite(file, body) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, body); fs.renameSync(tmp, file);
}

export class Bridge {
  constructor(store, dir, sender = queueCodex) {
    this.store = store; this.sender = sender; this.file = path.join(dir, 'bridge.json');
    this.doc = { bindings: {}, messages: {} };
    try { if (fs.existsSync(this.file)) this.doc = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* fresh */ }
    for (const m of Object.values(this.doc.messages)) if (m.status === 'submitting') { m.status = 'unknown'; m.detail = 'Layover restarted during submission. Do not resend automatically.'; }
    this.save();
    this.opens = new Map();
  }
  save() { atomicWrite(this.file, JSON.stringify(this.doc, null, 1)); }
  bindings() { return Object.values(this.doc.bindings); }
  messages() { return Object.values(this.doc.messages).sort((a, b) => a.created - b.created); }

  async bind({ run, thread, endpoint, turn }) {
    if (!uuid.test(thread || '')) throw Error('A full Codex thread UUID is required.');
    const r = this.store.runs.get(run);
    if (!r || r.agent !== 'codex') throw Error('Only a known Codex run can be linked.');
    endpoint = endpoint ? validateEndpoint(endpoint) : null;
    if (turn !== undefined && (typeof turn !== 'string' || !turn || turn.length > 180)) throw Error('Invalid turn ID.');
    const old = this.doc.bindings[run];
    if (old && (old.thread !== thread || (old.endpoint || null) !== endpoint)) throw Error('This run is already linked to a different thread or host.');
    const target = endpoint ? await readTarget(endpoint, thread) : null;
    this.doc.bindings[run] = { run, thread, endpoint, turn: turn || old?.turn || null };
    this.save();
    return { ...this.doc.bindings[run], linked: true, target };
  }
  async target({ run }) {
    const b = this.doc.bindings[run];
    if (!b) throw Error('Run is not linked.');
    const target = b.endpoint ? await readTarget(b.endpoint, b.thread) : { activeTurnId: null, status: { type: 'queueOnly' } };
    if (!target.historyAvailable && target.status?.type === 'active' && b.turn) { target.activeTurnId = b.turn; target.turnSource = 'registered; checked by Codex when sending'; }
    return { ...b, ...target };
  }
  async send({ id, run, thread, text, expectedTurnId }) {
    if (!uuid.test(id || '') || typeof text !== 'string' || !text.trim() || text.length > 12000) throw Error('A message UUID and 1-12000 characters are required.');
    const b = this.doc.bindings[run];
    if (!b || b.thread !== thread) throw Error('Target does not match the linked Codex thread.');
    const old = this.doc.messages[id];
    if (old) { if (old.run !== run || old.thread !== thread || old.text !== text) throw Error('Message ID conflict.'); return old; }
    const now = Date.now();
    const m = this.doc.messages[id] = { id, run, thread, text, status: 'submitting', detail: 'Submitting to Codex.', queueId: null, created: now, updated: now };
    this.save();
    const content = text + `\n\n[Layover message ${id}; run ${run}. If the layover CLI is available, acknowledge with: layover ack --id ${id} --run ${run} --thread ${thread}]`;
    let result;
    try { result = b.endpoint ? await steerCodex(b.endpoint, thread, content, expectedTurnId) : await this.sender(thread, content); }
    catch (e) { result = { status: /timed out|connection closed/i.test(e.message) ? 'unknown' : 'failed', detail: e.message }; }
    if (m.status === 'submitting') { m.status = result.status; m.detail = result.detail; m.queueId = result.queueId || null; m.updated = Date.now(); this.save(); }
    return m;
  }
  ack({ id, run, thread }) {
    const m = this.doc.messages[id];
    if (!m || m.run !== run || m.thread !== thread) throw Error('Receipt target mismatch.');
    if (m.status === 'failed') throw Error('Cannot acknowledge a failed submission.');
    m.status = 'acknowledged'; m.detail = 'Receiving agent reported receipt.'; m.updated = Date.now(); this.save();
    return { id, status: 'acknowledged', run, thread };
  }
}
