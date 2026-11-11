import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,statSync,createWriteStream,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ensure,Id,DomainError} from '../contracts/foundation.ts';
import {cloudVideoDefinitions,cloudConstraints,cloudIntentIssue,cloudRatio,type CloudVideoId} from '../contracts/cloud-video.ts';
import type {Capability,MediaProvider,ProviderRequest,ProviderReceipt} from '../contracts/production.ts';
import {CloudVideoSettings} from './cloud-video-settings.ts';
import {execute,mediaBinary} from './media.ts';

type Journal={endpoint:string;model:string;remoteId?:string;receipt:ProviderReceipt;nextPoll:number;cancelRequested?:boolean};
type Fetch=typeof fetch;
const digest=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const taskId=(s:unknown):s is string=>typeof s==='string'&&/^[\w-]{1,200}$/.test(s);
// Use only codes, never raw upstream text (which can echo credentials or prompts).
function remoteError(status:number,body:any){
 const raw=body?.error?.code??body?.output?.code??body?.code??body?.error_type;
 const code=typeof raw==='string'&&/^(InvalidApiKey|AuthenticationError|AccessDenied|InvalidParameter(?:\.[A-Za-z]+)?|Throttling\.RateQuota|InsufficientBalance|ContentPolicyViolation|UnsupportedOperation)$/.test(raw)?` · ${raw}`:'';
 const hint=status===401||status===403?'请检查 Key、模型权限及工作空间':status===402?'请检查账户余额':status===429?'请求限流，请稍后核对原任务':'请在平台控制台检查任务详情';
 return `云端接口 HTTP ${status}${code}；${hint}`;
}
export class CloudVideoProvider implements MediaProvider {
 private active=new Map<string,Promise<ProviderReceipt>>();private root:string;
 constructor(readonly id:CloudVideoId,private settings:CloudVideoSettings,root:string,private transport:Fetch=fetch,private pollMs=15000){this.root=join(root,'runtime','cloud-video',id);mkdirSync(this.root,{recursive:true,mode:0o700});}
 describe():Capability{
  const v=this.settings.public(this.id),d=cloudVideoDefinitions[this.id];
  return {id:this.id,title:d.title,available:!v.issue,detail:v.issue??`云端原生音画 · ${d.minSeconds}–${d.maxSeconds} 秒 · 按平台计费；首尾帧最多两张；停止接收不保证免除云端费用`,profiles:[...d.profiles],profileConstraints:Object.fromEntries(d.profiles.map(p=>[p,cloudConstraints(this.id,p)])),fingerprint:digest(JSON.stringify({id:this.id,endpoint:v.endpoint,model:v.model,enabled:v.enabled})),cost:'account-quota',supports:{references:true,lastFrame:true,audio:true,final:true}};
 }
 private dir(id:string){ensure(Id.safeParse(id).success,'VALIDATION','请求 ID 无效');return join(this.root,id);}
 private read(id:string):Journal|undefined{const file=join(this.dir(id),'state.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):undefined;}
 private save(id:string,value:Journal){const dir=this.dir(id);mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,'state.json');writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(file+'.tmp',file);return value.receipt;}
 private headers(){const v=this.settings.get(this.id);ensure(v.enabled,'UNSUPPORTED','云端视频已停用，不会发送平台请求');ensure(v.apiKey,'UNSUPPORTED','请先配置视频 API Key');return {Authorization:`${this.id==='fal-h3'?'Key':'Bearer'} ${v.apiKey}`,'Content-Type':'application/json'};}
 private async call(url:string,init:RequestInit={}){const r=await this.transport(url,{...init,headers:{...this.headers(),...init.headers},redirect:'error',signal:AbortSignal.timeout(45000)});let body:any={};try{const raw=await r.text();if(raw.length<=2_000_000)body=JSON.parse(raw);}catch{}return {status:r.status,ok:r.ok,body};}
 private taskPath(j:Journal){ensure(taskId(j.remoteId),'VALIDATION','云端任务 ID 无效');return this.id==='seedance'?`${j.endpoint}/contents/generations/tasks/${j.remoteId}`:this.id==='wan'?`${j.endpoint}/tasks/${j.remoteId}`:`${j.endpoint}/${j.model}/requests/${j.remoteId}`;}
 private lock(id:string,action:()=>Promise<ProviderReceipt>){const old=this.active.get(id);if(old)return old;const result=action().finally(()=>this.active.delete(id));this.active.set(id,result);return result;}
 async submit(r:ProviderRequest){return this.lock(r.id,async()=>{
  if(this.read(r.id))return this.poll(r.id);
  const config=this.settings.get(this.id),cap=this.describe();ensure(cap.available&&cap.fingerprint===r.fingerprint,'UNSUPPORTED','云端配置已变化，请重新确认');
  const issue=cloudIntentIssue(r.intent);ensure(r.intent.provider===this.id&&!issue,'UNSUPPORTED',issue??'Provider 不匹配');
  ensure(r.referenceFiles.length===r.intent.references.length,'UNSUPPORTED','参考素材缺失');
  const refs:string[]=[];
  for(const f of r.referenceFiles){
   ensure(['image/png','image/jpeg'].includes(f.mediaType),'UNSUPPORTED','云端首尾帧仅支持 PNG / JPEG');ensure(statSync(f.path).size<=20*1024*1024,'UNSUPPORTED','单张参考图最多 20 MiB');
   const bytes=readFileSync(f.path);ensure(digest(bytes)===f.sha256,'UNSUPPORTED','参考图哈希不匹配');
   const probe=JSON.parse(await execute(mediaBinary('ffprobe'),['-v','error','-show_streams','-of','json',f.path])),s=probe.streams?.[0];
   const min=this.id==='seedance'?300:this.id==='wan'?240:1,max=this.id==='seedance'?6000:this.id==='wan'?8000:8192;
   ensure(s?.width>=min&&s?.height>=min&&s?.width<=max&&s?.height<=max,'UNSUPPORTED',`参考图边长须在 ${min}–${max} 像素之间`);
   ensure(this.id!=='seedance'||s.width/s.height>=.4&&s.width/s.height<=2.5,'UNSUPPORTED','Seedance 参考图宽高比须为 0.4–2.5');
   if((this.id==='fal-h3'||this.id==='seedance')&&refs.length===0)ensure(Math.abs(s.width/s.height-r.intent.constraints.width/r.intent.constraints.height)<.06,'UNSUPPORTED','该模型图生视频沿用首帧画幅，请选择与首帧一致的横屏、竖屏或方形');
   refs.push(`data:${f.mediaType};base64,${bytes.toString('base64')}`);
  }
  const c=r.intent.constraints,ratio=cloudRatio(r.intent.profile,c.width,c.height),model=config.model;
  const payload=this.id==='seedance'?{model,content:[{type:'text',text:r.intent.prompt},...refs.map((url,i)=>({type:'image_url',image_url:{url},role:i?'last_frame':'first_frame'}))],resolution:r.intent.profile,ratio:refs.length?'adaptive':ratio,duration:c.durationSeconds,seed:r.intent.seed,generate_audio:true,watermark:false}:
   this.id==='wan'?{model,input:{prompt:r.intent.prompt,...(refs.length?{media:refs.map((url,i)=>({type:i?'last_frame':'first_frame',url}))}:{})},parameters:{resolution:r.intent.profile.toUpperCase(),ratio,duration:c.durationSeconds,seed:r.intent.seed,audio:true,prompt_extend:false,watermark:false}}:
   {prompt:r.intent.prompt,resolution:r.intent.profile.toUpperCase(),duration:c.durationSeconds,seed:r.intent.seed,prompt_expansion_mode:'disabled',enable_safety_checker:true,...(refs.length?{image_url:refs[0],...(refs[1]?{end_image_url:refs[1]}:{})}:{aspect_ratio:ratio})};
  const endpoint=this.settings.endpoint(config),url=this.id==='seedance'?`${endpoint}/contents/generations/tasks`:this.id==='wan'?`${endpoint}/services/aigc/video-generation/video-synthesis`:`${endpoint}/${model}/${refs.length?'image-to-video':'text-to-video'}`;
  const j:Journal={endpoint,model,nextPoll:0,receipt:{state:'unknown',error:'提交回执尚未确认，请到平台控制台核对；不会自动重提'}};
  // Persist before POST. A lost response must never cause a second billable request.
  this.save(r.id,j);
  try{
   const result=await this.call(url,{method:'POST',headers:this.id==='wan'?{'X-DashScope-Async':'enable'}:{},body:JSON.stringify(payload)});
   if(!result.ok){j.receipt={state:result.status>=400&&result.status<500&&result.status!==408?'failed':'unknown',error:remoteError(result.status,result.body)};return this.save(r.id,j);}
   const remote=this.id==='seedance'?result.body.id:this.id==='wan'?result.body.output?.task_id:result.body.request_id;
   if(!taskId(remote))return this.save(r.id,j);
   j.remoteId=remote;j.nextPoll=Date.now()+this.pollMs;j.receipt={state:'running',metrics:{remoteTaskId:remote,model}};return this.save(r.id,j);
  }catch{return this.save(r.id,j);}
 });}
 status(id:string){return this.lock(id,()=>this.poll(id));}
 private async poll(id:string):Promise<ProviderReceipt>{
  const j=this.read(id);if(!j)return {state:'unknown',error:'没有本机云端回执，请先到平台控制台核对原任务'};
  if(['completed','failed','cancelled'].includes(j.receipt.state)||!j.remoteId)return j.receipt;
  const current=this.settings.get(this.id);if(!current.enabled)return {...j.receipt,state:'unknown',error:'云端视频已停用，原任务查询与回收已暂停；重新启用后核对原任务，不会重新生成'};
  if(Date.now()<j.nextPoll)return j.receipt;
  if(!current.apiKey||this.settings.endpoint(current)!==j.endpoint)return {...j.receipt,state:'unknown',error:'原任务凭据或工作空间不可用；恢复原工作空间并核对，勿重复生成'};
  j.nextPoll=Date.now()+this.pollMs;
  try{
   const url=this.taskPath(j),result=await this.call(url+(this.id==='fal-h3'?'/status':''));
   if(!result.ok){j.receipt={...j.receipt,state:result.status===429||result.status>=500?'running':'unknown',error:remoteError(result.status,result.body)};return this.save(id,j);}
   const body=result.body,state=this.id==='wan'?body.output?.task_status:body.status;
   if(['queued','running','PENDING','RUNNING','IN_QUEUE','IN_PROGRESS'].includes(state))j.receipt={...j.receipt,state:'running',error:j.cancelRequested?'本机已停止接收；云端仍在执行，费用以平台为准':undefined};
   else if(['cancelled','CANCELED','CANCELLED'].includes(state))j.receipt={...j.receipt,state:'cancelled',error:undefined};
   else if(['failed','expired','FAILED'].includes(state)||state==='COMPLETED'&&body.error)j.receipt={...j.receipt,state:'failed',error:remoteError(200,body)};
   else if(['succeeded','SUCCEEDED','COMPLETED'].includes(state)){
    if(j.cancelRequested)j.receipt={...j.receipt,state:'cancelled',error:'云端已完成，本机取消接收；费用以平台实际账单为准'};
    else {
     const output=this.id==='fal-h3'?await this.call(url):result;
     if(!output.ok){j.receipt={...j.receipt,state:output.status===422?'failed':'unknown',error:remoteError(output.status,output.body)};return this.save(id,j);}
     const link=this.id==='seedance'?output.body.content?.video_url:this.id==='wan'?output.body.output?.video_url:output.body.video?.url;
     ensure(typeof link==='string','MEDIA_INVALID','云端回执没有视频地址');
     const files=await this.download(id,link);j.receipt={state:'completed',...files,metrics:{...j.receipt.metrics,nativeAudio:true}};
    }
   }else j.receipt={...j.receipt,state:'unknown',error:'云端状态无法识别或任务已过期，请在控制台核对原任务'};
  }catch(e){j.receipt={...j.receipt,state:e instanceof DomainError?'unknown':'running',error:e instanceof DomainError?'云端视频回收未通过检查（格式、地址或原生音轨）。请检查原任务，不会重新生成。':'云端查询或素材回收暂未完成，稍后继续核对原任务；不会重新生成'};}
  return this.save(id,j);
 }
 async cancel(id:string){
  // Serialize with submission/polling; never overwrite a newly persisted remote ID.
  await this.active.get(id);await this.lock(id,async()=>{
   const j=this.read(id);if(!j)return {state:'unknown'};j.cancelRequested=true;j.nextPoll=0;this.save(id,j);
   if(this.id!=='seedance'&&j.remoteId&&this.settings.get(this.id).enabled&&this.settings.get(this.id).apiKey&&this.settings.endpoint(this.settings.get(this.id))===j.endpoint){
    try{const r=await this.call(this.taskPath(j)+'/cancel',{method:this.id==='wan'?'POST':'PUT'});if(this.id==='fal-h3'&&r.status===200&&r.body.status==='OK'){j.receipt={...j.receipt,state:'cancelled',error:undefined};return this.save(id,j);}}catch{}
   }
   return this.poll(id);
  });
 }
 async check(){
  const config=this.settings.get(this.id),issue=this.settings.issue(config);ensure(!issue,'VALIDATION',issue??'配置不完整');
  const j:Journal={endpoint:this.settings.endpoint(config),model:config.model,remoteId:'00000000-0000-4000-8000-000000000000',receipt:{state:'unknown'},nextPoll:0};
  try{const r=await this.call(this.taskPath(j)+(this.id==='fal-h3'?'/status':''));return {status:r.status===401||r.status===403?'rejected':'reachable',message:r.status===401||r.status===403?remoteError(r.status,r.body):`已收到平台 HTTP ${r.status} 响应。只查询了测试任务 ID，未创建视频；模型权限、余额和生成效果仍需首次真实任务确认。`};}
  catch{return {status:'unreachable',message:'接口未连通，请检查本机网络与地域；未提交生成任务。'};}
 }
 private async download(id:string,link:string){
  const path=join(this.dir(id),'video.mp4'),audio=join(this.dir(id),'native.wav');
  if(!existsSync(path)){
   let url=link,response:Response|undefined;
   for(let i=0;i<4;i++){
    ensure(this.settings.get(this.id).enabled,'UNSUPPORTED','云端视频已停用，暂停素材回收');
    await publicMediaUrl(url,this.id);ensure(this.settings.get(this.id).enabled,'UNSUPPORTED','云端视频已停用，暂停素材回收');response=await this.transport(url,{redirect:'manual',signal:AbortSignal.timeout(300000)});
    if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();ensure(location,'MEDIA_INVALID','视频跳转缺少地址');url=new URL(location,url).href;continue;}break;
   }
   ensure(response?.ok&&response.body,'MEDIA_INVALID','视频下载未成功');const tmp=path+'.partial';let bytes=0;
   try{await pipeline(Readable.fromWeb(response.body as any),new Transform({transform(chunk,_,done){bytes+=chunk.length;done(bytes>512*1024*1024?new Error('视频超过 512 MiB'):null,chunk);}}),createWriteStream(tmp,{mode:0o600}));renameSync(tmp,path);}finally{if(existsSync(tmp))unlinkSync(tmp);}
  }
  try{
   const probe=JSON.parse(await execute(mediaBinary('ffprobe'),['-v','error','-show_streams','-show_format','-of','json',path]));ensure(probe.format?.format_name?.includes('mp4')&&probe.streams?.some((s:any)=>s.codec_type==='video')&&probe.streams?.some((s:any)=>s.codec_type==='audio'),'MEDIA_INVALID','视频缺少原生音轨');
   await execute(mediaBinary('ffmpeg'),['-v','error','-nostdin','-i',path,'-f','null','-']);
   await execute(mediaBinary('ffmpeg'),['-y','-v','error','-nostdin','-i',path,'-map','0:a:0','-vn','-c:a','pcm_s16le',audio]);
  }catch{if(existsSync(path))unlinkSync(path);throw new DomainError('MEDIA_INVALID','原生音画回收未通过');}
  return {path,sha256:digest(readFileSync(path)),nativeAudio:{path:audio,sha256:digest(readFileSync(audio))}};
 }
}
type MediaLookup=(host:string)=>Promise<{address:string}[]>;
export async function publicMediaUrl(raw:string,provider?:CloudVideoId,resolveHost:MediaLookup=host=>lookup(host,{all:true})){
 let url:URL;try{url=new URL(raw);}catch{throw new DomainError('MEDIA_INVALID','云端媒体地址无效');}ensure(url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443'),'MEDIA_INVALID','云端媒体必须使用公开 HTTPS 地址');
 const host=url.hostname.replace(/^\[|\]$/g,'');ensure(!['localhost','localhost.localdomain'].includes(host)&&!host.endsWith('.local'),'MEDIA_INVALID','不允许本机媒体地址');
 const addresses=isIP(host)?[{address:host}]:await resolveHost(host);
 // TUN proxies use 198.18/15 for synthetic DNS answers. Only the Wan-owned
 // DashScope OSS download hostname may use that route. HTTPS still verifies
 // that hostname; every redirect is checked again and receives no API key.
 // Arbitrary hosts, IP literals, loopback and other private ranges stay blocked.
 const wanProxyRoute=provider==='wan'&&/^dashscope-[a-z0-9-]+\.oss-accelerate\.aliyuncs\.com$/.test(host);
 ensure(addresses.length&&addresses.every(({address})=>{
  if(isIP(address)===6)return /^2[0-9a-f]{3}:/i.test(address)&&!/^2001:(?:0:|db8:)/i.test(address);
  const [a,b]=address.split('.').map(Number);if(a===198&&(b===18||b===19))return wanProxyRoute;
  return a!==0&&a!==10&&a!==127&&a!==169&&a<224&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0))&&!(a===100&&b>=64&&b<=127);
 }),'MEDIA_INVALID','不允许内网媒体地址');return url;
}
