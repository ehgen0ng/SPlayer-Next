// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadUpdateFile } from "./updateDownload";

const content = Buffer.from("signed update package");
const asset = {
  url: "https://github.com/ehgen0ng/SPlayer-Next/releases/download/v2.0.0/update.zip",
  sha512: createHash("sha512").update(content).digest("base64"),
  size: content.length,
};
let work: string;
let request: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "splayer-update-download-"));
  request = vi.fn().mockImplementation(async () => new Response(content));
  vi.stubGlobal("fetch", request);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(work, { recursive: true, force: true });
});

describe("更新包流式下载", () => {
  it("直连成功不访问镜像，只有摘要通过后才提交最终文件", async () => {
    const destination = join(work, "update.zip");
    await downloadUpdateFile(asset, destination, new AbortController().signal, vi.fn());
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe(asset.url);
    expect(await readFile(destination)).toEqual(content);
    expect(await readdir(work)).toEqual(["update.zip"]);
  });
  it("直连失败后才访问镜像，并继续使用原始摘要校验", async () => {
    request.mockRejectedValueOnce(new Error("network"));
    const destination = join(work, "update.apk");
    await downloadUpdateFile(asset, destination, new AbortController().signal, vi.fn());
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      asset.url,
      `https://gh-proxy.org/${asset.url}`,
    ]);
    expect(await readFile(destination)).toEqual(content);
  });
  it("摘要失败不改用另一来源掩盖错误，也不保留未验证文件", async () => {
    request.mockResolvedValueOnce(new Response(Buffer.alloc(content.length)));
    await expect(
      downloadUpdateFile(asset, join(work, "update.zip"), new AbortController().signal, vi.fn()),
    ).rejects.toThrow("摘要");
    expect(request).toHaveBeenCalledOnce();
    expect(await readdir(work)).toEqual([]);
  });
  it("取消任务后不触发镜像回退", async () => {
    const abort = new AbortController();
    request.mockImplementationOnce(async () => {
      abort.abort();
      throw new Error("cancelled");
    });
    await expect(
      downloadUpdateFile(asset, join(work, "update.zip"), abort.signal, vi.fn()),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    expect(await readdir(work)).toEqual([]);
  });
  it("其他仓库的 URL 被拒绝", async () => {
    await expect(
      downloadUpdateFile(
        { ...asset, url: "https://github.com/imsyy/SPlayer/releases/download/v2/update.zip" },
        join(work, "update.zip"),
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow("当前仓库");
    expect(request).not.toHaveBeenCalled();
  });
});
