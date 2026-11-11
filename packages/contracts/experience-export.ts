import {z} from 'zod';
import {Id,Ref} from './foundation.ts';
import {ContentHash,CommittedEffect,PlayableSegment,Uid} from './experience.ts';

export const ExperiencedSegment=z.strictObject({visitId:Id,nodeId:Id,title:z.string(),instanceId:Id,inputHash:ContentHash,resultRevision:z.number().int().positive().optional(),outcomeId:z.string().optional(),playback:PlayableSegment});
export const ExperiencedHistory=z.strictObject({schemaVersion:z.literal(1),projectId:Id,uid:Uid,runId:Id,releaseId:Id,manifestHash:ContentHash,stateSeq:z.number().int().positive(),mode:z.enum(['simulation','playback']),segments:z.array(ExperiencedSegment),decisions:z.array(z.strictObject({visitId:Id,nodeId:Id,title:z.string(),result:z.json(),resultLabel:z.string().max(200).optional(),completedAt:z.string().optional()})),effects:z.array(CommittedEffect)});
export type ExperiencedHistory=z.infer<typeof ExperiencedHistory>;
export const ExperienceExportPlan=ExperiencedHistory.extend({format:z.strictObject({width:z.number().int().positive(),height:z.number().int().positive(),fps:z.number().int().min(1).max(60)}),sources:z.array(z.strictObject({ref:Ref,sha256:ContentHash,mediaType:z.string(),width:z.number().optional(),height:z.number().optional(),fps:z.number().optional(),durationSeconds:z.number().positive(),hasAudio:z.boolean()})),durationSeconds:z.number().positive()});
export type ExperienceExportPlan=z.infer<typeof ExperienceExportPlan>;
export const ExperienceExportRequest=z.strictObject({protocolVersion:z.literal(1),requestId:Id,runId:Id});
export const ExperienceExportRetry=ExperienceExportRequest.extend({exportId:Id});
export const ExperienceExport=z.strictObject({id:Id,runId:Id,requestId:Id,planHash:ContentHash,plan:ExperienceExportPlan,status:z.enum(['queued','rendering','completed','failed']),attempt:z.number().int().positive(),createdAt:z.string().datetime(),completedAt:z.string().datetime().optional(),error:z.string().optional(),output:z.strictObject({sha256:ContentHash,sizeBytes:z.number().int().positive(),mediaType:z.literal('video/mp4'),width:z.number().int().positive(),height:z.number().int().positive(),fps:z.number().positive(),durationSeconds:z.number().positive(),hasAudio:z.boolean()}).optional()});
export type ExperienceExport=z.infer<typeof ExperienceExport>;
