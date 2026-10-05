import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { pbkdf2Sync, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const password = 'edgeone-public-password-diagnostic-v1';
const salt = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
const expectedHash = pbkdf2Sync(password, salt, 10000, 32, 'sha256');
const knownHash = `pbkdf2_sha256$10000$${salt.toString('base64')}$${expectedHash.toString('base64')}`;
const bundled = await build({
  absWorkingDir: root, entryPoints: ['worker/src/auth/password-diagnostics.ts'],
  bundle: true, platform: 'browser', format: 'iife', globalName: 'PasswordDiagnostics', write: false,
});

function harness({ deriveBits, getRandomValues, decodeBase64 = atob } = {}) {
  const calls = [];
  const context = vm.createContext({
    TextEncoder, atob: decodeBase64, btoa,
    crypto: {
      subtle: {
        importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
        async deriveBits(...args) {
          const algorithm = args[0];
          calls.push({ iterations: algorithm.iterations, hash: algorithm.hash, salt: Buffer.from(algorithm.salt), bits: args[2] });
          return deriveBits ? deriveBits(args, calls.length) : webcrypto.subtle.deriveBits(...args);
        },
      },
      getRandomValues: getRandomValues ?? webcrypto.getRandomValues.bind(webcrypto),
    },
  });
  vm.runInContext(bundled.outputFiles[0].text, context);
  assert.equal(vm.runInContext('typeof process', context), 'undefined');
  return { calls, check: context.PasswordDiagnostics.checkPasswordCrypto };
}

async function resultOf(check) {
  const result = JSON.parse(JSON.stringify(await check()));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /edgeone-public-password-diagnostic-v1|pbkdf2_sha256\$/);
  assert.ok(!serialized.includes(salt.toString('base64')));
  assert.ok(!serialized.includes(expectedHash.toString('base64')));
  assert.deepEqual(Object.keys(result).sort(), result.ok ? ['ok'] : ['diagnostic', 'error', 'ok']);
  if (result.diagnostic) {
    assert.deepEqual(Object.keys(result.diagnostic).sort(), ['message', 'stack', 'stage']);
    assert.ok(result.error.length <= 100);
    assert.ok(result.diagnostic.message.length <= 400);
    assert.ok(result.diagnostic.stack.length <= 1500);
  }
  return result;
}

test('password diagnostics verify the Node PBKDF2 vector and random-salt roundtrip', async () => {
  const h = harness();
  assert.deepEqual(await resultOf(h.check), { ok: true });
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[0].salt, salt);
  assert.ok(h.calls.every(call => call.iterations === 10000 && call.hash === 'SHA-256' && call.bits === 256));
  assert.deepEqual(h.calls[1].salt, h.calls[2].salt);
});

test('a corrupted native PBKDF2 result fails the known vector rather than passing its own roundtrip', async () => {
  const h = harness({ deriveBits: async () => new Uint8Array(32).buffer });
  const result = await resultOf(h.check);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'PasswordKnownVectorError');
  assert.equal(result.diagnostic.stage, 'known_vector');
  assert.equal(h.calls.length, 1);
});

test('a random-salt decode failure is reported at verify_roundtrip', async () => {
  let decodes = 0;
  const h = harness({ decodeBase64(value) {
    if (++decodes > 2) throw new Error('Synthetic random-salt decode failure');
    return atob(value);
  } });
  const result = await resultOf(h.check);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'PasswordRoundtripError');
  assert.equal(result.diagnostic.stage, 'verify_roundtrip');
  assert.equal(h.calls.length, 2);
});

test('a failure generating a salt is reported at hash_password', async () => {
  const h = harness({ getRandomValues() { throw new DOMException('Synthetic random source rejected', 'OperationError'); } });
  const result = await resultOf(h.check);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'OperationError');
  assert.equal(result.diagnostic.stage, 'hash_password');
  assert.equal(result.diagnostic.message, 'Synthetic random source rejected');
});

test('a native derivation error preserves cross-realm details and hides fixed probe inputs', async () => {
  const error = new Error(`${password} ${knownHash}`);
  error.name = 'SyntheticDerivationError';
  const h = harness({ deriveBits: async () => { throw error; } });
  const result = await resultOf(h.check);
  assert.equal(result.error, 'SyntheticDerivationError');
  assert.equal(result.diagnostic.stage, 'known_vector');
  assert.match(result.diagnostic.message, /\[redacted\]/);
});

test('throwing Error-like getters cannot break the password diagnostic', async () => {
  const error = Object.create(null);
  for (const field of ['name', 'message', 'stack']) {
    Object.defineProperty(error, field, { get() { throw new Error('Synthetic getter rejected'); } });
  }
  const h = harness({ deriveBits: async () => { throw error; } });
  const result = await resultOf(h.check);
  assert.deepEqual(result, {
    ok: false, error: 'PasswordCryptoError',
    diagnostic: { stage: 'known_vector', message: 'Unknown password crypto error', stack: '' },
  });
});

test('diagnostic names, messages and stacks remain bounded', async () => {
  const error = { name: 'n'.repeat(500), message: 'm'.repeat(1000), stack: 's'.repeat(3000) };
  const h = harness({ deriveBits: async () => { throw error; } });
  const result = await resultOf(h.check);
  assert.equal(result.error.length, 100);
  assert.equal(result.diagnostic.message.length, 400);
  assert.equal(result.diagnostic.stack.length, 1500);
});
