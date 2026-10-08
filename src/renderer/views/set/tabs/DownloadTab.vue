<template>
  <setting-section :title="t('settings.sections.download')">
    <setting-item :title="t('settings.download.directoryMode')" :description="modeDescription">
      <s-select v-model="dirMode" :options="modeOptions" width="w-48 max-md:w-full" />
    </setting-item>

    <!-- 音乐库模式才要子目录。自定义目录模式下「写哪儿」已经由用户选的目录决定了，
         再套一层只会让人困惑（nativeDownload 那边也是这么传的：subDir 传空串）。 -->
    <setting-item
      v-if="dirMode === 'mediastore'"
      :title="t('settings.download.mediaSubDir')"
      :description="t('settings.download.mediaSubDirDesc')"
    >
      <s-input
        v-model="mediaSubDir"
        :placeholder="DEFAULT_MEDIA_SUB_DIR"
        width="w-48 max-md:w-full"
      />
    </setting-item>

    <setting-item
      v-if="dirMode === 'mediastore'"
      :title="t('settings.download.oldAndroidHint')"
      :description="t('settings.download.oldAndroidHintDesc')"
    />

    <setting-item
      v-if="dirMode === 'saf'"
      :title="t('settings.download.safDirectory')"
      :description="t('settings.download.safDirectoryDesc')"
    >
      <template #extra>
        <span class="text-sm break-all" :class="safStateClass">{{ safStateText }}</span>
      </template>
      <template #action>
        <div class="flex items-center gap-2 max-md:flex-wrap">
          <s-btn variant="primary" :loading="picking" @click="chooseDirectory">
            {{ t('settings.download.chooseDirectory') }}
          </s-btn>
          <s-btn @click="resetDirectory">{{ t('settings.download.resetDirectory') }}</s-btn>
        </div>
      </template>
    </setting-item>

    <setting-item :title="t('settings.download.locationPreview')">
      <template #description>
        <span class="break-all">{{ locationPreview }}</span>
      </template>
      <template #extra>
        <span class="text-xs text-gray-400 dark:text-gray-500">
          {{ t('settings.download.locationPreviewDesc') }}
        </span>
      </template>
    </setting-item>
  </setting-section>
</template>

<script lang="ts" setup>
import { computed, inject, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import {
  getDirectoryLabel,
  hasDirectoryPermission,
  pickDirectory
} from '@/services/androidStorage';
import { DEFAULT_MEDIA_SUB_DIR } from '@/services/nativeDownload';

import { SETTINGS_DATA_KEY, SETTINGS_MESSAGE_KEY } from '../keys';
import SBtn from '../SBtn.vue';
import SettingItem from '../SettingItem.vue';
import SettingSection from '../SettingSection.vue';
import SInput from '../SInput.vue';
import SSelect from '../SSelect.vue';

defineOptions({ name: 'DownloadTab' });

const { t } = useI18n();
const setData = inject(SETTINGS_DATA_KEY)!;
const message = inject(SETTINGS_MESSAGE_KEY)!;

/**
 * 存的是 `'mediastore' | 'saf'`。用 computed 的读写器而不是直接绑 `setData.value.xxx`：
 * setData 是个 writable computed，整体替换才和 ApplicationTab 那些页签的写法一致
 * （那个深监听是盯着 localSetData 整个对象的）。
 *
 * 类型写成 string|number|boolean（= SSelect 的 OptionValue）是必须的：SSelect 的
 * update:modelValue 就是这个宽类型，收窄成字面量联合会让 v-model 直接编译不过。
 */
const dirMode = computed<string | number | boolean>({
  get: () => (setData.value?.downloadDirMode === 'saf' ? 'saf' : 'mediastore'),
  set: (value) => {
    setData.value = {
      ...setData.value,
      downloadDirMode: value === 'saf' ? 'saf' : 'mediastore'
    };
  }
});

const modeOptions = computed(() => [
  { label: t('settings.download.modeMediaStore'), value: 'mediastore' },
  { label: t('settings.download.modeSaf'), value: 'saf' }
]);

const modeDescription = computed(() =>
  dirMode.value === 'saf'
    ? t('settings.download.modeSafDesc')
    : t('settings.download.modeMediaStoreDesc')
);

const mediaSubDir = computed({
  get: () =>
    typeof setData.value?.downloadMediaDir === 'string' ? setData.value.downloadMediaDir : '',
  set: (value: string) => {
    setData.value = { ...setData.value, downloadMediaDir: value };
  }
});

/** 已保存的 SAF 目录显示名。拿不到就回退到提示文案。 */
const directoryLabel = ref('');
/** 之前那次授权还算不算数。用户完全可能在系统设置里把它撤销掉。 */
const permissionOk = ref(true);
const picking = ref(false);

const safStateText = computed(() => {
  if (!setData.value?.downloadSafTreeUri) return t('settings.download.noDirectoryChosen');
  if (!permissionOk.value) return t('settings.download.safPermissionLost');
  return directoryLabel.value || t('settings.download.noDirectoryChosen');
});

const safStateClass = computed(() =>
  permissionOk.value && setData.value?.downloadSafTreeUri
    ? 'text-gray-500 dark:text-gray-400'
    : 'text-amber-600 dark:text-amber-500'
);

/**
 * 位置预览。跟原生侧 buildDisplayPath 的拼法保持一致，但这边不带上歌名
 * —— 只是让用户看清「文件会落到哪」。
 */
const locationPreview = computed(() => {
  if (dirMode.value === 'saf') {
    if (!setData.value?.downloadSafTreeUri) return t('settings.download.noDirectoryChosen');
    return permissionOk.value
      ? `${directoryLabel.value || setData.value.downloadSafTreeUri}/`
      : t('settings.download.safPermissionLost');
  }

  const clean = String(setData.value?.downloadMediaDir ?? DEFAULT_MEDIA_SUB_DIR).trim();
  return clean ? `Music/${clean}/` : 'Music/';
});

/**
 * 挂载时就把已存的 tree URI 验一遍。
 *
 * 这是「别等到下载时才发现」那条：授权失效是**没有通知**的（用户在系统设置里撤销、
 * 或者 app 数据被迁移），只有主动查一次才知道。查出来就地标黄，让用户重选。
 */
const refreshSafState = async () => {
  const uri = setData.value?.downloadSafTreeUri;
  if (!uri) {
    permissionOk.value = true;
    directoryLabel.value = '';
    return;
  }

  const [label, granted] = await Promise.all([getDirectoryLabel(uri), hasDirectoryPermission(uri)]);
  directoryLabel.value = label || '';
  permissionOk.value = granted;
};

onMounted(refreshSafState);

// 选完目录后重新查一次（选目录的返回值里已经有 label，但授权状态还是走同一条路更保险）
watch(() => setData.value?.downloadSafTreeUri, refreshSafState);

const chooseDirectory = async () => {
  picking.value = true;
  try {
    const picked = await pickDirectory();
    if (!picked) return; // 用户取消，静默 —— 那不是错误

    setData.value = {
      ...setData.value,
      downloadDirMode: 'saf',
      downloadSafTreeUri: picked.uri
    };
    message.success(t('songItem.message.downloadDirectorySet', { path: picked.label }));
  } catch (error) {
    console.error('[DownloadTab] 选择目录失败:', error);
    message.error(t('settings.download.chooseDirectoryFailed'));
  } finally {
    picking.value = false;
  }
};

/** 「恢复默认」= 打回系统音乐库，并清掉那条授权记录。 */
const resetDirectory = () => {
  setData.value = {
    ...setData.value,
    downloadDirMode: 'mediastore',
    downloadSafTreeUri: ''
  };
  directoryLabel.value = '';
  permissionOk.value = true;
};
</script>
