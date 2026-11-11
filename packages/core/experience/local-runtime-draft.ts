import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensure, parse, Ref, stable } from '../../contracts/foundation.ts';
import { SegmentScriptV1 } from '../../contracts/experience.ts';
import { LocalRuntimeDraftV1 } from '../../contracts/local-runtime-draft.ts';
import { VideoFrameReference } from '../../contracts/production-input.ts';

const Binding = SegmentScriptV1.pick({ instanceId: true, inputHash: true, outcomeId: true, sourceRefs: true }).extend({ resourceRefs: z.array(Ref).max(100), mediaReferences: z.array(VideoFrameReference).max(60).optional() });
export type LocalRuntimeDraftBinding = z.infer<typeof Binding>;

/** UUIDv8 is a custom deterministic SHA-256 identity, scoped to this instance and local identifier kind. */
function identifier(instanceId: string, kind: 'scene' | 'block' | 'shot', localId: string) {
  const bytes = createHash('sha256').update(stable(['local-segment-draft/v1', instanceId, kind, localId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Only explicit local identity fields are translated. Story text, global IDs, and frozen Refs are untouched. */
export function compileLocalRuntimeDraft(raw: unknown, expected: LocalRuntimeDraftBinding): SegmentScriptV1 {
  const draft = parse(LocalRuntimeDraftV1, raw), binding = parse(Binding, expected);
  ensure(draft.instanceId === binding.instanceId && draft.inputHash === binding.inputHash && draft.outcomeId === binding.outcomeId, 'VALIDATION', '本地草稿不能改变冻结实例、输入或结果身份');
  const sources = new Set(binding.sourceRefs.map(stable)), resources = new Set(binding.resourceRefs.map(stable)), frames = new Set((binding.mediaReferences ?? []).map(stable));
  ensure(draft.sourceRefs.every(ref => sources.has(stable(ref))), 'VALIDATION', '本地草稿包含未授权来源，不能修补或替换 Ref');
  const localIds = new Set<string>(), mappedIds = new Set<string>(), scenes = new Map<string, string>(), shots = new Map<string, string>();
  const blocks = new Map<string, { id: string; sceneId: string; type: string }>();
  const register = (kind: 'scene' | 'block' | 'shot', localId: string) => {
    ensure(!localIds.has(localId), 'VALIDATION', `本地草稿局部标识重复：${localId}`); localIds.add(localId);
    const id = identifier(binding.instanceId, kind, localId);
    ensure(!mappedIds.has(id), 'VALIDATION', '本地草稿身份映射发生冲突'); mappedIds.add(id); return id;
  };
  for (const scene of draft.scenes) {
    scenes.set(scene.id, register('scene', scene.id));
    for (const block of scene.blocks) blocks.set(block.id, { id: register('block', block.id), sceneId: scene.id, type: block.type });
  }
  for (const shot of draft.shotPlan) shots.set(shot.id, register('shot', shot.id));
  const blockId = (localId: string) => { const block = blocks.get(localId); ensure(block, 'VALIDATION', `本地草稿正文引用不存在：${localId}`); return block.id; };
  for (const shot of draft.shotPlan) {
    ensure(scenes.has(shot.sceneId), 'VALIDATION', `本地草稿镜头场景不存在：${shot.sceneId}`);
    ensure(shot.resourceRefs.every(ref => resources.has(stable(ref))), 'VALIDATION', '本地草稿镜头使用未授权资源，不能修补或替换 Ref');
    ensure((shot.frameReferences ?? []).every(ref => frames.has(stable(ref))), 'VALIDATION', '本地草稿镜头使用未授权首尾帧，不能修补或替换 Ref');
    for (const id of shot.dialogueBlockIds ?? []) {
      const block = blocks.get(id);
      ensure(block && block.sceneId === shot.sceneId && block.type === 'dialogue', 'VALIDATION', `本地草稿镜头对白必须指向同场对白块：${id}`);
    }
  }
  const { format: _format, ...body } = draft;
  return parse(SegmentScriptV1, { ...body,
    scenes: draft.scenes.map(scene => ({ ...scene, id: scenes.get(scene.id)!, blocks: scene.blocks.map(block => ({ ...block, id: blockId(block.id) })) })),
    shotPlan: draft.shotPlan.map(shot => ({ ...shot, id: shots.get(shot.id)!, sceneId: scenes.get(shot.sceneId)!, ...(shot.dialogueBlockIds ? { dialogueBlockIds: shot.dialogueBlockIds.map(blockId) } : {}) })),
    assertedFacts: draft.assertedFacts.map(fact => ({ ...fact, evidenceBlockIds: fact.evidenceBlockIds.map(blockId) })),
    contentChecks: draft.contentChecks.map(check => ({ ...check, evidenceBlockIds: check.evidenceBlockIds.map(blockId) })),
  });
}
