import { computed } from 'vue';

import { useSettingsStore } from '@/store';
import type { Platform } from '@/types/music';
import { isElectron } from '@/utils';

/**
 * 只依赖 Electron IPC 的音源。
 * 这四个走 `musicParser.ts` 的 `getUnblockMusicAudio` → `window.api.unblockMusic`，
 * 而那个 IPC 背后是主进程的 Node 包 `@unblockneteasemusic/server`（依赖 fs/http/crypto
 * 等内置模块），不是能直接搬进渲染进程的东西，所以移动端/Web 上标记为不可用。
 *
 * 注意 **lxMusic 不在这张表里** —— `LxMusicSourceRunner.handleHttpRequest` 自带
 * `fetch` 回退分支，端上是能跑的。见该文件 `hasMainProcessHttp` 那段。
 */
const ELECTRON_ONLY_SOURCES: Platform[] = ['migu', 'kugou', 'kuwo', 'pyncmd'];

// ==================== 类型定义 ====================

export type MusicSourceGroup = 'unblock' | 'extended' | 'plugin';

export type MusicSourceMeta = {
  key: Platform;
  icon: string;
  color: string;
  group: MusicSourceGroup;
};

export type MusicSourceInfo = MusicSourceMeta & {
  available: boolean;
  configHint?: string;
};

// ==================== 静态注册表 ====================

export const MUSIC_SOURCE_REGISTRY: MusicSourceMeta[] = [
  // 内置解锁音源 (UnblockMusicStrategy)
  { key: 'migu', icon: 'ri-music-2-fill', color: '#ff6600', group: 'unblock' },
  { key: 'kugou', icon: 'ri-music-fill', color: '#2979ff', group: 'unblock' },
  { key: 'kuwo', icon: 'ri-music-fill', color: '#ff8c00', group: 'unblock' },
  { key: 'pyncmd', icon: 'ri-netease-cloud-music-fill', color: '#ec4141', group: 'unblock' },
  // 扩展音源 (GDMusicStrategy)
  { key: 'gdmusic', icon: 'ri-google-fill', color: '#4285f4', group: 'extended' },
  // 插件音源 (需要用户配置)
  { key: 'lxMusic', icon: 'ri-leaf-fill', color: '#22c55e', group: 'plugin' },
  { key: 'custom', icon: 'ri-plug-fill', color: '#8b5cf6', group: 'plugin' }
];

// ==================== Composable ====================

export const useMusicSources = () => {
  const settingsStore = useSettingsStore();

  const allSources = computed<MusicSourceInfo[]>(() => {
    return MUSIC_SOURCE_REGISTRY.map((source) => {
      let available = true;
      let configHint: string | undefined;

      if (source.key === 'lxMusic') {
        available =
          (settingsStore.setData.lxMusicScripts?.length ?? 0) > 0 &&
          Boolean(settingsStore.setData.activeLxMusicApiId);
        if (!available) configHint = 'settings.playback.lxMusic.scripts.notConfigured';
      } else if (source.key === 'custom') {
        available = Boolean(settingsStore.setData.customApiPlugin);
        if (!available) configHint = 'settings.playback.customApi.notImported';
      }

      // 已经配置好但端上跑不了的音源（如移动端选中的 lxMusic），改为提示"依赖桌面端"
      if (!isElectron && ELECTRON_ONLY_SOURCES.includes(source.key)) {
        available = false;
        configHint = 'settings.playback.desktopOnlySource';
      }

      return { ...source, available, configHint };
    });
  });

  return { allSources };
};
