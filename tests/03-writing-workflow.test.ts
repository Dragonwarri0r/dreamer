import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Application} from '../apps/host/application.ts';
import {handleWritingPost,handleWritingGet} from '../apps/host/writing-routes.ts';
import {writingActor,type WritingMode} from '../packages/contracts/writing.ts';
import type {AgentFactory,AgentSession} from '../packages/core/agent/port.ts';
import {fixture,until} from './helpers.ts';

function fakeAgent(){
 const turns:{tool:Parameters<AgentSession['turn']>[3];event:Parameters<AgentSession['turn']>[2];input:any;tools:string[]}[]=[];
 const factory:AgentFactory=()=>{let tools:string[]=[];return {async start(id,available){tools=available.map(t=>t.name);return id??randomUUID();},async turn(_id,text,event,tool){turns.push({tool,event,input:JSON.parse(text),tools:[...tools]});return randomUUID();},async interrupt(){},close(){}};};
 return {factory,turns};
}
function harness(){
 const agent=fakeAgent(),x=fixture({agentFactory:agent.factory}),owner=randomUUID();
 const start=(mode:WritingMode='discuss',extra:any={})=>{const body={requestId:randomUUID(),projectId:x.pid,owner,title:'主题共创',goal:'提升阅读趣味',message:'一起讨论人物和主题',mode,...extra};return {body,receipt:handleWritingPost(x.app,'/api/writing/start',body) as any};};
 const next=(threadId:string,mode:WritingMode='discuss',extra:any={})=>{const body={requestId:randomUUID(),projectId:x.pid,owner,threadId,message:'继续讨论',mode,...extra};return {body,receipt:handleWritingPost(x.app,'/api/writing/continue',body) as any};};
 const turn=(index:number)=>until(()=>agent.turns[index],Boolean);
 return {...x,...agent,owner,start,next,turn};
}
const offer={question:'下一段更想读什么？',options:[{id:'repair',title:'修机器',summary:'伙伴对解法有分歧',message:'围绕一次共同修理展开人物交锋'},{id:'market',title:'去赶集',summary:'技术判断遇到人情变化',message:'让张扬在集市误判一件小事'}]};
const textChange=(base:any)=>({base,field:'body',start:0,end:1,expectedText:'冷',replacement:'热',title:'饭温修订',reason:'保留现有剧情，只改一处文字'});

test('03 写作状态游标包含流式锚点的最新全文，完成后仍可按 ID 合并且不越会话',async()=>{
 const x=harness();try{
  const {receipt}=x.start(),id=receipt.result.threadId,turn=await x.turn(0);
  turn.event({type:'delta',text:'先给人物一个愿望'});
  const initial=x.app.agents.writingStatus(x.pid,id),anchor=initial.entries.at(-1)!;
  assert.equal(anchor.text,'先给人物一个愿望');
  turn.event({type:'delta',text:'，让伙伴有不同的解法。'});
  const streaming=x.app.agents.writingStatus(x.pid,id,anchor.id);
  assert.equal(streaming.entries[0].id,anchor.id);assert.equal(streaming.entries[0].text,'先给人物一个愿望，让伙伴有不同的解法。');
  turn.event({type:'complete'});
  const completed=x.app.agents.writingStatus(x.pid,id,anchor.id);
  assert.equal(completed.turnState,'completed');assert.deepEqual(completed.entries,streaming.entries);
  const merged=new Map(initial.entries.map(e=>[e.id,e]));for(const entry of completed.entries)merged.set(entry.id,entry);
  assert.equal(merged.size,initial.entries.length);assert.equal(merged.get(anchor.id)?.text,streaming.entries[0].text);
  const other=x.start(),otherEntry=x.app.agents.writingStatus(x.pid,other.receipt.result.threadId).entries[0];
  assert.throws(()=>x.app.agents.writingStatus(x.pid,id,otherEntry.id),/游标不在此会话/);
  x.next(id);const next=await x.turn(2);next.event({type:'delta',text:'这是下一轮的新消息。'});
  const following=x.app.agents.writingStatus(x.pid,id,anchor.id);
  assert.equal(following.entries[0].id,anchor.id);assert.ok(following.entries.some(e=>e.text==='这是下一轮的新消息。'));
 }finally{x.close();}
});

test('03 写作讨论卡持久幂等，选择只继续讨论，忙碌、旧轮次与越项目选择被拒绝',async()=>{
 const x=harness();try{
  const {body,receipt}=x.start(),id=receipt.result.threadId,first=await x.turn(0);
  assert.ok(first.tools.includes('dreamer_offer_directions'));assert.ok(!first.tools.includes('chapter_create'));
  await assert.rejects(first.tool('chapter_create',{number:1,title:'不应创建'},'bad'),/未授权/);
  const saved=await first.tool('dreamer_offer_directions',offer,'offer') as any;
  assert.equal((await first.tool('dreamer_offer_directions',offer,'offer') as any).entryId,saved.entryId);
  await assert.rejects(first.tool('dreamer_offer_directions',{...offer,question:'换内容'},'offer'),/相同方向调用/);
  await assert.rejects(first.tool('dreamer_offer_directions',{...offer,options:[offer.options[0],offer.options[0]]},'duplicates'),/不能重复/);
  assert.throws(()=>x.next(id,'discuss',{selection:{entryId:saved.entryId,optionId:'repair'}}),/仍在执行/);
  first.event({type:'complete'});
  const selection={entryId:saved.entryId,optionId:'repair'};
  assert.throws(()=>x.next(id,'draft',{selection}),/只能继续讨论/);
  assert.throws(()=>x.next(id,'discuss',{owner:randomUUID(),selection}),/另一个窗口/);
  const selected=x.next(id,'discuss',{selection}),second=await x.turn(1);
  assert.equal(second.input.request.includes(offer.options[0].message),true);
  const replay=handleWritingPost(x.app,'/api/writing/continue',selected.body) as any;assert.equal(replay.replayed,true);
  assert.equal(x.app.agents.threads.get(id,x.pid).data.turns.length,2);
  assert.equal(x.app.chapters.repo.list(x.pid).length,0);
  second.event({type:'complete'});
  assert.throws(()=>x.next(id,'discuss',{selection}),/已过期/);
  assert.throws(()=>x.next(id,'discuss',{projectId:randomUUID()}),/不属于当前项目/);
  assert.throws(()=>x.app.agents.writingStatus(randomUUID(),id),/不属于当前项目/);
  const initialReplay=handleWritingPost(x.app,'/api/writing/start',body) as any;
  assert.equal(initialReplay.replayed,true);assert.equal(initialReplay.result.threadId,id);
  assert.equal(x.app.agents.threads.list(x.pid).length,1);
  assert.equal(x.app.store.events(x.pid,0).find(e=>e.type==='writing.start')?.source,'external');
  const status=x.app.agents.writingStatus(x.pid,id);assert.equal(status.entries.filter(e=>e.writingOffer).length,1);assert.equal(status.writing?.mode,'discuss');
 }finally{x.close();}
});

test('03 外部仅可请求平台 Agent，写作参考不授予修订权，提案只限明确目标且无媒体审批',async()=>{
 const x=harness();try{
  const chapter=x.run('chapter.create',{number:1,title:'已有故事',body:'冷饭要留着。'}),base=x.app.chapters.checkpoint(chapter.id,x.pid,chapter.seq);
  const context=x.run('knowledge.create',{title:'主题参考',text:'让人物更有趣'}),reference=x.app.knowledge.checkpoint(context.id,x.pid,context.seq);
  const uncheckpointed=x.run('chapter.create',{number:9,title:'尚未冻结',body:'保留精确版本。'});
  const external=writingActor(x.pid);
  for(const operation of ['chapter.create','change.approve','thread.send','job.create'])assert.throws(()=>x.app.bus.execute({requestId:randomUUID(),projectId:x.pid,operation,payload:{}},{...external,allowed:[operation]}));
  assert.throws(()=>x.start('revise'),/必须明确/);assert.equal(x.app.agents.threads.list(x.pid).length,0);
  const freshRef={kind:'chapter' as const,id:uncheckpointed.id,seq:uncheckpointed.seq};
  const draft=x.start('draft',{bindings:[{ref:base},{ref:freshRef}]}),draftTurn=await x.turn(0);
  assert.equal(x.app.chapters.repo.at(freshRef,x.pid).data.body,'保留精确版本。');
  assert.ok(draftTurn.tools.includes('chapter_create'));assert.ok(!draftTurn.tools.includes('change_text'));assert.ok(!draftTurn.tools.some(n=>/approve|apply|job_|production/.test(n)));
  await draftTurn.tool('dreamer_read',{kind:'chapter',ref:base},'read');
  await assert.rejects(draftTurn.tool('change_text',textChange(base),'forbidden'),/未授权/);
  draftTurn.event({type:'complete'});
  x.next(draft.receipt.result.threadId,'draft',{bindings:[{ref:reference}],targetRefs:[base]});const scoped=await x.turn(1);
  const created=await scoped.tool('chapter_create',{number:2,title:'新章',body:'冷饭变香。'},'new') as any;
  const newBase={kind:'chapter',id:created.result.id,seq:created.result.seq};
  await assert.rejects(scoped.tool('change_text',textChange(newBase),'new-not-target'),/授权范围/);
  const changed=await scoped.tool('change_text',textChange(base),'proposal') as any;
  assert.equal(x.app.chapters.repo.get(base.id,x.pid).data.body,'冷饭要留着。');
  assert.equal(x.app.review.changes.get(changed.result.id,x.pid).data.state,'proposed');
  assert.equal(x.app.review.changes.get(changed.result.id,x.pid).data.createdBy,'agent');
  await assert.rejects(scoped.tool('change_approve',{id:changed.result.id},'approve'),/未授权/);
  await assert.rejects(scoped.tool('job_create',{},'video'),/未授权/);
  assert.deepEqual(x.app.agents.threads.get(draft.receipt.result.threadId,x.pid).data.turns.at(-1)?.targets,[base.id]);
  assert.equal(x.app.production.jobs.list(x.pid).length,0);
  const status=x.app.agents.writingStatus(x.pid,draft.receipt.result.threadId);assert.ok(status.proposalIds.includes(changed.result.id));assert.ok(!status.outputs.some(r=>r.id===reference.id));
 }finally{x.close();}
});

test('03 趣味审稿与旧审稿技能均强制只读，独立审稿子任务不能提供方向或继续被外部控制',async()=>{
 const x=harness();try{
  const started=x.start('review'),main=await x.turn(0);
  assert.ok(main.tools.includes('dreamer_delegate'));assert.ok(!main.tools.includes('chapter_create'));assert.ok(!main.tools.includes('dreamer_offer_directions'));
  const pending=main.tool('dreamer_delegate',{title:'独立趣味复核',task:'只读检查承诺与兑现',skill:'engagement-review',allowed:[]},'review');
  const child=await x.turn(1);assert.ok(!child.tools.includes('dreamer_delegate'));assert.ok(!child.tools.includes('dreamer_offer_directions'));
  await assert.rejects(child.tool('dreamer_offer_directions',offer,'bad-offer'),/只有主题共创/);
  await assert.rejects(child.tool('chapter_create',{number:1,title:'拒绝写作'},'write'),/未授权/);
  child.event({type:'complete'});const result=await pending as any;
  assert.throws(()=>x.next(result.threadId),/子任务记录只读/);main.event({type:'complete'});
  const thread=x.run('thread.create',{title:'兼容旧审稿'});x.run('thread.claim',{id:thread.id,expectedSeq:thread.seq,owner:x.owner});x.run('thread.send',{id:thread.id,owner:x.owner,text:'请写正文',skill:'script-review'});
  const legacy=await x.turn(2);assert.ok(!legacy.tools.includes('chapter_create'));await assert.rejects(legacy.tool('change_text',{},'write'),/未授权/);
  assert.equal(x.app.chapters.repo.list(x.pid).length,0);
  const status=x.app.agents.writingStatus(x.pid,started.receipt.result.threadId);assert.equal(status.turnState,'completed');assert.equal(status.independentReview?.state,'completed');assert.equal(status.independentReview?.children[0].threadId,result.threadId);
  const missing=x.start('review'),selfOnly=await x.turn(3);selfOnly.event({type:'complete'});
  assert.equal(x.app.agents.writingStatus(x.pid,missing.receipt.result.threadId).independentReview?.state,'not_performed');
 }finally{x.close();}
});

test('03 写作回执经 Host 恢复保持持久幂等，unknown 不自动重发，允许显式新轮次继续',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-writing-recovery-')),agent=fakeAgent(),pid=randomUUID(),owner=randomUUID();let app=new Application(root,{agentFactory:agent.factory});
 const body={requestId:randomUUID(),projectId:pid,owner,title:'持久共创',message:'讨论下一章',mode:'discuss'};
 try{
  app.bus.execute({requestId:randomUUID(),projectId:pid,operation:'project.create',payload:{title:'恢复测试'}},{source:'human'});
  const first=handleWritingPost(app,'/api/writing/start',body) as any;await until(()=>agent.turns.length,n=>n===1);
  app.close();app=new Application(root,{agentFactory:agent.factory});
  const state=handleWritingGet(app,new URL('http://localhost/api/writing/status?'+new URLSearchParams({projectId:pid,threadId:first.result.threadId}))) as any;
  assert.equal(state.state,'interrupted');assert.equal(state.turnState,'unknown');assert.equal(agent.turns.length,1);
  const {requestId,projectId,...payload}=body;
  const receipt=handleWritingPost(app,'/api/writing/receipt',{requestId,projectId,operation:'writing.start',payload}) as any;
  assert.equal(receipt.found,true);assert.equal(receipt.receipt.result.turnId,first.result.turnId);
  assert.equal((handleWritingPost(app,'/api/writing/start',body) as any).replayed,true);assert.equal(agent.turns.length,1);
  assert.throws(()=>handleWritingPost(app,'/api/writing/start',{...body,message:'另一份请求'}),/请求标识/);
  const continuation={requestId:randomUUID(),projectId:pid,owner,threadId:first.result.threadId,message:'已确认旧轮次未知，请根据公开记录继续讨论',mode:'discuss'};
  handleWritingPost(app,'/api/writing/continue',continuation);await until(()=>agent.turns.length,n=>n===2);
  assert.equal(app.agents.threads.get(first.result.threadId,pid).data.turns.length,2);
  assert.equal(app.agents.threads.get(first.result.threadId,pid).data.turns[0].state,'unknown');
 }finally{app.close();rmSync(root,{recursive:true,force:true});}
});
