import {DomainError} from '../../contracts/foundation.ts';

type AgentEvent={type:'delta'|'complete'|'error';text?:string;turnId?:string};
type ToolHandler=(name:string,args:unknown,id:string)=>Promise<unknown>;

/** A provider can deliver the first delta before turn/start acknowledges its ID. */
export class AgentChannel {
 private turnId?:string;
 private ended=false;
 private buffered:{threadId:string;event:AgentEvent}[]=[];
 private resolveReady!:(turnId:string)=>void;
 private rejectReady!:(reason:Error)=>void;
 private ready=new Promise<string>((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
 constructor(private threadId:string,private notify:(event:AgentEvent)=>void,private tool:ToolHandler){
  // close may happen before any tool request has subscribed to the acknowledgement.
  void this.ready.catch(()=>{});
 }
 started(turnId:string){
  if(this.ended)return;
  this.turnId=turnId;this.resolveReady(turnId);
  for(const {threadId,event} of this.buffered)this.event(threadId,event);
  this.buffered=[];
 }
 event(threadId:string,event:AgentEvent){
  if(this.ended||threadId!==this.threadId)return;
  if(!this.turnId){this.buffered.push({threadId,event});return;}
  if(event.turnId!==this.turnId)return;
  if(event.type!=='delta')this.ended=true;
  this.notify(event);
 }
 async call(threadId:string,turnId:string,name:string,args:unknown,callId:string){
  const active=await this.ready;
  if(this.ended||threadId!==this.threadId||turnId!==active)throw new DomainError('FORBIDDEN','工具请求不属于当前有效轮次');
  return this.tool(name,args,callId);
 }
 close(message?:string){
  if(this.ended)return;
  this.ended=true;this.buffered=[];this.rejectReady(new DomainError('UNKNOWN_OUTCOME',message??'本轮已关闭'));
  if(message)this.notify({type:'error',text:message,turnId:this.turnId});
 }
}
