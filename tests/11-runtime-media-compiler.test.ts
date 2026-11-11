import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStore} from '../packages/infra/sqlite.ts';
import {ProjectData,type Ref} from '../packages/contracts/foundation.ts';
import {ResourceData} from '../packages/contracts/creative.ts';
import {ScriptPlanData} from '../packages/contracts/interactive-script.ts';
import {ExperienceRun,RuntimeVisit,ScriptRelease,SegmentInstance} from '../packages/contracts/experience.ts';
import type {MediaProvider} from '../packages/contracts/production.ts';
import {cloudConstraints} from '../packages/contracts/cloud-video.ts';
import {CommandBus} from '../packages/core/foundation/commands.ts';
import {Production} from '../packages/core/modules/production.ts';
import {RuntimeMedia} from '../packages/core/experience/media.ts';
import {ExperienceRuntime} from '../packages/core/experience/runtime.ts';
import {contentHash} from '../packages/core/story/script.ts';
import {validateScript} from '../packages/core/story/validation.ts';

const fingerprint='c'.repeat(64);
function setup(options:{provider?:'h3'|'wan';cue?:boolean;frames?:boolean;resource?:boolean;silentFallback?:boolean;mutate?:(plan:any,script:any)=>void}={}){
 const root=mkdtempSync(join(tmpdir(),'dreamer-compiler-')),store=new SqliteStore(root),projectId=randomUUID(),scope={projectId,uid:'reader',runId:randomUUID()};
 store.repository('project',ProjectData).create(projectId,ProjectData.parse({title:'固定输入编译',generationLimit:20}),projectId);
 const providerId=options.provider??'h3',profile=providerId==='h3'?'h3-preview/v1':'720p';let submits=0;
 const provider:MediaProvider={describe:()=>({id:providerId,title:'测试Provider',available:true,detail:'no external calls',profiles:[profile],...(providerId==='wan'?{profileConstraints:{'720p':cloudConstraints('wan','720p')}}:{}),fingerprint,cost:'local',supports:{references:true,lastFrame:true,audio:true,final:false}}),async submit(){submits++;throw new Error('unexpected external execution');},async status(){return {state:'unknown'};},async cancel(){}};
 const resources=new Map<string,any>();
 const read=(ref:Ref):any=>{if(ref.kind==='artifact')return production.artifacts.at(ref,projectId);const data=resources.get(`${ref.kind}:${ref.id}:${ref.seq}`);assert.ok(data,`fixture ref ${ref.kind}`);return {id:ref.id,projectId,seq:ref.seq,data,updatedAt:new Date().toISOString()};};
 const production:Production=new Production(store,new CommandBus(store),{path:hash=>join(root,hash),async import(){throw new Error('fixture does not import');}},[provider],read,store.experience,false);production.experienceScope=()=>scope;
 const artifact=(mediaType:'image/png'|'video/mp4',hash:string)=>{const row=production.artifacts.create(projectId,{title:'fixed fixture',sha256:hash.repeat(64),sizeBytes:1,mediaType,source:'fixture',createdAt:new Date().toISOString(),metadata:{},...(mediaType==='video/mp4'?{durationSeconds:5,fps:30,metadata:{hasAudio:!options.silentFallback}}:{})});return production.artifacts.checkpoint(row.id,projectId,row.seq);};
 const start=artifact('image/png','a'),end=artifact('image/png','b'),video=artifact('video/mp4','d');
 const sceneRef:Ref={kind:'scene',id:randomUUID(),seq:1},resourceRef:Ref={kind:'resource',id:randomUUID(),seq:1},buildRef:Ref={kind:'build',id:randomUUID(),seq:1};
 resources.set(`scene:${sceneRef.id}:1`,{title:'作者场景',blocks:[]});
 resources.set(`resource:${resourceRef.id}:1`,ResourceData.parse({title:'守门人',type:'character',entityId:randomUUID(),description:'穿蓝色长袍，行动沉稳',requirements:'始终佩戴木牌',references:[{artifact:start,purpose:'appearance',selected:true}]}));
 resources.set(`build:${buildRef.id}:1`,{state:'completed',output:video,snapshot:{fps:24},range:{startFrame:0,endFrame:120}});
 const media={buildRef,fromFrame:0,toFrame:120,fps:24,contentHash:'d'.repeat(64)};
 const entry=randomUUID(),activity=randomUUID(),ending=randomUUID(),activityId=randomUUID(),instanceId=randomUUID(),visitId=randomUUID(),sceneId=randomUUID(),blockId=randomUUID(),shotId=randomUUID(),fallbackId=randomUUID();
 const constraints=providerId==='h3'?{width:320,height:576,fps:24,durationSeconds:124/24,audio:true,firstLastFrames:options.frames??false}:{...cloudConstraints('wan','720p'),firstLastFrames:options.frames??false};
 const frozen=Object.fromEntries(['width','height','fps','durationSeconds','audio','firstLastFrames'].map(key=>[key,(constraints as any)[key]]));
 const contract:any={id:randomUUID(),version:1,scope:'segment',reads:['trust'],narrativeGoal:'获准进门',allowedChanges:[{field:'dialogue',constraint:'保留结果'}],outcomeCases:[],fallbackOutcome:'enter',outcomes:[{id:'enter',narrativeRequirement:'获准进门',completionEffects:[{id:randomUUID(),op:'increment',key:'trust',value:{source:'constant',value:1},commitAt:'segmentCompleted'}]}],resourceRefs:options.resource?[resourceRef]:[],mediaReferences:options.frames?[{purpose:'start',artifact:start},{purpose:'end',artifact:end}]:[],boundFallbacks:[{id:fallbackId,outcomeId:'enter',entryConditions:[{op:'eq',key:'trust',value:0}],text:'守门人准许入内。',media}],limits:{maxCharacters:1000,maxScenes:1,maxShots:2,targetSeconds:5,maxTextCalls:2,maxMediaJobs:2,maxRepairAttempts:0},checks:{structure:true,independentContent:false,mediaReady:true}};
 const plan:any={schemaVersion:1,title:'媒体编译',chapterRefs:[],entryNodeId:entry,variables:[{key:'trust',label:'信任',type:'integer',scope:'run',initial:0,min:0,max:3,allowedWriters:[{sourceId:entry,commitAt:'segmentCompleted'}]}],nodes:[{id:entry,type:'segment',title:'动态城门',outlineOrder:0,mode:'generated',sourceSceneRefs:[sceneRef],next:activity,contentSpec:{mode:'generated',generationContract:contract}},{id:activity,type:'activity',title:'回应',outlineOrder:1,activityId,next:ending},{id:ending,type:'ending',title:'结束',outlineOrder:2,endingKey:'end',summary:'入城'}],activities:[{id:activityId,type:'choice',version:1,label:'回应',config:{options:[{id:'yes',label:'继续'},{id:'wait',label:'稍等'}]},presentation:{rendererKey:'choice',prompt:'继续？'},resultMapping:[]}],cues:options.cue?[{id:randomUUID(),segmentNodeId:entry,activityNodeId:activity,anchor:{ref:sceneRef,position:'after'},deadlineFrame:12,activateAt:'segmentEnd'}]:[],policy:{maxTextCallsPerRun:2,maxMediaJobsPerRun:4,maxShotsPerSegment:2,reviewMode:'authorReview',failurePolicy:'boundFallback',executionProfiles:[{provider:providerId,profile,quality:'draft',model:'fixture',configFingerprint:fingerprint,templateVersion:'v1',constraints:frozen}]}};
 const script:any={schemaVersion:1,instanceId,inputHash:'e'.repeat(64),outcomeId:'enter',timelineFps:24,scenes:[{id:sceneId,title:'守门人',location:'城门',time:'夜',blocks:[{id:blockId,type:'dialogue',text:'请带着木牌，从这里进去。',speaker:'守门人'}]}],sourceRefs:[sceneRef],usedVariables:[],assertedFacts:[],shotPlan:[{id:shotId,sceneId,goal:'获准进门',action:'守门人侧身让路',sound:'门轴吱呀作响',durationFrames:25,resourceRefs:options.resource?[resourceRef]:[],frameReferences:options.frames?[{purpose:'end',artifact:end},{purpose:'start',artifact:start}]:[],providerPrompts:{h3:'integrated_multimodal_description: 固定专用表演\noverall_soundscape: 风声\nnon_diegetic_music: N/A',wan:'Native portrait framing 320x576 at 24fps.\n守门人侧身说：<d>[Chinese]请带着木牌，从这里进去。</d>'}}],contentChecks:[]};
 options.mutate?.(plan,script);
 const snapshot=ScriptPlanData.parse(plan),now=new Date().toISOString(),release=ScriptRelease.parse({id:randomUUID(),projectId,scriptRef:{kind:'script',id:randomUUID(),seq:1},schemaVersion:1,kind:'playback',manifestHash:contentHash(snapshot),snapshot,dependencyRefs:[sceneRef,resourceRef,buildRef,start,end,video],activityVersions:[{type:'choice',version:1}],policy:snapshot.policy,generationAuthorization:{policyHash:contentHash(snapshot.policy),confirmedAt:now,source:'human'},createdAt:now});
 store.experience.create('releases',{projectId},release,release.id);
 const run=ExperienceRun.parse({id:scope.runId,projectId,uid:scope.uid,releaseId:release.id,manifestHash:release.manifestHash,mode:'playback',stateSeq:1,currentNodeId:entry,currentVisitId:visitId,status:'waitingContent',variables:{trust:0},historyCursor:0,createdAt:now,updatedAt:now});store.experience.create('runs',scope,run,run.id);
 store.experience.create('visits',scope,RuntimeVisit.parse({id:visitId,runId:run.id,nodeId:entry,status:'active',ordinal:0}),visitId);
 const instance=SegmentInstance.parse({id:instanceId,runId:run.id,nodeId:entry,visitId,inputHash:script.inputHash,releaseId:release.id,status:'producing',sourceRefs:[sceneRef],variableSnapshot:{trust:0},outcomeId:'enter',resultRevision:1,scriptResult:script});store.experience.create('instances',scope,instance,instanceId);
 const visit=store.experience.get<any>('visits',visitId,scope);store.experience.save('visits',visitId,scope,visit.seq,{...visit.data,instanceId});
 const runtime=new ExperienceRuntime(store.experience,read),compiler=new RuntimeMedia(store.experience,production,()=>20,{accept:(s,i)=>{runtime.acceptPreparedInternal(s,i);},fixed:(s,i,m)=>runtime.compileFixedInternal(s,i,m)},read);
 const current=()=>store.experience.get<SegmentInstance>('instances',instanceId,scope).data;
 const save=(patch:Partial<SegmentInstance>)=>{const row=store.experience.get<SegmentInstance>('instances',instanceId,scope);return store.experience.save('instances',instanceId,scope,row.seq,{...row.data,...patch}).data;};
 const prepare=()=>store.transaction(()=>compiler.prepare(scope,current()));
 const complete=()=>store.transaction(()=>{const jobs=production.jobs.list(projectId);for(const job of jobs)production.jobs.save(job.id,projectId,job.seq,{...job.data,state:'completed',artifact:video});compiler.complete(production.jobs.get(jobs[0]!.id,projectId));});
 return {root,store,production,compiler,runtime,scope,release,instance,current,save,prepare,complete,contract,sceneRef,start,end,video,resourceRef,fallbackId,counts:()=>submits,close(){production.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('11 S5 shared compiler keeps provider text, Chinese dialogue, frozen resource prose and explicit first/end frames',()=>{
 const x=setup({frames:true,resource:true});try{
  assert.equal(x.prepare().status,'producing');const job=x.production.jobs.list(x.scope.projectId)[0]!.data;
  assert.match(job.intent.prompt,/固定专用表演/);assert.match(job.intent.prompt,/请带着木牌，从这里进去。/);assert.match(job.intent.prompt,/蓝色长袍/);assert.match(job.intent.prompt,/始终佩戴木牌/);
  assert.deepEqual(job.intent.references,[x.start,x.end]);assert.equal(job.intent.constraints.firstLastFrames,true);assert.equal(x.counts(),0);
  assert.equal(x.store.experience.usage(x.scope).runMedia,1);
 }finally{x.close();}
});
test('11 S5 resource appearance stays textual; unapproved frame, lone end and missing dialogue allocation block before budget',()=>{
 const prose=setup({resource:true});try{prose.prepare();assert.deepEqual(prose.production.jobs.list(prose.scope.projectId)[0]!.data.intent.references,[]);}finally{prose.close();}
 for(const kind of ['unapproved','end','dialogue'] as const){const x=setup({frames:kind==='end',mutate(_plan,script){const shot=script.shotPlan[0];if(kind==='unapproved')shot.frameReferences=[{purpose:'start',artifact:{kind:'artifact',id:randomUUID(),seq:1}}];if(kind==='end')shot.frameReferences=shot.frameReferences.filter((frame:any)=>frame.purpose==='end');if(kind==='dialogue')script.shotPlan.push({...shot,id:randomUUID()});}});try{const blocked=x.prepare();assert.equal(blocked.status,'blocked');assert.match(blocked.recoveryReason!,kind==='unapproved'?/白名单/:kind==='end'?/单独尾帧/:/对白/);assert.equal(x.production.jobs.list(x.scope.projectId).length,0);assert.equal(x.store.experience.usage(x.scope).runMedia,0);}finally{x.close();}}
});
test('11 S5 provider input retains frozen location, time, non-dialogue scene detail and facts without mixing another scene',()=>{
 const x=setup({mutate(plan,script){
  script.scenes[0].location='城门下的暖黄灯笼旁';script.scenes[0].time='雨后的深夜';script.scenes[0].blocks.push({id:randomUUID(),type:'action',text:'旅人始终在画外，只见守门人侧身。',speaker:''});
  script.scenes.push({id:randomUUID(),title:'另一场景',location:'禁用的海滩',time:'中午',blocks:[{id:randomUUID(),type:'action',text:'不得混入的沙滩细节',speaker:''}]});
  plan.nodes[0].contentSpec.generationContract.fixedFacts=[{key:'lamp',text:'灯笼不熄灭',sourceRef:plan.nodes[0].sourceSceneRefs[0]}];
 }});try{x.prepare();const prompt=x.production.jobs.list(x.scope.projectId)[0]!.data.intent.prompt;for(const text of ['暖黄灯笼','雨后的深夜','旅人始终在画外','灯笼不熄灭'])assert.ok(prompt.includes(text),text);assert.ok(!prompt.includes('禁用的海滩'));assert.ok(!prompt.includes('不得混入的沙滩细节'));assert.equal(x.counts(),0);}finally{x.close();}
});
test('11 S5 cloud request rounds narrative frames to permitted integer seconds without changing dialogue or timeline fps',()=>{
 const x=setup({provider:'wan'});try{const prepared=x.prepare();assert.equal(prepared.status,'producing',prepared.recoveryReason);const intent=x.production.jobs.list(x.scope.projectId)[0]!.data.intent;assert.equal(intent.constraints.durationSeconds,2);assert.equal(intent.constraints.fps,30);assert.equal((intent.plan as any).timelineFps,24);assert.match(intent.prompt,/中文对白：“请带着木牌，从这里进去。”/);assert.ok(!intent.prompt.includes('320x576'));}finally{x.close();}
});
test('11 S5 dynamic Cue blocks viewer media until human binds actual plan; stale or out-of-range locations cannot become ready',()=>{
 const x=setup({cue:true});try{
  assert.ok(!validateScript(x.release.snapshot,{mode:'playback',readRef:ref=>ref.kind==='scene'?{blocks:[]}:ref.kind==='build'?{state:'completed',output:x.video}: {mediaType:'image/png'},capabilities:{runtimeText:true,runtimeMedia:true,activityVersions:['choice@1']}}).some(issue=>issue.severity==='error'));
  x.prepare();x.complete();let instance=x.current();assert.equal(instance.status,'blocked');assert.ok(instance.pendingPlaybackPlan);assert.equal(instance.playbackPlan,undefined);const plan=instance.pendingPlaybackPlan!,binding=plan.bindings[0]!,cue=x.release.snapshot.cues[0]!;
  assert.throws(()=>x.runtime.media(x.scope,x.scope.runId,plan.planHash,binding.id),/未授权/);assert.equal(x.compiler.preview(x.scope,{instanceId:instance.id,resultRevision:1,planHash:plan.planHash,bindingId:binding.id}).data.sha256,binding.contentHash);
  const input={uid:x.scope.uid,runId:x.scope.runId,instanceId:instance.id,resultRevision:1,expectedPlanHash:plan.planHash,cueId:cue.id,appearFrame:5,deadlineFrame:20,shotId:instance.scriptResult!.shotPlan[0]!.id};
  assert.throws(()=>x.store.transaction(()=>x.compiler.bindCue(x.scope,{...input,expectedPlanHash:'f'.repeat(64)})),/版本/);assert.throws(()=>x.store.transaction(()=>x.compiler.bindCue(x.scope,{...input,deadlineFrame:26})),/实际片段/);
  x.store.transaction(()=>x.compiler.bindCue(x.scope,input));instance=x.current();assert.equal(instance.status,'ready');assert.equal(instance.pendingPlaybackPlan,undefined);assert.equal(instance.playbackPlan!.cues[0]!.resolvedBinding!.appearFrame,5);
  let view=x.runtime.view(x.scope,x.scope.runId);view=x.runtime.positionSave(x.scope,{protocolVersion:1,requestId:randomUUID(),runId:x.scope.runId,visitId:view.run.currentVisitId,planHash:view.playback!.planHash,frame:24,expectedPositionSeq:0}).view;assert.ok(view.attempt);assert.equal(view.position!.frame,20);
  assert.throws(()=>x.store.transaction(()=>x.compiler.bindCue(x.scope,{...input,appearFrame:7})),/版本/);assert.equal(x.counts(),0);
 }finally{x.close();}
});
test('11 S5 same-outcome fallback is explicit, checks entry and unknown work, commits no effects and refunds no spent budget',()=>{
 const x=setup();try{
  x.save({status:'blocked'});const input={uid:x.scope.uid,runId:x.scope.runId,instanceId:x.instance.id,expectedInputHash:x.instance.inputHash,fallbackId:x.fallbackId};
  const run=x.store.experience.get<ExperienceRun>('runs',x.scope.runId,x.scope);x.store.experience.save('runs',run.id,x.scope,run.seq,{...run.data,variables:{trust:1}});assert.throws(()=>x.store.transaction(()=>x.compiler.useFallback(x.scope,input)),/衔接/);const changed=x.store.experience.get<ExperienceRun>('runs',run.id,x.scope);x.store.experience.save('runs',run.id,x.scope,changed.seq,{...changed.data,variables:{trust:0}});
  const dispatch=x.store.experience.create('dispatches',x.scope,{requestId:randomUUID(),ownerKey:`instance:${x.instance.id}`,owner:{type:'segmentInstance',instanceId:x.instance.id},stage:'write',attemptNo:1,state:'unknown'});
  assert.throws(()=>x.store.transaction(()=>x.compiler.useFallback(x.scope,input)),/尚未确认/);x.store.experience.save('dispatches',dispatch.id,x.scope,dispatch.seq,{...dispatch.data,state:'failed'});
  x.store.experience.create('reservations',x.scope,{requestId:randomUUID(),ownerKey:`instance:${x.instance.id}`,stage:'media',attemptNo:1,unit:'media',countsProject:true,state:'failed',source:'runtime',provider:'h3'});
  x.store.transaction(()=>x.compiler.useFallback(x.scope,input));const instance=x.current();assert.equal(instance.status,'ready');assert.equal(instance.resultRevision,2);assert.equal(instance.outcomeId,'enter');assert.equal(instance.fallbackResult!.text,'守门人准许入内。');assert.equal(x.runtime.view(x.scope,x.scope.runId).run.variables.trust,0);assert.equal(x.store.experience.list('results',x.scope).length,1);assert.equal(x.production.jobs.list(x.scope.projectId).length,0);assert.equal(x.counts(),0);
  assert.equal(x.store.experience.usage(x.scope).runMedia,1);assert.equal(x.store.experience.usage(x.scope).projectMedia,1);
  assert.throws(()=>x.store.transaction(()=>x.compiler.useFallback(x.scope,input)),/原实例/);
 }finally{x.close();}
});

test('11 S5 fallback cannot select a different published outcome or silently remove required native audio',()=>{
 const x=setup({mutate(plan){plan.nodes[0].contentSpec.generationContract.outcomes.push({id:'leave',narrativeRequirement:'离开'});plan.nodes[0].contentSpec.generationContract.boundFallbacks[0].outcomeId='leave';}});
 try{x.save({status:'blocked'});assert.throws(()=>x.store.transaction(()=>x.compiler.useFallback(x.scope,{uid:x.scope.uid,runId:x.scope.runId,instanceId:x.instance.id,expectedInputHash:x.instance.inputHash,fallbackId:x.fallbackId})),/同一叙事结果/);assert.equal(x.current().status,'blocked');assert.equal(x.store.experience.list('results',x.scope).length,0);}finally{x.close();}
 const silent=setup({silentFallback:true});try{silent.save({status:'blocked'});assert.throws(()=>silent.store.transaction(()=>silent.compiler.useFallback(silent.scope,{uid:silent.scope.uid,runId:silent.scope.runId,instanceId:silent.instance.id,expectedInputHash:silent.instance.inputHash,fallbackId:silent.fallbackId})),/原生音轨/);assert.equal(silent.store.experience.list('results',silent.scope).length,0);}finally{silent.close();}
});

test('11 S5 completed but invalid actual media stays a known blocked result and does not masquerade as unknown work',()=>{
 const x=setup({silentFallback:true});try{x.prepare();x.complete();assert.equal(x.current().status,'blocked');assert.match(x.current().recoveryReason!,/原生音轨/);assert.equal(x.current().playbackPlan,undefined);assert.equal(x.production.jobs.list(x.scope.projectId)[0]!.data.state,'completed');assert.equal(x.store.experience.list('mediaLinks',x.scope).length,0);assert.equal(x.counts(),0);}finally{x.close();}
});

test('11 S5 publish validation rejects estimated dynamic cue bindings and undeclared fallback condition reads',()=>{
 const x=setup({cue:true});try{
  const estimated=structuredClone(x.release.snapshot);estimated.cues[0]!.resolvedBinding={planId:randomUUID(),contentHash:'f'.repeat(64),fps:24,appearFrame:5};assert.ok(validateScript(estimated).some(issue=>issue.ruleId==='ANCHOR_RUNTIME_STALE'));
  const undeclared=structuredClone(x.release.snapshot),node=undeclared.nodes[0]!;if(node.type!=='segment'||node.contentSpec.mode!=='generated')return;node.contentSpec.generationContract.reads=[];
  assert.ok(validateScript(undeclared).some(issue=>issue.ruleId==='READ_NOT_DECLARED'&&issue.message.includes('后备')));
 }finally{x.close();}
});
