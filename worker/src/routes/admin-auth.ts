/**
 * 管理接口鉴权：会话 JWT + session_version 校验、CSRF、敏感操作二次验证。
 */

import type { MiddlewareHandler } from 'hono';
import { AuthConfigurationError, verifyAdminToken } from '../auth/jwt';
import { isMfaStepUpProtectedRequest } from '../auth/mfa-policy';
import { verifyMfaToken } from '../auth/mfa-token';
import { getAdminSessionToken, getMfaStepUpToken, verifyAdminCsrfToken } from '../auth/session';
import { findUserByUuid, readCore } from '../store/core';
import { queueThrottledAudit } from '../services/notify';
import { clientIp, services, type HonoEnv } from './common';

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

export const adminAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const token = getAdminSessionToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const env = c.env as { JWT_SECRET?: string };
  let payload;
  try {
    payload = await verifyAdminToken(token, env);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
      return c.json({ error: 'Server authentication is not configured' }, 500);
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!payload) return c.json({ error: 'Unauthorized' }, 401);

  const app = services(c);
  const core = await readCore(app);
  const user = findUserByUuid(core, payload.userId);
  if (!user || user.username !== payload.username || user.session_version !== payload.sessionVersion) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  c.set('userId', user.uuid);
  c.set('username', user.username);

  if (!isSafeMethod(c.req.method)) {
    if (!verifyAdminCsrfToken(c)) {
      queueThrottledAudit(app, `csrf:${user.username}:${clientIp(c)}:${c.req.path}`, user.username, 'csrf_rejected',
        `拒绝缺少或无效 CSRF token 的管理写请求: ${c.req.path}; ip=${clientIp(c)}`, 'warning');
      return c.json({ error: 'CSRF token 无效，请刷新页面后重试' }, 403);
    }
    if (isMfaStepUpProtectedRequest(c.req.method, c.req.path) && user.totp_enabled_at && user.totp_secret_enc) {
      const stepUpToken = getMfaStepUpToken(c);
      let stepUp = null;
      try {
        stepUp = stepUpToken ? await verifyMfaToken(stepUpToken, 'mfa-step-up', env) : null;
      } catch (error) {
        if (error instanceof AuthConfigurationError) return c.json({ error: 'Server authentication is not configured' }, 500);
        throw error;
      }
      if (!stepUp || stepUp.userId !== user.uuid || stepUp.username !== user.username || stepUp.sessionVersion !== user.session_version) {
        return c.json({ code: 'MFA_STEP_UP_REQUIRED', error: '需要双重身份验证确认' }, 428);
      }
    }
  }
  await next();
  return undefined;
};
