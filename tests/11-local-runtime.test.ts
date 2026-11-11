import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {z} from 'zod';
import { LocalRuntimeGenerator, localStructuredResult, localOutputGuide,localOutputSchema,localModelInput } from '../packages/infra/agent/local-runtime-generator.ts';
import {LocalRuntimeDraftV1} from '../packages/contracts/local-runtime-draft.ts';
import {SegmentScriptV1} from '../packages/contracts/experience.ts';
import {stable} from '../packages/contracts/foundation.ts';
import {compileLocalRuntimeDraft} from '../packages/core/experience/local-runtime-draft.ts';
import type { RuntimeTextRequest } from '../packages/core/experience/generation.ts';
import {ContentReview} from '../packages/core/experience/generation.ts';

async function fixture(mode: 'ok' | 'unknown' | 'redirect' | 'tools' | 'model' = 'ok', result:unknown = {result:'你好'}) {
 const root = mkdtempSync(join(tmpdir(), 'dreamer-local-text-')); let calls = 0, body: any;
 const server = createServer(async (req, res) => {
  if (req.url === '/v1/models') { if (mode === 'redirect') { res.writeHead(302,{Location:'https://example.invalid/paid'}).end(); return; } res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-local'}]}));return; }
  calls++; const chunks=[];for await(const c of req)chunks.push(c);body=JSON.parse(Buffer.concat(chunks).toString());
  if(mode==='unknown'){req.socket.destroy();return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:mode==='model'?'other':'test-local',choices:[{message:{content:JSON.stringify(result),...(mode==='tools'?{tool_calls:[{id:'bad'}]}:{})},finish_reason:'stop'}]}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as any).port}/v1`;
 const generator=new LocalRuntimeGenerator(root,{baseUrl:url,model:'test-local'});
 const request:RuntimeTextRequest={requestId:randomUUID(),stage:'interpret',inputHash:'a'.repeat(64),configurationHash:generator.configuration().fingerprint,input:{text:'你好'},outputSchema:{type:'object',properties:{result:{type:'string'}},required:['result'],additionalProperties:false}};
 return {generator,request,calls:()=>calls,body:()=>body,root,url,close:async()=>{generator.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}};
}
test('11 local runtime requires a literal loopback endpoint and explicit model; no implicit paid configuration',()=>{
 for(const baseUrl of ['https://127.0.0.1:1234/v1','http://example.com/v1','http://user:secret@127.0.0.1:1234/v1','http://127.0.0.1:1234/v1?key=bad','http://localhost:1234/v1'])assert.throws(()=>new LocalRuntimeGenerator('/tmp/unused',{baseUrl,model:'test-local'}),/本地文本/);
 assert.throws(()=>new LocalRuntimeGenerator('/tmp/unused',{baseUrl:'http://127.0.0.1:1234/v1',model:''}),/指定/);
});
test('11 local runtime structured request is journaled, recoverable and never resubmitted',async()=>{
 const x=await fixture();try{
  assert.deepEqual(await x.generator.execute(x.request,()=>{}),{result:'你好'});
  assert.equal(x.body().response_format.type,'json_schema');assert.equal(x.body().tools,undefined);assert.equal(x.body().stream,false);
  assert.equal(x.generator.configuration().description.cost,'local');
  assert.deepEqual(await x.generator.execute(x.request,()=>{}),{result:'你好'});
  const restored=new LocalRuntimeGenerator(x.root,{baseUrl:x.url,model:'test-local'});
  assert.deepEqual(await restored.reconcile(x.request),{result:'你好'});restored.close();assert.equal(x.calls(),1);
  await assert.rejects(x.generator.reconcile({...x.request,inputHash:'b'.repeat(64)}),/不一致/);
 }finally{await x.close();}
});
test('11 local runtime rejects redirects, wrong models/tools and retains unknown without resubmission',async()=>{
 for(const mode of ['redirect','model','tools','unknown'] as const){const x=await fixture(mode);try{
  await assert.rejects(x.generator.execute(x.request,()=>{}));assert.equal(x.calls(),mode==='redirect'?0:1);
  if(mode==='unknown'){assert.equal(await x.generator.reconcile(x.request),undefined);await assert.rejects(x.generator.execute(x.request,()=>{}),/未知/);assert.equal(x.calls(),1);}
 }finally{await x.close();}}
});
test('11 local cancellation before dispatch and concurrent same-ID calls never submit twice',async()=>{
 const x=await fixture();try{
  await x.generator.cancel(x.request);await assert.rejects(x.generator.execute(x.request,()=>{}),/取消/);assert.equal(x.calls(),0);
  const request={...x.request,requestId:randomUUID()};const results=await Promise.allSettled([x.generator.execute(request,()=>{}),x.generator.execute(request,()=>{})]);
  assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(x.calls(),1);
 }finally{await x.close();}
});

test('11 local structured result separates known final channel and exact JSON fence without extracting arbitrary prose',()=>{
 assert.deepEqual(localStructuredResult('<|channel>thought\nnot-a-result {"wrong":true}<channel|>```json\n{"result":"好"}\n```'),{result:'好'});
 assert.deepEqual(localStructuredResult('```json\n{"result":"好"}\n```'),{result:'好'});
 assert.throws(()=>localStructuredResult('<|channel>thought unfinished'),/最终回答/);
 assert.equal(localStructuredResult('prefix {"result":"好"}'), 'prefix {"result":"好"}');
 assert.equal(localStructuredResult('{"a":1}{"b":2}'), '{"a":1}{"b":2}');
});

test('11 local writing guide is itself schema-valid and uses only frozen references',()=>{
 const id=randomUUID(),scene={kind:'scene',id:randomUUID(),seq:2};
 const request:RuntimeTextRequest={requestId:randomUUID(),stage:'write',inputHash:'a'.repeat(64),configurationHash:'b'.repeat(64),input:{instanceId:id,inputHash:'a'.repeat(64),outcomeId:'wait',context:{sourceRefs:[scene]},contract:{reads:['intent'],limits:{maxScenes:2,maxShots:3,targetSeconds:5}}},outputSchema:{}};
 const guide=localOutputGuide(request)!;assert.ok(guide.example);assert.ok(LocalRuntimeDraftV1.safeParse(guide.example).success);assert.deepEqual(guide.example.sourceRefs,[scene]);assert.deepEqual(guide.example.shotPlan[0]!.resourceRefs,[]);assert.deepEqual(localOutputGuide(request),guide);
 const frozen={...request,input:{...request.input,instructions:'只返回 SegmentScriptV1'}};
 assert.match(String(localModelInput(frozen).instructions),/LocalRuntimeDraftV1/);assert.equal(frozen.input.instructions,'只返回 SegmentScriptV1');
});

test('11 local writing declares its draft format and uses the draft schema only for write/repair',async()=>{
 const x=await fixture();try{
  assert.equal(x.generator.configuration().description.outputFormat,'local-segment-draft/v1');
  for(const stage of ['write','repair','check'] as const){
   await x.generator.execute({...x.request,requestId:randomUUID(),stage},()=>{});
   const schema=x.body().response_format.json_schema.schema;
   if(stage==='check')assert.deepEqual(schema,x.request.outputSchema);
   else assert.equal(schema.properties.format.const,'local-segment-draft/v1');
   assert.deepEqual(JSON.parse(x.body().messages[1].content).outputSchema,schema);
  }
 }finally{await x.close();}
});

test('11 local review schema and guide whitelist only canonical body blocks, never shot identities',()=>{
 const blockId=randomUUID(),shotId=randomUUID(),schema={type:'object',properties:{instanceId:{type:'string'},checks:{type:'array',items:{type:'object',properties:{evidenceBlockIds:{type:'array',items:{type:'string'}}}}}}};
 const request:RuntimeTextRequest={requestId:randomUUID(),stage:'check',inputHash:'a'.repeat(64),configurationHash:'b'.repeat(64),input:{instanceId:randomUUID(),script:{scenes:[{blocks:[{id:blockId,type:'action',text:'城门关闭'}]}],shotPlan:[{id:shotId}]}},outputSchema:schema};
 const compiled:any=localOutputSchema(request);
 assert.deepEqual(compiled.properties.checks.items.properties.evidenceBlockIds.items.enum,[blockId]);
 assert.equal(compiled.properties.instanceId.const,request.input.instanceId);
 assert.deepEqual(schema.properties.checks.items.properties.evidenceBlockIds.items,{type:'string'});
 assert.deepEqual(localOutputGuide(request)!.evidenceBlocks,[{id:blockId,type:'action',text:'城门关闭'}]);
 const actual:any=localOutputSchema({...request,outputSchema:z.toJSONSchema(ContentReview,{reused:'ref'})});
 const item=actual.properties.checks.items,reviewItem=item.$ref?actual.$defs[item.$ref.split('/').at(-1)]:item;
 assert.deepEqual(reviewItem.properties.evidenceBlockIds.items.enum,[blockId]);
});

function writingRequest():RuntimeTextRequest {
 const scene={kind:'scene',id:randomUUID(),seq:1};
 return {requestId:randomUUID(),stage:'write',inputHash:'a'.repeat(64),configurationHash:'b'.repeat(64),
  input:{instanceId:randomUUID(),inputHash:'a'.repeat(64),outcomeId:'wait',context:{sourceRefs:[scene],priorInstanceRefs:[]},
   sources:[{ref:scene,data:{blocks:[{id:randomUUID(),type:'action',text:'城门关闭'}]}}],previousContent:[],
   contract:{scope:'chapter',reads:[],limits:{maxScenes:3,maxShots:3,targetSeconds:15}}},
  outputSchema:z.toJSONSchema(SegmentScriptV1,{reused:'ref'})};
}
function dereference(schema:any,value:any):any {
 while(value?.$ref)value=value.$ref.slice(2).split('/').reduce((node:any,key:string)=>node[key.replace(/~1/g,'/').replace(/~0/g,'~')],schema);
 return value;
}
function bodyBlockSchema(schema:any):any {
 const scene=dereference(schema,dereference(schema,schema.properties.scenes).items);
 return dereference(schema,dereference(schema,scene.properties.blocks).items);
}

test('11 writing and repair omit unbound entityId from their closed wire schema without changing canonical output shape',()=>{
 const request=writingRequest(),before=stable(request);
 for(const stage of ['write','repair'] as const){
  const input={...request,stage},schema:any=localOutputSchema(input),block=bodyBlockSchema(schema);
  assert.equal(block.additionalProperties,false);assert.equal(Object.hasOwn(block.properties,'entityId'),false);
  assert.ok(!block.required.includes('entityId'));assert.deepEqual(localOutputGuide(input)!.entityIds,[]);
  assert.ok(bodyBlockSchema(request.outputSchema).properties.entityId,'canonical protocol still accepts explicitly bound UUIDs');
  for(const key of ['instanceId','inputHash','outcomeId'])assert.equal(schema.properties[key].const,request.input[key]);
  assert.match(localOutputGuide(input)!.instructions,/必须省略entityId属性/);
  assert.match(String(localModelInput(input).instructions),/不填空值或局部编号/);
 }
 assert.equal(stable(request),before);
 const interpretation={...request,stage:'interpret' as const,input:{text:'你好'},outputSchema:{type:'object',properties:{entityId:{type:'string'}},additionalProperties:false}};
 assert.deepEqual(localOutputSchema(interpretation),interpretation.outputSchema);
});

test('11 bound entity UUIDs come only from exact frozen author and prior-content refs, not local IDs or repair diagnosis',()=>{
 const request=writingRequest(),input=request.input as any,sceneRef=input.context.sourceRefs[0],resourceRef={kind:'resource',id:randomUUID(),seq:2};
 const priorRef={runId:randomUUID(),instanceId:randomUUID(),resultRevision:1,contentHash:'c'.repeat(64)};
 const entities=[randomUUID(),randomUUID(),randomUUID()],untrusted=randomUUID();
 input.context.sourceRefs.push(resourceRef);input.context.priorInstanceRefs.push(priorRef);
 input.sources=[{ref:sceneRef,data:{blocks:[{id:randomUUID(),entityId:entities[0]},{entityId:''},{entityId:'action-0'},{entityId:entities[0]}],notes:{entityId:untrusted}}},
  {ref:resourceRef,data:{entityId:entities[1]}},{ref:{...sceneRef,seq:2},data:{blocks:[{entityId:untrusted}]}}];
 input.previousContent=[{ref:priorRef,script:{instanceId:priorRef.instanceId,scenes:[{blocks:[{id:randomUUID(),entityId:entities[2]}]}]}},
  {ref:{...priorRef,resultRevision:2},script:{instanceId:priorRef.instanceId,scenes:[{blocks:[{entityId:untrusted}]}]}}];
 input.diagnosis={entityId:untrusted};input.previousResult={scenes:[{blocks:[{entityId:untrusted}]}]};
 const before=stable(request);
 for(const stage of ['write','repair'] as const){
  const schema:any=localOutputSchema({...request,stage}),block=bodyBlockSchema(schema);
  assert.deepEqual(block.properties.entityId.enum,[...entities].sort());assert.equal(block.properties.entityId.format,'uuid');
  assert.equal(block.additionalProperties,false);assert.ok(!block.required.includes('entityId'));
  assert.deepEqual(localOutputGuide({...request,stage})!.entityIds,[...entities].sort());
  assert.equal(dereference(schema,schema.properties.instanceId).enum,undefined,'entity whitelist must not narrow the shared identity definition');
 }
 assert.equal(stable(request),before);
 const withoutBindings={...request,input:{...input,context:{sourceRefs:[],priorInstanceRefs:[]}}};
 assert.equal(Object.hasOwn(bodyBlockSchema(localOutputSchema(withoutBindings)).properties,'entityId'),false);
});

test('11 local evidence refers only to new output blocks; strict compiler still rejects prior UUIDs and invalid entity IDs',()=>{
 const request=writingRequest(),guide=localOutputGuide(request)!,draft=guide.example!;
 assert.match(guide.instructions,/本次新输出的scenes\[\]\.blocks\[\]\.id/);
 assert.match(guide.instructions,/不能引用previousContent、sources、previousResult/);
 const binding={instanceId:request.input.instanceId,inputHash:request.input.inputHash,outcomeId:request.input.outcomeId,sourceRefs:(request.input.context as any).sourceRefs,resourceRefs:[]} as Parameters<typeof compileLocalRuntimeDraft>[1];
 for(const entityId of ['', 'action-0', 'dialogue-0']){
  const invalid=structuredClone(draft) as any;invalid.scenes[0].blocks[0].entityId=entityId;
  assert.equal(LocalRuntimeDraftV1.safeParse(invalid).success,false);
  assert.throws(()=>compileLocalRuntimeDraft(invalid,binding));
 }
 const previousBlockId='a0000000-0000-4000-8000-000000000001';
 for(const field of ['assertedFacts','contentChecks'] as const){
  const invalid=structuredClone(draft) as any;
  invalid[field]=field==='assertedFacts'?[{key:'gateClosed',value:true,evidenceBlockIds:[previousBlockId]}]:[{ruleId:'GATE',status:'passed',evidenceBlockIds:[previousBlockId],message:'前文'}];
  assert.ok(LocalRuntimeDraftV1.safeParse(invalid).success,'the old UUID can resemble a local symbol; reference existence must still be checked');
  assert.throws(()=>compileLocalRuntimeDraft(invalid,binding),/正文引用不存在/);
 }
 const valid=structuredClone(draft) as any,entityId=randomUUID();valid.scenes[0].blocks[1].entityId=entityId;
 valid.assertedFacts=[{key:'gateClosed',value:true,evidenceBlockIds:['action-0']}];
 const canonical=compileLocalRuntimeDraft(valid,binding);
 assert.equal(canonical.scenes[0]!.blocks[1]!.entityId,entityId);
 assert.equal(canonical.assertedFacts[0]!.evidenceBlockIds[0],canonical.scenes[0]!.blocks[0]!.id);
});

test('11 narrowed local wire schema never rewrites an invalid original result or its journal',async()=>{
 const raw={scenes:[{id:'scene-0',blocks:[{id:'action-0',entityId:'',text:'原始返回保留'}]}]},x=await fixture('ok',raw);
 try{
  const request={...writingRequest(),configurationHash:x.generator.configuration().fingerprint};
  assert.deepEqual(await x.generator.execute(request,()=>{}),raw);
  assert.equal(Object.hasOwn(bodyBlockSchema(x.body().response_format.json_schema.schema).properties,'entityId'),false);
  const journal=JSON.parse(readFileSync(join(x.root,'runtime','experience-text',`${request.requestId}.json`),'utf8'));
  assert.deepEqual(journal.result,raw);assert.deepEqual(await x.generator.reconcile(request),raw);assert.equal(x.calls(),1);
 }finally{await x.close();}
});

test('11 local entity/evidence guidance is frozen by template v8 and refuses old configuration dispatch',async()=>{
 const x=await fixture();try{
  const configuration=x.generator.configuration();assert.equal(configuration.description.templateVersion,'dreamer-runtime-structured/v8');
  const priorFingerprint=createHash('sha256').update(stable({...configuration.description,templateVersion:'dreamer-runtime-structured/v7'})).digest('hex');
  assert.notEqual(configuration.fingerprint,priorFingerprint);
  await assert.rejects(x.generator.execute({...x.request,configurationHash:priorFingerprint},()=>{}),/配置已变化/);assert.equal(x.calls(),0);
 }finally{await x.close();}
});
