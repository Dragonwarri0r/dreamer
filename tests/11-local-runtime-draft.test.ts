import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Id, stable } from '../packages/contracts/foundation.ts';
import { LocalRuntimeDraftV1 } from '../packages/contracts/local-runtime-draft.ts';
import { SegmentScriptV1 } from '../packages/contracts/experience.ts';
import { compileLocalRuntimeDraft, type LocalRuntimeDraftBinding } from '../packages/core/experience/local-runtime-draft.ts';

function fixture() {
  const source = { kind: 'scene' as const, id: randomUUID(), seq: 7 }, resource = { kind: 'resource' as const, id: randomUUID(), seq: 3 }, artifact = { kind: 'artifact' as const, id: randomUUID(), seq: 2 }, entityId = randomUUID();
  const binding: LocalRuntimeDraftBinding = { instanceId: randomUUID(), inputHash: 'a'.repeat(64), outcomeId: 'wait', sourceRefs: [source], resourceRefs: [resource], mediaReferences: [{ purpose: 'start', artifact }] };
  const draft = LocalRuntimeDraftV1.parse({ format: 'local-segment-draft/v1', schemaVersion: 1, instanceId: binding.instanceId, inputHash: binding.inputHash, outcomeId: binding.outcomeId, timelineFps: 24, chapterTitle: '灯下等候',
    scenes: [
      { id: 'scene_1', title: '门外', location: '城门', time: '黄昏', blocks: [{ id: 'action_1', type: 'action', text: '牌子上写着 scene_1 和 dialogue_2，原文不得替换。' }, { id: 'dialogue_1', type: 'dialogue', speaker: '守门人', text: '在这等他吧。', entityId }] },
      { id: 'scene_2', title: '墙下', location: '城墙', time: '夜色渐起', blocks: [{ id: 'dialogue_2', type: 'dialogue', speaker: '守门人', text: '这里有灯。' }] },
    ], sourceRefs: [source], usedVariables: ['intent'], assertedFacts: [{ key: 'allowedWait', value: true, evidenceBlockIds: ['dialogue_1', 'dialogue_2'] }],
    shotPlan: [
      { id: 'shot_1', sceneId: 'scene_1', goal: '许可等待', action: '提灯', sound: '风声', durationFrames: 120, resourceRefs: [resource], dialogueBlockIds: ['dialogue_1'], frameReferences: [{ purpose: 'start', artifact }], providerPrompts: { h3: 'exact prompt mentioning shot_1 and dialogue_1' } },
      { id: 'shot_2', sceneId: 'scene_2', goal: '落定', action: '站定', sound: '轻风', durationFrames: 120, resourceRefs: [], dialogueBlockIds: ['dialogue_2'] },
    ], contentChecks: [{ ruleId: 'FACT', status: 'passed', evidenceBlockIds: ['action_1', 'dialogue_2'], message: '证据仅为自报，仍需独立检查' }] });
  return { draft, binding, source, resource, artifact, entityId };
}

test('11 local draft compiles all typed references deterministically without altering prose or frozen identities', () => {
  const x = fixture(), before = stable(x.draft), output = compileLocalRuntimeDraft(x.draft, x.binding);
  assert.ok(SegmentScriptV1.safeParse(output).success); assert.equal('format' in output, false);
  assert.deepEqual(output, compileLocalRuntimeDraft(x.draft, x.binding)); assert.equal(stable(x.draft), before);
  assert.equal(output.instanceId, x.binding.instanceId); assert.equal(output.inputHash, x.binding.inputHash); assert.equal(output.outcomeId, x.binding.outcomeId);
  assert.deepEqual(output.sourceRefs, x.draft.sourceRefs); assert.deepEqual(output.shotPlan[0]!.resourceRefs, [x.resource]); assert.deepEqual(output.shotPlan[0]!.frameReferences, x.binding.mediaReferences);
  assert.equal(output.scenes[0]!.blocks[1]!.entityId, x.entityId);
  assert.equal(output.scenes[0]!.blocks[0]!.text, x.draft.scenes[0]!.blocks[0]!.text); assert.deepEqual(output.shotPlan[0]!.providerPrompts, x.draft.shotPlan[0]!.providerPrompts);
  assert.equal(output.shotPlan[0]!.sceneId, output.scenes[0]!.id); assert.equal(output.shotPlan[1]!.sceneId, output.scenes[1]!.id);
  assert.deepEqual(output.shotPlan[0]!.dialogueBlockIds, [output.scenes[0]!.blocks[1]!.id]);
  assert.deepEqual(output.assertedFacts[0]!.evidenceBlockIds, [output.scenes[0]!.blocks[1]!.id, output.scenes[1]!.blocks[0]!.id]);
  assert.deepEqual(output.contentChecks[0]!.evidenceBlockIds, [output.scenes[0]!.blocks[0]!.id, output.scenes[1]!.blocks[0]!.id]);
  const ids = [...output.scenes.map(scene => scene.id), ...output.scenes.flatMap(scene => scene.blocks.map(block => block.id)), ...output.shotPlan.map(shot => shot.id)];
  assert.equal(new Set(ids).size, ids.length); for (const id of ids) assert.ok(Id.safeParse(id).success);
  const other = randomUUID(), changed = compileLocalRuntimeDraft({ ...x.draft, instanceId: other }, { ...x.binding, instanceId: other });
  assert.notEqual(changed.scenes[0]!.id, output.scenes[0]!.id);
  const reordered = compileLocalRuntimeDraft({ ...x.draft, scenes: [...x.draft.scenes].reverse(), shotPlan: [...x.draft.shotPlan].reverse() }, x.binding);
  assert.equal(reordered.scenes[1]!.id, output.scenes[0]!.id); assert.equal(reordered.shotPlan[1]!.id, output.shotPlan[0]!.id);
});

test('11 local draft rejects duplicate symbols in any identity domain and dangling or wrong-kind references', () => {
  const cases: ((draft: LocalRuntimeDraftV1) => void)[] = [
    draft => { draft.scenes[1]!.id = 'scene_1'; },
    draft => { draft.scenes[1]!.blocks[0]!.id = 'dialogue_1'; },
    draft => { draft.shotPlan[1]!.id = 'shot_1'; },
    draft => { draft.shotPlan[0]!.id = 'scene_1'; },
    draft => { draft.shotPlan[0]!.sceneId = 'missing'; },
    draft => { draft.assertedFacts[0]!.evidenceBlockIds = ['missing']; },
    draft => { draft.contentChecks[0]!.evidenceBlockIds = ['shot_1']; },
    draft => { draft.shotPlan[0]!.dialogueBlockIds = ['missing']; },
    draft => { draft.shotPlan[0]!.dialogueBlockIds = ['action_1']; },
    draft => { draft.shotPlan[0]!.dialogueBlockIds = ['dialogue_2']; },
  ];
  for (const change of cases) { const x = fixture(); change(x.draft); assert.throws(() => compileLocalRuntimeDraft(x.draft, x.binding), error => (error as { code?: string }).code === 'VALIDATION'); }
});

test('11 local draft never repairs instance/hash/outcome or author/resource/media references', () => {
  const cases: ((draft: LocalRuntimeDraftV1) => void)[] = [
    draft => { draft.instanceId = randomUUID(); }, draft => { draft.inputHash = 'b'.repeat(64); }, draft => { draft.outcomeId = 'openGate'; },
    draft => { draft.sourceRefs[0]!.seq++; }, draft => { draft.shotPlan[0]!.resourceRefs[0]!.id = randomUUID(); },
    draft => { draft.shotPlan[0]!.frameReferences![0]!.artifact.seq++; }, draft => { draft.shotPlan[0]!.frameReferences![0]!.purpose = 'end'; },
  ];
  for (const change of cases) { const x = fixture(); change(x.draft); const before = stable(x.draft); assert.throws(() => compileLocalRuntimeDraft(x.draft, x.binding)); assert.equal(stable(x.draft), before); }
  const x = fixture(); assert.throws(() => compileLocalRuntimeDraft(x.draft, { ...x.binding, mediaReferences: undefined }), /未授权首尾帧/);
});

test('11 local draft schema is strict, bounded and still requires UUIDs and revisions on external identities', () => {
  const x = fixture(); assert.ok(z.toJSONSchema(LocalRuntimeDraftV1).properties);
  for (const id of ['', 'a'.repeat(65), '1scene', '__proto__', 'scene.1', 'scene 1', '场景一']) assert.equal(LocalRuntimeDraftV1.safeParse({ ...x.draft, scenes: [{ ...x.draft.scenes[0], id }] }).success, false);
  assert.equal(LocalRuntimeDraftV1.safeParse({ ...x.draft, unexpected: true }).success, false);
  assert.equal(LocalRuntimeDraftV1.safeParse({ ...x.draft, format: 'other/v1' }).success, false);
  assert.equal(LocalRuntimeDraftV1.safeParse({ ...x.draft, instanceId: 'instance_1' }).success, false);
  assert.equal(LocalRuntimeDraftV1.safeParse({ ...x.draft, sourceRefs: [{ kind: 'scene', id: x.source.id }] }).success, false);
  const draft = structuredClone(x.draft); draft.scenes[0]!.blocks[1]!.entityId = 'entity_1'; assert.equal(LocalRuntimeDraftV1.safeParse(draft).success, false);
});

test('11 local draft format echo may be omitted but a conflicting tag remains invalid', () => {
  const x = fixture(), { format: _format, ...untagged } = x.draft, before = stable(untagged);
  assert.ok(LocalRuntimeDraftV1.safeParse(untagged).success);
  assert.deepEqual(compileLocalRuntimeDraft(untagged, x.binding), compileLocalRuntimeDraft(x.draft, x.binding));
  assert.equal(stable(untagged), before); assert.equal(Object.hasOwn(untagged, 'format'), false);
  assert.equal((z.toJSONSchema(LocalRuntimeDraftV1).required ?? []).includes('format'), false);
  for (const format of ['SegmentScriptV1', 'local-segment-draft/v2', '', null]) assert.throws(() => compileLocalRuntimeDraft({ ...untagged, format }, x.binding));
});
