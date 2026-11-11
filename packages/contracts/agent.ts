import { z } from 'zod';
import { Id, Ref } from './foundation.ts';
import {Binding} from './agent-context.ts';
import {WritingOffer,WritingTurn} from './writing.ts';
export {Binding} from './agent-context.ts';
export const Entry=z.strictObject({id:Id,role:z.enum(['user','assistant','tool','status']),text:z.string(),at:z.string(),turnId:Id.optional(),refs:z.array(Ref).default([]),writingOffer:WritingOffer.optional()});
export const AppliedSkill=z.strictObject({id:z.string(),title:z.string(),version:z.string(),source:z.string(),instructions:z.string(),hash:z.string().length(64)});
export const Turn=z.strictObject({id:Id,text:z.string(),bindings:z.array(Binding),allowed:z.array(z.string()),targets:z.array(Id),skill:z.string().optional(),appliedSkill:AppliedSkill.optional(),state:z.enum(['queued','running','completed','failed','interrupted','unknown']),providerTurnId:z.string().optional(),readManifest:z.array(Binding).default([]),writing:WritingTurn.optional()});
export const Delegation=z.strictObject({parentThreadId:Id,parentTurnId:Id,callId:z.string().min(1).max(500),inputHash:z.string().length(64)});
export const DelegateInput=z.strictObject({
 title:z.string().trim().min(1).max(120),task:z.string().trim().min(1).max(20000),skill:z.string().optional(),
 bindings:z.array(Binding).max(40).optional(),allowed:z.array(z.string()).max(20).default([]),
});
export const ThreadData=z.strictObject({title:z.string().min(1).max(160),workId:Id,bindings:z.array(Binding).default([]),entries:z.array(Entry).default([]),turns:z.array(Turn).default([]),anchors:z.array(Id).default([]),state:z.enum(['idle','queued','running','interrupted','failed','unknown']).default('idle'),providerId:z.string().optional(),providerToolset:z.string().optional(),error:z.string().optional(),recoveryReason:z.string().optional(),lease:z.strictObject({owner:Id,until:z.number()}).optional(),forkOf:Id.optional(),delegation:Delegation.optional()});
export type ThreadData=z.infer<typeof ThreadData>;
export const WorkData=z.strictObject({title:z.string().min(1).max(160),goal:z.string().max(20000),state:z.enum(['open','done']).default('open'),bindings:z.array(Binding).default([]),outputs:z.array(Ref).default([]),source:Ref.optional()});
export {skillCatalog} from './writing-skills.ts';
export type {SkillId,SkillDefinition} from './writing-skills.ts';
