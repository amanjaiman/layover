import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store.js';
import { reconcileClaudeSubagents, scanClaudeSubagents } from '../src/main/claude-subagents.js';

test('Claude transcript reconciliation finds a child whose worktree missed lifecycle hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-children-'));
  const root = path.join(dir, 'projects');
  const parentDir = path.join(root, 'project');
  const childrenDir = path.join(parentDir, 's1', 'subagents');
  fs.mkdirSync(childrenDir, { recursive: true });
  const transcript = path.join(parentDir, 's1.jsonl');
  fs.writeFileSync(transcript, '');
  const child = (id, meta = { agentType: 'general-purpose', toolUseId: 'tool-1' }) => {
    fs.writeFileSync(path.join(childrenDir, `agent-${id}.meta.json`), JSON.stringify(meta));
    const file = path.join(childrenDir, `agent-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use' } }) + '\n');
    return file;
  };
  child('hooked');
  const missed = child('worktree');
  child('internal', { agentType: '', description: 'internal' });
  const now = Date.now();
  const store = new Store(path.join(dir, 'data'));
  store.event({ id: 'start:r1', type: 'start', project: 'p1', task: 'claude:s1', agent: 'claude', sessionId: 's1', run: 'r1', seq: 0, title: 'Working', lifecycle: 'hooks' }, now - 1000);
  store.event({ id: 'hook:hooked', type: 'session', project: 'p1', task: 'claude:s1', agent: 'claude', seq: now - 500, subagentId: 'hooked', subagentType: 'general-purpose', subagentStatus: 'active' }, now - 500);
  assert.deepEqual(scanClaudeSubagents(transcript, now).map(c => c.id).sort(), ['hooked', 'worktree']);
  reconcileClaudeSubagents(store, now, root);
  assert.deepEqual(store.state(now).subagents.filter(c => c.status === 'active').map(c => c.subagentId).sort(), ['hooked', 'worktree']);
  assert.equal(store.state(now).subagents.find(c => c.subagentId === 'hooked').startedAt, now - 500);
  const count = fs.readFileSync(store.eventsFile, 'utf8').trim().split('\n').length;
  reconcileClaudeSubagents(store, now + 1000, root);
  assert.equal(fs.readFileSync(store.eventsFile, 'utf8').trim().split('\n').length, count);

  const endedParent = new Store(path.join(dir, 'ended-parent'));
  endedParent.event({ id: 'start:r2', type: 'start', project: 'p1', task: 'claude:s1', agent: 'claude', sessionId: 's1', run: 'r2', seq: 0, title: 'Working', lifecycle: 'hooks' }, now - 1000);
  endedParent.event({ id: 'end:r2', type: 'end', project: 'p1', task: 'claude:s1', agent: 'claude', run: 'r2', seq: now, status: 'completed' }, now);
  reconcileClaudeSubagents(endedParent, now + 1000, root);
  assert.equal(endedParent.state(now + 1000).subagents.find(c => c.subagentId === 'worktree').status, 'active');
  endedParent.close();

  fs.appendFileSync(missed, JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) + '\n');
  reconcileClaudeSubagents(store, now + 2000, root);
  assert.equal(store.state(now + 2000).subagents.find(c => c.subagentId === 'worktree').status, 'completed');
  store.close();
});

test('Claude transcript reconciliation finishes stalled children and respects ended sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-children-'));
  const root = path.join(dir, 'projects');
  const childrenDir = path.join(root, 'project', 's2', 'subagents');
  fs.mkdirSync(childrenDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'project', 's2.jsonl'), '');
  const child = (id, line) => {
    fs.writeFileSync(path.join(childrenDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId: `tool-${id}` }));
    const file = path.join(childrenDir, `agent-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify(line) + '\n');
    return file;
  };
  const now = Date.now();
  child('stopseq', { type: 'assistant', message: { stop_reason: 'stop_sequence' } });
  child('interrupted', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } });
  child('tool', { type: 'assistant', message: { stop_reason: 'tool_use' } });
  const store = new Store(path.join(dir, 'data'));
  store.event({ id: 'start:r1', type: 'start', project: 'p1', task: 'claude:s2', agent: 'claude', sessionId: 's2', run: 'r1', seq: 0, title: 'Working', lifecycle: 'hooks' }, now - 1000);
  reconcileClaudeSubagents(store, now, root);
  const status = t => Object.fromEntries(store.state(t).subagents.map(c => [c.subagentId, c.status]));
  assert.deepEqual(status(now), { stopseq: 'completed', interrupted: 'active', tool: 'active' });
  reconcileClaudeSubagents(store, now + 6 * 60_000, root);
  assert.deepEqual(status(now + 6 * 60_000), { stopseq: 'completed', interrupted: 'completed', tool: 'active' });

  const ended = new Store(path.join(dir, 'ended'));
  ended.event({ id: 'start:r2', type: 'start', project: 'p1', task: 'claude:s2', agent: 'claude', sessionId: 's2', run: 'r2', seq: 0, title: 'Working', lifecycle: 'hooks' }, now - 1000);
  ended.event({ id: 'session:end', type: 'session', project: 'p1', task: 'claude:s2', agent: 'claude', sessionEnded: true }, now + 1000);
  reconcileClaudeSubagents(ended, now + 2000, root);
  assert.equal(ended.state(now + 2000).subagents.some(c => c.status === 'active'), false);
  ended.close();
  store.close();
});
