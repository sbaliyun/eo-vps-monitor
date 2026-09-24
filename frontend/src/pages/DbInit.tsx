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
  edge_kv: 'ESA 边缘存储（EdgeKV）',
  admin: '管理员账号',
};

/**
 * 部署自检页（ESA 版本不需要初始化数据库）：
 * 检查 JWT_SECRET 与 EdgeKV 命名空间是否可用，并提示首次创建管理员。
 */
export default function DbInit() {
  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    fetch('/api/setup/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body: SetupStatus) => setStatus(body))
      .catch(() => setStatus({ ok: false, checks: [{ key: 'edge_kv', status: 'error', detail: '无法访问函数接口，请确认 ESA 函数已部署且路由正确' }] }))
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
            ESA 版本使用边缘存储 KV，无需初始化数据库。以下检查通过后即可登录后台。
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
                在 ESA 控制台「函数和 Pages → 项目 → 设置 → 环境变量」中配置 JWT_SECRET（至少 32 个字符）与 KV_NAMESPACE，
                并确认已在「边缘存储」中创建同名命名空间，保存后重新部署。
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
