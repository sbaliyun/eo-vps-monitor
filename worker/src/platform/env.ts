/**
 * 运行时环境变量解析。
 *
 * EdgeOne Pages 的入口接收 { request, env, context }，KV binding 则可能是
 * 独立的全局变量。保留原 fetch(request, context, env) 的本地测试入口，
 * 将配置对象与具体 binding 合并为每次请求独立的 AppEnv。
 */

import { getGlobalEdgeOneKvBinding, type EdgeOneKvBinding } from './kv.ts';

export interface AppEnv {
  /** 后台会话签名密钥，至少 32 字节。 */
  JWT_SECRET?: string;
  /** 在 EdgeOne Pages 项目中配置的具体 KV binding，不是命名空间字符串。 */
  MONITOR_KV?: EdgeOneKvBinding;
  /** EO 必须设置独立的管理员初始化/恢复密钥，至少 32 字节。 */
  ADMIN_RECOVERY_KEY?: string;
  /** 外部定时任务触发密钥；未设置时由 JWT_SECRET 派生。 */
  CRON_SECRET?: string;
  /** 应用层单次请求 KV 操作预算。 */
  KV_OPS_PER_REQUEST?: string;
  /** 应用层单次请求出站 fetch 预算。 */
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
 * 本项目读取的变量名。env 可能是 Proxy 或不可枚举对象，Object.keys 拿不到键，
 * 所以除了枚举外还要按名字逐个探测。
 */
export const KNOWN_ENV_KEYS = [
  'JWT_SECRET',
  'MONITOR_KV',
  'ADMIN_RECOVERY_KEY',
  'CRON_SECRET',
  'KV_OPS_PER_REQUEST',
  'SUBREQUESTS_PER_REQUEST',
  'LIVE_SHARDS',
  'CURRENT_GIT_COMMIT',
  'AGENT_REPOSITORY',
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
      // Local adapters may attach env to the execution context.
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
  env.MONITOR_KV ??= getGlobalEdgeOneKvBinding();
  return { env: env as AppEnv, ctx };
}

export function readEnvString(env: AppEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function readAdminRecoveryKey(env: AppEnv): string {
  const recovery = readEnvString(env, 'ADMIN_RECOVERY_KEY');
  const jwt = readEnvString(env, 'JWT_SECRET');
  if (env.EDGEONE === true || env.EDGEONE === 'true') {
    return new TextEncoder().encode(recovery).byteLength >= 32 && recovery !== jwt ? recovery : '';
  }
  return recovery || jwt;
}

export function readEnvInt(env: AppEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = readEnvString(env, key);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
