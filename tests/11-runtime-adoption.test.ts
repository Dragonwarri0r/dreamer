import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { seedAdoption } from './fixtures/interactive-adoption.ts';
import { Proposal } from '../packages/contracts/review.ts';
import { contentHash } from '../packages/core/story/script.ts';
import type { SegmentInstance } from '../packages/contracts/experience.ts';
import { proposalHash } from '../packages/core/modules/review.ts';

function harness(){const x=fixture({providers:[]}),f=seedAdoption(x.app,x.pid);return {...x,...f};}
function reviseInstance(x:ReturnType<typeof harness>,change:(instance:SegmentInstance)=>SegmentInstance){const row=x.app.store.experience.get<SegmentInstance>('instances',x.instanceId,x.scope);x.app.store.experience.save('instances',row.id,x.scope,row.seq,change(row.data));}
function approve(x:ReturnType<typeof harness>,proposal:any){return x.run('change.approve',{id:proposal.id,expectedSeq:proposal.seq,groups:proposal.data.groups.map((g:any)=>g.id)});}

test('11 private instance is disclosed only by explicit proposal; approval adopts atomically without changing the run',()=>{
 const x=harness();try{
  const beforeRun=x.app.store.experience.get('runs',x.scope.runId,x.scope).data,beforeRelease=x.app.store.experience.get('releases',x.release.id,{projectId:x.pid}).data;
  assert.ok(!JSON.stringify(x.app.snapshot(x.pid)).includes('只属于这个实例'));
  const requestId=randomUUID(),proposal=x.run('instance.propose',x.proposal,{source:'human'},requestId);
  assert.deepEqual(x.run('instance.propose',x.proposal,{source:'human'},requestId),JSON.parse(JSON.stringify(proposal)));
  assert.equal(x.app.chapters.repo.get(x.chapter.id,x.pid).data.body,'作者原有正文。');
  assert.equal(proposal.data.runtimeSource.content.contentHash,contentHash(x.generated));
  assert.equal(proposal.data.runtimeSource.content.resultRevision,1);
  assert.notEqual(proposalHash(proposal.data),proposalHash({...proposal.data,runtimeSource:{...proposal.data.runtimeSource,mode:'replace'}}));
  const shared=JSON.stringify(proposal);assert.ok(shared.includes('只属于这个实例'));assert.ok(!shared.includes(x.scope.uid));assert.ok(!shared.includes('不会公开的个人输入'));assert.ok(!shared.includes('variableSnapshot'));
  assert.throws(()=>x.run('change.apply',{id:proposal.id,expectedSeq:proposal.seq}),/批准/);
  const approved=approve(x,proposal);reviseInstance(x,i=>({...i,status:'consumed'}));
  x.run('change.apply',{id:proposal.id,expectedSeq:approved.seq});
  assert.equal(x.app.chapters.repo.get(x.chapter.id,x.pid).data.body,'作者原有正文。\n\n城门旁\n旅人：只属于这个实例的提取正文。\n\n桥上\n另一段已审的个人正文。');
  assert.deepEqual(x.app.store.experience.get('runs',x.scope.runId,x.scope).data,beforeRun);assert.deepEqual(x.app.store.experience.get('releases',x.release.id,{projectId:x.pid}).data,beforeRelease);
  assert.equal(x.app.production.jobs.list(x.pid).length,0);assert.equal(x.app.store.experience.list('dispatches',x.scope).length,0);
 }finally{x.close();}
});

test('11 extraction requires human disclosure, uid ownership, reached and reviewed fixed content, and an explicit target',()=>{
 const x=harness();try{
  assert.throws(()=>x.run('instance.propose',x.proposal,{source:'agent',projectId:x.pid,targets:[x.chapter.id],allowed:['instance.propose']}),/用户决定/);
  assert.throws(()=>x.run('instance.propose',{...x.proposal,confirmDisclosure:false}),/约定/);
  assert.throws(()=>x.run('instance.propose',{...x.proposal,uid:'another-reader'}),/不存在/);
  assert.throws(()=>x.run('instance.propose',{...x.proposal,target:x.sceneRef}),/一个来源场景/);
  assert.throws(()=>x.run('instance.propose',{...x.proposal,sceneIds:[randomUUID()]}),/提取场景/);
  for(const status of ['unknown','waitingReview','writing'] as const){reviseInstance(x,i=>({...i,status}));assert.throws(()=>x.run('instance.propose',x.proposal),/检查和确认/);}
  reviseInstance(x,i=>({...i,status:'ready',checks:[]}));assert.throws(()=>x.run('instance.propose',x.proposal),/审阅/);
  const row=x.app.store.experience.get<SegmentInstance>('instances',x.instanceId,x.scope),visit=x.app.store.experience.get<any>('visits',row.data.visitId,x.scope);x.app.store.experience.save('visits',visit.id,x.scope,visit.seq,{...visit.data,status:'planned'});
  assert.throws(()=>x.run('instance.propose',x.proposal),/尚未到达/);assert.equal(x.app.review.changes.list(x.pid).length,0);
 }finally{x.close();}
});

test('11 proposal binds target sequence and source revision; normal proposals cannot forge or erase provenance',()=>{
 const x=harness();try{
  const proposal=x.run('instance.propose',{...x.proposal,target:x.sceneRef,sceneIds:[x.generated.scenes[0].id],mode:'replace'});
  assert.equal(proposal.data.groups[0].operations[0].data.blocks.length,1);assert.notEqual(proposal.data.groups[0].operations[0].data.blocks[0].id,x.generated.scenes[0].blocks[0].id);
  const ordinary=Proposal.parse({title:'伪造',reason:'',groups:proposal.data.groups});
  assert.throws(()=>x.run('change.propose',{...ordinary,runtimeSource:proposal.data.runtimeSource}),/约定/);
  assert.throws(()=>x.run('change.revise',{id:proposal.id,expectedSeq:proposal.seq,proposal:ordinary}),/固定来源/);
  const approved=approve(x,proposal);reviseInstance(x,i=>({...i,resultRevision:2}));
  assert.throws(()=>x.run('change.apply',{id:proposal.id,expectedSeq:approved.seq}),/修订已变化/);assert.equal(x.app.story.repo.get(x.scene.id,x.pid).seq,x.scene.seq);
  reviseInstance(x,i=>({...i,resultRevision:1}));const scene=x.app.story.repo.get(x.scene.id,x.pid);x.run('scene.update',{id:scene.id,expectedSeq:scene.seq,data:{...scene.data,title:'目标已改'}});
  assert.throws(()=>x.run('change.apply',{id:proposal.id,expectedSeq:approved.seq}),/基准已变化/);assert.equal(x.app.story.repo.get(x.scene.id,x.pid).data.blocks[0].text,'作者原有场景。');
 }finally{x.close();}
});

test('11 failure after target write rolls back adoption, approval state, event and receipt together',()=>{
 const x=harness();try{
  const proposal=x.run('instance.propose',x.proposal),approved=approve(x,proposal),events=x.app.store.events(x.pid,0).length,requestId=randomUUID();
  const save=x.app.review.changes.save;x.app.review.changes.save=()=>{throw new Error('adoption commit fault');};
  try{assert.throws(()=>x.run('change.apply',{id:proposal.id,expectedSeq:approved.seq},{source:'human'},requestId),/adoption commit fault/);}finally{x.app.review.changes.save=save;}
  assert.equal(x.app.chapters.repo.get(x.chapter.id,x.pid).seq,x.chapter.seq);assert.equal(x.app.review.changes.get(proposal.id,x.pid).data.state,'approved');assert.equal(x.app.store.events(x.pid,0).length,events);
  x.run('change.apply',{id:proposal.id,expectedSeq:approved.seq},{source:'human'},requestId);assert.equal(x.app.chapters.repo.get(x.chapter.id,x.pid).seq,x.chapter.seq+1);
 }finally{x.close();}
});

test('11 fixed template text and the actually selected fallback take precedence over an unplayed generated draft',()=>{
 const x=harness();try{
  const text='固定模板正文。'.repeat(1800);
  reviseInstance(x,instance=>({...instance,scriptResult:undefined,templateResult:{text,contentHash:contentHash({text})}}));
  const template=x.run('instance.propose',{...x.proposal,target:x.sceneRef});
  assert.equal(template.data.runtimeSource.format,'template');const blocks=template.data.groups[0].operations[0].data.blocks.slice(1);
  assert.equal(blocks.map((block:any)=>block.text).join(''),text);assert.ok(blocks.every((block:any)=>block.text.length<=12000));
  const cut=x.run('cut.create',{title:'后备媒体来源',tracks:[{id:randomUUID(),title:'画面',type:'video'}]}),cutRef=x.run('cut.checkpoint',{id:cut.id,expectedSeq:cut.seq});
  const project=x.app.projects.repo.get(x.pid,x.pid),projectRef=x.app.projects.repo.checkpoint(x.pid,x.pid,project.seq);
  const build=x.app.editorial.builds.create(x.pid,{title:'后备媒体固定版本',cut:cutRef,project:projectRef,snapshot:cut.data,artifacts:[],range:{startFrame:0,endFrame:24},encoding:{crf:20,subtitles:true},createdAt:new Date().toISOString(),state:'ready'}),buildRef=x.app.editorial.builds.checkpoint(build.id,x.pid,build.seq);
  const media={buildRef,fromFrame:0,toFrame:24,fps:24,contentHash:'a'.repeat(64)},fallback={id:randomUUID(),outcomeId:'continue',text:'实际采用的后备正文。',media,contentHash:contentHash({text:'实际采用的后备正文。',media}),previousResultRevision:1};
  x.app.store.experience.create('results',x.scope,{instanceId:x.instanceId,resultRevision:2,contentHash:fallback.contentHash,fallback});
  reviseInstance(x,instance=>({...instance,status:'consumed',resultRevision:2,scriptResult:x.generated,fallbackResult:fallback}));
  const proposal=x.run('instance.propose',{...x.proposal,resultRevision:2});
  assert.equal(proposal.data.runtimeSource.format,'fallback');assert.equal(proposal.data.runtimeSource.content.resultRevision,2);
  const body=proposal.data.groups[0].operations[0].data.body;assert.ok(body.includes('实际采用的后备正文'));assert.ok(!body.includes('只属于这个实例'));assert.ok(!body.includes('固定模板正文'));
 }finally{x.close();}
});
