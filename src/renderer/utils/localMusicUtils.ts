// 本地音乐工具函数
// 提供格式过滤、元数据 fallback、类型转换、搜索过滤、增量扫描等功能

// 只取类型：import type 会被完全擦除，运行时不会把 Capacitor 依赖拖进这个纯工具模块
import type { AudioCacheListEntry } from '@/services/audioDiskCache';
import type { LocalMusicEntry, LocalMusicMeta } from '@/types/localMusic';
import { SUPPORTED_AUDIO_FORMATS } from '@/types/localMusic';
import type { ILyric, ILyricText, IWordData, SongResult } from '@/types/music';
import { parseLyrics as parseYrcLyrics } from '@/utils/yrcParser';

/**
 * 判断文件路径是否为支持的音频格式
 * 通过提取文件扩展名（不区分大小写）与支持格式列表比对
 * @param filePath 文件路径
 * @returns 是否为支持的音频格式
 */
export function isSupportedAudioFormat(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return (SUPPORTED_AUDIO_FORMATS as readonly string[]).includes(ext);
}

/**
 * 从文件路径中提取歌曲标题（去除目录和扩展名）
 * @param filePath 文件路径
 * @returns 歌曲标题
 */
export function extractTitleFromFilename(filePath: string): string {
  // 兼容 Windows 和 Unix 路径分隔符
  const separator = filePath.includes('\\') ? '\\' : '/';
  const filename = filePath.split(separator).pop() || filePath;
  // 去除扩展名
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex > 0) {
    return filename.slice(0, dotIndex);
  }
  return filename;
}

/**
 * 构建缺失元数据时的 fallback 元数据对象
 * 使用文件名作为标题，"未知艺术家"和"未知专辑"作为默认值
 * @param filePath 文件路径
 * @returns 默认的 LocalMusicMeta 对象
 */
export function buildFallbackMeta(filePath: string): LocalMusicMeta {
  return {
    filePath,
    title: extractTitleFromFilename(filePath),
    artist: '未知艺术家',
    album: '未知专辑',
    duration: 0,
    cover: null,
    lyrics: null,
    fileSize: 0,
    modifiedTime: 0
  };
}

/**
 * 将 LRC 格式歌词字符串解析为 ILyric 对象
 * 复用 yrcParser 解析能力，兼容标准 LRC 和 YRC 格式
 * @param lrcString LRC 格式歌词文本
 * @returns ILyric 对象，解析失败返回 null
 */
export function parseLrcToILyric(lrcString: string | null): ILyric | null {
  if (!lrcString || typeof lrcString !== 'string') {
    return null;
  }

  try {
    const parseResult = parseYrcLyrics(lrcString);
    if (!parseResult.success) {
      return null;
    }

    const { lyrics: parsedLyrics } = parseResult.data;
    const lrcArray: ILyricText[] = [];
    const lrcTimeArray: number[] = [];
    let hasWordByWord = false;

    for (const line of parsedLyrics) {
      const hasWords = line.words && line.words.length > 0;
      if (hasWords) hasWordByWord = true;

      lrcArray.push({
        text: line.fullText,
        trText: '',
        words: hasWords ? (line.words as IWordData[]) : undefined,
        hasWordByWord: hasWords,
        startTime: line.startTime,
        duration: line.duration
      });

      lrcTimeArray.push(line.startTime / 1000);
    }

    if (lrcArray.length === 0) {
      return null;
    }

    return { lrcTimeArray, lrcArray, hasWordByWord };
  } catch {
    return null;
  }
}

/**
 * 造一个字段齐全的 Artist。
 *
 * 播放链路其实只用得到 id/name/picUrl，但 SongResult.ar 的类型要求整份结构，所以把这段
 * 样板抽出来给「本地音乐」和「已缓存」两条转换路径共用 —— 它们的需求完全一样。
 */
const createSongArtist = (name: string, id = 0, picUrl = '') => ({
  name,
  id,
  picId: 0,
  img1v1Id: 0,
  briefDesc: '',
  picUrl,
  img1v1Url: '',
  albumSize: 0,
  alias: [],
  trans: '',
  musicSize: 0,
  topicPerson: 0
});

/** 同上，为了 al: Album 那份长字面量。Album 类型没有 export，所以这里不标注返回类型。 */
const createSongAlbum = (name: string, picUrl: string, artistName: string) => ({
  name,
  id: 0,
  type: '',
  size: 0,
  picId: 0,
  blurPicUrl: '',
  companyId: 0,
  pic: 0,
  picUrl,
  publishTime: 0,
  description: '',
  tags: '',
  company: '',
  briefDesc: '',
  artist: createSongArtist(artistName),
  songs: [],
  alias: [],
  status: 0,
  copyrightId: 0,
  commentThreadId: '',
  artists: [],
  subType: '',
  transName: null,
  onSale: false,
  mark: 0,
  picId_str: ''
});

/**
 * 将 LocalMusicEntry 转换为 SongResult，以复用现有播放系统
 * @param entry 本地音乐条目
 * @returns 兼容播放系统的 SongResult 对象
 */
export function toSongResult(entry: LocalMusicEntry): SongResult {
  // 解析内嵌歌词为 ILyric 对象
  const lyric = parseLrcToILyric(entry.lyrics);

  return {
    id: entry.id,
    name: entry.title,
    picUrl: entry.cover || '/images/default_cover.png',
    ar: [createSongArtist(entry.artist)],
    al: createSongAlbum(entry.album, entry.cover || '', entry.artist),
    song: {
      artists: [{ name: entry.artist }],
      album: { name: entry.album }
    },
    playMusicUrl: `local:///${entry.filePath}`,
    duration: entry.duration,
    dt: entry.duration,
    source: 'netease' as const,
    count: 0,
    // 内嵌歌词（如果有）
    lyric: lyric ?? undefined,
    // 本地音乐 URL 不会过期，设置一个极大的过期时间
    createdAt: Date.now(),
    expiredAt: Date.now() + 365 * 24 * 60 * 60 * 1000
  };
}

/**
 * 将「已缓存」列表的一行转换为 SongResult，以复用现有播放系统。
 *
 * 与 toSongResult 的三处关键差异：
 *
 * 1. **`source` 保留条目自己的音源，不硬编码 `'netease'`。** 歌单持久化时会丢掉
 *    playMusicUrl（见 store/modules/playlist.ts 的 minifySong），重启后靠
 *    `getOfflinePlaybackUrl(songId, source)` 重新命中，而那个索引正是 `songId_source`。
 *    写死 source 会让重启后的播放找不到这份缓存。
 * 2. **`playMusicUrl` 必须是内部标记 `local:///...`**，不能是 `_capacitor_file_` 地址 ——
 *    播放链路里所有「本地文件不过期、出错不清空」的豁免都认这个前缀，理由见
 *    utils/playableUrl.ts 的注释。
 * 3. **名字可能缺失。** 条目可能是索引丢失后按文件名重建出来的，那时只有 songId；
 *    传 fallbackName 让调用方决定怎么显示（列表页会异步回填真名字）。
 *
 * @param entry audioDiskCache.list() 返回的一行
 * @param fallbackName 没有歌名时的降级显示文案
 */
export function cacheEntryToSongResult(
  entry: AudioCacheListEntry,
  fallbackName?: string
): SongResult {
  const artistName = entry.artist || '';
  const picUrl = entry.picUrl || '';
  // 有真实歌手列表（回填来的）就用它，让歌手信息尽量完整；否则退回展示串
  const artists = entry.ar?.length
    ? entry.ar.map((item) => createSongArtist(item.name, item.id))
    : [createSongArtist(artistName)];

  return {
    id: entry.songId,
    name: entry.title || fallbackName || `#${entry.songId}`,
    picUrl: picUrl || '/images/default_cover.png',
    ar: artists,
    al: createSongAlbum(entry.alName || '', picUrl, artistName),
    song: {
      artists: artists.map((item) => ({ name: item.name })),
      album: { name: entry.alName || '' }
    },
    // 内部标记，交给 playableUrl.ts 翻成 WebView 能加载的地址
    playMusicUrl: entry.url,
    duration: entry.dt || 0,
    dt: entry.dt || 0,
    // SongResult.source 的类型被收窄成了字面量 'netease'，但运行时它承载着各种音源
    // （history 页就在判 'bilibili'）。这里保留真实值。
    source: (entry.source || 'netease') as SongResult['source'],
    count: 0,
    createdAt: Date.now(),
    // 缓存是本地文件，不会过期；与本地音乐同样给一个极大的过期时间
    expiredAt: Date.now() + 365 * 24 * 60 * 60 * 1000
  };
}

/**
 * 将封面图片 Buffer 转换为 base64 Data URL
 * @param buffer 图片二进制数据
 * @param mime MIME 类型（如 image/jpeg、image/png）
 * @returns base64 Data URL 字符串
 */
export function coverToDataUrl(buffer: Buffer, mime: string): string {
  const base64 = buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
}

/**
 * 按关键词搜索过滤本地音乐列表
 * 不区分大小写，匹配歌曲标题或艺术家名称
 * 空关键词返回完整列表
 * @param list 本地音乐列表
 * @param keyword 搜索关键词
 * @returns 过滤后的音乐列表
 */
export function filterByKeyword(list: LocalMusicEntry[], keyword: string): LocalMusicEntry[] {
  if (!keyword || keyword.trim() === '') {
    return list;
  }
  const lowerKeyword = keyword.toLowerCase();
  return list.filter((entry) => {
    return (
      entry.title.toLowerCase().includes(lowerKeyword) ||
      entry.artist.toLowerCase().includes(lowerKeyword)
    );
  });
}

/**
 * 增量扫描对比：找出新增或修改时间变更的文件
 * 对比扫描到的文件列表与缓存条目，返回需要重新解析的文件路径
 * @param files 扫描到的文件列表（包含路径和修改时间）
 * @param cached 已缓存的本地音乐条目
 * @returns 需要重新解析的文件路径列表
 */
export function getChangedFiles(
  files: { path: string; modifiedTime: number }[],
  cached: LocalMusicEntry[]
): string[] {
  // 构建缓存映射：filePath -> modifiedTime
  const cachedMap = new Map<string, number>();
  for (const entry of cached) {
    cachedMap.set(entry.filePath, entry.modifiedTime);
  }

  return files
    .filter((file) => {
      const cachedTime = cachedMap.get(file.path);
      // 缓存中不存在（新文件）或修改时间不匹配（已变更）
      return cachedTime === undefined || cachedTime !== file.modifiedTime;
    })
    .map((file) => file.path);
}

/**
 * 缓存清理：移除文件已不存在的条目
 * @param entries 缓存的本地音乐条目列表
 * @param existsMap 文件存在性映射（filePath -> 是否存在）
 * @returns 清理后的条目列表（仅保留文件仍存在的条目）
 */
export function removeStaleEntries(
  entries: LocalMusicEntry[],
  existsMap: Record<string, boolean>
): LocalMusicEntry[] {
  return entries.filter((entry) => existsMap[entry.filePath] === true);
}
