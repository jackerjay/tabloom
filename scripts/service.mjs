#!/usr/bin/env node
/**
 * TabLoom — macOS LaunchAgent & Native Messaging service installer
 * Usage:
 *   node scripts/service.mjs install [--origin chrome-extension://<id>/]
 *   node scripts/service.mjs uninstall
 *   node scripts/service.mjs status
 */
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function computeUnpackedExtensionId(dirPath) {
  const hash = crypto.createHash('sha256').update(path.resolve(dirPath)).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

export function normalizeOrigin(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^chrome-extension:\/\/[a-p]{32}\/?$/i.test(s)) {
    const id = s.replace(/^chrome-extension:\/\/|\/+$/gi, '').toLowerCase();
    return `chrome-extension://${id}/`;
  }
  if (/^[a-p]{32}$/i.test(s)) return `chrome-extension://${s.toLowerCase()}/`;
  return null;
}

export function discoverLoadedExtensionOrigins(browserDirs = BROWSER_APP_SUPPORT_DIRS, targetExtDir = extDir) {
  const discovered = new Set();
  const resolvedExtDir = path.resolve(targetExtDir);
  for (const base of browserDirs) {
    if (!existsSync(base)) continue;
    let profileCandidates = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'];
    try {
      const scanned = readdirSync(base, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      profileCandidates = [...new Set([...scanned, ...profileCandidates])];
    } catch {
      /* Protected browser directories (e.g. macOS TCC) still probe standard profile names */
    }
    for (const profile of profileCandidates) {
      const prefPath = path.join(base, profile, 'Preferences');
      if (!existsSync(prefPath)) continue;
      try {
        const prefs = JSON.parse(readFileSync(prefPath, 'utf8'));
        const settings = prefs?.extensions?.settings || {};
        for (const [id, info] of Object.entries(settings)) {
          if (!/^[a-p]{32}$/.test(id) || !info || typeof info !== 'object') continue;
          const name = String(info?.manifest?.name || '');
          const extPath = info?.path ? path.resolve(String(info.path)) : '';
          if (extPath === resolvedExtDir || name.includes('TabLoom') || name.includes('织页')) {
            discovered.add(`chrome-extension://${id}/`);
          }
        }
      } catch { /* ignore unreadable or malformed Preferences */ }
    }
  }
  return [...discovered];
}

export function collectAllowedOrigins(extraArgs = [], browserDirs = BROWSER_APP_SUPPORT_DIRS, targetExtDir = extDir) {
  const origins = new Set([`chrome-extension://${computeUnpackedExtensionId(targetExtDir)}/`]);
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
  for (const discovered of discoverLoadedExtensionOrigins(browserDirs, targetExtDir)) {
    origins.add(discovered);
  }
  // Preserve any previously registered extension origins across NativeMessagingHosts
  for (const base of browserDirs) {
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
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(serverScript)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(serverDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(envPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function buildNativeWrapper(execPath = process.execPath, scriptPath = nativeHostScript) {
  const quotedNode = shellQuote(execPath);
  const quotedScript = shellQuote(scriptPath);
  return `#!/bin/sh
exec ${quotedNode} ${quotedScript} "$@"
`;
}

function installNativeHosts(allowedOrigins) {
  writeFileSync(nativeHostWrapper, buildNativeWrapper(), 'utf8');
  chmodSync(nativeHostWrapper, 0o755);
  chmodSync(nativeHostScript, 0o755);

  const manifest = {
    name: label,
    description: 'TabLoom Local Service Native Messaging Host',
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
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
        console.log(`Wrote LaunchAgent plist: ${plistPath} (${e.message})`);
      }
    }

    const allowedOrigins = collectAllowedOrigins(restArgs);
    const nativePaths = installNativeHosts(allowedOrigins);
    console.log(`Installed & started LaunchAgent: ${plistPath}`);
    console.log(`Registered Native Messaging origins (${allowedOrigins.join(', ')}):`);
    for (const p of nativePaths) console.log(`  - ${p}`);
  } else if (cmd === 'uninstall') {
    if (existsSync(plistPath)) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      try { if (uid !== null) execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' }); } catch { /* ignore */ }
      try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch { /* ignore */ }
      unlinkSync(plistPath);
      console.log(`Removed LaunchAgent: ${plistPath}`);
    } else {
      console.log('LaunchAgent is not installed');
    }
    for (const base of BROWSER_APP_SUPPORT_DIRS) {
      const target = path.join(base, 'NativeMessagingHosts', `${label}.json`);
      if (existsSync(target)) {
        try { unlinkSync(target); console.log(`Removed Native Host: ${target}`); } catch { /* ignore */ }
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
}
