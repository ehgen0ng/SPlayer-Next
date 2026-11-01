<script setup lang="ts">
import { invokeAndroid } from "@/platform/android";
import { formatFileSize } from "@/utils/format";
import { dialog } from "@/composables/useDialog";

const { t } = useI18n();
const size = ref(0);
const busy = ref(false);

/** 更新原生播放缓存占用 */
const refresh = async (): Promise<void> => {
  size.value = await invokeAndroid<number>("cache:size");
};

/** 确认后清理播放缓存，后续播放按需重新获取缺失片段 */
const clear = async (): Promise<void> => {
  if (
    !(await dialog.confirm({
      title: t("settings.fileClearAll.confirmTitle"),
      content: t("settings.fileClearAll.confirmDesc"),
    }))
  )
    return;
  busy.value = true;
  try {
    await invokeAndroid("cache:clear");
    await refresh();
  } finally {
    busy.value = false;
  }
};

onMounted(refresh);
</script>

<template>
  <div class="flex items-center gap-4">
    <span class="text-sm tabular-nums">{{ formatFileSize(size) }}</span>
    <SButton :disabled="busy" @click="clear">{{ t("settings.fileClearAll.label") }}</SButton>
  </div>
</template>
