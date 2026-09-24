import { useEffect, useState } from 'react';
import { Button, Flex, Select, Text, TextField } from '@radix-ui/themes';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '../../contexts/AuthContext';
import { SettingCard, SettingRow } from './SettingCard';

interface ClientOption {
  uuid: string;
  name: string;
}

/**
 * HTTPS 证书到期检查设置。ESA 边缘函数读不到证书，证书由 Agent 检查：
 * 默认自动选排序最前、在线且版本支持的节点，也可以指定节点或关闭。
 */
export default function SslSettingsCard({ clients }: { clients: ClientOption[] }) {
  const apiFetch = useApi();
  const [probeClient, setProbeClient] = useState('auto');
  const [notifyDays, setNotifyDays] = useState('14');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/admin/settings?scope=ssl')
      .then((data: Record<string, string>) => {
        if (cancelled) return;
        setProbeClient(data.ssl_probe_client || 'auto');
        setNotifyDays(data.ssl_expiry_notify_days || '14');
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => { cancelled = true; };
  }, [apiFetch]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ ssl_probe_client: probeClient, ssl_expiry_notify_days: notifyDays }),
      });
      if (result?.error) toast.error(result.error);
      else toast.success('证书检查设置已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const knownClient = probeClient === 'auto' || probeClient === 'off' || clients.some((client) => client.uuid === probeClient);

  return (
    <SettingCard title="SSL 证书到期检查" description="由 Agent 读取 HTTPS 证书到期时间，到期前每天提醒" defaultOpen={false}>
      <SettingRow label="检查节点" description="自动：选排序最前、在线且 Agent 版本支持证书检查的节点">
        <Select.Root value={probeClient} onValueChange={setProbeClient} disabled={!loaded}>
          <Select.Trigger style={{ minWidth: 200 }} />
          <Select.Content>
            <Select.Item value="auto">自动选择</Select.Item>
            <Select.Item value="off">关闭证书检查</Select.Item>
            {!knownClient && <Select.Item value={probeClient}>已删除的节点</Select.Item>}
            {clients.map((client) => (
              <Select.Item key={client.uuid} value={client.uuid}>{client.name || client.uuid}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </SettingRow>
      <SettingRow label="提前提醒天数" description="证书剩余天数不超过该值时每天提醒一次，0 表示不提醒">
        <TextField.Root
          type="number"
          min={0}
          max={90}
          value={notifyDays}
          onChange={(event) => setNotifyDays(event.target.value)}
          style={{ width: 90 }}
          disabled={!loaded}
        />
      </SettingRow>
      <Flex justify="between" align="center" mt="2" gap="2" wrap="wrap">
        <Text size="1" color="gray">通知渠道沿用「通知管理」里的设置。旧版 Agent 需要用新安装命令升级后才能检查证书。</Text>
        <Button size="1" onClick={save} disabled={saving || !loaded}><Save size={14} /> {saving ? '保存中…' : '保存'}</Button>
      </Flex>
    </SettingCard>
  );
}
