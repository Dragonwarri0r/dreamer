import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHost} from '../apps/host/server.ts';
import {WritingClient} from '../packages/infra/writing-client.ts';
import {fixture,until} from './helpers.ts';

test('03 写作外部客户端经真实 HTTP 会话完成提交、回执、查询与续写且拒绝无会话调用',async()=>{
 const turns:{complete:()=>void;input:any}[]=[];
 const x=fixture({agentFactory:()=>({async start(id){return id??randomUUID();},async turn(_id,text,event){turns.push({complete:()=>event({type:'complete'}),input:JSON.parse(text)});return randomUUID();},async interrupt(){},close(){}})}),server=createHost(x.app);
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port,client=new WritingClient(base,'http-test');
  const input={requestKey:'discuss-one',projectId:x.pid,title:'HTTP 共创',message:'先讨论主题',mode:'discuss'};
  assert.equal((await fetch(base+'/api/writing/status?'+new URLSearchParams({projectId:x.pid,threadId:randomUUID()}))).status,403);
  const first=await client.start(input),id=first.result.threadId;
  assert.equal((await client.start(input)).replayed,true);
  assert.equal((await client.receipt({operation:'start',request:input})).receipt.result.turnId,first.result.turnId);
  const firstTurn=await until(()=>turns[0],Boolean);assert.equal(firstTurn.input.writing.mode,'discuss');
  assert.equal((await client.status({projectId:x.pid,threadId:id})).turnState,'running');
  firstTurn.complete();
  const chapter=x.run('chapter.create',{number:1,title:'准确版本',body:'冷饭。'}),ref={kind:'chapter',id:chapter.id,seq:chapter.seq};
  const next=await client.continue({requestKey:'revise-one',projectId:x.pid,threadId:id,message:'只修指定章节',mode:'revise',targetRefs:[ref]});
  const nextTurn=await until(()=>turns[1],Boolean);assert.deepEqual(nextTurn.input.writing.targetRefs,[ref]);
  assert.notEqual(next.result.turnId,first.result.turnId);assert.equal(x.app.agents.threads.get(id,x.pid).data.turns.length,2);
  await assert.rejects(client.status({projectId:randomUUID(),threadId:id}),/NOT_FOUND/);
  assert.equal(x.app.store.events(x.pid,0).filter(e=>e.type.startsWith('writing.')).every(e=>e.source==='external'),true);
 }finally{await new Promise<void>(r=>server.close(()=>r()));x.close();}
});
