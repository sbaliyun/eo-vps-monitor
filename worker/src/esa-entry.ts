/**
 * 阿里云 ESA 函数入口。
 *
 * ESA 的签名是 `fetch(request, context, env)`；本地/其他运行时可能是 `fetch(request, env, ctx)`，
 * resolveInvocation 会自动识别两种形式。
 */

import { createApp, SERVICES_ENV_KEY } from './app';
import { resolveInvocation } from './platform/env';
import { createAppServices } from './platform/context';
import { flushAudit } from './services/notify';

const app = createApp();

export async function handleRequest(request: Request, second?: unknown, third?: unknown): Promise<Response> {
  const { env, ctx } = resolveInvocation(second, third);
  const services = createAppServices(env, ctx);
  (env as Record<string, unknown>)[SERVICES_ENV_KEY] = services;
  const url = new URL(request.url);
  let response: Response;
  try {
    response = await app.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => services.waitUntil(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext);
  } catch (error) {
    console.error('[esa] request failed:', error instanceof Error ? error.message : String(error));
    response = new Response(JSON.stringify({ error: '服务器内部错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  services.waitUntil(flushAudit(services));
  if (services.pending.length > 0) await Promise.allSettled(services.pending);
  // ESA 节点可能缓存 GET 响应：API 一律禁止缓存（少数资源自带 Cache-Control 的除外）。
  if (url.pathname.startsWith('/api/') && !response.headers.has('Cache-Control')) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}

export default {
  fetch(request: Request, second?: unknown, third?: unknown): Promise<Response> {
    return handleRequest(request, second, third);
  },
};
