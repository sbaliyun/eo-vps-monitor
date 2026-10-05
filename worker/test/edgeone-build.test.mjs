import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const routes = [
  'edge-functions/api/[[path]].ts',
  'edge-functions/agent/[[path]].ts',
  'edge-functions/ping.ts',
  'edgeone-dist/edge-functions/api/[[path]].js',
  'edgeone-dist/edge-functions/agent/[[path]].js',
  'edgeone-dist/edge-functions/ping.js',
];

function loadLikeEdgeOneCli(entry) {
  assert.ok(existsSync(entry), 'Build artifacts are required: run npm run build before this deployment regression test');
  // edgeone@1.6.41 EdgeFunctionBuilder.bundleAndGetString options. No raw
  // loaders or custom plugins may hide a problem the platform would encounter.
  const bundled = buildSync({
    entryPoints: [entry], bundle: true, write: false,
    outfile: './.tef_dist/assets.js', define: {},
  }).outputFiles.find(output => output.path.endsWith('.js')).text;
  assert.match(bundled, /\bfunction onRequest\s*\(/, 'The handler must survive the platform rebuild as a literal identifier');
  assert.match(bundled, /onRequest(?![a-zA-Z])/, 'The platform handler discovery must recognize the bundle');

  // The CLI adds responseFoo, then arrangeText inserts the function assignment
  // inside esbuild's IIFE. A re-export can contain the word onRequest while its
  // actual function name is minified; evaluating this assignment catches that.
  const text = `${bundled}responseFoo`;
  const runnable = text.replace(/\}\)\(\)\;\n(?:\/\*[\s\S]*?\*\/\n?)*responseFoo/, `
        pagesFunctionResponse = onRequest;
      })();`);
  assert.notEqual(runnable, text, 'The official arrangeText replacement must match the IIFE tail');
  const context = vm.createContext({
    console, Request, Response, Headers, URL, URLSearchParams,
    TextEncoder, TextDecoder, AbortController, AbortSignal,
    ReadableStream, WritableStream, TransformStream,
    // EdgeOne supplies subtle crypto without necessarily exposing CryptoKey.
    // Do not leak Node's webcrypto/CryptoKey globals into this simulated runtime.
    crypto: {
      subtle: new Proxy(webcrypto.subtle, {
        get(target, property) {
          const method = Reflect.get(target, property, target);
          if (typeof method !== 'function') return method;
          if (property === 'importKey') {
            return (...args) => {
              const algorithm = args[2];
              // Reproduce the cloud error found by the deployed HMAC probe.
              if (algorithm?.name === 'HMAC' && typeof algorithm.hash !== 'string') {
                throw new Error('Param Invalid');
              }
              return method.apply(target, args);
            };
          }
          return method.bind(target);
        },
      }),
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      randomUUID: webcrypto.randomUUID.bind(webcrypto),
    },
    atob, btoa, setTimeout, clearTimeout,
    fetch: async () => { throw new Error('Unexpected external request in build regression'); },
    pagesFunctionResponse: undefined,
  });
  assert.equal(vm.runInContext('typeof CryptoKey', context), 'undefined');
  assert.equal(vm.runInContext('typeof process', context), 'undefined');
  assert.equal(vm.runInContext('typeof crypto.webcrypto', context), 'undefined');
  vm.runInContext(runnable, context, { filename: entry, timeout: 10_000 });
  assert.equal(typeof context.pagesFunctionResponse, 'function');
  return context.pagesFunctionResponse;
}

function binding() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
}

for (const route of routes) {
  test(`official EdgeOne builder executes discovery and login without CryptoKey: ${route}`, async () => {
    const onRequest = loadLikeEdgeOneCli(resolve(root, route));
    const kv = binding();
    const env = {
      MONITOR_KV: kv,
      JWT_SECRET: 'build-test-jwt-secret-0123456789abcdef',
      ADMIN_RECOVERY_KEY: 'build-test-recovery-secret-0123456789abcdef',
    };
    async function call(method, path, { body, cookie, csrf } = {}) {
      const headers = new Headers();
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      if (cookie) headers.set('Cookie', cookie);
      if (csrf) headers.set('X-CSRF-Token', csrf);
      const request = new Request(`https://monitor.example.test${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      Object.defineProperty(request, 'eo', { value: { clientIp: '192.0.2.88' } });
      const response = await onRequest({ request, env });
      return { response, json: await response.json() };
    }

    const response = await onRequest({
      request: new Request('https://monitor.example.test/api/version'),
      env,
    });
    assert.equal(response.status, 200);
    const version = await response.json();
    assert.equal(version.name, 'EO VPS Monitor');
    assert.equal(version.platform, 'tencent-edgeone');
    assert.equal(response.headers.get('X-Monitor-Platform'), 'tencent-edgeone');

    const missing = await onRequest({ request: new Request('https://monitor.example.test/api/version'), env: {} });
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).error, /MONITOR_KV/);

    const health = await call('GET', '/api/setup/status');
    assert.equal(health.response.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.runtime.crypto_key_constructor, false);
    assert.equal(health.json.runtime.session_crypto_error, null);
    assert.equal(health.json.checks.find(check => check.key === 'session_crypto').status, 'ok');
    assert.equal(health.response.headers.has('Set-Cookie'), false);
    assert.equal(kv.data.size, 0, 'The anonymous crypto health probe must not persist an account or any other KV data');

    const username = '构建测试管理员🚀';
    const password = 'build-test-password-0123456789abcdef';
    const created = await call('POST', '/api/admin/recovery', {
      body: { username, password, recovery_key: env.ADMIN_RECOVERY_KEY },
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.json.mode, 'created');
    assert.equal(created.json.user.username, username);

    const incorrect = await call('POST', '/api/login', { body: { username, password: 'incorrect-build-test-password' } });
    assert.equal(incorrect.response.status, 401);
    assert.equal(incorrect.response.headers.has('Set-Cookie'), false);

    const login = await call('POST', '/api/login', { body: { username, password } });
    assert.equal(login.response.status, 200);
    assert.equal(login.json.user.uuid, created.json.user.uuid);
    assert.equal(login.json.user.username, username);
    const cookies = login.response.headers.getSetCookie();
    const sessionCookie = cookies.find(cookie => cookie.startsWith('cf_monitor_session='));
    const csrfCookie = cookies.find(cookie => cookie.startsWith('cf_monitor_csrf='));
    assert.ok(sessionCookie, 'Login must issue a session cookie');
    assert.match(sessionCookie, /; HttpOnly(?:;|$)/);
    assert.match(sessionCookie, /; Secure(?:;|$)/);
    assert.ok(csrfCookie, 'Login must issue a CSRF cookie');
    assert.equal(csrfCookie.split(';')[0], `cf_monitor_csrf=${login.json.csrf_token}`);
    const cookie = cookies.map(value => value.split(';')[0]).join('; ');

    const me = await call('GET', '/api/me', { cookie });
    assert.equal(me.response.status, 200);
    assert.equal(me.json.uuid, created.json.user.uuid);
    assert.equal(me.json.username, username);
    assert.equal(me.json.csrf_token, login.json.csrf_token);

    const rejected = await call('POST', '/api/admin/settings', { cookie, body: {} });
    assert.equal(rejected.response.status, 403);
    assert.match(rejected.json.error, /CSRF/);
    const accepted = await call('POST', '/api/admin/settings', { cookie, csrf: login.json.csrf_token, body: {} });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.json.success, true);
    assert.equal(accepted.json.changed, 0);
    assert.equal(accepted.json.noop, true);

    const beforeHealth = [...kv.data];
    const existingAdminHealth = await call('GET', '/api/setup/status');
    assert.equal(existingAdminHealth.response.status, 200);
    assert.equal(existingAdminHealth.json.checks.find(check => check.key === 'admin').status, 'ok');
    assert.equal(existingAdminHealth.response.headers.has('Set-Cookie'), false);
    assert.deepEqual([...kv.data], beforeHealth, 'A crypto health probe must leave existing users and other KV data unchanged');
  });
}
