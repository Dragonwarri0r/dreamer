import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Play,Pause,SkipBack,SkipForward,Volume2,VolumeX,Subtitles,ExternalLink} from 'lucide-react';
import {cutDuration,type CutData,type Clip} from '../../../packages/contracts/editorial.ts';
import type {StudioContext} from './editors.tsx';

function timecode(frame:number,fps:number){
 const seconds=Math.floor(frame/fps);
 return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}.${String(Math.floor(frame%fps)).padStart(2,'0')}`;
}

/** Separate media clocks follow the Cut clock, including source in-points and seeks. */
function PreviewMedia({kind,src,seconds,playing,volume,onFailure,onWaiting}:{kind:'video'|'audio';src:string;seconds:number;playing:boolean;volume:number;onFailure:(message:string)=>void;onWaiting:(waiting:boolean)=>void}){
 const ref=useRef<HTMLMediaElement|null>(null);
 const latest=useRef({seconds,playing,volume});latest.current={seconds,playing,volume};
 const sync=useCallback(()=>{
  const el=ref.current;if(!el)return;const state=latest.current;
  el.volume=Math.min(1,Math.max(0,state.volume));
  if(el.readyState>=1&&Math.abs(el.currentTime-state.seconds)>(state.playing?.18:.015))el.currentTime=state.seconds;
  if(state.playing&&el.paused&&el.readyState>=2)void el.play().catch(()=>onFailure('浏览器未能播放素材。请再次点击播放，或检查该镜头。'));
  if(!state.playing&&!el.paused)el.pause();
 },[onFailure]);
 useEffect(sync,[seconds,playing,volume,sync]);
 useEffect(()=>{const el=ref.current;return ()=>el?.pause();},[]);
 useEffect(()=>{onWaiting(true);return ()=>onWaiting(false);},[src,onWaiting]);
 const common={src,preload:'auto',onLoadedMetadata:sync,onCanPlay:()=>{onWaiting(false);sync();},onSeeking:()=>onWaiting(true),onSeeked:()=>{if((ref.current?.readyState??0)>=2)onWaiting(false);},onWaiting:()=>onWaiting(true),onError:()=>{onWaiting(false);onFailure('素材读取失败，请打开当前镜头检查或重新生成。');}};
 return kind==='video'?<video {...common} ref={el=>{ref.current=el;}} muted playsInline/>:<audio {...common} ref={el=>{ref.current=el;}}/>;
}

export function CutPreview({cut,ctx,frame,onFrame,onSelect}:{cut:CutData;ctx:StudioContext;frame:number;onFrame:(frame:number)=>void;onSelect?:(id:string)=>void}){
 const duration=cutDuration(cut),[playing,setPlaying]=useState(false),[muted,setMuted]=useState(false),[subtitles,setSubtitles]=useState(true),[error,setError]=useState(''),[jump,setJump]=useState('');
 const waiting=useRef(new Set<string>()),[buffering,setBuffering]=useState(false),position=useRef(frame),previous=useRef(0);
 const onFrameRef=useRef(onFrame);onFrameRef.current=onFrame;
 const tracks=useMemo(()=>new Map(cut.tracks.map(t=>[t.id,t])),[cut.tracks]);
 const pictures=useMemo(()=>cut.clips.filter(c=>tracks.get(c.trackId)?.type==='video').sort((a,b)=>a.atFrame-b.atFrame),[cut.clips,tracks]);
 const clip=pictures.find(c=>c.atFrame<=frame&&frame<c.atFrame+c.durationFrames),index=clip?pictures.indexOf(clip):-1;
 const artifact=clip?.artifact&&ctx.state.artifacts.find((a:any)=>a.id===clip.artifact?.id);
 const activeAudio=cut.clips.filter(c=>tracks.get(c.trackId)?.type!=='video'&&c.atFrame<=frame&&frame<c.atFrame+c.durationFrames);
 const failure=useCallback((message:string)=>{setError(message);setPlaying(false);},[]);
 const playerRoot=useRef<HTMLElement|null>(null);
 useEffect(()=>{const node=playerRoot.current;const pause=()=>setPlaying(false);node?.addEventListener('dreamer:pause-preview',pause);return()=>node?.removeEventListener('dreamer:pause-preview',pause);},[]);
 useEffect(()=>{const pauseHidden=()=>{if(document.hidden)setPlaying(false);};document.addEventListener('visibilitychange',pauseHidden);return ()=>document.removeEventListener('visibilitychange',pauseHidden);},[]);
 // Stable callbacks avoid remounting or restarting a media element at every frame.
 const waitCallbacks=useRef(new Map<string,(value:boolean)=>void>());
 const onWaiting=(id:string)=>{if(!waitCallbacks.current.has(id))waitCallbacks.current.set(id,value=>{if(value)waiting.current.add(id);else waiting.current.delete(id);setBuffering(waiting.current.size>0);});return waitCallbacks.current.get(id)!;};
 useEffect(()=>{if(Math.floor(position.current)!==frame)position.current=frame;},[frame]);
 useEffect(()=>{if(frame>=duration&&duration){position.current=duration-1;onFrameRef.current(duration-1);setPlaying(false);}},[duration,frame]);
 useEffect(()=>{
  if(!playing)return;let handle=0;previous.current=performance.now();
  const tick=(now:number)=>{const elapsed=Math.min(.1,(now-previous.current)/1000);previous.current=now;
   if(!waiting.current.size){position.current+=elapsed*cut.fps;if(position.current>=duration-1){position.current=Math.max(0,duration-1);setPlaying(false);}onFrameRef.current(Math.floor(position.current));}
   handle=requestAnimationFrame(tick);
  };handle=requestAnimationFrame(tick);return ()=>cancelAnimationFrame(handle);
 },[playing,cut.fps,duration]);
 function seek(next:number){const value=Math.max(0,Math.min(duration-1,Math.round(next)));position.current=value;onFrame(value);setError('');const c=pictures.find(c=>c.atFrame<=value&&value<c.atFrame+c.durationFrames);if(c)onSelect?.(c.id);}
 function toggle(){setError('');if(!playing&&frame>=duration-1)seek(0);setPlaying(v=>!v);}
 const mediaUrl=(id:string)=>`/api/media?projectId=${ctx.projectId}&id=${id}`;
 const localFrame=clip?frame-clip.atFrame:0,seconds=(c:Clip)=>c.sourceInFrame/c.sourceFps+(frame-c.atFrame)/cut.fps;
 const progress=clip?localFrame/clip.durationFrames:0,fadeFrames=clip?Math.min(cut.fps*.25,clip.durationFrames/3):1;
 const opacity=clip?.transition==='fade'?Math.min(1,localFrame/fadeFrames,(clip.durationFrames-localFrame)/fadeFrames):1;
 const imageTransform=clip?.motion==='push-in'?`scale(${Math.min(1+localFrame*.0015,1.15)})`:clip?.motion==='pan-left'?`scale(1.12) translateX(${(progress-.5)*8}%)`:'none';
 const cues=cut.cues.filter(c=>c.startFrame<=frame&&frame<c.endFrame);
 const sourceLabel=artifact?.data.mediaType.startsWith('video/')?'动态素材':artifact?.data.mediaType.startsWith('image/')?'静帧预演':'文字占位';
 return <section ref={playerRoot} className="draft-player" data-playback-group aria-label="草稿连续预览" tabIndex={0} onKeyDown={e=>{
  if((e.target as HTMLElement).matches('input,textarea,select,button,a'))return;
  if(e.code==='Space'){e.preventDefault();toggle();}else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setPlaying(false);seek(frame+(e.key==='ArrowLeft'?-1:1));}
 }}>
  <div className="preview-heading"><strong>草稿预览</strong><span>{sourceLabel} · {index>=0?`${index+1} / ${pictures.length} 镜`:'空档'}</span><span className="top-spacer"/>{clip?.shot&&<button onClick={()=>{setPlaying(false);ctx.open('shot',clip.title,clip.shot!.id);}}><ExternalLink size={13}/>修改当前镜头</button>}</div>
  <div className="preview-stage" style={{aspectRatio:`${cut.width}/${cut.height}`,width:`min(100%, ${440*cut.width/cut.height}px)`}}>
   <div className="preview-picture" style={{opacity}}>
    {artifact?.data.mediaType.startsWith('image/')?<img src={mediaUrl(artifact.id)} style={{transform:imageTransform}} alt={clip?.title} onError={()=>failure('参考图读取失败，请检查当前镜头。')}/>:artifact?.data.mediaType.startsWith('video/')&&clip?<PreviewMedia key={clip.id+':'+artifact.id} kind="video" src={mediaUrl(artifact.id)} seconds={seconds(clip)} playing={playing&&!buffering} volume={0} onFailure={failure} onWaiting={onWaiting(clip.id)}/>:<div className="preview-placeholder"><strong>{clip?.title??'空画面'}</strong><small>尚未配置画面素材</small></div>}
   </div>
   {subtitles&&cues.length>0&&<div className="preview-captions">{cues.map(c=><span key={c.id}>{c.text}</span>)}</div>}
   {buffering&&<span className="preview-buffering" role="status">{playing?'正在缓冲素材…':'正在载入画面与声音…'}</span>}
  </div>
  {activeAudio.map(c=>{const t=tracks.get(c.trackId)!;return c.artifact&&<PreviewMedia key={c.id+':'+c.artifact.id} kind="audio" src={mediaUrl(c.artifact.id)} seconds={seconds(c)} playing={playing&&!buffering&&!muted&&!c.muted&&!t.muted} volume={muted||c.muted||t.muted?0:c.volume*t.volume} onFailure={failure} onWaiting={onWaiting(c.id)}/>;})}
  <div className="preview-transport">
   <button aria-label="上一镜" disabled={!duration||index===0&&frame===0} onClick={()=>seek(pictures[Math.max(0,index-(clip&&frame===clip.atFrame?1:0))]?.atFrame??0)}><SkipBack size={17}/></button>
   <button className="primary" aria-label={playing?'暂停草稿':'播放草稿'} disabled={!duration} onClick={toggle}>{playing?<Pause size={18}/>:<Play size={18}/>}</button>
   <button aria-label="下一镜" disabled={index>=pictures.length-1} onClick={()=>seek(pictures[index+1]?.atFrame??duration-1)}><SkipForward size={17}/></button>
   <output aria-label="草稿播放时间">{timecode(frame,cut.fps)} / {timecode(duration,cut.fps)}</output>
   <span className="top-spacer"/>
   <button aria-label={muted?'开启预览声音':'静音预览'} aria-pressed={muted} onClick={()=>setMuted(v=>!v)}>{muted?<VolumeX size={17}/>:<Volume2 size={17}/>}</button>
   <button aria-label="显示预览字幕" aria-pressed={subtitles} onClick={()=>setSubtitles(v=>!v)}><Subtitles size={17}/></button>
  </div>
  <input aria-label="时间线播放位置" className="preview-scrubber" type="range" min={0} max={Math.max(0,duration-1)} value={Math.min(frame,Math.max(0,duration-1))} onChange={e=>seek(Number(e.target.value))}/>
  <div className="preview-navigation"><select aria-label="跳转到镜头" value={clip?.id??''} onChange={e=>{const c=pictures.find(c=>c.id===e.target.value);if(c)seek(c.atFrame);}}><option value="">选择镜头</option>{pictures.map((c,i)=><option key={c.id} value={c.id}>{i+1}. {c.title} · {timecode(c.atFrame,cut.fps)}</option>)}</select><form onSubmit={e=>{e.preventDefault();if(jump.trim()&&Number.isFinite(Number(jump)))seek(Number(jump)*cut.fps);}}><input aria-label="跳到秒数" type="number" min={0} max={duration/cut.fps} step={.1} value={jump} onChange={e=>setJump(e.target.value)} placeholder="秒数"/><button>跳转</button></form></div>
  {error&&<p className="preview-error" role="alert">{error}</p>}
  <p className="preview-help">直接试听当前草稿，无需等待合成。空格播放 / 暂停，方向键逐帧。淡入和静帧运动为近似预览；导出以固定成片为准。</p>
 </section>;
}
