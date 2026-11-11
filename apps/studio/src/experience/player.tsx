import React,{useCallback,useEffect,useId,useRef,useState} from 'react';
import {Play,RefreshCw,ArrowLeft,MoreHorizontal,Maximize,UserRound,X} from 'lucide-react';
import {registerEditor,type EditorProps} from '../editors.tsx';
import {experienceClient,type Pending} from './client.ts';
import {ApiError} from '../client.ts';
import {ExperienceArchivePanel} from './history.tsx';
import {VideoStage} from './video-stage.tsx';
import type {RuntimeView} from '../../../../packages/contracts/experience.ts';
import type {ExperienceCatalog} from '../../../../packages/contracts/experience-catalog.ts';
import {ExperienceLibrary} from './library.tsx';
import {readInputDraft,writeInputDraft,clearInputDraft,type InputDraftScope} from './input-draft.ts';
import './player.css';

const statuses:Record<string,string>={active:'故事进行中',waitingInput:'等待你的选择',waitingContent:'正在准备故事',blocked:'需要处理',completed:'已到达结局',abandoned:'体验已结束'};
const stages:Record<string,string>={planned:'等待准备',writing:'准备剧本',checking:'检查内容',producing:'生成媒体',ready:'可以继续',consumed:'已经历',waitingReview:'等待作者确认',blocked:'准备遇到问题',unknown:'原任务结果待核对',cancelled:'已取消',stale:'输入版本已变化'};
const terminal=(attempt:any)=>attempt&&['completed','skipped','cancelled'].includes(attempt.status);
const ended=(view?:RuntimeView)=>!!view&&['completed','abandoned'].includes(view.run.status);
function errorMessage(error:any){return error instanceof TypeError||error?.message==='Failed to fetch'?'连接暂时中断。已填写的内容仍保留，请检查本地服务；如有待确认提交，请先核对原提交。':error?.message??'读取失败，请重试。';}
function initialUid(binding:string){try{return binding.startsWith('uid:')?decodeURIComponent(binding.slice(4)):'reader-1';}catch{return 'reader-1';}}

function ExperienceEditor({ctx,tab}:EditorProps){
 const [uid,setUid]=useState(()=>initialUid(tab.binding)),[selectedUid,setSelectedUid]=useState(()=>initialUid(tab.binding));
 const [runId,setRunId]=useState(tab.objectId??''),[runs,setRuns]=useState<any[]>([]),[catalog,setCatalog]=useState<ExperienceCatalog['releases']>([]),[catalogCursor,setCatalogCursor]=useState<string>();
 const [view,setView]=useState<RuntimeView>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[frame,setFrame]=useState(0);
 const [trace,setTrace]=useState<any>(),[pending,setPending]=useState<Pending[]>([]),[historyOpen,setHistoryOpen]=useState(false),[abandonConfirm,setAbandonConfirm]=useState(false);
 const [playIntent,setPlayIntent]=useState(false),[runsState,setRunsState]=useState<'loading'|'ready'|'error'>('loading'),[catalogState,setCatalogState]=useState<'loading'|'ready'|'error'>('loading'),[runsError,setRunsError]=useState(''),[catalogError,setCatalogError]=useState(''),[cancelConfirm,setCancelConfirm]=useState<string>(),[toolsOpen,setToolsOpen]=useState(false);
 const toolsId=useId(),toolsTrigger=useRef<HTMLButtonElement>(null),toolsPanel=useRef<HTMLElement>(null),tracePanel=useRef<HTMLElement>(null);
 function closeTools(restoreFocus=true){setToolsOpen(false);if(restoreFocus)toolsTrigger.current?.focus();}
 useEffect(()=>{if(!toolsOpen)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setToolsOpen(false);toolsTrigger.current?.focus();}};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[toolsOpen]);
 useEffect(()=>{if(trace)requestAnimationFrame(()=>{tracePanel.current?.scrollIntoView({block:'nearest'});tracePanel.current?.focus({preventScroll:true});});},[trace]);
 const keyboardInteraction=useRef(false),feedbackElement=useRef<HTMLDivElement>(null),cancelDialog=useRef<HTMLElement>(null),abandonDialog=useRef<HTMLElement>(null);
 useEffect(()=>{if(abandonConfirm){abandonDialog.current?.scrollIntoView({block:'nearest'});abandonDialog.current?.focus({preventScroll:true});}},[abandonConfirm]);
 useEffect(()=>{const keyboard=(e:KeyboardEvent)=>{if(['Tab','Enter',' '].includes(e.key))keyboardInteraction.current=true;},pointer=()=>{keyboardInteraction.current=false;};document.addEventListener('keydown',keyboard);document.addEventListener('pointerdown',pointer);return()=>{document.removeEventListener('keydown',keyboard);document.removeEventListener('pointerdown',pointer);};},[]);
 const traceRequest=useRef(0),catalogExpanded=useRef(false),locked=useRef(false),epoch=useRef(0),activeScope=useRef(''),viewRef=useRef(view),panel=useRef<HTMLDivElement>(null),stage=useRef<HTMLDivElement>(null);
 activeScope.current=`${ctx.projectId}:${selectedUid}:${runId}`;viewRef.current=view;
 const acceptView=useCallback((next:RuntimeView)=>setView(current=>current?.run.id===next.run.id&&current.run.stateSeq>next.run.stateSeq?current:next),[]);
 const refresh=useCallback(async(clearError=false)=>{
  const scope=`${ctx.projectId}:${selectedUid}:${runId}`,at=epoch.current;
  try{
   if(runId){const next=await experienceClient.run(ctx.projectId,selectedUid,runId);if(scope!==activeScope.current||at!==epoch.current)return;acceptView(next);}
   else{
    const current=()=>scope===activeScope.current&&at===epoch.current;
    await Promise.allSettled([
     experienceClient.runs(ctx.projectId,selectedUid).then(records=>{if(current()){setRuns(records.runs??[]);setRunsState('ready');setRunsError('');}}).catch(e=>{if(current()){setRunsState('error');setRunsError(errorMessage(e));}}),
     experienceClient.catalog(ctx.projectId,selectedUid).then(stories=>{if(!current())return;setCatalogState('ready');setCatalogError('');setCatalog(existing=>{const extra=existing.filter(story=>!stories.releases.some(head=>head.releaseId===story.releaseId));return [...stories.releases,...extra];});if(!catalogExpanded.current)setCatalogCursor(stories.nextCursor);}).catch(e=>{if(current()){setCatalogState('error');setCatalogError(errorMessage(e));}})
    ]);
    if(!current())return;
   }
   setPending(experienceClient.pending(ctx.projectId,selectedUid));if(clearError)setError('');
  }catch(e:any){if(scope===activeScope.current&&at===epoch.current){setError(errorMessage(e));}}
 },[ctx.projectId,selectedUid,runId,acceptView]);
 useEffect(()=>{
  epoch.current++;traceRequest.current++;catalogExpanded.current=false;setView(undefined);setTrace(undefined);setHistoryOpen(false);setAbandonConfirm(false);setError('');setFrame(0);setRuns([]);setCatalog([]);setCatalogCursor(undefined);setPending(experienceClient.pending(ctx.projectId,selectedUid));setRunsState('loading');setCatalogState('loading');setRunsError('');setCatalogError('');setCancelConfirm(undefined);setToolsOpen(false);setPlayIntent(false);locked.current=false;setBusy(false);
  void refresh();const timer=setInterval(()=>void refresh(),1500);return()=>{epoch.current++;clearInterval(timer);};
 },[refresh]);
 function navigate(nextUid:string,nextRun=''){
  setToolsOpen(false);epoch.current++;activeScope.current=`${ctx.projectId}:${nextUid}:${nextRun}`;locked.current=false;setBusy(false);setUid(nextUid);setSelectedUid(nextUid);setRunId(nextRun);setView(undefined);setPending([]);setPlayIntent(false);
  ctx.updateTab(tab.instanceId,{binding:`uid:${encodeURIComponent(nextUid)}`,objectId:nextRun||undefined});
  panel.current?.scrollTo({top:0});
 }
 async function send(operation:string,payload:any):Promise<boolean>{
  const current=viewRef.current;if(!current||locked.current||ended(current))return false;
  if(operation!=='segment.complete'&&experienceClient.pending(ctx.projectId,selectedUid).some(item=>item.path==='commands'&&item.body.runId===current.run.id)){setError('有提交尚未确认，请先核对原提交，再继续操作。');return false;}
  locked.current=true;setBusy(true);const at=epoch.current,scope=activeScope.current;let basis=current;
  try{
   // A lost response must be resolved using its original request, never a new completion.
   if(operation==='segment.complete'&&experienceClient.pending(ctx.projectId,selectedUid).some(p=>p.body.runId===current.run.id&&p.body.operation===operation)){setError('上次完成提交尚未确认，请先核对原提交。');return false;}
   for(let retry=0;retry<2;retry++){
    try{
     const result=await experienceClient.command(ctx.projectId,selectedUid,{protocolVersion:1,requestId:crypto.randomUUID(),runId:basis.run.id,expectedStateSeq:basis.run.stateSeq,visitId:operation.startsWith('activity.')?basis.attempt!.visitId:basis.run.currentVisitId,operation,payload} as any);
     if(epoch.current!==at||scope!==activeScope.current)return false;
     acceptView(result.view);setError('');setPending(experienceClient.pending(ctx.projectId,selectedUid));return true;
    }catch(e){
     if(operation!=='segment.complete'||retry!==0||!(e instanceof ApiError)||e.code!=='CONFLICT')throw e;
     const fresh=await experienceClient.run(ctx.projectId,selectedUid,basis.run.id);
     if(epoch.current!==at||scope!==activeScope.current)return false;acceptView(fresh);
     if(fresh.run.currentVisitId!==basis.run.currentVisitId||fresh.run.status==='completed')return true;
     if(ended(fresh)||fresh.playback?.planHash!==payload.planHash)throw e;
     basis=fresh; // One bounded retry against the Host's current version.
    }
   }
   return false;
  }catch(e:any){if(epoch.current===at&&scope===activeScope.current){setError(errorMessage(e));setPending(experienceClient.pending(ctx.projectId,selectedUid));}return false;}
  finally{if(epoch.current===at&&scope===activeScope.current){locked.current=false;setBusy(false);}}
 }
 async function complete(){
  const current=viewRef.current;if(!current?.instance)return false;
  const planHash=current.playback?.planHash??current.instance.inputHash;
  return send('segment.complete',{instanceId:current.instance.id,planHash,frame:current.playback?.durationFrames??0});
 }
 async function start(releaseId:string,mode:'simulation'|'playback'='playback'){
  if(locked.current||experienceClient.pending(ctx.projectId,selectedUid).some(p=>p.path==='start'))return;
  locked.current=true;setBusy(true);const scope=activeScope.current,at=epoch.current;
  try{const result=await experienceClient.start(ctx.projectId,selectedUid,releaseId,mode);if(scope!==activeScope.current||at!==epoch.current)return;navigate(selectedUid,result.view.run.id);}
  catch(e:any){if(scope===activeScope.current&&at===epoch.current){setError(errorMessage(e));setPending(experienceClient.pending(ctx.projectId,selectedUid));}}
  finally{if(scope===activeScope.current&&at===epoch.current){locked.current=false;setBusy(false);}}
 }
 async function recoverSubmission(item:Pending,resend:boolean){
  if(locked.current||item.projectId!==ctx.projectId||item.uid!==selectedUid)return;locked.current=true;setBusy(true);const at=epoch.current,scope=activeScope.current;
  try{
   if(resend){const result=await experienceClient.resend(item);if(at!==epoch.current||scope!==activeScope.current)return;if(result.view.run.id!==runId)navigate(selectedUid,result.view.run.id);else acceptView(result.view);setError('');}
   else{const result=await experienceClient.receipt(item);if(at!==epoch.current||scope!==activeScope.current)return;if(result.found){ctx.notify('原请求已确认');await refresh(true);}else ctx.notify('尚未找到回执，可以重新发送同一个请求');}
   if(at===epoch.current&&scope===activeScope.current)setPending(experienceClient.pending(ctx.projectId,selectedUid));
  }catch(e:any){if(at===epoch.current&&scope===activeScope.current)setError(errorMessage(e));}
  finally{if(at===epoch.current&&scope===activeScope.current){locked.current=false;setBusy(false);}}
 }
 const run=view?.run,playback=view?.playback,cue=playback?.cues[0],attempt=view?.attempt,activity=view?.activity;
 const showInput=!!view&&!ended(view)&&!!activity&&(view.node.type==='activity'||run?.mode==='simulation'||!!cue&&frame>=(cue.resolvedBinding?.appearFrame??0));
 const currentPending=pending.filter(p=>!runId||p.body.runId===runId||p.path==='start');
 const actionBusy=busy||currentPending.length>0;
 const completionBlocked=currentPending.some(p=>p.body.operation==='segment.complete'&&p.body.runId===runId);
 const isCurrentVisit=()=>!!run&&activeScope.current===`${ctx.projectId}:${selectedUid}:${run.id}`&&viewRef.current?.run.currentVisitId===run.currentVisitId;
 const watching=!!view&&!ended(view)&&run?.mode==='playback'&&!historyOpen;
 const startingUnknown=pending.some(p=>p.path==='start');
 const stageVisible=!!view&&!historyOpen&&!ended(view);
 const inputBlocked=currentPending.some(p=>p.body.operation?.startsWith('activity.'));
 const feedback=<div ref={feedbackElement} className="experience-feedback">
  {error&&<p className="inline-warning experience-error" role="alert">{error} <button onClick={()=>void refresh(true)}>刷新状态</button></p>}
  {currentPending.length>0&&<section className="inline-warning experience-pending" role="status"><h2>有提交尚未收到回执</h2><p>先核对原请求，避免重复选择或创建体验。</p>{currentPending.map(item=><div className="actions" key={item.body.requestId}><span>{item.path==='start'?'开始体验':item.body.operation==='segment.complete'?'继续故事':'提交互动'}</span><button disabled={busy} onClick={()=>void recoverSubmission(item,false)}>核对原提交</button><button disabled={busy} onClick={()=>void recoverSubmission(item,true)}>重新发送同一请求</button></div>)}</section>}
 </div>;
 useEffect(()=>{if(!error&&!currentPending.length)return;const frame=requestAnimationFrame(()=>feedbackElement.current?.scrollIntoView({block:'nearest'}));return()=>cancelAnimationFrame(frame);},[error,currentPending.map(item=>item.body.requestId).join(':')]);
 useEffect(()=>{if(cancelConfirm){cancelDialog.current?.scrollIntoView({block:'nearest'});cancelDialog.current?.focus({preventScroll:true});}},[cancelConfirm]);
 function focusInput(){const active=document.activeElement;if(!keyboardInteraction.current||active&&active!==document.body&&!active.closest('.experience-video'))return;const input=stage.current?.querySelector<HTMLElement>('.experience-activity button:not(:disabled),.experience-activity textarea:not([readonly])');input?.focus({preventScroll:true});input?.scrollIntoView({block:'nearest'});}
 async function restartCancelled(){if(!run)return;const scope=activeScope.current,releaseId=run.releaseId,mode=run.mode;if(await send('run.abandon',{})&&scope===activeScope.current)await start(releaseId,mode);}

 return <div ref={panel} className={`editor-scroll experience-editor${watching?' is-watching':''}`}>
  <header className="experience-heading"><div className="experience-title"><div className="eyebrow">互动故事</div><h1>{view?.node.title??'选择你的故事'}</h1></div><div className="experience-heading-actions">
   {runId&&<button className="experience-home" aria-label="我的体验" title="我的体验" onClick={()=>navigate(selectedUid)}><ArrowLeft size={17}/><span>我的体验</span></button>}
   {watching&&playback&&document.fullscreenEnabled&&<button className="experience-fullscreen" aria-label="全屏播放" title="全屏播放" onClick={()=>{closeTools(false);void stage.current?.requestFullscreen().catch(()=>setError('当前窗口无法全屏，可继续在页面内播放。'));}}><Maximize size={17}/><span>全屏</span></button>}
   <button ref={toolsTrigger} aria-label={runId?'更多体验操作':'管理档案'} aria-expanded={toolsOpen} aria-controls={toolsId} onClick={()=>setToolsOpen(open=>!open)}>{runId?<MoreHorizontal size={18}/>:<UserRound size={17}/>}<span>{runId?'更多':'档案'}</span></button>
  </div></header>
  {toolsOpen&&<section id={toolsId} ref={toolsPanel} className="experience-tools" role="region" aria-label={runId?'体验选项':'管理档案'}>
   <div className="experience-tools-heading"><h2>{runId?'体验选项':'管理档案'}</h2><button aria-label="收起体验选项" title="收起体验选项" onClick={()=>closeTools()}><X size={17}/></button></div>
   {view&&run&&<div className="experience-tool-links">
    {run.mode==='playback'&&<button onClick={()=>{closeTools();setPlayIntent(false);setHistoryOpen(true);}}>回看与导出视频</button>}
    <button onClick={async()=>{closeTools();const scope=activeScope.current,at=epoch.current,request=++traceRequest.current;try{const result=await experienceClient.trace(ctx.projectId,selectedUid,run.id);if(scope===activeScope.current&&at===epoch.current&&request===traceRequest.current)setTrace(result);}catch(e:any){if(scope===activeScope.current&&at===epoch.current&&request===traceRequest.current)setError(errorMessage(e));}}}>查看已走路线</button>
    <a className="button" href={experienceClient.exportUrl(ctx.projectId,selectedUid,run.id)} download onClick={()=>closeTools()}>导出本次路线清单</a>
    {!ended(view)&&<button className="experience-end-action" disabled={busy} onClick={()=>{closeTools();setPlayIntent(false);setAbandonConfirm(true);}}>结束这次体验</button>}
   </div>}
   <form className="experience-profile" onSubmit={e=>{e.preventDefault();if(uid.trim()){closeTools();navigate(uid.trim());}}}>
    <label><span>本地档案</span><input aria-label="当前体验 UID" value={uid} maxLength={80} onChange={e=>setUid(e.target.value)}/></label><button disabled={!uid.trim()}>切换档案</button>
    <p className="muted">UID 区分本机存档。返回“我的体验”可保留进度，稍后继续。</p>
    {run&&<small>剧情版本 {run.stateSeq} · 固定发布 {run.releaseId.slice(0,8)}</small>}
   </form>
  </section>}
  {!stageVisible&&feedback}
  {runId&&!view&&!error&&<p role="status">正在读取故事进度…</p>}
  {!runId&&<>
   <ExperienceRuns runs={runs} state={runsState} error={runsError} onRetry={()=>void refresh(true)} onOpen={id=>navigate(selectedUid,id)}/>
   <ExperienceLibrary releases={catalog} busy={busy} startingUnknown={startingUnknown} onStart={releaseId=>void start(releaseId)} loading={catalogState==='loading'} error={catalogError||undefined} onRetry={()=>void refresh(true)}/>
   {catalogCursor&&<button disabled={busy} onClick={async()=>{if(locked.current)return;const scope=activeScope.current,at=epoch.current;locked.current=true;setBusy(true);try{const more=await experienceClient.catalog(ctx.projectId,selectedUid,catalogCursor);if(scope!==activeScope.current||at!==epoch.current)return;setCatalog(current=>[...current,...more.releases.filter(story=>!current.some(old=>old.releaseId===story.releaseId))]);catalogExpanded.current=true;setCatalogCursor(more.nextCursor);}catch(e:any){if(scope===activeScope.current&&at===epoch.current)setError(errorMessage(e));}finally{if(scope===activeScope.current&&at===epoch.current){locked.current=false;setBusy(false);}}}}>更多已发布版本</button>}
  </>}
  {view&&run&&<>
   <div className="experience-status" aria-live="polite"><span className={`badge ${run.status}`}>{statuses[run.status]}</span>{run.mode==='simulation'&&<span>逻辑模拟 · 不调用模型</span>}</div>
   {run.mode==='simulation'&&<p className="inline-warning">这是路线模拟。片段和活动结果不代表实际视频或小游戏已经制作。</p>}
   {!historyOpen&&!ended(view)&&<div ref={stage} className={`experience-stage${showInput?' has-interaction':''}`}><button className="experience-exit-fullscreen" onClick={()=>void document.exitFullscreen()}>退出全屏</button>
    {feedback}
    <div className="experience-screen">
     {view.node.type==='segment'&&(playback||run.mode==='simulation')&&(run.mode==='simulation'?<section className="experience-simulation"><div className="simulation-frame"><Play size={36}/><strong>{view.node.title}</strong><small>逻辑模拟占位</small></div><p>{view.node.summary??'检查完成后状态与后续路线。'}</p><button className="primary" disabled={busy||!!attempt&&!terminal(attempt)} onClick={()=>void complete()}>模拟片段结束</button></section>:<VideoStage key={run.currentVisitId+playback!.planHash} plan={playback!} uid={selectedUid} projectId={ctx.projectId} runId={run.id} visitId={run.currentVisitId} position={view.position} inputPending={!!cue&&!terminal(attempt)} onFrame={next=>{if(isCurrentVisit())setFrame(next);}} onView={next=>{if(activeScope.current===`${ctx.projectId}:${selectedUid}:${run.id}`)acceptView(next);}} onComplete={()=>isCurrentVisit()?complete():Promise.resolve(false)} resumePlayback={playIntent} onPlaybackIntentChange={next=>{if(isCurrentVisit())setPlayIntent(next);}} completionBlocked={completionBlocked} onInputRequired={focusInput}/>)}
     {(run.status==='waitingContent'||run.status==='blocked')&&<section className="experience-wait" role="status"><h2>{view.instance?.status==='cancelled'?'这次准备已取消':view.instance?.cancelRequested?'正在确认取消结果':activity&&attempt?.status==='interpreting'?'正在理解你的回答':stages[view.instance?.status??'']??statuses[run.status]}</h2>
      {view.instance?.status==='cancelled'?<><p>当前路线无法继续。已有经历仍保留，重新开始会建立新的体验。</p><button className="primary" disabled={actionBusy||startingUnknown} onClick={()=>void restartCancelled()}>结束并重新开始</button></>:<><p>{run.waitReason??'当前剧情已经保留，内容准备好后继续。'}</p><p className="muted">{view.instance?.cancelRequested?'已请求取消，这条路线不会再接收准备结果。核对完成后可以重新开始。':'可以先返回“我的体验”，稍后从原进度继续。'}</p><div className="actions experience-recovery-actions">{view.instance?.status==='unknown'&&<button disabled={actionBusy} onClick={()=>void send('instance.reconcile',{instanceId:view.instance!.id})}>核对原任务</button>}{!view.instance?.cancelRequested&&view.instance?.status==='blocked'&&view.instance.failedStage&&<button disabled={actionBusy} onClick={()=>void send('instance.retry',{instanceId:view.instance!.id,failedStage:view.instance!.failedStage})}>按原输入重试</button>}</div><details className="experience-preparation-options"><summary>准备选项</summary><div className="actions"><button onClick={()=>void refresh(true)}><RefreshCw size={15}/>查看最新状态</button>{view.instance&&!view.instance.cancelRequested&&['writing','checking','producing','unknown','planned'].includes(view.instance.status)&&<button disabled={actionBusy} onClick={()=>{setCancelConfirm(view.instance!.id);}}>取消本次准备</button>}</div></details></>}
      {cancelConfirm===view.instance?.id&&!view.instance?.cancelRequested&&<section ref={cancelDialog} tabIndex={-1} role="alert" className="inline-warning"><h3>确认取消本次准备？</h3><p>取消后，当前路线将无法继续。若只是暂时离开，请返回“我的体验”。已派发的任务仍可能完成并使用已预约额度。</p><div className="actions"><button disabled={actionBusy} onClick={()=>void send('instance.cancel',{instanceId:cancelConfirm!}).then(ok=>{if(ok)setCancelConfirm(undefined);})}>确认取消准备</button><button onClick={()=>{setCancelConfirm(undefined);stage.current?.querySelector<HTMLElement>('.experience-preparation-options summary')?.focus();}}>保留准备，继续等待</button></div></section>}
     </section>}
     {!playback&&view.node.type==='activity'&&<div className="experience-interlude"><h2>故事在等你的回应</h2><p>完成当前互动后，继续下一段。</p></div>}
    </div>
    {showInput&&<ActivityView key={attempt?.id??activity!.id} draftScope={{projectId:ctx.projectId,uid:selectedUid,runId:run.id,attemptId:attempt!.id}} activity={activity} attempt={attempt} busy={busy||inputBlocked} simulation={run.mode==='simulation'} submit={input=>send('activity.submit',{attemptId:attempt!.id,input})} confirm={intentId=>send('activity.confirmIntent',{attemptId:attempt!.id,interpretationRef:attempt!.interpretationRef,intentId})} skip={()=>send('activity.skip',{attemptId:attempt!.id})} retry={()=>send('activity.retry',{attemptId:attempt!.id})} reconcile={()=>send('activity.reconcile',{attemptId:attempt!.id})}/>}
   </div>}
   {!historyOpen&&run.status==='completed'&&<section className="experience-ending"><h2>故事已结束</h2><p>{view.node.summary}</p><p>这次经历已保存。重新体验会建立新的存档，保留原来的选择。</p><button className="primary" disabled={busy||startingUnknown} onClick={()=>void start(run.releaseId,run.mode)}>{run.mode==='playback'?'再体验一次':'再次模拟'}</button></section>}
   {!historyOpen&&run.status==='abandoned'&&<section className="experience-ending"><h2>这次体验已结束</h2><p>已有经历仍可回看。在途准备任务可能继续完成并使用已预约额度，不会再改变这条路线。</p>{run.mode==='playback'&&<button disabled={busy||startingUnknown} onClick={()=>void start(run.releaseId)}>再体验一次</button>}</section>}
   {ended(view)&&run.mode==='playback'&&!historyOpen&&<div className="experience-ending-recap"><button onClick={()=>{setPlayIntent(false);setHistoryOpen(true);}}>回看这次故事</button></div>}
   {abandonConfirm&&!ended(view)&&<section ref={abandonDialog} tabIndex={-1} className="inline-warning" role="alert"><p>结束后，这条路线将停止推进。在途准备任务仍可能完成并使用已预约额度。只想稍后继续，可以返回“我的体验”。</p><div className="actions"><button disabled={busy} onClick={()=>void send('run.abandon',{}).then(ok=>{if(ok)setAbandonConfirm(false);})}>确认结束</button><button onClick={()=>{setAbandonConfirm(false);toolsTrigger.current?.focus();}}>继续这次体验</button></div></section>}
   {historyOpen&&<ExperienceArchivePanel key={`${selectedUid}:${run.id}`} projectId={ctx.projectId} uid={selectedUid} runId={run.id} onClose={()=>{setHistoryOpen(false);toolsTrigger.current?.focus();}}/>}
   {trace&&<section ref={tracePanel} tabIndex={-1} aria-label="已走路线" className="experience-trace"><div className="actions"><h2>已走路线</h2><button onClick={()=>{traceRequest.current++;setTrace(undefined);toolsTrigger.current?.focus();}}>收起路线</button></div>{trace.visits.map((visit:any)=><article key={visit.id}><strong>{visit.title}</strong><span>{({completed:'已完成',active:'进行中',planned:'尚未开放'} as any)[visit.status]??''}</span>{visit.resultLabel&&<span>{visit.resultLabel}</span>}</article>)}{run.mode==='simulation'&&<dl className="experience-variables">{Object.entries(run.variables).map(([key,value])=><React.Fragment key={key}><dt>{key}</dt><dd>{String(value)}</dd></React.Fragment>)}</dl>}</section>}
  </>}

 </div>;
}

function ExperienceRuns({runs,state,error,onRetry,onOpen}:{runs:any[];state:'loading'|'ready'|'error';error:string;onRetry:()=>void;onOpen:(id:string)=>void}){
 const sorted=[...runs].sort((a,b)=>Number(['completed','abandoned'].includes(a.status))-Number(['completed','abandoned'].includes(b.status))||b.updatedAt.localeCompare(a.updatedAt));
 const card=(record:any)=><button className="content-card" key={record.id} onClick={()=>onOpen(record.id)}><strong>{record.title??(record.mode==='simulation'?'逻辑模拟':'互动体验')}</strong><span>{statuses[record.status]??record.status} · {new Date(record.updatedAt).toLocaleString()}</span><small>{['completed','abandoned'].includes(record.status)?'查看这次经历':'继续体验'}</small></button>;
 return <section className="experience-resume"><h2>我的体验</h2>{state==='loading'&&<p role="status">正在读取体验记录…</p>}{error&&<p role="alert">体验记录暂时无法更新。{error}<button onClick={onRetry}>重新读取体验记录</button></p>}{state!=='loading'&&<><div className="experience-runs">{sorted.slice(0,3).map(card)}{state==='ready'&&!runs.length&&<p>这个档案还没有体验记录。</p>}</div>{sorted.length>3&&<details><summary>其他体验记录（{sorted.length-3}）</summary><div className="experience-runs">{sorted.slice(3).map(card)}</div></details>}</>}</section>;
}

function ActivityView({draftScope,activity,attempt,busy,simulation,submit,confirm,skip,retry,reconcile}:{draftScope:InputDraftScope;activity:any;attempt:any;busy:boolean;simulation:boolean;submit:(input:any)=>Promise<boolean>;confirm:(id:string)=>Promise<boolean>;skip:()=>Promise<boolean>;retry:()=>Promise<boolean>;reconcile:()=>Promise<boolean>}){
 const [text,setText]=useState(()=>attempt?.input?.text??readInputDraft(draftScope,activity.maxLength)),[composing,setComposing]=useState(false),[draftPersistent,setDraftPersistent]=useState(true),accepted=terminal(attempt),unknown=activity.recoveryState==='unknown',element=useRef<HTMLElement>(null);
 useEffect(()=>{if(accepted||typeof attempt?.input?.text==='string'){clearInputDraft(draftScope);if(typeof attempt?.input?.text==='string')setText(attempt.input.text);}},[attempt?.status,attempt?.input?.text]);
 useEffect(()=>{const frame=requestAnimationFrame(()=>{const current=element.current;if(!current)return;const box=current.getBoundingClientRect();if(box.bottom>window.innerHeight-24||box.top<92){const first=current.querySelector<HTMLElement>('textarea,button');(box.height>window.innerHeight-120?first??current:current).scrollIntoView({block:'nearest'});}});return()=>cancelAnimationFrame(frame);},[]);

 return <section ref={element} className="experience-activity" aria-label="当前互动"><h2>{activity.label}</h2><p>{activity.prompt}</p>{accepted?<p role="status" className="accepted-choice">已记录：{activity.options?.find((option:any)=>option.id===(attempt.result?.optionId??attempt.result?.intentId))?.label??(attempt.status==='skipped'?'已跳过':'已提交')}。本次体验不能重新选择。</p>:attempt?.status==='interpreting'?<p role="status">正在理解输入，原文字已保存…</p>:<>
  {simulation&&activity.type!=='choice'?<div className="experience-options"><p>选择明确的模拟结果（不会调用模型或游戏）：</p>{activity.options?.map((option:any)=><button key={option.id} disabled={busy} onClick={()=>void submit(activity.type==='text-intent'?{intentId:option.id}:{fixtureId:option.id})}>{option.label}</button>)}{!activity.options?.length&&<p>此活动没有声明模拟结果，请回到剧本补充。</p>}</div>:activity.type==='choice'?<div className="experience-options">{activity.options?.map((option:any)=><button key={option.id} disabled={busy} onClick={()=>void submit({optionId:option.id})}>{option.label}</button>)}</div>:activity.type==='text-intent'?<>
   <form onSubmit={event=>{event.preventDefault();if(!composing&&!busy&&text.trim()&&!unknown&&attempt?.status!=='needsConfirmation'&&attempt?.status!=='failed')void submit({text});}}><label>你的回答<textarea aria-label="你的回答" rows={3} maxLength={activity.maxLength??2000} value={text} readOnly={busy||unknown||['failed','needsConfirmation'].includes(attempt?.status)} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} onChange={event=>{setText(event.target.value);setDraftPersistent(writeInputDraft(draftScope,event.target.value));}}/></label>{!draftPersistent&&<p role="status">浏览器未能保存草稿，刷新前请先复制回答。</p>}{!unknown&&!['failed','needsConfirmation'].includes(attempt?.status)&&<button disabled={busy||composing||!text.trim()}>提交回答</button>}</form>
   {attempt?.interpretation?.explanation&&<p>{attempt.interpretation.explanation}</p>}
   {attempt?.status==='needsConfirmation'&&<div className="experience-options"><p>请选择你想表达的意思：</p>{activity.options?.map((option:any)=><button key={option.id} disabled={busy} onClick={()=>void confirm(option.id)}>{option.label}</button>)}</div>}
   {unknown?<div className="inline-warning" role="status"><p>原输入的理解结果尚未确认，文字已保留。先核对原任务，不会重新提交生成。</p>{activity.canReconcile?<button disabled={busy} onClick={()=>void reconcile()}>核对原输入</button>:<p>{activity.recoveryReason??'请等待作者恢复原执行服务后再核对。'}</p>}</div>:attempt?.status==='failed'&&<div className="inline-warning"><p>未能完成理解，原输入仍保留。</p>{activity.canRetry?<button disabled={busy} onClick={()=>void retry()}>重试理解</button>:<p>当前无法继续重试，请联系作者处理。</p>}</div>}
  </>:<p className="inline-warning">此活动尚未接入。{simulation?'可用作者明确的模拟结果检查后续路线。':'请联系作者处理该版本。'}</p>}
  {activity.canSkip&&<button disabled={busy} onClick={()=>void skip()}>跳过此活动</button>}
 </>}</section>;
}
registerEditor('experience',{title:'互动播放',render:props=><ExperienceEditor {...props}/>});
