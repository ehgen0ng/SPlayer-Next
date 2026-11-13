<script setup lang="ts">
import { renderSVG } from "uqr";
import type { QrLoginAdapter, QrLoginState } from "@/apis/login/platform";

const props = defineProps<{ active: boolean; adapter: QrLoginAdapter }>();
const emit = defineEmits<{ success: [] }>();
const { t } = useI18n();
const qrUrl = ref("");
const key = ref("");
const state = ref<QrLoginState>("waiting");
const nickname = ref("");
const avatarUrl = ref("");
const refreshing = ref(false);
const error = ref("");
let generation = 0;
let pollingGeneration: number | null = null;
let currentAdapter: QrLoginAdapter | null = null;

const tip = computed(() => {
  if (error.value) return error.value;
  if (state.value === "expired") return t("login.qrTipExpired");
  if (state.value === "scanned") return t("login.qrTipScanned");
  if (state.value === "success") return t("login.qrTipDone");
  return t("login.qrTipWaiting");
});

/** 取消当前二维码，不让关闭弹窗后的授权写入会话 */
const cancel = (): void => {
  const previous = key.value;
  key.value = "";
  if (previous) void currentAdapter?.cancel?.(previous).catch(() => {});
};

/** 刷新二维码，忽略已关闭或被新一轮替代的生成结果 */
const refresh = async (): Promise<void> => {
  const version = ++generation;
  const adapter = props.adapter;
  pause();
  cancel();
  currentAdapter = adapter;
  refreshing.value = true;
  qrUrl.value = "";
  nickname.value = "";
  avatarUrl.value = "";
  error.value = "";
  try {
    const result = await adapter.create();
    if (version !== generation || !props.active) {
      await adapter.cancel?.(result.key);
      return;
    }
    key.value = result.key;
    if (result.content.startsWith("data:image/") || result.content.startsWith("blob:")) {
      qrUrl.value = result.content;
    } else {
      const svg = renderSVG(result.content, {
        ecc: "H",
        border: 0,
        pixelSize: 8,
        whiteColor: "#ffffff",
        blackColor: "#000000",
      });
      qrUrl.value = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    }
    state.value = "waiting";
    resume();
  } catch {
    if (version === generation && props.active) error.value = t("login.qrFailed");
  } finally {
    if (version === generation) refreshing.value = false;
  }
};

/** 串行查询扫码结果，迟到响应不触发旧二维码的成功回调 */
const poll = async (): Promise<void> => {
  const version = generation;
  if (!key.value || !props.active || pollingGeneration === version) return;
  pollingGeneration = version;
  try {
    const result = await props.adapter.check(key.value);
    if (version !== generation || !props.active) return;
    state.value = result.state;
    nickname.value = result.nickname ?? nickname.value;
    avatarUrl.value = result.avatarUrl ?? avatarUrl.value;
    if (result.state === "expired") await refresh();
    else if (result.state === "success") {
      pause();
      emit("success");
    }
  } catch {
    if (version === generation && props.active) {
      pause();
      cancel();
      error.value = t("login.qrFailed");
    }
  } finally {
    if (pollingGeneration === version) pollingGeneration = null;
  }
};
const { pause, resume } = useIntervalFn(poll, 1500, { immediate: false });

watch(
  () => [props.active, props.adapter] as const,
  ([active]) => {
    if (active) void refresh();
    else {
      generation++;
      pause();
      cancel();
      refreshing.value = false;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  pause();
  cancel();
});
defineExpose({ pause, resume, refresh });
</script>

<template>
  <div class="flex flex-col items-center gap-3">
    <div
      class="relative size-40 rounded-2xl bg-white p-3 border border-solid border-on-surface/12 shadow-sm overflow-hidden"
    >
      <img
        v-if="qrUrl"
        :src="qrUrl"
        alt="QR"
        :class="[
          'size-full',
          state === 'scanned' && (avatarUrl || nickname) && 'opacity-30 blur-4',
          state === 'expired' && 'opacity-40',
        ]"
      />
      <SLoading v-else class="absolute inset-0 m-auto size-6 text-gray-400" />
      <Transition name="fade">
        <div
          v-if="state === 'scanned' && (avatarUrl || nickname)"
          class="absolute inset-0 flex flex-col items-center justify-center gap-1.5"
        >
          <img
            v-if="avatarUrl"
            :src="avatarUrl"
            alt="avatar"
            class="size-12 rounded-full object-cover"
          />
          <div v-if="nickname" class="text-xs font-semibold text-gray-900">{{ nickname }}</div>
        </div>
      </Transition>
      <div
        v-if="state === 'expired'"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/75 text-xs font-medium text-gray-700"
      >
        <SLoading class="size-5" />
        {{ t("login.qrTipExpired") }}
      </div>
    </div>
    <div role="status" class="text-xs text-on-surface-variant text-center">{{ tip }}</div>
    <SButton v-if="error" variant="secondary" size="small" :loading="refreshing" @click="refresh">
      {{ t("login.qrRefresh") }}
    </SButton>
  </div>
</template>
