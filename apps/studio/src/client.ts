import type {CloudVideoPublicSettings,CloudVideoSettingsInput,CloudVideoId} from '../../../packages/contracts/cloud-video.ts';
import type { Command, CommandResult } from '../../../packages/contracts/foundation.ts';
import type {NovelExportRequest,NovelExportResult} from '../../../packages/contracts/novel-export.ts';
export class ApiError extends Error {constructor(readonly code:string,message:string,readonly details?:unknown){super(message);}}
let csrf='';
const ownerKey=`dreamer:input-owner:${new URLSearchParams(location.search).get('window')??'main'}`;
export const inputOwner=sessionStorage.getItem(ownerKey)??crypto.randomUUID();
sessionStorage.setItem(ownerKey,inputOwner);
export async function request<T>(path:string,init:RequestInit={}):Promise<T>{const r=await fetch(path,{...init,headers:{'Content-Type':'application/json','X-Dreamer-CSRF':csrf,...init.headers}});const body=await r.json();if(!r.ok)throw new ApiError(body.error?.code??'NETWORK',body.error?.message??'连接失败',body.error?.details);return body;}
export const api={
 exportNovel:(input:NovelExportRequest)=>request<NovelExportResult>('/api/novel-export',{method:'POST',body:JSON.stringify(input)}),
 scriptInfo:(projectId:string,id:string,view:'validate'|'read'|'releases'|'impact'|'media',mode:'draft'|'playback'|'simulation'='draft')=>request<any>(`/api/script/${view}?${new URLSearchParams({projectId,id,...(view==='validate'?{mode}:{})})}`),
 videoSettings:()=>request<CloudVideoPublicSettings[]>('/api/video-settings'),
 saveVideoSettings:async(value:CloudVideoSettingsInput)=>{const saved=await request<CloudVideoPublicSettings>('/api/video-settings',{method:'POST',body:JSON.stringify(value)});const channel=new BroadcastChannel('dreamer-settings');channel.postMessage('video-providers-changed');channel.close();return saved;},
 checkVideoSettings:(id:CloudVideoId)=>request<{status:string;message:string}>('/api/video-settings/check',{method:'POST',body:JSON.stringify({id})}),
 async connect(){const session=await request<{csrf:string;offline?:boolean}>('/api/session');csrf=session.csrf;return session;},
 projects:()=>request<any[]>('/api/projects'),
 state:(projectId:string)=>request<any>(`/api/state?projectId=${encodeURIComponent(projectId)}&view=studio`),
 object:(projectId:string,kind:string,id:string)=>request<any>(`/api/object?${new URLSearchParams({projectId,kind,id})}`),
 search:(projectId:string,params:Record<string,any>)=>request<any>(`/api/search?${new URLSearchParams({projectId,...Object.fromEntries(Object.entries(params).filter(([,v])=>v!==undefined))})}`),
 events:(projectId:string,after:number)=>request<any[]>(`/api/events?projectId=${encodeURIComponent(projectId)}&after=${after}`),
 command:async(projectId:string,operation:string,payload:unknown,requestId:string=crypto.randomUUID()):Promise<CommandResult>=>{
  const c:Command={requestId,projectId,operation,payload};const key=`dreamer:pending:${requestId}`;localStorage.setItem(key,JSON.stringify(c));
  try{const r=await request<CommandResult>('/api/commands',{method:'POST',body:JSON.stringify(c)});localStorage.removeItem(key);return r;}catch(e){if(e instanceof ApiError&&e.code!=='INTERNAL')localStorage.removeItem(key);throw e;}
 },
 pending:()=>Object.keys(localStorage).filter(k=>k.startsWith('dreamer:pending:')).flatMap(k=>{try{return [JSON.parse(localStorage.getItem(k)!) as Command];}catch{return [];}}),
 receipt:async(command:Command)=>{const result=await request<{found:boolean;receipt?:CommandResult}>('/api/receipt',{method:'POST',body:JSON.stringify(command)});if(result.found)localStorage.removeItem(`dreamer:pending:${command.requestId}`);return result;},
 import:async(projectId:string,file:File)=>{const r=await fetch(`/api/import?projectId=${projectId}&title=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'X-Dreamer-CSRF':csrf,'Content-Type':'application/octet-stream'},body:file});const body=await r.json();if(!r.ok)throw new ApiError(body.error?.code,body.error?.message??'导入失败');return body;},
 backup:()=>request<any>('/api/backup',{method:'POST',body:'{}'}),
 maintenance:(apply=false)=>request<any>(`/api/maintenance/${apply?'cleanup':'preview'}`,apply?{method:'POST',body:'{}'}:{}),
};
