import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundled = await build({
  absWorkingDir: root, entryPoints: ['worker/src/auth/crypto-diagnostics.ts'],
  bundle: true, platform: 'browser', format: 'iife', globalName: 'CryptoDiagnostics', write: false,
});

function harness(intercept = () => undefined) {
  const calls = [];
  const subtle = {};
  for (const method of ['importKey', 'sign', 'verify']) {
    subtle[method] = async (...args) => {
      calls.push({ method, algorithm: method === 'importKey' ? args[2] : args[0], usages: method === 'importKey' ? [...args[4]] : undefined });
      const override = await intercept(method, args, calls.length);
      if (override !== undefined) return override;
      return webcrypto.subtle[method](...args);
    };
  }
  const context = vm.createContext({ TextEncoder, crypto: { subtle } });
  vm.runInContext(bundled.outputFiles[0].text, context);
  return { calls, probe: context.CryptoDiagnostics.probeHmacRuntime };
}

async function resultsOf(probe) {
  const results = JSON.parse(JSON.stringify(await probe()));
  assert.deepEqual(results.map(result => result.name), ['hono_parameters', 'string_hash', 'string_algorithm']);
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), result.ok ? ['name', 'ok'] : ['error', 'name', 'ok', 'stage']);
    if (result.error) {
      assert.deepEqual(Object.keys(result.error).sort(), ['message', 'name', 'stack']);
      assert.ok(result.error.message.length <= 400);
      assert.ok(result.error.stack.length <= 1500);
    }
  }
  const serialized = JSON.stringify(results);
  assert.doesNotMatch(serialized, /edgeone-public-hmac-diagnostic-(?:key|message)-v1/);
  assert.doesNotMatch(serialized, /"(?:secret|data|signature)":/);
  return results;
}

test('HMAC diagnostics succeed for all parameter profiles with standard WebCrypto', async () => {
  const h = harness();
  assert.deepEqual(await resultsOf(h.probe), [
    { name: 'hono_parameters', ok: true },
    { name: 'string_hash', ok: true },
    { name: 'string_algorithm', ok: true },
  ]);
  assert.deepEqual(h.calls.filter(call => call.method === 'importKey').map(call => call.usages), [
    ['sign'], ['verify'], ['sign'], ['verify'], ['sign'], ['verify'],
  ]);
});

test('a runtime rejecting object hashes fails only the Hono parameter profile', async () => {
  const h = harness((method, args) => {
    if (method === 'importKey' && typeof args[2].hash === 'object') throw new Error('Object hashes are unsupported');
  });
  const results = await resultsOf(h.probe);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].stage, 'import_sign_key');
  assert.equal(results[0].error.message, 'Object hashes are unsupported');
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, true);
});

test('a runtime rejecting signing algorithm objects succeeds with the string algorithm profile', async () => {
  const h = harness((method, args) => {
    if ((method === 'sign' || method === 'verify') && typeof args[0] === 'object') throw new Error('Signature algorithm objects are unsupported');
  });
  const results = await resultsOf(h.probe);
  assert.deepEqual(results.map(result => [result.ok, result.stage]), [[false, 'sign'], [false, 'sign'], [true, undefined]]);
});

test('diagnostics identify each rejected WebCrypto stage and continue the remaining profiles', async () => {
  for (const stage of ['import_sign_key', 'sign', 'import_verify_key', 'verify']) {
    const h = harness((method, args) => {
      const actualStage = method === 'importKey'
        ? (args[4][0] === 'sign' ? 'import_sign_key' : 'import_verify_key')
        : method;
      if (actualStage === stage) {
        const error = new Error(`Rejected ${stage}`);
        error.name = 'SyntheticCryptoError';
        throw error;
      }
    });
    const results = await resultsOf(h.probe);
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.stage, stage);
      assert.equal(result.error.name, 'SyntheticCryptoError');
      assert.equal(result.error.message, `Rejected ${stage}`);
    }
  }
});

test('a false HMAC verification result is a failed verify stage', async () => {
  const h = harness(method => method === 'verify' ? false : undefined);
  for (const result of await resultsOf(h.probe)) {
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'verify');
    assert.equal(result.error.name, 'HmacVerificationError');
  }
});

test('diagnostic messages and stacks are bounded without returning crypto inputs or output', async () => {
  const h = harness(() => {
    const error = new Error('m'.repeat(1000));
    error.stack = 's'.repeat(3000);
    throw error;
  });
  for (const result of await resultsOf(h.probe)) {
    assert.equal(result.error.message, 'm'.repeat(400));
    assert.equal(result.error.stack, 's'.repeat(1500));
  }
});

test('diagnostics retain DOMException and cross-realm Error-like string fields', async () => {
  for (const error of [
    new DOMException('Synthetic key import rejected', 'DataError'),
    vm.runInNewContext("new Error('Synthetic cross-realm rejection')"),
    { name: 'OperationError', message: 'Synthetic Error-like rejection', stack: 'synthetic stack' },
  ]) {
    const h = harness(() => { throw error; });
    for (const result of await resultsOf(h.probe)) {
      assert.equal(result.stage, 'import_sign_key');
      assert.equal(result.error.name, error.name);
      assert.equal(result.error.message, error.message);
      assert.equal(result.error.stack, typeof error.stack === 'string' ? error.stack.slice(0, 1500) : '');
    }
  }
});

test('throwing exception getters and string coercion do not stop other profiles', async () => {
  const error = Object.create(null);
  for (const field of ['name', 'message', 'stack']) {
    Object.defineProperty(error, field, { get() { throw new Error('Getter rejected'); } });
  }
  const h = harness(() => { throw error; });
  for (const result of await resultsOf(h.probe)) {
    assert.equal(result.stage, 'import_sign_key');
    assert.deepEqual(result.error, { name: 'Error', message: 'Unknown crypto exception', stack: '' });
  }
});
