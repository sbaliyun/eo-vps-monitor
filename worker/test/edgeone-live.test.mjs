import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';
import { buildEdgeOne } from '../../scripts/build-edgeone.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'eo-live-test-'));
const outfile = join(temporary, 'entry.mjs');
await buildEdgeOne({ outfile, minify: false });
const { onRequest } = await import(pathToFileURL(outfile).href);
const storeFile = join(temporary, 'store.mjs');
await build({
  stdin: {
    contents: `export { readLiveState } from './src/store/live.ts'; export { createAppServices } from './src/platform/context.ts';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  outfile: storeFile, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
});
const { readLiveState, createAppServices } = await import(pathToFileURL(storeFile).href);
after(() => rm(temporary, { recursive: true, force: true }));

const encodedKey = key => `eo_${Buffer.from(key).toString('hex')}`;
const logicalKey = key => Buffer.from(key.slice(3), 'hex').toString();
let fixtureNumber = 0;

function fixture(count = 30) {
  const ip = `203.0.113.${140 + fixtureNumber++}`;
  const nodes = Array.from({ length: count }, (_, index) => {
    const token = `synthetic-agent-token-${index}-0123456789abcdef`;
    return {
      uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: `node-${index}`, token,
      token_hash: `sha256:${createHash('sha256').update(token).digest('hex')}`,
      hidden: false, sort_order: index,
    };
  });
  const data = new Map([[encodedKey('core'), JSON.stringify({
    schema: 1, meta_version: 1, users: [], clients: nodes, settings: { record_enabled: 'false' },
  })]]);
  const env = {
    JWT_SECRET: 'synthetic-live-test-jwt-0123456789abcdef',
    ADMIN_RECOVERY_KEY: 'synthetic-live-test-recovery-0123456789abcdef',
  };
  function binding(beforeRead) {
    const operations = [];
    let inFlightOwnReads = 0;
    let peakOwnReads = 0;
    return {
      operations,
      get peakOwnReads() { return peakOwnReads; },
      async get(key, options) {
        const logical = logicalKey(key);
        operations.push({ operation: 'get', key: logical });
        assert.equal(options?.type, 'text');
        // Capture the value before yielding: every barrier participant observes
        // the same old shard, although the mock storage itself is consistent.
        const snapshot = data.get(key) ?? null;
        if (beforeRead) await beforeRead(logical);
        if (logical.startsWith('lv_')) {
          inFlightOwnReads += 1;
          peakOwnReads = Math.max(peakOwnReads, inFlightOwnReads);
          try { await setImmediate(); }
          finally { inFlightOwnReads -= 1; }
        }
        return snapshot;
      },
      async put(key, value) {
        operations.push({ operation: 'put', key: logicalKey(key) });
        data.set(key, value);
      },
      async delete(key) {
        operations.push({ operation: 'delete', key: logicalKey(key) });
        data.delete(key);
      },
    };
  }
  async function call(kv, method, path, { body, token, budget, shards } = {}) {
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const request = new Request(`https://live.example.test${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    request.eo = { clientIp: ip };
    const response = await onRequest({ request, env: {
      ...env, MONITOR_KV: kv, ...(budget === undefined ? {} : { KV_OPS_PER_REQUEST: String(budget) }),
      ...(shards === undefined ? {} : { LIVE_SHARDS: String(shards) }),
    } });
    return { status: response.status, json: await response.json() };
  }
  return { nodes, data, binding, call };
}

for (const { budget, shards } of [{ shards: 1 }, { budget: 2, shards: 1 }, { budget: 2, shards: 4 }]) {
  test(`cold EdgeOne snapshots verify all 30 current node keys after concurrent shard overwrite (budget ${budget ?? 'default'}, shards ${shards})`,
    { timeout: 5000 }, async () => {
      const h = fixture();
      const oldTime = Date.now() - 1_300_000;
      h.data.set(encodedKey('live_0'), JSON.stringify({ entries: Object.fromEntries(h.nodes.map(node => [node.uuid, {
        t: oldTime, exp: oldTime + 30_000, r: { cpu: 1 }, m: {},
      }])) }));
      let readers = 0;
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      const reportBinding = h.binding(async key => {
        if (key !== 'live_0') return;
        readers += 1;
        if (readers === h.nodes.length) release();
        await ready;
      });
      const reports = await Promise.all(h.nodes.map(node => h.call(reportBinding, 'POST', '/api/clients/report', {
        token: node.token,
        body: { cpu: 42, ram: 1024, ram_total: 4096, report_interval: 3, timestamp: Date.now() },
      })));
      for (const result of reports) {
        assert.equal(result.status, 200);
        assert.equal(result.json.success, true);
      }
      assert.equal(readers, 30);
      for (const node of h.nodes) {
        assert.ok(JSON.parse(h.data.get(encodedKey(`lv_${node.uuid}`))).exp > Date.now());
      }
      const shard = JSON.parse(h.data.get(encodedKey('live_0')));
      assert.equal(Object.values(shard.entries).filter(entry => entry.t > oldTime).length, 1,
        'Concurrent updates must reproduce lost reports in the shared shard');

      for (let poll = 0; poll < 3; poll += 1) {
        // Every invocation gets a new binding identity and therefore a cold
        // driver cache. Correctness cannot depend on previous viewer requests.
        const cold = h.binding();
        h.data.delete(encodedKey('viewers'));
        const response = await h.call(cold, 'GET', '/api/live/clients?viewer=active', { budget, shards });
        assert.equal(response.status, 200);
        assert.equal(response.json.count, 30);
        assert.deepEqual(new Set(response.json.online), new Set(h.nodes.map(node => node.uuid)));
        assert.deepEqual(response.json.last_known, {});
        assert.equal(cold.operations.filter(item => item.operation === 'get' && item.key.startsWith('lv_')).length, 30);
        assert.ok(cold.peakOwnReads > 1);
        assert.ok(cold.peakOwnReads <= 8, `Independent reads reached concurrency ${cold.peakOwnReads}`);
        assert.ok(cold.operations.some(item => item.operation === 'put' && item.key === 'viewers'));
        assert.ok(JSON.parse(h.data.get(encodedKey('viewers'))).until > Date.now());
        assert.equal(cold.operations.some(item => item.key === 'maint'), false,
          'Mandatory live reads must not grant extra budget to optional maintenance');
      }
    });
}

test('BasicInfo on a cold binding preserves the heartbeat stored only in its independent live key', async () => {
  const h = fixture(1);
  const [node] = h.nodes;
  const heartbeat = {
    t: Date.now(), exp: Date.now() + 360_000, h: Date.now() - 1000,
    r: { cpu: 42, ram: 1024 }, m: { os: 'Old OS', cpu_name: 'Existing CPU' },
  };
  h.data.set(encodedKey(`lv_${node.uuid}`), JSON.stringify(heartbeat));
  h.data.set(encodedKey('live_0'), JSON.stringify({ entries: {} }));
  const result = await h.call(h.binding(), 'POST', '/api/clients/uploadBasicInfo', {
    token: node.token, body: { os: 'Updated OS', version: 'synthetic-version' },
  });
  assert.equal(result.status, 200);
  const saved = JSON.parse(h.data.get(encodedKey(`lv_${node.uuid}`)));
  assert.equal(saved.t, heartbeat.t);
  assert.equal(saved.exp, heartbeat.exp);
  assert.equal(saved.h, heartbeat.h);
  assert.deepEqual(saved.r, heartbeat.r);
  assert.equal(saved.m.os, 'Updated OS');
  assert.equal(saved.m.cpu_name, 'Existing CPU');
  const live = await h.call(h.binding(), 'GET', '/api/live/clients');
  assert.deepEqual(live.json.online, [node.uuid]);
});

test('BasicInfo selects a newer shard heartbeat instead of an older independent entry by report time', async () => {
  const h = fixture(1);
  const [node] = h.nodes;
  const current = {
    t: Date.now(), exp: Date.now() + 360_000, r: { cpu: 42 }, m: { cpu_name: 'New CPU' },
  };
  h.data.set(encodedKey(`lv_${node.uuid}`), JSON.stringify({ ...current, t: current.t - 60_000, r: { cpu: 1 } }));
  h.data.set(encodedKey('live_0'), JSON.stringify({ _rev: 1, entries: { [node.uuid]: current } }));
  const result = await h.call(h.binding(), 'POST', '/api/clients/uploadBasicInfo', {
    token: node.token, body: { os: 'Updated OS' },
  });
  assert.equal(result.status, 200);
  const saved = JSON.parse(h.data.get(encodedKey(`lv_${node.uuid}`)));
  assert.equal(saved.t, current.t);
  assert.equal(saved.exp, current.exp);
  assert.deepEqual(saved.r, current.r);
  assert.equal(saved.m.cpu_name, 'New CPU');
});

test('the maintenance live-state call keeps its configured budget and only verifies a bounded subset', async () => {
  const h = fixture();
  const now = Date.now();
  for (const node of h.nodes) {
    h.data.set(encodedKey(`lv_${node.uuid}`), JSON.stringify({ t: now, exp: now + 360_000, r: { cpu: 42 }, m: {} }));
  }
  h.data.set(encodedKey('live_0'), JSON.stringify({ entries: {} }));
  const binding = h.binding();
  const app = createAppServices({ EDGEONE: true, MONITOR_KV: binding }, undefined);
  const core = await app.kv.getJson('core');
  // Maintenance calls readLiveState directly, without a complete-snapshot flag.
  const state = await readLiveState(app, core, 15_000);
  assert.equal(state.entries.size, 4);
  assert.equal(state.verified.size, 4);
  assert.equal(app.kv.opsLimit, 8);
  assert.equal(app.kv.effectiveOpsLimit, 8);
  assert.equal(app.kv.remaining(), 2);
  assert.equal(binding.operations.length, 6);
});
