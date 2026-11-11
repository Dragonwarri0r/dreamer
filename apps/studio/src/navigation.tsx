import React from 'react';
import {Bot,FolderKanban,BookOpen,Clapperboard,Film,Library,Image,ClipboardList,GitCompare,ChevronRight,Plus,Archive,X} from 'lucide-react';
import type {StudioContext} from './editors.tsx';
import {useViewState} from './view-state.ts';

export function Navigation({ctx,projects,projectId,onProject,onCreate,active,onPreview,onClose}:{ctx:StudioContext;projects:any[];projectId:string;onProject:(id:string)=>void;onCreate:()=>void;onClose?:()=>void;active?:string;onPreview:(type:string,title:string,id:string)=>void}){
 const [expanded,setExpanded]=useViewState<Record<string,boolean>>(`${projectId}:navigation`,{});
 const toggle=(key:string)=>setExpanded(v=>({...v,[key]:!v[key]}));
 const item=(type:string,title:string,Icon:any,count?:number)=><button key={type} className={active===type?'nav-active':''} aria-current={active===type?'page':undefined} disabled={!projectId} onClick={()=>ctx.open(type,title)}><Icon size={17}/><span>{title}</span>{count!==undefined&&count>0&&<small>{count}</small>}</button>;
 const sections=[
  {id:'making',title:'内容与制作',Icon:Clapperboard,items:[['chapters','章节书架',BookOpen],['episodes','短片制作单',Clapperboard],['story','故事与剧本',BookOpen],['scripts','互动剧本',GitCompare],['board','分镜工作台',Clapperboard],['timeline','时间线与预演',Film]]},
  {id:'assets',title:'资源与资料',Icon:Library,items:[['resources','设定与资源',Library],['production','生成与素材',Image],['knowledge-list','资料与知识',Archive]]},
  {id:'activity',title:'任务与审阅',Icon:ClipboardList,items:[['work-center','工作中心',ClipboardList],['review','变更与审阅',GitCompare]]}
 ];
 const state=ctx.state;const jobs=state?.jobs?.filter((j:any)=>['running','queued','unknown','collecting'].includes(j.data.state)).length??0;
 return <aside id="project-navigation" className="sidebar"><div className="sidebar-title"><span>当前工程</span>{onClose&&<button className="icon" aria-label="关闭导航" onClick={onClose}><X size={16}/></button>}<button className="icon" aria-label="新建项目" title="新建项目" onClick={onCreate}><Plus size={16}/></button></div>
 <select aria-label="当前项目" value={projectId} onChange={e=>onProject(e.target.value)}>{!projects.length&&<option value="">还没有项目</option>}{projects.map(p=><option key={p.id} value={p.id}>{p.data.title}</option>)}</select>
 <nav aria-label="工程导航">{item('agent','Agent 创作',Bot,state?.threads?.filter((t:any)=>t.data.state==='running').length)}{item('overview','项目工程',FolderKanban)}{item('experience','互动播放',Film)}
 <div className="nav-divider"/>{sections.map(s=><div className="nav-section" key={s.id}><button className="nav-section-toggle" aria-expanded={!!expanded[s.id]} onClick={()=>toggle(s.id)}><s.Icon size={16}/><span>{s.title}</span>{s.id==='activity'&&jobs>0&&<small>{jobs}</small>}<ChevronRight className={expanded[s.id]?'rotated':''} size={14}/></button>{expanded[s.id]&&<div className="nav-children">{s.items.map(([type,title,Icon])=>item(type as string,title as string,Icon))}</div>}</div>)}</nav>
 <div className="sidebar-section">工程内容</div>{[['scripts','互动剧本','script'],['chapters','章节','chapter'],['episodes','短片','episode'],['scenes','场景','scene'],['resources','设定','resource'],['shots','镜头','shot'],['cuts','剪辑','cut'],['builds','成片','viewer']].map(([key,title,type])=>state?.[key]?.length?<div className="object-section" key={key}><button className="tree-heading" aria-expanded={!!expanded[key]} onClick={()=>toggle(key)}><ChevronRight size={12} className={expanded[key]?'rotated':''}/>{title}<small>{state[key].length}</small></button>{expanded[key]&&state[key].slice(0,20).map((o:any)=><button key={o.id} title={o.data.title} onClick={()=>onPreview(type,o.data.title,o.id)} onDoubleClick={()=>ctx.open(type,o.data.title,o.id)}>{o.data.title}</button>)}{expanded[key]&&state[key].length>20&&<button onClick={()=>ctx.open(({scripts:'scripts',chapters:'chapters',episodes:'episodes',scenes:'story',shots:'board',resources:'resources',cuts:'timeline',builds:'timeline'} as any)[key],`全部${title}`)}>查看全部 {state[key].length} 项</button>}</div>:null)}
 <div className="sidebar-footer"><span>{jobs?`${jobs} 个任务执行或待核对`:'工程已连接本地服务'}</span><small>内容、版本与工作统一保存在此工程</small></div></aside>;
}
