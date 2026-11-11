# 依赖安全升级与本地回归

日期：2026-11-02。本轮修复此前审计的 3 个受影响依赖包，不提交、不推送，不修改个人凭据或创作数据库。

| 包 | 升级前 | 升级后 |
|---|---|---|
| Vite | 7.3.1 | 7.3.7 |
| Zod | 4.3.6 | 4.6.7 |
| tsx | 4.21.0 | 4.23.15 |
| esbuild（传递依赖） | 0.27.7 | 0.28.2 |

tsx 升级用于解除对 esbuild 0.27 的限制。Vite 与 tsx 使用同一个锁定的 esbuild，无强制 overrides。升级后首次审计与干净安装副本的最终 `npm audit --json` 均为 **0 项漏洞**，包括 high / critical 均为 0。此结论是本次漏洞库快照，发布当天仍需复查。

## 兼容与调试修正

Zod 修复后会在遍历元素前拒绝超过上限的集合。原诊断测试用 40 个场景触发多个字段错误，而 schema 上限是 20；现在以 20 个场景内的多个无效字段继续验证诊断最多 32 条及脱敏，并增加超限场景不读取元素字段的回归。没有放宽集合上限或删除错误保护。

JSON Schema 已从新运行契约重新导出：命令与写作协议保持语义相同，互动协议的日期时间正则要求秒字段，与工程通过 `toISOString()` 生成的时间一致。

本地接入默认端口统一为 4327；自定义 Host 端口仍由 `DREAMER_URL` 显式指定。MCP 启动器可用 `DREAMER_NODE_BIN` 锁定 Node 24，并在不符合版本时给出 stderr 提示。README 前部补充 Codex CLI、通用 stdio JSON 与 Codex TOML 示例。

扩展浏览器回归首次暴露 3 份测试脚本的过期前提，已修正并保留失败记录：

- `browser-check` 使用当前“按主题一起构思”按钮，验证它不直接提交；场景写入夹具显式选择“故事与剧本”。H3 初始预览规格更新为已有产品行为的 320×576，并继续验证 Turbo / Quality 切换及禁止空描述提交。
- `browser-agent-audit` 的队列检查显式选择支持排队的通用创作方法。写作模式本来就需要等待当前轮完成，不能用它测试通用会话排队。丢响应回执恢复、输入接管、跨视图锁和停止队列的原断言保留。
- `browser-responsive` 在窗口变宽后等待 React 完成布局更新，再断言双编辑组；保留小屏、浮窗与溢出检查。

## 验证结果

环境为 macOS arm64、Node 24.14.0 和本机 Chrome。使用白名单导出到独立目录，重新 `npm ci` 安装 52 个包；副本没有既有 node_modules、个人创作数据或 `.local` 凭据。

| 检查 | 结果 |
|---|---|
| 工作区与干净副本 `npm run check` | 均通过：286/286 测试、类型、前端构建、领域边界 |
| 修改浏览器脚本后的类型检查 | 通过 |
| Python Worker 单元测试 | 12/12；使用本机既有 Python 环境，不加载模型 |
| 全部 21 个无需真实模型的浏览器回归脚本 | 最终全部通过；包含首次失败后修正的 3 项 |
| `npm run demo` | 真正从 npm 启动，选择 → 后续片段 → 结局通过 |
| `npm run demo:media` | 真正从 npm 启动，FFmpeg 视频播放、选择与结局通过 |
| Demo 隔离 | 两种模式均无页面错误、无外部请求；未使用传入的个人数据根；退出后临时数据清理 |
| `npm run dev` | 构建后的 UI/API 可用、网页创建工程成功；未认证 API 仍返回 403 |
| `npm run start:local` | 读取 `.env.local` 的端口和数据根；换端口重启后工程仍在 |
| Node inspector + tsx | 可连接、存在原始 TS 源映射；HTTP 请求命中断点，继续后正常返回；三个测试 Host 均释放端口 |
| MCP | 从工程外目录、精简 PATH 与显式 Node 启动，完成初始化、列 5 个工具和只读列工程；未创建 Agent 会话 |
| Skill 生成视图 | 与运行指令一致 |
| 公开范围检查 | 277 个候选文件，有限敏感规则 0 命中；没有 Git 历史可扫描 |
| 最终 npm audit | 0 项漏洞 |

浏览器脚本覆盖：`test:browser`、`test:journey`、`test:longform`、`test:preview`、`test:agent-ui`、`test:responsive`、`test:journey-audit`、`test:context`、`test:production-input`、`test:interactive-script`、`test:interactive-playback`、`test:interactive-archive`、`test:interactive-adoption`、`test:consumer`、`test:consumer-recovery`、`test:consumer-library`、`test:consumer-ux-state`、`test:ux-layout`、`test:author-ux`、`test:consumer-ui`、`test:author-ui`。

## 证据与边界

验证证据存放于维护者的 `test-results/dependency-upgrade-20261102/`，与前次审计分开，不进入公开候选包。`final-report.json` 汇总结果；`npm-audit-final.json`、`clean-check.log`、`worker-tests.log`、`demo-browser-report.json`、`debug-report.json`、各浏览器日志与截图保留原始证据。

消费侧脚本通过 `DREAMER_CONSUMER_MEDIA` 使用本轮新生成的 124 帧 FFmpeg 色块/音调夹具。部分历史报告模板仍写着“复用 H3 / v11”，本轮应以汇总中记录的夹具来源为准，没有验证真实 H3 视频质量。真实模型调用、付费请求均为 0；没有改动全局 Codex 配置、个人 Key 或创作数据库。

构建有非阻断提示：Zod 上游注释的 tree-shaking 注解位置，以及现存大 chunk 提示。未验 Linux/Windows、原生手机或真实模型质量。Python Worker 测试的默认命令仍依赖相邻工程环境，部分浏览器脚本需显式提供测试媒体；完整 Worker 安装可迁移性继续列在开源待办中。这些不影响已验证的基础工作台和两种 Demo。
