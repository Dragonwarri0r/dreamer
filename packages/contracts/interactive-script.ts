import { z } from 'zod';
import { Id, Ref } from './foundation.ts';
import { ActivityDefinition, Effect, InteractionCue, RuleValue, VariableKey, CommitPhase } from './activities.ts';
import { VideoFrameReference } from './production-input.ts';
export { Effect, RuleValue, CommitPhase } from './activities.ts';

export type Condition =
  | { op: 'eq'; key: string; value: RuleValue }
  | { op: 'in'; key: string; values: RuleValue[] }
  | { op: 'gte'; key: string; value: number }
  | { op: 'lte'; key: string; value: number }
  | { op: 'all'; conditions: Condition[] }
  | { op: 'any'; conditions: Condition[] }
  | { op: 'not'; condition: Condition };
// A finite schema rejects hostile depth before recursive parsing can overflow.
function conditionAt(depth: number): z.ZodType<Condition> {
  const leaves = [
    z.strictObject({ op: z.literal('eq'), key: VariableKey, value: RuleValue }),
    z.strictObject({ op: z.literal('in'), key: VariableKey, values: z.array(RuleValue).min(1).max(64) }),
    z.strictObject({ op: z.literal('gte'), key: VariableKey, value: z.number().int().safe() }),
    z.strictObject({ op: z.literal('lte'), key: VariableKey, value: z.number().int().safe() }),
  ] as const;
  if (depth === 8) return z.discriminatedUnion('op', leaves);
  const child = conditionAt(depth + 1);
  return z.discriminatedUnion('op', [...leaves,
    z.strictObject({ op: z.literal('all'), conditions: z.array(child).min(1).max(64) }),
    z.strictObject({ op: z.literal('any'), conditions: z.array(child).min(1).max(64) }),
    z.strictObject({ op: z.literal('not'), condition: child }),
  ]);
}
export const Condition = conditionAt(1).superRefine((value, ctx) => {
  const queue = [value]; let count = 0;
  while (queue.length) { const item = queue.pop()!; count++; if (item.op === 'all' || item.op === 'any') queue.push(...item.conditions); else if (item.op === 'not') queue.push(item.condition); }
  if (count > 64) ctx.addIssue({ code: 'custom', message: '单个条件表达式最多 64 项' });
});
const writers = z.array(z.strictObject({ sourceId: Id, commitAt: CommitPhase })).max(128).default([]);
const variableCommon = { key: VariableKey, label: z.string().min(1).max(100), scope: z.enum(['run', 'segment']), allowedWriters: writers };
export const VariableDefinition = z.discriminatedUnion('type', [
  z.strictObject({ ...variableCommon, type: z.literal('boolean'), initial: z.boolean() }),
  z.strictObject({ ...variableCommon, type: z.literal('enum'), initial: z.string().min(1).max(100), values: z.array(z.string().min(1).max(100)).min(1).max(64) }),
  z.strictObject({ ...variableCommon, type: z.literal('integer'), initial: z.number().int().safe(), min: z.number().int().safe(), max: z.number().int().safe() }),
  z.strictObject({ ...variableCommon, type: z.literal('text'), initial: z.string().max(500), maxLength: z.number().int().min(1).max(500) }),
]).superRefine((value, ctx) => {
  if (value.type === 'integer' && (value.min > value.max || value.initial < value.min || value.initial > value.max)) ctx.addIssue({ code: 'custom', path: ['initial'], message: '初始值必须在有效整数范围内' });
  if (value.type === 'enum' && (!value.values.includes(value.initial) || new Set(value.values).size !== value.values.length)) ctx.addIssue({ code: 'custom', path: ['values'], message: '枚举必须唯一且包含初始值' });
  if (value.type === 'text' && value.initial.length > value.maxLength) ctx.addIssue({ code: 'custom', path: ['initial'], message: '初始文本过长' });
});
export type VariableDefinition = z.infer<typeof VariableDefinition>;
export const ExecutionProfile = z.strictObject({
  provider: z.string().min(1).max(100), profile: z.string().min(1).max(100), quality: z.enum(['draft', 'final']),
  model: z.string().min(1).max(200), configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  templateVersion: z.string().min(1).max(100), constraints: z.record(z.string(), z.union([z.boolean(), z.number(), z.string().max(2000)])).default({}),
});
export const ScriptPolicy = z.strictObject({
  maxBranchesPerDecision: z.number().int().min(1).max(12).default(3),
  maxDynamicNodesPerRun: z.number().int().min(0).max(20).default(1),
  maxShotsPerSegment: z.number().int().min(1).max(30).default(6),
  maxTextCallsPerRun: z.number().int().min(0).max(100).default(0),
  maxMediaJobsPerRun: z.number().int().min(0).max(100).default(0),
  maxRepairAttempts: z.number().int().min(0).max(3).default(0),
  prefetchDepth: z.union([z.literal(0), z.literal(1)]).default(0),
  executionProfiles: z.array(ExecutionProfile).max(12).default([]),
  reviewMode: z.enum(['authorReview', 'validatedRuntime']).default('authorReview'),
  failurePolicy: z.enum(['block', 'boundFallback']).default('block'),
  waitingPolicy: z.literal('pauseAtBoundary').default('pauseAtBoundary'),
});
export type ScriptPolicy = z.infer<typeof ScriptPolicy>;
const outcome = z.strictObject({ id: VariableKey, narrativeRequirement: z.string().min(1).max(4000), postconditions: z.array(Condition).max(32).default([]), completionEffects: z.array(Effect).max(64).default([]) });
export const FixedMedia = z.strictObject({ buildRef: Ref.refine(ref => ref.kind === 'build', '必须引用 Build'), fromFrame: z.number().int().min(0).default(0), toFrame: z.number().int().positive(), fps: z.number().int().min(1).max(60), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).superRefine((v,c) => { if (v.toFrame <= v.fromFrame) c.addIssue({ code: 'custom', path: ['toFrame'], message: '片段范围必须非空' }); });
export type FixedMedia = z.infer<typeof FixedMedia>;
export const GenerationContract = z.strictObject({
  id: Id, version: z.number().int().positive(), scope: z.enum(['segment', 'chapter']),
  reads: z.array(VariableKey).max(64), sourceRefs: z.array(Ref).max(200).default([]),
  entryConditions: z.array(Condition).max(32).default([]), narrativeGoal: z.string().trim().min(1).max(8000),
  fixedFacts: z.array(z.strictObject({ key: VariableKey, text: z.string().min(1).max(4000), sourceRef: Ref })).max(100).default([]),
  allowedChanges: z.array(z.strictObject({ field: z.enum(['dialogue', 'action', 'method', 'description']), constraint: z.string().min(1).max(2000) })).max(30),
  outcomeCases: z.array(z.strictObject({ id: Id, priority: z.number().int().safe(), when: Condition, outcomeId: VariableKey })).max(12),
  fallbackOutcome: VariableKey, outcomes: z.array(outcome).min(1).max(12), resourceRefs: z.array(Ref).max(100).default([]),
  mediaReferences: z.array(VideoFrameReference).max(60).default([]),
  boundFallbacks: z.array(z.strictObject({id:Id,outcomeId:VariableKey,entryConditions:z.array(Condition).max(32).default([]),text:z.string().min(1).max(30000),media:FixedMedia})).max(12).default([]),
  limits: z.strictObject({ maxCharacters: z.number().int().min(1).max(30000), maxScenes: z.number().int().min(1).max(20), maxShots: z.number().int().min(1).max(30), targetSeconds: z.number().min(1).max(600), maxTextCalls: z.number().int().min(1).max(20), maxMediaJobs: z.number().int().min(0).max(30), maxRepairAttempts: z.number().int().min(0).max(3) }),
  checks: z.strictObject({ structure: z.literal(true), independentContent: z.boolean(), mediaReady: z.boolean() }),
});
export type GenerationContract = z.infer<typeof GenerationContract>;
export const SegmentContent = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fixed'), media: FixedMedia.optional() }),
  z.strictObject({ mode: z.literal('template'), reads: z.array(VariableKey).max(64), text: z.string().max(30000), variants: z.array(z.strictObject({ id: Id, when: Condition, media: FixedMedia, outcomeId: VariableKey })).max(32), generationContract: GenerationContract.optional() }),
  z.strictObject({ mode: z.literal('generated'), generationContract: GenerationContract }),
]);
const nodeCommon = { id: Id, title: z.string().trim().min(1).max(160), chapterId: Id.optional(), outlineOrder: z.number().int().min(0), description: z.string().max(4000).default('') };
export const ScriptNode = z.discriminatedUnion('type', [
  z.strictObject({ ...nodeCommon, type: z.literal('segment'), mode: z.enum(['fixed', 'template', 'generated']), sourceSceneRefs: z.array(Ref).max(200), contentSpec: SegmentContent, completionEffects: z.array(Effect).max(64).default([]), next: Id }),
  z.strictObject({ ...nodeCommon, type: z.literal('activity'), activityId: Id, next: Id }),
  z.strictObject({ ...nodeCommon, type: z.literal('branch'), cases: z.array(z.strictObject({ id: Id, priority: z.number().int().safe(), when: Condition, to: Id })).min(1).max(12), fallback: z.strictObject({ id: Id, to: Id }) }),
  z.strictObject({ ...nodeCommon, type: z.literal('checkpoint'), requires: z.array(Condition).max(32).default([]), commitEffects: z.array(Effect).max(64).default([]), next: Id, mediaEntryContract: z.strictObject({ description: z.string().min(1).max(2000), resourceRefs: z.array(Ref).max(30) }).optional() }),
  z.strictObject({ ...nodeCommon, type: z.literal('ending'), endingKey: VariableKey, summary: z.string().max(4000) }),
]);
export type ScriptNode = z.infer<typeof ScriptNode>;
export const ScriptPlanData = z.strictObject({
  schemaVersion: z.literal(1), title: z.string().trim().min(1).max(160),
  chapterRefs: z.array(Ref).max(10000), entryNodeId: Id, nodes: z.array(ScriptNode).min(1).max(1000),
  variables: z.array(VariableDefinition).max(64).default([]), activities: z.array(ActivityDefinition).max(200).default([]),
  cues: z.array(InteractionCue).max(200).default([]), branchOf: Ref.optional(), policy: ScriptPolicy.default(() => ScriptPolicy.parse({})),
});
export type ScriptPlanData = z.infer<typeof ScriptPlanData>;
export const ScriptOperation = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('title.set'), title: z.string().trim().min(1).max(160) }),
  z.strictObject({ op: z.literal('entry.set'), nodeId: Id }),
  z.strictObject({ op: z.literal('chapter.order'), chapterRefs: z.array(Ref).max(10000) }),
  z.strictObject({ op: z.literal('node.insert'), node: ScriptNode }),
  z.strictObject({ op: z.literal('node.replace'), node: ScriptNode }),
  z.strictObject({ op: z.literal('node.remove'), nodeId: Id }),
  z.strictObject({ op: z.literal('branch.case.upsert'), nodeId: Id, branchCase: z.strictObject({ id: Id, priority: z.number().int().safe(), when: Condition, to: Id }) }),
  z.strictObject({ op: z.literal('branch.case.remove'), nodeId: Id, caseId: Id }),
  z.strictObject({ op: z.literal('variable.upsert'), variable: VariableDefinition }),
  z.strictObject({ op: z.literal('variable.remove'), key: VariableKey }),
  z.strictObject({ op: z.literal('activity.upsert'), activity: ActivityDefinition }),
  z.strictObject({ op: z.literal('activity.remove'), activityId: Id }),
  z.strictObject({ op: z.literal('cue.upsert'), cue: InteractionCue }),
  z.strictObject({ op: z.literal('cue.remove'), cueId: Id }),
  z.strictObject({ op: z.literal('source.rebind'), nodeId: Id, chapterId: Id.optional(), sourceSceneRefs: z.array(Ref).max(200) }),
  z.strictObject({ op: z.literal('policy.set'), policy: ScriptPolicy }),
]);
export type ScriptOperation = z.infer<typeof ScriptOperation>;
export const ScriptEdit = z.strictObject({ id: Id, expectedSeq: z.number().int().positive(), ops: z.array(ScriptOperation).min(1).max(100) });
export const ScriptCreate = ScriptPlanData;
export const ScriptPublish = z.strictObject({ id: Id, expectedSeq: z.number().int().positive(), kind: z.enum(['playback', 'simulation']), confirmGeneration: z.boolean().default(false) });
