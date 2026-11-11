import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fixture,until} from './helpers.ts';
import type {MediaProvider} from '../packages/contracts/production.ts';
import type {RuntimeTextGenerator,RuntimeTextRequest} from '../packages/core/experience/generation.ts';
import {ScriptPlanData} from '../packages/contracts/interactive-script.ts';
import {execute,mediaBinary} from '../packages/infra/media.ts';
import {schemaRegistry} from '../packages/core/schema-registry.ts';
const fingerprint='d'.repeat(64);
function harness(budget=1){
 let mediaPath='',submits=0,writes=0;
 const provider:MediaProvider={describe:()=>({id:'h3',title:'本地替身',available:true,detail:'测试，不运行模型',profiles:['h3-preview/v1'],fingerprint,cost:'local',supports:{references:true,lastFrame:true,audio:true,final:false}}),async submit(){submits++;return {state:'completed',path:mediaPath};},async status(){return {state:'unknown'};},async cancel(){}};
 const generator:RuntimeTextGenerator={configuration:()=>({fingerprint,description:{model:'fixture'}}),async execute(r:RuntimeTextRequest){writes++;const scene=randomUUID(),block=randomUUID();return {schemaVersion:1,instanceId:r.input.instanceId,inputHash:r.input.inputHash,outcomeId:r.input.outcomeId,timelineFps:24,scenes:[{id:scene,title:'门打开',location:'城门',time:'夜',blocks:[{id:block,type:'action',text:'守卫打开门。'}]}],sourceRefs:[],usedVariables:[],assertedFacts:[],shotPlan:[{id:randomUUID(),sceneId:scene,goal:'开门',action:'城门打开',sound:'门轴响',durationFrames:24,resourceRefs:[]}],contentChecks:[]};}};
 const x=fixture({providers:[provider],runtimeGenerator:generator});const entry=randomUUID(),ending=randomUUID();
 const plan=ScriptPlanData.parse({schemaVersion:1,title:'本地动态片段',chapterRefs:[],entryNodeId:entry,nodes:[{id:entry,type:'segment',title:'开门',outlineOrder:0,mode:'generated',sourceSceneRefs:[],next:ending,contentSpec:{mode:'generated',generationContract:{id:randomUUID(),version:1,scope:'segment',reads:[],sourceRefs:[],entryConditions:[],narrativeGoal:'门打开',fixedFacts:[],allowedChanges:[{field:'action',constraint:'描述门打开'}],outcomeCases:[],fallbackOutcome:'open',outcomes:[{id:'open',narrativeRequirement:'门打开',completionEffects:[],postconditions:[]}],resourceRefs:[],limits:{maxCharacters:100,maxScenes:1,maxShots:1,targetSeconds:2,maxTextCalls:1,maxMediaJobs:1,maxRepairAttempts:0},checks:{structure:true,independentContent:false,mediaReady:true}}}},{id:ending,type:'ending',title:'入城',outlineOrder:1,endingKey:'entered',summary:'入城。'}],policy:{maxTextCallsPerRun:1,maxMediaJobsPerRun:1,reviewMode:'authorReview',executionProfiles:[{provider:'h3',profile:'h3-preview/v1',quality:'draft',model:'local-fixture',configFingerprint:fingerprint,templateVersion:'v1',constraints:{width:320,height:576,fps:24,durationSeconds:124/24,audio:true,firstLastFrames:false}}]}});
 const project=x.app.projects.repo.get(x.pid,x.pid);x.run('project.update',{id:x.pid,expectedSeq:project.seq,data:{...project.data,generationLimit:budget}});
 return {...x,plan,provider,counts:()=>({submits,writes}),async video(seconds=2){mediaPath=join(x.root,'local-fixture.mp4');await execute(mediaBinary('ffmpeg'),['-y','-v','error','-f','lavfi','-i',`color=c=blue:s=320x576:r=30:d=${seconds}`,'-f','lavfi','-i',`sine=frequency=440:duration=${seconds}`,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',mediaPath]);},start(){const script=x.run('script.create',plan);assert.throws(()=>x.run('script.publish',{id:script.id,expectedSeq:script.seq,kind:'playback'}),/确认/);const release=x.run('script.publish',{id:script.id,expectedSeq:script.seq,kind:'playback',confirmGeneration:true}).release;return x.app.experienceRuntime.start({projectId:x.pid,uid:'reader'},{protocolVersion:1,requestId:randomUUID(),projectId:x.pid,releaseId:release.id,mode:'playback'}).view;}};
}

test('11 完整动态链路：正文审阅后本地媒体归档、真实fps、私有projection与原生音轨',async()=>{
 const x=harness();try{await x.video();const initial=x.start(),principal={projectId:x.pid,uid:'reader'},scope={...principal,runId:initial.run.id};
  const reviewed=await until(()=>x.app.experienceRuntime.instance(principal,initial.run.id,initial.instance!.id),i=>i.status==='waitingReview');assert.deepEqual(x.counts(),{writes:1,submits:0});
  assert.throws(()=>x.run('instance.review',{uid:'reader',runId:initial.run.id,instanceId:reviewed.id,resultRevision:2,approve:true}),/变化/);
  x.run('instance.review',{uid:'reader',runId:initial.run.id,instanceId:reviewed.id,resultRevision:1,approve:true});
  const view=await until(()=>x.app.experienceRuntime.view(principal,initial.run.id),v=>v.instance?.status==='ready'||v.run.status==='blocked');assert.equal(view.instance!.status,'ready',view.run.waitReason);assert.equal(view.playback!.bindings[0].sourceFps,30);assert.equal(view.playback!.bindings[0].nativeAudio,true);assert.equal(view.playback!.bindings.length,1);
  const jobs=x.app.production.jobs.list(x.pid);assert.equal(jobs.length,1);assert.equal(jobs[0].data.owner.type,'experience');assert.equal(x.app.store.experience.usage(scope).projectMedia,1);assert.equal(x.app.store.experience.usage(scope).runMedia,1);assert.equal(x.app.store.experience.usage(scope).runText,1);
  const snapshot=x.app.snapshot(x.pid) as any;assert.deepEqual(snapshot.jobs,[]);assert.deepEqual(snapshot.artifacts,[]);assert.throws(()=>x.app.object(x.pid,'job',jobs[0].id),/不存在/);assert.throws(()=>x.run('job.retry',{id:jobs[0].id}),/所属体验/);
  const binding=view.playback!.bindings[0];assert.ok(x.app.experienceRuntime.media(principal,view.run.id,view.playback!.planHash,binding.id));assert.throws(()=>x.app.object(x.pid,'artifact',binding.artifactRef.id),/不存在/);
  assert.equal(x.app.story.repo.list(x.pid).length,0);assert.equal(x.app.storyboard.repo.list(x.pid).length,0);assert.deepEqual(x.counts(),{writes:1,submits:1});
  const result=x.app.experienceRuntime.execute(principal,{protocolVersion:1,requestId:randomUUID(),runId:view.run.id,expectedStateSeq:view.run.stateSeq,visitId:view.run.currentVisitId,operation:'segment.complete',payload:{instanceId:view.instance!.id,planHash:view.playback!.planHash,frame:view.playback!.durationFrames}});assert.equal(result.view.run.status,'completed');
 }finally{x.close();}
});

test('11 项目媒体额度不足时保留已审正文，整批媒体预约与真实调用均为零',async()=>{
 const x=harness(0);try{
  const view=x.start(),principal={projectId:x.pid,uid:'reader'};
  const reviewed=await until(()=>x.app.experienceRuntime.instance(principal,view.run.id,view.instance!.id),i=>i.status==='waitingReview');
  const after=x.app.store.events(x.pid,0).at(-1)!.cursor;
  const response=x.run('instance.review',{uid:principal.uid,runId:view.run.id,instanceId:reviewed.id,resultRevision:1,approve:true});
  assert.deepEqual(response,{instanceId:reviewed.id,status:'blocked',resultRevision:1});
  const events=x.app.store.events(x.pid,after);
  assert.equal(events.length,1);assert.equal(events[0].type,'instance.review');assert.deepEqual(events[0].body,{scope:'experience'});
  const serialized=JSON.stringify(events);
  for(const privateValue of [principal.uid,view.run.id,reviewed.id,'variables','committedFacts','payload','resultRevision'])assert.ok(!serialized.includes(privateValue),privateValue);
  const blocked=x.app.experienceRuntime.instance(principal,view.run.id,reviewed.id);assert.equal(blocked.status,'blocked');assert.ok(blocked.scriptResult);assert.equal(x.app.production.jobs.list(x.pid).length,0);assert.equal(x.app.store.experience.usage({...principal,runId:view.run.id}).runMedia,0);assert.equal(x.counts().submits,0);
 }finally{x.close();}
});

test('11 IT-26 actual half-second video cannot satisfy a one-second narrative shot or be padded into ready',async()=>{
 const x=harness();try{
  await x.video(.5);const initial=x.start(),principal={projectId:x.pid,uid:'reader'};
  const reviewed=await until(()=>x.app.experienceRuntime.instance(principal,initial.run.id,initial.instance!.id),instance=>instance.status==='waitingReview');
  x.run('instance.review',{uid:principal.uid,runId:initial.run.id,instanceId:reviewed.id,resultRevision:reviewed.resultRevision,approve:true});
  const blocked=await until(()=>x.app.experienceRuntime.instance(principal,initial.run.id,reviewed.id),instance=>instance.status==='blocked');
  assert.match(blocked.recoveryReason!,/不足以覆盖片段/);assert.equal(blocked.playbackPlan,undefined);assert.equal(blocked.pendingPlaybackPlan,undefined);
  assert.equal(x.app.production.jobs.list(x.pid)[0].data.state,'completed');assert.deepEqual(x.counts(),{writes:1,submits:1});
  const scope={...principal,runId:initial.run.id};assert.equal(x.app.store.experience.list('mediaLinks',scope).length,0);assert.equal(x.app.store.experience.usage(scope).runMedia,1);
 }finally{x.close();}
});

test('11 纯Schema注册表与实际Host命令一致且不启动Provider',()=>{const x=fixture();try{assert.deepEqual(schemaRegistry().schemas(),x.app.bus.schemas());}finally{x.close();}});


test('11 author budget preserves legacy per-job counting even when cancelled before dispatch',()=>{
 const x=harness(1);try{const intent={provider:'h3',profile:'h3-preview/v1',quality:'draft',prompt:'Local fixture',constraints:{width:320,height:576,fps:24,durationSeconds:124/24,audio:true,firstLastFrames:false}};const job=x.run('job.submit',intent);x.run('job.cancel',{id:job.id});assert.equal(x.app.store.experience.usage({projectId:x.pid}).projectMedia,1);assert.throws(()=>x.run('job.submit',intent),/预算/);assert.equal(x.counts().submits,0);}finally{x.close();}
});

test('11 private reference cannot be laundered into an author generation task',()=>{
 const x=harness();try{const a=x.app.production.artifacts.create(x.pid,{title:'private reference',sha256:'a'.repeat(64),sizeBytes:12,mediaType:'image/png',source:'fixture',createdAt:new Date().toISOString(),metadata:{visibility:'experience'}}),ref=x.app.production.artifacts.checkpoint(a.id,x.pid,a.seq);assert.throws(()=>x.run('job.submit',{provider:'h3',profile:'h3-preview/v1',quality:'draft',prompt:'fixture',references:[ref],constraints:{width:320,height:576,fps:24,durationSeconds:124/24,audio:true,firstLastFrames:false}}),/私人体验/);assert.equal(x.app.production.jobs.list(x.pid).length,0);assert.equal(x.app.store.experience.usage({projectId:x.pid}).projectMedia,0);}finally{x.close();}
});
