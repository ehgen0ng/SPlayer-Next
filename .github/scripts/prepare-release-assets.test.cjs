"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");
const { prepareReleaseAssets, resolveChannel } = require("./prepare-release-assets.cjs");

const createArtifact = (dir, name, content) => {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return { url: name, sha512: Buffer.from(name).toString("base64"), size: content.length };
};

const writeManifest = (dir, name, version, asset) => {
  fs.writeFileSync(
    path.join(dir, name),
    yaml.dump({ version, files: [asset], path: asset.url, sha512: asset.sha512 }),
  );
};

const createFixture = (root, version, channel) => {
  const assets = [
    ["win-x64", `${channel}.yml`, "app-x64-setup.exe"],
    ["win-arm64", `${channel}.yml`, "app-arm64-setup.exe"],
    ["mac-x64", `${channel}-mac.yml`, "app-x64.zip"],
    ["mac-arm64", `${channel}-mac.yml`, "app-arm64.zip"],
    ["linux-x64", `${channel}-linux.yml`, "app-x86_64.AppImage"],
    ["linux-arm64", `${channel}-linux-arm64.yml`, "app-arm64.AppImage"],
  ];
  for (const [folder, manifest, assetName] of assets) {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    const asset = createArtifact(dir, assetName, Buffer.from(assetName));
    writeManifest(dir, manifest, version, asset);
  }
};

test("正式版生成 latest、beta 和 alpha 的完整更新清单", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-release-stable-"));
  try {
    const src = path.join(root, "artifacts");
    const out = path.join(root, "out");
    createFixture(src, "1.2.0", "latest");
    prepareReleaseAssets(src, out, "1.2.0");
    for (const channel of ["latest", "beta", "alpha"]) {
      for (const suffix of ["", "-mac", "-linux", "-linux-arm64"]) {
        assert.equal(fs.existsSync(path.join(out, `${channel}${suffix}.yml`)), true);
      }
    }
    const windows = yaml.load(fs.readFileSync(path.join(out, "latest.yml"), "utf8"));
    assert.equal(windows.files.length, 2);
    assert.equal(windows.path, "app-x64-setup.exe");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Beta 版生成 beta 和 alpha 清单", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-release-beta-"));
  try {
    const src = path.join(root, "artifacts");
    const out = path.join(root, "out");
    createFixture(src, "1.3.0-beta.1", "beta");
    prepareReleaseAssets(src, out, "1.3.0-beta.1");
    assert.equal(fs.existsSync(path.join(out, "beta.yml")), true);
    assert.equal(fs.existsSync(path.join(out, "alpha.yml")), true);
    assert.equal(fs.existsSync(path.join(out, "latest.yml")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Alpha 版只发布 alpha 清单", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-release-alpha-"));
  try {
    const src = path.join(root, "artifacts");
    const out = path.join(root, "out");
    createFixture(src, "1.4.0-alpha.1", "alpha");
    prepareReleaseAssets(src, out, "1.4.0-alpha.1");
    assert.equal(fs.existsSync(path.join(out, "alpha.yml")), true);
    assert.equal(fs.existsSync(path.join(out, "beta.yml")), false);
    assert.equal(fs.existsSync(path.join(out, "latest.yml")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Nightly 版只发布 nightly 清单", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-release-nightly-"));
  try {
    const src = path.join(root, "artifacts");
    const out = path.join(root, "out");
    createFixture(src, "1.4.0-nightly.270", "nightly");
    prepareReleaseAssets(src, out, "1.4.0-nightly.270");
    assert.equal(fs.existsSync(path.join(out, "nightly.yml")), true);
    assert.equal(fs.existsSync(path.join(out, "alpha.yml")), false);
    assert.equal(fs.existsSync(path.join(out, "beta.yml")), false);
    assert.equal(fs.existsSync(path.join(out, "latest.yml")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Fork 正式版保留版本号并生成 latest、beta 和 alpha 清单", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-release-fork-"));
  try {
    const src = path.join(root, "artifacts");
    const out = path.join(root, "out");
    const version = "1.2.1-fork.1";
    createFixture(src, version, "latest");
    prepareReleaseAssets(src, out, version, "Fork 正式版更新说明");
    assert.equal(resolveChannel(version), "latest");
    for (const suffix of ["", "-mac", "-linux", "-linux-arm64"]) {
      for (const channel of ["latest", "beta", "alpha"]) {
        const manifest = yaml.load(
          fs.readFileSync(path.join(out, `${channel}${suffix}.yml`), "utf8"),
        );
        assert.equal(manifest.version, version);
        assert.equal(manifest.files.length, suffix.startsWith("-linux") ? 1 : 2);
        assert.equal(manifest.releaseNotes, "Fork 正式版更新说明");
      }
      for (const channel of ["fork", "nightly"]) {
        assert.equal(fs.existsSync(path.join(out, `${channel}${suffix}.yml`)), false);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("发布工作流将 Fork 和无后缀正式版创建为草稿，Alpha 和 Beta 保持预发布", () => {
  const workflow = yaml.load(
    fs.readFileSync(path.join(__dirname, "../workflows/release.yml"), "utf8"),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-release-workflow-"));
  try {
    fs.mkdirSync(path.join(root, "release-assets"));
    fs.writeFileSync(path.join(root, "release-assets/app.exe"), "installer");
    for (const [version, channel, releaseFlag] of [
      ["1.2.1-fork.1", "latest", "--draft"],
      ["1.2.1-fork.2", "latest", "--draft"],
      ["1.2.1", "latest", "--draft"],
      ["1.3.0-alpha.1", "alpha", "--prerelease"],
      ["1.3.0-beta.1", "beta", "--prerelease"],
    ]) {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
      for (const job of [workflow.jobs.build, workflow.jobs.release]) {
        const envFile = path.join(root, "github-env");
        fs.writeFileSync(envFile, "");
        const metadataStep = job.steps.find((step) => step.name === "Verify release metadata");
        const metadata = spawnSync("bash", ["-c", metadataStep.run], {
          cwd: root,
          env: { ...process.env, RELEASE_TAG: `v${version}`, GITHUB_ENV: envFile },
          encoding: "utf8",
        });
        assert.equal(metadata.status, 0, metadata.stderr);
        assert.ok(fs.readFileSync(envFile, "utf8").includes(`UPDATE_CHANNEL=${channel}\n`));
      }
      const releaseStep = workflow.jobs.release.steps.find(
        (step) => step.name === "Create GitHub Release",
      );
      const argsFile = path.join(root, "release-args");
      const release = spawnSync(
        "bash",
        [
          "-c",
          `# 记录发布参数，避免测试访问 GitHub\ngh() {
            if [ "$1" = "view" ]; then return 1; fi
            printf '%s\\n' "$@" > "$RELEASE_ARGS_FILE"
          }\n${releaseStep.run}`,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            UPDATE_CHANNEL: channel,
            RELEASE_TAG: `v${version}`,
            GITHUB_REPOSITORY: "ehgen0ng/SPlayer-Next",
            RELEASE_ARGS_FILE: argsFile,
          },
          encoding: "utf8",
        },
      );
      assert.equal(release.status, 0, release.stderr);
      const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
      assert.deepEqual(args.slice(0, 3), ["release", "create", `v${version}`]);
      assert.ok(args.includes(releaseFlag));
      assert.equal(args.includes(releaseFlag === "--draft" ? "--prerelease" : "--draft"), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("拒绝未支持的预发布通道", () => {
  assert.throws(() => resolveChannel("1.3.0-rc.1"), /不支持的预发布版本格式/);
});

test("安卓 APK 随桌面资源归集且不进入桌面自动更新清单", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-release-android-"));
  try {
    const src = path.join(root, "artifacts");
    const out = path.join(root, "out");
    const name = "SPlayer-Next-1.2.1-fork.2-android-arm64-v8a-release.apk";
    createFixture(src, "1.2.1-fork.2", "latest");
    createArtifact(path.join(src, "android"), name, Buffer.from("signed-apk"));
    prepareReleaseAssets(src, out, "1.2.1-fork.2");
    assert.equal(fs.readFileSync(path.join(out, name), "utf8"), "signed-apk");
    for (const file of fs.readdirSync(out).filter((file) => file.endsWith(".yml"))) {
      const manifest = yaml.load(fs.readFileSync(path.join(out, file), "utf8"));
      assert.ok(manifest.files.every((asset) => !asset.url.endsWith(".apk")));
    }
    const workflow = yaml.load(
      fs.readFileSync(path.join(__dirname, "../workflows/release.yml"), "utf8"),
    );
    assert.ok(workflow.jobs.release.needs.includes("android"));
    assert.equal(workflow.jobs.android.with.release, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
