export type Tool={type:'function';name:string;description:string;inputSchema:unknown};
export interface AgentSession {
 start(providerId:string|undefined,tools:Tool[],instructions:string):Promise<string>;
 turn(providerId:string,text:string,onEvent:(event:{type:'delta'|'complete'|'error';text?:string;turnId?:string})=>void,onTool:(name:string,args:unknown,callId:string)=>Promise<unknown>):Promise<string>;
 interrupt(providerId:string,turnId:string):Promise<void>;
 close():void;
}
export type AgentFactory=()=>AgentSession;
