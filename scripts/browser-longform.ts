import {chromium} from 'playwright';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Application} from '../apps/host/application.ts';
import {createHost} from '../apps/host/server.ts';
import {seedLongform} from '../tests/fixtures/longform.ts';
import {SearchQuery} from '../packages/contracts/longform.ts';

const root=mkdtempSync(join(tmpdir(),'dreamer-longform-ui-')),output=resolve('test-results/longform');mkdirSync(output,{recursive:true});
let captured:any;
const app=new Application(root,{agentFactory:()=>({
 async start(){return 'longform-ui-fixture';},
 async turn(_id,text,onEvent,onTool){captured=JSON.parse(text);setTimeout(()=>{void(async()=>{
  const result:any=await onTool('dreamer_search',{kind:'chapter',query:'#1024'},'search');
  await onTool('dreamer_read',{kind:'chapter',ref:result.items[0].ref,offset:0,limit:100},'read');
  onEvent({type:'delta',text:'已按固定版本读取第 1024 章的选定范围。'});onEvent({type:'complete'});
 })().catch(e=>onEvent({type:'error',text:e.message}));},50);return 'fixture-turn';},
 async interrupt(){},close(){}
})});
const pid=randomUUID(),run=(operation:string,payload:any)=>app.bus.execute({requestId:randomUUID(),projectId:pid,operation,payload},{source:'human'}).result as any;
run('project.create',{title:'Agent 修仙传 · 千章压力样本',width:320,height:180,fps:24});
const f=seedLongform(app,pid),server=createHost(app);await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
const url=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors:string[]=[],checks:string[]=[],metrics:Record<string,number>={};page.on('pageerror',e=>errors.push(e.message));
try{
 const start=performance.now();await page.goto(`${url}/?project=${pid}`);await page.getByRole('heading',{name:'Agent 修仙传 · 千章压力样本',exact:true}).waitFor();metrics.firstWorkspaceMs=Math.round(performance.now()-start);
 await page.locator('aside nav').getByRole('button',{name:'内容与制作'}).click();await page.locator('aside nav').getByRole('button',{name:'章节书架',exact:true}).click();await page.locator('.chapter-row').first().waitFor();
 assert.equal(await page.locator('.chapter-row').count(),30);assert.ok(await page.locator('body *').count()<1600);checks.push('1200 chapters and 6000 shots: directory renders 30 rows');
 await page.getByLabel('搜索章节').fill('青铜罗盘');await page.waitForFunction(()=>document.querySelectorAll('.chapter-row').length===1);assert.match(await page.locator('.chapter-row').innerText(),/1024/);await page.screenshot({path:join(output,'chapter-search.png')});checks.push('full-text search reaches late chapter');
 await page.getByLabel('添加第 1024 章书签',{exact:true}).click();await page.getByLabel('选择第 1024 章',{exact:true}).check();
 await page.getByLabel('搜索章节').fill('#1025');await page.getByLabel('选择第 1025 章',{exact:true}).check();await page.getByRole('button',{name:'制作 2 分钟短片',exact:true}).click();await page.getByLabel('短片名称',{exact:true}).waitFor();
 assert.equal(await page.locator('.schedule-row').count(),10);const episode=app.episodes.repo.list(pid)[0];assert.equal(episode.data.chapterIds.length,2);assert.equal(episode.data.shotIds.length,10);
 await page.getByRole('button',{name:'均分目标时长',exact:true}).click();await page.getByRole('button',{name:'下移 1024-1 · 吉皮梯镜头',exact:true}).click();await page.getByRole('button',{name:'保存草稿',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.editor-toolbar .primary')?.hasAttribute('disabled'));
 assert.equal(app.episodes.repo.get(episode.id,pid).data.shotIds[0],f.shots[1023*5+1].id);assert.equal(app.storyboard.repo.get(f.shots[1023*5].id,pid).data.order,1023*5);
 await page.getByRole('button',{name:'移出第 1025 章及其镜头',exact:true}).click();assert.equal(await page.locator('.schedule-row').count(),5);await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await page.locator('.schedule-row').count(),10);await page.getByRole('button',{name:'收集章节新镜头',exact:true}).click();assert.equal(await page.locator('.schedule-row').count(),10);await page.getByRole('button',{name:'保存草稿',exact:true}).click();
 await page.screenshot({path:join(output,'episode-schedule.png')});checks.push('two chapters to ten ordered shots / 120 seconds; plan ordering does not reorder book');
 await page.getByRole('button',{name:'分镜视图',exact:true}).click();await page.locator('.shot-card').first().waitFor();assert.equal(await page.locator('.shot-card').count(),10);await page.getByRole('button',{name:'编排短片',exact:true}).click();await page.getByLabel('短片名称').waitFor();checks.push('board opens only the selected episode');
 await page.getByRole('button',{name:'第 1024 章 · 吉皮梯修行 1024',exact:true}).click();await page.getByLabel('章节正文',{exact:true}).waitFor();const before=await page.getByLabel('章节正文').inputValue();assert.equal(before,f.chapters[1023].data.body);
 await page.getByLabel('章节正文').fill(before+'\n人工校订：这是正确的全文。');await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.editor-toolbar .primary')?.hasAttribute('disabled'));
 await page.getByLabel('章节正文').focus();await page.getByLabel('章节正文').press('Meta+ArrowUp');for(let i=0;i<12;i++)await page.getByLabel('章节正文').press('Shift+ArrowRight');await page.getByRole('button',{name:'已选 12 字 · 清除',exact:true}).waitFor();
 await page.getByRole('button',{name:'发送给 Agent',exact:true}).click();await page.getByLabel('选区修改要求').fill('请读取所选章节并确认版本。');await page.getByRole('button',{name:'固定上下文并发送',exact:true}).click();await page.getByText('已按固定版本读取第 1024 章的选定范围。',{exact:true}).waitFor();
 const binding=captured.context.find((b:any)=>b.ref.kind==='chapter');assert.equal(binding.ref.id,f.chapters[1023].id);assert.equal(binding.ref.seq,2);assert.equal(binding.selection?.text,before.slice(0,12));assert.ok(app.chapters.repo.get(binding.ref.id,pid).data.body.endsWith('正确的全文。'));
 checks.push('lazy chapter body edit and selected text to Agent with fixed version; deterministic Agent fixture');
 await page.getByRole('button',{name:/搜索工程/}).click();await page.getByLabel('搜索工程内容').fill('青铜罗盘');await page.locator('.search-results').getByRole('button').filter({hasText:'吉皮梯修行 1024'}).waitFor();await page.locator('.search-results').getByRole('button').filter({hasText:'吉皮梯修行 1024'}).click();await page.getByLabel('章节正文').waitFor();checks.push('global search matches body and opens the correct editable chapter');
 await page.locator('aside nav').getByRole('button',{name:'短片制作单',exact:true}).click();await page.locator('.content-card').filter({hasText:'第 1024–1025 章 · 短片'}).click();await page.getByLabel('短片名称').waitFor();
 await page.getByRole('button',{name:'生成本片预演',exact:true}).click();await page.locator('video.build-video').waitFor({timeout:30000});const b=app.editorial.builds.list(pid)[0];assert.equal(b.data.snapshot.clips.length,10);assert.equal(b.data.range.endFrame,2880);assert.ok(b.data.output);checks.push('scoped 120-second placeholder preview renders; unrelated 5990 shots excluded');
 await page.screenshot({path:join(output,'episode-preview.png')});
 await page.locator('aside nav').getByRole('button',{name:'章节书架',exact:true}).click();await page.getByLabel('搜索章节').fill('');await page.getByRole('button',{name:'书签',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.chapter-row').length===1);await page.reload();await page.locator('.chapter-row').first().waitFor();assert.equal(await page.locator('.chapter-row').count(),1);checks.push('chapter bookmark and directory view recover after reload');
 await page.setViewportSize({width:1050,height:800});await page.screenshot({path:join(output,'compact-library.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 const t=performance.now();const result=app.store.discovery.search(pid,SearchQuery.parse({kind:'chapter',query:'青铜罗盘'}));metrics.bodySearchMs=Math.round(performance.now()-t);metrics.searchResponseBytes=Buffer.byteLength(JSON.stringify(result));metrics.catalogBytes=Buffer.byteLength(JSON.stringify(app.snapshot(pid,true)));metrics.domNodes=await page.locator('body *').count();
 writeFileSync(join(output,'browser-report.json'),JSON.stringify({passed:true,fixture:{chapters:1200,shots:6000},checks,metrics,errors},null,2));console.log(JSON.stringify({passed:true,checks,metrics}));
}catch(e){await page.screenshot({path:join(output,'failure.png'),fullPage:true});console.error(JSON.stringify({checks,errors,body:(await page.locator('body').innerText()).slice(-5000)}));throw e;}
finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));app.close();await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);rmSync(root,{recursive:true,force:true});}
