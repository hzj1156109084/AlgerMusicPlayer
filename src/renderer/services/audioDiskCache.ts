import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
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
 * 2. **歌词也落盘（`audio-cache/lyric/<songId>.json`）。** 曾经这里写的是"不缓存歌词，
 *    交给 MusicHook 的 musicDB / music_lyric 对象仓就够了"。这个判断在真机上不成立：
 *    端上歌词**只有** IndexedDB 这一条来源（usePlayerHooks 的 isElectron 分支被跳过，
 *    桌面端的主进程歌词缓存够不着），而这个平台的 IndexedDB 丢过记录 —— 音频在磁盘上、
 *    歌名在 song-meta.json 里，唯独歌词会跟着索引一起消失，表现为"歌能放、词没有"。
 *    现在端上是磁盘优先，IDB 退居次选。
 *
 * 歌名/歌手另有一份 `audio-cache/song-meta.json`（见下方 SONG_META_FILE 的注释）。要点是
 * 磁盘文件名里只有 songId，而索引（IndexedDB）在端上被反复强杀时丢过记录 —— 名字必须有个
 * 不依赖索引的落脚点，否则"缓存了哪些歌"就只能显示裸 id。写入走与音频同一套 tmp + rename，
 * 且挂在既有的防抖 flush 与 visibilitychange 上。
 *
 * cookie 相关：这里下载的是**已经签名好的 CDN 地址**，不带任何 cookie / UA / referer，
 * downloadFile 与 convertFileSrc 也都不碰原生 cookie jar（且 CapacitorCookies 是关闭的）。
 * 所以用户的 MUSIC_U 没有任何经过此模块离开设备的路径。
 */

/** 缓存根目录，相对 Directory.Data（Android 上即 files/） */
const CACHE_ROOT = 'audio-cache';
const MUSIC_DIR = `${CACHE_ROOT}/music`;
const TMP_DIR = `${CACHE_ROOT}/tmp`;
/**
 * 歌词落盘目录。
 *
 * 按 songId 一文件（`<songId>.json`），不跟音频文件挂钩：歌词是**每首歌**一份，而音频是
 * 按 `songId_source` 存的，同一首歌可能有两份音频共用同一份歌词。
 */
const LYRIC_DIR = `${CACHE_ROOT}/lyric`;
/**
 * 磁盘歌词的寿命，与 api/music.ts 里 IndexedDB 那份保持同一个值。
 *
 * 有 TTL 是必须的：歌词会被上游修正（错别字、时间轴），永久缓存等于把这个能力做没了。
 * 10 天之后重新拉一次，代价可接受。
 */
const LYRIC_TTL_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * 歌曲元数据清单，相对 Directory.Data。
 *
 * 存在的理由：磁盘文件名是 `<songId>_<source>_<sha1><ext>`，**里面没有歌名** —— 歌名只在
 * 索引里。而 rebuildIndexFromDisk() 每次冷启动都会按文件名重建索引，一旦 IndexedDB 丢了
 * 记录（这正是 DB_VERSION 抬到 2 的原因），名字就永久消失了，列表页只能显示裸 songId。
 * 所以名字必须有一份不依赖 IndexedDB 的落脚点。
 *
 * 放在 CACHE_ROOT 下而不是 MUSIC_DIR 里，有两个原因：rebuildIndexFromDisk 会对 MUSIC_DIR
 * 做 readdir，摆进去会被当成音频文件解析；摆这里还能让 clear() 的 rmdir(CACHE_ROOT)
 * 顺手把清单一起清掉，不用另写一行。
 */
const SONG_META_FILE = `${CACHE_ROOT}/song-meta.json`;
/** 清单格式版本。形状变了就抬，读到不认识的版本一律当没有清单。 */
const SONG_META_VERSION = 1;

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

/**
 * songId → 歌名/歌手等元数据。
 *
 * 与 AudioCacheEntry 分开存是刻意的：条目是"某个 source 的一份文件"，而这份是按 songId 的
 * 事实。同一首歌可能以两个 source 各缓存一份，名字只需要记一份。
 */
export type SongMeta = {
  name?: string;
  /** 展示用的拼接串，与 usePlayerHooks 里 getSongArtistText() 同形 */
  artist?: string;
  ar?: { id: number; name: string }[];
  alName?: string;
  picUrl?: string;
  /** 时长，毫秒 */
  dt?: number;
  updatedAt: number;
  /** 'cache' = 缓存落盘时从播放 payload 记下的；'api' = /song/detail 回填的（更权威） */
  src: 'cache' | 'api';
};

type SongMetaFile = {
  version: number;
  entries: Record<string, SongMeta>;
  /** 回填失败过的 songId → 时间戳，用来退避；否则每次进页面都会去问一批已经下架的 id */
  failedAt?: Record<string, number>;
};

/**
 * 列表页拿到的一行。所有字段都是拷贝，调用方改它不会影响缓存自身的记账。
 */
export type AudioCacheListEntry = {
  key: string;
  songId: number;
  source: string;
  filePath: string;
  /** `local:///audio-cache/music/...`。调用方不必自己拼（也不许 —— 见 isCacheUrl）。 */
  url: string;
  size: number;
  createdAt: number;
  lastAccessAt: number;
  playCount: number;
  title?: string;
  artist?: string;
  picUrl?: string;
  alName?: string;
  ar?: { id: number; name: string }[];
  dt?: number;
  /** 名字是哪来的。'none' 表示页面该去回填。 */
  metaSource: 'entry' | 'manifest' | 'none';
};

export type AudioCacheListOptions = {
  /** 默认 'recent'（最近播放优先）。'name' 会在合并完名字之后再排。 */
  sort?: 'recent' | 'created' | 'name';
  /**
   * 逐条 stat 校验文件是否还在。默认 false —— 加载时和淘汰时都已剪过枝，
   * 每次进页面都 stat 一遍不划算。真正要强一致时才开。
   */
  verify?: boolean;
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

/**
 * ensureCachedFile 的结果。给「下载到设备」用：拿一份确定在磁盘上的文件去交给原生插件复制。
 */
export type AudioCacheEnsureResult = {
  /** `${songId}_${safeSource}`，调用方若要删掉缓存那份，用这个 key */
  key: string;
  /** 相对 Directory.Data 的路径，原生插件按 getFilesDir() 解析 */
  filePath: string;
  size: number;
  /** 带前导点，如 '.flac' —— 直接拼在文件名后面即可 */
  extension: string;
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

/** 内存里的 songId → 元数据映射，key 为 String(songId) */
let songMeta: Record<string, SongMeta> = {};
/** 回填失败记录（见 SongMetaFile.failedAt） */
let metaFailedAt: Record<string, number> = {};
/** 清单待写标记。与 dirtyKeys 共用同一套防抖落盘（flushDirty）。 */
let metaDirty = false;

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
  if (!dirtyKeys.size && !metaDirty) return;

  if (dirtyKeys.size) {
    const keys = Array.from(dirtyKeys);
    dirtyKeys.clear();
    for (const key of keys) {
      await persistEntry(key);
    }
  }

  if (metaDirty) {
    await writeSongMetaManifest();
  }
};

/** 标记清单需要落盘。走的是与索引同一套防抖 + visibilitychange 落盘。 */
const markMetaDirty = (): void => {
  metaDirty = true;
  scheduleFlush();
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
  for (const dir of [MUSIC_DIR, TMP_DIR, LYRIC_DIR]) {
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

// ==================== 歌曲元数据清单 ====================

/**
 * 读清单。
 *
 * 契约：**这一步永远不能失败到影响加载。** 文件不在（首次运行）、内容损坏、版本不认识，
 * 一律当成"还没有清单"继续跑 —— 名字缺失只该让列表页降级显示 songId，不该把整条
 * 开机链路拖垮（ensureLoaded 是每首歌播放前都要 await 的）。
 */
const loadSongMetaManifest = async (): Promise<void> => {
  let raw: string;
  try {
    const { data } = await Filesystem.readFile({
      path: SONG_META_FILE,
      directory: Directory.Data,
      encoding: Encoding.UTF8
    });
    raw = String(data);
  } catch {
    // 首次运行本来就没有这个文件，静默即可
    songMeta = {};
    metaFailedAt = {};
    return;
  }

  try {
    const parsed = JSON.parse(raw) as SongMetaFile;
    if (
      parsed?.version !== SONG_META_VERSION ||
      typeof parsed.entries !== 'object' ||
      !parsed.entries
    ) {
      throw new Error(`版本或形状不符（version=${parsed?.version}）`);
    }
    songMeta = parsed.entries;
    metaFailedAt = parsed.failedAt || {};
  } catch (error) {
    // 损坏的清单丢掉就好：有网时回填会把它重建出来，离线时降级显示 songId
    console.warn('[audioDiskCache] 读取歌曲元数据清单失败，已忽略:', error);
    songMeta = {};
    metaFailedAt = {};
  }
};

/**
 * 写清单。先写 tmp 再 rename，与音频落盘同一套纪律 —— 读到的永远是完整文件，
 * 进程正好在写一半时被杀也不会留下半截 JSON。
 */
const writeSongMetaManifest = async (): Promise<void> => {
  const payload: SongMetaFile = {
    version: SONG_META_VERSION,
    entries: songMeta,
    failedAt: metaFailedAt
  };
  const tmpPath = `${TMP_DIR}/song-meta.json`;

  try {
    await ensureDirs();
    await Filesystem.writeFile({
      path: tmpPath,
      directory: Directory.Data,
      data: JSON.stringify(payload),
      encoding: Encoding.UTF8,
      recursive: true
    });
    await Filesystem.rename({
      from: tmpPath,
      to: SONG_META_FILE,
      directory: Directory.Data,
      toDirectory: Directory.Data
    });
    metaDirty = false;
  } catch (error) {
    // 失败就留着 metaDirty，下次防抖到点会重试
    console.warn('[audioDiskCache] 写入歌曲元数据清单失败:', error);
  }
};

/**
 * 用清单补上条目缺失的名字。
 *
 * 优先内存里已有的：那是播放当时记下的，比清单更贴近用户此刻看到的东西。
 * 空串一律算缺失 —— getSongArtistText() 在拿不到歌手时会返回 ''。
 */
const applySongMeta = (entry: AudioCacheEntry): boolean => {
  if (entry.title && entry.artist) return false;
  const meta = songMeta[String(entry.songId)];
  if (!meta) return false;

  let touched = false;
  if (!entry.title && meta.name) {
    entry.title = meta.name;
    touched = true;
  }
  if (!entry.artist && meta.artist) {
    entry.artist = meta.artist;
    touched = true;
  }
  return touched;
};

/**
 * 把手上新鲜的歌名/歌手记进条目与清单。
 *
 * 存在的理由：rebuildIndexFromDisk 在「索引里没有、磁盘上有」时按文件名重建条目，那条路上
 * 名字是空的；而命中缓存时 payload 里正好带着完整的 name/artist，不补白不补。
 */
const rememberNames = (entry: AudioCacheEntry, title?: string, artist?: string): void => {
  let touched = false;
  if (title && !entry.title) {
    entry.title = title;
    touched = true;
  }
  if (artist && !entry.artist) {
    entry.artist = artist;
    touched = true;
  }
  if (touched) {
    dirtyKeys.add(entry.key);
    scheduleFlush();
  }
  mergeSongMetaFromEntry(entry);
};

/** 缓存落盘时把名字记进清单 —— 文件名里只有 songId，这份清单是名字唯一的持久来源。 */
const mergeSongMetaFromEntry = (entry: AudioCacheEntry): void => {
  if (!entry.title && !entry.artist) return;
  const metaKey = String(entry.songId);
  const existing = songMeta[metaKey];

  // 回填来的更权威，别拿播放当时的旧名字盖掉它
  if (existing?.src === 'api' && existing.name) return;

  songMeta[metaKey] = {
    ...existing,
    name: entry.title || existing?.name,
    artist: entry.artist || existing?.artist,
    updatedAt: Date.now(),
    src: 'cache'
  };
  markMetaDirty();
};

/**
 * 清单只保留内存索引里还在引用的 songId。
 *
 * 一处刻意的顺序要求：**只能在 readdir 成功之后（或 entries 可信时）调用。**
 * 若在"readdir 失败、entries 又恰好是空的"那种双重打击下剪枝，会把清单清空 ——
 * 而那份清单正是为了扛住这种打击才存在的。
 */
const pruneSongMeta = (): void => {
  const alive = new Set<number>();
  for (const entry of Object.values(entries)) alive.add(entry.songId);

  let removed = 0;
  for (const metaKey of Object.keys(songMeta)) {
    if (!alive.has(Number(metaKey))) {
      delete songMeta[metaKey];
      removed += 1;
    }
  }
  if (removed) markMetaDirty();
};

/**
 * 丢掉某个 songId 的元数据 —— 但只在没有任何条目还引用它时。
 *
 * 清单是按 songId 索引的，而条目是按 `songId_source`：同一首歌可能以两个 source 各缓存
 * 一份。删掉 netease 那份就把名字一起抹了，会让 custom 那份变成裸 id。
 */
const dropSongMetaIfUnreferenced = (songId: number): boolean => {
  if (Object.values(entries).some((item) => item.songId === songId)) return false;

  const metaKey = String(songId);
  if (metaKey in songMeta) {
    delete songMeta[metaKey];
    markMetaDirty();
  }
  // 返回值告诉调用方"这首歌的音乐文件已经一份不剩了"，它据此决定要不要顺手删歌词
  return true;
};

// ==================== 歌词落盘 ====================

/**
 * 歌词在磁盘上的形状。`data` 就是 `/lyric/new` 的原样响应体（`{ lrc, yrc, tlyric, ... }`），
 * 不做任何加工 —— 解析留在 usePlayerHooks 的 loadLrc 里，那边才是唯一的真相。
 */
type LyricFile = {
  id: number;
  data: unknown;
  createTime: number;
};

const lyricPath = (songId: number): string => `${LYRIC_DIR}/${songId}.json`;

/**
 * 读磁盘歌词。**永不抛异常**，拿不到就返回 null（调用方会继续往 IDB、网络找）。
 *
 * 返回的是 `data` 本身而不是整条记录：调用方（loadLrc）要的就是 `/lyric/new` 的响应体，
 * 与它从 getMusicLrc 拿到的形状一致。
 */
const readCachedLyric = async (songId: number): Promise<unknown | null> => {
  if (!Capacitor.isNativePlatform()) return null;

  try {
    const result = await Filesystem.readFile({
      path: lyricPath(songId),
      directory: Directory.Data,
      encoding: Encoding.UTF8
    });
    if (typeof result.data !== 'string') return null;

    const parsed = JSON.parse(result.data) as LyricFile;
    if (!parsed?.data || !parsed.createTime) return null;
    // 过期就当没有 —— 让调用方去 IDB / 网络拿新的，歌词修正才能生效
    if (Date.now() - parsed.createTime > LYRIC_TTL_MS) return null;

    return parsed.data;
  } catch {
    // 没有这个文件是最常见的情况（这首歌还没播过），不值得打日志
    return null;
  }
};

/**
 * 歌词落盘。**永不抛异常** —— 调用方是在播放链路上顺手调它的，写不进去只意味着
 * "下次离线可能没词"，不该反过来影响这次播放。
 */
const saveCachedLyric = async (songId: number, data: unknown): Promise<void> => {
  if (!Capacitor.isNativePlatform() || !data) return;

  try {
    // 与音频同一条纪律：先写 tmp 再 rename，读到的永远是完整文件
    const { enabled } = await getConfig();
    if (!enabled) return;

    await ensureDirs();
    const tmpPath = `${TMP_DIR}/lyric-${songId}.json`;
    const payload: LyricFile = { id: songId, data, createTime: Date.now() };

    await Filesystem.writeFile({
      path: tmpPath,
      directory: Directory.Data,
      data: JSON.stringify(payload),
      encoding: Encoding.UTF8,
      recursive: true
    });
    await Filesystem.rename({
      from: tmpPath,
      to: lyricPath(songId),
      directory: Directory.Data,
      toDirectory: Directory.Data
    });
    console.log(`[lyric] 已落盘 songId=${songId}`);
  } catch (error) {
    console.warn(`[lyric] 写入磁盘缓存失败 songId=${songId}:`, error);
  }
};

const removeCachedLyric = async (songId: number): Promise<void> => {
  if (!Capacitor.isNativePlatform()) return;
  await removeFileQuietly(lyricPath(songId));
};

/**
 * 丢掉音频已经不在了的歌词文件。
 *
 * 只在「entries 可信」的时候调（readdir 成功之后，或淘汰刚结束）—— 否则会把好端端的
 * 歌词当成孤儿删掉。和 pruneSongMeta 是同一个前提，所以两处总是一起调。
 */
const pruneLyricFiles = async (): Promise<void> => {
  if (!Capacitor.isNativePlatform()) return;

  let files: { name: string; type?: string }[] = [];
  try {
    const result = await Filesystem.readdir({ path: LYRIC_DIR, directory: Directory.Data });
    files = result.files || [];
  } catch {
    // 目录还没建出来，没有可剪的
    return;
  }

  const alive = new Set<number>();
  for (const entry of Object.values(entries)) alive.add(entry.songId);

  let removed = 0;
  for (const file of files) {
    if (file.type && file.type !== 'file') continue;
    const songId = Number(file.name.replace(/\.json$/, ''));
    if (!Number.isFinite(songId) || alive.has(songId)) continue;
    await removeFileQuietly(`${LYRIC_DIR}/${file.name}`);
    removed += 1;
  }
  if (removed) console.log(`[lyric] 剪掉 ${removed} 份失去音频的歌词`);
};

/** 歌词目录的份数与总体积。readdir 在 Android 上会带 size，不必再逐条 stat。 */
const getLyricStats = async (): Promise<{ files: number; size: number }> => {
  try {
    const result = await Filesystem.readdir({ path: LYRIC_DIR, directory: Directory.Data });
    const files = (result.files || []).filter((file) => !file.type || file.type === 'file');
    return {
      files: files.length,
      size: files.reduce((sum, file) => sum + (file.size || 0), 0)
    };
  } catch {
    return { files: 0, size: 0 };
  }
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
      // 名字可能是上一轮丢索引时丢掉的，从清单补回来并落一次盘
      if (applySongMeta(existing)) rebuilt.push(parsed.key);
      continue;
    }

    const entry: AudioCacheEntry = {
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
    // 索引里没有名字（丢过记录）、但清单里有 —— 这里是名字能活下来的关键一步
    applySongMeta(entry);
    entries[parsed.key] = entry;
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

  // 到这里 readdir 已经成功、entries 才可信，剪枝才是安全的（见 pruneSongMeta 的注释）
  pruneSongMeta();
  void pruneLyricFiles();

  if (rebuilt.length) {
    console.log(
      `[audioDiskCache] 已按磁盘校正索引 ${rebuilt.length} 条（磁盘 ${files.length} 个文件，现共 ${Object.keys(entries).length} 条）`
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
        // 必须在 rebuildIndexFromDisk 之前：重建时要靠它把丢掉的歌名补回来
        await loadSongMetaManifest();
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

  // 淘汰掉的歌不该继续占着清单和歌词（这里 entries 已反映淘汰后的状态，剪枝是安全的）
  pruneSongMeta();
  void pruneLyricFiles();
};

// ==================== 下载落盘 ====================

const downloadAndCache = async (
  payload: AudioCacheResolvePayload,
  force: boolean = false
): Promise<void> => {
  await ensureLoaded();
  const { enabled } = await getConfig();
  // force 只给 ensureCachedFile 用：那是用户点了「下载」这种明确的一次性动作，
  // 不能因为「播放缓存关了」就拒绝。机会性缓存（queueDownload）仍然尊重这个开关。
  if (!enabled && !force) return;

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
    // 地址轮转会触发重下，那次的 payload 未必带名字 —— 别把已有的名字覆盖成 undefined
    title: payload.title || existing?.title,
    artist: payload.artist || existing?.artist
  };
  await persistEntry(key);
  // 名字落进清单：这是它唯一不依赖 IndexedDB 的落脚点
  mergeSongMetaFromEntry(entries[key]);
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

/** 从落盘路径反推扩展名。filePath 形如 `audio-cache/music/<key><ext>`，末段就是答案。 */
const toEnsureResult = (entry: AudioCacheEntry): AudioCacheEnsureResult => {
  const dot = entry.filePath.lastIndexOf('.');
  const slash = entry.filePath.lastIndexOf('/');
  // 点在目录名里（'a.b/x'）不算扩展名，所以要求点必须在最后一个斜杠之后
  const extension = dot > slash ? entry.filePath.slice(dot) : '.mp3';
  return {
    key: entry.key,
    filePath: entry.filePath,
    size: entry.size,
    extension
  };
};

/**
 * 确保某个 songId+source 的音频**确实躺在磁盘上**，并给出它的位置。
 *
 * 这是「下载到设备」的垫脚石：原生插件要拷一份出去，就得先有个文件可拷。它和
 * resolveMusicUrl 的区别是**会等**——后者命中返回本地地址、未命中就后台入队返回在线地址，
 * 适合播放（不能等），不适合下载（必须等）。
 *
 * 复用它而不是另写一条下载，是因为 downloadAndCache 已经解决了这个平台上所有难的部分：
 * CDN 地址轮转、按文件头魔数嗅探真实扩展名（网易返回的 type 字段经常不准）、
 * .part + rename 的原子写、以及把歌名写进 song-meta.json。重写一份必然腐烂。
 *
 * 三处刻意的语义（见调用方 nativeDownload.ts）：
 *  - force 绕过 enableDiskCache 开关（用户明确点的下载不该被"缓存关了"挡住）；
 *  - 落下的那份**留在缓存里**，于是这首歌立刻离线可播，也会出现在「已缓存」页；
 *  - 所以关掉缓存的用户需要调用方自己收尾删掉它，否则目录会无上限增长。
 */
const ensureCachedFile = async (
  payload: AudioCacheResolvePayload
): Promise<AudioCacheEnsureResult> => {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('ensureCachedFile 只在端上有意义');
  }
  if (!payload?.url || !payload?.songId) {
    throw new Error('缺少下载地址或歌曲 ID');
  }

  const key = buildKey(payload.songId, payload.source);

  // 已经有在飞的下载就先等它，别再下一遍：两条 downloadAndCache 会同时往
  // TMP_DIR 写同一个 key 的 .part 文件，互相踩。
  const inFlight = pending.get(key);
  if (inFlight) await inFlight;

  await ensureLoaded();

  const cached = entries[key];
  // 地址没变且文件还在 → 直接复用，一次网络都不打（重复下载同一首就是这条路径）。
  //
  // 传进来的地址还可能**本身就是缓存标记**：播放命中后 resolveMusicUrl 会把
  // songData.playMusicUrl 写成 `local:///audio-cache/music/...`，而 getSongUrl 在
  // isDownloaded=true 时原样把它返回。那时候 bytes 已经在本地了，但 urlHash 比不过
  // （entry 里存的是当初那个 CDN 地址），不特判就会拿着 local:// 去发网络请求，必失败。
  if (cached && (isCacheUrl(payload.url) || cached.urlHash === hashUrl(payload.url))) {
    const info = await statOrNull(cached.filePath);
    if (info?.size) {
      // 命中时手里正好有完整名字，顺手补上丢过索引的那些（内部会记进清单）
      rememberNames(cached, payload.title, payload.artist);
      return toEnsureResult(cached);
    }
  }

  await downloadAndCache(payload, true);

  const entry = entries[key];
  if (!entry) throw new Error('下载失败：缓存里没有留下记录');
  const info = await statOrNull(entry.filePath);
  if (!info?.size) throw new Error('下载失败：落盘文件为空');
  return toEnsureResult(entry);
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
    const entry = entries[buildKey(payload.songId, payload.source)];
    if (entry) {
      // 命中时手里正好有完整的 name/artist。丢过索引的那些条目名字是空的，顺手补上 ——
      // 否则一个丢了名字的条目永远只能显示 songId，即使它此后天天被播放。
      rememberNames(entry, payload.title, payload.artist);
      // 网易地址会轮转：不拿它卡命中，只在有网时顺手把新地址换下来
      if (entry.urlHash !== hashUrl(payload.url)) {
        queueDownload(payload);
      }
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

  const lyric = await getLyricStats();

  return {
    enabled,
    directory,
    maxSizeMB,
    cleanupPolicy,
    totalSizeBytes,
    musicSizeBytes: totalSizeBytes,
    lyricSizeBytes: lyric.size,
    totalFiles: list.length + lyric.files,
    musicFiles: list.length,
    lyricFiles: lyric.files,
    // usage 只对着音频那份算：容量上限淘汰的是音频，歌词是搭车的
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
  // 映射是给缓存文件贴标签用的：文件都没了，标签就是死重。留着反而会让此后重新缓存的
  // 同一首歌短暂显示旧名字。（清单文件本身随 rmdir(CACHE_ROOT) 一起没了。）
  songMeta = {};
  metaFailedAt = {};
  metaDirty = false;

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

// ==================== 列表与管理 ====================

/**
 * 列出缓存里的每一首歌。
 *
 * **返回的全是拷贝。** `entries` 是 LRU 淘汰赖以计算的那份数据，把活的引用递出去，
 * 调用方改一下 `size` 就能把淘汰算错。
 */
const list = async (options: AudioCacheListOptions = {}): Promise<AudioCacheListEntry[]> => {
  // 桌面端有主进程自己的缓存（cache.ts + IPC），这份端上缓存对它是空概念。
  // 守卫要放在 ensureLoaded() **之前**：进了 ensureLoaded 就会跑 Cap 的 Filesystem/web 实现
  // 在渲染进程里凭空建一套 IndexedDB 存储。
  if (!Capacitor.isNativePlatform()) return [];

  await ensureLoaded();

  if (options.verify) {
    // 逐条 stat 校验。默认关闭：加载时与淘汰时都已剪过枝，每次进页面都 stat 一遍不划算。
    for (const entry of Object.values(entries)) {
      await verifyEntry(entry);
    }
  }

  const rows: AudioCacheListEntry[] = Object.values(entries).map((entry) => {
    const meta = songMeta[String(entry.songId)];
    const metaSource: AudioCacheListEntry['metaSource'] =
      entry.title || entry.artist ? 'entry' : meta?.name ? 'manifest' : 'none';

    return {
      key: entry.key,
      songId: entry.songId,
      source: entry.source,
      filePath: entry.filePath,
      url: toLocalUrl(entry.filePath),
      size: entry.size || 0,
      createdAt: entry.createdAt || 0,
      lastAccessAt: entry.lastAccessAt || 0,
      playCount: entry.playCount || 0,
      title: entry.title || meta?.name,
      artist: entry.artist || meta?.artist,
      picUrl: meta?.picUrl,
      alName: meta?.alName,
      ar: meta?.ar,
      dt: meta?.dt,
      metaSource
    };
  });

  const sort = options.sort ?? 'recent';
  if (sort === 'name') {
    // 必须在合并名字之后再排，否则排的是 undefined
    rows.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  } else if (sort === 'created') {
    rows.sort((a, b) => b.createdAt - a.createdAt);
  } else {
    rows.sort((a, b) => b.lastAccessAt - a.lastAccessAt);
  }

  return rows;
};

/**
 * 删掉一条缓存。
 *
 * 先等在飞的下载结束：downloadAndCache 是后台入队的，不等它就会在删除之后又把文件写回来，
 * 界面上表现为"删了之后一秒又自己冒出来"。
 */
const remove = async (key: string): Promise<boolean> => {
  if (!Capacitor.isNativePlatform()) return false;

  await ensureLoaded();

  const inFlight = pending.get(key);
  if (inFlight) {
    // 它自己已经吞了错，这里只是等它收尾
    await inFlight.catch(() => undefined);
  }

  const entry = entries[key];
  if (!entry) return false;

  await removeFileQuietly(entry.filePath);
  delete entries[key];
  await removeEntryRecord(key);
  // 同一首歌可能以两个 source 各缓存一份，只有最后一份被删掉时才连歌词一起丢
  if (dropSongMetaIfUnreferenced(entry.songId)) await removeCachedLyric(entry.songId);
  return true;
};

/**
 * 同步读清单。
 *
 * 注意：这是个同步读，冷启动时若 `ensureLoaded()` 还没跑完就是空的。先用 `list()` 或
 * `getStats()` 把加载带起来再调它。
 */
const getSongMeta = (songId: number): SongMeta | undefined => {
  if (!Capacitor.isNativePlatform()) return undefined;
  return songMeta[String(songId)];
};

/**
 * 批量写入回填结果。
 *
 * `/song/detail` 拿到的视为权威（`src: 'api'`），但不允许更旧的结果覆盖更新的。
 */
const updateSongMeta = async (metas: Record<number, SongMeta>): Promise<void> => {
  if (!Capacitor.isNativePlatform()) return;

  await ensureLoaded();

  let touched = false;
  for (const [id, meta] of Object.entries(metas)) {
    if (!meta) continue;
    const existing = songMeta[id];
    if (existing?.src === 'api' && (existing.updatedAt || 0) > (meta.updatedAt || 0)) continue;
    songMeta[id] = { ...existing, ...meta };
    touched = true;
  }
  if (touched) markMetaDirty();
};

/** 记下回填失败的 songId，用于退避 —— 否则每次进页面都会去问一批已经下架的 id */
const markMetaBackfillFailed = async (songIds: number[]): Promise<void> => {
  if (!songIds.length || !Capacitor.isNativePlatform()) return;
  await ensureLoaded();
  const now = Date.now();
  for (const id of songIds) metaFailedAt[String(id)] = now;
  markMetaDirty();
};

/** 某个 songId 是否还在回填的退避窗口里 */
const isMetaBackfillCoolingDown = (songId: number, windowMs: number): boolean => {
  const at = metaFailedAt[String(songId)];
  return !!at && Date.now() - at < windowMs;
};

export const audioDiskCache = {
  getOfflinePlaybackUrl,
  resolveMusicUrl,
  ensureCachedFile,
  getStats,
  clear,
  onConfigChanged,
  isCacheUrl,
  isCacheUrlAlive,
  list,
  remove,
  readCachedLyric,
  saveCachedLyric,
  removeCachedLyric,
  getSongMeta,
  updateSongMeta,
  markMetaBackfillFailed,
  isMetaBackfillCoolingDown
};
