import type { SettingCategory } from "@/types/settings-schema";
import generalCategory from "./categories/general";
import appearanceCategory from "./categories/appearance";
import playerCategory from "./categories/player";
import lyricCategory from "./categories/lyric";
import externalLyricCategory from "./categories/externalLyric";
import hotkeysCategory from "./categories/hotkeys";
import servicesCategory from "./categories/services";
import aiIntegrationCategory from "./categories/aiIntegration";
import mediaSourceCategory from "./categories/streaming";
import downloadCategory from "./categories/download";
import localCacheCategory from "./categories/localCache";
import pluginsCategory from "./categories/plugins";
import otherCategory from "./categories/other";
import { updateSection } from "./sections/update";
import AboutSettings from "@/components/settings/custom/AboutSettings.vue";
import IconLucideInfo from "~icons/lucide/info";
import { isAndroid } from "@/platform";
import PlaybackCacheSettings from "@/components/settings/custom/PlaybackCacheSettings.vue";

const categories: SettingCategory[] = [
  generalCategory,
  appearanceCategory,
  playerCategory,
  lyricCategory,
  externalLyricCategory,
  hotkeysCategory,
  servicesCategory,
  aiIntegrationCategory,
  mediaSourceCategory,
  downloadCategory,
  localCacheCategory,
  pluginsCategory,
  otherCategory,
  { id: "about", icon: IconLucideInfo, component: AboutSettings, sections: [updateSection] },
];

const androidSections: Record<string, readonly string[]> = {
  general: ["language", "debug"],
  appearance: ["theme", "layout", "softwareAnimations", "playerBar", "nowPlaying"],
  player: ["playBehavior", "audioSource", "musicSpectrum"],
  lyric: [
    "lyricContent",
    "lyricTTML",
    "lyricExclude",
    "lyricGeneral",
    "lyricDisplay",
    "lyricAMLLOptimize",
    "lyricSpring",
    "lyricLayout",
  ],
  plugins: ["pluginManage", "pluginsList"],
  other: ["platformLogin", "platformConfig", "preset"],
  localCache: ["songCache", "cache"],
  about: [],
};
const desktopItems = new Set([
  "cjkTransform",
  "enableLocalTTMLOverride",
  "skipKeywordsSongs",
  "keepScreenAwake",
]);

export const settingsSchema: SettingCategory[] = isAndroid
  ? categories
      .filter((category) => category.id in androidSections)
      .map((category) => ({
        ...category,
        sections: category.sections
          ?.filter((section) => androidSections[category.id].includes(section.id))
          .map((section) => {
            if (section.id === "songCache")
              return {
                ...section,
                items: [
                  {
                    ...section.items[0].children!.find(
                      (item) => item.key === "songCacheSizeLimit",
                    )!,
                    min: 1,
                    marks: { 1: "1G", 10: "10G", 20: "20G", 50: "50G" },
                  },
                ],
              };
            if (section.id === "cache")
              return {
                ...section,
                items: [
                  {
                    key: "fileCacheManager",
                    type: "custom",
                    component: PlaybackCacheSettings,
                    fullWidth: true,
                  },
                ],
              };
            return {
              ...section,
              items: section.items.filter((item) => !desktopItems.has(item.key)),
            };
          }),
      }))
  : categories;
