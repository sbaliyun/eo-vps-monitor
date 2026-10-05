import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Box, Button, Card, Flex, Heading, Separator, Text } from '@radix-ui/themes';
import { AlertTriangle, CheckCircle2, Database, Loader2, RefreshCw, XCircle } from 'lucide-react';

type SetupCheck = {
  key: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
};

type SetupStatus = {
  ok: boolean;
  platform?: string;
  checks?: SetupCheck[];
};

const CHECK_LABELS: Record<string, string> = {
  jwt_secret: '会话密钥 JWT_SECRET',
  admin_recovery_key: '管理员恢复密钥 ADMIN_RECOVERY_KEY',
  edge_kv: 'EdgeOne KV 存储',
  admin: '管理员账号',
};

/**
 * 部署自检页：检查 EdgeOne KV 绑定与认证密钥，并提示首次创建管理员。
 */
export default function DbInit() {
  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    fetch('/api/setup/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body: SetupStatus) => setStatus(body))
      .catch(() => setStatus({ ok: false, checks: [{ key: 'edge_kv', status: 'error', detail: '无法访问函数接口，请确认 EdgeOne Pages 项目已部署且 /api 路由正确' }] }))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  return (
    <div className="login-page db-init-page">
      <Card className="login-card db-init-card" style={{ padding: '32px' }}>
        <Flex direction="column" align="center" gap="2" mb="5">
          <Box className="login-logo">
            <Database size={32} color="white" />
          </Box>
          <Heading size="6">部署自检</Heading>
          <Text size="2" color="gray" align="center">
            EdgeOne 版本使用 KV 存储，无需初始化数据库。检查通过后，在登录页使用恢复密钥创建管理员。
          </Text>
        </Flex>

        <Separator size="4" mb="4" />

        {loading && (
          <Flex align="center" gap="2"><Loader2 className="db-init-spin" size={18} /><Text size="2">检查中…</Text></Flex>
        )}

        {!loading && status && (
          <Flex direction="column" gap="3">
            <Badge color={status.ok ? 'green' : 'red'} variant="soft" style={{ width: 'fit-content' }}>
              {status.ok ? '配置可用' : '配置未就绪'}
            </Badge>
            {(status.checks || []).map((check) => (
              <Box key={check.key} className={`db-init-result ${check.status === 'ok' ? 'is-success' : check.status === 'warning' ? '' : 'is-error'}`}>
                <Flex align="center" gap="2" mb="1">
                  {check.status === 'ok' ? <CheckCircle2 size={18} /> : check.status === 'warning' ? <AlertTriangle size={18} /> : <XCircle size={18} />}
                  <Text size="2" weight="bold">{CHECK_LABELS[check.key] || check.key}</Text>
                </Flex>
                <Text size="2">{check.detail}</Text>
              </Box>
            ))}
            {!status.ok && (
              <Text size="1" color="gray">
                在 EdgeOne Pages 项目中配置 JWT_SECRET（至少 32 字节）和独立的 ADMIN_RECOVERY_KEY，
                创建 KV 命名空间并以 MONITOR_KV 名称绑定到项目，保存后重新部署。
              </Text>
            )}
          </Flex>
        )}

        <Flex gap="2" mt="4">
          <Button size="3" variant="soft" onClick={load} disabled={loading} style={{ flex: 1 }}>
            <RefreshCw size={16} /> 重新检查
          </Button>
          <Button asChild size="3" style={{ flex: 1 }}>
            <Link to="/login">进入后台登录</Link>
          </Button>
        </Flex>
      </Card>
    </div>
  );
}
