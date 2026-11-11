import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../packages/infra/sqlite.ts';
import { ProjectData } from '../packages/contracts/foundation.ts';
import { RenderIntent, type MediaProvider } from '../packages/contracts/production.ts';
import { ScriptPlanData } from '../packages/contracts/interactive-script.ts';
import { ExperienceRun, RuntimeVisit, ScriptRelease, SegmentInstance } from '../packages/contracts/experience.ts';
import { CommandBus } from '../packages/core/foundation/commands.ts';
import { Production } from '../packages/core/modules/production.ts';
import { RuntimeMedia } from '../packages/core/experience/media.ts';
import { contentHash } from '../packages/core/story/script.ts';

const fingerprint = 'e'.repeat(64);
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dreamer-media-edge-')), store = new SqliteStore(root), projectId = randomUUID(), runId = randomUUID();
  const scope = { projectId, uid: 'reader', runId }, entry = randomUUID(), ending = randomUUID(), visitId = randomUUID(), instanceId = randomUUID(), sceneId = randomUUID();
  store.repository('project', ProjectData).create(projectId, ProjectData.parse({ title: '运行媒体边界', generationLimit: 20 }), projectId);
  const snapshot = ScriptPlanData.parse({ schemaVersion: 1, title: '媒体边界', chapterRefs: [], entryNodeId: entry,
    nodes: [{ id: entry, type: 'segment', title: '动态内容', outlineOrder: 0, mode: 'generated', sourceSceneRefs: [], next: ending,
      contentSpec: { mode: 'generated', generationContract: { id: randomUUID(), version: 1, scope: 'segment', reads: [], narrativeGoal: '继续前行', allowedChanges: [{ field: 'action', constraint: '保持结局' }], outcomeCases: [], fallbackOutcome: 'continue', outcomes: [{ id: 'continue', narrativeRequirement: '继续前行' }],
        limits: { maxCharacters: 500, maxScenes: 1, maxShots: 2, targetSeconds: 2, maxTextCalls: 1, maxMediaJobs: 2, maxRepairAttempts: 0 }, checks: { structure: true, independentContent: false, mediaReady: true } } } },
      { id: ending, type: 'ending', title: '结束', outlineOrder: 1, endingKey: 'end', summary: '完成' }],
    policy: { maxTextCallsPerRun: 1, maxMediaJobsPerRun: 4, maxShotsPerSegment: 2, reviewMode: 'validatedRuntime', executionProfiles: [{ provider: 'h3', profile: 'h3-preview/v1', quality: 'draft', model: 'local-fixture', configFingerprint: fingerprint, templateVersion: 'v1', constraints: {width:320,height:576,fps:24,durationSeconds:124/24,audio:true,firstLastFrames:false} }] } });
  const now = new Date().toISOString(), release = ScriptRelease.parse({ id: randomUUID(), projectId, scriptRef: { kind: 'script', id: randomUUID(), seq: 1 }, schemaVersion: 1, kind: 'playback', manifestHash: contentHash(snapshot), snapshot, dependencyRefs: [], activityVersions: [], policy: snapshot.policy, generationAuthorization: { policyHash: contentHash(snapshot.policy), confirmedAt: now, source: 'human' }, createdAt: now });
  store.experience.create('releases', { projectId }, release, release.id);
  const run = ExperienceRun.parse({ id: runId, projectId, uid: scope.uid, releaseId: release.id, manifestHash: release.manifestHash, mode: 'playback', stateSeq: 1, currentNodeId: entry, currentVisitId: visitId, status: 'waitingContent', variables: {}, historyCursor: 0, createdAt: now, updatedAt: now });
  store.experience.create('runs', { projectId, uid: scope.uid }, run, run.id);
  store.experience.create('visits', scope, RuntimeVisit.parse({ id: visitId, runId, nodeId: entry, status: 'active', ordinal: 0 }), visitId);
  const instance = SegmentInstance.parse({ id: instanceId, runId, nodeId: entry, visitId, releaseId: release.id, inputHash: 'a'.repeat(64), status: 'producing', sourceRefs: [], variableSnapshot: {}, resultRevision: 1,
    scriptResult: { schemaVersion: 1, instanceId, inputHash: 'a'.repeat(64), outcomeId: 'continue', timelineFps: 24,
      scenes: [{ id: sceneId, title: '街道', location: '街道', time: '白天', blocks: [{ id: randomUUID(), type: 'action', text: '继续前行' }] }],
      sourceRefs: [], usedVariables: [], assertedFacts: [], contentChecks: [], shotPlan: [0, 1].map(() => ({ id: randomUUID(), sceneId, goal: '继续前行', action: '前行', sound: '', durationFrames: 24, resourceRefs: [] })) } });
  store.experience.create('instances', scope, instance, instance.id);
  let submits = 0, statuses = 0, cancels = 0;
  const provider: MediaProvider = { describe: () => ({ id: 'h3', title: '本地替身', available: true, detail: '没有真实模型调用', profiles: ['h3-preview/v1'], fingerprint, cost: 'local', supports: { references: true, lastFrame: true, audio: true, final: false } }),
    async submit() { submits++; return { state: 'unknown' }; }, async status() { statuses++; return { state: 'unknown' }; }, async cancel() { cancels++; } };
  const production = new Production(store, new CommandBus(store), { path() { throw new Error('no files'); }, async import() { throw new Error('no import'); } }, [provider], () => { throw new Error('no refs'); }, store.experience, false);
  production.experienceScope = () => scope;
  const media = new RuntimeMedia(store.experience, production, () => 20, { accept() {}, fixed() { throw new Error('not fixed'); } });
  const intent = RenderIntent.parse({ provider: 'h3', profile: 'h3-preview/v1', prompt: '向前行走', constraints: { width: 320, height: 576, durationSeconds: 124 / 24, fps: 24, audio: true } });
  const enqueue = () => store.transaction(() => {
    const component = randomUUID(), reservation = store.experience.reserve(scope, { requestId: randomUUID(), ownerKey: `instance:${instanceId}:shot:${component}`, stage: 'media', attemptNo: 1, unit: 'media', countsProject: true, state: 'reserved', source: 'runtime', provider: 'h3' }, { projectMedia: 20, runMedia: 4 });
    return production.enqueue(projectId, intent, undefined, { owner: { type: 'experience', runId, instanceId, component }, scope, reservationId: reservation.id });
  });
  const changeRun = (patch: Partial<ExperienceRun>) => { const row = store.experience.get<ExperienceRun>('runs', run.id, scope); store.experience.save('runs', row.id, scope, row.seq, { ...row.data, ...patch }); };
  return { root, store, scope, run, release, instance, production, media, intent, enqueue, changeRun, counts: () => ({ submits, statuses, cancels }), close() { production.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('11 体验放弃后排队媒体不派发，明确未派发额度释放', async () => {
  const x = setup();
  try {
    const job = x.enqueue(); x.changeRun({ status: 'abandoned' });
    await x.production.dispatch(job.id, x.scope.projectId);
    assert.equal(x.counts().submits, 0);
    assert.equal(x.production.jobs.get(job.id, x.scope.projectId).data.state, 'cancelled');
    assert.equal(x.store.experience.usage(x.scope).runMedia, 0);
    assert.equal(x.store.experience.list('reservations', x.scope)[0].data.state, 'released');
  } finally { x.close(); }
});

test('11 备份恢复与归属缺失均停止派发，不从unknown重建任务或退已派发额度', async () => {
  for (const blocked of ['restore', 'owner', 'dispatched'] as const) {
    const x = setup();
    try {
      const job = x.enqueue();
      if (blocked === 'restore') x.changeRun({ restoreBlocked: true, status: 'blocked' });
      if (blocked === 'owner') x.production.experienceScope = () => undefined;
      await x.production.dispatch(job.id, x.scope.projectId);
      assert.equal(x.counts().submits, blocked === 'dispatched' ? 1 : 0);
      assert.equal(x.production.jobs.get(job.id, x.scope.projectId).data.state, 'unknown');
      await x.production.dispatch(job.id, x.scope.projectId);
      assert.equal(x.counts().submits, blocked === 'dispatched' ? 1 : 0);
      assert.equal(x.store.experience.usage(x.scope).projectMedia, 1);
      if (blocked === 'dispatched') {
        x.store.transaction(() => x.production.cancelExperience(job.id, x.scope.projectId));
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(x.store.experience.usage(x.scope).runMedia, 1);
      }
    } finally { x.close(); }
  }
});

test('11 第二个媒体入队写失败会回滚整批预约和Job，已安排微任务不会补发', async () => {
  const x = setup();
  try {
    const enqueue = x.production.enqueue.bind(x.production); let calls = 0;
    x.production.enqueue = (...args) => { if (++calls === 2) throw new Error('injected-second-write'); return enqueue(...args); };
    assert.throws(() => x.store.transaction(() => x.media.prepare(x.scope, x.instance)), /injected-second-write/);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(x.production.jobs.list(x.scope.projectId).length, 0);
    assert.equal(x.store.experience.list('reservations', x.scope).length, 0);
    assert.equal(x.counts().submits, 0);
  } finally { x.close(); }
});

test('11 媒体预约不能借给别的run或Provider，未授权资源引用明确阻断而不忽略', () => {
  const x = setup();
  try {
    x.store.transaction(() => {
      const reservation = x.store.experience.reserve(x.scope, { requestId: randomUUID(), ownerKey: 'wrong-owner', stage: 'media', attemptNo: 1, unit: 'media', countsProject: true, state: 'reserved', source: 'runtime', provider: 'wan' }, { projectMedia: 20, runMedia: 4 });
      assert.throws(() => x.production.enqueue(x.scope.projectId, x.intent, undefined, { owner: { type: 'experience', runId: x.run.id, instanceId: x.instance.id, component: 'wrong-owner' }, scope: x.scope, reservationId: reservation.id }), /预约身份/);
      assert.throws(() => x.production.enqueue(x.scope.projectId, x.intent, undefined, { owner: { type: 'experience', runId: randomUUID(), instanceId: x.instance.id, component: 'wrong-owner' }, scope: x.scope, reservationId: reservation.id }), /范围/);
    });
    const referenced = structuredClone(x.instance); referenced.scriptResult!.shotPlan[0].resourceRefs = [{ kind: 'resource', id: randomUUID(), seq: 1 }];
    const blocked = x.store.transaction(() => x.media.prepare(x.scope, referenced));
    assert.equal(blocked.status, 'blocked'); assert.match(blocked.recoveryReason!, /固定发布依赖/);
    assert.equal(x.production.jobs.list(x.scope.projectId).length, 0); assert.equal(x.counts().submits, 0);
  } finally { x.close(); }
});

test('11 媒体取消在派发前释放预算，派发后保持unknown供原任务核对', async () => {
  for (const dispatchFirst of [false, true]) {
    const x = setup();
    try {
      const job = x.enqueue();
      if (dispatchFirst) await x.production.dispatch(job.id, x.scope.projectId);
      let callbacks = 0; x.production.onExperienceState = () => { callbacks++; };
      const before = callbacks;
      const cancelled = x.store.transaction(() => x.media.command(x.scope, x.instance, 'instance.cancel'));
      // The Runtime command owns the instance update; synchronous callbacks must not race its CAS.
      assert.equal(callbacks, before);
      assert.equal(cancelled.cancelRequested, true);
      assert.equal(cancelled.status, dispatchFirst ? 'unknown' : 'cancelled');
      assert.equal(x.store.experience.usage(x.scope).runMedia, dispatchFirst ? 1 : 0);
      await new Promise(resolve => setTimeout(resolve, 5));
    } finally { x.close(); }
  }
});
