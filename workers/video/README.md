# Dreamer LTX Worker

2026-10-20 从用户指定的 `../short-dreamer/workers/video` 复用；原实现来源保留如下。模型推理、参考帧预处理、模型校验和受控请求沿用已验证路径。

Dreamer 适配：默认端口 4328；`DREAMER_VIDEO_DATA` 指向自己的任务、Token、参考与输出目录；`DREAMER_MODEL_MANIFEST` 只读引用已有模型清单；HF 缓存落在自己的目录。通过 `scripts/video-worker.ts` 启动，禁止写 Python bytecode 到共享 venv，不自动下载模型。

```sh
npm run video:worker
```

LTX 与 H3 共用 `.local/video-gpu.lock`，`DREAMER_GPU_LOCK` 可覆盖路径，但两个 Worker 必须保持一致。锁继承至推理子进程；取消或执行器异常退出会清理本次拥有的进程组。Worker 生命周期回归见 `npm run test:video-worker`。

默认 Profile 为 LTX-Video-2B-0.9.6-distilled、288×512、16fps，49 / 129 帧。首尾帧输入经过哈希校验和模型自身的裁切缩放，不能承诺像素精确一致。能力声明只有动态草稿，未通过 P5 高保真验收。

原文件在复用时的 SHA-256：

| 来源文件 | SHA-256 |
|---|---|
| `worker.py` | `9d92f88a099f00cd7d394ad918b9814ddf9e3694cf14356102b0c245239f91af` |
| `run.py` | `cd2d9cb3e48a2c6ba9248b5c0ffd929aa3b35d48185e023471df7d799eb40da5` |
| `model_assets.py` | `3d76e69b729fc9c6be96f6233c680c790688fbb80f5ee1e5dc8687b3a1e63c42` |
| `reference_assets.py` | `387693c97ed122eba11210fbdfcb910b9d5510d0a19825c1455c93369537d2af` |
| `model-lock.json` | `d9ba0ed265c6bd0016d3bb30249092b2fc26c34e0a8d13c2137aa050563869eb` |
| `requirements.lock.txt` | `8872165e777667a717b74f0c0a62dcb5678ba43e767490f03a4053fd3908effa` |

实际测试结果见 `docs/implementation-status.md`，不把技术生成成功当作指定动作或视觉质量合格。
