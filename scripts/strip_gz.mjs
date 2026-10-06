/**
 * 删除 Web 产物里所有的 `.gz`，供 Android 构建使用。
 *
 * 为什么需要这个脚本 —— 两个坑叠在一起：
 *
 * 1. `vite-plugin-compression` 会为每个产物额外生成一份 `.gz`（桌面端有用：
 *    out/renderer 由 Electron 主进程的 Express 静态服务托管，可以协商
 *    Content-Encoding）。但 AGP 合并 assets 时会把 `.gz` 后缀规范化掉，
 *    于是 `index.html` 和 `index.html.gz` 被判成同一个资源名，构建直接以
 *    `Resource and asset merger: Duplicate resources` 失败。
 *    → 已在 electron.vite.config.ts 里用 mode 门控关掉了 Android 模式的压缩。
 *
 * 2. 但只靠 vite 的 `build.emptyOutDir` 清理**在这台 Windows 机器上不可靠**。
 *    实测：连续跑「桌面构建 → Android 构建」，桌面那次产出的 74 个 `.gz`
 *    在 Android 构建后仍剩 1 个，且它的 mtime 前后完全没变 —— 说明不是被
 *    重新生成，而是 emptyOutDir 漏删了。原因是 Vite 的 emptyDir 对删除失败
 *    做了容错（只对 ENOTEMPTY 报错），而 Windows 上文件被短暂占用会抛 EBUSY，
 *    于是被静默跳过。（本机 npm install 也撞过同一个 EBUSY。）
 *
 *    另一个放大问题的点：`cap sync` 是**合并**而不是替换 `assets/public`，
 *    所以一旦有 `.gz` 落进去，之后每次构建都会继续撞车，且看起来像"新问题"。
 *
 * 所以这里做两件事：显式删除 out/renderer 下所有 `.gz`，并在 Android 工程的
 * assets 已存在时一并清干净（cap sync 随后会重新拷贝）。删除带重试，
 * 最终失败则**以非零码退出** —— 宁可构建中断，也不让一个漏删的 .gz 潜伏到
 * Gradle 阶段变成看不懂的 Duplicate resources。
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 待清理的目录：Web 产物本身，以及 cap sync 的合并目标 */
const TARGETS = [resolve('out/renderer'), resolve('android/app/src/main/assets/public')];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 删除单个文件，遇到占用（EBUSY/EPERM/ENOTEMPTY）时重试 */
const removeWithRetry = async (file) => {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await rm(file, { force: true });
      return true;
    } catch (error) {
      if (attempt === 6) {
        console.error(`[strip-gz] 🔴 无法删除，已重试 6 次: ${file}`);
        console.error(`[strip-gz]    ${error.code || ''} ${error.message}`);
        return false;
      }
      // 多半是刚写完文件句柄还没释放，等一会儿再试
      await sleep(150 * attempt);
    }
  }
  return false;
};

const walk = async (dir, onGz) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在（例如还没跑过 cap sync）—— 不是错误
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onGz);
    } else if (entry.name.toLowerCase().endsWith('.gz')) {
      await onGz(full);
    }
  }
};

let removed = 0;
const failed = [];

for (const target of TARGETS) {
  if (!existsSync(target)) continue;
  await walk(target, async (file) => {
    const ok = await removeWithRetry(file);
    if (ok) {
      removed++;
    } else {
      failed.push(file);
    }
  });
}

// 复核：确认两个目录下确实一个 .gz 都不剩
const leftovers = [];
for (const target of TARGETS) {
  if (!existsSync(target)) continue;
  await walk(target, async (file) => {
    try {
      await stat(file);
      leftovers.push(file);
    } catch {
      // 已经不在了
    }
  });
}

if (leftovers.length > 0 || failed.length > 0) {
  console.error(`[strip-gz] 🔴 清理后仍有 ${leftovers.length} 个 .gz 残留`);
  console.error('[strip-gz]    Android 构建会因 Duplicate resources 失败。');
  console.error('[strip-gz]    若是文件被占用，关掉正在运行的 dev server / Android Studio 后重试。');
  process.exit(1);
}

console.log(`[strip-gz] ✅ 已清理 ${removed} 个 .gz（out/renderer 与 android assets 均为空）`);
