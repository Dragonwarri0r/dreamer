import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Application} from '../apps/host/application.ts';
import {stable} from '../packages/contracts/foundation.ts';
import type {AgentSession} from '../packages/core/agent/port.ts';
const tick=()=>new Promise(r=>setTimeout(r,25));
test('03 selected writing method is frozen at submission and the exact snapshot reaches the provider',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-writing-'));let submitted:any;
 const session:AgentSession={async start(){return 'p';},async turn(_id,text){submitted=JSON.parse(text);return 't';},async interrupt(){},close(){}};
 const app=new Application(root,{agentFactory:()=>session}),pid=randomUUID();
 const run=(operation:string,payload:any)=>app.bus.execute({projectId:pid,requestId:randomUUID(),operation,payload},{source:'human'}).result as any;
 try{
  run('project.create',{title:'创作方法测试'});const thread=run('thread.create',{title:'短剧改编'}),owner=randomUUID();
  run('thread.claim',{id:thread.id,expectedSeq:thread.seq,owner});
  const sent=run('thread.send',{id:thread.id,owner,skill:'short-drama',text:'把章节改编为首集'});
  const snapshot=sent.data.turns[0].appliedSkill;assert.equal(snapshot.id,'short-drama');
  const {hash,...content}=snapshot;assert.equal(hash,createHash('sha256').update(stable(content)).digest('hex'));
  await tick();assert.deepEqual(submitted.skill,snapshot);assert.deepEqual(app.agents.threads.get(thread.id,pid).data.turns[0].appliedSkill,snapshot);
 }finally{app.close();rmSync(root,{recursive:true,force:true});}
});
test('03 independent script review cannot create or propose changes even when requested in text',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-review-'));let call:any,exposed:string[]=[];
 const app=new Application(root,{agentFactory:()=>({async start(_id,tools){exposed=tools.map(t=>t.name);return 'p';},async turn(_id,_text,_event,onTool){call=onTool;return 't';},async interrupt(){},close(){}})}),pid=randomUUID();
 const run=(operation:string,payload:any)=>app.bus.execute({projectId:pid,requestId:randomUUID(),operation,payload},{source:'human'}).result as any;
 try{
  run('project.create',{title:'独立审稿'});const t=run('thread.create',{title:'审稿'}),owner=randomUUID();
  run('thread.claim',{id:t.id,expectedSeq:1,owner});run('thread.send',{id:t.id,owner,skill:'script-review',text:'审稿并直接覆盖正文'});await tick();
  assert.ok(exposed.includes('dreamer_read'));assert.ok(!exposed.includes('chapter_create'));assert.ok(!exposed.includes('change_text'));
  await assert.rejects(call('chapter_create',{title:'越权'},'write'),/未授权/);
  const skills=await call('dreamer_skills',{},'discover');assert.ok(skills.skills.some((s:any)=>s.id==='story'&&s.version.startsWith('2.')));
 }finally{app.close();rmSync(root,{recursive:true,force:true});}
});
