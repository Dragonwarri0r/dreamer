import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { stable } from '../packages/contracts/foundation.ts';
import { ExperienceRun, RuntimeVisit, ScriptRelease, SegmentInstance, SegmentScriptV1 } from '../packages/contracts/experience.ts';
import { GenerationContract, ScriptPlanData } from '../packages/contracts/interactive-script.ts';
import { LocalRuntimeDraftV1 } from '../packages/contracts/local-runtime-draft.ts';
import type { RuntimeTextGenerator, RuntimeTextRequest } from '../packages/core/experience/generation.ts';
import { createChapterAcceptance, readChapterSource, type ChapterSourceEvidence } from '../scripts/interactive-local-chapter-acceptance.ts';

const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function evidence(): ChapterSourceEvidence {
  const projectId = randomUUID(), runId = randomUUID(), nodeId = randomUUID(), instanceId = randomUUID(), visitId = randomUUID(), releaseId = randomUUID(), endingId = randomUUID(), now = new Date().toISOString();
  const chapterRef = { kind: 'chapter' as const, id: randomUUID(), seq: 1 }, sceneRef = { kind: 'scene' as const, id: randomUUID(), seq: 1 };
  const contract = GenerationContract.parse({ id: randomUUID(), version: 1, scope: 'segment', reads: ['intention'], sourceRefs: [chapterRef, sceneRef], narrativeGoal: '准许旅人在门外等候', fixedFacts: [{ key: 'closed', text: '城门关闭', sourceRef: sceneRef }], allowedChanges: [], outcomeCases: [], fallbackOutcome: 'waitOutside', outcomes: [{ id: 'waitOutside', narrativeRequirement: '门外等候' }], resourceRefs: [], limits: { maxCharacters: 300, maxScenes: 1, maxShots: 1, targetSeconds: 5, maxTextCalls: 4, maxMediaJobs: 0, maxRepairAttempts: 1 }, checks: { structure: true, independentContent: true, mediaReady: true } });
  const snapshot = ScriptPlanData.parse({ schemaVersion: 1, title: 'Source fixture', chapterRefs: [chapterRef], entryNodeId: nodeId,
    variables: [{ key: 'intention', label: '请求', type: 'enum', scope: 'run', initial: 'wait', values: ['wait', 'enter'], allowedWriters: [] }, { key: 'allowedWait', label: '允许等候', type: 'boolean', scope: 'run', initial: false, allowedWriters: [{ sourceId: nodeId, commitAt: 'segmentCompleted' }] }],
    nodes: [{ id: nodeId, type: 'segment', mode: 'generated', title: '前一片段', outlineOrder: 0, chapterId: chapterRef.id, sourceSceneRefs: [sceneRef], contentSpec: { mode: 'generated', generationContract: contract }, next: endingId }, { id: endingId, type: 'ending', title: '等候', outlineOrder: 1, endingKey: 'waiting', summary: '城门外继续等候。' }] });
  const release = ScriptRelease.parse({ id: releaseId, projectId, scriptRef: { kind: 'script', id: randomUUID(), seq: 1 }, schemaVersion: 1, kind: 'playback', manifestHash: hash(snapshot), snapshot, dependencyRefs: [chapterRef, sceneRef], activityVersions: [], policy: snapshot.policy, createdAt: now });
  const script = SegmentScriptV1.parse({ schemaVersion: 1, instanceId, inputHash: 'a'.repeat(64), outcomeId: 'waitOutside', timelineFps: 24,
    scenes: [{ id: randomUUID(), title: '许可', location: '城门外', time: '黄昏', blocks: [{ id: randomUUID(), type: 'dialogue', speaker: '守门人', text: '在这等他吧。' }] }], sourceRefs: [chapterRef, sceneRef], usedVariables: ['intention'], assertedFacts: [], shotPlan: [{ id: randomUUID(), sceneId: nodeId, goal: '许可等候', action: '提灯点头', sound: '轻风', durationFrames: 120, resourceRefs: [] }], contentChecks: [] });
  script.shotPlan[0]!.sceneId = script.scenes[0]!.id;
  const run = ExperienceRun.parse({ id: runId, projectId, uid: 'source-reader', releaseId, manifestHash: release.manifestHash, mode: 'playback', stateSeq: 3, currentNodeId: endingId, currentVisitId: visitId, status: 'completed', variables: { intention: 'wait', allowedWait: true }, committedFacts: [], historyCursor: 0, createdAt: now, updatedAt: now });
  const visit = RuntimeVisit.parse({ id: visitId, runId, nodeId, instanceId, status: 'completed', ordinal: 0 });
  const instance = SegmentInstance.parse({ id: instanceId, runId, nodeId, visitId, releaseId, inputHash: script.inputHash, status: 'consumed', sourceRefs: [chapterRef, sceneRef], variableSnapshot: { intention: 'wait' }, outcomeId: script.outcomeId, resultRevision: 1, scriptResult: script,
    checks: ['structure', 'content', 'authorReview'].map(stage => ({ id: randomUUID(), stage, status: 'passed', resultRevision: 1, message: 'fixture only' })) });
  const sources = [{ ref: chapterRef, data: { title: '城门等候', number: 1, body: '城门关闭，旅人在外等朋友。' } }, { ref: sceneRef, data: { title: '守门人', chapterId: chapterRef.id, blocks: [{ id: randomUUID(), type: 'action', text: '蓝袍守门人提着暖黄色灯笼。' }] } }];
  const identity = { root: '/fixture-only', projectId, uid: run.uid, runId, instanceId, chapterRef, sceneRef };
  return { identity, sourceRoot: identity.root, run, visit, instance, release, node: snapshot.nodes[0] as ChapterSourceEvidence['node'], script, sources,
    proof: { sourceIdentity: '/fixture-only/identity.json', originalRef: { runId, instanceId, resultRevision: 1, contentHash: hash(script) }, sourceRunHash: hash(run), sourceInstanceHash: hash(instance), sourceReleaseHash: hash(release), sourceManifestHash: release.manifestHash, authorSources: sources.map(item => ({ ref: item.ref, contentHash: hash(item.data) })) } };
}
function fake(format: 'canonical' | 'local' = 'canonical') {
  const calls: RuntimeTextRequest[] = [];
  const generator: RuntimeTextGenerator = { configuration: () => ({ fingerprint: 'b'.repeat(64), description: { model: 'chapter-fixture-no-network', ...(format === 'local' ? { outputFormat: 'local-segment-draft/v1' } : {}) } }), async execute(request) {
    calls.push(request);
    if (request.stage === 'check') return { schemaVersion: 1, instanceId: request.input.instanceId, inputHash: request.input.inputHash, resultRevision: request.input.resultRevision, status: 'passed', checks: [{ ruleId: 'CONTINUITY', passed: true, evidenceBlockIds: [], message: '原许可持续有效，等待尚未结束' }] };
    const scenes = ['灯下片刻', '墙边余光'].map(title => ({ id: randomUUID(), title, location: '城门外', time: '黄昏', blocks: [{ id: randomUUID(), type: 'action', text: '城门依旧关着。守门人提稳暖黄色灯笼，旅人仍在画外等候朋友。' }] }));
    const result = { schemaVersion: 1, instanceId: request.input.instanceId, inputHash: request.input.inputHash, outcomeId: request.input.outcomeId, timelineFps: 24, chapterTitle: '灯下等候', scenes,
      sourceRefs: (request.input.context as any).sourceRefs, usedVariables: ['intention', 'allowedWait'], assertedFacts: [], shotPlan: scenes.map(scene => ({ id: randomUUID(), sceneId: scene.id, goal: '等候', action: '提灯站定', sound: '轻风', durationFrames: 120, resourceRefs: [] })), contentChecks: [] };
    return format === 'canonical' ? result : { ...result, format: 'local-segment-draft/v1',
      scenes: result.scenes.map((scene, index) => ({ ...scene, id: `scene_${index + 1}`, blocks: scene.blocks.map((block, blockIndex) => ({ ...block, id: `block_${index + 1}_${blockIndex + 1}` })) })),
      shotPlan: result.shotPlan.map((shot, index) => ({ ...shot, id: `shot_${index + 1}`, sceneId: `scene_${index + 1}` })) };
  } };
  return { calls, generator };
}

test('11 IT-12 isolated chapter acceptance copies fixed consumed content into its own run and stops at author review without media', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dreamer-chapter-acceptance-')), source = evidence(), before = stable(source), f = fake();
  const x = createChapterAcceptance(source, root, f.generator);
  try {
    x.prepare(); await x.coordinator.tick(x.scope);
    assert.deepEqual(f.calls.map(call => call.stage), ['write', 'check']);
    assert.equal((f.calls[0]!.input.contract as GenerationContract).scope, 'chapter');
    assert.deepEqual((f.calls[0]!.input.context as any).priorInstanceRefs, [x.copiedRef]);
    assert.notEqual(x.copiedRef.runId, source.proof.originalRef.runId);
    assert.equal(x.copiedRef.contentHash, source.proof.originalRef.contentHash);
    assert.deepEqual((f.calls[0]!.input.sources as unknown[]).map(stable).sort(), source.sources.map(stable).sort());
    assert.deepEqual((f.calls[0]!.input.previousContent as any[])[0].script, source.script);
    assert.equal(x.instance().status, 'waitingReview'); assert.equal(x.instance().scriptResult!.scenes.length, 2);
    assert.equal(x.store.experience.usage(x.scope).runMedia, 0); assert.equal(stable(source), before);
  } finally { x.close(); rmSync(root, { recursive: true, force: true }); }
});

test('11 chapter source reader is read-only and rejects unconsumed or revision-mismatched source evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'dreamer-chapter-source-')), source = evidence(), f = fake(), x = createChapterAcceptance(source, root, f.generator);
  const identityPath = join(root, 'identity.json');
  writeFileSync(identityPath, JSON.stringify({ ...source.identity, root, projectId: x.scope.projectId, uid: x.scope.uid, runId: x.scope.runId }));
  x.close();
  try {
    // Author snapshots are explicit isolated fixture rows; no production database is opened for writing.
    const db = new DatabaseSync(join(root, 'dreamer.sqlite'));
    for (const item of source.sources) db.prepare(`INSERT INTO ${item.ref.kind}_revisions VALUES(?,?,?,?,?)`).run(item.ref.id, x.scope.projectId, item.ref.seq, stable(item.data), new Date().toISOString());
    db.close();
    const checksum = () => createHash('sha256').update(readFileSync(join(root, 'dreamer.sqlite'))).digest('hex'), before = checksum();
    const actual = readChapterSource(identityPath);
    assert.equal(actual.proof.originalRef.runId, x.scope.runId); assert.equal(actual.proof.originalRef.contentHash, source.proof.originalRef.contentHash);
    assert.equal(checksum(), before); assert.equal(f.calls.length, 0);
    for (const patch of [{ status: 'ready' }, { status: 'consumed', resultRevision: 2 }]) {
      const edit = new DatabaseSync(join(root, 'dreamer.sqlite'));
      const row = edit.prepare('SELECT body FROM experience_instances WHERE id=?').get(source.instance.id)!;
      edit.prepare('UPDATE experience_instances SET body=? WHERE id=?').run(stable({ ...JSON.parse(String(row.body)), ...patch }), source.instance.id); edit.close();
      assert.throws(() => readChapterSource(identityPath), patch.status === 'ready' ? /consume/ : /has not passed/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('11 chapter acceptance is compatible with the frozen local-draft format while prior context and review remain canonical', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dreamer-chapter-local-draft-')), source = evidence(), f = fake('local'), x = createChapterAcceptance(source, root, f.generator);
  try {
    x.prepare(); await x.coordinator.tick(x.scope);
    assert.deepEqual(f.calls.map(call => call.stage), ['write', 'check']);
    assert.deepEqual((f.calls[0]!.input.previousContent as any[])[0].script, source.script);
    const raw = x.store.experience.list<any>('dispatches', x.scope).find(row => row.data.stage === 'write')!.data.result;
    assert.ok(LocalRuntimeDraftV1.safeParse(raw).success); assert.equal(raw.scenes[0].id, 'scene_1');
    const result = x.instance().scriptResult!;
    assert.ok(SegmentScriptV1.safeParse(result).success); assert.equal('format' in result, false);
    assert.deepEqual(result.sourceRefs.map(stable).sort(), source.sources.map(item => stable(item.ref)).sort());
    assert.deepEqual(f.calls[1]!.input.script, result); assert.equal(x.instance().status, 'waitingReview');
    assert.equal(x.store.experience.usage(x.scope).runMedia, 0); assert.equal(x.store.experience.usage(x.scope).runText, 2);
  } finally { x.close(); rmSync(root, { recursive: true, force: true }); }
});
