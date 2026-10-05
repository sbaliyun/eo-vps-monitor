#!/usr/bin/env node
// 前端使用 Vite 8，需要 Node.js ^20.19 或 >=22.12。构建环境过旧时给出明确提示。
const [major, minor] = process.versions.node.split('.').map(Number);
const ok = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
if (!ok) {
  console.error(`[check-node] 当前 Node.js ${process.versions.node} 过旧，需要 ^20.19 或 >=22.12。`);
  console.error('[check-node] 请在 EdgeOne 控制台选择 Node.js 24.5.0，或在本地构建后上传 edgeone-dist（见 README）。');
  process.exit(1);
}
