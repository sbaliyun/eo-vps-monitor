/**
 * 主题资源：每个主题的静态资源打包成至多 4 个 KV 值（每个约 800KB 以内），
 * 以便一次上传不超过单请求 KV 操作额度。
 */

import type { AppServices } from '../platform/context';
import type { ThemeAssetUpsertInput } from '../db/types';
import type { StoredTheme, ThemeAssetRef } from './types';

const MAX_BUNDLE_CHARS = 800_000;
export const MAX_THEME_BUNDLES = 4;
const ASSET_CACHE_MS = 5 * 60 * 1000;

type Bundle = Record<string, { content_type: string; content_base64: string }>;

export function themeBundleKey(short: string, index: number): string {
  return `theme_${short}_${index}`;
}

export function planThemeBundles(short: string, assets: ThemeAssetUpsertInput[]): { bundles: Array<{ key: string; value: Bundle }>; refs: ThemeAssetRef[] } | { error: string } {
  const bundles: Array<{ key: string; value: Bundle; size: number }> = [];
  const refs: ThemeAssetRef[] = [];
  for (const asset of assets) {
    const size = asset.content_base64.length + asset.path.length + 64;
    if (size > MAX_BUNDLE_CHARS) return { error: `主题资源 ${asset.path} 过大（单个资源需小于约 600KB）` };
    let bundle = bundles.find(item => item.size + size <= MAX_BUNDLE_CHARS);
    if (!bundle) {
      if (bundles.length >= MAX_THEME_BUNDLES) return { error: '主题资源总量过大，请压缩图片或减少资源（上限约 2.4MB Base64）' };
      bundle = { key: themeBundleKey(short, bundles.length), value: {}, size: 0 };
      bundles.push(bundle);
    }
    bundle.value[asset.path] = { content_type: asset.content_type, content_base64: asset.content_base64 };
    bundle.size += size;
    refs.push({ path: asset.path, key: bundle.key, content_type: asset.content_type, size_bytes: asset.size_bytes });
  }
  return { bundles: bundles.map(({ key, value }) => ({ key, value })), refs };
}

export async function writeThemeBundles(app: AppServices, bundles: Array<{ key: string; value: Bundle }>): Promise<void> {
  for (const bundle of bundles) await app.kv.put(bundle.key, JSON.stringify(bundle.value));
}

export async function deleteThemeBundles(app: AppServices, theme: StoredTheme, keepKeys: Set<string> = new Set()): Promise<void> {
  const keys = new Set(theme.assets.map(asset => asset.key));
  for (const key of keys) {
    if (keepKeys.has(key) || !app.kv.canSpend(1)) continue;
    await app.kv.delete(key);
  }
}

export async function readThemeAsset(app: AppServices, theme: StoredTheme, path: string): Promise<{ content_type: string; content_base64: string } | null> {
  const ref = theme.assets.find(asset => asset.path === path);
  if (!ref) return null;
  const bundle = await app.kv.getJson<Bundle>(ref.key, { maxAgeMs: ASSET_CACHE_MS });
  const asset = bundle?.[path];
  return asset ? { content_type: asset.content_type || ref.content_type, content_base64: asset.content_base64 } : null;
}

export const SITE_LOGO_KEY = 'site_logo';

export async function readSiteLogo(app: AppServices): Promise<{ type: string; data: string } | null> {
  const logo = await app.kv.getJson<{ type: string; data: string }>(SITE_LOGO_KEY, { maxAgeMs: 60_000 });
  return logo && logo.type && logo.data ? logo : null;
}
