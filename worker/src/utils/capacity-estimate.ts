/**
 * ESA 用量估算：函数请求数、EdgeKV 读写次数与存储量。
 *
 * 只做数量级规划，实际计费以阿里云 ESA 控制台用量为准；此处不内置任何免费额度数字。
 * 前端 SettingsGeneral 也直接调用本函数做即时预览，因此不能引入任何运行时依赖。
 */

export type ResourceKey = 'function_requests' | 'kv_reads' | 'kv_writes' | 'kv_storage_bytes';

export interface ResourceEstimate {
  key: ResourceKey;
  period: 'day' | 'retained';
  /** 典型场景：每天有人查看 capacity_daily_view_minutes 分钟。 */
  typical: number;
  /** 峰值场景：全天都有人在看实时面板。 */
  peak: number;
  estimate: 'estimate' | 'lower_bound';
  notes: string[];
}

export interface CapacityResourceInput {
  clientCount: number;
  pingTasksPerClient: number;
  websiteMonitorCount: number;
  websiteEdgeChecksPerDay: number;
  activeSecondsPerDay: number;
  activeIntervalSec: number;
  idleIntervalSec: number;
  recordIntervalSec: number;
  pingIntervalSec: number;
  retentionHours: number;
}

const DAY = 86_400;
/** 单个节点历史文档的估算字节数（每个数据点 18 个数值字段）。 */
const BYTES_PER_POINT = 18 * 7;
const BYTES_PER_PING_POINT = 16;

function scenario(input: CapacityResourceInput, activeSeconds: number) {
  const n = Math.max(0, input.clientCount);
  const active = Math.max(0, Math.min(DAY, activeSeconds));
  const idle = DAY - active;
  const activeInterval = Math.max(3, input.activeIntervalSec);
  const idleInterval = Math.max(60, input.idleIntervalSec);
  const reports = n * (active / activeInterval + idle / idleInterval);
  const policies = n * (active / 30 + idle / 60);
  const viewerPolls = active / activeInterval;
  const maintenanceRuns = 1440;
  const historyWrites = Math.min(reports, n * Math.max(DAY / Math.max(30, input.recordIntervalSec),
    input.pingTasksPerClient > 0 ? (input.pingTasksPerClient * DAY) / Math.max(60, input.pingIntervalSec) : 0));
  const functionRequests = reports + policies + viewerPolls;
  const kvWrites = reports + historyWrites + active / 60 + maintenanceRuns * 2 + input.websiteEdgeChecksPerDay / 2;
  const kvReads = reports + historyWrites + policies * 0.3 + viewerPolls * 0.6 + maintenanceRuns * 3;
  return {
    reports: Math.ceil(reports),
    policies: Math.ceil(policies),
    functionRequests: Math.ceil(functionRequests),
    kvWrites: Math.ceil(kvWrites),
    kvReads: Math.ceil(kvReads),
    historyWrites: Math.ceil(historyWrites),
  };
}

export function estimateKvStorageBytes(input: CapacityResourceInput): number {
  const n = Math.max(0, input.clientCount);
  const finePoints = Math.min(1200, (4 * 3600) / Math.max(30, input.recordIntervalSec));
  const coarsePoints = (Math.min(72, Math.max(1, input.retentionHours)) * 3600) / 600;
  const pingPoints = input.pingTasksPerClient * ((4 * 3600) / Math.max(60, input.pingIntervalSec) + coarsePoints);
  const perNode = (finePoints + coarsePoints) * BYTES_PER_POINT + pingPoints * BYTES_PER_PING_POINT + 2048;
  const live = n * 1500;
  const core = 20_000 + n * 800 + input.websiteMonitorCount * 600;
  const websites = input.websiteMonitorCount * 8_000;
  return Math.ceil(n * perNode + live + core + websites + 100_000);
}

export function buildResourceEstimates(input: CapacityResourceInput) {
  const typical = scenario(input, input.activeSecondsPerDay);
  const peak = scenario(input, DAY);
  const storage = estimateKvStorageBytes(input);
  const resources: ResourceEstimate[] = [
    {
      key: 'function_requests', period: 'day', typical: typical.functionRequests, peak: peak.functionRequests, estimate: 'lower_bound',
      notes: ['含 Agent 上报与策略拉取、一个访客的实时轮询；未含后台操作与额外访客。'],
    },
    {
      key: 'kv_reads', period: 'day', typical: typical.kvReads, peak: peak.kvReads, estimate: 'estimate',
      notes: ['实例内有短时缓存，实际读次数与访问分布有关。'],
    },
    {
      key: 'kv_writes', period: 'day', typical: typical.kvWrites, peak: peak.kvWrites, estimate: 'estimate',
      notes: ['每次上报写 1 次实时分片；到达记录间隔或带 Ping 结果时再写 1 次节点历史；维护任务约每分钟 1~2 次。'],
    },
    {
      key: 'kv_storage_bytes', period: 'retained', typical: storage, peak: storage, estimate: 'estimate',
      notes: ['按保留时长估算节点历史、实时分片与配置文档。'],
    },
  ];
  return {
    resource_estimates: resources,
    monitor_reports_per_day: typical.reports,
    agent_policy_requests_per_day: typical.policies,
    estimated_function_requests_per_day: typical.functionRequests,
    estimated_function_requests_peak_per_day: peak.functionRequests,
    estimated_kv_writes_per_day: typical.kvWrites,
    estimated_kv_reads_per_day: typical.kvReads,
    estimated_history_writes_per_day: typical.historyWrites,
    estimated_storage_bytes: storage,
  };
}
