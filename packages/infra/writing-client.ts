import {createHash} from 'node:crypto';
import {z} from 'zod';
import {WritingStartRequest,WritingContinueRequest,WritingStatusQuery} from '../contracts/writing.ts';

const requestKey=z.string().trim().min(1).max(200).describe('本次意图的稳定唯一键；重试保持原键和全部参数，新意图换新键。');
export const ExternalWritingStart=WritingStartRequest.omit({requestId:true,owner:true}).extend({requestKey});
export const ExternalWritingContinue=WritingContinueRequest.omit({requestId:true,owner:true}).extend({requestKey});
export const ExternalWritingReceipt=z.discriminatedUnion('operation',[
 z.strictObject({operation:z.literal('start'),request:ExternalWritingStart}),
 z.strictObject({operation:z.literal('continue'),request:ExternalWritingContinue}),
]);
const uuid=(value:string)=>{const h=createHash('sha256').update(value).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export class WritingClient {
 readonly baseUrl:string;readonly owner:string;
 private session?:{cookie:string;csrf:string};
 constructor(baseUrl='http://127.0.0.1:4327',clientId='external-default',private fetcher:typeof fetch=fetch){
  const url=new URL(baseUrl);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Dreamer 写作入口只支持本机 http://127.0.0.1:端口 或 localhost；不接受凭据和远程地址。');
  this.baseUrl=url.origin;this.owner=uuid(`dreamer-writing-owner:${this.baseUrl}:${clientId}`);
 }
 command(operation:'start'|'continue',input:unknown){
  const {requestKey,...payload}=(operation==='start'?ExternalWritingStart:ExternalWritingContinue).parse(input);
  return {...payload,owner:this.owner,requestId:uuid(`dreamer-writing-request:${this.owner}:${payload.projectId}:${operation}:${requestKey}`)};
 }
 private async connect(){
  const response=await this.fetcher(`${this.baseUrl}/api/session`,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error(`Dreamer 会话连接失败 (${response.status})`);
  const body=await response.json() as any,cookie=response.headers.get('set-cookie')?.split(';')[0];
  if(!cookie||typeof body.csrf!=='string')throw new Error('Dreamer 未返回有效会话');
  this.session={cookie,csrf:body.csrf};
 }
 private async request(path:string,body?:unknown){
  if(!this.session)await this.connect();
  const headers={'content-type':'application/json',origin:this.baseUrl,cookie:this.session!.cookie,'x-dreamer-csrf':this.session!.csrf};
  const ambiguous=()=>new Error(['/api/writing/start','/api/writing/continue'].includes(path)?'提交结果尚未确认；先用 dreamer_writing_receipt 查询同一请求，不要换 requestKey 重新提交。':'Dreamer 未能返回完整查询结果；请确认 Host 已启动后重新查询。');
  let response:Response;
  try{response=await this.fetcher(`${this.baseUrl}${path}`,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(20000)});}
  catch{throw ambiguous();}
  let value:any;
  try{value=await response.json();}catch{throw ambiguous();}
  if(!response.ok){if(response.status===403)this.session=undefined;throw new Error(`${value.error?.code??value.code??response.status}: ${value.error?.message??value.message??'Dreamer 请求失败'}`);}
  const absoluteLink=(v:any):any=>!v||typeof v!=='object'||Array.isArray(v)?v:{...v,...(typeof v.url==='string'&&v.url.startsWith('/?')?{url:new URL(v.url,this.baseUrl).href}:{}),...(v.result?{result:absoluteLink(v.result)}:{}),...(v.receipt?{receipt:absoluteLink(v.receipt)}:{})};
  return absoluteLink(value);
 }
 async projects(){const ids=await this.request('/api/projects');return Array.isArray(ids)?ids.map((p:any)=>({id:p.id,title:p.title??p.data?.title})):ids;}
 async start(input:unknown){return this.request('/api/writing/start',this.command('start',input));}
 async continue(input:unknown){return this.request('/api/writing/continue',this.command('continue',input));}
 async status(input:unknown){return this.request('/api/writing/status?'+new URLSearchParams(WritingStatusQuery.parse(input)).toString());}
 async receipt(input:unknown){const p=ExternalWritingReceipt.parse(input),{requestId,projectId,...payload}=this.command(p.operation,p.request);return this.request('/api/writing/receipt',{requestId,projectId,operation:`writing.${p.operation}`,payload});}
}

export const writingTools=[
 {name:'dreamer_writing_projects',description:'列出本机 Dreamer 工程 ID 和标题。先确认用户指定工程，不自行选择其他故事。',schema:z.strictObject({}),readonly:true},
 {name:'dreamer_writing_start',description:'写作首选入口：让 Dreamer 平台 Agent 按主题共创或在明确范围内写作。discuss 提供可选方向且不能改稿；draft 创作授权的新章节；revise 对 targetRefs 提交提案；review 只读审稿。正文由平台 Agent 执行，调用者不要直接写数据库或替代写稿。返回异步轮次后查询 status；completed 不等于审稿通过或已采用。',schema:ExternalWritingStart,readonly:false},
 {name:'dreamer_writing_continue',description:'在原平台写作会话中补充主题、选方向、确认写章或修订。selection 只能用于 discuss 且必须是最新方向卡；选择不等于授权写章。保持 requestKey 重试；mode 和 targetRefs 由用户本轮范围决定，不因阅读自动扩大修改范围。',schema:ExternalWritingContinue,readonly:false},
 {name:'dreamer_writing_status',description:'查询真实 Agent 轮次、选项、产物和错误。保留 threadId，工作中间隔查询；可用最后已知 entry.id 作为 afterEntryId，按ID合并返回的锚点最新全文及后续消息，避免反复取全部历史。unknown/failed 不代表成功，不能自行换 requestKey 重试。',schema:WritingStatusQuery,readonly:true},
 {name:'dreamer_writing_receipt',description:'提交丢响应后，用原 operation 与原 request 的完整参数核对回执。found=false 才可重发相同 requestKey 和参数；不要改键重复生成。',schema:ExternalWritingReceipt,readonly:true},
] as const;
