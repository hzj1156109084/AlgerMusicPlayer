/**
 * 生成端内网易云 API 的路由表：src/renderer/services/ncm/routes.generated.ts
 *
 * 原理：netease-cloud-music-api-alger 的模块文件名与 URL 路径是机械对应的
 *   module/song_url_v1.js  ←→  /song/url/v1
 * 所以扫描 app 自身src/renderer/api/*.ts 里出现的所有路径字面量，
 * 逐个映射到包的模块文件，并读取该模块声明的加密模式。
 *
 * 用法：node scripts/gen-ncm-routes.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = 'netease-cloud-music-api-alger';
const MODULE_DIR = join(ROOT, 'node_modules', PKG, 'module');
const API_DIR = join(ROOT, 'src', 'renderer', 'api');
const OUT_FILE = join(ROOT, 'src', 'renderer', 'services', 'ncm', 'routes.generated.ts');

/** 收集包内所有模块名（去掉 .js） */
const availableModules = new Set(
  readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
);

/** 扫描 app 的 api/*.ts，收集所有以 / 开头的路径字面量 */
const appPaths = new Set();
for (const file of readdirSync(API_DIR).filter((f) => f.endsWith('.ts'))) {
  const source = readFileSync(join(API_DIR, file), 'utf8');
  for (const match of source.matchAll(/['"](\/[a-z0-9_/]+)['"]/gi)) {
    const path = match[1];
    // 过滤掉非接口路径
    if (path === '/' || path.startsWith('/assets/') || path.startsWith('/images/')) continue;
    appPaths.add(path);
  }
}

/** 判断模块走哪种加密：读它给 createOption 传的第二个参数 */
const cryptoOf = (moduleFile) => {
  const source = readFileSync(moduleFile, 'utf8');
  const call = source.match(/createOption\(query[^)]*\)/);
  if (call && /weapi/.test(call[0])) return 'weapi';
  return 'eapi'; // 显式 eapi，或未指定（APP_CONF.encrypt=true → 默认 eapi）
};

const entries = [];
const missing = [];

for (const path of [...appPaths].sort()) {
  const moduleName = path.slice(1).replace(/\//g, '_');
  if (!availableModules.has(moduleName)) {
    missing.push(path);
    continue;
  }
  entries.push({
    path,
    moduleName,
    crypto: cryptoOf(join(MODULE_DIR, `${moduleName}.js`))
  });
}

if (missing.length) {
  console.warn(`⚠️ 以下路径在包内找不到对应模块，已跳过：\n  ${missing.join('\n  ')}`);
}

/** 生成 import 标识符：加前缀避免与保留字/数字开头冲突 */
const ident = (name) => `m_${name}`;

const imports = entries
  .map((e) => `import ${ident(e.moduleName)} from '${PKG}/module/${e.moduleName}.js';`)
  .join('\n');

const table = entries
  .map(
    (e) =>
      `  '${e.path}': { crypto: '${e.crypto}', module: ${ident(e.moduleName)} }`
  )
  .join(',\n');

const output = `/**
 * 端内网易云 API —— 路由表
 *
 * ⚠️ 本文件由 scripts/gen-ncm-routes.mjs 自动生成，请勿手动修改。
 *    重新生成：node scripts/gen-ncm-routes.mjs
 *
 * 共 ${entries.length} 个端点（weapi ${entries.filter((e) => e.crypto === 'weapi').length} 个，
 * eapi ${entries.filter((e) => e.crypto === 'eapi').length} 个）。
 *
 * 模块来自 ${PKG}，其统一签名为 (query, request) => Promise<{status, body, cookie}>，
 * request 由本层注入（见 ./request.ts），因此模块源码无需任何改动。
 */
import type { NcmModule, NcmRoute } from './types';

${imports}

export const ROUTES: Record<string, NcmRoute> = {
${table}
};
`;

writeFileSync(OUT_FILE, output, 'utf8');
console.log(`✅ 已生成 ${OUT_FILE}`);
console.log(`   ${entries.length} 个端点（weapi ${entries.filter((e) => e.crypto === 'weapi').length} / eapi ${entries.filter((e) => e.crypto === 'eapi').length}）`);
