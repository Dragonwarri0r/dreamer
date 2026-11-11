import { z } from 'zod';
import { Id, Ref } from './foundation.ts';

export const VariableKey = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/);
export const RuleValue = z.union([z.boolean(), z.number().int().safe(), z.string().max(2000)]);
export type RuleValue = z.infer<typeof RuleValue>;
export const CommitPhase = z.enum(['activityAccepted', 'segmentCompleted', 'checkpointReached']);
export type CommitPhase = z.infer<typeof CommitPhase>;
export const EffectValue = z.union([
  z.strictObject({ source: z.literal('constant'), value: RuleValue }),
  z.strictObject({ source: z.literal('result'), field: VariableKey }),
]);
export const Effect = z.discriminatedUnion('op', [
  z.strictObject({ id: Id, op: z.literal('set'), key: VariableKey, value: EffectValue, commitAt: CommitPhase }),
  z.strictObject({ id: Id, op: z.literal('increment'), key: VariableKey, value: EffectValue, commitAt: CommitPhase }),
  z.strictObject({ id: Id, op: z.literal('unsetSegment'), key: VariableKey, commitAt: CommitPhase }),
]);
export type Effect = z.infer<typeof Effect>;

const presentation = z.strictObject({ rendererKey: z.string().min(1).max(100), prompt: z.string().max(2000).default('') });
const skipPolicy = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('forbidden') }),
  z.strictObject({ mode: z.literal('allowed'), result: z.record(VariableKey, RuleValue) }),
]);
const common = {
  id: Id, type: z.string().min(1).max(80), version: z.number().int().positive().max(100),
  label: z.string().trim().min(1).max(160), reads: z.array(VariableKey).max(64).default([]),
  resultMapping: z.array(Effect).max(64).default([]), presentation,
  skipPolicy: skipPolicy.default({ mode: 'forbidden' }),
  retryPolicy: z.strictObject({ maxAttempts: z.number().int().min(0).max(3) }).default({ maxAttempts: 0 }),
};
const ChoiceConfig = z.strictObject({ options: z.array(z.strictObject({ id: VariableKey, label: z.string().trim().min(1).max(200) })).min(2).max(12) });
const extractedField = z.discriminatedUnion('type', [
  z.strictObject({ key: VariableKey, type: z.literal('text'), maxLength: z.number().int().min(1).max(500) }),
  z.strictObject({ key: VariableKey, type: z.literal('integer'), min: z.number().int().safe(), max: z.number().int().safe() }),
  z.strictObject({ key: VariableKey, type: z.literal('boolean') }),
  z.strictObject({ key: VariableKey, type: z.literal('enum'), values: z.array(z.string().min(1).max(100)).min(1).max(32) }),
]);
const TextIntentConfig = z.strictObject({
  maxLength: z.number().int().min(1).max(2000),
  intents: z.array(z.strictObject({ id: VariableKey, label: z.string().min(1).max(200), description: z.string().max(1000).default('') })).min(1).max(12),
  interpretationTemplate: z.strictObject({ id: z.string().min(1).max(100), version: z.number().int().positive() }),
  extractedFields: z.array(extractedField).max(16).default([]),
});
export const ChoiceActivity = z.strictObject({ ...common, type: z.literal('choice'), version: z.literal(1), config: ChoiceConfig });
export const TextIntentActivity = z.strictObject({ ...common, type: z.literal('text-intent'), version: z.literal(1), config: TextIntentConfig });
export const ExtensionActivity = z.strictObject({ ...common, config: z.record(z.string(), z.json()) }).refine(
  value => !((value.type === 'choice' || value.type === 'text-intent') && value.version === 1),
  '内置活动必须使用对应的严格配置',
);
export const ActivityDefinition = z.union([ChoiceActivity, TextIntentActivity, ExtensionActivity]);
export type ActivityDefinition = z.infer<typeof ActivityDefinition>;
export const ChoiceInput = z.strictObject({ optionId: VariableKey });
export const TextIntentInput = z.strictObject({ text: z.string().trim().min(1).max(2000) });
export const TextInterpretationV1 = z.strictObject({
  schemaVersion: z.literal(1), intentId: VariableKey.optional(),
  candidateIntentIds: z.array(VariableKey).max(12).default([]),
  extractedValues: z.record(VariableKey, RuleValue), needsConfirmation: z.boolean(),
  explanation: z.string().max(2000), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TextInterpretationV1 = z.infer<typeof TextInterpretationV1>;
export type ActivityDescriptor = {
  type: string; version: number; rendererKey: string; capabilities: readonly string[];
  configSchema: z.ZodType; inputSchema: z.ZodType; resultSchema: z.ZodType;
  recovery: 'none' | 'reconcile-original';
};
export const builtinActivityDescriptors: readonly ActivityDescriptor[] = [
  { type: 'choice', version: 1, rendererKey: 'choice', capabilities: [], configSchema: ChoiceConfig, inputSchema: ChoiceInput, resultSchema: ChoiceInput, recovery: 'none' },
  { type: 'text-intent', version: 1, rendererKey: 'text-intent', capabilities: ['runtimeText'], configSchema: TextIntentConfig, inputSchema: TextIntentInput,
    resultSchema: z.strictObject({ intentId: VariableKey, extractedValues: z.record(VariableKey, RuleValue), interpretationRef: Id }), recovery: 'reconcile-original' },
];

export const InteractionCue = z.strictObject({
  id: Id, activityNodeId: Id, segmentNodeId: Id,
  anchor: z.strictObject({ ref: Ref, blockId: Id.optional(), position: z.enum(['before', 'after', 'offset']), offsetFrames: z.number().int().min(0).default(0) }),
  resolvedBinding: z.strictObject({ releaseId: Id.optional(), planId: Id, contentHash: z.string().regex(/^[a-f0-9]{64}$/), fps: z.number().int().min(1).max(60), appearFrame: z.number().int().min(0) }).optional(),
  deadlineFrame: z.number().int().min(0), activateAt: z.literal('segmentEnd'),
});
export type InteractionCue = z.infer<typeof InteractionCue>;
export const ActivityAttemptStatus = z.enum(['open', 'interpreting', 'needsConfirmation', 'completed', 'failed', 'cancelled', 'skipped']);
export const ActivityAttempt = z.strictObject({
  id: Id, runId: Id, visitId: Id, activityId: Id, descriptorVersion: z.number().int().positive(),
  status: ActivityAttemptStatus, input: z.json().optional(), interpretation: TextInterpretationV1.optional(),
  interpretationRef: Id.optional(), result: z.record(VariableKey, RuleValue).optional(),
  recoveryReason: z.string().max(2000).optional(), restoreBlocked: z.boolean().optional(),
  consumed: z.boolean().default(false), executionIds: z.array(Id).default([]),
});
export type ActivityAttempt = z.infer<typeof ActivityAttempt>;
