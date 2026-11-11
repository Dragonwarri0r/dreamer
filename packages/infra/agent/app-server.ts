import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync,existsSync,mkdirSync,symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join,delimiter } from 'node:path';
import { homedir } from 'node:os';
import { DomainError } from '../../contracts/foundation.ts';
import type { AgentSession,Tool } from '../../core/agent/port.ts';
import {AgentChannel} from './channel.ts';
import {resolveAgentModelConfig,type AgentModelOptions,type AgentModelConfig} from './model-config.ts';

export class JsonRpc {
 private sequence=0; private buffer=''; private closed=false; private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 onNotification:(method:string,params:any)=>void=()=>{};
 onRequest:(method:string,params:any)=>Promise<unknown>=async()=>{throw new Error('未授权的外部工具');};
 onClose:()=>void=()=>{};
 constructor(private child:ChildProcessWithoutNullStreams){
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>this.receive(chunk));child.stderr.on('data',()=>{});
  child.stdin.on('error',()=>this.fail());
  child.once('error',()=>this.fail());child.once('exit',()=>this.fail());
 }
 receive(chunk:string){if(this.closed)return;this.buffer+=chunk;if(this.buffer.length>8_000_000){this.close();return;}let i;while((i=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);if(!line.trim())continue;let m:any;try{m=JSON.parse(line);}catch{continue;}if(!m||typeof m!=='object')continue;
  if(m.method){if(m.id!==undefined)void this.onRequest(m.method,m.params).then(result=>this.write({id:m.id,result}),()=>this.write({id:m.id,error:{code:-32603,message:'Dreamer 拒绝或无法执行此请求'}}));else this.onNotification(m.method,m.params);}
  else if(m.id!==undefined){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);if(m.error)p.reject(new DomainError('UNSUPPORTED',`Codex 请求失败：${typeof m.error.message==='string'?m.error.message.slice(0,1000):'请检查本机登录及运行版本'}`));else p.resolve(m.result);}}
 }}
 private write(value:unknown){if(!this.closed&&this.child.stdin.writable)this.child.stdin.write(JSON.stringify(value)+'\n');}
 notify(method:string,params:unknown={}){this.write({method,params});}
 request(method:string,params:unknown,timeout=30000):Promise<any>{if(this.closed)return Promise.reject(new DomainError('UNKNOWN_OUTCOME','Codex 连接已关闭，请从会话记录显式继续'));const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new DomainError('UNKNOWN_OUTCOME',`${method} 未确认，请核对后继续`));},timeout);this.pending.set(id,{resolve,reject,timer});this.write({id,method,params});});}
 private fail(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new DomainError('UNKNOWN_OUTCOME','Codex 连接中断，未自动重发'));}this.pending.clear();this.onClose();}
 close(){this.child.kill('SIGTERM');this.fail();}
}
export function findCodex(){return [process.env.DREAMER_CODEX_BIN,...String(process.env.PATH??'').split(delimiter).map(p=>join(p,'codex')),'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'].find(p=>p&&existsSync(p));}
export class AppServerSession implements AgentSession {
 private rpc:JsonRpc;private ready:Promise<any>;private channel?:AgentChannel;
 readonly modelConfig:AgentModelConfig;readonly evidencePath:string;
 private confirmed=new Map<string,{model:string;modelProvider:string;reasoningEffort:string|null}>();
 constructor(root:string,private options:AgentModelOptions&{imageMode?:boolean;onImage?:(item:any)=>void}={}){
  // Image generation/recovery is a separate provider: text-Agent preferences must not change it.
  this.modelConfig=options.imageMode?resolveAgentModelConfig(options,{},null):resolveAgentModelConfig(options);
  const binary=findCodex();if(!binary)throw new DomainError('UNSUPPORTED','未找到本机 Codex，请设置 DREAMER_CODEX_BIN');
  const home=join(root,'runtime','codex'),cwd=join(root,'runtime','sandbox');mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(cwd,{recursive:true,mode:0o700});
  const evidenceDirectory=join(root,'runtime','agent-config');mkdirSync(evidenceDirectory,{recursive:true,mode:0o700});this.evidencePath=join(evidenceDirectory,randomUUID()+'.jsonl');
  this.record({event:'configured',requested:this.modelConfig});
  const auth=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'auth.json');if(existsSync(auth)&&!existsSync(join(home,'auth.json')))symlinkSync(auth,join(home,'auth.json'));
  const disabled=['shell_tool','unified_exec','multi_agent','multi_agent_v2','hooks','plugins','remote_plugin','apps','browser_use','browser_use_external','in_app_browser','image_generation','view_image','skill_search','skill_mcp_dependency_install'];
  const child=spawn(binary,['app-server','--stdio',...disabled.filter(n=>!options.imageMode||n!=='image_generation').flatMap(n=>['--disable',n]),...(options.imageMode?['--enable','image_generation']:[]),'--enable','code_mode_host','--enable','skip_host_skill_discovery','-c','approval_policy="never"','-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','memories.use_memories=false','-c','memories.generate_memories=false'],{cwd,env:{...process.env,CODEX_HOME:home},shell:false,stdio:['pipe','pipe','pipe']});
  this.rpc=new JsonRpc(child);this.rpc.onClose=()=>this.channel?.close('本机会话连接已断开；不会自动重发');
  this.rpc.onNotification=(method,p)=>{if(method==='item/completed'&&p.item?.type==='imageGeneration')this.options.onImage?.(p.item);if(method==='item/agentMessage/delta')this.channel?.event(p.threadId,{type:'delta',text:p.delta,turnId:p.turnId});if(method==='turn/completed'){this.record({event:'turn-completed',threadId:p.threadId,turnId:p.turn?.id,status:p.turn?.status});this.channel?.event(p.threadId,{type:p.turn?.status==='completed'?'complete':'error',text:p.turn?.status==='completed'?undefined:typeof p.turn?.error?.message==='string'?p.turn.error.message.slice(0,1000):'本轮未完成，请检查登录、额度或显式重试',turnId:p.turn?.id});}};
  this.rpc.onRequest=async(method,p)=>{if(method!=='item/tool/call'||!this.channel)throw new Error('未授权');try{return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(await this.channel.call(p.threadId,p.turnId,p.tool,p.arguments,p.callId))}]};}catch(e){return {success:false,contentItems:[{type:'inputText',text:(e as Error).message}]};}};
  this.ready=this.rpc.request('initialize',{clientInfo:{name:'dreamer',version:'0.1.0'},capabilities:{experimentalApi:true,requestAttestation:false}}).then(v=>{this.rpc.notify('initialized');return v;});
 }
 private record(value:Record<string,unknown>){appendFileSync(this.evidencePath,JSON.stringify({at:new Date().toISOString(),...value})+'\n',{mode:0o600});}
 async start(providerId:string|undefined,tools:Tool[],instructions:string){
  await this.ready;if(providerId)this.confirmed.delete(providerId);const {model,reasoningEffort}=this.modelConfig;
  // Codex's generated schema uses config on thread/start and resume, but effort on turn/start.
  const common={approvalPolicy:'never',sandbox:'read-only',baseInstructions:instructions,...(model?{model}:{}),...(reasoningEffort?{config:{model_reasoning_effort:reasoningEffort}}:{})};
  const method=providerId?'thread/resume':'thread/start',result=await this.rpc.request(method,providerId?{threadId:providerId,...common}:{...common,dynamicTools:tools,allowProviderModelFallback:false});
  const confirmed={model:result.model,modelProvider:result.modelProvider,reasoningEffort:result.reasoningEffort??null};
  const matches=typeof confirmed.model==='string'&&!!confirmed.model&&typeof confirmed.modelProvider==='string'&&(!model||confirmed.model===model)&&(!reasoningEffort||confirmed.reasoningEffort===reasoningEffort);
  this.record({event:'thread-configured',method,threadId:result.thread.id,requested:this.modelConfig,confirmed,matches});
  if(!matches)throw new DomainError('UNSUPPORTED','Codex 返回的模型或推理强度与请求不一致，未启动创作；请检查运行配置记录');
  this.confirmed.set(result.thread.id,confirmed);return result.thread.id as string;
 }
 async turn(providerId:string,text:string,onEvent:Parameters<AgentSession['turn']>[2],onTool:Parameters<AgentSession['turn']>[3],images:string[]=[]){
  const confirmed=this.confirmed.get(providerId);if(!confirmed)throw new DomainError('VALIDATION','请先确认会话模型配置再启动轮次');
  this.channel?.close();const channel=new AgentChannel(providerId,onEvent,onTool);this.channel=channel;
  try{const r=await this.rpc.request('turn/start',{threadId:providerId,input:[{type:'text',text,text_elements:[]},...images.map(path=>({type:'localImage',path}))],approvalPolicy:'never',model:confirmed.model,...(confirmed.reasoningEffort?{effort:confirmed.reasoningEffort}:{})});this.record({event:'turn-started',threadId:providerId,turnId:r.turn.id,requested:{model:confirmed.model,reasoningEffort:confirmed.reasoningEffort},configurationConfirmedBy:'thread-response'});channel.started(r.turn.id);return r.turn.id as string;}catch(error){channel.close();throw error;}
 }
 async interrupt(providerId:string,turnId:string){await this.rpc.request('turn/interrupt',{threadId:providerId,turnId});}
 async read(providerId:string){await this.ready;return this.rpc.request('thread/read',{threadId:providerId,includeTurns:true});}
 close(){this.channel?.close();this.rpc.close();}
}
