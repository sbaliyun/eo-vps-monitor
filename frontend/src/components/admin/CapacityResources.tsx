import { Badge, Text } from '@radix-ui/themes';
import type { ResourceEstimate } from '../../../../worker/src/utils/capacity-estimate';

const labels: Record<ResourceEstimate['key'], string> = {
  function_requests: 'ESA 函数请求',
  kv_reads: 'EdgeKV 读取',
  kv_writes: 'EdgeKV 写入',
  kv_storage_bytes: 'EdgeKV 存储',
};

function amount(row: ResourceEstimate, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知';
  if (row.key.endsWith('_bytes')) {
    if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GB';
    if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB';
    if (value >= 1024) return (value / 1024).toFixed(1) + ' KB';
    return Math.ceil(value).toLocaleString() + ' B';
  }
  return Math.ceil(value).toLocaleString();
}

function suffix(period: ResourceEstimate['period']): string {
  return period === 'day' ? '/天' : '（保留期）';
}

function Usage({ row, value }: { row: ResourceEstimate; value: number }) {
  return <>
    <Badge color="blue" variant="soft">
      {row.estimate === 'lower_bound' ? '≥ ' : ''}{amount(row, value)}{suffix(row.period)}
    </Badge>
    {row.period === 'day' && <Text as="div" size="1" color="gray">约 {amount(row, value * 30)}/月</Text>}
  </>;
}

export default function CapacityResources({ resources, dailyViewMinutes }: { resources: ResourceEstimate[]; dailyViewMinutes: number }) {
  return <section className="capacity-resources" aria-label="分项资源用量估算">
    <Text as="p" size="2" weight="bold">分项资源用量</Text>
    <Text as="p" size="1" color="gray">
      ESA 按函数请求数、KV 读写次数与存储量计费，具体免费额度与单价以阿里云控制台为准。≥ 表示下限。
    </Text>
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table className="capacity-resource-table" aria-label="分项资源用量估算">
        <thead><tr><th>资源</th><th>典型（每天观看 {dailyViewMinutes} 分钟）</th><th>全天有人观看</th></tr></thead>
        <tbody>{resources.map(row => <tr key={row.key} data-resource={row.key}>
          <th scope="row">
            {labels[row.key]}
            <Text as="div" size="1" color="gray">{row.estimate === 'lower_bound' ? '下限' : '估算'}</Text>
            <details><summary>说明</summary><ul>{row.notes.map(note => <li key={note}>{note}</li>)}</ul></details>
          </th>
          <td><Usage row={row} value={row.typical} /></td>
          <td><Usage row={row} value={row.peak} /></td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}
