import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEdgeOne } from '../../scripts/build-edgeone.mjs';
import { createHarness, JWT_SECRET, sampleReport } from './helpers.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'eo-live-ttl-test-'));
const outfile = join(temporary, 'edgeone-entry.mjs');
await buildEdgeOne({ outfile, minify: false });
const { onRequest } = await import(pathToFileURL(outfile).href);
after(() => rm(temporary, { recursive: true, force: true }));

const RECOVERY_KEY = 'live-ttl-public-test-recovery-key-0123456789';
const logicalKey = key => `eo_${Buffer.from(key).toString('hex')}`;
let nextIp = 70;

function clockFor(t) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  return { get now() { return now; }, set(value) { now = value; } };
}

function binding(data = new Map()) {
  return {
    data,
    async get(key) { assert.match(key, /^eo_[0-9a-f]+$/); return data.get(key) ?? null; },
    async put(key, value) { assert.match(key, /^eo_[0-9a-f]+$/); data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
}

async function eoHarness(settings = {}) {
  const kv = binding();
  const cookies = new Map();
  const ip = `203.0.113.${nextIp++}`;
  const env = {
    MONITOR_KV: kv, JWT_SECRET, ADMIN_RECOVERY_KEY: RECOVERY_KEY,
    CRON_SECRET: 'live-ttl-public-test-cron-secret',
  };
  async function call(method, path, { body, token, readBinding = kv } = {}) {
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    else if (cookies.size) {
      headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
      if (cookies.has('cf_monitor_csrf')) headers.set('X-CSRF-Token', cookies.get('cf_monitor_csrf'));
    }
    const request = new Request(`https://monitor.example.test${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    request.eo = { clientIp: ip };
    const response = await onRequest({ request, env: { ...env, MONITOR_KV: readBinding } });
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const json = await response.json();
    assert.equal(response.status, 200, JSON.stringify(json));
    return json;
  }

  const credentials = { username: 'ttl-test-admin', password: 'public-test-password-123456' };
  await call('POST', '/api/admin/recovery', { body: { ...credentials, recovery_key: RECOVERY_KEY } });
  await call('POST', '/api/login', { body: credentials });
  await call('POST', '/api/admin/settings', { body: { record_enabled: 'false', ...settings } });
  const client = await call('POST', '/api/admin/clients/add', { body: { name: 'ttl-test-node' } });

  const entry = () => JSON.parse(kv.data.get(logicalKey(`lv_${client.uuid}`)));
  const report = body => call('POST', '/api/clients/report', { token: client.token, body: sampleReport(body) });
  const policy = () => call('GET', '/api/clients/policy', { token: client.token });
  const live = (readBinding = kv, active = false) => call('GET', `/api/live/clients${active ? '?viewer=active' : ''}`, { readBinding });
  // A distinct binding identity isolates the reader's module cache. Its values
  // represent another edge's provider cache, unchanged while uploads continue.
  const staleReader = () => binding(new Map(kv.data));
  return { client, entry, report, policy, live, staleReader };
}

for (const interval of [1, 3, 5]) {
  test(`real EO entry keeps ${interval}s reports online through a 35s old remote KV cache`, async t => {
    const clock = clockFor(t);
    const h = await eoHarness();
    const started = clock.now;
    await h.report({ report_interval: interval });
    const remoteCache = h.staleReader();
    const expectedDeadline = started + 210_000;
    assert.equal(h.entry().exp, expectedDeadline);

    for (let seconds = interval; seconds <= 35; seconds += interval) {
      clock.set(started + seconds * 1000);
      await h.report({ report_interval: interval });
    }
    clock.set(started + 35_000);
    assert.ok(clock.now - h.entry().t < interval * 1000 + 1, 'The writer must still be reporting');
    const snapshot = await h.live(remoteCache);
    assert.deepEqual(snapshot.online, [h.client.uuid]);
    assert.equal(snapshot.data[h.client.uuid].lastReportTime, started, 'The reader really sees the older receipt');
  });
}

test('real EO entry covers the active to idle120 upload window and expires after the deadline', async t => {
  const clock = clockFor(t);
  const h = await eoHarness();
  const started = clock.now;
  await h.live(undefined, true);
  assert.equal((await h.policy()).mode, 'active');
  clock.set(started + 119_999);
  await h.report({ report_interval: 5 });
  const receipt = clock.now;
  const remoteCache = h.staleReader();
  assert.equal(h.entry().exp, receipt + 210_000);

  clock.set(started + 120_001);
  const idle = await h.policy();
  assert.equal(idle.mode, 'idle');
  assert.equal(idle.report_interval_sec, 120);
  assert.equal(idle.sample_interval_sec, 60);
  clock.set(receipt + 120_000 + 60_000 + 29_999);
  assert.deepEqual((await h.live(remoteCache)).online, [h.client.uuid]);
  clock.set(receipt + 210_001);
  assert.deepEqual((await h.live(remoteCache)).online, []);
});

for (const idleInterval of [300, 3600]) {
  test(`real EO entry honors idle${idleInterval} upload scheduling despite 60s sampling`, async t => {
    const clock = clockFor(t);
    const h = await eoHarness({ live_poll_idle_interval_sec: String(idleInterval) });
    const policy = await h.policy();
    assert.equal(policy.mode, 'idle');
    assert.equal(policy.sample_interval_sec, 60);
    assert.equal(policy.report_interval_sec, idleInterval);
    const receipt = clock.now;
    await h.report({ report_interval: policy.sample_interval_sec });
    const expectedTtl = (idleInterval + 60 + 30) * 1000;
    assert.equal(h.entry().t, receipt);
    assert.equal(h.entry().exp, receipt + expectedTtl);

    clock.set(receipt + expectedTtl - 1);
    assert.deepEqual((await h.live()).online, [h.client.uuid]);
    clock.set(receipt + expectedTtl + 1);
    assert.deepEqual((await h.live()).online, []);
  });
}

test('real EO entry caps extreme report intervals and ignores future Agent clocks for liveness', async t => {
  const clock = clockFor(t);
  const h = await eoHarness();
  const receipt = clock.now;
  await h.report({ report_interval: 1e308, timestamp: receipt + 100 * 86_400_000 });
  assert.equal(h.entry().t, receipt);
  assert.equal(h.entry().exp, receipt + 86_400_000);
  clock.set(receipt + 86_400_001);
  assert.deepEqual((await h.live()).online, []);
});

test('real EO entry preserves legacy fallbacks and longer interval aliases above its floor', async t => {
  const clock = clockFor(t);
  const h = await eoHarness();
  for (const [body, expectedTtl] of [
    [{ report_interval: undefined }, 210_000],
    [{ report_interval: 0 }, 210_000],
    [{ report_interval: -1 }, 210_000],
    [{ report_interval: 'Infinity' }, 210_000],
    [{ report_interval: 120 }, 360_000],
    [{ report_interval: undefined, interval_sec: 300 }, 900_000],
    [{ report_interval: undefined, interval: 600 }, 1_800_000],
  ]) {
    await h.report(body);
    assert.equal(h.entry().exp, clock.now + expectedTtl);
    clock.set(clock.now + 1);
  }
});

test('real non-EO entry retains legacy TTL, fallback, limits and server receipt clock', async t => {
  const clock = clockFor(t);
  const h = await createHarness({ EDGEONE: false });
  t.after(() => h.restore());
  await h.setupAdmin();
  const settings = await h.call('POST', '/api/admin/settings', {
    body: { record_enabled: 'false', live_poll_idle_interval_sec: '3600' },
  });
  assert.equal(settings.status, 200, settings.text);
  const client = await h.addClient();
  for (const [interval, ttl] of [[1, 30_000], [5, 30_000], [30, 90_000], [60, 180_000],
    [120, 360_000], [undefined, 180_000], [0, 180_000], [1e100, 86_400_000]]) {
    const receipt = clock.now;
    const response = await h.agent('POST', '/api/clients/report', client.token,
      sampleReport({ report_interval: interval, timestamp: receipt + 100 * 86_400_000 }));
    assert.equal(response.status, 200, response.text);
    const entry = JSON.parse(h.memory.data.get(`lv_${client.uuid}`));
    assert.equal(entry.t, receipt);
    assert.equal(entry.exp, receipt + ttl, `Legacy interval ${interval} must not receive the EO floor`);
    clock.set(receipt + ttl + 1);
    const snapshot = await h.call('GET', '/api/live/clients');
    assert.equal(snapshot.status, 200, snapshot.text);
    assert.deepEqual(snapshot.json.online, []);
  }
});
