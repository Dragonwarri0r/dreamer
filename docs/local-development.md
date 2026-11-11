# 本地开发与调试

使用 Node 24.14–24.x。在根目录 `npm ci` 后运行 `npm run build`；Host 同时提供 API 和已构建的前端。普通回归不需要真实模型或个人 Key。

## 日常调试

建议将调试数据与正在使用的创作工程分开。第一次复制 `.env.example` 为 `.env.local`，把 `DREAMER_DATA_ROOT` 改为 `data/dev`，端口可选未占用的 4336，然后：

```sh
npm run build
npm run start:local
```

按配置端口打开工作台。`start:local` 读取 `.env.local`；`npm start` 和 `npm run dev` 使用 shell 环境变量，不会自动加载 dotenv。shell 中已经设置的变量优先，出现端口或数据根与文件不符时检查当前终端环境。

| 修改内容 | 生效方式 |
|---|---|
| Studio TSX / CSS | 另一个终端 `npm run build`，浏览器刷新 |
| Host / contracts / core / infra | 停止本次 Host 并重新启动；合约同时影响前端时也重新 build |
| `.env.local` | 重启 `start:local` |
| 写作 Skill 运行源 | 重新导出 Skill 视图并重启 Host；旧轮次仍保留旧快照 |

`npm run dev` 是普通 Host 启动别名，当前没有 HMR。不要把直接运行 Vite 的 5173 端口当作已支持的完整工作台：API 的 Host、同源和 Cookie 校验以 Host 端口为准。当前可靠路径是构建后由 Host 提供页面，不能为了代理调试放宽 CSRF 校验。

## TypeScript 断点

先停止使用同一数据根和端口的 Host，再以 inspector 启动：

```sh
node --inspect=127.0.0.1:9229 --env-file=.env.local --import tsx apps/host/main.ts
```

用 Chrome 的 `chrome://inspect` 或编辑器的 Node Attach 连接 9229，在 `apps/host/*.ts` 或 `packages/*/*.ts` 设置断点；tsx 提供源映射。需要启动即暂停时将 `--inspect` 改为 `--inspect-brk`。端口冲突就换一个本机端口，不能把调试器绑定到公网。

## MCP 连接调试

按 [README 快速接入](../README.md#本地-codex--其他-agent-快速接入) 配置。客户端的 `DREAMER_URL` 要和 Host 端口一致；`DREAMER_NODE_BIN` 指向符合要求的 Node。脚本自行切换到工程目录，可以从别的工作目录启动，stdout 只用于 JSON-RPC，诊断走 stderr。

先列工具，再只读调用 `dreamer_writing_projects`。这验证了 MCP → Host 的真实连接，但不等于真实模型写作通过。若无法列工程，先检查 Host、端口和 Node 路径，不要为排查重复提交写作请求。启动真实写作后遇到未知结果，查询原 `requestKey` 的 receipt。

## 回归入口

```sh
npm run check
npm run source:check
npm audit
npm run demo
# 关闭基础 Demo 后：
npm run demo:media
```

Demo 使用临时数据；普通 Host 在重启后保留自己的数据库。浏览器及真实 Provider 测试的范围不同，真实模型/付费调用必须另外明确授权。本轮依赖升级和调试结果见 [回归记录](dependency-upgrade-20261102.md)。

扩展浏览器回归需安装本机 Chrome，脚本目前使用 macOS 应用路径。`test:consumer-ux-state` 与 `test:consumer-ui` 默认引用维护者历史素材，新环境需显式设置 `DREAMER_CONSUMER_MEDIA` 为本机测试 MP4；可以使用 FFmpeg 色块素材，无需生成模型视频。测试输出放在 `test-results/`，重跑历史验收时应指定新的输出目录或使用独立源码副本。`test:video-worker` 的 Python 环境限制见 [配置说明](configuration.md#可选媒体-worker)。
