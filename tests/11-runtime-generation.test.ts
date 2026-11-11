import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SqliteStore } from '../packages/infra/sqlite.ts';
import { ProjectData, DomainError, stable } from '../packages/contracts/foundation.ts';
import { ScriptPlanData, GenerationContract } from '../packages/contracts/interactive-script.ts';
import { SegmentInstance, SegmentScriptV1, ExperienceRun, RuntimeVisit, ScriptRelease } from '../packages/contracts/experience.ts';
import { ActivityAttempt, ActivityDefinition } from '../packages/contracts/activities.ts';
import { RuntimeGeneration, type RuntimeTextGenerator, type RuntimeTextRequest, type PreparationContext, type RuntimeDispatch } from '../packages/core/experience/generation.ts';
import { RestrictedRuntimeGenerator } from '../packages/infra/agent/runtime-generator.ts';
import { cityGateFixture, interactiveId } from './fixtures/interactive-script.ts';
import { initialVariables } from '../packages/core/story/rules.ts';

const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function setup(generator?: RuntimeTextGenerator, options: { review?: 'authorReview' | 'validatedRuntime'; repairs?: number; calls?: number; independent?: boolean; mode?: 'simulation' | 'playback'; scope?: 'segment' | 'chapter' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dreamer-runtime-text-')), store = new SqliteStore(root), projectId = randomUUID();
  store.repository('project', ProjectData).create(projectId, ProjectData.parse({ title: '动态城门' }), projectId);
  const { plan, ids, refs } = cityGateFixture();
  const contract = GenerationContract.parse({ id: randomUUID(), version: 1, scope: options.scope ?? 'segment', reads: ['trust'], sourceRefs: [refs.scene], entryConditions: [], narrativeGoal: '守卫认可帮助并引导入城', fixedFacts: [{ key: 'location', text: '城门没有开启', sourceRef: refs.scene }], allowedChanges: [{ field: 'dialogue', constraint: '只改变问候方式' }], outcomeCases: [], fallbackOutcome: 'accepted', outcomes: [{ id: 'accepted', narrativeRequirement: '守卫明确认可帮助', completionEffects: [{ id: randomUUID(), op: 'increment', key: 'trust', value: { source: 'constant', value: 1 }, commitAt: 'segmentCompleted' }], postconditions: [{ op: 'gte', key: 'trust', value: 1 }] }], resourceRefs: [], limits: { maxCharacters: options.scope === 'chapter' ? 800 : 500, maxScenes: options.scope === 'chapter' ? 3 : 1, maxShots: options.scope === 'chapter' ? 3 : 1, targetSeconds: options.scope === 'chapter' ? 15 : 5, maxTextCalls: options.calls ?? 5, maxMediaJobs: 0, maxRepairAttempts: options.repairs ?? 1 }, checks: { structure: true, independentContent: options.independent ?? true, mediaReady: true } });
  const node = { ...plan.nodes[0]!, type: 'segment' as const, mode: 'generated' as const, contentSpec: { mode: 'generated' as const, generationContract: contract }, sourceSceneRefs: [refs.scene], next: ids.enter, completionEffects: [] } as Extract<ScriptPlanData['nodes'][number], { type: 'segment' }>;
  const snapshot = ScriptPlanData.parse({ ...plan, nodes: [node, plan.nodes.find(node => node.id === ids.enter)], activities: [], cues: [], variables: plan.variables.map(v => v.key === 'trust' ? { ...v, allowedWriters: [{ sourceId: node.id, commitAt: 'segmentCompleted' }] } : v), policy: { ...plan.policy, maxTextCallsPerRun: options.calls ?? 5, maxRepairAttempts: options.repairs ?? 1, reviewMode: options.review ?? 'validatedRuntime' } });
  const now = new Date().toISOString(), release = ScriptRelease.parse({ id: randomUUID(), projectId, scriptRef: { kind: 'script', id: randomUUID(), seq: 1 }, schemaVersion: 1, kind: options.mode ?? 'playback', manifestHash: 'a'.repeat(64), snapshot, dependencyRefs: [refs.scene], activityVersions: [], policy: snapshot.policy, generationAuthorization: { policyHash: hash(snapshot.policy), confirmedAt: now, source: 'human', textConfigurationFingerprint: generator?.configuration().fingerprint ?? 'b'.repeat(64) }, createdAt: now });
  store.experience.create('releases', { projectId }, release, release.id);
  const run = ExperienceRun.parse({ id: randomUUID(), projectId, uid: 'reader', releaseId: release.id, manifestHash: release.manifestHash, mode: options.mode ?? 'playback', stateSeq: 1, currentNodeId: node.id, currentVisitId: randomUUID(), status: 'waitingContent', variables: initialVariables(snapshot.variables), committedFacts: [], historyCursor: 0, createdAt: now, updatedAt: now });
  const scope = { projectId, uid: 'reader', runId: run.id }; store.experience.create('runs', scope, run, run.id);
  const visit = RuntimeVisit.parse({ id: run.currentVisitId, runId: run.id, nodeId: node.id, status: 'active', ordinal: 0, enteredAt: now }); store.experience.create('visits', scope, visit, visit.id);
  const instance = SegmentInstance.parse({ id: randomUUID(), runId: run.id, nodeId: node.id, visitId: visit.id, releaseId: release.id, inputHash: 'c'.repeat(64), status: 'planned', sourceRefs: [], variableSnapshot: {} }); store.experience.create('instances', scope, instance, instance.id);
  const coordinator = new RuntimeGeneration(store.experience, () => ({ data: { title: '城门', blocks: [] } }), generator, {
    acceptPreparedInternal(s, data) { const row = store.experience.get('instances', data.id, s); store.experience.save('instances', data.id, s, row.seq, data); },
    acceptActivityInternal(s, data) { const row = store.experience.get('activities', data.id, s); store.experience.save('activities', data.id, s, row.seq, data); },
  });
  const context: PreparationContext = { principal: { projectId, uid: 'reader' }, run, release, node, visit, instance };
  return { root, store, coordinator, context, scope, contract, ids, refs, prepare() { return store.transaction(() => { const data = coordinator.prepare(context); const row = store.experience.get('instances', instance.id, scope); store.experience.save('instances', row.id, scope, row.seq, data); return data; }); }, instance: () => store.experience.get<SegmentInstance>('instances', instance.id, scope).data, close() { coordinator.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function script(request: RuntimeTextRequest) {
  const input = request.input, scene = interactiveId(500), block = interactiveId(501);
  return { schemaVersion: 1, instanceId: input.instanceId, inputHash: input.inputHash, outcomeId: input.outcomeId, timelineFps: 24, scenes: [{ id: scene, title: '守卫的回应', location: '城门', time: '黄昏', blocks: [{ id: block, type: 'dialogue', text: '谢谢你的帮助，请随我来。', speaker: '守卫' }] }], sourceRefs: (input.context as any).sourceRefs, usedVariables: ['trust'], assertedFacts: [], shotPlan: [{ id: interactiveId(502), sceneId: scene, goal: '认可帮助', action: '守卫点头', sound: '谢谢你的帮助，请随我来。', durationFrames: 120, resourceRefs: [] }], contentChecks: [] };
}
function localDraft(request: RuntimeTextRequest) {
  const value = script(request);
  return { ...value, format: 'local-segment-draft/v1', scenes: value.scenes.map(scene => ({ ...scene, id: 'scene_1', blocks: scene.blocks.map(block => ({ ...block, id: 'dialogue_1' })) })),
    shotPlan: value.shotPlan.map(shot => ({ ...shot, id: 'shot_1', sceneId: 'scene_1', dialogueBlockIds: ['dialogue_1'] })) };
}
function fake(respond: (request: RuntimeTextRequest) => unknown = request => request.stage === 'check' ? { schemaVersion: 1, instanceId: request.input.instanceId, inputHash: request.input.inputHash, resultRevision: request.input.resultRevision, status: 'passed', checks: [{ ruleId: 'CAUSE', passed: true, evidenceBlockIds: [interactiveId(501)], message: '帮助得到守卫明确回应' }] } : script(request)) {
  const calls: RuntimeTextRequest[] = [], generator: RuntimeTextGenerator = { configuration: () => ({ fingerprint: 'b'.repeat(64), description: { model: 'fixture-no-network' } }), async execute(request) { calls.push(request); return respond(request); } };
  return { generator, calls };
}

test('11 S4 dispatch and budget precede async generation; fixed outcome, independent review and saved revisions do not commit future effects', async () => {
  const f = fake(), x = setup(f.generator);
  try {
    const prepared = x.prepare(); assert.equal(prepared.status, 'writing'); assert.equal(f.calls.length, 0);
    assert.equal(x.store.experience.usage(x.scope).runText, 1);
    await x.coordinator.tick(x.scope);
    assert.equal(x.instance().status, 'producing'); assert.equal(x.instance().resultRevision, 1);
    assert.equal(f.calls.length, 2); assert.equal(x.store.experience.usage(x.scope).runText, 2);
    assert.equal(x.store.experience.get<ExperienceRun>('runs', x.scope.runId, x.scope).data.variables.trust, 0);
    const results = x.store.experience.list<any>('results', x.scope); assert.equal(results.length, 1);
    assert.equal(results[0]!.data.script.outcomeId, 'accepted'); assert.equal(f.calls[0]!.input.context && (f.calls[0]!.input.context as any).priorInstanceRefs.length, 0);
    assert.throws(() => x.store.experience.save('results', results[0]!.id, x.scope, 1, results[0]!.data), /不可修改/);
    await x.coordinator.tick(x.scope); assert.equal(f.calls.length, 2);
  } finally { x.close(); }
});

test('11 IT-12 chapter reuses bounded generation with consumed context, rejects wrong outcome and stops after independent check for author review', async () => {
  const f = fake(request => {
    if (request.stage === 'check') return { schemaVersion: 1, instanceId: request.input.instanceId, inputHash: request.input.inputHash, resultRevision: request.input.resultRevision, status: 'passed', checks: [{ ruleId: 'CHAPTER_CONTINUITY', passed: true, evidenceBlockIds: [interactiveId(501)], message: '整章承接已发生的帮助，认可结果一致' }] };
    const first = script(request), second = interactiveId(510), block = interactiveId(511);
    return { ...first, chapterTitle: '灯下的回应', outcomeId: request.stage === 'write' ? 'invented' : first.outcomeId,
      scenes: [...first.scenes, { id: second, title: '墙下等候', location: '城门外', time: '黄昏', blocks: [{ id: block, type: 'action', text: '守卫仍守着关闭的城门，让旅人在灯下等候。' }] }],
      shotPlan: [...first.shotPlan, { id: interactiveId(512), sceneId: second, goal: '结束这一章', action: '灯火安静地照亮石墙', sound: '远处风声', durationFrames: 120, resourceRefs: [] }] };
  }), x = setup(f.generator, { scope: 'chapter', review: 'authorReview' });
  try {
    const add = (status: 'consumed' | 'ready', text: string) => {
      const visit = RuntimeVisit.parse({ id: randomUUID(), runId: x.scope.runId, nodeId: randomUUID(), status: status === 'consumed' ? 'completed' : 'planned', ordinal: status === 'consumed' ? 0 : 2 });
      x.store.experience.create('visits', x.scope, visit, visit.id);
      const instance = SegmentInstance.parse({ ...x.context.instance, id: randomUUID(), nodeId: visit.nodeId, visitId: visit.id, status, resultRevision: 1, templateResult: { text, contentHash: hash({ text }) } });
      x.store.experience.create('instances', x.scope, instance, instance.id); return instance;
    };
    const past = add('consumed', '旅人刚刚帮助守卫找回灯笼。'), future = add('ready', '尚未发生的未来场景不得进入下一章');
    x.prepare(); await x.coordinator.tick(x.scope);
    assert.deepEqual(f.calls.map(call => call.stage), ['write', 'repair', 'check']);
    for (const request of f.calls) assert.equal((request.input.contract as GenerationContract).scope, 'chapter');
    const previous = f.calls[0]!.input.previousContent as any[];
    assert.deepEqual(previous.map(item => item.ref.instanceId), [past.id]);
    assert.equal(JSON.stringify(f.calls).includes(future.templateResult!.text), false);
    assert.equal(previous[0].ref.runId, x.scope.runId);
    assert.equal(x.instance().status, 'waitingReview'); assert.equal(x.instance().scriptResult!.chapterTitle, '灯下的回应');
    assert.equal(x.instance().scriptResult!.scenes.length, 2); assert.equal(x.instance().scriptResult!.outcomeId, 'accepted');
    assert.ok(x.instance().checks.some(check => check.stage === 'content' && check.status === 'passed' && check.resultRevision === 1));
    assert.ok(!x.instance().checks.some(check => check.stage === 'authorReview'));
    assert.equal(x.store.experience.list<any>('results', x.scope).length, 1);
    assert.equal(x.store.experience.usage(x.scope).runMedia, 0);
    assert.equal(x.store.experience.get<ExperienceRun>('runs', x.scope.runId, x.scope).data.variables.trust, 0);
  } finally { x.close(); }
});

test('11 local-declared draft compiles through bounded repair, archives raw draft and gives independent checker canonical UUID content', async () => {
  const f = fake(request => {
    if (request.stage === 'check') return { schemaVersion: 1, instanceId: request.input.instanceId, inputHash: request.input.inputHash, resultRevision: request.input.resultRevision, status: 'passed', checks: [{ ruleId: 'FACTS', passed: true, evidenceBlockIds: [(request.input.script as SegmentScriptV1).scenes[0]!.blocks[0]!.id], message: 'canonical evidence' }] };
    const value = localDraft(request); if (request.stage === 'write') value.shotPlan[0]!.sceneId = 'missing_scene'; return value;
  });
  f.generator.configuration = () => ({ fingerprint: 'b'.repeat(64), description: { model: 'local-fixture', outputFormat: 'local-segment-draft/v1' } });
  const x = setup(f.generator, { review: 'authorReview' });
  try {
    x.prepare(); await x.coordinator.tick(x.scope);
    assert.deepEqual(f.calls.map(call => call.stage), ['write', 'repair', 'check']); assert.equal(x.instance().status, 'waitingReview');
    assert.match((f.calls[1]!.input.diagnosis as { message: string }).message, /镜头场景不存在/);
    const archived = x.store.experience.list<RuntimeDispatch>('dispatches', x.scope).filter(row => row.data.stage !== 'check');
    for (const row of archived) assert.equal((row.data.result as any).format, 'local-segment-draft/v1');
    assert.equal((archived[0]!.data.result as any).shotPlan[0].sceneId, 'missing_scene');
    assert.equal((archived[1]!.data.result as any).scenes[0].id, 'scene_1');
    const result = x.store.experience.list<any>('results', x.scope)[0]!.data.script;
    assert.equal(result.format, undefined); assert.ok(SegmentScriptV1.safeParse(result).success);
    assert.notEqual(result.scenes[0].id, 'scene_1'); assert.equal(result.shotPlan[0].sceneId, result.scenes[0].id);
    assert.deepEqual(result.shotPlan[0].dialogueBlockIds, [result.scenes[0].blocks[0].id]);
    assert.deepEqual(f.calls[2]!.input.script, result); assert.deepEqual(result.sourceRefs, [x.refs.scene]);
    assert.equal(x.store.experience.get<ExperienceRun>('runs', x.scope.runId, x.scope).data.variables.trust, 0);
  } finally { x.close(); }
});

test('11 local draft compilation requires the frozen format opt-in and never corrects authority fields or source refs', async () => {
  for (const scenario of ['unmarked', 'canonical', 'identity', 'hash', 'outcome', 'source'] as const) {
    const f = fake(request => {
      if (scenario === 'canonical') return script(request);
      const value = localDraft(request);
      if (scenario === 'identity') value.instanceId = randomUUID();
      if (scenario === 'hash') value.inputHash = 'd'.repeat(64);
      if (scenario === 'outcome') value.outcomeId = 'openGate';
      if (scenario === 'source') value.sourceRefs = [{ kind: 'scene', id: randomUUID(), seq: 1 }];
      return value;
    });
    if (scenario !== 'unmarked') f.generator.configuration = () => ({ fingerprint: 'b'.repeat(64), description: { outputFormat: 'local-segment-draft/v1' } });
    const x = setup(f.generator, { repairs: 0 });
    try {
      x.prepare(); await x.coordinator.tick(x.scope);
      assert.equal(x.instance().status, 'blocked', scenario); assert.equal(f.calls.length, 1);
      assert.equal(x.store.experience.list('results', x.scope).length, 0); assert.equal(x.instance().scriptResult, undefined);
      assert.equal(x.store.experience.get<ExperienceRun>('runs', x.scope.runId, x.scope).data.variables.trust, 0);
    } finally { x.close(); }
  }
});

test('11 optional local draft tag is accepted only under frozen local format; absent or conflicting Host declarations cannot select it', async () => {
  for (const host of ['local-segment-draft/v1', 'other/v1', undefined]) {
    const f = fake(request => { const { format: _format, ...body } = localDraft(request); return body; });
    f.generator.configuration = () => ({ fingerprint: 'b'.repeat(64), description: { ...(host ? { outputFormat: host } : {}) } });
    const x = setup(f.generator, { review: 'authorReview', independent: false, repairs: 0 });
    try {
      x.prepare(); await x.coordinator.tick(x.scope);
      assert.equal(x.instance().status, host === 'local-segment-draft/v1' ? 'waitingReview' : 'blocked');
      assert.equal(x.store.experience.list('results', x.scope).length, host === 'local-segment-draft/v1' ? 1 : 0);
      const raw = x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!.data.result as object;
      assert.equal(Object.hasOwn(raw, 'format'), false);
    } finally { x.close(); }
  }
});

test('11 common canonical validation requires every frozen source exactly once after either wire format', async () => {
  for (const format of ['canonical', 'local'] as const) for (const invalid of ['missing', 'duplicate'] as const) {
    const f = fake(request => {
      const value = format === 'local' ? localDraft(request) : script(request);
      value.sourceRefs = invalid === 'missing' ? [] : [...value.sourceRefs, ...value.sourceRefs]; return value;
    });
    if (format === 'local') f.generator.configuration = () => ({ fingerprint: 'b'.repeat(64), description: { outputFormat: 'local-segment-draft/v1' } });
    const x = setup(f.generator, { repairs: 1 });
    try {
      x.prepare(); await x.coordinator.tick(x.scope);
      assert.deepEqual(f.calls.map(call => call.stage), ['write', 'repair']);
      assert.match((f.calls[1]!.input.diagnosis as { message: string }).message, /完整保留冻结来源/);
      assert.equal(x.instance().status, 'blocked'); assert.equal(x.store.experience.list('results', x.scope).length, 0);
      const archived = x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!.data.result as { sourceRefs: unknown[] };
      assert.equal(archived.sourceRefs.length, invalid === 'missing' ? 0 : 2);
    } finally { x.close(); }
  }
});

test('11 S4 已消费模板正文以固定revision和hash进入前文，未消费的预生成模板不可作为经历', () => {
  const f = fake(), x = setup(f.generator);
  try {
    const template = { text: '守卫仍在观察，信任为 0。', contentHash: hash({ text: '守卫仍在观察，信任为 0。' }) };
    const add = (status: 'consumed' | 'ready', result: Partial<SegmentInstance>, ordinal: number) => {
      const visit = RuntimeVisit.parse({ id: randomUUID(), runId: x.scope.runId, nodeId: randomUUID(), status: status === 'consumed' ? 'completed' : 'planned', ordinal });
      x.store.experience.create('visits', x.scope, visit, visit.id);
      const instance = SegmentInstance.parse({ ...x.context.instance, id: randomUUID(), nodeId: visit.nodeId, visitId: visit.id, status, ...result });
      x.store.experience.create('instances', x.scope, instance, instance.id); return instance;
    };
    const consumed = add('consumed', { resultRevision: 1, templateResult: template }, 0);
    const future = add('ready', { resultRevision: 1, templateResult: { text: '尚未播放的未来正文', contentHash: hash({ text: '尚未播放的未来正文' }) } }, 2);
    const pastScript = SegmentScriptV1.parse(script({ requestId: randomUUID(), stage: 'write', inputHash: 'd'.repeat(64), configurationHash: 'b'.repeat(64), outputSchema: {},
      input: { instanceId: randomUUID(), inputHash: 'd'.repeat(64), outcomeId: 'accepted', context: { sourceRefs: [x.refs.scene] } } }));
    const generated = add('consumed', { resultRevision: 2, scriptResult: pastScript }, 1);
    x.context.run.variables.trust = 1;
    const prepared = x.prepare();
    const dispatch = x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!.data;
    const previous = dispatch.request.input.previousContent as any[];
    assert.deepEqual(previous.map(item => item.ref.instanceId), [consumed.id, generated.id]);
    assert.equal(previous.some(item => item.ref.instanceId === future.id), false);
    assert.deepEqual(previous[0], { ref: { runId: x.scope.runId, instanceId: consumed.id, resultRevision: 1, contentHash: template.contentHash }, template });
    assert.deepEqual(previous[1].ref, { runId: x.scope.runId, instanceId: generated.id, resultRevision: 2, contentHash: hash(pastScript) });
    assert.deepEqual(prepared.context!.priorInstanceRefs, previous.map(item => item.ref));
    assert.equal(prepared.context!.variableSnapshot.trust, 1); assert.equal(previous[0].template.text, template.text);
    assert.equal(f.calls.length, 0);
  } finally { x.close(); }
});

test('11 S5 已消费固定后备优先进入冻结前文，不把失败生成稿伪装成观众已看内容',()=>{
 const f=fake(),x=setup(f.generator);
 try{
  const visit=RuntimeVisit.parse({id:randomUUID(),runId:x.scope.runId,nodeId:randomUUID(),status:'completed',ordinal:0});x.store.experience.create('visits',x.scope,visit,visit.id);
  const fallback={id:randomUUID(),outcomeId:'accepted',text:'守卫接受证物并开门。',media:{buildRef:{kind:'build',id:randomUUID(),seq:1},fromFrame:0,toFrame:24,fps:24,contentHash:'f'.repeat(64)},contentHash:'e'.repeat(64),previousResultRevision:1};
  const old=SegmentScriptV1.parse(script({requestId:randomUUID(),stage:'write',inputHash:'a'.repeat(64),configurationHash:'b'.repeat(64),outputSchema:{},input:{instanceId:randomUUID(),inputHash:'c'.repeat(64),outcomeId:'accepted',context:{sourceRefs:[]}}}));
  const instance=SegmentInstance.parse({...x.context.instance,id:randomUUID(),visitId:visit.id,nodeId:visit.nodeId,status:'consumed',resultRevision:2,scriptResult:old,fallbackResult:fallback});x.store.experience.create('instances',x.scope,instance,instance.id);
  x.prepare();const input=x.store.experience.list<RuntimeDispatch>('dispatches',x.scope)[0]!.data.request.input,previous=input.previousContent as any[];
  assert.equal(previous.length,1);assert.equal(previous[0].script,undefined);assert.equal(previous[0].fallback.text,fallback.text);assert.deepEqual(previous[0].ref,{runId:x.scope.runId,instanceId:instance.id,resultRevision:2,contentHash:fallback.contentHash});assert.equal(f.calls.length,0);
 }finally{x.close();}
});
test('11 S4 default absent generator, simulation, changed configuration and budget zero never execute model', () => {
  for (const scenario of ['absent', 'simulation', 'changed', 'budget'] as const) {
    const f = fake(), x = setup(scenario === 'absent' ? undefined : f.generator, { mode: scenario === 'simulation' ? 'simulation' : 'playback' });
    try {
      if (scenario === 'changed') x.context.release.generationAuthorization!.textConfigurationFingerprint = 'd'.repeat(64);
      if (scenario === 'budget') { x.context.release.policy.maxTextCallsPerRun = 0; x.context.release.generationAuthorization!.policyHash = hash(x.context.release.policy); }
      assert.throws(() => x.prepare(), scenario === 'absent' ? /未接入/ : scenario === 'simulation' ? /模拟/ : scenario === 'changed' ? /配置/ : /预算/);
      assert.equal(f.calls.length, 0); assert.equal(x.store.experience.list('dispatches', x.scope).length, 0);
      assert.equal(x.store.experience.usage(x.scope).runText, 0);
    } finally { x.close(); }
  }
});
test('11 S4 mismatched outcome invokes bounded repair, records only matching revision and cannot change authoritative state', async () => {
  let writes = 0; const f = fake(request => { if (request.stage === 'check') return { schemaVersion: 1, instanceId: request.input.instanceId, inputHash: request.input.inputHash, resultRevision: request.input.resultRevision, status: 'passed', checks: [{ ruleId: 'FACTS', passed: true, evidenceBlockIds: [], message: '通过' }] }; const value = script(request); if (++writes === 1) value.outcomeId = 'invented'; return value; });
  const x = setup(f.generator);
  try { x.prepare(); await x.coordinator.tick(x.scope); assert.equal(x.instance().status, 'producing'); assert.deepEqual(f.calls.map(call => call.stage), ['write', 'repair', 'check']); assert.equal(x.instance().scriptResult!.outcomeId, 'accepted'); assert.equal(x.store.experience.list('results', x.scope).length, 1); }
  finally { x.close(); }
});
test('11 IT-16 exhausted repair limit keeps wrong-outcome drafts blocked without results or automatic re-dispatch', async () => {
  const f = fake(request => ({ ...script(request), outcomeId: 'invented' })), x = setup(f.generator, { repairs: 1 });
  try {
    x.prepare(); await x.coordinator.tick(x.scope); await x.coordinator.tick(x.scope);
    assert.deepEqual(f.calls.map(call => call.stage), ['write', 'repair']);
    assert.equal(x.instance().status, 'blocked'); assert.match(x.instance().recoveryReason!, /修复上限/);
    assert.equal(x.instance().scriptResult, undefined); assert.equal(x.store.experience.list('results', x.scope).length, 0);
    assert.equal(x.store.experience.usage(x.scope).runText, 2); assert.equal(x.store.experience.usage(x.scope).runMedia, 0);
    assert.equal(x.store.experience.get<ExperienceRun>('runs', x.scope.runId, x.scope).data.variables.trust, 0);
  } finally { x.close(); }
});
test('11 S4 schema repair retains bounded JSON locations and reasons without forwarding rejected input or opaque error data', async () => {
  const f = fake(request => {
    const result = script(request);
    // Stay within the collection bound: patched Zod rejects oversized arrays
    // before inspecting elements. Invalid scene and block IDs still exercise
    // more than 32 independent issues without relying on the old vulnerability.
    if (request.stage === 'write') result.scenes = Array.from({ length: 20 }, () => ({ ...result.scenes[0]!, id: 'rejected-private-value', title: 'private draft text never belongs in diagnosis', blocks: result.scenes[0]!.blocks.map(block=>({...block,id:'rejected-private-value'})) }));
    return result;
  });
  const x = setup(f.generator, { independent: false, review: 'authorReview' });
  try {
    x.prepare(); await x.coordinator.tick(x.scope);
    assert.equal(x.instance().status, 'waitingReview'); assert.deepEqual(f.calls.map(call => call.stage), ['write', 'repair']);
    const diagnosis = f.calls[1]!.input.diagnosis as { message: string; schemaIssues: { path: string; message: string }[]; truncatedIssues: boolean };
    assert.equal(diagnosis.schemaIssues.length, 32); assert.equal(diagnosis.truncatedIssues, true);
    assert.deepEqual(diagnosis.schemaIssues[0], { path: '$.scenes[0].id', message: 'Invalid UUID' });
    assert.ok(diagnosis.schemaIssues.every(issue => issue.path.length <= 257 && issue.message.length <= 400 && Object.keys(issue).length === 2));
    assert.ok(!JSON.stringify(diagnosis).includes('rejected-private-value')); assert.ok(!JSON.stringify(diagnosis).includes('private draft text'));
    assert.deepEqual(Object.keys(diagnosis).sort(), ['message', 'schemaIssues', 'truncatedIssues']);
    assert.equal(x.store.experience.list('results', x.scope).length, 1);
  } finally { x.close(); }
});
test('11 oversized scene collections are rejected before inspecting private element fields',()=>{
 let reads=0;
 const scenes=Array.from({length:21},()=>({get id(){reads++;throw new Error('oversized elements must not be inspected');}}));
 const parsed=SegmentScriptV1.safeParse({schemaVersion:1,instanceId:randomUUID(),inputHash:'a'.repeat(64),outcomeId:'accepted',timelineFps:24,scenes,shotPlan:[],sourceRefs:[],usedVariables:[],assertedFacts:[],contentChecks:[]});
 assert.equal(parsed.success,false);assert.equal(reads,0);
 if(!parsed.success)assert.ok(parsed.error.issues.some(issue=>issue.code==='too_big'&&issue.path.join('.')==='scenes'));
});
test('11 S4 author review is version-bound and unknown execution neither refunds nor automatically reissues', async () => {
  const f = fake(), x = setup(f.generator, { review: 'authorReview' });
  try { x.prepare(); await x.coordinator.tick(x.scope); assert.equal(x.instance().status, 'waitingReview'); assert.throws(() => x.coordinator.review(x.scope, x.instance().id, 2, true), /变化/); x.coordinator.review(x.scope, x.instance().id, 1, true); assert.equal(x.instance().status, 'producing'); }
  finally { x.close(); }
  const unknown = fake(() => { throw new DomainError('UNKNOWN_OUTCOME', '外部结果尚未确认'); }), y = setup(unknown.generator);
  try {
    y.prepare(); await y.coordinator.tick(y.scope); assert.equal(y.instance().status, 'unknown'); assert.equal(y.store.experience.usage(y.scope).runText, 1);
    y.coordinator.recover([y.scope]); await y.coordinator.tick(y.scope); assert.equal(unknown.calls.length, 1);
    assert.throws(() => y.store.transaction(() => y.coordinator.instanceCommand({ ...y.context, instance: y.instance(), operation: 'instance.retry', failedStage: 'writing' })), /失败/);
  } finally { y.close(); }
});
test('11 S4 text intent freezes input, validates finite candidates/fields and awaits ambiguity confirmation', async () => {
  const f = fake(request => ({ schemaVersion: 1, intentId: 'explain', candidateIntentIds: ['explain', 'ask'], extractedValues: {}, needsConfirmation: true, explanation: '你是想解释证物的来历吗？', inputHash: request.input.inputHash })), x = setup(f.generator);
  try {
    const activity = ActivityDefinition.parse({ id: randomUUID(), type: 'text-intent', version: 1, label: '如何交涉', config: { maxLength: 200, intents: [{ id: 'explain', label: '解释证物' }, { id: 'ask', label: '请求通行' }], interpretationTemplate: { id: 'gate-intent', version: 1 }, extractedFields: [] }, reads: [], resultMapping: [], presentation: { rendererKey: 'text-intent', prompt: '说说你的打算' } });
    x.context.release.snapshot.activities.push(activity);
    const node = { id: randomUUID(), type: 'activity' as const, title: '交涉', description: '', outlineOrder: 1, activityId: activity.id, next: x.ids.enter };
    const attempt = ActivityAttempt.parse({ id: randomUUID(), runId: x.scope.runId, visitId: x.context.visit.id, activityId: activity.id, descriptorVersion: 1, status: 'open' }); x.store.experience.create('activities', x.scope, attempt, attempt.id);
    x.store.transaction(() => { const data = x.coordinator.activity({ ...x.context, node, attempt, input: { text: '这件证物可以帮我们吗' } }); const row = x.store.experience.get('activities', attempt.id, x.scope); x.store.experience.save('activities', row.id, x.scope, row.seq, data); });
    assert.equal(f.calls.length, 0); await x.coordinator.tick(x.scope);
    const saved = x.store.experience.get<ActivityAttempt>('activities', attempt.id, x.scope).data;
    assert.equal(saved.status, 'needsConfirmation'); assert.deepEqual(saved.input, { text: '这件证物可以帮我们吗' }); assert.equal(saved.result, undefined);
    assert.equal(x.store.experience.usage(x.scope).runText, 1);
  } finally { x.close(); }
});
test('11 S4 restricted adapter uses no author tools, saves exact result and never resubmits same request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dreamer-restricted-text-')); let starts = 0, turns = 0; let discovered: unknown;
  const adapter = new RestrictedRuntimeGenerator(root, { model: 'fixture', reasoningEffort: 'low', factory: () => ({ async start(_id, tools) { starts++; discovered = tools; return 'thread-fixture'; }, async turn(_id, _text, onEvent, onTool) { turns++; await assert.rejects(onTool('script_create', {}, 'call'), /不提供作者工具/); queueMicrotask(() => { onEvent({ type: 'delta', text: '{"value":"保存的结果"}' }); onEvent({ type: 'complete' }); }); return 'turn-fixture'; }, async interrupt() {}, close() {} }) });
  try {
    const request: RuntimeTextRequest = { requestId: randomUUID(), stage: 'write', inputHash: 'e'.repeat(64), configurationHash: adapter.configuration().fingerprint, input: {}, outputSchema: {} };
    assert.equal(starts, 0); const remote: unknown[] = [];
    assert.deepEqual(await adapter.execute(request, value => remote.push(value)), { value: '保存的结果' });
    assert.deepEqual(await adapter.execute(request, () => {}), { value: '保存的结果' });
    assert.equal(starts, 1); assert.equal(turns, 1); assert.deepEqual(discovered, []); assert.equal(remote.length, 2);
    assert.deepEqual(await adapter.reconcile(request), { value: '保存的结果' });
    await assert.rejects(adapter.reconcile({ ...request, inputHash: 'f'.repeat(64) }), /冻结输入/);
  } finally { adapter.close(); rmSync(root, { recursive: true, force: true }); }
});

test('11 IT-11 invalid intent or extracted field and unknown interpretation retain original input without effects or blind retry', async () => {
  for (const scenario of ['intent', 'field', 'unknown'] as const) {
    const f = fake(request => {
      if (scenario === 'unknown') throw new DomainError('UNKNOWN_OUTCOME', 'fixture response interrupted');
      return { schemaVersion: 1, intentId: scenario === 'intent' ? 'invented' : 'wait', candidateIntentIds: ['wait'], extractedValues: scenario === 'field' ? { undeclared: 'private-field' } : {}, needsConfirmation: false, explanation: '分类结果', inputHash: request.input.inputHash };
    }), x = setup(f.generator);
    try {
      const activity = ActivityDefinition.parse({ id: randomUUID(), type: 'text-intent', version: 1, label: '等候请求', config: { maxLength: 200, intents: [{ id: 'wait', label: '等朋友' }], interpretationTemplate: { id: 'waiting', version: 1 }, extractedFields: [] }, reads: [], resultMapping: [], presentation: { rendererKey: 'text-intent', prompt: '你要做什么？' } });
      x.context.release.snapshot.activities.push(activity);
      const node = { id: randomUUID(), type: 'activity' as const, title: '等候请求', description: '', outlineOrder: 1, activityId: activity.id, next: x.ids.enter };
      const attempt = ActivityAttempt.parse({ id: randomUUID(), runId: x.scope.runId, visitId: x.context.visit.id, activityId: activity.id, descriptorVersion: 1, status: 'open' });
      x.store.experience.create('activities', x.scope, attempt, attempt.id);
      const input = { text: '我只想在门外等朋友。' }, context = { ...x.context, node, attempt, input };
      x.store.transaction(() => {
        const prepared = x.coordinator.activity(context), row = x.store.experience.get('activities', attempt.id, x.scope);
        x.store.experience.save('activities', row.id, x.scope, row.seq, prepared);
      });
      await x.coordinator.tick(x.scope); await x.coordinator.tick(x.scope);
      const actual = x.store.experience.get<ActivityAttempt>('activities', attempt.id, x.scope).data;
      assert.equal(actual.status, 'failed'); assert.deepEqual(actual.input, input); assert.equal(actual.result, undefined);
      assert.equal(f.calls.length, 1); assert.equal(x.store.experience.list('effects', x.scope).length, 0);
      assert.deepEqual(x.store.experience.get<ExperienceRun>('runs', x.scope.runId, x.scope).data.variables, x.context.run.variables);
      const dispatch = x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!.data;
      assert.equal(dispatch.state, scenario === 'unknown' ? 'unknown' : 'failed'); assert.equal(dispatch.result, undefined);
      if (scenario === 'unknown') assert.throws(() => x.store.transaction(() => x.coordinator.activity({ ...context, attempt: actual })), /原解释结果未知/);
      assert.equal(x.store.experience.usage(x.scope).runText, 1);
    } finally { x.close(); }
  }
});

test('11 S4 exhausted independent-check budget preserves the generated text and does not admit playback', async () => {
  const f = fake(), x = setup(f.generator, { calls: 1 });
  try {
    x.prepare(); await x.coordinator.tick(x.scope);
    assert.equal(f.calls.length, 1); assert.equal(x.instance().status, 'blocked');
    assert.equal(x.instance().resultRevision, 1); assert.equal(x.instance().scriptResult!.outcomeId, 'accepted');
    assert.equal(x.store.experience.list('results', x.scope).length, 1); assert.equal(x.store.experience.usage(x.scope).runText, 1);
    assert.ok(x.instance().checks.some(check => check.stage === 'content' && check.status === 'failed'));
  } finally { x.close(); }
});
test('11 S4 cancellation before dispatch releases only its unspent reservation and performs zero model calls', async () => {
  const f = fake(), x = setup(f.generator);
  try {
    x.prepare(); x.store.transaction(() => {
      const row = x.store.experience.get<SegmentInstance>('instances', x.context.instance.id, x.scope);
      const cancelled = x.coordinator.instanceCommand({ ...x.context, instance: row.data, operation: 'instance.cancel' });
      x.store.experience.save('instances', row.id, x.scope, row.seq, cancelled);
    });
    await x.coordinator.tick(x.scope); assert.equal(f.calls.length, 0); assert.equal(x.instance().status, 'cancelled');
    assert.equal(x.store.experience.usage(x.scope).runText, 0);
  } finally { x.close(); }
});
test('11 S4 result commit fault rolls back result and state atomically; reconciliation collects original output without writing again', async () => {
  const f = fake(), results = new Map<string, unknown>();
  const execute = f.generator.execute;
  f.generator.execute = async (request, save) => { const result = await execute(request, save); results.set(request.requestId, result); return result; };
  f.generator.reconcile = async request => results.get(request.requestId);
  const x = setup(f.generator, { independent: false, review: 'authorReview' });
  try {
    const save = x.store.experience.save.bind(x.store.experience); let inject = true;
    x.store.experience.save = ((collection: any, id: string, scope: any, seq: number, data: any) => {
      if (inject && collection === 'instances' && data.status === 'waitingReview') { inject = false; throw new DomainError('INTERNAL', 'injected result commit failure'); }
      return save(collection, id, scope, seq, data);
    }) as typeof x.store.experience.save;
    x.prepare(); await x.coordinator.tick(x.scope);
    assert.equal(x.instance().status, 'unknown'); assert.equal(x.store.experience.list('results', x.scope).length, 0);
    assert.equal(x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!.data.state, 'unknown');
    assert.equal(x.store.experience.usage(x.scope).runText, 1); assert.equal(f.calls.length, 1);
    await x.coordinator.reconcile(x.scope, x.context.instance.id);
    assert.equal(x.instance().status, 'waitingReview'); assert.equal(x.store.experience.list('results', x.scope).length, 1); assert.equal(f.calls.length, 1);
  } finally { x.close(); }
});

test('11 S4 validated-runtime cannot bypass independent content review with a structure-only contract', () => {
  const f = fake(), x = setup(f.generator, { independent: false });
  try { assert.throws(() => x.prepare(), /独立内容检查/); assert.equal(f.calls.length, 0); assert.equal(x.store.experience.list('dispatches', x.scope).length, 0); }
  finally { x.close(); }
});

test('11 S4 closing Host during an external text request leaves durable dispatch for recovery and ignores late result/remote callback', async () => {
  let complete!: () => void, entered = false;
  const f = fake(), pending = new Promise<void>(resolve => { complete = resolve; });
  f.generator.execute = async (request, saveRemote) => { entered = true; await pending; saveRemote({ threadId: 'late-thread', turnId: 'late-turn' }); return script(request); };
  const x = setup(f.generator);
  try {
    x.prepare(); const ticking = x.coordinator.tick(x.scope); assert.equal(entered, true);
    x.coordinator.close(); x.store.close(); complete(); await ticking;
    const reopened = new SqliteStore(x.root);
    try { assert.equal(reopened.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!.data.state, 'dispatched'); assert.equal(reopened.experience.list('results', x.scope).length, 0); }
    finally { reopened.close(); }
  } finally { rmSync(x.root, { recursive: true, force: true }); }
});
