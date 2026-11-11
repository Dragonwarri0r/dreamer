# 配置与本地数据

以当前代码为准，更新于 2026-11-11。复制 `.env.example` 为 `.env.local` 后用 `npm run start:local` 加载；已有 shell 环境变量优先。

| 配置 | 默认值与用途 |
|---|---|
| `DREAMER_DATA_ROOT` | `data/workspace`；数据库、媒体、导出和会话目录 |
| `DREAMER_PORT` | `4327`；Host 固定监听 `127.0.0.1` |
| `DREAMER_DEMO_PORT` | `4326`；只影响独立 Demo |
| `DREAMER_CODEX_BIN` | PATH 中的 codex，以及代码中的兼容应用路径 |
| `DREAMER_AGENT_MODEL` | 可选写作模型覆盖；未指定则读取用户配置顶层模型偏好 |
| `DREAMER_AGENT_REASONING_EFFORT` | 可选推理强度；以 CLI 实际接受并确认的配置为准 |
| `DREAMER_RUNTIME_TEXT` | `disabled`；可显式设置 `local` 或 `codex` |
| `DREAMER_RUNTIME_TEXT_URL` | `http://127.0.0.1:1234/v1`；仅回环，不跟随重定向 |
| `DREAMER_RUNTIME_TEXT_MODEL` | 本机服务的准确模型 ID，无默认模型 |
| `DREAMER_FFMPEG` / `DREAMER_FFPROBE` | 可信媒体二进制绝对路径；也可使用安装的 npm 媒体依赖 |
| `DREAMER_URL` | MCP 连接地址；示例为 `http://127.0.0.1:4327`，须匹配 Host |
| `DREAMER_WRITING_CLIENT_ID` | 稳定客户端身份，不是密码；不同客户端使用不同值 |
| `DREAMER_NODE_BIN` | stdio MCP 启动器使用的 Node 可执行文件；默认 PATH 中的 node，桌面客户端建议显式填写 Node 24 的绝对路径 |

MCP 示例脚本和 Node 路径须改为自己的绝对路径。适配器和 Host 默认端口现在均为 4327；既有 Host 若运行在 4330 等自定义端口，继续显式填写对应 `DREAMER_URL`。客户端需先启动 Host；连接到离线 Demo 不会启用真实写作。MCP 不自动读取 `.env.local`，启动参数应放在客户端的 env 配置里。

中文媒体渲染使用系统字体：macOS PingFang 或 Ubuntu / Debian Noto Sans CJK；Linux 需要安装完整 FFmpeg 与字体，见 [安装说明](quickstart.md#linux-媒体与字体)。字体、FFmpeg 二进制均不随源码分发。

## Key 保存位置

- 云视频：`<data-root>/credentials/video-providers.json`。目录权限 0700，文件 0600；是本机明文存储，不是加密保险箱。
- 设置 GET 只返回 configured 等状态，不返回 Key；格式错误不回显配置原文。留空保存保留旧 Key，明确“移除 Key”才删除。
- Codex：调用 Agent 时从 `CODEX_HOME` 或默认配置目录读取 `auth.json`，在工作区会话目录建立符号链接。不要解引用打包或上传运行目录。
- Worker token、模型路径、日志和原始回执位于 `.local/` 或显式指定的本地目录。
- `.env.local`、`data/`、`.local/`、凭据、数据库和备份已被 `.gitignore` 排除。自定义的数据根若位于仓库中，也必须确认不会进入提交。

Git 忽略规则不能清除已经跟踪的文件和旧提交。发布前使用 `source:check`，另行扫描全部 Git 历史。截图、Issue 附件与备份也可能含私人内容。

## 可选媒体 Worker

LTX 使用 `DREAMER_VIDEO_PYTHON`、`DREAMER_MODEL_MANIFEST`、`DREAMER_VIDEO_DATA`（`.local/video-worker`）和 `DREAMER_VIDEO_PORT`（4328）。Python 与模型清单默认路径仍指向相邻的 `short-dreamer`，新用户必须自行配置。见 [LTX](../workers/video/README.md)。

H3 使用 `DREAMER_H3_MODEL`、`DREAMER_H3_RUNTIME`、`DREAMER_H3_MANIFEST`、`DREAMER_H3_DATA`（`.local/h3-worker`）和 `DREAMER_H3_PORT`（4329）。**仅修改路径仍不足以完成新环境安装**：校验读取相邻工程的历史下载记录，通用下载与校验入口尚待整理。见 [H3](../workers/h3/README.md)。

Worker 不由 Demo 自动启动，不自动下载或替换模型，也不自动切换付费服务。模型授权与硬件要求分别确认。`test:video-worker` 也依赖相邻 Python 环境，尚非新用户通用验证命令。
