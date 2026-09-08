// Installs the Layover skill and lifecycle hooks for Claude Code and Codex. Idempotent; preserves
// everything else in the user's files. Used by the app's onboarding and by `layover setup`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homeDir } from '../main/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_SOURCE = path.resolve(here, '..', '..', 'skills', 'layover', 'SKILL.md');
const MARK = 'layover'; // every hook command we own contains this and " hook "

export function claudeDir() { return process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude'); }
export function codexDir() { return process.env.CODEX_HOME || path.join(homeDir(), '.codex'); }
export function codexSkillsDir() { return path.join(homeDir(), '.agents', 'skills'); }

export function locations(agent) {
  if (agent === 'claude') return { skill: path.join(claudeDir(), 'skills', 'layover', 'SKILL.md'), hooks: path.join(claudeDir(), 'settings.json'), hooksKey: 'hooks' };
  if (agent === 'codex') return { skill: path.join(codexSkillsDir(), 'layover', 'SKILL.md'), hooks: path.join(codexDir(), 'hooks.json'), hooksKey: 'hooks' };
  throw Error('agent must be claude or codex');
}

/**
 * The command string agents run. Codex executes hooks in PowerShell on Windows (verified 2026-09-08);
 * Claude Code accepted a double-quoted path. An unquoted forward-slash path with no spaces works in
 * PowerShell, cmd and bash alike, so that is the preferred form; paths with spaces get shell-specific quoting.
 */
export function hookCommand(cliPath, agent) {
  const p = cliPath.replace(/\\/g, '/');
  if (!/[\s'"]/.test(p)) return `${p} hook ${agent}`;
  return agent === 'codex' ? `& '${p.replace(/'/g, "''")}' hook codex` : `"${p}" hook ${agent}`;
}

export function renderSkill(cliPath) {
  const text = fs.readFileSync(SKILL_SOURCE, 'utf8');
  return text.replaceAll('__CLI__', cliPath.replace(/\\/g, '/'));
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // a malformed file throws: we never overwrite what we cannot parse
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-layover';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function isOurs(h) { return h && typeof h.command === 'string' && /layover(\.cmd)?['"]? hook (claude|codex)\b/.test(h.command); }

function stripOurs(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) { out[event] = groups; continue; }
    const kept = groups.map(g => ({ ...g, hooks: Array.isArray(g.hooks) ? g.hooks.filter(h => !isOurs(h)) : g.hooks })).filter(g => !Array.isArray(g.hooks) || g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function hookSpec(agent, cmd) {
  const c = (extra = {}) => ({ hooks: [{ type: 'command', command: cmd, timeout: 20, ...extra }] });
  // Stop stays synchronous: it takes ~130 ms and an async hook can be killed when a non-interactive
  // session (codex exec, claude -p) exits right after the turn.
  if (agent === 'claude') return {
    SessionStart: [c({ matcher: 'startup|resume|clear' })],
    UserPromptSubmit: [c()],
    Stop: [c()],
    StopFailure: [c()],
    SessionEnd: [c()],
    Notification: [{ matcher: 'permission_prompt|idle_prompt|agent_needs_input|elicitation_dialog', hooks: [{ type: 'command', command: cmd, timeout: 20, async: true }] }],
  };
  return {
    SessionStart: [c()],
    UserPromptSubmit: [c()],
    Stop: [c()],
    Interrupt: [c({ timeout: 3 })],
    SessionEnd: [c({ timeout: 3 })],
  };
}

function mergeHooks(existing, spec) {
  const out = stripOurs(existing);
  for (const [event, groups] of Object.entries(spec)) out[event] = [...(out[event] || []), ...groups];
  return out;
}

export function status(agent, cliPath) {
  const loc = locations(agent);
  const skillInstalled = fs.existsSync(loc.skill);
  let skillCurrent = false;
  if (skillInstalled && cliPath) { try { skillCurrent = fs.readFileSync(loc.skill, 'utf8') === renderSkill(cliPath); } catch { /* unreadable */ } }
  let hooksInstalled = false, hooksCurrent = false, hooksError = '';
  try {
    const doc = readJson(loc.hooks);
    const all = Object.values(doc[loc.hooksKey] || {}).flat().flatMap(g => g?.hooks || []);
    hooksInstalled = all.some(isOurs);
    hooksCurrent = cliPath ? all.filter(isOurs).every(h => h.command === hookCommand(cliPath, agent)) && hooksInstalled : hooksInstalled;
  } catch (e) { hooksError = e.message; }
  return { agent, skillPath: loc.skill, hooksPath: loc.hooks, skillInstalled, skillCurrent, hooksInstalled, hooksCurrent, hooksError, connected: skillInstalled && hooksInstalled };
}

export function install(agent, cliPath, { hooks = true, skill = true } = {}) {
  if (!cliPath) throw Error('cliPath is required');
  const loc = locations(agent);
  const result = { agent, ...loc, wroteSkill: false, wroteHooks: false, notes: [] };
  if (skill) {
    fs.mkdirSync(path.dirname(loc.skill), { recursive: true });
    const body = renderSkill(cliPath);
    if (!fs.existsSync(loc.skill) || fs.readFileSync(loc.skill, 'utf8') !== body) { fs.writeFileSync(loc.skill, body); result.wroteSkill = true; }
  }
  if (hooks) {
    const doc = readJson(loc.hooks);
    doc[loc.hooksKey] = mergeHooks(doc[loc.hooksKey], hookSpec(agent, hookCommand(cliPath, agent)));
    writeJson(loc.hooks, doc);
    result.wroteHooks = true;
    if (agent === 'codex') result.notes.push('Codex asks you to trust new hooks once: run /hooks inside Codex and approve the Layover entries.');
    result.notes.push('Sessions already running pick up hooks and skills on their next start.');
  }
  return result;
}

/** Put the CLI folder on the user's PATH (Windows, HKCU only). SetEnvironmentVariable broadcasts the change. */
export function ensureUserPath(binDir) {
  if (process.platform !== 'win32') return { changed: false, reason: 'not windows' };
  const current = String(process.env.Path || process.env.PATH || '');
  const has = (p) => p.split(';').some(x => x.trim().toLowerCase() === binDir.toLowerCase());
  if (has(current)) return { changed: false, reason: 'already on PATH' };
  const script = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if(($p -split ';') -contains '${binDir.replace(/'/g, "''")}'){ 'present' } else { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';')) + ';' + '${binDir.replace(/'/g, "''")}').TrimStart(';'), 'User'); 'added' }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.status !== 0) return { changed: false, reason: (r.stderr || r.stdout || 'powershell failed').trim() };
  return { changed: r.stdout.trim() === 'added', reason: r.stdout.trim() };
}

export function remove(agent) {
  const loc = locations(agent);
  const result = { agent, removedSkill: false, removedHooks: false };
  if (fs.existsSync(loc.skill)) { fs.rmSync(path.dirname(loc.skill), { recursive: true, force: true }); result.removedSkill = true; }
  if (fs.existsSync(loc.hooks)) {
    const doc = readJson(loc.hooks);
    if (doc[loc.hooksKey]) { doc[loc.hooksKey] = stripOurs(doc[loc.hooksKey]); if (!Object.keys(doc[loc.hooksKey]).length) delete doc[loc.hooksKey]; writeJson(loc.hooks, doc); result.removedHooks = true; }
  }
  return result;
}
