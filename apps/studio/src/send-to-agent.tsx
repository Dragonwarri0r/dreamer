import React,{useRef,useState} from 'react';
import type {StudioContext} from './editors.tsx';
import {api,inputOwner,request} from './client.ts';
import {useViewState} from './view-state.ts';
import {prepareSubmission,submitAgent,type AgentSubmission} from './agent-submission.ts';
import {prepareWritingSubmission,submitWriting,type WritingSubmission} from './writing-submission.ts';
import {independentReviewMessage,writingModes,type WritingMode} from './writing-flow.ts';

export function SendToAgent({ctx,title,contextKey,freeze,initialText='',skill='revision',buttonLabel='发送给 Agent',writingMode,disabled=false}:{ctx:StudioContext;title:string;contextKey:string;freeze:()=>Promise<any[]>;initialText?:string;skill?:string;buttonLabel?:string;writingMode?:WritingMode;disabled?:boolean}){
 const [open,setOpen]=useState(false),[threadId,setThreadId]=useState('new'),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [pending,setPending]=useViewState<AgentSubmission|WritingSubmission|null>(`${ctx.projectId}:send-context:${contextKey}`,null),locked=useRef(false);
 async function send(e:React.FormEvent){
  e.preventDefault();if(locked.current||(!pending&&!text.trim()))return;locked.current=true;setBusy(true);setError('');
  try{
   let submission=pending;
   if(!submission){
    const bindings=await freeze();
    const thread=threadId==='new'?undefined:await api.object(ctx.projectId,'thread',threadId);
    if(thread?.data.delegation)throw new Error('子任务记录只读，请选择主会话或新建修订会话');
    const message=writingMode==='review'&&!text.includes('dreamer_delegate')?`${text}\n\n${independentReviewMessage}`:text;
    const base={threadId:thread?.id,title:thread?.data.title??`${writingMode?writingModes[writingMode].label:'修改'}：${title}`.slice(0,160),goal:text.slice(0,20000),text:message,bindings};
    submission=writingMode?prepareWritingSubmission({...base,mode:writingMode,sourceText:text,targetRefs:bindings.map(binding=>binding.ref).filter(ref=>['chapter','scene','knowledge','resource'].includes(ref.kind)),owner:inputOwner}):prepareSubmission({...base,skill});setPending(submission);
   }
   const target='kind' in submission?await submitWriting(ctx,submission,request):await submitAgent(ctx,submission,setPending);ctx.open('agent',target.title,target.id);setPending(null);setOpen(false);setText('');
  }catch(e:any){setError(e.message);if(['VALIDATION','NOT_FOUND'].includes(e.code))setPending(null);}finally{locked.current=false;setBusy(false);}
 }
 async function takeover(){try{const id=pending?.threadId??(threadId==='new'?undefined:threadId);if(!id)return;const t=await api.object(ctx.projectId,'thread',id);await ctx.command('thread.claim',{id,expectedSeq:t.seq,owner:pending?.owner??inputOwner,takeover:true});setError('');ctx.notify('本窗口已接管输入，请继续发送');}catch(e:any){setError(e.message);}}
 return <><button type="button" disabled={disabled} onClick={()=>{setText(pending?.text??initialText);setError('');setOpen(true);}}>{buttonLabel}</button>{open&&<div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-label="发送上下文给 Agent" onSubmit={send}>
  <h2>{writingMode?writingModes[writingMode].label:'发送上下文'}</h2><p>目标对象：{title}。发送前保存草稿并固定选区与版本。</p>
  <label>目标会话<select disabled={busy||!!pending} aria-label="目标 Agent 会话" value={pending?.threadId??threadId} onChange={e=>setThreadId(e.target.value)}><option value="new">{writingMode?'创建新的写作会话':'创建新的修订会话'}</option>{ctx.state.threads.filter((t:any)=>!t.data.delegation).map((t:any)=><option key={t.id} value={t.id}>{t.data.title}</option>)}</select></label>
  <textarea disabled={busy||!!pending} aria-label="选区修改要求" value={pending?.text??text} onChange={e=>setText(e.target.value)} rows={4} placeholder={writingMode?writingModes[writingMode].hint:'说明希望如何修改…'}/>
  {pending&&!busy&&<p className="muted">上次发送尚未确认，继续操作会核对同一个请求。</p>}{error&&<p className="error-text" role="alert">{error}</p>}
  <div className="actions"><button type="button" disabled={busy} onClick={()=>setOpen(false)}>取消</button>{(pending?.threadId||threadId!=='new')&&<button type="button" disabled={busy} onClick={takeover}>接管此会话输入</button>}<button className="primary" disabled={busy||!pending&&!text.trim()}>{busy?'正在发送…':pending?'核对上次发送':'固定上下文并发送'}</button></div>
 </form></div>}</>;
}
