import { randomUUID } from 'node:crypto';
import { ensure, parse, stable, type Ref } from '../../contracts/foundation.ts';
import {
  ExperienceRun, RuntimePrincipal, RuntimeStart, RuntimeCommand, PositionSave, RuntimeView,
  RuntimeResponse, RuntimeVisit, SegmentInstance, ScriptRelease, PlayableSegment, CommittedEffect, RuntimeTraceQuery, RuntimeTracePage,
} from '../../contracts/experience.ts';
import { ActivityAttempt, ChoiceActivity, ChoiceInput, TextIntentActivity, TextIntentInput, type ActivityDefinition, type Effect, type CommitPhase, type RuleValue } from '../../contracts/activities.ts';
import { activityResultLabel } from '../../contracts/activity-result-label.ts';
import type { ScriptNode, FixedMedia } from '../../contracts/interactive-script.ts';
import { applyEffects, initialVariables, selectBranch, evaluateCondition, conditionVariableKeys, segmentVariableKeys } from '../story/rules.ts';
import { contentHash, mediaPlanId } from '../story/script.ts';
import type { ReferenceReader } from '../modules/authoring.ts';
import type { ExperiencePersistence, ExperienceRow, RunScope } from './ports.ts';

type SegmentNode = Extract<ScriptNode, { type: 'segment' }>;
type ActivityNode = Extract<ScriptNode, { type: 'activity' }>;
type State = { principal: RuntimePrincipal; scope: RunScope; run: ExperienceRun; release: ScriptRelease };
export type RuntimePreparation = State & { node: SegmentNode; visit: RuntimeVisit; instance: SegmentInstance };
export type RuntimeActivityInput = State & { node: ActivityNode; attempt: ActivityAttempt; activity: ActivityDefinition; input: unknown };
export type RuntimeHooks = {
  prepare?: (context: RuntimePreparation) => SegmentInstance;
  activity?: (context: RuntimeActivityInput) => ActivityAttempt;
  activityRecovery?: (context: RuntimeActivityInput) => { canReconcile: boolean; recoveryReason?: string };
  reconcileActivity?: (context: RuntimeActivityInput) => ActivityAttempt;
  instanceCommand?: (context: RuntimePreparation & { operation: 'instance.retry' | 'instance.reconcile' | 'instance.cancel'; failedStage?: string }) => SegmentInstance;
};
const terminalAttempts = new Set(['completed', 'skipped', 'cancelled']);

/** A synchronous deterministic state machine. Hooks may persist work, never await it. */
export class ExperienceRuntime {
  constructor(readonly persistence: ExperiencePersistence, private read: ReferenceReader, readonly hooks: RuntimeHooks = {}) {}

  private state(principal: RuntimePrincipal, runId: string): State {
    const actor = parse(RuntimePrincipal, { projectId: principal.projectId, uid: principal.uid });
    const run = parse(ExperienceRun, this.persistence.get<ExperienceRun>('runs', runId, actor).data);
    const release = parse(ScriptRelease, this.persistence.get<ScriptRelease>('releases', run.releaseId, { projectId: actor.projectId }).data);
    ensure(run.manifestHash === release.manifestHash && run.mode === release.kind, 'CONFLICT', '体验固定版本不匹配');
    return { principal: actor, scope: { ...actor, runId }, run, release };
  }
  private node(state: State, nodeId = state.run.currentNodeId): ScriptNode {
    const node = state.release.snapshot.nodes.find(n => n.id === nodeId);
    ensure(node, 'NOT_FOUND', '固定剧本节点不存在'); return node;
  }
  private visits(state: State) { return this.persistence.list<RuntimeVisit>('visits', state.scope); }
  private visit(state: State, id = state.run.currentVisitId) { return this.persistence.get<RuntimeVisit>('visits', id, state.scope); }
  private save<T>(collection: 'runs' | 'visits' | 'activities' | 'instances', row: ExperienceRow<T>, data: T) {
    return this.persistence.save(collection, row.id, row, row.seq, data);
  }
  private persistRun(state: State) {
    state.run.updatedAt = new Date().toISOString();
    const row = this.persistence.get<ExperienceRun>('runs', state.run.id, state.scope);
    this.save('runs', row, parse(ExperienceRun, state.run));
  }
  private event(state: State, type: string, body: unknown, commandId?: string) {
    state.run.historyCursor = this.persistence.append(state.scope, type, body, commandId);
  }
  private response(state: State, requestId: string, replayed = false, effects: CommittedEffect[] = [], acceptedInput?: unknown): RuntimeResponse {
    const status = state.run.status;
    return parse(RuntimeResponse, { requestId, replayed, stateSeq: state.run.stateSeq, status,
      currentNodeId: state.run.currentNodeId, waitReason: state.run.waitReason, effects,
      ...(acceptedInput !== undefined ? { acceptedInput } : {}),
      nextAction: status === 'completed' ? 'ending' : status === 'waitingInput' ? 'input' : status === 'waitingContent' ? 'wait' : status === 'blocked' ? 'blocked' : status === 'abandoned' ? 'none' : 'play' });
  }

  start(principal: RuntimePrincipal, input: RuntimeStart) {
    return this.persistence.transaction(() => this.startInternal(principal, input));
  }
  /** The author simulation command already owns the CommandBus transaction. */
  startInternal(principal: RuntimePrincipal, raw: RuntimeStart) {
    const actor = parse(RuntimePrincipal, principal), input = parse(RuntimeStart, raw);
    ensure(input.projectId === actor.projectId, 'FORBIDDEN', '启动项目不匹配');
    const previous = this.persistence.receipt<{ receipt: RuntimeResponse; runId: string }>(actor, input.requestId, input);
    if (previous) return { receipt: { ...previous.receipt, replayed: true }, view: this.view(actor, previous.runId) };
    const release = parse(ScriptRelease, this.persistence.get<ScriptRelease>('releases', input.releaseId, { projectId: actor.projectId }).data);
    ensure(release.kind === input.mode, 'FORBIDDEN', '模拟与真实播放不能互相转换');
    const id = randomUUID(), now = new Date().toISOString();
    const run = parse(ExperienceRun, { id, ...actor, releaseId: release.id, manifestHash: release.manifestHash, mode: input.mode,
      stateSeq: 1, currentNodeId: release.snapshot.entryNodeId, currentVisitId: randomUUID(), status: 'active',
      variables: initialVariables(release.snapshot.variables), historyCursor: 0, createdAt: now, updatedAt: now });
    this.persistence.create('runs', actor, run, id);
    const state: State = { principal: actor, scope: { ...actor, runId: id }, run, release };
    this.enter(state, run.currentNodeId, run.currentVisitId);
    this.event(state, 'run.started', { releaseId: release.id, mode: run.mode }, input.requestId);
    this.persistRun(state);
    const receipt = this.response(state, input.requestId);
    this.persistence.saveReceipt(actor, input.requestId, input, { receipt, runId: id });
    return { receipt, view: this.view(actor, id) };
  }

  private plannedVisit(state: State, nodeId: string, id: string = randomUUID()) {
    const existing = this.visits(state).find(row => row.data.nodeId === nodeId);
    if (existing) return existing;
    const data = parse(RuntimeVisit, { id, runId: state.run.id, nodeId, status: 'planned', ordinal: this.visits(state).length });
    return this.persistence.create('visits', state.scope, data, id);
  }
  private enter(state: State, nodeId: string, initialVisitId?: string) {
    for (let steps = 0; steps <= state.release.snapshot.nodes.length; steps++) {
      const node = this.node(state, nodeId);
      let row = this.plannedVisit(state, nodeId, initialVisitId); initialVisitId = undefined;
      ensure(row.data.status !== 'completed', 'CONFLICT', '首版剧情不能再次进入已完成节点');
      row = this.save('visits', row, { ...row.data, status: 'active', ordinal: this.visits(state).filter(v => v.data.status !== 'planned').length, enteredAt: row.data.enteredAt ?? new Date().toISOString() });
      state.run.currentNodeId = nodeId; state.run.currentVisitId = row.id; state.run.status = 'active'; state.run.waitReason = undefined;
      this.event(state, 'visit.entered', { visitId: row.id, nodeId });
      if (node.type === 'ending') { this.completeVisit(state, row.id); state.run.status = 'completed'; this.event(state, 'run.completed', { endingKey: node.endingKey }); return; }
      if (node.type === 'branch') {
        const selected = selectBranch(node, state.run.variables, state.release.snapshot.variables);
        this.completeVisit(state, row.id, selected.to);
        this.event(state, 'branch.selected', { visitId: row.id, caseId: selected.caseId, fallback: selected.fallback }); nodeId = selected.to; continue;
      }
      if (node.type === 'checkpoint') {
        if (!node.requires.every(condition => evaluateCondition(condition, state.run.variables, state.release.snapshot.variables))) {
          state.run.status = 'blocked'; state.run.waitReason = '尚未满足检查点前置条件'; return;
        }
        this.commit(state, row.id, node.id, 'checkpointReached', node.commitEffects);
        this.completeVisit(state, row.id, node.next); nodeId = node.next; continue;
      }
      if (node.type === 'activity') {
        const attempt = this.ensureAttempt(state, node, row);
        if (['completed', 'skipped'].includes(attempt.data.status)) {
          this.consumeActivity(state, row.id, attempt); nodeId = node.next; continue;
        }
        const activity = this.activityDefinition(state, node);
        if (!(activity.version === 1 && ['choice', 'text-intent'].includes(activity.type)) && (state.run.mode !== 'simulation' || !this.simulationFixtures(activity).length)) {
          state.run.status = 'blocked'; state.run.waitReason = '此活动类型尚未安装处理器'; return;
        }
        state.run.status = attempt.data.status === 'interpreting' ? 'waitingContent' : 'waitingInput'; return;
      }
      const instance = this.ensureInstance(state, node, row);
      if (instance.data.status === 'ready') { if (state.run.mode === 'simulation') this.openCue(state, 0); return; }
      this.setInstanceState(state, instance.data); return;
    }
    ensure(false, 'VALIDATION', '剧情路径超出有限节点范围');
  }
  private completeVisit(state: State, visitId: string, exitNodeId?: string) {
    const row = this.visit(state, visitId);
    this.save('visits', row, { ...row.data, status: 'completed', completedAt: new Date().toISOString(), exitNodeId });
  }
  private commit(state: State, visitId: string, sourceId: string, phase: CommitPhase, effects: Effect[], result?: Record<string, RuleValue>) {
    const visit = this.visit(state, visitId);
    if (visit.data.completedPhases.includes(phase)) return;
    let variables = state.run.variables;
    for (const effect of effects) {
      const next = applyEffects(state.release.snapshot.variables, variables, [effect], { sourceId, phase, result });
      const committed = parse(CommittedEffect, { id: randomUUID(), runId: state.run.id, visitId, sourceId, effectId: effect.id, phase,
        key: effect.key, before: variables[effect.key], after: next[effect.key], stateSeq: state.run.stateSeq });
      this.persistence.create('effects', state.scope, committed, committed.id);
      state.run.committedFacts.push(committed); variables = next;
    }
    state.run.variables = variables;
    this.save('visits', visit, { ...visit.data, completedPhases: [...visit.data.completedPhases, phase] });
  }
  private clearSegmentVariables(state: State, visitId: string, sourceId: string) {
    for (const definition of state.release.snapshot.variables.filter(v => v.scope === 'segment')) {
      const before = state.run.variables[definition.key];
      if (before === definition.initial) continue;
      const committed = parse(CommittedEffect, { id: randomUUID(), runId: state.run.id, visitId, sourceId, effectId: randomUUID(),
        phase: 'segmentCompleted', key: definition.key, before, after: definition.initial, stateSeq: state.run.stateSeq });
      this.persistence.create('effects', state.scope, committed, committed.id); state.run.committedFacts.push(committed);
      state.run.variables[definition.key] = definition.initial;
    }
  }

  private activityDefinition(state: State, node: ActivityNode) {
    const activity = state.release.snapshot.activities.find(a => a.id === node.activityId);
    ensure(activity, 'NOT_FOUND', '活动定义不存在'); return activity;
  }
  private ensureAttempt(state: State, node: ActivityNode, visit = this.plannedVisit(state, node.id)) {
    if (visit.data.attemptId) return this.persistence.get<ActivityAttempt>('activities', visit.data.attemptId, state.scope);
    const activity = this.activityDefinition(state, node), id = randomUUID();
    const data = parse(ActivityAttempt, { id, runId: state.run.id, visitId: visit.id, activityId: activity.id, descriptorVersion: activity.version, status: 'open' });
    const attempt = this.persistence.create('activities', state.scope, data, id);
    this.save('visits', visit, { ...visit.data, attemptId: id }); return attempt;
  }
  private consumeActivity(state: State, visitId: string, attempt: ExperienceRow<ActivityAttempt>) {
    ensure(['completed', 'skipped'].includes(attempt.data.status), 'CONFLICT', '活动尚未形成有效结果');
    if (!attempt.data.consumed) this.save('activities', attempt, { ...attempt.data, consumed: true });
    const node = this.node(state, this.visit(state, visitId).data.nodeId);
    ensure(node.type === 'activity', 'VALIDATION', '活动访问节点无效'); this.completeVisit(state, visitId, node.next);
  }
  private ensureInstance(state: State, node: SegmentNode, visit: ExperienceRow<RuntimeVisit>) {
    if (visit.data.instanceId) {
      const existing = this.persistence.get<SegmentInstance>('instances', visit.data.instanceId, state.scope);
      const expected = this.instanceInputHash(state, node);
      ensure(existing.data.inputHash === expected, 'CONFLICT', '预生成依赖已改变，不能复用旧实例');
      return existing;
    }
    const id = randomUUID(), inputHash = this.instanceInputHash(state, node);
    let data = parse(SegmentInstance, { id, runId: state.run.id, nodeId: node.id, visitId: visit.id, inputHash, releaseId: state.release.id,
      status: 'planned', sourceRefs: node.sourceSceneRefs, variableSnapshot: state.run.variables });
    let row = this.persistence.create('instances', state.scope, data, id);
    this.save('visits', visit, { ...visit.data, instanceId: id });
    let media: FixedMedia | undefined;
    if (node.contentSpec.mode === 'fixed') media = node.contentSpec.media;
    if (node.contentSpec.mode === 'template') {
      const variants = node.contentSpec.variants.filter(v => evaluateCondition(v.when, state.run.variables, state.release.snapshot.variables));
      ensure(variants.length <= 1, 'VALIDATION', '模板同时匹配多个媒体变体');
      const variant = variants[0];
      if (variant) {
        media = variant.media; data.outcomeId = variant.outcomeId;
        const text = node.contentSpec.text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => {
          ensure(node.contentSpec.mode === 'template' && node.contentSpec.reads.includes(key), 'VALIDATION', '模板读取未声明变量');
          return String(state.run.variables[key]);
        });
        data.templateResult = { text, contentHash: contentHash({ text, media }), media };
        data.resultRevision = 1;
      }
    }
    if (media) {
      data.playbackPlan = this.fixedPlan(state, node, id, media); data.mediaRefs = data.playbackPlan.bindings.map(b => b.artifactRef); data.status = 'ready';
    } else if (state.run.mode === 'simulation') data.status = 'ready';
    else if (this.hooks.prepare) data = parse(SegmentInstance, this.hooks.prepare({ ...state, node, visit: visit.data, instance: data }));
    else data.status = 'blocked';
    row = this.save('instances', row, data); return row;
  }
  private instanceInputHash(state: State, node: SegmentNode) {
    const reads = segmentVariableKeys(node);
    return contentHash({ release: state.release.manifestHash, nodeId: node.id, variables: Object.fromEntries(reads.map(key => [key, state.run.variables[key]])) });
  }
  private fixedPlan(state: State, node: SegmentNode, instanceId: string, media: FixedMedia) {
    const build = this.read(media.buildRef, state.principal.projectId).data;
    ensure(build.output, 'MEDIA_INVALID', '固定 Build 尚无媒体产物');
    const artifact = this.read(build.output, state.principal.projectId).data;
    ensure(artifact.mediaType === 'video/mp4' && artifact.sha256 === media.contentHash && build.snapshot.fps === media.fps,
      'MEDIA_INVALID', '固定片段媒体或时间基准变化');
    ensure(media.toFrame <= build.range.endFrame - build.range.startFrame && media.toFrame / media.fps <= artifact.durationSeconds + 1 / media.fps,
      'MEDIA_INVALID', '固定片段超出已生成范围');
    const id = mediaPlanId(media), bindingId = randomUUID(), durationFrames = media.toFrame - media.fromFrame;
    const cues = state.release.snapshot.cues.filter(cue => cue.segmentNodeId === node.id);
    for (const cue of cues) ensure(cue.resolvedBinding?.planId === id && cue.resolvedBinding.contentHash === media.contentHash && cue.resolvedBinding.fps === media.fps && cue.deadlineFrame <= durationFrames,
      'MEDIA_INVALID', '互动时码未绑定当前固定媒体');
    const base = { id, fps: media.fps, durationFrames, bindings: [{ id: bindingId, artifactRef: build.output as Ref, contentHash: media.contentHash,
      kind: 'video' as const, atFrame: 0, durationFrames, sourceInFrame: media.fromFrame, sourceFps: media.fps, nativeAudio: artifact.metadata?.hasAudio === true }], cues };
    const plan = parse(PlayableSegment, { ...base, planHash: contentHash(base) });
    this.persistence.create('mediaLinks', state.scope, { instanceId, bindingId, planHash: plan.planHash, artifactRef: build.output, sha256: media.contentHash, purpose: 'video' });
    return plan;
  }
  compileFixedInternal(scope: RunScope, instance: SegmentInstance, media: FixedMedia): PlayableSegment {
    const state = this.state(scope, scope.runId), node = this.node(state, instance.nodeId);
    ensure(node.type === 'segment' && instance.runId === scope.runId, 'VALIDATION', '固定媒体实例范围无效');
    return this.fixedPlan(state, node, instance.id, media);
  }

  private currentCue(state: State) {
    const node=this.node(state);
    if(state.run.mode==='simulation')return state.release.snapshot.cues.find(cue=>cue.segmentNodeId===node.id);
    const visit=this.visit(state);
    return visit.data.instanceId?this.persistence.get<SegmentInstance>('instances',visit.data.instanceId,state.scope).data.playbackPlan?.cues.find(cue=>cue.segmentNodeId===node.id):undefined;
  }
  private openCue(state: State, frame: number) {
    const node = this.node(state);
    if (node.type !== 'segment') return;
    const cue = this.currentCue(state);
    if (!cue || state.run.mode !== 'simulation' && (!cue.resolvedBinding || frame < cue.resolvedBinding.appearFrame)) return;
    const next = this.node(state, cue.activityNodeId);
    ensure(next.type === 'activity' && node.next === next.id, 'VALIDATION', '提前活动必须是片段直接后继');
    return { cue, attempt: this.ensureAttempt(state, next) };
  }
  private activeAttempt(state: State, attemptId: string, visitId: string) {
    const attempt = this.persistence.get<ActivityAttempt>('activities', attemptId, state.scope);
    ensure(attempt.data.visitId === visitId, 'CONFLICT', '活动访问不匹配');
    const visit = this.visit(state, visitId), node = this.node(state, visit.data.nodeId);
    ensure(node.type === 'activity', 'VALIDATION', '目标不是活动节点');
    if (visitId !== state.run.currentVisitId) {
      const current = this.node(state), cue = this.currentCue(state);
      ensure(current.type === 'segment' && current.next === node.id && cue?.activityNodeId === node.id && visit.data.status === 'planned', 'CONFLICT', '活动尚未开放');
    }
    return { attempt, visit, node, activity: this.activityDefinition(state, node) };
  }
  private commitAcceptedActivity(state: State, attempt: ExperienceRow<ActivityAttempt>, node: ActivityNode, activity: ActivityDefinition) {
    this.commit(state, attempt.data.visitId, node.id, 'activityAccepted', activity.resultMapping, attempt.data.result);
    this.event(state, 'activity.accepted', { visitId: attempt.data.visitId, attemptId: attempt.id, result: attempt.data.result });
    if (state.run.currentVisitId === attempt.data.visitId) { this.consumeActivity(state, attempt.data.visitId, attempt); this.enter(state, node.next); }
    else { state.run.status = 'active'; state.run.waitReason = undefined; this.prefetch(state, node); }
  }
  private prefetch(state: State, activityNode: ActivityNode) {
    if (state.release.policy.prefetchDepth !== 1 || state.run.mode !== 'playback' || !this.hooks.prepare) return;
    const current = this.node(state);
    if (current.type !== 'segment') return;
    // Runtime narration becomes prior content only after consumption. This also applies
    // to generated clips with an author-resolved Cue, not only to fixed template variants.
    if (current.contentSpec.mode !== 'fixed') return;
    const unstable = new Set(current.completionEffects.map(effect => effect.key).concat(state.release.snapshot.variables.filter(v => v.scope === 'segment').map(v => v.key)));
    let node = this.node(state, activityNode.next);
    for (let count = 0; count < state.release.snapshot.nodes.length; count++) {
      if (node.type === 'branch') {
        if (node.cases.some(c => conditionVariableKeys(c.when).some(key => unstable.has(key)))) return;
        node = this.node(state, selectBranch(node, state.run.variables, state.release.snapshot.variables).to); continue;
      }
      if (node.type !== 'segment' || node.contentSpec.mode === 'fixed') return;
      const reads = segmentVariableKeys(node);
      if (reads.some(key => unstable.has(key))) return;
      // Future narration cannot claim the still-playing segment has already happened.
      const visit = this.plannedVisit(state, node.id); this.ensureInstance(state, node, visit); return;
    }
  }
  private simulationFixtures(activity: ActivityDefinition): { id: string; label: string; result: Record<string, RuleValue> }[] {
    const value = (activity.config as Record<string, unknown>).simulationResults;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is { id: string; label: string; result: Record<string, RuleValue> } => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.label !== 'string' || !item.result || typeof item.result !== 'object' || Array.isArray(item.result)) return false;
      return Object.values(item.result).every(v => typeof v === 'string' || typeof v === 'boolean' || Number.isSafeInteger(v));
    });
  }

  private validateInterpretation(activity: ActivityDefinition, attempt: ActivityAttempt) {
    if (activity.type !== 'text-intent' || activity.version !== 1 || !attempt.interpretation) return;
    const definition = parse(TextIntentActivity, activity), interpretation = attempt.interpretation;
    const allowed = definition.config.intents.map(intent => intent.id);
    ensure(!interpretation.intentId || allowed.includes(interpretation.intentId), 'VALIDATION', '解释意图超出声明范围');
    ensure(interpretation.candidateIntentIds.every(id => allowed.includes(id)), 'VALIDATION', '解释候选意图超出声明范围');
    for (const [key, value] of Object.entries(interpretation.extractedValues)) {
      const field = definition.config.extractedFields.find(f => f.key === key);
      ensure(field && key !== 'intentId', 'VALIDATION', '解释包含未声明或保留字段');
      const valid = field.type === 'text' ? typeof value === 'string' && value.length <= field.maxLength
        : field.type === 'integer' ? Number.isSafeInteger(value) && Number(value) >= field.min && Number(value) <= field.max
        : field.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && field.values.includes(value);
      ensure(valid, 'VALIDATION', `解释字段 ${key} 类型或范围无效`);
    }
  }

  private activityCapabilities(state: State, node: ActivityNode, attempt: ActivityAttempt, activity: ActivityDefinition) {
    const dispatches = this.persistence.list<{ ownerKey: string; state: string }>('dispatches', state.scope).filter(row => row.data.ownerKey === `activity:${attempt.id}`);
    const unknown = dispatches.some(row => row.data.state === 'unknown');
    const pending = dispatches.some(row => ['queued', 'dispatched', 'unknown'].includes(row.data.state));
    const ended = ['completed', 'abandoned'].includes(state.run.status);
    const recovery = unknown && !ended ? this.hooks.activityRecovery?.({ ...state, node, attempt, activity, input: attempt.input }) : undefined;
    const calls = Math.max(attempt.executionIds.length, dispatches.length);
    return {
      canSkip: !ended && !terminalAttempts.has(attempt.status) && activity.skipPolicy.mode === 'allowed',
      canRetry: !ended && attempt.status === 'failed' && !pending && !!this.hooks.activity && activity.retryPolicy.maxAttempts >= calls && activity.retryPolicy.maxAttempts > 0 && this.persistence.usage(state.scope).runText < state.release.policy.maxTextCallsPerRun,
      canReconcile: !ended && !terminalAttempts.has(attempt.status) && unknown && !!this.hooks.reconcileActivity && recovery?.canReconcile === true,
      recoveryState: unknown ? 'unknown' as const : 'none' as const,
      ...(unknown ? { recoveryReason: ended ? '本次体验已结束，不能继续解释输入' : recovery?.recoveryReason ?? attempt.recoveryReason ?? '原解释结果未知；当前执行器未提供原请求核对' } : attempt.recoveryReason ? { recoveryReason: attempt.recoveryReason } : {}),
    };
  }

  private setInstanceState(state: State, instance: SegmentInstance) {
    state.run.status = instance.status === 'ready' ? 'active' : ['blocked', 'unknown', 'cancelled', 'stale'].includes(instance.status) ? 'blocked' : 'waitingContent';
    const reasons: Partial<Record<SegmentInstance['status'], string>> = { writing: '正在准备本次片段正文', checking: '正在检查本次片段内容', producing: '正在生成本次片段媒体', waitingReview: '等待作者确认本次生成内容', unknown: '等待原任务核对', cancelled: '当前片段已取消' };
    state.run.waitReason = instance.status === 'ready' ? undefined : instance.cancelRequested && instance.recoveryReason ? instance.recoveryReason : ['writing', 'checking', 'producing', 'waitingReview'].includes(instance.status) ? reasons[instance.status] : instance.recoveryReason ?? reasons[instance.status] ?? '等待本次片段内容';
  }

  execute(principal: RuntimePrincipal, raw: RuntimeCommand) {
    const input = parse(RuntimeCommand, raw);
    return this.persistence.transaction(() => {
      const state = this.state(principal, input.runId);
      const existing = this.persistence.receipt<RuntimeResponse>(state.scope, input.requestId, input);
      if (existing) return { receipt: { ...existing, replayed: true }, view: this.view(principal, input.runId) };
      if (input.operation.startsWith('activity.')) ensure(state.run.status !== 'abandoned', 'CONFLICT', '本次体验已结束');
      const priorFacts = state.run.committedFacts.length;
      let duplicate = false;
      if (input.operation.startsWith('activity.')) {
        const payload = input.payload as { attemptId: string; input?: unknown };
        const attempt = this.persistence.get<ActivityAttempt>('activities', payload.attemptId, state.scope);
        ensure(attempt.data.visitId === input.visitId, 'CONFLICT', '活动访问不匹配');
        if (terminalAttempts.has(attempt.data.status)) {
          duplicate = input.operation === 'activity.submit' && attempt.data.status === 'completed' && stable(attempt.data.input) === stable(payload.input)
            || input.operation === 'activity.skip' && attempt.data.status === 'skipped'
            || input.operation === 'activity.confirmIntent' && attempt.data.status === 'completed' && attempt.data.interpretationRef === input.payload.interpretationRef && attempt.data.result?.intentId === input.payload.intentId;
          ensure(duplicate, 'CONFLICT', '活动已结束，不能覆盖原结果');
        }
      } else if (input.operation === 'segment.complete') {
        const instance = this.persistence.get<SegmentInstance>('instances', input.payload.instanceId, state.scope);
        ensure(instance.data.visitId === input.visitId, 'CONFLICT', '片段访问不匹配');
        this.assertCompletion(instance.data, input.payload.planHash, input.payload.frame, state.run.mode);
        duplicate = instance.data.status === 'consumed';
      } else if (input.operation === 'run.abandon') duplicate = state.run.status === 'abandoned';
      if (!duplicate) {
        ensure(state.run.stateSeq === input.expectedStateSeq, 'CONFLICT', '剧情状态已更新，请刷新后重试');
        ensure(!['completed', 'abandoned'].includes(state.run.status), 'CONFLICT', '本次体验已结束');
        state.run.stateSeq += 1;
        this.applyCommand(state, input);
        this.event(state, input.operation, { visitId: input.visitId }, input.requestId);
        this.persistRun(state);
      }
      const receipt = this.response(state, input.requestId, duplicate, state.run.committedFacts.slice(priorFacts));
      this.persistence.saveReceipt(state.scope, input.requestId, input, receipt);
      return { receipt, view: this.view(principal, input.runId) };
    });
  }
  private assertCompletion(instance: SegmentInstance, planHash: string, frame: number, mode: string) {
    const plan = instance.playbackPlan;
    ensure(planHash === (plan?.planHash ?? instance.inputHash), 'CONFLICT', '播放计划已变化');
    if (plan) ensure(frame >= plan.durationFrames && frame <= plan.durationFrames + 1, 'VALIDATION', '尚未到达片段结尾');
    else ensure(mode === 'simulation' && frame === 0, 'MEDIA_INVALID', '片段尚未准备好');
  }
  private applyCommand(state: State, input: RuntimeCommand) {
    if (input.operation === 'run.abandon') { ensure(input.visitId === state.run.currentVisitId, 'CONFLICT', '当前访问已变化'); state.run.status = 'abandoned'; state.run.waitReason = input.payload.reason; return; }
    if (input.operation === 'segment.complete') {
      ensure(input.visitId === state.run.currentVisitId, 'CONFLICT', '不是当前播放片段');
      const node = this.node(state); ensure(node.type === 'segment', 'VALIDATION', '当前节点不是片段');
      const instance = this.persistence.get<SegmentInstance>('instances', input.payload.instanceId, state.scope);
      ensure(instance.data.status === 'ready', 'CONFLICT', '片段尚未就绪');
      const cue = this.openCue(state, input.payload.frame);
      if (cue && !['completed', 'skipped'].includes(cue.attempt.data.status)) { state.run.status = 'waitingInput'; state.run.waitReason = '请先完成当前互动'; return; }
      const contract = node.contentSpec.mode === 'fixed' ? undefined : node.contentSpec.generationContract;
      const outcome = contract?.outcomes.find(value => value.id === instance.data.outcomeId);
      this.commit(state, input.visitId, node.id, 'segmentCompleted', [...node.completionEffects, ...(outcome?.completionEffects ?? [])]);
      if (outcome) ensure(outcome.postconditions.every(condition => evaluateCondition(condition, state.run.variables, state.release.snapshot.variables)), 'CONFLICT', '片段完成效果不满足固定结果要求');
      this.clearSegmentVariables(state, input.visitId, node.id);
      this.save('instances', instance, { ...instance.data, status: 'consumed' });
      this.completeVisit(state, input.visitId, node.next); this.enter(state, node.next); return;
    }
    if (input.operation === 'instance.retry' || input.operation === 'instance.reconcile' || input.operation === 'instance.cancel') {
      const instance = this.persistence.get<SegmentInstance>('instances', input.payload.instanceId, state.scope);
      ensure(instance.data.visitId === input.visitId, 'CONFLICT', '实例访问不匹配');
      ensure(!['ready', 'consumed', 'cancelled', 'stale'].includes(instance.data.status), 'CONFLICT', '此实例不能继续执行或更换内容');
      const node = this.node(state, instance.data.nodeId); ensure(node.type === 'segment', 'VALIDATION', '实例节点不匹配');
      if (input.operation === 'instance.retry') ensure(instance.data.status === 'blocked', 'CONFLICT', '未知结果必须核对原任务，不能重新派发');
      if (input.operation === 'instance.reconcile') ensure(instance.data.status === 'unknown', 'CONFLICT', '只有未知实例可核对原任务');
      let data: SegmentInstance;
      if (this.hooks.instanceCommand) data = this.hooks.instanceCommand({ ...state, node, visit: this.visit(state, input.visitId).data, instance: instance.data, operation: input.operation, ...('failedStage' in input.payload ? { failedStage: input.payload.failedStage } : {}) });
      else { ensure(input.operation === 'instance.cancel', 'UNSUPPORTED', '此实例尚未接入执行处理器'); data = { ...instance.data, status: 'cancelled' }; }
      this.save('instances', instance, parse(SegmentInstance, data)); this.setInstanceState(state, data); return;
    }
    const active = this.activeAttempt(state, input.payload.attemptId, input.visitId);
    const { attempt, node, activity } = active;
    ensure(!terminalAttempts.has(attempt.data.status), 'CONFLICT', '活动已结束');
    let data: ActivityAttempt;
    if (input.operation === 'activity.reconcile') {
      const capability = this.activityCapabilities(state, node, attempt.data, activity);
      ensure(capability.recoveryState === 'unknown', 'CONFLICT', '只有未知的原解释可以核对');
      ensure(capability.canReconcile && this.hooks.reconcileActivity, 'UNSUPPORTED', capability.recoveryReason ?? '当前执行器不支持原解释核对');
      data = this.hooks.reconcileActivity({ ...state, node, attempt: attempt.data, activity, input: attempt.data.input });
    } else if (input.operation === 'activity.skip') {
      ensure(activity.skipPolicy.mode === 'allowed', 'FORBIDDEN', '此活动不允许跳过');
      data = { ...attempt.data, status: 'skipped', result: activity.skipPolicy.result };
    } else if (input.operation === 'activity.submit') {
      ensure(attempt.data.status === 'open', 'CONFLICT', '当前输入已提交，请等待解释或明确重试');
      if (activity.type === 'choice' && activity.version === 1) {
        const definition = parse(ChoiceActivity, activity), value = parse(ChoiceInput, input.payload.input);
        ensure(definition.config.options.some(option => option.id === value.optionId), 'VALIDATION', '选择不在当前活动选项内');
        data = { ...attempt.data, status: 'completed', input: value, result: value };
      } else if (state.run.mode === 'simulation') {
        ensure(typeof input.payload.input === 'object' && input.payload.input !== null && !Array.isArray(input.payload.input), 'VALIDATION', '模拟结果需要对象');
        let result = input.payload.input as Record<string, RuleValue>;
        for (const value of Object.values(result)) ensure(typeof value === 'string' || typeof value === 'boolean' || Number.isSafeInteger(value), 'VALIDATION', '模拟结果只接受简单字段');
        if (activity.type === 'text-intent' && activity.version === 1) {
          const definition = parse(TextIntentActivity, activity);
          ensure(definition.config.intents.some(i => i.id === result.intentId), 'VALIDATION', '模拟意图不在声明列表内');
        } else {
          const fixture = this.simulationFixtures(activity).find(f => f.id === result.fixtureId);
          ensure(fixture && Object.keys(result).length === 1, 'VALIDATION', '只能提交已声明的活动模拟夹具'); result = fixture.result;
        }
        data = { ...attempt.data, status: 'completed', input: input.payload.input, result };
      } else {
        ensure(activity.type === 'text-intent' && activity.version === 1, 'UNSUPPORTED', '此活动版本尚未安装处理器');
        const definition = parse(TextIntentActivity, activity), value = parse(TextIntentInput, input.payload.input);
        ensure(value.text.length <= definition.config.maxLength, 'VALIDATION', '输入超过当前活动长度上限');
        ensure(this.hooks.activity, 'UNSUPPORTED', '运行文字解释尚未配置');
        data = this.hooks.activity({ ...state, node, attempt: attempt.data, activity, input: value });
      }
    } else if (input.operation === 'activity.confirmIntent') {
      ensure(attempt.data.status === 'needsConfirmation' && attempt.data.interpretationRef === input.payload.interpretationRef && attempt.data.interpretation, 'CONFLICT', '解释版本已变化');
      const definition = parse(TextIntentActivity, activity);
      ensure(definition.config.intents.some(i => i.id === input.payload.intentId), 'VALIDATION', '意图不在声明列表内');
      const interpretation = attempt.data.interpretation;
      this.validateInterpretation(activity, attempt.data);
      ensure(interpretation.candidateIntentIds.includes(input.payload.intentId) || interpretation.intentId === input.payload.intentId, 'VALIDATION', '请确认解释提供的意图');
      data = { ...attempt.data, status: 'completed', result: { ...interpretation.extractedValues, intentId: input.payload.intentId } };
    } else {
      const capability = this.activityCapabilities(state, node, attempt.data, activity);
      ensure(capability.recoveryState !== 'unknown', 'UNKNOWN_OUTCOME', '原解释结果未知，只能核对原任务');
      ensure(capability.canRetry, 'FORBIDDEN', '此活动不能继续重试：原任务未结束或次数预算已用完');
      ensure(this.hooks.activity && attempt.data.input, 'UNSUPPORTED', '没有可重试的原始输入');
      data = this.hooks.activity({ ...state, node, attempt: attempt.data, activity, input: attempt.data.input });
    }
    const saved = this.save('activities', attempt, parse(ActivityAttempt, data));
    if (['completed', 'skipped'].includes(saved.data.status)) this.commitAcceptedActivity(state, saved, node, activity);
    else if (state.run.currentVisitId === saved.data.visitId) state.run.status = saved.data.status === 'interpreting' ? 'waitingContent' : 'waitingInput';
  }

  positionSave(principal: RuntimePrincipal, raw: PositionSave) {
    const input = parse(PositionSave, raw);
    return this.persistence.transaction(() => {
      const state = this.state(principal, input.runId), receiptInput = { operation: 'position.save', ...input };
      const previous = this.persistence.receipt<{ position: RuntimeView['position'] }>(state.scope, input.requestId, receiptInput);
      if (previous) return { ...previous, replayed: true, view: this.view(principal, input.runId) };
      const visit = this.visit(state, input.visitId);
      ensure(visit.data.status !== 'planned' && visit.data.instanceId, 'FORBIDDEN', '该片段尚未开放');
      const instance = this.persistence.get<SegmentInstance>('instances', visit.data.instanceId, state.scope), plan = instance.data.playbackPlan;
      ensure(plan && plan.planHash === input.planHash && input.frame <= plan.durationFrames, 'CONFLICT', '播放计划或位置不匹配');
      const existing = this.persistence.list<{ visitId: string; planHash: string; frame: number; positionSeq: number }>('positions', state.scope).find(p => p.data.visitId === visit.id);
      ensure((existing?.data.positionSeq ?? 0) === input.expectedPositionSeq, 'CONFLICT', '播放位置已更新');
      let frame = input.frame;
      if (visit.id === state.run.currentVisitId) {
        const cue = this.openCue(state, frame);
        if (cue && !['completed', 'skipped'].includes(cue.attempt.data.status)) frame = Math.min(frame, cue.cue.deadlineFrame);
      }
      const position = { visitId: visit.id, planHash: plan.planHash, frame, positionSeq: input.expectedPositionSeq + 1 };
      if (existing) this.persistence.save('positions', existing.id, state.scope, existing.seq, position);
      else this.persistence.create('positions', state.scope, position);
      this.persistence.saveReceipt(state.scope, input.requestId, receiptInput, { position });
      return { position, replayed: false, view: this.view(principal, input.runId) };
    });
  }

  view(principal: RuntimePrincipal, runId: string): RuntimeView {
    const state = this.state(principal, runId), node = this.node(state), visit = this.visit(state);
    let attempt = visit.data.attemptId ? this.persistence.get<ActivityAttempt>('activities', visit.data.attemptId, state.scope).data : undefined;
    if (!attempt && node.type === 'segment') {
      const cue = this.currentCue(state);
      const early = cue && this.visits(state).find(v => v.data.nodeId === cue.activityNodeId);
      if (early?.data.attemptId) attempt = this.persistence.get<ActivityAttempt>('activities', early.data.attemptId, state.scope).data;
    }
    const instance = visit.data.instanceId ? this.persistence.get<SegmentInstance>('instances', visit.data.instanceId, state.scope).data : undefined;
    const definition = attempt && state.release.snapshot.activities.find(a => a.id === attempt.activityId);
    let activity: RuntimeView['activity'];
    if (definition) {
      const choice = ChoiceActivity.safeParse(definition), text = TextIntentActivity.safeParse(definition);
      const activityNode = this.node(state, this.visit(state, attempt!.visitId).data.nodeId);
      ensure(activityNode.type === 'activity', 'VALIDATION', '活动访问节点无效');
      activity = { id: definition.id, type: definition.type, version: definition.version, label: definition.label, prompt: definition.presentation.prompt,
        options: choice.success ? choice.data.config.options : text.success ? text.data.config.intents.filter(i => state.run.mode === 'simulation' || attempt?.interpretation?.candidateIntentIds.includes(i.id) || attempt?.interpretation?.intentId === i.id).map(i => ({ id: i.id, label: i.label })) : state.run.mode === 'simulation' ? this.simulationFixtures(definition).map(f => ({ id: f.id, label: f.label })) : [],
        ...(text.success ? { maxLength: text.data.config.maxLength } : {}), ...this.activityCapabilities(state, activityNode, attempt!, definition) };
    }
    const position = this.persistence.list<NonNullable<RuntimeView['position']>>('positions', state.scope).find(p => p.data.visitId === visit.id)?.data;
    return parse(RuntimeView, { run: state.run, node: { id: node.id, type: node.type, title: node.title, ...(node.type === 'ending' ? { summary: node.summary } : {}) },
      ...(attempt ? { attempt } : {}), ...(activity ? { activity } : {}), ...(instance ? { instance: { id: instance.id, status: instance.status, inputHash: instance.inputHash, cancelRequested: instance.cancelRequested,
        ...(instance.checks.some(c => c.status === 'failed' && ['structure', 'content', 'media'].includes(c.stage)) ? { failedStage: instance.checks.some(c => c.status === 'failed' && c.stage === 'media') ? 'producing' : instance.checks.some(c => c.status === 'failed' && c.stage === 'content') ? 'checking' : 'writing' } : {}) } } : {}),
      ...(instance?.playbackPlan && ['ready', 'consumed'].includes(instance.status) ? { playback: instance.playbackPlan } : {}), ...(position ? { position } : {}) });
  }
  runs(principal: RuntimePrincipal) {
    const actor = parse(RuntimePrincipal, principal);
    return this.persistence.list<ExperienceRun>('runs', actor).map(row => {
      const { run, release } = this.state(actor, row.id);
      return { ...run, title: release.snapshot.title };
    });
  }
  private traceVisit(state: State, visit: RuntimeVisit) {
    const node = this.node(state, visit.nodeId);
    const attempt = visit.attemptId ? this.persistence.get<ActivityAttempt>('activities', visit.attemptId, state.scope).data : undefined;
    const definition = node.type === 'activity' && state.release.snapshot.activities.find(item => item.id === node.activityId);
    const resultLabel = definition && attempt && (attempt.consumed || visit.completedPhases.includes('activityAccepted')) ? activityResultLabel(definition, attempt) : undefined;
    return { ...visit, title: node.title, ...(resultLabel ? { resultLabel } : {}) };
  }
  trace(principal: RuntimePrincipal, runId: string) {
    const state = this.state(principal, runId);
    return { visits: this.visits(state).filter(v => v.data.status !== 'planned').map(v => this.traceVisit(state, v.data)).sort((a, b) => a.ordinal - b.ordinal), events: this.persistence.events(state.scope, 0) };
  }
  /** Viewer pages freeze their upper ordinal, so later progress cannot leak into an existing traversal. */
  tracePage(principal: RuntimePrincipal, runId: string, raw: unknown = {}): RuntimeTracePage {
    const query = parse(RuntimeTraceQuery, raw), state = this.state(principal, runId);
    const scopeHash = contentHash(state.scope), all = this.visits(state).filter(row => row.data.status !== 'planned').map(row => row.data).sort((a, b) => a.ordinal - b.ordinal);
    let afterOrdinal = -1, snapshotOrdinal = all.at(-1)?.ordinal ?? -1;
    if (query.cursor) {
      let cursor: any;
      try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { ensure(false, 'VALIDATION', '体验轨迹游标无效'); }
      ensure(cursor && typeof cursor === 'object' && !Array.isArray(cursor) && Object.keys(cursor).length === 4 && cursor.version === 1 &&
        Number.isSafeInteger(cursor.afterOrdinal) && Number.isSafeInteger(cursor.snapshotOrdinal) && cursor.afterOrdinal >= 0 && cursor.afterOrdinal < cursor.snapshotOrdinal,
      'VALIDATION', '体验轨迹游标无效');
      ensure(cursor.scopeHash === scopeHash, 'FORBIDDEN', '体验轨迹游标不属于当前项目、档案与体验');
      ensure(cursor.snapshotOrdinal <= snapshotOrdinal && all.some(visit => visit.ordinal === cursor.afterOrdinal) && all.some(visit => visit.ordinal === cursor.snapshotOrdinal),
        'VALIDATION', '体验轨迹游标不属于已开放的路线');
      afterOrdinal = cursor.afterOrdinal; snapshotOrdinal = cursor.snapshotOrdinal;
    }
    const visible = all.filter(visit => visit.ordinal <= snapshotOrdinal), offset = visible.filter(visit => visit.ordinal <= afterOrdinal).length;
    const visits = visible.slice(offset, offset + query.limit).map(visit => this.traceVisit(state, visit));
    const hasMore = offset + visits.length < visible.length;
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ version: 1, scopeHash, afterOrdinal: visits.at(-1)!.ordinal, snapshotOrdinal })).toString('base64url') : null;
    return parse(RuntimeTracePage, { visits, contentPage: { offset, limit: query.limit, total: visible.length, snapshotOrdinal, partial: offset > 0 || hasMore, nextCursor } });
  }
  events(principal: RuntimePrincipal, runId: string, after: number) { const state = this.state(principal, runId); return this.persistence.events(state.scope, after); }
  instance(principal: RuntimePrincipal, runId: string, instanceId: string) {
    const state = this.state(principal, runId), row = this.persistence.get<SegmentInstance>('instances', instanceId, state.scope);
    ensure(this.visit(state, row.data.visitId).data.status !== 'planned', 'FORBIDDEN', '该实例尚未开放');
    return row.data;
  }
  activity(principal: RuntimePrincipal, runId: string, attemptId: string) {
    const state = this.state(principal, runId); return this.persistence.get<ActivityAttempt>('activities', attemptId, state.scope).data;
  }
  media(principal: RuntimePrincipal, runId: string, planHash: string, bindingId: string) {
    const state = this.state(principal, runId);
    const link = this.persistence.list<{ instanceId: string; bindingId: string; planHash: string; artifactRef: Ref; sha256: string }>('mediaLinks', state.scope)
      .find(row => row.data.bindingId === bindingId && row.data.planHash === planHash);
    ensure(link, 'NOT_FOUND', '此体验未授权访问该媒体');
    const instance = this.instance(principal, runId, link.data.instanceId);
    ensure(['ready', 'consumed'].includes(instance.status) && instance.playbackPlan?.planHash === planHash, 'FORBIDDEN', '此播放计划尚未开放');
    const binding = instance.playbackPlan.bindings.find(b => b.id === bindingId);
    ensure(binding && stable(binding.artifactRef) === stable(link.data.artifactRef), 'MEDIA_INVALID', '媒体绑定不匹配');
    const artifact = this.read(binding.artifactRef, principal.projectId);
    ensure(artifact.data.sha256 === binding.contentHash && artifact.data.sha256 === link.data.sha256, 'MEDIA_INVALID', '绑定媒体内容已变化'); return artifact;
  }
  receipt(principal: RuntimePrincipal, raw: RuntimeCommand | RuntimeStart | PositionSave) {
    const actor = parse(RuntimePrincipal, principal);
    if ('operation' in raw) { const input = parse(RuntimeCommand, raw); const state = this.state(actor, input.runId); return this.persistence.receipt<RuntimeResponse>(state.scope, input.requestId, input); }
    if ('releaseId' in raw) { const input = parse(RuntimeStart, raw); ensure(input.projectId === actor.projectId, 'FORBIDDEN', '请求项目不匹配'); return this.persistence.receipt(actor, input.requestId, input); }
    const input = parse(PositionSave, raw), state = this.state(actor, input.runId);
    return this.persistence.receipt(state.scope, input.requestId, { operation: 'position.save', ...input });
  }

  acceptPrepared(scope: RunScope, instance: SegmentInstance) {
    return this.persistence.transaction(() => this.acceptPreparedInternal(scope, instance));
  }
  acceptPreparedInternal(scope: RunScope, raw: SegmentInstance) {
    const state = this.state(scope, scope.runId), instance = parse(SegmentInstance, raw);
    const current = this.persistence.get<SegmentInstance>('instances', instance.id, scope);
    ensure(instance.runId === scope.runId && instance.inputHash === current.data.inputHash && instance.releaseId === state.release.id,
      'CONFLICT', '异步结果不属于原实例输入');
    if (['ready', 'consumed', 'cancelled', 'stale'].includes(current.data.status)) return this.view(scope, scope.runId);
    this.save('instances', current, state.run.status === 'abandoned' ? { ...current.data, status: 'cancelled' } : instance);
    return this.refreshInternal(scope, scope.runId);
  }
  acceptActivity(scope: RunScope, attempt: ActivityAttempt) {
    return this.persistence.transaction(() => this.acceptActivityInternal(scope, attempt));
  }
  acceptActivityInternal(scope: RunScope, raw: ActivityAttempt) {
    const state = this.state(scope, scope.runId), attempt = parse(ActivityAttempt, raw);
    const current = this.persistence.get<ActivityAttempt>('activities', attempt.id, scope);
    ensure(attempt.runId === scope.runId && current.data.visitId === attempt.visitId && current.data.activityId === attempt.activityId,
      'CONFLICT', '异步结果不属于原活动输入');
    if (terminalAttempts.has(current.data.status) || state.run.status === 'abandoned') return this.view(scope, scope.runId);
    const node = this.node(state, this.visit(state, attempt.visitId).data.nodeId);
    ensure(node.type === 'activity', 'VALIDATION', '解释所属活动无效');
    this.validateInterpretation(this.activityDefinition(state, node), attempt);
    this.save('activities', current, attempt);
    return this.refreshInternal(scope, scope.runId);
  }

  /** Generation callbacks call this after persisting an original dispatch result. */
  refresh(principal: RuntimePrincipal, runId: string) {
    return this.persistence.transaction(() => this.refreshInternal(principal, runId));
  }
  refreshInternal(principal: RuntimePrincipal, runId: string) {
    const state = this.state(principal, runId);
    if (['completed', 'abandoned'].includes(state.run.status)) return this.view(principal, runId);
    const node = this.node(state), visit = this.visit(state);
    state.run.stateSeq += 1;
    if (node.type === 'activity' && visit.data.attemptId) {
      const attempt = this.persistence.get<ActivityAttempt>('activities', visit.data.attemptId, state.scope);
      if (['completed', 'skipped'].includes(attempt.data.status)) this.commitAcceptedActivity(state, attempt, node, this.activityDefinition(state, node));
      else state.run.status = attempt.data.status === 'interpreting' ? 'waitingContent' : 'waitingInput';
    } else if (node.type === 'segment' && visit.data.instanceId) {
      const instance = this.persistence.get<SegmentInstance>('instances', visit.data.instanceId, state.scope);
      this.setInstanceState(state, instance.data);
      const cue = this.currentCue(state), planned = cue && this.visits(state).find(v => v.data.nodeId === cue.activityNodeId);
      if (planned?.data.attemptId) {
        const attempt = this.persistence.get<ActivityAttempt>('activities', planned.data.attemptId, state.scope);
        const activityNode = this.node(state, planned.data.nodeId);
        if (activityNode.type === 'activity' && ['completed', 'skipped'].includes(attempt.data.status) && !planned.data.completedPhases.includes('activityAccepted')) this.commitAcceptedActivity(state, attempt, activityNode, this.activityDefinition(state, activityNode));
      }
    }
    this.event(state, 'run.refreshed', { visitId: state.run.currentVisitId }); this.persistRun(state); return this.view(principal, runId);
  }
}
