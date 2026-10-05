import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { buildEdgeOne } from '../../scripts/build-edgeone.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'eo-login-diagnostics-test-'));
const outfile = join(temporary, 'edgeone-entry.mjs');
await buildEdgeOne({ outfile, minify: false });
const { onRequest } = await import(pathToFileURL(outfile).href);
after(() => rm(temporary, { recursive: true, force: true }));

const USERNAME = 'diagnostic-admin';
const PASSWORD = 'synthetic-password-42/"\\密';
const JWT_SECRET = '  synthetic-jwt-secret-42/"\\密-0123456789abcdef  ';
const RECOVERY_KEY = 'synthetic-recovery-secret-24/"\\密-0123456789abcdef';
const CRON_SECRET = 'synthetic-cron-secret-84/"\\密';
const encodedKey = key => `eo_${Buffer.from(key).toString('hex')}`;
let fixtureNumber = 0;

function fixture() {
  const ip = `203.0.113.${80 + fixtureNumber++}`;
  const data = new Map();
  const faults = { put: null };
  const binding = {
    async get(key) { return data.get(key) ?? null; },
    async put(key, value) {
      if (faults.put) faults.put(key, value);
      data.set(key, value);
    },
    async delete(key) { data.delete(key); },
  };
  const env = { MONITOR_KV: binding, JWT_SECRET, ADMIN_RECOVERY_KEY: RECOVERY_KEY, CRON_SECRET };
  const cookies = new Map();
  async function call(method, path, body, { session = false, csrf = false } = {}) {
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (session) headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    if (csrf) headers.set('X-CSRF-Token', cookies.get('cf_monitor_csrf'));
    const request = new Request(`https://diagnostics.example.test${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    request.eo = { clientIp: ip };
    const response = await onRequest({ request, env });
    const text = await response.text();
    const setCookies = response.headers.getSetCookie();
    if (response.ok) {
      for (const cookie of setCookies) {
        const pair = cookie.split(';', 1)[0];
        const equals = pair.indexOf('=');
        cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
      }
    }
    return { status: response.status, json: JSON.parse(text), text, headers: response.headers, setCookies };
  }
  async function createAdmin() {
    const response = await call('POST', '/api/admin/recovery', {
      username: USERNAME, password: PASSWORD, recovery_key: RECOVERY_KEY,
    });
    assert.equal(response.status, 200, 'The fixture must create its isolated synthetic administrator');
    return JSON.parse(data.get(encodedKey('core'))).users[0];
  }
  return { data, faults, cookies, call, createAdmin };
}

function encodings(value) {
  const bytes = Buffer.from(value);
  const base64 = bytes.toString('base64');
  return [...new Set([
    value, value.trim(), JSON.stringify(value).slice(1, -1), encodeURIComponent(value), encodeURI(value),
    base64, base64.replace(/=+$/, ''), bytes.toString('base64url'),
    bytes.toString('hex'), bytes.toString('hex').toUpperCase(),
  ])].filter(Boolean);
}

function sensitiveMessage(user, extra = []) {
  return [PASSWORD, JWT_SECRET, JWT_SECRET.trim(), RECOVERY_KEY, CRON_SECRET, user.passwd, ...extra]
    .flatMap(encodings).join(' | ');
}

function assertPrivate(result, logs, user, extra = []) {
  const diagnosticOutput = JSON.stringify({ body: result.json, logs });
  for (const value of [PASSWORD, JWT_SECRET, JWT_SECRET.trim(), RECOVERY_KEY, CRON_SECRET, user.passwd, ...extra]) {
    for (const representation of encodings(value)) {
      assert.equal(diagnosticOutput.includes(representation), false, 'A synthetic credential escaped redaction');
    }
  }
  assert.doesNotMatch(diagnosticOutput, /pbkdf2_sha256\$\d+\$/);
}

async function captureErrors(operation) {
  const logs = [];
  const previous = console.error;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  try { return { result: await operation(), logs }; }
  finally { console.error = previous; }
}

async function withCrypto(overrides, operation) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const native = globalThis.crypto;
  const subtle = new Proxy(native.subtle, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true, value: {
      subtle,
      getRandomValues: native.getRandomValues.bind(native),
      randomUUID: native.randomUUID.bind(native),
    },
  });
  try { return await operation(native); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
}

function assertFailure(result, stage, error) {
  assert.equal(result.status, 500);
  assert.equal(result.json.error, '服务器内部错误');
  assert.equal(result.json.diagnostic.stage, stage);
  assert.equal(result.json.diagnostic.error, error);
  assert.deepEqual(Object.keys(result.json.diagnostic).sort(), ['error', 'message', 'stack', 'stage']);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
}

test('actual EdgeOne login keeps wrong-password 401, successful cookies, identity and CSRF enforcement', async () => {
  const h = fixture();
  const user = await h.createAdmin();
  const wrong = await h.call('POST', '/api/login', { username: USERNAME, password: `${PASSWORD}-wrong` });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, { error: '用户名或密码错误' });
  assert.deepEqual(wrong.setCookies, []);
  assert.equal(wrong.json.diagnostic, undefined);
  const login = await h.call('POST', '/api/login', { username: USERNAME, password: PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.json.diagnostic, undefined);
  assert.equal(login.json.user.uuid, user.uuid);
  const sessionCookie = login.setCookies.find(value => value.startsWith('cf_monitor_session='));
  assert.match(sessionCookie, /; HttpOnly/);
  assert.match(sessionCookie, /; Secure/);
  assert.match(sessionCookie, /; SameSite=Lax/);
  assert.ok(login.setCookies.some(value => value.startsWith('cf_monitor_csrf=')));
  assert.equal(login.json.csrf_token, h.cookies.get('cf_monitor_csrf'));
  const me = await h.call('GET', '/api/me', undefined, { session: true });
  assert.equal(me.status, 200);
  assert.equal(me.json.username, USERNAME);
  const denied = await h.call('POST', '/api/admin/settings', {}, { session: true });
  assert.equal(denied.status, 403);
  const allowed = await h.call('POST', '/api/admin/settings', {}, { session: true, csrf: true });
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(h.data.get(encodedKey('core'))).users[0].passwd, user.passwd);
  assert.deepEqual(JSON.parse(h.data.get(encodedKey('ratelimit'))).buckets, {});
});

test('actual EdgeOne login reports native password crypto exceptions without exposing credential encodings', async () => {
  const h = fixture();
  const user = await h.createAdmin();
  const error = new DOMException(`PBKDF2 import rejected: ${sensitiveMessage(user)}`, 'OperationError');
  const { result, logs } = await withCrypto({ deriveBits: async () => { throw error; } },
    () => captureErrors(() => h.call('POST', '/api/login', { username: USERNAME, password: PASSWORD })));
  assertFailure(result, 'password_verify', 'OperationError');
  assertPrivate(result, logs, user);
  assert.deepEqual(result.setCookies, [], 'A password verification failure must not issue a session');
  assert.ok(logs.some(line => line.startsWith('[auth] login failed:')));
  assert.equal(logs.some(line => line.startsWith('[edgeone] request failed')), false);
  assert.equal(JSON.parse(h.data.get(encodedKey('core'))).users[0].passwd, user.passwd);
});

test('actual EdgeOne login catches cross-realm password crypto errors inside its staged route', async () => {
  const h = fixture();
  const user = await h.createAdmin();
  const error = vm.runInNewContext('new Error(message)', { message: `foreign native rejection: ${sensitiveMessage(user)}` });
  assert.equal(error instanceof Error, false, 'This fault must exercise an Error from another realm');
  const { result, logs } = await withCrypto({ deriveBits: async () => { throw error; } },
    () => captureErrors(() => h.call('POST', '/api/login', { username: USERNAME, password: PASSWORD })));
  assertFailure(result, 'password_verify', 'Error');
  assertPrivate(result, logs, user);
  assert.deepEqual(result.setCookies, []);
  assert.ok(logs.some(line => line.startsWith('[auth] login failed:')));
  assert.equal(logs.some(line => line.startsWith('[edgeone] request failed')), false);
});

test('actual EdgeOne login identifies rate-limit clear write failure and redacts the newly signed token', async () => {
  const h = fixture();
  const user = await h.createAdmin();
  const wrong = await h.call('POST', '/api/login', { username: USERNAME, password: `${PASSWORD}-wrong` });
  assert.equal(wrong.status, 401);
  const existingLimits = h.data.get(encodedKey('ratelimit'));
  let signedToken;
  let clearWrites = 0;
  h.faults.put = key => {
    if (key !== encodedKey('ratelimit')) return;
    clearWrites += 1;
    assert.ok(signedToken, 'The fault must occur after token signing');
    throw new DOMException(`KV put rejected: ${sensitiveMessage(user, [signedToken])}`, 'InvalidStateError');
  };
  const native = globalThis.crypto;
  const { result, logs } = await withCrypto({
    async sign(...args) {
      const signature = await native.subtle.sign(...args);
      const data = args[2];
      signedToken = `${new TextDecoder().decode(data)}.${Buffer.from(signature).toString('base64url')}`;
      return signature;
    },
  }, () => captureErrors(() => h.call('POST', '/api/login', { username: USERNAME, password: PASSWORD })));
  assertFailure(result, 'rate_limit_clear', 'InvalidStateError');
  assert.equal(clearWrites, 1);
  assertPrivate(result, logs, user, [signedToken]);
  assert.equal(h.data.get(encodedKey('ratelimit')), existingLimits, 'A failed clear must not erase existing rate limits');
  assert.equal(JSON.parse(h.data.get(encodedKey('core'))).users[0].passwd, user.passwd);
  assert.ok(logs.some(line => line.startsWith('[auth] login failed:')));
  assert.equal(logs.some(line => line.startsWith('[edgeone] request failed')), false);
});
