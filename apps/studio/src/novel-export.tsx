import React,{useRef,useState,useSyncExternalStore} from 'react';
import {Download,Copy} from 'lucide-react';
import type {EditorProps} from './editors.tsx';
import type {NovelExportRequest,NovelExportResult} from '../../../packages/contracts/novel-export.ts';
import {api,ApiError} from './client.ts';
import {documents} from './workbench.ts';
import {useViewState} from './view-state.ts';
import './novel-export.css';

function dirtyChapters(projectId:string,chapters:any[]){
  const ids=new Set(chapters.filter(c=>documents.get(`${projectId}:chapter:${c.id}:current`)?.dirty).map(c=>c.id));
  for(const key of Object.keys(localStorage))if(key.startsWith('dreamer:draft:')&&key.includes(`:${projectId}:chapter:`)){
    try{if(JSON.parse(localStorage.getItem(key)??'null')?.dirty){const id=key.split(`:${projectId}:chapter:`)[1].split(':')[0];ids.add(id);}}catch{/* Ignore an invalid recovered draft. */}
  }
  return [...ids].sort().join(',');
}
const subscribe=(fn:()=>void)=>{const stop=documents.subscribe(fn);window.addEventListener('storage',fn);return()=>{stop();window.removeEventListener('storage',fn);};};

export function NovelExport({ctx}:{ctx:EditorProps['ctx']}){
  const [mode,setMode]=useViewState(`${ctx.projectId}:novel-export:mode`,'whole');
  const [tenThousands,setTenThousands]=useViewState(`${ctx.projectId}:novel-export:limit`,'10');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [pending,setPending]=useViewState<NovelExportRequest|null>(`${ctx.projectId}:novel-export:pending`,null);
  const [result,setResult]=useViewState<NovelExportResult|null>(`${ctx.projectId}:novel-export:result`,null);
  const locked=useRef(false),pathField=useRef<HTMLInputElement>(null);
  const dirty=useSyncExternalStore(subscribe,()=>dirtyChapters(ctx.projectId,ctx.state.chapters??[]));
  const maxCharacters=mode==='whole'?0:mode==='100k'?100000:Number(tenThousands)*10000;
  const valid=Number.isSafeInteger(maxCharacters)&&maxCharacters>=0&&maxCharacters<=10000000&&(mode!=='custom'||maxCharacters>=10000);
  async function exportNovel(){
    if(locked.current)return;locked.current=true;setBusy(true);setError('');
    const input=pending??{projectId:ctx.projectId,requestId:crypto.randomUUID(),maxCharacters};
    setPending(input);
    try{const saved=await api.exportNovel(input);setResult(saved);setPending(null);ctx.notify(`已导出 ${saved.chapterCount} 章，${saved.files.length} 个文件`);}
    catch(e){setError(e instanceof Error?e.message:'导出失败');if(e instanceof ApiError&&e.code!=='INTERNAL')setPending(null);}
    finally{locked.current=false;setBusy(false);}
  }
  return <section className="novel-export" aria-label="小说离线导出">
    <div className="novel-export-controls">
      <strong>离线审阅</strong>
      <label><select aria-label="小说分文件方式" value={mode} disabled={busy||!!pending} onChange={e=>setMode(e.target.value)}><option value="whole">全文一个 TXT</option><option value="100k">每 10 万字分文件</option><option value="custom">自定义分文件字数</option></select></label>
      {mode==='custom'&&<label className="novel-export-limit"><input aria-label="每个文件万字数" type="number" min="1" max="1000" step="1" value={tenThousands} disabled={busy||!!pending} onChange={e=>setTenThousands(e.target.value)}/>万字 / 文件</label>}
      <button onClick={exportNovel} disabled={busy||(!pending&&!valid)}><Download size={16}/>{busy?'正在导出…':pending?'重试导出':'导出小说'}</button>
    </div>
    <p className="muted">导出全工程已保存正文，按章节序号排列，不受当前筛选影响。分文件保留完整章节，单章超长则单独成文件。字数含标点，不计空白。</p>
    {dirty&&<p className="inline-warning" role="status">有未保存的章节修改，本次仅导出已保存版本。<button onClick={()=>{const id=dirty.split(',')[0],c=ctx.state.chapters.find((c:any)=>c.id===id);if(c)ctx.open('chapter',c.data.title,id);}}>查看未保存章节</button></p>}
    {error&&<p role="alert">{error}{pending?'；可重试同一次导出，不会重复创建文件。':''}</p>}
    {pending&&!busy&&!error&&<p role="status">上次导出尚未确认，点击“重试导出”取回结果。</p>}
    {result&&<details className="novel-export-result" open>
      <summary>上次导出：{result.chapterCount} 章 · {result.totalCharacters.toLocaleString()} 字 · {result.files.length} 个文件 · {new Date(result.createdAt).toLocaleString()}</summary>
      <div className="novel-export-path"><input ref={pathField} aria-label="小说导出目录" readOnly value={result.directory} onFocus={e=>e.currentTarget.select()}/><button onClick={async()=>{try{await navigator.clipboard.writeText(result.directory);ctx.notify('导出目录已复制');}catch{pathField.current?.focus();pathField.current?.select();ctx.notify('请复制已选中的目录');}}}><Copy size={15}/>复制目录</button></div>
      <ul>{result.files.map(f=><li key={f.name}><a href={f.downloadUrl} download={f.name}>{f.name}</a><small>第 {f.firstNumber}–{f.lastNumber} 章 · {f.characters.toLocaleString()} 字{f.oversized?' · 单章超过分文件字数':''}</small></li>)}</ul>
      {result.skippedEmptyCount>0&&<p className="muted">已跳过 {result.skippedEmptyCount} 个没有正文的章节。</p>}
    </details>}
  </section>;
}
