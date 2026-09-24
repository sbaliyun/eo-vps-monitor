/**
 * 账户管理：用户名、密码、TOTP 双重身份验证、敏感操作二次确认。
 */

import { Hono } from 'hono';
import type { User } from '../db/types';
import { AuthConfigurationError, generateToken } from '../auth/jwt';
import { decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes } from '../auth/mfa';
import { generateMfaSetupToken, generateMfaToken, verifyMfaSetupToken } from '../auth/mfa-token';
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from '../auth/totp';
import { hashPassword, validateAdminPasswordStrength, verifyPassword } from '../auth/password';
import { clearMfaStepUpCookie, setAdminSessionCookie, setMfaStepUpCookie } from '../auth/session';
import { findUserByUsername, findUserByUuid, mutateCore, readCore } from '../store/core';
import { clearObserved, loadRateLimits, recordFailures, retryAfterSeconds } from '../store/ratelimit';
import { queueAudit } from '../services/notify';
import { auditLoginFailure, mfaRateLimitBuckets, verifyAndConsumeMfa } from './auth';
import { clientIp, readJsonObject, services, type AppContext, type HonoEnv } from './common';

export const accountRoutes = new Hono<HonoEnv>();

const MAX_ADMIN_USERNAME_BYTES = 64;

async function currentUser(c: AppContext): Promise<User | null> {
  const core = await readCore(services(c), 0);
  return findUserByUuid(core, c.get('userId'));
}

async function issueSession(c: AppContext, user: User): Promise<Response | null> {
  try {
    const token = await generateToken(user.uuid, user.username, user.session_version, c.env as { JWT_SECRET?: string });
    setAdminSessionCookie(c, token);
    clearMfaStepUpCookie(c);
    return null;
  } catch (error) {
    if (error instanceof AuthConfigurationError) return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
    throw error;
  }
}

/** 修改 core 中的当前用户并递增会话版本（其他会话失效），返回更新后的用户。 */
async function mutateCurrentUser(c: AppContext, mutate: (user: User) => void): Promise<User | null> {
  const app = services(c);
  return mutateCore(app, (core) => {
    const user = findUserByUuid(core, c.get('userId'));
    if (!user) return null;
    mutate(user);
    user.session_version += 1;
    user.updated_at = new Date(app.now()).toISOString();
    return { ...user };
  });
}

async function mfaRateLimited(c: AppContext, user: User) {
  const app = services(c);
  const buckets = mfaRateLimitBuckets(clientIp(c), user.uuid);
  const states = await loadRateLimits(app, buckets);
  const retryAfter = retryAfterSeconds(states, app.now());
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    return { response: c.json({ code: 'MFA_RATE_LIMITED', error: `验证尝试过于频繁，请 ${retryAfter} 秒后再试` }, 429), buckets, states };
  }
  return { response: null, buckets, states };
}

accountRoutes.get('/account/mfa', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  return c.json({
    enabled: Boolean(user.totp_enabled_at && user.totp_secret_enc),
    enabled_at: user.totp_enabled_at,
    recovery_codes_remaining: Array.isArray(user.recovery_code_hashes) ? user.recovery_code_hashes.length : 0,
  });
});

accountRoutes.post('/account/mfa/setup', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const password = typeof parsed.body.password === 'string' ? parsed.body.password : '';
  if (!password || password.length > 4096) return c.json({ error: '当前密码无效' }, 400);
  const user = await currentUser(c);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  const limited = await mfaRateLimited(c, user);
  if (limited.response) return limited.response;
  const app = services(c);
  if (!await verifyPassword(password, user.passwd)) {
    await recordFailures(app, limited.buckets, app.now());
    auditLoginFailure(c, user.username, clientIp(c), 'invalid_mfa_setup_password');
    return c.json({ error: '当前密码错误' }, 401);
  }
  await clearObserved(app, limited.states);
  const env = c.env as { JWT_SECRET?: string };
  const secret = generateTotpSecret();
  const encryptedSecret = await encryptTotpSecret(secret, user.uuid, env);
  const setupToken = await generateMfaSetupToken({
    userId: user.uuid,
    username: user.username,
    sessionVersion: user.session_version,
    encryptedSecret,
  }, env);
  return c.json({ setup_token: setupToken, secret, uri: buildTotpUri({ secret, username: user.username, issuer: 'ESA VPS Monitor' }) });
});

accountRoutes.post('/account/mfa/enable', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const setupToken = typeof parsed.body.setup_token === 'string' ? parsed.body.setup_token : '';
  const code = typeof parsed.body.code === 'string' ? parsed.body.code.trim() : '';
  if (!setupToken || setupToken.length > 4096 || !/^\d{6}$/.test(code)) return c.json({ error: '绑定参数无效' }, 400);
  const user = await currentUser(c);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  const env = c.env as { JWT_SECRET?: string };
  const setup = await verifyMfaSetupToken(setupToken, env);
  if (!setup || setup.userId !== user.uuid || setup.username !== user.username || setup.sessionVersion !== user.session_version) {
    return c.json({ error: '绑定信息已失效，请重新开始' }, 401);
  }
  const limited = await mfaRateLimited(c, user);
  if (limited.response) return limited.response;
  const app = services(c);
  const secret = await decryptTotpSecret(setup.encryptedSecret, user.uuid, env);
  const result = await verifyTotpCode(secret, code);
  if (!result.valid || result.step === undefined) {
    await recordFailures(app, limited.buckets, app.now());
    auditLoginFailure(c, user.username, clientIp(c), 'invalid_mfa_enrollment_code');
    return c.json({ error: '验证码无效，请确认服务器时间准确' }, 401);
  }
  const recovery = await generateRecoveryCodes(env);
  const step = result.step;
  const updated = await mutateCurrentUser(c, (target) => {
    target.totp_secret_enc = setup.encryptedSecret;
    target.totp_enabled_at = new Date(app.now()).toISOString();
    target.totp_last_used_step = step;
    target.recovery_code_hashes = recovery.hashes;
  });
  if (!updated) return c.json({ error: '用户不存在' }, 404);
  const failed = await issueSession(c, updated);
  if (failed) return failed;
  queueAudit(app, user.username, 'mfa_enabled', '启用 TOTP 双重身份验证', 'warning');
  return c.json({ success: true, recovery_codes: recovery.codes });
});

accountRoutes.post('/account/mfa/recovery-codes', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  if (!user.totp_enabled_at) return c.json({ error: '尚未启用双重身份验证' }, 409);
  const recovery = await generateRecoveryCodes(c.env as { JWT_SECRET?: string });
  const updated = await mutateCurrentUser(c, (target) => { target.recovery_code_hashes = recovery.hashes; });
  if (!updated) return c.json({ error: '无法更新恢复码' }, 409);
  const failed = await issueSession(c, updated);
  if (failed) return failed;
  queueAudit(services(c), user.username, 'mfa_recovery_codes_regenerated', '重新生成恢复码', 'warning');
  return c.json({ success: true, recovery_codes: recovery.codes });
});

accountRoutes.post('/account/mfa/disable', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  if (!user.totp_enabled_at) return c.json({ success: true });
  const updated = await mutateCurrentUser(c, (target) => {
    target.totp_secret_enc = null;
    target.totp_enabled_at = null;
    target.totp_last_used_step = 0;
    target.recovery_code_hashes = [];
  });
  if (!updated) return c.json({ error: '用户不存在' }, 404);
  const failed = await issueSession(c, updated);
  if (failed) return failed;
  queueAudit(services(c), user.username, 'mfa_disabled', '关闭 TOTP 双重身份验证', 'warning');
  return c.json({ success: true });
});

accountRoutes.post('/account/mfa/step-up', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const method = parsed.body.method === 'totp' || parsed.body.method === 'recovery_code' ? parsed.body.method : null;
  const code = typeof parsed.body.code === 'string' ? parsed.body.code.trim() : '';
  if (!method || !code || code.length > 128) return c.json({ code: 'MFA_INPUT_INVALID', error: '双重身份验证参数无效' }, 400);
  const user = await currentUser(c);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  if (!user.totp_enabled_at || !user.totp_secret_enc) return c.json({ error: '尚未启用双重身份验证' }, 409);
  const limited = await mfaRateLimited(c, user);
  if (limited.response) return limited.response;
  const app = services(c);
  let verified = false;
  try {
    verified = await verifyAndConsumeMfa(c, user, method, code);
  } catch (error) {
    if (error instanceof AuthConfigurationError) return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
    return c.json({ error: '双重身份验证配置损坏，请使用管理员恢复功能' }, 500);
  }
  if (!verified) {
    await recordFailures(app, limited.buckets, app.now());
    auditLoginFailure(c, user.username, clientIp(c), 'invalid_mfa_step_up');
    return c.json({ code: 'MFA_INVALID', error: '验证码或恢复码无效' }, 401);
  }
  await clearObserved(app, limited.states);
  const token = await generateMfaToken({
    userId: user.uuid,
    username: user.username,
    sessionVersion: user.session_version,
    purpose: 'mfa-step-up',
  }, c.env as { JWT_SECRET?: string });
  setMfaStepUpCookie(c, token);
  queueAudit(app, user.username, 'mfa_step_up', '完成敏感操作二次确认');
  return c.json({ success: true, expires_in: 300 });
});

accountRoutes.post('/account/username', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const nextUsername = typeof parsed.body.username === 'string' ? parsed.body.username.trim() : '';
  if (!nextUsername) return c.json({ error: '用户名不能为空' }, 400);
  if (new TextEncoder().encode(nextUsername).byteLength > MAX_ADMIN_USERNAME_BYTES) return c.json({ error: `用户名不能超过 ${MAX_ADMIN_USERNAME_BYTES} 字节` }, 400);
  if (/[\u0000-\u001F\u007F]/.test(nextUsername)) return c.json({ error: '用户名包含无效字符' }, 400);
  const user = await currentUser(c);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  if (user.username === nextUsername) return c.json({ success: true, user: { uuid: user.uuid, username: user.username } });
  const core = await readCore(services(c), 0);
  const existing = findUserByUsername(core, nextUsername);
  if (existing && existing.uuid !== user.uuid) return c.json({ error: '用户名已存在' }, 409);
  const updated = await mutateCurrentUser(c, (target) => { target.username = nextUsername; });
  if (!updated) return c.json({ error: 'User not found' }, 404);
  const failed = await issueSession(c, updated);
  if (failed) return failed;
  queueAudit(services(c), user.username, 'account_username_edit', `修改用户名: ${user.username} -> ${nextUsername}`);
  return c.json({ success: true, user: { uuid: updated.uuid, username: updated.username } });
});

accountRoutes.post('/account/chpasswd', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const { old_password: oldPassword, new_password: newPassword } = parsed.body;
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') return c.json({ error: '密码格式错误' }, 400);
  const user = await currentUser(c);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  const strengthError = validateAdminPasswordStrength(newPassword, user.username);
  if (strengthError) return c.json({ error: `新密码不符合强度要求：${strengthError}` }, 400);
  if (!await verifyPassword(oldPassword, user.passwd)) return c.json({ error: '旧密码错误' }, 400);
  const hashed = await hashPassword(newPassword);
  const app = services(c);
  const updated = await mutateCurrentUser(c, (target) => {
    target.passwd = hashed;
    target.password_changed_at = new Date(app.now()).toISOString();
  });
  if (!updated) return c.json({ error: '用户不存在' }, 404);
  const failed = await issueSession(c, updated);
  if (failed) return failed;
  queueAudit(app, user.username, 'chpasswd', '修改密码');
  return c.json({ success: true });
});
