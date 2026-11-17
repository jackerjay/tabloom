/** Private, content-free analysis cache. One server instance owns each file. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 1000;

export class AnalysisCache {
  constructor({ file, ttlMs = CACHE_TTL_MS, maxEntries = CACHE_MAX_ENTRIES, now = Date.now } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.writeQueue = Promise.resolve();
    this.loading = null;
    this.dirty = false;
  }

  ready() {
    return this.loading ||= this.load();
  }

  valid(row) {
    return row && /^[a-f0-9]{64}$/.test(row.hash) && /^[a-f0-9]{64}$/.test(row.backend)
      && typeof row.group?.name === 'string' && row.group.name.trim() && row.group.name.length <= 16
      && ['blue', 'green', 'red', 'yellow', 'purple', 'cyan', 'orange', 'pink', 'grey'].includes(row.group.color)
      && (row.title === undefined || (typeof row.title === 'string' && row.title.trim() && row.title.length <= 120))
      && (row.summary === undefined || (typeof row.summary === 'string' && row.summary.trim() && row.summary.length <= 160))
      && Number.isFinite(row.createdAt) && Number.isFinite(row.accessedAt);
  }

  // Whitelist persisted fields: never carry through URLs, original titles or snippets.
  clean(row) {
    return { hash: row.hash, ...(row.title ? { title: row.title } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      group: { name: row.group.name, color: row.group.color },
      createdAt: row.createdAt, accessedAt: row.accessedAt, backend: row.backend };
  }

  prune() {
    const now = this.now();
    for (const [key, row] of this.entries) {
      if (now - row.createdAt >= this.ttlMs || row.createdAt > now) {
        this.entries.delete(key); this.dirty = true;
      }
    }
    const oldest = [...this.entries.values()].sort((a, b) => a.accessedAt - b.accessedAt);
    for (const row of oldest.slice(0, Math.max(0, this.entries.size - this.maxEntries))) {
      this.entries.delete(row.hash); this.dirty = true;
    }
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error('invalid cache');
      for (const row of data.entries) {
        if (this.valid(row)) {
          const clean = this.clean(row);
          this.entries.set(row.hash, clean);
          if (JSON.stringify(row) !== JSON.stringify(clean)) this.dirty = true;
        } else this.dirty = true;
      }
      this.prune();
    } catch (error) {
      this.entries.clear();
      if (error.code !== 'ENOENT') this.dirty = true;
    }
    await this.flush();
  }

  get(hash) {
    const row = this.entries.get(hash);
    if (!row) return null;
    if (this.now() - row.createdAt >= this.ttlMs || row.createdAt > this.now()) {
      this.entries.delete(hash); this.dirty = true;
      return null;
    }
    row.accessedAt = this.now();
    // Map insertion order breaks equal-clock LRU ties (including concurrent gets).
    this.entries.delete(hash); this.entries.set(hash, row);
    this.dirty = true;
    return this.clean(row);
  }

  async setMany(rows) {
    for (const row of rows) {
      const at = this.now();
      const value = { ...row, createdAt: at, accessedAt: at };
      if (!this.valid(value)) continue;
      this.entries.delete(row.hash); this.entries.set(row.hash, this.clean(value));
      this.dirty = true;
    }
    this.prune();
    await this.flush();
  }

  flush() {
    if (!this.dirty) return this.writeQueue;
    this.dirty = false;
    // Snapshot at enqueue time; serialized atomic replacements cannot overwrite newer writes.
    const text = JSON.stringify({ version: 1, entries: [...this.entries.values()].map(row => this.clean(row)) });
    const task = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.writeQueue = task.catch(() => { this.dirty = true; }); // Persistence must never turn AI success into failure.
    return this.writeQueue;
  }
}
