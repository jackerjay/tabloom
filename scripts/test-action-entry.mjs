#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
function fixture({ fail = false, settings = { density: 'compact', autoOrganize: false } } = {}) {
  const calls = [], warnings = [], installed = [];
  const event = { addListener() {} };
  const storage = { settings };
  const chrome = {
    sidePanel: { async setPanelBehavior(value) { calls.push(value.openPanelOnActionClick); if (fail) throw Error('policy denied'); } },
    runtime: { onMessage: event, onInstalled: { addListener(fn) { installed.push(fn); } } },
    windows: {},
    tabs: { onCreated: event, onRemoved: event, onUpdated: event },
    alarms: { onAlarm: event },
    storage: { sync: { async get() { return { settings: storage.settings }; }, async set(values) { Object.assign(storage, values); } } },
  };
  const context = vm.createContext({ chrome, URL, console: { warn(...args) { warnings.push(args); } } });
  vm.runInContext(source, context);
  return { context, calls, warnings, installed, storage };
}
test('toolbar has no popup and keeps native sidepanel, newtab and browser search', () => {
  assert.equal(Object.hasOwn(manifest.action, 'default_popup'), false);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert(manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.chrome_url_overrides.newtab, 'home.html');
  assert.equal(manifest.commands['search-tabs'].suggested_key.mac, 'Command+K');
});
test('worker start and extension update enable action-sidepanel behavior without changing existing settings', async () => {
  const f = fixture();
  assert.deepEqual(f.calls, [true]);
  await f.installed[0]({ reason: 'update' });
  assert.deepEqual(f.calls, [true, true]);
  assert.deepEqual(f.storage.settings, { density: 'compact', autoOrganize: false });
  const restarted = fixture({ settings: f.storage.settings });
  assert.deepEqual(restarted.calls, [true]);
});
test('first install retains settings initialization and reports API failure without rejecting', async () => {
  const f = fixture({ settings: null, fail: true });
  await vm.runInContext('configureActionEntry()', f.context);
  await f.installed[0]({ reason: 'install' });
  assert.equal(f.storage.settings.autoOrganize, false);
  assert(f.warnings.length >= 2);
});
