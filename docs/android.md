# 安卓车机版

本页介绍 SPlayer-Next 安卓车机版的平台差异、安装方式与构建说明。日常操作见 [使用指南](/guide)，插件安装与管理见 [插件使用指南](/plugins-usage)。

## 安装与更新

当前仅提供 **ARM64（`arm64-v8a`）** APK，最低声明支持 Android 7 / API 24。设备需允许侧载应用，界面兼容性取决于系统 WebView 版本。

将 APK 安装到设备后，打开应用即可使用。安卓端不使用桌面自动更新模块，更新时需安装新的 APK。

## 与桌面版的差异

| 项目     | 安卓端说明                                                                  |
| -------- | --------------------------------------------------------------------------- |
| 账号登录 | 支持二维码与 Cookie，不提供桌面版的登录窗口                                 |
| 文件选择 | 导入插件时使用 Android 系统文档选择器                                       |
| 歌曲缓存 | 使用 Media3 自动播放缓存，设置中提供容量调整与清理入口                      |
| 音频输出 | 由 Android 系统管理，无法获取系统混音后的最终硬件格式，重采样状态显示为未知 |

安卓端按实际能力显示设置与工具栏，暂不提供以下桌面功能：

- **本地文件**：本地音乐扫描、U 盘与内存卡曲库、手动下载、文件导出、标签编辑与云盘上传
- **流媒体服务器**：Navidrome、Jellyfin、Emby 等自建服务
- **桌面集成**：桌面歌词、灵动岛、任务栏、托盘、窗口管理与全局快捷键
- **音频处理**：AutoMix、交叉过渡、桌面均衡器、音调调整与 AB 循环
- **其他功能**：定时关闭、听歌识曲、海报导出、Discord、AI、MCP、外部 API、WebSocket 与局域网控制

## 车机集成

安卓端通过 `MediaSessionService` 对接系统媒体控制。方向盘按键映射、导航播报与电话音频抢占的实际行为取决于车机固件。

### 比亚迪语音控制

播放服务启动时会向车机语音服务登记默认音乐候选，支持以下指令：

- 按歌名或歌手点歌，以及播放、暂停、上一首、下一首
- 切换单曲循环、随机与列表循环
- 跳转进度、快进与快退
- 查询当前曲目、播放状态与进度

语音点歌使用界面最后选择的音乐平台，可直接在后台搜索和播放。收藏、推荐歌单等指令暂不支持。

安装后先打开应用一次，再到车机默认应用设置查看音乐列表；若可选择 SPlayer，设为默认音乐后测试语音指令与后台控制。

::: warning 固件兼容性
默认音乐名单与后台唤起权限取决于车机固件。标准媒体控制可用时，厂商桌面的音源列表和语音助手仍可能限制第三方应用接入，需在实际设备确认。
:::

## 本地构建

安卓端复用现有 Vue 应用与后台业务，使用 Capacitor 容器、嵌入式 Node 和 Media3，不编译桌面的 Rust / FFmpeg 模块。

### 环境要求

Node.js 与 pnpm 要求见 [贡献指南](/contributing)，pnpm 版本以根 `package.json` 的 `packageManager` 为准。另需安装：

| 工具                    | 版本或要求                    |
| ----------------------- | ----------------------------- |
| Python 与 C/C++ 工具链  | Python 3 及运行时源码构建工具 |
| JDK                     | 21                            |
| Android SDK Platform    | 36                            |
| Android SDK Build Tools | 36.0.0                        |
| Android NDK             | 27.2.12479018                 |
| CMake                   | 3.22.1                        |

设置 `JAVA_HOME` 和 `ANDROID_HOME`，安装 SDK Platform Tools 并接受 SDK 许可证。运行时源码构建支持 macOS 与 Linux，Windows 可通过 WSL 执行。

### 构建与调试

```bash
# 安装根项目依赖并构建调试 APK
pnpm install --frozen-lockfile
pnpm build:android
```

产物位于 `dist/android/SPlayer-Next-<版本>-android-arm64-v8a-debug.apk`。将下方路径替换为本次构建的 APK 路径，即可安装到已通过 adb 连接的设备：

```bash
# 安装调试 APK
adb install -r "<调试 APK 路径>"
```

```bash
# 启动热更新，并自动安装和打开已连接设备上的应用
pnpm dev:android
```

开发模式通过 `adb reverse` 连接本机 `14559` 端口，Vue 修改自动更新；Node、Java 或 C/C++ 修改后需重新运行命令。独立 APK 包含网页与 Node 资源，不依赖开发电脑。

首次构建会下载固定版本的 Node 源码并校验 SHA-256，再通过 NDK 编译嵌入式运行时；后续复用 `android/vendor/node`，首次编译耗时较长。

### 安卓检查

```bash
# 检查安卓后台类型并运行原生测试与 Android lint
pnpm typecheck:android
./android/gradlew -p android :app:testDebugUnitTest :app:lintDebug
```

通用类型检查、测试与代码约定沿用 [贡献指南](/contributing)。

## 自动构建

`ci.yml` 与 `dev.yml` 构建调试 APK，`release.yml` 构建签名 APK 并随桌面安装包一起发布。构建产物名为 `SPlayer-Next-android-arm64-v8a`，APK 不进入桌面自动更新清单。

## 兼容性

实际运行验证环境为 Android 15 / API 35 ARM64 模拟器，覆盖安装启动与核心播放链路。其他 Android 版本、系统 WebView 与车机固件仍需实机验证；账号登录、各平台完整歌单与 FM 续推等联网路径尚未完成完整验收。

Node 运行时、JNI 与 SQLite 已使用 16 KiB ELF 段对齐，实际运行验证环境仍为 4 KiB 页，16 KiB 页设备需单独验收。车机长时间后台播放、休眠唤醒与断电恢复也需实车确认。
