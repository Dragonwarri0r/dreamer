import { z } from 'zod';
import { ScriptBlock } from './creative.ts';
import { SegmentScriptV1 } from './experience.ts';

/** Local model wire format only; these symbols are never persisted as core story identities. */
export const LocalRuntimeId = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const blocks = z.array(ScriptBlock.extend({ id: LocalRuntimeId })).min(1).max(500);
export const LocalRuntimeDraftV1 = SegmentScriptV1.extend({
  // The frozen Host execution configuration selects the wire format; this model echo is optional.
  format: z.literal('local-segment-draft/v1').optional(),
  scenes: z.array(SegmentScriptV1.shape.scenes.element.extend({ id: LocalRuntimeId, blocks })).min(1).max(20),
  assertedFacts: z.array(SegmentScriptV1.shape.assertedFacts.element.extend({ evidenceBlockIds: z.array(LocalRuntimeId).min(1).max(100) })).max(100),
  shotPlan: z.array(SegmentScriptV1.shape.shotPlan.element.extend({ id: LocalRuntimeId, sceneId: LocalRuntimeId, dialogueBlockIds: z.array(LocalRuntimeId).max(500).optional() })).min(1).max(30),
  contentChecks: z.array(SegmentScriptV1.shape.contentChecks.element.extend({ evidenceBlockIds: z.array(LocalRuntimeId).max(100) })).max(100),
});
export type LocalRuntimeDraftV1 = z.infer<typeof LocalRuntimeDraftV1>;
