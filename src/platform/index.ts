/** 构建目标用于收敛平台入口，不根据浏览器 UA 猜测能力 */
export const isAndroid = import.meta.env.VITE_PLATFORM === "android";

/**
 * 限定车机可进入的业务页面，侧栏与路由使用同一规则
 * @param path - 目标页面路径
 * @returns 当前构建是否支持该页面
 */
export const supportsRoute = (path: string): boolean =>
  !isAndroid ||
  ![
    "/library",
    "/artists/local",
    "/albums/local",
    "/folders",
    "/download",
    "/cloud",
    "/streaming",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
