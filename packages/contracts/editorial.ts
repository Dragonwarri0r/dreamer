import {z} from 'zod';import {Id,Ref,ensure} from './foundation.ts';
export const Track=z.strictObject({id:Id,title:z.string().max(160),type:z.enum(['video','dialogue','music','sfx']),volume:z.number().min(0).max(2).default(1),muted:z.boolean().default(false)});
export const Clip=z.strictObject({id:Id,trackId:Id,title:z.string().max(160),atFrame:z.number().int().nonnegative(),durationFrames:z.number().int().positive(),sourceInFrame:z.number().int().nonnegative().default(0),sourceFps:z.number().positive().max(240).default(24),artifact:Ref.optional(),shot:Ref.optional(),takeId:Id.optional(),linkedVideoClipId:Id.optional(),volume:z.number().min(0).max(2).default(1),muted:z.boolean().default(false),transition:z.enum(['cut','fade']).default('cut'),motion:z.enum(['none','push-in','pan-left']).default('none')});
export type Clip=z.infer<typeof Clip>;
export const Cue=z.strictObject({id:Id,startFrame:z.number().int().nonnegative(),endFrame:z.number().int().positive(),text:z.string().max(4000)});
export const CutData=z.strictObject({episode:Ref.optional(),chapters:z.array(Ref).max(100).default([]),title:z.string().min(1).max(160),fps:z.number().int().min(1).max(60).default(24),width:z.number().int().min(64).max(4096).default(1280),height:z.number().int().min(64).max(4096).default(720),tracks:z.array(Track).min(1),clips:z.array(Clip).max(1000).default([]),cues:z.array(Cue).max(2000).default([]),notes:z.string().max(6000).default(''),branchOf:Ref.optional()});
export type CutData=z.infer<typeof CutData>;
export const BuildData=z.strictObject({title:z.string().max(200),cut:Ref,project:Ref,snapshot:CutData,artifacts:z.array(Ref),range:z.strictObject({startFrame:z.number().int().nonnegative(),endFrame:z.number().int().positive()}),encoding:z.strictObject({crf:z.number().int().min(16).max(30).default(20),subtitles:z.boolean().default(true)}),createdAt:z.string(),state:z.enum(['ready','rendering','completed']).default('ready'),jobId:Id.optional(),output:Ref.optional()});
export type BuildData=z.infer<typeof BuildData>;
export const AssemblePlan=z.strictObject({version:z.literal(1),snapshot:CutData,range:z.strictObject({startFrame:z.number().int().nonnegative(),endFrame:z.number().int().positive()}),encoding:BuildData.shape.encoding,media:z.array(z.strictObject({ref:Ref,sha256:z.string().regex(/^[a-f0-9]{64}$/),mediaType:z.string(),durationSeconds:z.number().optional()}))});
export type AssemblePlan=z.infer<typeof AssemblePlan>;
export function cutDuration(cut:CutData){return Math.max(0,...cut.clips.map(c=>c.atFrame+c.durationFrames),...cut.cues.map(c=>c.endFrame));}
export function locate(cut:CutData,frame:number){return cut.clips.filter(c=>c.atFrame<=frame&&frame<c.atFrame+c.durationFrames).map(c=>({clipId:c.id,trackId:c.trackId,shot:c.shot,takeId:c.takeId,artifact:c.artifact,sourceFrame:c.sourceInFrame+Math.floor((frame-c.atFrame)*c.sourceFps/cut.fps)}));}

type ClipMedia={mediaType:string;durationSeconds?:number;metadata?:Record<string,unknown>};
export type ClipMediaReader=(ref:Ref)=>ClipMedia;
const sameRef=(a:Ref|undefined,b:Ref|undefined)=>!!a&&!!b&&a.kind===b.kind&&a.id===b.id&&a.seq===b.seq;
export function nativeAudioRef(media:ClipMedia|undefined):Ref|undefined {
 const ref=Ref.safeParse(media?.metadata?.nativeAudio);
 return ref.success&&ref.data.kind==='artifact'?ref.data:undefined;
}
export function assertClipSource(clip:Clip,fps:number,read:ClipMediaReader){
 if(!clip.artifact)return;
 const media=read(clip.artifact);
 if(media.mediaType.startsWith('image/')||media.durationSeconds===undefined)return;
 const required=clip.sourceInFrame/clip.sourceFps+clip.durationFrames/fps,missing=required-media.durationSeconds;
 ensure(missing<=1e-6,'VALIDATION',`「${clip.title}」素材不足：当前入点后需 ${(clip.durationFrames/fps).toFixed(2)} 秒，可用 ${Math.max(0,media.durationSeconds-clip.sourceInFrame/clip.sourceFps).toFixed(2)} 秒，缺 ${Math.max(0,missing).toFixed(2)} 秒；请补足素材或明确调整时长，剪辑预算未缩短`);
}
// Only recognize old generated sound when source metadata, track, title and timing all agree.
// Never infer ownership from an audio artifact alone: users can reuse it as music or dialogue.
function linkedSound(cut:CutData,video:Clip,read:ClipMediaReader):Clip[]{
 const explicit=cut.clips.filter(c=>c.linkedVideoClipId===video.id);
 if(explicit.length||!video.artifact)return explicit;
 const native=nativeAudioRef(read(video.artifact));if(!native)return [];
 const generated=cut.clips.filter(c=>!c.linkedVideoClipId&&c.title===video.title+' · 原声'&&sameRef(c.artifact,native)&&cut.tracks.some(t=>t.id===c.trackId&&t.type==='sfx'&&t.title==='生成原声'));
 const audioSeconds=read(native).durationSeconds;
 const oldFrames=audioSeconds===undefined?video.durationFrames:Math.min(video.durationFrames,Math.floor((audioSeconds-video.sourceInFrame/video.sourceFps)*cut.fps));
 const legacy=generated.filter(c=>c.atFrame===video.atFrame&&(c.durationFrames===video.durationFrames||c.durationFrames===oldFrames)&&Math.abs(c.sourceInFrame/c.sourceFps-video.sourceInFrame/video.sourceFps)<1e-6);
 ensure(generated.length===legacy.length,'VALIDATION','旧原声与画面裁切已不一致，请先确认并移除旧原声，再编辑画面');
 ensure(legacy.length<=1,'VALIDATION','此画面存在多段相同的旧原声，请先明确保留的原声片段');
 return legacy;
}
function syncNativeSound(cut:CutData,video:Clip,oldSound:Clip[],read:ClipMediaReader,id:()=>string):CutData{
 const native=video.artifact?nativeAudioRef(read(video.artifact)):undefined;
 let tracks=cut.tracks;let sound:Clip|undefined;
 if(native){
  ensure(read(native).mediaType.startsWith('audio/'),'MEDIA_INVALID','原声引用不是音频');
  let track=oldSound[0]&&tracks.find(t=>t.id===oldSound[0].trackId);
  track??=tracks.find(t=>t.type==='sfx'&&t.title==='生成原声');
  if(!track){track={id:id(),title:'生成原声',type:'sfx',volume:1,muted:false};tracks=[...tracks,track];}
  sound={...video,...oldSound[0],id:oldSound[0]?.id??id(),trackId:track.id,title:(video.title+' · 原声').slice(0,160),artifact:native,shot:undefined,takeId:undefined,linkedVideoClipId:video.id,atFrame:video.atFrame,durationFrames:video.durationFrames,sourceInFrame:video.sourceInFrame,sourceFps:video.sourceFps,transition:'cut',motion:'none'};
  assertClipSource(sound,cut.fps,read);
 }
 const removed=new Set(oldSound.map(c=>c.id));
 return {...cut,tracks,clips:[...cut.clips.filter(c=>!removed.has(c.id)),...(sound?[sound]:[])]};
}
export function insertCutClip(cut:CutData,clip:Clip,read:ClipMediaReader,id:()=>string):CutData{
 assertClipSource(clip,cut.fps,read);
 const next={...cut,clips:[...cut.clips,clip]};
 return cut.tracks.find(t=>t.id===clip.trackId)?.type==='video'?syncNativeSound(next,clip,[],read,id):next;
}
export function copyCutClip(cut:CutData,clipId:string,read:ClipMediaReader,id:()=>string):{cut:CutData;clipId:string}{
 const original=cut.clips.find(c=>c.id===clipId);ensure(original,'NOT_FOUND','该片段已移除');
 ensure(!original.linkedVideoClipId,'VALIDATION','关联原声须随画面一起复制');
 const video=cut.tracks.find(t=>t.id===original.trackId)?.type==='video';
 const copy={...original,id:id(),atFrame:video?cutDuration(cut):original.atFrame+original.durationFrames};
 assertClipSource(copy,cut.fps,read);
 const next={...cut,clips:[...cut.clips,copy]};
 // New identities preserve the original sound while retaining its mix and track.
 const sounds=video?linkedSound(cut,original,read).map(sound=>({...sound,id:id(),linkedVideoClipId:copy.id})):[];
 return {cut:video?syncNativeSound(next,copy,sounds,read,id):next,clipId:copy.id};
}
export function updateCutClip(cut:CutData,clipId:string,patch:Partial<Clip>,read:ClipMediaReader,id:()=>string):CutData{
 const original=cut.clips.find(c=>c.id===clipId);ensure(original,'NOT_FOUND','该片段已移除');
 const changed={...original,...patch};
 if(patch.sourceFps!==undefined&&patch.sourceInFrame===undefined)changed.sourceInFrame=Math.round(original.sourceInFrame/original.sourceFps*patch.sourceFps);
 assertClipSource(changed,cut.fps,read);
 const next={...cut,clips:cut.clips.map(c=>c.id===clipId?changed:c)};
 return cut.tracks.find(t=>t.id===original.trackId)?.type==='video'?syncNativeSound(next,changed,linkedSound(cut,original,read),read,id):next;
}
export function removeCutClip(cut:CutData,clipId:string,read:ClipMediaReader):CutData{
 const clip=cut.clips.find(c=>c.id===clipId);if(!clip)return cut;
 const related=cut.tracks.find(t=>t.id===clip.trackId)?.type==='video'?linkedSound(cut,clip,read):[];
 const removed=new Set([clipId,...related.map(c=>c.id)]);
 return {...cut,clips:cut.clips.filter(c=>!removed.has(c.id))};
}
