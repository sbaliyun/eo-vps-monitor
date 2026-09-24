/**
 * ESA 边缘存储（EdgeKV）中的文档结构。
 *
 * 设计要点（受 EdgeKV 约束：无 list、无事务、最终一致、单次请求 KV 操作次数有限）：
 *  - `core`：后台配置（设置、账号、节点、Ping 任务、网站监控、告警规则、主题），只有管理操作写入；
 *  - `live_<n>`：节点实时状态分片（最近一次上报、在线截止时间、Agent 上报的硬件信息）；
 *  - `node_<uuid>`：单节点历史（精细层 + 10 分钟粗粒度层 + Ping + GPU），只有该节点的上报写入；
 *  - `websites`：网站监控运行状态与心跳历史；
 *  - `alerts` / `audit` / `ratelimit` / `viewers` / `maint`：小体量辅助文档。
 */

import type {
  ExpiryNotificationUpdate,
  LoadNotification,
  OfflineNotificationUpdate,
  PingTask,
  User,
  WebsiteAgentProbeMode,
  WebsiteMonitorMethod,
  WebsiteMonitorStatus,
} from '../db/types';

/** 管理员维护的节点字段（Agent 上报的硬件字段存放在实时分片中）。 */
export interface StoredClient {
  uuid: string;
  token: string;
  token_hash: string;
  token_rotated_at: string | null;
  name: string;
  remark: string;
  public_remark: string;
  price: number;
  billing_cycle: number;
  auto_renewal: boolean;
  currency: string;
  expired_at: string;
  group: string;
  tags: string;
  hidden: boolean;
  traffic_limit: number;
  traffic_limit_type: string;
  traffic_reset_day: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /**
   * 从备份恢复的硬件、系统、地区等信息。Agent 重新上报前用它兜底展示，
   * 实时 meta 中有值时以实时为准。
   */
  seed?: AgentMeta;
}

export interface StoredWebsiteMonitor {
  id: number;
  config_revision: string;
  name: string;
  url: string;
  method: WebsiteMonitorMethod;
  expected_status_min: number;
  expected_status_max: number;
  interval_sec: number;
  timeout_sec: number;
  grace_period_sec: number;
  enabled: boolean;
  hidden: boolean;
  hide_url: boolean;
  agent_probe_mode: WebsiteAgentProbeMode;
  agent_probe_clients: string[];
  agent_probe_limit: number;
  agent_probe_status_enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ThemeAssetRef {
  path: string;
  key: string;
  content_type: string;
  size_bytes: number;
}

export interface StoredTheme {
  short: string;
  name: string;
  description: string;
  version: string;
  author: string;
  url: string;
  preview_path: string;
  style_path: string;
  manifest_json: string;
  config_json: string;
  custom_css: string;
  assets: ThemeAssetRef[];
  created_at: string;
  updated_at: string;
}

export type StoredLoadNotification = Omit<LoadNotification, 'last_notified'> & { id: number };

export interface CoreDoc {
  _rev?: number;
  schema: 1;
  /** 公开元数据版本号，节点/网站/设置变化时递增，前端据此强制刷新。 */
  meta_version: number;
  settings: Record<string, string>;
  users: User[];
  clients: StoredClient[];
  ping_tasks: Array<PingTask & { id: number }>;
  websites: StoredWebsiteMonitor[];
  offline_notifications: OfflineNotificationUpdate[];
  expiry_notifications: ExpiryNotificationUpdate[];
  load_notifications: StoredLoadNotification[];
  themes: StoredTheme[];
  seq: {
    ping_task: number;
    website: number;
    load_notification: number;
  };
}

/** Agent 上报、只能由 Agent 更新的节点信息。 */
export interface AgentMeta {
  cpu_name?: string;
  virtualization?: string;
  arch?: string;
  cpu_cores?: number;
  os?: string;
  kernel_version?: string;
  gpu_name?: string;
  ipv4?: string;
  ipv6?: string;
  region?: string;
  mem_total?: number;
  swap_total?: number;
  disk_total?: number;
  version?: string;
  /** Agent 声明支持的可选能力，例如 ssl_cert（探测时读取 HTTPS 证书）。 */
  features?: string[];
  token_last_used_at?: string;
  token_last_used_ip?: string;
}

export interface LiveEntry {
  /** 服务端最近一次收到上报的时间（毫秒）。 */
  t: number;
  /** 在线截止时间（毫秒）：超过即视为离线，展示 last_known。 */
  exp: number;
  /** 最近一次上报（已清洗，仅包含展示所需字段）。 */
  r: Record<string, unknown>;
  /** Agent 上报的硬件与网络信息。 */
  m: AgentMeta;
  /** 最近一次写入节点历史的时间（毫秒），用于判断下一次是否需要写历史。 */
  h?: number;
}

export interface LiveShardDoc {
  _rev?: number;
  entries: Record<string, LiveEntry>;
}

export interface ViewersDoc {
  _rev?: number;
  /** 有人在看实时面板时，Agent 切到高频上报，直到该时间。 */
  until: number;
}

/** 列式时间序列：t 为秒级时间戳，其余字段与 RECORD_FIELDS 顺序一致。 */
export interface Series {
  t: number[];
  v: Array<Array<number | null>>;
}

export interface CoarseAccumulator {
  /** 当前粗粒度桶的起点（秒）。 */
  start: number;
  n: number;
  sums: number[];
  counts: number[];
  last: Array<number | null>;
}

export interface PingSeries {
  t: number[];
  v: number[];
}

export interface GpuSeries {
  t: number[];
  /** 每个时间点的 GPU 列表：[index, name, mem_total, mem_used, utilization, temperature] */
  d: Array<Array<[number, string, number, number, number, number]>>;
}

export interface NodeDoc {
  _rev?: number;
  uuid: string;
  /** 最近一次写入历史的上报时间（毫秒）。 */
  last_time: number;
  fine: Series;
  coarse: Series;
  acc: CoarseAccumulator | null;
  ping: Record<string, PingSeries>;
  ping_coarse: Record<string, PingSeries>;
  ping_last: Record<string, number>;
  gpu: GpuSeries;
  /** 负载告警：规则 id -> 最近一次通知时间（毫秒）。 */
  load_alerts: Record<string, number>;
}

/** 紧凑的网站检测记录：[秒, ok, status_code, raw_status_code, latency_ms, reason, source('w'|'a'), source_client] */
export type CompactCheck = [number, 0 | 1, number | null, number | null, number | null, string | null, 'w' | 'a', string | null];

export interface WebsiteRuntime {
  config_revision: string;
  status: WebsiteMonitorStatus;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_status_code: number | null;
  last_raw_status_code: number | null;
  last_latency_ms: number | null;
  last_effective_reason: string | null;
  last_error: string | null;
  down_since: string | null;
  last_notified_at: string | null;
  /** HTTPS 证书到期时间（Agent 探测时读取；边缘函数拿不到证书）。 */
  ssl_expires_at?: string | null;
  ssl_issuer?: string | null;
  ssl_checked_at?: string | null;
  /** 证书检查失败原因（例如证书已过期、域名不匹配）。 */
  ssl_error?: string | null;
  ssl_notified_at?: string | null;
  /** 最近的原始检测（新在前）。 */
  recent: CompactCheck[];
  /** 20 分钟桶内最新一次检测（新在前），覆盖 72 小时。 */
  buckets: CompactCheck[];
}

export interface WebsitesDoc {
  _rev?: number;
  monitors: Record<string, WebsiteRuntime>;
}

export interface AlertsDoc {
  _rev?: number;
  offline: Record<string, { streak: number; last_notified: string | null; last_event?: string }>;
  expiry: Record<string, { last_notified: string | null; event?: string }>;
}

export interface AuditDoc {
  _rev?: number;
  seq: number;
  entries: Array<{ id: number; time: string; user: string; action: string; detail: string; level: string }>;
}

export interface RateLimitDoc {
  _rev?: number;
  buckets: Record<string, {
    failures: number;
    first_failed_at: string;
    last_failed_at: string;
    locked_until: string | null;
    failure_revision: string;
  }>;
}

export interface MaintenanceDoc {
  _rev?: number;
  /** 本轮维护租约的截止时间。 */
  until: number;
  owner: string;
  /** 下次从哪个步骤开始（轮转，保证公平）。 */
  step: number;
  last_run_at: number;
  last_cleanup_at: number;
}
