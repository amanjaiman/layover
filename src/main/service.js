// Loopback HTTP service used by the CLI and agent hooks. The renderer talks over IPC instead.
// Bearer token, Host and Origin checks; no CORS. Never executes agent text.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokenFile, dataRoot, port as defaultPort, PROTOCOL_VERSION, APP_ID } from './paths.js';

export function ensureToken() {
  fs.mkdirSync(dataRoot, { recursive: true });
  try { fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  return fs.readFileSync(tokenFile, 'utf8').trim();
}

/**
 * @param {object} o
 * @param {import('./store.js').Store} o.store
 * @param {object} [o.bridge]
 * @param {(ctx:object)=>Promise<object>} o.onOpen   app-level open/reveal handler
 * @param {(e:object, result:object)=>void} [o.onEvent]
 * @param {()=>object} [o.settings]
 */
export function createService({ store, bridge, onOpen, onEvent, settings = () => ({}), port = defaultPort, version = '0', pid = process.pid }) {
  const token = ensureToken();
  const server = http.createServer(async (req, res) => {
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin) return send(403, { error: 'Local origin required' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname === '/health') return send(200, { app: APP_ID, protocol: PROTOCOL_VERSION, version, pid });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized' });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, { ...store.state(), settings: publicSettings(settings()) , bindings: bridge?.bindings() || [], messages: bridge?.messages() || [] });
      if (req.method === 'GET' && url.pathname.startsWith('/api/open-status/')) return send(200, bridge?.opens?.get(url.pathname.slice('/api/open-status/'.length)) || { status: 'unknown' });
      if (req.method !== 'POST') return send(404, { error: 'Not found' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 262144) return send(413, { error: 'Payload too large' }); }
      const input = body ? JSON.parse(body) : {};
      switch (url.pathname) {
        case '/api/events': {
          const result = store.event(input);
          let open = null;
          if (onEvent) open = await onEvent(input, result);
          return send(200, { ...result, open });
        }
        case '/api/events/batch': {
          if (!Array.isArray(input) || input.length > 50) throw Error('Batch must be an array of at most 50 events');
          const results = [];
          for (const e of input) { try { const r = store.event(e); if (onEvent) r.open = await onEvent(e, r); results.push(r); } catch (err) { results.push({ error: err.message }); } }
          return send(200, { results });
        }
        case '/api/open': return send(200, await onOpen(input || {}));
        case '/api/stop': { send(200, { stopping: true }); setTimeout(() => process.emit('layover:stop'), 10); return; }
        case '/api/bind': return send(200, await bridge.bind(input));
        case '/api/target': return send(200, await bridge.target(input));
        case '/api/send': return send(200, await bridge.send(input));
        case '/api/ack': return send(200, bridge.ack(input));
        default: return send(404, { error: 'Not found' });
      }
    } catch (e) {
      send(400, { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, token, port, close: () => new Promise(r => server.close(r)) }));
  });
}

export function publicSettings(s) {
  // Only what the CLI needs to make decisions on the app's behalf.
  return { openOnRunStart: s.openOnRunStart, hookContext: s.hookContext };
}

export { tokenFile, path };
