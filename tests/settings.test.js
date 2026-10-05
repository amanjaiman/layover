import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, applySettings, validateSettings, fitBounds } from '../src/main/settings.js';

test('layout defaults to the full workspace view and accepts the tracker', () => {
  assert.equal(DEFAULTS.layout, 'full');
  const s = applySettings(structuredClone(DEFAULTS), { layout: 'tracker' });
  assert.equal(s.layout, 'tracker');
  assert.throws(() => validateSettings({ layout: 'kanban' }), /Invalid layout/);
});

test('the tracker remembers its sort without touching the rest of window', () => {
  const s = applySettings(structuredClone(DEFAULTS), { window: { trackerSort: 'project' } });
  assert.equal(s.window.trackerSort, 'project');
  assert.equal(s.window.mode, 'expanded');
  assert.throws(() => validateSettings({ window: { trackerSort: 'name' } }), /Invalid tracker sort/);
});

test('the tracker remembers which groups are folded, and a new list replaces the old one', () => {
  let s = applySettings(structuredClone(DEFAULTS), { window: { trackerFolded: ['idle', 'p_abc123', 'idle'] } });
  assert.deepEqual(s.window.trackerFolded, ['idle', 'p_abc123']);
  s = applySettings(s, { window: { trackerFolded: [] } });
  assert.deepEqual(s.window.trackerFolded, []);
  assert.equal(s.window.trackerSort ?? 'status', 'status');
  assert.throws(() => validateSettings({ window: { trackerFolded: 'idle' } }), /folded/);
  assert.throws(() => validateSettings({ window: { trackerFolded: ['<script>'] } }), /folded/);
});

test('style defaults to the plain look and accepts flight', () => {
  assert.equal(DEFAULTS.style, 'default');
  const s = applySettings(structuredClone(DEFAULTS), { style: 'flight' });
  assert.equal(s.style, 'flight');
  assert.equal(s.theme, 'system');
  assert.throws(() => validateSettings({ style: 'boat' }), /Invalid style/);
});

test('saved window bounds are fitted to the display they come back on', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(fitBounds({ x: 900, y: 40, width: 400, height: 580 }, area), { x: 900, y: 40, width: 400, height: 580 });
  assert.deepEqual(fitBounds({ x: 3000, y: 40, width: 400, height: 580 }, area), { x: 1040, y: 40, width: 400, height: 580 }); // display gone
  assert.deepEqual(fitBounds({ x: -20, y: 0, width: 2560, height: 1415 }, area), { x: 0, y: 25, width: 1440, height: 875 }); // larger than the screen
  assert.deepEqual(fitBounds({ width: 400, height: 580 }, area), { x: 520, y: 173, width: 400, height: 580 }); // no position: centred
  assert.deepEqual(fitBounds({ x: 0, y: 25, width: 100, height: 100 }, area, { width: 340, height: 440 }), { x: 0, y: 25, width: 340, height: 440 });
});
