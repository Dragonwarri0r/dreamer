import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers.ts';
import {ChapterData} from '../packages/contracts/longform.ts';
import {formatNovel,manuscriptCharacters,type NovelChapter} from '../packages/core/story/novel-export.ts';
import {createHost} from '../apps/host/server.ts';

function chapter(number:number,body:string,volume='第一卷'):NovelChapter{return {id:randomUUID(),projectId:randomUUID(),seq:1,updatedAt:'now',data:ChapterData.parse({title:`章节${number}`,number,body,volume,synopsis:'不导出梗概',notes:'不导出备注'})};}
test('小说导出按章节序号排序并保留正文，跳过空章，Unicode 字数不含空白',()=>{
  const body='  原文\n\n𠮷🙂。\r\n尾巴  ',rows=[chapter(3,'\n '),chapter(2,'另一章','第二卷'),chapter(1,body)];
  const result=formatNovel('书名',rows);assert.equal(result.chapterCount,2);assert.equal(result.skippedEmptyCount,1);
  assert.equal(result.totalCharacters,manuscriptCharacters(body)+3);assert.equal(manuscriptCharacters('𠮷🙂 A。\n'),4);
  const text=result.parts[0].text;assert.ok(text.includes(body));assert.ok(text.indexOf('第1章')<text.indexOf('第2章'));assert.ok(text.includes('第二卷'));
  assert.doesNotMatch(text,/不导出/);assert.equal(rows[0].data.number,3);
  assert.throws(()=>formatNovel('空工程',[chapter(1,' \n')]),/没有已保存/);
});
test('小说分文件按完整章节边界，无丢失重复，超长单章单独输出',()=>{
  const rows=[chapter(1,'一'.repeat(6)),chapter(2,'二'.repeat(4)),chapter(3,'三'.repeat(11)),chapter(4,'四'.repeat(2))];
  const result=formatNovel('书名',rows,10);
  assert.deepEqual(result.parts.map(p=>p.chapters.map(c=>c.data.number)),[[1,2],[3],[4]]);
  assert.deepEqual(result.parts.map(p=>p.oversized),[false,true,false]);assert.equal(result.totalCharacters,23);
  assert.ok(result.parts.every(p=>p.text.includes('第一卷')));assert.equal(formatNovel('书名',rows,0).parts.length,1);
});
test('小说导出全部 1001 章，不受分页与状态影响，来源及媒体不变',()=>{
  const x=fixture({recover:false,providers:[]});try{
    const statuses=['outline','draft','review','done'];
    for(let n=1001;n>=1;n--)x.run('chapter.create',{title:`标题${n}`,number:n,body:`正文${n}。`,status:statuses[n%4]});
    x.run('chapter.create',{title:'只有提纲',number:1002,synopsis:'仅梗概'});
    const before=x.app.snapshot(x.pid),input={projectId:x.pid,requestId:randomUUID(),maxCharacters:0};
    const result=x.app.novelExporter.export(input),text=readFileSync(join(result.directory,result.files[0].name),'utf8');
    assert.equal(result.chapterCount,1001);assert.equal(result.skippedEmptyCount,1);assert.equal(result.files.length,1);
    assert.equal([...text.matchAll(/^第\d+章 /gm)].length,1001);assert.ok(text.indexOf('第1章 ')<text.indexOf('第1001章 '));
    assert.deepEqual(x.app.snapshot(x.pid),before);assert.deepEqual(x.app.novelExporter.export(input),result);
    const manifest=JSON.parse(readFileSync(join(result.directory,'manifest.json'),'utf8'));assert.equal(manifest.sources.length,1001);assert.equal(manifest.sources[0].seq,1);
    assert.equal(x.app.production.jobs.list(x.pid).length,0);assert.equal(x.app.production.artifacts.list(x.pid).length,0);
  }finally{x.close();}
});
test('导出回执重试保留原版本，参数冲突拒绝，新导出取得最新正文，项目隔离',()=>{
  const x=fixture({recover:false,providers:[]});try{
    const c=x.run('chapter.create',{title:'标题',number:1,body:'原版'}),input={projectId:x.pid,requestId:randomUUID(),maxCharacters:0};
    const original=x.app.novelExporter.export(input);
    x.run('chapter.update',{id:c.id,expectedSeq:1,data:{...c.data,body:'新版'}});
    assert.deepEqual(x.app.novelExporter.export(input),original);assert.match(readFileSync(join(original.directory,original.files[0].name),'utf8'),/原版/);
    assert.throws(()=>x.app.novelExporter.export({...input,maxCharacters:100000}),/不能更改/);
    const next=x.app.novelExporter.export({...input,requestId:randomUUID()});assert.match(readFileSync(join(next.directory,next.files[0].name),'utf8'),/新版/);
    assert.throws(()=>x.app.novelExporter.file(randomUUID(),original.id,0),/找不到/);
    assert.throws(()=>x.app.novelExporter.file('../',original.id,0));assert.throws(()=>x.app.novelExporter.file(x.pid,original.id,-1));
    assert.throws(()=>x.app.novelExporter.export({...input,requestId:randomUUID(),projectId:randomUUID()}));
    assert.ok(readdirSync(join(original.directory,'..')).every(n=>!n.startsWith('.export-')));
  }finally{x.close();}
});
test('导出文件名防路径穿越，中文长书名可保存',()=>{
  const x=fixture({recover:false,providers:[]});try{
    const p=x.app.projects.repo.get(x.pid,x.pid);x.run('project.update',{id:p.id,expectedSeq:p.seq,data:{...p.data,title:'../乱序/标题:🙂'+ '长'.repeat(140)}});
    x.run('chapter.create',{title:'正文',number:1,body:'内容'});
    const r=x.app.novelExporter.export({projectId:x.pid,requestId:randomUUID()});assert.equal(r.files.length,1);assert.ok(Buffer.byteLength(r.files[0].name)<255);assert.doesNotMatch(r.files[0].name,/[\\/:]/);
    assert.match(readFileSync(x.app.novelExporter.file(x.pid,r.id,0).path,'utf8'),/内容/);
  }finally{x.close();}
});
test('Host 小说导出需要会话与 CSRF，下载内容等于已保存文件',async()=>{
  const x=fixture({recover:false,providers:[]}),server=createHost(x.app);try{
    x.run('chapter.create',{title:'第一章',number:1,body:'张扬的正文。'});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
    const input={projectId:x.pid,requestId:randomUUID(),maxCharacters:0};
    assert.equal((await fetch(origin+'/api/novel-export',{method:'POST',body:JSON.stringify(input)})).status,403);
    const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrf}=await session.json() as any;
    const headers={cookie,origin,'Content-Type':'application/json','X-Dreamer-CSRF':csrf};
    assert.equal((await fetch(origin+'/api/novel-export',{method:'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:JSON.stringify(input)})).status,403);
    const response=await fetch(origin+'/api/novel-export',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,200);const result=await response.json() as any;
    const download=await fetch(origin+result.files[0].downloadUrl,{headers:{cookie}});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition')!,/^attachment;/);assert.match(download.headers.get('content-type')!,/text\/plain/);
    assert.equal(await download.text(),readFileSync(join(result.directory,result.files[0].name),'utf8'));
    assert.equal((await fetch(origin+result.files[0].downloadUrl)).status,403);
    assert.equal((await fetch(origin+result.files[0].downloadUrl.replace('part=0','part=99'),{headers:{cookie}})).status,404);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));x.close();}
});
