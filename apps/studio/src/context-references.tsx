import React,{useEffect,useState} from 'react';
import {ChevronRight,ExternalLink,Plus,Trash2} from 'lucide-react';
import type {Ref} from '../../../packages/contracts/foundation.ts';
import type {StudioContext} from './editors.tsx';
import {ObjectPicker,Pager} from './catalog.tsx';
import {request} from './client.ts';
import {contextKindLabels,contextRefKey,currentReference} from './context-references.ts';
import './context-references.css';

type Summary={title?:string;error?:string};
export function ContextReferences({ctx,refs,onRemove,onAdd}:{ctx:StudioContext;refs:Ref[];onRemove:(index:number)=>void;onAdd:(row:any)=>Promise<void>}){
 const [open,setOpen]=useState(false),[adding,setAdding]=useState(false),[picker,setPicker]=useState(false),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[attempt,setAttempt]=useState(0);
 const [summaries,setSummaries]=useState<Record<string,Summary>>({});
 const cacheKey=(ref:Ref)=>`${ctx.projectId}:${contextRefKey(ref)}`;
 const currentTitleFor=(ref:Ref)=>currentReference(ctx.state,ref)?.data.title??'';
 const titleFor=(ref:Ref)=>summaries[cacheKey(ref)]?.title||currentTitleFor(ref)||`${contextKindLabels[ref.kind]} ${ref.id.slice(0,8)}`;
 // Search the complete current-title index, never the asynchronously loaded revision titles.
 const filtered=refs.map((ref,index)=>({ref,index})).filter(({ref})=>`${currentTitleFor(ref)} ${contextKindLabels[ref.kind]} v${ref.seq} ${ref.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 const pageOffset=Math.min(offset,Math.max(0,Math.ceil(filtered.length/10)-1)*10),visible=filtered.slice(pageOffset,pageOffset+10),key=visible.map(({ref})=>contextRefKey(ref)).join('|');
 useEffect(()=>{
  if(!open)return;let alive=true;
  const missing=visible.filter(({ref})=>!summaries[cacheKey(ref)]||summaries[cacheKey(ref)].error);
  void Promise.all(missing.map(async({ref})=>{
   try{const row=await request<any>(`/api/revision?${new URLSearchParams({projectId:ctx.projectId,kind:ref.kind,id:ref.id,seq:String(ref.seq)})}`);return [cacheKey(ref),{title:row.data.title??contextKindLabels[ref.kind]}] as const;}
   catch(e){return [cacheKey(ref),{error:(e as Error).message}] as const;}
  })).then(rows=>{if(alive&&rows.length)setSummaries(current=>({...current,...Object.fromEntries(rows)}));});
  return()=>{alive=false;};
 },[ctx.projectId,open,key,attempt]);
 return <details className="context-references" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
  <summary><ChevronRight size={16}/><strong>上下文引用</strong><span>{refs.length} 个固定版本</span></summary>
  {open&&<div className="context-references-body">
   <p className="muted">引用保留选定时的版本，移除后需保存草稿。按当前标题、类型、引用版本或 ID 筛选；旧标题仅用于展示。</p>
   <div className="context-reference-toolbar"><input aria-label="筛选已有上下文引用" placeholder="当前标题、类型、引用版本或 ID" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0);}}/><button type="button" aria-expanded={picker} onClick={()=>setPicker(v=>!v)}><Plus size={15}/>添加引用</button></div>
   {picker&&<fieldset className="context-reference-picker" disabled={adding}><ObjectPicker ctx={ctx} kind="all" placeholder="搜索要加入上下文包的内容" onPick={async row=>{if(adding)return;setAdding(true);try{await onAdd(row);}catch(e){ctx.notify((e as Error).message);}finally{setAdding(false);}}}/>{adding&&<p role="status">正在固定引用版本…</p>}</fieldset>}
   <ul className="context-reference-list" aria-label="已添加的上下文引用">{visible.map(({ref,index})=>{
    const summary=summaries[cacheKey(ref)],title=titleFor(ref),current=currentReference(ctx.state,ref),versionChanged=current&&current.seq!==ref.seq;
    return <li className="context-reference-row" key={`${contextRefKey(ref)}:${index}`} data-reference-key={contextRefKey(ref)}>
     <div className="context-reference-info"><strong>{title}</strong><small>{!summary&&'正在读取引用时标题 · '}{contextKindLabels[ref.kind]} · 引用 v{ref.seq}{versionChanged?` · 当前 v${current.seq}`:''}</small>{summary?.title&&current?.data.title&&summary.title!==current.data.title&&<small>当前标题：{current.data.title}</small>}{summary?.error&&<span className="error-text">固定版本暂不可用：{summary.error}</span>}</div>
     <div className="context-reference-actions">{summary?.error?<button type="button" onClick={()=>setAttempt(v=>v+1)}>重试读取</button>:<button type="button" aria-label={`查看固定引用：${title} v${ref.seq}`} onClick={()=>ctx.open(ref.kind,`${title} · v${ref.seq}`,ref.id,{binding:`revision:${ref.seq}`})}><ExternalLink size={14}/>查看 v{ref.seq}</button>}<button type="button" className="icon" aria-label={`移除引用：${title} v${ref.seq}`} title="只移除此版本引用" onClick={()=>onRemove(index)}><Trash2 size={15}/></button></div>
    </li>;
   })}</ul>
   {!filtered.length&&<p className="muted">{refs.length?'没有匹配的引用。':'尚未添加上下文引用。'}</p>}
   {filtered.length>10&&<Pager offset={pageOffset} total={filtered.length} size={10} onChange={setOffset}/>}
  </div>}
 </details>;
}
