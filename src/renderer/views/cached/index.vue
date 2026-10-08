<template>
  <div
    class="cached-page h-full flex flex-col bg-white dark:bg-black transition-colors duration-500"
  >
    <!-- 摘要头：移动端顶栏已经显示了页面名，这里只承担"存了多少、占了多少" -->
    <div class="flex-shrink-0 px-4 pt-3 pb-3 flex items-center gap-3">
      <div
        class="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0"
      >
        <i class="ri-download-cloud-2-line text-2xl text-primary" />
      </div>
      <div class="min-w-0">
        <div class="text-base font-bold text-neutral-900 dark:text-white truncate">
          {{ t('cached.title') }}
        </div>
        <div class="text-xs text-neutral-500 dark:text-neutral-400 truncate">
          {{ t('cached.songCount', { count: stats.musicFiles }) }} ·
          {{ t('cached.totalSize', { size: formatFileSize(stats.totalSizeBytes) }) }}
        </div>
      </div>
    </div>

    <cached-songs-panel class="flex-1 min-h-0" @changed="refreshStats" />
  </div>
</template>

<script setup lang="ts">
defineOptions({
  // 必须和 other.ts 里路由 name 的首字母大写形式一致：MobileLayout 的 keepAlive include
  // 是按 `name.charAt(0).toUpperCase() + slice(1)` 生成的，对不上就不会被缓存。
  name: 'Cached'
});

import { onActivated, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { audioDiskCache } from '@/services/audioDiskCache';
import { formatFileSize } from '@/utils';

import CachedSongsPanel from './CachedSongsPanel.vue';

const { t } = useI18n();

const stats = ref({ musicFiles: 0, totalSizeBytes: 0 });

const refreshStats = async () => {
  try {
    const current = await audioDiskCache.getStats();
    stats.value = { musicFiles: current.musicFiles, totalSizeBytes: current.totalSizeBytes };
  } catch (error) {
    console.warn('[cached] 读取缓存统计失败:', error);
  }
};

onMounted(refreshStats);
onActivated(refreshStats);
</script>
