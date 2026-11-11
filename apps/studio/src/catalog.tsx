import React,{useEffect,useState} from 'react';
import {api} from './client.ts';
import type {StudioContext} from './editors.tsx';

/** Summary records may never become editable drafts. Fetch a single complete object. */
export function useObject(ctx:StudioContext,kind:string,id?:string){
 const key=({chapter:'chapters',episode:'episodes',scene:'scenes',shot:'shots',thread:'threads',knowledge:'knowledge',script:'scripts'} as any)[kind];
 const summary=ctx.state?.[key]?.find((r:any)=>r.id===id);
 const [loaded,setLoaded]=useState<any>(),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let alive=true;if(!id){setLoaded(undefined);return;}setError('');
  api.object(ctx.projectId,kind,id).then(row=>{if(alive)setLoaded(row);}).catch(e=>{if(alive){setError(e.message);ctx.notify(e.message);}});
  return()=>{alive=false;};
 },[ctx.projectId,kind,id,summary?.seq,attempt]);
 return {row:loaded?.id===id&&loaded?.projectId===ctx.projectId?loaded:undefined,error,reload:()=>setAttempt(n=>n+1)};
}
export function useSearch(ctx:StudioContext,params:Record<string,any>){
 const [result,setResult]=useState<any>({items:[],total:0,nextOffset:null}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const key=JSON.stringify(params),scope=ctx.projectId+':'+key;
 useEffect(()=>{let alive=true;setBusy(true);setError('');const timer=setTimeout(()=>{
  api.search(ctx.projectId,params).then(r=>{if(alive)setResult({...r,queryScope:scope});}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setBusy(false);});
 },140);return()=>{alive=false;clearTimeout(timer);};},[ctx.projectId,key,ctx.state]);
 return {result:result.queryScope===scope?result:{items:[],total:0,nextOffset:null},busy:busy||!error&&result.queryScope!==scope,error};
}
export function Pager({offset,total,size=30,onChange}:{offset:number;total:number;size?:number;onChange:(offset:number)=>void}){
 return <div className="pager"><span>{total?`${offset+1}–${Math.min(offset+size,total)} / ${total}`:'暂无内容'}</span><button type="button" disabled={!offset} onClick={()=>onChange(Math.max(0,offset-size))}>上一页</button><button type="button" disabled={offset+size>=total} onClick={()=>onChange(offset+size)}>下一页</button></div>;
}
export function ObjectPicker({ctx,kind,onPick,placeholder='按章节号、标题或正文查找',chapterId}:{ctx:StudioContext;kind:string;onPick:(row:any)=>void;placeholder?:string;chapterId?:string}){
 const [query,setQuery]=useState(''),[offset,setOffset]=useState(0);
 const {result,busy,error}=useSearch(ctx,{kind,query,chapterId,offset,limit:10});
 return <div className="object-picker"><input aria-label={placeholder} value={query} placeholder={placeholder} onChange={e=>{setQuery(e.target.value);setOffset(0);}}/>{error&&<p role="alert">{error}</p>}<div aria-busy={busy} className="picker-results">{result.items.map((r:any)=><button type="button" key={r.id} onClick={()=>onPick(r)}><span>{r.kind==='chapter'?`第 ${r.data.number} 章 · `:''}{r.data.title}</span><small>{r.data.volume??r.kind}</small></button>)}</div><Pager offset={offset} total={result.total} size={10} onChange={setOffset}/></div>;
}
