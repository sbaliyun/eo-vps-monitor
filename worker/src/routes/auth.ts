/**
 * 登录、二次验证、退出、当前用户、管理员创建/恢复。
 */

import { Hono } from 'hono';
import type { User } from '../db/types';
import { AuthConfigurationError, generateToken, verifyAdminToken } from '../auth/jwt';
import { decryptTotpSecret, hashRecoveryCode } from '../auth/mfa';
import { generateMfaToken, verifyMfaToken } from '../auth/mfa-token';
import { verifyTotpCode } from '../auth/totp';
import { hashPassword, needsPasswordRehash, validateAdminPasswordStrength, verifyPassword } from '../auth/password';
import { clearAdminSessionCookie, ensureAdminCsrfCookie, getAdminSessionToken, setAdminSessionCookie, verifyAdminCsrfToken } from '../auth/session';
import { readEnvString } from '../platform/env';
import { findUserByUsername, findUserByUuid, mutateCore, readCore } from '../store/core';
import { clearObserved, loadRateLimits, recordFailures, retryAfterSeconds } from '../store/ratelimit';
import { queueAudit, queueThrottledAudit } from '../services/notify';
import { clientIp, publicRateLimit, readJsonObject, services, type AppContext, type HonoEnv } from './common';

export const authRoutes = new Hono<HonoEnv>();

const MAX_LOGIN_USERNAME_LENGTH = 128;
const MAX_LOGIN_PASSWORD_LENGTH = 4096;
const MAX_MFA_CHALLENGE_LENGTH = 4096;
const MAX_MFA_CODE_LENGTH = 128;
const MAX_RECOVERY_KEY_LENGTH = 8192;
const MAX_ADMIN_USERNAME_BYTES = 64;
const DUMMY_ADMIN_PASSWORD_HASH = 'pbkdf2_sha256$10000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function normalizeLoginUsername(username: string): string {
  return username.trim().toLowerCase().slice(0, MAX_LOGIN_USERNAME_LENGTH);
}

export function loginRateLimitBuckets(ip: string, username: string): string[] {
  return [`login:ip:${ip}`, `login:ip-user:${ip}:${normalizeLoginUsername(username)}`];
}

export function mfaRateLimitBuckets(ip: string, userId: string): string[] {
  return [`mfa:ip:${ip}`, `mfa:ip-user:${ip}:${userId}`];
}

export function auditLoginFailure(c: AppContext, username: string, ip: string, reason: string): void {
  queueThrottledAudit(
    services(c),
    `login:${reason}:${ip}:${normalizeLoginUsername(username)}`,
    username.slice(0, MAX_LOGIN_USERNAME_LENGTH) || 'anonymous',
    'login_failed',
    JSON.stringify({ username: username.slice(0, MAX_LOGIN_USERNAME_LENGTH), ip, reason }),
    'warn',
  );
}

function jwtMisconfigured(c: AppContext): Response {
  console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
  return c.json({ error: '服务端 JWT_SECRET 未正确配置（至少 32 字节）' }, 500);
}

async function completeLogin(c: AppContext, user: User, observed: Awaited<ReturnType<typeof loadRateLimits>>): Promise<Response> {
  let token: string;
  try {
    token = await generateToken(user.uuid, user.username, user.session_version, c.env as { JWT_SECRET?: string });
  } catch (error) {
    if (error instanceof AuthConfigurationError) return jwtMisconfigured(c);
    throw error;
  }
  setAdminSessionCookie(c, token);
  const csrfToken = ensureAdminCsrfCookie(c);
  const app = services(c);
  if ([...observed.values()].some(Boolean)) await clearObserved(app, observed);
  queueAudit(app, user.username, 'login', '用户登录');
  return c.json({ csrf_token: csrfToken, user: { uuid: user.uuid, username: user.username } });
}

async function timingSafeEqualString(actual: string, expected: string): Promise<boolean> {
  if (!actual || !expected) return false;
  const encode = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([encode(actual), encode(expected)]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = actual.length === expected.length ? 0 : 1;
  for (let i = 0; i < right.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function recoveryKeyOf(c: AppContext): string {
  return readEnvString(c.env, 'ADMIN_RECOVERY_KEY') || readEnvString(c.env, 'JWT_SECRET');
}

authRoutes.get('/admin/recovery/status', async (c) => {
  const limited = publicRateLimit(c, 'admin-recovery-status', 30);
  if (limited) return limited;
  const core = await readCore(services(c), 0);
  return c.json({ admin_present: core.users.length > 0, recoverable: core.users.length <= 1 });
});

authRoutes.post('/admin/recovery', async (c) => {
  const limited = publicRateLimit(c, 'admin-recovery', 5);
  if (limited) return limited;
  const parsed = await readJsonObject(c, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const rawKey = body.recovery_key ?? body.admin_recovery_key ?? body.supabase_secret_key;
  const recoveryKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username) return c.json({ error: '用户名不能为空' }, 400);
  if (new TextEncoder().encode(username).byteLength > MAX_ADMIN_USERNAME_BYTES) return c.json({ error: `用户名不能超过 ${MAX_ADMIN_USERNAME_BYTES} 字节` }, 400);
  if (/[\u0000-\u001F\u007F]/.test(username)) return c.json({ error: '用户名包含无效字符' }, 400);
  const passwordError = validateAdminPasswordStrength(password, username);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const expectedKey = recoveryKeyOf(c);
  if (!expectedKey || new TextEncoder().encode(readEnvString(c.env, 'JWT_SECRET')).byteLength < 32) return jwtMisconfigured(c);
  if (!recoveryKey || recoveryKey.length > MAX_RECOVERY_KEY_LENGTH || !await timingSafeEqualString(recoveryKey, expectedKey)) {
    return c.json({ error: '恢复密钥无效（填写部署时设置的 ADMIN_RECOVERY_KEY，未设置时为 JWT_SECRET）' }, 403);
  }

  const app = services(c);
  const hashedPassword = await hashPassword(password);
  const now = new Date(app.now()).toISOString();
  const outcome = await mutateCore(app, (core) => {
    if (core.users.length > 1) return { error: 'multiple' as const };
    if (core.users.length === 0) {
      const user: User = {
        uuid: crypto.randomUUID(),
        username,
        passwd: hashedPassword,
        session_version: 1,
        password_changed_at: now,
        totp_secret_enc: null,
        totp_enabled_at: null,
        totp_last_used_step: 0,
        recovery_code_hashes: [],
        created_at: now,
        updated_at: now,
      };
      core.users.push(user);
      return { mode: 'created' as const, user };
    }
    const existing = core.users[0];
    existing.username = username;
    existing.passwd = hashedPassword;
    existing.session_version += 1;
    existing.password_changed_at = now;
    existing.totp_secret_enc = null;
    existing.totp_enabled_at = null;
    existing.totp_last_used_step = 0;
    existing.recovery_code_hashes = [];
    existing.updated_at = now;
    return { mode: 'reset' as const, user: existing };
  });
  if ('error' in outcome) return c.json({ error: '当前存在多个管理员账号，请登录后在账户管理中修改密码' }, 409);
  queueAudit(app, username, 'admin_recovery', outcome.mode === 'created' ? '首次创建管理员账号' : '通过恢复密钥重置管理员账号', 'warning');
  return c.json({ success: true, mode: outcome.mode, user: { uuid: outcome.user.uuid, username: outcome.user.username } });
});

authRoutes.post('/login', async (c) => {
  const parsed = await readJsonObject(c, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const { username, password } = parsed.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return c.json({ error: '用户名和密码不能为空' }, 400);
  }
  if (username.length > MAX_LOGIN_USERNAME_LENGTH || password.length > MAX_LOGIN_PASSWORD_LENGTH) {
    return c.json({ error: '用户名或密码长度超出限制' }, 400);
  }
  const app = services(c);
  const ip = clientIp(c);
  const buckets = loginRateLimitBuckets(ip, username);
  const states = await loadRateLimits(app, buckets);
  const retryAfter = retryAfterSeconds(states, app.now());
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    auditLoginFailure(c, username, ip, 'rate_limited');
    return c.json({ error: `登录尝试过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  }

  const core = await readCore(app, 0);
  const user = findUserByUsername(core, username);
  if (!user) {
    await verifyPassword(password, DUMMY_ADMIN_PASSWORD_HASH);
    await recordFailures(app, buckets, app.now());
    auditLoginFailure(c, username, ip, 'unknown_user');
    if (core.users.length === 0) return c.json({ error: '请先在登录页创建管理员账号' }, 409);
    return c.json({ error: '用户名或密码错误' }, 401);
  }
  if (!await verifyPassword(password, user.passwd)) {
    await recordFailures(app, buckets, app.now());
    auditLoginFailure(c, username, ip, 'invalid_password');
    return c.json({ error: '用户名或密码错误' }, 401);
  }
  if (needsPasswordRehash(user.passwd)) {
    const hashed = await hashPassword(password);
    await mutateCore(app, (doc) => {
      const target = findUserByUuid(doc, user.uuid);
      if (target) target.passwd = hashed;
    });
  }
  if (user.totp_enabled_at && user.totp_secret_enc) {
    try {
      const challenge = await generateMfaToken({
        userId: user.uuid,
        username: user.username,
        sessionVersion: user.session_version,
        purpose: 'mfa-login',
      }, c.env as { JWT_SECRET?: string });
      return c.json({ code: 'MFA_REQUIRED', mfa_required: true, challenge, methods: ['totp', 'recovery_code'] });
    } catch (error) {
      if (error instanceof AuthConfigurationError) return jwtMisconfigured(c);
      throw error;
    }
  }
  return completeLogin(c, user, states);
});

/** 校验 TOTP 或恢复码，并在 core 中消费（防重放）。 */
export async function verifyAndConsumeMfa(c: AppContext, user: User, method: 'totp' | 'recovery_code', code: string): Promise<boolean> {
  const app = services(c);
  const env = c.env as { JWT_SECRET?: string };
  if (!user.totp_enabled_at || !user.totp_secret_enc) return false;
  if (method === 'recovery_code') {
    let hash: string;
    try {
      hash = await hashRecoveryCode(code, env);
    } catch (error) {
      if (error instanceof AuthConfigurationError) throw error;
      return false;
    }
    return mutateCore(app, (doc) => {
      const target = findUserByUuid(doc, user.uuid);
      if (!target || !target.recovery_code_hashes.includes(hash)) return false;
      target.recovery_code_hashes = target.recovery_code_hashes.filter(item => item !== hash);
      target.updated_at = new Date(app.now()).toISOString();
      return true;
    });
  }
  const secret = await decryptTotpSecret(user.totp_secret_enc, user.uuid, env);
  const result = await verifyTotpCode(secret, code);
  if (!result.valid || result.step === undefined) return false;
  const step = result.step;
  return mutateCore(app, (doc) => {
    const target = findUserByUuid(doc, user.uuid);
    if (!target || step <= Number(target.totp_last_used_step || 0)) return false;
    target.totp_last_used_step = step;
    return true;
  });
}

authRoutes.post('/login/mfa', async (c) => {
  const parsed = await readJsonObject(c, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const challenge = typeof parsed.body.challenge === 'string' ? parsed.body.challenge : '';
  const method = parsed.body.method;
  const code = typeof parsed.body.code === 'string' ? parsed.body.code.trim() : '';
  if (!challenge || challenge.length > MAX_MFA_CHALLENGE_LENGTH || (method !== 'totp' && method !== 'recovery_code') || !code || code.length > MAX_MFA_CODE_LENGTH) {
    return c.json({ code: 'MFA_INPUT_INVALID', error: '双重身份验证参数无效' }, 400);
  }
  let payload;
  try {
    payload = await verifyMfaToken(challenge, 'mfa-login', c.env as { JWT_SECRET?: string });
  } catch (error) {
    if (error instanceof AuthConfigurationError) return jwtMisconfigured(c);
    throw error;
  }
  if (!payload) return c.json({ code: 'MFA_CHALLENGE_INVALID', error: '登录验证已失效，请重新登录' }, 401);

  const app = services(c);
  const core = await readCore(app, 0);
  const user = findUserByUuid(core, payload.userId);
  if (!user || user.username !== payload.username || user.session_version !== payload.sessionVersion || !user.totp_enabled_at || !user.totp_secret_enc) {
    return c.json({ code: 'MFA_CHALLENGE_INVALID', error: '登录验证已失效，请重新登录' }, 401);
  }
  const ip = clientIp(c);
  const mfaBuckets = mfaRateLimitBuckets(ip, user.uuid);
  const states = await loadRateLimits(app, [...loginRateLimitBuckets(ip, user.username), ...mfaBuckets]);
  const mfaStates = new Map(mfaBuckets.map(bucket => [bucket, states.get(bucket) || null]));
  const retryAfter = retryAfterSeconds(mfaStates, app.now());
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    auditLoginFailure(c, user.username, ip, 'mfa_rate_limited');
    return c.json({ code: 'MFA_RATE_LIMITED', error: `验证尝试过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  }
  let verified = false;
  try {
    verified = await verifyAndConsumeMfa(c, user, method, code);
  } catch (error) {
    if (error instanceof AuthConfigurationError) return jwtMisconfigured(c);
    console.error('[auth] MFA verification failed:', error instanceof Error ? error.message : String(error));
    return c.json({ error: '双重身份验证配置损坏，请使用管理员恢复功能' }, 500);
  }
  if (!verified) {
    await recordFailures(app, mfaBuckets, app.now());
    auditLoginFailure(c, user.username, ip, 'invalid_mfa');
    return c.json({ code: 'MFA_INVALID', error: '验证码或恢复码无效' }, 401);
  }
  return completeLogin(c, user, states);
});

authRoutes.post('/logout', async (c) => {
  const token = getAdminSessionToken(c);
  if (token && !verifyAdminCsrfToken(c)) return c.json({ error: 'CSRF token 无效，请刷新页面后重试' }, 403);
  let payload = null;
  try {
    payload = token ? await verifyAdminToken(token, c.env as { JWT_SECRET?: string }) : null;
  } catch {
    payload = null;
  }
  if (payload) {
    const app = services(c);
    const userId = payload.userId;
    const sessionVersion = payload.sessionVersion;
    await mutateCore(app, (doc) => {
      const user = findUserByUuid(doc, userId);
      if (user && user.session_version === sessionVersion) {
        user.session_version += 1;
        user.updated_at = new Date(app.now()).toISOString();
      }
    });
  }
  clearAdminSessionCookie(c);
  c.header('Clear-Site-Data', '"cache"');
  return c.json({ success: true });
});

authRoutes.get('/me', async (c) => {
  const token = getAdminSessionToken(c);
  if (!token) return c.json({ error: '未登录' }, 401);
  try {
    const payload = await verifyAdminToken(token, c.env as { JWT_SECRET?: string });
    if (!payload) return c.json({ error: 'Token 无效' }, 401);
    const core = await readCore(services(c));
    const user = findUserByUuid(core, payload.userId);
    if (!user || user.username !== payload.username || user.session_version !== payload.sessionVersion) {
      return c.json({ error: 'Token 无效' }, 401);
    }
    const csrfToken = ensureAdminCsrfCookie(c);
    return c.json({ uuid: user.uuid, username: user.username, csrf_token: csrfToken });
  } catch (error) {
    if (error instanceof AuthConfigurationError) return jwtMisconfigured(c);
    return c.json({ error: 'Token 无效' }, 401);
  }
});
