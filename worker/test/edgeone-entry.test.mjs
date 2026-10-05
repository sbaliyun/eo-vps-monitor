import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEdgeOne } from '../../scripts/build-edgeone.mjs';
import { sampleReport, JWT_SECRET } from './helpers.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'eo-entry-test-'));
const outfile = join(temporary, 'edgeone-entry.mjs');
await buildEdgeOne({ outfile, minify: false });
const { onRequest, trustedEdgeOneRequest } = await import(pathToFileURL(outfile).href);
after(() => rm(temporary, { recursive: true, force: true }));

const RECOVERY_KEY = 'entry-test-recovery-secret-0123456789abcdef';
const CRON_SECRET = 'entry-test-external-cron-secret';

function mockBinding() {
  const data = new Map();
  const check = key => assert.match(key, /^eo_[0-9a-f]+$/, 'The production driver must encode all logical keys');
  return {
    data,
    async get(key) { check(key); return data.get(key) ?? null; },
    async put(key, value) { check(key); data.set(key, value); },
    async delete(key) { check(key); data.delete(key); },
  };
}

function harness(ip = '203.0.113.42') {
  const kv = mockBinding();
  const env = { MONITOR_KV: kv, JWT_SECRET, ADMIN_RECOVERY_KEY: RECOVERY_KEY, CRON_SECRET };
  const cookies = new Map();
  async function call(method, path, { body, headers: supplied = {}, session = true, raw = false } = {}) {
    const headers = new Headers(supplied);
    if (session && cookies.size) headers.set('Cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (session && cookies.has('cf_monitor_csrf') && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', cookies.get('cf_monitor_csrf'));
    }
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const request = new Request(`https://monitor.example.test${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    request.eo = { clientIp: ip };
    const response = await onRequest({ request, env });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    if (raw) return response;
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, headers: response.headers };
  }
  return { kv, env, cookies, call };
}

test('actual EdgeOne bundle fails clearly without a KV binding', async () => {
  const previous = globalThis.MONITOR_KV;
  delete globalThis.MONITOR_KV;
  try {
    const response = await onRequest({ request: new Request('https://monitor.example.test/api/setup/status'), env: { JWT_SECRET } });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /MONITOR_KV/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally {
    if (previous !== undefined) globalThis.MONITOR_KV = previous;
  }
});

test('EdgeOne request adapter removes spoofed proxy headers and preserves the request body', async () => {
  const names = ['ali-real-client-ip', 'ali-cdn-real-ip', 'eo-connecting-ip', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for'];
  const request = new Request('https://monitor.example.test/api/login', {
    method: 'POST', headers: Object.fromEntries(names.map(name => [name, 'spoofed-client'])), body: '{"username":"admin"}',
  });
  request.eo = { clientIp: ' 198.51.100.8 ' };
  const trusted = trustedEdgeOneRequest(request);
  assert.equal(trusted.headers.get('eo-connecting-ip'), '198.51.100.8');
  for (const name of names.filter(name => name !== 'eo-connecting-ip')) assert.equal(trusted.headers.get(name), null);
  assert.equal(await trusted.text(), '{"username":"admin"}');
  const missing = trustedEdgeOneRequest(new Request('https://monitor.example.test/', { headers: { 'x-forwarded-for': 'forged' } }));
  assert.equal(missing.headers.get('eo-connecting-ip'), 'unknown');
});

for (const chunkType of ['ArrayBuffer', 'string', 'DataView']) {
  test(`actual EdgeOne entry creates and logs in an administrator with ${chunkType} request chunks`, async () => {
    const h = harness();
    const username = '管理员🚀';
    const password = 'Stream-test-password-2026!';

    async function postJson(path, body) {
      const text = JSON.stringify(body);
      const bytes = new TextEncoder().encode(text);
      const chunks = chunkType === 'string'
        ? Array.from(text)
        : Array.from(bytes, byte => {
          if (chunkType === 'ArrayBuffer') return Uint8Array.of(byte).buffer;
          // Bytes outside the view must not be included in the JSON body.
          const padded = Uint8Array.of(0xff, 0xff, byte, 0xff);
          return new DataView(padded.buffer, 2, 1);
        });
      const bodyStream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      const request = new Request(`https://monitor.example.test${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': 'spoofed-client',
          'EO-Connecting-IP': 'spoofed-client',
        },
        body: bodyStream,
        duplex: 'half',
      });
      request.eo = { clientIp: '203.0.113.42' };
      // onRequest copies this stream while replacing untrusted proxy headers.
      return onRequest({ request, env: h.env });
    }

    const created = await postJson('/api/admin/recovery', {
      username, password, recovery_key: RECOVERY_KEY,
    });
    const createdBody = await created.json();
    assert.equal(created.status, 200, JSON.stringify(createdBody));
    assert.equal(createdBody.mode, 'created');
    assert.equal(createdBody.user.username, username);

    const login = await postJson('/api/login', { username, password });
    const loginBody = await login.json();
    assert.equal(login.status, 200, JSON.stringify(loginBody));
    assert.equal(loginBody.user.username, username);
    assert.ok(login.headers.getSetCookie().some(cookie => /^cf_monitor_session=[^;]+;/.test(cookie)));
    assert.ok(h.kv.data.size > 0, 'Each chunk type must persist the account in its isolated KV binding');
  });
}

test('actual EdgeOne entry supports setup, session/CSRF, Agent reports, live/history, cron and installers', async t => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('ok');
  t.after(() => { globalThis.fetch = realFetch; });
  const h = harness();
  const status = await h.call('GET', '/api/setup/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.platform, 'tencent-edgeone');
  assert.equal(status.headers.get('X-Monitor-Platform'), 'tencent-edgeone');
  assert.equal(status.headers.get('Cache-Control'), 'no-store');
  const recovery = await h.call('GET', '/api/admin/recovery/status');
  assert.equal(recovery.json.admin_present, false);
  assert.equal(recovery.json.mfa_supported, false);
  const wrong = await h.call('POST', '/api/admin/recovery', {
    body: { username: 'admin', password: 'admin123456', recovery_key: JWT_SECRET }, session: false,
  });
  assert.equal(wrong.status, 403, 'The session key must not authorize recovery');
  const created = await h.call('POST', '/api/admin/recovery', {
    body: { username: 'admin', password: 'admin123456', recovery_key: RECOVERY_KEY }, session: false,
  });
  assert.equal(created.status, 200, created.text);
  const login = await h.call('POST', '/api/login', { body: { username: 'admin', password: 'admin123456' } });
  assert.equal(login.status, 200, login.text);
  assert.ok(h.cookies.has('cf_monitor_session'));
  assert.ok(h.cookies.has('cf_monitor_csrf'));
  assert.equal((await h.call('GET', '/api/me')).json.username, 'admin');
  const update = await h.call('GET', '/api/admin/update-check');
  assert.equal(update.status, 200);
  assert.equal(update.json.has_update, false);
  assert.equal(update.json.source_url, '', 'No private ESA source is offered as an EO update');
  const csrfDenied = await h.call('POST', '/api/admin/clients/add', {
    body: { name: 'forged' }, headers: { 'X-CSRF-Token': 'invalid-token-invalid-token-invalid-token' },
  });
  assert.equal(csrfDenied.status, 403);
  const node = await h.call('POST', '/api/admin/clients/add', { body: { name: 'edgeone-node' } });
  assert.equal(node.status, 200, node.text);
  const { uuid, token } = node.json;
  assert.ok(uuid && token);
  const unauthorized = await h.call('POST', '/api/clients/report', {
    body: sampleReport(), session: false, headers: { Authorization: 'Bearer invalid' },
  });
  assert.equal(unauthorized.status, 401);
  const sampledAt = Date.now() - 1000;
  const report = await h.call('POST', '/api/clients/report', {
    body: sampleReport({ cpu: 37, timestamp: sampledAt }), session: false, headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(report.status, 200, report.text);
  assert.equal(report.json.success, true);
  const live = await h.call('GET', '/api/live/clients?viewer=active', { session: false });
  assert.deepEqual(live.json.online, [uuid]);
  assert.equal(live.json.data[uuid].cpu, 37);
  const policy = await h.call('GET', '/api/clients/policy', { session: false, headers: { Authorization: `Bearer ${token}` } });
  assert.equal(policy.status, 200);
  assert.equal(policy.json.mode, 'active');
  const start = new Date(sampledAt - 60_000).toISOString();
  const end = new Date(sampledAt + 60_000).toISOString();
  const records = await h.call('GET', `/api/records/load?uuid=${uuid}&start=${start}&end=${end}&cursor=${end}&limit=500`, { session: false });
  assert.equal(records.status, 200, records.text);
  assert.equal(records.json.data.length, 1);
  assert.equal(records.json.data[0].cpu, 37);
  assert.equal((await h.call('GET', '/api/cron?key=wrong', { session: false })).status, 401);
  const cron = await h.call('GET', `/api/cron?key=${CRON_SECRET}`, { session: false });
  assert.equal(cron.status, 200, cron.text);
  assert.equal(cron.json.success, true);
  for (const name of ['install.sh', 'install-linux.sh', 'install-windows.ps1']) {
    const installer = await h.call('GET', `/agent/${name}`, { session: false });
    assert.equal(installer.status, 200);
    assert.match(installer.text, /sbaliyun\/cf-vps-monitor/);
    h.env.AGENT_REPOSITORY = 'example/eo-agent';
    const custom = await h.call('GET', `/agent/${name}`, { session: false });
    assert.match(custom.text, /example\/eo-agent/);
    assert.doesNotMatch(custom.text, /sbaliyun\/(?:esa|cf)-vps-monitor/);
    delete h.env.AGENT_REPOSITORY;
    assert.match(installer.headers.get('Content-Type'), /^text\/plain/);
    assert.match(installer.text, name.endsWith('.ps1') ? /\$Mode = "http"/ : /MODE="http"/);
  }
  assert.equal(h.env.EDGEONE, undefined, 'The entry must not mutate the platform environment');
  assert.equal(h.env.__esa_vps_monitor_services, undefined);
  assert.ok(h.kv.data.size > 0);
});

test('changing spoofed IP headers does not reset the EdgeOne login failure bucket', async () => {
  const h = harness('198.51.100.71');
  let response;
  for (let index = 0; index < 6; index += 1) {
    response = await h.call('POST', '/api/login', {
      body: { username: 'missing-admin', password: 'bad-password' }, session: false,
      headers: { 'X-Forwarded-For': `8.8.8.${index}`, 'CF-Connecting-IP': `1.1.1.${index}` },
    });
  }
  assert.equal(response.status, 429);
});

test('the EdgeOne entry rejects declared request bodies above its platform limit', async () => {
  const h = harness('198.51.100.81');
  const response = await h.call('POST', '/api/login', {
    body: {}, session: false, headers: { 'Content-Length': String(1024 * 1024 + 1) },
  });
  assert.equal(response.status, 413);
});
