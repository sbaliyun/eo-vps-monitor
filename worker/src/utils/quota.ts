/** ESA 用量参考链接。具体免费额度与单价以阿里云官方页面为准。 */
export function buildQuotaReference() {
  return {
    sources: {
      esa_functions: 'https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/what-is-functions-and-pages/',
      esa_edge_kv: 'https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/edge-storage-1/',
      esa_limits: 'https://help.aliyun.com/zh/edge-security-acceleration/esa/product-overview/limits-on-using-esa',
    },
  };
}
