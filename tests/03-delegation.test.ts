import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,until} from './helpers.ts';
import type {AgentSession,Tool} from '../packages/core/agent/port.ts';
import {AgentChannel} from '../packages/infra/agent/channel.ts';

function harness(){
 const sessions:{starts:{id?:string;tools:Tool[]}[];turns:{input:any;event:Parameters<AgentSession['turn']>[2];tool:Parameters<AgentSession['turn']>[3]}[];closed:number}[]=[];
 const x=fixture({agentFactory:()=>{
  const state={starts:[] as {id?:string;tools:Tool[]}[],turns:[] as typeof sessions[number]['turns'],closed:0};sessions.push(state);
  return {async start(id,tools){state.starts.push({id,tools});return id??`provider-${sessions.indexOf(state)}`;},async turn(_id,text,event,tool){state.turns.push({input:JSON.parse(text),event,tool});return `turn-${state.turns.length}`;},async interrupt(){},close(){state.closed++;}};
 }});
 async function parent(bindings:any[]=[]){
  const thread=x.run('thread.create',{title:'主任务',bindings}),owner=randomUUID();
  x.run('thread.claim',{id:thread.id,expectedSeq:thread.seq,owner});x.run('thread.send',{id:thread.id,owner,text:'检查故事连续性'});
  await until(()=>sessions.flatMap(s=>s.turns),v=>v.length>0);
  return {thread,owner,call:sessions.at(-1)!.turns.at(-1)!};
 }
 return {...x,sessions,parent,children:()=>x.app.agents.threads.list(x.pid).filter(t=>t.data.delegation)};
}

test('03 委派冻结上下文、默认只读、拒绝越权与递归、同调用幂等并回收结果',async()=>{
 const x=harness();try{
  const chapter=x.run('chapter.create',{number:1,title:'冷水饭香',body:'吉皮梯只想吃热饭。'});
  const ref=x.app.chapters.checkpoint(chapter.id,x.pid,chapter.seq),binding={ref,purpose:'只检查本章',layer:'turn' as const};
  const {thread,call}=await x.parent([binding]);
  const other=x.run('chapter.create',{number:2,title:'下一章'}),otherRef=x.app.chapters.checkpoint(other.id,x.pid,other.seq);
  await assert.rejects(call.tool('dreamer_delegate',{title:'越权',task:'批准',allowed:['change.approve']},'unauthorized'),/权限不能/);
  await assert.rejects(call.tool('dreamer_delegate',{title:'扩展输入',task:'检查',bindings:[{ref:otherRef}]},'outside'),/固定输入或已读/);
  x.run('chapter.update',{id:chapter.id,expectedSeq:chapter.seq,data:{...chapter.data,body:'人工改成两碗热饭。'}});
  const input={title:'独立复核',task:'核对最初版本的动机',bindings:[binding]};
  const first=call.tool('dreamer_delegate',input,'review'),repeat=call.tool('dreamer_delegate',input,'review');
  await until(()=>x.sessions.length,v=>v===2);
  const child=await until(()=>x.sessions[1].turns[0],Boolean);
  assert.deepEqual(x.children()[0].data.turns[0].allowed,[]);
  assert.deepEqual(child.input.context,[binding]);
  assert.equal((await child.tool('dreamer_read',{kind:'chapter',ref},'read') as any).data.body,'吉皮梯只想吃热饭。');
  assert.ok(!x.sessions[1].starts[0].tools.some(t=>t.name==='dreamer_delegate'||t.name==='chapter_create'));
  await assert.rejects(child.tool('chapter_create',{number:3,title:'不允许'},'write'),/未授权/);
  await assert.rejects(child.tool('dreamer_delegate',{title:'递归',task:'继续拆分'},'nested'),/不能再次委派/);
  child.event({type:'delta',text:'原稿动机一致：热饭。'});child.event({type:'complete'});
  const [result,replayed]=await Promise.all([first,repeat]);
  assert.equal((result as any).state,'completed');assert.deepEqual(result,replayed);assert.equal(x.children().length,1);
  assert.equal((result as any).summary,'原稿动机一致：热饭。');
  assert.ok((result as any).refs.some((r:any)=>r.kind==='thread'&&r.id===x.children()[0].id));
  assert.equal(x.app.agents.threads.get(thread.id,x.pid).data.entries.filter(e=>e.text.includes('"phase":"finished"')).length,1);
  assert.equal((await call.tool('dreamer_delegate',input,'review') as any).threadId,(result as any).threadId);
  await assert.rejects(call.tool('dreamer_delegate',{...input,task:'换了任务'},'review'),/相同委派调用不能/);
  const compact=x.app.snapshot(x.pid,true) as any;
  assert.equal(compact.threads.find((t:any)=>t.id===(result as any).threadId).data.delegation.parentThreadId,thread.id);
 }finally{x.close();}
});

test('03 子任务可显式继承提案权限，但不能扩大修改目标或自批',async()=>{
 const x=harness();try{
  const chapter=x.run('chapter.create',{number:1,title:'初稿',body:'一碗冷饭。'}),other=x.run('chapter.create',{number:2,title:'其他',body:'别动。'});
  const ref=x.app.chapters.checkpoint(chapter.id,x.pid,chapter.seq),otherRef=x.app.chapters.checkpoint(other.id,x.pid,other.seq);
  const {call}=await x.parent([{ref}]);
  const pending=call.tool('dreamer_delegate',{title:'局部修辞',task:'把冷饭改为热饭并提出修订',allowed:['change.text']},'propose');
  const child=await until(()=>x.sessions[1]?.turns[0],Boolean);
  const proposal={base:ref,field:'body',start:2,end:3,expectedText:'冷',replacement:'热',title:'饭温',reason:'局部调整'};
  const receipt=await child.tool('change_text',proposal,'change') as any;
  await assert.rejects(child.tool('change_text',{...proposal,base:otherRef,start:0,end:1,expectedText:'别'},'outside'),/授权范围/);
  await assert.rejects(child.tool('change_approve',{id:receipt.result.id,expectedSeq:1,groups:[]},'approve'),/未授权/);
  assert.equal(x.app.chapters.repo.get(chapter.id,x.pid).data.body,'一碗冷饭。');
  child.event({type:'delta',text:'已提交提案，等待人工审阅。'});child.event({type:'complete'});
  const result=await pending as any;assert.ok(result.refs.some((r:any)=>r.kind==='change'&&r.id===receipt.result.id));
 }finally{x.close();}
});

test('03 子任务失败与父会话停止均回收明确状态，迟到输出不可写入',async()=>{
 const x=harness();try{
  const {thread,call}=await x.parent();
  const failed=call.tool('dreamer_delegate',{title:'复核',task:'检查'},'failure'),child=await until(()=>x.sessions[1]?.turns[0],Boolean);
  child.event({type:'error',text:'Provider 额度不足'});const result=await failed as any;
  assert.equal(result.state,'failed');assert.match(result.error,/额度/);
  assert.equal(x.app.agents.threads.get(thread.id,x.pid).data.state,'running');
  const pending=call.tool('dreamer_delegate',{title:'第二次复核',task:'检查另一处'},'stop'),second=await until(()=>x.sessions[2]?.turns[0],Boolean);
  x.run('thread.interrupt',{id:thread.id});const stopped=await pending as any;
  assert.equal(stopped.state,'interrupted');assert.match(stopped.error,/主会话已停止/);
  second.event({type:'delta',text:'迟到内容'});await assert.rejects(second.tool('dreamer_read',{kind:'project'},'late'),/停止/);
  assert.ok(!x.app.agents.threads.get(stopped.threadId,x.pid).data.entries.some(e=>e.text==='迟到内容'));
  assert.ok(x.sessions.every(s=>s.closed>0));
 }finally{x.close();}
});

test('03 委派数量有界，子会话不能被普通发送重跑，恢复不重发子任务',async()=>{
 const x=harness();try{
  const {call}=await x.parent();
  for(let i=0;i<3;i++){
   const pending=call.tool('dreamer_delegate',{title:`复核 ${i}`,task:'检查'},`limit-${i}`);
   const child=await until(()=>x.sessions[i+1]?.turns[0],Boolean);
   child.event({type:'complete'});await pending;
  }
  await assert.rejects(call.tool('dreamer_delegate',{title:'第四次',task:'检查'},'fourth'),/三个子任务/);
  const child=x.children()[0],owner=randomUUID();x.run('thread.claim',{id:child.id,expectedSeq:child.seq,owner});
  assert.throws(()=>x.run('thread.send',{id:child.id,owner,text:'重跑'}),/子任务记录只读/);
  const starts=x.sessions.length;x.app.agents.recover([x.pid]);assert.equal(x.sessions.length,starts);
 }finally{x.close();}
});

test('03 委派超时停止且保留记录，Host 恢复将父子轮次标为未知而不重发',async(t)=>{
 const x=harness();try{
  const {thread,call}=await x.parent();
  const pending=call.tool('dreamer_delegate',{title:'等待中的复核',task:'检查'},'restart');
  await until(()=>x.sessions[1]?.turns[0],Boolean);
  const starts=x.sessions.length;x.app.agents.recover([x.pid]);
  assert.equal((await pending as any).state,'unknown');assert.equal(x.sessions.length,starts);
  assert.equal(x.app.agents.threads.get(thread.id,x.pid).data.turns[0].state,'unknown');
 }finally{x.close();}
 const y=harness();try{
  const {call}=await y.parent();
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=call.tool('dreamer_delegate',{title:'超时复核',task:'检查'},'timeout');
  // The timeout is host-owned; no provider response is required to stop the child.
  t.mock.timers.tick(15*60*1000);
  const result=await pending as any;
  assert.equal(result.state,'interrupted');assert.match(result.error,/15 分钟/);
  assert.equal(y.children().length,1);
 }finally{t.mock.timers.reset();y.close();}
});

test('03 流式记录不使输入租约失效，执行中工作不能完成，后续发送重开工作',async()=>{
 const x=harness();try{
  const {thread,owner,call}=await x.parent(),before=x.app.agents.threads.get(thread.id,x.pid);
  call.event({type:'delta',text:'正在检查'});
  assert.doesNotThrow(()=>x.run('thread.claim',{id:thread.id,owner,expectedSeq:before.seq}));
  const work=x.app.agents.works.get(thread.data.workId,x.pid);
  assert.throws(()=>x.run('work.complete',{id:work.id,expectedSeq:work.seq}),/仍有会话或子任务/);
  call.event({type:'complete'});x.run('work.complete',{id:work.id,expectedSeq:work.seq});
  x.run('thread.send',{id:thread.id,owner,text:'再检查一次'});
  await until(()=>x.sessions[0].turns.length,v=>v===2);
  assert.equal(x.app.agents.works.get(work.id,x.pid).data.state,'open');
  assert.equal(x.sessions[0].starts[1].id,'provider-0');
 }finally{x.close();}
});

test('03 工具集升级可继续旧会话并显示受限恢复说明',async()=>{
 const x=harness();try{
  const thread=x.run('thread.create',{title:'旧会话'}),owner=randomUUID();
  x.app.agents.threads.save(thread.id,x.pid,thread.seq,{...thread.data,providerId:'old-provider',entries:[{id:randomUUID(),role:'assistant',text:'旧公开记录',at:new Date().toISOString(),refs:[]}]});
  x.run('thread.claim',{id:thread.id,expectedSeq:thread.seq,owner});x.run('thread.send',{id:thread.id,owner,text:'继续'});
  const call=await until(()=>x.sessions[0]?.turns[0],Boolean);
  assert.equal(x.sessions[0].starts[0].id,undefined);
  assert.ok(x.sessions[0].starts[0].tools.some(t=>t.name==='dreamer_delegate'));
  assert.ok(call.input.publicHistory.some((e:any)=>e.text==='旧公开记录'));
  assert.ok(x.app.agents.threads.get(thread.id,x.pid).data.entries.some(e=>e.role==='status'&&e.text.includes('最近 24 条')));
 }finally{x.close();}
});

test('03 排队轮次在开始执行时仍使用发送时冻结的工作目标',async()=>{
 const x=harness();try{
  const {thread,owner,call}=await x.parent();
  const work=x.app.agents.works.get(thread.data.workId,x.pid);
  x.run('thread.send',{id:thread.id,owner,text:'按原目标继续'});
  x.app.agents.works.save(work.id,x.pid,work.seq,{...work.data,goal:'排队之后才改的新目标'});
  call.event({type:'complete'});
  await until(()=>x.sessions[0].turns.length,v=>v===2);
  assert.equal(x.sessions[0].turns[1].input.work.goal,work.data.goal);
  const ref=x.sessions[0].turns[1].input.context.find((b:any)=>b.ref.kind==='work').ref;
  assert.equal(ref.seq,work.seq);
 }finally{x.close();}
});

test('03 启动中停止后立即排队新消息，旧启动回调不能吃掉新消息',async()=>{
 let ready!:(id:string)=>void,starts=0,turns=0;
 const x=fixture({agentFactory:()=>({start(){starts++;return starts===1?new Promise<string>(r=>ready=r):Promise.resolve('new-provider');},async turn(){turns++;return 'new-turn';},async interrupt(){},close(){}})});
 try{
  const thread=x.run('thread.create',{title:'竞态'}),owner=randomUUID();
  x.run('thread.claim',{id:thread.id,expectedSeq:thread.seq,owner});x.run('thread.send',{id:thread.id,owner,text:'旧消息'});
  await until(()=>starts,v=>v===1);x.run('thread.interrupt',{id:thread.id});
  x.run('thread.send',{id:thread.id,owner,text:'新消息'});ready('old-provider');
  await until(()=>turns,v=>v===1);
  const record=x.app.agents.threads.get(thread.id,x.pid);
  assert.deepEqual(record.data.turns.map(t=>t.state),['interrupted','running']);assert.equal(starts,2);
 }finally{x.close();}
});

test('03 Provider 事件与工具按会话和轮次关联，首包先于确认也不丢失',async()=>{
 const events:any[]=[],calls:any[]=[];
 const channel=new AgentChannel('thread',e=>events.push(e),async(name,args,id)=>{calls.push({name,args,id});return 'ok';});
 channel.event('thread',{type:'delta',turnId:'old',text:'迟到'});
 channel.event('thread',{type:'delta',turnId:'new',text:'首包'});
 const early=channel.call('thread','new','read',{},'call');
 channel.started('new');assert.equal(await early,'ok');
 channel.event('other-thread',{type:'delta',turnId:'new',text:'串线'});
 channel.event('thread',{type:'complete',turnId:'old'});
 await assert.rejects(channel.call('thread','old','write',{},'stale'),/当前有效轮次/);
 assert.deepEqual(events.map(e=>e.text),['首包']);assert.equal(calls.length,1);
 channel.event('thread',{type:'complete',turnId:'new'});channel.close('连接断开');
 channel.event('thread',{type:'delta',turnId:'new',text:'更迟'});
 assert.deepEqual(events.map(e=>e.type),['delta','complete']);
 await assert.rejects(channel.call('thread','new','write',{},'ended'),/当前有效轮次/);
});
