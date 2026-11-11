import { z } from 'zod';
import { Id, Ref } from './foundation.ts';
import { ScriptBlock } from './creative.ts';
import { ScriptPlanData, ScriptPolicy, FixedMedia } from './interactive-script.ts';
import { RuleValue, VariableKey, CommitPhase, InteractionCue, ActivityAttempt } from './activities.ts';
import { ProviderPrompts, VideoFrameReference } from './production-input.ts';

export const ContentHash = z.string().regex(/^[a-f0-9]{64}$/);
export const Uid = z.string().trim().min(1).max(80);
export const RuntimePrincipal = z.strictObject({ projectId: Id, uid: Uid });
export type RuntimePrincipal = z.infer<typeof RuntimePrincipal>;
export const ExperienceMode = z.enum(['simulation', 'playback']);
export const GenerationAuthorization = z.strictObject({ policyHash: ContentHash, confirmedAt: z.string().datetime(), source: z.literal('human'), textConfigurationFingerprint: ContentHash.optional() });
export const ScriptRelease = z.strictObject({
  id: Id, projectId: Id, scriptRef: Ref, schemaVersion: z.literal(1), kind: ExperienceMode,
  manifestHash: ContentHash, snapshot: ScriptPlanData, dependencyRefs: z.array(Ref).max(20000),
  activityVersions: z.array(z.strictObject({ type: z.string().min(1).max(80), version: z.number().int().positive() })).max(200),
  policy: ScriptPolicy, generationAuthorization: GenerationAuthorization.optional(),
  createdAt: z.string().datetime(), publishedAt: z.string().datetime().optional(),
});
export type ScriptRelease = z.infer<typeof ScriptRelease>;
export const RuntimeContentRef = z.strictObject({ runId: Id, instanceId: Id, resultRevision: z.number().int().positive(), contentHash: ContentHash });
export type RuntimeContentRef = z.infer<typeof RuntimeContentRef>;
export const RuntimeContextSnapshot = z.strictObject({
  sourceRefs: z.array(Ref).max(1000), priorInstanceRefs: z.array(RuntimeContentRef).max(1000),
  variableSnapshot: z.record(VariableKey, RuleValue), committedEffectIds: z.array(Id).max(10000),
  completeness: z.enum(['complete', 'incomplete']),
  summary: z.strictObject({ text: z.string().max(12000), sourceHashes: z.array(ContentHash).max(1000) }).optional(),
});
export type RuntimeContextSnapshot = z.infer<typeof RuntimeContextSnapshot>;
export const CommittedEffect = z.strictObject({
  id: Id, runId: Id, visitId: Id, sourceId: Id, effectId: Id, phase: CommitPhase,
  key: VariableKey, before: RuleValue, after: RuleValue, stateSeq: z.number().int().positive(),
});
export type CommittedEffect = z.infer<typeof CommittedEffect>;
export const ExperienceStatus = z.enum(['active', 'waitingInput', 'waitingContent', 'blocked', 'completed', 'abandoned']);
export const ExperienceRun = z.strictObject({
  id: Id, projectId: Id, uid: Uid, releaseId: Id, manifestHash: ContentHash, mode: ExperienceMode,
  stateSeq: z.number().int().positive(), currentNodeId: Id, currentVisitId: Id, status: ExperienceStatus,
  variables: z.record(VariableKey, RuleValue), committedFacts: z.array(CommittedEffect).default([]), historyCursor: z.number().int().nonnegative(),
  waitReason: z.string().max(2000).optional(), recoveryReason: z.string().max(2000).optional(), restoreBlocked: z.boolean().optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type ExperienceRun = z.infer<typeof ExperienceRun>;
export const RuntimeVisit = z.strictObject({
  id: Id, runId: Id, nodeId: Id, status: z.enum(['planned', 'active', 'completed']),
  ordinal: z.number().int().nonnegative(), attemptId: Id.optional(), instanceId: Id.optional(),
  completedPhases: z.array(CommitPhase).max(3).default([]), exitNodeId: Id.optional(),
  enteredAt: z.string().datetime().optional(), completedAt: z.string().datetime().optional(),
});
export type RuntimeVisit = z.infer<typeof RuntimeVisit>;
export const RuntimeTraceQuery = z.strictObject({ cursor: z.string().min(1).max(300).optional(), limit: z.number().int().min(1).max(100).default(50) });
export type RuntimeTraceQuery = z.infer<typeof RuntimeTraceQuery>;
export const RuntimeTracePage = z.strictObject({
  visits: z.array(RuntimeVisit.extend({ title: z.string(), resultLabel: z.string().max(200).optional() })).max(100),
  contentPage: z.strictObject({ offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), total: z.number().int().nonnegative(),
    snapshotOrdinal: z.number().int().min(-1), partial: z.boolean(), nextCursor: z.string().max(300).nullable() }),
});
export type RuntimeTracePage = z.infer<typeof RuntimeTracePage>;
export const SegmentScriptV1 = z.strictObject({
  schemaVersion: z.literal(1), instanceId: Id, inputHash: ContentHash, outcomeId: VariableKey,
  timelineFps: z.number().int().min(1).max(60), chapterTitle: z.string().max(160).optional(),
  scenes: z.array(z.strictObject({ id: Id, title: z.string().min(1).max(160), location: z.string().max(300), time: z.string().max(300), blocks: z.array(ScriptBlock).min(1).max(500) })).min(1).max(20),
  sourceRefs: z.array(Ref).max(1000), usedVariables: z.array(VariableKey).max(64),
  assertedFacts: z.array(z.strictObject({ key: VariableKey, value: RuleValue, evidenceBlockIds: z.array(Id).min(1).max(100) })).max(100),
  shotPlan: z.array(z.strictObject({ id: Id, sceneId: Id, goal: z.string().max(2000), action: z.string().max(4000), sound: z.string().max(4000), durationFrames: z.number().int().positive().max(36000), resourceRefs: z.array(Ref).max(100), providerPrompts:ProviderPrompts.optional(), dialogueBlockIds:z.array(Id).max(500).optional(), frameReferences:z.array(VideoFrameReference).max(2).optional() })).min(1).max(30),
  contentChecks: z.array(z.strictObject({ ruleId: z.string().min(1).max(100), status: z.enum(['passed', 'failed', 'uncertain']), evidenceBlockIds: z.array(Id).max(100), message: z.string().max(4000) })).max(100),
});
export type SegmentScriptV1 = z.infer<typeof SegmentScriptV1>;
export const PlayableSegment = z.strictObject({
  id: Id, planHash: ContentHash, fps: z.number().int().min(1).max(60), durationFrames: z.number().int().positive(),
  bindings: z.array(z.strictObject({ id: Id, artifactRef: Ref, contentHash: ContentHash, kind: z.enum(['video', 'audio']), atFrame: z.number().int().min(0), durationFrames: z.number().int().positive(), sourceInFrame: z.number().int().min(0), sourceFps: z.number().positive().max(240), nativeAudio: z.boolean().default(false) })).min(1).max(100),
  cues: z.array(InteractionCue).max(1).default([]),
});
export type PlayableSegment = z.infer<typeof PlayableSegment>;
export const InstanceCueBinding=z.strictObject({uid:Uid,runId:Id,instanceId:Id,resultRevision:z.number().int().positive(),expectedPlanHash:ContentHash,cueId:Id,appearFrame:z.number().int().nonnegative(),deadlineFrame:z.number().int().nonnegative(),shotId:Id.optional(),blockId:Id.optional()});
export type InstanceCueBinding=z.infer<typeof InstanceCueBinding>;
export const InstanceFallback=z.strictObject({uid:Uid,runId:Id,instanceId:Id,expectedInputHash:ContentHash,fallbackId:Id});
export type InstanceFallback=z.infer<typeof InstanceFallback>;
export const SegmentInstanceStatus = z.enum(['planned', 'writing', 'checking', 'producing', 'ready', 'consumed', 'waitingReview', 'blocked', 'unknown', 'cancelled', 'stale']);
export const SegmentInstance = z.strictObject({
  id: Id, runId: Id, nodeId: Id, visitId: Id, inputHash: ContentHash, releaseId: Id,
  status: SegmentInstanceStatus, cancelRequested: z.boolean().default(false), recoveryReason: z.string().max(2000).optional(), restoreBlocked: z.boolean().optional(), sourceRefs: z.array(Ref), variableSnapshot: z.record(VariableKey, RuleValue),
  outcomeId: VariableKey.optional(), context: RuntimeContextSnapshot.optional(), resultRevision: z.number().int().positive().optional(),
  scriptResult: SegmentScriptV1.optional(), templateResult: z.strictObject({ text: z.string().max(30000), contentHash: ContentHash, media: FixedMedia.optional() }).optional(), mediaRefs: z.array(Ref).default([]), playbackPlan: PlayableSegment.optional(),
  pendingPlaybackPlan:PlayableSegment.optional(),
  cueResolutions:z.array(z.strictObject({cueId:Id,resultRevision:z.number().int().positive(),planContentHash:ContentHash,appearFrame:z.number().int().nonnegative(),deadlineFrame:z.number().int().nonnegative(),source:z.literal('author'),shotId:Id.optional(),blockId:Id.optional()})).max(1).optional(),
  fallbackResult:z.strictObject({id:Id,outcomeId:VariableKey,text:z.string().max(30000),contentHash:ContentHash,media:FixedMedia,previousResultRevision:z.number().int().positive().optional()}).optional(),
  checks: z.array(z.strictObject({ id: Id, stage: z.enum(['structure', 'content', 'media', 'authorReview']), status: z.enum(['pending', 'passed', 'failed']), resultRevision: z.number().int().positive().optional(), planHash: ContentHash.optional(), message: z.string().max(4000) })).default([]),
});
export type SegmentInstance = z.infer<typeof SegmentInstance>;
export const RuntimeDispatchOwner = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('activityAttempt'), runId: Id, activityAttemptId: Id }),
  z.strictObject({ type: z.literal('segmentInstance'), runId: Id, instanceId: Id }),
]);
export const RuntimeStart = z.strictObject({ protocolVersion: z.literal(1), requestId: Id, projectId: Id, releaseId: Id, mode: ExperienceMode });
export type RuntimeStart = z.infer<typeof RuntimeStart>;
const command = { protocolVersion: z.literal(1), requestId: Id, runId: Id, expectedStateSeq: z.number().int().positive(), visitId: Id };
const attempt = { attemptId: Id };
export const RuntimeCommand = z.discriminatedUnion('operation', [
  z.strictObject({ ...command, operation: z.literal('activity.submit'), payload: z.strictObject({ ...attempt, input: z.json() }) }),
  z.strictObject({ ...command, operation: z.literal('activity.confirmIntent'), payload: z.strictObject({ ...attempt, interpretationRef: Id, intentId: VariableKey }) }),
  z.strictObject({ ...command, operation: z.literal('activity.skip'), payload: z.strictObject(attempt) }),
  z.strictObject({ ...command, operation: z.literal('activity.retry'), payload: z.strictObject(attempt) }),
  z.strictObject({ ...command, operation: z.literal('activity.reconcile'), payload: z.strictObject(attempt) }),
  z.strictObject({ ...command, operation: z.literal('segment.complete'), payload: z.strictObject({ instanceId: Id, planHash: ContentHash, frame: z.number().int().min(0) }) }),
  z.strictObject({ ...command, operation: z.literal('instance.retry'), payload: z.strictObject({ instanceId: Id, failedStage: z.enum(['writing', 'checking', 'producing']) }) }),
  z.strictObject({ ...command, operation: z.literal('instance.reconcile'), payload: z.strictObject({ instanceId: Id }) }),
  z.strictObject({ ...command, operation: z.literal('instance.cancel'), payload: z.strictObject({ instanceId: Id }) }),
  z.strictObject({ ...command, operation: z.literal('run.abandon'), payload: z.strictObject({ reason: z.string().max(1000).optional() }) }),
]);
export type RuntimeCommand = z.infer<typeof RuntimeCommand>;
export const PositionSave = z.strictObject({ protocolVersion: z.literal(1), requestId: Id, runId: Id, visitId: Id, planHash: ContentHash, frame: z.number().int().min(0), expectedPositionSeq: z.number().int().nonnegative() });
export type PositionSave = z.infer<typeof PositionSave>;
export const PlaybackPosition = z.strictObject({ visitId: Id, planHash: ContentHash, frame: z.number().int().min(0), positionSeq: z.number().int().nonnegative() });
export const RuntimeResponse = z.strictObject({
  requestId: Id, replayed: z.boolean(), stateSeq: z.number().int().positive(), status: ExperienceStatus,
  currentNodeId: Id, waitReason: z.string().max(2000).optional(), acceptedInput: z.json().optional(),
  effects: z.array(CommittedEffect), nextAction: z.enum(['play', 'input', 'wait', 'blocked', 'ending', 'none']),
});
export type RuntimeResponse = z.infer<typeof RuntimeResponse>;
// DTO intentionally excludes release.snapshot, unvisited nodes, and raw execution configuration.
export const RuntimeView = z.strictObject({
  run: ExperienceRun, node: z.strictObject({ id: Id, type: z.enum(['segment', 'activity', 'branch', 'checkpoint', 'ending']), title: z.string(), summary: z.string().optional() }),
  activity: z.strictObject({ id: Id, type: z.string(), version: z.number().int().positive(), label: z.string(), prompt: z.string(), options: z.array(z.strictObject({ id: z.string(), label: z.string() })), maxLength: z.number().int().positive().optional(), canSkip: z.boolean(), canRetry: z.boolean(), canReconcile: z.boolean().default(false), recoveryState: z.enum(['none', 'unknown']).default('none'), recoveryReason: z.string().max(2000).optional() }).optional(),
  instance: z.strictObject({ id: Id, status: SegmentInstanceStatus, inputHash: ContentHash, cancelRequested: z.boolean().default(false), failedStage: z.enum(['writing', 'checking', 'producing']).optional() }).optional(),
  attempt: ActivityAttempt.optional(), playback: PlayableSegment.optional(), position: PlaybackPosition.optional(),
});
export type RuntimeView = z.infer<typeof RuntimeView>;
