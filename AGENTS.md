# Dreamer 工作约定

## 工程内的小说与剧本写作

用户要求在 Dreamer 工程中构思主题、写章、续写、修订或审稿时，优先把任务交给 **平台内的写作 Agent**。使用 `dreamer_writing_projects` 确认工程，再调用 `dreamer_writing_start` / `dreamer_writing_continue`，通过 `dreamer_writing_status` 读取结果。已有会话应继续使用，不重复开会话丢失作者选择。

- 主题讨论用 `discuss`；用户明确授权的新增正文用 `draft`；既有章节修改用带固定 `targetRefs` 的 `revise`；只读评价用 `review`。
- 外部模型负责转达用户意图、检视结果与协调范围。不要直接代写正文再以通用 `/api/commands`、SQL、文件导入或另一个生成器绕过平台 Agent。
- 选方向与写正文是两步。把平台的方向卡呈现给用户；用户已给明确方向和执行授权时可以直接写，不重复问卷。
- 保留用户指定的题材、人物、慢生活开篇、成长成果与当前写作范围。不要因为审稿偏好把种田长篇改成短视频断章。
- Agent 修改既有内容应提交可审阅提案。独立趣味审稿使用平台 `dreamer_delegate` 和只读权限；执行完成不等于质量合格。
- 请求结果不明确时先查询同一参数的回执，不换 requestKey 重做；不能把失败悄悄替换为外部代写。平台不可用时说明具体阻碍。
- 写作不授权视频、图片、配音或付费模型链路。当前媒体默认保持本地。

连接与接口说明见 `docs/platform-writing.md`，可导入的 MCP 配置见 `config/examples/dreamer-writing.mcp.json`。未配置 MCP 的调用方也可使用同文档中的 HTTP 入口。软件开发、测试、文档维护继续使用正常工程工具；上述约定仅针对工程内的创作内容。
