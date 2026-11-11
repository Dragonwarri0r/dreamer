import {z} from 'zod';
import {Id,Ref,type Actor} from './foundation.ts';
import {Binding} from './agent-context.ts';

export const WritingMode=z.enum(['discuss','draft','revise','review']);
export const WritingSelection=z.strictObject({entryId:Id,optionId:z.string().trim().min(1).max(80)});
export const WritingOffer=z.strictObject({
 question:z.string().trim().min(1).max(2000),
 options:z.array(z.strictObject({id:z.string().trim().min(1).max(80),title:z.string().trim().min(1).max(120),summary:z.string().trim().min(1).max(2000),message:z.string().trim().min(1).max(5000)})).min(2).max(3),
});
export const WritingTurn=z.strictObject({mode:WritingMode,targetRefs:z.array(Ref).max(40),selection:WritingSelection.optional()});
const common={owner:Id,message:z.string().trim().min(1).max(20000),mode:WritingMode,bindings:z.array(Binding).max(40).default([]),targetRefs:z.array(Ref).max(40).default([])};
export const WritingStartPayload=z.strictObject({...common,title:z.string().trim().min(1).max(160),goal:z.string().max(20000).default('')});
export const WritingContinuePayload=z.strictObject({...common,threadId:Id,selection:WritingSelection.optional()});
export const WritingStartRequest=WritingStartPayload.extend({requestId:Id,projectId:Id});
export const WritingContinueRequest=WritingContinuePayload.extend({requestId:Id,projectId:Id});
export const WritingReceiptRequest=z.discriminatedUnion('operation',[
 z.strictObject({requestId:Id,projectId:Id,operation:z.literal('writing.start'),payload:WritingStartPayload}),
 z.strictObject({requestId:Id,projectId:Id,operation:z.literal('writing.continue'),payload:WritingContinuePayload}),
]);
export const WritingStatusQuery=z.strictObject({projectId:Id,threadId:Id,afterEntryId:Id.optional()});
export type WritingMode=z.infer<typeof WritingMode>;
export type WritingStartPayload=z.infer<typeof WritingStartPayload>;
export type WritingContinuePayload=z.infer<typeof WritingContinuePayload>;
export type WritingTurn=z.infer<typeof WritingTurn>;
export type WritingOffer=z.infer<typeof WritingOffer>;
export const writingSkill=(mode:WritingMode)=>mode==='discuss'?'writing-coach':mode==='review'?'engagement-review':'serial-fiction';
export const isReviewSkill=(skill?:string)=>skill==='script-review'||skill==='engagement-review';
/** Transport identity is deliberately distinct from a human review/approval. */
export const writingActor=(projectId:string):Actor=>({source:'external',projectId,allowed:['writing.start','writing.continue']});
