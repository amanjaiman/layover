// Render the landing page's link-preview image (site/og.png, 1200x630) from the page itself,
// so the card keeps the page's fonts, colors and boarding pass.
// Run: node scripts/og-image.mjs   (set CHROME to point at a Chrome or Chromium binary)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const dest = path.join(site, 'og.png');
const [W, H] = [1200, 630];
const chrome = process.env.CHROME
  || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');

// Only the headline and the boarding pass, laid out for the card, with the plane mid-route.
const card = `<style>
html,body{width:${W}px;height:${H}px;overflow:hidden}
html{scroll-behavior:auto}
.gatebar,.nav,.hero-side,body>:not(.hero):not(script){display:none!important}
.hero{padding:0;height:${H}px;display:flex;align-items:center}
.hero .wrap{width:100%;max-width:none;padding:0 72px}
.hero-top{display:block;margin-bottom:44px}
.hero h1{font-size:68px}
.tix{--route:84px}
.tix-route{margin:28px 0 30px}
#plane{left:58%!important;animation:none!important}
</style>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtools(profile) {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file)) {
      const port = fs.readFileSync(file, 'utf8').split('\n')[0];
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    }
    await sleep(100);
  }
  throw Error('Chrome did not open a DevTools port');
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map(), waiters = [];
  let id = 0;
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const w of waiters.filter((w) => w.method === msg.method)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
    }
  };
  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(Error('Could not reach Chrome'));
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        pending.set(++id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      once: (method) => new Promise((res) => waiters.push({ method, resolve: res })),
      close: () => ws.close(),
    });
  });
}

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-og-'));
const profile = path.join(data, 'chrome');
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-color-profile=srgb', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
try {
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8').replace('</head>', `${card}\n</head>`);
  fs.writeFileSync(path.join(data, 'index.html'), html);
  fs.copyFileSync(path.join(site, 'logo.png'), path.join(data, 'logo.png'));

  const cdp = await connect(await devtools(profile));
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  // Light theme, and reduced motion so the pass holds still on Working.
  await cdp.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: new URL(`file:///${path.join(data, 'index.html').replaceAll('\\', '/')}`).href });
  await loaded;
  const fonts = await cdp.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
    expression: 'document.fonts.ready.then(() => document.fonts.check("500 68px Familjen Grotesk"))' });
  if (!fonts.result.value) throw Error('Familjen Grotesk did not load; check the network');
  await sleep(300);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  fs.writeFileSync(dest, Buffer.from(shot.data, 'base64'));
  cdp.close();
  console.log(`Wrote ${path.relative(root, dest)}`);
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* Chrome may still be releasing its profile. */ }
}
