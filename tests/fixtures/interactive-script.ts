import { mediaPlanId } from '../../packages/core/story/script.ts';
import { ScriptPlanData } from '../../packages/contracts/interactive-script.ts';
import type { Ref } from '../../packages/contracts/foundation.ts';

export const interactiveId = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
export function cityGateFixture(options: { media?: boolean } = {}) {
  const ids = { chapter: interactiveId(1), scene: interactiveId(2), build: interactiveId(3), block: interactiveId(4), intro: interactiveId(10), approach: interactiveId(11), branch: interactiveId(12), rescue: interactiveId(13), proof: interactiveId(14), gate: interactiveId(15), result: interactiveId(16), early: interactiveId(17), enter: interactiveId(18), back: interactiveId(19), activity: interactiveId(20), cue: interactiveId(21) };
  const chapter: Ref = { kind: 'chapter', id: ids.chapter, seq: 1 }, scene: Ref = { kind: 'scene', id: ids.scene, seq: 1 }, build: Ref = { kind: 'build', id: ids.build, seq: 1 };
  const media = { buildRef: build, fromFrame: 0, toFrame: 240, fps: 24, contentHash: 'a'.repeat(64) };
  const segment = (id: string, title: string, next: string, outlineOrder: number, completionEffects: unknown[] = []) => ({ id, type: 'segment', title, chapterId: ids.chapter, outlineOrder, mode: 'fixed', sourceSceneRefs: [scene], contentSpec: { mode: 'fixed', ...(options.media ? { media } : {}) }, completionEffects, next });
  const plan = ScriptPlanData.parse({
    schemaVersion: 1, title: '城门之前', chapterRefs: [chapter], entryNodeId: ids.intro,
    nodes: [
      segment(ids.intro, '暮色下的城门', ids.approach, 0),
      { id: ids.approach, type: 'activity', title: '选择靠近城门的方法', chapterId: ids.chapter, outlineOrder: 1, activityId: ids.activity, next: ids.branch },
      { id: ids.branch, type: 'branch', title: '入城前的选择', outlineOrder: 2, cases: [
        { id: interactiveId(30), priority: 10, when: { op: 'eq', key: 'approach', value: 'leave' }, to: ids.early },
        { id: interactiveId(31), priority: 20, when: { op: 'eq', key: 'approach', value: 'rescue' }, to: ids.rescue },
      ], fallback: { id: interactiveId(32), to: ids.proof } },
      segment(ids.rescue, '帮助守卫', ids.gate, 3, [{ id: interactiveId(40), op: 'increment', key: 'trust', value: { source: 'constant', value: 1 }, commitAt: 'segmentCompleted' }]),
      segment(ids.proof, '出示证物', ids.gate, 4, [{ id: interactiveId(41), op: 'set', key: 'hasEvidence', value: { source: 'constant', value: true }, commitAt: 'segmentCompleted' }]),
      { id: ids.gate, type: 'checkpoint', title: '抵达城门', outlineOrder: 5, requires: [{ op: 'in', key: 'approach', values: ['rescue', 'proof'] }], commitEffects: [], next: ids.result },
      { id: ids.result, type: 'branch', title: '守卫的回应', outlineOrder: 6, cases: [{ id: interactiveId(33), priority: 0, when: { op: 'gte', key: 'trust', value: 1 }, to: ids.enter }], fallback: { id: interactiveId(34), to: ids.back } },
      { id: ids.early, type: 'ending', title: '离开', outlineOrder: 7, endingKey: 'leave', summary: '你选择绕行，故事在此结束。' },
      { id: ids.enter, type: 'ending', title: '获准入城', outlineOrder: 8, endingKey: 'enter', summary: '守卫记得你的帮助。' },
      { id: ids.back, type: 'ending', title: '等待核实', outlineOrder: 9, endingKey: 'return', summary: '守卫收下证物，约定明日再见。' },
    ],
    variables: [
      { key: 'approach', label: '交涉方法', type: 'enum', scope: 'run', initial: 'undecided', values: ['undecided', 'rescue', 'proof', 'leave'], allowedWriters: [{ sourceId: ids.approach, commitAt: 'activityAccepted' }] },
      { key: 'hasEvidence', label: '已出示证物', type: 'boolean', scope: 'run', initial: false, allowedWriters: [{ sourceId: ids.proof, commitAt: 'segmentCompleted' }] },
      { key: 'trust', label: '信任', type: 'integer', scope: 'run', initial: 0, min: 0, max: 3, allowedWriters: [{ sourceId: ids.rescue, commitAt: 'segmentCompleted' }] },
      { key: 'intent', label: '交涉意图', type: 'enum', scope: 'run', initial: 'none', values: ['none', 'ask', 'explain'], allowedWriters: [] },
    ],
    activities: [{ id: ids.activity, type: 'choice', version: 1, label: '你打算如何行动？', config: { options: [{ id: 'rescue', label: '帮助受伤的守卫' }, { id: 'proof', label: '出示通行证物' }, { id: 'leave', label: '转身离开' }] }, reads: [],
      resultMapping: [{ id: interactiveId(42), op: 'set', key: 'approach', value: { source: 'result', field: 'optionId' }, commitAt: 'activityAccepted' }], presentation: { rendererKey: 'choice', prompt: '当前片段继续播放，你的选择将在片段结束后生效。' } }],
    cues: [{ id: ids.cue, segmentNodeId: ids.intro, activityNodeId: ids.approach, anchor: { ref: scene, blockId: ids.block, position: 'after' }, ...(options.media ? { resolvedBinding: { planId: mediaPlanId(media), contentHash: media.contentHash, fps: 24, appearFrame: 48 } } : {}), deadlineFrame: 200, activateAt: 'segmentEnd' }], policy: {},
  });
  return { plan, ids, refs: { chapter, scene, build }, media };
}
