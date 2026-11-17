// Multi-Agent CLI 驱动层（零 SDK 依赖，直接复用本机已登录的 codex / claude CLI）
// 在 os.tmpdir() 空目录以只读模式单次执行，并使用 --output-last-message 剥离 Hook / Banner 噪音。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREF_FILE = path.join(__dirname, '.cli-preferences.json');

const CLI_DEFS = [
  {
    id: 'codex',
    name: 'codex CLI',
    desc: '复用 ~/.codex 登录态与公开模型（GPT-5.4 / o4-mini）',
    binNames: ['codex'],
    defaultModel: 'gpt-5.4-mini',
    fallbackModels: [
      'gpt-5.4-mini',
      'gpt-5.4',
      'o4-mini',
    ],
  },
  {
    id: 'claude',
    name: 'claude CLI',
    desc: '复用 Claude Code CLI 登录态，单轮无工具极速输出',
    binNames: ['claude'],
    defaultModel: 'claude-sonnet-4-6',
    fallbackModels: [
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-opus-4-6',
    ],
  },
];

function buildSearchPaths() {
  const home = os.homedir();
  const extra = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  try {
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    if (existsSync(nvmDir)) {
      const versions = readdirSync(nvmDir).sort().reverse();
      for (const v of versions) extra.unshift(path.join(nvmDir, v, 'bin'));
    }
  } catch { /* ignore */ }
  const envPaths = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return [...new Set([...extra, ...envPaths])];
}

export function buildCliEnv(extraEnv = {}) {
  const paths = buildSearchPaths();
  return {
    ...process.env,
    PATH: paths.join(path.delimiter),
    NO_COLOR: '1',
    ...extraEnv,
  };
}

function resolveBinary(binNames) {
  const dirs = buildSearchPaths();
  for (const name of binNames) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function readTomlModel(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8');
    const m = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function readCodexCatalogModels() {
  try {
    const catalogPath = path.join(os.homedir(), '.codex', 'models_cache.json');
    if (!existsSync(catalogPath)) return [];
    const data = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const list = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
    const slugs = list.map(m => m?.slug || m?.id).filter(Boolean);
    return [...new Set(slugs)];
  } catch {
    return [];
  }
}

export function readCliPreferences() {
  try {
    if (!existsSync(PREF_FILE)) return { preferredCli: 'auto', models: {} };
    const parsed = JSON.parse(readFileSync(PREF_FILE, 'utf8'));
    return {
      preferredCli: parsed?.preferredCli || 'auto',
      models: parsed?.models && typeof parsed.models === 'object' ? parsed.models : {},
    };
  } catch {
    return { preferredCli: 'auto', models: {} };
  }
}

export function writeCliPreferences(patch = {}) {
  const cur = readCliPreferences();
  const next = {
    preferredCli: patch.preferredCli ?? cur.preferredCli ?? 'auto',
    models: { ...cur.models, ...(patch.models || {}) },
  };
  try {
    writeFileSync(PREF_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch { /* ignore read-only fs in tests */ }
  return next;
}

export async function probeAgentClis() {
  const prefs = readCliPreferences();
  const home = os.homedir();
  const codexConfigModel = readTomlModel(path.join(home, '.codex', 'config.toml'));
  const codexCatalog = readCodexCatalogModels();

  const results = [];
  for (const def of CLI_DEFS) {
    const binPath = resolveBinary(def.binNames);
    let models = [...def.fallbackModels];
    let configModel = null;

    if (def.id === 'codex') {
      configModel = codexConfigModel;
      if (codexCatalog.length) {
        models = [...new Set([...def.fallbackModels, ...codexCatalog])];
      }
    }

    if (configModel && !models.includes(configModel)) {
      models.unshift(configModel);
    }

    const savedModel = prefs.models?.[def.id];
    const activeModel = (savedModel && models.includes(savedModel))
      ? savedModel
      : (def.defaultModel || configModel || models[0]);

    if (activeModel && !models.includes(activeModel)) models.unshift(activeModel);

    results.push({
      id: def.id,
      name: def.name,
      desc: def.desc,
      installed: Boolean(binPath),
      command: binPath,
      activeModel,
      configModel,
      models,
      invocationPreview: buildInvocationPreview(def.id, activeModel),
    });
  }

  const installed = results.filter(r => r.installed);
  let activeCli = null;
  if (prefs.preferredCli && prefs.preferredCli !== 'auto') {
    activeCli = installed.find(r => r.id === prefs.preferredCli) || null;
  }
  if (!activeCli && installed.length) {
    activeCli = installed[0];
  }

  return {
    preferredCli: prefs.preferredCli || 'auto',
    activeCli: activeCli ? activeCli.id : null,
    activeModel: activeCli ? activeCli.activeModel : null,
    clis: results,
  };
}

function buildInvocationPreview(cliId, model) {
  const m = model || 'auto';
  if (cliId === 'codex') {
    return `codex exec --skip-git-repo-check --ephemeral -s read-only -c model_reasoning_effort="low" -m ${m}`;
  }
  if (cliId === 'claude') {
    return `claude -p --output-format text --tools "" --model ${m}`;
  }
  return `${cliId}`;
}

export async function detectCliBackend() {
  const probe = await probeAgentClis();
  const active = probe.clis.find(c => c.id === probe.activeCli && c.installed);
  if (!active) return null;
  return {
    type: 'cli',
    cli: active.id,
    name: active.name,
    command: active.command,
    model: active.activeModel,
    models: active.models,
    invocationPreview: active.invocationPreview,
    availableClis: probe.clis.map(c => ({
      id: c.id,
      name: c.name,
      desc: c.desc,
      installed: c.installed,
      activeModel: c.activeModel,
      models: c.models,
    })),
  };
}

export async function runCliPrompt(promptText, { cliId, command, model, timeoutMs = 120_000 } = {}) {
  const probe = (!command || !cliId) ? await probeAgentClis() : null;
  const targetId = cliId || probe?.activeCli || 'codex';
  const targetCli = probe?.clis?.find(c => c.id === targetId);
  const bin = command || targetCli?.command || resolveBinary([targetId]);
  if (!bin) throw new Error(`未找到本机 CLI 可执行文件: ${targetId}`);
  const chosenModel = model || targetCli?.activeModel;

  const outFile = path.join(
    os.tmpdir(),
    `aitab-cli-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );

  let args = [];
  if (targetId === 'codex') {
    args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '-s', 'read-only',
      '-c', 'model_reasoning_effort="low"',
      '--color', 'never',
      '-o', outFile,
    ];
    if (chosenModel) args.push('-m', chosenModel);
    args.push('-');
  } else if (targetId === 'claude') {
    args = ['-p', '--output-format', 'text', '--tools', ''];
    if (chosenModel) args.push('--model', chosenModel);
  } else {
    throw new Error(`不支持的 CLI 类型: ${targetId}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: os.tmpdir(),
      env: buildCliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      cleanupOutFile();
      reject(new Error(`${targetId} CLI 调用超时 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    function cleanupOutFile() {
      try { if (existsSync(outFile)) unlinkSync(outFile); } catch { /* ignore */ }
    }

    child.stdout.on('data', chunk => {
      if (stdout.length < 512 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8');
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupOutFile();
      reject(err);
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let fileContent = '';
      try {
        if (existsSync(outFile)) fileContent = readFileSync(outFile, 'utf8').trim();
      } catch { /* ignore */ }
      cleanupOutFile();

      const output = fileContent || stdout.trim();
      if (!output && code !== 0) {
        return reject(new Error(`${targetId} CLI 退出码 ${code}: ${stderr.trim().slice(0, 300) || '无输出'}`));
      }
      resolve(output);
    });

    child.stdin.on('error', () => { /* ignore EPIPE if exited early */ });
    child.stdin.end(String(promptText || ''), 'utf8');
  });
}
