import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEsa } from '../../scripts/build-esa.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
let modulePromise = null;

export async function loadWorker() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const outfile = join(root, 'worker', '.tmp', 'test-entry.mjs');
      mkdirSync(dirname(outfile), { recursive: true });
      await buildEsa({ entry: join(root, 'worker', 'src', 'dev-entry.ts'), outfile, minify: false });
      return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    })();
  }
  return modulePromise;
}

export const JWT_SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';

/** 统计每个请求的 KV 操作次数的驱动包装。 */
export class CountingDriver {
  constructor(inner) {
    this.inner = inner;
    this.ops = 0;
  }
  async get(key) { this.ops += 1; return this.inner.get(key); }
  async put(key, value) { this.ops += 1; return this.inner.put(key, value); }
  async delete(key) { this.ops += 1; return this.inner.delete(key); }
}

export async function createHarness(envOverrides = {}) {
  const worker = await loadWorker();
  worker.resetKvModuleCacheForTests();
  worker.resetMaintenanceThrottleForTests();
  worker.resetLocalRateLimitsForTests();
  const memory = new worker.MemoryKvDriver();
  const driver = new CountingDriver(memory);
  worker.setDefaultKvDriver(driver);
  const env = { JWT_SECRET, KV_NAMESPACE: 'test', ...envOverrides };
  const cookies = new Map();
  const outbound = [];
  let fetchHandler = async () => new Response('ok', { status: 200 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    outbound.push({ url, init });
    return fetchHandler(url, init);
  };

  async function call(method, path, { body, headers = {}, raw = false, cookieJar = true, ip = '203.0.113.9' } = {}) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('x-forwarded-for', ip);
    if (cookieJar && cookies.size) requestHeaders.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (cookieJar && cookies.has('cf_monitor_csrf') && !requestHeaders.has('x-csrf-token')) requestHeaders.set('x-csrf-token', cookies.get('cf_monitor_csrf'));
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    }
    const request = new Request(`https://monitor.example.com${path}`, { method, headers: requestHeaders, body: payload });
    driver.ops = 0;
    // 不提供 waitUntil：后台任务在返回前完成，便于断言。
    const response = await worker.handleRequest(request, {}, env);
    const kvOps = driver.ops;
    for (const cookie of response.headers.getSetCookie?.() || []) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value || /max-age=0/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, value);
    }
    if (raw) return { response, kvOps };
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, kvOps, headers: response.headers };
  }

  async function setupAdmin(username = 'admin', password = 'admin123456') {
    const created = await call('POST', '/api/admin/recovery', { body: { username, password, recovery_key: JWT_SECRET }, cookieJar: false });
    if (created.status !== 200) throw new Error(`admin create failed: ${created.text}`);
    const login = await call('POST', '/api/login', { body: { username, password } });
    if (login.status !== 200) throw new Error(`login failed: ${login.text}`);
    return login.json;
  }

  async function addClient(name = 'node-1') {
    const added = await call('POST', '/api/admin/clients/add', { body: { name } });
    if (added.status !== 200) throw new Error(`add client failed: ${added.text}`);
    return added.json;
  }

  async function agent(method, path, token, body) {
    return call(method, path, { body, headers: { authorization: `Bearer ${token}` }, cookieJar: false, ip: '198.51.100.20' });
  }

  /** 模拟租约过期后的下一轮维护。 */
  async function runMaintenance() {
    memory.data.delete('maint');
    worker.resetKvModuleCacheForTests();
    worker.resetMaintenanceThrottleForTests();
    return call('POST', '/api/admin/cron/run');
  }

  function restore() {
    globalThis.fetch = realFetch;
    worker.setDefaultKvDriver(null);
  }

  return {
    worker, env, memory, driver, cookies, outbound, call, agent, setupAdmin, addClient, restore, runMaintenance,
    setFetch(handler) { fetchHandler = handler; },
  };
}

export function sampleReport(overrides = {}) {
  return {
    cpu: 20, gpu: 0, ram: 1_073_741_824, ram_total: 4_294_967_296, swap: 0, swap_total: 0, load: 0.5, temp: 40,
    disk: 10_737_418_240, disk_total: 53_687_091_200, net_in: 100, net_out: 200, net_total_up: 1000, net_total_down: 2000,
    process_count: 100, connections: 10, connections_udp: 2, uptime: 1000, version: '2.0.3', report_interval: 120,
    timestamp: Date.now(), ...overrides,
  };
}
