import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapHook, resolveLatest, turnTitle } from '../src/cli/hook.js';

test('turn titles are short, tag-free, and name system-generated turns', () => {
  assert.equal(turnTitle('<task-notification>\n<task-id>abc</task-id>'), 'Follow-up from a background task');
  assert.equal(turnTitle('Great start, and I mostly love the look of the app. Couple problems I am noticing: 1. Claude...'), 'Great start, and I mostly love the look of the app.');
  assert.equal(turnTitle('## Fix the **build**\n```js\nx\n```'), 'Fix the build');
  assert.equal(turnTitle('x'.repeat(200)).length, 80);
  assert.equal(turnTitle(''), '');
});
import { projectIdFromPath } from '../src/main/paths.js';

const common = { session_id: 'abc', cwd: 'C:\\work\\site', transcript_path: 'x' };

test('Claude prompt → hook-driven start with context line; Stop → completed end on the same run', () => {
  const s = mapHook('claude', { ...common, hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'Build the onboarding flow\nwith email' });
  assert.equal(s.events.length, 1);
  const e = s.events[0];
  assert.equal(e.type, 'start'); assert.equal(e.lifecycle, 'hooks'); assert.equal(e.run, 'claude:abc:p1');
  assert.equal(e.project, projectIdFromPath('C:\\work\\site')); assert.equal(e.projectName, 'site');
  assert.equal(e.title, 'Build the onboarding flow with email');
  assert.match(s.context, /run claude:abc:p1/);
  assert.equal(s.open.reason, 'run-start');
  const st = mapHook('claude', { ...common, hook_event_name: 'Stop', prompt_id: 'p1' });
  assert.equal(st.events[0].type, 'end'); assert.equal(st.events[0].status, 'completed'); assert.equal(st.events[0].run, 'claude:abc:p1');
  assert.equal(st.context, '');
});

test('context line can be turned off', () => {
  const s = mapHook('claude', { ...common, hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'x' }, { hookContext: false });
  assert.equal(s.context, '');
});

test('SessionEnd, StopFailure, Interrupt map to cancelled/failed; missing run resolves to the latest active run', () => {
  const se = mapHook('codex', { ...common, hook_event_name: 'SessionEnd', reason: 'other' });
  assert.equal(se.events[0].status, 'cancelled'); assert.equal(se.events[0].run, '__latest__');
  const sf = mapHook('claude', { ...common, hook_event_name: 'StopFailure', prompt_id: 'p2', error: 'rate limited' });
  assert.equal(sf.events[0].status, 'failed'); assert.equal(sf.events[0].run, 'claude:abc:p2');
  const it = mapHook('codex', { ...common, hook_event_name: 'Interrupt', turn_id: 't9' });
  assert.equal(it.events[0].status, 'cancelled'); assert.equal(it.events[0].run, 'codex:abc:t9');
  const state = { runs: [{ id: 'codex:abc:t1', task: 'codex:abc', status: 'completed', startedAt: 1 }, { id: 'codex:abc:t2', task: 'codex:abc', status: 'active', startedAt: 2 }] };
  const resolved = resolveLatest(se.events, state);
  assert.equal(resolved[0].run, 'codex:abc:t2');
  assert.deepEqual(resolveLatest(se.events, { runs: [] }), []);
});

test('Notification permission prompts become waiting questions; other notifications are ignored', () => {
  const n = mapHook('claude', { ...common, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs permission to run npm test' });
  assert.equal(n.events[0].type, 'item'); assert.equal(n.events[0].waiting, true); assert.equal(n.events[0].origin, 'notification');
  const a = mapHook('claude', { ...common, hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok' });
  assert.equal(a.events.length, 0);
});

test('SessionStart registers the conversation; unknown events and missing session ids are ignored', () => {
  const s = mapHook('codex', { ...common, hook_event_name: 'SessionStart' }, { host: { pid: 12, hwnd: '99', name: 'WindowsTerminal', title: 'pwsh' } });
  assert.equal(s.events[0].type, 'session'); assert.equal(s.events[0].task, 'codex:abc');
  assert.deepEqual(s.events[0].host, { pid: 12, hwnd: '99', name: 'WindowsTerminal', title: 'pwsh' });
  assert.equal(mapHook('codex', { ...common, hook_event_name: 'SessionStart' }).events[0].host, undefined);
  assert.equal(mapHook('claude', { ...common, hook_event_name: 'PreToolUse' }).events.length, 0);
  assert.equal(mapHook('claude', { hook_event_name: 'Stop', cwd: 'C:\\x' }).events.length, 0);
  assert.throws(() => mapHook('gemini', common), /agent/);
});
