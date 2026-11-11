import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.ts';
import {ScriptPlanData} from '../packages/contracts/interactive-script.ts';

const simple=()=>{const id=randomUUID();return ScriptPlanData.parse({schemaVersion:1,title:'门前',chapterRefs:[],entryNodeId:id,nodes:[{id,type:'ending',title:'离开',outlineOrder:0,endingKey:'leave',summary:'归家'}]});};

test('11 作者发布固定版本，节点分页与检索；后续修改不污染原发布',()=>{
 const x=fixture();try{const plan=simple(),s=x.run('script.create',plan),ref=x.run('script.checkpoint',{id:s.id,expectedSeq:s.seq});
  const published=x.run('script.publish',{id:s.id,expectedSeq:s.seq,kind:'playback'}).release;
  assert.equal(published.snapshot.title,'门前');assert.equal(x.app.store.discovery.search(x.pid,{kind:'script',query:'门前',offset:0,limit:10}).total,1);
  const page=x.app.scripts.readPage(x.pid,ref,0,1);assert.equal(page.nodes.length,1);assert.equal(page.contentPage.partial,false);
  const changed=x.run('script.edit',{id:s.id,expectedSeq:s.seq,ops:[{op:'title.set',title:'改稿'}]});
  assert.equal(changed.seq,s.seq+1);assert.equal(x.app.scripts.releases(x.pid,s.id)[0].snapshot.title,'门前');
  assert.equal(x.app.scripts.impact(x.pid,s.id).releases[0].changed,true);
  assert.throws(()=>x.run('script.publish',{id:s.id,expectedSeq:s.seq,kind:'playback'}),/更新/);
  const snapshot=x.app.snapshot(x.pid) as any;assert.ok(snapshot.scripts);assert.equal(snapshot.runs,undefined);
 }finally{x.close();}
});

test('11 AI仅可局部提案，批准仍绑定基准、不能全量替换或自批',()=>{
 const x=fixture();try{const s=x.run('script.create',simple()),base=x.run('script.checkpoint',{id:s.id,expectedSeq:s.seq}),actor={source:'agent' as const,projectId:x.pid,targets:[s.id],allowed:['script.propose','script.update','change.propose','change.approve']};
  assert.throws(()=>x.run('script.update',{id:s.id,expectedSeq:s.seq,data:{...s.data,title:'覆盖'}},actor),/script.propose/);
  assert.throws(()=>x.run('change.propose',{title:'覆盖',reason:'',groups:[{id:randomUUID(),title:'组',operations:[{kind:'script',id:s.id,expectedSeq:s.seq,base,data:s.data}]}]},actor));
  const c=x.run('script.propose',{id:s.id,expectedSeq:s.seq,baseRef:base,title:'改名',reason:'准确',ops:[{op:'title.set',title:'批准后的标题'}]},actor);assert.equal(x.app.scripts.repo.get(s.id,x.pid).seq,s.seq);
  assert.throws(()=>x.run('change.approve',{id:c.id,expectedSeq:c.seq,groups:[c.data.groups[0].id]},actor),/用户决定/);
  const approved=x.run('change.approve',{id:c.id,expectedSeq:c.seq,groups:[c.data.groups[0].id]});x.run('change.apply',{id:c.id,expectedSeq:approved.seq});assert.equal(x.app.scripts.repo.get(s.id,x.pid).data.title,'批准后的标题');
  assert.throws(()=>x.run('script.propose',{id:s.id,expectedSeq:s.seq,baseRef:base,title:'无效节点',reason:'',ops:[{op:'entry.set',nodeId:randomUUID()}]},actor),/规则检查/);
 }finally{x.close();}
});

test('11 模拟发布可重复且不调用模型，创建默认没有运行生成额度',()=>{
 const x=fixture();try{const s=x.run('script.create',simple());assert.equal(s.data.policy.maxTextCallsPerRun,0);assert.equal(s.data.policy.maxMediaJobsPerRun,0);
  const a=x.run('simulation.start',{id:s.id,expectedSeq:s.seq,uid:'u1'}),b=x.run('simulation.start',{id:s.id,expectedSeq:s.seq,uid:'u2'});assert.equal(a.releaseId,b.releaseId);assert.equal(a.view.run.status,'completed');assert.notEqual(a.view.run.id,b.view.run.id);assert.equal(x.app.production.jobs.list(x.pid).length,0);
  assert.throws(()=>x.app.experienceRuntime.view({projectId:x.pid,uid:'u2'},a.view.run.id),/不存在/);
 }finally{x.close();}
});

test('11 模拟命令保留完整私有回执，公共项目事件不包含身份、变量或事实',()=>{
 const x=fixture({providers:[]});try{
  const plan=simple(),checkpoint=randomUUID(),effect=randomUUID();
  plan.variables=[{key:'progress',label:'进展',type:'integer',scope:'run',initial:0,min:0,max:1,allowedWriters:[{sourceId:checkpoint,commitAt:'checkpointReached'}]}];
  plan.nodes.unshift({id:checkpoint,type:'checkpoint',title:'开始',description:'',outlineOrder:0,requires:[],commitEffects:[{id:effect,op:'set',key:'progress',value:{source:'constant',value:1},commitAt:'checkpointReached'}],next:plan.entryNodeId});
  plan.entryNodeId=checkpoint;
  const script=x.run('script.create',plan),after=x.app.store.events(x.pid,0).at(-1)!.cursor;
  const command={requestId:randomUUID(),projectId:x.pid,operation:'simulation.start',payload:{id:script.id,expectedSeq:script.seq,uid:'private-simulation-user'}};
  const first=x.app.bus.execute(command,{source:'human'}),result=first.result as any;
  assert.equal(result.view.run.uid,command.payload.uid);
  assert.deepEqual(result.view.run.variables,{progress:1});
  assert.equal(result.view.run.committedFacts.length,1);
  assert.equal(result.view.run.committedFacts[0].effectId,effect);
  assert.ok(result.receipt);assert.equal(result.view.run.releaseId,result.releaseId);
  const replay=x.app.bus.execute(command,{source:'human'});
  const responseJson=JSON.parse(JSON.stringify(result));
  assert.equal(replay.replayed,true);assert.deepEqual(replay.result,responseJson);
  assert.deepEqual(x.app.store.receipt(command,{source:'human'})?.result,responseJson);
  const events=x.app.store.events(x.pid,after);
  assert.equal(events.length,1);assert.equal(events[0].type,'simulation.start');
  assert.deepEqual(events[0].body,{scope:'experience'});
  const serialized=JSON.stringify(events);
  for(const privateValue of [command.payload.uid,result.view.run.id,result.view.run.currentVisitId,effect,'variables','committedFacts','payload','view'])assert.ok(!serialized.includes(privateValue),privateValue);
  assert.equal(x.app.production.jobs.list(x.pid).length,0);
 }finally{x.close();}
});
