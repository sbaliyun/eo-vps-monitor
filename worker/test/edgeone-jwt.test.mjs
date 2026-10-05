import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { sign, verify } from 'hono/jwt';
import { honoCryptoKeyCompatibilityPlugin, patchHonoJws } from '../../scripts/edgeone-jwt-compat.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp(join(tmpdir(), 'eo-jwt-candidate-'));
after(() => rm(temporary, { recursive: true, force: true }));
const env = { JWT_SECRET: 'synthetic-jwt-compatibility-key-at-least-32-bytes' };
const identity = { userId: 'synthetic-user', username: '管理员🚀', sessionVersion: 1 };
const now = Math.floor(Date.now() / 1000);
const claims = { ...identity, kind: 'cf-monitor-session', purpose: 'admin-session', iat: now, exp: now + 300 };

async function makeRuntime(patched, subtle = webcrypto.subtle) {
  const result = await build({
    absWorkingDir: root, entryPoints: ['worker/src/auth/jwt.ts'], bundle: true,
    platform: 'browser', format: 'iife', globalName: 'JwtCandidate', write: false,
    plugins: patched ? [honoCryptoKeyCompatibilityPlugin()] : [],
  });
  const context = vm.createContext({
    TextEncoder, TextDecoder, atob, btoa,
    crypto: {
      subtle,
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      randomUUID: webcrypto.randomUUID.bind(webcrypto),
    },
  });
  vm.runInContext(result.outputFiles[0].text, context);
  assert.equal(vm.runInContext('typeof CryptoKey', context), 'undefined');
  assert.equal(vm.runInContext('typeof process', context), 'undefined');
  return context.JwtCandidate;
}

const candidate = await makeRuntime(true);

test('unmodified Hono reproduces the missing CryptoKey failure', async () => {
  const original = await makeRuntime(false);
  await assert.rejects(() => original.generateToken(identity.userId, identity.username, 1, env), /CryptoKey is not defined/);
});

test('candidate signs and verifies UTF-8 sessions without a global CryptoKey constructor', async () => {
  const token = await candidate.generateToken(identity.userId, identity.username, 1, env);
  assert.deepEqual(JSON.parse(JSON.stringify(await candidate.verifyAdminToken(token, env))), identity);
});

test('session health reports compatibility and configuration errors without exposing tokens', async () => {
  const original = await makeRuntime(false);
  const snapshot = value => JSON.parse(JSON.stringify(value));
  const missingConstructor = snapshot(await original.checkSessionCrypto(env));
  assert.equal(missingConstructor.error, 'ReferenceError');
  assert.equal(missingConstructor.diagnostic.stage, 'sign');
  assert.match(missingConstructor.diagnostic.message, /CryptoKey is not defined/);
  const invalidConfig = snapshot(await candidate.checkSessionCrypto({ JWT_SECRET: 'short' }));
  assert.equal(invalidConfig.error, 'AuthConfigurationError');
  assert.equal(invalidConfig.diagnostic.stage, 'sign');
  assert.match(invalidConfig.diagnostic.message, /at least 32 bytes/);
  assert.deepEqual(snapshot(await candidate.checkSessionCrypto(env)), { ok: true });
});

test('session diagnostics redact encoded secrets and preserve cross-realm crypto error details', async () => {
  const secret = '  synthetic-quoted-"key\\value-至少32字节🚀  ';
  const variants = [secret, secret.trim(), JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'),
    Buffer.from(secret).toString('hex'), Buffer.from(secret).toString('hex').toUpperCase()];
  const fault = new Error(variants.join(' | '));
  fault.name = 'SyntheticImportError';
  const runtime = await makeRuntime(true, { importKey: async () => { throw fault; } });
  const result = await runtime.checkSessionCrypto({ JWT_SECRET: secret });
  assert.equal(result.error, 'SyntheticImportError');
  assert.equal(result.diagnostic.stage, 'sign');
  assert.match(result.diagnostic.stack, /SyntheticImportError/);
  const serialized = JSON.stringify(result);
  for (const value of variants) assert.ok(!serialized.includes(value), 'The diagnostic must redact each key encoding');
  assert.match(result.diagnostic.message, /\[redacted\]/);
});

test('candidate tokens and existing Hono tokens are mutually compatible', async () => {
  const oldToken = await sign(claims, env.JWT_SECRET, 'HS256');
  assert.deepEqual(JSON.parse(JSON.stringify(await candidate.verifyAdminToken(oldToken, env))), identity);
  const newToken = await candidate.generateToken(identity.userId, identity.username, 1, env);
  const verified = await verify(newToken, env.JWT_SECRET, 'HS256');
  for (const [name, value] of Object.entries(identity)) assert.equal(verified[name], value);
  assert.equal(verified.kind, 'cf-monitor-session');
  assert.equal(verified.purpose, 'admin-session');
});

test('candidate rejects both signature and payload tampering', async () => {
  const token = await sign(claims, env.JWT_SECRET, 'HS256');
  const [header, payload, signature] = token.split('.');
  const modifiedSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
  await assert.rejects(() => candidate.verifyAdminToken(`${header}.${payload}.${modifiedSignature}`, env));
  const modifiedPayload = Buffer.from(JSON.stringify({ ...claims, userId: 'another-user' })).toString('base64url');
  await assert.rejects(() => candidate.verifyAdminToken(`${header}.${modifiedPayload}.${signature}`, env));
});

test('candidate retains expiration, not-before and issued-at checks', async () => {
  for (const overrides of [{ iat: 1, exp: 2 }, { nbf: now + 3600 }, { iat: now + 3600 }]) {
    const token = await sign({ ...claims, ...overrides }, env.JWT_SECRET, 'HS256');
    await assert.rejects(() => candidate.verifyAdminToken(token, env));
  }
});

test('candidate rejects alg none and correctly signed HS384 tokens', async () => {
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  await assert.rejects(() => candidate.verifyAdminToken(`${noneHeader}.${payload}.`, env));
  const hs384 = await sign(claims, env.JWT_SECRET, 'HS384');
  await assert.rejects(() => candidate.verifyAdminToken(hs384, env));
});

test('candidate retains the application session kind, purpose and version checks', async () => {
  for (const overrides of [
    { kind: 'cf-monitor-mfa' }, { purpose: 'mfa-login' }, { sessionVersion: 0 },
    { sessionVersion: 1.5 }, { userId: null }, { username: 123 },
  ]) {
    const token = await sign({ ...claims, ...overrides }, env.JWT_SECRET, 'HS256');
    assert.equal(await candidate.verifyAdminToken(token, env), null);
  }
});

test('candidate preserves CryptoKey object handling when the constructor is available', async () => {
  const source = await readFile(join(root, 'node_modules/hono/dist/utils/jwt/jws.js'), 'utf8');
  const patched = patchHonoJws(source, { name: 'hono', version: '4.13.7' });
  assert.ok(patched.includes('return key instanceof crypto.webcrypto.CryptoKey;'));
  assert.ok(patched.includes('return key instanceof CryptoKey;'));
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const result = await build({
    absWorkingDir: root, stdin: { contents: "export { sign, verify } from 'hono/jwt';", resolveDir: root },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'HonoCandidate', write: false,
    plugins: [honoCryptoKeyCompatibilityPlugin()],
  });
  const context = vm.createContext({ TextEncoder, TextDecoder, atob, btoa, crypto: webcrypto, CryptoKey: globalThis.CryptoKey });
  vm.runInContext(result.outputFiles[0].text, context);
  const token = await context.HonoCandidate.sign(claims, key, 'HS256');
  assert.equal((await context.HonoCandidate.verify(token, key, 'HS256')).username, identity.username);
});

test('the plugin fails the build when the pinned package version or source changes', async () => {
  const original = await readFile(join(root, 'node_modules/hono/dist/utils/jwt/jws.js'), 'utf8');
  for (const [name, version, source] of [
    ['version', '4.13.8', original],
    ['source', '4.13.7', original.replace('function isCryptoKey(key)', 'function renamedCryptoKey(key)')],
  ]) {
    const fixture = join(temporary, name, 'node_modules/hono');
    const entry = join(fixture, 'dist/utils/jwt/jws.js');
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'hono', version }));
    await writeFile(entry, source);
    await assert.rejects(
      () => build({ entryPoints: [entry], bundle: true, write: false, plugins: [honoCryptoKeyCompatibilityPlugin()], logLevel: 'silent' }),
      name === 'version' ? /requires hono@4\.13\.7/ : /isCryptoKey source changed/,
    );
  }
});

test('the plugin fails the build if module resolution stops loading the expected Hono file', async () => {
  await assert.rejects(() => build({
    stdin: { contents: 'export const value = 1;' }, bundle: true, write: false,
    plugins: [honoCryptoKeyCompatibilityPlugin()], logLevel: 'silent',
  }), /Expected one Hono JWT compatibility patch, applied 0/);
});
