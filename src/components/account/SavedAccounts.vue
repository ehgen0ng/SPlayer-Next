<script setup lang="ts">
import { useAccountsStore } from "@/stores/accounts";
import { ALL_PLATFORMS, PLATFORM_SHORT_NAME, type Platform } from "@shared/types/platform";
import type { SavedPlatformAccount } from "@shared/types/apis";
import { toast } from "@/composables/useToast";
import { dialog } from "@/composables/useDialog";

const props = defineProps<{ platform?: Platform; removable?: boolean }>();
const emit = defineEmits<{ switched: [] }>();
const accounts = useAccountsStore();
const { t } = useI18n();
const groups = computed(() =>
  ALL_PLATFORMS.filter((platform) => !props.platform || props.platform === platform)
    .map((platform) => ({
      platform,
      items: accounts.accounts.filter((item) => item.platform === platform),
    }))
    .filter((group) => group.items.length > 0),
);

/** 更新共用列表，失败时保留上次已加载的账号 */
const refresh = async (): Promise<void> => {
  try {
    await accounts.refresh();
  } catch {
    toast.error(t("login.accountsLoadFailed"));
  }
};
onMounted(refresh);

/**
 * 切换账号并显示验证结果
 * @param account - 已保存的公开账号记录
 */
const select = async (account: SavedPlatformAccount): Promise<void> => {
  try {
    if (await accounts.switchAccount(account)) {
      toast.success(t("login.accountSwitched"));
      emit("switched");
    } else toast.error(t("login.accountExpired"));
  } catch {
    toast.error(t("login.accountSwitchFailed"));
  }
};

/**
 * 经确认后移除本地账号
 * @param account - 要移除的账号
 */
const remove = async (account: SavedPlatformAccount): Promise<void> => {
  if (
    !(await dialog.confirm({
      title: t("login.removeAccount"),
      content: t("login.removeAccountConfirm", { name: account.profile.nickname }),
      type: "warning",
    }))
  )
    return;
  try {
    await accounts.removeAccount(account);
  } catch {
    toast.error(t("login.accountRemoveFailed"));
  }
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="!groups.length" class="px-2 py-3 text-sm text-on-surface-variant">
      {{ t("login.noSavedAccounts") }}
    </div>
    <section v-for="group in groups" :key="group.platform" class="flex flex-col gap-1">
      <div v-if="!platform" class="px-2 text-xs font-medium text-on-surface-variant">
        {{ PLATFORM_SHORT_NAME[group.platform] }}
      </div>
      <div
        v-for="account in group.items"
        :key="account.profile.userId"
        class="flex items-center gap-1"
      >
        <button
          type="button"
          :disabled="accounts.busy"
          :aria-label="t('login.switchToAccount', { name: account.profile.nickname })"
          :aria-pressed="account.active && (!!platform || accounts.platform === account.platform)"
          class="min-w-0 flex-1 flex items-center gap-2.5 rounded-xl border-0 bg-transparent px-2 py-2 text-left cursor-pointer hover:bg-on-surface/8 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          @click="select(account)"
        >
          <img
            v-if="account.profile.avatarUrl"
            :src="account.profile.avatarUrl"
            alt=""
            decoding="async"
            referrerpolicy="no-referrer"
            class="size-8 rounded-full object-cover shrink-0"
          />
          <span
            v-else
            class="size-8 rounded-full bg-on-surface/8 flex items-center justify-center shrink-0"
          >
            <IconLucideUserRound class="size-4" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-on-surface">
              {{ account.profile.nickname || t("login.unknownUser") }}
            </span>
            <span class="block truncate text-xs text-on-surface-variant">
              {{ account.profile.userId }}
            </span>
          </span>
          <IconLucideCheck
            v-if="account.active"
            class="size-4 shrink-0 text-primary"
            :title="t('login.currentAccount')"
          />
        </button>
        <SButton
          v-if="removable"
          variant="ghost"
          :size="32"
          circle
          :disabled="accounts.busy"
          :title="t('login.removeAccount')"
          @click="remove(account)"
        >
          <template #icon><IconLucideTrash2 /></template>
        </SButton>
      </div>
    </section>
  </div>
</template>
