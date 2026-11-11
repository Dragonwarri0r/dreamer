# 互动剧本协议 v1

日期：2026-10-23。状态：**已接入的协议与语义说明**；精确 API 字段以同目录生成的 JSON Schema 为准。依据本地历史 Roadmap v0.3、交互设计 v0.2 和 SPEC-09；这些历史材料不随默认公开候选包分发。

本次随 SPEC-09 v0.2 补充发布生成授权、Provider 配置固定、模板媒体与时间基准；v1 协议已进入实现，权威字段见 `packages/contracts/interactive-script.ts`、`activities.ts`、`experience.ts` 及生成的 `interactive-script.schema.json`。当前公开范围和待办见 [开源审计](../open-source-audit.md)。

本文件定义跨模块字段、状态与行为。实现时放入 packages/contracts 的 Zod Schema，自动导出 JSON Schema；本文件继续解释语义，不手写维护第二套运行时 Schema。以下字段名是约定，目录名与内部函数可在不破坏接口的前提下调整。

## 1. 身份、版本与所有权

- Id 复用 UUID。Uid 首版采用长度 1–80 的非空本地档案字符串，只作数据库值，不拼文件路径。它不构成登录认证。
- Ref 继续表示作者对象的固定 kind / id / seq；节点用 NodeRef {scriptRef, nodeId} 定位，不给每个节点另建作者全文副本。
- 增加作者领域 kind=script，沿用草稿／快照。ScriptRelease、ExperienceRun、SegmentInstance、ActivityAttempt 使用专属存储与专属引用，不能伪装成 Chapter 或 Thread。
- schemaVersion 表示协议结构；scriptRef.seq 表示稿件修订；releaseId 表示固定可体验发布；stateSeq 表示一次体验的逻辑状态版本；它们不可互换。
- 已发布版本固定章节、场景、资源、活动及规则版本的依赖闭包；“最新版本”不能成为运行时引用。
- Scene / ScriptBlock 仍是作者剧本正文。模板中的个人变量不写回作者正文；生成正文只写 SegmentInstance。
- 读取前面已生成或经变量替换的故事使用 RuntimeContentRef {runId,instanceId,resultRevision,contentHash}，与作者 Ref 分开；它必须属于本次 run 的已经历实例。固定模板结果使用 revision=1 与其冻结内容哈希，不能以当前变量重新渲染代替当时的正文。

## 2. ScriptPlanData

| 字段 | 类型 / 语义 |
|---|---|
| schemaVersion | 字面量 1 |
| title | 1–160 字符 |
| chapterRefs | 按作者阅读顺序排列的固定 Chapter Ref；动态章也有承载梗概的 Chapter |
| entryNodeId | 唯一入口 |
| nodes | ScriptNode 判别联合，节点 ID 唯一 |
| variables | VariableDefinition[]，key 在剧本内唯一 |
| activities | ActivityDefinition[]，ID 唯一 |
| cues | InteractionCue[]，ID 唯一 |
| policy | 发布和运行允许的预算、前瞻范围、检查策略 |

首版不支持剧情图循环。图结构必须有限、入口存在、所有可执行节点可达、每条路径可达 ending。可选活动跳过也必须有明确路线。结构检查不能宣称已穷举所有语义组合。

### 2.1 ScriptNode 判别联合

公共字段：id、title、chapterId?（须属于 chapterRefs）、outlineOrder、description。outlineOrder 只决定文档排列；next / cases 决定运行路线。图坐标不属于本协议。

| type | 业务字段 |
|---|---|
| segment | mode: fixed / template / generated；sourceSceneRefs；contentSpec；next |
| activity | activityId；next |
| branch | 有序 cases: {id, priority, when, to}[]；fallback: {id,to} |
| checkpoint | requires；commitEffects；next；可选 mediaEntryContract |
| ending | endingKey、summary；无 next |

branch 使用唯一整数 priority 升序取第一个成立条件，最后走唯一 fallback。UI 和诊断显示实际命中项；AI 不能返回任意目标节点。运行时不可更换图结构。

checkpoint 是剧情事实边界，不等于现有 *.checkpoint 的内容版本快照。requires 失败时返回状态不满足诊断，不悄悄改状态以通过汇合。

segment 的 contentSpec：

- fixed：声明来源场景及 Build 引用／片段范围。草稿允许 Build 暂缺；真实播放发布必须已经准备，逻辑模拟可以显示占位。
- template：在固定叙事主体中使用变量替换或有限条件片段；对白／画面变化必须有对应媒体版本或显式生成策略。
- generated：引用 GenerationContract；生成一段或一整章时使用相同契约。

next 可指向一个 checkpoint，再由 branch 进入下一章或结局。动态段的“结果类型”按 GenerationContract 选择，不能由模型另造全局出口。

template 使用声明的变量／允许字段确定内容哈希；变体条件引用的变量也必须声明并参与依赖检查和实例哈希。有限预制变体必须绑定匹配条件、相同叙事结果与具体媒体引用；无匹配时按显式生成策略准备，或阻断。不能只修改显示的正文／字幕，却沿用内容不符的旧视频和原声。模板与生成片段的冻结正文在实际消费后才作为前文传给后续动态段；即使生成视频已完成 Cue 定位，播放尚未结束时也推迟后继预生成。固定片段仍可在依赖已确定时前瞻一个动态片段。

### 2.2 引用与发布

发布时校验场景属于相应章节、块锚点存在、资源版本可用、变量读写一致。sourceSceneRefs 允许为空仅用于有完整生成规范的动态片段；不能将空固定段当视频。

作者修改章节／场景后，显式更新 script 的引用，显示内容影响。发布新 release 不改变旧 release。导入旧线性作品使用显式操作创建 script，不自动迁移所有旧章。

## 3. VariableDefinition 与规则

VariableDefinition：

| 字段 | 语义 |
|---|---|
| key / label | 稳定机器标识 / 用户可读名称 |
| type | boolean、enum、integer、text |
| scope | run 或 segment；首版不跨 run 继承剧情变量 |
| initial | 必填、符合类型；无隐式 undefined |
| values / min / max / maxLength | enum 非空有限集合；integer 有界；text 长度不超过 500 |
| allowedWriters | 明确节点／活动及提交阶段 |

第一版条件 DSL：eq、in、gte、lte、all、any、not；深度最多 8，单表达式最多 64 项。条件不能执行 JS、SQL、模板代码或网络调用。text 不用于任意正则判路，自由输入先归类为有限 enum。

效果 DSL：set、increment、unsetSegment；所有目标需在允许写入列表内。值来自常量或通过 Schema 校验的活动结果字段；不接受任意对象路径。越界效果拒绝整个提交，不能部分加分。

每个效果固定 commitAt：

| 阶段 | 可记录的内容 |
|---|---|
| activityAccepted | 已提交选择／意图，如交涉方式 |
| segmentCompleted | 已经历片段的结果，如获得信任、物品 |
| checkpointReached | 经进入条件检查后的剧情里程碑 |

run 变量保留到结局；segment 临时值在片段退出时清理。汇合不清空已有 run 变量。Effect 去重身份包含 runId、visitId、sourceId、phase。

模板只支持变量插值和声明式条件段落，默认作为纯文本输出。未声明变量、类型不符或缺值是校验错误；不拼接可执行 HTML。

## 4. GenerationContract

| 字段 | 语义 |
|---|---|
| id / version | 固定生成模板身份 |
| scope | segment 或 chapter；输出仍是一个 SegmentInstance |
| reads | 允许读取的变量 key 与必要内容引用 |
| entryConditions | 本段开始前应成立的机器可检查条件 |
| narrativeGoal | 叙事目的与观众应理解的变化 |
| fixedFacts | 固定事实条目，带来源 Ref；语义约束由内容检查处理 |
| allowedChanges | 允许变化的对白、方法、行动等字段与范围 |
| outcomeCases / fallbackOutcome | 条件与唯一优先级选择一个预定义结果；由 Host 在生成前确定 |
| outcomes | 每个结果的叙事要求、postconditions、completionEffects；模型不得改结果 ID |
| resourceRefs | 人物／服装／声音／场景与可选首尾参考固定版本 |
| limits | 最大正文长度、场景数、镜头数、目标时长、模型调用／媒体任务／修复次数 |
| checks | 结构、事实与内容检查策略、媒体就绪条件 |

已选 outcomeId 随输入冻结。模型返回不匹配结果时标为需修复，不重新决定用户路线。branch 后续基于已提交结果选择出口。

结构化输出 SegmentScriptV1：

~~~text
schemaVersion, instanceId, inputHash, outcomeId, timelineFps
chapterTitle?
scenes[{id, title, location, time, blocks[{id,type,text,speaker,entityId?}]}]
sourceRefs, usedVariables
assertedFacts[{key,value,evidenceBlockIds}]
shotPlan[{id,sceneId,goal,action,sound,durationFrames,resourceRefs}]
contentChecks[{ruleId,status,evidenceBlockIds,message}]
~~~

运行层核对输出身份、长度、引用、结果及预算。assertedFacts 是待核对声明，不能直接写当前 run 状态。实际状态变化只执行已发布 outcomes 中的 completionEffects。

timelineFps 是固定片段计划的整数帧率（1–60），shotPlan.durationFrames 均使用此时基，不能隐式借用当前项目 fps。Provider 输入的目标秒数与回收素材的实际 duration / sourceFps 分别保存；PlayableSegment 重新校验来源范围并解析 Cue。云端整数秒限制或实际素材过短不能通过删对白、补 TTS 或超出素材范围来静默弥补。

机器检查负责合同与已声明状态，内容检查负责因果、人物、对白和目标兑现。AI 自报 contentChecks 不是独立审稿证据；独立检查有自己的执行记录。媒体解码成功也不代表叙事或视觉质量通过。

生成上下文另存 RuntimeContextSnapshot：作者 sourceRefs、已经历 priorInstanceRefs、已提交结果的来源、variableSnapshot、可选前文摘要及其来源哈希。摘要只帮助定位，不能成为新的权威事实。所需前文未读完整时标记 incomplete，补读或阻断，不能把后续预生成稿当作前文。上下文不默认携带全书与其他 uid 的经历。

每次写作／修复结果按 resultRevision 不可变保存。检查通过选定版本，ready 后不替换正文或媒体；修订形成新实例，已经进入播放的实例不会热更新。

生成失败可在预留次数内修复；超过预算进入 blocked。固定后备片段只有在发布时绑定同一允许结果、满足衔接条件并声明为可用后备时才能采用；不得自动换成另一条故事线。

### 4.1 本地文本适配格式

核心存储、审稿、媒体编译和作者提取仍使用严格的 `SegmentScriptV1`。Host 可以显式选择 [`LocalRuntimeDraftV1`](../../packages/contracts/local-runtime-draft.ts) 作为本地模型写作／修复的传输格式。模型返回的冗余 `format` 标签可以省略，存在时只能为 `"local-segment-draft/v1"`；Host 不补写或猜测这一标签。解释输入和独立审稿各自保持原有 Schema。

仅场景、正文块、镜头的局部 `id`，以及 `sceneId`、`dialogueBlockIds`、`evidenceBlockIds` 中对应的局部引用使用符号名，例如 `scene_1`、`dialogue_1`、`shot_1`。符号名为 1–64 个字符，以英文字母开头，后续只允许英文字母、数字、下划线和连字符，整份草稿内不得重复。`instanceId`、`entityId` 和所有作者／资源／素材 `Ref` 仍必须使用原有 UUID 与固定版本；`inputHash`、`outcomeId` 也必须与冻结输入完全一致。

[`LocalRuntimeGenerator`](../../packages/infra/agent/local-runtime-generator.ts) 的 `dreamer-runtime-structured/v8` 将 `entityId` 明确区分为已有角色／实体的全局身份。写作与修复时，模型输出 Schema 只从冻结来源提取合法 UUID：`sources` 的完整 `Ref` 必须匹配 `context.sourceRefs`，读取 Resource 的 `entityId` 或 Scene 正文块的 `entityId`；已消费 `previousContent` 的完整 `RuntimeContentRef` 必须匹配 `context.priorInstanceRefs`，且正文 `instanceId` 必须一致，才读取其正文块的实体身份。其他版本、任意嵌套字段、诊断或 `previousResult` 不提供候选实体。

没有这些已有实体时，适配器从发给模型的封闭正文块 Schema 中移除可选 `entityId` 字段；有候选时保留 UUID 类型，并以去重、排序后的值设置 `enum`，同时通过 `formatGuide.entityIds` 提供给模型。没有明确人物绑定仍应省略该属性，不能填空字符串、`null`、局部编号或新造 UUID。这是模型请求的结构约束与提示，不是新增的服务端实体白名单：`LocalRuntimeDraftV1`、`SegmentScriptV1` 的实体字段仍按原有 UUID 规则校验，核心校验没有因此放宽，适配器也不会自动纠正模型返回的实体字段。

[`compileLocalRuntimeDraft`](../../packages/core/experience/local-runtime-draft.ts) 先校验严格 Schema、局部标识唯一性和引用存在性，再按格式版本、实例 ID、标识类别与符号名确定性生成 UUIDv8。同一实例中的同一局部标识映射不依赖数组顺序；不同实例互不复用这些生成身份。镜头对白只能引用本次新正文中同场的对白块，事实与检查的 `evidenceBlockIds` 只能引用本次新正文块；不能引用 `previousContent`、`sources` 或 `previousResult` 的正文 ID，也不能引用场景、镜头或实体 ID。前文仅供叙事衔接，不能替代本次事实的证据。转换仅作用于这些显式身份字段，不替换正文中的同名文字，不修订对白、Provider 提示、外部身份或来源版本。

选择适配格式的唯一依据是派发时冻结的 `executionConfiguration.outputFormat`，该配置参与发布配置指纹；模型是否回显 `format` 不参与这一决定。Host 不根据模型返回值猜测格式，也不在失败后自动切换协议或模型。编译器核对镜头资源和首尾帧的各自白名单；编译结果还必须通过 `SegmentScriptV1` 和共同的语义后置校验：`sourceRefs` 必须完整保留冻结上下文中的来源集合，顺序不限，不得遗漏、重复或增加来源。Host 不自动补齐遗漏的来源。

本地适配器仅拆解已知回答包装并尝试 JSON 解析，本地 journal 和 dispatch 保存原始返回结果，包括不合规的草稿；不会删除／补写 `entityId`、改写证据引用或补齐冻结来源。通过校验后，immutable result 保存标准 UUID 正文及内容哈希。独立内容检查只接收标准正文，其模型输出 Schema 将检查证据限定为这份正文实际存在的块 ID，不能因草稿自报检查通过而跳过。结构或引用错误仍进入已有的有界修复流程，耗尽额度后阻断。

模板版本 `dreamer-runtime-structured/v8` 参与配置指纹，升级形成新指纹；旧发布／派发的配置不匹配时拒绝执行，不套用新模板重新发送旧请求。已派发但结果未知的任务只能核对原请求，不能通过换格式、换模板或重新生成绕过原 journal。

`scope=chapter` 使用同一适配、编译和检查链，仍产生一个 `SegmentInstance`，可以包含多个有界场景。整章文本验收可停在 `waitingReview` 并设置媒体额度为零；这只证明正文链路，不能替代真实视频质量和播放验收。隔离验收若复制已消费正文，必须分别记录原始来源证明与新测试 run 的 `RuntimeContentRef`，不将复制夹具描述为生产环境的跨 run 读取能力。

## 5. ActivityDefinition 与 InteractionCue

### 5.1 活动定义

公共字段：id、type、version、label、config、reads、resultMapping、presentation、skipPolicy、retryPolicy。

type / version 在 Host 注册为 ActivityDescriptor：包含 configSchema、inputSchema、resultSchema、能力标识、验证器、恢复规则、前端 rendererKey。config 按注册 Schema 校验，不是任意 JSON 执行器。

内置：

- choice@1：有限 options {id,label}；结果 {optionId}。
- text-intent@1：maxLength（最多 2000）、有限 intents、解释模板引用；结果 {intentId, extractedValues, interpretationRef}。intentId 必须存在，extractedValues 仅允许声明的字段。

小游戏本轮只预留协议与模拟结果夹具。未知类型可在草稿中保留原始定义并标 unsupported；不得执行、自动跳过或发布成真实可体验的必经节点。

活动返回 typed result；resultMapping 由 Host 将字段映射为允许的输入效果。未来小游戏可以返回 outcome=solved / failed / skipped 和有界分数，不能直接写变量、发放资源、选择任意节点或派发生成任务。游戏失败是合法故事结果，此时 attempt 可为 completed；处理器异常的 attempt.failed 不产生剧情结果。未来游戏内部回合由活动自己管理，不要求给首版剧情图增加循环。

ActivityAttempt 保存 attemptId、runId、visitId、activityId、descriptorVersion、status、原输入、解释记录、结果、回执、恢复数据。

状态为 open → interpreting → needsConfirmation / completed；choice 可从 open 直接 completed；另有 failed、cancelled、skipped。failed 仅在 retryPolicy 允许且预算充足时以新解释任务重试原输入；不能创建重复成功结果。completed / cancelled / skipped 为终态，结果不可覆盖；取消或失败不能当作 completed。

为兼容旧存档，未知文字执行仍可持久化为 attempt.failed，但不能据此判断可重试。`RuntimeView.activity` 另给 `recoveryState=none|unknown`、`canRetry`、`canReconcile` 和 `recoveryReason?`。Host 从同一 project/uid/run 内的原 dispatch 判定：queued/dispatched/unknown 尚未结束时不能新建解释；`retryPolicy.maxAttempts` 是首次执行之外的额外重试次数，明确失败仍需剩余次数和发布文字预算。未知结果不能新建解释，只能通过 `activity.reconcile` 核对原解释；执行器缺少核对能力或冻结配置不符时 canReconcile=false 并解释原因。

核对校验原 attempt/dispatch owner、requestId、inputHash、配置指纹与 reservation 的归属、阶段、次数和状态，然后查询原请求。核对不 reserve、不 execute 新任务；并发核对合并，结果仍经过原解释 Schema/意图/字段校验，并在事务中一次提交效果。没有结果继续保持 unknown；确认非法结果才转明确失败。已放弃的 run 拒绝新活动操作，原请求回执仍可读取，迟到结果可归档但不能改变剧情。

TextInterpretationV1 返回 intentId?、extractedValues、needsConfirmation、explanation、inputHash。低确定性或没有合法意图时只返回可供确认的既定意图，不自行创造新出口；解释文字是用户可核对的结果说明。

### 5.2 视频内触发

InteractionCue {id, activityNodeId, segmentNodeId, anchor, resolvedBinding, deadlineFrame, activateAt}。

- anchor：固定 Scene / ScriptBlock / Shot 引用与 before / after / offset 语义。由编排或媒体检查解析。
- resolvedBinding：releaseId、固定 Build 或实例播放计划 ID、内容哈希、fps、appearFrame；deadlineFrame 在同一局部时基内。
- activateAt：首版为 segmentEnd，即路线在当前片段结束后生效；不在正在播放的镜头中热切换媒体。
- 第一版只允许提前打开该 segment 直接后继的 activity 节点，每段最多一个提前输入；章节间活动直接在进入节点时打开。

不允许假定生成对白可自动精确对齐。缺少可信映射时阻止真实播放发布／实例就绪，并要求重新定位；逻辑模拟可忽略实际时码但必须标记。

cue 可在 segment 当前 visit 中提前创建 ActivityAttempt。提交结果后允许预生成；播放到 activity 节点时消费同一已完成 attempt，不重复应用效果。到 deadline 未完成则暂停。

若 seeking 从出现帧前跳到出现帧后，显示尚未完成的输入；不得跳过 deadline 或未完成的剧情边界。回看只读取旧结果。

## 6. ScriptRelease 与预算

ScriptRelease {id, projectId, scriptRef, schemaVersion, kind, manifestHash, dependencyRefs, activityVersions, policy, generationAuthorization?, createdAt, publishedAt?}，不可变。

kind=playback 由 script.publish 创建，要求完整发布检查。kind=simulation 是作者模拟时编译的私有固定快照，允许未制作媒体及显式活动结果夹具，不显示为已发布作品。Run.mode 必须与 kind 一致，不允许把模拟记录转换为真实播放。

policy 至少包含：

- maxBranchesPerDecision、maxDynamicNodesPerRun、maxShotsPerSegment；
- maxTextCallsPerRun、maxMediaJobsPerRun、maxRepairAttempts；
- prefetchDepth（首版 0 或 1）、允许的 Provider / Profile 和质量；
- reviewMode（authorReview 或 validatedRuntime）、失败／等待策略。

允许生成的 Provider / Profile 必须绑定无凭据 executionProfile：provider、profile、quality、公开 model/config 指纹、约束与提示词模板版本。新计划从 videoGenerationPreference 读取当前默认（本次最新代码为本地 H3 预览）；明确且已启用的选择优先。默认的具体模型不是协议常量。发布后不跟随全局默认或配置漂移；缺能力／配置不符时阻断并提示原因，不自动切换模型，开发预览不冒充 final。密钥不进入 release、上下文、运行回执或备份。

ScriptRelease 另存 generationAuthorization {policyHash, confirmedAt, source:human}，由作者发布用例创建并纳入 manifestHash；只包含固定的生成范围与限额确认，不包含密钥或通用命令授权。具有外部调用的 playback 发布必须有该确认；纯固定／simulation 发布可以无此项。发布与能力检查都不得触发推理；观众输入只能消费已有授权范围。

本机样例建议 2–3 个出口、3–5 个变量、1 个动态视频节点。数字只是样例配置；协议校验器对实际预算检查，无隐藏无限默认。

创建 run 前，发布策略与项目剩余预算共同决定授权范围。预约预算、创建实例和持久调度意图在同一事务提交，避免并发体验超额。

文字解释、写作、独立检查和修复均计入文字调用预算；每个实际媒体请求／重试计入媒体预算，缓存命中不扣新调用。已分发、失败、取消和未知请求不因没有产物而退还成本额度；仅确认从未分发的预约可释放。

预算单位与旧工程兼容：Project.generationLimit 仍只计现有图像／视频类别（ltx、h3、codex-image、seedance、wan、fal-h3）；run 的文字次数独立计数，媒体次数计其新派发媒体 Job。TTS／FFmpeg 不挤占旧项目图像视频额度，但若用于 run 则占 run 的媒体次数。历史按旧 Job 已占额度回填；新旧计数不能双扣。首版不把次数承诺为货币上限，也不新增项目级文本账户。

reviewMode 控制实例进入本次体验的准入过程，不赋予修改共用作者作品的权利。validatedRuntime 在发布范围内完成规定检查后可播放；并不表示用户已认可最终质量。

## 7. ExperienceRun、实例与状态机

ExperienceRun {id, projectId, uid, releaseId, manifestHash, mode, stateSeq, currentNodeId, currentVisitId, status, variables, committedFacts, historyCursor}。

variables 是当前值的权威投影；committedFacts 是已提交效果账本的可追溯查询结果，不提供第二个可独立写入的事实字典。二者的来源均为原子提交的已发布规则效果。

mode=simulation / playback；运行后不可切换。simulation 不调用真实 Provider，数据不算真实完成证据。

逻辑状态：

| status | 含义 / 离开条件 |
|---|---|
| active | 正在执行可运行节点；进入活动／准备边界／结局时转换 |
| waitingInput | 等待选择、文字或歧义确认 |
| waitingContent | 依赖输入已固定，下一片段尚未就绪 |
| blocked | 检查、预算、能力或任务明确失败；按原上下文修复 |
| completed | 已进入 ending，保留实际路径 |
| abandoned | 用户结束本次体验，不继续调度 |

暂停播放与 buffering 是播放器状态，不直接改变逻辑状态。播放位置单独保存 {visitId,planHash,frame,positionSeq}，不让每帧更新与故事 stateSeq 争用。

SegmentInstance 固定 {id,runId,nodeId,visitId,inputHash,releaseId,sourceRefs,variableSnapshot,outcomeId,scriptResult,shotPlan,mediaRefs,playbackPlan,checks}。

实例状态：planned → writing → checking → producing → ready → consumed；另有 waitingReview、blocked、unknown、cancelled、stale。authorReview 策略在文本检查／媒体检查相应边界进入 waitingReview，经作者确认后继续；validatedRuntime 按已发布检查策略自动准入。过期结果仍可归档，不能接到不同输入的新 visit。ready 不提交 completionEffects；consumed 只在完成片段后发生。

RuntimeVisit 记录进入节点、活动引用、实例引用、已完成阶段及实际出口。剧情推进、效果、活动消费、访问记录和回执原子提交。

### 7.1 生成前瞻

已完成提前输入后，可以准备后继动态片段，但 reads 的所有值必须已经固定；前面未完成节点可能改变其中任一值时，不得越过该依赖生成。

预约保存读集、值哈希及原 visit；进入目标片段时重验依赖哈希。无关进度变化不使结果失效；相关输入改变使旧结果 stale。未来稿中的事实不进入 committedFacts。

### 7.2 重玩与恢复

同一 run 已接受输入不能覆盖。改选创建新 run；首版不提供任意检查点回滚和自动存档迁移。恢复使用原 release、原输入和原媒体；不能为了续玩重新随机写作。

消费页将所选 UID/run 保存在工作台标签中；档案切换同时清理旧视图并校验异步响应范围。存档列表的 title 来自冻结 release.snapshot.title，仅作为返回字段，不改写持久 run。真实体验与逻辑模拟的结局重玩均新建 run 并保留原 mode；模拟不转成真实发布或启动推理。

视频、输入和退出全屏控件属于同一播放舞台。截止暂停与用户主动暂停分开：完成输入及跨素材/片段时继承原播放意图，浏览器拒绝自动续播时保留显式继续按钮。片段完成只有 Host 确认后才锁定；明确 CAS 冲突刷新当前状态后最多重试一次，同一片段回执未知时先核对原请求，不能不断创建新完成请求。等待文案跟随 writing/checking/producing/waitingReview 实际阶段，取消中的原任务保留核对说明。

不支持的旧协议／活动版本保持可读，执行返回 unsupported；原数据不能丢弃。外部执行结果未知时对账原 requestId，不自动生成新请求。

## 8. 命令、查询与权限

### 8.1 作者与 AI

以下已接入命令使用现有项目 Command 外壳：

| 命令 | 内容与权限 |
|---|---|
| script.create | 创建空稿或显式引用既有内容；AI 可在授权范围内创建 |
| script.edit | 人工提交类型化 ops 与 expectedSeq |
| script.propose | AI／人工提交相同 ops、baseRef、expectedSeq、reason，生成审阅提案 |
| script.publish | 人工确认，重新校验固定依赖、预算与能力后创建 release |

ops 首版：node.insert / node.replace / node.remove、branch.case.upsert / remove、variable.upsert / remove、activity.upsert / remove、cue.upsert / remove、source.rebind、chapter.order。

每个 op 有独立 Schema。删除不隐式级联，必须在同组 ops 中修复引用。节点正文通过既有场景文本提案修改；图规则修改不重写场景全文。script.propose 接入 Review，批准绑定基础版本、ops 哈希和依赖。

查询：script.read（固定版本、节点分页）、script.validate、script.impact、script.releases。返回完整性标记，不把摘要伪装成完整可写文档。

作者专用 simulation.start 创建 kind=simulation 快照和测试 run，可提供经过校验的 nodeId / stateFixture；只读 AI 可以通过 script.validate 的样例检查获得诊断，不创建运行记录。作者专用 instance.review 记录对固定 resultRevision / planHash 的判断，不能批准已变化实例。

分阶段交付时，S2 仅提供纯规则步进和固定模拟快照，S3 才交付持久 simulation.start。发布检查读取实际已接入的执行能力；尚未实现的文本／媒体／活动能力只能保留在草稿和模拟中。

### 8.2 体验接口

运行命令单独路由到体验用例，不将观众请求转换为无限制 Actor.source=human 的作者命令。

请求外壳：

~~~json
{
  "protocolVersion": 1,
  "requestId": "UUID",
  "runId": "UUID",
  "expectedStateSeq": 7,
  "visitId": "UUID",
  "operation": "activity.submit",
  "payload": {"attemptId": "UUID", "input": {"optionId": "show-evidence"}}
}
~~~

run.start 单独接受 projectId、releaseId、mode；uid 从本地所选档案上下文确定。后续请求的 run / visit / attempt 均须属于该档案与 release；任意客户端 payload 不能扩大范围。

命令：run.start、activity.submit、activity.confirmIntent、activity.skip、activity.retry、activity.reconcile、segment.complete、instance.retry、instance.reconcile、instance.cancel、run.abandon。位置保存使用独立 positionSeq；实际 prepare / reconcile 由 Host 运行，观众仅可对自己实例提出受限请求，不暴露通用 job.submit。

响应：requestId、replayed、stateSeq、status、currentNodeId、waitReason?、acceptedInput?、effects、nextAction。结构化错误沿用 code / message / details，details 包含 nodeId、fieldPath、ruleId、recoverable、expectedVersion、actualVersion；稳定 ruleId 示例：INPUT_AMBIGUOUS、ANCHOR_STALE、ENTRY_UNSATISFIED、BUDGET_EXCEEDED。

同一 requestId 与同一身份／规范化 payload 返回原回执，先查回执再检查当前 expectedStateSeq；相同 requestId 不同内容拒绝。不同 requestId 的同一终态 attempt 或已完成 visit 也不能重复生效。

文字解释异步执行：提交先原子持久化输入与待执行任务；模型在事务外运行。完成时按 attempt 身份核对，保存解释再应用允许效果；歧义进入待确认。重放 submit 不再调用模型。

调度 owner 是 activityAttempt（输入解释）或 segmentInstance（写作／检查／制作），使用判别联合；解释阶段不要求已有待播放实例。媒体 Job 的 experience owner 仍固定 runId / instanceId / componentId，由 Host 内部派发设置。持久调度和预算在 S4 首次外部文字调用之前交付。

`GET /api/experience/catalog` 按项目分页列出已发布 playback 版本：releaseId、scriptId、scriptVersion、scriptTitle、publishedAt、动态/等待/作者审阅提示、限额摘要和 budgetHint，返回 nextCursor；scriptId 与 scriptVersion 分别取冻结 scriptRef.id 与 scriptRef.seq，供消费页按稳定剧本身份分组，不按可重复或可改名的标题合并。不包含 simulation、snapshot、规则、完整来源 Ref 或私人状态。消费页通过此安全目录直接开始故事，不依赖作者全文读取。分页按发布时间降序，每组默认展示已载入版本中发布时间最靠前的一项，其他已载入版本折叠；界面不将分页候选宣称为全量最新。选择旧版本仍以对应 releaseId 开始独立体验。

查询另提供运行摘要、分页轨迹、attempt / instance、回执和按 run 过滤的事件。`GET /api/experience/trace` 接受 `limit`（1–100，默认 50）及不透明 `cursor`，返回 `visits` 和 `contentPage`（offset、limit、total、partial、nextCursor、snapshotOrdinal）。游标绑定 project/uid/run 和首屏的已开放路线边界；之后的新进度不混入旧分页，重新从首页读取才能取得新边界。已接受/消费的 choice@1 或 text-intent@1 可返回 resultLabel，取自冻结 release 的 option/intent；历史 decisions 使用同一标签规则，跳过显示“已跳过”，未知或非法结果不推测名称。内部归档仍读取完整已走路线；事件另按 `/events?after=...` 读取。观众接口只返回已到达／已开放的内容，不下载整个作者工程或另一 uid 的轨迹。

uid 首版只区分本地档案，作者可管理所有本地档案。现有本地会话不等于多用户认证；公网开放必须另做身份体系。

### 8.3 运行 payload 与语义

下面的命令均拒绝未声明字段。query 与 position.save 不套用故事 expectedStateSeq。

| operation | payload / 前置 | 成功结果与重复规则 |
|---|---|---|
| run.start | projectId、releaseId、mode；独立 requestId，归属所选 uid | 返回新 run / 初始 visit；同一启动请求返回同一 run |
| activity.submit | attemptId、input；attempt 属于当前或合法提前开放的 activity | choice 完成或 text 持久排队；原输入不可被重放覆盖 |
| activity.confirmIntent | attemptId、interpretationRef、intentId | 只确认原解释中允许的意图，原子应用活动效果 |
| activity.skip | attemptId；定义有 skipPolicy 和 skipped 映射 | 记录 skipped，应用指定结果；不能当作成功 |
| activity.retry | attemptId；明确 failed、策略允许且预算足够 | 对原冻结输入新建解释执行记录；重放请求不重复派发 |
| activity.reconcile | attemptId；原解释为 unknown，原执行器支持核对且配置匹配 | 查询同一原 request 和 reservation；不创建新执行、不扣新额度；结果异步回写 |
| segment.complete | instanceId 或固定片段绑定 ID、planHash、结束 frame | 校验当前 visit、开放输入已完成和媒体身份，再提交完成效果 |
| instance.retry | instanceId、failedStage；明确失败、尚未 ready 且预算足够 | 在同一冻结输入下创建新 attempt，保留旧结果；unknown 不可重试 |
| instance.reconcile | instanceId；存在原外部执行 ID | 查询原任务，不生成新请求；结果异步反映到实例状态 |
| instance.cancel | instanceId；尚未 consumed，属于本 run | 请求停止拥有的执行；只在确认后标 cancelled，不能误停共享执行 |
| run.abandon | reason?；当前 visit | 停止路线推进和新调度；不承诺外部在途任务已取消或退款，保留成本、产物和原回执 |
| position.save | visitId、planHash、frame、expectedPositionSeq | 仅更新可访问片段的回看位置，不推进剧情 |

提交失败返回原输入可恢复信息。结构无效／权限不符请求不推进状态；已接受的异步输入即便解释失败也保留原回执和任务身份。

运行回执唯一键包含 projectId / uid / runId / requestId；run.start 在分配 run 前按 projectId / uid / requestId 去重。任务及效果还需独立的领域唯一键，不能只依赖客户端是否复用 requestId。

segment.complete 的播放报告用于本地体验恢复，不是可信的反作弊／观看证明。拖动前端进度不能绕过 Host 对当前 visit 和必需活动的检查；公网或带奖励系统另行设计可信完成证明。

cancelled 实例不可原地复活；首版可以重新开始一次体验，保留原取消记录。重试不能修改原输入、增加额度或更换发布策略；需要这些变化时创建新 run。取消过程中收到完成结果可归档，但不能自动接入已取消的路线。

消费页将“结束这次体验”放入更多操作并要求明确确认，说明在途任务仍可能完成并使用已预约额度；仅离开页面继续使用原存档。完成或放弃后隐藏活动和实例操作，仍允许查看已走路线；放弃后的迟到结果不推进原 run。

## 9. 活动示例与成本有限的验收作品

示意 ID 为可读别名，实现 fixture 必须替换成 UUID。

~~~text
introSegment → approachActivity → approachBranch
approachBranch:
  leave  → earlyEnding
  rescue → rescueSegment → gateCheckpoint
  proof  → proofSegment  → gateCheckpoint
gateCheckpoint → negotiationIntro → negotiationActivity
negotiationActivity → dynamicNegotiation → resultCheckpoint → resultBranch
resultBranch → enterEnding / returnEnding
~~~

approachActivity 在 introSegment 中提前出现；negotiationActivity 可在 negotiationIntro 中提前出现。变量示例：approach(enum)、hasEvidence(boolean)、trust(integer 0–3)、intent(enum)。

rescueSegment 完成时增加 trust；proofSegment 完成时记录 hasEvidence。汇合 requires 两条路线都已到城门，不要求 trust 与 hasEvidence 相同。

dynamicNegotiation 只读取四个变量及固定角色／场景引用；按规则选择成功或失败 outcome 后生成交涉过程。模型不能删除已有证据或凭空增加角色。resultCheckpoint 后选择相应结局。

未来可在 gateCheckpoint 后插入 puzzle@1 活动，返回 solved / failed；本轮只在模拟中注入结果验证协议，不实现小游戏。

## 10. 兼容、缓存与可追踪性

运行结果重放优先使用持久化实例；缓存键包含协议／模板／资源／输入读集／模型配置版本。包含个人原文的结果默认 run 私有；仅经过显式共享策略、无个人输入且依赖完全一致的有限变体可跨 uid 复用。

缓存命中也需校验媒体仍可用、内容准入策略兼容；不能只看 prompt 文本相同。取消一个 run 不得终止另一个 run 正在使用的共享任务。

重要来源链：release → node / visit → activity input → normalized intent → variable snapshot → segment script → media job → artifacts → playback plan → committed outcome。

协议新增可选字段须有明确默认；破坏性变更增加版本并显式迁移。版本迁移不重新生成内容，不重放活动，也不重新消费成本。

备份需要保存可移植、无凭据的外部任务恢复描述。云视频包含原 provider / requestId / remoteId（如有）/ endpoint / model / 指纹与状态，不依赖原机器的 journal 绝对路径。恢复校验期间零外部请求；补齐所需凭据后只核对原任务。没有远端 ID 的未知提交不能自动重提。backup.json version=2 保留旧 v1 包读取；基础数据保护随各阶段首次写入交付，S6 做整体归档验收。


## 10. 实施补充：实例媒体、回看与提取

本节对应 2026-10-23 实现；协议字段由 Zod 导出，不维护手写替代 Schema。

- `GenerationContract.mediaReferences` 是发布时明确授权的首/尾帧列表；角色 Resource 的外观图不会自动变成时空起点。`SegmentScriptV1.shotPlan` 可提供 `providerPrompts`、`dialogueBlockIds`、`frameReferences`，编译使用作者制作与体验共享的提示词函数。资源正文及要求按固定 Ref 读取。
- 有 Cue 的动态片段生成后先形成 `pendingPlaybackPlan`。作者通过专属待定位媒体入口预览，并用 `instance.bindCue` 提交 `resultRevision + expectedPlanHash + appearFrame/deadlineFrame`。定位通过后才生成允许播放的 plan；未定位、旧版本、越界帧不可播放。公开观众媒体入口不能读取 pending 素材。
- `boundFallbacks` 只可绑定同一 outcome 的固定正文、媒体和进入条件。发布必须选择 `failurePolicy=boundFallback`；作者显式 `instance.fallback` 才可使用。未知执行不能切后备，已经消耗的额度不退回。后备形成新的不可变 resultRevision，后文与提案读取实际后备正文。
- 历史接口仅返回已完成 visit 的 consumed 实例。历史播放器不调用 activity、position 或 segment.complete。MP4 导出冻结实际路径、素材哈希、Cue、变量效果和结果版本；不会展开未走路线或重新调用模型。导出输出和来源都加入备份、恢复及清理保留根，SQLite schema 升至 4。
- 私人实例通过 `instance.propose` 明确披露选中正文，产生普通 ChangeProposal。`runtimeSource` 固定原实例 revision/hash、release、node 与作者来源；审批哈希绑定这一来源。批准与应用再次核对，旧 run 不被更改，原始用户输入与变量快照不随提案公开。
- 修订影响输出 `variable/rule/text/audio/visual/metadata` 分类及受影响节点。元数据变化不能等同于必须重制全部媒体，旧 release 保持原依赖。
- 本地文本仅连接字面回环 HTTP 地址，禁止重定向与工具调用；请求前持久化 journal，超时/中断保留 unknown，不静默换模型或重发。模板版本与本地模型配置参与 release 指纹。v8 结构示例区分新正文局部 ID 与冻结实体 UUID，按 §4.1 约束模型输出 Schema，不自动修正原始返回；失败修复只获得有界 JSON 字段诊断。


### 2026-10-23 UI 状态补充

`RuntimeView.instance.cancelRequested` 为布尔值，缺省为 `false`；用于区分等待原任务取消结果和普通未知结果。取消未确认时仅核对原任务；已取消的路线不能继续，观众可结束旧 run 并按原 release 新建体验。该字段由既有实例状态投影，不增加数据库迁移或改变取消/预算语义。

作者 `GET /api/script/validate` 可带 `mode=draft|simulation|playback`，缺省为 `draft`。发布前按 playback 预检并展示 `diagnostics`；正式发布仍执行 Host 校验，预检结果不授权生成。前端在预检期间发现草稿改变会阻止发布旧稿。

未提交文字按 project/uid/run/attempt 保存在浏览器；只属于 UI 草稿，不是已接受输入。原活动命令得到成功响应或原回执确认后按原作用域清理，即使当前输入组件已经卸载。未知回执仍使用原 requestId，不把恢复草稿当作新解释请求。
