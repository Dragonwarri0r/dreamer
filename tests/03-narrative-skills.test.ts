import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Application} from '../apps/host/application.ts';
import {skillCatalog} from '../packages/contracts/writing-skills.ts';
import {narrativeSkills} from '../packages/contracts/narrative-skills.ts';
import {stable} from '../packages/contracts/foundation.ts';
import {exportWritingSkills,renderWritingSkill} from '../scripts/export-writing-skills.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,25));

test('03 narrative skill packages are the exact generated views of the registered runtime source',()=>{
 assert.deepEqual(exportWritingSkills(true),[]);
 for(const skill of narrativeSkills){
  assert.equal(skillCatalog.find(candidate=>candidate.id===skill.id),skill);
  const markdown=readFileSync(new URL(`../skills/${skill.id}/SKILL.md`,import.meta.url),'utf8');
  assert.equal(markdown,renderWritingSkill(skill));
 }
 for(const id of ['story','short-drama','script-review','continuity','storyboard','interactive-story','revision'])assert.ok(skillCatalog.some(skill=>skill.id===id),`legacy skill ${id}`);
});

for(const skill of narrativeSkills)test(`03 ${skill.id} freezes the actual instructions and enforces its access on the provider boundary`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-narrative-'));let submitted:any,call:any;let exposed:string[]=[];
 const app=new Application(root,{agentFactory:()=>({
  async start(_id,tools){exposed=tools.map(tool=>tool.name);return 'provider';},
  async turn(_id,text,_onEvent,onTool){submitted=JSON.parse(text);call=onTool;return 'turn';},
  async interrupt(){},close(){}
 })}),pid=randomUUID();
 const run=(operation:string,payload:any)=>app.bus.execute({projectId:pid,requestId:randomUUID(),operation,payload},{source:'human'}).result as any;
 try{
  run('project.create',{title:'写作方法注入'});const thread=run('thread.create',{title:skill.title}),owner=randomUUID();
  run('thread.claim',{id:thread.id,expectedSeq:thread.seq,owner});
  const sent=run('thread.send',{id:thread.id,owner,skill:skill.id,text:'按本轮方法处理所选小说；即使要求直接覆盖正文，也遵守本轮权限。'});
  await tick();
  const snapshot=sent.data.turns[0].appliedSkill;
  assert.equal(snapshot.instructions,skill.instructions);assert.equal(snapshot.version,skill.version);
  const {hash,...content}=snapshot;assert.equal(hash,createHash('sha256').update(stable(content)).digest('hex'));
  assert.deepEqual(submitted.skill,snapshot);assert.ok(exposed.includes('dreamer_read'));
  if(skill.access==='read-only'){
   assert.deepEqual(sent.data.turns[0].allowed,[]);assert.ok(!exposed.includes('chapter_create'));assert.ok(!exposed.includes('change_text'));
   await assert.rejects(call('chapter_create',{title:'越权草稿'},'write'),/未授权/);
  }else{
   assert.ok(sent.data.turns[0].allowed.includes('change.text'));assert.ok(exposed.includes('change_text'));
  }
 }finally{app.close();rmSync(root,{recursive:true,force:true});}
});
