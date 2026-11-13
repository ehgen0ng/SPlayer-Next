<script setup lang="ts">
import { useQQMusicStore } from "@/stores/qqmusic";
import { useStatusStore } from "@/stores/status";
import { toast } from "@/composables/useToast";
import { REPO_NAME } from "@/utils/config";
import { qqmusicQrLoginAdapter } from "@/apis/login/qqmusic";
import { useDataStore } from "@/stores/data";
import { useAccountsStore } from "@/stores/accounts";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const { t } = useI18n();
const user = useQQMusicStore();
const adapter = qqmusicQrLoginAdapter;
const panelRef = useTemplateRef("panelRef");
const loading = ref(false);
const cookieDialogOpen = ref(false);

/** 校验 QM 扫码结果并同步账号收藏 */
const finishLogin = async (): Promise<boolean> => {
  const ok = await user.fetchStatus();
  if (ok) {
    useDataStore().activeAccountPlatform = "qqmusic";
    await useAccountsStore().refresh();
    useStatusStore().myPlaylistSource = "online";
    toast.success(t("login.success"));
    emit("update:open", false);
    return true;
  }
  toast.error(t("login.failed"));
  return false;
};

/** 完成 QQ 扫码登录 */
const handleQrSuccess = async (): Promise<void> => {
  loading.value = true;
  try {
    if (!(await finishLogin())) void panelRef.value?.refresh();
  } finally {
    loading.value = false;
  }
};

/** 暂停二维码轮询并打开手动登录 */
const openManualCookie = (): void => {
  panelRef.value?.pause();
  cookieDialogOpen.value = true;
};

/**
 * 同步手动登录弹窗的开关状态
 * @param open - 是否显示弹窗
 */
const onCookieDialogOpen = (open: boolean): void => {
  cookieDialogOpen.value = open;
  if (!open && props.open) panelRef.value?.resume();
};
</script>

<template>
  <SDialog :open="open" :closable="false" width="380px" @update:open="emit('update:open', $event)">
    <div class="flex flex-col items-center gap-4 py-3">
      <div class="flex flex-col items-center gap-2">
        <SLogo :size="48" />
        <div class="text-xl font-semibold text-on-surface">{{ REPO_NAME }}</div>
        <div class="text-sm text-on-surface-variant">
          {{ t("settings.platformLogin.title", { name: "QM" }) }}
        </div>
      </div>
      <QrLoginPanel
        ref="panelRef"
        class="mt-4"
        :active="open"
        :adapter="adapter"
        @success="handleQrSuccess"
      />
      <div class="flex items-center gap-2 pt-1">
        <SButton variant="ghost" size="small" :disabled="loading" @click="openManualCookie">
          <template #icon><IconLucideKeyRound /></template>
          {{ t("login.manualCookie") }}
        </SButton>
      </div>
    </div>
    <template #footer="{ close }">
      <SButton variant="tertiary" class="mx-auto" :disabled="loading" @click="close">
        <template #icon><IconLucideX /></template>
        {{ t("common.cancel") }}
      </SButton>
    </template>
  </SDialog>
  <LoginCookieDialog
    :open="cookieDialogOpen"
    @update:open="onCookieDialogOpen"
    @success="emit('update:open', false)"
  />
</template>
