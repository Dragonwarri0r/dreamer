import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ApiError} from '../client.ts';
import {experienceClient} from './client.ts';
import type {PlayableSegment} from '../../../../packages/contracts/experience.ts';

const terminal=(attempt:any)=>attempt&&['completed','skipped','cancelled'].includes(attempt.status);
export type VideoStageProps={
 plan:PlayableSegment;projectId:string;uid:string;runId:string;visitId:string;position?:any;inputPending:boolean;
 onFrame:(frame:number)=>void;onView:(view:any)=>void;onComplete:()=>Promise<boolean>;
 /** The parent keeps this intent across segments, and resets it for another run, UID or history view. */
 resumePlayback?:boolean;onPlaybackIntentChange?:(playing:boolean)=>void;
 /** An uncertain completion must be resolved through its original persisted request. */
 completionBlocked?:boolean;
 /** Called once when this visit pauses at its required-input deadline. */
 onInputRequired?:()=>void;
};

export function VideoStage({plan,projectId,uid,runId,visitId,position,inputPending,onFrame,onView,onComplete,resumePlayback=false,onPlaybackIntentChange,completionBlocked=false,onInputRequired}:VideoStageProps){
 const video=useRef<HTMLVideoElement>(null),root=useRef<HTMLDivElement>(null),bindings=plan.bindings.filter(b=>b.kind==='video').sort((a,b)=>a.atFrame-b.atFrame);
 const [index,setIndex]=useState(()=>Math.max(0,bindings.findIndex(b=>(position?.frame??0)>=b.atFrame&&(position?.frame??0)<b.atFrame+b.durationFrames)));
 const [loadError,setLoadError]=useState(''),[paused,setPaused]=useState(true),[completionState,setCompletionState]=useState<'idle'|'submitting'|'failed'|'completed'>('idle');
 const binding=bindings[index],positionSeq=useRef(position?.positionSeq??0),lastSave=useRef(0),saving=useRef(false),cueReported=useRef(false),completed=useRef(false),completing=useRef(false),completionFailed=useRef(false),switching=useRef(false),resume=useRef(resumePlayback),mounted=useRef(true),currentFrame=useRef(position?.frame??0);
 const inputRequiredReported=useRef(false);
 const intent=useRef(resumePlayback),internalPauseEvents=useRef(0),pausedForInput=useRef(false),previousInputPending=useRef(inputPending);
 const cue=plan.cues[0],deadline=cue?.deadlineFrame??plan.durationFrames;
 const setIntent=(playing:boolean)=>{if(!mounted.current)return;intent.current=playing;onPlaybackIntentChange?.(playing);};
 const pauseInternally=()=>{const element=video.current;if(element&&!element.paused){internalPauseEvents.current++;element.pause();}};
 // Stop accepting events in the synchronous unmount phase. A delayed pause from
 // the previous video must not clear the next visit's inherited playback intent.
 useLayoutEffect(()=>{const element=video.current;mounted.current=true;return()=>{mounted.current=false;element?.pause();};},[]);
 useEffect(()=>{intent.current=resumePlayback;if(!resumePlayback){resume.current=false;pauseInternally();}},[resumePlayback]);
 useEffect(()=>{if(position?.visitId===visitId&&position?.planHash===plan.planHash)positionSeq.current=Math.max(positionSeq.current,position.positionSeq);},[position?.positionSeq,visitId,plan.planHash]);
 const frame=()=>{const time=video.current?.currentTime??binding.sourceInFrame/binding.sourceFps;return Math.max(binding.atFrame,Math.min(binding.atFrame+binding.durationFrames,Math.round(binding.atFrame+(time-binding.sourceInFrame/binding.sourceFps)*plan.fps)));};
 function clampToHost(view:any){
  if(view.run.currentVisitId!==visitId||view.playback?.planHash!==plan.planHash)return false;
  const hostPosition=view.position;if(hostPosition?.visitId===visitId&&hostPosition.planHash===plan.planHash)positionSeq.current=Math.max(positionSeq.current,hostPosition.positionSeq);
  const hostCue=view.playback.cues[0],limit=hostCue&&!terminal(view.attempt)?hostCue.deadlineFrame:plan.durationFrames;
  // A competing window can update its cursor, but must not move this window's
  // position. The current Host input deadline still applies to this window.
  if(currentFrame.current>limit){currentFrame.current=limit;onFrame(limit);const b=bindings.find(v=>limit>=v.atFrame&&limit<=v.atFrame+v.durationFrames);if(video.current&&b?.id===binding?.id){pausedForInput.current=!!hostCue;pauseInternally();video.current.currentTime=b.sourceInFrame/b.sourceFps+(limit-b.atFrame)/plan.fps;}}
  return true;
 }
 async function save(retryConflict=true){
  if(saving.current||!mounted.current)return;const sentFrame=currentFrame.current;saving.current=true;let success=false,retry=false;
  try{
   const result=await experienceClient.position(projectId,uid,{protocolVersion:1,requestId:crypto.randomUUID(),runId,visitId,planHash:plan.planHash,frame:sentFrame,expectedPositionSeq:positionSeq.current});
   if(!mounted.current)return;positionSeq.current=Math.max(positionSeq.current,result.position?.positionSeq??result.positionSeq??positionSeq.current+1);success=true;
   if(result.view){clampToHost(result.view);onView(result.view);}
  }catch(error){
   cueReported.current=false;
   if(error instanceof ApiError&&error.code==='CONFLICT'){
    try{const fresh=await experienceClient.run(projectId,uid,runId);if(mounted.current){const samePlan=clampToHost(fresh);onView(fresh);retry=retryConflict&&samePlan;}}catch{}
   }
  }finally{
   saving.current=false;
   // One recovery write per conflict; later playback may save normally.
   if(mounted.current){if(retry)void save(false);else if(success&&currentFrame.current!==sentFrame)void save();}
  }
 }
 async function requestCompletion(explicit=false){
  if(completed.current||completing.current||completionBlocked||!mounted.current||inputPending)return;
  if(completionFailed.current&&!explicit)return;
  completing.current=true;setCompletionState('submitting');pauseInternally();
  try{
   // The parent owns request identity, receipt recovery and bounded 409 retry.
   // A failed/unknown submission never closes this player or auto-creates a new request.
   const accepted=await onComplete();if(!mounted.current)return;
   completed.current=accepted;completionFailed.current=!accepted;setCompletionState(accepted?'completed':'failed');
  }catch{
   if(mounted.current){completionFailed.current=true;setCompletionState('failed');}
  }finally{completing.current=false;}
 }
 function continuePlayback(explicit=false){
  const element=video.current;if(!mounted.current||!element||!binding||completionBlocked||completing.current||completed.current)return;
  if(inputPending&&currentFrame.current>=deadline)return;
  if(explicit)setIntent(true);
  if(currentFrame.current>=binding.atFrame+binding.durationFrames){
   if(index<bindings.length-1){switching.current=true;resume.current=intent.current;currentFrame.current=bindings[index+1].atFrame;setIndex(index+1);}
   else void requestCompletion(explicit);
   return;
  }
  void element.play().catch(()=>{if(mounted.current){setPaused(true);setLoadError('请点击“继续故事”恢复播放。');}});
 }
 const tick=()=>{
  const element=video.current;if(!mounted.current||!element||switching.current)return;
  const sourceStart=binding.sourceInFrame/binding.sourceFps;if(element.currentTime<sourceStart){element.currentTime=sourceStart;return;}
  let next=frame();const blocked=inputPending&&next>=deadline;if(blocked)next=deadline;
  const end=binding.atFrame+binding.durationFrames,reachedEnd=next>=end;currentFrame.current=next;onFrame(next);
  if(blocked||reachedEnd){
   if(blocked)pausedForInput.current=true;pauseInternally();const target=sourceStart+(next-binding.atFrame)/plan.fps;if(Math.abs(element.currentTime-target)>.04)element.currentTime=target;
   if(!blocked&&reachedEnd){
    if(index<bindings.length-1){switching.current=true;resume.current=intent.current;currentFrame.current=bindings[index+1].atFrame;setIndex(index+1);}
    else void requestCompletion();
   }
  }
  if(Date.now()-lastSave.current>2500||!!cue&&!cueReported.current&&next>=(cue.resolvedBinding?.appearFrame??0)){lastSave.current=Date.now();if(cue&&next>=(cue.resolvedBinding?.appearFrame??0))cueReported.current=true;void save();}
 };
 useEffect(()=>{
  const wasPending=previousInputPending.current;previousInputPending.current=inputPending;
  if(wasPending&&!inputPending&&pausedForInput.current){pausedForInput.current=false;if(intent.current&&!completionFailed.current)continuePlayback();}
 },[inputPending]);
 useEffect(()=>{const element=root.current,pause=()=>{if(!mounted.current)return;setIntent(false);video.current?.pause();};element?.addEventListener('dreamer:pause-preview',pause);return()=>element?.removeEventListener('dreamer:pause-preview',pause);},[]);
 const waitingInput=inputPending&&currentFrame.current>=deadline;
 useEffect(()=>{if(waitingInput&&!inputRequiredReported.current){inputRequiredReported.current=true;onInputRequired?.();}},[waitingInput,onInputRequired]);
 if(!binding)return <p role="alert">当前播放计划没有视频绑定，不能当作已就绪内容播放。</p>;
 return <div className="experience-video" data-playback-group={runId} ref={root}>
  <video ref={video} controls controlsList="nofullscreen" playsInline preload="metadata" aria-label="互动故事视频" src={experienceClient.media(projectId,uid,runId,plan.planHash,binding.id)}
   onLoadedMetadata={()=>{if(!mounted.current||!video.current)return;const requested=Math.max(binding.atFrame,Math.min(currentFrame.current,binding.atFrame+binding.durationFrames-1)),allowed=inputPending?Math.min(requested,deadline):requested;video.current.currentTime=binding.sourceInFrame/binding.sourceFps+(allowed-binding.atFrame)/plan.fps;currentFrame.current=allowed;onFrame(allowed);switching.current=false;setLoadError('');if(resume.current){resume.current=false;if(intent.current)continuePlayback();}}}
   onTimeUpdate={tick} onSeeking={tick} onPlay={()=>{if(!mounted.current)return;setPaused(false);setLoadError('');setIntent(true);}}
   onPause={()=>{if(!mounted.current)return;setPaused(true);if(internalPauseEvents.current>0)internalPauseEvents.current--;else if(!video.current?.ended&&!switching.current)setIntent(false);void save();}}
   onError={()=>{if(mounted.current)setLoadError('视频暂时无法读取。请保留本次体验，刷新后重试。');}} onEnded={tick}/>
  {loadError&&<p role="alert">{loadError}</p>}
  {waitingInput&&paused&&<p role="status">请先完成当前输入，再继续故事。</p>}
  {completionBlocked&&<p role="status">片段已播放完，请先核对原提交，再继续故事。</p>}
  {completionState==='failed'&&!completionBlocked&&<p role="status">暂未确认片段完成。可以继续故事，重试这次进度提交。</p>}
  {completionState==='submitting'&&<p role="status">正在保存故事进度…</p>}
  {/* Keep one control mounted when playback changes, so keyboard focus is preserved. */}
  <button className="primary experience-playback-toggle" disabled={completionBlocked||completionState==='submitting'||completionState==='completed'} aria-disabled={waitingInput||undefined} onClick={()=>{if(waitingInput)return;if(paused)continuePlayback(true);else{setIntent(false);video.current?.pause();}}}>{completionState==='submitting'?'正在保存进度…':waitingInput?'等待当前输入':paused?'继续故事':'暂停故事'}</button>
 </div>;
}
