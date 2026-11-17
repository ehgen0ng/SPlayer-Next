"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("发布说明只收录上次正式发布之后、当前标签以内的提交", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-release-notes-"));
  /**
   * 在临时仓库执行 Git 命令
   * @param {...string} args - Git 参数
   * @returns {string} 命令输出
   */
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  /**
   * 生成已发布版本的 API 记录
   * @param {string} tag - 发布标签
   * @param {number} day - 发布时间在测试月份中的日期
   * @param {object} overrides - 草稿和预发布状态覆盖
   * @returns {object} 发布记录
   */
  const release = (tag, day, overrides = {}) => ({
    tag_name: tag,
    published_at: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
    draft: false,
    prerelease: false,
    ...overrides,
  });
  const input = path.join(root, "releases.json");
  const output = path.join(root, "notes.md");
  /**
   * 运行实际脚本并读取生成的说明
   * @param {object[][]} pages - 分页发布记录
   * @param {string} tag - 本次发布标签
   * @returns {string} 发布说明
   */
  const generate = (pages, tag = "v1.1.0-fork.1") => {
    fs.writeFileSync(input, JSON.stringify(pages));
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "generate-release-notes.cjs"), input, output],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          RELEASE_TAG: tag,
          GITHUB_REPOSITORY: "example/player",
          GITHUB_SERVER_URL: "https://github.com",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(output, "utf8");
  };

  try {
    git("init", "--quiet");
    git("config", "user.name", "Release Test");
    git("config", "user.email", "release-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    git("commit", "--allow-empty", "-m", "chore: 旧版本内容");
    git("tag", "v1.0.0");
    git("commit", "--allow-empty", "-m", "✨ feat: 新功能\n正文不应进入标题");
    const featureSha = git("rev-parse", "HEAD");
    git("tag", "v1.0.1");
    git("commit", "--allow-empty", "-m", "🐛 fix: 修复问题");
    git("tag", "v1.1.0-beta.1");
    git("tag", "v1.0.2");
    git("commit", "--allow-empty", "-m", "docs: 更新 [说明] <示例>");
    git("tag", "v1.1.0-fork.1");
    git("commit", "--allow-empty", "-m", "feat: 后续版本内容");
    git("tag", "v2.0.0");
    git("checkout", "--quiet", "--detach", "v1.0.0");
    git("commit", "--allow-empty", "-m", "fix: 其他分支内容");
    git("tag", "v3.0.0");

    const notes = generate([
      [release("v1.1.0-fork.1", 5), release("v1.0.2", 4, { draft: true })],
      [
        release("v1.0.0", 1),
        release("v1.1.0-beta.1", 3, { prerelease: true }),
        release("v2.0.0", 6),
        release("v3.0.0", 7),
      ],
    ]);
    assert.equal(notes.split("\n").filter((line) => line.startsWith("- ")).length, 3);
    assert.ok(
      notes.includes(
        `- ✨ feat: 新功能 ([${featureSha.slice(0, 7)}](https://github.com/example/player/commit/${featureSha}))`,
      ),
    );
    assert.ok(notes.includes("docs: 更新 \\[说明\\] \\<示例\\>"));
    assert.doesNotMatch(notes, /旧版本内容|后续版本内容|其他分支内容|正文不应进入标题/);
    assert.ok(notes.startsWith("- "));
    assert.ok(
      notes.includes(
        "**Full Changelog**: [v1.0.0...v1.1.0-fork.1](https://github.com/example/player/compare/v1.0.0...v1.1.0-fork.1)",
      ),
    );

    const firstRelease = generate([[]]);
    assert.ok(firstRelease.includes("旧版本内容"));
    assert.doesNotMatch(firstRelease, /后续版本内容|其他分支内容|Full Changelog/);

    git("tag", "v1.0.0-fork.1", "v1.0.0");
    const unchanged = generate([[release("v1.0.0", 1)]], "v1.0.0-fork.1");
    assert.ok(unchanged.includes("本次发布没有新增提交"));
    assert.ok(unchanged.includes("/compare/v1.0.0...v1.0.0-fork.1"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
