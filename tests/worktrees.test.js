import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalPath, projectPathFromPath, projectIdFromPath, projectNameFromPath } from '../src/main/paths.js';
import { Store } from '../src/main/store.js';
import { mapHook } from '../src/cli/hook.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-worktrees-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'project'), work = path.join(dir, '01M3GB4S3EKK7');
  const admin = path.join(main, '.git', 'worktrees', 'review');
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  return { dir, main, work };
}

test('linked worktrees and their subdirectories share the main project identity', t => {
  const { main, work, dir } = fixture(t);
  assert.equal(projectPathFromPath(work), main);
  assert.equal(projectPathFromPath(path.join(work, 'src')), main);
  assert.equal(projectIdFromPath(work), projectIdFromPath(main));
  assert.equal(projectNameFromPath(work), 'project');
  assert.equal(projectPathFromPath(path.join(main, 'src')), path.join(main, 'src'));
  const sub = path.join(dir, 'submodule'); fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${path.join(main, '.git', 'modules', 'sub')}\n`);
  assert.equal(projectPathFromPath(sub), sub);
  const hook = mapHook('claude', { cwd: work, session_id: 's1', hook_event_name: 'SessionStart' });
  assert.equal(hook.events[0].project, projectIdFromPath(main));
  assert.equal(hook.events[0].projectPath, main);
});

test('existing history and user content merge once, and aliases survive worktree removal', t => {
  const { dir, main, work } = fixture(t);
  const data = path.join(dir, 'data'); fs.mkdirSync(data);
  const old = 'p_' + crypto.createHash('sha1').update(canonicalPath(work)).digest('hex').slice(0, 16);
  const parent = projectIdFromPath(main);
  const event = { id: 'start', type: 'start', project: old, projectPath: work, projectName: path.basename(work), task: 'claude:s1', agent: 'claude', run: 'r1', seq: 0 };
  fs.writeFileSync(path.join(data, 'events.jsonl'), JSON.stringify({ t: Date.now(), e: event }) + '\n');
  const user = (body, title) => ({ notes: { body, revision: 1 }, tickets: [{ id: title, number: 1, title }], ticketSeq: 1, responses: {}, dismissed: {}, place: {} });
  fs.writeFileSync(path.join(data, 'user.json'), JSON.stringify({ version: 1, projects: { [old]: user('work notes', 'work'), [parent]: user('main notes', 'main') }, manualProjects: {} }));
  let store = new Store(data);
  assert.equal(store.state().projects.length, 1);
  assert.equal(store.state().projects[0].path, main);
  assert.equal(store.state().runs[0].project, parent);
  assert.equal(store.user(parent).notes.body, 'main notes\n\nwork notes');
  assert.deepEqual(store.user(parent).tickets.map(t => t.number), [1, 2]);
  assert.deepEqual(store.event(event), { duplicate: true });
  store.event({ id: 'end', type: 'end', project: old, task: event.task, agent: 'claude', run: 'r1', seq: 1, status: 'completed' });
  store.close();
  fs.unlinkSync(path.join(work, '.git'));
  store = new Store(data);
  try {
    assert.equal(store.state().projects.length, 1);
    assert.equal(store.state().runs[0].status, 'completed');
    assert.equal(store.user(old).notes.body, 'main notes\n\nwork notes');
    assert.equal(store.user(parent).tickets.length, 2);
  } finally { store.close(); }
});

test('deleted no-mistakes checkouts resolve through the main project remote', t => {
  const { dir, main } = fixture(t);
  const remote = path.join(dir, '.no-mistakes', 'repos', 'abc.git');
  fs.writeFileSync(path.join(main, '.git', 'config'), `[remote "no-mistakes"]\n url = ${remote.replaceAll('\\', '/')}\n`);
  const removed = path.join(dir, '.no-mistakes', 'worktrees', 'abc', '01M3GB4S3EKK7');
  const data = path.join(dir, 'data'); fs.mkdirSync(data);
  const base = { type: 'session', agent: 'claude' };
  const events = [{ ...base, id: 'old', project: 'old', projectPath: removed, task: 'old-task' }, { ...base, id: 'main', project: projectIdFromPath(main), projectPath: main, task: 'main-task' }];
  fs.writeFileSync(path.join(data, 'events.jsonl'), events.map(e => JSON.stringify({ t: Date.now(), e })).join('\n'));
  const store = new Store(data);
  try {
    assert.equal(store.state().projects.length, 1);
    assert.equal(store.state().tasks[0].project, projectIdFromPath(main));
  } finally { store.close(); }
});
