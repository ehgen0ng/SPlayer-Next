<script setup lang="ts">
import { PLATFORM_SHORT_NAME } from "@shared/types/platform";
defineOptions({ name: "Favorites" });

import type { CoverItem } from "@/types/artist";
import { useUserStore } from "@/stores/user";
import { useQQMusicStore } from "@/stores/qqmusic";
import { useOnlineLibrary } from "@/composables/useOnlineLibrary";
import {
  albumsToCoverItems,
  artistsToCoverItems,
  playlistToCoverItem,
} from "@/utils/format/coverItem";
import CoverList from "@/components/list/CoverList.vue";
import IconLucideListMusic from "~icons/lucide/list-music";
import IconLucideDisc3 from "~icons/lucide/disc-3";
import IconLucideUser from "~icons/lucide/user";
import IconMaterialSymbolsFavoriteOutline from "~icons/material-symbols/favorite-outline-rounded";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const user = useUserStore();
const qqmusic = useQQMusicStore();
const online = useOnlineLibrary();

type FavTab = "playlist" | "album" | "artist";

const TAB_KEYS: readonly FavTab[] = ["playlist", "album", "artist"];

/** 当前 tab */
const activeTab = computed<FavTab>(() => {
  const tab = route.query.tab;
  return typeof tab === "string" && (TAB_KEYS as readonly string[]).includes(tab)
    ? (tab as FavTab)
    : "playlist";
});

const onTabSwitch = (key: string): void => {
  router.replace({ query: { ...route.query, tab: key } });
};

const tabs = computed(() => [
  { key: "playlist" satisfies FavTab, label: t("favorites.tabs.playlist") },
  { key: "album" satisfies FavTab, label: t("favorites.tabs.album") },
  { key: "artist" satisfies FavTab, label: t("favorites.tabs.artist") },
]);

const playlistItems = computed<CoverItem[]>(() =>
  online.subscribedPlaylists.value.map((pl) => ({
    ...playlistToCoverItem(pl),
    id: `${pl.source}:${pl.id}`,
    subtitle: `${PLATFORM_SHORT_NAME[pl.source]} · ${t("common.totalSongs", { count: pl.trackCount ?? 0 })}`,
  })),
);

const albumItems = computed<CoverItem[]>(() => albumsToCoverItems(user.albums));

const artistItems = computed<CoverItem[]>(() => artistsToCoverItems(user.artists));

const currentItems = computed<CoverItem[]>(() => {
  if (activeTab.value === "playlist") return playlistItems.value;
  if (activeTab.value === "album") return albumItems.value;
  return artistItems.value;
});

const countMeta = computed(() => {
  switch (activeTab.value) {
    case "album":
      return {
        icon: IconLucideDisc3,
        text: t("common.totalAlbums", { count: albumItems.value.length }),
      };
    case "artist":
      return {
        icon: IconLucideUser,
        text: t("common.totalArtists", { count: artistItems.value.length }),
      };
    case "playlist":
    default:
      return {
        icon: IconLucideListMusic,
        text: t("common.totalPlaylists", { count: playlistItems.value.length }),
      };
  }
});

/** 打开收藏条目，并保留所属音乐平台 */
const handleClick = (item: CoverItem): void => {
  if (activeTab.value === "playlist") {
    const separator = item.id.indexOf(":");
    const source = item.id.slice(0, separator);
    router.push(
      `/collection/${source}/playlist/${encodeURIComponent(item.id.slice(separator + 1))}`,
    );
    return;
  }
  if (activeTab.value === "artist") {
    router.push(`/artist/netease/${encodeURIComponent(item.id)}`);
  } else {
    router.push(`/collection/netease/${activeTab.value}/${encodeURIComponent(item.id)}`);
  }
};
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 顶栏 -->
    <div class="shrink-0 px-5 pb-2">
      <div class="flex items-baseline gap-4 mt-2 mb-4 min-w-0">
        <h1 class="text-3xl font-bold text-on-surface shrink-0 text-balance">
          {{ t("favorites.title") }}
        </h1>
        <Transition name="fade" mode="out-in">
          <span
            v-if="online.isLoggedIn.value"
            :key="activeTab"
            class="flex items-center gap-1.5 text-sm text-on-surface-variant/50 truncate"
          >
            <component :is="countMeta.icon" class="size-3.5 shrink-0" />
            {{ countMeta.text }}
          </span>
        </Transition>
      </div>
      <STabs :model-value="activeTab" :tabs="tabs" @update:model-value="onTabSwitch" />
      <SAlert v-if="qqmusic.error" type="warning" class="mt-2">
        {{ "QM" }}：{{ qqmusic.error }}
      </SAlert>
    </div>
    <!-- 未登录 -->
    <div v-if="!online.isLoggedIn.value" class="flex-1 flex items-center justify-center">
      <div class="text-center text-on-surface-variant/60">
        <IconMaterialSymbolsFavoriteOutline class="size-12 mx-auto mb-3 opacity-30" />
        <div class="text-sm">{{ t("favorites.notLogin") }}</div>
      </div>
    </div>
    <!-- 内容 -->
    <Transition v-else name="fade" mode="out-in" :duration="150">
      <div v-if="currentItems.length > 0" :key="activeTab" class="flex-1 min-h-0">
        <CoverList
          :items="currentItems"
          :type="activeTab === 'artist' ? 'artist' : 'default'"
          :min-size="activeTab === 'artist' ? 120 : 140"
          :padding-x="20"
          :padding-top="8"
          :padding-bottom="20"
          @click="handleClick"
        />
      </div>
      <div
        v-else-if="qqmusic.loading"
        key="loading"
        class="flex-1 flex items-center justify-center"
      >
        <SLoading class="text-4xl text-primary/70" />
      </div>
      <div v-else key="empty" class="flex-1 flex items-center justify-center">
        <div class="text-center text-on-surface-variant/50">
          <IconMaterialSymbolsFavoriteOutline class="size-12 mx-auto mb-3 opacity-30" />
          <div class="text-sm">{{ t("favorites.empty") }}</div>
        </div>
      </div>
    </Transition>
  </div>
</template>
