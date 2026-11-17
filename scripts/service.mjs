#!/usr/bin/env node
/**
 * AI 标签工作台 — macOS LaunchAgent + Native Messaging 守护服务管理脚本
 * 用法:
 *   node scripts/service.mjs install [--origin chrome-extension://<id>/]
 *   node scripts/service.mjs uninstall
 *   node scripts/service.mjs status
 */
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const extDir = path.join(repoRoot, 'extension');
const serverDir = path.join(repoRoot, 'server');
const serverScript = path.join(serverDir, 'server.mjs');
const nativeHostScript = path.join(__dirname, 'native-host.mjs');
const nativeHostWrapper = path.join(__dirname, 'native-host.sh');
const logFile = path.join(serverDir, 'server.log');
const label = 'com.aitab.organizer';
const home = os.homedir();
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, `${label}.plist`);

const BROWSER_APP_SUPPORT_DIRS = [
  path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
  path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
  path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
  path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
  path.join(home, 'Library', 'Application Support', 'Chromium'),
  path.join(home, 'Library', 'Application Support', 'Arc', 'User Data'),
];

function computeUnpackedExtensionId(dirPath) {
  const hash = crypto.createHash('sha256').update(path.resolve(dirPath)).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

function normalizeOrigin(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('chrome-extension://')) return s.endsWith('/') ? s : `${s}/`;
  if (/^[a-p]{32}$/.test(s)) return `chrome-extension://${s}/`;
  return null;
}

function collectAllowedOrigins(extraArgs = []) {
  const origins = new Set([`chrome-extension://${computeUnpackedExtensionId(extDir)}/`]);
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === '--origin' && extraArgs[i + 1]) {
      const normalized = normalizeOrigin(extraArgs[i + 1]);
      if (normalized) origins.add(normalized);
      i++;
    } else if (extraArgs[i].startsWith('--origin=')) {
      const normalized = normalizeOrigin(extraArgs[i].slice('--origin='.length));
      if (normalized) origins.add(normalized);
    }
  }
  // 保留用户此前已注册过的额外 extension origin（如从另一目录加载时）
  for (const base of BROWSER_APP_SUPPORT_DIRS) {
    const hostFile = path.join(base, 'NativeMessagingHosts', `${label}.json`);
    if (!existsSync(hostFile)) continue;
    try {
      const existing = JSON.parse(readFileSync(hostFile, 'utf8'));
      if (Array.isArray(existing?.allowed_origins)) {
        for (const o of existing.allowed_origins) {
          const normalized = normalizeOrigin(o);
          if (normalized) origins.add(normalized);
        }
      }
    } catch { /* ignore */ }
  }
  return [...origins];
}

function buildPlist() {
  const nodePath = process.execPath;
  const envPath = [
    path.dirname(nodePath),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverScript}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${serverDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;
}

function buildNativeWrapper() {
  return `#!/bin/sh
exec "${process.execPath}" "${nativeHostScript}" "$@"
`;
}

function installNativeHosts(allowedOrigins) {
  writeFileSync(nativeHostWrapper, buildNativeWrapper(), 'utf8');
  chmodSync(nativeHostWrapper, 0o755);
  chmodSync(nativeHostScript, 0o755);

  const manifest = {
    name: label,
    description: 'AI 标签工作台本机服务 Native Messaging 唤醒宿主',
    path: nativeHostWrapper,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  };

  const installedPaths = [];
  for (const base of BROWSER_APP_SUPPORT_DIRS) {
    if (!existsSync(base)) continue;
    const hostsDir = path.join(base, 'NativeMessagingHosts');
    try {
      mkdirSync(hostsDir, { recursive: true });
      const target = path.join(hostsDir, `${label}.json`);
      writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      installedPaths.push(target);
    } catch { /* ignore protected browser dirs */ }
  }
  return installedPaths;
}

const cmd = (process.argv[2] || 'status').toLowerCase();
const restArgs = process.argv.slice(3);

if (cmd === 'install') {
  mkdirSync(launchAgentsDir, { recursive: true });
  writeFileSync(plistPath, buildPlist(), 'utf8');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  try {
    if (uid !== null) execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
  } catch { /* ignore */ }
  try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch { /* ignore */ }

  let startedViaLaunchctl = false;
  try {
    if (uid !== null) {
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
      startedViaLaunchctl = true;
    }
  } catch { /* fallback below */ }
  if (!startedViaLaunchctl) {
    try {
      execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'inherit' });
      startedViaLaunchctl = true;
    } catch (e) {
      console.log(`已写入 LaunchAgent 配置文件: ${plistPath} (${e.message})`);
    }
  }

  const allowedOrigins = collectAllowedOrigins(restArgs);
  const nativePaths = installNativeHosts(allowedOrigins);
  console.log(`已安装并启动 LaunchAgent: ${plistPath}`);
  console.log(`已注册 Native Messaging 唤醒 (${allowedOrigins.join(', ')}):`);
  for (const p of nativePaths) console.log(`  - ${p}`);
} else if (cmd === 'uninstall') {
  if (existsSync(plistPath)) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    try { if (uid !== null) execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch { /* ignore */ }
    unlinkSync(plistPath);
    console.log(`已移除 LaunchAgent: ${plistPath}`);
  } else {
    console.log('LaunchAgent 未安装');
  }
  for (const base of BROWSER_APP_SUPPORT_DIRS) {
    const target = path.join(base, 'NativeMessagingHosts', `${label}.json`);
    if (existsSync(target)) {
      try { unlinkSync(target); console.log(`已移除 Native Host: ${target}`); } catch { /* ignore */ }
    }
  }
  if (existsSync(nativeHostWrapper)) {
    try { unlinkSync(nativeHostWrapper); } catch { /* ignore */ }
  }
} else {
  const nativeHosts = BROWSER_APP_SUPPORT_DIRS
    .map(base => path.join(base, 'NativeMessagingHosts', `${label}.json`))
    .filter(p => existsSync(p));
  console.log(JSON.stringify({
    label,
    plistPath,
    installed: existsSync(plistPath),
    nativeHosts,
    defaultOrigin: `chrome-extension://${computeUnpackedExtensionId(extDir)}/`,
    serverScript,
    nodePath: process.execPath,
  }, null, 2));
}
