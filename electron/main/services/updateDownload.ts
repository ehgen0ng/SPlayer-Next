import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UPDATE_MIRROR, UPDATE_RELEASES_URL } from "@shared/utils/update";

export interface UpdateDownload {
  url: string;
  sha512: string;
  size: number;
}

/**
 * 将当前仓库附件交给镜像传输，不携带账号或认证请求头
 * @param url - 已验证的 GitHub 附件地址
 * @returns 镜像附件地址
 */
export const getMirrorDownloadUrl = (url: string): string => {
  if (!url.startsWith(`${UPDATE_RELEASES_URL}/download/`)) {
    throw new Error("更新地址不属于当前仓库");
  }
  return `${UPDATE_MIRROR}${url}`;
};

/**
 * 流式下载并核对发布摘要，直连失败后最多尝试一次镜像
 * @param asset - 由原仓库清单取得的附件和摘要
 * @param destination - 私有缓存中的最终文件
 * @param signal - 当前下载任务的取消信号
 * @param onProgress - 已下载百分比
 * @returns 通过摘要和大小校验的缓存路径
 */
export const downloadUpdateFile = async (
  asset: UpdateDownload,
  destination: string,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
): Promise<string> => {
  const mirror = getMirrorDownloadUrl(asset.url);
  if (
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    !/^[A-Za-z0-9+/]{86}==$/.test(asset.sha512)
  ) {
    throw new Error("更新包缺少有效的大小或 SHA-512 摘要");
  }
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  await rm(destination, { force: true });
  const urls = [asset.url, mirror];
  try {
    for (let attempt = 0; attempt < urls.length; attempt++) {
      signal.throwIfAborted();
      const hash = createHash("sha512");
      let received = 0;
      let oversized = false;
      await rm(partial, { force: true });
      onProgress(0);
      try {
        const response = await fetch(urls[attempt], {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`更新下载失败: HTTP ${response.status}`);
        }
        await pipeline(
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
          new Transform({
            /**
             * 在固定大小的流缓冲中更新摘要并限制包体大小
             * @param chunk - 当前数据块
             * @param _encoding - 二进制流编码
             * @param callback - 流处理完成回调
             */
            transform(chunk: Buffer, _encoding, callback) {
              received += chunk.length;
              if (received > asset.size) {
                oversized = true;
                callback(new Error("更新包大小超过发布清单"));
                return;
              }
              hash.update(chunk);
              onProgress(Math.min(99, Math.floor((received / asset.size) * 100)));
              callback(null, chunk);
            },
          }),
          createWriteStream(partial, { flags: "wx", mode: 0o600 }),
          { signal },
        );
      } catch (error) {
        if (signal.aborted || oversized || attempt === urls.length - 1) throw error;
        continue;
      }
      if (received !== asset.size || hash.digest("base64") !== asset.sha512) {
        throw new Error("更新包的大小或 SHA-512 摘要与发布清单不一致");
      }
      signal.throwIfAborted();
      await rename(partial, destination);
      onProgress(100);
      return destination;
    }
    throw new Error("更新包下载失败");
  } finally {
    await rm(partial, { force: true });
  }
};
