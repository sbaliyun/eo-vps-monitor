import workerPackage from '../../package.json';

declare const __BUILD_COMMIT__: string | undefined;

export const APP_VERSION = workerPackage.version?.trim() || 'dev';

/** 构建时由 esbuild 注入的 Git 提交号（ESA 构建环境可能拿不到，则为空）。 */
export const BUILD_COMMIT = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : '';
