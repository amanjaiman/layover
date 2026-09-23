import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, applySettings, validateSettings } from '../src/main/settings.js';

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
