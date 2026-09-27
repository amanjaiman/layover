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
