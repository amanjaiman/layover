import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/main/store.js';
import { mapHook } from '../src/cli/hook.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const chrome = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const run = promisify(execFile);

async function checkLinks() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (ok, msg) => { if (!ok) throw Error(msg); };
  const card = () => document.querySelector('[data-task="codex:multi"]');
  const chips = () => [...card().querySelectorAll('.thread-title .chip.link')];
  try {
    await wait(250);
    assert(chips().map(b => b.textContent).join(',') === 'WS-22,WS-21,WS-20', 'all references appear in requested order');
    const linked = userData.tickets.filter(t => (t.runs || []).includes('codex:multi:turn'));
    assert(linked.length === 3, 'all three tickets persist the run link');
    assert(userData.tickets.find(t => t.number === 22).status === 'progress', 'todo moved to progress');
    assert(userData.tickets.find(t => t.number === 20).status === 'done', 'completed ticket remains done');
    assert(userData.tickets.find(t => t.number === 19).status === 'todo', 'unmentioned ticket unchanged');
    assert(document.querySelectorAll('[data-task="claude:legacy"] .thread-title .chip.link').length === 2, 'legacy title links every matching ticket');
    const doneButtons = () => [...card().querySelectorAll('.tl-end-actions button')].filter(b => b.textContent.includes('Mark WS-'));
    assert(doneButtons().length === 2, 'individual actions only for unfinished tickets');
    doneButtons()[0].click(); await wait(60);
    assert(userData.tickets.find(t => t.number === 22).status === 'done', 'chosen ticket completed');
    assert(userData.tickets.find(t => t.number === 21).status === 'progress', 'other ticket stays in progress');
    assert(doneButtons().length === 1, 'completed action removed');
    handlers['window-mode']('compact'); await wait(60);
    assert(chips().length === 3, 'compact mode retains all keys');
    assert(chips().every(b => b.getBoundingClientRect().right <= innerWidth), 'compact ticket chips stay within viewport');
    chips()[1].click(); await wait(60);
    assert(document.querySelector('.tk-detail .tk-key').textContent === 'WS-21', 'each chip opens its ticket');
    assert(errors.length === 0, 'no renderer errors: ' + errors.join(', '));
    const result = document.createElement('pre'); result.id = 'test-result'; result.textContent = 'PASS'; document.body.append(result);
  } catch (e) {
    const result = document.createElement('pre'); result.id = 'test-result'; result.textContent = 'FAIL: ' + e.stack; document.body.append(result);
  }
}

test('renderer links all named tickets and completes them individually', { skip: !fs.existsSync(chrome), timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-ticket-links-'));
  const store = new Store(path.join(dir, 'data'));
  const project = 'p_multi';
  store.createProject({ id: project, name: 'Multi' }); store.setProjectMeta(project, { prefix: 'WS' });
  for (let number = 1; number <= 22; number++) store.upsertTicket(project, { title: 'Task ' + number, status: number === 20 ? 'done' : 'todo' });
  const event = mapHook('codex', { session_id: 'multi', turn_id: 'turn', hook_event_name: 'UserPromptSubmit', prompt: 'Consider this context first. ' + 'x'.repeat(100) + ' WS-22, ws-21, WS-20, WS-22, OTHER-19' }).events[0];
  Object.assign(event, { project, projectName: 'Multi', projectPath: '' }); store.event(event);
  store.event({ id: 'end', type: 'end', project, task: event.task, agent: 'codex', run: event.run, seq: Date.now(), status: 'completed' });
  store.event({ id: 'legacy', type: 'start', project, task: 'claude:legacy', agent: 'claude', run: 'legacy', seq: 0, title: 'WS-18 and WS-17', lifecycle: 'hooks' });
  const state = store.state(), user = store.user(project); store.close();
  try {
    for (const name of ['app.css', 'app.js', 'brand-icons.js', 'logo.png']) fs.copyFileSync(path.join(root, 'src/renderer', name), path.join(dir, name));
    let html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link rel="stylesheet" href="https:[^>]*>/, '');
    html = html.replace('<script src="brand-icons.js"></script>', '<script src="mock.js"></script><script src="brand-icons.js"></script>');
    html = html.replace('</body>', '<script src="check.js"></script></body>');
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'mock.js'), `window.handlers = {}; window.errors = []; window.userData = ${JSON.stringify(user)};
      window.addEventListener('error', e => errors.push(e.message));
      window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
      window.layover = {
        platform: 'win32', getState: async () => ({ok:true,value:${JSON.stringify(state)}}),
        getUser: async () => ({ok:true,value:structuredClone(userData)}),
        getSettings: async () => ({ok:true,value:{onboarded:true,theme:'light',layout:'full',window:{mode:'expanded',lastProject:'p_multi'}}}),
        getUpdate: async () => ({ok:true,value:null}), setPlace: async () => ({ok:true}), setSettings: async () => ({ok:true}), engaged: () => {},
        upsertTicket: async (project, patch) => { const ticket = userData.tickets.find(t => t.id === patch.id); Object.assign(ticket, patch); return {ok:true,value:structuredClone(ticket)}; },
        on: (name, fn) => {handlers[name] = fn; return () => {};}
      };`);
    fs.writeFileSync(path.join(dir, 'check.js'), '(' + checkLinks.toString() + ')();');
    const { stdout } = await run(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'chrome'), '--window-size=400,580', '--virtual-time-budget=7000', '--dump-dom', new URL('file:///' + path.join(dir, 'index.html').replaceAll('\\', '/')).href], { windowsHide: true, timeout: 25000, maxBuffer: 2e6 });
    const result = stdout.match(/<pre id="test-result">([\s\S]*?)<\/pre>/)?.[1];
    assert.equal(result, 'PASS', result || 'Browser did not complete the checks');
  } finally {
    // This exact temporary directory was created by mkdtemp above.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
