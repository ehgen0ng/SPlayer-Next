<script setup lang="ts">
import type { PluginInfo } from "@shared/types/plugin";
import { usePluginsStore } from "@/stores/plugins";
import { toast } from "@/composables/useToast";
import { isExternalUrl, openExternal } from "@/utils/url";
import { useSortable } from "@vueuse/integrations/useSortable";

defineOptions({ inheritAttrs: false });

const { t } = useI18n();
const pluginsStore = usePluginsStore();
const {
  orderedList: list,
  loaded,
  autoSortMusicSources,
  musicSourceSuccesses,
} = storeToRefs(pluginsStore);

const sortOpen = ref(false);
const sortDraft = shallowRef<PluginInfo[] | null>(null);
const sortList = computed({
  get: () => sortDraft.value ?? list.value,
  set: (value: PluginInfo[]) => (sortDraft.value = value),
});
const sortListEl = ref<HTMLElement | null>(null);
watch(sortOpen, () => {
  sortDraft.value = null;
});
useSortable(sortListEl, sortList, {
  animation: 150,
  handle: ".plugin-sort-handle",
  forceFallback: true,
  watchElement: true,
  fallbackClass: "sortable-ghost",
  onStart: () => {
    sortDraft.value = [...sortList.value];
  },
});

/**
 * 用按钮调整插件顺序，供键盘操作使用
 * @param index - 当前插件位置
 * @param offset - 向前或向后移动一位
 */
const movePlugin = (index: number, offset: number): void => {
  const next = [...sortList.value];
  const target = index + offset;
  if (target < 0 || target >= next.length) return;
  [next[index], next[target]] = [next[target], next[index]];
  sortList.value = next;
};

/** 保存手动排序，不改变自动排序开关 */
const saveOrder = async (): Promise<void> => {
  await pluginsStore.setOrder(sortList.value.map((info) => info.manifest.id));
  sortOpen.value = false;
};

const confirmOpen = ref(false);
const pendingUninstallId = ref<string | null>(null);
const settingsDialogOpen = ref(false);
const settingsDialogId = ref<string | null>(null);
const updatingId = ref<string | null>(null);
const checkingId = ref<string | null>(null);
const updateDialogOpen = ref(false);
const updateDialogId = ref<string | null>(null);
const detailDialogOpen = ref(false);
const detailDialogId = ref<string | null>(null);

onMounted(() => {
  if (!loaded.value) void pluginsStore.load();
  else pluginsStore.applyAutoOrder();
});

/** 插件 ready 时声明的设置 schema（配置弹窗用） */
const pluginSettings = (info: PluginInfo) => {
  if (info.status.state !== "ready") return [];
  return info.status.settings ?? [];
};

/**
 * 切换插件启用状态
 * @param id - 插件 ID
 * @param currentlyEnabled - 当前是否已启用
 */
const handleToggleEnabled = async (id: string, currentlyEnabled: boolean): Promise<void> => {
  await pluginsStore.setEnabled(id, !currentlyEnabled);
};

/**
 * 手动检查插件更新：拉远端 @version 与本地比对，按结果 toast 反馈
 * @param id - 插件 ID
 */
const handleCheckUpdate = async (id: string): Promise<void> => {
  checkingId.value = id;
  try {
    const res = await pluginsStore.checkUpdate(id);
    if (!res.ok) toast.error(t("settings.plugins.checkUpdateFailed"));
    else if (res.hasUpdate) toast.success(t("settings.plugins.updateFound"));
    else toast.info(t("settings.plugins.updateLatest"));
  } finally {
    checkingId.value = null;
  }
};

/**
 * 一键更新插件：拉取新版原地覆盖，成功后关闭弹窗
 * 失败时弹窗内的「查看更新」外链仍可手动打开
 * @param id - 插件 ID
 */
const handleUpdate = async (id: string): Promise<void> => {
  updatingId.value = id;
  try {
    const res = await pluginsStore.applyUpdate(id);
    if (res.ok) {
      toast.success(t("settings.plugins.updateSuccess"));
      updateDialogOpen.value = false;
    } else {
      toast.error(t("settings.plugins.updateFailed"));
    }
  } finally {
    updatingId.value = null;
  }
};

/** 打开某插件的更新详情弹窗 */
const openUpdateDialog = (id: string): void => {
  updateDialogId.value = id;
  updateDialogOpen.value = true;
};

/** 弹窗内点「更新」 */
const confirmUpdate = (): void => {
  if (updateDialogId.value) void handleUpdate(updateDialogId.value);
};

/** 当前更新弹窗对应的插件 */
const updateDialogInfo = computed(() => {
  if (!updateDialogId.value) return null;
  return list.value.find((info) => info.manifest.id === updateDialogId.value) ?? null;
});

/** 更新地址（用于「查看更新」外链） */
const updateDialogUrl = computed(() => updateDialogInfo.value?.updateInfo?.updateUrl ?? "");

/** 打开某插件详情弹窗 */
const openDetailDialog = (id: string): void => {
  detailDialogId.value = id;
  detailDialogOpen.value = true;
};

/** 当前详情弹窗对应的插件 */
const detailDialogInfo = computed(() => {
  if (!detailDialogId.value) return null;
  return list.value.find((info) => info.manifest.id === detailDialogId.value) ?? null;
});

const openUninstallConfirm = (id: string): void => {
  pendingUninstallId.value = id;
  confirmOpen.value = true;
};

const handleConfirmUninstall = async (): Promise<void> => {
  const id = pendingUninstallId.value;
  confirmOpen.value = false;
  pendingUninstallId.value = null;
  if (!id) return;
  const res = await pluginsStore.uninstall(id);
  if (res.ok) toast.success(t("settings.plugins.uninstallSuccess"));
  else toast.error(res.error ?? t("settings.plugins.uninstallFailed"));
};

/** 写入插件的单个设置项 */
const onSettingChange = async (pluginId: string, key: string, value: unknown): Promise<void> => {
  await pluginsStore.setSetting(pluginId, key, value);
};

/** 当前打开配置弹窗的插件 */
const settingsDialogInfo = computed(() => {
  if (!settingsDialogId.value) return null;
  return list.value.find((info) => info.manifest.id === settingsDialogId.value) ?? null;
});
/** 弹窗内设置表单的 schema 与当前值 */
const settingsDialogSchema = computed(() =>
  settingsDialogInfo.value ? pluginSettings(settingsDialogInfo.value) : [],
);
const settingsDialogValues = computed(() => settingsDialogInfo.value?.settingsValues ?? {});

/** 打开某插件的配置弹窗 */
const openSettingsDialog = (id: string): void => {
  settingsDialogId.value = id;
  settingsDialogOpen.value = true;
};

/** 弹窗内修改某设置项 */
const onDialogSettingChange = (key: string, value: unknown): void => {
  if (settingsDialogId.value) void onSettingChange(settingsDialogId.value, key, value);
};

/** 当前待卸载的插件名（对话框提示） */
const pendingName = computed(() => {
  if (!pendingUninstallId.value) return "";
  return (
    list.value.find((info) => info.manifest.id === pendingUninstallId.value)?.manifest.name ?? ""
  );
});

const isEmpty = computed(() => list.value.length === 0);

/** 插件开发文档 */
const DOCS_URL = "https://splayer-next.imsyy.top/plugins/";
/** 提交入口 */
const SUBMIT_URL = "https://github.com/SPlayer-Dev/plugins/issues/new/choose";

/** 已安装 / 插件市场 切换 */
const tab = ref("installed");
const tabs = computed(() => [
  { key: "installed", label: t("settings.plugins.installed") },
  { key: "market", label: t("settings.plugins.market") },
]);

/** 市场子组件引用，供刷新按钮调用 */
const marketRef = ref<{ refresh: (force?: boolean) => Promise<void> } | null>(null);
const refreshing = ref(false);
const refreshMarket = async (): Promise<void> => {
  refreshing.value = true;
  await marketRef.value?.refresh(true);
  refreshing.value = false;
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between gap-2">
      <STabs v-model="tab" type="bar" :tabs="tabs" />
      <SButton
        v-if="tab === 'market'"
        variant="text"
        size="small"
        :loading="refreshing"
        @click="refreshMarket"
      >
        <template #icon><IconLucideRefreshCw class="size-4" /></template>
        {{ t("common.refreshCache") }}
      </SButton>
    </div>

    <!-- 已安装 -->
    <div v-if="tab === 'installed'" class="flex flex-col gap-4">
      <div
        class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-panel border border-solid border-outline-variant/15 px-3.5 py-3"
      >
        <div class="flex-1 min-w-48">
          <div class="text-sm font-medium text-on-surface">
            {{ t("settings.plugins.autoSort") }}
          </div>
          <div class="mt-1 text-xs text-on-surface-variant/70">
            {{ t("settings.plugins.autoSortHint") }}
          </div>
        </div>
        <SSwitch
          :model-value="autoSortMusicSources"
          :aria-label="t('settings.plugins.autoSort')"
          @update:model-value="pluginsStore.setAutoSortMusicSources"
        />
        <SButton
          variant="secondary"
          size="small"
          :disabled="list.length < 2"
          @click="sortOpen = true"
        >
          <template #icon><IconLucideArrowUpDown class="size-4" /></template>
          {{ t("settings.plugins.sort") }}
        </SButton>
      </div>
      <!-- 空态 -->
      <div
        v-if="isEmpty"
        class="flex flex-col items-center gap-3 rounded-xl bg-surface-panel border border-solid border-outline-variant/15 py-10"
      >
        <div
          class="size-12 rounded-xl bg-on-surface/6 flex items-center justify-center text-on-surface-variant"
        >
          <IconLucidePuzzle class="size-6" />
        </div>
        <div class="text-sm text-on-surface-variant">{{ t("settings.plugins.empty") }}</div>
        <div class="text-xs text-on-surface-variant/60">{{ t("settings.plugins.emptyHint") }}</div>
      </div>

      <div class="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
        <PluginCard
          v-for="info in list"
          :key="info.manifest.id"
          :info="info"
          :checking="checkingId === info.manifest.id"
          @toggle="handleToggleEnabled"
          @uninstall="openUninstallConfirm"
          @configure="openSettingsDialog"
          @check="handleCheckUpdate"
          @view-update="openUpdateDialog"
          @detail="openDetailDialog"
        />
      </div>
    </div>

    <!-- 插件市场 -->
    <PluginMarket v-else ref="marketRef" />

    <SDialog
      v-model:open="sortOpen"
      :title="t('settings.plugins.sortTitle')"
      :description="t('settings.plugins.sortHint')"
      width="480px"
    >
      <div ref="sortListEl" class="flex max-h-96 flex-col gap-2 overflow-y-auto">
        <div
          v-for="(info, index) in sortList"
          :key="info.manifest.id"
          :data-plugin-id="info.manifest.id"
          class="flex items-center gap-2 rounded-lg bg-surface-panel px-3 py-2"
        >
          <span
            class="plugin-sort-handle flex shrink-0 cursor-grab items-center gap-1 text-on-surface-variant/60 active:cursor-grabbing"
          >
            <IconLucideGripVertical class="size-4" />
            <span class="w-5 text-center text-xs">{{ index + 1 }}</span>
          </span>
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm">{{ info.manifest.name }}</div>
            <div
              v-if="musicSourceSuccesses[info.manifest.id]"
              class="text-xs text-on-surface-variant/70"
            >
              {{
                t("settings.plugins.successCount", {
                  count: musicSourceSuccesses[info.manifest.id],
                })
              }}
            </div>
          </div>
          <SButton
            variant="text"
            size="tiny"
            circle
            :disabled="index === 0"
            :aria-label="t('settings.plugins.moveUp')"
            @click="movePlugin(index, -1)"
          >
            <template #icon><IconLucideChevronUp /></template>
          </SButton>
          <SButton
            variant="text"
            size="tiny"
            circle
            :disabled="index === sortList.length - 1"
            :aria-label="t('settings.plugins.moveDown')"
            @click="movePlugin(index, 1)"
          >
            <template #icon><IconLucideChevronDown /></template>
          </SButton>
        </div>
      </div>
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">{{ t("common.cancel") }}</SButton>
        <SButton type="primary" @click="saveOrder">{{ t("common.confirm") }}</SButton>
      </template>
    </SDialog>

    <!-- 发布入口 -->
    <div
      class="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 pt-4 text-xs text-on-surface-variant/60"
    >
      <span>{{ t("settings.plugins.publishHint") }}</span>
      <SButton variant="text" type="primary" size="tiny" @click="openExternal(SUBMIT_URL)">
        <template #icon><IconLucideUpload /></template>
        {{ t("settings.plugins.publishAction") }}
      </SButton>
      <span class="opacity-40">·</span>
      <SButton variant="text" type="primary" size="tiny" @click="openExternal(DOCS_URL)">
        <template #icon><IconLucideBookOpen /></template>
        {{ t("settings.plugins.docs") }}
      </SButton>
    </div>

    <!-- 卸载确认 -->
    <SDialog
      v-model:open="confirmOpen"
      :title="t('settings.plugins.uninstallConfirmTitle')"
      width="400px"
    >
      <p class="text-sm text-on-surface-variant">
        {{ t("settings.plugins.uninstallConfirm", { name: pendingName }) }}
      </p>
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">{{ t("common.cancel") }}</SButton>
        <SButton variant="secondary" type="error" @click="handleConfirmUninstall">
          {{ t("common.confirm") }}
        </SButton>
      </template>
    </SDialog>

    <!-- 插件配置 -->
    <SDialog
      v-model:open="settingsDialogOpen"
      :title="settingsDialogInfo?.manifest.name ?? ''"
      :description="t('settings.plugins.configSubtitle')"
      width="520px"
    >
      <PluginSettingsForm
        :schema="settingsDialogSchema"
        :values="settingsDialogValues"
        @change="onDialogSettingChange"
      />
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">{{ t("common.close") }}</SButton>
      </template>
    </SDialog>

    <!-- 插件更新 -->
    <SDialog
      v-model:open="updateDialogOpen"
      :title="updateDialogInfo?.manifest.name ?? ''"
      width="460px"
    >
      <div v-if="updateDialogInfo?.updateInfo" class="flex flex-col gap-4">
        <div class="flex items-center gap-2 text-sm">
          <STag type="default" size="small">v{{ updateDialogInfo.manifest.version }}</STag>
          <template v-if="updateDialogInfo.updateInfo.version">
            <IconLucideArrowRight class="size-4 text-on-surface-variant/50" />
            <STag type="primary" size="small">v{{ updateDialogInfo.updateInfo.version }}</STag>
          </template>
        </div>
        <div
          class="max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-sm"
          :class="
            updateDialogInfo.updateInfo.log
              ? 'text-on-surface-variant'
              : 'text-on-surface-variant/50'
          "
        >
          {{ updateDialogInfo.updateInfo.log || t("settings.plugins.noChangelog") }}
        </div>
      </div>
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">{{ t("common.cancel") }}</SButton>
        <SButton
          v-if="isExternalUrl(updateDialogUrl)"
          variant="secondary"
          @click="openExternal(updateDialogUrl)"
        >
          {{ t("settings.plugins.openUpdateUrl") }}
        </SButton>
        <SButton
          variant="secondary"
          type="primary"
          :loading="updatingId === updateDialogId"
          @click="confirmUpdate"
        >
          {{ t("settings.plugins.update") }}
        </SButton>
      </template>
    </SDialog>

    <!-- 插件详情 -->
    <PluginDetailDialog v-model:open="detailDialogOpen" :info="detailDialogInfo" />
  </div>
</template>
