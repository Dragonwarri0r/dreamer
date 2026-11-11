import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,renameSync,rmSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {CloudVideoSettings} from '../packages/infra/cloud-video-settings.ts';
import {CloudVideoProvider,publicMediaUrl} from '../packages/infra/cloud-video.ts';
import {cloudVideoDefinitions,cloudConstraints,cloudDimensions,cloudVideoIds,type CloudVideoId} from '../packages/contracts/cloud-video.ts';
import {RenderIntent,type ProviderRequest} from '../packages/contracts/production.ts';
import {execute,mediaBinary} from '../packages/infra/media.ts';
import {Application} from '../apps/host/application.ts';
import {createHost} from '../apps/host/server.ts';
import {cloudProductionPrompt} from '../apps/studio/src/production-input.ts';
import {until} from './helpers.ts';

const key='sk-test-cloud-secret-do-not-echo';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const setup=(id:CloudVideoId)=>{const root=mkdtempSync(join(tmpdir(),'dreamer-cloud-')),settings=new CloudVideoSettings(root);settings.save({id,enabled:true,model:cloudVideoDefinitions[id].model,workspace:id==='wan'?'ws-test':'',apiKey:key});return {root,settings,close:()=>rmSync(root,{recursive:true,force:true})};};
const request=(p:CloudVideoProvider):ProviderRequest=>{const profile=cloudVideoDefinitions[p.id].profiles[0],c=cloudConstraints(p.id,profile);return {id:randomUUID(),fingerprint:p.describe().fingerprint,referenceFiles:[],intent:RenderIntent.parse({provider:p.id,profile,prompt:'吉皮梯合上书：“这不对。”镜头迅速推近，响起风声。',quality:'final',constraints:{width:c.width,height:c.height,fps:c.fps,durationSeconds:5,audio:true}})};};

test('06 云端配置持久化、脱敏、Key 留空保留与明确移除',()=>{
 const x=setup('wan');try{
  assert.equal(statSync(join(x.root,'credentials','video-providers.json')).mode&0o777,0o600);
  assert.equal(statSync(join(x.root,'credentials')).mode&0o777,0o700);
  assert.equal(JSON.stringify(x.settings.list()).includes(key),false);
  x.settings.save({id:'wan',enabled:true,model:'wan3.0-video-prime',workspace:'ws-test',apiKey:''});
  assert.equal(new CloudVideoSettings(x.root).get('wan').apiKey,key);
  assert.throws(()=>x.settings.save({id:'wan',enabled:true,model:'other',apiKey:key}),/万相/);
  const removed=x.settings.save({id:'wan',enabled:false,model:'wan3.0-video',clearKey:true});assert.equal(removed.configured,false);
  assert.equal(readFileSync(join(x.root,'credentials','video-providers.json'),'utf8').includes(key),false);
 }finally{x.close();}
});

test('06 手改视频配置热读取，原子替换生效，损坏文件停用且不被网页覆盖',()=>{
 const x=setup('wan');try{
  const file=join(x.root,'credentials','video-providers.json'),next=file+'.edited';
  const edited=[{id:'wan',enabled:true,model:'wan3.0-video',region:'cn-beijing',workspace:'ws-edited',apiKey:'sk-edited-file-key'}];
  writeFileSync(next,JSON.stringify(edited),{mode:0o644});renameSync(next,file);
  assert.equal(x.settings.get('wan').apiKey,'sk-edited-file-key');assert.equal(x.settings.public('wan').workspace,'ws-edited');assert.equal(statSync(file).mode&0o777,0o600);
  x.settings.save({id:'fal-h3',enabled:false,model:'minimax/h3-max'});assert.equal(x.settings.get('wan').apiKey,'sk-edited-file-key');
  writeFileSync(file,'{"apiKey":"sk-partial-secret');const invalid=x.settings.public('wan');assert.match(invalid.issue!,/格式有误/);assert.equal(invalid.configured,false);assert.equal(x.settings.get('wan').apiKey,undefined);assert.equal(JSON.stringify(invalid).includes('sk-partial-secret'),false);
  assert.throws(()=>x.settings.save({id:'wan',enabled:true,model:'wan3.0-video'}),/格式有误/);assert.equal(readFileSync(file,'utf8'),'{"apiKey":"sk-partial-secret');
  writeFileSync(file,JSON.stringify(edited));assert.equal(x.settings.public('wan').issue,undefined);
  rmSync(file);assert.equal(x.settings.get('wan').apiKey,undefined);assert.equal(x.settings.public('wan').configured,false);
 }finally{x.close();}
});

test('06 停用云端阻止提交、排队派发、重试与接口检查，保留 Key 且零平台请求',async()=>{
 for(const id of cloudVideoIds){const x=setup(id);let app:Application|undefined;try{
  let calls=0;const p=new CloudVideoProvider(id,x.settings,x.root,async()=>{calls++;throw new Error('Transport must remain untouched');},0),r=request(p);
  app=new Application(x.root,{providers:[p]});const pid=randomUUID(),run=(operation:string,payload:any)=>app!.bus.execute({requestId:randomUUID(),projectId:pid,operation,payload},{source:'human'}).result as any;
  run('project.create',{title:'本地测试停用云端'});const queued=run('job.submit',r.intent);
  x.settings.save({id,enabled:false,model:cloudVideoDefinitions[id].model,workspace:id==='wan'?'ws-test':''});
  assert.equal(p.describe().available,false);assert.equal(new CloudVideoSettings(x.root).get(id).apiKey,key);
  await app.production.dispatch(queued.id,pid);const failed=await until(()=>app!.production.jobs.get(queued.id,pid),j=>j.data.state==='failed');assert.equal(failed.data.state,'failed');
  assert.throws(()=>run('job.submit',r.intent),/尚未启用/);assert.throws(()=>run('job.retry',{id:queued.id}),/尚未启用/);
  await assert.rejects(p.submit(r),/云端配置已变化/);await assert.rejects(p.check(),/尚未启用/);
  assert.equal(app.production.jobs.list(pid).length,1);assert.equal(calls,0);
 }finally{app?.close();x.close();}}
});

test('06 停用后旧云端回执只读本机，重启、核对与取消不发请求；重新启用不重复生成',async()=>{
 for(const id of cloudVideoIds){const x=setup(id);try{
  const calls:string[]=[],transport:typeof fetch=async(_,init)=>{const method=init?.method??'GET';calls.push(method);return method==='POST'?json(id==='seedance'?{id:'task-paused'}:id==='wan'?{output:{task_id:'task-paused'}}:{request_id:'task-paused'}):json(id==='wan'?{output:{task_status:'RUNNING'}}:{status:id==='seedance'?'running':'IN_PROGRESS'});};
  const p=new CloudVideoProvider(id,x.settings,x.root,transport,0),r=request(p);await p.submit(r);assert.deepEqual(calls,['POST']);
  x.settings.save({id,enabled:false,model:cloudVideoDefinitions[id].model,workspace:id==='wan'?'ws-test':''});
  const restarted=new CloudVideoProvider(id,new CloudVideoSettings(x.root),x.root,transport,0);
  const paused=await restarted.status(r.id);assert.equal(paused.state,'unknown');assert.match(paused.error!,/已停用/);
  await restarted.submit(r);await restarted.cancel(r.id);assert.deepEqual(calls,['POST']);
  x.settings.save({id,enabled:true,model:cloudVideoDefinitions[id].model,workspace:id==='wan'?'ws-test':''});await restarted.status(r.id);
  assert.deepEqual(calls,['POST','GET']);assert.equal(x.settings.get(id).apiKey,key);
 }finally{x.close();}}
});

for(const id of cloudVideoIds)test(`06 ${id} 官方请求、原 ID 恢复、原生音画回收与终态幂等`,async()=>{
 const x=setup(id);try{
  const video=join(x.root,'fixture.mp4');await execute(mediaBinary('ffmpeg'),['-y','-v','error','-f','lavfi','-i','color=c=blue:s=320x576:r=24','-f','lavfi','-i','sine=frequency=330:sample_rate=24000','-t','0.3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video]);
  const calls:{url:string;method:string;headers:any;payload?:any}[]=[],remote='task-test-123';
  const fetcher:typeof fetch=async(input,init)=>{
   const url=String(input),method=init?.method??'GET';calls.push({url,method,headers:init?.headers,payload:init?.body?JSON.parse(String(init.body)):undefined});
   if(url==='https://1.1.1.1/fixture.mp4'){assert.equal(init?.headers,undefined);return new Response(readFileSync(video));}
   assert.equal((init?.headers as any).Authorization,`${id==='fal-h3'?'Key':'Bearer'} ${key}`);assert.equal(init?.redirect,'error');
   if(method==='POST')return json(id==='seedance'?{id:remote}:id==='wan'?{output:{task_id:remote,task_status:'PENDING'}}:{request_id:remote});
   assert.ok(url.includes(remote));
   return json(id==='seedance'?{status:'succeeded',content:{video_url:'https://1.1.1.1/fixture.mp4'}}:id==='wan'?{output:{task_status:'SUCCEEDED',video_url:'https://1.1.1.1/fixture.mp4'}}:url.endsWith('/status')?{status:'COMPLETED'}:{video:{url:'https://1.1.1.1/fixture.mp4'}});
  };
  const p=new CloudVideoProvider(id,x.settings,x.root,fetcher,0),r=request(p);
  assert.equal((await p.submit(r)).state,'running');
  const first=calls[0],body=first.payload;assert.equal(first.method,'POST');
  if(id==='seedance'){assert.equal(first.url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');assert.equal(body.model,'doubao-seedance-2-5-260628');assert.equal(body.content[0].text,r.intent.prompt);assert.equal(body.generate_audio,true);assert.equal(body.ratio,'9:16');}
  if(id==='wan'){assert.equal(first.url,'https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis');assert.equal(first.headers['X-DashScope-Async'],'enable');assert.equal(body.input.prompt,r.intent.prompt);assert.equal(body.parameters.audio,true);assert.equal(body.parameters.prompt_extend,false);}
  if(id==='fal-h3'){assert.equal(first.url,'https://queue.fal.run/minimax/h3-max/text-to-video');assert.equal(body.prompt_expansion_mode,'disabled');assert.equal(body.resolution,'768P');}
  // New instance simulates a Host restart; no POST is repeated.
  const restarted=new CloudVideoProvider(id,new CloudVideoSettings(x.root),x.root,fetcher,0),done=await restarted.status(r.id);
  assert.equal(done.state,'completed',done.error);assert.ok(done.path&&existsSync(done.path));assert.ok(done.nativeAudio&&existsSync(done.nativeAudio.path));
  assert.equal((await restarted.submit(r)).state,'completed');assert.equal(calls.filter(c=>c.method==='POST').length,1);
  assert.equal(readFileSync(join(x.root,'runtime','cloud-video',id,r.id,'state.json'),'utf8').includes(key),false);
  const app=new Application(x.root,{providers:[restarted]}),pid=randomUUID();
  const run=(operation:string,payload:any)=>app.bus.execute({requestId:randomUUID(),projectId:pid,operation,payload},{source:'human'}).result as any;
  try{
   run('project.create',{title:'云端回收闭环',generationLimit:1});const shot=run('shot.create',{title:'吉皮梯',durationFrames:7}),target=run('shot.checkpoint',{id:shot.id,expectedSeq:shot.seq});
   const job=run('job.submit',{...r.intent,target});await until(()=>app.production.jobs.get(job.id,pid),j=>j.data.state==='running');await app.production.reconcile(job.id,pid);
   const done=await until(()=>app.production.jobs.get(job.id,pid),j=>j.data.state==='completed');assert.ok(done.data.nativeAudio);
   assert.deepEqual(app.production.artifacts.at(done.data.artifact!,pid).data.metadata.nativeAudio,done.data.nativeAudio);
   assert.equal(app.storyboard.repo.get(shot.id,pid).data.takes.length,1);assert.equal(app.production.artifacts.at(done.data.nativeAudio!,pid).data.mediaType,'audio/wav');
   await app.production.reconcile(job.id,pid);assert.equal(app.storyboard.repo.get(shot.id,pid).data.takes.length,1);assert.throws(()=>run('job.submit',r.intent),/预算/);
  }finally{app.close();}

 }finally{x.close();}
});

test('06 云端首尾帧按官方字段和顺序提交，Seedance 首帧画幅用 adaptive',async()=>{
 for(const id of cloudVideoIds){const x=setup(id);try{
  const path=join(x.root,'ref.png');await execute(mediaBinary('ffmpeg'),['-y','-v','error','-f','lavfi','-i','color=red:s=320x576','-frames:v','1',path]);
  let sent:any;const fetcher:typeof fetch=async(_,init)=>{sent=JSON.parse(String(init?.body));return json(id==='seedance'?{id:'task-ref'}:id==='wan'?{output:{task_id:'task-ref'}}:{request_id:'task-ref'});};
  const p=new CloudVideoProvider(id,x.settings,x.root,fetcher,0),r=request(p),hash=createHash('sha256').update(readFileSync(path)).digest('hex');
  r.referenceFiles=[0,1].map(()=>({path,sha256:hash,mediaType:'image/png'}));r.intent.references=[0,1].map(()=>({kind:'artifact',id:randomUUID(),seq:1}));r.intent.constraints.firstLastFrames=true;
  await p.submit(r);
  if(id==='seedance'){assert.deepEqual(sent.content.slice(1).map((c:any)=>c.role),['first_frame','last_frame']);assert.equal(sent.ratio,'adaptive');}
  if(id==='wan')assert.deepEqual(sent.input.media.map((c:any)=>c.type),['first_frame','last_frame']);
  if(id==='fal-h3'){assert.ok(sent.image_url.startsWith('data:image/png;base64,'));assert.equal(sent.end_image_url,sent.image_url);assert.equal(sent.aspect_ratio,undefined);}
 }finally{x.close();}}
});

test('06 响应丢失不重提、限流继续核对、鉴权错误不泄露、检查不生成',async()=>{
 const x=setup('seedance');try{
  let posts=0;const broken:typeof fetch=async()=>{posts++;throw new Error(key);};const p=new CloudVideoProvider('seedance',x.settings,x.root,broken,0),r=request(p);
  assert.equal((await p.submit(r)).state,'unknown');assert.equal((await p.submit(r)).state,'unknown');assert.equal(posts,1);
  const restart=new CloudVideoProvider('seedance',x.settings,x.root,broken,0);await restart.status(r.id);assert.equal(posts,1);
  let status=429,queries=0;const q=new CloudVideoProvider('seedance',x.settings,x.root,async(_,init)=>init?.method==='POST'?json({id:'task-429'}):(queries++,json({error:{code:key,message:key}},status)),0),r2=request(q);
  await q.submit(r2);assert.equal((await q.status(r2.id)).state,'running');status=401;const receipt=await q.status(r2.id);assert.equal(receipt.state,'unknown');assert.equal(JSON.stringify(receipt).includes(key),false);
  const check=await q.check();assert.equal(check.status,'rejected');assert.equal(JSON.stringify(check).includes(key),false);assert.equal(queries,3);
 }finally{x.close();}
});

test('06 fal 取消队列有确认才终止；运行中取消仍核对；Seedance 不删除云端成品',async()=>{
 for(const id of ['fal-h3','seedance'] as const){const x=setup(id);try{
  let methodList:string[]=[],cancelStatus=202;const p=new CloudVideoProvider(id,x.settings,x.root,async(_,init)=>{const method=init?.method??'GET';methodList.push(method);return method==='POST'?json(id==='seedance'?{id:'task-cancel'}:{request_id:'task-cancel'}):method==='PUT'?json({status:cancelStatus===200?'OK':'CANCELLATION_REQUESTED'},cancelStatus):json({status:id==='seedance'?'running':'IN_PROGRESS'});},0),r=request(p);
  await p.submit(r);await p.cancel(r.id);assert.equal((await p.status(r.id)).state,'running');assert.ok(!methodList.includes('DELETE'));
  if(id==='fal-h3'){cancelStatus=200;await p.cancel(r.id);assert.equal((await p.status(r.id)).state,'cancelled');}
 }finally{x.close();}}
});

test('06 云端地址检查阻止本机/内网下载，描述转换保留对白且不混入本地规格',async()=>{
 for(const url of ['http://example.com/x','https://127.0.0.1/x','https://10.1.2.3/x','https://[::1]/x','https://[::ffff:127.0.0.1]/x','https://user:pass@example.com/x'])await assert.rejects(publicMediaUrl(url));
 const dialogue='Native portrait framing 480x832 at 24fps.';
 const converted=cloudProductionPrompt(`Native portrait framing 320x576 at 24fps. He says <d>[Chinese]${dialogue}这不对。</d> Wind blows.`);
 assert.ok(!converted.includes('320x576'));assert.ok(converted.includes(dialogue+'这不对。'));assert.ok(converted.includes('中文对白'));assert.ok(converted.includes('Wind blows'));
 assert.deepEqual(cloudDimensions('480p'),{width:480,height:854});assert.deepEqual(cloudDimensions('720p','1:1'),{width:960,height:960});
});

test('06 万相官方 OSS 兼容代理 Fake-IP，任意域名与其他私网地址仍拒绝',async()=>{
 const official='https://dashscope-a717.oss-accelerate.aliyuncs.com/result.mp4';
 const fake=async()=>[{address:'198.18.0.67'}];
 assert.equal((await publicMediaUrl(official,'wan',fake)).hostname,'dashscope-a717.oss-accelerate.aliyuncs.com');
 await assert.rejects(publicMediaUrl(official,undefined,fake));
 await assert.rejects(publicMediaUrl(official,'seedance',fake));
 for(const url of ['https://example.com/result.mp4','https://dashscope-a717.oss-accelerate.aliyuncs.com.evil.test/result.mp4','https://198.18.0.67/result.mp4'])await assert.rejects(publicMediaUrl(url,'wan',fake));
 for(const address of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','::ffff:127.0.0.1'])await assert.rejects(publicMediaUrl(official,'wan',async()=>[{address}]));
});

test('06 设置 HTTP 隔离于命令日志/备份，CSRF 生效，能力与预算即时生效',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-cloud-http-')),app=new Application(root),server=createHost(app),pid=randomUUID(),backup=root+'-backup';
 const run=(operation:string,payload:any)=>app.bus.execute({requestId:randomUUID(),projectId:pid,operation,payload},{source:'human'}).result as any;
 try{
  run('project.create',{title:'云端设置测试',generationLimit:0});await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${(server.address() as any).port}`,session=await fetch(url+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrf}=await session.json() as any;
  const headers={'Content-Type':'application/json',cookie,origin:url,'X-Dreamer-CSRF':csrf},body=JSON.stringify({id:'seedance',enabled:true,model:cloudVideoDefinitions.seedance.model,apiKey:key});
  assert.equal((await fetch(url+'/api/video-settings',{method:'POST',headers:{...headers,'X-Dreamer-CSRF':''},body})).status,403);
  const saved=await fetch(url+'/api/video-settings',{method:'POST',headers,body});assert.equal(saved.status,200);assert.equal((await saved.text()).includes(key),false);
  const listing=await fetch(url+'/api/video-settings',{headers:{cookie}});assert.equal((await listing.text()).includes(key),false);
  assert.equal(app.production.capabilities().find(p=>p.id==='seedance')!.available,true);
  assert.equal(JSON.stringify(app.snapshot(pid,true)).includes(key),false);assert.equal(JSON.stringify(app.store.events(pid,0)).includes(key),false);
  const provider=app.cloudVideo.find(p=>p.id==='seedance')!;assert.throws(()=>run('job.submit',request(provider).intent),/预算/);
  const intent=request(provider).intent;intent.constraints.audio=false;assert.throws(()=>run('job.submit',intent),/原生音频/);
  await app.store.backup(backup);assert.equal(existsSync(join(backup,'credentials')),false);
  assert.equal(readFileSync(join(backup,'dreamer.sqlite')).includes(Buffer.from(key)),false);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));app.close();rmSync(root,{recursive:true,force:true});rmSync(backup,{recursive:true,force:true});}
});
