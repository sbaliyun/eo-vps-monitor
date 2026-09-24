/**
 * ESA VPS Monitor - 阿里云 ESA 函数和 Pages 版本
 * Hono + ESA 边缘存储（EdgeKV）
 */

import { Hono } from 'hono';
import { APP_VERSION, BUILD_COMMIT } from './utils/app-version';
import { shortGitSha } from './utils/update-check';
import { readEnvString } from './platform/env';
import { createAppServices, type AppServices } from './platform/context';
import { isEdgeKvAvailable } from './platform/kv';
import { readCore } from './store/core';
import { maybeRunMaintenance } from './services/maintenance';
import { authRoutes } from './routes/auth';
import { publicRoutes } from './routes/public';
import { agentRoutes } from './routes/agent';
import { adminAuth } from './routes/admin-auth';
import { adminRoutes } from './routes/admin';
import { adminThemeRoutes, publicThemeRoutes } from './routes/theme';
import { services, type HonoEnv } from './routes/common';

export const REPOSITORY = 'sbaliyun/esa-vps-monitor';
const RAW_BASE = `https://raw.githubusercontent.com/${REPOSITORY}/main/agent`;

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
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('esa-vps-monitor/cron/v1')));
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

  app.get('/agent/install.sh', (c) => c.redirect(`${RAW_BASE}/install.sh`, 302));
  app.get('/agent/install-linux.sh', (c) => c.redirect(`${RAW_BASE}/install-linux.sh`, 302));
  app.get('/agent/install-windows.ps1', (c) => c.redirect(`${RAW_BASE}/install-windows.ps1`, 302));

  app.get('/ping', (c) => c.text('pong'));

  app.get('/api/version', (c) => {
    const commit = shortGitSha(readEnvString(c.env, 'CURRENT_GIT_COMMIT') || BUILD_COMMIT);
    return c.json({ version: APP_VERSION, name: 'ESA VPS Monitor', hash: commit || 'dev', build: commit || `release-${APP_VERSION}`, platform: 'aliyun-esa' });
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
    return c.json({
      ok: jwtOk && kvOk,
      platform: 'aliyun-esa',
      checks: [
        { key: 'jwt_secret', status: jwtOk ? 'ok' : 'error', detail: jwtOk ? 'JWT_SECRET 已配置' : '缺少 JWT_SECRET 或不足 32 字节' },
        { key: 'edge_kv', status: kvOk ? 'ok' : 'error', detail: kvOk ? (isEdgeKvAvailable() ? `EdgeKV 命名空间可用：${readEnvString(c.env, 'KV_NAMESPACE') || 'esa-vps-monitor'}` : '本地内存 KV') : kvError },
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
      return c.text('ESA VPS Monitor: 前端资源不存在。请确认 esa.jsonc 的 assets.directory 指向 frontend/dist。', 404);
    }
    return c.json({ error: 'Not Found' }, 404);
  });

  app.onError((error, c) => {
    console.error('[app] unhandled error:', error instanceof Error ? error.stack || error.message : String(error));
    return c.json({ error: '服务器内部错误' }, 500);
  });

  return app;
}
