#!/usr/bin/env node
// Layover CLI. Runs under plain Node or under the packaged app's own runtime (ELECTRON_RUN_AS_NODE).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectIdFromPath, projectNameFromPath, isId, APP_NAME } from '../main/paths.js';
import { request, health, ensureApp, launch, deliver, readSettings, appLauncher } from './client.js';
import { mapHook, resolveLatest } from './hook.js';
import * as setup from './setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The command agents should call. Packaged: <install>/bin/layover.cmd. Dev: <repo>/bin/layover.cmd. */
export function cliCommandPath() {
  if (process.env.LAYOVER_CLI) return process.env.LAYOVER_CLI;
  const packagedRoot = path.resolve(here, '..', '..', '..');
  const packaged = path.join(packagedRoot, 'bin', process.platform === 'win32' ? 'layover.cmd' : 'layover');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(path.resolve(here, '..', '..'), 'bin', process.platform === 'win32' ? 'layover.cmd' : 'layover');
}

const HELP = `${APP_NAME} CLI

Usage: layover <command> [--option value ...]

  open [--path DIR | --project ID] [--task ID] [--run ID]   Reveal the app for a workspace (no focus steal).
  begin --agent claude|codex --path DIR [--title T] [--task ID] [--open]
                                    Start a run for voluntary (non-hook) sessions. Prints ids.
  item --run ID --kind decision|question|opportunity|suggestion --text T
       [--item ID] [--revision N] [--status open|resolved|dismissed] [--title T] [--waiting]
  end --run ID --status completed|failed|cancelled|unknown [--note T]
  heartbeat --run ID
  event --file PATH | -             Post one raw JSON event (or a JSON array).
  state                             Print the app state as JSON.
  status                            Is the app running? Are agents connected?
  setup --agent claude|codex|all [--remove] [--no-hooks] [--no-skill]
  app                               Launch the app window.
  stop                              Ask the running app to quit.
  hook claude|codex                 Internal: called by agent lifecycle hooks with JSON on stdin.
  bind|target|send|ack              Codex write-back (see docs/CAPABILITIES.md).

Environment: LAYOVER_DATA, LAYOVER_PORT, LAYOVER_EXE, LAYOVER_CLI.`;

function parse(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function readStdin(ms = 3000) {
  return new Promise(resolve => {
    let data = '';
    const t = setTimeout(() => resolve(data), ms);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => { data += c; });
      process.stdin.on('end', () => { clearTimeout(t); resolve(data); });
      process.stdin.on('error', () => { clearTimeout(t); resolve(data); });
    } catch { clearTimeout(t); resolve(data); }
  });
}

function out(v) { process.stdout.write(JSON.stringify(v) + '\n'); }

async function runHook(agent) {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.stderr.write('layover hook: stdin was not JSON\n'); return; }
  const settings = readSettings();
  // Once per session, remember which window the agent lives in so "Return" can bring it forward.
  let host = null;
  if (input?.hook_event_name === 'SessionStart') { try { const { findHostWindow } = await import('./host.js'); host = findHostWindow(); } catch { host = null; } }
  const { events, context, open } = mapHook(agent, input, { hookContext: settings.hookContext !== false, host });
  if (!events.length) return;
  const isStart = events.some(e => e.type === 'start');
  const wantsWindow = isStart && ['focus', 'open'].includes(settings.openOnRunStart || 'focus');
  let status = await health() ? 'running' : null;
  if (!status) {
    if (settings.autoStart === false) status = 'unavailable';
    else { const r = await launch({ background: !wantsWindow, open: wantsWindow ? open : null }); status = r.launched ? 'launched' : 'unavailable'; }
  }
  let ready = events;
  if (status === 'unavailable') { const { spool } = await import('./client.js'); spool(events); if (context) process.stdout.write(context + '\n'); return; }
  if (events.some(e => e.run === '__latest__')) {
    const state = await request('/api/state');
    ready = resolveLatest(events, state);
    if (!ready.length) return;
  }
  const { results } = await request('/api/events/batch', ready, 8000);
  for (const r of results) if (r.error) process.stderr.write('layover: ' + r.error + '\n');
  if (context) process.stdout.write(context + '\n');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parse(rest);
  if (!command || command === 'help' || command === '--help' || command === '-h') { console.log(HELP); return; }

  if (command === 'hook') { await runHook(positional[0] || flags.agent); return; }

  if (command === 'setup') {
    const cli = flags.cli || cliCommandPath();
    const agents = flags.agent === 'all' || !flags.agent ? ['claude', 'codex'] : [flags.agent];
    const results = [];
    for (const a of agents) results.push(flags.remove ? setup.remove(a) : setup.install(a, cli, { hooks: !flags['no-hooks'], skill: !flags['no-skill'] }));
    for (const r of results) { console.log(`${r.agent}: ${flags.remove ? 'removed' : 'installed'}  skill → ${r.skill || r.skillPath || ''}${r.hooks ? `\n  hooks → ${r.hooks}` : ''}`); for (const n of r.notes || []) console.log('  note: ' + n); }
    return;
  }

  if (command === 'status') {
    const h = await health();
    const cli = cliCommandPath();
    out({ app: h ? { running: true, ...h } : { running: false, launcher: appLauncher() }, cli, claude: setup.status('claude', cli), codex: setup.status('codex', cli) });
    return;
  }

  if (command === 'app') { const r = await ensureApp({ open: {}, background: false }); if (r === 'running') await request('/api/open', {}); out({ app: r }); return; }
  if (command === 'stop') { if (!(await health())) { out({ running: false }); return; } out(await request('/api/stop', {})); return; }
  if (command === 'state') { await must(); out(await request('/api/state')); return; }
  if (command === 'path') { console.log(cliCommandPath()); return; }

  if (command === 'open') {
    const ctx = context(flags, { allowEmpty: true });
    const r = await ensureApp({ open: ctx, background: false });
    if (r === 'unavailable') throw Error('Layover could not be started.');
    if (r === 'running') out({ ...(await request('/api/open', ctx)), app: r }); else out({ app: r, opened: ctx });
    return;
  }

  if (command === 'begin') {
    if (!['claude', 'codex', 'test'].includes(flags.agent)) throw Error('--agent claude|codex is required');
    const dir = path.resolve(flags.path || process.cwd());
    const project = flags.project || projectIdFromPath(dir);
    const task = flags.task || `${flags.agent}:v_${crypto.randomUUID()}`;
    const run = flags.run || `${task}:${Date.now().toString(36)}`;
    const base = { project, task, agent: flags.agent, projectName: flags['project-name'] || projectNameFromPath(dir), projectPath: dir };
    const source = flags.source || `${{ claude: 'Claude Code', codex: 'Codex' }[flags.agent] || 'Agent'} session in ${dir}`;
    const events = [
      { ...base, id: crypto.randomUUID(), type: 'session', name: flags.title || base.projectName, source },
      { ...base, id: crypto.randomUUID(), type: 'start', run, seq: 0, title: flags.title || 'Working', source, lifecycle: 'voluntary' },
    ];
    const settings = readSettings();
    const wantsWindow = !!flags.open || ['focus', 'open'].includes(settings.openOnRunStart || 'focus');
    const r = await deliver(events, { open: wantsWindow ? { project, task, run, reason: 'run-start' } : null, background: !wantsWindow });
    if (r.status === 'unavailable') throw Error('Layover could not be started; events were saved for its next launch.');
    const err = r.results.find(x => x.error); if (err) throw Error(err.error);
    if (flags.open && r.status === 'running') await request('/api/open', { project, task, run, reason: 'run-start' });
    out({ project, task, run, app: r.status });
    return;
  }

  if (['item', 'end', 'heartbeat', 'start'].includes(command)) {
    if (!flags.run || !isId(flags.run)) throw Error('--run ID is required (use the id printed by begin or given by the hook context)');
    const state = await (async () => { const s = await deliverState(); return s; })();
    const run = state.runs.find(r => r.id === flags.run);
    let base;
    if (run) base = { project: run.project, task: run.task, agent: run.agent };
    else if (command === 'start' && flags.project && flags.task && flags.agent) base = { project: flags.project, task: flags.task, agent: flags.agent };
    else throw Error(`Unknown run "${flags.run}". Use the id from the hook context, or start one with: layover begin`);
    const e = { ...base, id: flags['event-id'] || crypto.randomUUID(), type: command, run: flags.run, seq: Number(flags.seq || Date.now()) };
    if (command === 'start') Object.assign(e, { title: flags.title, source: flags.source, lifecycle: flags.lifecycle || 'voluntary', projectName: flags['project-name'], projectPath: flags.path });
    if (command === 'item') {
      if (typeof flags.text !== 'string') throw Error('--text is required');
      Object.assign(e, { item: flags.item || 'i_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), text: flags.text, kind: flags.kind || 'suggestion', revision: Number(flags.revision || 1), status: flags.status || 'open' });
      if (flags.title) e.title = flags.title;
      if (flags.waiting) e.waiting = true;
    }
    if (command === 'end') { e.status = flags.status || 'completed'; if (flags.note) e.note = flags.note; }
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const r = await request('/api/events', e);
    out({ ...r, run: e.run, item: e.item, revision: e.revision });
    return;
  }

  if (command === 'event') {
    const raw = flags.file === '-' || !flags.file ? await readStdin(10000) : fs.readFileSync(flags.file, 'utf8');
    const parsed = JSON.parse(raw);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const r = await deliver(events, { background: true });
    out(r);
    if (r.results.some(x => x.error)) process.exitCode = 1;
    return;
  }

  if (command === 'bind') { await must(); out(await request('/api/bind', { run: flags.run, thread: flags.thread, endpoint: flags.endpoint, turn: flags.turn }, 40000)); return; }
  if (command === 'target') { await must(); out(await request('/api/target', { run: flags.run }, 40000)); return; }
  if (command === 'ack') { await must(); out(await request('/api/ack', { id: flags.id, run: flags.run, thread: flags.thread })); return; }
  if (command === 'send') {
    await must();
    const r = await request('/api/send', { id: flags.id || crypto.randomUUID(), run: flags.run, thread: flags.thread, expectedTurnId: flags.turn, text: flags.file ? fs.readFileSync(flags.file, 'utf8') : flags.text }, 40000);
    out(r); if (['failed', 'unknown'].includes(r.status)) process.exitCode = 1; return;
  }

  throw Error(`Unknown command "${command}". Run: layover help`);
}

function context(flags, { allowEmpty = false } = {}) {
  const ctx = {};
  if (flags.path) { const dir = path.resolve(flags.path); ctx.project = projectIdFromPath(dir); ctx.projectName = projectNameFromPath(dir); ctx.projectPath = dir; }
  if (flags.project) ctx.project = flags.project;
  if (flags.task) ctx.task = flags.task;
  if (flags.run) ctx.run = flags.run;
  if (!ctx.project && !allowEmpty) throw Error('--path DIR or --project ID is required');
  return ctx;
}

async function must() { const r = await ensureApp({ background: true }); if (r === 'unavailable') throw Error('Layover is not running and could not be started.'); }
async function deliverState() { await must(); return request('/api/state'); }

main().catch(e => { process.stderr.write(`layover: ${e.message}\n`); process.exitCode = 1; });
