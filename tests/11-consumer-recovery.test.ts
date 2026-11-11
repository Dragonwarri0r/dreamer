import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SqliteStore } from '../packages/infra/sqlite.ts';
import { ProjectData, DomainError, stable } from '../packages/contracts/foundation.ts';
import { ScriptPlanData } from '../packages/contracts/interactive-script.ts';
import { ScriptRelease, type RuntimeCommand } from '../packages/contracts/experience.ts';
import { ExperienceRuntime } from '../packages/core/experience/runtime.ts';
import { RuntimeGeneration, type RuntimeTextGenerator, type RuntimeTextRequest, type RuntimeDispatch } from '../packages/core/experience/generation.ts';
import type { GenerationReservation } from '../packages/core/experience/ports.ts';

const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(options: { failure?: 'unknown' | 'failed'; calls?: number; retries?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dreamer-consumer-recovery-'));
  let store = new SqliteStore(root), runtime: ExperienceRuntime, generation: RuntimeGeneration;
  const projectId = randomUUID(), principal = { projectId, uid: 'reader' }, nodeId = randomUUID(), activityId = randomUUID(), endingId = randomUUID();
  const requests: RuntimeTextRequest[] = [], reconciled: RuntimeTextRequest[] = [], originals = new Map<string, unknown>();
  const generator: RuntimeTextGenerator = {
    configuration: () => ({ fingerprint: 'b'.repeat(64), description: { model: 'deterministic-no-network' } }),
    async execute(request) {
      requests.push(request);
      originals.set(request.requestId, { schemaVersion: 1, intentId: 'wait', candidateIntentIds: [], extractedValues: {}, needsConfirmation: false, explanation: '等待', inputHash: request.input.inputHash });
      throw new DomainError(options.failure === 'failed' ? 'VALIDATION' : 'UNKNOWN_OUTCOME', 'isolated fixture interrupted');
    },
    async reconcile(request) { reconciled.push(request); return originals.get(request.requestId); },
  };
  store.repository('project', ProjectData).create(projectId, ProjectData.parse({ title: '消费恢复测试' }), projectId);
  const snapshot = ScriptPlanData.parse({ schemaVersion: 1, title: '输入到结局', chapterRefs: [], entryNodeId: nodeId,
    variables: [{ key: 'intent', label: '意图', type: 'enum', scope: 'run', initial: 'unset', values: ['unset', 'wait'], allowedWriters: [{ sourceId: nodeId, commitAt: 'activityAccepted' }] }],
    nodes: [{ id: nodeId, type: 'activity', title: '必答输入', outlineOrder: 0, activityId, next: endingId }, { id: endingId, type: 'ending', title: '结束', outlineOrder: 1, endingKey: 'done', summary: '等待' }],
    activities: [{ id: activityId, type: 'text-intent', version: 1, label: '请求', config: { maxLength: 200, intents: [{ id: 'wait', label: '在门外等待' }], interpretationTemplate: { id: 'test', version: 1 }, extractedFields: [] }, retryPolicy: { maxAttempts: options.retries ?? 1 },
      resultMapping: [{ id: randomUUID(), op: 'set', key: 'intent', value: { source: 'result', field: 'intentId' }, commitAt: 'activityAccepted' }], presentation: { rendererKey: 'text-intent', prompt: '你的选择' } }],
    cues: [], policy: { maxTextCallsPerRun: options.calls ?? 4, maxMediaJobsPerRun: 0 } });
  const release = ScriptRelease.parse({ id: randomUUID(), projectId, scriptRef: { kind: 'script', id: randomUUID(), seq: 1 }, schemaVersion: 1, kind: 'playback', manifestHash: hash(snapshot), snapshot, dependencyRefs: [], activityVersions: [{ type: 'text-intent', version: 1 }], policy: snapshot.policy,
    generationAuthorization: { source: 'human', confirmedAt: new Date().toISOString(), policyHash: hash(snapshot.policy), textConfigurationFingerprint: generator.configuration().fingerprint }, createdAt: new Date().toISOString() });
  store.experience.create('releases', { projectId }, release, release.id);
  function wire() {
    runtime = new ExperienceRuntime(store.experience, () => { throw new Error('No source/media read expected'); });
    generation = new RuntimeGeneration(store.experience, () => undefined, generator, { acceptPreparedInternal: (s, i) => { runtime.acceptPreparedInternal(s, i); }, acceptActivityInternal: (s, a) => { runtime.acceptActivityInternal(s, a); } });
    runtime.hooks.activity = context => generation.activity(context);
    runtime.hooks.activityRecovery = context => generation.activityRecovery(context);
    runtime.hooks.reconcileActivity = context => generation.activityReconcile(context);
  }
  wire();
  const initial = runtime!.start(principal, { protocolVersion: 1, requestId: randomUUID(), projectId, releaseId: release.id, mode: 'playback' }).view;
  const scope = { ...principal, runId: initial.run.id };
  const view = () => runtime.view(principal, scope.runId);
  const input = (operation: string, payload: unknown): RuntimeCommand => { const v = view(); return { protocolVersion: 1, requestId: randomUUID(), runId: scope.runId, expectedStateSeq: v.run.stateSeq, visitId: operation.startsWith('activity.') ? initial.attempt!.visitId : v.run.currentVisitId, operation, payload } as RuntimeCommand; };
  const command = (operation: string, payload: unknown) => runtime.execute(principal, input(operation, payload));
  return { root, principal, scope, initial, generator, requests, reconciled, originals, view, input, command,
    get runtime() { return runtime; }, get generation() { return generation; }, get store() { return store; },
    submit() { return command('activity.submit', { attemptId: initial.attempt!.id, input: { text: '我想在门外等朋友' } }); },
    reconcileInput() { return input('activity.reconcile', { attemptId: initial.attempt!.id }); },
    reopen() { generation.close(); store.close(); store = new SqliteStore(root); wire(); generation.recover([scope]); },
    close() { generation.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('11 consumer unknown interpretation reconciles its original request after reopen, without new calls or quota and with one effect', async () => {
  const x = fixture({ calls: 1 });
  try {
    x.submit(); await settle();
    assert.equal(x.view().attempt!.status, 'failed'); // Persisted v1 status remains compatible.
    assert.equal(x.view().activity!.recoveryState, 'unknown'); assert.equal(x.view().activity!.canRetry, false); assert.equal(x.view().activity!.canReconcile, true);
    assert.throws(() => x.command('activity.retry', { attemptId: x.initial.attempt!.id }), /只能核对/);
    x.reopen(); await settle(); assert.equal(x.view().activity!.canReconcile, true);
    const original = x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!, request = x.reconcileInput();
    x.runtime.execute(x.principal, request); await settle();
    assert.equal(x.view().run.status, 'completed'); assert.equal(x.view().run.variables.intent, 'wait'); assert.equal(x.view().run.committedFacts.length, 1);
    assert.equal(x.requests.length, 1); assert.equal(x.reconciled.length, 1); assert.deepEqual(x.reconciled[0], original.data.request);
    assert.equal(x.store.experience.usage(x.scope).runText, 1); assert.equal(x.store.experience.list('reservations', x.scope).length, 1);
    assert.equal(x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!.data.requestId, original.data.requestId);
    assert.equal(x.runtime.execute(x.principal, request).receipt.replayed, true); await settle(); assert.equal(x.reconciled.length, 1);
    const trace = x.runtime.tracePage(x.principal, x.scope.runId); assert.equal(trace.visits[0]!.resultLabel, '在门外等待');
    assert.throws(() => x.runtime.view({ ...x.principal, uid: 'other' }, x.scope.runId), /当前范围/);
  } finally { x.close(); }
});

test('11 consumer unknown input disables unsupported or changed-config reconciliation and coalesces repeated unresolved queries', async () => {
  const x = fixture();
  try {
    x.submit(); await settle(); const reconcile = x.generator.reconcile!;
    x.generator.reconcile = undefined; assert.equal(x.view().activity!.canReconcile, false); assert.match(x.view().activity!.recoveryReason!, /未提供/);
    assert.throws(() => x.runtime.execute(x.principal, x.reconcileInput()), /未提供/);
    x.generator.reconcile = reconcile;
    const configuration = x.generator.configuration; x.generator.configuration = () => ({ fingerprint: 'c'.repeat(64), description: {} });
    assert.equal(x.view().activity!.canReconcile, false); assert.throws(() => x.runtime.execute(x.principal, x.reconcileInput()), /固定模型配置/); assert.equal(x.reconciled.length, 0);
    x.generator.configuration = configuration;
    let resolve!: (value: unknown) => void, calls = 0;
    x.generator.reconcile = async () => { calls++; return new Promise(r => { resolve = r; }); };
    x.runtime.execute(x.principal, x.reconcileInput()); x.runtime.execute(x.principal, x.reconcileInput()); await settle(); assert.equal(calls, 1);
    resolve(undefined); await settle(); assert.equal(x.view().activity!.canRetry, false); assert.equal(x.view().activity!.canReconcile, true); assert.match(x.view().activity!.recoveryReason!, /尚未找到/);
    assert.equal(x.requests.length, 1); assert.equal(x.store.experience.usage(x.scope).runText, 1);
  } finally { x.close(); }
});

test('11 consumer retry capability reflects explicit failure, extra-attempt limit and remaining run text budget', async () => {
  for (const calls of [1, 4]) {
    const x = fixture({ failure: 'failed', retries: 1, calls });
    try {
      x.submit(); await settle(); assert.equal(x.view().activity!.recoveryState, 'none'); assert.equal(x.view().activity!.canReconcile, false);
      assert.equal(x.view().activity!.canRetry, calls > 1);
      if (calls > 1) { x.command('activity.retry', { attemptId: x.initial.attempt!.id }); assert.equal(x.view().run.status, 'waitingContent'); assert.equal(x.view().attempt!.recoveryReason, undefined); await settle(); }
      assert.equal(x.view().activity!.canRetry, false);
      assert.throws(() => x.command('activity.retry', { attemptId: x.initial.attempt!.id }), /次数预算/);
      assert.equal(x.requests.length, calls > 1 ? 2 : 1);
    } finally { x.close(); }
  }
});

test('11 consumer original-input reconciliation rejects mismatched reservations and validates recovered results before effects', async () => {
  const x = fixture();
  try {
    x.submit(); await settle();
    const dispatch = x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!;
    const reservation = x.store.experience.get<GenerationReservation>('reservations', dispatch.data.reservationId, x.scope);
    const altered = x.store.experience.save('reservations', reservation.id, x.scope, reservation.seq, { ...reservation.data, dispatchId: randomUUID() });
    await assert.rejects(x.generation.reconcileActivity(x.scope, x.initial.attempt!.id), /额度记录不一致/);
    assert.equal(x.reconciled.length, 0); assert.equal(x.requests.length, 1); assert.equal(x.view().run.committedFacts.length, 0);
    x.store.experience.save('reservations', reservation.id, x.scope, altered.seq, reservation.data);
    x.originals.set(dispatch.data.requestId, { ...(x.originals.get(dispatch.data.requestId) as object), intentId: 'undeclared' });
    x.runtime.execute(x.principal, x.reconcileInput()); await settle();
    assert.equal(x.reconciled.length, 1); assert.equal(x.view().run.variables.intent, 'unset'); assert.equal(x.view().run.committedFacts.length, 0);
    assert.equal(x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!.data.state, 'failed');
    assert.equal(x.view().activity!.recoveryState, 'none'); assert.equal(x.view().activity!.canReconcile, false); assert.equal(x.view().activity!.canRetry, true);
    assert.equal(x.store.experience.usage(x.scope).runText, 1);
  } finally { x.close(); }
});

test('11 consumer abandoning during original-input reconciliation blocks new activity operations and ignores late story effects', async () => {
  const x = fixture();
  try {
    const submitted = x.input('activity.submit', { attemptId: x.initial.attempt!.id, input: { text: '我想在门外等朋友' } });
    x.runtime.execute(x.principal, submitted); await settle();
    let finish!: (result: unknown) => void; x.generator.reconcile = async () => new Promise(resolve => { finish = resolve; });
    x.runtime.execute(x.principal, x.reconcileInput()); await settle(); x.command('run.abandon', {});
    assert.equal(x.view().activity!.canRetry, false); assert.equal(x.view().activity!.canReconcile, false);
    for (const operation of ['activity.reconcile', 'activity.retry', 'activity.skip']) assert.throws(() => x.command(operation, { attemptId: x.initial.attempt!.id }), /体验已结束/);
    assert.equal(x.runtime.execute(x.principal, submitted).receipt.replayed, true);
    finish(x.originals.get(x.requests[0]!.requestId)); await settle();
    assert.equal(x.view().run.status, 'abandoned'); assert.equal(x.view().run.variables.intent, 'unset'); assert.equal(x.view().run.committedFacts.length, 0);
    assert.equal(x.store.experience.list<RuntimeDispatch>('dispatches', x.scope)[0]!.data.state, 'completed'); assert.equal(x.store.experience.usage(x.scope).runText, 1);
  } finally { x.close(); }
});
