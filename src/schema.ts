import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';
import { canonical, fail, hash, type Paper, type Tool } from './core.js';
import type { DB } from './db.js';
const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats');
export const toolHash = (t: Tool) =>
  hash(t.name + canonical(t.inputSchema) + canonical(t.outputSchema ?? null));
export type SchemaCache = {
  tools: Tool[];
  fetchedAt: string;
  hash: string;
  source: 'catalog' | 'live';
  degraded: boolean;
  toolHashes: Record<string, string>;
  changed: string[];
  removed: string[];
  baseHash: string | null;
};
export class Schemas {
  cache?: SchemaCache;
  constructor(
    private db: DB,
    private paper: Paper,
    private mode: 'mock' | 'live',
    private ttl: number,
    private identity: string,
    private now = () => Date.now(),
  ) {
    const row = db.prepare('SELECT json FROM kv WHERE key=?').get('schema:' + identity) as
      { json: string } | undefined;
    if (row) this.cache = JSON.parse(row.json);
  }
  private save() {
    this.db
      .prepare('INSERT OR REPLACE INTO kv VALUES(?,?)')
      .run('schema:' + this.identity, JSON.stringify(this.cache));
  }
  async refresh(allowFallback = false) {
    const saved = this.db
      .prepare('SELECT json FROM kv WHERE key=?')
      .get('schema:' + this.identity) as { json: string } | undefined;
    if (saved) this.cache = JSON.parse(saved.json);
    let tools: Tool[];
    try {
      tools = await this.paper.listTools();
    } catch (e) {
      if (!allowFallback) throw e;
      if (
        !this.cache ||
        this.now() - Date.parse(this.cache.fetchedAt) >= this.ttl ||
        (this.mode === 'live' && this.cache.source !== 'live')
      )
        fail(
          'schema_stale',
          'Paper is unreachable and no live schema cache remains inside its TTL.',
        );
      this.cache.degraded = true;
      this.save();
      return this.cache;
    }
    if (new Set(tools.map((t) => t.name)).size !== tools.length)
      fail('invalid_schema', 'Duplicate tool names');
    const previous = this.cache;
    const toolHashes = Object.fromEntries(tools.map((t) => [t.name, toolHash(t)]));
    const changed = new Set(previous?.changed ?? []);
    const removed = new Set(previous?.removed ?? []);
    for (const [name, h] of Object.entries(previous?.toolHashes ?? {})) {
      if (!toolHashes[name]) {
        removed.add(name);
        changed.delete(name);
      } else if (h !== toolHashes[name]) changed.add(name);
    }
    for (const name of [...removed])
      if (toolHashes[name]) {
        removed.delete(name);
        changed.add(name);
      }
    this.cache = {
      tools,
      fetchedAt: new Date(this.now()).toISOString(),
      hash: hash(toolHashes),
      source: this.mode === 'mock' ? 'catalog' : 'live',
      degraded: false,
      toolHashes,
      changed: [...changed].sort(),
      removed: [...removed].sort(),
      baseHash: previous?.baseHash ?? previous?.hash ?? null,
    };
    this.save();
    return this.cache;
  }
  async fresh() {
    const row = this.db
      .prepare('SELECT json FROM kv WHERE key=?')
      .get('schema:' + this.identity) as { json: string } | undefined;
    if (row) this.cache = JSON.parse(row.json);
    if (!this.cache || this.now() - Date.parse(this.cache.fetchedAt) >= this.ttl)
      await this.refresh(true);
    return this.cache!;
  }
  async guard(name: string) {
    const c = await this.fresh();
    if (c.removed.includes(name))
      fail(
        'SCHEMA_REMOVED',
        `Tool ${name} was removed. Re-enable it in Paper or update the adapter; drift acceptance cannot restore it.`,
      );
    if (c.changed.includes(name))
      fail(
        'SCHEMA_DRIFT',
        `Contract changed for ${name}. Inspect and accept drift before recording draft writes.`,
      );
    const tool = c.tools.find((t) => t.name === name);
    if (!tool) fail('unknown_tool', name);
    return tool;
  }
  async validate(name: string, args: unknown) {
    const tool = await this.guard(name);
    try {
      const ajv = tool.inputSchema.$schema?.includes('2020-12')
        ? new Ajv2020({ strict: false, allErrors: true })
        : new Ajv({ strict: false, allErrors: true });
      addFormats(ajv);
      const check = ajv.compile(tool.inputSchema);
      if (!check(args)) fail('invalid_arguments', ajv.errorsText(check.errors));
    } catch (e) {
      if (e instanceof Error && 'code' in e) throw e;
      fail('unsupported_schema', `Cannot validate discovered schema for ${name}: ${String(e)}`);
    }
    return tool;
  }
  acceptDrift() {
    const saved = this.db
      .prepare('SELECT json FROM kv WHERE key=?')
      .get('schema:' + this.identity) as { json: string } | undefined;
    if (saved) this.cache = JSON.parse(saved.json);
    if (!this.cache) fail('schema_stale');
    this.cache.changed = [];
    this.cache.baseHash = this.cache.hash;
    this.save();
    return this.cache;
  }
}
