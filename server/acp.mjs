/**
 * 最小 ACP (Agent Client Protocol) 客户端 —— JSON-RPC 2.0 over stdio。
 * 协议参考: https://agentclientprotocol.com/protocol/v1/overview
 *
 * 设计约束（安全）:
 * - 不声明 fs / terminal 能力：agent 无法通过本客户端读写文件或执行命令
 * - session/request_permission 一律自动拒绝
 * - 每次分组使用全新 session，避免上下文串扰
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';

export class AcpClient {
  constructor({ command, args = [], cwd = os.tmpdir(), env = {}, timeoutMs = 180000, log = () => {} }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.agentInfo = null;
    this.capabilities = {};
    this.stderrTail = [];
    this.dead = false;
    this._chunks = [];
  }

  start() {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.on('error', e => {
      this.dead = true;
      this._failAll(new Error(`ACP agent 启动失败 (${this.command}): ${e.message}`));
    });
    this.proc.on('exit', (code, sig) => {
      this.dead = true;
      const tail = this.stderrTail.slice(-3).join(' | ');
      this._failAll(new Error(`ACP agent 退出 (code=${code} sig=${sig})${tail ? `: ${tail}` : ''}`));
    });
    this.proc.stderr.on('data', d => {
      const s = d.toString().trim();
      if (!s) return;
      this.stderrTail.push(s);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      // 适配器会往 stderr 打大量系统提示词噪音，只记录错误行
      if (/error|panic|failed/i.test(s)) this.log(`[acp:stderr] ${s.slice(0, 400)}`);
    });
    createInterface({ input: this.proc.stdout }).on('line', line => this._onLine(line));
  }

  _failAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  _send(obj) {
    if (!this.proc || this.dead) throw new Error('ACP agent 未在运行');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP 请求超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      const done = fn => v => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params) {
    try { this._send({ jsonrpc: '2.0', method, params }); } catch { /* agent 可能已退出 */ }
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      this.log(`[acp] 非 JSON 输出: ${line.slice(0, 120)}`);
      return;
    }
    if (msg.id != null && msg.method) return this._onAgentRequest(msg);
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`ACP 错误 ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'session/update') this._onUpdate(msg.params);
  }

  _onUpdate(params) {
    const u = params?.update;
    if (!u) return;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      this._chunks.push(u.content.text);
    } else if (u.sessionUpdate === 'agent_message' && Array.isArray(u.content)) {
      // 整条消息形式（非流式）
      this._chunks.push(u.content.filter(c => c.type === 'text').map(c => c.text).join(''));
    }
    // tool_call / plan / thought 等更新对分组任务无意义，忽略
  }

  _onAgentRequest(msg) {
    const { id, method, params } = msg;
    const reply = result => { try { this._send({ jsonrpc: '2.0', id, result }); } catch { /* ignore */ } };
    const replyError = (code, message) => { try { this._send({ jsonrpc: '2.0', id, error: { code, message } }); } catch { /* ignore */ } };
    if (method === 'session/request_permission') {
      const opts = params?.options || [];
      const rejectOpt = opts.find(o => o.kind === 'reject_once' || o.kind === 'reject_always');
      this.log(`[acp] 自动拒绝权限请求: ${params?.toolCall?.title || method}`);
      reply(rejectOpt
        ? { outcome: { outcome: 'selected', optionId: rejectOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } });
      return;
    }
    // fs/*、terminal/* 等：客户端未声明相应能力，一律拒绝
    replyError(-32601, `client 不支持 ${method}`);
  }

  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ai-tab-organizer', title: 'AI Tab Organizer', version: '0.1.0' },
    }, 30000);
    this.capabilities = res?.agentCapabilities || {};
    this.agentInfo = res?.agentInfo || null;
    if (res?.protocolVersion !== 1) {
      this.log(`[acp] 协议版本协商为 ${res?.protocolVersion}（client 支持 1，按兼容模式继续）`);
    }
    return res;
  }

  /** 发送一轮 prompt，返回 agent 的完整文本回复。每次使用新 session。 */
  async prompt(text, { timeoutMs = this.timeoutMs } = {}) {
    const sessionParams = { cwd: this.cwd, mcpServers: [] };
    if (this.capabilities?.sessionCapabilities?.systemPrompt) {
      sessionParams.systemPrompt = {
        mode: 'append',
        content: [{ type: 'text', text: '你是浏览器标签页整理助手。只输出合法 JSON，不要使用任何工具，不要读写文件，不要执行命令。' }],
      };
    }
    const { sessionId } = await this.request('session/new', sessionParams, 60000);
    this._chunks = [];
    try {
      const res = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs);
      const out = this._chunks.join('');
      if (res?.stopReason === 'refusal') throw new Error('agent 拒绝回答');
      if (!out.trim()) throw new Error(`agent 未返回文本 (stopReason=${res?.stopReason})`);
      return out;
    } catch (e) {
      this.notify('session/cancel', { sessionId });
      throw e;
    }
  }

  close() {
    this.dead = true;
    try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ }
  }
}