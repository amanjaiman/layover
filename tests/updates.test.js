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
  assert.equal(parseRelease(rel({ tag_name: 'v0.6.8-beta.1' }), '0.6.7'), null);
  assert.equal(parseRelease(rel({ tag_name: 'nightly' }), '0.5.1'), null);
  assert.equal(parseRelease(null, '0.5.1'), null);
});

/** A fetch that answers github.com's /releases/latest redirect with `tag` and the API with `api`, and records what was asked. */
function github({ tag = 'v0.6.0', page = null, api = { status: 200, body: { tag_name: 'v0.6.0', body: 'Notes' } } } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push(url);
    if (url.startsWith('https://github.com/')) {
      if (page instanceof Error) throw page;
      if (page) return { ok: page.status < 400, status: page.status, url };
      return { ok: true, status: 200, url: tag ? `https://github.com/amanjaiman/layover/releases/tag/${tag}` : 'https://github.com/amanjaiman/layover/releases' };
    }
    if (api instanceof Error) throw api;
    return { ok: api.status < 400, status: api.status, json: async () => api.body };
  };
  return { impl, calls, api: () => calls.filter(u => u.startsWith('https://api.github.com/')).length };
}

test('checkForUpdate reads the version from github.com and asks the API only for a newer release\'s notes', async () => {
  const same = github({ tag: 'v0.6.0' });
  const r1 = await checkForUpdate({ current: '0.6.0', fetchImpl: same.impl });
  assert.equal(r1.latest, null); assert.equal(r1.latestVersion, '0.6.0'); assert.equal(r1.error, null);
  assert.equal(same.api(), 0, 'an up-to-date check never touches the API');
  assert.equal(same.calls[0], 'https://github.com/amanjaiman/layover/releases/latest');

  const newer = github();
  const r2 = await checkForUpdate({ current: '0.5.1', fetchImpl: newer.impl });
  assert.equal(r2.latest.version, '0.6.0'); assert.equal(r2.latest.notes, 'Notes'); assert.equal(newer.api(), 1);

  const again = github();
  const r3 = await checkForUpdate({ current: '0.5.1', fetchImpl: again.impl, known: r2.latest });
  assert.equal(r3.latest, r2.latest); assert.equal(again.api(), 0, 'notes already in hand are not fetched again');

  const none = await checkForUpdate({ current: '0.5.1', fetchImpl: github({ tag: '' }).impl });
  assert.equal(none.latest, null); assert.equal(none.latestVersion, null); assert.equal(none.error, null);
});

test('a rate-limited API still offers the update, and github.com failing falls back to the API', async () => {
  const limited = await checkForUpdate({ current: '0.5.1', fetchImpl: github({ api: { status: 403, body: {} } }).impl });
  assert.equal(limited.error, null);
  assert.deepEqual(limited.latest, { version: '0.6.0', url: 'https://github.com/amanjaiman/layover/releases/tag/v0.6.0', notes: '', publishedAt: null });

  const pageDown = github({ page: Error('ECONNRESET') });
  const r = await checkForUpdate({ current: '0.5.1', fetchImpl: pageDown.impl });
  assert.equal(r.latest.version, '0.6.0'); assert.equal(pageDown.api(), 1);

  const both = await checkForUpdate({ current: '0.5.1', fetchImpl: github({ page: { status: 429 }, api: { status: 403, body: {} } }).impl });
  assert.equal(both.latest, null); assert.match(both.error, /limiting requests from this network.*403/);

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
  assert.match(mac.args[1], /v0\.6\.0\/scripts\/install\.sh \| LAYOVER_VERSION='0\.6\.0' LAYOVER_REPO='amanjaiman\/layover' \/bin\/sh$/);
  assert.throws(() => installCommand('0.6.0; rm -rf /', { platform: 'darwin' }));
  assert.throws(() => installCommand('0.6.0', { platform: 'darwin', repo: 'bad repo' }));
});
