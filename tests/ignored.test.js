import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ignoredFolder } from '../src/main/paths.js';
import { DEFAULTS, applySettings, validateSettings, editFolders } from '../src/main/settings.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'layover.js');

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a folder is ignored when it is on the list or inside a listed folder, never by a shared name prefix', () => {
  const root = path.resolve('/work/secret');
  assert.equal(ignoredFolder(root, [root]), root);
  assert.equal(ignoredFolder(path.join(root, 'src', 'deep'), [root]), root);
  assert.equal(ignoredFolder(path.resolve('/work/secret-other'), [root]), '');
  assert.equal(ignoredFolder(path.resolve('/work'), [root]), '');
  assert.equal(ignoredFolder(root, []), '');
  assert.equal(ignoredFolder('', [root]), '');
  assert.equal(ignoredFolder(root + path.sep, [root, 'not a path', 42]), root);
});

test('ignoring a repository also covers its linked worktrees', t => {
  const dir = tmp(t, 'layover-ignored-wt-');
  const main = path.join(dir, 'project'), work = path.join(dir, 'review');
  const admin = path.join(main, '.git', 'worktrees', 'review');
  fs.mkdirSync(admin, { recursive: true }); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  assert.equal(ignoredFolder(path.join(work, 'src'), [main]), main);
  assert.equal(ignoredFolder(path.join(work, 'src'), [main], { resolve: false }), '');
});

test('the ignore list is empty by default, takes absolute folders once each, and is edited one folder at a time', () => {
  assert.deepEqual(DEFAULTS.ignoredFolders, []);
  const a = path.resolve('/work/a'), b = path.resolve('/work/b');
  const s = applySettings(structuredClone(DEFAULTS), { ignoredFolders: [a, b, a] });
  assert.deepEqual(s.ignoredFolders, [a, b]);
  assert.throws(() => validateSettings({ ignoredFolders: ['relative/dir'] }), /absolute/);
  assert.throws(() => validateSettings({ ignoredFolders: a }), /absolute/);
  assert.deepEqual(editFolders([a], b, true), [a, b]);
  assert.deepEqual(editFolders([a, b], a, true), [b, a]);
  assert.deepEqual(editFolders([a, b], a + path.sep, false), [b]);
  assert.deepEqual(editFolders(undefined, a, false), []);
});

test('hooks in an ignored folder do nothing: no events, no spool, no context line, no launch', t => {
  const data = tmp(t, 'layover-ignored-data-');
  const work = tmp(t, 'layover-ignored-work-');
  const other = tmp(t, 'layover-ignored-other-');
  // autoStart off and a port nothing listens on, so a hook that is not ignored spools instead of launching.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 2, autoStart: false, ignoredFolders: [work] }));
  const env = { ...process.env, LAYOVER_DATA: data, LAYOVER_PORT: '43198', LAYOVER_EXE: path.join(data, 'missing') };
  const hook = (cwd) => execFileSync(process.execPath, [cli, 'hook', 'claude'], { env, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt_id: 'p1', cwd, prompt: 'Fix it.' }) });
  const spool = () => { try { return fs.readdirSync(path.join(data, 'data', 'spool')); } catch { return []; } };

  assert.equal(hook(path.join(work, 'src')), '');
  assert.deepEqual(spool(), []);

  assert.match(hook(other), /Layover is open for this workspace/);
  assert.equal(spool().length, 1);
});

test('begin in an ignored folder says so and starts nothing', t => {
  const data = tmp(t, 'layover-ignored-begin-');
  const work = tmp(t, 'layover-ignored-begin-work-');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 2, autoStart: false, ignoredFolders: [work] }));
  const env = { ...process.env, LAYOVER_DATA: data, LAYOVER_PORT: '43198', LAYOVER_EXE: path.join(data, 'missing') };
  const out = JSON.parse(execFileSync(process.execPath, [cli, 'begin', '--agent', 'claude', '--path', work], { env, encoding: 'utf8' }));
  assert.equal(out.ignored, true);
  assert.equal(out.folder, work);
  assert.equal(fs.existsSync(path.join(data, 'data', 'spool')), false);
});

test('ignore, unignore and ignored edit the settings file while the app is not running', t => {
  const data = tmp(t, 'layover-ignored-cli-');
  const work = tmp(t, 'layover-ignored-cli-work-');
  const env = { ...process.env, LAYOVER_DATA: data, LAYOVER_PORT: '43198' };
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', cwd: work }));
  assert.deepEqual(run('ignore').ignoredFolders, [path.resolve(work)]);
  assert.deepEqual(run('ignored').ignoredFolders, [path.resolve(work)]);
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.ignoredFolders, [path.resolve(work)]);
  assert.deepEqual(run('unignore', '--path', work).ignoredFolders, []);
});
