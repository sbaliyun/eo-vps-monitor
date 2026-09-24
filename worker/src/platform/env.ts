/**
 * 运行时环境变量解析。
 *
 * 阿里云 ESA 函数的入口签名是 `fetch(request, context, env)`（env 在第三个参数），
 * 而 Hono / Cloudflare 风格是 `fetch(request, env, ctx)`。不同版本的运行时、本地
 * 开发服务器和测试夹具还可能把变量挂在 `globalThis.env` 或 `process.env` 上。
 * 这里把所有来源合并成一个普通对象，调用方只需读取 `AppEnv`。
 */

export interface AppEnv {
  /** 后台会话签名密钥，至少 32 字节。 */
  JWT_SECRET?: string;
  /** ESA 边缘存储 KV 的命名空间名称。 */
  KV_NAMESPACE?: string;
  /** 忘记管理员账号密码时的重置密钥；未设置时使用 JWT_SECRET。 */
  ADMIN_RECOVERY_KEY?: string;
  /** 外部定时任务触发密钥；未设置时由 JWT_SECRET 派生。 */
  CRON_SECRET?: string;
  /** 单次请求允许的 KV 操作数（ESA 默认约 8 次）。 */
  KV_OPS_PER_REQUEST?: string;
  /** 单次请求允许的出站 fetch 子请求数（ESA 默认 4 次）。 */
  SUBREQUESTS_PER_REQUEST?: string;
  /** 部署时注入的 Git 提交号，仅用于展示。 */
  CURRENT_GIT_COMMIT?: string;
  [key: string]: unknown;
}

export interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function looksLikeExecutionContext(value: unknown): boolean {
  return isRecord(value) && typeof (value as ExecutionContextLike).waitUntil === 'function';
}

/**
 * 本项目读取的变量名。ESA 的 env 可能是 Proxy 或不可枚举对象，Object.keys 拿不到键，
 * 所以除了枚举外还要按名字逐个探测。
 */
export const KNOWN_ENV_KEYS = [
  'JWT_SECRET',
  'KV_NAMESPACE',
  'ADMIN_RECOVERY_KEY',
  'CRON_SECRET',
  'KV_OPS_PER_REQUEST',
  'SUBREQUESTS_PER_REQUEST',
  'LIVE_SHARDS',
  'CURRENT_GIT_COMMIT',
] as const;

function copyStringEntries(target: Record<string, unknown>, source: unknown): void {
  if (!isRecord(source)) return;
  let keys: string[] = [];
  try {
    keys = Object.keys(source);
  } catch {
    keys = [];
  }
  for (const key of [...keys, ...KNOWN_ENV_KEYS]) {
    if (key in target) continue;
    let value: unknown;
    try {
      value = source[key];
    } catch {
      continue;
    }
    if (value === undefined || value === null) continue;
    if (typeof value === 'function') continue;
    target[key] = value;
  }
}

/**
 * 从入口参数中识别 env 与 context。第二、三个参数谁带 `waitUntil` 谁就是 context，
 * 其余对象按顺序合并为 env；缺失的键再从 globalThis.env / process.env 兜底。
 */
export function resolveInvocation(second: unknown, third: unknown): { env: AppEnv; ctx: ExecutionContextLike | undefined } {
  let ctx: ExecutionContextLike | undefined;
  const envSources: unknown[] = [];
  for (const candidate of [third, second]) {
    if (looksLikeExecutionContext(candidate)) {
      ctx ||= candidate as ExecutionContextLike;
      // ESA 的 context 上也可能挂 env。
      envSources.push((candidate as Record<string, unknown>).env);
    } else {
      envSources.push(candidate);
    }
  }
  const globalObject = globalThis as Record<string, unknown>;
  envSources.push(globalObject.env);
  const processObject = globalObject.process as { env?: unknown } | undefined;
  envSources.push(processObject?.env);

  const env: Record<string, unknown> = {};
  for (const source of envSources) copyStringEntries(env, source);
  return { env: env as AppEnv, ctx };
}

export function readEnvString(env: AppEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function readEnvInt(env: AppEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = readEnvString(env, key);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
