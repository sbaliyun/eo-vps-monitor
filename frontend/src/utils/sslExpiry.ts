export type SslTone = 'green' | 'amber' | 'red' | 'gray';

export interface SslSummary {
  /** 简短文案，例如「证书 23 天」「证书已过期」。 */
  label: string;
  /** 悬停说明：到期日期或错误原因。 */
  title: string;
  tone: SslTone;
  daysLeft: number | null;
}

const ERROR_LABELS: Record<string, string> = {
  cert_expired: '证书已过期',
  cert_invalid: '证书无效',
  cert_hostname_mismatch: '证书域名不匹配',
  cert_untrusted: '证书不受信任',
  tls_error: 'TLS 握手失败',
};

const DAY_MS = 86_400_000;

/** 由服务端下发的证书信息生成展示用摘要；没有证书信息时返回 null。 */
export function summarizeSsl(
  input: { ssl_expires_at?: string | null; ssl_error?: string | null },
  warnDays = 14,
  nowMs = Date.now(),
): SslSummary | null {
  const expiry = input.ssl_expires_at ? Date.parse(input.ssl_expires_at) : Number.NaN;
  const hasExpiry = Number.isFinite(expiry);
  const errorLabel = input.ssl_error ? ERROR_LABELS[input.ssl_error] || '证书异常' : '';
  if (!hasExpiry && !errorLabel) return null;
  const dateText = hasExpiry ? new Date(expiry).toLocaleDateString('zh-CN') : '';
  if (!hasExpiry) return { label: errorLabel, title: errorLabel, tone: 'red', daysLeft: null };
  const daysLeft = Math.floor((expiry - nowMs) / DAY_MS);
  if (daysLeft < 0) {
    return { label: '证书已过期', title: `到期时间 ${dateText}`, tone: 'red', daysLeft };
  }
  const title = `到期时间 ${dateText}${errorLabel ? `；${errorLabel}` : ''}`;
  const tone: SslTone = errorLabel || daysLeft <= Math.min(3, warnDays) ? 'red' : daysLeft <= warnDays ? 'amber' : 'green';
  return { label: errorLabel || `证书 ${daysLeft} 天`, title, tone, daysLeft };
}
