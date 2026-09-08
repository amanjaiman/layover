import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LAYOVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-home-'));
delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
const setup = await import('../src/cli/setup.js');
const home = process.env.LAYOVER_HOME;
const cli = 'C:\\Users\\Some One\\AppData\\Local\\Programs\\Layover\\bin\\layover.cmd';

test('install writes skill + hooks for both agents, preserves other settings, and is idempotent', () => {
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const r = setup.install('claude', cli);
  assert.ok(r.wroteSkill && r.wroteHooks);
  const doc = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(doc.theme, 'dark');
  assert.equal(doc.hooks.Stop[0].hooks[0].command, 'echo mine');
  assert.ok(doc.hooks.Stop.some(g => g.hooks.some(h => h.command === `"${cli.replace(/\\/g, '/')}" hook claude`)));
  assert.equal(setup.hookCommand('C:\\Users\\amanj\\AppData\\Local\\Programs\\layover\\bin\\layover.cmd', 'codex'), 'C:/Users/amanj/AppData/Local/Programs/layover/bin/layover.cmd hook codex');
  assert.equal(setup.hookCommand(cli, 'codex'), "& 'C:/Users/Some One/AppData/Local/Programs/Layover/bin/layover.cmd' hook codex");
  assert.ok(doc.hooks.UserPromptSubmit && doc.hooks.SessionEnd && doc.hooks.Notification);
  const skill = fs.readFileSync(path.join(home, '.claude', 'skills', 'layover', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: layover/); assert.ok(!skill.includes('__CLI__')); assert.ok(skill.includes('Layover/bin/layover.cmd'));
  const r2 = setup.install('claude', cli);
  assert.equal(r2.wroteSkill, false);
  const doc2 = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(doc2.hooks.Stop.length, 2); // still one of ours, one theirs
  const st = setup.status('claude', cli);
  assert.ok(st.connected && st.skillCurrent && st.hooksCurrent);

  const c = setup.install('codex', cli);
  assert.ok(c.notes.some(n => /\/hooks/.test(n)));
  const hooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  assert.ok(hooks.hooks.Interrupt && hooks.hooks.Stop);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'layover', 'SKILL.md')));
});

test('a changed CLI path shows as not current, and remove leaves other hooks intact', () => {
  const st = setup.status('claude', 'D:/elsewhere/layover.cmd');
  assert.ok(st.connected && !st.hooksCurrent);
  const r = setup.remove('claude');
  assert.ok(r.removedSkill && r.removedHooks);
  const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(doc.hooks.Stop.length, 1);
  assert.equal(doc.hooks.UserPromptSubmit, undefined);
  assert.equal(setup.status('claude', cli).connected, false);
});

test('a malformed settings file is never overwritten', () => {
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, '{ not json');
  assert.throws(() => setup.install('claude', cli));
  assert.equal(fs.readFileSync(settings, 'utf8'), '{ not json');
  assert.match(setup.status('claude', cli).hooksError, /JSON/);
});
