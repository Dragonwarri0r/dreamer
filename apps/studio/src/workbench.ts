import { z } from 'zod';

export const Tab = z.object({instanceId:z.string(),type:z.string(),objectId:z.string().optional(),title:z.string(),binding:z.string().default('current'),mode:z.enum(['preview','persistent','pinned'])});
export type Tab = z.infer<typeof Tab>;
const Group=z.object({id:z.string(),active:z.string().nullable(),tabs:z.array(Tab),floating:z.boolean().default(false),position:z.object({x:z.number().min(0).max(20000),y:z.number().min(0).max(20000)}).optional(),size:z.object({width:z.number().positive().max(20000),height:z.number().positive().max(20000)}).optional()});
export const Layout=z.object({version:z.literal(1),activeGroup:z.string(),groups:z.array(Group).min(1).max(8)});
export type Layout=z.infer<typeof Layout>;
export const emptyLayout=():Layout=>({version:1,activeGroup:'main',groups:[{id:'main',active:null,tabs:[],floating:false}]});
export function restoreLayout(value:unknown):Layout {
 const parsed=Layout.safeParse(value);if(!parsed.success)return emptyLayout();
 const layout=parsed.data,seen=new Set<string>();
 for(const group of layout.groups){group.tabs=group.tabs.filter(t=>{if(seen.has(t.instanceId))return false;seen.add(t.instanceId);return true;});if(!group.tabs.some(t=>t.instanceId===group.active))group.active=group.tabs[0]?.instanceId??null;}
 if(!layout.groups.some(g=>g.id===layout.activeGroup))layout.activeGroup=layout.groups[0].id;
 return layout;
}
export function openTab(current:Layout, input:Omit<Tab,'instanceId'|'mode'|'binding'> & Partial<Pick<Tab,'mode'|'binding'>>, options:{beside?:boolean;dirty?:(id:string)=>boolean}={}):Layout {
 const layout=structuredClone(current);let group=layout.groups.find(g=>g.id===layout.activeGroup)!;
 if(options.beside){if(layout.groups.length>=8)return current;group={id:crypto.randomUUID(),active:null,tabs:[],floating:false};layout.groups.push(group);layout.activeGroup=group.id;}
 const binding=input.binding??'current',existing=group.tabs.find(t=>t.type===input.type&&t.objectId===input.objectId&&t.binding===binding);
 if(existing){group.active=existing.instanceId;if(input.mode==='persistent'&&existing.mode==='preview')existing.mode='persistent';return layout;}
 const tab:Tab={...input,binding,instanceId:crypto.randomUUID(),mode:input.mode??'preview'};
 if(tab.mode==='preview')group.tabs=group.tabs.filter(t=>t.mode!=='preview'||options.dirty?.(t.instanceId));
 group.tabs.push(tab);group.active=tab.instanceId;return layout;
}
export function closeTab(layout:Layout,id:string,dirty=false):Layout {
 if(dirty)return layout;const next=structuredClone(layout);
 for(const g of next.groups){g.tabs=g.tabs.filter(t=>t.instanceId!==id);if(g.active===id)g.active=g.tabs.at(-1)?.instanceId??null;}
 next.groups=next.groups.filter(g=>g.tabs.length||g.id==='main');if(!next.groups.some(g=>g.id===next.activeGroup))next.activeGroup=next.groups[0]?.id??'main';return next;
}
export function moveTab(layout:Layout,id:string,target:string):Layout {
 const next=structuredClone(layout),to=next.groups.find(g=>g.id===target);if(!to)return layout;
 const from=next.groups.find(g=>g.tabs.some(t=>t.instanceId===id));if(!from||from===to)return layout;
 const tab=from.tabs.find(t=>t.instanceId===id)!;from.tabs=from.tabs.filter(t=>t.instanceId!==id);from.active=from.tabs[0]?.instanceId??null;
 if(tab.mode==='preview')tab.mode='persistent';to.tabs.push(tab);to.active=id;next.activeGroup=target;return next;
}
export function tabMode(layout:Layout,id:string,mode:Tab['mode']):Layout {
 const next=structuredClone(layout);for(const g of next.groups){const t=g.tabs.find(t=>t.instanceId===id);if(t)t.mode=mode;g.tabs.sort((a,b)=>Number(b.mode==='pinned')-Number(a.mode==='pinned'));}return next;
}

export const layoutPresets={idea:['构思','agent','Agent 创作','overview','项目工程'],script:['剧本','story','故事与剧本','agent','Agent 创作'],board:['分镜','board','分镜工作台','agent','Agent 创作'],review:['审片','timeline','时间线与预演','review','变更与审阅']} as const;
export function applyPreset(layout:Layout,name:keyof typeof layoutPresets):Layout {
 const [,left,leftTitle,right,rightTitle]=layoutPresets[name],tabs=layout.groups.flatMap(g=>g.tabs).map(t=>({...t,mode:t.mode==='preview'?'persistent' as const:t.mode}));
 const ensureTab=(type:string,title:string)=>tabs.find(t=>t.type===type)??{instanceId:crypto.randomUUID(),type,title,binding:'current',mode:'persistent' as const};
 const a=ensureTab(left,leftTitle),b=ensureTab(right,rightTitle),second=tabs.filter(t=>t.type===right),first=tabs.filter(t=>t.type!==right);
 if(!first.some(t=>t.instanceId===a.instanceId))first.push(a);if(!second.some(t=>t.instanceId===b.instanceId))second.push(b);
 return {version:1,activeGroup:'main',groups:[{id:'main',active:a.instanceId,tabs:first,floating:false},{id:'secondary',active:b.instanceId,tabs:second,floating:false}]};
}

export function visibleBounds(group:{position?:{x:number;y:number};size?:{width:number;height:number}},viewport:{width:number;height:number}){
 const width=Math.min(Math.max(360,group.size?.width??640),Math.max(1,viewport.width));
 const height=Math.min(Math.max(260,group.size?.height??520),Math.max(1,viewport.height));
 return {x:Math.max(0,Math.min(group.position?.x??32,viewport.width-width)),y:Math.max(0,Math.min(group.position?.y??40,viewport.height-height)),width,height};
}
export function floatGroup(layout:Layout,id:string,viewport:{width:number;height:number}):Layout{
 return {...layout,activeGroup:id,groups:layout.groups.map(g=>{if(g.id!==id)return g;const b=visibleBounds(g,viewport);return {...g,floating:!g.floating,position:{x:b.x,y:b.y},size:{width:b.width,height:b.height}};})};
}

export type DocumentState<T=unknown>={value:T;baseSeq:number;dirty:boolean;status:'saved'|'editing'|'saving'|'failed'|'conflict';error?:string};
export class Documents {
 private data=new Map<string,DocumentState>();private listeners=new Set<()=>void>();
 private undoStack=new Map<string,unknown[]>();private redoStack=new Map<string,unknown[]>();
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>this.listeners.delete(fn);};
 get<T>(key:string){return this.data.get(key) as DocumentState<T>|undefined;}
 hasDirty(){return [...this.data.values()].some(v=>v.dirty);}
 load<T>(key:string,value:T,seq:number){const old=this.get<T>(key);if(old?.dirty)return old;const next={value,baseSeq:seq,dirty:false,status:'saved' as const};this.data.set(key,next);this.emit();return next;}
 edit<T>(key:string,value:T){const old=this.get(key);if(!old)throw new Error('尚未载入文档');this.undoStack.set(key,[...(this.undoStack.get(key)??[]),old.value].slice(-100));this.redoStack.set(key,[]);this.data.set(key,{...old,value,dirty:true,status:'editing'});this.emit();}
 canUndo(key:string){return Boolean(this.undoStack.get(key)?.length);}
 canRedo(key:string){return Boolean(this.redoStack.get(key)?.length);}
 undo(key:string){this.travel(key,this.undoStack,this.redoStack);}
 redo(key:string){this.travel(key,this.redoStack,this.undoStack);}
 private travel(key:string,from:Map<string,unknown[]>,to:Map<string,unknown[]>){const old=this.get(key),stack=from.get(key);if(!old||!stack?.length)return;const value=stack.pop();to.set(key,[...(to.get(key)??[]),old.value]);this.data.set(key,{...old,value,dirty:true,status:'editing',error:undefined});this.emit();}
 saving(key:string){this.patch(key,{status:'saving'});}
 saved<T>(key:string,value:T,seq:number){this.data.set(key,{value,baseSeq:seq,dirty:false,status:'saved'});this.emit();}
 savedSnapshot<T>(key:string,sent:T,value:T,seq:number){const current=this.get<T>(key);if(current?.dirty&&current.value!==sent){this.data.set(key,{...current,baseSeq:seq,status:'editing',error:undefined});this.emit();}else this.saved(key,value,seq);}
 failed(key:string,message:string,conflict=false){this.patch(key,{status:conflict?'conflict':'failed',error:message,dirty:true});}
 recover(key:string,value:DocumentState){this.data.set(key,{...value,status:'editing',dirty:true});this.emit();}
 private patch(key:string,patch:Partial<DocumentState>){const old=this.data.get(key);if(old){this.data.set(key,{...old,...patch});this.emit();}}
 private emit(){for(const fn of this.listeners)fn();}
}
export const documents=new Documents();
