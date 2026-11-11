import {randomUUID} from 'node:crypto';
import {ensure,parse,stable,type Ref} from '../../contracts/foundation.ts';
import {RuntimePrincipal,type ScriptRelease} from '../../contracts/experience.ts';
import {activityResultLabel} from '../../contracts/activity-result-label.ts';
import {ExperiencedHistory,ExperienceExport,ExperienceExportPlan,ExperienceExportRequest,ExperienceExportRetry} from '../../contracts/experience-export.ts';
import type {ExperiencePersistence,RunScope} from './ports.ts';
import type {ExperienceRuntime} from './runtime.ts';
import {contentHash} from '../story/script.ts';

/** Pure frame/source validation. No files, renderer, author Take or runtime mutation. */
export function validateExportPlan(raw:ExperienceExportPlan){
 const plan=parse(ExperienceExportPlan,raw);ensure(plan.mode==='playback'&&plan.segments.length>0,'VALIDATION','尚无已消费的视频片段可导出');
 let duration=0;
 for(const segment of plan.segments){const playback=segment.playback,videos=playback.bindings.filter(b=>b.kind==='video').sort((a,b)=>a.atFrame-b.atFrame);let cursor=0;
  for(const binding of videos){ensure(binding.atFrame===cursor,'MEDIA_INVALID','已走路线的视频绑定必须连续且不能重叠');cursor+=binding.durationFrames;}
  ensure(cursor===playback.durationFrames,'MEDIA_INVALID','视频绑定不能覆盖完整已走片段');
  for(const binding of playback.bindings){const source=plan.sources.find(s=>stable(s.ref)===stable(binding.artifactRef)&&s.sha256===binding.contentHash);ensure(source,'MEDIA_INVALID','已走路线缺少固定源素材');ensure(binding.atFrame+binding.durationFrames<=playback.durationFrames,'MEDIA_INVALID','媒体绑定超出片段');ensure(binding.sourceInFrame/binding.sourceFps+binding.durationFrames/playback.fps<=source.durationSeconds+1/Math.max(binding.sourceFps,playback.fps),'MEDIA_INVALID','已走路线裁剪超出真实源素材');ensure(binding.kind==='video'?source.mediaType.startsWith('video/'):source.hasAudio,'MEDIA_INVALID','源素材类型与绑定不匹配');ensure(!binding.nativeAudio||source.hasAudio,'MEDIA_INVALID','规定的原声已缺失');}
  duration+=playback.durationFrames/playback.fps;
 }
 ensure(Math.abs(duration-plan.durationSeconds)<1e-6,'VALIDATION','导出时长与固定路线不一致');return plan;
}
export class ExperienceArchives{
 constructor(private store:ExperiencePersistence,private runtime:ExperienceRuntime){}
 private scope(principal:RuntimePrincipal,runId:string):RunScope{const actor=parse(RuntimePrincipal,{projectId:principal.projectId,uid:principal.uid});this.runtime.view(actor,runId);return {...actor,runId};}
 history(principal:RuntimePrincipal,runId:string):ExperiencedHistory{
  const scope=this.scope(principal,runId),view=this.runtime.view(principal,runId),visits=this.runtime.trace(principal,runId).visits.filter(v=>v.status==='completed'),visited=new Set(visits.map(v=>v.id));
  const release=this.store.get<ScriptRelease>('releases',view.run.releaseId,{projectId:scope.projectId}).data;
  const segments=visits.flatMap(visit=>{if(!visit.instanceId)return [];const instance=this.runtime.instance(principal,runId,visit.instanceId);if(instance.status!=='consumed'||!instance.playbackPlan)return [];return [{visitId:visit.id,nodeId:visit.nodeId,title:visit.title,instanceId:instance.id,inputHash:instance.inputHash,resultRevision:instance.resultRevision,outcomeId:instance.outcomeId,playback:instance.playbackPlan}];});
  const decisions=visits.flatMap(visit=>{if(!visit.attemptId)return [];const attempt=this.runtime.activity(principal,runId,visit.attemptId);if(!['completed','skipped'].includes(attempt.status))return [];const definition=release.snapshot.activities.find(activity=>activity.id===attempt.activityId);return [{visitId:visit.id,nodeId:visit.nodeId,title:visit.title,result:attempt.result??{status:attempt.status},resultLabel:definition?activityResultLabel(definition,attempt):undefined,completedAt:visit.completedAt}];});
  return parse(ExperiencedHistory,{schemaVersion:1,...scope,releaseId:view.run.releaseId,manifestHash:view.run.manifestHash,stateSeq:view.run.stateSeq,mode:view.run.mode,segments,decisions,effects:view.run.committedFacts.filter(e=>visited.has(e.visitId))});
 }
 plan(principal:RuntimePrincipal,runId:string):ExperienceExportPlan{
  const history=this.history(principal,runId),sources:ExperienceExportPlan['sources']=[];
  for(const segment of history.segments)for(const binding of segment.playback.bindings){const artifact=this.runtime.media(principal,runId,segment.playback.planHash,binding.id).data;ensure(artifact.sha256===binding.contentHash&&artifact.durationSeconds,'MEDIA_INVALID','导出源素材没有固定时长');if(!sources.some(s=>stable(s.ref)===stable(binding.artifactRef)))sources.push({ref:binding.artifactRef,sha256:artifact.sha256,mediaType:artifact.mediaType,width:artifact.width,height:artifact.height,fps:artifact.fps,durationSeconds:artifact.durationSeconds,hasAudio:artifact.metadata.hasAudio===true});}
  const first=history.segments[0]?.playback.bindings.find(b=>b.kind==='video'),source=first&&sources.find(s=>stable(s.ref)===stable(first.artifactRef));ensure(source?.width&&source.height,'VALIDATION','尚无已消费的视频片段可导出');
  return validateExportPlan({...history,format:{width:Math.ceil(source.width/2)*2,height:Math.ceil(source.height/2)*2,fps:history.segments[0].playback.fps},sources,durationSeconds:history.segments.reduce((sum,s)=>sum+s.playback.durationFrames/s.playback.fps,0)});
 }
 create(principal:RuntimePrincipal,raw:unknown){const input=parse(ExperienceExportRequest,raw),scope=this.scope(principal,input.runId);return this.store.transaction(()=>{const receiptInput={operation:'experience.export',...input},previous=this.store.receipt<{exportId:string}>(scope,input.requestId,receiptInput);if(previous)return this.get(principal,input.runId,previous.exportId);const plan=this.plan(principal,input.runId),id=randomUUID(),record=parse(ExperienceExport,{id,runId:input.runId,requestId:input.requestId,planHash:contentHash(plan),plan,status:'queued',attempt:1,createdAt:new Date().toISOString()});this.store.create('exports',scope,record,id);this.store.saveReceipt(scope,input.requestId,receiptInput,{exportId:id});return record;});}
 get(principal:RuntimePrincipal,runId:string,id:string){return parse(ExperienceExport,this.store.get<ExperienceExport>('exports',id,this.scope(principal,runId)).data);}
 list(principal:RuntimePrincipal,runId:string){return this.store.list<ExperienceExport>('exports',this.scope(principal,runId)).map(r=>parse(ExperienceExport,r.data));}
 retry(principal:RuntimePrincipal,raw:unknown){const input=parse(ExperienceExportRetry,raw),scope=this.scope(principal,input.runId);return this.store.transaction(()=>{const receiptInput={operation:'experience.export.retry',...input},previous=this.store.receipt<{exportId:string}>(scope,input.requestId,receiptInput);if(previous)return this.get(principal,input.runId,previous.exportId);const row=this.store.get<ExperienceExport>('exports',input.exportId,scope);ensure(row.data.status==='failed','CONFLICT','只有失败的本地导出可以重试');const record=parse(ExperienceExport,{...row.data,status:'queued',attempt:row.data.attempt+1,error:undefined});this.store.save('exports',row.id,scope,row.seq,record);this.store.saveReceipt(scope,input.requestId,receiptInput,{exportId:row.id});return record;});}
 update(principal:RuntimePrincipal,runId:string,id:string,change:Partial<Pick<ExperienceExport,'status'|'output'|'error'|'completedAt'>>){const scope=this.scope(principal,runId);return this.store.transaction(()=>{const row=this.store.get<ExperienceExport>('exports',id,scope),record=parse(ExperienceExport,{...row.data,...change});ensure(row.data.status!=='completed','CONFLICT','完成的导出不可修改');this.store.save('exports',id,scope,row.seq,record);return record;});}
 verifySources(principal:RuntimePrincipal,record:ExperienceExport){ensure(record.planHash===contentHash(record.plan),'MEDIA_INVALID','导出清单哈希损坏');validateExportPlan(record.plan);for(const segment of record.plan.segments){const instance=this.runtime.instance(principal,record.runId,segment.instanceId);ensure(instance.status==='consumed'&&instance.playbackPlan?.planHash===segment.playback.planHash,'FORBIDDEN','导出内容不再属于已消费路线');for(const binding of segment.playback.bindings)this.runtime.media(principal,record.runId,segment.playback.planHash,binding.id);}}
 recover(scopes:RunScope[]){for(const scope of scopes)for(const row of this.store.list<ExperienceExport>('exports',scope))if(['queued','rendering'].includes(row.data.status))this.update(scope,scope.runId,row.id,{status:'failed',error:'本地导出在重启或恢复前未完成。可按原清单明确重试，不会重新生成故事。'});}
}
