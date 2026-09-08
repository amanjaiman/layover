import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseRelease, checkForUpdate, installCommand } from '../src/main/updates.js';

test('versions compare numerically, pre-releases below their release', () => {
  assert.equal(compareVersions('0.5.1', '0.5.0'), 1);
  assert.equal(compareVersions('0.5.0', '0.5.1'), -1);
  assert.equal(compareVersions('v0.5.1', '0.5.1'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('a release is offered only when newer, released, and not a draft or pre-release', () => {
  const rel = (extra) => ({ tag_name: 'v0.6.0', html_url: 'https://github.com/x/y/releases/tag/v0.6.0', body: 'Notes', published_at: '2026-09-09T00:00:00Z', ...extra });
  const got = parseRelease(rel({}), '0.5.1');
  assert.deepEqual(got, { version: '0.6.0', url: 'https://github.com/x/y/releases/tag/v0.6.0', notes: 'Notes', publishedAt: '2026-09-09T00:00:00Z' });
  assert.equal(parseRelease(rel({}), '0.6.0'), null);
  assert.equal(parseRelease(rel({}), '0.7.0'), null);
  assert.equal(parseRelease(rel({ draft: true }), '0.5.1'), null);
  assert.equal(parseRelease(rel({ prerelease: true }), '0.5.1'), null);
  assert.equal(parseRelease(rel({ tag_name: 'nightly' }), '0.5.1'), null);
  assert.equal(parseRelease(null, '0.5.1'), null);
});

test('checkForUpdate reports an update, up to date, and failures without throwing', async () => {
  const fake = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
  const up = await checkForUpdate({ current: '0.5.1', fetchImpl: fake({ tag_name: 'v0.6.0', body: 'x' }) });
  assert.equal(up.latest.version, '0.6.0'); assert.equal(up.latestVersion, '0.6.0'); assert.equal(up.error, null);
  const same = await checkForUpdate({ current: '0.6.0', fetchImpl: fake({ tag_name: 'v0.6.0' }) });
  assert.equal(same.latest, null); assert.equal(same.latestVersion, '0.6.0');
  const limited = await checkForUpdate({ current: '0.5.1', fetchImpl: fake({}, false, 403) });
  assert.equal(limited.latest, null); assert.match(limited.error, /403/);
  const offline = await checkForUpdate({ current: '0.5.1', fetchImpl: async () => { throw Error('ENOTFOUND'); } });
  assert.equal(offline.latest, null); assert.match(offline.error, /ENOTFOUND/);
});

test('install command pins the script and the release to the same tag', () => {
  const win = installCommand('0.6.0', { platform: 'win32', logPath: 'C:\\Users\\me\\Layover\\update.log' });
  assert.equal(win.kind, 'wmi');
  assert.match(win.commandLine, /raw\.githubusercontent\.com\/amanjaiman\/layover\/v0\.6\.0\/scripts\/install\.ps1/);
  assert.match(win.commandLine, /LAYOVER_VERSION='0\.6\.0'/);
  assert.match(win.commandLine, /update\.log/);
  const inner = win.commandLine.slice(win.commandLine.indexOf('-Command "') + 10, -1);
  assert.equal(inner.includes('"'), false, 'the inner script must not contain double quotes');
  const mac = installCommand('0.6.0', { platform: 'darwin' });
  assert.equal(mac.kind, 'sh'); assert.equal(mac.cmd, '/bin/sh');
  assert.match(mac.args[1], /LAYOVER_VERSION='0\.6\.0' .*v0\.6\.0\/scripts\/install\.sh \| \/bin\/sh$/);
  assert.throws(() => installCommand('0.6.0; rm -rf /', { platform: 'darwin' }));
  assert.throws(() => installCommand('0.6.0', { platform: 'darwin', repo: 'bad repo' }));
});
