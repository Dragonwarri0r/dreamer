import type {CommandResult,Ref} from '../../../packages/contracts/foundation.ts';
import type {WritingMode,WritingSelection} from './writing-flow.ts';

export type WritingSubmission={kind:'writing';requestId:string;threadId?:string;title:string;goal:string;text:string;sourceText?:string;mode:WritingMode;bindings:any[];targetRefs:Ref[];selection?:WritingSelection;owner:string};
type Requester=<T>(path:string,init?:RequestInit)=>Promise<T>;
export function prepareWritingSubmission(input:Omit<WritingSubmission,'kind'|'requestId'>):WritingSubmission{return {...input,kind:'writing',requestId:crypto.randomUUID()};}
export function writingRequest(projectId:string,submission:WritingSubmission){
 const {requestId,threadId,title,goal,text,mode,bindings,targetRefs,selection,owner}=submission;
 return {requestId,projectId,operation:threadId?'writing.continue':'writing.start',payload:{...(threadId?{threadId}:{title,goal}),message:text,mode,bindings,targetRefs,owner,...(selection?{selection}:{})}};
}
/** Keep the original start/continue payload intact until its receipt is known. */
export async function submitWriting(ctx:{projectId:string;refresh:()=>Promise<void>},submission:WritingSubmission,request:Requester){
 const command=writingRequest(ctx.projectId,submission);
 const prior=await request<{found:boolean;receipt?:CommandResult}>('/api/writing/receipt',{method:'POST',body:JSON.stringify(command)});
 const result=prior.found?prior.receipt:await request<CommandResult>(`/api/writing/${submission.threadId?'continue':'start'}`,{method:'POST',body:JSON.stringify({requestId:command.requestId,projectId:ctx.projectId,...command.payload})});
 if(!result)throw new Error('发送回执缺少结果，请核对上次发送');
 const target=result.result as {threadId:string};
 if(!target?.threadId)throw new Error('发送回执缺少会话，请核对上次发送');
 await ctx.refresh();
 return {id:target.threadId,title:submission.title};
}
