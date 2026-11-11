import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Application} from '../apps/host/application.ts';
import {createHost} from '../apps/host/server.ts';
import {WritingClient,writingTools} from '../packages/infra/writing-client.ts';
import {WritingMcp} from '../packages/infra/writing-mcp.ts';

const input=()=>({requestKey:'chapter-seven-discuss-1',projectId:randomUUID(),title:'水碓篇共创',mode:'discuss' as const,message:'保留种田成长，讨论怎样让兑现更有趣'});
function fixture(){
 const calls:{url:string;init:RequestInit|undefined}[]=[];
 const client=new WritingClient('http://127.0.0.1:4330','test',async(url,init)=>{
  calls.push({url:String(url),init});
  return String(url).endsWith('/api/session')?new Response(JSON.stringify({csrf:'test-csrf'}),{headers:{'set-cookie':'dreamer=test-cookie; Path=/'}}):new Response(JSON.stringify({accepted:true,state:'queued',url:'/?project=test',receipt:{result:{url:'/?project=test'}}}));
 });return {client,calls};
}
test('03 external writing keys keep command identity across reconnects and receipt uses original payload',async()=>{
 const x=fixture(),p=input(),command=x.client.command('start',p);
 assert.deepEqual(new WritingClient('http://127.0.0.1:4330','test').command('start',p),command);
 assert.notEqual(new WritingClient('http://127.0.0.1:4330','another').command('start',p).owner,command.owner);
 assert.equal(x.client.command('start',{...p,message:'changed'}).requestId,command.requestId,'Host must reject changed payload under same identity');
 const started=await x.client.start(p);assert.equal(started.url,'http://127.0.0.1:4330/?project=test');assert.equal(started.receipt.result.url,started.url);await x.client.receipt({operation:'start',request:p});
 const {requestId,projectId,...payload}=command;
 assert.deepEqual(JSON.parse(String(x.calls[2].init?.body)),{requestId,projectId,operation:'writing.start',payload});
 assert.equal(x.calls.filter(c=>c.url.endsWith('/api/session')).length,1);
 assert.equal(x.calls[1].init?.redirect,'error');
 assert.deepEqual(JSON.parse(String(x.calls[1].init?.body)),command);
});
test('03 external client rejects remote targets and does not blindly retry ambiguous mutations',async()=>{
 for(const url of ['https://127.0.0.1:4330','http://example.com','http://user:secret@localhost:4330','http://localhost:4330/other','http://localhost:4330/?x=1'])assert.throws(()=>new WritingClient(url));
 let submitted=0;
 const client=new WritingClient(undefined,undefined,async(url)=>{if(String(url).endsWith('/api/session'))return new Response(JSON.stringify({csrf:'x'}),{headers:{'set-cookie':'dreamer=x'}});submitted++;throw new Error('socket closed');});
 await assert.rejects(client.start(input()),/receipt/);assert.equal(submitted,1);
});
test('03 MCP exposes only platform writing tools, validates lifecycle and never invokes generic writes',async()=>{
 const x=fixture(),mcp=new WritingMcp(x.client),ask=(id:number,method:string,params?:unknown)=>mcp.handle({jsonrpc:'2.0',id,method,params}) as Promise<any>;
 assert.equal((await ask(1,'tools/list')).error.code,-32000);
 const init=await ask(2,'initialize',{protocolVersion:'2099-01-01',capabilities:{},clientInfo:{name:'test',version:'1'}});
 assert.equal(init.result.protocolVersion,'2025-06-18');assert.match(init.result.instructions,/优先调用/);
 await mcp.handle({jsonrpc:'2.0',method:'notifications/initialized'});
 const listed=await ask(3,'tools/list');assert.deepEqual(listed.result.tools.map((t:any)=>t.name),writingTools.map(t=>t.name));
 assert.equal((await ask(4,'tools/call',{name:'chapter_create',arguments:{}})).error.code,-32602);
 const bad=await ask(5,'tools/call',{name:'dreamer_writing_start',arguments:{...input(),allowed:['change.apply']}});assert.equal(bad.result.isError,true);assert.equal(x.calls.length,0);
 const good=await ask(6,'tools/call',{name:'dreamer_writing_start',arguments:input()});assert.equal(good.result.isError,false);assert.equal(JSON.parse(good.result.content[0].text).state,'queued');
 assert.equal(x.calls[1].url,'http://127.0.0.1:4330/api/writing/start');
 assert.equal(await mcp.handle({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:6}}),undefined,'cancellation never claims underlying durable job was undone');
});
test('03 lost response body after POST preserves ambiguous outcome and receipt-query errors remain queries',async()=>{
 let submitted=0;
 const client=new WritingClient(undefined,undefined,async(url)=>{if(String(url).endsWith('/api/session'))return new Response(JSON.stringify({csrf:'x'}),{headers:{'set-cookie':'dreamer=x'}});submitted++;return new Response('{truncated');});
 const p=input();await assert.rejects(client.start(p),/结果尚未确认.*receipt/);assert.equal(submitted,1);
 await assert.rejects(client.receipt({operation:'start',request:p}),/查询结果/);assert.equal(submitted,2);
});
test('03 executable stdio adapter emits newline-delimited JSON only and negotiates before listing tools',async()=>{
 const child=spawn(process.execPath,['--import','tsx','scripts/writing-mcp.ts'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 child.stdin.end([
  JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}}),
  JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}),
  JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'}),
  '{bad',
 ].join('\n')+'\n');
 const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 assert.equal(code,0,err);const rows=out.trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows.length,3);assert.equal(rows[1].result.tools.length,5);assert.equal(rows[2].error.code,-32700);
});

test('03 MCP shell launcher uses explicit Node outside the repo and reads a real isolated Host',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-mcp-launch-')),app=new Application(root,{offline:true}),host=createHost(app);
 let child:ReturnType<typeof spawn>|undefined;
 try{
  const projectId=randomUUID();app.bus.execute({projectId,requestId:randomUUID(),operation:'project.create',payload:{title:'MCP 接入检查'}},{source:'human'});
  await new Promise<void>((done,fail)=>{host.once('error',fail);host.listen(0,'127.0.0.1',done);});
  child=spawn('/bin/sh',[resolve('scripts/dreamer-writing-mcp.sh')],{cwd:tmpdir(),env:{...process.env,PATH:'/usr/bin:/bin',DREAMER_NODE_BIN:process.execPath,DREAMER_URL:`http://127.0.0.1:${(host.address() as {port:number}).port}`,DREAMER_WRITING_CLIENT_ID:'launch-check'},stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout!.on('data',chunk=>out+=chunk);child.stderr!.on('data',chunk=>err+=chunk);
  child.stdin!.end([
   {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'launcher-test',version:'1'}}},
   {jsonrpc:'2.0',method:'notifications/initialized'},
   {jsonrpc:'2.0',id:2,method:'tools/list'},
   {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'dreamer_writing_projects',arguments:{}}},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const code=await new Promise<number|null>((done,fail)=>{child!.once('error',fail);child!.once('close',done);});
  assert.equal(code,0,err);const rows=out.trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows.length,3);
  assert.equal(rows[1].result.tools.length,5);assert.equal(rows[2].result.isError,false);
  assert.deepEqual(JSON.parse(rows[2].result.content[0].text),[{id:projectId,title:'MCP 接入检查'}]);
  assert.equal(app.agents.threads.list(projectId).length,0);
 }finally{child?.kill('SIGTERM');host.closeAllConnections();await new Promise<void>(done=>host.close(()=>done()));app.close();rmSync(root,{recursive:true,force:true});}
});
