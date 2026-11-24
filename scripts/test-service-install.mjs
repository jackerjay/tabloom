#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { collectAllowedOrigins, discoverLoadedExtensionOrigins } from './service.mjs';

test('discoverLoadedExtensionOrigins and collectAllowedOrigins discover browser Preferences IDs safely', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tabloom-service-test-'));
  try {
    const extId1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const extId2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const extDir = path.join(dir, 'repo', 'extension');
    const chromeDir = path.join(dir, 'Chrome');
    const braveDir = path.join(dir, 'Brave');
    const missingDir = path.join(dir, 'DoesNotExist');

    mkdirSync(path.join(chromeDir, 'Default'), { recursive: true });
    mkdirSync(path.join(chromeDir, 'Profile 2'), { recursive: true });
    mkdirSync(path.join(braveDir, 'Default'), { recursive: true });
    mkdirSync(path.join(braveDir, 'NativeMessagingHosts'), { recursive: true });

    writeFileSync(path.join(chromeDir, 'Default', 'Preferences'), JSON.stringify({
      extensions: {
        settings: {
          [extId1]: { manifest: { name: '织页 TabLoom' }, path: '/some/other/dir/extension' },
          'cccccccccccccccccccccccccccccccc': { manifest: { name: 'Other Extension' }, path: '/tmp/other' },
        },
      },
    }));
    writeFileSync(path.join(chromeDir, 'Profile 2', 'Preferences'), '{broken json');
    writeFileSync(path.join(braveDir, 'NativeMessagingHosts', 'com.aitab.organizer.json'), JSON.stringify({
      allowed_origins: [`chrome-extension://${extId2}/`],
    }));

    const discovered = discoverLoadedExtensionOrigins([chromeDir, braveDir, missingDir], extDir);
    assert.deepEqual(discovered, [`chrome-extension://${extId1}/`]);

    const merged = collectAllowedOrigins(['--origin', 'dddddddddddddddddddddddddddddddd'], [chromeDir, braveDir, missingDir], extDir);
    assert.ok(merged.includes(`chrome-extension://${extId1}/`), 'discovers loaded extension ID');
    assert.ok(merged.includes(`chrome-extension://${extId2}/`), 'preserves previous NativeMessagingHosts origins');
    assert.ok(merged.includes('chrome-extension://dddddddddddddddddddddddddddddddd/'), 'accepts explicit --origin');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install.sh passes bash syntax check and help output without internal URLs', () => {
  const installScript = path.resolve('install.sh');
  execFileSync('bash', ['-n', installScript]);
  const help = execFileSync('bash', [installScript, '--help'], { encoding: 'utf8' });
  assert.match(help, /--dir <path>/);
  assert.match(help, /--uninstall/);
  assert.match(help, /github\.com\/jackerjay\/tabloom/);
  const raw = readFileSync(installScript, 'utf8');
  const blocked = ['code\\.by' + 'ted\\.org', 'sun' + 'deqi', '\\.tr' + 'ae', 'lark' + 'office', 'fei' + 'shu'];
  assert.equal(new RegExp(blocked.join('|'), 'i').test(raw), false, 'install.sh must contain zero internal references');
});

test('buildDaemonInstallCommand produces copyable single-line GitHub install.sh commands without placeholders', async () => {
  const uiSource = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    URL,
    document: { createElement: () => ({ style: {} }), querySelectorAll: () => [], documentElement: { dataset: {} }, addEventListener() {} },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    chrome: {
      runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
      storage: {
        local: { get: async () => ({}) },
        sync: { get: async () => ({}) },
        onChanged: { addListener() {} },
      },
    },
  });
  vm.runInContext(uiSource, ctx);

  const freshCmd = await ctx.buildDaemonInstallCommand();
  assert.equal(freshCmd, 'git clone https://github.com/jackerjay/tabloom.git ~/tabloom && ~/tabloom/install.sh --origin chrome-extension://abcdefghijklmnopabcdefghijklmnop/');
  assert.equal(freshCmd.includes('<项目目录>'), false);
});
