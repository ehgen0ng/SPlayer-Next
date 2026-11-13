<script setup lang="ts">
import { useAccountsStore } from "@/stores/accounts";
import { useDataStore } from "@/stores/data";
import { useUserStore } from "@/stores/user";
import { PLATFORM_SHORT_NAME } from "@shared/types/platform";
import { useSettingsDialog } from "@/settings/useSettingsDialog";
import { useQQMusicStore } from "@/stores/qqmusic";
import { useStatusStore } from "@/stores/status";
import { dialog } from "@/composables/useDialog";
import { toast } from "@/composables/useToast";
import vipImg from "@/assets/images/vip.png";
import IconLucideListMusic from "~icons/lucide/list-music";
import IconMaterialSymbolsFavoriteOutlineRounded from "~icons/material-symbols/favorite-outline-rounded";

const { t } = useI18n();
const router = useRouter();
const user = useAccountsStore();
const qqmusic = useQQMusicStore();
const netease = useUserStore();
const data = useDataStore();
const isLoggedIn = computed(() => user.profile !== null);
const platformName = computed(() => PLATFORM_SHORT_NAME[user.platform]);
const { show: showSettings } = useSettingsDialog();

const loginOpen = ref(false);
const popoverOpen = ref(false);
const accountsOpen = ref(false);
const status = useStatusStore();

/** 校验现有三平台会话，将原单账号登录纳入账号列表 */
onMounted(async () => {
  await user.refresh();
  await Promise.allSettled([
    qqmusic.fetchStatus(),
    netease.fetchStatus(),
    user.fetchStatus("kugou"),
  ]);
  await user.refresh();
});
useEventListener(window, "focus", () => {
  if (isLoggedIn.value) void user.fetchStatus(user.platform);
});
useIntervalFn(
  () => {
    if (document.visibilityState === "visible" && isLoggedIn.value)
      void user.fetchStatus(user.platform);
  },
  5 * 60 * 1000,
);
watch(
  () => [qqmusic.profile, netease.profile, data.getPlatformProfile("kugou")],
  () => {
    void user.refresh();
  },
);
watch(
  () => user.accounts,
  (items) => {
    if (!user.profile) {
      const available = items.find((item) => item.active && user.getProfile(item.platform));
      if (available) data.activeAccountPlatform = available.platform;
    }
  },
);

const isVip = computed(() => !!user.profile?.isVip);

/** 收藏计数 */
const stats = computed(() => [
  {
    key: "playlist" as const,
    label: t("collection.playlist"),
    icon: markRaw(IconLucideListMusic),
    value:
      user.platform === "qqmusic"
        ? qqmusic.createdPlaylists.length + qqmusic.subscribedPlaylists.length
        : netease.createdPlaylists.length + netease.subscribedPlaylists.length,
  },
  {
    key: "liked" as const,
    label: t("liked.title"),
    icon: markRaw(IconMaterialSymbolsFavoriteOutlineRounded),
    value:
      user.platform === "qqmusic" ? qqmusic.likedPlaylistTracks.length : netease.likedSongIds.size,
  },
]);

/** 打开原有 QM 登录入口 */
const onTriggerClick = (): void => {
  loginOpen.value = true;
};

/**
 * 打开汇总收藏入口
 * @param key - 歌单或喜欢歌曲
 */
const handleStatClick = (key: "playlist" | "liked"): void => {
  popoverOpen.value = false;
  if (key === "liked") {
    status.likedPageTab = "online";
    router.push("/liked");
  } else router.push({ path: "/favorites", query: { tab: key } });
};

/** 退出顶部当前选中的账号，保留其他账号 */
const handleLogout = async (): Promise<void> => {
  popoverOpen.value = false;
  const ok = await dialog.confirm({
    title: t("login.logoutConfirmTitle"),
    content: t("login.logoutConfirmDesc"),
    type: "warning",
  });
  if (!ok) return;
  if (user.platform === "netease") await netease.logout();
  else if (user.platform === "qqmusic") await qqmusic.logout();
  else {
    await window.api.apis.clearSession("kugou");
    data.clearPlatformProfile("kugou");
  }
  await user.refresh();
  toast.success(t("login.logoutDone"));
};
</script>

<template>
  <SPopover
    v-if="isLoggedIn"
    v-model:open="popoverOpen"
    trigger="click"
    align="end"
    content-class="w-40"
  >
    <template #trigger>
      <div
        class="app-no-drag inline-flex items-center gap-2 h-10 pl-1 pr-3 lt-sidebar:pr-1 rounded-full bg-on-surface/6 hover:bg-on-surface/10 transition-colors cursor-pointer select-none"
      >
        <span
          class="size-8 rounded-full overflow-hidden bg-on-surface/10 flex items-center justify-center"
        >
          <img
            v-if="user.profile?.avatarUrl"
            :src="user.profile.avatarUrl"
            alt="avatar"
            class="size-full object-cover"
            referrerpolicy="no-referrer"
          />
          <IconLucideUserRound v-else class="size-4 text-on-surface-variant" />
        </span>
        <span class="text-sm text-on-surface max-w-[7rem] truncate lt-sidebar:hidden">
          {{ user.profile?.nickname || t("login.unknownUser") }}
        </span>
        <img v-if="isVip" :src="vipImg" alt="VIP" class="h-4 shrink-0 lt-sidebar:hidden" />
        <IconLucideChevronDown
          :class="[
            'size-3 text-on-surface-variant transition-transform duration-200 lt-sidebar:hidden',
            popoverOpen && 'rotate-180',
          ]"
        />
      </div>
    </template>

    <div class="flex flex-col items-center gap-2">
      <span
        class="size-12 rounded-full overflow-hidden bg-on-surface/10 flex items-center justify-center"
      >
        <img
          v-if="user.profile?.avatarUrl"
          :src="user.profile.avatarUrl"
          alt="avatar"
          class="size-full object-cover"
          referrerpolicy="no-referrer"
        />
        <IconLucideUserRound v-else class="size-5 text-on-surface-variant" />
      </span>
      <span class="w-full text-sm font-semibold text-on-surface text-center truncate">
        {{ user.profile?.nickname || t("login.unknownUser") }}
      </span>
      <div class="flex items-center gap-1.5">
        <span class="text-xs text-on-surface-variant">{{ platformName }}</span>
        <span
          v-if="user.profile?.vipLevel"
          class="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none bg-amber-500/15 text-amber-600 dark:text-amber-400 tabular-nums"
        >
          Lv.{{ user.profile.vipLevel }}
        </span>
        <img v-if="isVip" :src="vipImg" alt="VIP" class="h-4 shrink-0" />
      </div>
      <SDivider class="w-full" />
      <!-- 收藏计数 -->
      <div v-if="user.platform !== 'kugou'" class="w-full flex items-stretch justify-around gap-1">
        <div
          v-for="item in stats"
          :key="item.key"
          :title="item.label"
          class="group flex flex-1 flex-col items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors duration-200 hover:bg-on-surface/8 active:bg-on-surface/12"
          @click="handleStatClick(item.key)"
        >
          <component
            :is="item.icon"
            class="size-4 text-on-surface-variant/70 transition-colors duration-200 group-hover:text-primary"
          />
          <span
            class="text-sm font-semibold text-on-surface tabular-nums leading-none transition-colors duration-200 group-hover:text-primary"
          >
            {{ item.value }}
          </span>
        </div>
      </div>
      <SDivider class="w-full" />
      <SButton
        variant="secondary"
        size="small"
        block
        @click="
          popoverOpen = false;
          accountsOpen = true;
        "
      >
        <template #icon><IconLucideArrowRightLeft /></template>
        {{ t("login.switchAccount") }}
      </SButton>
      <SButton variant="secondary" size="small" block @click="handleLogout">
        <template #icon><IconLucideLogOut /></template>
        {{ t("login.logout") }}
      </SButton>
    </div>
  </SPopover>

  <SButton v-else class="app-no-drag" variant="tertiary" :size="40" circle @click="onTriggerClick">
    <template #icon><IconLucideUserRound /></template>
  </SButton>

  <SDialog v-model:open="accountsOpen" :title="t('login.switchAccount')" width="420px">
    <SavedAccounts class="max-h-96 overflow-y-auto" @switched="accountsOpen = false" />
    <template #footer>
      <SButton
        variant="tertiary"
        @click="
          accountsOpen = false;
          showSettings('other', 'platformLogin');
        "
      >
        <template #icon><IconLucideSettings /></template>
        {{ t("login.manageAccounts") }}
      </SButton>
      <SButton
        variant="secondary"
        @click="
          accountsOpen = false;
          loginOpen = true;
        "
      >
        <template #icon><IconLucideUserPlus /></template>
        {{ t("login.addQQMusicAccount") }}
      </SButton>
    </template>
  </SDialog>
  <LoginDialog v-model:open="loginOpen" />
</template>
