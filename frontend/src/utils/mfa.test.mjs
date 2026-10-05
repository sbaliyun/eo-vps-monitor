import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatRecoveryCodesText,
  normalizeMfaCode,
  parseLoginResponse,
  runWithMfaStepUpRetry,
} from './mfa.ts';

test('parses successful, MFA-required and failed login responses', () => {
  assert.deepEqual(parseLoginResponse(200, { user: { uuid: 'u1', username: 'admin' } }), {
    kind: 'success',
    user: { uuid: 'u1', username: 'admin' },
  });
  assert.deepEqual(parseLoginResponse(200, {
    code: 'MFA_REQUIRED',
    challenge: 'signed-token',
    methods: ['totp', 'recovery_code'],
  }), {
    kind: 'mfa_required',
    challenge: 'signed-token',
    methods: ['totp', 'recovery_code'],
  });
  assert.deepEqual(parseLoginResponse(401, { error: '用户名或密码错误' }), {
    kind: 'error',
    error: '用户名或密码错误',
  });
});

test('keeps bounded string diagnostics only for an internal login error', () => {
  const diagnostic = {
    stage: 'password-verification',
    error: 'OperationError',
    message: 'HMAC verification failed',
    stack: 'OperationError: HMAC verification failed\n    at verifyPassword',
    password: 'must-not-be-retained',
  };
  assert.deepEqual(parseLoginResponse(500, { error: '服务器内部错误', diagnostic }), {
    kind: 'error',
    error: '服务器内部错误',
    diagnostic: {
      stage: diagnostic.stage,
      error: diagnostic.error,
      message: diagnostic.message,
      stack: diagnostic.stack,
    },
  });
  for (const status of [400, 401, 403, 409, 503]) {
    assert.deepEqual(parseLoginResponse(status, { error: '登录失败', diagnostic }), {
      kind: 'error',
      error: '登录失败',
    });
  }
  assert.deepEqual(parseLoginResponse(200, { user: { uuid: 'u1', username: 'admin' }, diagnostic }), {
    kind: 'success',
    user: { uuid: 'u1', username: 'admin' },
  });
  assert.deepEqual(parseLoginResponse(200, { code: 'MFA_REQUIRED', challenge: 'signed-token', methods: ['totp'], diagnostic }), {
    kind: 'mfa_required',
    challenge: 'signed-token',
    methods: ['totp'],
  });
});

test('limits diagnostic fields and ignores malformed diagnostic values', () => {
  const result = parseLoginResponse(500, {
    error: '服务器内部错误',
    diagnostic: {
      stage: 's'.repeat(10000),
      error: 'e'.repeat(10000),
      message: 'm'.repeat(10000),
      stack: 't'.repeat(10000),
    },
  });
  assert.deepEqual(Object.fromEntries(Object.entries(result.diagnostic).map(([key, value]) => [key, value.length])), {
    stage: 128,
    error: 256,
    message: 2048,
    stack: 8192,
  });
  assert.deepEqual(parseLoginResponse(500, {
    error: '服务器内部错误',
    diagnostic: { stage: 123, error: null, message: { text: 'invalid' }, stack: ['invalid'] },
  }), { kind: 'error', error: '服务器内部错误' });
  assert.deepEqual(parseLoginResponse(500, {
    error: '服务器内部错误',
    diagnostic: { stage: 'login', stack: null },
  }), { kind: 'error', error: '服务器内部错误', diagnostic: { stage: 'login' } });
});

test('normalizes TOTP and recovery-code input without accepting malformed values', () => {
  assert.equal(normalizeMfaCode(' 123 456 ', 'totp'), '123456');
  assert.equal(normalizeMfaCode('abcd-efgh-ijkl-mnop-qrst-uvwx', 'recovery_code'), 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX');
  assert.equal(normalizeMfaCode('12345', 'totp'), null);
  assert.equal(normalizeMfaCode('invalid', 'recovery_code'), null);
});

test('formats recovery codes for a one-time text download', () => {
  const text = formatRecoveryCodesText(['AAAA-BBBB-CCCC-DDDD-EEEE-FFFF'], 'admin');
  assert.match(text, /ESA VPS Monitor/);
  assert.match(text, /admin/);
  assert.match(text, /AAAA-BBBB-CCCC-DDDD-EEEE-FFFF/);
});

test('retries a protected request exactly once after successful step-up', async () => {
  let requests = 0;
  let prompts = 0;
  const response = await runWithMfaStepUpRetry(
    async () => ({ status: ++requests === 1 ? 428 : 200 }),
    async () => { prompts += 1; return true; },
  );
  assert.equal(response.status, 200);
  assert.equal(requests, 2);
  assert.equal(prompts, 1);
});

test('does not retry when step-up is cancelled', async () => {
  let requests = 0;
  const response = await runWithMfaStepUpRetry(
    async () => ({ status: (++requests, 428) }),
    async () => false,
  );
  assert.equal(response.status, 428);
  assert.equal(requests, 1);
});
