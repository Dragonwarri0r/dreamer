import React,{useEffect,useState,useRef} from 'react';
import type {StudioContext} from '../editors.tsx';
import {experienceClient} from '../experience/client.ts';
import {InstanceCuePanel} from './instance-cue.tsx';

export function InstanceReviewPanel({ctx,uid,releaseIds}:{ctx:StudioContext;uid:string;releaseIds:string[]}){
 const [runs,setRuns]=useState<any[]>([]),[runId,setRunId]=useState(''),[visits,setVisits]=useState<any[]>([]),[instance,setInstance]=useState<any>(),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [target,setTarget]=useState(''),[mode,setMode]=useState<'append'|'replace'>('append'),[sceneId,setSceneId]=useState(''),[disclose,setDisclose]=useState(false);
 const releaseKey=[...releaseIds].sort().join(','),scope=useRef(''),loadVersion=useRef(0),selection=useRef({runId:'',instanceId:''}),mounted=useRef(true),reading=useRef<string|undefined>(undefined),actionBusy=useRef<string|undefined>(undefined),lastInstance=useRef<any>(undefined);scope.current=JSON.stringify([ctx.projectId,uid,releaseKey]);
 const reviewPanel=useRef<HTMLDetailsElement>(null);
 const [refreshing,setRefreshing]=useState(false),[updatedAt,setUpdatedAt]=useState('');
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;loadVersion.current++;};},[]);
 useEffect(()=>{loadVersion.current++;selection.current={runId:'',instanceId:''};lastInstance.current=undefined;setInstance(undefined);setRunId('');setRuns([]);setVisits([]);setDisclose(false);setMessage('');reading.current=undefined;actionBusy.current=undefined;setBusy(false);setRefreshing(false);setUpdatedAt('');},[uid,ctx.projectId,releaseKey]);
 async function load(id:string,selectedInstanceId?:string,background=false){
  if(background&&(reading.current||actionBusy.current))return;
  const at=scope.current,version=++loadVersion.current,token=`${at}:${version}`;reading.current=token;setRefreshing(true);
  if(!background){selection.current={runId:id,instanceId:selectedInstanceId??''};setBusy(true);}
  const valid=()=>mounted.current&&at===scope.current&&version===loadVersion.current&&selection.current.runId===id;
  try{
   const [view,trace]=await Promise.all([experienceClient.run(ctx.projectId,uid,id),experienceClient.trace(ctx.projectId,uid,id)]);
   if(!valid())return;
   const reached=trace.visits.filter((visit:any)=>visit.instanceId);setVisits(reached);
   const instanceId=selectedInstanceId??view.instance?.id??reached.at(-1)?.instanceId;
   if(!instanceId){setInstance(undefined);setMessage('这次体验尚未到达有正文的片段。');return;}
   const r=await experienceClient.instance(ctx.projectId,uid,id,instanceId);
   if(!valid())return;
   const previous=lastInstance.current,changed=previous?.id!==r.instance.id||previous?.resultRevision!==r.instance.resultRevision;
   selection.current={runId:id,instanceId};lastInstance.current=r.instance;
   setInstance({...r.instance,scope:at});if(changed){setSceneId(r.instance.scriptResult?.scenes[0]?.id??'');setDisclose(false);}setMessage('');setUpdatedAt(new Date().toLocaleTimeString());
  }catch(e:any){if(valid())setMessage(e.message);}finally{if(version===loadVersion.current&&at===scope.current&&reading.current===token){reading.current=undefined;if(mounted.current){setBusy(!!actionBusy.current);setRefreshing(false);}}}
 }
 // Refresh only the selected personal instance. This never reloads or saves the author's script draft.
 useEffect(()=>{if(!runId||!instance||['consumed','cancelled','stale'].includes(instance.status))return;const timer=setInterval(()=>void load(runId,instance.id,true),2000);return()=>clearInterval(timer);},[runId,instance?.id,instance?.status,uid,ctx.projectId,releaseKey]);
 async function loadRuns(){const at=scope.current;try{const r=await experienceClient.runs(ctx.projectId,uid);if(!mounted.current||at!==scope.current)return;const selected=r.runs.filter((run:any)=>releaseIds.includes(run.releaseId));setRuns(selected);setMessage(selected.length?'':'当前档案没有本剧本的体验');}catch(e:any){if(mounted.current&&at===scope.current)setMessage(e.message);}}
 async function propose(){
  const at=scope.current,version=loadVersion.current,current=instance,token=crypto.randomUUID();if(actionBusy.current)return;actionBusy.current=token;setBusy(true);
  try{
   const [kind,id]=target.split(':'),rows=kind==='chapter'?ctx.state.chapters:ctx.state.scenes,row=rows.find((item:any)=>item.id===id);
   if(!row)throw new Error('请明确选择目标场景或章节');
   const ref=await ctx.command(`${kind}.checkpoint`,{id,expectedSeq:row.seq});
   if(at!==scope.current||version!==loadVersion.current)return;
   await ctx.command('instance.propose',{uid,runId,instanceId:current.id,resultRevision:current.resultRevision??1,target:ref,mode,...(kind==='scene'&&current.scriptResult&&!current.fallbackResult?{sceneIds:[sceneId]}:{}),confirmDisclosure:true});
   if(!mounted.current||at!==scope.current||version!==loadVersion.current)return;setDisclose(false);ctx.notify('个人正文已提取为待批准提案，目标正文尚未修改');ctx.open('review','个人实例提案');
  }catch(e:any){if(mounted.current&&at===scope.current)setMessage(e.message);}finally{if(actionBusy.current===token){actionBusy.current=undefined;if(mounted.current&&at===scope.current)setBusy(false);}}
 }
 const revision=instance?.resultRevision??1,passed=(stage:string)=>instance?.checks?.some((check:any)=>check.stage===stage&&check.resultRevision===revision&&check.status==='passed');
 const mayExtract=instance&&(instance.fallbackResult||instance.scriptResult||instance.templateResult)&&!['planned','writing','checking','waitingReview','unknown','cancelled','stale'].includes(instance.status)&&(instance.fallbackResult||!instance.scriptResult||passed('structure')&&(passed('authorReview')||passed('content')));
 const needsAttention=instance&&instance.scope===scope.current&&(instance.pendingPlaybackPlan||['waitingReview','blocked','unknown'].includes(instance.status));
 return <section className="script-instance-review">{needsAttention&&<div className="inline-warning script-review-attention" role="status"><strong>{instance.pendingPlaybackPlan?'个人内容待确认互动位置':instance.status==='waitingReview'?'个人内容等待作者审阅':instance.status==='unknown'?'个人内容的制作结果待核对':'个人内容需要处理'}</strong><button onClick={()=>{if(reviewPanel.current){reviewPanel.current.open=true;reviewPanel.current.scrollIntoView({block:'start',behavior:'smooth'});reviewPanel.current.querySelector<HTMLElement>('summary')?.focus({preventScroll:true});}}}>查看待处理内容</button></div>}<details className="script-disclosure" ref={reviewPanel}><summary>体验内容审阅<span>{runId?'已选体验自动跟随制作进度':'按测试档案查看、审阅和提取个人内容'}</span></summary><h3>查看个人内容</h3><p className="muted">仅检查当前 UID 在本剧本发布版本中已到达的个人内容。确认继续体验与提取为作者提案是两个独立操作。</p>
  <div className="actions"><button disabled={busy||!uid.trim()} onClick={()=>void loadRuns()}>读取此档案的体验</button>{runId&&<button disabled={busy||refreshing} onClick={()=>void load(runId,selection.current.instanceId||undefined)}>刷新当前内容</button>}</div>{runId&&<p className="muted" role="status">{refreshing?'正在更新当前实例…':updatedAt?`最近更新 ${updatedAt} · 当前实例自动跟随制作进度`:'正在读取当前实例…'}</p>}
  {runs.length>0&&<label>待查看体验<select aria-label="待查看体验" value={runId} disabled={busy} onChange={e=>{loadVersion.current++;selection.current={runId:e.target.value,instanceId:''};lastInstance.current=undefined;setInstance(undefined);setVisits([]);setDisclose(false);setRunId(e.target.value);if(e.target.value)void load(e.target.value);}}><option value="">选择一次体验</option>{runs.map(r=><option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString()} · {r.status}</option>)}</select></label>}
  {visits.length>0&&<label>已到达的实例<select aria-label="已到达的实例" value={instance?.id??''} disabled={busy} onChange={e=>{loadVersion.current++;setInstance(undefined);setDisclose(false);void load(runId,e.target.value);}}><option value="" disabled>选择一个实例</option>{visits.map(visit=><option key={visit.id} value={visit.instanceId}>{visit.title} · {visit.status==='completed'?'已完成':'当前片段'}</option>)}</select></label>}
  {message&&<p role="status">{message}</p>}
  {instance&&instance.scope===scope.current&&<>
   <p>实例状态：{({planned:'准备中',writing:'正文写作中',checking:'正文检查中',waitingReview:'等待作者确认正文',producing:'视频制作中',ready:'已可播放',consumed:'已播放',blocked:'需要处理',unknown:'结果待核对',cancelled:'已取消',stale:'已失效'} as Record<string,string>)[instance.status]??instance.status} · 内容修订 {instance.resultRevision??(instance.templateResult?1:'尚未生成')}</p>
   <p className="muted">{instance.pendingPlaybackPlan?'下一步：在下方预览视频，确认互动位置。':instance.status==='waitingReview'?'下一步：审阅正文后确认继续或退回。':['writing','checking','producing','planned'].includes(instance.status)?'制作正在推进，可以留在此处等待；正文草稿不会被刷新覆盖。':instance.status==='ready'?'下一步：返回互动播放继续体验，或提取正文为作者提案。':''}</p>
   {!instance.fallbackResult&&instance.scriptResult?.scenes.map((scene:any)=><article key={scene.id}><h4>{scene.title}</h4>{scene.blocks.map((block:any)=><p key={block.id}>{block.speaker&&<strong>{block.speaker}：</strong>}{block.text}</p>)}</article>)}
   {instance.fallbackResult&&<article><h4>实际采用的固定后备正文</h4><p style={{whiteSpace:'pre-wrap'}}>{instance.fallbackResult.text}</p></article>}
   {!instance.fallbackResult&&instance.templateResult&&<article><h4>固定模板正文</h4><p style={{whiteSpace:'pre-wrap'}}>{instance.templateResult.text}</p></article>}
   <InstanceCuePanel ctx={ctx} uid={uid} runId={runId} instance={instance} refresh={()=>load(runId,instance.id)}/>
   {instance.checks?.filter((c:any)=>c.status!=='passed').map((c:any)=><p className="inline-warning" role="status" key={c.id}>{c.message}</p>)}
   {instance.checks?.length>0&&<details><summary>完整检查记录</summary>{instance.checks.map((c:any)=><p key={c.id}>{c.stage} · {c.status} · {c.message}</p>)}</details>}
   {instance.status==='waitingReview'&&<div className="actions">{[[true,'确认此版本可继续'],[false,'退回当前实例']].map(([approve,label])=><button key={String(approve)} disabled={busy||!instance.resultRevision} onClick={async()=>{const at=scope.current,current=instance,selected=runId,token=crypto.randomUUID();if(actionBusy.current)return;actionBusy.current=token;setBusy(true);try{await ctx.command('instance.review',{uid,runId:selected,instanceId:current.id,resultRevision:current.resultRevision,approve});if(!mounted.current||at!==scope.current||selection.current.runId!==selected)return;await load(selected,current.id);ctx.notify('已保存本实例的审阅决定');}catch(e:any){if(mounted.current&&at===scope.current)setMessage(e.message);}finally{if(actionBusy.current===token){actionBusy.current=undefined;if(mounted.current&&at===scope.current)setBusy(false);}}}}>{String(label)}</button>)}</div>}
   {(instance.fallbackResult||instance.scriptResult||instance.templateResult)&&<details className="script-extract-details"><summary>提取为作者提案</summary><fieldset><legend>提取所选正文</legend><p className="muted">只提取下面选择的正文和来源标识。原始输入、变量、媒体与其他体验记录继续保存在个人档案；目标内容需在“变更与审阅”批准后才修改。</p>
    <label>提取目标<select aria-label="提取目标" value={target} disabled={busy} onChange={e=>{setTarget(e.target.value);setDisclose(false);}}><option value="">明确选择一个场景或章节</option>{[['scene','scenes','场景'],['chapter','chapters','章节']].map(([kind,key,label])=><optgroup key={kind} label={label}>{(ctx.state[key]??[]).map((row:any)=><option key={row.id} value={`${kind}:${row.id}`}>{row.data.title} · v{row.seq}</option>)}</optgroup>)}</select></label>
    {target.startsWith('scene:')&&instance.scriptResult&&!instance.fallbackResult&&<label>提取的来源场景<select aria-label="提取的来源场景" value={sceneId} disabled={busy} onChange={e=>{setSceneId(e.target.value);setDisclose(false);}}>{instance.scriptResult.scenes.map((scene:any)=><option key={scene.id} value={scene.id}>{scene.title}</option>)}</select></label>}
    <label>正文采用方式<select aria-label="正文采用方式" value={mode} disabled={busy} onChange={e=>{setMode(e.target.value as 'append'|'replace');setDisclose(false);}}><option value="append">追加正文，保留目标已有内容</option><option value="replace">提议替换目标正文</option></select></label>
    {!mayExtract&&<p className="muted">当前正文尚未完成检查和确认，暂不能提取。</p>}
    <label className="checkbox"><input type="checkbox" checked={disclose} disabled={busy||!mayExtract||!target} onChange={e=>setDisclose(e.target.checked)}/>我确认将所选个人正文及来源标识公开到本项目的作者提案</label>
    <button disabled={busy||!mayExtract||!target||!disclose||(target.startsWith('scene:')&&instance.scriptResult&&!instance.fallbackResult&&!sceneId)} onClick={()=>void propose()}>创建正文提案</button>
   </fieldset></details>}
  </>}
 </details></section>;
}
