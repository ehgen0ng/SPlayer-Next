import type { PluginInfo } from "../types/plugin";

/**
 * 按用户优先级排列已安装插件，未排序的插件保持安装顺序
 * @param plugins - 当前插件列表
 * @param priority - 用户保存的插件标识顺序
 * @returns 去重后的插件优先级视图
 */
export const orderPlugins = (plugins: PluginInfo[], priority: readonly string[]): PluginInfo[] => {
  const remaining = new Map(plugins.map((info) => [info.manifest.id, info]));
  const ordered: PluginInfo[] = [];
  for (const id of priority) {
    const info = remaining.get(id);
    if (info) ordered.push(info);
    remaining.delete(id);
  }
  return [...ordered, ...remaining.values()];
};

/**
 * 为仍启用且已就绪的音源插件累计一次成功加载
 * @param plugins - 当前插件列表
 * @param counts - 已保存的成功次数
 * @param id - 实际成功加载的插件标识
 * @returns 更新后的次数，无效插件返回 null
 */
export const addMusicSourceSuccess = (
  plugins: PluginInfo[],
  counts: Record<string, number>,
  id: string,
): Record<string, number> | null => {
  const info = plugins.find((plugin) => plugin.manifest.id === id);
  if (
    !info?.enabled ||
    info.status.state !== "ready" ||
    !Object.values(info.status.sources).some((source) => source.actions.includes("musicUrl"))
  )
    return null;
  return { ...counts, [id]: (counts[id] ?? 0) + 1 };
};

/**
 * 按成功次数排序，同分插件保留当前优先级
 * @param plugins - 当前插件列表
 * @param priority - 当前插件顺序
 * @param counts - 已保存的成功次数
 * @returns 按成功次数排列的插件标识
 */
export const orderPluginsBySuccess = (
  plugins: PluginInfo[],
  priority: readonly string[],
  counts: Record<string, number>,
): string[] =>
  orderPlugins(plugins, priority)
    .sort((a, b) => (counts[b.manifest.id] ?? 0) - (counts[a.manifest.id] ?? 0))
    .map((info) => info.manifest.id);
