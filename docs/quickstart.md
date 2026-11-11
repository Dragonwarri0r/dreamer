# 快速开始

## 无 Key Demo

安装 Node 24.14–24.x；使用 nvm 的用户可在根目录执行 `nvm use`。然后：

```sh
npm ci
npm run demo
```

打开终端中的完整 URL。默认端口 4326，可用 `DREAMER_DEMO_PORT=4336 npm run demo` 修改（POSIX shell 示例）。

Demo 复用“城门选择”测试夹具。先选择一种行动，再点“模拟片段结束”；经过后续片段后看到结局。“再次模拟”可以重走路线。从导航可检查章节和节点。没有视频的逻辑模拟不等于媒体生成成功。

如需看视频内选择，运行 `npm run demo:media`。它生成 3 秒无声色块视频，打开后点“开始故事”和播放；不下载模型，不使用 TTS 或云服务。此可选路径需要可执行的 FFmpeg 和 ffprobe。

Demo 不读 `.env.local`，不使用持久数据根，禁用 Agent 和云端视频设置。即便本机已经登录或正在运行 Worker，也不会接入。正常按 Ctrl+C 关闭会清理本次临时目录；强制杀进程或断电可能留下系统临时目录，可根据启动日志自行清理。请勿在 Demo 保存唯一一份创作内容。

## 持久工作区

```sh
npm run build
npm start
```

打开 `http://127.0.0.1:4327`。默认 `data/workspace` 保存数据库和素材；不要与另一个 Host 同时使用同一数据根。

```sh
cp .env.example .env.local
# 编辑 .env.local 后：
npm run start:local
```

写作需准备自己的 Codex CLI / 登录，按 [平台写作](platform-writing.md) 使用；基础手工编辑无需登录。安装依赖或打开工作台不会自动生成。云端视频需用户自行启用并确认生成。

## 启动问题

| 现象 | 处理 |
|---|---|
| 找不到 `node:sqlite` 或版本报错 | 检查 `node --version`，使用 Node 24 |
| `EADDRINUSE` | 修改对应端口，不要结束其他进程 |
| 页面空白或前端不存在 | 在根目录执行 `npm run build`，再刷新 |
| `.env.local` 没生效 | 用 `npm run start:local` 并重启；普通 start 不加载 dotenv |
| FFmpeg 下载失败 | 指定可信本地 `DREAMER_FFMPEG` / `DREAMER_FFPROBE`；基础模拟无需媒体二进制 |
| 已有二进制，跳过 FFmpeg 下载 | 安装时用 `FFMPEG_BIN=/absolute/path/to/ffmpeg npm ci`；运行仍需设置 `DREAMER_FFMPEG` |
| `npm ci` 无网络 | 安装仍需 npm 包缓存或网络；“无 Key”不代表依赖已离线打包 |
| Demo 点击 Agent 提示不可用 | 预期行为；用持久工作区并配置自己的账户 |
| `h3:verify` 找不到下载证据 | 仍依赖原工程固定资产记录，尚非通用安装器 |

无法下载 FFmpeg 时，可用 `npm ci --ignore-scripts` 安装后试基础 Demo；这会跳过所有安装脚本，不能证明媒体和完整测试可运行。不要用 `--omit=dev` 安装此源码工作台：tsx、构建器与媒体工具目前位于 devDependencies。

## 数据备份

在界面创建备份，或恢复到不存在的新目录：

```sh
npm run restore -- /absolute/backup-directory /absolute/new-workspace
DREAMER_DATA_ROOT=/absolute/new-workspace npm start
```

备份排除凭据，恢复后需重新配置。备份仍包含正文和媒体，不是可以公开上传的源码包。未确认任务先核对原回执，不要重复生成。
