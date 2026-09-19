#!/usr/bin/env node
// Measures what Layover costs an agent: latency, tokens and turns for the same task run with the
// Layover skill + lifecycle hooks connected and with nothing connected at all.
//
// Every run is a fresh headless Claude Code process on a fresh copy of bench/fixture, with an
// isolated CLAUDE_CONFIG_DIR so the only difference between the two conditions is Layover itself.
// Conditions are interleaved and their order alternates per repetition, so drift in API latency
// falls on both sides equally.
//
//   node bench/bench.mjs --reps 3 --model sonnet
//   node bench/bench.mjs --probe-only          # just the static prompt-overhead probe
//
// Writes bench/results/runs.jsonl and bench/results/summary.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

function parseArgs(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n !== undefined && !n.startsWith('--')) { f[k] = n; i++; } else f[k] = true;
  }
  return f;
}
const args = parseArgs(process.argv.slice(2));
const REPS = Number(args.reps || 3);
const PROBE_REPS = Number(args['probe-reps'] || 4);
const MODEL = String(args.model || 'sonnet');
const WORK = path.resolve(args.work || path.join(os.tmpdir(), 'layover-bench'));
const OUT = path.join(here, 'results');
const TIMEOUT_MS = Number(args.timeout || 900000);
const CONDITIONS = ['off', 'on'];

const tasks = JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf8'));
const layoverData = path.join(WORK, 'layover-data');
const layoverPort = Number(args.port || 43155);
const cliPath = path.join(repo, 'bin', 'layover');

fs.mkdirSync(OUT, { recursive: true });
const runsFile = path.join(OUT, 'runs.jsonl');

// ---------------------------------------------------------------- environment

function sh(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out) : reject(Error(`${cmd} exited ${code}: ${err || out}`)));
  });
}

/** Start the headless Layover service (real store, real HTTP surface, no Electron window). */
async function startHost() {
  fs.rmSync(layoverData, { recursive: true, force: true });
  const env = { ...process.env, LAYOVER_DATA: layoverData, LAYOVER_PORT: String(layoverPort) };
  const p = spawn(process.execPath, [path.join(here, 'headless-host.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error('headless host did not start')), 15000);
    p.stdout.once('data', () => { clearTimeout(t); resolve(); });
    p.on('error', reject);
  });
  return p;
}

async function layoverState() {
  const token = fs.readFileSync(path.join(layoverData, 'token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${layoverPort}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
}

/**
 * One isolated Claude Code config dir per condition. 'off' is empty; 'on' is what
 * `layover setup --agent claude` writes — the skill plus the lifecycle hooks, nothing else.
 */
async function makeConfigDir(condition) {
  const dir = path.join(WORK, 'config-' + condition);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (condition === 'on') {
    await sh(process.execPath, [path.join(repo, 'src', 'cli', 'layover.js'), 'setup', '--agent', 'claude', '--cli', cliPath], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir, LAYOVER_DATA: layoverData, LAYOVER_PORT: String(layoverPort) },
    });
    const settings = path.join(dir, 'settings.json');
    if (!fs.existsSync(settings)) throw Error('layover setup wrote no hooks');
  }
  return dir;
}

/** Flip Settings -> hookContext on disk; the CLI reads it fresh on every hook call. */
function setHookContext(on) {
  const f = path.join(layoverData, 'settings.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.hookContext = on;
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
}

function makeWorkspace(label) {
  const dir = path.join(WORK, 'ws', label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(path.join(here, 'fixture'), dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- one run

/** Run a prompt headlessly and return the wall clock plus everything Claude Code reports about it. */
function runAgent({ prompt, cwd, configDir, sessionId }) {
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    LAYOVER_DATA: layoverData,
    LAYOVER_PORT: String(layoverPort),
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  const argv = [
    '-p', prompt,
    '--model', MODEL,
    '--output-format', 'stream-json',
    '--verbose',
    '--session-id', sessionId,
    '--permission-mode', 'acceptEdits',
    // Named rather than bypassed: --dangerously-skip-permissions refuses to run as root, and an
    // explicit list keeps both conditions on identical permission handling.
    '--allowedTools', 'Bash,Read,Edit,Write,MultiEdit,Glob,Grep,TodoWrite,Skill',
  ];
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const p = spawn('claude', argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', stderr = '';
    const events = [];
    const killer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
    p.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { events.push(JSON.parse(line)); } catch { /* not a JSON frame */ } }
      }
    });
    p.stderr.on('data', d => { stderr += d; });
    p.on('close', (code) => {
      clearTimeout(killer);
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ code, wallMs, events, stderr: stderr.slice(-4000) });
    });
  });
}

// An actual invocation of the CLI, not merely the word: a workspace path can contain "layover".
export const LAYOVER_CALL = /(^|[\s;&|(])(\S*[/\\])?layover(\.cmd)?\s+(item|begin|end|open|event|heartbeat|state|status)\b/;

/** Tool calls the agent made, by tool name, plus the Layover CLI calls among the Bash ones. */
export function toolStats(events) {
  const byTool = {};
  const layoverCommands = [];
  for (const e of events) {
    const content = e?.message?.content;
    if (e.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      byTool[block.name] = (byTool[block.name] || 0) + 1;
      const cmd = String(block.input?.command || '');
      if (block.name === 'Bash' && LAYOVER_CALL.test(cmd)) layoverCommands.push(cmd.slice(0, 300));
    }
  }
  return { byTool, total: Object.values(byTool).reduce((a, b) => a + b, 0), layoverCalls: layoverCommands.length, layoverCommands };
}

function metricsFrom(result) {
  const u = result?.usage || {};
  const input = u.input_tokens || 0;
  const cacheCreate = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const output = u.output_tokens || 0;
  return {
    duration_ms: result?.duration_ms ?? null,
    duration_api_ms: result?.duration_api_ms ?? null,
    ttft_ms: result?.ttft_ms ?? null,
    num_turns: result?.num_turns ?? null,
    input_tokens: input,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    thinking_tokens: u.output_tokens_details?.thinking_tokens || 0,
    prompt_tokens: input + cacheCreate + cacheRead,
    total_tokens: input + cacheCreate + cacheRead + output,
    total_cost_usd: result?.total_cost_usd ?? null,
    is_error: !!result?.is_error,
    subtype: result?.subtype ?? null,
  };
}

async function record(row) {
  fs.appendFileSync(runsFile, JSON.stringify(row) + '\n');
  const m = row.metrics || {};
  console.log(
    `  ${row.kind.padEnd(5)} ${row.condition.padEnd(3)} ${String(row.task).padEnd(12)} rep${row.rep}  ` +
    `wall ${Math.round(row.wall_ms).toString().padStart(6)}ms  api ${String(m.duration_api_ms).padStart(6)}ms  ` +
    `turns ${String(m.num_turns).padStart(3)}  prompt ${String(m.prompt_tokens).padStart(7)}  out ${String(m.output_tokens).padStart(5)}  ` +
    `tools ${String(row.tools?.total ?? 0).padStart(3)}  layover ${row.tools?.layoverCalls ?? 0}  items ${row.layover_items ?? 0}`
  );
}

// ---------------------------------------------------------------- suites

/**
 * Static overhead probe: an identical trivial prompt in both conditions. Nothing about the work
 * differs, so the difference in prompt tokens is exactly what Layover adds to a turn before the
 * agent does anything — the skill's entry in the system prompt plus the hook's injected line.
 */
async function probeSuite(configDirs) {
  console.log('\nStatic prompt-overhead probe (identical trivial prompt):');
  const prompt = 'Reply with exactly: OK';
  // 'on-nohook' is the connected agent with Settings -> hookContext turned off: the skill is still
  // installed, but the UserPromptSubmit hook prints nothing into context. It splits the overhead
  // into the part the skill costs and the part the per-turn hook line costs.
  const variants = args['no-decompose'] ? CONDITIONS : [...CONDITIONS, 'on-nohook'];
  for (let rep = 1; rep <= PROBE_REPS; rep++) {
    const order = rep % 2 === 1 ? variants : [...variants].reverse();
    for (const variant of order) {
      const condition = variant === 'on-nohook' ? 'on' : variant;
      setHookContext(variant !== 'on-nohook');
      const label = `probe-${variant}-${rep}`;
      const cwd = makeWorkspace(label);
      const before = condition === 'on' ? await layoverState() : null;
      const r = await runAgent({ prompt, cwd, configDir: configDirs[condition], sessionId: crypto.randomUUID() });
      const result = r.events.find(e => e.type === 'result');
      const after = condition === 'on' ? await layoverState() : null;
      await record({
        kind: 'probe', condition: variant, task: 'trivial', rep, wall_ms: r.wallMs, exit_code: r.code, workspace: cwd,
        metrics: metricsFrom(result), tools: toolStats(r.events),
        layover_items: after ? after.items.length - before.items.length : 0,
        layover_runs: after ? after.runs.length - before.runs.length : 0,
        stderr: r.stderr || undefined,
      });
    }
  }
}

/** The real workload: the same coding tasks, both conditions, interleaved. */
async function taskSuite(configDirs) {
  console.log('\nTask suite:');
  for (let rep = 1; rep <= REPS; rep++) {
    for (const task of tasks) {
      const order = rep % 2 === 1 ? CONDITIONS : [...CONDITIONS].reverse();
      for (const condition of order) {
        const label = `${task.id}-${condition}-${rep}`;
        const cwd = makeWorkspace(label);
        const before = condition === 'on' ? await layoverState() : null;
        const r = await runAgent({ prompt: task.prompt, cwd, configDir: configDirs[condition], sessionId: crypto.randomUUID() });
        const result = r.events.find(e => e.type === 'result');
        const after = condition === 'on' ? await layoverState() : null;
        const items = after ? after.items.slice(before.items.length) : [];
        await record({
          kind: 'task', condition, task: task.id, rep, wall_ms: r.wallMs, exit_code: r.code,
          metrics: metricsFrom(result), tools: toolStats(r.events),
          layover_items: items.length,
          layover_item_kinds: items.map(i => i.kind),
          layover_runs: after ? after.runs.length - before.runs.length : 0,
          workspace: cwd,
          stderr: r.stderr || undefined,
        });
      }
    }
  }
}

/** Cost of the Layover CLI itself, measured directly rather than through the agent. */
async function cliSuite() {
  console.log('\nLayover CLI latency (subprocess, measured directly):');
  const env = { ...process.env, LAYOVER_DATA: layoverData, LAYOVER_PORT: String(layoverPort) };
  const time = async (fn) => { const s = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - s) / 1e6; };
  // node_baseline and client_request bound the CLI numbers from below: how much of a call is Node
  // starting up and issuing one loopback request, and how much is Layover's own work.
  const samples = { hook_UserPromptSubmit: [], hook_Stop: [], item: [], hook_PostToolUse_fast: [], node_baseline: [], client_request: [] };
  const hook = (payload) => new Promise((resolve, reject) => {
    const p = spawn(cliPath, ['hook', 'claude'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout.resume(); p.stderr.resume();
    p.on('error', reject);
    p.on('close', () => resolve());
    p.stdin.end(JSON.stringify(payload));
  });
  const fastHook = (payload) => new Promise((resolve, reject) => {
    const p = spawn(path.join(repo, 'bin', 'layover-fast'), ['hook', 'claude'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout.resume(); p.stderr.resume();
    p.on('error', reject);
    p.on('close', () => resolve());
    p.stdin.end(JSON.stringify(payload));
  });
  for (let i = 0; i < 10; i++) {
    const session = `cli-bench-${i}`;
    const cwd = path.join(WORK, 'ws');
    samples.hook_UserPromptSubmit.push(await time(() => hook({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt: 'Add pagination to the orders endpoint.', prompt_id: 't1' })));
    samples.hook_PostToolUse_fast.push(await time(() => fastHook({ hook_event_name: 'PostToolUse', session_id: session, cwd, prompt_id: 't1' })));
    samples.item.push(await time(() => sh(cliPath, ['item', '--run', `claude:${session}:t1`, '--kind', 'decision', '--text', 'Chose cursor pagination over offset; continuing.'], { env })));
    samples.hook_Stop.push(await time(() => hook({ hook_event_name: 'Stop', session_id: session, cwd, prompt_id: 't1' })));
    samples.node_baseline.push(await time(() => sh(process.execPath, ['-e', ''], { env })));
    samples.client_request.push(await time(() => sh(process.execPath, ['-e',
      `import(${JSON.stringify(path.join(repo, 'src', 'cli', 'client.js'))}).then(m => m.request('/api/state'))`], { env })));
  }
  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return { n: s.length, mean: +(s.reduce((p, c) => p + c, 0) / s.length).toFixed(1), median: +s[Math.floor(s.length / 2)].toFixed(1), min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1) };
  };
  const out = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stat(v)]));
  for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(24)} median ${v.median} ms  (mean ${v.mean}, ${v.min}–${v.max})`);
  return out;
}

// ---------------------------------------------------------------- main

const host = await startHost();
try {
  const configDirs = {};
  for (const c of CONDITIONS) configDirs[c] = await makeConfigDir(c);
  console.log(`model=${MODEL}  reps=${REPS}  work=${WORK}`);
  console.log(`config off=${configDirs.off}  on=${configDirs.on}`);

  const cli = args['no-cli'] ? null : await cliSuite();
  if (!args['no-probe']) await probeSuite(configDirs);
  setHookContext(true); // the task suite always runs with Layover's default settings
  if (!args['probe-only']) await taskSuite(configDirs);

  const state = await layoverState();
  fs.writeFileSync(path.join(OUT, 'layover-state.json'), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
    model: MODEL, reps: REPS, probeReps: PROBE_REPS, tasks: tasks.map(t => t.id),
    claudeVersion: (await sh('claude', ['--version'])).trim(),
    node: process.version, platform: process.platform, at: new Date().toISOString(), cli,
  }, null, 2));
  console.log(`\nWrote ${runsFile}`);
} finally {
  host.kill('SIGTERM');
}
