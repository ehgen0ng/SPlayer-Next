<script setup lang="ts">
import { isAndroid } from "@/platform";
import { useSettingsDialog } from "@/settings/useSettingsDialog";

const SettingsContent = defineAsyncComponent(() => import("./SettingsContent.vue"));

const dialog = useSettingsDialog();
const { open } = dialog;
const { t } = useI18n();

/**
 * 车机打开设置时聚焦弹窗容器，避免搜索框自动唤起软键盘
 * @param event - 弹窗默认聚焦事件
 */
const handleOpenAutoFocus = (event: Event): void => {
  if (!isAndroid) return;
  event.preventDefault();
  (event.target as HTMLElement).focus({ preventScroll: true });
};

const unsubscribe = window.api.system.onOpenSettings(({ category, highlight }) => {
  dialog.show(category, highlight);
});

onBeforeUnmount(() => unsubscribe());
</script>

<template>
  <SDialog
    v-model:open="open"
    width="min(1024px, calc(100vw - 40px))"
    height="75vh"
    destroy-on-close
    @open-auto-focus="handleOpenAutoFocus"
  >
    <Suspense>
      <SettingsContent class="h-full" />
      <template #fallback>
        <div class="h-full flex items-center justify-center gap-2 text-on-surface-variant">
          <SLoading class="size-5 text-primary" />
          {{ t("common.loading") }}
        </div>
      </template>
    </Suspense>
  </SDialog>
</template>
