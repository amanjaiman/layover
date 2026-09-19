// Tiny JSON HTTP surface over OrderStore. One handler, routed by method and path.
import http from 'node:http';
import { OrderStore } from './store.js';

export function createServer({ store = new OrderStore() } = {}) {
  const server = http.createServer(async (req, res) => {
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/orders') {
        return send(200, store.list({ customer: url.searchParams.get('customer') || undefined }));
      }
      if (req.method === 'GET' && /^\/orders\/[^/]+$/.test(url.pathname)) {
        const o = store.get(url.pathname.split('/')[2]);
        return o ? send(200, o) : send(404, { error: 'not found' });
      }
      if (req.method === 'POST' && url.pathname === '/orders') {
        let body = '';
        for await (const chunk of req) body += chunk;
        return send(201, store.create(JSON.parse(body || '{}')));
      }
      if (req.method === 'POST' && /^\/orders\/[^/]+\/close$/.test(url.pathname)) {
        return send(200, store.close(url.pathname.split('/')[2]));
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      send(400, { error: e.message });
    }
  });
  return { server, store, listen: (port) => new Promise(r => server.listen(port, '127.0.0.1', r)) };
}
