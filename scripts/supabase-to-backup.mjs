#!/usr/bin/env node
/**
 * 把旧版 cf-vps-monitor（Supabase）数据库里导出的 JSON 转成新系统可导入的加密备份。
 *
 * 适用于旧后台已经打不开、无法在「站点设置」下载备份的情况。在 Supabase SQL Editor 运行：
 *
 *   select json_build_object(
 *     'clients',  (select coalesce(json_agg(c order by c.sort_order, c.name), '[]'::json) from clients c),
 *     'settings', (select coalesce(json_object_agg(s.key, s.value), '{}'::json) from settings s)
 *   ) as export;
 *
 * 把结果单元格的 JSON 保存为文件，然后：
 *
 *   node scripts/supabase-to-backup.mjs export.json backup.json
 *
 * 脚本会提示输入备份密码（也可用环境变量 BACKUP_PASSWORD），输出的 backup.json 在新后台
 * 「设置 → 站点设置 → 恢复备份」上传即可。节点 Token 原样保留，Agent 无需重装。
 * 也接受只包含节点数组的 JSON（`select json_agg(c) from clients c`）。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { isKnownSettingKey } from '../worker/src/settings/schema.ts';
import { BACKUP_SCHEMA_ID, BACKUP_SCOPE, BACKUP_VERSION, encryptBackup, validateBackup } from '../worker/src/utils/backup.ts';

function unwrap(value) {
  // Supabase 结果导出可能是 [{ export: {...} }] 或 [{ json_agg: [...] }] 这样的行数组。
  if (Array.isArray(value) && value.length === 1 && value[0] && typeof value[0] === 'object' && !('uuid' in value[0])) {
    const cells = Object.values(value[0]);
    if (cells.length === 1) return unwrap(typeof cells[0] === 'string' ? JSON.parse(cells[0]) : cells[0]);
  }
  return value;
}

// settings 表里还混有原系统的运行状态（health:*、维护时间戳、迁移版本），原版备份不会导出它们。
// 站点 Logo 的内嵌图片在新系统单独存储，这里不迁移，恢复后在后台重新上传即可。
const SKIPPED_SETTING_KEYS = new Set(['site_logo_url', 'site_logo_data', 'site_logo_type']);

function settingsObject(value) {
  if (!value) return undefined;
  const entries = Array.isArray(value) ? value.map((row) => [row.key, row.value ?? '']) : Object.entries(value);
  return Object.fromEntries(entries.filter(([key]) => isKnownSettingKey(key) && !SKIPPED_SETTING_KEYS.has(key)));
}

export function buildBackupFromExport(raw, now = new Date()) {
  const data = unwrap(raw);
  const clients = Array.isArray(data) ? data : data?.clients;
  if (!Array.isArray(clients)) throw new Error('导出内容里没有 clients 数组');
  const backup = {
    schema: BACKUP_SCHEMA_ID,
    version: BACKUP_VERSION,
    scope: BACKUP_SCOPE,
    timestamp: now.toISOString(),
    clients,
  };
  const settings = Array.isArray(data) ? undefined : settingsObject(data.settings);
  if (settings && Object.keys(settings).length > 0) backup.settings = settings;
  return validateBackup(backup);
}

async function readPassword() {
  if (process.env.BACKUP_PASSWORD) return process.env.BACKUP_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question('设置备份密码（至少 6 位，上传时需要输入）：');
  } finally {
    rl.close();
  }
}

async function main() {
  const [input, output = 'esa-vps-monitor-encrypted-backup.json'] = process.argv.slice(2);
  if (!input) {
    console.error('用法：node scripts/supabase-to-backup.mjs <导出的 JSON 文件> [输出文件]');
    process.exit(2);
  }
  const result = buildBackupFromExport(JSON.parse(await readFile(input, 'utf8')));
  if (!result.ok) {
    console.error('导出内容校验失败：\n- ' + result.errors.join('\n- '));
    process.exit(1);
  }
  for (const warning of result.warnings) console.error('提示：' + warning);
  const encrypted = await encryptBackup(result.backup, await readPassword());
  if (!encrypted.ok) {
    console.error(encrypted.error);
    process.exit(1);
  }
  await writeFile(output, JSON.stringify(encrypted.encryptedBackup, null, 2));
  const withToken = result.backup.clients.filter((client) => client.token || client.token_hash).length;
  console.error(`已生成 ${output}：${result.backup.clients.length} 个节点（${withToken} 个带 Token）` +
    (result.backup.settings ? '，含站点设置' : ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
