import path from "node:path";
import { z } from "zod/v4";
import { store } from "@main/store";
import { downloadUpdateFile } from "@main/services/updateDownload";
import { UPDATE_RELEASES_URL, UPDATE_REPOSITORY, getUpdateAssetUrl } from "@shared/utils/update";
import type { UpdateEvent, UpdateState } from "@shared/types/update";
import { ipcMain } from "./runtime/ipc";
import { broadcast } from "./runtime/broadcast";
import { invokeNative } from "./bridge";
import { coreLog } from "./runtime/logger";

const manifestSchema = z.object({
  version: z.string().min(1),
  versionCode: z.number().int().positive(),
  abi: z.string().min(1),
  file: z.string().endsWith("-release.apk"),
  sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  size: z.number().int().positive(),
});
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  body: z.string().nullable(),
  published_at: z.string().nullable(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

/** 返回安卓实际发布的通道，旧配置中的 Nightly 回到正式版 */
const getChannel = (): "stable" | "beta" =>
  store.get("update.channel") === "beta" ? "beta" : "stable";

let state: UpdateState = {
  revision: 0,
  channel: getChannel(),
  phase: "idle",
  mode: "inApp",
  meta: null,
  percent: 0,
  error: null,
};
let target: { manifest: z.infer<typeof manifestSchema>; url: string; apkPath: string } | null =
  null;
let downloaded = false;
let generation = 0;
let task: {
  kind: "check" | "download";
  generation: number;
  manual: boolean;
  abort: AbortController;
} | null = null;
let pendingCheck: { manual: boolean } | null = null;

/** 返回不含安装包路径的状态副本 */
const snapshot = (): UpdateState => structuredClone(state);

/** 返回配置写入校验和 WebView 恢复所需的更新快照 */
export const getAndroidUpdateState = (): UpdateState => snapshot();

/**
 * 发布完整更新状态，让 WebView 重建后能够恢复当前进度
 * @param patch - 本次状态变更
 * @param notification - 需要显示的结果通知
 * @param manual - 是否由用户主动触发
 */
const publish = (
  patch: Partial<UpdateState>,
  notification?: UpdateEvent["notification"],
  manual = false,
): void => {
  state = { ...state, ...patch, revision: state.revision + 1 };
  broadcast("update:event", { state: snapshot(), notification, manual } satisfies UpdateEvent);
};

/**
 * 检查原仓库正式签名 APK 的版本，使用原生 versionCode 防止降级
 * @param manual - 是否忽略自动检查开关
 * @returns 即时状态，结果通过事件推送
 */
const check = (manual: boolean): UpdateState => {
  if (!manual && !store.get("update.autoCheck")) return snapshot();
  if (task) {
    if (task.generation !== generation)
      pendingCheck = { manual: manual || pendingCheck?.manual === true };
    else if (task.kind === "check") task.manual ||= manual;
    return snapshot();
  }
  if (state.phase === "installing") return snapshot();
  if (target && !(manual && state.error?.source === "download")) return snapshot();
  const current = { kind: "check" as const, generation, manual, abort: new AbortController() };
  task = current;
  target = null;
  downloaded = false;
  publish({ phase: "checking", meta: null, percent: 0, error: null });
  void (async () => {
    try {
      const local = await invokeNative<{ versionCode: number; abis: string[]; apkPath: string }>(
        "android:updateInfo",
      );
      const response = await fetch(
        `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases${state.channel === "stable" ? "/latest" : "?per_page=30"}`,
        {
          headers: { Accept: "application/vnd.github+json" },
          signal: AbortSignal.any([current.abort.signal, AbortSignal.timeout(30_000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`检查更新失败: HTTP ${response.status}`);
      }
      const payload = await response.json();
      const releases =
        state.channel === "stable"
          ? [releaseSchema.parse(payload)]
          : z.array(releaseSchema).parse(payload);
      const name = `${state.channel === "beta" ? "beta" : "latest"}-android.json`;
      const release = releases.find(
        (item) =>
          !item.draft &&
          (state.channel === "beta" || !item.prerelease) &&
          /^v\d+\.\d+\.\d+(?:-(?:fork|beta)(?:\.\d+)?)?$/.test(item.tag_name) &&
          item.assets.some((asset) => asset.name === name),
      );
      if (!release) throw new Error("当前通道尚未发布支持在线更新的安卓安装包");
      const manifestUrl = getUpdateAssetUrl(release.tag_name, name);
      const metadata = await fetch(manifestUrl, {
        signal: AbortSignal.any([current.abort.signal, AbortSignal.timeout(30_000)]),
      });
      if (!metadata.ok) {
        await metadata.body?.cancel();
        throw new Error(`读取安卓更新清单失败: HTTP ${metadata.status}`);
      }
      const manifest = manifestSchema.parse(await metadata.json());
      if (`v${manifest.version}` !== release.tag_name)
        throw new Error("安卓更新清单版本与发布标签不一致");
      const url = getUpdateAssetUrl(release.tag_name, manifest.file);
      if (
        !release.assets.some(
          (asset) => asset.name === manifest.file && asset.browser_download_url === url,
        )
      ) {
        throw new Error("安卓更新清单引用了未发布的安装包");
      }
      if (current.generation !== generation) return;
      if (manifest.versionCode <= local.versionCode) {
        publish({ phase: "upToDate" }, "upToDate", current.manual);
      } else {
        if (!local.abis.includes(manifest.abi))
          throw new Error("当前发布没有适合本机架构的安卓更新包");
        target = { manifest, url, apkPath: local.apkPath };
        publish(
          {
            phase: "available",
            meta: {
              version: manifest.version,
              releaseNotes: release.body ?? "",
              releaseDate: release.published_at ?? "",
              size: manifest.size,
              releaseUrl: `${UPDATE_RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`,
            },
          },
          "available",
          current.manual,
        );
      }
    } catch (error) {
      if (current.generation === generation) fail("check", error, current.manual);
    } finally {
      finish(current);
    }
  })();
  return snapshot();
};

/**
 * 下载当前目标 APK，校验通过后才能交给系统安装器
 * @returns 即时下载状态
 */
const download = (): UpdateState => {
  if (task || !target || !(state.phase === "available" || state.error?.source === "download"))
    return snapshot();
  const selected = target;
  const current = {
    kind: "download" as const,
    generation,
    manual: true,
    abort: new AbortController(),
  };
  task = current;
  downloaded = false;
  publish({ phase: "downloading", percent: 0, error: null });
  void downloadUpdateFile(
    { url: selected.url, size: selected.manifest.size, sha512: selected.manifest.sha512 },
    path.resolve(selected.apkPath),
    current.abort.signal,
    (percent) => {
      if (current.generation === generation && percent !== state.percent) publish({ percent });
    },
  )
    .then(() => {
      if (current.generation !== generation) return;
      downloaded = true;
      publish({ phase: "downloaded", percent: 100 }, "downloaded", true);
    })
    .catch((error) => {
      if (current.generation === generation) fail("download", error, true);
    })
    .finally(() => finish(current));
  return snapshot();
};

/**
 * 调起系统安装与未知来源授权，取消安装后保留有效包
 * @returns 即时安装状态
 */
const install = (): UpdateState => {
  if (
    task ||
    !target ||
    !downloaded ||
    !(state.phase === "downloaded" || state.error?.source === "install")
  )
    return snapshot();
  publish({ phase: "installing", error: null });
  void invokeNative<boolean>(
    "android:installUpdate",
    target.apkPath,
    target.manifest.version,
    target.manifest.sha512,
  )
    .then((installed) => {
      if (!installed) publish({ phase: "downloaded" });
    })
    .catch((error) => fail("install", error, true));
  return snapshot();
};

/**
 * 切换通道时取消旧任务并撤销安装资格
 */
export const syncAndroidUpdateChannel = (): void => {
  const channel = getChannel();
  if (channel === state.channel) return;
  generation++;
  target = null;
  downloaded = false;
  publish({
    channel,
    phase: task?.kind === "download" ? "cancelling" : "idle",
    meta: null,
    percent: 0,
    error: null,
  });
  pendingCheck = { manual: true };
  task?.abort.abort();
  if (!task) {
    pendingCheck = null;
    check(true);
  }
};

/**
 * 在旧任务完全退出后启动最后一次排队检查
 * @param current - 已结算的任务
 */
const finish = (current: NonNullable<typeof task>): void => {
  if (task === current) task = null;
  const pending = pendingCheck;
  pendingCheck = null;
  if (pending) check(pending.manual);
};

/**
 * 保留错误来源与重试所需的目标
 * @param source - 失败阶段
 * @param error - 失败原因
 * @param manual - 是否向用户提示
 */
const fail = (source: "check" | "download" | "install", error: unknown, manual: boolean): void => {
  coreLog.error("安卓更新失败", error);
  publish({ phase: "error", error: { source, message: String(error) } }, "error", manual);
};

/** 注册与桌面一致的更新 API，仅在唯一 Node 实例启动时调用 */
export const registerAndroidUpdater = (): void => {
  ipcMain.handle("update:getState", snapshot);
  ipcMain.handle("update:check", (_event, manual) => check(manual === true));
  ipcMain.handle("update:download", download);
  ipcMain.handle("update:install", install);
  ipcMain.handle("update:openDownloadPage", () =>
    invokeNative("shell:openExternal", state.meta?.releaseUrl ?? UPDATE_RELEASES_URL),
  );
  setInterval(() => check(false), 6 * 60 * 60 * 1000).unref();
};
