import React,{useEffect,useRef,useState} from 'react';
import type {ExperiencedHistory,ExperienceExport} from '../../../../packages/contracts/experience-export.ts';
import {experienceClient} from './client.ts';
import './history.css';

const failureMessage=(error:unknown)=>error instanceof TypeError?'连接暂时中断，请检查本地服务后重试。':error instanceof Error?error.message:'读取失败，请重试。';

/** Read-only history deliberately has no runtime command or position-save dependency. */
export function ExperienceArchivePanel({projectId,uid,runId,onClose}:{projectId:string;uid:string;runId:string;onClose:()=>void}){
 const [history,setHistory]=useState<ExperiencedHistory>(),[exports,setExports]=useState<ExperienceExport[]>([]),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[exportOpen,setExportOpen]=useState(false);
 const requestId=useRef<string|undefined>(undefined),locked=useRef(false),reload=useRef<(()=>void)|undefined>(undefined),scope=useRef(''),noticedExportStates=useRef(new Set<string>()),returnButton=useRef<HTMLButtonElement>(null);scope.current=`${projectId}:${uid}:${runId}`;
 useEffect(()=>{returnButton.current?.focus({preventScroll:true});returnButton.current?.scrollIntoView({block:'nearest'});},[projectId,uid,runId]);
 useEffect(()=>{
  let active=true,fetching=false;
  setHistory(undefined);setExports([]);setError('');setLoadError('');setLoading(true);requestId.current=undefined;locked.current=false;setBusy(false);setExportOpen(false);noticedExportStates.current.clear();
  const load=async()=>{
   if(fetching)return;fetching=true;
   try{const [h,r]=await Promise.all([experienceClient.history(projectId,uid,runId),experienceClient.exports(projectId,uid,runId)]);if(active){setHistory(h);setExports(r.exports);setLoadError('');}}
   catch(e:unknown){if(active)setLoadError(failureMessage(e));}
   finally{fetching=false;if(active)setLoading(false);}
  };
  reload.current=()=>void load();void load();const timer=setInterval(()=>void load(),1500);
  return()=>{active=false;reload.current=undefined;clearInterval(timer);};
 },[projectId,uid,runId]);
 useEffect(()=>{
  // Reveal new work or failures once; polling must not repeatedly undo a reader's
  // decision to collapse this section. Its summary still exposes the live state.
  for(const record of exports){
   const state=`${record.id}:${record.status}`;
   if(record.status!=='completed'&&!noticedExportStates.current.has(state))setExportOpen(true);
   noticedExportStates.current.add(state);
  }
 },[exports]);
 async function create(retry?:string){if(locked.current)return;locked.current=true;setBusy(true);setExportOpen(true);const at=scope.current;try{if(retry)await experienceClient.retryExport(projectId,uid,runId,retry);else{requestId.current??=crypto.randomUUID();await experienceClient.createExport(projectId,uid,runId,requestId.current);requestId.current=undefined;}const r=await experienceClient.exports(projectId,uid,runId);if(at===scope.current){setExports(r.exports);setError('');}}catch(e:unknown){if(at===scope.current){setError(failureMessage(e));setExportOpen(true);}}finally{if(at===scope.current){locked.current=false;setBusy(false);}}}
 const exportAttention=!!error||(!busy&&!!requestId.current)||exports.some(record=>record.status==='failed');
 const exportWorking=busy||exports.some(record=>record.status==='queued'||record.status==='rendering');
 const exportStatus=busy?'正在导出':exportAttention?'需要处理':exportWorking?'正在导出':exports.some(record=>record.status==='completed')?'视频可下载':'';
 return <section className="experience-history" aria-label="已走路线回看" aria-busy={loading}>
  <div className="experience-history-heading"><h2>已走路线回看</h2><button ref={returnButton} onClick={onClose}>返回当前体验</button></div>
  <p className="muted">回看已经完成的片段，不改变当前剧情。</p>
  {loading&&<p role="status">正在加载已走路线…</p>}
  {loadError&&<div role="alert" className="inline-warning"><p>{history?'回看记录暂时无法更新，已加载的片段仍可查看。':'暂时无法加载已走路线。'}{loadError}</p><button disabled={loading} onClick={()=>reload.current?.()}>重新加载回看</button></div>}
  {history?.segments.length?<HistoryVideo key={`${runId}:${history.segments.map(s=>s.instanceId).join(':')}`} history={history}/>:!loading&&!loadError&&history?<p>当前还没有已经完成的视频片段。</p>:null}
  {history?.decisions.length?<details className="experience-history-section experience-history-decisions"><summary>当时的选择（{history.decisions.length}）</summary><div className="experience-trace">{history.decisions.map(d=><article key={d.visitId}><strong>{d.title}</strong><span>{d.resultLabel??'已记录选择'}</span></article>)}</div></details>:null}
  <details className="experience-history-section experience-history-exports" open={exportOpen} onToggle={event=>setExportOpen(event.currentTarget.open)}>
   <summary>保存与导出{exportStatus&&<span className={exportAttention?'experience-export-status needs-attention':'experience-export-status'} role="status">{exportStatus}</span>}</summary>
   <div className="experience-history-section-body">
    <p className="muted">将你已经看过的片段连成视频，保留原声，无需重新生成。</p>
    {error&&<p role="alert" className="inline-warning">{error}</p>}
    <div className="actions"><button className="primary" disabled={busy||loading||!history?.segments.length} onClick={()=>void create()}>{busy?'正在提交导出…':requestId.current?'核对并重试导出请求':'导出已走路线 MP4'}</button></div>
    {exports.map(record=><article className="job-card" key={record.id}><strong>{({queued:'等待本地导出',rendering:'正在本机拼接',completed:'视频已导出',failed:'本地导出需要处理'})[record.status]}</strong><p className="muted">{record.plan.segments.length} 个片段 · {record.plan.durationSeconds.toFixed(1)} 秒</p>{record.error&&<p role="alert" className="inline-warning">{record.error}</p>}<div className="actions">{record.status==='completed'&&<a className="button" download href={experienceClient.exportVideoUrl(projectId,uid,runId,record.id)}>下载已走路线视频</a>}{record.status==='failed'&&<button disabled={busy} onClick={()=>void create(record.id)}>按原路线重试本地导出</button>}</div><details className="experience-history-source"><summary>来源与版本清单</summary><p className="muted">导出于 {new Date(record.createdAt).toLocaleString()}。清单记录这条路线使用的视频与版本。</p><a className="button" download href={experienceClient.exportManifestUrl(projectId,uid,runId,record.id)}>下载来源与版本清单</a></details></article>)}
   </div>
  </details>
 </section>;
}
function HistoryVideo({history}:{history:ExperiencedHistory}){
 const items=history.segments.flatMap((segment,segmentIndex)=>segment.playback.bindings.filter(b=>b.kind==='video').sort((a,b)=>a.atFrame-b.atFrame).map(binding=>({segment,segmentIndex,binding}))),[index,setIndex]=useState(0),[playing,setPlaying]=useState(false),[error,setError]=useState('');const video=useRef<HTMLVideoElement>(null),switching=useRef(false),resume=useRef(false),item=items[index];
 function select(next:number,play=false){video.current?.pause();setPlaying(false);if(next<0||next>=items.length){setPlaying(false);return;}if(next===index){video.current!.currentTime=item.binding.sourceInFrame/item.binding.sourceFps;if(play)void video.current?.play();return;}switching.current=true;resume.current=play;setIndex(next);setError('');}
 function tick(){const element=video.current;if(!element||switching.current)return;const start=item.binding.sourceInFrame/item.binding.sourceFps,end=start+item.binding.durationFrames/item.segment.playback.fps;if(element.currentTime<start){element.currentTime=start;return;}if(element.currentTime>=end-.001){const continuing=element.ended||!element.paused;element.pause();if(Math.abs(element.currentTime-end)>.03)element.currentTime=end;if(index<items.length-1)select(index+1,continuing);else setPlaying(false);}}
 useEffect(()=>{const element=video.current;return()=>element?.pause();},[]);
 return <div className="experience-history-player" data-playback-group={`history-${history.runId}`}><label>回看片段<select aria-label="回看片段" value={item.segmentIndex} onChange={e=>select(items.findIndex(v=>v.segmentIndex===Number(e.target.value)),false)}>{history.segments.map((s,i)=><option key={s.visitId} value={i}>{i+1}. {s.title}</option>)}</select></label><video controls playsInline preload="metadata" aria-label="已走路线回看视频" ref={video} src={experienceClient.media(history.projectId,history.uid,history.runId,item.segment.playback.planHash,item.binding.id)} onLoadedMetadata={()=>{video.current!.currentTime=item.binding.sourceInFrame/item.binding.sourceFps;switching.current=false;setPlaying(false);if(resume.current){resume.current=false;void video.current!.play().catch(()=>setError('请点击播放继续回看。'));}}} onTimeUpdate={tick} onSeeking={tick} onEnded={tick} onPlay={()=>setPlaying(video.current?.paused===false)} onPause={()=>setPlaying(false)} onError={()=>setError('此段原媒体暂时不可读，请检查恢复素材。')}/><div className="actions"><button disabled={index===0} onClick={()=>select(index-1,false)}>上一段</button><button onClick={()=>{if(playing)video.current?.pause();else void video.current?.play();}}>{playing?'暂停回看':'连续回看'}</button><button disabled={index===items.length-1} onClick={()=>select(index+1,false)}>下一段</button></div><p>{item.segment.title} · 第 {index+1} / {items.length} 段素材</p>{error&&<p role="alert" className="inline-warning">{error}</p>}</div>;
}
