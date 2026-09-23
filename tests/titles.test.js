import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeThreadTitle, codexThreadTitle, threadTitle } from '../src/cli/titles.js';
import { mapHook } from '../src/cli/hook.js';
import { macHostFromProcesses } from '../src/cli/host.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'layover-titles-'));
const jsonl = (rows) => rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n';

test('Claude: the latest ai-title from the transcript, and a /rename wins over it', () => {
  const file = path.join(tmp(), 's1.jsonl');
  const msg = { type: 'user', sessionId: 's1', message: { role: 'user', content: 'set a title for this' } };
  fs.writeFileSync(file, jsonl([msg, { type: 'ai-title', aiTitle: 'Old name', sessionId: 's1' }, msg, { type: 'ai-title', aiTitle: 'Fix  login\nredirect', sessionId: 's1' }, '{"type":"assis']));
  assert.equal(claudeThreadTitle(file, 's1'), 'Fix login redirect');
  fs.appendFileSync(file, jsonl([{ type: 'custom-title', customTitle: 'Auth bug', sessionId: 's1' }, { type: 'ai-title', aiTitle: 'Newer AI name', sessionId: 's1' }]));
  assert.equal(claudeThreadTitle(file, 's1'), 'Auth bug');
  assert.equal(claudeThreadTitle(file, 'other-session'), '');
  assert.equal(threadTitle('claude', { session_id: 's1', transcript_path: file }), 'Auth bug');
  assert.equal(threadTitle('claude', { session_id: 's1', transcript_path: path.join(tmp(), 'missing.jsonl') }), '');
  assert.equal(threadTitle('claude', { session_id: 's1' }), '');
});

test('Claude: a title only near the start of a large transcript is still found', () => {
  const file = path.join(tmp(), 'big.jsonl');
  const filler = JSON.stringify({ type: 'assistant', text: 'x'.repeat(4000) });
  fs.writeFileSync(file, jsonl([{ type: 'ai-title', aiTitle: 'Early name', sessionId: 's1' }, ...Array(400).fill(filler)]));
  assert.ok(fs.statSync(file).size > 1.5 * (1 << 20));
  assert.equal(claudeThreadTitle(file, 's1'), 'Early name');
});

test('Codex: the last thread_name for this thread in session_index.jsonl', () => {
  const home = tmp();
  const file = path.join(home, 'session_index.jsonl');
  assert.equal(codexThreadTitle('t1', home), '');
  fs.writeFileSync(file, jsonl([
    { id: 't1', thread_name: 'First name', updated_at: '2026-09-23T15:33:20Z' },
    { id: 't2', thread_name: 'Another thread', updated_at: '2026-09-23T15:34:00Z' },
    { id: 't1', thread_name: 'Renamed', updated_at: '2026-09-23T15:35:00Z' },
  ]));
  assert.equal(codexThreadTitle('t1', home), 'Renamed');
  assert.equal(codexThreadTitle('t2', home), 'Another thread');
  assert.equal(codexThreadTitle('t3', home), '');
});

test('a thread title travels as its own identity-only session event, first, with an id from the title', () => {
  const input = { session_id: 'abc', cwd: '/work/site', hook_event_name: 'Stop', prompt_id: 'p1' };
  const a = mapHook('claude', input, { threadTitle: 'Fix login redirect' });
  assert.equal(a.events.length, 2);
  const [t, e] = a.events;
  assert.equal(t.type, 'session'); assert.equal(t.threadTitle, 'Fix login redirect'); assert.equal(e.type, 'end');
  assert.deepEqual(Object.keys(t).sort(), ['agent', 'id', 'project', 'task', 'threadTitle', 'type']);
  assert.equal(mapHook('claude', { ...input, cwd: '/WORK/site' }, { threadTitle: 'Fix login redirect' }).events[0].id, t.id);
  assert.notEqual(mapHook('claude', input, { threadTitle: 'Other' }).events[0].id, t.id);
  assert.equal(mapHook('claude', input).events.length, 1);
  assert.equal(mapHook('claude', { ...input, hook_event_name: 'PostToolUse' }, { threadTitle: 'x' }).events.length, 0);
});

test('macOS host: the first app bundle up the tree, iTerm2 through its detached server, and the tab tty', () => {
  const ps = [
    '    1     0 ??       /sbin/launchd',
    '  300     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '  301   300 ttys002  login',
    '  302   301 ttys002  -zsh',
    '  303   302 ttys002  node',
    '  304   303 ??       /bin/sh',
    '  400     1 ??       /Users/me/Library/Application Support/iTerm2/iTermServer-3.5.4',
    '  401   400 ttys005  /usr/bin/login',
    '  402   401 ttys005  -zsh',
    '  500     1 ??       tmux',
    '  501   500 ttys009  -zsh',
    '  502   302 ttys002  tmux',
    '  600     1 ??       /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
    '  601   600 ttys011  /bin/zsh',
  ].join('\n');
  assert.deepEqual(macHostFromProcesses(304, ps), { pid: 300, app: '/System/Applications/Utilities/Terminal.app', name: 'Terminal', tty: '/dev/ttys002' });
  assert.deepEqual(macHostFromProcesses(402, ps), { pid: 400, app: '', bundle: 'com.googlecode.iterm2', name: 'iTerm2', tty: '/dev/ttys005' });
  assert.equal(macHostFromProcesses(501, ps), null); // inside tmux the tree ends at the server…
  assert.deepEqual(macHostFromProcesses(502, ps), { pid: 300, app: '/System/Applications/Utilities/Terminal.app', name: 'Terminal', tty: '/dev/ttys002' }); // …so the walk starts at the client
  assert.equal(macHostFromProcesses(601, ps).name, 'Visual Studio Code');
});
