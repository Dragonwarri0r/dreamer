# H3 本地视频 Worker

SPEC-06 的第二条本地视频链，按 2026-10-20 用户选择接入。工程合同已实现；默认允许系统压缩和 swap，16 步质量档已生成并归档真实视频与原声。内容质量仍作为待审候选单独记录。

## 来源与固定版本

- 模型：`ddalcu/MiniMax-H3-FL2VA-MLX-Serve-4bit`，revision `9c9273578ed5c2daf0b9a42eace823a6a49050ba`。
- 运行时：MLX-Serve `v26.10.2`，commit `ccedc6a4820f48e576633062232ed0cba1139616`。
- 复用 `../short-dreamer/.local/h3-models/` 和 `.local/h3-runtime/`，不修改源项目、权重或已保存的试验结果。
- 接口契约依据 [固定版 gen.zig](https://github.com/ddalcu/mlx-serve/blob/ccedc6a4820f48e576633062232ed0cba1139616/src/gen.zig)，采样档位依据 [固定版模型说明](https://huggingface.co/ddalcu/MiniMax-H3-FL2VA-MLX-Serve-4bit/blob/9c9273578ed5c2daf0b9a42eace823a6a49050ba/README.md)。
- 运行器参考 short-dreamer 的 `scripts/run-h3-local-trial.py`，加入 Dreamer 的任务身份、固定 Profile、鉴权、参考快照、进程生命周期、原声登记和回执恢复。

## 启动与实际生成

```sh
npm run h3:verify
npm run h3:worker
```

`h3:verify` 逐文件检查原有下载记录：LFS 文件使用 SHA-256，小文件使用 Git blob SHA-1；同时验证运行时归档哈希及解包文件。验证后建立 Dreamer 自己的 `.local/h3-assets.json`。Worker 在派发前核对大小、修改时间及实现指纹，变化后要求重新校验。

另一个终端启动 `npm start`，在“生成与素材”选择 H3。需要执行隔离的真实生成验收时：

```sh
npm run test:h3 -- h3-quality/v1
# 可选首帧（PNG，最大 10 MiB；不接受任意远端 URL）
npm run test:h3 -- h3-quality/v1 /absolute/reference.png
```

每次 smoke 使用全新项目和目录，在 `test-results/h3/<run-id>/report.json` 记录结果，不覆盖旧样本，也不在普通测试中消耗 GPU 推理。

| Profile | 画幅 / 时长 | 采样 | 用途 |
|---|---|---|---|
| `h3-preview/v1` | 320×576，124 帧，24fps，约 5.167 秒 | Turbo，4 步，fast=false | 明确选择的低分辨率原生音画预览，拒绝 final 目标 |
| `h3-turbo/v1` | 480×832，124 帧，24fps，约 5.167 秒 | Turbo，4 步，fast=false | 预览，拒绝 final 质量目标 |
| `h3-quality/v1` | 同上 | 基础模型，16 步，fast=false | 高质量候选，仍须内容审阅 |

权威配置为 `packages/contracts/h3-profiles.json`。参考图按顺序编译为 `first_frame_image`、`last_frame_image`；支持 0 / 1 / 2 张，同一请求不会退化成无参考生成。上游首帧按画幅拉伸、尾帧居中覆盖，因此建议提供同画幅参考。不同画幅、帧率、时长、关闭原声音频会被拒绝，不悄悄改写输入。

2026-10-22 增加低分辨率预览：固定运行时的 `--skip-mem-preflight` 只跳过模型加载预检，仍会检查请求画幅。第二版 S01 正式档实际返回需要 17.8 GiB、当前可用 16.2 GiB，尚未推理。该层不受 `--os-reserve-gib` 控制。保留正式请求与旧规格，另选 `h3-preview/v1`，不修改全局 wired 限额、不关闭用户应用。界面切换规格时同步宽高、帧率、时长与质量目标并清除旧的执行确认；画幅预检失败按 `MEMORY_PREFLIGHT` 展示实际数字。预览保持原生中文对白与声景，不代表正式画质或内容验收通过。

## 中文对白与能力发现（2026-10-21）

Host 和 Worker 接受非空、最多 4000 个 Unicode 码点的提示词，保留中文对白、标点和换行原文；拒绝无法编码为 UTF-8 的孤立代理项。此前的 ASCII 限制会在推理前错误拒绝中文，现已删除。已有普通提示词继续有效，不强制新的结构格式。

建议按 [官方基础提示词指南](https://raw.githubusercontent.com/MiniMax-AI/MiniMax-H3/main/skills/h3-prompt-writing/references/base-en.txt) 使用英文场面与声音描述、稳定说话者编号，并以 `<d>[Chinese]别急，先数清楚。</d>` 保留实际中文对白；声线、动作和情绪放在对白标签外。三个正文部分分别为 `integrated_multimodal_description`、`overall_soundscape`、`non_diegetic_music`；无背景音乐时后者使用 `N/A`。这属于创作建议，不能替代逐镜对白、发音、节奏和口型验收。

当前固定 **FL2VA** 权重和 Dreamer 请求只接受首尾 PNG 图像，没有声音参考或音频输入字段。[官方模型说明](https://github.com/MiniMax-AI/MiniMax-H3) 中的音频参考属于 **Ref2VA** 能力，不能据此宣称本地已经支持跨镜声线锁定。官方列明中文对白支持；本地固定 `tokenizer.json` 已用 CPU 做中文对白、中文角色文字及 emoji 的编码/解码原文比对，且 [固定运行时](https://github.com/ddalcu/mlx-serve/blob/ccedc6a4820f48e576633062232ed0cba1139616/src/minimax_h3.zig#L3746-L3755) 将原始提示词送入 tokenizer。尚未生成真实中文对白样本；此前成功样本明确没有对白，不能用来验收中文发音或音画同步。

`dreamer_skills.capabilities` 现在通过 `Production.capabilities()` 实时提供 Provider 可用性、指纹和 `profileConstraints`：尺寸、帧数、帧率、固定时长、原生声音、质量、参考图数量与格式、提示词编码和长度。发现与提交校验共用 Profile 计算；查询不会授予生成权限。Agent 应先读取这些规格再规划分镜：当前 H3 单段约 5.167 秒，不能把 7.5 秒镜头直接当成等长素材替换；两分钟内容可规划为 24 段各采用 5 秒，实际剪辑仍须逐镜审阅。Worker 源码参与指纹，升级后重启 Host 与 Worker，让新任务使用新指纹，不能重放旧请求冒充新版本结果。

## 任务与资源边界

- Worker：127.0.0.1:4329，Bearer Token，拒绝浏览器 Origin 和错误 Host。任务保存于 `.local/h3-worker/<request-id>`。
- 每个任务拥有一个临时 MLX 进程，随机回环端口，`--api-key-env` 与 `--api-key-strict`。提交生成前验证未授权请求被拒绝。日志和请求不保存令牌。
- LTX 和 H3 共用 Host 调度组及 `.local/video-gpu.lock`。锁传至推理子进程，取消或执行器退出时清理本次进程组；不终止其他应用。
- 用户明确要求放宽门禁。默认 `DREAMER_H3_MEMORY_POLICY=swap-friendly`，传 `--skip-mem-preflight` 跳过保守静态预检；swap 使用及增长只记录。连续 12 次五秒采样为严重压力（约 60 秒）或磁盘余量低于 2 GiB 才停止任务。`strict` 可恢复原预检。保留 `MLX_SERVE_H3_RESIDENT=0`，不修改系统全局 wired 限额。
- SSE 接收有大小边界；先保存 RGB / PCM / 元数据，再验证 RGB 长度、画幅、帧数、帧率、PCM 格式和时长。固定运行时实际输出 32 kHz 双声道，保留其采样率写入 WAV。MP4 使用临时文件封装成功后再发布；封装失败保留原始媒体，可通过 `run.mux_saved(directory, profile)` 重封装，已有完整 MP4 拒绝覆盖。Host 再做媒体解码及哈希验证，同时登记原生 WAV。原声可独立用于音轨；从分镜创建的新 Cut 会带入原声音轨。
- 任务超时上限 3 小时；不自动重试。模型加载前 `MEMORY_PREFLIGHT` 为明确失败；Worker 崩溃的未确认请求保持 unknown，先使用原 ID 对账。晚到输出不自动进入已取消任务的候选。
- Worker 重启后读取原 `result.json`，核对请求 ID / 指纹；没有回执时不重提。未知请求收到取消后，只有确认继承的 GPU 锁已释放才确认取消，避免误杀复用 PID。

| 环境变量 | 默认值 |
|---|---|
| `DREAMER_H3_MEMORY_POLICY` | `swap-friendly`；可显式选择 `strict` |
| `DREAMER_H3_DATA` | `.local/h3-worker` |
| `DREAMER_H3_PORT` | `4329` |
| `DREAMER_H3_MANIFEST` | `.local/h3-assets.json` |
| `DREAMER_H3_MODEL` | short-dreamer 中固定版模型目录 |
| `DREAMER_H3_RUNTIME` | short-dreamer 中 v26.10.2 的 mlx-serve |
| `DREAMER_VIDEO_PYTHON` | short-dreamer 的 video-venv，包含 Pillow |
| `DREAMER_GPU_LOCK` | `.local/video-gpu.lock`，LTX 与 H3 必须保持一致 |

改路径后重新运行 `h3:verify`；这个接入只验证固定版本资产，不接受任意新版本冒用原指纹。

## 当前验收

`npm run check:06`：6 项 Host 测试，包含 H3 规格、预算、跨模型未知状态阻塞、原声与画面归档和固定 Build。`npm run test:video-worker`：9 项测试，包含内存策略和参考哈希 / 首尾字段、原 ID 恢复、孤儿任务取消、跨 Worker GPU 锁、实际进程组取消 / 异常退出、真实 32 kHz 音画封装与失败后重封装。Chrome 覆盖 H3 档位与尺寸默认值。这些合同样本不等于真实模型输出。

调整策略前，2026-10-20 在 M1 Max / 32GB 上的两次真实请求都在模型加载前返回 HTTP 503 / `InsufficientMemory`。最后一次预检需要约 **17.6 GiB**，可用约 **15.4 GiB**；内存压力正常，swap 在请求前后保持约 1.44 GiB。没有视频、原声音频、生成耗时或画质结论。原始报告见 `test-results/h3/5c6b1daf-1109-49a5-ba6b-c3d1ba71f163/report.json`。

放宽后 Turbo 通过首层预检，但被上游运行时画布估算拒绝（18.5 GB / 可用 18.1 GB）。基础模型不加载 Turbo LoRA，同画幅 16 步质量档完成采样和音画解码，耗时约 50.6 分钟；内存压力始终正常，swap 保持约 1.44 GiB。请求 ID 为 `e792d6ca-4722-48e2-87df-eee5728d60ec`。收尾发现接入层漏掉实际 32 kHz 原声采样率，已修复；原始失败回执保留，无声诊断视频位于 `test-results/h3/d453538a-558c-4baa-ae4b-23bbe80b2765/video-only.mp4`。

修复后的请求 `9697ed85-f2e1-4cea-9139-a45462c0e8af` 已完整成功：视频 124 帧 / 480×832 / 24fps（5.167 秒），原声 32 kHz 双声道 / 165600 样本每声道（5.175 秒），Host 分别归档且正确登记一次镜头候选。生成耗时 3013.46 秒（约 50.2 分钟），采样峰值 RSS 11.10 GB；该数值不代表全部 GPU / 系统占用。swap 从 1.44 GiB 增至 2.89 GiB（峰值 2.93 GiB），压力曾为警告后恢复正常，未触发资源停止。

报告位于 `test-results/h3/2f2871c3-0610-4d6b-ba70-7889a71290ed/`。全片解码通过，视频与原声在真实 Chrome 中可播放；波形非静音且无样本削波，未做听感审阅。抽帧可见抬手、纸鹤运动和较稳定的人物服饰，但未完整实现“从掌心起飞并绕圈”，且没有角色参考输入。因此 `contentQualityAccepted=false`，不冒充正式高保真内容通过。
