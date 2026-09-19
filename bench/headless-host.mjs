#!/usr/bin/env node
// A headless stand-in for the Layover desktop app, for benchmarking only.
//
// It runs the real store and the real loopback HTTP service (src/main/service.js), so the CLI and
// the lifecycle hooks talk to exactly the surface they talk to in production. What it leaves out is
// the Electron window: nothing here draws, focuses, or binds a terminal. Agent-side cost — hook
// latency, `layover item` latency, injected context — is unchanged by that, and a GUI cannot run in
// a headless container.
//
//   LAYOVER_DATA=<dir> LAYOVER_PORT=<n> node bench/headless-host.mjs
//
// Prints one JSON line when the service is listening, then stays up until SIGINT/SIGTERM.
import fs from 'node:fs';
import { Store } from '../src/main/store.js';
import { createService } from '../src/main/service.js';
import { dataDir, dataRoot, port, settingsFile } from '../src/main/paths.js';

fs.mkdirSync(dataDir, { recursive: true });

// autoStart:false keeps the CLI from ever trying to spawn the real app; the service below answers
// /health, so the CLI treats Layover as running and takes the normal path.
const settings = { autoStart: false, openOnRunStart: 'quiet', hookContext: true };
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

const store = new Store(dataDir);
const service = await createService({
  store,
  bridge: null,
  onOpen: () => ({ status: 'headless' }),
  onEvent: () => null,
  settings: () => settings,
  port,
  version: 'headless',
});

process.stdout.write(JSON.stringify({ ready: true, port: service.port, data: dataRoot, pid: process.pid }) + '\n');

const stop = async () => { await service.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('layover:stop', stop);
