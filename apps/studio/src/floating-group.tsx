import React,{useEffect,useState} from 'react';
import {Grip,Maximize2,Minimize2,PanelTopClose} from 'lucide-react';
import {visibleBounds,type Layout} from './workbench.ts';
type Group=Layout['groups'][number];
export function FloatingGroup({group,active,activate,update,dock,children,onDrop,compactVisible=true}:{group:Group;compactVisible?:boolean;active:boolean;activate:()=>void;update:(patch:Partial<Group>)=>void;dock:()=>void;children:React.ReactNode;onDrop:(id:string)=>void}){
 const [viewport,setViewport]=useState({width:1000,height:700}),[maximized,setMaximized]=useState(false);
 useEffect(()=>{const element=document.querySelector('.editor-groups');if(!element)return;const observer=new ResizeObserver(([e])=>setViewport({width:e.contentRect.width,height:e.contentRect.height}));observer.observe(element);return()=>observer.disconnect();},[]);
 const bounds=visibleBounds(group,viewport);
 function gesture(e:React.PointerEvent,mode:'move'|'resize'){
  e.preventDefault();e.stopPropagation();activate();const start={x:e.clientX,y:e.clientY};e.currentTarget.setPointerCapture(e.pointerId);
  const move=(event:PointerEvent)=>{
   const dx=event.clientX-start.x,dy=event.clientY-start.y;
   const next=visibleBounds(mode==='move'?{position:{x:bounds.x+dx,y:bounds.y+dy},size:group.size}:{position:group.position,size:{width:bounds.width+dx,height:bounds.height+dy}},viewport);
   update({position:{x:next.x,y:next.y},size:{width:next.width,height:next.height}});
  };
  const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
 }
 const style=group.floating?{left:maximized?0:bounds.x,top:maximized?0:bounds.y,width:maximized?viewport.width:bounds.width,height:maximized?viewport.height:bounds.height,zIndex:active?22:20,right:'auto'}:undefined;
 return <section className={`editor-group ${group.floating?'floating':''} ${active?'active-group':''} ${compactVisible?'compact-visible':''}`} style={style} onPointerDown={activate} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();onDrop(e.dataTransfer.getData('dreamer-tab'));}}>
 {group.floating&&<div className="floating-title"><button className="float-handle" aria-label="移动浮动面板" title="拖动浮动面板；方向键微调" onPointerDown={e=>gesture(e,'move')} onKeyDown={e=>{const d=10;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const b=visibleBounds({position:{x:bounds.x+(e.key==='ArrowRight'?d:e.key==='ArrowLeft'?-d:0),y:bounds.y+(e.key==='ArrowDown'?d:e.key==='ArrowUp'?-d:0)},size:group.size},viewport);update({position:{x:b.x,y:b.y}} );}}}><Grip size={16}/><span>{group.tabs.find(t=>t.instanceId===group.active)?.title??'浮动工作区'}</span></button><button className="icon" aria-label={maximized?'还原浮动尺寸':'最大化浮动面板'} title={maximized?'还原浮动尺寸':'最大化浮动面板'} onClick={()=>setMaximized(v=>!v)}>{maximized?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button><button className="icon" aria-label="停靠浮动面板" title="停靠浮动面板" onClick={dock}><PanelTopClose size={15}/></button></div>}
 {children}{group.floating&&!maximized&&<button className="resize-handle" aria-label="调整浮动面板大小" title="拖动调整大小；方向键微调" onPointerDown={e=>gesture(e,'resize')} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const b=visibleBounds({position:group.position,size:{width:bounds.width+(e.key==='ArrowRight'?20:e.key==='ArrowLeft'?-20:0),height:bounds.height+(e.key==='ArrowDown'?20:e.key==='ArrowUp'?-20:0)}},viewport);update({size:{width:b.width,height:b.height}});}}}/>}
 </section>;
}
