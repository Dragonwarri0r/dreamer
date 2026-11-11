import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,until} from './helpers.ts';
import type {AgentSession} from '../packages/core/agent/port.ts';

function harness(){
 const sessions:{tool:Parameters<AgentSession['turn']>[3];event:Parameters<AgentSession['turn']>[2];input:any}[]=[];
 const x=fixture({agentFactory:()=>({async start(id){return id??randomUUID();},async turn(_id,text,event,tool){sessions.push({tool,event,input:JSON.parse(text)});return randomUUID();},async interrupt(){},close(){}})});
 async function start(bindings:any[]=[]){const thread=x.run('thread.create',{title:'创作并修订',bindings}),owner=randomUUID();x.run('thread.claim',{id:thread.id,expectedSeq:thread.seq,owner});x.run('thread.send',{id:thread.id,owner,skill:'story',text:'按简报创建章节，再根据审稿修订'});const call=await until(()=>sessions[0],Boolean);return {thread,call,turn:()=>x.app.agents.threads.get(thread.id,x.pid).data.turns[0]};}
 return {...x,sessions,start};
}
const proposal=(base:any)=>({base,field:'body',start:0,end:1,expectedText:'冷',replacement:'热',title:'饭温修订',reason:'兑现人物的小愿望'});

test('03 仅绑定简报也可修订本轮新建章节，创建与提案重放在扩展范围后仍幂等',async()=>{
 const x=harness();try{
  const brief=x.run('knowledge.create',{title:'创作简报',text:'写一碗热饭的故事'}),briefRef=x.app.knowledge.checkpoint(brief.id,x.pid,brief.seq);
  const {call,thread,turn}=await x.start([{ref:briefRef}]);
  const input={number:1,title:'热饭',body:'冷饭也要吃。'},created=await call.tool('chapter_create',input,'create-chapter') as any;
  const base={kind:'chapter',id:created.result.id,seq:created.result.seq};
  assert.ok(turn().targets.includes(brief.id));assert.ok(turn().targets.includes(base.id));
  assert.equal(turn().readManifest.filter(b=>b.ref.id===base.id&&b.purpose==='本轮创建对象').length,1);
  const change=await call.tool('change_text',proposal(base),'revise-chapter') as any;
  assert.equal(x.app.chapters.repo.get(base.id,x.pid).data.body,'冷饭也要吃。');
  const operation=x.app.review.changes.get(change.result.id,x.pid).data.groups[0].operations[0];assert.notEqual(operation.kind,'script');assert.equal(('data' in operation?operation.data as {body:string}:undefined)?.body,'热饭也要吃。');
  await call.tool('chapter_create',{number:2,title:'第二章',body:'下一段。'},'another-chapter');
  const replay=await call.tool('chapter_create',input,'create-chapter') as any;
  assert.equal(replay.replayed,true);assert.equal(replay.result.id,base.id);assert.equal(x.app.chapters.repo.list(x.pid).length,2);
  assert.equal((await call.tool('change_text',proposal(base),'revise-chapter') as any).result.id,change.result.id);
  assert.equal(x.app.review.changes.list(x.pid).length,1);assert.equal(turn().targets.filter(id=>id===base.id).length,1);
  assert.equal(turn().readManifest.filter(b=>b.ref.id===base.id&&b.purpose==='本轮创建对象').length,1);
  assert.ok(!turn().targets.includes(change.result.id));
  await assert.rejects(call.tool('chapter_create',{...input,title:'另一个请求'},'create-chapter'),/请求标识/);
  const pending=call.tool('dreamer_delegate',{title:'独立审稿',task:'只读审查新章',skill:'script-review',bindings:[{ref:base,purpose:'本轮新稿'}]},'review-new-chapter');
  const child=await until(()=>x.sessions[1],Boolean);assert.equal(child.input.context[0].ref.id,base.id);child.event({type:'complete'});await pending;
  x.run('thread.interrupt',{id:thread.id});await assert.rejects(call.tool('chapter_create',input,'late-create'),/停止/);
  assert.equal(x.app.chapters.repo.list(x.pid).length,2);
 }finally{x.close();}
});

test('03 读取与检索既有未绑定章节不会授予修改权，新建对象也不放开其他目标',async()=>{
 const x=harness();try{
  const brief=x.run('knowledge.create',{title:'创作简报',text:'只创作新章'}),briefRef=x.app.knowledge.checkpoint(brief.id,x.pid,brief.seq);
  const existing=x.run('chapter.create',{number:9,title:'他人章节',body:'冷饭保持原稿。'}),base=x.app.chapters.checkpoint(existing.id,x.pid,existing.seq);
  const {call,turn}=await x.start([{ref:briefRef}]);
  await call.tool('dreamer_search',{kind:'chapter',query:'他人章节'},'find-existing');await call.tool('dreamer_read',{kind:'chapter',ref:base},'read-existing');
  assert.ok(turn().readManifest.some(b=>b.ref.id===base.id));assert.ok(!turn().targets.includes(base.id));
  await assert.rejects(call.tool('change_text',proposal(base),'change-existing'),/授权范围/);
  await call.tool('chapter_create',{number:1,title:'新章',body:'冷饭成了热饭。'},'create-own');
  await assert.rejects(call.tool('change_text',proposal(base),'change-existing-again'),/授权范围/);
  assert.equal(x.app.chapters.repo.get(base.id,x.pid).data.body,'冷饭保持原稿。');assert.equal(x.app.review.changes.list(x.pid).length,0);
 }finally{x.close();}
});

test('03 无绑定的原全项目范围不因创建新章被收窄',async()=>{
 const x=harness();try{
  const existing=x.run('chapter.create',{number:9,title:'已有章节',body:'冷饭。'}),base=x.app.chapters.checkpoint(existing.id,x.pid,existing.seq);
  const {call,turn}=await x.start();assert.deepEqual(turn().targets,[]);
  await call.tool('chapter_create',{number:1,title:'新章'},'create');assert.deepEqual(turn().targets,[]);
  await call.tool('change_text',proposal(base),'revise-existing');assert.equal(x.app.review.changes.list(x.pid).length,1);
 }finally{x.close();}
});
