import type {ExperiencePersistence,RunScope,GenerationReservation,ExperienceScope} from '../experience/ports.ts';
import type {JobOwner} from '../../contracts/production.ts';
import {cloudIntentIssue,isCloudVideo} from '../../contracts/cloud-video.ts';
import h3Profiles from '../../contracts/h3-profiles.json' with {type:'json'};
import {randomUUID} from 'node:crypto';import {z} from 'zod';import {Id,Ref,ProjectData,ensure,type RecordState} from '../../contracts/foundation.ts';import {ArtifactData,JobData,RenderIntent,type MediaProvider,type ProviderReceipt,type Capability,type ProfileConstraints} from '../../contracts/production.ts';import type {Persistence} from '../foundation/ports.ts';import {CommandBus} from '../foundation/commands.ts';import type {ReferenceReader} from './authoring.ts';
// Discovery and submission validation share the same fixed profile calculation.
function profileConstraints(provider:RenderIntent['provider'],profile:string):ProfileConstraints|undefined{
 if(provider==='h3'){const p=h3Profiles[profile as keyof typeof h3Profiles];return p?{...p,durationSeconds:p.frames/p.fps,audio:true,minReferences:0,maxReferences:2,firstLastFramesForTwo:true,referenceMediaTypes:['image/png'],maxPromptCharacters:4000,promptEncoding:'unicode'}:undefined;}
 if(provider==='ltx'){const frames=profile.includes('story')?129:49,i2v=profile.includes('i2v');return {width:288,height:512,frames,fps:16,durationSeconds:frames/16,audio:false,final:false,minReferences:i2v?1:0,maxReferences:i2v?2:0,firstLastFramesForTwo:false,referenceMediaTypes:['image/png'],maxPromptCharacters:4000,promptEncoding:'ascii'};}
}
export interface MediaStorage {path(hash:string):string;import(path:string,title:string,source:string,expectedHash?:string):Promise<ArtifactData>;}
export class Production {
 readonly jobs;readonly artifacts;readonly providers=new Map<string,MediaProvider>();private busy=new Set<string>();private activeProviders=new Set<string>();private closed=false;private timer?:ReturnType<typeof setInterval>;onResult:(job:RecordState<JobData>,artifact:Ref)=>void=()=>{};onExperienceResult:(job:RecordState<JobData>,artifact:Ref)=>void=()=>{};onExperienceState:(job:RecordState<JobData>)=>void=()=>{};
 constructor(private store:Persistence,private bus:CommandBus,readonly files:MediaStorage,providers:MediaProvider[],private read:ReferenceReader,private experience?:ExperiencePersistence,startScheduler=true){
  this.jobs=store.repository('job',JobData);this.artifacts=store.repository('artifact',ArtifactData);for(const p of providers)this.providers.set(p.describe().id,p);
  bus.register('job.submit',RenderIntent,(intent,pid)=>{ensure(intent.provider!=='ffmpeg','FORBIDDEN','成片任务必须从固定 Build 创建');return this.enqueue(pid,intent);},true);
  bus.register('job.cancel',z.strictObject({id:Id}),(p,pid)=>{const j=this.jobs.get(p.id,pid);ensure(j.data.owner.type==='author','FORBIDDEN','体验任务只能在所属体验中操作');ensure(!['completed','failed','cancelled'].includes(j.data.state),'CONFLICT','任务已结束');const queued=j.data.state==='queued';const next=this.jobs.save(j.id,pid,j.seq,{...j.data,cancelRequested:true,state:queued?'cancelled':j.data.state,attempts:j.data.attempts.map((a,i)=>i===j.data.attempts.length-1&&queued?{...a,state:'cancelled'}:a)});this.notify(next);if(!queued)queueMicrotask(()=>void this.cancel(next));return next;},true);
  bus.register('job.reconcile',z.strictObject({id:Id}),(p,pid)=>{const j=this.jobs.get(p.id,pid);ensure(j.data.owner.type==='author','FORBIDDEN','体验任务只能在所属体验中操作');queueMicrotask(()=>void this.reconcile(j.id,pid));return {id:j.id,state:j.data.state};},true);
  bus.register('job.retry',z.strictObject({id:Id}),(p,pid)=>{const j=this.jobs.get(p.id,pid);ensure(j.data.owner.type==='author','FORBIDDEN','体验任务只能在所属体验中操作');ensure(['failed','cancelled'].includes(j.data.state),'CONFLICT','只有明确失败或取消的任务可重试；未知结果须先对账');ensure(!j.data.retryOf,'CONFLICT','一次任务最多显式重试一次，请修改意图后新建任务');return this.enqueue(pid,j.data.intent,j.id);},true);

  if(startScheduler){this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref();}
 }
 capabilities():Capability[]{return [...this.providers.values()].map(provider=>{const cap=provider.describe();const constraints=Object.fromEntries(cap.profiles.flatMap(id=>{const value=profileConstraints(cap.id,id);return value?[[id,value]]:[];}));return Object.keys(constraints).length?{...cap,profileConstraints:constraints}:cap;});}
 validate(pid:string,intent:RenderIntent,checkBudget=true){const provider=this.providers.get(intent.provider);ensure(provider,'UNSUPPORTED','Provider 未配置');const cap=provider.describe();ensure(cap.available,'UNSUPPORTED',cap.detail);ensure(cap.profiles.includes(intent.profile),'UNSUPPORTED','Provider 不支持此 Profile');ensure(!intent.references.length||cap.supports.references,'UNSUPPORTED','此 Provider 不支持参考图');ensure(!intent.constraints.firstLastFrames||cap.supports.lastFrame,'UNSUPPORTED','此 Provider 不支持首尾帧约束');ensure(!intent.constraints.audio||cap.supports.audio,'UNSUPPORTED','此 Provider 不支持生成声音');ensure(intent.quality!=='final'||cap.supports.final,'UNSUPPORTED','此 Provider 未具备高质量生成能力');
  if(intent.target)this.read(intent.target,pid);for(const ref of intent.references){ensure(ref.kind==='artifact','VALIDATION','参考输入须为正式素材');const a=this.artifacts.at(ref,pid);ensure(a.data.mediaType.startsWith('image/'),'VALIDATION','生成参考须为图像');}
  if(intent.provider==='ltx'){const p=profileConstraints(intent.provider,intent.profile)!,c=intent.constraints;ensure(c.width===p.width&&c.height===p.height&&c.fps===p.fps&&Math.abs(c.durationSeconds-p.durationSeconds)<0.001,'UNSUPPORTED',`当前 LTX Profile 要求 ${p.width}×${p.height} / ${p.fps}fps / ${p.frames} 帧，不能静默修改约束`);ensure(/^[\x00-\x7F]+$/.test(intent.prompt)&&intent.prompt.length<=p.maxPromptCharacters,'VALIDATION','LTX 需要不超过 4000 字符的英文画面描述');ensure(intent.references.length>=p.minReferences&&intent.references.length<=p.maxReferences,'VALIDATION','参考图数量与 LTX Profile 不匹配');ensure(!c.firstLastFrames||intent.references.length===2,'VALIDATION','首尾帧模式需要两张参考图');}
  if(intent.provider==='h3'){const p=profileConstraints(intent.provider,intent.profile),c=intent.constraints;ensure(p,'UNSUPPORTED','H3 Profile 不可用');ensure(c.width===p.width&&c.height===p.height&&c.fps===p.fps&&Math.abs(c.durationSeconds-p.durationSeconds)<0.001&&c.audio,'UNSUPPORTED',`H3 要求 ${p.width}×${p.height} / ${p.fps}fps / ${p.frames} 帧并保留原生音频`);ensure(intent.quality!=='final'||p.final,'UNSUPPORTED','Turbo 仅用于预览，请选择 h3-quality/v1');ensure(intent.prompt.trim().length>0&&[...intent.prompt].length<=p.maxPromptCharacters&&Buffer.from(intent.prompt,'utf8').toString('utf8')===intent.prompt,'VALIDATION','H3 提示词须为非空有效 Unicode，最多 4000 字符；支持保留原文对白');ensure(intent.references.length<=p.maxReferences&&c.firstLastFrames===(intent.references.length===2),'VALIDATION','H3 最多使用首尾两张参考图，双参考必须明确首尾帧约束');}
  if(isCloudVideo(intent.provider)){const issue=cloudIntentIssue(intent);ensure(!issue,'VALIDATION',issue??'云端生成参数无效');}
  if(checkBudget&&countsProject(intent.provider)){const limit=storeProject(this.store,pid).generationLimit;const used=this.experience?this.experience.usage({projectId:pid}).projectMedia:this.jobs.list(pid).filter(j=>countsProject(j.data.intent.provider)).length;ensure(used<limit,'FORBIDDEN','项目生成次数预算已用完，请先调整项目预算');}
  return cap;
 }
 enqueue(pid:string,input:RenderIntent,retryOf?:string,internal?:{owner:Extract<JobOwner,{type:'experience'}>;scope:RunScope;reservationId:string}){
  const intent=RenderIntent.parse(input);if(!internal)for(const ref of intent.references)ensure(this.artifacts.at(ref,pid).data.metadata.visibility!=='experience','FORBIDDEN','私人体验素材不能作为公共作者任务的参考');const cap=this.validate(pid,intent,!internal),id=randomUUID();let requestId:string=randomUUID();
  if(internal){
   ensure(this.experience,'INTERNAL','体验存储未接入');
   ensure(!intent.target,'FORBIDDEN','体验生成不能改写公共创作目标');
   ensure(internal.scope.projectId===pid&&internal.owner.runId===internal.scope.runId,'FORBIDDEN','媒体任务与体验范围不匹配');
   const run=this.experience.get<any>('runs',internal.scope.runId,internal.scope).data;
   ensure(run.mode==='playback'&&!run.restoreBlocked&&!['abandoned','completed'].includes(run.status),'FORBIDDEN','此体验不能创建媒体任务');
   const instance=this.experience.get<any>('instances',internal.owner.instanceId,internal.scope).data;
   ensure(instance.runId===internal.scope.runId&&instance.releaseId===run.releaseId,'FORBIDDEN','媒体实例与固定体验不匹配');
   const reservation=this.experience.get<GenerationReservation>('reservations',internal.reservationId,internal.scope);
   ensure(reservation.data.state==='reserved'&&reservation.data.unit==='media'&&!reservation.data.jobId&&reservation.data.source==='runtime'
     &&reservation.data.stage==='media'&&reservation.data.provider===intent.provider&&reservation.data.countsProject===countsProject(intent.provider)
     &&reservation.data.ownerKey===`instance:${internal.owner.instanceId}:shot:${internal.owner.component}`,'CONFLICT','媒体预约身份或执行规格不匹配');
   requestId=reservation.data.requestId;
   this.experience.save('reservations',reservation.id,internal.scope,reservation.seq,{...reservation.data,jobId:id});
  }
  else if(this.experience&&countsProject(intent.provider))this.experience.reserve({projectId:pid},{requestId,ownerKey:`author:job:${id}`,stage:'media',attemptNo:1,unit:'media',countsProject:true,state:'reserved',source:'author',jobId:id,provider:intent.provider},{projectMedia:storeProject(this.store,pid).generationLimit});
  const job=this.jobs.create(pid,JobData.parse({owner:internal?.owner??{type:'author'},title:intent.prompt.slice(0,80)||intent.profile,intent,fingerprint:cap.fingerprint,state:'queued',attempts:[{id:randomUUID(),requestId,lease:randomUUID(),state:'queued'}],submittedAt:new Date().toISOString(),retryOf}),id);queueMicrotask(()=>void this.dispatch(id,pid));return job;
 }
 isAuthorArtifact(id:string,pid:string){return this.artifacts.get(id,pid).data.metadata.visibility!=='experience';}
 private ownerScope(job:RecordState<JobData>):RunScope|undefined{
  if(job.data.owner.type!=='experience'||!this.experience)return;
  try{const scope=this.experienceScope?.(job.projectId,job.data.owner.runId);if(!scope||scope.projectId!==job.projectId||scope.runId!==job.data.owner.runId||!scope.uid)return;
   this.experience.get('runs',scope.runId,scope);this.experience.get('instances',job.data.owner.instanceId,scope);return scope;
  }catch{return;}
 }
 private journal(job:RecordState<JobData>){
  if(!this.experience)return;
  const scope:ExperienceScope|undefined=job.data.owner.type==='author'?{projectId:job.projectId}:this.ownerScope(job);if(!scope)return;
  const row=this.experience.list<GenerationReservation>('reservations',scope).find(r=>r.data.jobId===job.id);if(!row)return;
  const neverDispatched=row.data.state==='reserved'&&job.data.attempts.every(a=>!a.startedAt);
  const state:GenerationReservation['state']=job.data.owner.type==='experience'&&neverDispatched&&['cancelled','failed'].includes(job.data.state)?'released'
    :job.data.state==='completed'?'consumed':job.data.state==='unknown'?'unknown':job.data.state==='failed'?'failed':job.data.state==='cancelled'?'cancelled':job.data.state==='queued'?'reserved':'dispatched';
  // A repeated cancellation cannot turn a refunded, undispatched reservation into a charge.
  if(row.data.state==='released')return;
  this.experience.save('reservations',row.id,scope,row.seq,{...row.data,state});
 }
 experienceScope?:(pid:string,runId:string)=>RunScope|undefined;
 private notify(job:RecordState<JobData>){this.journal(job);if(job.data.owner.type==='experience'&&this.ownerScope(job))this.onExperienceState(job);}
 cancelExperience(id:string,pid:string,notifyInstance=true){
  const j=this.jobs.get(id,pid);ensure(j.data.owner.type==='experience','FORBIDDEN','任务不属于体验');
  const queued=j.data.state==='queued';
  const next=this.jobs.save(id,pid,j.seq,{...j.data,cancelRequested:true,state:queued?'cancelled':j.data.state,
    attempts:j.data.attempts.map((attempt,index)=>queued&&index===j.data.attempts.length-1?{...attempt,state:'cancelled'}:attempt)});
  this.journal(next);if(notifyInstance&&this.ownerScope(next))this.onExperienceState(next);if(next.data.state!=='cancelled')queueMicrotask(()=>void this.cancel(next));return next;
 }
 private mayDispatchExperience(job:RecordState<JobData>):boolean{
  if(job.data.owner.type!=='experience')return true;
  const scope=this.ownerScope(job);
  if(!scope){this.mutate(job.id,job.projectId,data=>({...data,state:'unknown',error:'体验归属无法核对，未派发媒体',attempts:data.attempts.map(a=>({...a,state:'unknown'}))}));return false;}
  const run=this.experience!.get<any>('runs',scope.runId,scope).data;
  if(['abandoned','completed'].includes(run.status)){
   this.store.transaction(()=>this.cancelExperience(job.id,job.projectId));return false;
  }
  let allowed=false;
  try{
   const instance=this.experience!.get<any>('instances',job.data.owner.instanceId,scope).data;
   const reservation=this.experience!.list<GenerationReservation>('reservations',scope).find(r=>r.data.jobId===job.id);
   allowed=run.mode==='playback'&&!run.restoreBlocked&&!instance.restoreBlocked&&!instance.cancelRequested&&!['cancelled','stale','ready','consumed'].includes(instance.status)
     &&instance.runId===scope.runId&&instance.releaseId===run.releaseId&&reservation?.data.state==='reserved'
     &&reservation.data.provider===job.data.intent.provider&&reservation.data.requestId===job.data.attempts.at(-1)?.requestId;
  }catch{allowed=false;}
  if(!allowed)this.mutate(job.id,job.projectId,data=>({...data,state:'unknown',error:'恢复状态、实例或预约未核对，禁止重新派发媒体',attempts:data.attempts.map(a=>({...a,state:'unknown'}))}));
  return allowed;
 }

 private mutate(id:string,pid:string,fn:(d:JobData)=>JobData){if(this.closed)return;return this.store.transaction(()=>{const j=this.jobs.get(id,pid);const next=this.jobs.save(id,pid,j.seq,fn(j.data));this.notify(next);if(next.data.owner.type==='author')this.store.append({requestId:randomUUID(),projectId:pid,operation:'job.event',payload:{id}},{source:'system'},{id,seq:next.seq,state:next.data.state});return next;});}
 private pids=new Set<string>();
 recover(projectIds:string[]){if(this.experience)this.store.transaction(()=>{for(const pid of projectIds){const existing=this.experience!.list<GenerationReservation>('reservations',{projectId:pid});for(const j of this.jobs.list(pid)){if(!countsProject(j.data.intent.provider)||j.data.owner.type!=='author'||existing.some(r=>r.data.jobId===j.id))continue;this.experience!.create('reservations',{projectId:pid},{requestId:`legacy-job:${j.id}`,ownerKey:`author:job:${j.id}`,stage:'media',attemptNo:1,unit:'media',countsProject:true,state:'consumed',source:'legacy',jobId:j.id,provider:j.data.intent.provider});}}});for(const pid of projectIds){this.pids.add(pid);for(const j of this.jobs.list(pid)){if(['running','collecting'].includes(j.data.state)){this.mutate(j.id,pid,d=>({...d,state:'unknown',recoveryReason:'Host 重启，核对原请求结果',attempts:d.attempts.map((a,i)=>i===d.attempts.length-1?{...a,state:'unknown'}:a)}));queueMicrotask(()=>void this.reconcile(j.id,pid));}else if(j.data.state==='queued')queueMicrotask(()=>void this.dispatch(j.id,pid));}}}
 private async tick(){if(this.closed)return;for(const pid of this.pids)for(const j of this.jobs.list(pid)){if(j.data.state==='queued')void this.dispatch(j.id,pid);else if(j.data.state==='running'&&!this.busy.has(j.id))void this.reconcile(j.id,pid);}}
 private group(id:string){return this.providers.get(id)?.describe().concurrencyGroup??id;}
 async dispatch(id:string,pid:string){if(this.closed||this.busy.has(id))return;this.pids.add(pid);let j:RecordState<JobData>;try{j=this.jobs.get(id,pid);}catch(error){if((error as any).code==='NOT_FOUND')return;throw error;}if(j.data.state!=='queued'||!this.mayDispatchExperience(j)||this.activeProviders.has(this.group(j.data.intent.provider)))return;for(const project of this.pids)if(this.jobs.list(project).some(other=>other.id!==id&&this.group(other.data.intent.provider)===this.group(j.data.intent.provider)&&['running','unknown','collecting'].includes(other.data.state)))return;const provider=this.providers.get(j.data.intent.provider);if(!provider)return;this.busy.add(id);this.activeProviders.add(this.group(j.data.intent.provider));const attempt=j.data.attempts.at(-1)!;try{const cap=provider.describe();ensure(cap.available&&cap.fingerprint===j.data.fingerprint,'UNSUPPORTED','Provider 环境已变化，请重新确认生成条件');j=this.mutate(id,pid,d=>({...d,state:'running',attempts:d.attempts.map(a=>a.id===attempt.id?{...a,state:'running',startedAt:new Date().toISOString()}:a)}))!;const receipt=await provider.submit({id:attempt.requestId,intent:j.data.intent,fingerprint:j.data.fingerprint,referenceFiles:j.data.intent.references.map(ref=>{const a=this.artifacts.at(ref,pid);return {path:this.files.path(a.data.sha256),sha256:a.data.sha256,mediaType:a.data.mediaType};})});await this.collect(id,pid,attempt.lease,receipt);}catch(e:any){if(!this.closed)this.mutate(id,pid,d=>({...d,state:e.code==='UNSUPPORTED'?'failed':'unknown',error:e.message,attempts:d.attempts.map(a=>a.id===attempt.id?{...a,state:e.code==='UNSUPPORTED'?'failed':'unknown',error:e.message}:a)}));}finally{this.busy.delete(id);this.activeProviders.delete(this.group(j.data.intent.provider));}}
 async reconcile(id:string,pid:string){if(this.closed||this.busy.has(id))return;const j=this.jobs.get(id,pid);if(['completed','failed','cancelled','queued'].includes(j.data.state))return;const provider=this.providers.get(j.data.intent.provider);if(!provider)return;this.busy.add(id);try{await this.collect(id,pid,j.data.attempts.at(-1)!.lease,await provider.status(j.data.attempts.at(-1)!.requestId));}catch(e:any){if(!this.closed)this.mutate(id,pid,d=>({...d,state:'unknown',error:e.message}));}finally{this.busy.delete(id);}}
 async collect(id:string,pid:string,lease:string,receipt:ProviderReceipt){if(this.closed)return;let j=this.jobs.get(id,pid);if(j.data.attempts.at(-1)?.lease!==lease||['completed','cancelled'].includes(j.data.state))return;
  if(j.data.cancelRequested&&receipt.state==='completed'){this.mutate(id,pid,d=>({...d,state:'cancelled',attempts:d.attempts.map(a=>a.lease===lease?{...a,state:'cancelled',finishedAt:new Date().toISOString()}:a)}));return;}
  if(receipt.state==='completed'){ensure(receipt.path,'MEDIA_INVALID','Provider 没有输出文件');this.mutate(id,pid,d=>({...d,state:'collecting'}));const data=await this.files.import(receipt.path,j.data.title,`${j.data.intent.provider}:${j.data.intent.profile}`,receipt.sha256);const audio=receipt.nativeAudio?await this.files.import(receipt.nativeAudio.path,j.data.title+' · 原声',`${j.data.intent.provider}:native-audio`,receipt.nativeAudio.sha256):undefined;if(this.closed)return;
   this.store.transaction(()=>{j=this.jobs.get(id,pid);if(j.data.attempts.at(-1)?.lease!==lease||j.data.state==='completed')return;if(j.data.cancelRequested){this.jobs.save(id,pid,j.seq,{...j.data,state:'cancelled'});return;}const nativeAudio=audio?this.registerArtifact(pid,audio,j.data.owner.type==='experience'):undefined;const artifact=this.registerArtifact(pid,{...data,metadata:{...data.metadata,...(nativeAudio?{nativeAudio}:{})}},j.data.owner.type==='experience');const next=this.jobs.save(id,pid,j.seq,{...j.data,state:'completed',artifact,nativeAudio,error:undefined,metrics:receipt.metrics??{},attempts:j.data.attempts.map(a=>a.lease===lease?{...a,state:'completed',finishedAt:new Date().toISOString(),metrics:receipt.metrics??{}}:a)});this.notify(next);if(next.data.owner.type==='experience')this.onExperienceResult(next,artifact);else this.onResult(next,artifact);if(next.data.owner.type==='author')this.store.append({requestId:randomUUID(),projectId:pid,operation:'job.completed',payload:{id}},{source:'system'},{id,artifact});});
  }else this.mutate(id,pid,d=>({...d,state:receipt.state==='queued'?'running':receipt.state,error:receipt.error,metrics:receipt.metrics??d.metrics,attempts:d.attempts.map(a=>a.lease===lease?{...a,state:receipt.state==='queued'?'running':receipt.state,error:receipt.error}:a)}));
 }
 registerArtifact(pid:string,data:ArtifactData,privateMedia=false){const existing=this.artifacts.list(pid).find(a=>a.data.sha256===data.sha256&&(a.data.metadata.visibility==='experience')===privateMedia);const a=existing??this.artifacts.create(pid,{...data,metadata:{...data.metadata,...(privateMedia?{visibility:'experience'}:{})}});return this.artifacts.checkpoint(a.id,pid,a.seq);}
 async import(pid:string,path:string,title:string){this.store.repository('project',ProjectData).get(pid,pid);const data=await this.files.import(path,title,'用户导入');return this.store.transaction(()=>{const ref=this.registerArtifact(pid,data);this.store.append({requestId:randomUUID(),projectId:pid,operation:'artifact.import',payload:{title}},{source:'human'},ref);return ref;});}
 private async cancel(j:RecordState<JobData>){try{await this.providers.get(j.data.intent.provider)?.cancel(j.data.attempts.at(-1)!.requestId);if(j.data.state!=='cancelled')await this.reconcile(j.id,j.projectId);}catch(e:any){if(!this.closed)this.mutate(j.id,j.projectId,d=>({...d,state:'unknown',error:'取消未得到确认，请核对原任务'}));}}
 close(){this.closed=true;clearInterval(this.timer);for(const p of this.providers.values())p.close?.();}
}
function storeProject(store:Persistence,pid:string){return store.repository('project',ProjectData).get(pid,pid).data;}

export const countsProject=(provider:string)=>['ltx','h3','codex-image','seedance','wan','fal-h3'].includes(provider);
