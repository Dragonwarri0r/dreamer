import { z } from 'zod';
import { Id, Ref } from './foundation.ts';
import { RuntimeContentRef, Uid } from './experience.ts';

export const InstanceProposal = z.strictObject({
  uid: Uid, runId: Id, instanceId: Id, resultRevision: z.number().int().positive(),
  target: Ref.refine(ref => ref.kind === 'scene' || ref.kind === 'chapter', '请选择场景或章节的固定版本'),
  mode: z.enum(['append', 'replace']).default('append'), sceneIds: z.array(Id).min(1).max(20).optional(),
  confirmDisclosure: z.literal(true),
});
export type InstanceProposal = z.infer<typeof InstanceProposal>;
/** The selected text is explicitly shared; uid, original input and variable snapshots stay private. */
export const RuntimeAdoptionSource = z.strictObject({
  content: RuntimeContentRef, releaseId: Id, nodeId: Id,
  sourceRefs: z.array(Ref).max(1000), sceneIds: z.array(Id).max(20),
  format: z.enum(['generated', 'template', 'fallback']), mode: z.enum(['append', 'replace']), target: Ref,
});
export type RuntimeAdoptionSource = z.infer<typeof RuntimeAdoptionSource>;
