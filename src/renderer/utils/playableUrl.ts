import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

import { isElectron } from '@/utils';

/**
 * `local://` 是本项目内部的「本地文件」标记。
 *
 * Electron 主进程注册了同名协议来真正读取它（src/main/modules/fileManager.ts 里的
 * `protocol.registerFileProtocol('local', ...)`），Android/WebView 没有这个协议，
 * 所以必须在把地址交给 <audio> / Howler 之前翻译一次。
 *
 * 反过来，故意保留 `local://` 作为内部标记也很重要：播放链路里所有「本地文件不过期、
 * 出错不要清空」的豁免判断，认的都是这个前缀（usePlayerHooks / playerCore / playlist）。
 * 如果缓存命中时直接返回 http://localhost/_capacitor_file_/... ，那些判断就全部失效，
 * 缓存下来的地址会在 30 分钟后被当成普通在线地址清掉，离线播放随即静默失效。
 */
const LOCAL_PROTOCOL = /^local:\/\/\/?/;

export const isLocalUrl = (url?: string | null): boolean =>
  typeof url === 'string' && LOCAL_PROTOCOL.test(url);

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** 已经是绝对路径的形态（Electron 侧写进去的多半是 `E:/...` 之类的绝对路径） */
const isAbsolutePath = (filePath: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/') || filePath.startsWith('file:');

/**
 * 把内部的 `local:///...` 翻译成当前平台真正能加载的地址。
 *
 * - Electron：主进程已注册 local 协议，原样返回
 * - Android / iOS：换成 convertFileSrc 产出的地址。因为 capacitor.config.ts 里
 *   `androidScheme: 'http'`，WebView 的源就是 http://localhost，而 convertFileSrc 产出
 *   `http://localhost/_capacitor_file_/...` —— 与页面**同源**，没有 CORS、也没有混合内容问题。
 * - dev:web（浏览器里跑 vite）：没有原生层，原样返回
 *
 * 非 `local://` 的地址一律原样透传，调用方不用预先判断。
 */
export const toPlayableUrl = async (url: string): Promise<string> => {
  if (!isLocalUrl(url)) return url;
  if (isElectron) return url;
  if (!Capacitor.isNativePlatform()) return url;

  const filePath = safeDecode(url.replace(LOCAL_PROTOCOL, ''));
  if (!filePath) return url;

  try {
    if (isAbsolutePath(filePath)) {
      return Capacitor.convertFileSrc(filePath);
    }

    // 相对路径：按 Directory.Data 解析成真实 uri。
    // 磁盘缓存写进去的就是这种相对路径（见 services/audioDiskCache.ts）。
    const { uri } = await Filesystem.getUri({ path: filePath, directory: Directory.Data });
    return Capacitor.convertFileSrc(uri);
  } catch (error) {
    console.warn('[playableUrl] 解析本地音频地址失败，回退原地址:', error);
    return url;
  }
};
