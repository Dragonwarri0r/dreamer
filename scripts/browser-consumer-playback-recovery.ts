import {openExperienceTools,experienceAction,experienceProfile,experienceUid,preparationAction} from './experience-ui.ts';
import {chromium,type Page,type Browser} from 'playwright';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Application} from '../apps/host/application.ts';
import {createHost} from '../apps/host/server.ts';
import {seedInteractiveStory} from './interactive-fixture.ts';

// Uses only isolated local FFmpeg fixtures, never real text/video generation.
// Run after the parent experience editor has integrated VideoStage and the current build is ready.
const root=mkdtempSync(join(tmpdir(),'dreamer-consumer-playback-')),output=resolve(process.env.DREAMER_BROWSER_OUTPUT??'test-results/consumer-playback-recovery');mkdirSync(output,{recursive:true});
const app=new Application(root,{providers:[],recover:false}),projectId=randomUUID(),uid='playback-regression',checks:string[]=[],cases:any[]=[],errors:string[]=[];
let browser:Browser|undefined,server:ReturnType<typeof createHost>|undefined,currentPage:Page|undefined;
try{
 app.bus.execute({projectId,requestId:randomUUID(),operation:'project.create',payload:{title:'消费播放恢复回归',width:320,height:180,fps:24}},{source:'human'});
 const fixture=await seedInteractiveStory(app,projectId,true),linear=structuredClone(fixture.plan);linear.nodes=[{...linear.nodes[0],next:fixture.ids.enter} as any,linear.nodes.find(node=>node.id===fixture.ids.enter)!];linear.cues=[];linear.activities=[];linear.variables=[];
 const script=fixture.command('script.create',linear),release=fixture.command('script.publish',{id:script.id,expectedSeq:script.seq,kind:'playback',confirmGeneration:false}).release;
 const cueRelease=fixture.command('script.publish',{id:fixture.script.id,expectedSeq:fixture.script.seq,kind:'playback',confirmGeneration:false}).release;
 server=createHost(app);await new Promise<void>((ok,fail)=>{server!.once('error',fail);server!.listen(0,'127.0.0.1',ok);});const url='http://127.0.0.1:'+(server.address() as any).port;
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 async function openRun(releaseId:string,name:string){
  const run=app.experienceRuntime.start({projectId,uid},{protocolVersion:1,requestId:randomUUID(),projectId,releaseId,mode:'playback'}).view.run;
  const page=await browser!.newPage({viewport:{width:1100,height:850}});currentPage=page;page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url+'/?'+new URLSearchParams({project:projectId,window:name,editor:'experience',object:run.id,binding:'uid:'+uid}));
  await page.getByLabel('互动故事视频',{exact:true}).waitFor();await page.waitForFunction(()=>{const video=document.querySelector('video');return !!video&&video.readyState>=1;});return {run,page,video:page.getByLabel('互动故事视频',{exact:true})};
 }
 for(const mode of ['transport','conflict-once','conflict-bounded']){
  const {run,page,video}=await openRun(release.id,'completion-'+mode);let completions=0;const bodies:any[]=[];
  await page.route('**/api/experience/commands?*',async route=>{
   const body=route.request().postDataJSON();if(body.operation==='segment.complete'){
    completions++;bodies.push(body);
    if(mode==='transport'&&completions===1){await route.abort('failed');return;}
    if(mode.startsWith('conflict')&&completions<=(mode==='conflict-once'?1:2)){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'CONFLICT',message:'剧情状态已更新，请刷新后重试'}})});return;}
   }
   await route.continue();
  });
  await video.evaluate((element:HTMLVideoElement)=>{element.currentTime=2.85;void element.play();});
  if(mode==='transport'){
   await page.getByRole('heading',{name:'有提交尚未收到回执',exact:true}).waitFor();await page.waitForTimeout(1800);
   assert.equal(completions,1,'Unknown completion must not create a fresh automatic request');assert.equal(app.experienceRuntime.view({projectId,uid},run.id).run.status,'active');
   assert.equal(await page.getByRole('button',{name:'继续故事',exact:true}).isDisabled(),true);
   await page.getByRole('button',{name:'重新发送同一请求',exact:true}).click();await page.getByRole('heading',{name:'故事已结束',exact:true}).waitFor();
   assert.equal(completions,2);assert.equal(bodies[0].requestId,bodies[1].requestId);checks.push('结束提交网络中断保留原请求，不自动新发；原请求重发在页面内恢复');
  }else if(mode==='conflict-once'){
   await page.getByRole('heading',{name:'故事已结束',exact:true}).waitFor();assert.equal(completions,2);assert.notEqual(bodies[0].requestId,bodies[1].requestId);checks.push('结束提交一次明确状态冲突后刷新并有界恢复，无需整页刷新');
  }else{
   await page.getByRole('button',{name:'继续故事',exact:true}).waitFor();await page.waitForTimeout(1800);assert.equal(completions,2,'Conflicts must not cause an unbounded automatic retry loop');
   assert.equal(app.experienceRuntime.view({projectId,uid},run.id).run.status,'active');assert.equal(await page.getByRole('button',{name:'继续故事',exact:true}).isEnabled(),true);
   await page.getByRole('button',{name:'继续故事',exact:true}).click();await page.getByRole('heading',{name:'故事已结束',exact:true}).waitFor();assert.equal(completions,3);checks.push('连续明确冲突停止自动重试，显式继续故事可再次提交进度');
  }
  cases.push({mode,completionRequests:completions,requestIds:bodies.map(body=>body.requestId),status:app.experienceRuntime.view({projectId,uid},run.id).run.status});
  await page.screenshot({path:join(output,mode+'.png'),fullPage:true});await page.close();currentPage=undefined;
 }
 {
  const {run,page,video}=await openRun(cueRelease.id,'cue-continuation');await page.getByRole('button',{name:'继续故事',exact:true}).click();
  await page.getByRole('button',{name:'帮助受伤的守卫',exact:true}).waitFor();await page.waitForFunction(()=>{const element=document.querySelector('video');return !!element&&element.paused&&element.currentTime>=1.45;});
  await page.getByRole('button',{name:'帮助受伤的守卫',exact:true}).click();await page.waitForFunction(()=>{const element=document.querySelector('video');return !!element&&!element.paused&&element.currentTime>1.65;});
  checks.push('正在播放的片段在必填输入截止暂停，选择成功后按原播放意图继续');
  await page.getByRole('heading',{name:'帮助守卫',exact:true}).waitFor();await page.waitForFunction(()=>{const element=document.querySelector('video');return !!element&&!element.paused&&element.currentTime>.1;});
  checks.push('新片段继承用户播放意图与原生原声，无需再次点击播放');await page.getByRole('heading',{name:'故事已结束',exact:true}).waitFor();
  assert.equal(app.experienceRuntime.view({projectId,uid},run.id).run.status,'completed');await page.close();currentPage=undefined;
 }
 {
  const {page,video}=await openRun(cueRelease.id,'manual-pause');await video.evaluate((element:HTMLVideoElement)=>{element.currentTime=1;});
  await page.getByRole('button',{name:'帮助受伤的守卫',exact:true}).waitFor();assert.equal(await video.evaluate((element:HTMLVideoElement)=>element.paused),true);
  await page.getByRole('button',{name:'帮助受伤的守卫',exact:true}).click();await page.getByText(/已记录：帮助受伤的守卫/).waitFor();await page.waitForTimeout(350);
  assert.equal(await video.evaluate((element:HTMLVideoElement)=>element.paused),true);checks.push('主动保持暂停时，选择完成不会擅自播放；明确继续按钮仍可用');
  await page.getByRole('button',{name:'继续故事',exact:true}).click();await experienceAction(page,'回看与导出视频');await page.getByRole('button',{name:'返回当前体验',exact:true}).click();await video.waitFor();
  await page.waitForFunction(()=>{const element=document.querySelector('video');return !!element&&element.readyState>=1;});assert.equal(await video.evaluate((element:HTMLVideoElement)=>element.paused),true);
  checks.push('进入历史后清除自动续播意图，返回当前体验保持暂停');await page.screenshot({path:join(output,'manual-pause-history.png'),fullPage:true});await page.close();currentPage=undefined;
 }
 assert.equal(app.production.jobs.list(projectId).length,0);assert.deepEqual(errors,[]);
 writeFileSync(join(output,'report.json'),JSON.stringify({passed:true,checks,cases,errors,modelCalls:0,providerJobs:0,fixture:'Local FFmpeg fixed media; no AI output',verifiedAt:new Date().toISOString()},null,2));console.log(JSON.stringify({passed:true,checks,cases,output}));
}catch(error){if(currentPage)await currentPage.screenshot({path:join(output,'failure.png'),fullPage:true});writeFileSync(join(output,'failure.json'),JSON.stringify({error:String(error),checks,cases,errors},null,2));throw error;}
finally{try{await browser?.close();}finally{try{if(server?.listening){server.closeAllConnections();await new Promise<void>(ok=>server!.close(()=>ok()));}}finally{app.close();rmSync(root,{recursive:true,force:true});}}}
