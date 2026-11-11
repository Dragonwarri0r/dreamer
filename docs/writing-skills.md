# 平台写作技能

更新日期：2026-11-11。运行指令以 `packages/contracts/narrative-skills.ts` 为单一来源；每轮保存技能版本和指令 hash。`skills/*/SKILL.md` 是可校验的导出视图，不是另一套运行规则。

| 技能 | 职责 |
|---|---|
| writing-coach | 按作者题材讨论方向、人物关系、长期目标与近期场面；选方向不自动写正文 |
| serial-fiction | 在授权范围内写草稿或限定修订，组织详写、概述与信息揭示，保留已有收获和人物自主性 |
| engagement-review | 只读评价固定稿件，提供完整阅读范围、连续区段证据、影响和建议；不自动采用修改 |

保留慢生活与成长题材，不以固定反转密度、字数、笑话配额或自评分数保证作品好看。独立审稿需要真实子任务和固定输入；方法、权限、运行成功、内容质量分别验收。

## 方法来源与归属

以下保留方法参考来源与适配方向；本次核对的固定版本和完整许可副本见 [许可清单](licenses/README.md)。Dreamer 已将这些方法改写为平台运行指令，适配说明见 [NOTICE](../NOTICE)。维护者的具体小说案例、试写稿和阅读证据不随公开源码分发。

| 来源 | 参考方向 | 上游许可证 |
|---|---|---|
| [CLINLX / write-novel-skill](https://github.com/clinlx/write-novel-skill) | 读者期待、铺垫、阶段结果 | [MIT](https://github.com/clinlx/write-novel-skill/blob/master/LICENSE) |
| [0xsline / short-drama](https://github.com/0xsline/short-drama) | 场次、情绪结果、集间承接 | [MIT](https://github.com/0xsline/short-drama/blob/main/LICENSE) |
| [烁皓 / shuohao-skills](https://github.com/eternityspring/shuohao-skills) | 改编来源、剧本与分镜边界 | [Apache-2.0](https://github.com/eternityspring/shuohao-skills/blob/main/LICENSE) / [NOTICE](https://github.com/eternityspring/shuohao-skills/blob/main/NOTICE) |
| [karthikv792 / kv-skills](https://github.com/karthikv792/kv-skills) | 目标、人物选择、分层诊断 | [MIT](https://github.com/karthikv792/kv-skills/blob/main/LICENSE) |

公开讲座参考包括 [Sanderson 的情节讲座](https://www.brandonsanderson.com/blogs/blog/brandon-sandersons-2025-guide-to-plot-lecture-2)、Writing Excuses 的 [张力](https://writingexcuses.com/18-09-unpacking-the-tension/)、[核心冲突](https://writingexcuses.com/18-13-finding-the-core-conflict/) 和 [幽默](https://writingexcuses.com/11-34-humor-as-a-sub-genre/) 讨论。使用的是以自身表述整理的方法，不分发讲座、教材或小说原文；不能将某位作者的方法当作所有体裁的固定公式。

## 维护

修改运行源后执行：

```sh
node --import tsx scripts/export-writing-skills.ts
node --import tsx scripts/export-writing-skills.ts --check
npm run check
```

更新 Host 需要重启后才对新轮次生效；旧轮次保留旧快照。参考材料没有实际读取就不能声称应用过。真实写作流程与外部接口见 [平台写作](platform-writing.md)。
