import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Badge, Box, Button, Dialog, Flex, Text } from '@radix-ui/themes';
import { Clock, Database, Gauge, RefreshCw, Save, Server } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { LIVE_POLL_SETTINGS_UPDATED_EVENT } from '../../contexts/livePolling';
import { SettingCard, SettingInput, SettingToggle } from '../../components/admin/SettingCard';
import { getChangedSettings, type SettingsMap } from '../../utils/settingsDiff';
import { notifyPublicDataUpdated } from '../../utils/publicDataEvents';
import type { SettingsLayoutOutletContext } from './SettingsLayout';
import { buildResourceEstimates, type ResourceEstimate } from '../../../../worker/src/utils/capacity-estimate';
import CapacityResources from '../../components/admin/CapacityResources';

interface CapacityEstimate {
  clients?: number;
  website_monitors?: number;
  capacity_daily_view_minutes?: number;
  ping_tasks?: Array<{ id: number; name?: string; target_client_count?: number }>;
  estimated_storage_bytes?: number;
  resource_estimates?: ResourceEstimate[];
}

const DEFAULT_RETENTION_HOURS = 72;
const MAX_RETENTION_HOURS = 72;
const DEFAULT_ACTIVE_SAMPLE_SEC = 5;
const DEFAULT_IDLE_UPLOAD_SEC = 120;
const MIN_IDLE_UPLOAD_SEC = 60;
const DEFAULT_VIEWER_TTL_SEC = 120;
const DEFAULT_RECORD_PERSIST_SEC = 120;
const DEFAULT_PING_RECORD_PERSIST_SEC = 120;
const DEFAULT_DAILY_VIEW_MINUTES = 60;
const DEFAULT_OFFLINE_CONFIRM_ROUNDS = 3;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function formatInteger(value: number | undefined): string {
  return Math.ceil(Number(value || 0)).toLocaleString();
}

function formatBytes(bytes: number | undefined): string {
  const value = Math.max(0, Number(bytes || 0));
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function getSettingValue(settings: SettingsMap, key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
}

function normalizeGeneralSettings(settings: SettingsMap): SettingsMap {
  return { ...settings };
}

function EstimateMetric({
  label,
  value,
  tone,
  density = 'medium',
}: {
  label: string;
  value: string;
  tone?: 'blue' | 'green' | 'amber' | 'orange' | 'red' | 'purple';
  density?: 'short' | 'medium' | 'long';
}) {
  return (
    <Flex direction="column" gap="1" className={`quota-estimate-metric quota-estimate-metric-${density}`} style={{ minWidth: 0 }}>
      <Text size="1" color="gray">{label}</Text>
      <Badge variant="soft" color={tone || 'gray'} style={{ width: 'fit-content' }}>{value}</Badge>
    </Flex>
  );
}

function UsageCard({ label, value, caption, icon }: { label: string; value: string; caption: string; icon: React.ReactNode }) {
  return (
    <div className="quota-estimate-card quota-estimate-card-green">
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <span className="quota-estimate-icon" aria-hidden="true">{icon}</span>
        <Flex direction="column" style={{ minWidth: 0 }}>
          <Text size="1" color="gray">{label}</Text>
          <Text size="3" weight="bold" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{value}</Text>
        </Flex>
      </Flex>
      <Text size="1" color="gray">{caption}</Text>
    </div>
  );
}

export default function SettingsGeneral() {
  const apiFetch = useApi();
  const { setAction, settingsCache, loadSettingsScope, setSettingsScope } = useOutletContext<SettingsLayoutOutletContext>();
  const [settings, setSettings] = useState<SettingsMap>(() => normalizeGeneralSettings(settingsCache.general || {}));
  const [originalSettings, setOriginalSettings] = useState<SettingsMap>(() => settingsCache.general || {});
  const [capacity, setCapacity] = useState<CapacityEstimate | null>(null);
  const [loading, setLoading] = useState(!settingsCache.general);
  const [settingsReady, setSettingsReady] = useState(Boolean(settingsCache.general));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [refreshingCounts, setRefreshingCounts] = useState(false);
  const [explainDialog, setExplainDialog] = useState<'cleanup' | 'refresh' | null>(null);
  const [cronUrl, setCronUrl] = useState('');

  const refreshCapacity = useCallback(async (forceCounts = false) => {
    const path = forceCounts ? '/admin/capacity?refresh_counts=true' : '/admin/capacity';
    try {
      const capacityData = await apiFetch(path);
      if (capacityData && typeof capacityData === 'object') {
        setCapacity(capacityData as CapacityEstimate);
        return true;
      }
    } catch {}
    return false;
  }, [apiFetch]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadSettingsScope('general')
      .then((settingsData) => {
        if (cancelled) return;
        setSettings(normalizeGeneralSettings(settingsData));
        setOriginalSettings(settingsData);
        setSettingsReady(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : '读取设置失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadSettingsScope, reloadKey]);

  useEffect(() => {
    apiFetch('/admin/capacity')
      .then((capacityData) => {
        if (capacityData && typeof capacityData === 'object') setCapacity(capacityData as CapacityEstimate);
      })
      .catch(() => {});
  }, [apiFetch]);

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateRetentionHours = (value: string) => {
    setSettings((prev) => ({
      ...prev,
      record_preserve_time: value,
      ping_record_preserve_time: value,
    }));
  };

  const derived = useMemo(() => {
    const clients = Math.max(0, Number(capacity?.clients || 0));
    const retentionHours = clampInteger(
      settings.record_preserve_time || settings.ping_record_preserve_time,
      DEFAULT_RETENTION_HOURS,
      1,
      MAX_RETENTION_HOURS,
    );
    const sampleIntervalSec = clampInteger(settings.live_poll_active_interval_sec, DEFAULT_ACTIVE_SAMPLE_SEC, 3, 300);
    const idleUploadIntervalSec = clampInteger(settings.live_poll_idle_interval_sec, DEFAULT_IDLE_UPLOAD_SEC, MIN_IDLE_UPLOAD_SEC, 3600);
    const viewerTtlSec = clampInteger(settings.live_poll_active_max_duration_sec, DEFAULT_VIEWER_TTL_SEC, 60, 3600);
    const recordPersistIntervalSec = clampInteger(settings.record_persist_interval_sec, DEFAULT_RECORD_PERSIST_SEC, 30, 3600);
    const pingRecordPersistIntervalSec = clampInteger(settings.ping_record_persist_interval_sec, DEFAULT_PING_RECORD_PERSIST_SEC, 60, 3600);
    const dailyViewMinutes = clampInteger(
      settings.capacity_daily_view_minutes,
      Number(capacity?.capacity_daily_view_minutes || DEFAULT_DAILY_VIEW_MINUTES),
      0,
      1440,
    );
    const pingAssignments = (capacity?.ping_tasks || []).reduce((sum, task) => sum + Math.max(0, Number(task.target_client_count || 0)), 0);
    const estimate = buildResourceEstimates({
      clientCount: clients,
      pingTasksPerClient: clients > 0 ? pingAssignments / clients : 0,
      websiteMonitorCount: Math.max(0, Number(capacity?.website_monitors || 0)),
      websiteEdgeChecksPerDay: 0,
      activeSecondsPerDay: dailyViewMinutes * 60,
      activeIntervalSec: sampleIntervalSec,
      idleIntervalSec: idleUploadIntervalSec,
      recordIntervalSec: recordPersistIntervalSec,
      pingIntervalSec: pingRecordPersistIntervalSec,
      retentionHours,
    });
    return {
      clients,
      retentionHours,
      sampleIntervalSec,
      idleUploadIntervalSec,
      viewerTtlSec,
      recordPersistIntervalSec,
      pingRecordPersistIntervalSec,
      dailyViewMinutes,
      estimate,
    };
  }, [capacity, settings]);

  const handleSave = useCallback(async () => {
    if (!settingsReady || loading || loadError || saving) return;
    const payload = {
      ...settings,
      record_preserve_time: String(derived.retentionHours),
      ping_record_preserve_time: String(derived.retentionHours),
      live_poll_active_interval_sec: String(derived.sampleIntervalSec),
      live_poll_idle_interval_sec: String(derived.idleUploadIntervalSec),
      live_poll_active_max_duration_sec: String(derived.viewerTtlSec),
      record_persist_interval_sec: String(derived.recordPersistIntervalSec),
      ping_record_persist_interval_sec: String(derived.pingRecordPersistIntervalSec),
      capacity_daily_view_minutes: String(derived.dailyViewMinutes),
    };
    const changedSettings = getChangedSettings(payload, originalSettings);
    if (Object.keys(changedSettings).length === 0) {
      toast.info('没有需要保存的改动');
      return;
    }

    setSaving(true);
    try {
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify(changedSettings),
      });
      if (result.success) {
        setSettings(payload);
        setOriginalSettings(payload);
        setSettingsScope('general', payload);
        window.dispatchEvent(new CustomEvent(LIVE_POLL_SETTINGS_UPDATED_EVENT, { detail: payload }));
        notifyPublicDataUpdated();
        toast.success('设置已保存');
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [apiFetch, derived, originalSettings, setSettingsScope, settings, settingsReady, loading, loadError, saving]);

  const handleMaintenanceCleanup = useCallback(async () => {
    setCleaning(true);
    try {
      const result = await apiFetch('/admin/maintenance/cleanup', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (result.success) {
        toast.success(`维护清理完成，删除 ${formatInteger(Number(result.deleted?.audit_logs || 0))} 条过期审计日志（节点历史按保留时长自动滚动）`);
        await refreshCapacity();
      } else {
        toast.error(result.error || '维护清理失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '维护清理失败');
    } finally {
      setCleaning(false);
    }
  }, [apiFetch, refreshCapacity]);

  const handleRunMaintenance = useCallback(async () => {
    setRefreshingCounts(true);
    try {
      const result = await apiFetch('/admin/cron/run', { method: 'POST', body: JSON.stringify({}) });
      if (result.ran) {
        const steps = Array.isArray(result.steps) ? result.steps.map((step: { step: string; status: string }) => `${step.step}:${step.status}`).join('，') : '';
        toast.success(`定时维护已执行${steps ? `（${steps}）` : ''}`);
      } else {
        toast.info(result.reason === 'lease_held' ? '维护任务刚刚在其他请求中运行过，请稍后再试' : '维护任务暂未执行');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '执行失败');
    } finally {
      setRefreshingCounts(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    apiFetch('/admin/cron/secret').then((result) => {
      if (result && typeof result.url === 'string') setCronUrl(result.url);
    }).catch(() => {});
  }, [apiFetch]);

  const headerAction = useMemo(() => (
    <Button onClick={handleSave} disabled={!settingsReady || loading || Boolean(loadError) || saving}>
      <Save size={16} /> {saving ? '保存中…' : '保存'}
    </Button>
  ), [handleSave, settingsReady, loading, loadError, saving]);

  useEffect(() => {
    setAction(headerAction);
    return () => setAction(null);
  }, [headerAction, setAction]);

  if (loading) return <Loading />;

  const loadFailure = loadError && <Flex align="center" gap="2">
    <Text color="red" role="alert">读取设置失败：{loadError}</Text>
    <Button variant="soft" onClick={() => setReloadKey(value => value + 1)}>重试</Button>
  </Flex>;
  if (!settingsReady) return loadFailure;

  return (
    <Flex direction="column" gap="4">
      {loadFailure}
      <SettingCard title="采集与记录策略" description="统一设置 Agent 采集、历史记录与 ESA 用量估算" defaultOpen>
        <div className="general-settings-workspace">
          <section className="general-settings-manual-panel" aria-labelledby="general-settings-manual-title">
            <Flex align="center" justify="between" gap="2" wrap="wrap" className="general-settings-section-heading">
              <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
                <Text id="general-settings-manual-title" size="2" weight="bold">手动设置</Text>
                <Text size="1" color="gray">这些输入会即时驱动右侧用量估算，保存后 Agent 在下一次拉取策略时生效。</Text>
              </Flex>
              <Badge variant="soft" color="blue">可编辑</Badge>
            </Flex>

            <div className="general-settings-input-grid">
              <div className="general-setting-span-full general-setting-toggle-row">
                <SettingToggle
                  label="启用数据记录"
                  description="关闭后不再写入历史记录，但不影响实时数据展示"
                  checked={settings.record_enabled !== 'false'}
                  onCheckedChange={(checked) => updateSetting('record_enabled', checked ? 'true' : 'false')}
                />
              </div>
              <SettingInput
                label="历史保留时长（小时）"
                description="节点历史按该时长滚动保留（最近 4 小时为原始精度，更早的按 10 分钟聚合）。上限 72 小时"
                value={getSettingValue(settings, 'record_preserve_time', getSettingValue(settings, 'ping_record_preserve_time', String(DEFAULT_RETENTION_HOURS)))}
                onChange={updateRetentionHours}
                type="number"
                placeholder="72"
                width="100%"
              />
              <SettingInput
                label="每日预计观看时长（分钟）"
                description="仅用于右侧用量估算，不影响实际行为"
                value={getSettingValue(settings, 'capacity_daily_view_minutes', String(DEFAULT_DAILY_VIEW_MINUTES))}
                onChange={(value) => updateSetting('capacity_daily_view_minutes', value)}
                type="number"
                placeholder="60"
                width="100%"
              />
              <SettingInput
                label="有人观看时 · 上报间隔（秒）"
                description="前台有访客在看时 Agent 的上报间隔。ESA 上每次上报都是一次函数请求和一次 KV 写入，越小越实时、用量越大"
                value={getSettingValue(settings, 'live_poll_active_interval_sec', String(DEFAULT_ACTIVE_SAMPLE_SEC))}
                onChange={(value) => updateSetting('live_poll_active_interval_sec', value)}
                type="number"
                placeholder="5"
                width="100%"
              />
              <SettingInput
                label="无人观看时 · 上报间隔（秒）"
                description="没有访客时的上报间隔，最少 60 秒；Agent 每分钟采样一次，按该间隔批量上报"
                value={getSettingValue(settings, 'live_poll_idle_interval_sec', String(DEFAULT_IDLE_UPLOAD_SEC))}
                onChange={(value) => updateSetting('live_poll_idle_interval_sec', value)}
                type="number"
                placeholder="120"
                width="100%"
              />
              <SettingInput
                label="观看状态保持时长（秒）"
                description="访客最后一次轮询后，Agent 保持高频上报多久。Agent 最迟约 60 秒内感知到有人观看"
                value={getSettingValue(settings, 'live_poll_active_max_duration_sec', String(DEFAULT_VIEWER_TTL_SEC))}
                onChange={(value) => updateSetting('live_poll_active_max_duration_sec', value)}
                type="number"
                placeholder="120"
                width="100%"
              />
              <SettingInput
                label="历史记录间隔（秒）"
                description="每个节点每隔多久写入一个历史点（一次 KV 写入），最少 30 秒"
                value={getSettingValue(settings, 'record_persist_interval_sec', String(DEFAULT_RECORD_PERSIST_SEC))}
                onChange={(value) => updateSetting('record_persist_interval_sec', value)}
                type="number"
                placeholder="120"
                width="100%"
              />
              <SettingInput
                label="Ping 探测与记录间隔（秒）"
                description="Agent 执行延迟探测的间隔，也是 Ping 历史的记录间隔；最低 60 秒"
                value={getSettingValue(settings, 'ping_record_persist_interval_sec', String(DEFAULT_PING_RECORD_PERSIST_SEC))}
                onChange={(value) => updateSetting('ping_record_persist_interval_sec', value)}
                type="number"
                placeholder="120"
                width="100%"
              />
              <SettingInput
                label="离线确认轮数（轮）"
                description="连续多少轮维护判定为离线才发出告警，任意一轮在线立即清零。维护约每分钟运行一次"
                value={getSettingValue(settings, 'offline_confirm_rounds', String(DEFAULT_OFFLINE_CONFIRM_ROUNDS))}
                onChange={(value) => updateSetting('offline_confirm_rounds', value)}
                type="number"
                placeholder="3"
                width="100%"
              />
            </div>
          </section>

          <section className="general-settings-calculated-panel" aria-labelledby="general-settings-calculated-title">
            <Box className="quota-estimate-panel quota-estimate-panel-embedded">
              <Flex align="start" justify="between" gap="3" wrap="wrap" mb="3">
                <Flex direction="column" gap="1" style={{ minWidth: 0, flex: '1 1 360px' }}>
                  <Flex align="center" gap="2">
                    <Gauge size={16} />
                    <Text id="general-settings-calculated-title" size="2" weight="bold">ESA 用量估算</Text>
                  </Flex>
                  <Text size="1" color="gray" className="quota-reference-line">
                    按当前输入即时估算函数请求与 EdgeKV 读写次数，实际计费以阿里云 ESA 控制台用量为准。
                  </Text>
                </Flex>
                <Flex align="center" gap="2" wrap="wrap" className="quota-estimate-actions">
                  <Button size="1" variant="soft" onClick={() => setExplainDialog('cleanup')} disabled={cleaning}>
                    <Database size={13} /> {cleaning ? '清理中…' : '维护清理'}
                  </Button>
                  <Button size="1" variant="soft" onClick={() => setExplainDialog('refresh')} disabled={refreshingCounts}>
                    <RefreshCw size={13} /> {refreshingCounts ? '执行中…' : '立即执行维护'}
                  </Button>
                </Flex>
              </Flex>
              <div className="quota-estimate-bar-grid">
                <UsageCard
                  label="函数请求/天（典型）"
                  value={formatInteger(derived.estimate.estimated_function_requests_per_day)}
                  caption={`全天有人观看约 ${formatInteger(derived.estimate.estimated_function_requests_peak_per_day)} 次/天`}
                  icon={<Server size={15} />}
                />
                <UsageCard
                  label="KV 写入/天（典型）"
                  value={formatInteger(derived.estimate.estimated_kv_writes_per_day)}
                  caption={`其中历史写入约 ${formatInteger(derived.estimate.estimated_history_writes_per_day)} 次`}
                  icon={<Database size={15} />}
                />
                <UsageCard
                  label="KV 存储（估算）"
                  value={formatBytes(derived.estimate.estimated_storage_bytes)}
                  caption={`保留 ${derived.retentionHours} 小时历史`}
                  icon={<Database size={15} />}
                />
              </div>
              <CapacityResources resources={derived.estimate.resource_estimates} dailyViewMinutes={derived.dailyViewMinutes} />
              <div className="quota-estimate-metric-grid">
                <div className="quota-estimate-metric-column quota-estimate-metric-column-short">
                  <EstimateMetric label="节点数" value={formatInteger(derived.clients)} density="short" />
                  <EstimateMetric label="保留时间" value={`${derived.retentionHours} 小时`} density="short" />
                  <EstimateMetric label="Ping 间隔" value={`${derived.pingRecordPersistIntervalSec} 秒`} density="short" />
                </div>
                <div className="quota-estimate-metric-column quota-estimate-metric-column-medium">
                  <EstimateMetric label="每日观看时间" value={`${derived.dailyViewMinutes} 分钟`} tone="blue" />
                  <EstimateMetric label="Agent 上报/天" value={formatInteger(derived.estimate.monitor_reports_per_day)} tone="green" />
                  <EstimateMetric label="策略拉取/天" value={formatInteger(derived.estimate.agent_policy_requests_per_day)} tone="green" />
                </div>
                <div className="quota-estimate-metric-column quota-estimate-metric-column-long">
                  <EstimateMetric label="KV 读取/天" value={formatInteger(derived.estimate.estimated_kv_reads_per_day)} tone="blue" density="long" />
                  <EstimateMetric label="历史记录间隔" value={`${derived.recordPersistIntervalSec} 秒`} density="long" />
                  <EstimateMetric label="无人时上报间隔" value={`${derived.idleUploadIntervalSec} 秒`} density="long" />
                </div>
              </div>
              <Flex direction="column" gap="1" mt="3">
                <Flex align="center" gap="2"><Clock size={14} /><Text size="2" weight="bold">外部定时触发（可选）</Text></Flex>
                <Text size="1" color="gray">
                  ESA 函数没有定时触发器，维护任务（离线/到期告警、网站检测）由 Agent 拉取策略和访客访问顺带触发。
                  若所有节点都离线仍需告警，可用任意外部定时服务（如 GitHub Actions、cron-job.org）每 1~5 分钟请求下面的地址：
                </Text>
                <Text size="1" style={{ fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}>{cronUrl || '（需要配置 JWT_SECRET 或 CRON_SECRET）'}</Text>
              </Flex>
            </Box>
          </section>
        </div>
      </SettingCard>
      <Dialog.Root open={explainDialog !== null} onOpenChange={(open) => !open && setExplainDialog(null)}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>{explainDialog === 'cleanup' ? '维护清理说明' : '立即执行维护说明'}</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            {explainDialog === 'cleanup'
              ? '维护清理会按审计日志保留时长删除过期日志。节点历史本身按保留时长滚动，不需要手动清理。'
              : '立即运行一轮定时维护：网站检测、离线与到期告警检查。受单次请求的 KV 与出站请求额度限制，未完成的部分会在下一轮继续。'}
          </Dialog.Description>
          <Flex justify="end" gap="2">
            <Button variant="soft" color="gray" onClick={() => setExplainDialog(null)}>取消</Button>
            <Button
              color={explainDialog === 'cleanup' ? 'red' : undefined}
              onClick={() => {
                const action = explainDialog;
                setExplainDialog(null);
                if (action === 'cleanup') void handleMaintenanceCleanup();
                if (action === 'refresh') void handleRunMaintenance();
              }}
            >
              {explainDialog === 'cleanup' ? '确认清理' : '立即执行'}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
}
