# README 界面截图

截图日期：2026-11-12。使用当前工作台、Chrome 和 1440 × 840 视口实拍，样例来自公开的 `cityGateFixture` / `seedInteractiveStory`。运行使用离线 Application 与独立临时目录，不读取个人作品、账户登录或 Key，不调用模型。

| 文件 | 展示内容 |
|---|---|
| `story-editor.png` | “城门选择”互动剧本的故事线与观众输入节点 |
| `demo-simulation.png` | 逻辑模拟中的行动选择与片段推进 |
| `demo-media.png` | 本地 FFmpeg 色块测试视频与观众选择；不是生成样片 |

体验入口见 [README](../../README.md#快速体验无需-key)。逻辑模拟无需媒体；截图的剧本编排场景还包含相同样例的固定测试素材。图片只包含应用视口，没有地址栏、终端或桌面内容。

更新截图时先用独立 Demo 数据重拍，逐张检查画面中的正文、身份和配置，确认 PNG 没有私人元数据。再更新 `config/public-source.json` 中对应图片的 SHA-256，并运行 `npm run source:check`。公开检查仅允许这些经过人工查看、路径和哈希完全匹配的 PNG；其他二进制仍会被拒绝。请勿把整个 `test-results/` 纳入公开范围。
