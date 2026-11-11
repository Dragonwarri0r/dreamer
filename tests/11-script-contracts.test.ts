import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Condition, ScriptPlanData, ScriptOperation } from '../packages/contracts/interactive-script.ts';
import { RuntimeCommand, RuntimeStart, ScriptRelease } from '../packages/contracts/experience.ts';
import { ActivityDefinition, ChoiceActivity } from '../packages/contracts/activities.ts';
import { initialVariables, evaluateCondition, selectBranch, applyEffects, applyScriptOperations, resetSegmentVariables, segmentVariableKeys } from '../packages/core/story/rules.ts';
import { validateScript, collectScriptRefs } from '../packages/core/story/validation.ts';
import { cityGateFixture, interactiveId } from './fixtures/interactive-script.ts';

const errors = (plan: unknown) => validateScript(plan).filter(item => item.severity === 'error');
test('11 S1 strict script fixture preserves fixed references and supports pure schema export without Application', () => {
  const { plan, refs } = cityGateFixture();
  assert.deepEqual(errors(plan), []);
  assert.deepEqual(collectScriptRefs(plan), [refs.chapter, refs.scene]);
  assert.equal(ScriptPlanData.safeParse({ ...plan, arbitrary: 'no' }).success, false);
  const json = z.toJSONSchema(ScriptPlanData, { reused: 'ref' });
  assert.equal(json.type, 'object'); assert.ok(json.$defs);
  assert.equal(ScriptOperation.safeParse({ op: 'node.remove', nodeId: plan.entryNodeId, script: 'arbitrary' }).success, false);
  assert.equal(ScriptOperation.safeParse({ op: 'eval', code: 'while(true){}' }).success, false);
});
test('11 S1 graph diagnoses cycle, missing target, unreachable node, duplicate priority and missing ending', () => {
  const { plan, ids } = cityGateFixture();
  const cyclic = structuredClone(plan); (cyclic.nodes.find(item => item.id === ids.gate) as any).next = ids.intro;
  assert.ok(errors(cyclic).some(item => item.ruleId === 'GRAPH_CYCLE'));
  const missing = structuredClone(plan); (missing.nodes[0] as any).next = interactiveId(999);
  assert.ok(errors(missing).some(item => item.ruleId === 'TARGET_UNKNOWN' && item.nodeId === ids.intro));
  assert.ok(errors(missing).some(item => item.ruleId === 'NODE_UNREACHABLE'));
  const priority = structuredClone(plan); (priority.nodes.find(item => item.id === ids.branch) as any).cases[1].priority = 10;
  assert.ok(errors(priority).some(item => item.ruleId === 'PRIORITY_DUPLICATE'));
  assert.ok(errors({ ...plan, nodes: plan.nodes.filter(node => node.type !== 'ending') }).some(item => item.ruleId === 'ENDING_REQUIRED'));
});
test('11 S1 deterministic branch priority, fallback and typed bounded conditions', () => {
  const { plan, ids } = cityGateFixture(), state = initialVariables(plan.variables), branch = plan.nodes.find(node => node.id === ids.branch)!;
  assert.equal(branch.type, 'branch'); if (branch.type !== 'branch') return;
  assert.equal(selectBranch(branch, { ...state, approach: 'rescue' }, plan.variables).to, ids.rescue);
  assert.equal(selectBranch(branch, { ...state, approach: 'proof' }, plan.variables).fallback, true);
  assert.equal(evaluateCondition({ op: 'all', conditions: [{ op: 'gte', key: 'trust', value: 0 }, { op: 'not', condition: { op: 'eq', key: 'hasEvidence', value: true } }] }, state, plan.variables), true);
  assert.throws(() => evaluateCondition({ op: 'any', conditions: [{ op: 'eq', key: 'hasEvidence', value: false }, { op: 'eq', key: 'unknown', value: true }] }, state, plan.variables), /未声明/);
  assert.throws(() => evaluateCondition({ op: 'eq', key: 'trust', value: '0' }, state, plan.variables), /类型/);
  let nested: any = { op: 'eq', key: 'trust', value: 0 }; for (let i = 0; i < 20; i++) nested = { op: 'not', condition: nested };
  assert.equal(Condition.safeParse(nested).success, false);
  assert.equal(Condition.safeParse({ op: 'all', conditions: Array.from({ length: 64 }, () => ({ op: 'eq', key: 'trust', value: 0 })) }).success, false);
});
test('11 S1 effects enforce node writers, phase, result type, range and atomicity', () => {
  const { plan, ids } = cityGateFixture(), state = initialVariables(plan.variables), effects = plan.activities[0]!.resultMapping;
  const accepted = applyEffects(plan.variables, state, effects, { sourceId: ids.approach, phase: 'activityAccepted', result: { optionId: 'rescue' } });
  assert.equal(accepted.approach, 'rescue'); assert.equal(state.approach, 'undecided');
  assert.throws(() => applyEffects(plan.variables, state, effects, { sourceId: ids.activity, phase: 'activityAccepted', result: { optionId: 'rescue' } }), /无权/);
  assert.throws(() => applyEffects(plan.variables, state, effects, { sourceId: ids.approach, phase: 'segmentCompleted', result: { optionId: 'rescue' } }), /阶段/);
  assert.throws(() => applyEffects(plan.variables, state, effects, { sourceId: ids.approach, phase: 'activityAccepted', result: { optionId: 'invented' } }), /类型/);
  const rescue = plan.nodes.find(node => node.id === ids.rescue)!; if (rescue.type !== 'segment') return;
  const excessive = [{ ...rescue.completionEffects[0]! }, { ...rescue.completionEffects[0]!, id: interactiveId(90), value: { source: 'constant' as const, value: 3 } }];
  assert.throws(() => applyEffects(plan.variables, state, excessive, { sourceId: ids.rescue, phase: 'segmentCompleted' }), /越界/);
  assert.equal(state.trust, 0);
  assert.throws(() => applyEffects(plan.variables, state, [rescue.completionEffects[0]!, rescue.completionEffects[0]!], { sourceId: ids.rescue, phase: 'segmentCompleted' }), /重复效果/);
  assert.equal(resetSegmentVariables(plan.variables, { ...state, trust: 2 }).trust, 2);
});
test('11 S1 source references, block anchors and cue binding use fixed local media clock', () => {
  const { plan, ids } = cityGateFixture({ media: true });
  const readRef = (ref: any) => ref.kind === 'scene' ? { chapterId: ids.chapter, blocks: [{ id: ids.block }] } : ref.kind === 'build' ? { state: 'completed', output: { id: interactiveId(91) } } : { title: '章' };
  assert.deepEqual(validateScript(plan, { mode: 'playback', readRef }), []);
  const bad = structuredClone(plan); bad.cues[0]!.resolvedBinding!.fps = 30; bad.cues[0]!.anchor.blockId = interactiveId(95);
  const issues = validateScript(bad, { mode: 'playback', readRef });
  assert.ok(issues.some(item => item.ruleId === 'ANCHOR_STALE' && item.fieldPath.endsWith('blockId')));
  assert.ok(issues.some(item => item.ruleId === 'ANCHOR_STALE' && item.fieldPath.endsWith('resolvedBinding')));
  assert.ok(validateScript(cityGateFixture().plan, { mode: 'playback' }).some(item => item.ruleId === 'MEDIA_MISSING' && item.severity === 'error'));
  assert.ok(validateScript(cityGateFixture().plan).some(item => item.ruleId === 'MEDIA_MISSING' && item.severity === 'warning'));
});
test('11 S1 unknown extension retained but blocked for playback; malformed builtin cannot bypass strict schema', () => {
  const { plan } = cityGateFixture();
  assert.equal(ActivityDefinition.safeParse({ ...plan.activities[0], config: { options: [], arbitrary: true } }).success, false);
  assert.equal(ChoiceActivity.safeParse({ ...plan.activities[0], config: { options: [], arbitrary: true } }).success, false);
  const game = structuredClone(plan); game.activities[0] = ActivityDefinition.parse({ ...game.activities[0], type: 'puzzle', version: 1, config: { difficulty: 1 }, resultMapping: [] });
  assert.ok(validateScript(game).some(item => item.ruleId === 'ACTIVITY_UNSUPPORTED' && item.severity === 'warning'));
  assert.ok(validateScript(game, { mode: 'playback' }).some(item => item.ruleId === 'ACTIVITY_UNSUPPORTED' && item.severity === 'error'));
});
test('11 S1 author ops preserve original on failure, distinguish insert/replace and diagnose dangling removals', () => {
  const { plan, ids } = cityGateFixture();
  const renamed = applyScriptOperations(plan, [{ op: 'title.set', title: '新标题' }]);
  assert.equal(renamed.title, '新标题'); assert.equal(plan.title, '城门之前');
  assert.throws(() => applyScriptOperations(plan, [{ op: 'title.set', title: '不应保存' }, { op: 'node.insert', node: plan.nodes[0]! }]), /已存在/);
  assert.equal(plan.title, '城门之前');
  assert.ok(errors(applyScriptOperations(plan, [{ op: 'node.remove', nodeId: ids.early }])).some(item => item.ruleId === 'TARGET_UNKNOWN'));
  const fixed = applyScriptOperations(plan, [{ op: 'branch.case.remove', nodeId: ids.branch, caseId: interactiveId(30) }, { op: 'node.remove', nodeId: ids.early }]);
  assert.deepEqual(errors(fixed), []);
});
test('11 S1 runtime envelopes reject authority injection and release freezes author snapshot', () => {
  const { plan } = cityGateFixture(), id = interactiveId(100);
  const start = { protocolVersion: 1, requestId: id, projectId: interactiveId(101), releaseId: interactiveId(102), mode: 'simulation' };
  assert.equal(RuntimeStart.safeParse(start).success, true);
  assert.equal(RuntimeStart.safeParse({ ...start, uid: 'elsewhere' }).success, false);
  assert.equal(RuntimeCommand.safeParse({ protocolVersion: 1, requestId: id, runId: id, visitId: id, expectedStateSeq: 1, operation: 'activity.submit', payload: { attemptId: id, input: { optionId: 'proof' }, target: { kind: 'project', id } } }).success, false);
  const release = ScriptRelease.parse({ id, projectId: interactiveId(101), scriptRef: { kind: 'script', id: interactiveId(103), seq: 1 }, schemaVersion: 1, kind: 'simulation', manifestHash: 'b'.repeat(64), snapshot: plan, dependencyRefs: collectScriptRefs(plan), activityVersions: [{ type: 'choice', version: 1 }], policy: plan.policy, createdAt: '2026-10-22T00:00:00.000Z' });
  assert.equal(release.snapshot.title, plan.title);
});

test('11 模板变体条件必须声明读集，运行依赖仍覆盖旧版本遗漏的条件变量', () => {
  const { plan, media } = cityGateFixture({ media: true });
  const node = plan.nodes[0]; assert.equal(node?.type, 'segment'); if (node?.type !== 'segment') return;
  node.mode = 'template';
  node.contentSpec = { mode: 'template', reads: ['approach'], text: '选择 {{approach}}', variants: [{ id: interactiveId(180),
    when: { op: 'all', conditions: [{ op: 'gte', key: 'trust', value: 1 }, { op: 'not', condition: { op: 'eq', key: 'hasEvidence', value: false } }] }, media, outcomeId: 'continue' }] };
  const issues = errors(plan).filter(item => item.ruleId === 'READ_NOT_DECLARED');
  assert.equal(issues.length, 2); assert.ok(issues.every(item => item.nodeId === node.id && item.fieldPath.endsWith('.reads')));
  assert.deepEqual(segmentVariableKeys(node), ['approach', 'hasEvidence', 'trust']);
  node.contentSpec.reads.push('trust', 'hasEvidence');
  assert.deepEqual(errors(plan), []);
});
