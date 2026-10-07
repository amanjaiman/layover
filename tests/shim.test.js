import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The installer links ~/.local/bin/layover to Layover.app/Contents/bin/layover. Run through that link,
// the shim used to look for the CLI next to the link (~/.local/src/cli/layover.js) and fail with
// "Cannot find module". A fake bundle stands in for the app: its "runtime" prints what it was given.
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const skip = process.platform === 'win32' ? 'sh shims are for macOS and Linux' : false;

function bundle() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'layover-shim-')));
  const contents = path.join(root, 'Applications', 'Layover.app', 'Contents');
  for (const d of ['bin', 'MacOS', 'Resources/src/cli']) fs.mkdirSync(path.join(contents, d), { recursive: true });
  for (const f of ['layover', 'layover-fast']) { fs.copyFileSync(path.join(bin, f), path.join(contents, 'bin', f)); fs.chmodSync(path.join(contents, 'bin', f), 0o755); }
  fs.writeFileSync(path.join(contents, 'Resources', 'src', 'cli', 'layover.js'), '');
  fs.writeFileSync(path.join(contents, 'MacOS', 'Layover'), '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE|$*"\n', { mode: 0o755 });
  return { root, contents };
}

test('the CLI shim finds the bundle through a symlink, relative or absolute', { skip }, () => {
  const { root, contents } = bundle();
  const cli = path.join(contents, 'Resources', 'src', 'cli', 'layover.js');
  const local = path.join(root, 'home', '.local', 'bin');
  fs.mkdirSync(local, { recursive: true });
  fs.symlinkSync(path.join(contents, 'bin', 'layover'), path.join(local, 'layover'));
  fs.symlinkSync(path.relative(root, path.join(contents, 'bin', 'layover')), path.join(root, 'layover'));
  fs.symlinkSync(path.join(local, 'layover'), path.join(root, 'chained'));
  for (const via of [path.join(contents, 'bin', 'layover'), path.join(local, 'layover'), path.join(root, 'layover'), path.join(root, 'chained')]) {
    const out = execFileSync(via, ['item', '--text', 'a b'], { encoding: 'utf8' }).trim();
    const [flag, args] = out.split('|');
    assert.equal(flag, '1', via);
    assert.equal(fs.realpathSync(args.split(' ')[0]), cli, via);
    assert.match(args, /item --text a b$/, via);
  }
});

test('the fast shim exits at once without a queued message, and follows a symlink when one is', { skip }, () => {
  const { root, contents } = bundle();
  const data = path.join(root, 'data-root');
  fs.symlinkSync(path.join(contents, 'bin', 'layover-fast'), path.join(root, 'layover-fast'));
  const env = { ...process.env, LAYOVER_DATA: data, XDG_DATA_HOME: path.join(root, 'xdg') };
  assert.equal(execFileSync(path.join(root, 'layover-fast'), ['hook', 'claude'], { encoding: 'utf8', env }), '');
  fs.mkdirSync(path.join(data, 'data'), { recursive: true });
  fs.writeFileSync(path.join(data, 'data', 'outbox.flag'), '');
  assert.match(execFileSync(path.join(root, 'layover-fast'), ['hook', 'claude'], { encoding: 'utf8', env }), /layover\.js hook claude/);
});
