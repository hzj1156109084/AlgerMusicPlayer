<template>
  <div class="cached-songs-panel flex flex-col h-full min-h-0">
    <!-- 操作条：只在有内容时出现，空态下"播放全部/清空"没有意义 -->
    <div
      v-if="rows.length"
      class="flex items-center gap-3 px-4 py-3 flex-shrink-0 border-b border-neutral-100 dark:border-neutral-800/50"
    >
      <button
        class="h-9 px-4 rounded-full bg-primary text-white text-sm font-medium flex items-center gap-1.5 active:scale-95 transition-transform flex-shrink-0"
        @click="handlePlayAll"
      >
        <i class="ri-play-fill text-base" />
        {{ t('cached.playAll') }}
      </button>

      <span class="text-xs text-neutral-500 dark:text-neutral-400 truncate">
        {{ t('cached.songCount', { count: rows.length }) }} ·
        {{ t('cached.totalSize', { size: formatFileSize(totalSize) }) }}
      </span>

      <button
        class="ml-auto h-8 px-3 rounded-full text-xs font-medium flex items-center gap-1.5 text-red-500 bg-red-500/10 active:scale-95 transition-transform flex-shrink-0"
        @click="handleClearAll"
      >
        <i class="ri-delete-bin-2-line" />
        {{ t('cached.clearAll') }}
      </button>
    </div>

    <!-- 列表。n-scrollbar 必须拿到确定高度，否则它按内容撑开、父层的 min-h-0 拦不住溢出 -->
    <div class="flex-1 min-h-0">
      <n-scrollbar class="h-full">
        <div v-if="loading && !rows.length" class="flex justify-center py-20">
          <n-spin size="small" />
        </div>

        <empty-state
          v-else-if="!rows.length"
          icon="ri-download-cloud-2-line"
          :text="t('cached.emptyState')"
        />

        <div v-else class="space-y-2 px-3 py-3 pb-32">
          <div
            v-for="row in rows"
            :key="row.key"
            class="flex items-center gap-3 p-2.5 rounded-2xl transition-colors"
            :class="
              isCurrent(row)
                ? 'bg-primary/10'
                : 'hover:bg-neutral-100 dark:hover:bg-neutral-900 active:bg-neutral-100 dark:active:bg-neutral-900'
            "
          >
            <!-- 封面。缓存里没有封面时不指 /images/default_cover.png —— 那个路径在本仓并不存在，
                 会渲染成一个破图；直接给一个图标底更干净。 -->
            <div
              class="relative w-12 h-12 rounded-xl overflow-hidden shadow-sm flex-shrink-0 bg-primary/10 flex items-center justify-center"
            >
              <i v-if="showPlaceholder(row)" class="ri-music-2-line text-xl text-primary/60" />
              <img
                v-else
                :src="getImgUrl(row.picUrl, '100y100')"
                class="w-full h-full object-cover"
                @error="markCoverFailed(row.key)"
              />
              <i
                v-if="isCurrent(row)"
                class="absolute inset-0 flex items-center justify-center text-white text-xl bg-black/40 ri-volume-up-line"
              />
            </div>

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-bold text-neutral-900 dark:text-white truncate">
                  {{ rowName(row) }}
                </span>
                <span class="text-xs text-neutral-400 flex-shrink-0">
                  {{ formatFileSize(row.size) }}
                </span>
              </div>
              <div class="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5">
                {{ row.artist || t('cached.unknownArtist') }}
              </div>
            </div>

            <!-- 常显，不抄移动端历史页那个 hover-opacity-0 的写法：触屏上没有 hover，
                 那样写等于按钮不存在。 -->
            <div class="flex items-center gap-1 flex-shrink-0">
              <button
                class="w-9 h-9 rounded-full flex items-center justify-center text-neutral-400 active:text-primary active:bg-primary/10 transition-colors"
                @click="handlePlay(row)"
              >
                <i class="ri-play-circle-line text-xl" />
              </button>
              <button
                class="w-9 h-9 rounded-full flex items-center justify-center text-neutral-400 active:text-red-500 active:bg-red-500/10 transition-colors"
                @click="handleDelete(row)"
              >
                <i class="ri-delete-bin-line text-lg" />
              </button>
            </div>
          </div>
        </div>
      </n-scrollbar>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDialog, useMessage } from 'naive-ui';
import { computed, onActivated, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import EmptyState from '@/components/common/EmptyState.vue';
import { type AudioCacheListEntry, audioDiskCache } from '@/services/audioDiskCache';
import { backfillSongMeta } from '@/services/songMetaBackfill';
import { usePlayerStore } from '@/store/modules/player';
import { formatFileSize, getImgUrl } from '@/utils';
import { cacheEntryToSongResult } from '@/utils/localMusicUtils';

const { t } = useI18n();
const dialog = useDialog();
const message = useMessage();
const playerStore = usePlayerStore();

/** 列表内容变了（重拉 / 删除 / 清空）。外层页面靠它同步自己的统计数字。 */
const emit = defineEmits<{ changed: [] }>();

const rows = ref<AudioCacheListEntry[]>([]);
const loading = ref(false);
/** 封面加载失败的 key。getImgUrl 出来的地址 404 时退化成图标底，不留破图。 */
const failedCovers = ref<Set<string>>(new Set());

const totalSize = computed(() => rows.value.reduce((sum, row) => sum + (row.size || 0), 0));

const rowName = (row: AudioCacheListEntry): string =>
  row.title || t('cached.unknownSong', { id: row.songId });

const showPlaceholder = (row: AudioCacheListEntry): boolean =>
  !row.picUrl || failedCovers.value.has(row.key);

const markCoverFailed = (key: string) => {
  const next = new Set(failedCovers.value);
  next.add(key);
  failedCovers.value = next;
};

/** 正在播的就是这一行吗 —— 缓存行的 songId/source 与播放列表里的条目是同一套值 */
const isCurrent = (row: AudioCacheListEntry): boolean => {
  const playing = playerStore.playMusic;
  return !!playing && playing.id === row.songId && playing.source === row.source;
};

const toSong = (row: AudioCacheListEntry) =>
  cacheEntryToSongResult(row, t('cached.unknownSong', { id: row.songId }));

const loadList = async (): Promise<void> => {
  loading.value = true;
  try {
    // 整体替换，不做合并：淘汰（enforceLimit）和后台下载都可能让快照变陈
    rows.value = await audioDiskCache.list({ sort: 'recent' });
    emit('changed');
  } catch (error) {
    console.warn('[CachedSongsPanel] 读取缓存列表失败:', error);
    rows.value = [];
    emit('changed');
  } finally {
    loading.value = false;
  }
};

/**
 * 拉列表 + 触发回填。
 *
 * 回填完成后**再拉一次**列表，把补齐的封面/歌名显示出来。不会绕圈：补上的记录带 picUrl，
 * 第二次调用 `backfillSongMeta` 找不到待补的 id 会立刻返回。
 */
const refresh = async (): Promise<void> => {
  await loadList();
  if (!rows.value.length) return;
  void backfillSongMeta(rows.value)
    .then(() => loadList())
    .catch(() => undefined);
};

const handlePlay = async (row: AudioCacheListEntry) => {
  const list = rows.value.map(toSong);
  // 先把整个缓存列表装进播放器，再播这一行：这样"下一首"在离线状态下滑到的
  // 都是本地文件，而不是一堆需要联网重新解析的歌。setPlay 会按 id+source 把索引对齐到该行。
  playerStore.setPlayList(list);
  await playerStore.setPlay(list[rows.value.findIndex((item) => item.key === row.key)]);
};

const handlePlayAll = async () => {
  const list = rows.value.map(toSong);
  if (!list.length) return;
  // setPlayList 只装载不发声（playlist.ts：它只赋值 playList/playListIndex），
  // 所以必须再 setPlay 第一首，否则"播放全部"点了没有任何声音。
  playerStore.setPlayList(list);
  await playerStore.setPlay(list[0]);
};

const handleDelete = (row: AudioCacheListEntry) => {
  dialog.warning({
    title: t('cached.deleteTitle'),
    content: t('cached.deleteContent', {
      name: rowName(row),
      size: formatFileSize(row.size)
    }),
    positiveText: t('cached.deleteConfirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        const ok = await audioDiskCache.remove(row.key);
        if (ok) {
          rows.value = rows.value.filter((item) => item.key !== row.key);
          emit('changed');
          message.success(t('cached.deleteSuccess'));
        } else {
          // 没删掉说明这条已经不在了（多半是被淘汰了），纠正快照即可
          await loadList();
        }
      } catch (error) {
        console.error('[CachedSongsPanel] 删除缓存失败:', error);
        message.error(t('settings.system.messages.diskCacheClearFailed'));
      }
    }
  });
};

const handleClearAll = async () => {
  const stats = await audioDiskCache.getStats();
  if (!stats.totalFiles) {
    message.info(t('settings.system.clearSongCacheEmpty'));
    return;
  }

  // 复用设置页那套确认文案与格式，别在这里再写一份
  dialog.warning({
    title: t('settings.system.clearSongCacheTitle'),
    content: t('settings.system.clearSongCacheContent', {
      count: stats.musicFiles,
      size: formatFileSize(stats.totalSizeBytes)
    }),
    positiveText: t('settings.system.clearSongCacheConfirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        const { removedCount, freedBytes } = await audioDiskCache.clear('music');
        rows.value = [];
        emit('changed');
        message.success(
          t('settings.system.clearSongCacheSuccess', {
            count: removedCount,
            size: formatFileSize(freedBytes)
          })
        );
      } catch (error) {
        console.error('[CachedSongsPanel] 清空缓存失败:', error);
        message.error(t('settings.system.messages.diskCacheClearFailed'));
      }
    }
  });
};

/**
 * 回到前台时重拉：页面在后台时 enforceLimit() 可能已经淘汰掉几行，
 * 快照不刷新的话那些行点下去会播放失败。
 */
const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') void refresh();
};

onMounted(() => {
  void refresh();
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

// 路由 keepAlive 或历史页 v-if/v-else 切回来时重新拉
onActivated(() => {
  void refresh();
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>
