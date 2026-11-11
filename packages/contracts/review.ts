import {z} from 'zod';import {Id,Ref} from './foundation.ts';
import {ScriptOperation} from './interactive-script.ts';
import {RuntimeAdoptionSource} from './adoption.ts';
export const CreativeKind=z.enum(['chapter','episode','scene','resource','knowledge','shot','cut','script']);
const ReplacementKind=z.enum(['chapter','episode','scene','resource','knowledge','shot','cut']);
export const CreativeOperation=z.discriminatedUnion('kind',[
 z.strictObject({kind:ReplacementKind,id:Id,expectedSeq:z.number().int().positive(),base:Ref,data:z.unknown()}),
 z.strictObject({kind:z.literal('script'),id:Id,expectedSeq:z.number().int().positive(),base:Ref,ops:z.array(ScriptOperation).min(1).max(100)}),
]);
export const ChangeGroup=z.strictObject({id:Id,title:z.string().min(1).max(160),dependsOn:z.array(Id).default([]),operations:z.array(CreativeOperation).min(1).max(100)});
export const Proposal=z.strictObject({title:z.string().min(1).max(200),reason:z.string().max(10000),groups:z.array(ChangeGroup).min(1).max(50),reads:z.array(Ref).default([]),budget:z.strictObject({maxGenerations:z.literal(0).default(0)}).default({maxGenerations:0}),noteId:Id.optional()});
export const ChangeData=Proposal.extend({runtimeSource:RuntimeAdoptionSource.optional(),state:z.enum(['proposed','approved','applied','partial','rejected']).default('proposed'),createdBy:z.enum(['human','agent','system']),appliedGroups:z.array(Id).default([]),approval:z.strictObject({hash:z.string(),groups:z.array(Id),at:z.string(),revision:z.number().int().positive()}).optional(),decisions:z.array(z.strictObject({at:z.string(),action:z.enum(['approved','applied','rejected']),groups:z.array(Id),reason:z.string().default('')})).default([])});
export type ChangeData=z.infer<typeof ChangeData>;
export const Locator=z.strictObject({buildId:Id,clipId:Id.optional(),takeId:Id.optional(),startFrame:z.number().int().nonnegative(),endFrame:z.number().int().nonnegative(),x:z.number().min(0).max(1).optional(),y:z.number().min(0).max(1).optional()});
export const NoteData=z.strictObject({target:Ref,text:z.string().trim().min(1).max(10000),locator:Locator.optional(),state:z.enum(['open','in_progress','revised','resolved']).default('open'),workId:Id.optional(),threadId:Id.optional(),revision:Ref.optional(),resolution:z.string().max(4000).default('')});
export type NoteData=z.infer<typeof NoteData>;
