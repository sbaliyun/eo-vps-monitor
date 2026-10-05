import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundled = await build({
  absWorkingDir: root,
  entryPoints: ['worker/src/auth/login-diagnostics.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'LoginDiagnostics',
  write: false,
});

function harness(globals = {}) {
  const context = vm.createContext({ TextEncoder, btoa, atob, ...globals });
  vm.runInContext(bundled.outputFiles[0].text, context);
  return (stage, error, sensitive) => JSON.parse(JSON.stringify(
    context.LoginDiagnostics.loginErrorDiagnostic(stage, error, sensitive),
  ));
}

function encodings(value) {
  const bytes = Buffer.from(value, 'utf8');
  const base64 = bytes.toString('base64');
  const urlBase64 = base64.replace(/\+/g, '-').replace(/\//g, '_');
  return [...new Set([
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    encodeURI(value),
    encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()),
    base64,
    base64.replace(/=+$/, ''),
    urlBase64,
    urlBase64.replace(/=+$/, ''),
    bytes.toString('hex'),
    bytes.toString('hex').toUpperCase(),
  ])];
}

test('diagnostics retain the stage and useful Error fields without a Node runtime', () => {
  const diagnostic = harness()('set_session_cookie', {
    name: 'CookieError', message: 'Header append rejected', stack: 'at setAdminSessionCookie (auth.ts:51)',
  });
  assert.deepEqual(diagnostic, {
    stage: 'set_session_cookie', error: 'CookieError', message: 'Header append rejected',
    stack: 'at setAdminSessionCookie (auth.ts:51)',
  });
  assert.deepEqual(Object.keys(diagnostic).sort(), ['error', 'message', 'stack', 'stage']);
});

test('all fields redact raw, trimmed, JSON, URI, base64, base64url and hex credentials', () => {
  const diagnose = harness();
  const secrets = ['  密钥"/\\🙂+\n  ', 'multiple-secret-42'];
  const variants = [...new Set(secrets.flatMap(value => [...encodings(value), ...encodings(value.trim())]))];
  for (const value of variants) {
    const diagnostic = diagnose(value, { name: value, message: value, stack: value }, secrets);
    assert.deepEqual(diagnostic, {
      stage: '[redacted]', error: '[redacted]', message: '[redacted]', stack: '[redacted]',
    }, `Encoding escaped redaction: ${JSON.stringify(value)}`);
  }
});

test('generic JWT and PBKDF2 hashes are redacted without caller-provided credentials', () => {
  const diagnose = harness();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdWJqZWN0In0.signature';
  const shortPayloadJwt = 'eyJhbGciOiJub25lIn0.e30.';
  const passwordHash = 'pbkdf2_sha256$10000$ABCD+/salt==$XYZ+/hash==';
  for (const value of [jwt, shortPayloadJwt, passwordHash, encodeURIComponent(passwordHash)]) {
    assert.equal(diagnose('verify', { message: `Rejected ${value}`, stack: `at verify (${value})` }).message,
      'Rejected [redacted]');
    assert.equal(diagnose('verify', { message: value }).stack, '');
  }
});

test('generic hash masking remains complete when a supplied password overlaps its prefix', () => {
  const hash = 'pbkdf2_sha256$10000$ABCD+/salt==$XYZ+/hash==';
  assert.equal(harness()('verify_password', { message: hash }, ['pbkdf2_sha256']).message, '[redacted]');
});

test('known credentials containing a JWT-like substring are masked as a whole', () => {
  const value = 'prefix-eyJhbGciOiJub25lIn0.e30.-suffix';
  assert.equal(harness()('verify_password', { message: value }, [value]).message, '[redacted]');
});

test('supplied PBKDF2 hashes redact isolated salt and derived hash components and encodings', () => {
  const diagnose = harness();
  const salt = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
  const hash = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
  const stored = `pbkdf2_sha256$10000$${salt.toString('base64')}$${hash.toString('base64')}`;
  for (const bytes of [salt, hash]) {
    const component = bytes.toString('base64');
    const variants = new Set([
      ...encodings(component), component.replace(/=+$/, ''), bytes.toString('base64url'),
      bytes.toString('hex'), bytes.toString('hex').toUpperCase(),
    ]);
    for (const value of variants) {
      const diagnostic = diagnose('derive_password', { name: value, message: value, stack: value }, [stored]);
      assert.equal(diagnostic.error, '[redacted]');
      assert.equal(diagnostic.message, '[redacted]');
      assert.equal(diagnostic.stack, '[redacted]');
    }
  }
});

test('supplied JWTs redact isolated header, payload and signature components and encodings', () => {
  const diagnose = harness();
  const token = [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from('{"sub":"synthetic-admin","name":"中文🙂"}').toString('base64url'),
    Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString('base64url'),
  ].join('.');
  for (const component of token.split('.')) {
    const bytes = Buffer.from(component, 'base64url');
    const variants = new Set([
      ...encodings(component), bytes.toString('base64'), bytes.toString('base64').replace(/=+$/, ''),
      bytes.toString('hex'), bytes.toString('hex').toUpperCase(),
    ]);
    for (const value of variants) {
      const diagnostic = diagnose('sign_session', { name: value, message: value, stack: value }, [token]);
      assert.equal(diagnostic.error, '[redacted]');
      assert.equal(diagnostic.message, '[redacted]');
      assert.equal(diagnostic.stack, '[redacted]');
    }
  }
});

test('diagnostics support DOMException, cross-realm and callable Error-like values', () => {
  const diagnose = harness();
  const callable = () => undefined;
  Object.assign(callable, { message: 'Callable exception', stack: 'callable stack' });
  Object.defineProperty(callable, 'name', { value: 'CallableError' });
  const errors = [
    new DOMException('Synthetic header rejection', 'InvalidStateError'),
    vm.runInNewContext("new Error('Cross-realm header rejection')"),
    callable,
  ];
  for (const error of errors) {
    const diagnostic = diagnose('set_cookie', error);
    assert.equal(diagnostic.error, error.name);
    assert.equal(diagnostic.message, error.message);
    assert.equal(diagnostic.stack, typeof error.stack === 'string' ? error.stack.slice(0, 2000) : '');
  }
});

test('throwing field getters and coercion hooks cannot escape the diagnostic helper', () => {
  const error = Object.create(null);
  for (const field of ['name', 'message', 'stack']) {
    Object.defineProperty(error, field, { get() { throw new Error('Getter rejected'); } });
  }
  Object.defineProperty(error, Symbol.toPrimitive, { get() { throw new Error('Coercion rejected'); } });
  assert.deepEqual(harness()('clear_rate_limit', error), {
    stage: 'clear_rate_limit', error: 'LoginRuntimeError', message: 'Unknown login error', stack: '',
  });
});

test('throwing one field does not discard other readable Error-like fields', () => {
  const error = { message: 'KV write rejected', stack: 'at clearObserved (rate-limit.ts:92)' };
  Object.defineProperty(error, 'name', { get() { throw new Error('Name rejected'); } });
  assert.deepEqual(harness()('clear_rate_limit', error), {
    stage: 'clear_rate_limit', error: 'LoginRuntimeError', message: error.message, stack: error.stack,
  });
});

test('primitive throws keep string messages and safely handle other primitives', () => {
  const diagnose = harness();
  assert.equal(diagnose('clear_rate_limit', 'KV failed for raw-secret', ['raw-secret']).message,
    'KV failed for [redacted]');
  for (const error of [null, undefined, 1, false, Symbol('private')]) {
    assert.deepEqual(diagnose('clear_rate_limit', error), {
      stage: 'clear_rate_limit', error: 'LoginRuntimeError', message: 'Unknown login error', stack: '',
    });
  }
});

test('all output fields are bounded and redaction precedes truncation', () => {
  const diagnose = harness();
  assert.deepEqual(diagnose('t'.repeat(120), {
    name: 'n'.repeat(120), message: 'm'.repeat(500), stack: 's'.repeat(2200),
  }), { stage: 't'.repeat(100), error: 'n'.repeat(100), message: 'm'.repeat(400), stack: 's'.repeat(2000) });
  const secret = 'SECRET-crossing-output-boundary';
  const diagnostic = diagnose('t'.repeat(95) + secret, {
    name: 'n'.repeat(95) + secret, message: 'm'.repeat(395) + secret, stack: 's'.repeat(1995) + secret,
  }, [secret]);
  assert.deepEqual(diagnostic, {
    stage: 't'.repeat(95) + '[reda', error: 'n'.repeat(95) + '[reda',
    message: 'm'.repeat(395) + '[reda', stack: 's'.repeat(1995) + '[reda',
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET/);
});

test('malformed UTF-16 credentials still redact raw, JSON, UTF-8 base64 and hex values', () => {
  const diagnose = harness();
  const secret = 'synthetic-\ud800-secret';
  for (const value of [secret, JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]) {
    assert.equal(diagnose('verify', { message: value }, [secret]).message, '[redacted]');
  }
});

test('a missing base64 encoder does not discard raw, URI or hex redactions', () => {
  const diagnose = harness({ btoa: undefined });
  const secret = 'synthetic / secret';
  for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('hex')]) {
    assert.equal(diagnose('verify', { message: value }, [secret]).message, '[redacted]');
  }
});
