import {z} from 'zod';
import {WritingClient,writingTools} from './writing-client.ts';

const request=z.strictObject({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number()]).optional(),method:z.string(),params:z.unknown().optional()});
const initialize=z.object({protocolVersion:z.string(),capabilities:z.record(z.string(),z.unknown()),clientInfo:z.object({name:z.string(),version:z.string()})});
const instructions='创作 Dreamer 工程的小说、章节或剧本时，优先调用 dreamer_writing_start/continue，让平台 Agent 使用专用 Skill 和固定上下文。主题未定用 discuss，用户授权写稿才用 draft/revise。不要在外部直接代写后覆盖工程。尊重用户已经指定的方向或授权代理把控的范围；尚需用户决定的方向卡交给用户选，不重复确认已授权步骤。已有修改是提案，审批留给工作台。调用失败明确报告，不悄悄绕过平台。媒体生成不在这些工具范围内。';
/** Small stdio MCP surface; no model, database, arbitrary URL or generic command tools. */
export class WritingMcp {
 private initialized=false;private ready=false;
 constructor(private client:WritingClient){}
 async handle(value:unknown):Promise<unknown|undefined>{
  const parsed=request.safeParse(value);
  if(!parsed.success)return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}};
  const p=parsed.data,reply=(result:unknown)=>({jsonrpc:'2.0',id:p.id,result}),error=(code:number,message:string)=>({jsonrpc:'2.0',id:p.id??null,error:{code,message}});
  if(p.id===undefined){if(p.method==='notifications/initialized'&&this.initialized)this.ready=true;return;}
  if(p.method==='ping')return reply({});
  if(p.method==='initialize'){
   if(this.initialized)return error(-32600,'Already initialized');
   if(!initialize.safeParse(p.params).success)return error(-32602,'Invalid initialization parameters');
   this.initialized=true;
   return reply({protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'dreamer-writing',version:'1.0.0'},instructions});
  }
  if(!this.ready)return error(-32000,'Initialize and send notifications/initialized first');
  if(p.method==='tools/list')return reply({tools:writingTools.map(t=>({name:t.name,description:t.description,inputSchema:z.toJSONSchema(t.schema),annotations:{readOnlyHint:t.readonly,destructiveHint:false,idempotentHint:true,openWorldHint:false}}))});
  if(p.method!=='tools/call')return error(-32601,'Method not found');
  const call=z.object({name:z.string(),arguments:z.unknown().optional()}).safeParse(p.params);
  if(!call.success)return error(-32602,'Invalid tool call');
  const tool=writingTools.find(t=>t.name===call.data.name);
  if(!tool)return error(-32602,'Unknown tool');
  try{
   const input=tool.schema.parse(call.data.arguments??{});
   const methods:Record<string,()=>Promise<unknown>>={dreamer_writing_projects:()=>this.client.projects(),dreamer_writing_start:()=>this.client.start(input),dreamer_writing_continue:()=>this.client.continue(input),dreamer_writing_status:()=>this.client.status(input),dreamer_writing_receipt:()=>this.client.receipt(input)};
   const result=await methods[tool.name]();
   return reply({content:[{type:'text',text:JSON.stringify(result)}],isError:false});
  }catch(e){return reply({content:[{type:'text',text:e instanceof z.ZodError?'参数无效：'+e.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join(';'):(e as Error).message}],isError:true});}
 }
}
