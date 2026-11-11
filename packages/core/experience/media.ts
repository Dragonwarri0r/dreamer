import { randomUUID } from 'node:crypto';
import { DomainError, ensure, stable, type RecordState, type Ref } from '../../contracts/foundation.ts';
import { PlayableSegment, SegmentInstance, InstanceCueBinding, InstanceFallback, type ExperienceRun, type ScriptRelease, type SegmentScriptV1 } from '../../contracts/experience.ts';
import { RenderIntent, type JobData } from '../../contracts/production.ts';
import { ResourceData } from '../../contracts/creative.ts';
import { runtimeProductionPrompt } from '../../contracts/production-input.ts';
import { isCloudVideo } from '../../contracts/cloud-video.ts';
import type { FixedMedia } from '../../contracts/interactive-script.ts';
import { Production, countsProject } from '../modules/production.ts';
import { contentHash } from '../story/script.ts';
import { evaluateCondition } from '../story/rules.ts';
import type { ReferenceReader } from '../modules/authoring.ts';
import type { ExperiencePersistence, RunScope } from './ports.ts';

type Callbacks = { accept(scope: RunScope, instance: SegmentInstance): void; fixed(scope: RunScope, instance: SegmentInstance, media: FixedMedia): PlayableSegment };
/** All public methods run in the caller's transaction. Only Production talks to media Providers. */
export class RuntimeMedia {
  constructor(private store: ExperiencePersistence, private production: Production, private projectLimit: (pid: string) => number, private callbacks: Callbacks, private read?: ReferenceReader) {}
  prepare(scope: RunScope, instance: SegmentInstance): SegmentInstance {
    if (instance.status !== 'producing') return instance;
    if (instance.cancelRequested) return { ...instance, status: 'cancelled' };
    let plan: ReturnType<RuntimeMedia['preflight']>;
    try { plan = this.preflight(scope, instance); }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return SegmentInstance.parse({ ...instance, status: 'blocked', recoveryReason: error.message,
        checks: [...instance.checks, { id: randomUUID(), stage: 'media', status: 'failed', message: error.message }] });
    }
    if (plan.kind === 'existing') return instance;
    // All persistence begins after preflight. Unexpected write failures escape and roll back the caller's transaction.
    if (plan.kind === 'fixed') {
      const playbackPlan = this.callbacks.fixed(scope, instance, plan.media);
      return SegmentInstance.parse({ ...instance, status: 'ready', playbackPlan, mediaRefs: playbackPlan.bindings.map(b => b.artifactRef) });
    }
    const { intents, release } = plan;
    const reservations = intents.map(({ shot, input }) => this.store.reserve(scope, {
      requestId: randomUUID(), ownerKey: `instance:${instance.id}:shot:${shot.id}`, stage: 'media', attemptNo: 1,
      unit: 'media', countsProject: countsProject(input.provider), state: 'reserved', source: 'runtime', provider: input.provider,
    }, { projectMedia: this.projectLimit(scope.projectId), runMedia: release.policy.maxMediaJobsPerRun, runText: release.policy.maxTextCallsPerRun }));
    intents.forEach(({ shot, input }, index) => this.production.enqueue(scope.projectId, input, undefined, {
      owner: { type: 'experience', runId: scope.runId, instanceId: instance.id, component: shot.id }, scope, reservationId: reservations[index].id,
    }));
    this.store.append(scope, 'instance.mediaQueued', { instanceId: instance.id, jobs: intents.length }); return instance;
  }
  private preflight(scope: RunScope, instance: SegmentInstance) {
    const run = this.store.get<ExperienceRun>('runs', scope.runId, scope).data;
    const release = this.store.get<ScriptRelease>('releases', run.releaseId, { projectId: scope.projectId }).data;
    ensure(run.mode === 'playback' && !run.restoreBlocked && !['abandoned', 'completed'].includes(run.status), 'FORBIDDEN', '此体验不能派发媒体');
    if (instance.templateResult?.media) return { kind: 'fixed' as const, media: instance.templateResult.media };
    ensure(release.generationAuthorization?.policyHash === contentHash(release.policy), 'FORBIDDEN', '媒体生成没有发布授权');
    const node = release.snapshot.nodes.find(n => n.id === instance.nodeId);
    ensure(node?.type === 'segment' && node.contentSpec.mode !== 'fixed' && node.contentSpec.generationContract, 'VALIDATION', '没有冻结的媒体生成规范');
    const contract = node.contentSpec.generationContract, script = instance.scriptResult;
    ensure(script && instance.resultRevision, 'VALIDATION', '应先完成正文检查');
    ensure(!instance.checks.some(c => c.status === 'failed' && (c.resultRevision === undefined || c.resultRevision === instance.resultRevision)), 'VALIDATION', '尚有未通过的当前正文检查');
    const profile = release.policy.executionProfiles[0]; ensure(profile, 'UNSUPPORTED', '请选择并发布一个明确的媒体执行规格');
    const capability = this.production.capabilities().find(c => c.id === profile.provider);
    ensure(capability?.available && capability.fingerprint === profile.configFingerprint && capability.profiles.includes(profile.profile), 'UNSUPPORTED', '冻结的媒体配置已变化或本地模型未就绪');
    ensure(capability.profileConstraints?.[profile.profile], 'UNSUPPORTED', '此媒体规格没有可校验的约束');
    ensure(['width', 'height', 'fps', 'durationSeconds', 'audio', 'firstLastFrames'].every(key => Object.hasOwn(profile.constraints, key)), 'VALIDATION', '发布媒体规格缺少冻结的尺寸、时长或音频约束');
    const parsedConstraints = RenderIntent.shape.constraints.safeParse(profile.constraints);
    ensure(parsedConstraints.success, 'VALIDATION', '发布媒体规格的冻结约束无效');
    const constraints = parsedConstraints.data;
    ensure(script.shotPlan.length <= Math.min(contract.limits.maxShots, release.policy.maxShotsPerSegment, contract.limits.maxMediaJobs), 'FORBIDDEN', '媒体计划超过本段限制');
    if (this.jobs(scope, instance.id).length) return { kind: 'existing' as const };
    const dialogue = this.dialogue(script), approvedFrames = new Set((contract.mediaReferences??[]).map(ref => stable(ref))), dependencyRefs = new Set(release.dependencyRefs.map(ref => stable(ref)));
    const intents = script.shotPlan.map(shot => {
      const scene = script.scenes.find(item => item.id === shot.sceneId)!;
      const seconds = shot.durationFrames / script.timelineFps;
      ensure(seconds <= constraints.durationSeconds + 1 / script.timelineFps, 'VALIDATION', '镜头长度超过发布的生成规格；不能截断或拼接伪造正文');
      const resources = shot.resourceRefs.map(ref => {
        ensure(ref.kind === 'resource' && contract.resourceRefs.some(allowed => stable(allowed) === stable(ref)) && dependencyRefs.has(stable(ref)), 'FORBIDDEN', '镜头资源不属于固定发布依赖');
        ensure(this.read, 'UNSUPPORTED', '固定资源读取器未接入');
        const resource = ResourceData.parse(this.read(ref, scope.projectId).data);
        return { title: resource.title, type: resource.type, description: resource.description, requirements: resource.requirements };
      });
      const frames = shot.frameReferences ?? [];
      ensure(frames.every(ref => approvedFrames.has(stable(ref)) && dependencyRefs.has(stable(ref.artifact))), 'FORBIDDEN', '镜头首尾帧不在作者发布的明确绑定白名单');
      ensure(new Set(frames.map(ref => ref.purpose)).size === frames.length, 'VALIDATION', '镜头不能绑定多个首帧或尾帧');
      const start = frames.find(ref => ref.purpose === 'start'), end = frames.find(ref => ref.purpose === 'end');
      ensure(!end || start, 'VALIDATION', '单独尾帧不能冒充首帧');
      const references = start ? [start.artifact, ...(end ? [end.artifact] : [])] : [];
      ensure(constraints.firstLastFrames === Boolean(start && end), 'VALIDATION', '实际首尾帧绑定与冻结执行规格不一致');
      const profileConstraints = capability.profileConstraints![profile.profile];
      const durationSeconds = isCloudVideo(profile.provider) ? Math.max(profileConstraints.durationRange?.[0] ?? 1, Math.ceil(seconds)) : constraints.durationSeconds;
      ensure(durationSeconds <= constraints.durationSeconds && durationSeconds <= (profileConstraints.durationRange?.[1] ?? constraints.durationSeconds), 'VALIDATION', '镜头目标时长无法在发布授权的 Provider 范围内生成');
      const input = RenderIntent.parse({ provider: profile.provider, profile: profile.profile, quality: profile.quality,
        prompt: runtimeProductionPrompt({provider:profile.provider,goal:shot.goal,action:shot.action,sound:shot.sound,providerPrompts:shot.providerPrompts,dialogue:dialogue.get(shot.id) ?? [],resources,
          sceneContext:{location:scene.location,time:scene.time,blocks:scene.blocks.filter(block=>block.type!=='dialogue').map(block=>({type:block.type,text:block.text}))},
          fixedFacts:contract.fixedFacts.map(fact=>({key:fact.key,text:fact.text}))}), references,
        constraints:{...constraints,durationSeconds}, plan:{schemaVersion:1,instanceId:instance.id,resultRevision:instance.resultRevision,shotId:shot.id,timelineFps:script.timelineFps,durationFrames:shot.durationFrames,resourceRefs:shot.resourceRefs,frameReferences:frames} });
      this.production.validate(scope.projectId, input, false); return { shot, input };
    });
    const usage = this.store.usage(scope), count = intents.filter(i => countsProject(i.input.provider)).length;
    ensure(usage.runMedia + intents.length <= release.policy.maxMediaJobsPerRun && usage.projectMedia + count <= this.projectLimit(scope.projectId), 'FORBIDDEN', '本次媒体计划超过剩余额度，尚未派发');
    return { kind: 'generate' as const, intents, release };
  }
  private dialogue(script:SegmentScriptV1){
    const output=new Map<string,{speaker:string;text:string}[]>(),used=new Set<string>();
    for(const shot of script.shotPlan){
      const scene=script.scenes.find(scene=>scene.id===shot.sceneId);ensure(scene,'VALIDATION','镜头场景不存在');
      const spoken=scene.blocks.filter(block=>block.type==='dialogue'),ids=shot.dialogueBlockIds??(script.shotPlan.filter(item=>item.sceneId===shot.sceneId).length===1?spoken.map(block=>block.id):[]);
      const blocks=ids.map(id=>{const block=spoken.find(block=>block.id===id);ensure(block&&!used.has(id),'VALIDATION','对白镜头映射重复或引用了其他场景');used.add(id);return {speaker:block.speaker,text:block.text};});
      output.set(shot.id,blocks);
    }
    ensure(script.scenes.flatMap(scene=>scene.blocks).filter(block=>block.type==='dialogue').every(block=>used.has(block.id)),'VALIDATION','多镜头必须明确每句原文对白的归属，不能遗漏或重复');
    return output;
  }
  private jobs(scope:RunScope,instanceId:string){return this.production.jobs.list(scope.projectId).filter(j=>j.data.owner.type==='experience'&&j.data.owner.runId===scope.runId&&j.data.owner.instanceId===instanceId);}
  state(job:RecordState<JobData>){
    if(job.data.owner.type!=='experience')return;
    const row=this.store.lookupRun<ExperienceRun>(job.projectId,job.data.owner.runId);if(!row)return;
    const scope={projectId:job.projectId,uid:row.data.uid,runId:row.id},instance=this.store.get<SegmentInstance>('instances',job.data.owner.instanceId,scope).data;
    if(['consumed','cancelled','stale','ready'].includes(instance.status)||row.data.status==='abandoned')return;
    if(instance.cancelRequested){const complete=this.jobs(scope,instance.id).every(j=>['completed','failed','cancelled'].includes(j.data.state));this.callbacks.accept(scope,{...instance,status:complete?'cancelled':'unknown',recoveryReason:complete?'原媒体任务已确认停止，本次体验不再接收结果':'取消结果尚未确认，只能核对原媒体任务'});return;}
    if(['failed','cancelled','unknown'].includes(job.data.state))this.callbacks.accept(scope,{...instance,status:job.data.state==='unknown'?'unknown':'blocked',recoveryReason:job.data.error??'媒体任务尚未完成',checks:[...instance.checks.filter(c=>c.stage!=='media'),{id:randomUUID(),stage:'media',status:job.data.state==='unknown'?'pending':'failed',message:job.data.error??'媒体任务尚未完成'}]});
  }
  complete(job:RecordState<JobData>){
    if(job.data.owner.type!=='experience')return;
    const row=this.store.lookupRun<ExperienceRun>(job.projectId,job.data.owner.runId);if(!row)return;
    const scope={projectId:job.projectId,uid:row.data.uid,runId:row.id},instance=this.store.get<SegmentInstance>('instances',job.data.owner.instanceId,scope).data;
    if(['consumed','cancelled','stale','ready'].includes(instance.status)||instance.pendingPlaybackPlan||instance.cancelRequested||row.data.status==='abandoned')return;
    const shots=instance.scriptResult?.shotPlan;ensure(shots,'VALIDATION','缺少固定镜头计划');
    const all=this.jobs(scope,instance.id),jobs=shots.map(shot=>all.filter(j=>j.data.owner.type==='experience'&&j.data.owner.component===shot.id).at(-1));
    if(jobs.some(j=>!j||j.data.state!=='completed'||!j.data.artifact))return;
    let plan:PlayableSegment;
    try{
      let atFrame=0;const fps=instance.scriptResult!.timelineFps;
      const bindings=jobs.map((job,index)=>{const ref=job!.data.artifact!,artifact=this.production.artifacts.at(ref,scope.projectId).data,shot=shots[index];
        ensure(artifact.mediaType==='video/mp4'&&artifact.durationSeconds&&artifact.fps,'MEDIA_INVALID','实际视频缺少时长或帧率证据');
        ensure(shot.durationFrames/fps<=artifact.durationSeconds+1/Math.max(fps,artifact.fps),'MEDIA_INVALID','实际视频不足以覆盖片段');
        ensure(!job!.data.intent.constraints.audio||artifact.metadata.hasAudio===true,'MEDIA_INVALID','实际视频缺少规定的原生音轨');
        const binding={id:randomUUID(),artifactRef:ref,contentHash:artifact.sha256,kind:'video' as const,atFrame,durationFrames:shot.durationFrames,sourceInFrame:0,sourceFps:artifact.fps,nativeAudio:artifact.metadata.hasAudio===true};atFrame+=shot.durationFrames;return binding;});
      const base={id:randomUUID(),fps,durationFrames:atFrame,bindings,cues:[]};plan=PlayableSegment.parse({...base,planHash:contentHash(base)});
    }catch(error){
      if(!(error instanceof DomainError))throw error;
      this.callbacks.accept(scope,{...instance,status:'blocked',recoveryReason:error.message,checks:[...instance.checks,{id:randomUUID(),stage:'media',status:'failed',resultRevision:instance.resultRevision,message:error.message}]});return;
    }
    this.finishPlan(scope,instance,plan);
  }
  private finishPlan(scope:RunScope,instance:SegmentInstance,plan:PlayableSegment){
    const release=this.store.get<ScriptRelease>('releases',instance.releaseId,{projectId:scope.projectId}).data;
    if(release.snapshot.cues.some(cue=>cue.segmentNodeId===instance.nodeId)&&!plan.cues.length){
      const pending=SegmentInstance.parse({...instance,status:'blocked',pendingPlaybackPlan:plan,mediaRefs:plan.bindings.map(binding=>binding.artifactRef),recoveryReason:'媒体已完成，等待作者定位本次实例的互动时码',checks:[...instance.checks.filter(check=>check.stage!=='media'),{id:randomUUID(),stage:'media',status:'pending',resultRevision:instance.resultRevision,planHash:plan.planHash,message:'实际媒体已核对；互动锚点尚未定位'}]});
      this.callbacks.accept(scope,pending);return pending;
    }
    for(const binding of plan.bindings)this.store.create('mediaLinks',scope,{instanceId:instance.id,bindingId:binding.id,planHash:plan.planHash,artifactRef:binding.artifactRef,sha256:binding.contentHash,purpose:'video'});
    const ready=SegmentInstance.parse({...instance,status:'ready',pendingPlaybackPlan:undefined,recoveryReason:undefined,playbackPlan:plan,mediaRefs:plan.bindings.map(binding=>binding.artifactRef),checks:[...instance.checks.filter(check=>check.stage!=='media'),{id:randomUUID(),stage:'media',status:'passed',resultRevision:instance.resultRevision,planHash:plan.planHash,message:'实际时长、帧率、音轨与互动绑定已核对'}]});
    this.callbacks.accept(scope,ready);return ready;
  }
  /** Human-only preview endpoint must authenticate the author before calling this scoped method. */
  preview(scope:RunScope,input:{instanceId:string;resultRevision:number;planHash:string;bindingId:string}){
    const instance=this.store.get<SegmentInstance>('instances',input.instanceId,scope).data,plan=instance.pendingPlaybackPlan;
    ensure(instance.status==='blocked'&&instance.resultRevision===input.resultRevision&&plan?.planHash===input.planHash,'CONFLICT','待定位媒体版本已变化');
    const binding=plan.bindings.find(binding=>binding.id===input.bindingId);ensure(binding,'NOT_FOUND','待定位素材不属于此计划');
    const artifact=this.production.artifacts.at(binding.artifactRef,scope.projectId);ensure(artifact.data.sha256===binding.contentHash,'MEDIA_INVALID','待定位素材内容已变化');return artifact;
  }
  /** Caller owns the transaction and human authorization. No model or media job is created. */
  bindCue(scope:RunScope,raw:InstanceCueBinding){
    const input=InstanceCueBinding.parse(raw);ensure(input.uid===scope.uid&&input.runId===scope.runId,'FORBIDDEN','互动定位范围不匹配');
    const instance=this.store.get<SegmentInstance>('instances',input.instanceId,scope).data,plan=instance.pendingPlaybackPlan;
    const run=this.store.get<ExperienceRun>('runs',scope.runId,scope).data;
    ensure(!['abandoned','completed'].includes(run.status)&&!instance.cancelRequested&&!instance.restoreBlocked,'FORBIDDEN','此实例不能定位互动');
    ensure(instance.status==='blocked'&&instance.resultRevision===input.resultRevision&&plan?.planHash===input.expectedPlanHash,'CONFLICT','实例正文或实际媒体版本已变化');
    const release=this.store.get<ScriptRelease>('releases',instance.releaseId,{projectId:scope.projectId}).data,cue=release.snapshot.cues.find(cue=>cue.id===input.cueId&&cue.segmentNodeId===instance.nodeId);
    ensure(cue,'NOT_FOUND','Cue不属于本次固定节点');
    ensure(input.appearFrame<=input.deadlineFrame&&input.deadlineFrame<plan.durationFrames,'VALIDATION','互动时码必须在实际片段范围内');
    ensure(!instance.fallbackResult||!input.shotId&&!input.blockId,'VALIDATION','固定后备只能在实际媒体定位，不能使用未播放生成稿的镜头或正文块');
    if(input.shotId){
      const shots=instance.scriptResult?.shotPlan??[];let start=0;const shot=shots.find(shot=>{if(shot.id===input.shotId)return true;start+=shot.durationFrames;return false;});
      ensure(shot&&input.appearFrame>=start&&input.appearFrame<=start+shot.durationFrames,'VALIDATION','互动出现位置不属于所选镜头');
      if(input.blockId)ensure(instance.scriptResult?.scenes.find(scene=>scene.id===shot.sceneId)?.blocks.some(block=>block.id===input.blockId),'VALIDATION','正文块不属于所选镜头场景');
    }else if(input.blockId)ensure(instance.scriptResult?.scenes.some(scene=>scene.blocks.some(block=>block.id===input.blockId)),'VALIDATION','实例正文块不存在');
    const planContentHash=contentHash({fps:plan.fps,durationFrames:plan.durationFrames,bindings:plan.bindings});
    const resolved={...cue,deadlineFrame:input.deadlineFrame,resolvedBinding:{releaseId:release.id,planId:plan.id,contentHash:planContentHash,fps:plan.fps,appearFrame:input.appearFrame}};
    const {planHash:_pending,...base}=plan,playbackPlan=PlayableSegment.parse({...base,cues:[resolved],planHash:contentHash({...base,cues:[resolved]})});
    const next={...instance,cueResolutions:[{cueId:cue.id,resultRevision:input.resultRevision,planContentHash,appearFrame:input.appearFrame,deadlineFrame:input.deadlineFrame,source:'author' as const,shotId:input.shotId,blockId:input.blockId}]};
    this.store.append(scope,'instance.cueBound',{instanceId:instance.id,cueId:cue.id,resultRevision:input.resultRevision,planHash:playbackPlan.planHash});
    return this.finishPlan(scope,next,playbackPlan);
  }
  useFallback(scope:RunScope,raw:InstanceFallback){
    const input=InstanceFallback.parse(raw);ensure(input.uid===scope.uid&&input.runId===scope.runId,'FORBIDDEN','后备内容范围不匹配');
    const instance=this.store.get<SegmentInstance>('instances',input.instanceId,scope).data,run=this.store.get<ExperienceRun>('runs',scope.runId,scope).data;
    ensure(instance.status==='blocked'&&instance.inputHash===input.expectedInputHash&&!instance.pendingPlaybackPlan&&!instance.fallbackResult&&!instance.cancelRequested&&!instance.restoreBlocked&&!run.restoreBlocked&&!['completed','abandoned'].includes(run.status),'CONFLICT','只有已确认失败且尚未播放的原实例可选后备');
    ensure(!this.jobs(scope,instance.id).some(job=>['queued','running','collecting','unknown'].includes(job.data.state))&&!this.store.list<any>('dispatches',scope).some(row=>row.data.owner?.instanceId===instance.id&&['queued','dispatched','unknown'].includes(row.data.state)),'UNKNOWN_OUTCOME','原执行尚未确认，不能改用后备');
    const release=this.store.get<ScriptRelease>('releases',instance.releaseId,{projectId:scope.projectId}).data,node=release.snapshot.nodes.find(node=>node.id===instance.nodeId),contract=node?.type==='segment'&&node.contentSpec.mode!=='fixed'?node.contentSpec.generationContract:undefined;
    const fallback=contract?.boundFallbacks?.find(fallback=>fallback.id===input.fallbackId);
    ensure(release.policy.failurePolicy==='boundFallback'&&contract&&fallback&&fallback.outcomeId===instance.outcomeId,'FORBIDDEN','后备未在发布时绑定同一叙事结果');
    ensure([...contract.entryConditions,...fallback.entryConditions].every(condition=>evaluateCondition(condition,run.variables,release.snapshot.variables)),'CONFLICT','后备内容衔接条件不满足');
    ensure(this.read,'UNSUPPORTED','固定后备媒体读取器未接入');
    const media=fallback.media,build=this.read(media.buildRef,scope.projectId).data;ensure(build.output,'MEDIA_INVALID','固定后备缺少已生成Build');
    const artifact=this.production.artifacts.at(build.output,scope.projectId).data;
    ensure(artifact.mediaType==='video/mp4'&&artifact.sha256===media.contentHash&&build.snapshot.fps===media.fps&&media.toFrame<=build.range.endFrame-build.range.startFrame&&artifact.durationSeconds&&media.toFrame/media.fps<=artifact.durationSeconds+1/media.fps,'MEDIA_INVALID','固定后备的内容或实际范围无效');
    ensure(!release.policy.executionProfiles[0]?.constraints.audio||artifact.metadata.hasAudio===true,'MEDIA_INVALID','固定后备不能删除发布规格要求的原生音轨');
    const resultRevision=(instance.resultRevision??0)+1,fallbackResult={id:fallback.id,outcomeId:fallback.outcomeId,text:fallback.text,media,contentHash:contentHash({text:fallback.text,media}),previousResultRevision:instance.resultRevision};
    const binding={id:randomUUID(),artifactRef:build.output as Ref,contentHash:media.contentHash,kind:'video' as const,atFrame:0,durationFrames:media.toFrame-media.fromFrame,sourceInFrame:media.fromFrame,sourceFps:media.fps,nativeAudio:artifact.metadata.hasAudio===true};
    const base={id:randomUUID(),fps:media.fps,durationFrames:binding.durationFrames,bindings:[binding],cues:[]};
    this.store.create('results',scope,{instanceId:instance.id,resultRevision,contentHash:fallbackResult.contentHash,fallback:fallbackResult});
    this.store.append(scope,'instance.fallbackSelected',{instanceId:instance.id,fallbackId:fallback.id,outcomeId:instance.outcomeId,resultRevision});
    return this.finishPlan(scope,{...instance,resultRevision,fallbackResult,pendingPlaybackPlan:undefined},PlayableSegment.parse({...base,planHash:contentHash(base)}));
  }
  command(scope:RunScope,instance:SegmentInstance,operation:string,stage?:string):SegmentInstance{
    const jobs=this.jobs(scope,instance.id);
    if(operation==='instance.reconcile'){for(const job of jobs.filter(j=>['unknown','running','collecting'].includes(j.data.state)))queueMicrotask(()=>void this.production.reconcile(job.id,scope.projectId));return instance;}
    if(operation==='instance.cancel'){
      const pending=jobs.filter(j=>!['completed','failed','cancelled'].includes(j.data.state));
      const needsConfirmation=pending.some(j=>j.data.state!=='queued');
      for(const job of pending)this.production.cancelExperience(job.id,scope.projectId,false);
      return {...instance,cancelRequested:true,status:needsConfirmation?'unknown':'cancelled',recoveryReason:needsConfirmation?'取消结果尚未确认，只能核对原媒体任务':'已取消尚未派发的媒体'};
    }
    ensure(operation==='instance.retry'&&stage==='producing'&&instance.status==='blocked','CONFLICT','仅明确失败的媒体可以显式重试');
    const run=this.store.get<ExperienceRun>('runs',scope.runId,scope).data,release=this.store.get<ScriptRelease>('releases',run.releaseId,{projectId:scope.projectId}).data;
    ensure(!run.restoreBlocked,'FORBIDDEN','恢复的任务应先核对原执行');
    const latest=new Map(jobs.map(j=>[j.data.owner.type==='experience'?j.data.owner.component:'',j]));
    ensure([...latest.values()].some(j=>['failed','cancelled'].includes(j.data.state))&&!jobs.some(j=>['unknown','running','collecting','queued'].includes(j.data.state)),'CONFLICT','未知结果不能重试');
    const node=release.snapshot.nodes.find(n=>n.id===instance.nodeId),contract=node?.type==='segment'&&node.contentSpec.mode!=='fixed'?node.contentSpec.generationContract:undefined;
    ensure(contract&&jobs.length+[...latest.values()].filter(j=>['failed','cancelled'].includes(j.data.state)).length<=contract.limits.maxMediaJobs,'FORBIDDEN','媒体重试超过本段已发布的调用上限');
    for(const job of latest.values())if(['failed','cancelled'].includes(job.data.state)){
      ensure(!job.data.retryOf,'FORBIDDEN','本次镜头已显式重试过');
      const owner=job.data.owner;ensure(owner.type==='experience','INTERNAL','体验任务归属不匹配');
      const reservation=this.store.reserve(scope,{requestId:randomUUID(),ownerKey:`instance:${instance.id}:shot:${owner.component}`,stage:'media',attemptNo:2,unit:'media',countsProject:countsProject(job.data.intent.provider),state:'reserved',source:'runtime',provider:job.data.intent.provider},{projectMedia:this.projectLimit(scope.projectId),runMedia:release.policy.maxMediaJobsPerRun});
      this.production.enqueue(scope.projectId,job.data.intent,job.id,{owner,scope,reservationId:reservation.id});
    }
    return {...instance,status:'producing',recoveryReason:undefined};
  }
}
