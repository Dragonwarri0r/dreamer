import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.ts';
import {ScriptPlanData, type ScriptPolicy} from '../packages/contracts/interactive-script.ts';
import type {Capability, MediaProvider} from '../packages/contracts/production.ts';
import {cloudConstraints, cloudDimensions, cloudVideoDefinitions, type CloudVideoId} from '../packages/contracts/cloud-video.ts';
import h3Profiles from '../packages/contracts/h3-profiles.json' with {type: 'json'};
import {scriptExecutionProfileIssue} from '../packages/contracts/script-production-policy.ts';
import {freezeScriptProfile} from '../apps/studio/src/script-production-policy.ts';
import type {RuntimeTextGenerator} from '../packages/core/experience/generation.ts';

const fingerprint = 'a'.repeat(64);
type FrozenProfile = ScriptPolicy['executionProfiles'][number];
function capability(provider: 'h3' | CloudVideoId): Capability {
  const profiles = provider === 'h3' ? Object.keys(h3Profiles) : [...cloudVideoDefinitions[provider].profiles];
  return {id: provider, title: '隔离测试能力', available: true, detail: '不调用模型', profiles, fingerprint,
    cost: provider === 'h3' ? 'local' : 'account-quota', supports: {references: true, lastFrame: true, audio: true, final: true},
    profileConstraints: Object.fromEntries(profiles.map(profile => {
      if (provider !== 'h3') return [profile, cloudConstraints(provider, profile)];
      const spec = h3Profiles[profile as keyof typeof h3Profiles];
      return [profile, {...spec, durationSeconds: spec.frames / spec.fps, audio: true, minReferences: 0, maxReferences: 2,
        firstLastFramesForTwo: true, referenceMediaTypes: ['image/png'], maxPromptCharacters: 4000, promptEncoding: 'unicode' as const}];
    })),
  };
}
function dynamicPlan(profile: FrozenProfile) {
  const entry = randomUUID(), ending = randomUUID();
  return ScriptPlanData.parse({schemaVersion: 1, title: '发布规格检查', chapterRefs: [], entryNodeId: entry,
    nodes: [{id: entry, type: 'segment', title: '等候', outlineOrder: 0, mode: 'generated', sourceSceneRefs: [], next: ending,
      contentSpec: {mode: 'generated', generationContract: {id: randomUUID(), version: 1, scope: 'segment', reads: [],
        narrativeGoal: '留在城门外等候', allowedChanges: [{field: 'action', constraint: '描述等候姿态'}],
        outcomeCases: [], fallbackOutcome: 'wait', outcomes: [{id: 'wait', narrativeRequirement: '依旧在城门外等候'}],
        limits: {maxCharacters: 100, maxScenes: 1, maxShots: 1, targetSeconds: 1, maxTextCalls: 1, maxMediaJobs: 1, maxRepairAttempts: 0},
        checks: {structure: true, independentContent: false, mediaReady: true}}}},
    {id: ending, type: 'ending', title: '结束', outlineOrder: 1, endingKey: 'wait', summary: '继续等候'}],
    policy: {maxTextCallsPerRun: 1, maxMediaJobsPerRun: 1, reviewMode: 'authorReview', executionProfiles: [profile]}});
}
function harness(cap: Capability) {
  let calls = 0;
  const unexpected = async (): Promise<never> => {calls++; throw new Error('测试禁止生成调用');};
  const provider: MediaProvider = {describe: () => cap, submit: unexpected, status: unexpected, cancel: unexpected};
  const generator: RuntimeTextGenerator = {configuration: () => ({fingerprint, description: {model: 'isolated-fake'}}), execute: unexpected};
  const x = fixture({providers: [provider], runtimeGenerator: generator, recover: false});
  return {...x, calls: () => calls, publish(profile: FrozenProfile) {
    const script = x.run('script.create', dynamicPlan(profile));
    return x.run('script.publish', {id: script.id, expectedSeq: script.seq, kind: 'playback', confirmGeneration: true}).release;
  }};
}

test('11 publication rejects the reproduced fal 1-second limit before a release, checkpoint or generation', () => {
  const cap = capability('fal-h3'), x = harness(cap);
  try {
    const profile = freezeScriptProfile(cap, '768p');
    profile.constraints.durationSeconds = 1;
    const script = x.run('script.create', dynamicPlan(profile));
    assert.throws(() => x.run('script.publish', {id: script.id, expectedSeq: script.seq, kind: 'playback', confirmGeneration: true}), /5–15 的整数秒/);
    assert.equal(x.app.scripts.repo.get(script.id, x.pid).seq, script.seq);
    assert.deepEqual(x.app.scripts.repo.history(script.id, x.pid), []);
    assert.deepEqual(x.app.scripts.releases(x.pid, script.id), []);
    assert.deepEqual(x.app.store.experience.runScopes(x.pid), []);
    assert.deepEqual(x.app.store.experience.list('reservations', {projectId: x.pid}), []);
    assert.equal(x.app.production.jobs.list(x.pid).length, 0);
    assert.equal(x.calls(), 0);
  } finally {x.close();}
});

test('11 publication rejects invalid cloud dimensions, duration, fps and audio instead of spending text first', () => {
  const cap = capability('fal-h3'), x = harness(cap);
  try {
    const patches: Record<string, string | number | boolean>[] = [
      {durationSeconds: 16}, {durationSeconds: 5.5}, {width: 768, height: 768}, {fps: 30}, {audio: false}, {unknownConstraint: true},
    ];
    for (const patch of patches) {
      const profile = freezeScriptProfile(cap, '768p');
      Object.assign(profile.constraints, patch);
      assert.throws(() => x.publish(profile), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'VALIDATION', JSON.stringify(patch));
    }
    assert.deepEqual(x.app.store.experience.list('releases', {projectId: x.pid}), []);
    assert.equal(x.calls(), 0);
  } finally {x.close();}
});

test('11 legal cloud presets and duration endpoints publish with unchanged frozen constraints and zero calls', () => {
  for (const provider of ['seedance', 'wan', 'fal-h3'] as const) {
    const cap = capability(provider), x = harness(cap);
    try {
      for (const profileId of cap.profiles) for (const ratio of ['9:16', '16:9', '1:1']) for (const seconds of cap.profileConstraints![profileId]!.durationRange!) {
        const profile = freezeScriptProfile(cap, profileId);
        Object.assign(profile.constraints, cloudDimensions(profileId, ratio), {durationSeconds: seconds});
        assert.equal(scriptExecutionProfileIssue(profile, cap), undefined);
        const release = x.publish(profile);
        assert.deepEqual(release.policy.executionProfiles[0], profile);
        assert.ok(release.generationAuthorization);
      }
      assert.equal(x.calls(), 0);
    } finally {x.close();}
  }
});

test('11 local frozen profiles retain fractional frame duration while wrong dimensions, fps, audio or duration cannot publish', () => {
  const cap = capability('h3'), x = harness(cap);
  try {
    for (const profileId of cap.profiles) {
      const profile = freezeScriptProfile(cap, profileId), release = x.publish(profile);
      assert.equal(release.policy.executionProfiles[0].constraints.durationSeconds, 124 / 24);
      assert.deepEqual(release.policy.executionProfiles[0], profile);
    }
    for (const patch of [{width: 480}, {height: 832}, {fps: 30}, {durationSeconds: 5}, {audio: false}]) {
      const profile = freezeScriptProfile(cap, 'h3-preview/v1');
      Object.assign(profile.constraints, patch);
      assert.throws(() => x.publish(profile), /此规格/);
    }
    assert.equal(x.calls(), 0);
  } finally {x.close();}
});

test('11 shared frozen-profile check refuses missing constraints, capability drift and unsupported execution modes', () => {
  const cap = capability('h3'), profile = freezeScriptProfile(cap, 'h3-preview/v1');
  const missing = structuredClone(profile); delete missing.constraints.audio;
  assert.equal(scriptExecutionProfileIssue(missing, cap)?.fieldPath, 'constraints');
  assert.equal(scriptExecutionProfileIssue(profile, {...cap, profileConstraints: undefined})?.fieldPath, 'profile');
  assert.equal(scriptExecutionProfileIssue(profile, {...cap, fingerprint: 'b'.repeat(64)})?.fieldPath, 'configFingerprint');
  assert.equal(scriptExecutionProfileIssue({...profile, quality: 'final'}, cap)?.fieldPath, 'quality');
  const frames = {...profile, constraints: {...profile.constraints, firstLastFrames: true}};
  assert.equal(scriptExecutionProfileIssue(frames, cap), undefined);
  assert.equal(scriptExecutionProfileIssue(frames, {...cap, supports: {...cap.supports, lastFrame: false}})?.fieldPath, 'constraints.firstLastFrames');
  assert.equal(scriptExecutionProfileIssue(frames, {...cap, profileConstraints: {...cap.profileConstraints,
    [profile.profile]: {...cap.profileConstraints![profile.profile]!, firstLastFramesForTwo: false}}})?.fieldPath, 'constraints.firstLastFrames');
});
