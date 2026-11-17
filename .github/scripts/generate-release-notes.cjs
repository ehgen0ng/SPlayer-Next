#!/usr/bin/env node
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");

const [releasesFile, notesFile] = process.argv.slice(2);
const { RELEASE_TAG: currentTag, GITHUB_REPOSITORY: repository } = process.env;
if (!releasesFile || !notesFile || !currentTag || !repository) {
  throw new Error("需要发布列表文件、输出文件及 RELEASE_TAG、GITHUB_REPOSITORY 环境变量");
}

const currentRef = `refs/tags/${currentTag}`;
const releases = JSON.parse(readFileSync(releasesFile, "utf8"))
  .flat()
  .filter(
    (release) =>
      !release.draft &&
      !release.prerelease &&
      release.tag_name.startsWith("v") &&
      release.tag_name !== currentTag,
  )
  .sort((a, b) => b.published_at.localeCompare(a.published_at));

let previousTag;
for (const release of releases) {
  // 重跑旧版本时，后续版本和其他分支上的发布不能作为起点
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `refs/tags/${release.tag_name}`, currentRef],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 1) continue;
  if (result.status !== 0) throw new Error(result.stderr);
  previousTag = release.tag_name;
  break;
}

const repositoryUrl = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repository}`;
const range = previousTag ? `refs/tags/${previousTag}..${currentRef}` : currentRef;
const entries = execFileSync("git", ["log", "-z", "--format=%H%x00%B", range, "--"], {
  encoding: "utf8",
}).split("\0");
const commits = [];
for (let index = 0; index < entries.length - 1; index += 2) {
  const sha = entries[index];
  // 部分旧提交的正文没有空行分隔，%s 会把正文拼进标题
  const title = entries[index + 1].split(/\r?\n/, 1)[0].replace(/([\\`*_[\]<>])/g, "\\$1");
  commits.push(`- ${title} ([${sha.slice(0, 7)}](${repositoryUrl}/commit/${sha}))`);
}

const notes = [
  commits.join("\n") || "本次发布没有新增提交",
  "",
  ...(previousTag
    ? [
        `**Full Changelog**: [${previousTag}...${currentTag}](${repositoryUrl}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(currentTag)})`,
        "",
      ]
    : []),
].join("\n");

writeFileSync(notesFile, notes, "utf8");
console.log(`已生成发布说明：${previousTag || "首次发布"} → ${currentTag}`);
