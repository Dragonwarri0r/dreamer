import {openDisclosure} from './browser-disclosure.ts';
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Application } from '../apps/host/application.ts';
import { createHost } from '../apps/host/server.ts';
import { seedInteractiveStory } from './interactive-fixture.ts';
import { seedAdoption } from '../tests/fixtures/interactive-adoption.ts';

const root=mkdtempSync(join(tmpdir(),'dreamer-adoption-ui-')),output=resolve(process.env.DREAMER_BROWSER_OUTPUT??'test-results/interactive-script/adoption');mkdirSync(output,{recursive:true});
const app=new Application(root,{providers:[]}),pid=randomUUID();
const command=(operation:string,payload:unknown)=>app.bus.execute({projectId:pid,requestId:randomUUID(),operation,payload},{source:'human'}).result as any;
command('project.create',{title:'实例提取与修订影响回归'});
const fixed=await seedInteractiveStory(app,pid,true),f=seedAdoption(app,pid,{media:fixed.media.media});
const initial=app.experienceRuntime.view({projectId:pid,uid:f.scope.uid},f.scope.runId);
app.experienceRuntime.execute({projectId:pid,uid:f.scope.uid},{protocolVersion:1,requestId:randomUUID(),runId:f.scope.runId,expectedStateSeq:initial.run.stateSeq,visitId:initial.run.currentVisitId,operation:'segment.complete',payload:{instanceId:f.instanceId,planHash:initial.playback!.planHash,frame:initial.playback!.durationFrames}});
const originalRun=JSON.stringify(app.store.experience.get('runs',f.scope.runId,f.scope).data);
const scene=app.story.repo.get(f.scene.id,pid);command('scene.update',{id:scene.id,expectedSeq:scene.seq,data:{...scene.data,location:'新地点',blocks:[{...scene.data.blocks[0],type:'dialogue',speaker:'守卫',text:'修改后的作者对白'}]}});
command('script.edit',{id:f.script.id,expectedSeq:f.script.seq,ops:[{op:'title.set',title:'个人正文提取与影响检查'}]});
const server=createHost(app);await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const url=`http://127.0.0.1:${(server.address() as any).port}`,browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[],checks:string[]=[];
page.on('pageerror',error=>errors.push(error.message));
try{
 await page.goto(`${url}/?${new URLSearchParams({project:pid,window:'adoption-author',editor:'script',object:f.script.id,title:'提取验证'})}`);await page.getByLabel('互动剧本名称',{exact:true}).waitFor();
 await page.getByRole('button',{name:'制作与发布',exact:true}).click();await openDisclosure(page,'制作影响与任务');await page.getByRole('button',{name:'检查制作影响',exact:true}).click();await page.getByLabel('修订影响分析',{exact:true}).waitFor();
 const impact=await page.getByLabel('修订影响分析',{exact:true}).innerText();for(const type of ['纯元数据','正文','声音','画面'])assert.ok(impact.includes(type),type);assert.ok(impact.includes('查看原来源'));assert.ok(impact.includes('定位 个人段落'));checks.push('影响视图展示分类、关联节点、固定来源与重制说明');
 await openDisclosure(page,'测试档案与历史版本');await page.getByLabel('测试档案 UID',{exact:true}).fill(f.scope.uid);await openDisclosure(page,'体验内容审阅');await page.getByRole('button',{name:'读取此档案的体验',exact:true}).click();await page.getByLabel('待查看体验',{exact:true}).selectOption(f.scope.runId);await page.getByText('只属于这个实例的提取正文。',{exact:false}).waitFor();
 assert.equal(await page.getByLabel('已到达的实例',{exact:true}).inputValue(),f.instanceId);await openDisclosure(page,'提取为作者提案');assert.equal(await page.getByRole('button',{name:'创建正文提案',exact:true}).isDisabled(),true);checks.push('结束后的体验仍可显式查看已走实例，未确认不能提取');
 await openDisclosure(page,'提取为作者提案');await page.getByLabel('提取目标',{exact:true}).selectOption(`chapter:${f.chapter.id}`);await page.getByLabel('我确认将所选个人正文及来源标识公开到本项目的作者提案',{exact:true}).check();await page.screenshot({path:join(output,'disclosure-desktop.png')});
 await page.getByRole('button',{name:'创建正文提案',exact:true}).click();await page.getByRole('heading',{name:'看清每一次改变',exact:true}).waitFor();assert.equal(app.chapters.repo.get(f.chapter.id,pid).data.body,'作者原有正文。');
 await page.getByText('个人实例来源 · 固定正文 v1',{exact:true}).click();assert.ok(await page.locator('.runtime-proposal-source').innerText().then(text=>text.includes('内容哈希')));assert.ok(!JSON.stringify(app.review.changes.list(pid)).includes('不会公开的个人输入'));checks.push('提取仅生成提案，显示固定内容来源，不复制私人变量和输入');
 await page.getByRole('button',{name:'批准全部待处理组',exact:true}).click();await page.getByRole('button',{name:'采用已批准修改',exact:true}).click();await page.getByText('已采用',{exact:true}).first().waitFor();assert.ok(app.chapters.repo.get(f.chapter.id,pid).data.body.includes('只属于这个实例'));assert.equal(JSON.stringify(app.store.experience.get('runs',f.scope.runId,f.scope).data),originalRun);assert.equal(app.production.jobs.list(pid).length,0);checks.push('批准后原子采用，旧体验不变，零生成任务');
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(output,'proposal-mobile.png')});assert.deepEqual(errors,[]);
 writeFileSync(join(output,'report.json'),JSON.stringify({passed:true,checks,errors,externalCalls:0,fixture:'synthetic instance text and local FFmpeg video'},null,2));console.log(JSON.stringify({passed:true,checks,errors}));
}catch(error){await page.screenshot({path:join(output,'failure.png'),fullPage:true});console.error(JSON.stringify({checks,errors,body:(await page.locator('body').innerText()).slice(-6000)}));throw error;}
finally{await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));app.close();rmSync(root,{recursive:true,force:true});}
