<template>
  <div class="flex gap-6 h-full pb-4 page-padding pt-6 bg-white dark:bg-black">
    <!-- 移动端：桌面端那份"收藏 + 历史"并排布局在这个宽度下不可用，收成一个分段控件。
         用 v-if/v-else 而不是 v-show：切回来时子组件要重新挂载，否则 onMounted 不触发、
        列表会停在切走前的旧快照上。 -->
    <div v-if="isMobile" class="flex-1 flex flex-col h-full min-h-0">
      <div class="flex-shrink-0 pb-3">
        <n-tabs v-model:value="mobileTab" type="segment" size="small">
          <n-tab name="history">{{ t('cached.tabHistory') }}</n-tab>
          <n-tab name="cached">{{ t('cached.tabCached') }}</n-tab>
        </n-tabs>
      </div>

      <div class="flex-1 min-h-0">
        <history-list v-if="mobileTab === 'history'" class="h-full" />
        <cached-songs-panel v-else class="h-full" />
      </div>
    </div>

    <template v-else>
      <favorite class="flex-item" />
      <history-list class="flex-item" />
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({
  name: 'History'
});

import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { isMobile } from '@/utils';
import CachedSongsPanel from '@/views/cached/CachedSongsPanel.vue';
import Favorite from '@/views/favorite/index.vue';
import HistoryList from '@/views/history/index.vue';

const { t } = useI18n();
const mobileTab = ref<'history' | 'cached'>('history');
</script>

<style scoped>
.flex-item {
  @apply flex-1 bg-gray-50 dark:bg-neutral-900/50 rounded-3xl overflow-hidden border border-gray-100 dark:border-neutral-800 transition-all duration-300;
}
</style>
