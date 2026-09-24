import type { Context } from 'hono';
import type { AppEnv } from '../platform/env';
import type { AppServices } from '../platform/context';
import { readJsonWithLimit } from '../utils/request-body';
import { getAdminSessionToken } from '../auth/session';
import { verifyAdminToken } from '../auth/jwt';
import { readCore } from '../store/core';
import { localRateLimit } from '../store/ratelimit';

export type AppVariables = {
  app: AppServices;
  userId: string;
  username: string;
};

export type HonoEnv = { Bindings: AppEnv; Variables: AppVariables };
export type AppContext = Context<HonoEnv>;

export function services(c: AppContext): AppServices {
  return c.get('app');
}

const IP_HEADERS = ['ali-real-client-ip', 'ali-cdn-real-ip', 'eo-connecting-ip', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip'];

/** 访客 IP：优先使用 ESA/CDN 注入的真实客户端 IP 头，其次取 X-Forwarded-For 第一个地址。 */
export function clientIp(c: { req: { header(name: string): string | undefined } }, fallback = 'unknown'): string {
  for (const header of IP_HEADERS) {
    const value = (c.req.header(header) || '').trim();
    if (value) return value.slice(0, 128);
  }
  const forwarded = (c.req.header('x-forwarded-for') || '').split(',')[0]?.trim();
  return (forwarded || fallback).slice(0, 128);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function readJsonObject(c: AppContext, maxBytes = 256 * 1024): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const parsed = await readJsonWithLimit(c.req.raw, maxBytes, { emptyValue: {} });
  if (!parsed.ok) {
    if (parsed.reason === 'too_large') return { ok: false, response: c.json({ error: `请求内容不能超过 ${maxBytes} 字节` }, 413) };
    return { ok: false, response: c.json({ error: '请求 JSON 格式错误' }, 400) };
  }
  if (!isObject(parsed.body)) return { ok: false, response: c.json({ error: '请求内容必须是 JSON 对象' }, 400) };
  return { ok: true, body: parsed.body };
}

export async function readJsonObjectOrArray(c: AppContext, maxBytes = 256 * 1024): Promise<{ ok: true; body: Record<string, unknown> | Record<string, unknown>[] } | { ok: false; response: Response }> {
  const parsed = await readJsonWithLimit(c.req.raw, maxBytes, { emptyValue: {} });
  if (!parsed.ok) {
    if (parsed.reason === 'too_large') return { ok: false, response: c.json({ error: `请求内容不能超过 ${maxBytes} 字节` }, 413) };
    return { ok: false, response: c.json({ error: '请求 JSON 格式错误' }, 400) };
  }
  const body = parsed.body;
  if (isObject(body) || (Array.isArray(body) && body.every(isObject))) return { ok: true, body: body as Record<string, unknown> | Record<string, unknown>[] };
  return { ok: false, response: c.json({ error: '请求内容必须是 JSON 对象或对象数组' }, 400) };
}

export function readIntParam(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function noStoreJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

/** 当前请求是否带有有效的管理员会话（用于 include_hidden）。 */
export async function hasAdminSession(c: AppContext): Promise<boolean> {
  const token = getAdminSessionToken(c);
  if (!token) return false;
  try {
    const payload = await verifyAdminToken(token, c.env as { JWT_SECRET?: string });
    if (!payload) return false;
    const core = await readCore(services(c));
    const user = core.users.find(item => item.uuid === payload.userId);
    return Boolean(user && user.username === payload.username && user.session_version === payload.sessionVersion);
  } catch {
    return false;
  }
}

export async function wantsIncludeHidden(c: AppContext): Promise<boolean> {
  return c.req.query('include_hidden') === '1' && hasAdminSession(c);
}

export function publicRateLimit(c: AppContext, bucket: string, max: number): Response | null {
  const result = localRateLimit(`${bucket}:${clientIp(c)}`, max, 60_000, services(c).now());
  c.header('X-RateLimit-Limit', String(max));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  if (result.allowed) return null;
  c.header('Retry-After', String(result.retryAfter));
  return c.json({ error: `请求过于频繁，请 ${result.retryAfter} 秒后再试` }, 429);
}
