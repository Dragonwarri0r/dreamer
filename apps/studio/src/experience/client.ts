import {ApiError,request} from '../client.ts';
import {clearConfirmedInputDraft} from './input-draft.ts';
import type {RuntimeView,RuntimeResponse,RuntimeCommand,PositionSave,RuntimeTracePage} from '../../../../packages/contracts/experience.ts';
export type ExperienceResult={receipt:RuntimeResponse;view:RuntimeView};
export type Pending={projectId:string;uid:string;path:string;body:any};
const prefix=(projectId:string,uid:string)=>`dreamer:experience:pending:${encodeURIComponent(projectId)}:${encodeURIComponent(uid)}:`;
const query=(projectId:string,uid:string,more:Record<string,string|number>={})=>new URLSearchParams({projectId,uid,...Object.fromEntries(Object.entries(more).map(([k,v])=>[k,String(v)]))});
async function post<T>(projectId:string,uid:string,path:string,body:any,persist=true):Promise<T>{body={...body,projectId};const key=prefix(projectId,uid)+body.requestId;if(persist)sessionStorage.setItem(key,JSON.stringify({projectId,uid,path,body}));try{const result=await request<T>(`/api/experience/${path}?${query(projectId,uid)}`,{method:'POST',headers:{'X-Dreamer-Uid':uid},body:JSON.stringify(body)});if(persist)sessionStorage.removeItem(key);if(path==='commands')clearConfirmedInputDraft(projectId,uid,body);return result;}catch(e){if(e instanceof ApiError&&e.code!=='INTERNAL'&&persist)sessionStorage.removeItem(key);throw e;}}
async function trace(projectId:string,uid:string,runId:string){
 const visits:RuntimeTracePage['visits']=[],seen=new Set<string>();let cursor:string|undefined;
 do{const page=await request<RuntimeTracePage>(`/api/experience/trace?${query(projectId,uid,{runId,...(cursor?{cursor}:{}),limit:100})}`);visits.push(...page.visits);cursor=page.contentPage.nextCursor??undefined;
  if(cursor){if(seen.has(cursor))throw new Error('体验轨迹分页未前进，请重新读取');seen.add(cursor);}
 }while(cursor);
 return {visits,complete:true};
}
export const experienceClient={
 catalog:(projectId:string,uid:string,cursor?:string)=>request<import('../../../../packages/contracts/experience-catalog.ts').ExperienceCatalog>(`/api/experience/catalog?${query(projectId,uid,{...(cursor?{cursor}:{})})}`),
 start:(projectId:string,uid:string,releaseId:string,mode:'simulation'|'playback')=>post<ExperienceResult>(projectId,uid,'start',{protocolVersion:1,requestId:crypto.randomUUID(),projectId,releaseId,mode}),
 run:(projectId:string,uid:string,runId:string)=>request<RuntimeView>(`/api/experience/run?${query(projectId,uid,{runId})}`),
 runs:(projectId:string,uid:string)=>request<any>(`/api/experience/runs?${query(projectId,uid)}`),
 instance:(projectId:string,uid:string,runId:string,instanceId:string)=>request<any>(`/api/experience/instance?${query(projectId,uid,{runId,instanceId})}`),
 trace,
 history:(projectId:string,uid:string,runId:string)=>request<import('../../../../packages/contracts/experience-export.ts').ExperiencedHistory>(`/api/experience/history?${query(projectId,uid,{runId})}`),
 exports:(projectId:string,uid:string,runId:string)=>request<{exports:import('../../../../packages/contracts/experience-export.ts').ExperienceExport[]}>(`/api/experience/exports?${query(projectId,uid,{runId})}`),
 createExport:(projectId:string,uid:string,runId:string,requestId:string=crypto.randomUUID())=>post<{export:import('../../../../packages/contracts/experience-export.ts').ExperienceExport}>(projectId,uid,'export-video',{protocolVersion:1,requestId,runId},false),
 retryExport:(projectId:string,uid:string,runId:string,exportId:string)=>post<any>(projectId,uid,'export-retry',{protocolVersion:1,requestId:crypto.randomUUID(),runId,exportId},false),
 exportVideoUrl:(projectId:string,uid:string,runId:string,exportId:string)=>`/api/experience/export-video?${query(projectId,uid,{runId,exportId})}`,
 exportManifestUrl:(projectId:string,uid:string,runId:string,exportId:string)=>`/api/experience/export-manifest?${query(projectId,uid,{runId,exportId})}`,
 events:(projectId:string,uid:string,runId:string,after=0)=>request<any>(`/api/experience/events?${query(projectId,uid,{runId,after})}`),
 command:(projectId:string,uid:string,body:RuntimeCommand)=>post<ExperienceResult>(projectId,uid,'commands',body),
 position:(projectId:string,uid:string,body:PositionSave)=>post<any>(projectId,uid,'position',body,false),
 pending:(projectId:string,uid:string):Pending[]=>Object.keys(sessionStorage).filter(k=>k.startsWith(prefix(projectId,uid))).flatMap(k=>{try{return [JSON.parse(sessionStorage.getItem(k)!)];}catch{return [];}}),
 receipt:async(p:Pending)=>{const result=await post<any>(p.projectId,p.uid,'receipt',p.body,false);if(result.found){sessionStorage.removeItem(prefix(p.projectId,p.uid)+p.body.requestId);if(p.path==='commands')clearConfirmedInputDraft(p.projectId,p.uid,p.body);}return result;},
 resend:(p:Pending)=>post<ExperienceResult>(p.projectId,p.uid,p.path,p.body),
 media:(projectId:string,uid:string,runId:string,planHash:string,bindingId:string)=>`/api/experience/media?${query(projectId,uid,{runId,planHash,bindingId})}`,
 exportUrl:(projectId:string,uid:string,runId:string)=>`/api/experience/export?${query(projectId,uid,{runId})}`,
};
