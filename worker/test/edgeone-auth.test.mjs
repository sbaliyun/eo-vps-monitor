import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, JWT_SECRET } from './helpers.mjs';

const RECOVERY_KEY = 'edgeone-recovery-0123456789abcdefghijklmnopqrstuvwxyz';
const USERNAME = 'admin';
const PASSWORD = 'admin123456';

async function createAdmin(h) {
  const created = await h.call('POST', '/api/admin/recovery', {
    body: { username: USERNAME, password: PASSWORD, recovery_key: RECOVERY_KEY },
    cookieJar: false,
  });
  assert.equal(created.status, 200, created.text);
  const login = await h.call('POST', '/api/login', { body: { username: USERNAME, password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  return login.json;
}

test('EdgeOne 首次管理员只能凭独立恢复密钥创建，普通登录不创建账号', async () => {
  const h = await createHarness({ EDGEONE: true, ADMIN_RECOVERY_KEY: RECOVERY_KEY });
  try {
    const status = await h.call('GET', '/api/admin/recovery/status');
    assert.equal(status.json.admin_present, false);
    assert.equal(status.json.recoverable, true);
    assert.equal(status.json.mfa_supported, false);

    const firstLogin = await h.call('POST', '/api/login', { body: { username: USERNAME, password: PASSWORD } });
    assert.equal(firstLogin.status, 409);
    assert.match(firstLogin.json.error, /忘记密码.*ADMIN_RECOVERY_KEY/);

    const sessionKey = await h.call('POST', '/api/admin/recovery', {
      body: { username: USERNAME, password: PASSWORD, recovery_key: JWT_SECRET },
    });
    assert.equal(sessionKey.status, 403, '会话密钥不能用来初始化管理员');
    const unchanged = await h.call('GET', '/api/admin/recovery/status');
    assert.equal(unchanged.json.admin_present, false);

    await createAdmin(h);
    const me = await h.call('GET', '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.username, USERNAME);
    const noCsrf = await h.call('POST', '/api/admin/clients/add', {
      body: { name: 'node' }, headers: { 'x-csrf-token': 'invalid' },
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    h.restore();
  }
});

test('EdgeOne 缺少 ADMIN_RECOVERY_KEY 时返回 503，不回落 JWT_SECRET', async () => {
  const h = await createHarness({ EDGEONE: 'true', ADMIN_RECOVERY_KEY: '' });
  try {
    const status = await h.call('GET', '/api/admin/recovery/status');
    assert.equal(status.json.recoverable, false);
    assert.equal(status.json.recovery_key_configured, false);
    const created = await h.call('POST', '/api/admin/recovery', {
      body: { username: USERNAME, password: PASSWORD, recovery_key: JWT_SECRET },
    });
    assert.equal(created.status, 503);
    assert.equal(created.json.code, 'ADMIN_RECOVERY_KEY_REQUIRED');
    assert.equal(JSON.parse(h.memory.data.get('core') || '{}').users?.length || 0, 0);
  } finally {
    h.restore();
  }
});

test('EdgeOne 明确禁用 MFA 设置、启用、恢复码与一次性验证，并保留普通登录', async () => {
  const h = await createHarness({ EDGEONE: true, ADMIN_RECOVERY_KEY: RECOVERY_KEY });
  try {
    await createAdmin(h);
    const status = await h.call('GET', '/api/admin/account/mfa');
    assert.equal(status.json.supported, false);
    assert.equal(status.json.enabled, false);
    for (const path of ['setup', 'enable', 'recovery-codes', 'step-up']) {
      const result = await h.call('POST', `/api/admin/account/mfa/${path}`, { body: { password: PASSWORD } });
      assert.equal(result.status, 503, `${path}: ${result.text}`);
      assert.equal(result.json.code, 'MFA_UNSUPPORTED_ON_EDGEONE');
      assert.equal(result.json.recovery_codes, undefined);
      assert.equal(result.json.setup_token, undefined);
    }
    const mfaLogin = await h.call('POST', '/api/login/mfa', { body: {}, cookieJar: false });
    assert.equal(mfaLogin.status, 503);
    assert.equal(mfaLogin.json.code, 'MFA_UNSUPPORTED_ON_EDGEONE');
    const core = JSON.parse(h.memory.data.get('core'));
    assert.equal(core.users[0].totp_secret_enc, null);
    assert.deepEqual(core.users[0].recovery_code_hashes, []);
    await h.call('POST', '/api/logout');
    const login = await h.call('POST', '/api/login', { body: { username: USERNAME, password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal(login.json.mfa_required, undefined);
  } finally {
    h.restore();
  }
});

test('EdgeOne 拒绝过短或与会话密钥相同的恢复密钥配置', async () => {
  for (const key of ['short', JWT_SECRET]) {
    const h = await createHarness({ EDGEONE: true, ADMIN_RECOVERY_KEY: key });
    try {
      const setup = await h.call('GET', '/api/setup/status');
      assert.equal(setup.json.ok, false);
      const status = await h.call('GET', '/api/admin/recovery/status');
      assert.equal(status.json.recoverable, false);
      const created = await h.call('POST', '/api/admin/recovery', {
        body: { username: USERNAME, password: PASSWORD, recovery_key: key },
      });
      assert.equal(created.status, 503);
      assert.equal(created.json.code, 'ADMIN_RECOVERY_KEY_REQUIRED');
      assert.equal(JSON.parse(h.memory.data.get('core') || '{}').users?.length || 0, 0);
    } finally {
      h.restore();
    }
  }
});

test('迁入 EdgeOne 的旧 MFA 账号不能绕过验证，可通过恢复密钥重置后登录', async () => {
  const h = await createHarness({ ADMIN_RECOVERY_KEY: RECOVERY_KEY });
  try {
    await createAdmin(h);
    const setup = await h.call('POST', '/api/admin/account/mfa/setup', { body: { password: PASSWORD } });
    assert.equal(setup.status, 200, setup.text);
    const code = await h.worker.generateTotpCode(setup.json.secret, Date.now());
    const enabled = await h.call('POST', '/api/admin/account/mfa/enable', {
      body: { setup_token: setup.json.setup_token, code },
    });
    assert.equal(enabled.status, 200, enabled.text);
    h.env.EDGEONE = true;

    const sensitive = await h.call('POST', '/api/admin/download/backup', { body: { backup_password: 'backup-pass' } });
    assert.equal(sensitive.status, 503, '旧会话不能绕过敏感操作 MFA');
    const login = await h.call('POST', '/api/login', {
      body: { username: USERNAME, password: PASSWORD }, cookieJar: false,
    });
    assert.equal(login.status, 503);
    assert.equal(login.json.code, 'MFA_UNSUPPORTED_ON_EDGEONE');
    assert.equal(login.json.challenge, undefined);

    const recovered = await h.call('POST', '/api/admin/recovery', {
      body: { username: USERNAME, password: PASSWORD, recovery_key: RECOVERY_KEY }, cookieJar: false,
    });
    assert.equal(recovered.status, 200, recovered.text);
    assert.equal(recovered.json.mode, 'reset');
    const core = JSON.parse(h.memory.data.get('core'));
    assert.equal(core.users[0].totp_secret_enc, null);
    assert.equal(core.users[0].totp_enabled_at, null);
    assert.deepEqual(core.users[0].recovery_code_hashes, []);
    const restoredLogin = await h.call('POST', '/api/login', { body: { username: USERNAME, password: PASSWORD } });
    assert.equal(restoredLogin.status, 200, restoredLogin.text);
  } finally {
    h.restore();
  }
});
