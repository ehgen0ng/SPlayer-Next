/** 应用更新只使用本仓库发布的资源 */
export const UPDATE_REPOSITORY = "ehgen0ng/SPlayer-Next";
export const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
export const UPDATE_MIRROR = "https://gh-proxy.org/";

/**
 * 将发布附件名限定为单个文件，避免清单改变下载仓库
 * @param tag - 已检查的发布标签
 * @param file - 发布附件名
 * @returns 当前仓库内的附件地址
 */
export const getUpdateAssetUrl = (tag: string, file: string): string => {
  const name = decodeURIComponent(file);
  if (
    !name ||
    /[/\\]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("更新附件名称无效");
  }
  return `${UPDATE_RELEASES_URL}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
};
