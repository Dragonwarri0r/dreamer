import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Application} from '../apps/host/application.ts';
import {createHost} from '../apps/host/server.ts';
import {SqliteStore} from '../packages/infra/sqlite.ts';
import {ProjectData,type Ref} from '../packages/contracts/foundation.ts';
import {JobData,RenderIntent,type MediaProvider} from '../packages/contracts/production.ts';
import {CommandBus} from '../packages/core/foundation/commands.ts';
import {Production} from '../packages/core/modules/production.ts';
import {seedInteractiveStory} from '../scripts/interactive-fixture.ts';
import {until} from './helpers.ts';

function budgetFixture(limit=3){
 const root=mkdtempSync(join(tmpdir(),'dreamer-final-budget-')),store=new SqliteStore(root),projectId=randomUUID();
 store.repository('project',ProjectData).create(projectId,ProjectData.parse({title:'共享最后额度',generationLimit:limit}),projectId);
 const release=store.experience.create('releases',{projectId},{scriptRef:{id:randomUUID(),seq:1},manifestHash:'fixed'});
 const scopes=['a','b'].map(uid=>{const runId=randomUUID();store.experience.create('runs',{projectId,uid},{releaseId:release.id,mode:'playback',status:'waitingContent'},runId);const scope={projectId,uid,runId},visit=store.experience.create('visits',scope,{nodeId:randomUUID(),status:'active'}),instance=store.experience.create('instances',scope,{runId,releaseId:release.id,visitId:visit.id,inputHash:randomUUID(),status:'producing'});return {...scope,instanceId:instance.id};});
 let submits=0;
 const provider:MediaProvider={describe:()=>({id:'h3',title:'合同替身',profiles:['h3-preview/v1'],fingerprint:'fixed',available:true,detail:'no model',cost:'local',concurrencyGroup:'local-video',supports:{references:true,lastFrame:true,audio:true,final:false}}),async submit(){submits++;return {state:'unknown'};},async status(){return {state:'unknown'};},async cancel(){}};
 const bus=new CommandBus(store),production=new Production(store,bus,{path(){throw new Error('no files');},async import(){throw new Error('no import');}},[provider],()=>{throw new Error('no references');},store.experience,false);
 production.experienceScope=(_pid,runId)=>scopes.find(scope=>scope.runId===runId);
 const intent=RenderIntent.parse({provider:'h3',profile:'h3-preview/v1',prompt:'固定测试',quality:'draft',constraints:{width:320,height:576,fps:24,durationSeconds:124/24,audio:true}});
 const author=()=>bus.execute({requestId:randomUUID(),projectId,operation:'job.submit',payload:intent},{source:'human'});
 const runtime=(index:number)=>store.transaction(()=>{const scope=scopes[index],component=randomUUID(),reservation=store.experience.reserve(scope,{requestId:randomUUID(),ownerKey:`instance:${scope.instanceId}:shot:${component}`,stage:'media',attemptNo:1,unit:'media',countsProject:true,state:'reserved',source:'runtime',provider:'h3'},{projectMedia:limit,runMedia:3});return production.enqueue(projectId,intent,undefined,{owner:{type:'experience',runId:scope.runId,instanceId:scope.instanceId,component},scope,reservationId:reservation.id});});
 return {root,store,projectId,scopes,production,intent,author,runtime,submits:()=>submits,close(){production.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('11 IT-13/27 migration-era job delta is counted once and two runs plus author serialize competition for the final shared slot',async()=>{
 for(const first of [0,1,2]){const x=budgetFixture();try{
  const legacy=[0,1].map(()=>x.production.jobs.create(x.projectId,JobData.parse({title:'迁移后旧入口任务',intent:x.intent,fingerprint:'fixed',state:'failed',attempts:[],submittedAt:new Date().toISOString()})));
  assert.equal(x.store.experience.usage({projectId:x.projectId}).projectMedia,0);
  x.production.recover([x.projectId]);x.production.recover([x.projectId]);
  assert.equal(x.store.experience.usage({projectId:x.projectId}).projectMedia,2);
  for(const job of legacy)assert.equal(x.store.experience.list('reservations',{projectId:x.projectId}).filter(row=>row.data.jobId===job.id).length,1);
  const contenders=[()=>x.runtime(0),()=>x.runtime(1),()=>x.author()],order=[first,...[0,1,2].filter(index=>index!==first)];
  const results=await Promise.allSettled(order.map(index=>Promise.resolve().then(()=>{contenders[index]();})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results[0].status,'fulfilled');
  assert.equal(x.store.experience.usage({projectId:x.projectId}).projectMedia,3);assert.equal(x.production.jobs.list(x.projectId).length,3);
  assert.equal(x.store.experience.list('reservations',{projectId:x.projectId}).length+x.scopes.reduce((sum,scope)=>sum+x.store.experience.list('reservations',scope).length,0),3);assert.ok(x.submits()<=1);
 }finally{x.close();}}
});

test('11 IT-28 author and two runs share one Provider group; an unknown task blocks all replacement submissions after recovery',async()=>{
 const x=budgetFixture(5);try{
  const a=x.runtime(0),b=x.runtime(1);x.author();await x.production.dispatch(a.id,x.projectId);await x.production.dispatch(b.id,x.projectId);
  assert.equal(x.submits(),1);assert.equal(x.production.jobs.get(a.id,x.projectId).data.state,'unknown');assert.equal(x.production.jobs.get(b.id,x.projectId).data.state,'queued');
  x.production.recover([x.projectId]);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(x.submits(),1);
  const originalB=x.production.jobs.get(b.id,x.projectId);x.store.transaction(()=>x.production.cancelExperience(a.id,x.projectId));await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(x.production.jobs.get(b.id,x.projectId),originalB);assert.equal(x.store.experience.usage(x.scopes[0]).runMedia,1);assert.equal(x.store.experience.usage(x.scopes[1]).runMedia,1);
 }finally{x.close();}
});

test('11 IT-01/19 interactive creation preserves author chapters, board and Build; old run survives source revisions and a new release',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-final-release-'));let app:Application|undefined=new Application(root,{providers:[],recover:false});
 try{
  const projectId=randomUUID(),command=(operation:string,payload:unknown)=>app!.bus.execute({projectId,requestId:randomUUID(),operation,payload},{source:'human'}).result as any;
  command('project.create',{title:'原章节保护'});const f=await seedInteractiveStory(app,projectId,true),scene=app.story.repo.list(projectId)[0],chapter=app.chapters.repo.list(projectId)[0];
  const referenceBytes=Buffer.from('fixed author appearance fixture'),referenceHash=createHash('sha256').update(referenceBytes).digest('hex');writeFileSync(join(root,'objects',referenceHash),referenceBytes);
  const image=app.production.artifacts.create(projectId,{title:'外貌参考',sha256:referenceHash,sizeBytes:referenceBytes.length,mediaType:'image/png',source:'fixture',metadata:{},createdAt:new Date().toISOString()}),imageRef=app.production.artifacts.checkpoint(image.id,projectId,image.seq);
  const resource=command('resource.create',{title:'守卫',type:'character',entityId:randomUUID(),description:'蓝衣守卫',status:'published',references:[{artifact:imageRef,purpose:'appearance',selected:true}]}),resourceRef=command('resource.checkpoint',{id:resource.id,expectedSeq:resource.seq});
  const linked=command('scene.update',{id:scene.id,expectedSeq:scene.seq,data:{...scene.data,bindings:[{ref:resourceRef}]}}),sceneRef=command('scene.checkpoint',{id:linked.id,expectedSeq:linked.seq});
  const shot=command('shot.create',{title:'原镜头',scene:sceneRef,durationFrames:72});command('episode.create',{title:'原制作单',chapterIds:[chapter.id],shotIds:[shot.id],targetSeconds:3});
  const plan=structuredClone(f.plan);for(const node of plan.nodes)if(node.type==='segment')node.sourceSceneRefs=[sceneRef];for(const cue of plan.cues)cue.anchor.ref=sceneRef;
  const domains=()=>[app!.chapters.repo.list(projectId),app!.episodes.repo.list(projectId),app!.storyboard.repo.list(projectId),app!.editorial.builds.list(projectId)];const before=JSON.stringify(domains());
  const script=command('script.create',plan),release=command('script.publish',{id:script.id,expectedSeq:script.seq,kind:'playback'}).release;
  assert.equal(JSON.stringify(domains()),before);assert.ok(release.dependencyRefs.some((ref:Ref)=>ref.id===resource.id&&ref.seq===resourceRef.seq));
  const principal={projectId,uid:'old-reader'},old=app.experienceRuntime.start(principal,{protocolVersion:1,requestId:randomUUID(),projectId,releaseId:release.id,mode:'playback'}).view,oldPlan=old.playback;
  const changedResource=command('resource.update',{id:resource.id,expectedSeq:resource.seq,data:{...resource.data,description:'红衣守卫'}}),newResourceRef=command('resource.checkpoint',{id:resource.id,expectedSeq:changedResource.seq});
  const changedScene=command('scene.update',{id:scene.id,expectedSeq:linked.seq,data:{...linked.data,location:'新城门',bindings:[{ref:newResourceRef}]}}),newSceneRef=command('scene.checkpoint',{id:scene.id,expectedSeq:changedScene.seq});
  const latest=structuredClone(script.data);for(const node of latest.nodes)if(node.type==='segment')node.sourceSceneRefs=[newSceneRef];for(const cue of latest.cues)cue.anchor.ref=newSceneRef;latest.title='新发布';
  const updated=command('script.update',{id:script.id,expectedSeq:script.seq,data:latest}),newRelease=command('script.publish',{id:script.id,expectedSeq:updated.seq,kind:'playback'}).release;
  assert.notEqual(newRelease.id,release.id);assert.ok(newRelease.dependencyRefs.some((ref:Ref)=>ref.id===resource.id&&ref.seq===newResourceRef.seq));
  app.close();app=new Application(root,{providers:[],recover:false});const resumed=app.experienceRuntime.view(principal,old.run.id);
  assert.equal(resumed.run.releaseId,release.id);assert.deepEqual(resumed.playback,oldPlan);assert.equal(app.resources.repo.at(resourceRef,projectId).data.description,'蓝衣守卫');
  assert.equal(app.scripts.releases(projectId,script.id).find(r=>r.id===release.id)!.manifestHash,release.manifestHash);
 }finally{app?.close();rmSync(root,{recursive:true,force:true});}
});

test('11 IT-24 all author HTTP and Agent reads exclude private Jobs and same-hash private artifacts while public copies remain accessible',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-final-privacy-'));let tool:((name:string,args:unknown,id:string)=>Promise<any>)|undefined;
 const app=new Application(root,{providers:[],recover:false,agentFactory:()=>({async start(){return 'fixture';},async turn(_id,_text,_event,onTool){tool=onTool;return 'fixture-turn';},async interrupt(){},close(){}})}),server=createHost(app),projectId=randomUUID();
 const command=(operation:string,payload:unknown)=>app.bus.execute({projectId,requestId:randomUUID(),operation,payload},{source:'human'}).result as any;
 try{
  command('project.create',{title:'隐私面枚举'});const bytes=Buffer.from('same immutable media'),sha256=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(root,'objects',sha256),bytes);
  const media={title:'公共副本',sha256,sizeBytes:bytes.length,mediaType:'image/png' as const,source:'fixture',createdAt:new Date().toISOString(),metadata:{}};
  const publicArtifact=app.production.artifacts.create(projectId,media),privateArtifact=app.production.artifacts.create(projectId,{...media,title:'仅个人可见正文',metadata:{visibility:'experience'}});
  const refs=[publicArtifact,privateArtifact].map(row=>app.production.artifacts.checkpoint(row.id,projectId,row.seq));
  const job=app.production.jobs.create(projectId,JobData.parse({title:'仅个人可见任务',owner:{type:'experience',runId:randomUUID(),instanceId:randomUUID(),component:'video'},intent:{provider:'h3',profile:'h3-preview/v1',prompt:'私人提示词',constraints:{}},fingerprint:'fixed',state:'cancelled',attempts:[],submittedAt:new Date().toISOString()})),jobRef=app.production.jobs.checkpoint(job.id,projectId,job.seq);
  const snapshot=app.snapshot(projectId) as any;assert.deepEqual(snapshot.jobs,[]);assert.deepEqual(snapshot.artifacts.map((row:any)=>row.id),[publicArtifact.id]);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const base=`http://127.0.0.1:${(server.address() as any).port}`,session=await fetch(base+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0];
  for(const [kind,row] of [['artifact',privateArtifact],['job',job]] as const)for(const path of ['object','history','revision'])assert.equal((await fetch(`${base}/api/${path}?${new URLSearchParams({projectId,kind,id:row.id,seq:String(row.seq)})}`,{headers:{cookie}})).status,404,`${path} ${kind}`);
  assert.equal((await fetch(`${base}/api/media?projectId=${projectId}&id=${privateArtifact.id}`,{headers:{cookie}})).status,404);
  assert.equal((await fetch(`${base}/api/media?projectId=${projectId}&id=${publicArtifact.id}`,{headers:{cookie}})).status,200);
  for(const operation of ['job.cancel','job.retry','job.reconcile'])assert.throws(()=>command(operation,{id:job.id}),/所属体验/);
  const thread=command('thread.create',{title:'只读作者资料'}),owner=randomUUID();command('thread.claim',{id:thread.id,expectedSeq:thread.seq,owner});command('thread.send',{id:thread.id,owner,text:'列出已公开素材'});await until(()=>tool,Boolean);
  assert.deepEqual((await tool!('dreamer_read',{kind:'artifact'},'artifacts')).map((row:any)=>row.id),[publicArtifact.id]);assert.deepEqual(await tool!('dreamer_read',{kind:'job'},'jobs'),[]);
  for(const ref of [refs[1],jobRef])await assert.rejects(tool!('dreamer_read',{kind:ref.kind,ref},randomUUID()),/作者工作区/);
  const events=JSON.stringify(await (await fetch(`${base}/api/events?projectId=${projectId}&after=0`,{headers:{cookie}})).json());for(const privateValue of [privateArtifact.id,job.id,'私人提示词','仅个人可见'])assert.ok(!events.includes(privateValue));
  assert.equal(app.production.artifacts.at(refs[0],projectId).data.sha256,app.production.artifacts.at(refs[1],projectId).data.sha256);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));app.close();rmSync(root,{recursive:true,force:true});}
});

test('11 IT-29 unavailable media, text handler or extension can be designed and simulated but cannot publish playback or convert a simulation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-final-capabilities-')),app=new Application(root,{providers:[],recover:false}),projectId=randomUUID();
 try{
  app.bus.execute({projectId,requestId:randomUUID(),operation:'project.create',payload:{title:'有限能力门禁'}},{source:'human'});
  const f=await seedInteractiveStory(app,projectId,true);
  for(const scenario of ['media','text','puzzle'] as const){
   const plan=structuredClone(f.plan);plan.title=scenario;
   if(scenario==='media'){for(const node of plan.nodes)if(node.type==='segment')node.contentSpec={mode:'fixed'};for(const cue of plan.cues)delete cue.resolvedBinding;}
   else {const activity=plan.activities[0];plan.activities[0]={...activity,type:scenario==='text'?'text-intent':'puzzle',config:scenario==='text'?{maxLength:200,intents:[{id:'rescue',label:'帮助'},{id:'proof',label:'证物'}],interpretationTemplate:{id:'fixed',version:1},extractedFields:[]}:{simulationResults:[{id:'win',label:'模拟成功',result:{}}]},resultMapping:[]};}
   const draft=f.command('script.create',plan),diagnostics=app.scripts.diagnostics(draft.data,projectId,'playback');
   const rule=scenario==='media'?'MEDIA_MISSING':scenario==='text'?'CAPABILITY_TEXT':'ACTIVITY_UNSUPPORTED';assert.ok(diagnostics.some(item=>item.ruleId===rule&&item.severity==='error'),rule);
   assert.throws(()=>f.command('script.publish',{id:draft.id,expectedSeq:draft.seq,kind:'playback',confirmGeneration:true}),/无法发布|不能发布|校验|缺少|检查/);
   const simulated=f.command('simulation.start',{id:draft.id,expectedSeq:draft.seq,uid:`test-${scenario}`});assert.equal(simulated.view.run.mode,'simulation');
   assert.throws(()=>app.experienceRuntime.start({projectId,uid:`test-${scenario}`},{protocolVersion:1,requestId:randomUUID(),projectId,releaseId:simulated.releaseId,mode:'playback'}),/不能互相转换/);
   assert.equal(app.store.experience.list('dispatches',{projectId,uid:`test-${scenario}`,runId:simulated.view.run.id}).length,0);
  }
  assert.equal(app.production.jobs.list(projectId).length,0);
 }finally{app.close();rmSync(root,{recursive:true,force:true});}
});
