import React,{useEffect,useRef,useState} from 'react';
import type {StudioContext} from '../editors.tsx';
import type {ScriptPlanData,FixedMedia} from '../../../../packages/contracts/interactive-script.ts';
import type {InteractionCue} from '../../../../packages/contracts/activities.ts';
import {stable} from '../../../../packages/contracts/foundation.ts';
import {request} from '../client.ts';
import {fixedCuePlanId,validFixedCueRange} from './activity-authoring.ts';

export function FixedCuePanel({ctx,node,plan,cue,onChange}:{ctx:StudioContext;node:any;plan:ScriptPlanData;cue?:InteractionCue;onChange:(p:ScriptPlanData)=>void}){
 const media:FixedMedia=node.contentSpec.media,duration=media.toFrame-media.fromFrame,scope=`${ctx.projectId}:${node.id}:${stable(media)}`;
 const [preview,setPreview]=useState<{scope:string;url:string;planId:string}>(),[error,setError]=useState(''),[frame,setFrame]=useState(0),[appear,setAppear]=useState(cue?.resolvedBinding?.appearFrame??0),[deadline,setDeadline]=useState(cue?.deadlineFrame??Math.max(1,duration-1));
 const video=useRef<HTMLVideoElement>(null),currentScope=useRef(scope);currentScope.current=scope;
 useEffect(()=>{let active=true;setPreview(undefined);setError('');setFrame(0);setAppear(cue?.resolvedBinding?.appearFrame??0);setDeadline(cue?.deadlineFrame??Math.max(1,duration-1));
  void Promise.all([request<any>(`/api/revision?${new URLSearchParams({projectId:ctx.projectId,kind:'build',id:media.buildRef.id,seq:String(media.buildRef.seq)})}`),fixedCuePlanId(media)]).then(async([build,planId])=>{
   if(!build.data.output)throw new Error('固定版本尚无可预览的视频');const ref=build.data.output,artifact=await request<any>(`/api/revision?${new URLSearchParams({projectId:ctx.projectId,kind:'artifact',id:ref.id,seq:String(ref.seq)})}`);
   if(artifact.data.sha256!==media.contentHash)throw new Error('此固定版本的素材与片段绑定不一致，请重新选择视频');
   if(active)setPreview({scope,url:`/api/media?${new URLSearchParams({projectId:ctx.projectId,id:ref.id})}`,planId});
  }).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};
 },[scope,cue?.id]);
 useEffect(()=>{setAppear(cue?.resolvedBinding?.appearFrame??0);setDeadline(cue?.deadlineFrame??Math.max(1,duration-1));},[scope,cue?.id,cue?.resolvedBinding?.appearFrame,cue?.deadlineFrame]);
 const ready=preview?.scope===scope,valid=validFixedCueRange(appear,deadline,duration),stale=cue&&ready&&(cue.resolvedBinding?.planId!==preview.planId||cue.resolvedBinding?.fps!==media.fps||cue.resolvedBinding?.contentHash!==media.contentHash);
 function tick(){const element=video.current;if(!element)return;const start=media.fromFrame/media.fps,end=media.toFrame/media.fps;if(element.currentTime<start)element.currentTime=start;if(element.currentTime>end){element.pause();element.currentTime=end;}setFrame(Math.max(0,Math.min(duration,Math.round(element.currentTime*media.fps-media.fromFrame))));}
 function seek(next:number){video.current?.pause();if(video.current)video.current.currentTime=(media.fromFrame+next)/media.fps;setFrame(next);}
 function apply(){if(!ready||!valid||currentScope.current!==scope)return;video.current?.pause();const next:InteractionCue={id:cue?.id??crypto.randomUUID(),segmentNodeId:node.id,activityNodeId:node.next,anchor:{ref:node.sourceSceneRefs[0],position:'offset',offsetFrames:appear},resolvedBinding:{planId:preview.planId,contentHash:media.contentHash,fps:media.fps,appearFrame:appear},deadlineFrame:deadline,activateAt:'segmentEnd'};onChange({...plan,cues:cue?plan.cues.map(c=>c.id===cue.id?next:c):[...plan.cues,next]});}
 return <section className="fixed-cue-panel" aria-label="固定视频互动定位"><h4>在视频中定位输入</h4><p className="muted">预览使用固定成片 v{media.buildRef.seq}，片段共 {duration} 帧（{(duration/media.fps).toFixed(2)} 秒）。位置按当前裁剪片段计算。</p>{error&&<p className="inline-warning" role="alert">{error}</p>}{!ready&&!error&&<p role="status">正在读取固定视频…</p>}{ready&&<video key={scope} ref={video} aria-label="固定视频互动原声预览" controls playsInline preload="metadata" src={preview.url} style={{width:'100%',maxHeight:'45vh'}} onLoadedMetadata={()=>seek(0)} onTimeUpdate={tick} onSeeking={tick} onError={()=>setError('视频读取失败，请检查固定素材后再定位。')}/>}
 <p>当前位置：第 {frame} 帧（{(frame/media.fps).toFixed(2)} 秒）</p><label>预览位置<input aria-label="固定视频预览位置" type="range" min={0} max={duration} step={1} disabled={!ready} value={frame} onChange={e=>seek(Number(e.target.value))}/></label>
 <div className="form-grid"><label>输入出现秒数<input aria-label="固定视频输入出现秒数" type="number" min={0} max={(duration-1)/media.fps} step={1/media.fps} value={Number((appear/media.fps).toFixed(3))} onChange={e=>setAppear(Math.round(Number(e.target.value)*media.fps))}/></label><label>输入截止秒数<input aria-label="固定视频输入截止秒数" type="number" min={1/media.fps} max={(duration-1)/media.fps} step={1/media.fps} value={Number((deadline/media.fps).toFixed(3))} onChange={e=>setDeadline(Math.round(Number(e.target.value)*media.fps))}/></label></div>
 <div className="actions"><button disabled={!ready} onClick={()=>setAppear(Math.min(frame,duration-1))}>设为输入出现位置</button><button disabled={!ready} onClick={()=>setDeadline(Math.max(1,Math.min(frame,duration-1)))}>设为输入截止位置</button></div>
 <details><summary>精确帧数</summary><div className="form-grid"><label>出现帧<input aria-label="固定视频输入出现帧" type="number" min={0} max={duration-1} step={1} value={appear} onChange={e=>setAppear(Number(e.target.value))}/></label><label>截止帧<input aria-label="固定视频输入截止帧" type="number" min={1} max={duration-1} step={1} value={deadline} onChange={e=>setDeadline(Number(e.target.value))}/></label></div></details>
 {!valid&&<p className="inline-warning" role="alert">出现帧需为 0–{duration-1} 的整数，截止帧必须晚于出现帧且不超过 {duration-1}。</p>}{stale&&<p className="inline-warning" role="status">当前视频或裁剪已改变，请核对位置后重新应用。</p>}
 <p className="muted">到截止位置未完成输入则暂停；选择在片段结束后影响路线。应用仅修改本地剧本草稿，需要另行保存和发布。</p><div className="actions"><button disabled={!ready||!valid||!!error} onClick={apply}>{cue?'应用位置到剧本草稿':'在这段视频中发起输入'}</button>{cue&&<button onClick={()=>onChange({...plan,cues:plan.cues.filter(c=>c.id!==cue.id)})}>改为片段之间输入</button>}</div></section>;
}
