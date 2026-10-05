import { createApp, SERVICES_ENV_KEY } from './app';
import { createAppServices } from './platform/context';
import { resolveInvocation, type AppEnv } from './platform/env';
import { getGlobalEdgeOneKvBinding, isEdgeOneKvAvailable } from './platform/kv';
import { flushAudit } from './services/notify';

const app = createApp();
const MAX_REQUEST_BYTES = 1024 * 1024;
const CLIENT_IP_HEADERS = [
  'ali-real-client-ip', 'ali-cdn-real-ip', 'eo-connecting-ip', 'cf-connecting-ip',
  'true-client-ip', 'x-real-ip', 'x-forwarded-for',
];

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Monitor-Platform': 'tencent-edgeone',
    },
  });
}

export interface EdgeOneContext {
  request: Request;
  env?: AppEnv;
  waitUntil?(promise: Promise<unknown>): void;
}

// Client-supplied proxy headers must not select the login/rate-limit bucket.
export function trustedEdgeOneRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of CLIENT_IP_HEADERS) headers.delete(name);
  const eo = (request as Request & { eo?: { clientIp?: string } }).eo;
  const clientIp = typeof eo?.clientIp === 'string' ? eo.clientIp.trim().slice(0, 128) : 'unknown';
  headers.set('eo-connecting-ip', clientIp || 'unknown');
  return new Request(request, { headers });
}

export async function onRequest(context: EdgeOneContext): Promise<Response> {
  const { env: supplied } = resolveInvocation(context.env, undefined);
  // Keep per-request services off the platform's shared env object.
  const env: AppEnv = {
    ...supplied,
    EDGEONE: true,
    MONITOR_KV: supplied.MONITOR_KV || getGlobalEdgeOneKvBinding(),
  };
  const request = trustedEdgeOneRequest(context.request);
  if (!isEdgeOneKvAvailable(env.MONITOR_KV)) {
    return jsonResponse({ ok: false, platform: 'tencent-edgeone', error: '请在 EdgeOne Pages 项目中绑定 MONITOR_KV，并重新部署。' }, 503);
  }
  const declaredLength = Number(request.headers.get('Content-Length') || '0');
  if (declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: 'EdgeOne 请求内容不能超过 1 MiB' }, 413);
  }
  const services = createAppServices(env, undefined);
  env[SERVICES_ENV_KEY] = services;
  let response: Response;
  try {
    response = await app.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => services.waitUntil(promise),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext);
    // Drain before acknowledging an API write, including tasks queued by tasks.
    while (services.pending.length) await Promise.allSettled(services.pending.splice(0));
    await flushAudit(services);
  } catch (error) {
    console.error('[edgeone] request failed', error instanceof Error ? error.message : String(error));
    response = jsonResponse({ error: '服务器内部错误' }, 500);
  }
  const headers = new Headers(response.headers);
  if (new URL(request.url).pathname.startsWith('/api/')) headers.set('Cache-Control', 'no-store');
  headers.set('X-Monitor-Platform', 'tencent-edgeone');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default onRequest;
