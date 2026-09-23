import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LAYOVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'layover-home-'));
delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
const setup = await import('../src/cli/setup.js');
const home = process.env.LAYOVER_HOME;
// Hook commands are shell-specific: cmd/PowerShell quoting on Windows, sh quoting elsewhere. Each
// platform checks its own, with a space in the path so the quoting is exercised.
const win = process.platform === 'win32';
const cli = win ? 'C:\\Users\\Some One\\AppData\\Local\\Programs\\Layover\\bin\\layover.cmd' : '/Users/Some One/Applications/Layover.app/Contents/bin/layover';
const quoted = (p) => win ? `"${p.replace(/\\/g, '/')}"` : `'${p}'`;

test('install writes skill + hooks for both agents, preserves other settings, and is idempotent', () => {
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const r = setup.install('claude', cli);
  assert.ok(r.wroteSkill && r.wroteHooks);
  const doc = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(doc.theme, 'dark');
  assert.equal(doc.hooks.Stop[0].hooks[0].command, 'echo mine');
  assert.ok(doc.hooks.Stop.some(g => g.hooks.some(h => h.command === `${quoted(cli)} hook claude`)));
  if (win) {
    assert.equal(setup.hookCommand('C:\\Users\\amanj\\AppData\\Local\\Programs\\layover\\bin\\layover.cmd', 'codex'), 'C:/Users/amanj/AppData/Local/Programs/layover/bin/layover.cmd hook codex');
    assert.equal(setup.hookCommand(cli, 'codex'), "& 'C:/Users/Some One/AppData/Local/Programs/Layover/bin/layover.cmd' hook codex");
  } else {
    assert.equal(setup.hookCommand('/Applications/Layover.app/Contents/bin/layover', 'codex'), '/Applications/Layover.app/Contents/bin/layover hook codex');
    assert.equal(setup.hookCommand(cli, 'codex'), "'/Users/Some One/Applications/Layover.app/Contents/bin/layover' hook codex");
    assert.equal(setup.hookCommand("/Users/o'neil/Layover.app/Contents/bin/layover", 'claude'), "'/Users/o'\\''neil/Layover.app/Contents/bin/layover' hook claude");
  }
  assert.ok(doc.hooks.UserPromptSubmit && doc.hooks.SessionEnd && doc.hooks.Notification);
  assert.equal(doc.hooks.PostToolUse[0].hooks[0].command, `${quoted(cli.replace(/layover(\.cmd)?$/, 'layover-fast$1'))} hook claude`);
  const skill = fs.readFileSync(path.join(home, '.claude', 'skills', 'layover', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: layover/); assert.ok(!skill.includes('__CLI__')); assert.ok(skill.includes(win ? 'Layover/bin/layover.cmd' : 'Contents/bin/layover'));
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

test('connecting Codex turns hooks on in config.toml, keeps the rest, and disconnecting takes only our line out', () => {
  const file = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = 'model = "gpt-6"\r\n\r\n[features]\r\njs_repl = false\r\n\r\n[projects.alpha]\r\ntrust_level = "trusted"\r\n';
  fs.writeFileSync(file, mine);
  assert.equal(setup.status('codex', cli).hooksCurrent, false); // installed earlier, before the flag existed
  setup.install('codex', cli);
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /\[features\]\r\ncodex_hooks = true # added by Layover[^\r\n]*\r\njs_repl = false\r\n/);
  assert.equal(after.replace(/codex_hooks[^\r\n]*\r\n/, ''), mine);
  assert.ok(setup.status('codex', cli).hooksCurrent && setup.status('codex', cli).hooksFeature.enabled);
  assert.equal(setup.enableCodexHooks().changed, false); // idempotent
  setup.remove('codex');
  assert.equal(fs.readFileSync(file, 'utf8'), mine);

  fs.writeFileSync(file, '[features]\ncodex_hooks = false\n');
  setup.install('codex', cli);
  assert.equal(setup.codexHooksFeature().enabled, true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /false/);

  fs.writeFileSync(file, 'model = "x"\n');
  setup.install('codex', cli);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = "x"\n\n[features]\ncodex_hooks = true # added by Layover: Codex before 0.125 keeps hooks off without it\n');

  fs.writeFileSync(file, '[features]\nhooks = false\n');
  const r = setup.install('codex', cli);
  assert.ok(setup.status('codex', cli).hooksFeature.disabled);
  assert.ok(r.notes.some(n => /hooks = false/.test(n)));

  fs.writeFileSync(file, 'features = { js_repl = false }\n');
  assert.equal(setup.enableCodexHooks().changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'features = { js_repl = false }\n');
  fs.rmSync(file);
  setup.install('codex', cli);
  assert.ok(setup.codexHooksFeature().enabled);
});
