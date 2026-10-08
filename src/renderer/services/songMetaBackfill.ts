import { Capacitor } from '@capacitor/core';

import { getMusicDetail } from '@/api/music';
import { type AudioCacheListEntry, audioDiskCache, type SongMeta } from '@/services/audioDiskCache';

/**
 * 给缓存里的歌批量补全元数据（歌名/歌手/封面/时长）。
 *
 * 为什么需要它：缓存落盘时手上只有播放 payload，能记下歌名歌手却**拿不到封面**；而索引
 * 丢失后按文件名重建的那些条目，连歌名都没有。这两类都只能回头问服务端。
 *
 * 三条自我约束，都是为了避免把"打开一个页面"变成"打一堆 API"：
 *
 * 1. **5 分钟下限**：反复进出页面（尤其移动端侧边菜单切来切去）不会重复请求。
 * 2. **失败退避 6 小时**：已下架/版权受限的 songId 是永远问不出来的，不能每次都试。
 * 3. **并发去重**：历史页和缓存页可能同时激活，共用同一个在飞请求。
 *
 * 刻意**不**放在 audioDiskCache 里：那边导入 api/music 会绕出
 * audioDiskCache → api/music → MusicHook → audioService 的环。
 *
 * 也刻意不由 audioDiskCache.ensureLoaded() 触发：启动路径永远不许发网络请求，
 * 那是"断网冷启动还能放歌"的地基。
 */

/** 同一批 id 失败后的退避窗口 */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** 两次回填之间的最小间隔 */
const MIN_INTERVAL_MS = 5 * 60 * 1000;
/** 单次回填的 id 上限，避免首次打开时一口气问几百首 */
const MAX_IDS_PER_RUN = 300;
/** `/song/detail` 单次请求的 id 数 */
const CHUNK_SIZE = 100;

let inFlight: Promise<void> | null = null;
let lastRunAt = 0;

/**
 * 这条记录还值不值得问。
 *
 * 判据用**封面**而不是名字：名字和歌手在缓存落盘时就一起记下了，光有名字不算"补全"。
 * 封面对这份清单来说是只有 API 能给的东西，所以它才是"已经补过"的可靠标记。
 */
const isPending = (songId: number): boolean => {
  if (audioDiskCache.isMetaBackfillCoolingDown(songId, RETRY_AFTER_MS)) return false;
  return !audioDiskCache.getSongMeta(songId)?.picUrl;
};

/** 把 /song/detail 的一条结果折成清单记录 */
const toSongMeta = (song: any): SongMeta => {
  const artists: any[] = song.ar || song.artists || [];
  return {
    name: song.name,
    // 与 usePlayerHooks 的 getSongArtistText() 保持同一个拼接写法
    artist: artists.map((artist) => artist.name).join(' / '),
    ar: artists.map((artist) => ({ id: artist.id, name: artist.name })),
    alName: song.al?.name || song.album?.name,
    picUrl: song.al?.picUrl || song.album?.picUrl,
    dt: song.dt || song.duration,
    updatedAt: Date.now(),
    src: 'api'
  };
};

const run = async (ids: number[]): Promise<void> => {
  const batch = ids.slice(0, MAX_IDS_PER_RUN);

  for (let offset = 0; offset < batch.length; offset += CHUNK_SIZE) {
    const chunk = batch.slice(offset, offset + CHUNK_SIZE);
    try {
      const res = await getMusicDetail(chunk);
      const songs: any[] = (res as any)?.data?.songs || [];

      const metas: Record<number, SongMeta> = {};
      for (const song of songs) {
        if (song?.id) metas[song.id] = toSongMeta(song);
      }
      if (Object.keys(metas).length) {
        await audioDiskCache.updateSongMeta(metas);
      }

      // 接口答了但没带这几首（下架/版权/地区限制）—— 记一笔，退避窗口内不再问
      const missing = chunk.filter((id) => !metas[id]);
      if (missing.length) {
        await audioDiskCache.markMetaBackfillFailed(missing);
      }
    } catch (error) {
      // 整批失败（断网、接口异常）：**不记退避**，下次进页面还该有机会重试。
      // 页面对此无感 —— 它已经用降级文案渲染完了，补上名字只是事后刷新一次。
      console.warn('[songMetaBackfill] 批量获取歌曲详情失败:', error);
    }
  }
};

/**
 * 批量补全。调用方不必 await，也不必处理错误 —— 失败时页面照常显示降级文案。
 *
 * @param entries audioDiskCache.list() 返回的行（只需要 songId）
 */
export const backfillSongMeta = async (
  entries: Pick<AudioCacheListEntry, 'songId'>[]
): Promise<void> => {
  // 桌面端没有这份缓存（getSongMeta 恒为 undefined，会把每个 id 都判成"待补"），
  // 直接挡在这里，别指望调用方一定守卫过。
  if (!Capacitor.isNativePlatform()) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  // 依赖 list() 已经 await 过 ensureLoaded —— getSongMeta 是同步读的
  const ids = Array.from(new Set(entries.map((entry) => entry.songId))).filter(isPending);
  if (!ids.length) return;

  // 同时进来的第二个调用者（历史页 + 缓存页）共用同一个在飞请求
  if (inFlight) return inFlight;
  if (Date.now() - lastRunAt < MIN_INTERVAL_MS) return;

  lastRunAt = Date.now();
  inFlight = run(ids).finally(() => {
    inFlight = null;
  });
  return inFlight;
};
