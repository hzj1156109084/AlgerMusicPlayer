import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import CryptoJS from 'crypto-js';

import useIndexedDB from '@/hooks/IndexDBHook';

/**
 * Android/iOS 端的音频磁盘缓存。
 *
 * 为什么需要它：桌面版的磁盘缓存整个活在 Electron 主进程里（src/main/modules/cache.ts，
 * 纯 Node fs），而端上不跑 src/main/*，所以断网时连刚播过的歌都放不了 —— 不是「没命中
 * 缓存」，是**根本没有缓存这一层**。
 *
 * 与桌面版的两处**有意偏离**，都是为了「断网能重放」这个目标本身：
 *
 * 1. **按键命中，不按 urlHash 卡新鲜度。** 网易的播放地址是时效签名 URL 且会轮转，
 *    新会话里 sha1(新URL) 与存档里的 urlHash 恒不相等。桌面版据此判定未命中并回源，
 *    离线时等于彻底不可用。这里改成按键（`songId_source`）命中；urlHash 只用于判断
 *    「要不要趁现在有网把新地址换下来」，绝不阻塞播放。
 *
 * 2. **不缓存歌词。** 歌词已经由 src/renderer/hooks/MusicHook.ts 的 musicDB /
 *    music_lyric 对象仓持久化，离线本来就能显示；再缓存一遍只是平白翻倍淘汰面积。
 *
 * cookie 相关：这里下载的是**已经签名好的 CDN 地址**，不带任何 cookie / UA / referer，
 * downloadFile 与 convertFileSrc 也都不碰原生 cookie jar（且 CapacitorCookies 是关闭的）。
 * 所以用户的 MUSIC_U 没有任何经过此模块离开设备的路径。
 */

/** 缓存根目录，相对 Directory.Data（Android 上即 files/） */
const CACHE_ROOT = 'audio-cache';
const MUSIC_DIR = `${CACHE_ROOT}/music`;
const TMP_DIR = `${CACHE_ROOT}/tmp`;

const DB_NAME = 'audioCacheDB';
const STORE = 'entries';
/**
 * 库版本。留成 2 而不是 1 是有原因的：端上进程会被系统随时杀掉，IndexedDB 的
 * leveldb 在这种反复强杀下出现过「库停在 version 1 但一个对象仓都没有」的状态
 * （元数据与数据脱节）。版本号抬到 2 之后，`onupgradeneeded` 还会再跑一次，
 * 缺的仓会被补建回来；版本号不抬就永远没有机会修。
 */
const DB_VERSION = 2;

/** 同一首歌 60 秒内重复播放不重写索引，避免 lastAccessAt 造成写放大 */
const ACCESS_THROTTLE_MS = 60 * 1000;
/** 脏索引合并落盘的间隔 */
const FLUSH_DELAY_MS = 5 * 1000;

/** 与桌面版 cache.ts 的 MIN_CACHE_SIZE_MB 保持一致 */
const MIN_CACHE_SIZE_MB = 256;
const DEFAULT_MAX_SIZE_MB = 500;

type CleanupPolicy = 'lru' | 'fifo';
export type AudioCacheScope = 'music' | 'all';

export type AudioCacheEntry = {
  /** `${songId}_${safeSource}` —— IndexedDB 的主键 */
  key: string;
  songId: number;
  source: string;
  /** 相对 Directory.Data 的路径 */
  filePath: string;
  /** sha1(下载时用的 URL)，仅用于判断要不要机会性刷新 */
  urlHash: string;
  size: number;
  createdAt: number;
  lastAccessAt: number;
  playCount: number;
  title?: string;
  artist?: string;
};

/** 与 SystemTab 里的 DiskCacheStats 形状一致，便于共用同一套 UI */
export type AudioCacheStats = {
  enabled: boolean;
  directory: string;
  maxSizeMB: number;
  cleanupPolicy: CleanupPolicy;
  totalSizeBytes: number;
  musicSizeBytes: number;
  lyricSizeBytes: number;
  totalFiles: number;
  musicFiles: number;
  lyricFiles: number;
  usage: number;
};

export type AudioCacheResolvePayload = {
  songId: number;
  source?: string;
  url: string;
  title?: string;
  artist?: string;
};

export type AudioCacheResolveResult = {
  url: string;
  cached: boolean;
  queued: boolean;
};

export type AudioCacheClearResult = {
  freedBytes: number;
  removedCount: number;
};

// ==================== 内部状态 ====================

type AudioCacheDBSchema = { entries: AudioCacheEntry };

const createDb = () =>
  useIndexedDB<'entries', AudioCacheDBSchema>(
    DB_NAME,
    [{ name: STORE, keyPath: 'key' }],
    DB_VERSION
  );

type AudioCacheDB = Awaited<ReturnType<typeof createDb>>;

let dbPromise: Promise<AudioCacheDB> | null = null;
let settingsPromise: Promise<{ setData: any }> | null = null;

/** 内存索引：读取与淘汰的唯一事实来源，避免每次操作都读库 */
let entries: Record<string, AudioCacheEntry> = {};
let loaded = false;
let loadPromise: Promise<void> | null = null;
let dirsReady = false;

/** 同 key 并发去重（镜像桌面版 cache.ts 的 pendingMusicDownloads） */
const pending = new Map<string, Promise<void>>();

const dirtyKeys = new Set<string>();
let flushTimer: number | null = null;
let visibilityBound = false;

// ==================== 基础工具 ====================

const safeSource = (source?: string): string =>
  (source || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

const buildKey = (songId: number | string, source?: string): string =>
  `${songId}_${safeSource(source)}`;

const hashUrl = (url: string): string => CryptoJS.SHA1(url).toString();

const toLocalUrl = (filePath: string): string => `local:///${filePath}`;

const statOrNull = async (path: string) => {
  try {
    const info = await Filesystem.stat({ path, directory: Directory.Data });
    return info?.type === 'file' ? info : null;
  } catch {
    return null;
  }
};

/**
 * 判断某个地址是不是本模块的缓存命中标记（`local:///audio-cache/music/...`）。
 *
 * 只认自己这棵子树：本地音乐用的也是 `local://`，但那是用户选进来的绝对路径，
 * 与缓存无关，不能混为一谈。
 */
const isCacheUrl = (url?: string | null): boolean =>
  !!url && url.startsWith(`local:///${MUSIC_DIR}/`);

/**
 * 缓存命中留下的 `local://` 还指得动文件吗。
 *
 * **这个判断不能省。** 设置里的「清空歌曲缓存」会把整棵目录删掉，容量淘汰也会删文件，
 * 而这类 `local://` 挂在播放状态里**不会被自动纠正** —— `playerCore` 和 `useSongDetail`
 * 的半小时过期清理都刻意跳过 `local://`（那是为「本地音乐不过期」加的豁免）。
 * 不复用前确认一下，就会一直拿一个不存在的文件去喂 Howl（Howler 报
 * MEDIA_ERR_SRC_NOT_SUPPORTED），表现成「清空缓存之后这首歌唱再也放不了了」。
 */
const isCacheUrlAlive = async (url?: string | null): Promise<boolean> => {
  if (!isCacheUrl(url)) return true; // 不是缓存标记，不归这里管
  return !!(await statOrNull((url as string).slice('local:///'.length)));
};

const removeFileQuietly = async (path: string): Promise<void> => {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  } catch {
    // 文件本来就不在，忽略
  }
};

// ==================== 配置（直接复用设置页里那套开关，不另起一份 key） ====================

const loadSettingsStore = async () => {
  if (!settingsPromise) {
    settingsPromise = import('@/store/modules/settings').then((m) => m.useSettingsStore());
  }
  return settingsPromise;
};

const getConfig = async (): Promise<{
  enabled: boolean;
  maxSizeMB: number;
  cleanupPolicy: CleanupPolicy;
}> => {
  let raw: any = {};
  try {
    raw = (await loadSettingsStore())?.setData || {};
  } catch (error) {
    console.warn('[audioDiskCache] 读取设置失败，按默认值处理:', error);
  }

  return {
    enabled: raw.enableDiskCache !== false,
    maxSizeMB: Math.max(
      MIN_CACHE_SIZE_MB,
      Math.floor(Number(raw.diskCacheMaxSizeMB) || DEFAULT_MAX_SIZE_MB)
    ),
    cleanupPolicy: raw.diskCacheCleanupPolicy === 'fifo' ? 'fifo' : 'lru'
  };
};

// ==================== 索引读写 ====================

const getDb = (): Promise<AudioCacheDB> => {
  if (!dbPromise) {
    dbPromise = createDb();
  }
  return dbPromise;
};

const persistEntry = async (key: string): Promise<void> => {
  const entry = entries[key];
  if (!entry) return;
  try {
    const db = await getDb();
    await db.saveData(STORE, entry);
  } catch (error) {
    console.warn('[audioDiskCache] 写入缓存索引失败:', error);
  }
};

const removeEntryRecord = async (key: string): Promise<void> => {
  try {
    const db = await getDb();
    await db.deleteData(STORE, key);
  } catch (error) {
    console.warn('[audioDiskCache] 删除缓存索引失败:', error);
  }
};

const clearFlushTimer = () => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
};

const flushDirty = async (): Promise<void> => {
  clearFlushTimer();
  if (!dirtyKeys.size) return;
  const keys = Array.from(dirtyKeys);
  dirtyKeys.clear();
  for (const key of keys) {
    await persistEntry(key);
  }
};

const scheduleFlush = () => {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushDirty();
  }, FLUSH_DELAY_MS);
};

// ==================== 目录准备 ====================

/**
 * 幂等地建好目录。
 * 显式 mkdir 而不是只靠 downloadFile 的 recursive：recursive 在 Android 上有过
 * 历史 bug（capacitor#6896），自己建一遍就不用赌它修好了。
 */
const ensureDirs = async (): Promise<void> => {
  if (dirsReady) return;
  for (const dir of [MUSIC_DIR, TMP_DIR]) {
    try {
      await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
    } catch {
      // 已存在，正常
    }
  }
  dirsReady = true;
};

/** 清掉上次进程被杀时残留的半截文件（桌面版是直接留着的，这里做得更干净） */
const resetTmpDir = async (): Promise<void> => {
  try {
    await Filesystem.rmdir({ path: TMP_DIR, directory: Directory.Data, recursive: true });
  } catch {
    // 不存在就算了
  }
  dirsReady = false;
};

// ==================== 扩展名判定 ====================

const AUDIO_EXTENSIONS = ['mp3', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'opus', 'wav', 'wma', 'ape'];

const extensionFromUrl = (url: string): string | null => {
  try {
    const pathname = new URL(url).pathname;
    const match = /\.([a-zA-Z0-9]{2,5})$/.exec(pathname);
    if (!match) return null;
    const ext = match[1].toLowerCase();
    return AUDIO_EXTENSIONS.includes(ext) ? `.${ext}` : null;
  } catch {
    return null;
  }
};

const readHeaderBytes = async (path: string): Promise<Uint8Array | null> => {
  try {
    // 不给 encoding，原生就按 base64 返回二进制（见 ReadFileOptions 的注释）
    const { data } = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      offset: 0,
      length: 16
    });
    if (typeof data !== 'string' || !data) return null;
    return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

/**
 * 靠文件头兜底判扩展名。
 *
 * 这一步在端上比在桌面版更要紧：`_capacitor_file_` 是按扩展名决定响应 Content-Type 的
 * （Android 的 MimeTypeMap），而 downloadFile 拿不到响应头。FLAC 被当成 audio/mpeg
 * 返回会直接解码失败，所以不能只靠 .mp3 兜底。
 */
const extensionFromMagic = async (path: string): Promise<string | null> => {
  const bytes = await readHeaderBytes(path);
  if (!bytes || bytes.length < 4) return null;

  const [b0, b1, b2, b3] = bytes;

  if (b0 === 0x66 && b1 === 0x4c && b2 === 0x61 && b3 === 0x43) return '.flac'; // "fLaC"
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return '.mp3'; // "ID3"
  if (b0 === 0x4f && b1 === 0x67 && b2 === 0x67 && b3 === 0x53) return '.ogg'; // "OggS"
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) return '.wav'; // "RIFF"

  // MP4 家族：第 4-7 字节是 "ftyp"，第 8-11 字节是 brand
  if (bytes.length >= 12 && b1 === 0x66 && b2 === 0x74 && b3 === 0x79 && bytes[4] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return brand.startsWith('M4A') ? '.m4a' : '.mp4';
  }

  // ADTS AAC（掩码比 MP3 的帧同步更具体，必须先判，否则会被 MP3 规则吃掉）
  if (b0 === 0xff && (b1 & 0xf6) === 0xf0) return '.aac';
  // MP3 帧同步
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return '.mp3';

  return null;
};

const resolveExtension = async (path: string, url: string): Promise<string> => {
  return extensionFromUrl(url) ?? (await extensionFromMagic(path)) ?? '.mp3';
};

// ==================== 命中校验 ====================

/** 校验条目对应文件是否真的在。索引与磁盘漂移（被外部清掉）时删掉幽灵条目并当未命中。 */
const verifyEntry = async (entry: AudioCacheEntry): Promise<boolean> => {
  const info = await statOrNull(entry.filePath);
  if (!info || !info.size) {
    delete entries[entry.key];
    await removeEntryRecord(entry.key);
    return false;
  }
  return true;
};

const touch = (key: string): void => {
  const entry = entries[key];
  if (!entry) return;
  entry.playCount += 1;
  const now = Date.now();
  if (now - entry.lastAccessAt < ACCESS_THROTTLE_MS) return;
  entry.lastAccessAt = now;
  dirtyKeys.add(key);
  scheduleFlush();
};

// ==================== 初始化 ====================

/**
 * 从缓存文件名反解出重建索引所需的信息。
 *
 * 文件名形如 `<songId>_<safeSource>_<sha1(url)><ext>`，而 `<safeSource>` 本身允许含
 * 下划线，所以从右往左切：先剥扩展名，末 40 位是 sha1，剩下那段正好就是索引主键。
 */
const parseCacheFileName = (
  fileName: string
): { key: string; songId: number; source: string; urlHash: string } | null => {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;

  const stem = fileName.slice(0, dot); // `<key>_<sha1>`
  const urlHash = stem.slice(-40);
  if (stem.length < 42 || !/^[0-9a-f]{40}$/.test(urlHash)) return null;

  const key = stem.slice(0, -41); // 去掉分隔用的 `_` 与 sha1
  const underscore = key.indexOf('_');
  if (underscore <= 0) return null;

  const songId = Number(key.slice(0, underscore));
  if (!songId || Number.isNaN(songId)) return null;

  // source 取到的是 safeSource（已消毒），而查表用的 buildKey 也会做同样的消毒，
  // 所以两边算出来的 key 必然一致
  return { key, songId, source: key.slice(underscore + 1), urlHash };
};

/**
 * 用磁盘上的实际文件重建、校正内存索引。
 *
 * **目录才是事实来源，索引只是加速。** 端上进程随时会被系统杀掉，而 IndexedDB 在反复
 * 强杀下出现过「库还在、对象仓却没了」的状态（见 DB_VERSION 的注释），WAL 里的记录
 * 回放不出来，索引就是空的。若只信索引，磁盘上明明躺着的文件会被当成没缓存过 ——
 * 而「断网能放之前播过的歌」恰恰不能有这个前提。
 */
const rebuildIndexFromDisk = async (): Promise<void> => {
  type CacheDirEntry = { name: string; type?: string; size?: number; mtime?: number };

  let files: CacheDirEntry[] = [];
  try {
    const result = await Filesystem.readdir({ path: MUSIC_DIR, directory: Directory.Data });
    files = (result.files || []) as CacheDirEntry[];
  } catch {
    // 目录还没建出来。不能当成「磁盘上是空的」，否则会把好端端的索引剪光
    return;
  }

  const onDisk = new Set<string>();
  const rebuilt: string[] = [];

  for (const file of files) {
    if (file.type && file.type !== 'file') continue;
    const parsed = parseCacheFileName(file.name);
    if (!parsed) continue;

    const filePath = `${MUSIC_DIR}/${file.name}`;
    onDisk.add(filePath);

    const existing = entries[parsed.key];
    if (existing && existing.filePath === filePath) {
      // 索引里有，拿磁盘上的真实体积校正一下
      if (file.size) existing.size = file.size;
      continue;
    }

    entries[parsed.key] = {
      key: parsed.key,
      songId: parsed.songId,
      source: parsed.source,
      filePath,
      urlHash: parsed.urlHash,
      size: file.size || 0,
      createdAt: existing?.createdAt ?? file.mtime ?? Date.now(),
      lastAccessAt: existing?.lastAccessAt ?? file.mtime ?? Date.now(),
      playCount: existing?.playCount ?? 0,
      title: existing?.title,
      artist: existing?.artist
    };
    rebuilt.push(parsed.key);
  }

  // 索引里有、磁盘上没有 → 幽灵条目（被外部删过），顺手清掉
  for (const entry of Object.values(entries)) {
    if (!onDisk.has(entry.filePath)) {
      delete entries[entry.key];
      void removeEntryRecord(entry.key);
    }
  }

  // 写回索引，下次启动就不必再扫一遍盘
  for (const key of rebuilt) {
    await persistEntry(key);
  }

  if (rebuilt.length) {
    console.log(
      `[audioDiskCache] 已按磁盘重建索引 ${rebuilt.length} 条（磁盘 ${files.length} 个文件，现共 ${Object.keys(entries).length} 条）`
    );
  }
};

const ensureLoaded = async (): Promise<void> => {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const db = await getDb();
        const all = (await db.getAllData(STORE)) as AudioCacheEntry[];
        entries = {};
        for (const entry of all || []) {
          if (entry?.key) entries[entry.key] = entry;
        }
      } catch (error) {
        // 索引读不出来不是致命的：下面直接按磁盘重建
        console.warn('[audioDiskCache] 读取缓存索引失败，改为按磁盘重建:', error);
        entries = {};
      }

      try {
        await ensureDirs();
        // 清掉上次进程被杀时留下的半截文件，再把目录建回来
        await resetTmpDir();
        await ensureDirs();
        await rebuildIndexFromDisk();
        bindVisibilityFlush();
      } catch (error) {
        console.warn('[audioDiskCache] 按磁盘重建索引失败:', error);
      } finally {
        // 无论成败都标记完成，避免一次失败把后续所有播放都卡在重试上
        loaded = true;
      }
      // 补上「应用没开的时候把上限调小了」这种情况
      void enforceLimit();
    })();
  }
  return loadPromise;
};

const bindVisibilityFlush = () => {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushDirty();
  });
};

// ==================== 淘汰 ====================

const enforceLimit = async (): Promise<void> => {
  await ensureLoaded();
  const { enabled, maxSizeMB, cleanupPolicy } = await getConfig();
  if (!enabled) return;

  const budget = maxSizeMB * 1024 * 1024;
  const list = Object.values(entries);
  let total = list.reduce((sum, entry) => sum + (entry.size || 0), 0);
  if (total <= budget) return;

  // 单一合并预算（只有音乐一个池子），按 lastAccessAt / createdAt 升序淘汰，
  // 与桌面版 cache.ts 的 LRU/FIFO 语义一致
  const field = cleanupPolicy === 'fifo' ? 'createdAt' : 'lastAccessAt';
  list.sort((a, b) => (a[field] || 0) - (b[field] || 0));

  for (const entry of list) {
    if (total <= budget) break;
    await removeFileQuietly(entry.filePath);
    total -= entry.size || 0;
    delete entries[entry.key];
    await removeEntryRecord(entry.key);
  }
};

// ==================== 下载落盘 ====================

const downloadAndCache = async (payload: AudioCacheResolvePayload): Promise<void> => {
  await ensureLoaded();
  const { enabled } = await getConfig();
  if (!enabled) return;

  const key = buildKey(payload.songId, payload.source);
  const urlHash = hashUrl(payload.url);
  const existing = entries[key];

  // 同一个地址且文件还在 → 什么都不用做
  if (existing && existing.urlHash === urlHash) {
    const info = await statOrNull(existing.filePath);
    if (info?.size) return;
  }

  await ensureDirs();

  const tmpPath = `${TMP_DIR}/${key}_${Date.now()}.part`;

  // downloadFile 自 @capacitor/filesystem 7.1.0 起被标记 deprecated（后继是
  // @capacitor/file-transfer），8.1.4 里仍然可用。选它是因为它走原生流式下载：
  // 不经 JS 内存（一首无损 30-50MB，走 base64 会先膨胀 1.33 倍），也不受 CORS 限制。
  await Filesystem.downloadFile({
    url: payload.url,
    path: tmpPath,
    directory: Directory.Data,
    recursive: true
  });

  const tmpInfo = await statOrNull(tmpPath);
  if (!tmpInfo?.size) {
    await removeFileQuietly(tmpPath);
    throw new Error('下载得到的文件为空');
  }

  const extension = await resolveExtension(tmpPath, payload.url);
  const finalPath = `${MUSIC_DIR}/${key}_${urlHash}${extension}`;

  // 地址变了导致扩展名变了：先去掉旧文件，否则同一首歌会留下两份
  if (existing?.filePath && existing.filePath !== finalPath) {
    await removeFileQuietly(existing.filePath);
  }

  // 先写 .part 再 rename，保证最终路径上只可能是完整文件
  try {
    await Filesystem.rename({
      from: tmpPath,
      to: finalPath,
      directory: Directory.Data,
      toDirectory: Directory.Data
    });
  } catch (error) {
    // 目标已存在（并发或重复下载）：留下既有文件，扔掉临时文件
    await removeFileQuietly(tmpPath);
    if (!(await statOrNull(finalPath))) throw error;
  }

  const finalInfo = await statOrNull(finalPath);
  if (!finalInfo?.size) return;

  const now = Date.now();
  entries[key] = {
    key,
    songId: Number(payload.songId),
    source: payload.source || 'unknown',
    filePath: finalPath,
    urlHash,
    size: finalInfo.size,
    createdAt: existing?.createdAt ?? now,
    lastAccessAt: now,
    playCount: existing?.playCount ?? 0,
    title: payload.title,
    artist: payload.artist
  };
  await persistEntry(key);
  void enforceLimit();
};

const queueDownload = (payload: AudioCacheResolvePayload): void => {
  const key = buildKey(payload.songId, payload.source);
  if (pending.has(key)) return;

  const task = downloadAndCache(payload)
    .catch((error) => {
      console.warn('[audioDiskCache] 后台缓存失败，不影响播放:', error);
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, task);
};

// ==================== 对外接口 ====================

/**
 * 按键查缓存，**不需要 URL**。
 *
 * 这是「重启后离线」和「过期后离线」能成立的关键：playerCore 在启动恢复播放时会主动把
 * 非 local:// 的 playMusicUrl 置空（playerCore.ts），半小时过期逻辑也会清掉它
 * （usePlayerHooks.ts），于是 getSongUrl 是带着空 URL 进来的 —— 那条路上根本走不到
 * resolveMusicUrl，只能先按 songId+source 查一次。
 */
const getOfflinePlaybackUrl = async (
  songId: number | string,
  source?: string
): Promise<string | null> => {
  const numericId = Number(songId);
  if (!numericId || Number.isNaN(numericId)) return null;
  if (!Capacitor.isNativePlatform()) return null;

  const { enabled } = await getConfig();
  if (!enabled) return null;

  await ensureLoaded();
  const entry = entries[buildKey(numericId, source)];
  if (!entry) return null;
  if (!(await verifyEntry(entry))) return null;

  touch(entry.key);
  return toLocalUrl(entry.filePath);
};

/**
 * 手里已经有解析好的地址时的手递手（镜像桌面版 cache.ts 的 resolveMusicUrl）：
 * 命中就返回本地地址，未命中就返回在线地址并在后台入队 —— 首次在线播放行为不变。
 */
const resolveMusicUrl = async (
  payload: AudioCacheResolvePayload
): Promise<AudioCacheResolveResult> => {
  const fallback: AudioCacheResolveResult = {
    url: payload?.url ?? '',
    cached: false,
    queued: false
  };
  if (!payload?.url || !payload?.songId) return fallback;
  if (/^(local|file):\/\//i.test(payload.url)) {
    return { url: payload.url, cached: true, queued: false };
  }
  if (!Capacitor.isNativePlatform()) return fallback;

  const { enabled } = await getConfig();
  if (!enabled) return fallback;

  const hit = await getOfflinePlaybackUrl(payload.songId, payload.source);
  if (hit) {
    // 网易地址会轮转：不拿它卡命中，只在有网时顺手把新地址换下来
    const entry = entries[buildKey(payload.songId, payload.source)];
    if (entry && entry.urlHash !== hashUrl(payload.url)) {
      queueDownload(payload);
    }
    return { url: hit, cached: true, queued: false };
  }

  queueDownload(payload);
  return { url: payload.url, cached: false, queued: true };
};

const getStats = async (): Promise<AudioCacheStats> => {
  await ensureLoaded();
  const { enabled, maxSizeMB, cleanupPolicy } = await getConfig();

  const list = Object.values(entries);
  const totalSizeBytes = list.reduce((sum, entry) => sum + (entry.size || 0), 0);
  const limitBytes = maxSizeMB * 1024 * 1024;

  let directory = '';
  try {
    const { uri } = await Filesystem.getUri({ path: CACHE_ROOT, directory: Directory.Data });
    directory = uri;
  } catch {
    // 目录还没建出来，留空即可
  }

  return {
    enabled,
    directory,
    maxSizeMB,
    cleanupPolicy,
    totalSizeBytes,
    musicSizeBytes: totalSizeBytes,
    lyricSizeBytes: 0,
    totalFiles: list.length,
    musicFiles: list.length,
    lyricFiles: 0,
    usage: limitBytes > 0 ? Math.min(1, totalSizeBytes / limitBytes) : 0
  };
};

/**
 * 清空缓存。
 *
 * 删整棵树而不是逐条 deleteFile：这样连索引丢失的孤儿文件和残留的 .part 一并清掉，
 * 而索引驱动的删除根本看不见它们（readdir 不递归，手工遍历不划算）。
 * 下一次下载会用幂等的 mkdir 把目录重新建起来。
 */
const clear = async (scope: AudioCacheScope = 'music'): Promise<AudioCacheClearResult> => {
  void scope; // 目前只有音乐一个池子，'music' 与 'all' 等价
  await ensureLoaded();

  const list = Object.values(entries);
  const freedBytes = list.reduce((sum, entry) => sum + (entry.size || 0), 0);
  const removedCount = list.length;

  try {
    await Filesystem.rmdir({ path: CACHE_ROOT, directory: Directory.Data, recursive: true });
  } catch (error) {
    console.warn('[audioDiskCache] 删除缓存目录失败（多半是本来就不存在）:', error);
  }

  entries = {};
  dirtyKeys.clear();
  clearFlushTimer();
  dirsReady = false;

  try {
    const db = await getDb();
    await db.clearData(STORE);
  } catch (error) {
    console.warn('[audioDiskCache] 清空缓存索引失败:', error);
  }

  return { freedBytes, removedCount };
};

/** 设置里改了容量上限后调用，让新上限立刻生效 */
const onConfigChanged = (): void => {
  void enforceLimit();
};

export const audioDiskCache = {
  getOfflinePlaybackUrl,
  resolveMusicUrl,
  getStats,
  clear,
  onConfigChanged,
  isCacheUrl,
  isCacheUrlAlive
};
