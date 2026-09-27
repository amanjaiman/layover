// Capture README images from a disposable, illustrative workspace.
// Run: node scripts/capture-readme.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/main/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome';
if (process.platform === 'win32' && !fs.existsSync(chrome)) throw Error('Chrome is required to capture screenshots');
fs.mkdirSync(out, { recursive: true });

const specs = [
  { name: 'now.png', view: 'now', layout: 'full', style: 'default', mode: 'expanded' },
  { name: 'next.png', view: 'tickets', layout: 'full', style: 'default', mode: 'expanded' },
  { name: 'tracker.png', view: 'now', layout: 'tracker', style: 'default', mode: 'expanded' },
  { name: 'flight.png', view: 'now', layout: 'tracker', style: 'flight', mode: 'expanded' },
  { name: 'compact.png', view: 'now', layout: 'full', style: 'default', mode: 'compact' },
];

async function capture(spec) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-readme-'));
  const store = new Store(path.join(data, 'data'));
  const project = 'p_sample';
  const second = 'p_docs';
  const start = (agent, task, run, title, projectId, projectName) => {
    store.event({ id: `start:${run}`, type: 'start', agent, task, run, project: projectId, projectName,
      projectPath: `C:/demo/${projectName.toLowerCase()}`, seq: 0, lifecycle: 'hooks', title });
  };
  const item = (agent, task, run, id, kind, message, waiting = false) => {
    store.event({ id: `item:${id}`, type: 'item', agent, task, run, project, seq: 1, item: id,
      kind, status: 'open', revision: 1, text: message, waiting });
  };
  start('codex', 'codex:sample', 'run:sample', 'Refresh the product overview', project, 'Atlas', 0);
  item('codex', 'codex:sample', 'run:sample', 'decision', 'decision', 'Use a short overview with current app screenshots.');
  item('codex', 'codex:sample', 'run:sample', 'question', 'question', 'Which workflow should the first example show?', true);
  start('claude', 'claude:review', 'run:review', 'Review onboarding copy', project, 'Atlas', 0);
  store.event({ id: 'end:review', type: 'end', agent: 'claude', task: 'claude:review', run: 'run:review', project,
    seq: 2, status: 'completed' });
  start('claude', 'claude:docs', 'run:docs', 'Check release notes', second, 'Docs', 0);
  store.event({ id: 'end:docs', type: 'end', agent: 'claude', task: 'claude:docs', run: 'run:docs', project: second,
    seq: 2, status: 'completed' });
  store.setProjectMeta(project, { color: 'teal', prefix: 'ATL' });
  store.setProjectMeta(second, { color: 'gold', prefix: 'DOC' });
  const t1 = store.upsertTicket(project, { title: 'Update the welcome flow', status: 'progress', priority: 3,
    description: 'Make the first run clear for both Claude Code and Codex.', prompt: 'Review the first-run flow and improve the setup copy.' });
  store.upsertTicket(project, { title: 'Add keyboard shortcut tips', status: 'todo', priority: 2,
    prompt: 'Add concise shortcut tips to the help sheet.' });
  store.upsertTicket(project, { title: 'Explore a weekly recap', status: 'backlog', priority: 1 });
  store.setPlace(project, { view: spec.view, ticket: spec.view === 'tickets' ? t1.id : null });
  const state = store.state();
  const users = { [project]: store.user(project), [second]: store.user(second) };
  store.close();
  const settings = { onboarded: true, theme: 'light',
    updates: { check: false }, layout: spec.layout, style: spec.style, closeToTray: false,
    window: { mode: spec.mode, lastProject: project, bounds: { expanded: { width: 1120, height: 740 }, compact: { width: 400, height: 580 } } } };
  const renderer = path.join(root, 'src', 'renderer');
  for (const name of ['app.css', 'app.js', 'brand-icons.js', 'logo.png']) fs.copyFileSync(path.join(renderer, name), path.join(data, name));
  let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  html = html.replace('<script src="brand-icons.js"></script>', '<script src="mock.js"></script><script src="brand-icons.js"></script>');
  fs.writeFileSync(path.join(data, 'index.html'), html);
  fs.writeFileSync(path.join(data, 'mock.js'), `window.layover = {
    platform: 'win32',
    getState: async () => ({ ok: true, value: ${JSON.stringify(state)} }),
    getUser: async id => ({ ok: true, value: (${JSON.stringify(users)})[id] }),
    getSettings: async () => ({ ok: true, value: ${JSON.stringify(settings)} }),
    getUpdate: async () => ({ ok: true, value: null }),
    setPlace: async () => ({ ok: true }),
    engaged: () => {},
    on: () => () => {},
  };`);
  const dest = path.join(out, spec.name);
  fs.rmSync(dest, { force: true });
  const size = spec.mode === 'compact' ? [400, 580] : [1120, 740];
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${path.join(data, 'chrome')}`, `--window-size=${size.join(',')}`,
    '--virtual-time-budget=5000', `--screenshot=${dest}`, new URL(`file:///${path.join(data, 'index.html').replaceAll('\\', '/')}`).href], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const until = Date.now() + 20000;
    while (!fs.existsSync(dest)) {
      if (Date.now() > until || child.exitCode !== null) throw Error(`Screenshot failed: ${spec.name}\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    console.log(`${spec.name}: ${fs.statSync(dest).size} bytes`);
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
    try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* Chrome may still be releasing its profile. */ }
  }
}

for (const spec of specs) await capture(spec);
