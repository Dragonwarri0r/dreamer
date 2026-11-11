import {chromium,type Page} from 'playwright';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Application} from '../apps/host/application.ts';
import {createHost} from '../apps/host/server.ts';
import {ScriptRelease} from '../packages/contracts/experience.ts';
import {ScriptPlanData,GenerationContract} from '../packages/contracts/interactive-script.ts';
import {contentHash} from '../packages/core/story/script.ts';
import {seedInteractiveStory} from './interactive-fixture.ts';

// Isolated progressive-disclosure acceptance. Reuses an existing movie; dispatches no models.
const output=resolve(process.env.DREAMER_UI_ORGANIZATION_OUTPUT??'test-results/ui-organization-20261023/consumer');
mkdirSync(output,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'dreamer-ui-organization-'));
let modelCalls=0;
const app=new Application(root,{providers:[],recover:false,runtimeGenerator:{configuration:()=>({fingerprint:'b'.repeat(64),description:{model:'ui-fixture-no-network'}}),async execute(){modelCalls++;throw new Error('This UI fixture must not dispatch a model');},async reconcile(){modelCalls++;throw new Error('This UI fixture must not reconcile a model');}}});
const projectId=randomUUID();
app.bus.execute({projectId,requestId:randomUUID(),operation:'project.create',payload:{title:'功能收纳 · 消费侧验收',width:320,height:576,fps:24}},{source:'human'});
const f=await seedInteractiveStory(app,projectId,false);
const mediaPath=resolve(process.env.DREAMER_CONSUMER_MEDIA??'test-results/interactive-script/real-local-20261023-v11/generated-0.mp4');
assert.ok(existsSync(mediaPath));
const artifact=await app.production.import(projectId,mediaPath,'复用既有 H3 视频'),track=randomUUID();
const cut=f.command('cut.create',{title:'收纳验收视频',width:320,height:576,fps:24,tracks:[{id:track,title:'画面',type:'video'}],clips:[{id:randomUUID(),trackId:track,title:'城门',atFrame:0,durationFrames:124,sourceInFrame:0,sourceFps:24,artifact}]});
const build=f.command('build.create',{id:cut.id,expectedSeq:cut.seq,title:'固定成片'}),readyBuild=app.editorial.builds.save(build.id,projectId,build.seq,{...build.data,state:'completed',output:artifact});
app.editorial.builds.checkpoint(readyBuild.id,projectId,readyBuild.seq);
const media=app.scriptMedia(projectId).find((item:any)=>item.media.buildRef.id===readyBuild.id)!;
f.plan.nodes=f.plan.nodes.map(node=>node.type==='segment'?{...node,contentSpec:{mode:'fixed',media:media.media}}:node) as any;
f.plan.cues=f.plan.cues.map(cue=>({...cue,deadlineFrame:100,resolvedBinding:{planId:media.planId,contentHash:media.media.contentHash,fps:24,appearFrame:24}}));
f.script=f.command('script.update',{id:f.script.id,expectedSeq:f.script.seq,data:f.plan});
const release=f.command('script.publish',{id:f.script.id,expectedSeq:f.script.seq,kind:'playback',confirmGeneration:false}).release;
const start=(uid:string,releaseId=release.id)=>app.experienceRuntime.start({projectId,uid},{protocolVersion:1,requestId:randomUUID(),projectId,releaseId,mode:'playback'}).view;
const server=createHost(app);
await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
const base=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),checks:string[]=[],errors:string[]=[],geometry:any[]=[];
page.on('pageerror',error=>errors.push(error.message));
const url=(runId?:string,uid='reader-1')=>`${base}/?${new URLSearchParams({project:projectId,window:randomUUID(),editor:'experience',title:'互动体验',binding:`uid:${uid}`,...(runId?{object:runId}:{})})}`;
const more=()=>page.getByRole('button',{name:'更多体验操作',exact:true});
const profile=()=>page.getByLabel('当前体验 UID',{exact:true});
async function hidden(target:ReturnType<Page['locator']>){assert.equal(await target.isVisible(),false);}
async function compact(){await hidden(profile());await hidden(page.getByRole('button',{name:'回看与导出视频',exact:true}));await hidden(page.getByRole('button',{name:'查看已走路线',exact:true}));await hidden(page.getByRole('button',{name:'结束这次体验',exact:true}));await hidden(page.getByRole('link',{name:'导出本次路线清单',exact:true}));}
async function openRun(runId:string,uid:string){await page.goto(url(runId,uid));await page.getByLabel('互动故事视频',{exact:true}).waitFor();await page.getByRole('button',{name:/^(继续故事|等待当前输入)$/}).waitFor();}
async function cue(){if(await page.getByRole('button',{name:'继续故事',exact:true}).isVisible())await page.getByRole('button',{name:'继续故事',exact:true}).click();await page.getByText('请先完成当前输入，再继续故事。',{exact:true}).waitFor();}
async function openMore(){await more().click();assert.equal(await more().getAttribute('aria-expanded'),'true');}
async function closeWithEscape(){await page.keyboard.press('Escape');assert.equal(await more().getAttribute('aria-expanded'),'false');assert.equal(await more().evaluate(element=>element===document.activeElement),true);}
async function geometryCheck(label:string){const value=await page.evaluate(label=>({label,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,heading:(()=>{const r=document.querySelector('.experience-heading')!.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width};})(),controls:[...document.querySelectorAll('.experience-heading button')].filter(el=>(el as HTMLElement).offsetParent!==null).map(el=>{const r=el.getBoundingClientRect();return{label:el.textContent,x:r.x,right:r.right,width:r.width,height:r.height};})}),label);assert.ok(value.scrollWidth<=value.width,JSON.stringify(value));for(const item of value.controls){assert.ok(item.x>=0&&item.right<=value.width,JSON.stringify(value));assert.ok(item.height>=32,JSON.stringify(value));}geometry.push(value);}

try{
 const existing=start('reader-1');
 await page.goto(url());await page.getByRole('heading',{name:'我的体验',exact:true}).waitFor();
 await page.getByRole('button',{name:'管理档案',exact:true}).waitFor();await compact();
 assert.equal(await more().count(),0);
 await page.getByRole('button',{name:'管理档案',exact:true}).click();await profile().waitFor();
 await page.keyboard.press('Escape');await hidden(profile());
 assert.equal(await page.getByRole('button',{name:'管理档案',exact:true}).evaluate(element=>element===document.activeElement),true);
 await page.getByRole('button',{name:'管理档案',exact:true}).click();await page.getByRole('button',{name:'切换档案',exact:true}).click();await hidden(profile());assert.equal(await page.getByRole('button',{name:'管理档案',exact:true}).evaluate(element=>element===document.activeElement),true);
 checks.push('目录默认只显示管理档案入口；UID 编辑按需展开，Esc 收起并返回触发器焦点，提交相同 UID 也收起');

 await openRun(existing.run.id,'reader-1');await compact();await more().waitFor();
 await more().focus();await page.keyboard.press('Enter');assert.equal(await more().getAttribute('aria-expanded'),'true');
 await page.getByRole('button',{name:'回看与导出视频',exact:true}).waitFor();await page.getByRole('button',{name:'查看已走路线',exact:true}).waitFor();
 await page.getByRole('button',{name:'结束这次体验',exact:true}).waitFor();await profile().waitFor();
 await closeWithEscape();await compact();
 checks.push('播放页默认收起回看、路线、结束和 UID；更多体验操作可键盘展开，Esc 收起且保留焦点');

 await cue();await openMore();await page.getByRole('button',{name:'回看与导出视频',exact:true}).click();
 await page.getByRole('button',{name:'返回当前体验',exact:true}).waitFor();await compact();
 await page.getByRole('button',{name:'返回当前体验',exact:true}).click();await page.getByLabel('当前互动',{exact:true}).waitFor();assert.equal(await more().evaluate(element=>element===document.activeElement),true);
 await openMore();await page.getByRole('button',{name:'查看已走路线',exact:true}).click();
 await page.getByRole('heading',{name:'已走路线',exact:true}).waitFor();await hidden(profile());
 await page.getByRole('button',{name:'收起路线',exact:true}).click();await hidden(page.getByRole('heading',{name:'已走路线',exact:true}));assert.equal(await more().evaluate(element=>element===document.activeElement),true);
 checks.push('回看与路线查看仍能从更多操作进入；进入后自动收起工具，回到体验仍保留当前互动');

 await openMore();await page.getByRole('button',{name:'结束这次体验',exact:true}).click();await page.getByRole('button',{name:'继续这次体验',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('role')),'alert');
 await page.getByRole('button',{name:'继续这次体验',exact:true}).click();assert.equal(await more().evaluate(element=>element===document.activeElement),true);
 assert.notEqual(app.experienceRuntime.view({projectId,uid:'reader-1'},existing.run.id).run.status,'abandoned');
 checks.push('结束体验从更多进入后聚焦明确确认区；放弃结束回到更多按钮焦点，不发送结束命令');

 await openMore();await profile().fill('reader-2');await page.getByRole('button',{name:'切换档案',exact:true}).click();
 await page.getByRole('heading',{name:'我的体验',exact:true}).waitFor();await compact();
 await page.getByText('这个档案还没有体验记录。',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'已走路线',exact:true}).count(),0);
 await page.getByRole('button',{name:'管理档案',exact:true}).click();assert.equal(await profile().inputValue(),'reader-2');await page.keyboard.press('Escape');
 checks.push('切换 UID 后回到新档案目录并收起工具和旧路线，原档案进度不会泄漏');

 for(const size of [{width:320,height:568},{width:390,height:844},{width:844,height:390}]){
  await page.setViewportSize(size);await openRun(existing.run.id,'reader-1');await compact();await geometryCheck(`${size.width}x${size.height}-compact`);await page.screenshot({path:join(output,`watch-${size.width}x${size.height}.png`)});
  await openMore();await profile().waitFor();await geometryCheck(`${size.width}x${size.height}-expanded`);
  const panelWidth=await profile().evaluate(element=>{let p=element.parentElement;while(p&&p.className!=='experience-tools')p=p.parentElement;const box=(p??element).getBoundingClientRect();return{left:box.left,right:box.right,width:innerWidth};});assert.ok(panelWidth.left>=0&&panelWidth.right<=panelWidth.width,JSON.stringify(panelWidth));
  await page.screenshot({path:join(output,`menu-${size.width}x${size.height}.png`),fullPage:true});await closeWithEscape();
 }
 checks.push('320 窄屏、390 手机和 844 横屏的标题操作与展开工具无横向溢出，入口保持可点击');

 const recovery=start('recover');await page.setViewportSize({width:390,height:844});await openRun(recovery.run.id,'recover');
 await openMore();await page.getByRole('button',{name:'全屏播放',exact:true}).click();assert.equal(await more().getAttribute('aria-expanded'),'false');await hidden(profile());await cue();
 const submittedIds:string[]=[];await page.route('**/api/experience/commands?*',async route=>{const body=route.request().postDataJSON();if(body.operation==='activity.submit'){submittedIds.push(body.requestId);if(submittedIds.length===1){await route.abort();return;}}await route.continue();});
 await page.getByRole('button',{name:'帮助受伤的守卫',exact:true}).click();await page.getByRole('button',{name:'重新发送同一请求',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>!!document.fullscreenElement?.querySelector('.experience-pending')),true);await hidden(profile());
 await page.screenshot({path:join(output,'recovery-stays-visible.png')});await page.getByRole('button',{name:'重新发送同一请求',exact:true}).click();
 await page.getByText(/已记录：帮助受伤的守卫/).waitFor();assert.equal(submittedIds.length,2);assert.equal(submittedIds[0],submittedIds[1]);
 await page.unrouteAll({behavior:'wait'});await page.evaluate(()=>document.fullscreenElement?document.exitFullscreen():undefined);
 checks.push('进入全屏前收起更多避免 Esc 冲突；原回执恢复始终在全屏故事区域显示，重发沿用原 requestId');

 // Reached generation states are explicit fixture states; no generation dispatch occurs.
 const linear=structuredClone(f.plan);linear.nodes=[{...linear.nodes[0],next:f.ids.enter} as any,linear.nodes.find(n=>n.id===f.ids.enter)!];linear.cues=[];linear.activities=[];linear.variables=[];
 const g=GenerationContract.parse({id:randomUUID(),version:1,scope:'segment',reads:[],narrativeGoal:'守卫等待',allowedChanges:[],outcomeCases:[],fallbackOutcome:'wait',outcomes:[{id:'wait',narrativeRequirement:'继续等待'}],limits:{maxCharacters:100,maxScenes:1,maxShots:1,targetSeconds:5,maxTextCalls:1,maxMediaJobs:0,maxRepairAttempts:0},checks:{structure:true,independentContent:false,mediaReady:true}});
 const dynamic=ScriptPlanData.parse({...linear,title:'准备选项收纳',nodes:linear.nodes.map((n,i)=>i===0?{...n,mode:'generated',contentSpec:{mode:'generated',generationContract:g}}:n),policy:{...linear.policy,maxTextCallsPerRun:1}}),now=new Date().toISOString();
 const dr=ScriptRelease.parse({...release,id:randomUUID(),snapshot:dynamic,manifestHash:contentHash(dynamic),policy:dynamic.policy,generationAuthorization:{policyHash:contentHash(dynamic.policy),confirmedAt:now,source:'human',textConfigurationFingerprint:'b'.repeat(64)}});app.store.experience.create('releases',{projectId},dr,dr.id);
 app.experienceRuntime.hooks.prepare=context=>({...context.instance,status:'writing'});
 const waiting=start('waiting',dr.id);await page.goto(url(waiting.run.id,'waiting'));await page.getByRole('heading',{name:'准备剧本',exact:true}).waitFor();
 await hidden(page.getByRole('button',{name:'取消本次准备',exact:true}));
 await page.getByText('准备选项',{exact:true}).click();await page.getByRole('button',{name:'取消本次准备',exact:true}).click();
 await page.getByRole('heading',{name:'确认取消本次准备？',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('role')),'alert');
 await page.getByRole('button',{name:'保留准备，继续等待',exact:true}).click();assert.equal(app.experienceRuntime.view({projectId,uid:'waiting'},waiting.run.id).instance!.status,'writing');
 assert.equal(await page.locator('.experience-preparation-options summary').evaluate(element=>element===document.activeElement),true);
 checks.push('准备状态默认隐藏低频取消操作，展开后聚焦明确确认区，返回等待还焦点准备选项且不产生取消命令');

 app.experienceRuntime.hooks.prepare=context=>({...context.instance,status:'unknown',recoveryReason:'原任务结果尚未确认'});
 const unknown=start('unknown',dr.id);await page.goto(url(unknown.run.id,'unknown'));await page.getByRole('button',{name:'核对原任务',exact:true}).waitFor();
 await hidden(page.getByRole('button',{name:'取消本次准备',exact:true}));await compact();
 checks.push('未知生成结果的核对原任务直接显示，不需要展开准备选项或更多操作');

 assert.equal(modelCalls,0);assert.equal(app.production.jobs.list(projectId).length,0);assert.deepEqual(errors,[]);
 writeFileSync(join(output,'report.json'),JSON.stringify({passed:true,checks,geometry,errors,newRealModelCalls:0,providerJobs:0,paidRequests:0,nativePhone:false,media:'Existing v11 video reused',verifiedAt:new Date().toISOString()},null,2));console.log(JSON.stringify({output,checks,errors}));
}catch(error){await page.screenshot({path:join(output,'failure.png'),fullPage:true});writeFileSync(join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors,body:(await page.locator('body').innerText()).slice(-7000)},null,2));throw error;}
finally{await page.context().close();await browser.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));app.close();rmSync(root,{recursive:true,force:true});}
