import {chromium,type Page,type Browser} from 'playwright';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Application} from '../apps/host/application.ts';
import {createHost} from '../apps/host/server.ts';
import {execute,mediaBinary} from '../packages/infra/media.ts';
import {seedInteractiveStory} from './interactive-fixture.ts';

// Responsive UX acceptance uses isolated data and local fixed media, never a model/provider.
const output=resolve(process.env.DREAMER_BROWSER_OUTPUT??'test-results/ui-ux-fixes-20261023/layout');mkdirSync(output,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'dreamer-ux-layout-')),app=new Application(root,{providers:[],recover:false}),projectId=randomUUID(),uid='layout-reader';
const checks:string[]=[],geometry:any[]=[],errors:string[]=[];let browser:Browser|undefined,server:ReturnType<typeof createHost>|undefined,page:Page|undefined;
try{
 app.bus.execute({projectId,requestId:randomUUID(),operation:'project.create',payload:{title:'互动布局验收',width:320,height:576,fps:24}},{source:'human'});
 const f=await seedInteractiveStory(app,projectId,false),reused=process.env.DREAMER_CONSUMER_MEDIA;
 const mediaPath=reused?resolve(reused):join(root,'portrait.mp4');
 if(reused)assert.ok(existsSync(mediaPath));else await execute(mediaBinary('ffmpeg'),['-y','-v','error','-f','lavfi','-i','color=c=0x416b65:s=320x576:r=24','-f','lavfi','-i','sine=frequency=330:sample_rate=32000','-frames:v','124','-t','5.166667','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',mediaPath]);
 const artifact=await app.production.import(projectId,mediaPath,'本地既有布局测试素材'),track=randomUUID();
 const cut=f.command('cut.create',{title:'布局验收素材',width:320,height:576,fps:24,tracks:[{id:track,title:'画面',type:'video'}],clips:[{id:randomUUID(),trackId:track,title:'城门',atFrame:0,durationFrames:124,sourceInFrame:0,sourceFps:24,artifact}]}),build=f.command('build.create',{id:cut.id,expectedSeq:cut.seq,title:'固定成片'});
 const ready=app.editorial.builds.save(build.id,projectId,build.seq,{...build.data,state:'completed',output:artifact});app.editorial.builds.checkpoint(ready.id,projectId,ready.seq);
 const media=app.scriptMedia(projectId).find((item:any)=>item.media.buildRef.id===ready.id)!;
 f.plan.nodes=f.plan.nodes.map(node=>node.type==='segment'?{...node,contentSpec:{mode:'fixed',media:media.media}}:node) as any;
 f.plan.cues=f.plan.cues.map(cue=>({...cue,deadlineFrame:100,resolvedBinding:{planId:media.planId,contentHash:media.media.contentHash,fps:24,appearFrame:24}}));
 f.script=f.command('script.update',{id:f.script.id,expectedSeq:f.script.seq,data:f.plan});
 const release=f.command('script.publish',{id:f.script.id,expectedSeq:f.script.seq,kind:'playback',confirmGeneration:false}).release;
 const longPlan=structuredClone(f.plan);longPlan.title='长选项布局';const choice:any=longPlan.activities[0];choice.config.options=choice.config.options.map((option:any,index:number)=>({...option,label:`选择${index+1}：${'先观察城门附近的环境，再向受伤的守卫说明我的来意，并且等待他的答复。'.repeat(5)}`}));
 const longScript=f.command('script.create',longPlan),longRelease=f.command('script.publish',{id:longScript.id,expectedSeq:longScript.seq,kind:'playback',confirmGeneration:false}).release;
 server=createHost(app);await new Promise<void>((ok,fail)=>{server!.once('error',fail);server!.listen(0,'127.0.0.1',ok);});const base=`http://127.0.0.1:${(server.address() as any).port}`;
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 async function openRun(size:{width:number;height:number},releaseId=release.id){
  if(page)await page.close();page=await browser!.newPage({viewport:size});page.on('pageerror',error=>errors.push(error.message));
  const view=app.experienceRuntime.start({projectId,uid},{protocolVersion:1,requestId:randomUUID(),projectId,releaseId,mode:'playback'}).view;
  await page.goto(`${base}/?${new URLSearchParams({project:projectId,window:randomUUID(),editor:'experience',object:view.run.id,binding:`uid:${uid}`})}`);
  await page.getByLabel('互动故事视频',{exact:true}).waitFor();await page.waitForFunction(()=>{const video=document.querySelector('video');return !!video&&video.readyState>=1;});return view.run;
 }
 async function cueByKeyboard(){
  const button=page!.getByRole('button',{name:'继续故事',exact:true});await button.evaluate(element=>element.setAttribute('data-layout-control','same-button'));await button.focus();await button.press('Enter');
  assert.equal(await page!.getByRole('button',{name:'暂停故事',exact:true}).getAttribute('data-layout-control'),'same-button','The focused playback control must retain its DOM node');
  await page!.getByText('请先完成当前输入，再继续故事。',{exact:true}).waitFor();
 }
 async function readGeometry(label:string){
  const value=await page!.evaluate(label=>{
   const panel=document.querySelector('.experience-editor')!,activity=document.querySelector('.experience-activity')!,video=document.querySelector('video')!,stage=document.querySelector('.experience-stage')!;
   const [panelRect,activityRect,videoRect,stageRect]=[panel,activity,video,stage].map(element=>{const b=element.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,height:b.height};});
   const options=[...document.querySelectorAll('.experience-options button')].map(element=>{const b=element.getBoundingClientRect(),hit=document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,height:b.height,centerHit:!!hit&&(hit===element||element.contains(hit))};});
   return {label,viewport:{width:innerWidth,height:innerHeight},horizontalOverflow:document.documentElement.scrollWidth>innerWidth,panel:{...panelRect,scrollTop:panel.scrollTop,scrollHeight:panel.scrollHeight,clientHeight:panel.clientHeight},stage:stageRect,video:videoRect,activity:activityRect,options,activeElement:{tag:document.activeElement?.tagName,inActivity:activity.contains(document.activeElement),text:document.activeElement?.textContent?.slice(0,60)}};
  },label);geometry.push(value);return value;
 }
 async function assertAllOptionsReachable(){
  const buttons=page!.locator('.experience-options button');assert.equal(await buttons.count(),3);
  for(let i=0;i<3;i++){const button=buttons.nth(i);await button.scrollIntoViewIfNeeded();assert.equal(await button.evaluate(element=>{const b=element.getBoundingClientRect(),hit=document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);return !!hit&&(hit===element||element.contains(hit));}),true,`Option ${i+1} must receive pointer input`);}
 }
 for(const size of [{width:1440,height:1000},{width:390,height:844},{width:375,height:667},{width:320,height:568},{width:844,height:390}]){
  await openRun(size);await cueByKeyboard();const value=await readGeometry(`${size.width}x${size.height}`);
  assert.equal(value.horizontalOverflow,false);assert.ok(value.video.height>=180,JSON.stringify(value));assert.ok(value.video.height<=560,JSON.stringify(value));
  assert.equal(value.activeElement.inActivity,true,'At required input, keyboard focus should enter the interaction');
  const overlap=Math.min(value.video.right,value.activity.right)>Math.max(value.video.left,value.activity.left)&&Math.min(value.video.bottom,value.activity.bottom)>Math.max(value.video.top,value.activity.top);assert.equal(overlap,false,'Native video cannot overlay the choices');
  if(size.width===390||size.width===1440){assert.ok(value.video.top>=0&&value.video.bottom<=size.height);assert.ok(value.options.every(option=>option.top>=0&&option.bottom<size.height&&option.centerHit),'Normal portrait and desktop retain video and choices together');}
  assert.equal(value.options[0].centerHit,true,'First choice should be visible automatically at the input deadline');
  assert.ok(value.activity.top>=value.panel.top,'The question heading must remain visible with the first choice');
  await page!.screenshot({path:join(output,`cue-${size.width}x${size.height}.png`)});await assertAllOptionsReachable();
  const scrolled=await page!.locator('.experience-editor').evaluate(element=>{element.scrollTop=0;return element.scrollTop;});await page!.waitForTimeout(1700);assert.equal(await page!.locator('.experience-editor').evaluate(element=>element.scrollTop),scrolled,'Polling must not repeatedly scroll back to the input');
  checks.push(`${size.width}×${size.height} 视频最小180px、不遮选择、首项自动可见、三项可点、键盘聚焦输入且轮询不抢滚动`);
 }
 // The long labels are real frozen release data, not DOM/CSS overrides.
 await openRun({width:320,height:568},longRelease.id);await cueByKeyboard();const longGeometry=await readGeometry('long-options-320x568');assert.equal(longGeometry.horizontalOverflow,false);assert.ok(longGeometry.options.every(option=>option.height>80));assert.equal(longGeometry.options[0].centerHit,true);await assertAllOptionsReachable();await page!.screenshot({path:join(output,'long-options-scroll.png')});checks.push('长选项自然换行并整体滚动，三项都可点击，没有内部裁切或横向溢出');
 // Fullscreen errors and the original-request recovery remain inside the active surface.
 await openRun({width:320,height:568});await page!.getByRole('button',{name:'全屏播放',exact:true}).click();await page!.waitForFunction(()=>!!document.fullscreenElement);await cueByKeyboard();
 const submitIds:string[]=[];await page!.route('**/api/experience/commands?*',async route=>{const body=route.request().postDataJSON();if(body.operation==='activity.submit'){submitIds.push(body.requestId);if(submitIds.length===1){await route.abort();return;}}await route.continue();});
 await page!.getByRole('button',{name:'帮助受伤的守卫',exact:true}).click();await page!.getByRole('heading',{name:'有提交尚未收到回执',exact:true}).waitFor();
 assert.equal(await page!.evaluate(()=>!!document.fullscreenElement?.querySelector('.experience-feedback .experience-pending')),true);assert.equal(await page!.evaluate(()=>!!document.fullscreenElement?.querySelector('.experience-feedback [role="alert"]')),true);
 const retry=page!.getByRole('button',{name:'重新发送同一请求',exact:true});await retry.scrollIntoViewIfNeeded();assert.equal(await retry.evaluate(element=>{const b=element.getBoundingClientRect();return element===document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);}),true);
 await page!.screenshot({path:join(output,'fullscreen-recovery.png')});await retry.click();await page!.getByText(/已记录：帮助受伤的守卫/).waitFor();assert.equal(submitIds.length,2);assert.equal(submitIds[0],submitIds[1]);
 await page!.getByRole('heading',{name:'帮助守卫',exact:true}).waitFor();await page!.waitForFunction(()=>{const video=document.querySelector('video');return !!video&&!video.paused&&video.currentTime>.1;});await page!.getByRole('heading',{name:'故事已结束',exact:true}).waitFor();checks.push('小屏全屏能阅读错误并使用原请求恢复，选择后自动续播、跨段并到达结局');
 // A user's own pause is not overridden when a choice is accepted.
 await openRun({width:390,height:844});await page!.getByRole('button',{name:'继续故事',exact:true}).click();await page!.getByRole('button',{name:'帮助受伤的守卫',exact:true}).waitFor();await page!.getByRole('button',{name:'暂停故事',exact:true}).click();
 const before=await page!.getByLabel('互动故事视频',{exact:true}).evaluate((video:HTMLVideoElement)=>video.currentTime);await page!.getByRole('button',{name:'帮助受伤的守卫',exact:true}).click();await page!.getByText(/已记录：帮助受伤的守卫/).waitFor();await page!.waitForTimeout(500);
 assert.equal(await page!.getByLabel('互动故事视频',{exact:true}).evaluate((video:HTMLVideoElement)=>video.paused),true);assert.ok(Math.abs(await page!.getByLabel('互动故事视频',{exact:true}).evaluate((video:HTMLVideoElement)=>video.currentTime)-before)<.1);await page!.screenshot({path:join(output,'manual-pause-preserved.png')});checks.push('显式暂停后提交选择保持暂停，稳定播放按钮可继续，未擅自恢复用户暂停');
 assert.deepEqual(errors,[]);assert.equal(app.production.jobs.list(projectId).length,0);
 const report={passed:true,checks,geometry,errors,newModelCalls:0,paidRequests:0,providerJobs:0,media:reused?'reused existing local media':'local FFmpeg fixture',nativePhone:false,screenReader:false,virtualKeyboard:false,verifiedAt:new Date().toISOString()};writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){if(page)await page.screenshot({path:join(output,'failure.png'),fullPage:true});writeFileSync(join(output,'failure.json'),JSON.stringify({error:String(error),checks,geometry,errors},null,2)+'\n');throw error;}
finally{try{await browser?.close();}finally{try{if(server?.listening){server.closeAllConnections();await new Promise<void>(ok=>server!.close(()=>ok()));}}finally{app.close();rmSync(root,{recursive:true,force:true});}}}
