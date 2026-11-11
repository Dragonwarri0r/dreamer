/** Unsubmitted text is device-local UI state, never an accepted runtime input. */
export type InputDraftScope={projectId:string;uid:string;runId:string;attemptId:string};
const memory=new Map<string,string>();
export const inputDraftKey=(scope:InputDraftScope)=>`dreamer:experience:draft:${[scope.projectId,scope.uid,scope.runId,scope.attemptId].map(encodeURIComponent).join(':')}`;
export function readInputDraft(scope:InputDraftScope,maxLength=2000):string{
 const key=inputDraftKey(scope);let value=memory.get(key)??'';
 // A failed write is newer than any previous value still present on disk.
 if(!memory.has(key))try{value=localStorage.getItem(key)??'';}catch{/* Keep same-page drafts when browser storage is unavailable. */}
 return value.slice(0,Math.min(2000,maxLength));
}
export function writeInputDraft(scope:InputDraftScope,text:string):boolean{
 const key=inputDraftKey(scope),value=text.slice(0,2000);
 try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key);memory.delete(key);return true;}catch{memory.set(key,value);return false;}
}
export function clearInputDraft(scope:InputDraftScope){
 const key=inputDraftKey(scope);try{localStorage.removeItem(key);memory.delete(key);}catch{memory.set(key,'');}
}
/** Clear the original attempt even if its view has already advanced or unmounted. */
export function clearConfirmedInputDraft(projectId:string,uid:string,command:{operation?:string;runId?:string;payload?:{attemptId?:string}}){
 if(command.operation?.startsWith('activity.')&&command.runId&&command.payload?.attemptId)clearInputDraft({projectId,uid,runId:command.runId,attemptId:command.payload.attemptId});
}
