#!/usr/bin/env python3
"""校验并解压仓库内固定版本的 Android Node 运行时"""

import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
RUNTIMES = ROOT / "android" / "runtime"
runtime = json.loads((RUNTIMES / "manifest.json").read_text())
archive = RUNTIMES / runtime["archive"]
destination = ROOT / "android" / "vendor" / "node"

with archive.open("rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
if digest != runtime["sha256"]:
    raise RuntimeError(f"Node 运行时压缩包 SHA-256 不符: {archive}")

stamp = destination / ".version"
if not (stamp.is_file() and stamp.read_text() == digest
        and (destination / "libnode.so").is_file()
        and (destination / "include/node/node.h").is_file()):
    with tempfile.TemporaryDirectory(prefix="splayer-node-") as directory:
        staging = Path(directory)
        with tarfile.open(archive) as package:
            package.extractall(staging, filter="data")
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(staging, destination)
        # 最后写入校验标记，同时让 CMake 感知运行时更新
        stamp.write_text(digest)

print(f"Android Node {runtime['version']} (arm64-v8a) 已就绪，复用仓库预编译包")
