import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ensure,stable} from '../contracts/foundation.ts';
import type {RuntimePrincipal} from '../contracts/experience.ts';
import type {ExperienceExport,ExperienceExportPlan} from '../contracts/experience-export.ts';
import type {ExperienceArchives} from '../core/experience/archive.ts';
import {execute,mediaBinary,MediaFiles} from './media.ts';

/** Local-only export. Output stays in private run storage, outside author Artifact/Take registries. */
export class ExperienceExporter{
 private active=new Map<string,{controller:AbortController,promise:Promise<void>}>();private closed=false;
 private files:MediaFiles;
 constructor(private archives:ExperienceArchives,root:string){this.files=new MediaFiles(root);}
 start(principal:RuntimePrincipal,input:unknown){const record=this.archives.create(principal,input);this.launch(principal,record);return {export:this.archives.get(principal,record.runId,record.id)};}
 retry(principal:RuntimePrincipal,input:unknown){const record=this.archives.retry(principal,input);this.launch(principal,record);return {export:this.archives.get(principal,record.runId,record.id)};}
 private launch(principal:RuntimePrincipal,record:ExperienceExport){
  if(this.closed||record.status!=='queued'||this.active.has(record.id))return;
  const controller=new AbortController();this.archives.update(principal,record.runId,record.id,{status:'rendering',error:undefined});
  const promise=this.render(principal,record,controller.signal).then(output=>{if(!this.closed)this.archives.update(principal,record.runId,record.id,{status:'completed',output,completedAt:new Date().toISOString(),error:undefined});}).catch(error=>{if(!this.closed)this.archives.update(principal,record.runId,record.id,{status:'failed',error:error instanceof Error?error.message:'本地视频导出失败'});}).finally(()=>this.active.delete(record.id));
  this.active.set(record.id,{controller,promise});
 }
 async wait(id:string){await this.active.get(id)?.promise;}
 close(){this.closed=true;for(const work of this.active.values())work.controller.abort();}
 download(principal:RuntimePrincipal,runId:string,id:string){const record=this.archives.get(principal,runId,id);ensure(record.status==='completed'&&record.output,'CONFLICT','视频导出尚未完成');this.archives.verifySources(principal,record);const path=this.files.path(record.output.sha256);ensure(createHash('sha256').update(readFileSync(path)).digest('hex')===record.output.sha256,'MEDIA_INVALID','导出视频哈希损坏');return {record,path};}
 private async render(principal:RuntimePrincipal,record:ExperienceExport,signal:AbortSignal):Promise<NonNullable<ExperienceExport['output']>>{
  this.archives.verifySources(principal,record);const plan=record.plan,paths=new Map<string,string>();
  for(const source of plan.sources){const path=this.files.path(source.sha256);ensure(createHash('sha256').update(readFileSync(path)).digest('hex')===source.sha256,'MEDIA_INVALID','导出源素材哈希损坏');const actual=await this.files.inspect(path);ensure(actual.mediaType===source.mediaType&&actual.metadata.hasAudio===source.hasAudio&&actual.durationSeconds&&Math.abs(actual.durationSeconds-source.durationSeconds)<=1/Math.max(source.fps??24,1),'MEDIA_INVALID','导出源素材的实际音轨或时长已变化');paths.set(source.sha256,path);}
  const dir=mkdtempSync(join(this.files.root,'staging','experience-export-'));
  try{
   for(let i=0;i<plan.segments.length;i++)await this.renderSegment(plan,plan.segments[i],paths,dir,i,signal);
   const concat=join(dir,'route.txt');writeFileSync(concat,plan.segments.map((_,i)=>`file 'segment-${i}.mp4'`).join('\n'));
   const output=join(dir,'route.mp4');await execute(mediaBinary('ffmpeg'),['-y','-v','error','-nostdin','-f','concat','-safe','1','-i',concat,'-map','0:v:0','-map','0:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-t',String(plan.durationSeconds),'-movflags','+faststart',output],{signal,timeout:15*60*1000});
   const media=await this.files.import(output,'已走路线视频','experience-export');ensure(media.mediaType==='video/mp4'&&media.width&&media.height&&media.fps&&media.durationSeconds&&media.metadata.hasAudio===true,'MEDIA_INVALID','导出视频缺少有效音画');ensure(Math.abs(media.durationSeconds-plan.durationSeconds)<=Math.max(.12,plan.segments.length/plan.format.fps),'MEDIA_INVALID','导出视频时长与已走路线不一致');
   return {sha256:media.sha256,sizeBytes:media.sizeBytes,mediaType:'video/mp4',width:media.width,height:media.height,fps:media.fps,durationSeconds:media.durationSeconds,hasAudio:true};
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
 private async renderSegment(plan:ExperienceExportPlan,segment:ExperienceExportPlan['segments'][number],paths:Map<string,string>,dir:string,index:number,signal:AbortSignal){
  const playback=segment.playback,videos=playback.bindings.filter(b=>b.kind==='video').sort((a,b)=>a.atFrame-b.atFrame),{width,height,fps}=plan.format;
  for(let j=0;j<videos.length;j++){const b=videos[j],duration=b.durationFrames/playback.fps,args=['-y','-v','error','-nostdin','-ss',String(b.sourceInFrame/b.sourceFps),'-i',paths.get(b.contentHash)!];
   if(!b.nativeAudio)args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
   args.push('-map','0:v:0','-map',b.nativeAudio?'0:a:0':'1:a:0','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}`,'-af','apad','-t',String(duration),'-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2','-b:a','192k','-threads','2',join(dir,`clip-${index}-${j}.mp4`));await execute(mediaBinary('ffmpeg'),args,{signal,timeout:10*60*1000});
  }
  const concat=join(dir,`segment-${index}.txt`);writeFileSync(concat,videos.map((_,j)=>`file 'clip-${index}-${j}.mp4'`).join('\n'));
  const native=join(dir,`native-${index}.mp4`);await execute(mediaBinary('ffmpeg'),['-y','-v','error','-nostdin','-f','concat','-safe','1','-i',concat,'-c','copy',native],{signal});
  // An explicit copy of embedded native audio must not play twice.
  const audio=playback.bindings.filter(b=>b.kind==='audio'&&!videos.some(v=>v.nativeAudio&&v.contentHash===b.contentHash&&v.atFrame===b.atFrame&&v.durationFrames===b.durationFrames&&v.sourceInFrame/v.sourceFps===b.sourceInFrame/b.sourceFps));
  const args=['-y','-v','error','-nostdin','-i',native],filters=['[0:a]asetpts=PTS-STARTPTS[base]'],labels=['[base]'];
  audio.forEach((b,j)=>{args.push('-i',paths.get(b.contentHash)!);const delay=Math.round(b.atFrame/playback.fps*1000);filters.push(`[${j+1}:a]atrim=start=${b.sourceInFrame/b.sourceFps}:duration=${b.durationFrames/playback.fps},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delay}|${delay}[a${j}]`);labels.push(`[a${j}]`);});
  if(audio.length){filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0,alimiter=limit=0.95[out]`);args.push('-filter_complex',filters.join(';'),'-map','0:v:0','-map','[out]');}else args.push('-map','0:v:0','-map','0:a:0');
  args.push('-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-t',String(playback.durationFrames/playback.fps),join(dir,`segment-${index}.mp4`));await execute(mediaBinary('ffmpeg'),args,{signal});
 }
}
