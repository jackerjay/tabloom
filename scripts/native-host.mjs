#!/usr/bin/env node
/**
 * AI 标签工作台 — Chrome / Brave Native Messaging 唤醒宿主
 * 由浏览器按需拉起，用于在 127.0.0.1:8787 未运行时直接在扩展内一键启动本机服务。
 */
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverDir = path.join(repoRoot, 'server');
const serverScript = path.join(serverDir, 'server.mjs');
const logFile = path.join(serverDir, 'server.log');
const label = 'com.aitab.organizer';
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const HEALTH_URL = 'http://127.0.0.1:8787/health';

function buildEnv() {
  const home = os.homedir();
  const extra = [
    path.dirname(process.execPath),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const merged = [...new Set([...extra, ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean)])];
  return { ...process.env, PATH: merged.join(path.delimiter) };
}

async function checkHealth(timeoutMs = 1200) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const h = await checkHealth(900);
    if (h?.ok) return h;
    await new Promise(r => setTimeout(r, 180));
  }
  return null;
}

function tryKickstartLaunchAgent() {
  if (!existsSync(plistPath)) return false;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  try {
    if (uid !== null) {
      try {
        execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'ignore' });
        return true;
      } catch {
        execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
        return true;
      }
    }
  } catch {
    /* fallback below */
  }
  try {
    execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function spawnDetachedServer() {
  mkdirSync(serverDir, { recursive: true });
  const logFd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [serverScript], {
    cwd: serverDir,
    env: buildEnv(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
}

function readNativeMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let expected = null;
    const onData = buf => {
      chunks.push(buf);
      const all = Buffer.concat(chunks);
      if (expected === null && all.length >= 4) {
        expected = all.readUInt32LE(0);
      }
      if (expected !== null && all.length >= 4 + expected) {
        process.stdin.off('data', onData);
        const body = all.subarray(4, 4 + expected).toString('utf8');
        try { resolve(JSON.parse(body || '{}')); }
        catch (e) { reject(e); }
      }
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', () => {
      if (expected === null) resolve({});
    });
    process.stdin.on('error', reject);
  });
}

function writeNativeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

async function handle(msg) {
  const action = String(msg?.action || 'start');
  const daemonInstalled = existsSync(plistPath);

  if (action === 'ping') {
    const health = await checkHealth(1000);
    return { ok: true, running: Boolean(health?.ok), daemonInstalled, health };
  }

  if (action === 'install-daemon') {
    const serviceScript = path.join(__dirname, 'service.mjs');
    const args = [serviceScript, 'install'];
    if (msg?.origin) args.push('--origin', String(msg.origin));
    execFileSync(process.execPath, args, { env: buildEnv(), stdio: 'ignore' });
    const health = await waitForHealth(5000);
    return {
      ok: Boolean(health?.ok),
      started: Boolean(health?.ok),
      daemonInstalled: existsSync(plistPath),
      health,
      message: health?.ok ? '已安装开机常驻守护并启动服务' : '守护配置已写入，服务仍在启动中',
    };
  }

  const existing = action === 'start' ? await checkHealth(800) : null;
  if (existing?.ok) {
    return {
      ok: true,
      started: false,
      alreadyRunning: true,
      daemonInstalled,
      health: existing,
      message: '本机服务已在运行',
    };
  }

  const kicked = tryKickstartLaunchAgent();
  let health = kicked ? await waitForHealth(2200) : null;
  if (!health?.ok) {
    spawnDetachedServer();
    health = await waitForHealth(4500);
  }

  return {
    ok: Boolean(health?.ok),
    started: Boolean(health?.ok),
    daemonInstalled,
    health,
    message: health?.ok ? '本机服务已通过 Native 唤醒启动' : '唤醒进程后端口 8787 暂未就绪，请检查 server/server.log',
  };
}

try {
  const msg = await readNativeMessage();
  const res = await handle(msg);
  writeNativeMessage(res);
} catch (err) {
  writeNativeMessage({ ok: false, error: err?.message || String(err) });
}
