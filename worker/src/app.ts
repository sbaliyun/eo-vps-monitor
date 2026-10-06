/**
 * EO VPS Monitor - 腾讯云 EdgeOne Pages 版本
 * Hono + 原生 KV；保留原 ESA 测试入口的兼容行为。
 */

import { Hono } from 'hono';
import { APP_VERSION, BUILD_COMMIT } from './utils/app-version';
import { shortGitSha } from './utils/update-check';
import { readAdminRecoveryKey, readEnvString } from './platform/env';
import { checkSessionCrypto, type SessionCryptoStatus } from './auth/jwt';
import { probeHmacRuntime } from './auth/crypto-diagnostics';
import { checkPasswordCrypto, type PasswordCryptoStatus } from './auth/password-diagnostics';
import { createAppServices, type AppServices } from './platform/context';
import { isEdgeOneKvAvailable } from './platform/kv';
import unixInstaller from '../../agent/install.sh';
import linuxInstaller from '../../agent/install-linux.sh';
import windowsInstaller from '../../agent/install-windows.ps1';
import { readCore } from './store/core';
import { maybeRunMaintenance } from './services/maintenance';
import { authRoutes } from './routes/auth';
import { publicRoutes } from './routes/public';
import { agentRoutes } from './routes/agent';
import { adminAuth } from './routes/admin-auth';
import { adminRoutes } from './routes/admin';
import { adminThemeRoutes, publicThemeRoutes } from './routes/theme';
import { services, type HonoEnv } from './routes/common';

export const REPOSITORY = 'sbaliyun/eo-vps-monitor';
const RAW_BASE = `https://raw.githubusercontent.com/${REPOSITORY}/main/agent`;

function agentInstaller(env: Record<string, unknown>, source: string): string {
  const value = typeof env.AGENT_REPOSITORY === 'string' ? env.AGENT_REPOSITORY.trim() : '';
  const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : REPOSITORY;
  return source.replace(/sbaliyun\/(?:esa|cf|eo)-vps-monitor/g, () => repository);
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: https:; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < y.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** 外部定时器密钥：优先 CRON_SECRET，否则由 JWT_SECRET 派生（后台「设置 → 通用设置」可看到完整地址）。 */
export async function resolveCronSecret(env: Record<string, unknown>): Promise<string> {
  const explicit = typeof env.CRON_SECRET === 'string' ? env.CRON_SECRET.trim() : '';
  if (explicit) return explicit;
  const jwt = typeof env.JWT_SECRET === 'string' ? env.JWT_SECRET.trim() : '';
  if (new TextEncoder().encode(jwt).byteLength < 32) return '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(jwt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const purpose = env.EDGEONE ? 'eo-vps-monitor/cron/v1' : 'esa-vps-monitor/cron/v1';
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(purpose)));
  return Array.from(signature.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const SERVICES_ENV_KEY = '__esa_vps_monitor_services';

export function createApp(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // 每个请求的 KV 会话与子请求预算由入口创建后放在 env 上，这里挂到上下文。
  app.use('*', async (c, next) => {
    const injected = (c.env as Record<string, unknown>)[SERVICES_ENV_KEY] as AppServices | undefined;
    c.set('app', injected ?? createAppServices(c.env, undefined));
    await next();
  });

  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) c.header(name, value);
    }
  });

  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  for (const [name, source] of [
    ['install.sh', unixInstaller], ['install-linux.sh', linuxInstaller], ['install-windows.ps1', windowsInstaller],
  ]) {
    app.get(`/agent/${name}`, (c) => c.env.EDGEONE
      ? new Response(agentInstaller(c.env, source), { headers: {
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      } })
      : c.redirect(`${RAW_BASE}/${name}`, 302));
  }

  app.get('/ping', (c) => c.text('pong'));

  app.get('/api/version', (c) => {
    const commit = shortGitSha(readEnvString(c.env, 'CURRENT_GIT_COMMIT') || BUILD_COMMIT);
    return c.json({ version: APP_VERSION, name: c.env.EDGEONE ? 'EO VPS Monitor' : 'ESA VPS Monitor', hash: commit || 'dev', build: commit || `release-${APP_VERSION}`, platform: c.env.EDGEONE ? 'tencent-edgeone' : 'aliyun-esa' });
  });

  // 部署自检：不暴露任何密钥，只报告配置是否就绪。
  app.get('/api/setup/status', async (c) => {
    const app = services(c);
    const jwtOk = new TextEncoder().encode(readEnvString(c.env, 'JWT_SECRET')).byteLength >= 32;
    let kvOk = false;
    let adminPresent: boolean | null = null;
    let kvError = '';
    try {
      const core = await readCore(app, 0);
      kvOk = true;
      adminPresent = core.users.length > 0;
    } catch (error) {
      kvError = error instanceof Error ? error.message : String(error);
    }
    const recoveryOk = !c.env.EDGEONE || Boolean(readAdminRecoveryKey(c.env));
    const sessionCrypto: SessionCryptoStatus = c.env.EDGEONE
      ? await checkSessionCrypto(c.env)
      : { ok: true };
    const passwordCrypto: PasswordCryptoStatus = c.env.EDGEONE
      ? await checkPasswordCrypto()
      : { ok: true };
    const hmacRuntime = c.env.EDGEONE && !sessionCrypto.ok ? await probeHmacRuntime() : undefined;
    if (sessionCrypto.diagnostic) {
      console.error('[auth] session crypto self-check failed:', JSON.stringify({
        error: sessionCrypto.error, ...sessionCrypto.diagnostic, hmac: hmacRuntime,
      }));
    }
    if (passwordCrypto.diagnostic) {
      console.error('[auth] password crypto self-check failed:', JSON.stringify({
        error: passwordCrypto.error, ...passwordCrypto.diagnostic,
      }));
    }
    return c.json({
      ok: jwtOk && kvOk && recoveryOk && sessionCrypto.ok && passwordCrypto.ok,
      platform: c.env.EDGEONE ? 'tencent-edgeone' : 'aliyun-esa',
      ...(c.env.EDGEONE ? { runtime: {
        crypto_key_constructor: typeof (globalThis as Record<string, unknown>).CryptoKey === 'function',
        session_crypto_error: sessionCrypto.error || null,
        password_crypto_error: passwordCrypto.error || null,
        ...(sessionCrypto.diagnostic ? { session_crypto_diagnostic: sessionCrypto.diagnostic, hmac: hmacRuntime } : {}),
        ...(passwordCrypto.diagnostic ? { password_crypto_diagnostic: passwordCrypto.diagnostic } : {}),
      } } : {}),
      checks: [
        { key: 'jwt_secret', status: jwtOk ? 'ok' : 'error', detail: jwtOk ? 'JWT_SECRET 已配置' : '缺少 JWT_SECRET 或不足 32 字节' },
        { key: 'edge_kv', status: kvOk ? 'ok' : 'error', detail: kvOk ? (isEdgeOneKvAvailable(c.env.MONITOR_KV) ? 'EdgeOne KV 绑定 MONITOR_KV 可读' : '本地内存 KV') : kvError },
        ...(c.env.EDGEONE ? [{ key: 'admin_recovery_key', status: recoveryOk ? 'ok' : 'error', detail: recoveryOk ? 'ADMIN_RECOVERY_KEY 已配置' : '请设置至少 32 字节的独立 ADMIN_RECOVERY_KEY' }] : []),
        ...(c.env.EDGEONE ? [{ key: 'session_crypto', status: sessionCrypto.ok ? 'ok' : 'error', detail: sessionCrypto.ok ? '会话签名和验证可用' : '会话加密功能不可用，请查看接口诊断' },
          { key: 'password_crypto', status: passwordCrypto.ok ? 'ok' : 'error', detail: passwordCrypto.ok ? '密码计算符合 PBKDF2 标准向量，随机盐验证可用' : '密码计算自检失败，请查看接口诊断' }] : []),
        { key: 'admin', status: adminPresent ? 'ok' : 'warning', detail: adminPresent ? '管理员已创建' : '尚未创建管理员，请访问 /login' },
      ],
    });
  });

  // 外部定时器入口（可选）：GET/POST /api/cron?key=<CRON_SECRET>
  app.all('/api/cron', async (c) => {
    const expected = await resolveCronSecret(c.env);
    const provided = c.req.query('key') || (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!expected || !await timingSafeEqual(provided, expected)) return c.json({ error: 'Unauthorized' }, 401);
    const result = await maybeRunMaintenance(services(c), 'external', { force: true });
    return c.json({ success: true, ...result });
  });

  app.route('/api/theme', publicThemeRoutes);
  app.route('/api/clients', agentRoutes);
  app.route('/api', authRoutes);
  app.route('/api', publicRoutes);

  app.use('/api/admin/*', adminAuth);
  app.get('/api/admin/cron/secret', async (c) => {
    const secret = await resolveCronSecret(c.env);
    const origin = new URL(c.req.url).origin;
    return c.json({ url: secret ? `${origin}/api/cron?key=${secret}` : '', explicit: Boolean(readEnvString(c.env, 'CRON_SECRET')) });
  });
  app.route('/api/admin/themes', adminThemeRoutes);
  app.route('/api/admin', adminRoutes);

  app.notFound((c) => {
    const url = new URL(c.req.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/ping') {
      return c.text('EO VPS Monitor: 前端资源不存在。请运行 npm run build 并部署 edgeone-dist。', 404);
    }
    return c.json({ error: 'Not Found' }, 404);
  });

  app.onError((error, c) => {
    console.error('[app] unhandled error:', error instanceof Error ? error.stack || error.message : String(error));
    const status = (error as Error & { status?: number }).status;
    if (status === 413) return c.json({ error: '保存内容超过 EdgeOne KV 的应用大小限制（900 KiB），请减少数据量。' }, 413);
    return c.json({ error: '服务器内部错误' }, 500);
  });

  return app;
}
