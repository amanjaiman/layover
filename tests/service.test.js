import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-svc-'));
process.env.LAYOVER_DATA = root;
process.env.LAYOVER_PORT = '43199';
const { Store } = await import('../src/main/store.js');
const { createService } = await import('../src/main/service.js');
const { request, health } = await import('../src/cli/client.js');

const store = new Store(path.join(root, 'data'));
const opens = [];
const svc = await createService({ store, onOpen: async (ctx) => { opens.push(ctx); return { reused: true }; }, onEvent: async () => null, port: 43199 });
const base = { project: 'p1', task: 'test:s1', agent: 'test' };

test('health is public; everything else needs the local token', async () => {
  const h = await health(); assert.equal(h.app, 'layover');
  const r = await fetch('http://127.0.0.1:43199/api/state'); assert.equal(r.status, 401);
  const bad = await fetch('http://127.0.0.1:43199/api/state', { headers: { Origin: 'http://evil.test', Authorization: 'Bearer ' + svc.token } }); assert.equal(bad.status, 403);
});

test('events, batch, duplicates and rejection over HTTP', async () => {
  const r = await request('/api/events', { ...base, id: 'e1', type: 'start', run: 'r1', seq: 0, title: 'T', lifecycle: 'voluntary' });
  assert.equal(r.accepted, true);
  const d = await request('/api/events', { ...base, id: 'e1', type: 'start', run: 'r1', seq: 0, title: 'T', lifecycle: 'voluntary' });
  assert.equal(d.duplicate, true);
  await assert.rejects(request('/api/events', { ...base, id: 'e2', type: 'item', run: 'r1', seq: 1, item: 'x', kind: 'nope', status: 'open', revision: 1, text: 'x' }), /kind/);
  const b = await request('/api/events/batch', [{ ...base, id: 'e3', type: 'item', run: 'r1', seq: 1, item: 'x', kind: 'question', status: 'open', revision: 1, text: 'Q?' }, { ...base, id: 'e4', type: 'end', run: 'r1', seq: 2, status: 'completed' }, { bogus: true }]);
  assert.equal(b.results[0].accepted, true); assert.equal(b.results[1].ended.status, 'completed'); assert.match(b.results[2].error, /Invalid/);
  const st = await request('/api/state');
  assert.equal(st.runs[0].status, 'completed'); assert.equal(st.items.length, 1);
});

test('open is routed to the app handler', async () => {
  const r = await request('/api/open', { project: 'p1' });
  assert.equal(r.reused, true); assert.deepEqual(opens.at(-1), { project: 'p1' });
});

test.after(async () => { await svc.close(); store.close(); });
