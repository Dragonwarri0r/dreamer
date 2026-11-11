# 贡献与开发

使用 Node 24.14–24.x，执行 `npm ci`、`npm run check` 和 `npm run source:check`。完整媒体测试需要 FFmpeg / ffprobe。`npm audit` 需要联网，审计告警不能以其他测试通过抵消。

Host 与 Studio 同仓；日常入口为 `npm start`，前端修改后 `npm run build`。核心领域不得直接依赖基础设施，浏览器不得导入 Host 实现，边界脚本在 check 中执行。

修改应包含可复现问题、用户可见结果、必要的回归检查与限制。已有对象保持版本检查、幂等回执和提案审阅语义；断线或未知结果先查原回执，不换请求 ID 重复生成。工程内创作遵循 `AGENTS.md` 的平台写作约定。

测试使用隔离数据。浏览器脚本目前默认本机 Chrome，部分历史脚本会引用本地媒体或默认输出目录，运行前读明用途并用独立输出目录保存新证据。真实 Agent、图像、视频或算力验收不能隐式加入普通 CI。

发布候选文件由 `config/public-source.json` 管理。新增公开入口时更新清单；导出的副本应能独立安装、构建和启动。个人作品、测试产物与机器配置继续留在工作目录，不通过扩大白名单方便打包。

项目采用 [Apache-2.0](LICENSE)。请保留第三方归属与许可声明，仅提交有权贡献的内容。提交使用简洁的 Conventional Commits 格式，例如 `fix: preserve draft after reconnect` 或 `docs: clarify local setup`，说明问题、行为变化与验证结果。

提交前和暂存后均运行 `npm run source:check`。新增公开文件应更新白名单；不要强制加入本地凭据或个人作品。GitHub Actions 在 Linux / macOS 执行工程检查，并扫描 Git 历史中的疑似密钥；CI 不调用真实模型或付费 Provider。

通过 [Issues](https://github.com/Dragonwarri0r/dreamer/issues) 报告可复现问题或讨论较大改动。安全问题按 [SECURITY.md](SECURITY.md) 处理，不公开敏感细节。
