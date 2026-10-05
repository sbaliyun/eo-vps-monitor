import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await mkdtemp(join(tmpdir(), 'eo-kv-test-'));
const outfile = join(temporary, 'platform.mjs');
await build({
  stdin: {
    contents: `export * from './src/platform/kv.ts'; export * from './src/platform/context.ts'; export * from './src/platform/env.ts';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  outfile, bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
});
const {
  EdgeOneKvDriver, MemoryKvDriver, KvSession, KvUnavailableError, edgeOneKvKey,
  createAppServices, resolveInvocation, setDefaultKvDriver, resetKvModuleCacheForTests,
  getGlobalEdgeOneKvBinding, isEdgeOneKvAvailable,
} = await import(pathToFileURL(outfile).href);
after(() => rm(temporary, { recursive: true, force: true }));

function binding(initial = {}) {
  const values = new Map(Object.entries(initial));
  const operations = [];
  return {
    values, operations,
    async get(key, options) { operations.push(['get', key, options]); return values.get(key) ?? null; },
    async put(key, value) { operations.push(['put', key]); values.set(key, value); },
    async delete(key) { operations.push(['delete', key]); values.delete(key); },
  };
}

test('EdgeOne binding reads, writes and deletes safely encoded logical keys', async () => {
  const kv = binding();
  const driver = new EdgeOneKvDriver(kv);
  const key = 'live:节点/😀';
  const encoded = edgeOneKvKey(key);
  assert.match(encoded, /^eo_[0-9a-f]+$/);
  assert.notEqual(encoded, edgeOneKvKey('live:节点/'));
  await driver.put(key, '{"cpu":12}');
  assert.equal(kv.values.get(encoded), '{"cpu":12}');
  assert.equal(await driver.get(key), '{"cpu":12}');
  assert.deepEqual(kv.operations.at(-1), ['get', encoded, { type: 'text' }]);
  await driver.delete(key);
  assert.equal(await driver.get(key), null);
  assert.equal(isEdgeOneKvAvailable(kv), true);
  assert.equal(isEdgeOneKvAvailable(undefined), false);
  assert.throws(() => new EdgeOneKvDriver(undefined), KvUnavailableError);
});

test('EdgeOne driver converts binary get responses without changing their contents', async () => {
  const bytes = new TextEncoder().encode('节点');
  const kv = binding({ [edgeOneKvKey('binary')]: bytes.buffer });
  const driver = new EdgeOneKvDriver(kv);
  assert.equal(await driver.get('binary'), '节点');
  kv.values.set(edgeOneKvKey('binary'), bytes);
  assert.equal(await driver.get('binary'), '节点');
});

test('512-byte encoded keys and UTF-8 900 KiB values are checked before external writes', async () => {
  const kv = binding();
  const driver = new EdgeOneKvDriver(kv);
  assert.equal(edgeOneKvKey('a'.repeat(254)).length, 511);
  assert.throws(() => edgeOneKvKey('a'.repeat(255)), { status: 413 });
  assert.throws(() => edgeOneKvKey('界'.repeat(85)), { status: 413 });
  const exactLimit = '界'.repeat(900 * 1024 / 3);
  await driver.put('large', exactLimit);
  const count = kv.operations.length;
  await assert.rejects(driver.put('large', `${exactLimit}a`), { status: 413 });
  await assert.rejects(driver.put('a'.repeat(255), 'x'), { status: 413 });
  await assert.rejects(driver.put('bad-value', undefined), TypeError);
  assert.equal(kv.operations.length, count, 'Rejected payloads never reach the binding');
  assert.equal(await driver.get('large'), exactLimit);
});

test('module cache and revision preference stay inside the driver namespace', async () => {
  resetKvModuleCacheForTests();
  const a = new MemoryKvDriver();
  const b = new MemoryKvDriver({ config: '{"_rev":1,"owner":"b"}' });
  await new KvSession(a).putJson('config', { owner: 'a' });
  const other = new KvSession(b);
  assert.equal(other.cached('config'), undefined);
  assert.equal((await other.getFreshJson('config')).owner, 'b');
  assert.equal(b.reads, 1);
  const empty = new MemoryKvDriver();
  assert.equal(await new KvSession(empty).get('config', { maxAgeMs: 60_000 }), null);
  assert.equal(empty.reads, 1);
});

test('request services reuse each binding driver and isolate concurrent bindings', async () => {
  resetKvModuleCacheForTests();
  const a = binding();
  const b = binding({ [edgeOneKvKey('config')]: '{"_rev":1,"owner":"b"}' });
  const local = new MemoryKvDriver({ config: '{"owner":"local"}' });
  setDefaultKvDriver(local);
  try {
    const first = createAppServices({ MONITOR_KV: a }, undefined);
    const second = createAppServices({ MONITOR_KV: b }, undefined);
    await Promise.all([
      first.kv.putJson('config', { owner: 'a' }),
      second.kv.getFreshJson('config').then(doc => assert.equal(doc.owner, 'b')),
    ]);
    const later = createAppServices({ MONITOR_KV: a }, undefined);
    assert.equal(later.kv.driver, first.kv.driver);
    assert.notEqual(later.kv.driver, second.kv.driver);
    const reads = a.operations.filter(operation => operation[0] === 'get').length;
    assert.equal(JSON.parse(await later.kv.get('config', { maxAgeMs: 60_000 })).owner, 'a');
    assert.equal(a.operations.filter(operation => operation[0] === 'get').length, reads);
    assert.equal(local.reads + local.writes, 0, 'An invocation binding wins over local injection');
    assert.equal(JSON.parse(await createAppServices({ MONITOR_KV: b }, undefined).kv.get('config', { maxAgeMs: 60_000 })).owner, 'b');
  } finally {
    setDefaultKvDriver(null);
  }
});

test('environment resolver preserves binding identity and falls back to the Pages global binding', () => {
  const previous = globalThis.MONITOR_KV;
  const globalBinding = binding();
  const explicitBinding = binding();
  globalThis.MONITOR_KV = globalBinding;
  try {
    const context = { waitUntil() {}, env: { JWT_SECRET: 'context-secret', MONITOR_KV: explicitBinding } };
    const resolved = resolveInvocation(context, undefined);
    assert.equal(resolved.ctx, context);
    assert.equal(resolved.env.MONITOR_KV, explicitBinding);
    assert.equal(resolved.env.JWT_SECRET, 'context-secret');
    const fallback = resolveInvocation(undefined, { JWT_SECRET: 'request-secret' });
    assert.equal(fallback.env.MONITOR_KV, globalBinding);
    assert.equal(getGlobalEdgeOneKvBinding(), globalBinding);
    assert.equal(fallback.env.JWT_SECRET, 'request-secret');
    assert.equal(createAppServices(fallback.env, undefined).kv.driver,
      createAppServices({ MONITOR_KV: globalBinding }, undefined).kv.driver);
    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, 'MONITOR_KV', { value: explicitBinding });
    assert.equal(resolveInvocation(undefined, nonEnumerable).env.MONITOR_KV, explicitBinding);
  } finally {
    if (previous === undefined) delete globalThis.MONITOR_KV;
    else globalThis.MONITOR_KV = previous;
  }
});

test('failed writes never enter request or module caches', async () => {
  resetKvModuleCacheForTests();
  const kv = binding();
  kv.put = async () => { throw new Error('storage unavailable'); };
  const driver = new EdgeOneKvDriver(kv);
  const session = new KvSession(driver);
  await assert.rejects(session.put('config', '{"owner":"pending"}'), /storage unavailable/);
  assert.equal(session.peek('config'), undefined);
  assert.equal(session.cached('config'), undefined);
  assert.equal(await new KvSession(driver).get('config', { maxAgeMs: 60_000 }), null);
});

test('critical read capacity leaves only the reserved follow-up budget after mandatory reads', async () => {
  const driver = new MemoryKvDriver();
  const session = new KvSession(driver, 8);
  await session.get('core');
  await session.get('live_0');
  session.reserveCriticalReadCapacity(10, 2);
  session.reserveCriticalReadCapacity(10, 2);
  assert.equal(session.opsLimit, 8, 'The configured request budget is preserved');
  assert.equal(session.effectiveOpsLimit, 14, 'Repeating a reservation does not create spare capacity');
  for (let index = 0; index < 10; index += 1) await session.get(`lv_${index}`);
  assert.equal(session.remaining(), 2);
  assert.equal(session.canSpend(2), true);
  assert.equal(session.canSpend(3), false, 'Optional maintenance receives no extra budget');
  await session.get('viewers');
  await session.put('viewers', '{"until":1}');
  assert.equal(session.remaining(), 0);
  assert.equal(session.canSpend(), false);
  const ordinary = new KvSession(driver, 8);
  assert.equal(ordinary.effectiveOpsLimit, 8, 'Expansion belongs only to the reserving request');
});

test('critical read capacity rejects invalid counts without expanding the request budget', () => {
  const session = new KvSession(new MemoryKvDriver(), 8);
  for (const [count, reserved] of [[-1, 2], [1, -2], [0.5, 2], [NaN, 2], [1, Infinity], [Number.MAX_SAFE_INTEGER, 2]]) {
    assert.throws(() => session.reserveCriticalReadCapacity(count, reserved), RangeError);
  }
  assert.equal(session.effectiveOpsLimit, 8);
});
