import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { cloneDeep } from 'lodash';

import { getMusicLrc } from '@/api/music';
import {
  type AndroidSaveMode,
  hasDirectoryPermission,
  isAndroidStorageAvailable,
  pickDirectory,
  saveFile} from '@/services/androidStorage';
import { audioDiskCache } from '@/services/audioDiskCache';
import { getSongUrl } from '@/store/modules/player';
import { useSettingsStore } from '@/store/modules/settings';
import type { SongResult } from '@/types/music';
import { mergeLrcWithTranslation } from '@/utils/lrc';

/**
 * 端上「下载到设备」的编排层。
 *
 * 桌面那条下载链是纯 Electron 主进程的（useDownload → ipcRenderer →
 * src/main/modules/fileManager.ts，用 node:fs / music-metadata / node-id3），端上
 * window.electron 是 undefined，一行都跑不了。这里是它的等价物，四步：
 *
 *   1. getSongUrl(…, isDownloaded=true)          拿地址（与桌面同一个函数、同一个网络出口）
 *   2. audioDiskCache.ensureCachedFile(…)        落进应用缓存，得到一个可拷贝的本地文件
 *   3. androidStorage.saveFile(…)                把音频拷到用户看得见的地方
 *   4. 同名 .lrc                                  写中转文件 → 拷出去 → 删中转
 *
 * **不写 ID3/FLAC 标签、不嵌封面**：那需要解析容器，端上没有 Node。文件名已经带了歌名歌手，
 * 封面交给系统音乐 App 去刮，歌词用同名 .lrc 旁挂 —— 效果等价。
 */

/** 与桌面 fileManager.ts 的 `|| '{songName} - {artistName}'` 逐字一致 */
const DEFAULT_NAME_FORMAT = '{songName} - {artistName}';

/** 音乐库模式下的默认子目录（`Music/AlgerMusic/`） */
export const DEFAULT_MEDIA_SUB_DIR = 'AlgerMusic';

/**
 * 歌词中转目录。刻意**不用** `audio-cache/tmp/`：那是 audioDiskCache 的原子写中转区，
 * 被 resetTmpDir() 整体清空、还会被 clear() 的 rmdir 扫到，不该混进无关文件。
 */
const LRC_STAGE_DIR = 'download-stage';

export type NativeDownloadFailureCode =
  /** 非 Android / 原生插件不可用 */
  | 'unavailable'
  /** 拿不到播放地址（版权、VIP、网络），或歌曲 ID 非法 */
  | 'no_url'
  /** 音频没能落到应用缓存里 */
  | 'cache_failed'
  /** 这首歌压根没有歌词 */
  | 'no_lyric'
  /** SAF 模式下没有可用的目录授权（没选过，或被系统撤销了） */
  | 'no_directory'
  /** API < 29：音乐库模式没有 RELATIVE_PATH 可用，应改走 SAF */
  | 'unsupported_api_level'
  /** 原生侧复制失败 */
  | 'save_failed';

export type NativeDownloadResult = {
  /** 最终写出去的文件名（含扩展名） */
  fileName: string;
  /**
   * 人类可读的落点，如 `Music/AlgerMusic/歌名.flac`。
   * 用户手机连不上电脑、用不了 chrome://inspect，这是这个功能在设备上**唯一**
   * 能自查落点的地方，所以成功提示里必须带上（照 SystemTab 只读展示缓存目录的先例）。
   */
  displayPath: string;
  size: number;
  /** 同名 .lrc 是否一起写成功。歌词是尽力而为，false **不**影响整体成功 */
  lyricSaved: boolean;
  /** 关掉磁盘缓存时，第 2 步那份中转是否已经顺手删掉 */
  cacheCleared: boolean;
};

/**
 * 判别联合而不是抛异常：失败原因是**要展示给用户看**的（「没选目录」要引导去设置页、
 * 「老系统不支持」要自动切到 SAF），调用方需要按 code 分派，而不是去 catch message。
 */
export type NativeDownloadOutcome =
  | { ok: true; result: NativeDownloadResult }
  | { ok: false; code: NativeDownloadFailureCode; message?: string; fallback?: 'saf' };

export type NativeDownloadTarget = {
  mode: AndroidSaveMode;
  /** 仅 mediastore 模式有意义；空串 = 直接写 `Music/` 根 */
  subDir: string;
  /** 仅 saf 模式有意义 */
  treeUri: string;
};

/**
 * 读设置里的下载落点。
 *
 * 目录名的清洗（首尾斜杠、`..`）统一交给原生侧做，这里只区分两件事：
 * 「没配过」（非字符串 → 回退默认）和「配成空串」（用户有意要直接写在 `Music/` 根）。
 */
export const resolveDownloadTarget = (): NativeDownloadTarget => {
  const { setData } = useSettingsStore();
  const mode: AndroidSaveMode = setData?.downloadDirMode === 'saf' ? 'saf' : 'mediastore';

  return {
    mode,
    subDir:
      mode === 'mediastore' && typeof setData?.downloadMediaDir === 'string'
        ? setData.downloadMediaDir
        : DEFAULT_MEDIA_SUB_DIR,
    treeUri: typeof setData?.downloadSafTreeUri === 'string' ? setData.downloadSafTreeUri : ''
  };
};

/**
 * 下载前给目的地做个体检，返回 null 表示可以继续。
 *
 * 单独拎出来是给**设置页**复用的：页面挂载时先跑一次，就能在用户点下载**之前**发现
 * 「SAF 授权被系统撤销了」，而不是等到下载失败才报。
 */
export const checkDownloadTarget = async (): Promise<NativeDownloadOutcome | null> => {
  if (!isAndroidStorageAvailable()) return { ok: false, code: 'unavailable' };

  const target = resolveDownloadTarget();
  if (target.mode === 'saf') {
    // 没选过目录、和授权被撤销，是同一种下场：都写不进去
    if (!target.treeUri) return { ok: false, code: 'no_directory' };
    if (!(await hasDirectoryPermission(target.treeUri))) {
      return { ok: false, code: 'no_directory' };
    }
  }
  return null;
};

/**
 * 老系统上音乐库模式走不通时的退路：切到自定义目录，并**顺手把系统目录选择器拉起来**。
 *
 * 别指望用户自己去设置页找（他多半也不知道要找什么）。不动手就只是弹一句
 * 「不支持」，那是个死循环：下次点下载还是同一句。
 *
 * 模式先落成 'saf' 再拉选择器：用户中途取消也停在 'saf'，下次下载会明确报「还没选目录」，
 * 比留在 'mediastore' 上反复撞 unsupported_api_level 清楚。
 *
 * @returns 用户选中的目录名；取消或失败返回 null
 */
export const switchToCustomDirectory = async (): Promise<string | null> => {
  const settingsStore = useSettingsStore();
  settingsStore.setSetData({ downloadDirMode: 'saf' });

  const picked = await pickDirectory();
  if (!picked) return null;

  settingsStore.setSetData({ downloadSafTreeUri: picked.uri });
  return picked.label || picked.uri;
};

// ==================== 文件名 ====================

/**
 * 与桌面逐字一致的命名规则。
 *
 * 抄的是 src/main/modules/fileManager.ts 的 downloadMusic()：同样的 downloadNameFormat
 * 占位符（`{songName}` / `{artistName}` / `{albumName}`）、同样的 `、` 连接符、
 * 同样的 `未知艺术家` / `未知专辑` 兜底、同样只替换 `[<>:"/\|?*]` 并折叠空白。
 *
 * 那两个兜底串**故意不接 i18n**：文件名要跨平台一致（同一张歌单在桌面和手机上导出的
 * 名字该一样），而且它们在桌面本来就是硬编码中文。改了这里就对不上桌面了。
 */
const sanitizeFileName = (name: string): string =>
  name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

const buildBaseName = (song: SongResult): string => {
  const { setData } = useSettingsStore();
  const format = String(setData?.downloadNameFormat || DEFAULT_NAME_FORMAT);

  const artists = song.ar || song.song?.artists;
  const songName = song.name || 'unknown';
  const artistName = artists?.map((a: any) => a.name).join('、') || '未知艺术家';
  const albumName = song.al?.name || '未知专辑';

  const composed = format
    .replace(/\{songName\}/g, songName)
    .replace(/\{artistName\}/g, artistName)
    .replace(/\{albumName\}/g, albumName);

  let base = sanitizeFileName(composed) || songName;

  // 长度上限：Android 单个路径段通常是 255 **字节**，中文按 UTF-8 占 3 字节，
  // 多歌手的 `A、B、C…` 很容易撞上去 —— 超了 MediaStore 直接 FAILED，没有任何别的症状。
  // 按字符截到 120 留足余量，扩展名还有地方放。
  if (base.length > 120) base = base.slice(0, 120).trim();

  // 结尾的点和空格在部分存储上会被静默吃掉，导致「写的是这个名字、看到的是另一个」
  return base.replace(/[. ]+$/, '') || 'unknown';
};

// ==================== MIME ====================

/**
 * 扩展名 → MIME。扩展名来自 audioDiskCache 的**魔数嗅探**，不是接口返回的 type 字段
 * （那个经常不准），所以这张表的命中率是可靠的。
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.ape': 'audio/x-ape',
  '.wma': 'audio/x-ms-wma'
};

const mimeForExtension = (extension: string): string =>
  MIME_BY_EXTENSION[extension.toLowerCase()] || 'audio/mpeg';

// ==================== 歌词 ====================

/**
 * 取一份能直接写进 .lrc 的文本：磁盘缓存优先，其次网络。
 * 有翻译就合并 —— 与桌面 downloadLyric 的行为一致（那边也是先 merge 再写文件）。
 */
const loadLrcText = async (songId: number): Promise<string | null> => {
  let lyricData: any = await audioDiskCache.readCachedLyric(songId);

  if (!lyricData) {
    try {
      lyricData = (await getMusicLrc(songId))?.data;
      // 顺手落盘，与播放链路上 loadLrc 的做法一致；缓存关掉时它内部会自己跳过
      if (lyricData) void audioDiskCache.saveCachedLyric(songId, lyricData);
    } catch (error) {
      // 离线且没缓存过 —— 只下音频，不报错
      console.warn('[nativeDownload] 取歌词失败，只下音频:', error);
      return null;
    }
  }

  const original = lyricData?.lrc?.lyric;
  if (!original) return null;
  const translation = lyricData?.tlyric?.lyric;
  return translation ? mergeLrcWithTranslation(original, translation) : original;
};

/**
 * 写中转文件 → 让原生侧拷出去 → **无论成败**都删掉中转。
 * 返回 null 表示连中转都没写成（没有歌词文本 / 写盘失败）。
 */
const stageAndSaveLyric = async (
  baseName: string,
  target: NativeDownloadTarget,
  lrcText: string
): Promise<Awaited<ReturnType<typeof saveFile>> | null> => {
  const stagedPath = `${LRC_STAGE_DIR}/${baseName}.lrc`;

  try {
    // Directory.Cache = getCacheDir()，系统随时可以清理，正好适合一次性中转
    await Filesystem.writeFile({
      path: stagedPath,
      data: lrcText,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true
    });

    // 插件要真实路径。注意它把**相对**路径按 getFilesDir() 解析，而这里是 cache 目录，
    // 所以必须取 getUri 给的 file:// 绝对地址，不能直接甩 stagedPath。
    const { uri } = await Filesystem.getUri({ path: stagedPath, directory: Directory.Cache });

    const outcome = await saveFile({
      sourcePath: uri,
      // 与音频**同名**，这是「同名 .lrc」的全部意义：系统音乐 App 靠它找到歌词
      fileName: `${baseName}.lrc`,
      mimeType: 'text/plain',
      mode: target.mode,
      subDir: target.mode === 'mediastore' ? target.subDir : '',
      treeUri: target.treeUri
    });

    if (!outcome.ok) {
      console.warn('[nativeDownload] 歌词落盘失败:', outcome.code, outcome.message);
    }
    return outcome;
  } catch (error) {
    console.warn('[nativeDownload] 歌词中转失败:', error);
    return null;
  } finally {
    try {
      await Filesystem.deleteFile({ path: stagedPath, directory: Directory.Cache });
    } catch {
      // 本来就没写成功，或者已经被清掉了 —— 删不掉无所谓
    }
  }
};

// ==================== 对外 ====================

/**
 * 下载一首歌：音频 + 同名歌词。
 *
 * 前置校验失败（没选 SAF 目录 / 插件不可用）会**在动手之前**返回，不会下到一半才失败。
 */
export const downloadSongToDevice = async (song: SongResult): Promise<NativeDownloadOutcome> => {
  if (!isAndroidStorageAvailable()) return { ok: false, code: 'unavailable' };

  const precheck = await checkDownloadTarget();
  if (precheck) return precheck;

  const songId = Number(song?.id);
  if (!songId || Number.isNaN(songId)) {
    return { ok: false, code: 'no_url', message: '无效的歌曲 ID' };
  }

  // 1. 地址。与桌面 useDownload.ts 同一个函数、同样传 isDownloaded=true ——
  //    只有这条分支才走 VIP 的 song/download/url/v1。**不新增任何网络出口**，
  //    走的还是既有 request 层，「cookie 不出设备」这条硬约束不变。
  let url: string | undefined;
  try {
    const resolved: any = await getSongUrl(song.id, cloneDeep(song), true);
    url = typeof resolved === 'string' ? resolved : resolved?.url;
  } catch (error) {
    return { ok: false, code: 'no_url', message: (error as Error)?.message };
  }
  if (!url) return { ok: false, code: 'no_url' };

  // 2. 落进应用缓存，拿到一个可拷贝的本地文件
  let cached: Awaited<ReturnType<typeof audioDiskCache.ensureCachedFile>>;
  try {
    cached = await audioDiskCache.ensureCachedFile({
      songId,
      source: song.source,
      url,
      title: song.name,
      artist: (song.ar || song.song?.artists)?.map((a: any) => a.name).join(',')
    });
  } catch (error) {
    return { ok: false, code: 'cache_failed', message: (error as Error)?.message };
  }

  // 3. 把音频拷到用户看得见的地方
  const target = resolveDownloadTarget();
  const baseName = buildBaseName(song);
  const fileName = `${baseName}${cached.extension}`;

  const outcome = await saveFile({
    sourcePath: cached.filePath,
    fileName,
    mimeType: mimeForExtension(cached.extension),
    mode: target.mode,
    // SAF 模式不套子目录：「自定义目录」的意思就是「就写这儿」
    subDir: target.mode === 'mediastore' ? target.subDir : '',
    treeUri: target.treeUri
  });

  if (!outcome.ok) {
    // 老系统没有 RELATIVE_PATH，不是错误而是「此路不通」：带上 fallback，让上层
    // 自动切到 SAF 并顺手拉起目录选择器
    if (outcome.code === 'unsupported_api_level') {
      return {
        ok: false,
        code: 'unsupported_api_level',
        fallback: 'saf',
        message: outcome.message
      };
    }
    return {
      ok: false,
      code: outcome.code === 'no_directory_permission' ? 'no_directory' : 'save_failed',
      message: outcome.message
    };
  }

  // 4. 歌词尽力而为：失败不影响「音频已经落地」这个事实，结果里如实回报
  const lyric = await loadLrcText(songId);
  const lyricOutcome = lyric ? await stageAndSaveLyric(baseName, target, lyric) : null;

  // 5. 关掉磁盘缓存的用户要自己收尾：第 2 步是刻意绕过开关写进去的，
  //    不删掉的话 audio-cache 会无上限增长（remove 会连清单和孤儿歌词一起收拾）
  let cacheCleared = false;
  if (useSettingsStore().setData?.enableDiskCache === false) {
    cacheCleared = await audioDiskCache.remove(cached.key);
  }

  return {
    ok: true,
    result: {
      fileName,
      displayPath: outcome.displayPath,
      size: outcome.size,
      lyricSaved: !!lyricOutcome?.ok,
      cacheCleared
    }
  };
};

/**
 * 只写一份 .lrc（行内菜单的「下载歌词」走这条）。
 *
 * 刻意**不要求**歌曲有音频地址 —— 「把这首歌的歌词单独存一份」是个合理诉求，
 * 而且离线时音频多半下不了、歌词却可能已经在缓存里躺着。
 */
export const downloadLyricToDevice = async (song: SongResult): Promise<NativeDownloadOutcome> => {
  if (!isAndroidStorageAvailable()) return { ok: false, code: 'unavailable' };

  const precheck = await checkDownloadTarget();
  if (precheck) return precheck;

  const songId = Number(song?.id);
  if (!songId || Number.isNaN(songId)) {
    return { ok: false, code: 'no_url', message: '无效的歌曲 ID' };
  }

  const lrcText = await loadLrcText(songId);
  if (!lrcText) return { ok: false, code: 'no_lyric' };

  const target = resolveDownloadTarget();
  const baseName = buildBaseName(song);
  const outcome = await stageAndSaveLyric(baseName, target, lrcText);

  if (!outcome?.ok) {
    if (outcome && outcome.code === 'unsupported_api_level') {
      return { ok: false, code: 'unsupported_api_level', fallback: 'saf', message: outcome.message };
    }
    return {
      ok: false,
      code: outcome?.code === 'no_directory_permission' ? 'no_directory' : 'save_failed',
      message: outcome?.message
    };
  }

  return {
    ok: true,
    result: {
      fileName: `${baseName}.lrc`,
      displayPath: outcome.displayPath,
      size: outcome.size,
      // 这条路径本身就是写歌词，所以 lyricSaved 恒为 true
      lyricSaved: true,
      cacheCleared: false
    }
  };
};
