import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/main/store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const chrome = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const run = promisify(execFile);

// Runs against the real renderer with an isolated profile and mock IPC bridge.
async function checkSelection() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const assert = (ok, msg) => { if (!ok) throw Error(msg); };
  const menu = () => document.querySelector('.notes-selection:not(.is-closing)');
  const select = async (start, end, mouse = false) => {
    const ta = document.querySelector('.notes'); ta.focus();
    if (mouse) ta.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    ta.setSelectionRange(start, end); ta.dispatchEvent(new Event('select'));
    if (mouse) {
      await wait(20); assert(!menu(), 'no menu while dragging');
      ta.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 150, clientY: 230 }));
    }
    await wait(40); return ta;
  };
  const resetNotes = async () => { const ta = document.querySelector('.notes'); ta.value = originalBody; ta.dispatchEvent(new Event('input', { bubbles: true })); await wait(550); };
  try {
    await wait(100);
    let ta = await select(0, 31, true);
    assert(menu(), 'menu on mouse selection');
    assert(menu().getAttribute('aria-label') === 'Move to Departures', 'flight title');
    let buttons = [...menu().querySelectorAll('button')];
    assert(buttons.length === 2 && buttons[0].textContent === 'Scheduled' && buttons[1].textContent === 'In flight', 'two existing status labels');
    const rect = menu().getBoundingClientRect();
    assert(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, 'compact viewport bounds');
    buttons[0].click(); buttons[0].click(); await wait(60);
    assert(calls.length === 1 && calls[0].project === 'p_notes', 'single save to source project');
    assert(calls[0].ticket.status === 'todo' && calls[0].ticket.title === 'Plan a launch' && calls[0].ticket.description === originalBody.slice(0, 31), 'todo and multiline text');
    assert(ta.value === originalBody.slice(31) && document.querySelector('.notes') === ta, 'saved selection removed and view retained');
    await wait(550); assert(noteCalls.at(-1).body === originalBody.slice(31), 'removal autosaved');
    await resetNotes();
    ta = await select(36, ta.value.length);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert(document.activeElement === menu().querySelector('button'), 'Tab enters selection actions');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert(document.activeElement.textContent === 'In flight', 'arrow navigation');
    document.activeElement.click(); await wait(60);
    assert(calls[1].ticket.status === 'progress' && calls[1].ticket.description === 'Review the release', 'progress status');
    assert(ta.value === originalBody.slice(0, 36), 'in-progress move removes precisely its selection');
    await resetNotes();
    await select(32, 35); assert(!menu(), 'whitespace ignored');
    await select(0, 0); assert(!menu(), 'collapsed selection ignored');
    await select(0, 4); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(20); assert(!menu(), 'Escape dismisses');
    await select(0, 5); ta.dispatchEvent(new Event('scroll')); assert(!menu(), 'scroll dismisses');
    await select(0, 6); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); assert(!menu(), 'outside click dismisses');
    await select(0, 7); window.dispatchEvent(new Event('resize')); assert(!menu(), 'resize dismisses');
    await select(0, 8); menu().querySelector('button').click(); ta.value = originalBody + '\nA newer edit'; ta.dispatchEvent(new Event('input', { bubbles: true })); await wait(60);
    assert(ta.value.endsWith('A newer edit') && ta.value.startsWith('Plan a launch'), 'edits during task save are retained');
    await resetNotes();
    const beforeFailure = calls.length;
    await select(0, 8); failNext = true; menu().querySelector('button').click(); await wait(20);
    assert(menu() && !menu().querySelector('button').disabled && document.querySelector('.toasts').textContent.includes('Test save failure'), 'failed save retry');
    assert(ta.value === originalBody, 'failed task save does not remove notes');
    menu().querySelector('button').click(); await wait(60); assert(calls.length === beforeFailure + 2 && !menu(), 'retry succeeds');
    assert(ta.value === originalBody.slice(8), 'retry removes only after task success');
    await resetNotes();
    handlers.settings({ style: 'default' }); await wait(20); ta = await select(0, 9);
    assert(menu().getAttribute('aria-label') === 'Move to Next' && [...menu().querySelectorAll('button')].map(b => b.textContent).join('|') === 'Up next|In progress', 'default style labels');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true })); await wait(20);
    assert(!menu() && document.querySelector('.view-tickets'), 'view navigation dismisses');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, bubbles: true })); await wait(20);
    ta = await select(0, 10); menu().querySelector('button').click(); await wait(60);
    const opens = [...document.querySelectorAll('.toast button')].filter(b => b.textContent === 'Open'); opens.at(-1).click(); await wait(30);
    assert(document.querySelector('.tk-row.selected')?.textContent.includes('Plan a lau'), 'Open targets new task');
    handlers.settings({ layout: 'tracker' }); await wait(30);
    const trackerLogos = () => [...document.querySelectorAll('.tr-row > .agent-ic')];
    const checkLogos = () => {
      const logos = trackerLogos();
      assert(logos.length === 2 && logos.some(n => n.classList.contains('claude')) && logos.some(n => n.classList.contains('codex')), 'both agent logos in compact tracker');
      assert(logos.every(n => n.querySelector('svg path') && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width === 20), 'visible agent artwork at compact size');
      assert([...document.querySelectorAll('.tr-row .tr-proj')].every(n => getComputedStyle(n).display === 'none'), 'workspace icon hidden in compact rows');
      assert(logos.some(n => n.getAttribute('aria-label') === 'Claude Code') && logos.some(n => n.getAttribute('aria-label') === 'Codex'), 'accessible agent names');
    };
    checkLogos();
    [...document.querySelectorAll('.tr-head button')].find(b => b.textContent === 'Project').click(); await wait(30); checkLogos();
    handlers['window-mode']('expanded'); await wait(30);
    assert(trackerLogos().length === 0 && document.querySelectorAll('.tr-row .tr-agent').length === 2, 'expanded tracker retains existing agent labels');
    handlers['window-mode']('compact'); await wait(30); checkLogos();
    assert(errors.length === 0, 'no renderer errors: ' + errors.join(', '));
    const result = document.createElement('pre'); result.id = 'test-result'; result.textContent = 'PASS'; document.body.append(result);
  } catch (e) {
    const result = document.createElement('pre'); result.id = 'test-result'; result.textContent = 'FAIL: ' + e.stack; document.body.append(result);
  }
}

test('renderer: notes selection actions and compact tracker agent logos', { skip: !fs.existsSync(chrome), timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-notes-'));
  const store = new Store(path.join(dir, 'data'));
  store.event({ id: 'start', type: 'start', agent: 'claude', task: 'claude:notes', run: 'claude:run', project: 'p_notes', projectName: 'Notes test', projectPath: 'C:/demo/notes', title: 'Test notes', seq: 0, lifecycle: 'hooks' });
  store.event({ id: 'codex-start', type: 'start', agent: 'codex', task: 'codex:notes', run: 'codex:run', project: 'p_notes', projectName: 'Notes test', projectPath: 'C:/demo/notes', title: 'Review the checklist', seq: 0, lifecycle: 'hooks' });
  const body = 'Plan a launch\nKeep the checklist\n   \nReview the release';
  store.setNotes('p_notes', body, 0);
  store.setPlace('p_notes', { view: 'notes' });
  const state = store.state(), user = store.user('p_notes'); store.close();
  try {
    for (const name of ['app.css', 'app.js', 'brand-icons.js', 'logo.png']) fs.copyFileSync(path.join(root, 'src/renderer', name), path.join(dir, name));
    let html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link rel="stylesheet" href="https:[^>]*>/, '');
    html = html.replace('<script src="brand-icons.js"></script>', '<script src="mock.js"></script><script src="brand-icons.js"></script>');
    html = html.replace('</body>', '<script src="check.js"></script></body>');
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'mock.js'), `window.calls = []; window.noteCalls = []; window.handlers = {}; window.failNext = false; window.errors = []; window.originalBody = ${JSON.stringify(body)};
      window.addEventListener('error', e => errors.push(e.message));
      window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
      window.layover = {
        platform: 'win32', getState: async () => ({ok:true,value:${JSON.stringify(state)}}),
        getUser: async () => ({ok:true,value:${JSON.stringify(user)}}),
        getSettings: async () => ({ok:true,value:{onboarded:true,theme:'light',style:'flight',layout:'full',window:{mode:'compact',lastProject:'p_notes'}}}),
        getUpdate: async () => ({ok:true,value:null}), setPlace: async () => ({ok:true}), setSettings: async () => ({ok:true}), engaged: () => {},
        setNotes: async (project, body, revision) => {noteCalls.push({project,body,revision}); return {ok:true,value:{revision:revision+1}};},
        upsertTicket: async (project, ticket) => {
          calls.push({project,ticket});
          if (failNext) { failNext = false; return {ok:false,error:'Test save failure'}; }
          await new Promise(resolve => setTimeout(resolve, 30));
          return {ok:true,value:{...ticket,id:'t_'+calls.length,number:calls.length,priority:0,createdAt:Date.now(),updatedAt:Date.now()}};
        }, on: (name, fn) => {handlers[name] = fn; return () => {};}
      };`);
    fs.writeFileSync(path.join(dir, 'check.js'), '(' + checkSelection.toString() + ')();');
    const url = new URL('file:///' + path.join(dir, 'index.html').replaceAll('\\', '/')).href;
    const { stdout } = await run(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'chrome'), '--window-size=400,580', '--virtual-time-budget=7000', '--dump-dom', url], { windowsHide: true, timeout: 25000, maxBuffer: 2e6 });
    const result = stdout.match(/<pre id="test-result">([\s\S]*?)<\/pre>/)?.[1];
    assert.equal(result, 'PASS', result || 'Browser did not complete the checks');
  } finally {
    // This exact temporary directory was created by mkdtemp above.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
