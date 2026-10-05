/**
 * EdgeOne Pages KV 访问层。
 *
 * KV binding 由 Pages 项目配置提供。不同边缘节点的缓存通常约 60 秒同步，
 * 没有事务或 compare-and-swap；本层保留请求操作预算与以下缓存策略：
 *  - 每个请求一个 KvSession：请求内同 key 只读一次，并统计操作数；
 *  - 模块级（isolate 内跨请求）缓存：写入后更新，减轻同一 isolate 读到旧值；
 *  - 文档带 `_rev`，读-改-写路径在模块缓存与 KV 返回值之间取较新的一份。
 */

export interface KvDriver {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface EdgeOneKvBinding {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' }): Promise<unknown>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

declare const MONITOR_KV: EdgeOneKvBinding | undefined;

const encoder = new TextEncoder();
const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 900 * 1024;

export class KvUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KvUnavailableError';
  }
}

export function getGlobalEdgeOneKvBinding(): EdgeOneKvBinding | undefined {
  const candidate = typeof MONITOR_KV !== 'undefined'
    ? MONITOR_KV : (globalThis as Record<string, unknown>).MONITOR_KV;
  return isKvBinding(candidate) ? candidate : undefined;
}

export function isEdgeOneKvAvailable(binding: unknown): binding is EdgeOneKvBinding {
  return isKvBinding(binding);
}

function isKvBinding(binding: unknown): binding is EdgeOneKvBinding {
  if (!binding || typeof binding !== 'object') return false;
  const candidate = binding as Partial<EdgeOneKvBinding>;
  return typeof candidate.get === 'function' && typeof candidate.put === 'function' && typeof candidate.delete === 'function';
}

/** Retained for callers transitioning their diagnostic labels to EdgeOne. */
export function isEdgeKvAvailable(): boolean {
  return getGlobalEdgeOneKvBinding() !== undefined;
}

export function edgeOneKvKey(key: string): string {
  const encoded = `eo_${Array.from(encoder.encode(key), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  if (encoded.length > MAX_KEY_BYTES) throw Object.assign(new Error('KV key exceeds the 512-byte EdgeOne limit'), { status: 413 });
  return encoded;
}

async function readEdgeValue(value: unknown): Promise<string | null> {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value as ArrayBufferView);
  const maybeText = value as { text?: () => Promise<string> };
  if (typeof maybeText.text === 'function') return maybeText.text();
  return String(value);
}

export class EdgeOneKvDriver implements KvDriver {
  private readonly binding: EdgeOneKvBinding;

  constructor(binding: EdgeOneKvBinding) {
    if (!isEdgeOneKvAvailable(binding)) {
      throw new KvUnavailableError('请在 EdgeOne Pages 项目中绑定 MONITOR_KV，或在本地使用内存 KV。');
    }
    this.binding = binding;
  }

  async get(key: string): Promise<string | null> {
    return readEdgeValue(await this.binding.get(edgeOneKvKey(key), { type: 'text' }));
  }

  async put(key: string, value: string): Promise<void> {
    if (typeof value !== 'string') throw new TypeError('KV value must be a string');
    if (encoder.encode(value).byteLength > MAX_VALUE_BYTES) {
      throw Object.assign(new Error('KV value exceeds the 900 KiB application limit'), { status: 413 });
    }
    await this.binding.put(edgeOneKvKey(key), value);
  }

  async delete(key: string): Promise<void> {
    await this.binding.delete(edgeOneKvKey(key));
  }
}

export class MemoryKvDriver implements KvDriver {
  readonly data = new Map<string, string>();
  reads = 0;
  writes = 0;
  deletes = 0;

  private readonly onChange?: (data: Map<string, string>) => void;

  constructor(initial?: Record<string, string>, onChange?: (data: Map<string, string>) => void) {
    this.onChange = onChange;
    if (initial) for (const [key, value] of Object.entries(initial)) this.data.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    this.reads += 1;
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  async put(key: string, value: string): Promise<void> {
    if (typeof value !== 'string') throw new TypeError('KV value must be a string');
    this.writes += 1;
    this.data.set(key, value);
    this.onChange?.(this.data);
  }

  async delete(key: string): Promise<void> {
    this.deletes += 1;
    this.data.delete(key);
    this.onChange?.(this.data);
  }
}

type ModuleCacheEntry = { value: string | null; at: number };

const MODULE_CACHE_MAX_ENTRIES = 1024;
let moduleCaches = new WeakMap<KvDriver, Map<string, ModuleCacheEntry>>();

function driverCache(driver: KvDriver): Map<string, ModuleCacheEntry> {
  let cache = moduleCaches.get(driver);
  if (!cache) {
    cache = new Map();
    moduleCaches.set(driver, cache);
  }
  return cache;
}

function moduleCacheGet(moduleCache: Map<string, ModuleCacheEntry>, key: string, maxAgeMs: number, now: number): ModuleCacheEntry | undefined {
  const entry = moduleCache.get(key);
  if (!entry) return undefined;
  if (now - entry.at > maxAgeMs) return undefined;
  return entry;
}

function moduleCacheSet(moduleCache: Map<string, ModuleCacheEntry>, key: string, value: string | null, now: number): void {
  if (moduleCache.size >= MODULE_CACHE_MAX_ENTRIES && !moduleCache.has(key)) {
    const oldest = moduleCache.keys().next().value;
    if (typeof oldest === 'string') moduleCache.delete(oldest);
  }
  moduleCache.delete(key);
  moduleCache.set(key, { value, at: now });
}

export function resetKvModuleCacheForTests(): void {
  moduleCaches = new WeakMap();
}

export interface KvReadOptions {
  /** 允许使用的模块级缓存最大年龄（毫秒）。0 表示必须真实读取一次 KV。 */
  maxAgeMs?: number;
}

export interface RevisionedDoc {
  _rev?: number;
}

let revisionCounter = 0;
export function nextRevision(now = Date.now()): number {
  revisionCounter = (revisionCounter + 1) % 1000;
  return now * 1000 + revisionCounter;
}

export class KvSession {
  private readonly requestCache = new Map<string, string | null>();
  private operations = 0;
  private readonly warned = new Set<string>();

  readonly driver: KvDriver;
  readonly opsLimit: number;
  private readonly now: () => number;

  constructor(driver: KvDriver, opsLimit = 8, now: () => number = Date.now) {
    this.driver = driver;
    this.opsLimit = opsLimit;
    this.now = now;
  }

  get used(): number {
    return this.operations;
  }

  remaining(): number {
    return Math.max(0, this.opsLimit - this.operations);
  }

  canSpend(ops = 1): boolean {
    return this.operations + ops <= this.opsLimit;
  }

  private spend(kind: string, key: string): void {
    this.operations += 1;
    if (this.operations > this.opsLimit && !this.warned.has(key)) {
      this.warned.add(key);
      console.warn(`[kv] request exceeded KV budget (${this.operations}/${this.opsLimit}) on ${kind} ${key}`);
    }
  }

  /**
   * 不消耗操作数：返回本请求或本 isolate 缓存中的值及其读取时间（可能已过期）。
   * 用于决定哪些 key 值得花预算刷新。
   */
  cached(key: string): { value: string | null; at: number } | undefined {
    if (this.requestCache.has(key)) return { value: this.requestCache.get(key)!, at: this.now() };
    const entry = driverCache(this.driver).get(key);
    return entry ? { value: entry.value, at: entry.at } : undefined;
  }

  /** 请求内是否已经读过（不消耗操作数）。 */
  peek(key: string): string | null | undefined {
    return this.requestCache.get(key);
  }

  async get(key: string, options: KvReadOptions = {}): Promise<string | null> {
    if (this.requestCache.has(key)) return this.requestCache.get(key)!;
    const now = this.now();
    const maxAgeMs = options.maxAgeMs ?? 0;
    if (maxAgeMs > 0) {
      const cached = moduleCacheGet(driverCache(this.driver), key, maxAgeMs, now);
      if (cached) {
        this.requestCache.set(key, cached.value);
        return cached.value;
      }
    }
    this.spend('get', key);
    const value = await this.driver.get(key);
    this.requestCache.set(key, value);
    moduleCacheSet(driverCache(this.driver), key, value, now);
    return value;
  }

  async getJson<T>(key: string, options: KvReadOptions = {}): Promise<T | null> {
    const raw = await this.get(key, options);
    if (raw === null || raw === '') return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      console.warn(`[kv] ignoring malformed JSON in ${key}`);
      return null;
    }
  }

  /**
   * 读-改-写专用读取：必须真实读一次 KV，并与本 isolate 最近写入的版本比较 `_rev`，
   * 返回较新的一份，避免边缘节点尚未失效的旧值覆盖本实例刚写入的数据。
   */
  async getFreshJson<T extends RevisionedDoc>(key: string): Promise<T | null> {
    if (this.requestCache.has(key)) {
      const raw = this.requestCache.get(key)!;
      return raw ? safeParse<T>(raw) : null;
    }
    const localEntry = driverCache(this.driver).get(key);
    const local = localEntry?.value ? safeParse<T>(localEntry.value) : null;
    this.spend('get', key);
    const raw = await this.driver.get(key);
    const remote = raw ? safeParse<T>(raw) : null;
    const pick = (local && (!remote || Number(local._rev || 0) > Number(remote._rev || 0))) ? local : remote;
    const pickedRaw = pick === local && localEntry ? localEntry.value : raw;
    this.requestCache.set(key, pickedRaw);
    moduleCacheSet(driverCache(this.driver), key, pickedRaw, this.now());
    return pick;
  }

  async put(key: string, value: string): Promise<void> {
    if (value.length > 900_000) {
      console.warn(`[kv] large value for ${key}: ${value.length} bytes`);
    }
    this.spend('put', key);
    await this.driver.put(key, value);
    this.requestCache.set(key, value);
    moduleCacheSet(driverCache(this.driver), key, value, this.now());
  }

  async putJson<T extends object>(key: string, value: T): Promise<T> {
    const stamped = { ...value, _rev: nextRevision(this.now()) } as T;
    await this.put(key, JSON.stringify(stamped));
    return stamped;
  }

  async delete(key: string): Promise<void> {
    this.spend('delete', key);
    await this.driver.delete(key);
    this.requestCache.set(key, null);
    moduleCacheSet(driverCache(this.driver), key, null, this.now());
  }

  /** 丢弃本请求与模块级缓存中的某个 key（例如确认远端已被其他实例更新）。 */
  forget(key: string): void {
    this.requestCache.delete(key);
    driverCache(this.driver).delete(key);
  }
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
