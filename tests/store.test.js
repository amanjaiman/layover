import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'layover-store-'));
const base = { project: 'p1', task: 'claude:s1', agent: 'claude', projectName: 'Demo', projectPath: 'C:/demo' };
const start = (run, extra = {}) => ({ ...base, id: 'start:' + run, type: 'start', run, seq: 0, title: 'Build onboarding', lifecycle: 'hooks', ...extra });
const item = (run, id, rev = 1, extra = {}) => ({ ...base, id: `item:${run}:${id}:${rev}`, type: 'item', run, seq: rev, item: id, kind: 'decision', status: 'open', revision: rev, text: 'Chose email sign-in', ...extra });
const end = (run, status = 'completed', seq = 10) => ({ ...base, id: `end:${run}:${status}`, type: 'end', run, seq, status });

test('start, item, end round-trip and persistence across reopen', () => {
  const dir = tmp();
  let s = new Store(dir);
  assert.deepEqual(s.event(start('r1')), { accepted: true, project: 'p1', newRun: true, started: 'r1' });
  s.event(item('r1', 'd1'));
  s.event(end('r1'));
  s.close();
  s = new Store(dir);
  const st = s.state();
  assert.equal(st.projects[0].name, 'Demo');
  assert.equal(st.runs[0].status, 'completed');
  assert.equal(st.items.length, 1);
  assert.equal(st.tasks[0].id, 'claude:s1');
  s.close();
});

test('duplicates are idempotent, conflicting reuse of an id is rejected', () => {
  const s = new Store(tmp());
  s.event(start('r1'));
  assert.deepEqual(s.event(start('r1')), { duplicate: true });
  assert.throws(() => s.event({ ...start('r1'), title: 'Different' }), /conflict/i);
  s.close();
});

test('identity is immutable and out-of-order delivery is safe', () => {
  const s = new Store(tmp());
  s.event(start('r1'));
  assert.throws(() => s.event({ ...item('r1', 'x'), project: 'p2' }), /Task identity/);
  assert.throws(() => s.event({ ...item('r1', 'x'), id: 'item:r1:x:other', task: 'claude:zz' }), /Run identity/);
  assert.throws(() => s.event({ ...start('r9'), agent: 'codex' }), /Task identity/);
  s.event(end('r1', 'completed', 10));
  // A delayed start after completion does not reopen the run.
  assert.equal(s.state().runs[0].status, 'completed');
  // A lower-seq end is ignored; a higher one wins.
  s.event(end('r1', 'failed', 5));
  assert.equal(s.state().runs[0].status, 'completed');
  s.event(end('r1', 'cancelled', 20));
  assert.equal(s.state().runs[0].status, 'cancelled');
  s.close();
});

test('item revisions: higher wins, older ignored, same revision conflict rejected', () => {
  const s = new Store(tmp());
  s.event(start('r1'));
  s.event(item('r1', 'q', 2, { text: 'v2' }));
  s.event(item('r1', 'q', 1, { text: 'v1' }));
  assert.equal(s.state().items[0].text, 'v2');
  assert.throws(() => s.event(item('r1', 'q', 2, { id: 'item:r1:q:2b', text: 'other' })), /revision conflict/);
  s.event(item('r1', 'q', 3, { text: 'v2', status: 'resolved' }));
  assert.equal(s.state().items[0].status, 'resolved');
  s.close();
});

test('concurrent runs are independent; finishing one does not finish the other', () => {
  const s = new Store(tmp());
  s.event(start('a', { task: 'claude:s1' }));
  s.event({ ...start('b'), task: 'codex:s2', agent: 'codex', id: 'start:b' });
  s.event(end('a'));
  const st = s.state();
  assert.equal(st.runs.find(r => r.id === 'a').status, 'completed');
  assert.equal(st.runs.find(r => r.id === 'b').status, 'active');
  s.close();
});

test('a new hook-driven turn on the same conversation closes the previous turn as cancelled', () => {
  const s = new Store(tmp());
  s.event(start('t1'));
  s.event(start('t2'));
  const st = s.state();
  assert.equal(st.runs.find(r => r.id === 't1').status, 'cancelled');
  assert.equal(st.runs.find(r => r.id === 't2').status, 'active');
  s.close();
});

test('voluntary runs go unknown after silence; hook runs do not', () => {
  const s = new Store(tmp());
  s.event(start('v', { lifecycle: 'voluntary' }), 1000);
  s.event(start('h', { lifecycle: 'hooks', task: 'claude:s2', id: 'start:h2' }), 1000);
  const st = s.state(1000 + 3 * 60_000);
  assert.equal(st.runs.find(r => r.id === 'v').status, 'disconnected');
  assert.equal(st.runs.find(r => r.id === 'h').status, 'active');
  s.close();
});

test('notification items resolve themselves when the run ends', () => {
  const s = new Store(tmp());
  s.event(start('r1'));
  s.event(item('r1', 'n1', 1, { kind: 'question', origin: 'notification', waiting: true }));
  assert.equal(s.state().items[0].status, 'open');
  s.event(end('r1'));
  assert.equal(s.state().items[0].status, 'resolved');
  s.close();
});

test('validation rejects bad payloads before anything is written', () => {
  const dir = tmp();
  const s = new Store(dir);
  assert.throws(() => s.event({ ...start('r1'), agent: 'gpt' }), /Invalid agent/);
  assert.throws(() => s.event({ ...start('r1'), id: 'bad id!' }), /Invalid id/);
  assert.throws(() => s.event({ ...item('r1', 'x'), kind: 'todo' }), /kind/);
  assert.throws(() => s.event({ ...item('r1', 'x'), text: 'x'.repeat(12001) }), /text/);
  assert.throws(() => s.event({ ...end('r1', 'done') }), /terminal/);
  assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), '');
  s.close();
});

test('user content: notes conflict, next entries, responses, dismissals persist', () => {
  const dir = tmp();
  let s = new Store(dir);
  s.event(start('r1'));
  assert.deepEqual(s.setNotes('p1', 'hello', 0), { revision: 1 });
  assert.equal(s.setNotes('p1', 'stale', 0).conflict, true);
  const n = s.upsertNext('p1', { kind: 'prompt', title: 'Tomorrow', body: 'Refactor exports' });
  s.upsertNext('p1', { id: n.id, status: 'done' });
  s.respond('p1', 'r1:d1', 'I agree');
  s.dismiss('p1', 'r1:d1');
  s.close();
  s = new Store(dir);
  const u = s.user('p1');
  assert.equal(u.notes.body, 'hello');
  assert.equal(u.next[0].status, 'done');
  assert.equal(u.responses['r1:d1'].body, 'I agree');
  assert.ok(u.dismissed['r1:d1']);
  assert.equal(s.state().projects[0].color, 'clay');
  s.close();
});

test('manual projects survive restart and a torn last line is ignored', () => {
  const dir = tmp();
  let s = new Store(dir);
  s.createProject({ id: 'm_1', name: 'Hand made', path: '' });
  s.close();
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"t":1,"e":{"id":"x"');
  s = new Store(dir);
  assert.equal(s.state().projects[0].name, 'Hand made');
  s.event(start('r1'));
  assert.equal(s.state().runs.length, 1);
  s.close();
});
