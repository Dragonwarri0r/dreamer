import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../packages/infra/sqlite.ts';
import { ProjectData, type Ref } from '../packages/contracts/foundation.ts';
import { ScriptPlanData } from '../packages/contracts/interactive-script.ts';
import { PlayableSegment, SegmentScriptV1, ScriptRelease, type RuntimeCommand, type RuntimeView } from '../packages/contracts/experience.ts';
import { ExperienceRuntime, type RuntimeHooks } from '../packages/core/experience/runtime.ts';
import { contentHash, mediaPlanId } from '../packages/core/story/script.ts';

function setup(options: { playback?: boolean; cue?: boolean; hooks?: RuntimeHooks; mutate?: (plan: any) => void } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'dreamer-runtime-')), root = join(parent, 'data');
  const store = new SqliteStore(root), projectId = randomUUID(), principal = { projectId, uid: 'reader-a' };
  store.repository('project', ProjectData).create(projectId, ProjectData.parse({ title: '互动故事' }), projectId);
  const ids = Object.fromEntries(['segment', 'activity', 'branch', 'checkpoint', 'ending', 'earlyEnding', 'activityDef', 'scene', 'build', 'artifact'].map(key => [key, randomUUID()]));
  const media = { buildRef: { kind: 'build' as const, id: ids.build, seq: 1 }, fromFrame: 0, toFrame: 240, fps: 24, contentHash: 'a'.repeat(64) };
  const plan: any = { schemaVersion: 1, title: '选择路线', chapterRefs: [], entryNodeId: ids.segment, policy: {},
    variables: [
      { key: 'path', label: '路线', scope: 'run', type: 'enum', initial: 'left', values: ['left', 'right'], allowedWriters: [{ sourceId: ids.activity, commitAt: 'activityAccepted' }] },
      { key: 'score', label: '得分', scope: 'run', type: 'integer', initial: 0, min: 0, max: 30, allowedWriters: [{ sourceId: ids.activity, commitAt: 'activityAccepted' }, { sourceId: ids.segment, commitAt: 'segmentCompleted' }, { sourceId: ids.checkpoint, commitAt: 'checkpointReached' }] },
    ],
    nodes: [
      { id: ids.segment, type: 'segment', title: '片段', outlineOrder: 0, mode: 'fixed', sourceSceneRefs: [], contentSpec: { mode: 'fixed', ...(options.playback ? { media } : {}) }, next: ids.activity,
        completionEffects: [{ id: randomUUID(), op: 'increment', key: 'score', value: { source: 'constant', value: 2 }, commitAt: 'segmentCompleted' }] },
      { id: ids.activity, type: 'activity', title: '选择', outlineOrder: 1, activityId: ids.activityDef, next: ids.branch },
      { id: ids.branch, type: 'branch', title: '分路', outlineOrder: 2, cases: [{ id: randomUUID(), priority: 1, when: { op: 'eq', key: 'path', value: 'right' }, to: ids.earlyEnding }], fallback: { id: randomUUID(), to: ids.checkpoint } },
      { id: ids.checkpoint, type: 'checkpoint', title: '汇合', outlineOrder: 3, next: ids.ending,
        commitEffects: [{ id: randomUUID(), op: 'increment', key: 'score', value: { source: 'constant', value: 10 }, commitAt: 'checkpointReached' }] },
      { id: ids.ending, type: 'ending', title: '结局', outlineOrder: 4, endingKey: 'normal', summary: '正常结束' },
      { id: ids.earlyEnding, type: 'ending', title: '提前结局', outlineOrder: 5, endingKey: 'early', summary: '提前结束' },
    ],
    activities: [{ id: ids.activityDef, type: 'choice', version: 1, label: '往哪里走', presentation: { rendererKey: 'choice', prompt: '你选择哪条路？' }, config: { options: [{ id: 'left', label: '左路' }, { id: 'right', label: '右路' }] },
      resultMapping: [{ id: randomUUID(), op: 'set', key: 'path', value: { source: 'result', field: 'optionId' }, commitAt: 'activityAccepted' },
        { id: randomUUID(), op: 'increment', key: 'score', value: { source: 'constant', value: 1 }, commitAt: 'activityAccepted' }] }],
    cues: options.cue ? [{ id: randomUUID(), activityNodeId: ids.activity, segmentNodeId: ids.segment, anchor: { ref: { kind: 'scene', id: ids.scene, seq: 1 }, position: 'after' },
      ...(options.playback ? { resolvedBinding: { planId: mediaPlanId(media), contentHash: media.contentHash, fps: 24, appearFrame: 48 } } : {}), deadlineFrame: 192, activateAt: 'segmentEnd' }] : [],
  };
  options.mutate?.(plan);
  const snapshot = ScriptPlanData.parse(plan), now = new Date().toISOString();
  const release = ScriptRelease.parse({ id: randomUUID(), projectId, scriptRef: { kind: 'script', id: randomUUID(), seq: 1 }, schemaVersion: 1,
    kind: options.playback ? 'playback' : 'simulation', manifestHash: contentHash(snapshot), snapshot, policy: snapshot.policy, dependencyRefs: [],
    activityVersions: snapshot.activities.map(a => ({ type: a.type, version: a.version })), createdAt: now });
  store.experience.create('releases', { projectId }, release, release.id);
  const read = (ref: Ref) => ({ id: ref.id, projectId, seq: 1, updatedAt: now, data: ref.kind === 'build'
    ? { output: { kind: 'artifact', id: ids.artifact, seq: 1 }, snapshot: { fps: 24 }, range: { startFrame: 0, endFrame: 240 } }
    : { mediaType: 'video/mp4', sha256: media.contentHash, durationSeconds: 10, title: '媒体' } });
  const runtime = new ExperienceRuntime(store.experience, read, options.hooks);
  const startInput = { protocolVersion: 1 as const, requestId: randomUUID(), projectId, releaseId: release.id, mode: release.kind };
  const started = runtime.start(principal, startInput);
  const command = (view: RuntimeView, operation: string, payload: unknown, visitId = view.run.currentVisitId, requestId = randomUUID()) => runtime.execute(principal, {
    protocolVersion: 1, requestId, runId: view.run.id, expectedStateSeq: view.run.stateSeq, visitId, operation, payload,
  } as RuntimeCommand);
  const complete = (view: RuntimeView) => command(view, 'segment.complete', { instanceId: view.instance!.id, planHash: view.playback?.planHash ?? view.instance!.inputHash, frame: view.playback?.durationFrames ?? 0 });
  return { parent, root, store, principal, ids, release, runtime, read, startInput, started, command, complete, close() { store.close(); rmSync(parent, { recursive: true, force: true }); } };
}

test('11 模拟提前输入只提交活动效果，片段结束后分路；重复输入与ended不重复加分', () => {
  let calls = 0;
  const x = setup({ cue: true, hooks: { prepare() { calls++; throw new Error('simulation must not generate'); } } });
  try {
    assert.ok(x.started.view.attempt); assert.equal(x.started.view.run.variables.score, 0);
    assert.equal(x.runtime.trace(x.principal, x.started.view.run.id).visits.length, 1);
    const input = { optionId: 'right' }, view = x.started.view;
    const accepted = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input }, view.attempt!.visitId);
    assert.equal(accepted.view.run.variables.score, 1); assert.equal(accepted.view.run.currentNodeId, x.ids.segment);
    const repeated = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input }, view.attempt!.visitId);
    assert.equal(repeated.receipt.replayed, true); assert.equal(repeated.view.run.variables.score, 1);
    const completed = x.complete(accepted.view);
    assert.equal(completed.view.run.status, 'completed'); assert.equal(completed.view.run.currentNodeId, x.ids.earlyEnding); assert.equal(completed.view.run.variables.score, 3);
    assert.equal(x.complete(accepted.view).receipt.replayed, true); assert.equal(calls, 0);
    assert.deepEqual(x.runtime.trace(x.principal, view.run.id).visits.map(v => v.title), ['片段', '选择', '分路', '提前结局']);
  } finally { x.close(); }
});

test('11 视频时码到点开放输入，seek不能越过deadline，positionSeq不改剧情stateSeq', () => {
  const x = setup({ playback: true, cue: true });
  try {
    let view = x.started.view;
    assert.equal(view.attempt, undefined);
    const saved = x.runtime.positionSave(x.principal, { protocolVersion: 1, requestId: randomUUID(), runId: view.run.id, visitId: view.run.currentVisitId,
      planHash: view.playback!.planHash, frame: 230, expectedPositionSeq: 0 });
    view = saved.view; assert.equal(saved.position?.frame, 192); assert.equal(view.run.stateSeq, 1); assert.ok(view.attempt);
    const accepted = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'left' } }, view.attempt!.visitId);
    assert.equal(accepted.view.run.variables.score, 1);
    const ended = x.complete(accepted.view);
    assert.equal(ended.view.run.variables.score, 13); assert.equal(ended.view.run.status, 'completed');
    assert.equal(x.runtime.trace(x.principal, view.run.id).visits.filter(v => v.nodeId === x.ids.activity).length, 1);
  } finally { x.close(); }
});

test('11 回执先于CAS，错误输入整事务回滚，run固定版本恢复且不泄漏别的uid', () => {
  const x = setup({ cue: true });
  try {
    const view = x.started.view, requestId = randomUUID();
    assert.throws(() => x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'unlisted' } }, view.attempt!.visitId, requestId), /选项/);
    assert.equal(x.runtime.view(x.principal, view.run.id).run.stateSeq, 1);
    const accepted = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'left' } }, view.attempt!.visitId, requestId);
    assert.equal(x.runtime.start(x.principal, x.startInput).receipt.replayed, true);
    assert.equal(x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'left' } }, view.attempt!.visitId, requestId).receipt.replayed, true);
    assert.throws(() => x.runtime.view({ ...x.principal, uid: 'reader-b' }, view.run.id), /当前范围/);
    assert.equal(x.runtime.runs({ ...x.principal, uid: 'reader-b' }).length, 0);
    assert.equal(Object.hasOwn(accepted.view, 'snapshot'), false);
    x.store.close();
    const reopened = new SqliteStore(x.root), runtime = new ExperienceRuntime(reopened.experience, x.read);
    try {
      assert.equal(runtime.view(x.principal, view.run.id).run.variables.score, 1); assert.equal(runtime.view(x.principal, view.run.id).run.releaseId, x.release.id);
      const receipt = runtime.receipt(x.principal, { protocolVersion: 1, requestId, runId: view.run.id, expectedStateSeq: view.run.stateSeq, visitId: view.attempt!.visitId,
        operation: 'activity.submit', payload: { attemptId: view.attempt!.id, input: { optionId: 'left' } } });
      assert.ok(receipt); assert.equal(runtime.view(x.principal, view.run.id).run.variables.score, 1);
    }
    finally { reopened.close(); }
  } finally { rmSync(x.parent, { recursive: true, force: true }); }
});

test('11 IT-08 same-uid runs reject exchanged attempts and replay starts with fresh variables and receipts', () => {
  const x = setup({ cue: true });
  try {
    const first = x.started.view, second = x.runtime.start(x.principal, { ...x.startInput, requestId: randomUUID() }).view;
    assert.notEqual(first.run.id, second.run.id); assert.notEqual(first.attempt!.id, second.attempt!.id);
    assert.throws(() => x.command(first, 'activity.submit', { attemptId: second.attempt!.id, input: { optionId: 'right' } }, first.attempt!.visitId), /当前范围|匹配|当前活动/);
    const accepted = x.command(first, 'activity.submit', { attemptId: first.attempt!.id, input: { optionId: 'right' } }, first.attempt!.visitId).view;
    x.complete(accepted);
    assert.equal(x.runtime.view(x.principal, first.run.id).run.variables.score, 3);
    assert.equal(x.runtime.view(x.principal, second.run.id).run.variables.score, 0);
    assert.equal(x.runtime.view(x.principal, second.run.id).run.variables.path, 'left');
    const replay = x.runtime.start(x.principal, { ...x.startInput, requestId: randomUUID() }).view;
    assert.equal(replay.run.variables.score, 0); assert.equal(replay.run.committedFacts.length, 0);
    assert.notEqual(replay.instance!.id, first.instance!.id); assert.equal(x.runtime.runs(x.principal).length, 3);
  } finally { x.close(); }
});

test('11 IT-17 extension simulation success and explicit skip map once; duplicate terminal input cannot repeat effects', () => {
  for (const skipped of [false, true]) {
    const x = setup({ mutate(plan) {
      plan.entryNodeId = plan.nodes[1].id;
      plan.activities[0] = { ...plan.activities[0], type: 'puzzle', skipPolicy: { mode: 'allowed', result: { optionId: 'left' } },
        config: { simulationResults: [{ id: 'win', label: '模拟成功', result: { optionId: 'left' } }] } };
    } });
    try {
      const view = x.started.view, operation = skipped ? 'activity.skip' : 'activity.submit';
      const payload = { attemptId: view.attempt!.id, ...(skipped ? {} : { input: { fixtureId: 'win' } }) };
      const completed = x.command(view, operation, payload).view;
      assert.equal(completed.run.status, 'completed'); assert.equal(completed.run.variables.score, 11);
      assert.equal(x.runtime.activity(x.principal, view.run.id, view.attempt!.id).status, skipped ? 'skipped' : 'completed');
      const repeated = x.command(view, operation, payload).view;
      assert.equal(repeated.run.variables.score, 11); assert.equal(repeated.run.committedFacts.length, completed.run.committedFacts.length);
    } finally { x.close(); }
  }
});

test('11 媒体访问只接受已开放run/plan/binding，相同hash不能扩大用户权限', () => {
  const x = setup({ playback: true });
  try {
    const view = x.started.view, binding = view.playback!.bindings[0];
    assert.equal(x.runtime.media(x.principal, view.run.id, view.playback!.planHash, binding.id).data.sha256, 'a'.repeat(64));
    assert.throws(() => x.runtime.media({ ...x.principal, uid: 'reader-b' }, view.run.id, view.playback!.planHash, binding.id), /当前范围/);
    assert.throws(() => x.runtime.media(x.principal, view.run.id, 'b'.repeat(64), binding.id), /未授权/);
    assert.throws(() => x.runtime.media(x.principal, view.run.id, view.playback!.planHash, x.ids.artifact), /未授权/);
  } finally { x.close(); }
});

test('11 扩展活动模拟仅接受已声明fixture；合法游戏失败是completed而不是执行failed', () => {
  const x = setup({ mutate(plan) {
    plan.entryNodeId = plan.nodes[1].id;
    plan.activities[0] = { ...plan.activities[0], type: 'puzzle', config: { simulationResults: [{ id: 'lose', label: '模拟失败', result: { optionId: 'left' } }] } };
  } });
  try {
    const view = x.started.view;
    assert.deepEqual(view.activity!.options, [{ id: 'lose', label: '模拟失败' }]);
    assert.throws(() => x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'left' } }), /夹具/);
    const result = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { fixtureId: 'lose' } });
    assert.equal(result.view.run.status, 'completed');
    assert.equal(x.runtime.activity(x.principal, view.run.id, view.attempt!.id).status, 'completed');
  } finally { x.close(); }
});

test('11 已完成实例不能被异步结果热替换，重放已消费输入不生成新结果', () => {
  const x = setup({ cue: true });
  try {
    const view = x.started.view, scope = { ...x.principal, runId: view.run.id };
    const instance = x.runtime.instance(x.principal, view.run.id, view.instance!.id);
    x.runtime.acceptPrepared(scope, { ...instance, status: 'blocked' });
    assert.equal(x.runtime.view(x.principal, view.run.id).instance?.status, 'ready');
    assert.equal(x.store.experience.list('instances', scope).length, 1);
  } finally { x.close(); }
});

test('11 consumer instance retries expose the active preparation stage and clear the old failure reason', () => {
  for (const status of ['writing', 'checking', 'producing', 'waitingReview'] as const) {
    const x = setup({ playback: true, hooks: {
      prepare: context => ({ ...context.instance, status: 'blocked', recoveryReason: '旧失败原因' }),
      instanceCommand: context => ({ ...context.instance, status, ...(context.operation === 'instance.cancel' ? { cancelRequested: true, recoveryReason: '正在核对取消原任务' } : {}) }),
    }, mutate(plan) {
      plan.nodes[0].mode = 'generated';
      plan.nodes[0].contentSpec = { mode: 'generated', generationContract: { id: randomUUID(), version: 1, scope: 'segment', reads: [], narrativeGoal: '继续', allowedChanges: [],
        outcomeCases: [], fallbackOutcome: 'continue', outcomes: [{ id: 'continue', narrativeRequirement: '继续' }],
        limits: { maxCharacters: 1000, maxScenes: 1, maxShots: 1, targetSeconds: 5, maxTextCalls: 2, maxMediaJobs: 1, maxRepairAttempts: 1 }, checks: { structure: true, independentContent: false, mediaReady: true } } };
    } });
    try {
      assert.equal(x.started.view.run.status, 'blocked'); assert.equal(x.started.view.run.waitReason, '旧失败原因');
      const response = x.command(x.started.view, 'instance.retry', { instanceId: x.started.view.instance!.id, failedStage: status === 'producing' ? 'producing' : 'writing' });
      assert.equal(response.view.instance!.status, status); assert.equal(response.view.run.status, 'waitingContent'); assert.equal(response.receipt.nextAction, 'wait');
      assert.equal(response.view.run.waitReason, ({ writing: '正在准备本次片段正文', checking: '正在检查本次片段内容', producing: '正在生成本次片段媒体', waitingReview: '等待作者确认本次生成内容' })[status]);
      const refreshed = x.runtime.refresh(x.principal, response.view.run.id);
      assert.equal(refreshed.run.waitReason, response.view.run.waitReason);
      const cancelled = x.command(refreshed, 'instance.cancel', { instanceId: response.view.instance!.id });
      assert.equal(cancelled.view.run.waitReason, '正在核对取消原任务');
      assert.equal(cancelled.view.instance!.cancelRequested, true);
      assert.equal(response.view.instance!.cancelRequested, false);
    } finally { x.close(); }
  }
});

test('11 consumer save titles and accepted choice labels stay pinned to the release, including simulations', () => {
  for (const playback of [false, true]) {
    const x = setup({ playback });
    try {
      const author = x.store.repository('script', ScriptPlanData).create(x.principal.projectId, x.release.snapshot, x.release.scriptRef.id);
      x.store.repository('script', ScriptPlanData).save(author.id, x.principal.projectId, author.seq, { ...author.data, title: '作者后来改名' });
      assert.equal(x.runtime.runs(x.principal)[0]!.title, '选择路线');
      assert.equal(x.runtime.runs({ ...x.principal, uid: 'different-reader' }).length, 0);
      assert.equal(Object.hasOwn(x.store.experience.get('runs', x.started.view.run.id, x.principal).data as object, 'title'), false);
      let view = x.complete(x.started.view).view;
      assert.equal(x.runtime.tracePage(x.principal, view.run.id).visits.find(v => v.nodeId === x.ids.activity)?.resultLabel, undefined);
      view = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'left' } }).view;
      assert.equal(x.runtime.tracePage(x.principal, view.run.id).visits.find(v => v.nodeId === x.ids.activity)?.resultLabel, '左路');
    } finally { x.close(); }
  }
});

test('11 有界预生成复用固定读集实例，不提前走未来路线或提交片段效果', () => {
  for (const unstable of [false, true]) {
    let calls = 0, observedScore: unknown;
    const dynamicId = randomUUID();
    const x = setup({ playback: true, cue: true, hooks: { prepare(context) { calls++; observedScore = context.run.variables.score; return { ...context.instance, status: 'writing' }; } }, mutate(plan) {
      plan.policy.prefetchDepth = 1;
      plan.nodes[2].fallback.to = dynamicId;
      plan.nodes.push({ id: dynamicId, type: 'segment', title: '动态片段', outlineOrder: 6, mode: 'generated', sourceSceneRefs: [], next: plan.nodes[3].id,
        contentSpec: { mode: 'generated', generationContract: { id: randomUUID(), version: 1, scope: 'segment', reads: [unstable ? 'score' : 'path'], narrativeGoal: '回应选择', allowedChanges: [{ field: 'dialogue', constraint: '保持结局' }],
          outcomeCases: [], fallbackOutcome: 'continue', outcomes: [{ id: 'continue', narrativeRequirement: '继续前行' }],
          limits: { maxCharacters: 1000, maxScenes: 1, maxShots: 1, targetSeconds: 5, maxTextCalls: 1, maxMediaJobs: 1, maxRepairAttempts: 0 }, checks: { structure: true, independentContent: false, mediaReady: true } } } });
    } });
    try {
      let view = x.started.view;
      view = x.runtime.positionSave(x.principal, { protocolVersion: 1, requestId: randomUUID(), runId: view.run.id, visitId: view.run.currentVisitId, planHash: view.playback!.planHash, frame: 48, expectedPositionSeq: 0 }).view;
      view = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'left' } }, view.attempt!.visitId).view;
      assert.equal(calls, unstable ? 0 : 1);
      assert.equal(x.runtime.trace(x.principal, view.run.id).visits.some(v => v.nodeId === dynamicId), false);
      assert.equal(view.run.variables.score, 1);
      const next = x.complete(view).view;
      assert.equal(calls, 1); assert.equal(observedScore, unstable ? 3 : 1);
      assert.equal(next.run.currentNodeId, dynamicId); assert.equal(next.instance?.status, 'writing');
      assert.deepEqual(x.runtime.trace(x.principal, view.run.id).visits.map(v => v.title), ['片段', '选择', '分路', '动态片段']);
    } finally { x.close(); }
  }
});

test('11 文本解释需确认合法候选，确认前不提交变量，异步回写原子推进且重复确认不重复加分', () => {
  const x = setup({ playback: true, hooks: { activity(context) { return { ...context.attempt, input: context.input as any, status: 'interpreting', executionIds: [randomUUID()] }; } }, mutate(plan) {
    plan.entryNodeId = plan.nodes[1].id;
    plan.activities[0] = { ...plan.activities[0], type: 'text-intent', config: { maxLength: 200, intents: [{ id: 'left', label: '左路' }, { id: 'right', label: '右路' }], interpretationTemplate: { id: 'intent', version: 1 }, extractedFields: [] } };
    plan.activities[0].resultMapping[0].value.field = 'intentId';
  } });
  try {
    const submitted = x.command(x.started.view, 'activity.submit', { attemptId: x.started.view.attempt!.id, input: { text: '我想谨慎一点' } }).view;
    assert.equal(submitted.run.status, 'waitingContent'); assert.equal(submitted.run.variables.score, 0);
    const attempt = x.runtime.activity(x.principal, submitted.run.id, submitted.attempt!.id), interpretationRef = randomUUID();
    const ready = x.runtime.acceptActivity({ ...x.principal, runId: submitted.run.id }, { ...attempt, status: 'needsConfirmation', interpretationRef,
      interpretation: { schemaVersion: 1, candidateIntentIds: ['left'], extractedValues: {}, needsConfirmation: true, explanation: '确认左路？', inputHash: 'b'.repeat(64) } });
    assert.equal(ready.run.variables.score, 0); assert.deepEqual(ready.activity?.options, [{ id: 'left', label: '左路' }]);
    assert.throws(() => x.command(ready, 'activity.confirmIntent', { attemptId: attempt.id, interpretationRef, intentId: 'right' }), /提供的意图/);
    const completed = x.command(ready, 'activity.confirmIntent', { attemptId: attempt.id, interpretationRef, intentId: 'left' });
    assert.equal(completed.view.run.variables.score, 11); assert.equal(completed.view.run.status, 'completed');
    assert.equal(x.command(ready, 'activity.confirmIntent', { attemptId: attempt.id, interpretationRef, intentId: 'left' }).receipt.replayed, true);
  } finally { x.close(); }
});

test('11 未知内置活动版本保留定义但阻断执行；模板变量正文与选定固定媒体一起保存', () => {
  const unsupported = setup({ mutate(plan) { plan.entryNodeId = plan.nodes[1].id; plan.activities[0].version = 2; } });
  try { assert.equal(unsupported.started.view.run.status, 'blocked'); assert.match(unsupported.started.view.run.waitReason!, /尚未安装/); }
  finally { unsupported.close(); }
  const template = setup({ playback: true, mutate(plan) {
    const media = plan.nodes[0].contentSpec.media;
    plan.nodes[0].mode = 'template';
    plan.nodes[0].contentSpec = { mode: 'template', reads: ['path'], text: '前往 {{path}} 路。', variants: [{ id: randomUUID(), when: { op: 'eq', key: 'path', value: 'left' }, media, outcomeId: 'left' }] };
  } });
  try {
    const view = template.started.view;
    const instance = template.runtime.instance(template.principal, view.run.id, view.instance!.id);
    assert.equal(instance.templateResult?.text, '前往 left 路。');
    assert.equal(instance.templateResult?.media?.contentHash, view.playback?.bindings[0].contentHash);
  } finally { template.close(); }
});

test('11 当前片段完成效果会改变模板变体条件时，不预取或复用旧变体，hash涵盖条件读集', () => {
  for (const declared of [false, true]) {
    const targetId = randomUUID();
    const x = setup({ playback: true, cue: true, hooks: { prepare() { throw new Error('fixed template must not generate'); } }, mutate(plan) {
      plan.policy.prefetchDepth = 1; plan.nodes[2].fallback.to = targetId;
      const media = plan.nodes[0].contentSpec.media;
      plan.nodes.push({ id: targetId, type: 'segment', title: '按完成结果选择变体', outlineOrder: 6, mode: 'template', sourceSceneRefs: [], next: plan.nodes[3].id,
        contentSpec: { mode: 'template', reads: declared ? ['path', 'score'] : ['path'], text: '前往 {{path}} 路。', variants: [
          { id: randomUUID(), when: { op: 'lte', key: 'score', value: 1 }, media, outcomeId: 'continue' },
          { id: randomUUID(), when: { op: 'gte', key: 'score', value: 2 }, media: { ...media, toFrame: 120 }, outcomeId: 'continue' },
        ] } });
    } });
    try {
      let view = x.started.view;
      const scope = { ...x.principal, runId: view.run.id };
      view = x.runtime.positionSave(x.principal, { protocolVersion: 1, requestId: randomUUID(), runId: view.run.id, visitId: view.run.currentVisitId, planHash: view.playback!.planHash, frame: 48, expectedPositionSeq: 0 }).view;
      view = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'left' } }, view.attempt!.visitId).view;
      assert.equal(view.run.variables.score, 1);
      assert.equal(x.store.experience.list<any>('instances', scope).some(row => row.data.nodeId === targetId), false);
      view = x.complete(view).view;
      assert.equal(view.run.currentNodeId, targetId); assert.equal(view.playback?.durationFrames, 120);
      const instance = x.runtime.instance(x.principal, view.run.id, view.instance!.id);
      assert.equal(instance.inputHash, contentHash({ release: x.release.manifestHash, nodeId: targetId, variables: { path: 'left', score: 3 } }));
      assert.equal(instance.resultRevision, 1);
      assert.equal(instance.templateResult?.contentHash, contentHash({ text: instance.templateResult?.text, media: instance.templateResult?.media }));
    } finally { x.close(); }
  }
});

test('11 当前模板正文消费后才准备下一段，播放中输入不重写已冻结正文', () => {
  let calls = 0, consumedText: string | undefined, consumedRevision: number | undefined;
  const targetId = randomUUID();
  const x = setup({ playback: true, cue: true, hooks: { prepare(context) {
    calls++;
    const prior = x.store.experience.list<any>('instances', context.scope).find(row => row.data.nodeId === x.ids.segment)!.data;
    assert.equal(prior.status, 'consumed'); consumedText = prior.templateResult.text; consumedRevision = prior.resultRevision;
    return { ...context.instance, status: 'writing' };
  } }, mutate(plan) {
    plan.policy.prefetchDepth = 1; plan.nodes[2].cases[0].when.value = 'left'; plan.nodes[2].fallback.to = targetId;
    const current = plan.nodes[0], media = current.contentSpec.media;
    current.mode = 'template'; current.completionEffects = [];
    current.contentSpec = { mode: 'template', reads: ['path'], text: '已经走在 {{path}} 路上。', variants: [{ id: randomUUID(), when: { op: 'eq', key: 'path', value: 'left' }, media, outcomeId: 'continue' }] };
    plan.nodes.push({ id: targetId, type: 'segment', title: '回应已播放正文', outlineOrder: 6, mode: 'generated', sourceSceneRefs: [], next: plan.nodes[3].id,
      contentSpec: { mode: 'generated', generationContract: { id: randomUUID(), version: 1, scope: 'segment', reads: ['path'], narrativeGoal: '回应刚才的路与新选择', allowedChanges: [{ field: 'dialogue', constraint: '保持结局' }],
        outcomeCases: [], fallbackOutcome: 'continue', outcomes: [{ id: 'continue', narrativeRequirement: '继续前行' }], limits: { maxCharacters: 1000, maxScenes: 1, maxShots: 1, targetSeconds: 5, maxTextCalls: 1, maxMediaJobs: 1, maxRepairAttempts: 0 }, checks: { structure: true, independentContent: false, mediaReady: true } } } });
  } });
  try {
    let view = x.started.view;
    const original = x.runtime.instance(x.principal, view.run.id, view.instance!.id);
    view = x.runtime.positionSave(x.principal, { protocolVersion: 1, requestId: randomUUID(), runId: view.run.id, visitId: view.run.currentVisitId, planHash: view.playback!.planHash, frame: 48, expectedPositionSeq: 0 }).view;
    view = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'right' } }, view.attempt!.visitId).view;
    assert.equal(calls, 0); assert.equal(view.run.variables.path, 'right');
    assert.equal(x.store.experience.list<any>('instances', { ...x.principal, runId: view.run.id }).some(row => row.data.nodeId === targetId), false);
    view = x.complete(view).view;
    assert.equal(calls, 1); assert.equal(consumedText, '已经走在 left 路上。'); assert.equal(consumedRevision, 1);
    x.runtime.acceptPrepared({ ...x.principal, runId: view.run.id }, { ...original, templateResult: { ...original.templateResult!, text: '不允许热替换' } });
    const consumed = x.runtime.instance(x.principal, view.run.id, original.id);
    assert.deepEqual(consumed.templateResult, original.templateResult); assert.equal(consumed.resultRevision, 1);
  } finally { x.close(); }
});

test('11 生成视频中的Cue输入等待当前正文消费后才准备后继，不复用缺前文的预取实例', () => {
  const targetId = randomUUID();
  let preparedNext = 0, consumedText: string | undefined;
  const x = setup({ playback: true, cue: true, hooks: { prepare(context) {
    if (context.node.id === targetId) {
      preparedNext++;
      const prior = x.store.experience.list<any>('instances', context.scope).find(row => row.data.nodeId === x.ids.segment)!.data;
      assert.equal(prior.status, 'consumed');
      consumedText = prior.scriptResult.scenes[0].blocks[0].text;
    }
    return { ...context.instance, status: 'writing' };
  } }, mutate(plan) {
    const contract = { id: randomUUID(), version: 1, scope: 'segment', reads: ['path'], narrativeGoal: '延续实际经历的前文', allowedChanges: [{ field: 'dialogue', constraint: '保持结局' }],
      outcomeCases: [], fallbackOutcome: 'continue', outcomes: [{ id: 'continue', narrativeRequirement: '继续前行' }],
      limits: { maxCharacters: 1000, maxScenes: 1, maxShots: 1, targetSeconds: 5, maxTextCalls: 1, maxMediaJobs: 1, maxRepairAttempts: 0 }, checks: { structure: true, independentContent: false, mediaReady: true } };
    plan.policy.prefetchDepth = 1; plan.policy.maxDynamicNodesPerRun = 2; plan.nodes[2].fallback.to = targetId;
    plan.nodes[0].mode = 'generated'; plan.nodes[0].completionEffects = [];
    plan.nodes[0].contentSpec = { mode: 'generated', generationContract: contract };
    delete plan.cues[0].resolvedBinding;
    plan.nodes.push({ id: targetId, type: 'segment', title: '承接生成前文', outlineOrder: 6, mode: 'generated', sourceSceneRefs: [], next: plan.nodes[3].id,
      contentSpec: { mode: 'generated', generationContract: { ...contract, id: randomUUID() } } });
  } });
  try {
    let view = x.started.view;
    const scope = { ...x.principal, runId: view.run.id }, current = x.runtime.instance(x.principal, view.run.id, view.instance!.id);
    const sceneId = randomUUID(), text = '守门人把一封密信交给旅人，这一事实只存在于当前生成正文。';
    const scriptResult = SegmentScriptV1.parse({ schemaVersion: 1, instanceId: current.id, inputHash: current.inputHash, outcomeId: 'continue', timelineFps: 24,
      scenes: [{ id: sceneId, title: '城门', location: '城门外', time: '夜晚', blocks: [{ id: randomUUID(), type: 'action', text }] }],
      sourceRefs: [], usedVariables: ['path'], assertedFacts: [], contentChecks: [],
      shotPlan: [{ id: randomUUID(), sceneId, goal: '交信', action: text, sound: '雨声', durationFrames: 240, resourceRefs: [] }] });
    // A deterministic completed media fixture models the already author-bound dynamic Cue.
    // Media production and frame binding are independently covered by the compiler tests.
    const planId = randomUUID(), base = { id: planId, fps: 24, durationFrames: 240,
      bindings: [{ id: randomUUID(), artifactRef: { kind: 'artifact' as const, id: x.ids.artifact, seq: 1 }, contentHash: 'a'.repeat(64), kind: 'video' as const,
        atFrame: 0, durationFrames: 240, sourceInFrame: 0, sourceFps: 24, nativeAudio: false }],
      cues: x.release.snapshot.cues.map(cue => ({ ...cue, resolvedBinding: { planId, contentHash: 'b'.repeat(64), fps: 24, appearFrame: 48 } })) };
    view = x.runtime.acceptPrepared(scope, { ...current, status: 'ready', outcomeId: 'continue', resultRevision: 1, scriptResult,
      playbackPlan: PlayableSegment.parse({ ...base, planHash: contentHash(base) }) });
    view = x.runtime.positionSave(x.principal, { protocolVersion: 1, requestId: randomUUID(), runId: view.run.id, visitId: view.run.currentVisitId,
      planHash: view.playback!.planHash, frame: 48, expectedPositionSeq: 0 }).view;
    view = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'left' } }, view.attempt!.visitId).view;
    assert.equal(preparedNext, 0);
    assert.equal(x.store.experience.list<any>('instances', scope).some(row => row.data.nodeId === targetId), false);
    assert.equal(x.runtime.trace(x.principal, view.run.id).visits.some(visit => visit.nodeId === targetId), false);
    view = x.complete(view).view;
    assert.equal(preparedNext, 1); assert.equal(consumedText, text); assert.equal(view.run.currentNodeId, targetId);
    assert.equal(x.runtime.instance(x.principal, view.run.id, current.id).status, 'consumed');
  } finally { x.close(); }
});

test('11 轨迹分页固定已开放边界，跨run游标拒绝且新增进度不混入旧分页', () => {
  const x = setup();
  try {
    let view = x.complete(x.started.view).view;
    const scope = { ...x.principal, runId: view.run.id }, futureId = randomUUID();
    x.store.experience.create('visits', scope, { id: futureId, runId: view.run.id, nodeId: x.ids.earlyEnding, status: 'planned', ordinal: 99, completedPhases: [] }, futureId);
    const first = x.runtime.tracePage(x.principal, view.run.id, { limit: 1 });
    assert.deepEqual(first.visits.map(visit => visit.nodeId), [x.ids.segment]);
    assert.equal(first.contentPage.total, 2); assert.equal(first.contentPage.partial, true); assert.ok(first.contentPage.nextCursor);
    const other = x.runtime.start(x.principal, { ...x.startInput, requestId: randomUUID() }).view;
    assert.throws(() => x.runtime.tracePage(x.principal, other.run.id, { cursor: first.contentPage.nextCursor }), /不属于当前/);
    assert.throws(() => x.runtime.tracePage({ ...x.principal, uid: 'reader-b' }, view.run.id, { cursor: first.contentPage.nextCursor }), /当前范围/);
    assert.throws(() => x.runtime.tracePage(x.principal, view.run.id, { limit: 0 }), /输入不符合/);
    assert.throws(() => x.runtime.tracePage(x.principal, view.run.id, { limit: 101 }), /输入不符合/);
    assert.throws(() => x.runtime.tracePage(x.principal, view.run.id, { cursor: 'invalid' }), /游标无效/);
    view = x.command(view, 'activity.submit', { attemptId: view.attempt!.id, input: { optionId: 'left' } }).view;
    assert.equal(view.run.status, 'completed');
    const second = x.runtime.tracePage(x.principal, view.run.id, { limit: 1, cursor: first.contentPage.nextCursor });
    assert.deepEqual(second.visits.map(visit => visit.nodeId), [x.ids.activity]);
    assert.equal(second.contentPage.total, 2); assert.equal(second.contentPage.offset, 1); assert.equal(second.contentPage.nextCursor, null);
    const fresh = x.runtime.tracePage(x.principal, view.run.id);
    assert.equal(fresh.contentPage.total, 5); assert.equal(fresh.contentPage.partial, false);
    assert.deepEqual(fresh.visits, x.runtime.trace(x.principal, view.run.id).visits);
    assert.equal(fresh.visits.some(visit => visit.id === futureId), false); assert.equal(Object.hasOwn(fresh, 'events'), false);
  } finally { x.close(); }
});
