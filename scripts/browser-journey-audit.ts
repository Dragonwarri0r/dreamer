import {chromium,type Page} from 'playwright';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Application} from '../apps/host/application.ts';
import {createHost} from '../apps/host/server.ts';
import {execute,mediaBinary} from '../packages/infra/media.ts';

// This fixture never opens the real project or calls a paid / GPU provider.
const root=mkdtempSync(join(tmpdir(),'dreamer-journey-audit-')),out=resolve('test-results/journey-audit');
mkdirSync(out,{recursive:true});
const app=new Application(root),pid=randomUUID();
const run=(operation:string,payload:any)=>app.bus.execute({requestId:randomUUID(),projectId:pid,operation,payload},{source:'human'}).result as any;
run('project.create',{title:'交互回归隔离工程',width:320,height:180,fps:24});
const chapter=run('chapter.create',{title:'平凡的一天',number:1,body:'吉皮梯接过纸条，去街尾替掌柜取六只蒸笼。门前已经排满了等待买饭的人。'});
const scene=run('scene.create',{title:'青瓦巷',chapterId:chapter.id,blocks:[{id:randomUUID(),type:'dialogue',speaker:'掌柜',text:'去街尾取六只蒸笼。'}]});
const sceneRef=run('scene.checkpoint',{id:scene.id,expectedSeq:scene.seq});
await execute(mediaBinary('ffmpeg'),['-y','-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=16:d=6','-an','-c:v','libx264','-pix_fmt','yuv420p',join(root,'video.mp4')]);
const video=await app.production.import(pid,join(root,'video.mp4'),'16fps 动态测试');
const shot=run('shot.create',{title:'取笼镜头',scene:sceneRef,action:'吉皮梯沿小巷走向仓房。',sound:'去街尾取六只蒸笼。',durationFrames:48});
const input=run('shot.checkpoint',{id:shot.id,expectedSeq:shot.seq}),take=run('shot.take',{id:shot.id,input,artifact:video});
run('shot.adopt',{id:shot.id,expectedSeq:app.storyboard.repo.get(shot.id,pid).seq,takeId:take.id});
const episode=run('episode.fromChapters',{title:'第一集',chapterIds:[chapter.id],targetSeconds:4});
let cut=run('cut.fromBoard',{title:'待修改剪辑',episode:{id:episode.id,expectedSeq:episode.seq}});
cut=run('cut.update',{id:cut.id,expectedSeq:cut.seq,data:{...cut.data,clips:cut.data.clips.map((c:any)=>({...c,sourceInFrame:24,sourceFps:24}))}});
const builds=['版本甲','版本乙'].map(title=>run('build.create',{id:cut.id,expectedSeq:cut.seq,title}));
for(const build of builds)run('build.render',{id:build.id,expectedSeq:build.seq});
const server=createHost(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),checks:string[]=[],errors:string[]=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('dialog',d=>void d.accept());
let windowNumber=0;
const open=async(type:string,id?:string)=>{await page.goto(`${base}/?${new URLSearchParams({project:pid,window:`journey-audit-${++windowNumber}`,editor:type,...(id?{object:id}:{})})}`);};
const save=async()=>{await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='保存草稿')?.disabled);};
const waitFor=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,100));}throw Error('fixture condition timed out');};
async function holdObject(p:Page,id:string){
 let release!:()=>void,seen!:()=>void,finished!:()=>void;
 const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r),continued=new Promise<void>(r=>finished=r);
 const match=(u:URL)=>u.pathname==='/api/object'&&u.searchParams.get('id')===id;
 await p.route(match,async route=>{seen();await waiting;try{await route.continue();}finally{finished();}});
 return {started,release:async()=>{release();await continued;await p.unroute(match);}};
}
try{
 await open('scene',scene.id);const block=page.getByLabel('剧本块 1',{exact:true});await block.waitFor();
 await block.focus();await block.press('Meta+ArrowUp');for(let i=0;i<4;i++)await block.press('Shift+ArrowRight');
 await page.getByText('已选 4 字',{exact:true}).waitFor();await block.fill('请先数清六只蒸笼，再回来。');
 assert.equal(await page.getByText('已选 4 字',{exact:true}).count(),0);
 await page.getByLabel('说话人物',{exact:true}).fill('新角色阿婆');await page.getByRole('button',{name:'提取资源需求',exact:true}).click();
 await waitFor(()=>app.resources.repo.list(pid).some(r=>r.data.title==='新角色阿婆'));
 assert.equal(app.story.repo.get(scene.id,pid).data.blocks[0].text,'请先数清六只蒸笼，再回来。');
 console.log('checkpoint',checks.length);checks.push('scene edit clears stale selection; extract resources saves and reads current unsaved dialogue');

 await open('chapter',chapter.id);const body=page.getByLabel('章节正文',{exact:true});await body.waitFor();
 await body.focus();await body.press('Meta+ArrowUp');for(let i=0;i<4;i++)await body.press('Shift+ArrowRight');
 await page.getByRole('button',{name:'已选 4 字 · 清除',exact:true}).waitFor();await body.press('ArrowRight');
 assert.equal(await page.getByRole('button',{name:'已选 4 字 · 清除',exact:true}).count(),0);
 await page.getByLabel('章节名称',{exact:true}).fill('六只蒸笼');await body.fill(chapter.data.body+'\n人群里有人叫了他的名字。');
 await page.getByRole('button',{name:'创建短片制作单',exact:true}).click();await page.getByLabel('短片名称',{exact:true}).waitFor();
 assert.equal(app.chapters.repo.get(chapter.id,pid).data.title,'六只蒸笼');assert.ok(app.chapters.repo.get(chapter.id,pid).data.body.endsWith('名字。'));
 console.log('checkpoint',checks.length);checks.push('collapsed chapter selection clears; episode creation saves the current chapter');

 await open('episode',episode.id);await page.getByLabel('短片名称',{exact:true}).fill('第一集 · 最新编排');
 await page.getByRole('button',{name:'分镜视图',exact:true}).click();await page.getByRole('heading',{name:'第一集 · 最新编排',exact:true}).waitFor();
 assert.equal(app.episodes.repo.get(episode.id,pid).data.title,'第一集 · 最新编排');
 await page.getByLabel('镜头名称',{exact:true}).fill('新建镜头也属于本片');await page.getByRole('button',{name:'添加镜头',exact:true}).click();
 await page.getByLabel('动作',{exact:true}).waitFor();const added=app.storyboard.repo.list(pid).find(s=>s.data.title==='新建镜头也属于本片')!;
 assert.ok(app.episodes.repo.get(episode.id,pid).data.shotIds.includes(added.id));
 console.log('checkpoint',checks.length);checks.push('episode board transition saves ordering/title; newly created board shot joins the current episode');

 await open('production',shot.id);await page.getByLabel('生成描述',{exact:true}).fill('我的尚未提交的生成描述');
 await page.getByRole('button',{name:'返回镜头',exact:true}).click();await page.getByRole('button',{name:'为此镜头生成 / 导入',exact:true}).click();
 assert.equal(await page.getByLabel('生成描述',{exact:true}).inputValue(),'我的尚未提交的生成描述');
 const held=await holdObject(page,shot.id);await page.getByRole('button',{name:'带入镜头描述与参考',exact:true}).click();await held.started;
 await page.getByLabel('生成描述',{exact:true}).fill('读取期间继续输入的最新描述');await held.release();
 await page.getByText('生成输入已变化，保留你当前填写的内容',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('生成描述',{exact:true}).inputValue(),'读取期间继续输入的最新描述');
 await page.reload();await page.getByLabel('生成描述',{exact:true}).waitFor();assert.equal(await page.getByLabel('生成描述',{exact:true}).inputValue(),'读取期间继续输入的最新描述');
 console.log('checkpoint',checks.length);checks.push('generation inputs survive tab navigation/reload; delayed intent reads never overwrite newer typed text');

 await open('cut',cut.id);await page.getByRole('region',{name:'草稿连续预览'}).waitFor();await page.locator('.timeline-clip').first().click();
 const replace=await holdObject(page,shot.id);await page.getByLabel('替换为镜头当前采用候选').selectOption(shot.id);await replace.started;
 await page.getByRole('button',{name:'在当前帧添加字幕',exact:true}).click();await page.getByLabel('字幕 1 内容',{exact:true}).fill('等待素材期间新增的字幕');
 await page.getByLabel('片段时长 / 帧',{exact:true}).fill('36');await replace.release();
 await page.getByText('已替换画面与关联原声，保留裁切时间和独立声音',{exact:true}).waitFor();await save();
 const updated=app.editorial.repo.get(cut.id,pid);assert.equal(updated.data.cues[0].text,'等待素材期间新增的字幕');
 assert.equal(updated.data.clips[0].durationFrames,36);assert.equal(updated.data.clips[0].sourceFps,16);assert.equal(updated.data.clips[0].sourceInFrame,16);
 console.log('checkpoint',checks.length);checks.push('delayed take replacement preserves concurrent subtitle/timing edits and the source in-point in seconds across frame rates');
 await page.screenshot({path:join(out,'timeline-race-fixed.png')});

 await waitFor(()=>builds.every(b=>app.editorial.builds.get(b.id,pid).data.output));
 await open('viewer',builds[0].id);await page.getByLabel('成片批注',{exact:true}).fill('只属于版本甲的意见');
 await page.getByLabel('固定成片版本',{exact:true}).selectOption(builds[1].id);assert.equal(await page.getByLabel('成片批注',{exact:true}).inputValue(),'');
 await page.getByLabel('成片批注',{exact:true}).fill('只属于版本乙的意见');await page.getByLabel('固定成片版本',{exact:true}).selectOption(builds[0].id);
 assert.equal(await page.getByLabel('成片批注',{exact:true}).inputValue(),'只属于版本甲的意见');
 let releaseNote!:()=>void,seenNote!:()=>void;const waitNote=new Promise<void>(r=>releaseNote=r),noteStarted=new Promise<void>(r=>seenNote=r);
 await page.route('**/api/commands',async route=>{if(route.request().postDataJSON().operation==='note.create'){seenNote();await waitNote;}await route.continue();});
 await page.getByRole('button',{name:'保存意见',exact:true}).click();await noteStarted;
 await page.getByLabel('成片批注',{exact:true}).fill('保存期间写的下一条意见');releaseNote();await waitFor(()=>app.review.notes.list(pid).length===1);
 await page.getByText('意见已绑定此 Build 的原始位置',{exact:true}).waitFor();assert.equal(await page.getByLabel('成片批注',{exact:true}).inputValue(),'保存期间写的下一条意见');
 assert.equal(app.review.notes.list(pid)[0].data.target.id,builds[0].id);await page.unroute('**/api/commands');
 await page.getByRole('button',{name:'比较与审阅',exact:true}).click();await page.getByLabel('左侧版本',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('左侧版本',{exact:true}).inputValue(),builds[0].id);
 console.log('checkpoint',checks.length);checks.push('Viewer notes stay scoped to each Build, survive submission races, and compare opens the current version');

 await page.getByRole('button',{name:'意见与修订',exact:true}).click();await page.getByLabel('批注对象',{exact:true}).selectOption(`chapter:${chapter.id}`);
 await page.getByLabel('对象批注内容',{exact:true}).fill('章节层面的连续性检查');await page.getByRole('button',{name:'保存意见',exact:true}).click();
 await waitFor(()=>app.review.notes.list(pid).some(n=>n.data.target.kind==='chapter'));
 await page.getByLabel('批注对象',{exact:true}).selectOption(`episode:${episode.id}`);
 await page.getByLabel('对象批注内容',{exact:true}).fill('制作单节奏检查');await page.getByRole('button',{name:'保存意见',exact:true}).click();
 await waitFor(()=>app.review.notes.list(pid).some(n=>n.data.target.kind==='episode'));
 console.log('checkpoint',checks.length);checks.push('chapter and episode review notes are available and persist fixed target revisions');
 await page.screenshot({path:join(out,'review-targets-fixed.png')});
 assert.deepEqual(errors,[]);writeFileSync(join(out,'report.json'),JSON.stringify({passed:true,checks,errors,fixture:'isolated local FFmpeg assets; no real project or model generation'},null,2));
 console.log(JSON.stringify({passed:true,checks}));
}catch(error){await page.screenshot({path:join(out,'failure.png'),fullPage:true});console.error(JSON.stringify({checks,errors,body:(await page.locator('body').innerText()).slice(-5000)}));throw error;}
finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));app.close();rmSync(root,{recursive:true,force:true});}
