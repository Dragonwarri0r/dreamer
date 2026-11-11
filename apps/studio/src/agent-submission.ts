import {api,inputOwner} from './client.ts';
import type {StudioContext} from './editors.tsx';

export type AgentSubmission={threadId?:string;title:string;goal:string;text:string;skill:string;bindings:any[];owner:string;createRequestId:string;sendRequestId:string};
const submissions=new Set<string>();
export function lockSubmission(scope:string){if(submissions.has(scope))return false;submissions.add(scope);return true;}
export function unlockSubmission(scope:string){submissions.delete(scope);}
export function prepareSubmission(input:Omit<AgentSubmission,'owner'|'createRequestId'|'sendRequestId'>):AgentSubmission{
 return {...input,owner:inputOwner,createRequestId:crypto.randomUUID(),sendRequestId:crypto.randomUUID()};
}
/** A lost HTTP response must resume the same request, even after the page reloads. */
export async function submitAgent(ctx:StudioContext,input:AgentSubmission,progress:(next:AgentSubmission)=>void){
 let submission=input;
 if(!submission.threadId){
  const result=await api.command(ctx.projectId,'thread.create',{title:submission.title,goal:submission.goal},submission.createRequestId);
  submission={...submission,threadId:(result.result as any).id};progress(submission);
 }
 const payload={id:submission.threadId!,owner:submission.owner,text:submission.text,skill:submission.skill,bindings:submission.bindings};
 const previous=await api.receipt({projectId:ctx.projectId,requestId:submission.sendRequestId,operation:'thread.send',payload});
 if(!previous.found){
  const current=await api.object(ctx.projectId,'thread',submission.threadId!);
  await api.command(ctx.projectId,'thread.claim',{id:current.id,expectedSeq:current.seq,owner:submission.owner});
  await api.command(ctx.projectId,'thread.send',payload,submission.sendRequestId);
 }
 await ctx.refresh();
 return {id:submission.threadId!,title:submission.title};
}
