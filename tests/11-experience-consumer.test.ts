import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { ChoiceActivity, TextIntentActivity } from '../packages/contracts/activities.ts';
import { activityResultLabel } from '../packages/contracts/activity-result-label.ts';
import { ScriptPlanData } from '../packages/contracts/interactive-script.ts';
import { ScriptRelease } from '../packages/contracts/experience.ts';
import { ExperiencedHistory } from '../packages/contracts/experience-export.ts';
import { ExperienceCatalog } from '../packages/contracts/experience-catalog.ts';
import { experienceCatalog } from '../packages/core/experience/catalog.ts';
import { contentHash } from '../packages/core/story/script.ts';

function choicePlan() {
  const activity = ChoiceActivity.parse({ id: randomUUID(), type: 'choice', version: 1, label: '怎样回应？',
    presentation: { rendererKey: 'choice', prompt: '选择当前行动' }, skipPolicy: { mode: 'allowed', result: {} },
    config: { options: [{ id: 'wait', label: '留在城门外等候' }, { id: 'leave', label: '转身离开' }] } });
  const node = randomUUID(), ending = randomUUID();
  const plan = ScriptPlanData.parse({ schemaVersion: 1, title: '发布时的故事', chapterRefs: [], entryNodeId: node,
    nodes: [{ id: node, type: 'activity', activityId: activity.id, title: '当前选择', outlineOrder: 0, next: ending },
      { id: ending, type: 'ending', title: '尚未到达的结局', outlineOrder: 1, endingKey: 'end', summary: 'future-secret-content' }],
    activities: [activity], variables: [{ key: 'secret', label: '作者变量', type: 'text', scope: 'run', initial: 'private-variable-value', maxLength: 100 }] });
  return { plan, activity };
}

test('11 consumer result labels only expose frozen supported labels after completion or explicit skip', () => {
  const { activity } = choicePlan();
  assert.equal(activityResultLabel(activity, { status: 'completed', result: { optionId: 'wait' } }), '留在城门外等候');
  assert.equal(activityResultLabel(activity, { status: 'completed', result: { optionId: 'forged-private-result' } }), undefined);
  assert.equal(activityResultLabel(activity, { status: 'open', result: { optionId: 'wait' } }), undefined);
  assert.equal(activityResultLabel({ ...activity, version: 2 }, { status: 'completed', result: { optionId: 'wait' } }), undefined);
  assert.equal(activityResultLabel(activity, { status: 'skipped', result: { optionId: 'wait' } }), '已跳过');
  const intent = TextIntentActivity.parse({ ...activity, type: 'text-intent', config: { maxLength: 100,
    intents: [{ id: 'explain', label: '说明来意', description: '解释来此的目的' }], interpretationTemplate: { id: 'test', version: 1 } } });
  assert.equal(activityResultLabel(intent, { status: 'completed', result: { intentId: 'explain', note: 'private raw text' } }), '说明来意');
  assert.equal(activityResultLabel(intent, { status: 'needsConfirmation', result: { intentId: 'explain' } }), undefined);
  assert.equal(activityResultLabel(intent, { status: 'completed', result: { intentId: 'unknown' } }), undefined);
});

test('11 consumer catalog projects only published playback metadata, pages all releases and does no runtime work', () => {
  const x = fixture({ providers: [], recover: false });
  try {
    const { plan } = choicePlan(), script = x.run('script.create', plan);
    const original = x.run('script.publish', { id: script.id, expectedSeq: script.seq, kind: 'playback' }).release as ScriptRelease;
    x.run('script.publish', { id: script.id, expectedSeq: script.seq, kind: 'simulation' });
    const add = (change: Partial<ScriptRelease>) => {
      const release = ScriptRelease.parse({ ...original, id: randomUUID(), manifestHash: contentHash(randomUUID()), ...change });
      x.app.store.experience.create('releases', { projectId: release.projectId }, release, release.id); return release;
    };
    add({ publishedAt: undefined });
    const otherId = randomUUID();
    x.app.bus.execute({ requestId: randomUUID(), projectId: otherId, operation: 'project.create', payload: { title: '另一项目' } }, { source: 'human' });
    const other = add({ projectId: otherId, publishedAt: '2030-01-01T00:00:00.000Z' });
    const generatedNode = randomUUID();
    const dynamicPlan = ScriptPlanData.parse({ ...plan, entryNodeId: generatedNode, policy: { ...plan.policy, maxTextCallsPerRun: 4, maxMediaJobsPerRun: 2 },
      nodes: [{ id: generatedNode, type: 'segment', title: 'private-future-chapter', outlineOrder: 0, mode: 'generated', sourceSceneRefs: [], next: plan.entryNodeId,
        contentSpec: { mode: 'generated', generationContract: { id: randomUUID(), version: 1, scope: 'chapter', reads: [], narrativeGoal: 'future-secret-goal', allowedChanges: [], outcomeCases: [], fallbackOutcome: 'continue', outcomes: [{ id: 'continue', narrativeRequirement: 'private-outcome' }], limits: { maxCharacters: 800, maxScenes: 3, maxShots: 3, targetSeconds: 15, maxTextCalls: 4, maxMediaJobs: 2, maxRepairAttempts: 0 }, checks: { structure: true, independentContent: true, mediaReady: true } } } }, ...plan.nodes] });
    const dynamic = add({ snapshot: dynamicPlan, policy: dynamicPlan.policy, publishedAt: '2030-01-02T00:00:00.000Z' });
    x.run('script.edit', { id: script.id, expectedSeq: script.seq, ops: [{ op: 'title.set', title: '尚未发布的作者改稿' }] });
    const before = x.app.store.experience.runScopes(x.pid), first = experienceCatalog(x.app.store.experience, x.pid, { limit: 1 });
    assert.deepEqual(first.releases.map(item => item.releaseId), [dynamic.id]); assert.equal(first.nextCursor, dynamic.id);
    assert.equal(first.releases[0].hasDynamicContent, true); assert.equal(first.releases[0].mayWaitForPreparation, true); assert.equal(first.releases[0].requiresAuthorReview, true);
    assert.deepEqual(first.releases[0].limits, { maxTextCallsPerRun: 4, maxMediaJobsPerRun: 2 });
    assert.match(first.releases[0].budgetHint, /授权.*剩余额度/);
    const second = experienceCatalog(x.app.store.experience, x.pid, { cursor: first.nextCursor, limit: 1 });
    assert.deepEqual(second.releases.map(item => item.releaseId), [original.id]); assert.equal(second.nextCursor, undefined);
    assert.equal(second.releases[0].scriptTitle, '发布时的故事'); assert.equal(second.releases[0].mayWaitForPreparation, false);
    assert.equal(second.releases[0].scriptId, original.scriptRef.id); assert.equal(second.releases[0].scriptVersion, original.scriptRef.seq);
    assert.throws(() => experienceCatalog(x.app.store.experience, x.pid, { cursor: other.id }), /游标/);
    assert.throws(() => experienceCatalog(x.app.store.experience, x.pid, { limit: 101 }));
    const serialized = JSON.stringify(experienceCatalog(x.app.store.experience, x.pid));
    for (const hidden of ['snapshot', 'nodes', 'sourceRefs', 'variables', 'future-secret', 'private-', '尚未发布', 'interpretationTemplate', other.id]) assert.ok(!serialized.includes(hidden), hidden);
    assert.deepEqual(Object.keys(ExperienceCatalog.parse(first).releases[0]).sort(), ['releaseId', 'scriptId', 'scriptVersion', 'scriptTitle', 'publishedAt', 'hasDynamicContent', 'mayWaitForPreparation', 'requiresAuthorReview', 'limits', 'budgetHint'].sort());
    assert.throws(() => x.app.experienceRuntime.start({ projectId: x.pid, uid: 'reader' }, { protocolVersion: 1, requestId: randomUUID(), projectId: x.pid, releaseId: dynamic.id, mode: 'playback' }), /生成授权/);
    assert.deepEqual(x.app.store.experience.runScopes(x.pid), before); assert.equal(x.app.production.jobs.list(x.pid).length, 0);
  } finally { x.close(); }
});

test('11 consumer catalog keeps stable script identities across renamed versions and same-title stories', () => {
  const x = fixture({ providers: [], recover: false });
  try {
    const { plan } = choicePlan(), first = x.run('script.create', plan);
    const release1 = x.run('script.publish', { id: first.id, expectedSeq: first.seq, kind: 'playback' }).release as ScriptRelease;
    const edited = x.run('script.edit', { id: first.id, expectedSeq: first.seq, ops: [{ op: 'title.set', title: '新版故事' }] });
    const release2 = x.run('script.publish', { id: first.id, expectedSeq: edited.seq, kind: 'playback' }).release as ScriptRelease;
    const second = x.run('script.create', { ...plan, title: '新版故事' });
    const other = x.run('script.publish', { id: second.id, expectedSeq: second.seq, kind: 'playback' }).release as ScriptRelease;
    const all = experienceCatalog(x.app.store.experience, x.pid);
    const byId = new Map(all.releases.map(release => [release.releaseId, release]));
    assert.equal(byId.get(release1.id)!.scriptId, first.id);
    assert.equal(byId.get(release2.id)!.scriptId, first.id);
    assert.equal(byId.get(release1.id)!.scriptVersion, first.seq);
    assert.equal(byId.get(release2.id)!.scriptVersion, edited.seq);
    assert.equal(byId.get(other.id)!.scriptId, second.id);
    assert.equal(byId.get(other.id)!.scriptTitle, byId.get(release2.id)!.scriptTitle);
    const paged: typeof all.releases = []; let cursor: string | undefined;
    do { const page = experienceCatalog(x.app.store.experience, x.pid, { cursor, limit: 1 }); paged.push(...page.releases); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(paged, all.releases);
    assert.equal(new Set(paged.map(release => release.releaseId)).size, 3);
  } finally { x.close(); }
});

test('11 experienced history and replay use original release labels while a later draft changes choices', () => {
  const x = fixture({ providers: [], recover: false });
  try {
    const { plan, activity } = choicePlan(), script = x.run('script.create', plan);
    const release = x.run('script.publish', { id: script.id, expectedSeq: script.seq, kind: 'playback' }).release as ScriptRelease;
    const principal = { projectId: x.pid, uid: 'private-reader' }, start = { protocolVersion: 1 as const, requestId: randomUUID(), projectId: x.pid, releaseId: release.id, mode: 'playback' as const };
    const first = x.app.experienceRuntime.start(principal, start).view;
    assert.deepEqual(x.app.experienceArchives.history(principal, first.run.id).decisions, []);
    const edited = x.run('script.edit', { id: script.id, expectedSeq: script.seq, ops: [{ op: 'activity.upsert', activity: { ...activity, config: { options: [{ id: 'wait', label: '改稿后的选择' }, activity.config.options[1]] } } }] });
    const newer = x.run('script.publish', { id: script.id, expectedSeq: edited.seq, kind: 'playback' }).release as ScriptRelease;
    const completed = x.app.experienceRuntime.execute(principal, { protocolVersion: 1, requestId: randomUUID(), runId: first.run.id, expectedStateSeq: first.run.stateSeq, visitId: first.attempt!.visitId, operation: 'activity.submit', payload: { attemptId: first.attempt!.id, input: { optionId: 'wait' } } }).view;
    const before = structuredClone(completed.run), history = x.app.experienceArchives.history(principal, first.run.id);
    assert.equal(history.decisions[0].resultLabel, '留在城门外等候'); assert.deepEqual(history.decisions[0].result, { optionId: 'wait' });
    assert.deepEqual(x.app.experienceRuntime.view(principal, first.run.id).run, before);
    const legacy = structuredClone(history); delete legacy.decisions[0].resultLabel; assert.equal(ExperiencedHistory.parse(legacy).decisions[0].resultLabel, undefined);
    assert.throws(() => x.app.experienceArchives.history({ ...principal, uid: 'someone-else' }, first.run.id), /不存在/);
    const replay = x.app.experienceRuntime.start(principal, { ...start, requestId: randomUUID() }).view;
    assert.notEqual(replay.run.id, first.run.id); assert.equal(replay.run.releaseId, release.id); assert.equal(replay.activity!.options![0].label, '留在城门外等候');
    const newRun = x.app.experienceRuntime.start(principal, { ...start, requestId: randomUUID(), releaseId: newer.id }).view;
    assert.equal(newRun.activity!.options![0].label, '改稿后的选择');
    x.app.experienceRuntime.execute(principal, { protocolVersion: 1, requestId: randomUUID(), runId: replay.run.id, expectedStateSeq: replay.run.stateSeq, visitId: replay.attempt!.visitId, operation: 'activity.skip', payload: { attemptId: replay.attempt!.id } });
    assert.equal(x.app.experienceArchives.history(principal, replay.run.id).decisions[0].resultLabel, '已跳过');
    assert.equal(x.app.production.jobs.list(x.pid).length, 0);
  } finally { x.close(); }
});
