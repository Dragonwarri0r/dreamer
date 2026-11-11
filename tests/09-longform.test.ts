import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,until} from './helpers.ts';
import {seedLongform} from './fixtures/longform.ts';
import {SearchQuery} from '../packages/contracts/longform.ts';
import {cutDuration} from '../packages/contracts/editorial.ts';
import {contentWindow} from '../packages/core/agent/context.ts';

test('09 千章目录只传摘要，正文/章节号/卷/范围检索分页且项目隔离',()=>{
 const x=fixture();try{
  const f=seedLongform(x.app,x.pid),search=(q:any)=>x.app.store.discovery.search(x.pid,SearchQuery.parse(q));
  const state=x.app.snapshot(x.pid,true) as any,bytes=Buffer.byteLength(JSON.stringify(state));
  assert.equal(state.chapters.length,1200);assert.equal(state.shots.length,6000);
  assert.equal(state.chapters[1023].data.body,undefined);
  assert.ok(bytes<6_000_000,`目录过大 ${bytes}`);
  const found=search({kind:'chapter',query:'青铜罗盘'});assert.equal(found.total,1);assert.equal(found.items[0].id,f.chapters[1023].id);assert.match(found.items[0].excerpt,/青铜罗盘/);
  assert.equal(search({query:'#1024'}).items[0].id,f.chapters[1023].id);
  assert.equal(search({query:'第1024章'}).total,1);
  assert.equal(search({kind:'chapter',volume:'第 11 卷'}).total,100);
  const page=search({kind:'chapter',offset:1170});assert.equal(page.items.length,30);assert.equal(page.items[0].data.number,1171);assert.equal(page.nextOffset,null);
  assert.equal(search({kind:'shot',chapterId:f.chapters[1023].id}).total,5);
  const other=randomUUID();x.app.bus.execute({projectId:other,requestId:randomUUID(),operation:'project.create',payload:{title:'其他工程'}},{source:'human'});
  assert.equal(x.app.store.discovery.search(other,SearchQuery.parse({query:'青铜罗盘'})).total,0);
  assert.throws(()=>x.app.object(other,'chapter',f.chapters[1023].id),/不属于/);
  assert.equal(x.app.object(x.pid,'chapter',f.chapters[1023].id).data.body,f.chapters[1023].data.body);
  console.log(JSON.stringify({longform:{chapters:1200,shots:6000,catalogBytes:bytes,chapterPageBytes:Buffer.byteLength(JSON.stringify(page))}}));
 }finally{x.close();}
});

test('09 两章多镜制作单独立排序和时长，固定 Cut 不跟随改编计划',()=>{
 const x=fixture();try{
  const f=seedLongform(x.app,x.pid,3),ids=f.chapters.slice(0,2).map(c=>c.id);
  const original=x.run('episode.fromChapters',{title:'吉皮梯 · 两分钟',chapterIds:ids,targetSeconds:120});
  assert.equal(original.data.shotIds.length,10);
  assert.throws(()=>x.run('episode.update',{id:original.id,expectedSeq:1,data:{...original.data,shotIds:[f.shots[10].id]}}),/来源章节/);
  const reversed=[...original.data.shotIds].reverse(),ep=x.run('episode.schedule',{id:original.id,expectedSeq:1,shotIds:reversed});
  assert.equal(x.app.storyboard.repo.get(f.shots[0].id,x.pid).data.order,0);
  const search=x.app.store.discovery.search(x.pid,SearchQuery.parse({kind:'shot',episodeId:ep.id}));assert.deepEqual(search.items.map(s=>s.id),reversed);
  assert.throws(()=>x.run('cut.fromBoard',{title:'过期',episode:{id:ep.id,expectedSeq:1}}),/已变化/);
  const cut=x.run('cut.fromBoard',{title:'两章预演',episode:{id:ep.id,expectedSeq:ep.seq}});
  assert.equal(cut.data.clips.length,10);assert.equal(cutDuration(cut.data),24*120);assert.deepEqual(cut.data.clips.map((c:any)=>c.shot.id),reversed);
  assert.equal(cut.data.episode.seq,ep.seq);assert.equal(cut.data.chapters.length,2);
  const changed=x.run('episode.update',{id:ep.id,expectedSeq:ep.seq,data:{...ep.data,shotFrames:{[reversed[0]]:24*6}}});
  const shorter=x.run('cut.fromBoard',{title:'改编节奏',episode:{id:ep.id,expectedSeq:changed.seq}});
  assert.equal(cutDuration(shorter.data),24*114);assert.equal(cutDuration(x.app.editorial.repo.get(cut.id,x.pid).data),24*120);
  assert.equal(x.app.storyboard.repo.get(reversed[0],x.pid).data.durationFrames,24*12);
  const scene=f.scenes[0];x.run('scene.update',{id:scene.id,expectedSeq:scene.seq,data:{...scene.data,chapterId:f.chapters[2].id}});
  assert.throws(()=>x.run('cut.fromBoard',{title:'归属变化',episode:{id:ep.id,expectedSeq:changed.seq}}),/归属已变化/);
 }finally{x.close();}
});

test('09 Agent 检索与字符分页、局部修改审批保留全文，旧基准不覆盖人工编辑',async()=>{
 let tool:any;
 const x=fixture({agentFactory:()=>({async start(){return 'fixture';},async turn(_id,_text,_event,onTool){tool=onTool;return 'turn';},async interrupt(){},close(){}})});
 try{
  const body='前文'.repeat(10000)+'青铜罗盘'+'后文'.repeat(10000),c=x.run('chapter.create',{title:'长章节',number:1024,body}),ref=x.run('chapter.checkpoint',{id:c.id,expectedSeq:1});
  const t=x.run('thread.create',{title:'局部改写',bindings:[{ref,purpose:'修改本章',selection:{field:'body',from:20000,to:20004,text:'青铜罗盘'}}]}),owner=randomUUID();
  x.run('thread.claim',{id:t.id,expectedSeq:t.seq,owner});x.run('thread.send',{id:t.id,owner,text:'修改选区'});await until(()=>tool,Boolean);
  const found=await tool('dreamer_search',{kind:'chapter',query:'#1024'},'search');assert.equal(found.items.length,1);assert.equal(found.items[0].data.body,undefined);assert.deepEqual(found.items[0].ref,ref);
  const partial=await tool('dreamer_read',{kind:'chapter',ref,offset:19990,limit:24},'read');assert.equal(partial.data.body.length,24);assert.equal(partial.contentPage.total,40004);assert.equal(partial.contentPage.partial,true);
  const bad={title:'错误覆盖',reason:'测试',groups:[{id:randomUUID(),title:'组',operations:[{kind:'chapter',id:c.id,expectedSeq:1,base:ref,data:{...c.data,body:partial.data.body}}]}]};
  await assert.rejects(tool('change_propose',bad,'unsafe'),/change_text/);
  const args={base:ref,field:'body',start:20000,end:20004,expectedText:'青铜罗盘',replacement:'星河罗盘',title:'替换法器',reason:'统一名称'};
  const receipt=await tool('change_text',args,'patch'),proposal=receipt.result;
  assert.equal(x.app.chapters.repo.get(c.id,x.pid).data.body,body);
  const approved=x.run('change.approve',{id:proposal.id,expectedSeq:proposal.seq,groups:proposal.data.groups.map((g:any)=>g.id)});x.run('change.apply',{id:approved.id,expectedSeq:approved.seq});
  assert.equal(x.app.chapters.repo.get(c.id,x.pid).data.body,body.replace('青铜罗盘','星河罗盘'));
  const stale=(await tool('change_text',args,'stale')).result;
  assert.throws(()=>x.run('change.approve',{id:stale.id,expectedSeq:stale.seq,groups:stale.data.groups.map((g:any)=>g.id)}),/基准已变化/);
  assert.deepEqual(contentWindow(c,999999,100).contentPage,{field:'body',offset:body.length,end:body.length,total:body.length,nextOffset:null,partial:true});
 }finally{x.close();}
});
