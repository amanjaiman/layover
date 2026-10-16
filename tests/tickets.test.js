import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Resolve symlinks (macOS /var → /private/var) so the path matches the CLI's process.cwd().
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'layover-tickets-')));
process.env.LAYOVER_DATA = dir;
process.env.LAYOVER_PORT = '43198';
const { Store } = await import('../src/main/store.js');
const { createService } = await import('../src/main/service.js');
const { request } = await import('../src/cli/client.js');
const { projectIdFromPath } = await import('../src/main/paths.js');
const { normalizeTicketKeys, ticketKeysFromText } = await import('../src/main/ticket-keys.js');
const { mapHook } = await import('../src/cli/hook.js');

const main = path.join(dir, 'workspace');
const admin = path.join(main, '.git', 'worktrees', 'review');
fs.mkdirSync(admin, { recursive: true });
const work = path.join(dir, 'worktree'); fs.mkdirSync(work);
fs.writeFileSync(path.join(work, '.git'), 'gitdir: ' + admin + '\n');
fs.writeFileSync(path.join(admin, 'commondir'), '../..');
const store = new Store(path.join(dir, 'data'));
const project = projectIdFromPath(main);
store.createProject({ id: project, name: 'Workspace', path: main });
store.setProjectMeta(project, { prefix: 'WS' });
for (let n = 1; n <= 22; n++) store.upsertTicket(project, { title: 'Ticket ' + n, description: 'Requirements ' + n, prompt: 'Draft ' + n, status: n === 20 ? 'done' : 'todo', priority: 3 });
store.setNotes(project, 'Private unrelated notes', 0);
store.createProject({ id: 'other', name: 'Other' });
store.setProjectMeta('other', { prefix: 'WS' });
store.upsertTicket('other', { title: 'Different WS-1' });
const hook = mapHook('codex', { cwd: main, session_id: 'tickets', turn_id: '1', hook_event_name: 'UserPromptSubmit', prompt: 'Please work on these tickets after considering this context. ' + 'x'.repeat(100) + ' WS-22, ws-21, WS-20 and WS-22' });
store.event(hook.events[0]);
const runId = hook.events[0].run;
const svc = await createService({ store, port: 43198, onOpen: async () => ({}) });
const cli = (args, cwd = main) => new Promise(resolve => execFile(process.execPath, [path.resolve('src/cli/layover.js'), 'tickets', ...args], { cwd, env: process.env, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));

test('ticket reads require local authentication', async () => {
  const response = await fetch('http://127.0.0.1:43198/api/tickets/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['WS-22'], run: runId }) });
  assert.equal(response.status, 401);
});

test('batch ticket reads retain order, deduplicate, and never expose notes or change content', async () => {
  const before = fs.readFileSync(store.userFile, 'utf8');
  const memory = structuredClone(store.userDoc);
  const events = fs.readFileSync(store.eventsFile, 'utf8');
  const result = await request('/api/tickets/read', { keys: ['WS-22', 'ws-21', 'WS-20', 'WS-22'], run: runId });
  assert.deepEqual(result.tickets.map(t => t.key), ['WS-22', 'WS-21', 'WS-20']);
  assert.equal(result.tickets[0].description, 'Requirements 22');
  assert.equal(result.tickets[0].prompt, 'Draft 22');
  assert.equal(result.tickets[0].priority, 3);
  assert.equal(result.tickets[2].status, 'done');
  assert.deepEqual(result.missing, []);
  assert.equal(result.project.id, project);
  assert.ok(!JSON.stringify(result).includes('Private unrelated notes'));
  assert.equal(fs.readFileSync(store.userFile, 'utf8'), before);
  assert.equal(fs.readFileSync(store.eventsFile, 'utf8'), events);
  assert.deepEqual(store.userDoc, memory);
});

test('workspace selectors and linked worktrees stay within the selected workspace', async () => {
  assert.equal(store.readTickets({ keys: ['WS-1'], project: 'other' }).tickets[0].title, 'Different WS-1');
  assert.equal(store.readTickets({ keys: ['WS-1'], path: work }).tickets[0].title, 'Ticket 1');
  assert.deepEqual(store.readTickets({ keys: ['OTH-1', 'WS-99'], run: runId }).missing, ['OTH-1', 'WS-99']);
  assert.throws(() => store.readTickets({ keys: ['WS-1'], run: 'unknown' }), /Unknown run/);
  assert.throws(() => store.readTickets({ keys: ['WS-1'], project: 'unknown' }), /Unknown workspace/);
  assert.throws(() => store.readTickets({ keys: ['WS-1'], run: runId, project }), /one workspace selector/);
  assert.throws(() => store.readTickets({ keys: ['WS-1'], path: 'relative' }), /absolute/);
  assert.equal((await cli(['WS-22', 'WS-21', 'WS-20'], work)).code, 0);
});

test('CLI prints partial results with a failing exit code and accepts explicit run/project/path', async () => {
  for (const selector of [[], ['--run', runId], ['--path', work], ['--project', project]]) {
    const result = await cli(['ws-22', 'WS-99', ...selector]);
    assert.equal(result.code, 1);
    const json = JSON.parse(result.stdout);
    assert.deepEqual(json.tickets.map(t => t.key), ['WS-22']);
    assert.deepEqual(json.missing, ['WS-99']);
  }
  const ok = await cli(['WS-22', 'WS-21', 'WS-20', '--run', runId], dir);
  assert.equal(ok.code, 0); assert.equal(JSON.parse(ok.stdout).tickets.length, 3);
  const conflict = await cli(['WS-1', '--run', runId, '--project', 'other']);
  assert.equal(conflict.code, 1); assert.match(conflict.stderr, /Choose one/);
});

test('invalid keys and oversized batches fail before lookup', async () => {
  for (const keys of [[], ['WS-0'], ['WS-01'], ['WS-9007199254740992'], [null], ['WS-1; echo'], Array(51).fill('WS-1')]) {
    assert.throws(() => normalizeTicketKeys(keys));
    await assert.rejects(request('/api/tickets/read', { keys, run: runId }));
  }
  const invalid = await cli(['WS-1', '--run']);
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /requires a value/);
  assert.deepEqual(ticketKeysFromText('ws-22 WS-21 WS-22 XWS-20 WS-9007199254740992'), ['WS-22', 'WS-21', 'XWS-20']);
});

test('full-prompt ticket references survive title shortening and store reload', () => {
  assert.ok(!hook.events[0].title.includes('WS-22'));
  assert.deepEqual(store.state().runs[0].ticketKeys, ['WS-22', 'WS-21', 'WS-20']);
  const reopened = new Store(store.dir);
  try { assert.deepEqual(reopened.state().runs[0].ticketKeys, ['WS-22', 'WS-21', 'WS-20']); } finally { reopened.close(); }
  assert.match(hook.context, /layover tickets KEY/);
});

test.after(async () => { await svc.close(); store.close(); });
