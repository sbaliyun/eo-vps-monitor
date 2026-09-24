import { Hono } from 'hono';
import type * as db from '../db/types';
import {
  base64ToBytes,
  buildThemeCss,
  normalizeThemeManifest,
  normalizeThemePath,
  parseThemeZip,
  validateThemeConfig,
} from '../utils/theme-package';
import { readJsonWithLimit, readRequestBytesWithLimit } from '../utils/request-body';
import { adminSettingsOf, mutateCore, readCore } from '../store/core';
import type { CoreDoc, StoredTheme } from '../store/types';
import { deleteThemeBundles, planThemeBundles, readThemeAsset, writeThemeBundles } from '../store/themes';
import { queueAudit } from '../services/notify';
import { services, type AppContext, type HonoEnv } from './common';

type ThemeContext = AppContext;

export const adminThemeRoutes = new Hono<HonoEnv>();
export const publicThemeRoutes = new Hono<HonoEnv>();

const MAX_THEME_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_THEME_JSON_BYTES = 256 * 1024;
const MAX_THEME_CUSTOM_CSS_BYTES = 64 * 1024;
const BUILTIN_STYLE_PATH = 'builtin.css';
const BUILTIN_THEMES = [
  {
    short: 'monitor',
    name: 'Monitor',
    description: '项目内置Monitor主题',
    previewUrl: '/theme-previews/monitor.svg',
  },
  {
    short: 'aurora',
    name: 'Aurora',
    description: '项目内置 Aurora 极光玻璃主题',
    previewUrl: '/theme-previews/aurora.svg',
  },
] as const;

// 已退场内置主题的迁移目标。必须与前端 displayTheme.ts 的 legacyDisplayThemeMap 逐项一致，
// 否则前台按别名渲染 Aurora、后台却认不出 active_theme，"当前"标记会落空。
// 只做读时翻译，不改写数据库——存量 active_theme='next' 的站点无需重新初始化。
const LEGACY_THEME_ALIASES: Record<string, string> = {
  'cf-monitor': 'aurora',
  next: 'aurora',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isUploadedFile(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } {
  return !!value && typeof value === 'object' && 'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}

async function readJsonObject(c: ThemeContext): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const parsed = await readJsonWithLimit(c.req.raw, MAX_THEME_JSON_BYTES);
  if (!parsed.ok) {
    if (parsed.reason === 'too_large') return { response: c.json({ error: `请求内容不能超过 ${MAX_THEME_JSON_BYTES} 字节` }, 413) };
    return { response: c.json({ error: '请求 JSON 格式错误' }, 400) };
  }
  return isObject(parsed.body) ? { body: parsed.body } : { response: c.json({ error: '请求内容必须是 JSON 对象' }, 400) };
}

function jsonParseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeManifest(value: string): ReturnType<typeof normalizeThemeManifest> | null {
  try {
    return normalizeThemeManifest(JSON.parse(value));
  } catch {
    return null;
  }
}

function isBuiltinTheme(short: string): short is typeof BUILTIN_THEMES[number]['short'] {
  return BUILTIN_THEMES.some(theme => theme.short === short);
}

// 退场主题的 short 同样是保留字：它们会被 normalizeActiveTheme 重定向，
// 一旦被上传占用，该主题包将无法启用（别名指向别处）、不出现在列表里、
// 也删不掉（删除端点经别名后判定为内置），成为一条卡死的幽灵记录。
function isReservedThemeShort(short: string): boolean {
  return isBuiltinTheme(short) || Object.prototype.hasOwnProperty.call(LEGACY_THEME_ALIASES, short);
}

function builtinThemePreviewUrl(short: string): string {
  return BUILTIN_THEMES.find(theme => theme.short === short)?.previewUrl || '';
}

function normalizeActiveTheme(short: string | null | undefined): string {
  const value = short && short !== 'default' ? short : 'monitor';
  return LEGACY_THEME_ALIASES[value] || value;
}

function builtinThemeRecord(short: typeof BUILTIN_THEMES[number]['short']): db.ThemeUpsertInput {
  const builtin = BUILTIN_THEMES.find(theme => theme.short === short)!;
  const manifest = {
    name: builtin.name,
    short: builtin.short,
    description: builtin.description,
    version: '',
    author: 'ESA VPS Monitor',
    url: '',
    preview: '',
    style: BUILTIN_STYLE_PATH,
    configuration: {
      type: 'managed',
      data: [],
    },
  };
  return {
    short: builtin.short,
    name: builtin.name,
    description: builtin.description,
    version: '',
    author: 'ESA VPS Monitor',
    url: '',
    preview_path: '',
    style_path: BUILTIN_STYLE_PATH,
    manifest_json: JSON.stringify(manifest),
    config_json: '{}',
    custom_css: '',
  };
}

function themeSummary(theme: db.Theme, activeTheme: string) {
  const manifest = safeManifest(theme.manifest_json);
  const builtin = isBuiltinTheme(theme.short);
  return {
    short: theme.short,
    name: theme.name,
    description: theme.description,
    version: theme.version,
    author: theme.author,
    url: theme.url,
    preview_path: theme.preview_path,
    preview_url: builtin ? builtinThemePreviewUrl(theme.short) : theme.preview_path ? `/api/theme/assets/${encodeURIComponent(theme.short)}/${theme.preview_path}` : '',
    active: activeTheme === theme.short,
    deletable: !builtin,
    configurable: true,
    manifest,
    config: jsonParseObject(theme.config_json),
    custom_css: theme.custom_css,
  };
}

function builtinThemeSummary(short: typeof BUILTIN_THEMES[number]['short'], activeTheme: string, stored?: db.Theme) {
  return themeSummary(stored || { ...builtinThemeRecord(short), created_at: '', updated_at: '' }, activeTheme);
}

function cssResponse(css: string): Response {
  return new Response(css, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
    },
  });
}

function publicJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
    },
  });
}

function themeAssetHeaders(contentType: string): HeadersInit {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; font-src 'self'",
  };
}

function findTheme(core: CoreDoc, short: string): StoredTheme | null {
  return core.themes.find(theme => theme.short === short) ?? null;
}

function activeThemeOf(core: CoreDoc): string {
  return normalizeActiveTheme(adminSettingsOf(core).active_theme);
}

function audit(c: ThemeContext, action: string, detail: string): void {
  queueAudit(services(c), c.get('username') || 'admin', action, detail);
}

adminThemeRoutes.get('/', async (c) => {
  const core = await readCore(services(c), 0);
  const activeTheme = activeThemeOf(core);
  const themeMap = new Map(core.themes.map(theme => [theme.short, theme]));
  const builtinSummaries = BUILTIN_THEMES.map(theme => builtinThemeSummary(theme.short, activeTheme, themeMap.get(theme.short)));
  const uploadedSummaries = core.themes
    .filter(theme => !isReservedThemeShort(theme.short))
    .map(theme => themeSummary(theme, activeTheme));
  return c.json({ active_theme: activeTheme, data: [...builtinSummaries, ...uploadedSummaries] });
});

adminThemeRoutes.post('/upload', async (c) => {
  const body = await readRequestBytesWithLimit(c.req.raw, MAX_THEME_ZIP_BYTES + 4096);
  if (!body.ok) return c.json({ error: `主题包不能超过 ${MAX_THEME_ZIP_BYTES} 字节` }, 413);
  let form: FormData;
  try {
    form = await new Response(body.bytes, { headers: { 'Content-Type': c.req.header('Content-Type') || '' } }).formData();
  } catch {
    return c.json({ error: '主题包表单格式错误' }, 400);
  }
  const file = form.get('file');
  if (!isUploadedFile(file)) return c.json({ error: '请上传主题 zip 文件' }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_THEME_ZIP_BYTES) return c.json({ error: `主题包不能超过 ${MAX_THEME_ZIP_BYTES} 字节` }, 413);
  let parsed: ReturnType<typeof parseThemeZip>;
  try {
    parsed = parseThemeZip(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知错误';
    return c.json({ error: `主题包解析失败: ${detail}` }, 400);
  }
  if (isReservedThemeShort(parsed.theme.short)) return c.json({ error: '不能覆盖内置主题' }, 400);
  const plan = planThemeBundles(parsed.theme.short, parsed.assets);
  if ('error' in plan) return c.json({ error: plan.error }, 413);

  const app = services(c);
  const before = await readCore(app, 0);
  const existing = findTheme(before, parsed.theme.short);
  if (existing) {
    const manifest = normalizeThemeManifest(JSON.parse(parsed.theme.manifest_json));
    const validated = validateThemeConfig(manifest, jsonParseObject(existing.config_json));
    parsed.theme.config_json = JSON.stringify(validated.ok ? validated.config : jsonParseObject(parsed.theme.config_json));
    parsed.theme.custom_css = existing.custom_css;
  }
  await writeThemeBundles(app, plan.bundles);
  const now = new Date(app.now()).toISOString();
  const stored: StoredTheme = { ...parsed.theme, assets: plan.refs, created_at: existing?.created_at || now, updated_at: now };
  const activeTheme = await mutateCore(app, (core) => {
    core.themes = [...core.themes.filter(theme => theme.short !== stored.short), stored];
    return activeThemeOf(core);
  }, { bumpMeta: true });
  if (existing) await deleteThemeBundles(app, existing, new Set(plan.bundles.map(bundle => bundle.key)));
  audit(c, 'theme_upload', `上传主题: ${stored.short}`);
  return c.json({ success: true, theme: themeSummary(stored, activeTheme) });
});

adminThemeRoutes.post('/set', async (c) => {
  const parsed = await readJsonObject(c);
  if ('response' in parsed) return parsed.response;
  const short = normalizeActiveTheme(typeof parsed.body.short === 'string' ? parsed.body.short.trim() : '');
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return c.json({ error: '主题 ID 无效' }, 400);
  const ok = await mutateCore(services(c), (core) => {
    if (!isBuiltinTheme(short) && !findTheme(core, short)) return false;
    core.settings.active_theme = short;
    return true;
  }, { bumpMeta: true });
  if (!ok) return c.json({ error: '主题不存在' }, 404);
  audit(c, 'theme_set', `启用主题: ${short}`);
  return c.json({ success: true, active_theme: short });
});

adminThemeRoutes.post('/settings', async (c) => {
  const parsed = await readJsonObject(c);
  if ('response' in parsed) return parsed.response;
  const short = normalizeActiveTheme(typeof parsed.body.short === 'string' ? parsed.body.short.trim() : '');
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return c.json({ error: '主题 ID 无效' }, 400);
  const customCss = typeof parsed.body.custom_css === 'string' ? parsed.body.custom_css : '';
  if (new TextEncoder().encode(customCss).byteLength > MAX_THEME_CUSTOM_CSS_BYTES) {
    return c.json({ error: `自定义 CSS 不能超过 ${MAX_THEME_CUSTOM_CSS_BYTES} 字节` }, 413);
  }
  const app = services(c);
  const result = await mutateCore(app, (core) => {
    let theme = findTheme(core, short);
    if (!theme && isBuiltinTheme(short)) {
      const now = new Date(app.now()).toISOString();
      theme = { ...builtinThemeRecord(short), assets: [], created_at: now, updated_at: now };
      core.themes.push(theme);
    }
    if (!theme) return { error: '主题不存在', status: 404 as const };
    const manifest = normalizeThemeManifest(JSON.parse(theme.manifest_json));
    const config = validateThemeConfig(manifest, parsed.body.config);
    if (!config.ok) throw new ThemeConfigError(config.error);
    theme.config_json = JSON.stringify(config.config);
    theme.custom_css = customCss;
    theme.updated_at = new Date(app.now()).toISOString();
    return { ok: true as const };
  }, { bumpMeta: true }).catch((error: unknown) => {
    if (error instanceof ThemeConfigError) return { error: error.message, status: 400 as const };
    throw error;
  });
  if ('error' in result) return c.json({ error: result.error }, result.status);
  audit(c, 'theme_settings', `配置主题: ${short}`);
  return c.json({ success: true });
});

class ThemeConfigError extends Error {}

adminThemeRoutes.post('/delete', async (c) => {
  const parsed = await readJsonObject(c);
  if ('response' in parsed) return parsed.response;
  const short = normalizeActiveTheme(typeof parsed.body.short === 'string' ? parsed.body.short.trim() : '');
  if (!/^[A-Za-z0-9_-]+$/.test(short) || isBuiltinTheme(short)) return c.json({ error: '内置主题不能删除' }, 400);
  const app = services(c);
  const result = await mutateCore(app, (core) => {
    const theme = findTheme(core, short);
    if (!theme) return null;
    const activeTheme = activeThemeOf(core);
    core.themes = core.themes.filter(item => item.short !== short);
    if (activeTheme === short) core.settings.active_theme = 'monitor';
    return { theme, activeTheme: activeTheme === short ? 'monitor' : activeTheme };
  }, { bumpMeta: true });
  if (!result) return c.json({ error: '主题不存在' }, 404);
  await deleteThemeBundles(app, result.theme);
  audit(c, 'theme_delete', `删除主题: ${short}`);
  return c.json({ success: true, active_theme: result.activeTheme });
});

publicThemeRoutes.get('/active.css', async (c) => {
  try {
    const app = services(c);
    const core = await readCore(app);
    const activeTheme = activeThemeOf(core);
    const theme = findTheme(core, activeTheme);
    if (!theme) return cssResponse('');
    const asset = isBuiltinTheme(theme.short) ? null : await readThemeAsset(app, theme, theme.style_path);
    if (!asset && !isBuiltinTheme(theme.short)) return cssResponse('');
    return cssResponse(buildThemeCss({
      styleCss: asset ? new TextDecoder().decode(base64ToBytes(asset.content_base64)) : '',
      config: jsonParseObject(theme.config_json),
      customCss: theme.custom_css,
    }));
  } catch {
    return cssResponse('');
  }
});

publicThemeRoutes.get('/assets/:theme/*', async (c) => {
  const short = c.req.param('theme');
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return c.json({ error: 'Not Found' }, 404);
  let path: string;
  try {
    const prefix = `/api/theme/assets/${short}/`;
    const raw = c.req.path.startsWith(prefix) ? decodeURIComponent(c.req.path.slice(prefix.length)) : '';
    path = normalizeThemePath(raw);
  } catch {
    return c.json({ error: 'Not Found' }, 404);
  }
  const app = services(c);
  const core = await readCore(app);
  const theme = findTheme(core, short);
  const asset = theme ? await readThemeAsset(app, theme, path) : null;
  if (!asset) return c.json({ error: 'Not Found' }, 404);
  return new Response(base64ToBytes(asset.content_base64), { headers: themeAssetHeaders(asset.content_type) });
});

publicThemeRoutes.get('/manifest/:theme', async (c) => {
  const short = normalizeActiveTheme(c.req.param('theme'));
  const core = await readCore(services(c));
  if (isBuiltinTheme(short)) return publicJson(builtinThemeSummary(short, short, findTheme(core, short) || undefined));
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return c.json({ error: 'Not Found' }, 404);
  const theme = findTheme(core, short);
  if (!theme) return c.json({ error: 'Not Found' }, 404);
  return publicJson({ short: theme.short, manifest: safeManifest(theme.manifest_json), config: jsonParseObject(theme.config_json) });
});
