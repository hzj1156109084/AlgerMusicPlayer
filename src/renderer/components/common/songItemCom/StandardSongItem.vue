<template>
  <base-song-item
    :item="item"
    :selectable="selectable"
    :selected="selected"
    :can-remove="canRemove"
    :is-next="isNext"
    :index="index"
    @play="(...args) => $emit('play', ...args)"
    @select="(...args) => $emit('select', ...args)"
    @remove-song="(...args) => $emit('remove-song', ...args)"
    class="standard-song-item"
    ref="baseItem"
  >
    <!-- 选择框插槽 -->
    <template #select>
      <div v-if="baseItem && selectable" class="song-item-select" @click.stop="onToggleSelect">
        <n-checkbox :checked="selected" />
      </div>
    </template>

    <!-- 图片插槽 -->
    <template #image>
      <n-image
        v-if="item.picUrl"
        :src="getImgUrl(item.picUrl, '100y100')"
        class="song-item-img"
        preview-disabled
        :img-props="{
          crossorigin: 'anonymous'
        }"
        @load="onImageLoad"
      />
    </template>

    <!-- 内容插槽 -->
    <template #content>
      <div class="song-item-content">
        <div class="song-item-content-title">
          <n-ellipsis
            class="text-ellipsis"
            line-clamp="1"
            :class="{ 'text-green-500': isPlaying }"
            >{{ item.name }}</n-ellipsis
          >
        </div>
        <div class="song-item-content-name">
          <n-ellipsis class="text-ellipsis" line-clamp="1">
            <template v-for="(artist, index) in artists" :key="index">
              <span
                class="cursor-pointer hover:text-green-500"
                @click.stop="onArtistClick(artist.id)"
                >{{ artist.name }}</span
              >
              <span v-if="index < artists.length - 1"> / </span>
            </template>
          </n-ellipsis>
        </div>
      </div>
    </template>

    <!-- 操作插槽 -->
    <template #operating>
      <div class="song-item-operating">
        <div v-if="favorite" class="song-item-operating-like">
          <i
            class="iconfont icon-likefill"
            :class="{ 'like-active': isFavorite }"
            @click.stop="onToggleFavorite"
          ></i>
        </div>
        <n-tooltip v-if="isNext" trigger="hover" :z-index="9999999" :delay="400">
          <template #trigger>
            <div class="song-item-operating-next" @click.stop="onPlayNext">
              <i class="iconfont ri-skip-forward-fill"></i>
            </div>
          </template>
          {{ t('songItem.menu.playNext') }}
        </n-tooltip>
        <!--
          端上专属的行内下载入口。桌面不加：那边的右键菜单里已经有同一条，
          再加一个只会让已经够挤的操作区更挤。
          门控用 isAndroid 而不是 isElectron/isNativePlatform —— iOS 上后者的判定会让
          按钮出现、点下去却必然失败（AndroidStoragePlugin 没有 iOS 实现）。
        -->
        <div
          v-if="isAndroid"
          class="song-item-operating-download"
          :class="{ 'is-downloading': isDownloading }"
          @click.stop="onDownload"
        >
          <i :class="isDownloading ? 'ri-loader-4-line animate-spin' : 'ri-download-line'"></i>
        </div>
        <div
          class="song-item-operating-play bg-gray-300 dark:bg-gray-800 animate__animated"
          :class="{ 'bg-green-600': isPlaying, animate__flipInY: playLoading }"
          @click="onPlayMusic"
        >
          <i v-if="isPlaying && play" class="iconfont icon-stop"></i>
          <i v-else class="iconfont icon-playfill"></i>
        </div>
      </div>
    </template>
  </base-song-item>
</template>

<script lang="ts" setup>
import { NCheckbox, NEllipsis, NImage, NTooltip } from 'naive-ui';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { usePlayerStore } from '@/store';
import type { SongResult } from '@/types/music';
import { getImgUrl, isAndroid } from '@/utils';

import BaseSongItem from './BaseSongItem.vue';

const { t } = useI18n();
const playerStore = usePlayerStore();

const props = withDefaults(
  defineProps<{
    item: SongResult;
    favorite?: boolean;
    selectable?: boolean;
    selected?: boolean;
    canRemove?: boolean;
    isNext?: boolean;
    index?: number;
  }>(),
  {
    favorite: true,
    selectable: false,
    selected: false,
    canRemove: false,
    isNext: false,
    index: undefined
  }
);

const emit = defineEmits(['play', 'select', 'remove-song']);
const baseItem = ref<InstanceType<typeof BaseSongItem>>();

// 从playerStore和baseItem获取响应式状态
const play = computed(() => playerStore.isPlay);
const isPlaying = computed(() => baseItem.value?.isPlaying || false);
const playLoading = computed(() => baseItem.value?.playLoading || false);
const isFavorite = computed(() => baseItem.value?.isFavorite || false);
const artists = computed(() => baseItem.value?.artists || []);
// 每行各建一个 useDownload()，所以这个转圈只转被点的那一行
const isDownloading = computed(() => baseItem.value?.isDownloading || false);

// 包装方法，避免直接访问可能为undefined的ref
const onToggleSelect = () => {
  baseItem.value?.toggleSelect();
};
const onImageLoad = (event: Event) => baseItem.value?.imageLoad(event);
const onArtistClick = (id: number) => baseItem.value?.handleArtistClick(id);
const onToggleFavorite = (event: Event) => {
  baseItem.value?.toggleFavorite(event);
};
const onPlayMusic = () => {
  baseItem.value?.playMusicEvent(props.item);
  emit('play', props.item);
};
const onPlayNext = () => {
  baseItem.value?.handlePlayNext();
};
const onDownload = () => {
  baseItem.value?.downloadMusic(props.item);
};
</script>

<style lang="scss" scoped>
.standard-song-item {
  &:hover {
    @apply bg-light-100 dark:bg-dark-100;
  }

  .song-item-img {
    @apply w-12 h-12 rounded-xl mr-4;
  }

  .song-item-content {
    @apply flex-1;

    &-title {
      @apply text-base text-gray-900 dark:text-white;
    }

    &-name {
      @apply text-xs text-gray-500 dark:text-gray-400;
    }
  }

  .song-item-operating {
    @apply flex items-center rounded-full ml-4 border dark:border-gray-700 border-gray-200 bg-light dark:bg-black;

    .iconfont {
      @apply text-xl;
    }

    .icon-likefill {
      @apply text-xl transition text-gray-500 dark:text-gray-400 hover:text-red-500;
    }

    &-like {
      @apply mr-2 cursor-pointer ml-4 transition-all;
    }

    &-next {
      @apply mr-2 cursor-pointer transition-all;

      .iconfont {
        @apply text-xl transition text-gray-500 dark:text-gray-400 hover:text-green-500;
      }
    }

    // 下载按钮用 remixicon 的图标，刻意**不带** iconfont 类：
    // 两者都靠 font-family: ... !important 抢字族，同级选择器只由样式表顺序决定胜负，
    // 叠在一起时哪一个生效是不确定的（见 components/settings/MusicSourceSettings.vue
    // 里同样只用 remixicon 类的先例）。所以字号也在这里自己给。
    &-download {
      @apply mr-2 cursor-pointer transition-all;

      i {
        @apply text-xl transition text-gray-500 dark:text-gray-400;
      }

      &:hover i {
        @apply text-green-500;
      }

      &.is-downloading i {
        @apply text-green-500;
      }
    }

    .like-active {
      @apply text-red-500 dark:text-red-500;
    }

    &-play {
      @apply cursor-pointer rounded-full w-10 h-10 flex justify-center items-center transition
             border dark:border-gray-700 border-gray-200 text-gray-900 dark:text-white;

      &:hover,
      &.bg-green-600 {
        @apply bg-green-500 border-green-500 text-white;
      }
    }
  }

  .song-item-select {
    @apply mr-3 cursor-pointer;
  }
}
</style>
