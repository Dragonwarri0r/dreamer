# 平台 Agent 主题共创与外部调用

写作使用同一条链路：网页／外部 MCP → Host 写作入口 → 真实 Agent → 固定 Skill 与上下文 → 章节草稿或变更提案 → 独立复核。没有第二套小说数据库或外部生成器。

## 网页中的创作旅程

在 Agent 会话或章节书架选取范围，输入主题和当前要解决的问题，选择“共同构思”。平台的 `writing-coach` 提供 2–3 个有差别的方向，说明冲突、人物趣味、近期兑现和代价。点击方向只继续讨论；明确执行“写下一章”或“局部修订”才开放本轮相应写作能力。方向可以用自由文字调整，不需要每次重新填写设定问卷。

新正文使用 `serial-fiction`；已有正文以固定版本提交局部提案。需要另一双眼睛时，主 Agent 委派 `engagement-review`，子任务只读，并返回证据位置、读者受到的影响、改法、保留项和未核实项。草稿完成、审稿建议与用户采用是不同状态。不能用字数、章节齐全、测试通过证明文章好看。

Skill 的执行规范、版本与 hash 随每轮保存；参考材料没有实际读过就不能声称已应用。讨论和审稿权限由 Host 限定，不能被提示词扩大。阅读上下文 `bindings` 与允许修改的 `targetRefs` 分开；读到另一个章节不授予修改权。`revise` 必须指定目标，`draft` 没有既有目标时只能新增文字对象。

## 外部模型接入

将 [配置示例](../config/examples/dreamer-writing.mcp.json) 合并到调用方支持的 MCP 配置中。将示例中的 `/absolute/path/to/dreamer` 改为自己的工程绝对路径；默认端口为 4327。`DREAMER_NODE_BIN` 也应替换成 Node 24 的绝对路径；Codex 的 CLI 与 TOML 配置方式见 [README](../README.md#本地-codex--其他-agent-快速接入)。Host 必须已经启动在 `DREAMER_URL` 指定端口；MCP 不另开数据库、不启动媒体模型，也不保存或返回密钥。

使用 Node 24.14–24.x 与本工程依赖。适配器支持 MCP `2025-06-18` 的 stdio、initialize、ping、tools/list、tools/call；协议结果只写 stdout，诊断与启动错误走 stderr。兼容其他版本的客户端可按协议协商采用此版本；没有实现 HTTP MCP、采样或远程服务器。依据 [MCP stdio 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) 与 [生命周期规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)。

工具目录只提供：

| 工具 | 用途 |
| --- | --- |
| `dreamer_writing_projects` | 确认用户指定工程的 ID 和名称 |
| `dreamer_writing_start` | 在工程内建立工作项、会话和首轮 |
| `dreamer_writing_continue` | 沿用同一会话选方向、补要求或执行下一步 |
| `dreamer_writing_status` | 查询真实轮次、方向卡、产物与错误 |
| `dreamer_writing_receipt` | 丢失响应时核对原请求，不重复生成 |

外部入口的优先规则在 `AGENTS.md` 和 MCP initialize instructions 中。支持这些工程指令或 MCP 的客户端会收到该约定；项目不能强迫一个未连接的外部模型采用该路线。也没有把同一用户本机进程隔离成安全沙箱：原有网页通用 API 仍服务人工编辑，窄 MCP 工具不暴露它。

一次构思请求示例（工程 ID 替换成实际值）：

```json
{
  "requestKey": "example-discuss-001",
  "projectId": "00000000-0000-4000-8000-000000000001",
  "title": "示例工程 · 主题共创",
  "goal": "保留作者选择，讨论人物关系与近期目标",
  "message": "先讨论故事方向。给出不同方案，暂不改正文。",
  "mode": "discuss",
  "bindings": [],
  "targetRefs": []
}
```

MCP adapter 依据固定 `DREAMER_WRITING_CLIENT_ID` 和 `requestKey` 生成稳定 owner/requestId。重试必须保留原键和全部参数；改变参数仍用原键会冲突，新意图才换键。不同外部客户端宜设置不同 client ID，避免误共用输入租约。工具返回队列回执之后间隔查询 status；无需保持一次工具调用等待整章写完。

方向选择在 continue 中传 `selection: {entryId, optionId}`，并保持 `mode: discuss`。Host 检查同会话、最新已完成轮次和未失效卡片。随后独立的 draft/revise 请求才授权正文处理。自由文字指定方向也成立，不强迫使用卡片。

返回 `unknown`、超时或网络断开时不要报告成功。以原 operation（`start`/`continue`）和完整原 request 调 receipt；未找到才重发同一请求。Host 重启保留 unknown，不自动重发；重新执行需要明确的新一轮。适配器不会因网络异常自动再 POST。

## 直接 HTTP 入口

1. `GET /api/session`，在内存保存 cookie 与 csrf。
2. `POST /api/writing/start` 或 `/api/writing/continue`。需要同源 `Origin`、cookie、`x-dreamer-csrf`、JSON Content-Type。HTTP 参数使用 UUID `requestId` / `owner`，不用 MCP 的 `requestKey`。
3. `GET /api/writing/status?projectId=…&threadId=…`；可传 `afterEntryId` 获取该锚点及后续记录。返回锚点消息的最新全文，客户端按 `entry.id` 替换合并，避免遗漏同一消息流式增长后的末尾文字；不能直接逐次追加成重复消息。
4. `POST /api/writing/receipt`，传 `{requestId,projectId,operation:"writing.start"或"writing.continue",payload:原完整payload}`。

精确字段来自 `packages/contracts/writing.ts` 与生成的 `docs/contracts/writing.schema.json`。新增命令原子创建工作项、会话与轮次；重复请求读取持久回执。来源审计为 external，与人工审批区分。不存在媒体、审批或自动采用工具；无须提供视频密钥。

## 验收边界

工程回归、真实 Agent 调用和内容吸引力分别验证。独立审稿应提供固定版本、完整阅读范围与具体文本证据；成功保存草稿或测试通过不等于作品质量合格。维护者的真实作品、会话和试写证据不随公开源码分发。
