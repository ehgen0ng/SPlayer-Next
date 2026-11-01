#!/usr/bin/env python3
"""从固定官方源码构建 Android ARM64 Node 运行时，复用现有 Android NDK"""

import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import urllib.request

VERSION = "24.22.2"
SHA256 = "8fe2ec1723bb9f8d0b683907c82708debbeda64af21cb2aa214c4241eed0a061"
NDK_VERSION = "27.2.12479018"
SCRIPT_HASH = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
STAMP = f"{VERSION}:{SHA256}:ndk{NDK_VERSION}:{SCRIPT_HASH}"
ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "android" / "vendor"
DESTINATION = VENDOR / "node"


def run(arguments, directory, environment=None):
    """执行构建工具，直接保留输出与失败退出码
    @param arguments - 工具名称与独立参数
    @param directory - 工作目录
    @param environment - 可选构建环境
    """
    subprocess.run(arguments, cwd=directory, env=environment, check=True)


def replace_once(file, original, replacement):
    """为固定上游版本应用可重复的构建补丁
    @param file - 上游构建文件
    @param original - 已核对的原始片段
    @param replacement - 兼容宿主平台的替换片段
    """
    text = file.read_text()
    if original.startswith(" "):
        original = "\n" + original
        replacement = "\n" + replacement
    if replacement in text:
        return
    if text.count(original) != 1:
        raise RuntimeError(f"Node 构建文件与固定版本不符: {file}")
    file.write_text(text.replace(original, replacement))


if (DESTINATION / ".version").is_file() and (DESTINATION / ".version").read_text() == STAMP:
    print(f"Android Node {VERSION} 已就绪")
    sys.exit(0)

host = platform.system()
if host not in ("Darwin", "Linux"):
    raise RuntimeError("Node 24 安卓运行时从源码构建需要 macOS 或 Linux，Windows 请在 WSL 中构建")
sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
if not sdk:
    raise RuntimeError("缺少 ANDROID_HOME 或 ANDROID_SDK_ROOT")
ndk = Path(sdk) / "ndk" / NDK_VERSION
host_tag = "darwin-x86_64" if host == "Darwin" else "linux-x86_64"
bin_dir = ndk / "toolchains" / "llvm" / "prebuilt" / host_tag / "bin"
if not (bin_dir / "aarch64-linux-android24-clang++").is_file():
    raise RuntimeError(f"缺少 Android NDK {NDK_VERSION}: {ndk}")
VENDOR.mkdir(parents=True, exist_ok=True)
archive = VENDOR / f"node-v{VERSION}.tar.xz"
if not archive.exists():
    print(f"下载 Node {VERSION} 官方源码", flush=True)
    partial = archive.with_suffix(".part")
    with urllib.request.urlopen(f"https://nodejs.org/dist/v{VERSION}/{archive.name}", timeout=120) as response:
        with partial.open("wb") as output:
            shutil.copyfileobj(response, output)
    partial.replace(archive)
with archive.open("rb") as stream:
    hasher = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        hasher.update(chunk)
    digest = hasher.hexdigest()
if digest != SHA256:
    raise RuntimeError(f"Node 源码 SHA-256 不符，请删除后重试: {archive}")
source = VENDOR / f"node-v{VERSION}"
if not source.exists():
    run(["tar", "-xf", str(archive)], VENDOR)
source = source.resolve()

# 上游 Android 构建假定 Linux 宿主，明确区分 macOS 工具和 Android 目标
if host == "Darwin":
    uv = source / "deps/uv/uv.gyp"
    replace_once(uv, '[ \'OS in "mac ios"\', {',
                 '[ \'OS in "mac ios" or (_toolset=="host" and host_os=="mac")\', {')
    replace_once(uv, '[ \'OS=="android"\', {',
                 '[ \'OS=="android" and not (_toolset=="host" and host_os=="mac")\', {')
    replace_once(uv, '[ \'OS in "ios mac freebsd dragonflybsd openbsd netbsd".split()\', {',
                 '[ \'OS in "ios mac freebsd dragonflybsd openbsd netbsd".split() or (_toolset=="host" and host_os=="mac")\', {')
    replace_once(source / "tools/v8_gypfiles/v8.gyp", '''            ['_toolset=="host"', {
              'sources': [
                '<(V8_ROOT)/src/base/debug/stack_trace_posix.cc',
                '<(V8_ROOT)/src/base/platform/platform-linux.cc',
              ],
            }, {''', '''            ['_toolset=="host"', {
              'conditions': [
                ['host_os=="linux"', {
                  'sources': [
                    '<(V8_ROOT)/src/base/debug/stack_trace_posix.cc',
                    '<(V8_ROOT)/src/base/platform/platform-linux.cc',
                  ],
                }],
              ],
            }, {''')

# 为宿主 V8 快照工具补齐 POSIX 信号处理，目标 Android 保留上游配置
replace_once(source / "tools/v8_gypfiles/v8.gyp", '                [\'((_toolset=="host" and host_arch=="arm64" or _toolset=="target" and target_arch=="arm64") and (OS in "linux mac ios openharmony")) or ((_toolset=="host" and host_arch=="x64" or _toolset=="target" and target_arch=="x64") and (OS in "linux mac openharmony"))\', {', '                [\'((_toolset=="host" and host_arch=="arm64" or _toolset=="target" and target_arch=="arm64") and (OS in "linux mac ios openharmony" or (_toolset=="host" and host_os in "linux mac"))) or ((_toolset=="host" and host_arch=="x64" or _toolset=="target" and target_arch=="x64") and (OS in "linux mac openharmony" or (_toolset=="host" and host_os in "linux mac")))\', {')
replace_once(source / "tools/v8_gypfiles/v8.gyp", '                [\'(_toolset=="host" and host_arch=="x64" or _toolset=="target" and target_arch=="x64") and (OS in "linux mac win openharmony")\', {', '                [\'(_toolset=="host" and host_arch=="x64" or _toolset=="target" and target_arch=="x64") and (OS in "linux mac win openharmony" or (_toolset=="host" and host_os in "linux mac"))\', {')

# zlib 的 Android CPU 探测实现直接使用同一 NDK 自带源码
cpu_dir = source / "deps/zlib/ndk-cpufeatures"
cpu_dir.mkdir(exist_ok=True)
for filename in ("cpu-features.c", "cpu-features.h"):
    shutil.copyfile(ndk / "sources/android/cpufeatures" / filename, cpu_dir / filename)
original = '''            ['OS=="mac" or OS=="ios" or OS=="freebsd" or OS=="android"', {'''
replace_once(source / "deps/zlib/zlib.gyp", original, '''            ['OS=="android"', {
              'sources': ['ndk-cpufeatures/cpu-features.c'],
            }],
''' + original)

environment = dict(os.environ)
environment.update({
    "CC": str(bin_dir / "aarch64-linux-android24-clang"),
    "CXX": str(bin_dir / "aarch64-linux-android24-clang++"),
    "AR": str(bin_dir / "llvm-ar"),
    "RANLIB": str(bin_dir / "llvm-ranlib"),
    "CC_host": "clang" if host == "Darwin" else "gcc",
    "CXX_host": "clang++" if host == "Darwin" else "g++",
    "AR_host": "ar",
    "GYP_GENERATORS": "make",
    "GYP_DEFINES": "target_arch=arm64 v8_target_arch=arm64 android_target_arch=arm64 "
                   f'host_os={"mac" if host == "Darwin" else "linux"} OS=android android_ndk_path="{ndk}"',
    "LDFLAGS": "-Wl,-z,max-page-size=16384",
})
run([sys.executable, "configure.py", "--dest-cpu=arm64", "--dest-os=android", "--cross-compiling",
     "--shared", "--with-intl=full-icu", "--without-node-snapshot", "--without-node-code-cache",
     "--without-npm", "--without-corepack", "--openssl-no-asm"], source, environment)
arguments = ["make", "-C", "out", "BUILDTYPE=Release", f"-j{min(6, os.cpu_count() or 2)}", "libnode"]
if host == "Darwin":
    # Darwin 归档和链接器不接受 GNU thin archive 与 group 参数
    ar = source / "splayer-host-ar.py"
    ar.write_text(f'''#!{sys.executable}
# 使用同一 NDK 生成 macOS 宿主归档
import os, sys
program = {str(bin_dir / "llvm-ar")!r}
args = [value.replace("T", "") if index == 0 else value for index, value in enumerate(sys.argv[1:])]
os.execv(program, [program, "--format=darwin", *args])
''')
    linker = source / "splayer-host-link.py"
    linker.write_text(f'''#!{sys.executable}
# 补齐 macOS 系统框架并过滤 GNU 链接器参数
import os, sys
args = [value for value in sys.argv[1:] if value not in ("-Wl,--start-group", "-Wl,--end-group")]
os.execvp("clang++", ["clang++", *args, "-framework", "CoreFoundation"])
''')
    ar.chmod(0o755)
    linker.chmod(0o755)
    arguments += [f"AR.host={ar}", f"LINK.host={linker}"]
run(arguments, source, environment)

staging = VENDOR / "node.partial"
if staging.exists():
    shutil.rmtree(staging)
staging.mkdir()
run([sys.executable, "tools/install.py", "install", "--headers-only", "--dest-dir", str(staging),
     "--prefix", "", "--silent"], source)
library = staging / "bin/arm64-v8a/libnode.so"
library.parent.mkdir(parents=True)
shutil.copyfile(source / "out/Release/libnode.so", library)
run([str(bin_dir / "llvm-strip"), "--strip-unneeded", str(library)], source)
shutil.copyfile(source / "LICENSE", staging / "LICENSE")
shutil.copyfile(ndk / "sources/android/cpufeatures/NOTICE", staging / "NOTICE-NDK")
(staging / ".version").write_text(STAMP)
if DESTINATION.exists():
    shutil.rmtree(DESTINATION)
staging.rename(DESTINATION)
print(f"Android Node {VERSION} 已就绪: {library.relative_to(staging)}")
