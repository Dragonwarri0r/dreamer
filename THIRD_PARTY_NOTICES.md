# 第三方组件与来源清单

核对日期：2026-11-11。项目自身采用 [Apache-2.0](LICENSE)，沿用远端初始提交的许可证。下列依赖与参考来源分别保留原许可，不因本项目许可证而改变。

## npm 依赖

下表来自当前 `package-lock.json` 与已安装包元数据。分发二进制或依赖包时还应保留对应版本的完整许可证与版权声明。

| 直接组件 | 固定版本 | 包声明 |
|---|---|---|
| React / React DOM | 19.2.6 | MIT |
| lucide-react | 0.468.0 | ISC |
| smol-toml | 1.9.1 | BSD-3-Clause |
| Zod | 4.6.7 | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| tsx | 4.23.15 | MIT |
| Vite | 7.3.7 | MIT |
| Playwright | 1.58.2 | Apache-2.0 |
| ffmpeg-static | 5.3.0 | GPL-3.0-or-later |
| ffprobe-static | 3.1.0 | npm 包声明 MIT；内置二进制单独核对 |

锁文件还含传递依赖与平台可选包，应在最终锁版本确定后生成完整 SBOM / license 清单并保留所分发组件的声明。没有把 `node_modules` 放进公开候选副本。

## FFmpeg、模型与复用代码

FFmpeg 的具体许可取决于编译选项和使用的组件；不能把 npm 包装层声明等同于所有二进制的许可。涉及重新分发时核对实际构建及相应源码、声明要求，见 [FFmpeg 官方说明](https://ffmpeg.org/legal.html)。当前副本只含源码及依赖清单，不捆绑 FFmpeg 可执行文件。

`workers/video` 从相邻 `short-dreamer` 复用，来源文件摘要保留于其 README；H3 执行器也参考该工程的本地试验。这部分为工程内复用与适配的源码；模型权重和外部推理引擎未复制到本仓库。固定哈希用于追溯来源，不把外部模型或引擎统一重新许可。

LTX / H3 权重、MLX-Serve 运行时、Python 环境不在源码副本中。后续若增加下载器、镜像或容器，应逐项确认上游模型卡、固定版本许可、访问条款和再分发要求；不能直接打包维护者 `.local/`。

## 写作技能与作品

写作方法的参考来源和适配方向见 [写作技能来源](docs/writing-skills.md)。本次已从固定上游版本保存 MIT / Apache-2.0 完整许可与 shuohao-skills 的原始 NOTICE，见 [许可副本](docs/licenses/README.md)；Dreamer 的适配说明见根目录 [NOTICE](NOTICE)。未分发上游示例小说或讲座全文。

个人小说、设定集、真实会话和媒体不随工程源码发布。Demo 只复用有限的仓库测试夹具，并以 FFmpeg 合成色块展示播放机制。新增宣传截图、视频或故事范例需单独核实可公开范围。
