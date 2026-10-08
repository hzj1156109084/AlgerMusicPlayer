import { musicDB } from '@/hooks/MusicHook';
import { useSettingsStore, useUserStore } from '@/store';
import type { ILyric } from '@/types/lyric';
import type { SongResult } from '@/types/music';
import request from '@/utils/request';

import { MusicParser, type MusicParseResult } from './musicParser';

const { getData, saveData } = musicDB;

// 将 FM 歌曲移至垃圾桶（不喜欢）
export const fmTrash = (id: number) => {
  return request.post('/fm_trash', null, {
    params: { id, timestamp: Date.now() }
  });
};

// 获取音乐音质详情
export const getMusicQualityDetail = (id: number) => {
  return request.get('/song/music/detail', { params: { id } });
};

// 根据音乐Id获取音乐播放URl
export const getMusicUrl = async (id: number, isDownloaded: boolean = false) => {
  // 拼接 cookie 时必须补分隔符：用户粘贴的 token 不一定以 ';' 结尾，
  // 直接 `${token} os=pc;` 会让 os=pc 粘到最后一个字段的值上。
  // 若 token 只含 MUSIC_U 一个字段，被污染的就正好是 MUSIC_U 本身。
  const token = localStorage.getItem('token') || '';
  const tokenWithSep = token && !token.trimEnd().endsWith(';') ? `${token.trimEnd()};` : token;
  const userStore = useUserStore();
  const settingStore = useSettingsStore();
  // 判断是否登录
  try {
    if (userStore.user && isDownloaded && userStore.user.vipType !== 0) {
      const url = '/song/download/url/v1';
      const res = await request.get(url, {
        params: {
          id,
          level: settingStore.setData.musicQuality || 'higher',
          encodeType: settingStore.setData.musicQuality == 'lossless' ? 'aac' : 'flac',
          cookie: `${tokenWithSep} os=pc;`
        }
      });

      if (res.data.data.url) {
        return { data: { data: [{ ...res.data.data }] } };
      }
    }
  } catch (error) {
    console.error('error', error);
  }

  return await request.get('/song/url/v1', {
    params: {
      id,
      level: settingStore.setData.musicQuality || 'higher',
      encodeType: settingStore.setData.musicQuality == 'lossless' ? 'aac' : 'flac'
    }
  });
};

// 获取歌曲详情
export const getMusicDetail = (ids: Array<number>) => {
  return request.get('/song/detail', { params: { ids: ids.join(',') } });
};

// 根据音乐Id获取音乐歌词
export const getMusicLrc = async (id: number) => {
  const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000; // 10天的毫秒数

  try {
    // 尝试获取缓存的歌词
    const cachedLyric = await getData('music_lyric', id);
    if (cachedLyric?.createTime && Date.now() - cachedLyric.createTime < TEN_DAYS_MS) {
      return { ...cachedLyric };
    }

    // 获取新的歌词数据
    const res = await request.get<ILyric>('/lyric/new', { params: { id } });

    if (res?.data) {
      // put 而不是 add。原先这里是「先 delete 再 add」，而 add 撞已存在的键会抛
      // ConstraintError —— 同一首歌连发两次播放请求时（真机日志里确实出现过），
      // 两个调用都会走到这里，后一个必然失败。更糟的是这行原来没有 await，
      // 失败会变成 unhandled rejection：歌词就此静默丢掉，没有任何界面提示。
      // put 是幂等的，前后顺序不再重要；await 保证失败至少被这里记一笔。
      try {
        await saveData('music_lyric', { id, data: res.data, createTime: Date.now() });
      } catch (error) {
        console.warn('缓存歌词到 IndexedDB 失败:', error);
      }
    }

    return res;
  } catch (error) {
    console.error('获取歌词失败:', error);
    throw error; // 向上抛出错误，让调用者处理
  }
};

/**
 * 获取解析后的音乐URL
 * @param id 歌曲ID
 * @param data 歌曲数据
 * @returns 解析结果
 */
export const getParsingMusicUrl = async (
  id: number,
  data: SongResult
): Promise<MusicParseResult> => {
  return await MusicParser.parseMusic(id, data);
};

// 收藏歌曲
export const likeSong = (id: number, like: boolean = true) => {
  return request.get('/like', { params: { id, like } });
};

// 将每日推荐中的歌曲标记为不感兴趣，并获取一首新歌
export const dislikeRecommendedSong = (id: number | string) => {
  return request.get('/recommend/songs/dislike', {
    params: { id }
  });
};
// 获取用户喜欢的音乐列表
export const getLikedList = (uid: number) => {
  return request.get('/likelist', {
    params: { uid, noLogin: true }
  });
};

// 创建歌单
export const createPlaylist = (params: { name: string; privacy: number }) => {
  return request.post('/playlist/create', params);
};

// 添加或删除歌单歌曲
export const updatePlaylistTracks = (params: {
  op: 'add' | 'del';
  pid: number;
  tracks: string;
}) => {
  return request.post('/playlist/tracks', params);
};

/**
 * 根据类型获取列表数据
 * @param type 列表类型 album/playlist
 * @param id 列表ID
 */
export function getMusicListByType(type: string, id: string) {
  if (type === 'album') {
    return getAlbumDetail(id);
  } else if (type === 'playlist') {
    return getPlaylistDetail(id);
  }
  return Promise.reject(new Error('未知列表类型'));
}

/**
 * 获取专辑详情
 * @param id 专辑ID
 */
export function getAlbumDetail(id: string) {
  return request({
    url: '/album',
    method: 'get',
    params: {
      id
    }
  });
}

/**
 * 获取歌单详情
 * @param id 歌单ID
 */
export function getPlaylistDetail(id: string) {
  return request({
    url: '/playlist/detail',
    method: 'get',
    params: {
      id
    }
  });
}

export function subscribePlaylist(params: { t: number; id: number }) {
  return request({
    url: '/playlist/subscribe',
    method: 'post',
    params
  });
}

/**
 * 收藏/取消收藏专辑
 * @param params t: 1 收藏, 2 取消收藏; id: 专辑id
 */
export function subscribeAlbum(params: { t: number; id: number }) {
  return request({
    url: '/album/sub',
    method: 'post',
    params
  });
}

/**
 * 获取历史日推可用日期列表
 */
export function getHistoryRecommendDates() {
  return request({
    url: '/history/recommend/songs',
    method: 'get'
  });
}

/**
 * 获取历史日推详情数据
 * @param date 日期，格式：YYYY-MM-DD
 */
export function getHistoryRecommendSongs(date: string) {
  return request({
    url: '/history/recommend/songs/detail',
    method: 'get',
    params: { date }
  });
}

/**
 * 心动模式/智能播放
 * @param params id: 歌曲id, pid: 歌单id, sid: 要开始播放的歌曲id(可选)
 */
export function getIntelligenceList(params: { id: number; pid: number; sid?: number }) {
  return request({
    url: '/playmode/intelligence/list',
    method: 'get',
    params
  });
}
